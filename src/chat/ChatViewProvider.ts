import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Agent } from '../agent/agent';
import { replyLanguageName } from '../agent/languages';
import { ClientRegistry } from '../agent/clients';
import { ChatMessage, ThinkingEffort } from '../agent/types';
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_ID,
  cardDisplayName,
  cards,
  contextWindowFor,
  normalizeEffort,
  parseCatalog,
  providerSpecs,
  resolveCard,
  setCatalog,
} from '../agent/models';
import {
  AgentSession,
  DisplayItem,
  StoredState,
  STORED_STATE_VERSION,
  TitleSource,
  TreeNode,
  TurnStatus,
  UserAttachment,
  branchIds,
  detachBranch,
  isSidecar,
  migrateState,
  messageText,
  newId,
  nodeUsage,
  normalizeSession,
  pathIds,
  pathMessages,
  sessionEffortPick,
  sessionModelPick,
} from './tree';
import {
  TITLE_BATCH_MAX_TOKENS,
  TITLE_BATCH_SIZE,
  TITLE_MAX_TOKENS,
  buildBatchTitleMessages,
  buildTitleDigest,
  buildTitleMessages,
  heuristicTitle,
  parseBatchTitles,
  sanitizeTitle,
  shouldAutoTitle,
  turnCount,
} from './sessionTitles';
import { agentRootInfo, getWorkspaceRoot, resolvePath } from '../tools';
import { defaultSessionTitle, l10nDiagnostics } from '../i18n';
import { buildChatShell } from './webviewShell';
import { BackgroundHub } from './backgroundHub';
import { ChatPanel } from './ChatPanel';
import { PanelManager } from './panels';
import {
  HarnessConfig,
  RuntimeHost,
  SessionRuntime,
  SubAgentJob,
  clipDisplayItem,
} from './runtime';
import { SessionTreeItem } from './SessionsProvider';
import { ModelTreeController, apiKeySecretName } from './modelTree';
import { resolvePromptSnippets } from './promptSnippets';
import {
  removeTranscriptDir,
  removeTranscriptFile,
  removeTranscripts,
  sumUsage,
  flushTranscripts,
  writeSessionTranscript,
  writeSubAgentTranscript,
} from './transcript';
import {
  RemoteCommandOutcome,
  RemoteInputResult,
  RemoteOrigin,
  RemoteService,
  nodeOrigin,
  writeOriginIntoTranscript,
} from '../remote/remoteService';
import { ControlHost, ControlResult, ControlState, WaitForFinishOptions } from '../http/controlServer';
import { SessionStore, SessionSummary, defaultDataRoot, looksLikeStoreRoot, workspaceKeyFor } from './sessionStore';
import { diagnosticsHeader, newestDiagnosticsLog, prepareDiagnosticsLog } from './diagnosticsLog';
import { nodeDigest } from './persistDigest';
import {
  beginOp,
  harnessLog,
  liveOpCount,
  logWebviewReport,
  opMark,
  perf,
  setLagContextProvider,
  setOpTimeoutHook,
  setPerfSink,
  startLagWatch,
  startRepaintOp,
  timedSync,
  heapReadout,
  workReadout,
} from '../perf';
import { sliceText } from '../text';

// Model cards, providers, context windows and image support all live in one
// place: `src/agent/models.ts` (their editor is the Model Card Tree page,
// `src/chat/modelTree.ts`).
const STORAGE_KEY = 'spinney.state';
/**
 * The active-session pointer, in its **own** memento key. A session switch only
 * moves this pointer, and doing that through `persist()` re-serialized the whole
 * window state (~111 M chars → ~1.6 s of blocked extension host and a 273 MB
 * SQLite write) to store one id. Read side: this key wins; the blob's own
 * `activeSessionId` field is the fallback for state written before it existed.
 */
const ACTIVE_SESSION_KEY = 'spinney.activeSession';
/**
 * How long a content write may be coalesced away. State changes arrive in bursts
 * (a turn with a dozen tool calls, a stream of background updates) and each write
 * costs ~1 s of blocked extension host in a real profile, so a burst pays once.
 */
const PERSIST_DEBOUNCE_MS = 800;
/** …but never leave the newest state unpublished longer than this. */
const PERSIST_MAX_WAIT_MS = 3000;
/**
 * Dev-only perf tee buffer cap (see `openPerfTee`): past this many un-flushed
 * bytes the tee drops lines rather than grow, so it stays out of the host's way.
 * Only relevant while `SPINNEY_PERF_LOG` is set.
 */
const PERF_TEE_MAX_BUFFER = 1 << 20;
/**
 * The stall diagnostic's own deadlines ("the tab stopped painting", see `onStallReport`). The
 * numbers are the ones the lines quote (`no reply in 3000ms`, `no frame in 1000ms`), so a
 * report can be read without the source.
 */
const PROBE_REPLY_TIMEOUT_MS = 3000;
const PROBE_FRAME_TIMEOUT_MS = 1000;
/** …and how long the nudge's frame gets: it re-applies the transform and re-runs relayout. */
const NUDGE_FRAME_TIMEOUT_MS = 3000;
/**
 * No probe at all for a session within this window of its previous one. The webview's own
 * stall detector and an op deadline can both ask inside the same second, and two probes would
 * measure the same moment twice — this is what de-duplicates them.
 */
const PROBE_DEDUPE_MS = 10_000;
/**
 * The least time between two ladders in one session. A tab that stalls, is nudged and stalls
 * again is one condition: a second probe run inside the same minute cannot say more than the
 * first, and the webview's own `stall` line has already recorded it.
 */
const LADDER_COOLDOWN_MS = 60_000;
/**
 * At most one `post-failed` line per session, per message type, per this window. A turn
 * streaming into a document that is gone fails hundreds of messages in a row; the first one is
 * the whole of the news, and the rest would only push the useful lines out of the file.
 */
const POST_FAILED_REPORT_MS = 60_000;
/**
 * How long a **late** reply is still worth waiting for. A background tab's script is frozen by
 * the engine, and the measured case had a probe answered 257 s after it was asked — so a reply
 * that misses its 3 s deadline is not discarded, it is logged as late and the ladder it belongs
 * to keeps waiting for it, up to this window, after which the probe is forgotten (the
 * `webview-probe-dead` line is already on the record).
 */
const PROBE_LATE_WINDOW_MS = 10 * 60_000;
/**
 * A tab that was off screen at least this long comes back to a surface nothing repainted while
 * it was away, so coming back is the one moment the host nudges without being asked: the frame
 * sampler reported "stale" for those returns for months and the nudge is what turns that line
 * into evidence about the surface (see `onPanelViewState`).
 */
const VISIBLE_NUDGE_HIDDEN_MS = 3000;
/** One-shot marker for the historical-transcript backfill (see `backfillTranscripts`). */
const TRANSCRIPT_BACKFILL_KEY = 'spinney.transcriptBackfill';
const TRANSCRIPT_BACKFILL_VERSION = 'v1';
/** One-shot marker for the historical session-title backfill (see `backfillSessionTitles`). */
const TITLE_BACKFILL_KEY = 'spinney.sessionTitleBackfill';
const TITLE_BACKFILL_VERSION = 'v1';
/** How long one title completion may take before falling back to the heuristic. */
const TITLE_REQUEST_TIMEOUT_MS = 25_000;
/** Give up a backfill pass after this long; the marker stays unset so it resumes. */
const TITLE_BACKFILL_DEADLINE_MS = 10 * 60 * 1000;
/** One-shot copy of the pre-tree (v1) state. Kept as a FILE, never in the memento. */
const STORAGE_BACKUP_KEY = 'spinney.state.v1backup';
/** Where {@link STORAGE_BACKUP_KEY}'s content is parked (see `moveV1BackupOut`). */
const V1_BACKUP_FILE = 'state-v1-backup.json';
const CONFIG_KEY = 'spinney.runtimeConfig';
/**
 * One-shot marker: the session content has been moved from the Memento row to the store
 * files. In the **small** scope, like the other markers, so clearing the big row does not
 * clear it.
 */
const DATA_MIGRATED_KEY = 'spinney.dataMigrated';
const DATA_MIGRATED_VERSION = 'v1';
/** The parked copy of the pre-store row, in the store root (never in the Memento). */
const MIGRATION_BACKUP_PREFIX = 'migrated-state';
/** The store's folder name inside a global-storage folder (see `defaultDataRoot`). */
const STORE_DIR_NAME = 'spinney';
/**
 * How often the workspace lock is refreshed. Comfortably under the store’s
 * `LOCK_STALE_MS` (45 s), so three missed beats are needed before another window may
 * take the files over.
 */
const STORE_HEARTBEAT_MS = 15_000;
/**
 * The last assistant text a finished turn produced (used to carry a hopped
 * session's answer back to the session that dispatched it). Reasoning-only
 * turns fall back to the reasoning text so the caller is not left with nothing.
 */
/**
 * The sidebar-sized view of one stored session — the shape the store's index holds.
 * Everything a session list needs to render without loading a single conversation.
 */
function storeSummaryOf(session: AgentSession): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    titleSource: session.titleSource,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    nodeCount: Object.keys(session.nodes).length,
    activeNodeId: session.activeNodeId ?? '',
    model: session.model ?? undefined,
    effort: session.effort ?? undefined,
  };
}

function lastAssistantText(node: TreeNode): string {
  for (let i = node.messages.length - 1; i >= 0; i--) {
    const msg = node.messages[i];
    if (msg.role !== 'assistant') {
      continue;
    }
    const text = messageText(msg.content).trim();
    if (text) {
      return text;
    }
    const reasoning = (msg.reasoning_content ?? '').trim();
    if (reasoning) {
      return reasoning;
    }
  }
  return '';
}

/**
 * The Spinney output channel with the time stamp attached to every line written through it.
 *
 * The stamp has to live on the **channel** and not only on the call sites, because some writers
 * are not the provider's: `SessionRuntime.logLayoutDiagnostic` writes the `[layout]` dump of a
 * webview report through `RuntimeHost.output` with a bare `appendLine`. A report whose layout
 * evidence carries no time while every line around it does is exactly the hole the stamp exists
 * to close. `stampLine` is idempotent, so the call sites that already stamp their own line (the
 * perf sink, `outputLog`) keep working unchanged.
 */
class StampedOutputChannel implements vscode.OutputChannel {
  constructor(
    private readonly inner: vscode.OutputChannel,
    private readonly stamp: (line: string) => string,
  ) {}

  get name(): string {
    return this.inner.name;
  }

  /** A partial line is left alone: its stamp belongs to the line it finishes. */
  append(value: string): void {
    this.inner.append(value);
  }

  appendLine(value: string): void {
    this.inner.appendLine(this.stamp(value));
  }

  replace(value: string): void {
    this.inner.replace(value);
  }

  clear(): void {
    this.inner.clear();
  }

  show(preserveFocus?: boolean): void;
  show(column?: vscode.ViewColumn, preserveFocus?: boolean): void;
  show(columnOrPreserveFocus?: vscode.ViewColumn | boolean, preserveFocus?: boolean): void {
    if (typeof columnOrPreserveFocus === 'boolean') {
      this.inner.show(columnOrPreserveFocus);
    } else {
      this.inner.show(columnOrPreserveFocus, preserveFocus);
    }
  }

  hide(): void {
    this.inner.hide();
  }

  dispose(): void {
    this.inner.dispose();
  }
}

/**
 * One "the tab stopped painting" episode, per session: from the webview's first `stale` report
 * until it reports `recovered` (or the tab goes away). Its presence is what keeps the ladder to
 * **one per episode** — a `stale` repeated every 10 s is the same frozen screen, not ten
 * instructions — and `startedAt` is the `ms=<episode ms>` of the unresolved line.
 */
interface StallEpisode {
  /** When the webview first said `stale` (the frame gap itself is in its own line). */
  startedAt: number;
}

/**
 * A probe the host is still waiting on, by probe id — the id the webview echoes back in its
 * `probe`, `probe-frame` and `nudge-frame` reports. The whole ladder (probe → its frame → one
 * nudge → its frame) is this record's `stage`, with the deadline of the stage currently awaited
 * in `timer`: one record per probe, so no stage can leave a timer behind.
 */
interface ProbeWait {
  readonly sessionId: string;
  /** The episode this probe investigates, or `null` for an op-deadline probe (it has none). */
  readonly episode: StallEpisode | null;
  /** Which report moves this probe on: the probe's reply, its frame, or the nudge's frame. */
  stage: 'reply' | 'probe-frame' | 'nudge-frame';
  /** The deadline of `stage`; cleared before the stage moves on, and by `dispose`. */
  timer: ReturnType<typeof setTimeout>;
  /** When the probe went out — the `ms=` of a reply that missed its deadline. */
  readonly requestedAt: number;
  /**
   * Its deadline passed with no reply. The wait is kept (a frozen script answers minutes later,
   * and the answer is the evidence) with a second, much longer deadline behind it.
   */
  late?: boolean;
}

/**
 * Locally persists the active model card + thinking-level selection. The two
 * `*FromSettings` fields record the values that were in force when the selection
 * was stored (`spinney.model`, i.e. the default card id; and that card's own
 * `defaultEffort`), so a later edit of either can win over an older dropdown pick
 * — see `loadRuntimeConfig`. `model` is a **card id**, `thinkingEffort` a level
 * name; both are free-form strings to the API layer.
 */
interface RuntimeConfig {
  model: string;
  thinkingEffort: ThinkingEffort;
  modelFromSettings?: string;
  effortFromSettings?: string;
}

/**
 * The coordinator. P1 split every per-session / per-turn concern out into
 * `SessionRuntime` (see `src/chat/runtime.ts`) and every editor tab out into
 * `PanelManager` (see `src/chat/panels.ts`); this class owns what is genuinely
 * global:
 *
 *  - sessions and their persistence (`spinney.state`);
 *  - the `sessionId → SessionRuntime` map (`runtimes`);
 *  - tabs (`panels`), titles, transcripts, config, the control plane;
 *  - the global hop bookkeeping (`hopReturn` / `pendingSessionStart`).
 *
 * `activeSessionId` is only "the last focused tab" (persisted); every piece of
 * work is routed through an explicit session id, never "the active session".
 */
export class ChatViewProvider implements ControlHost, RuntimeHost {
  /** Fired when the sidebar's session list should re-read its items. */
  onStateChanged?: () => void;

  /** The chat is rendered in editor tabs: one `ChatPanel` per session. */
  private readonly panels: PanelManager;
  /**
   * The one background hub of this window. Registries live per (session, node)
   * inside it, so a job belongs to the node whose turn spawned it; the hub's
   * hooks route an update/finish back to the runtime that owns the session.
   */
  private readonly backgroundHub = new BackgroundHub();
  /** One runtime per session, created on demand (see `runtimeFor`). */
  private readonly runtimes = new Map<string, SessionRuntime>();
  /**
   * One API client per provider, plus the provider/card concurrency gates. Every
   * runtime's agent and every sub-agent reaches the network through it, so
   * routing a request is "which card is this?" and nothing else.
   */
  private readonly clients: ClientRegistry;
  /** The Model Card Tree page: a second editor tab, created on demand. */
  private readonly modelTree: ModelTreeController;
  /**
   * The remote publisher of this window (`src/remote/remoteService.ts`), set by
   * `activate()` once both objects exist. `undefined` in a host that never enables the
   * feature — and even then it is only reached through `postTo`'s cheap no-op call.
   */
  private remoteService?: RemoteService;
  /** Last value `resolveModel` could not place, so the output line is logged once. */
  private lastUnknownModel = '';
  /** Last `storage.update` write; the control plane awaits it before a reboot. */
  private lastPersist: Promise<void> = Promise.resolve();
  /** Pointer last written to its own key, so a switch writes it exactly once. */
  private lastActiveWritten = '';
  /** A content change is waiting for the coalescing window (see `persist`). */
  private dirty = false;
  /** When the oldest un-written change happened (bounds how stale state may get). */
  private dirtySince = 0;
  /** Changes folded into the pending write, reported as `coalesced=n`. */
  private deferredWrites = 0;
  /** The coalescing timer, or `null`. */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Shape of the **last** content write, kept for the lag context provider
   * (`hostContext`): how many chars it serialized and its
   * `sessions=/nodes=/items=/msgs=` readout. `persistNow()` computes both anyway,
   * and remembering them is what lets a stall say "it was that write" without a
   * second pass over the whole state.
   */
  private persistChars = 0;
  private persistCounts = '';
  /** When the in-flight content write started (0 = none running). */
  private persistInFlightSince = 0;
  /** When the last content write settled (0 = none in this window), and how long it took. */
  private persistLastDoneAt = 0;
  private persistLastMs = 0;
  /** While `Date.now() < controlHoldUntil` an external controller is rebooting. */
  private controlHoldUntil = 0;
  /** Set when the provider is being torn down; suppresses background notifications. */
  disposed = false;
  /** A queued `POST /session/start` waiting for the current turn to end. */
  private pendingSessionStart: { title?: string; prompt?: string; sessionId?: string; nodeId?: string } | null = null;
  /**
   * An armed session hop (`hop_session` tool / `POST /session/start` with
   * `returnTo`). Set when the hop is queued; the first turn that finishes in a
   * session created after `armedAt` (i.e. the hopped one) delivers its answer
   * back to `originSessionId` — as a new branch off `returnNodeId` when given —
   * and clears this.
   */
  private hopReturn: { originSessionId: string; armedAt: number; returnNodeId?: string } | null = null;
  /**
   * Cache-busting suffix for media URLs; changes per extension session. Public because the
   * replicated session panel (`src/remote/remoteSessionPanel.ts`) renders the same document
   * and has to bust the same cache.
   */
  readonly mediaVersion: string;
  readonly output: vscode.OutputChannel;
  /**
   * The persisted **default** model card/level, used to seed a session that has
   * no pick of its own (each session's own choice lives on `session.model` /
   * `session.effort`). `defaultModel` is a **card id** — what `spinney.model`
   * holds — and `defaultThinkingEffort` a level name that card offers. Kept in
   * step with the settings by `onConfigurationChanged`, and updated by
   * `persistRuntimeConfig` whenever a tab picks a value explicitly.
   */
  private defaultModel = DEFAULT_MODEL;
  private defaultThinkingEffort: ThinkingEffort = '';
  /** Settles when the workspace lock is decided (writes wait for it, never guess). */
  private lockPending: Promise<boolean> | null = null;
  /** Roots a rename/reinstall could have left the history in (see `storeCandidatesFor`). */
  private storeCandidates: string[] = [];
  /** The workspace lock heartbeat timer (see `STORE_HEARTBEAT_MS`). */
  private storeHeartbeat: ReturnType<typeof setInterval> | null = null;
  /** This window's lock owner string — unique per extension host. */
  private readonly ownerId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  /**
   * The live API key of a provider is **not** cached here: `ClientRegistry`
   * caches it per provider and re-reads through `readApiKeyFor` when it is
   * invalidated. This flag only remembers that the single "no key yet" nudge was
   * shown, so a send only nags once.
   */
  private missingKeyNotified = false;
  private sessions: AgentSession[] = [];
  /**
   * The file-backed session store (see `invariants/session-persistence.md`). `null` when
   * this window has no global storage (a test host), in which case everything falls back
   * to the Memento exactly as before.
   */
  private store: SessionStore | null = null;
  /** The store root is writable and we hold (or could not be denied) its workspace lock. */
  private storeWritable = false;
  /** Another live window owns this workspace's files: we keep writing the Memento. */
  private storeLockedOut = false;
  /**
   * True when another window owns this workspace's session files: this window then reads
   * them and refuses every mutation. One owner, one writer — a session is never steered
   * from two windows (`docs/agents/plans/session-epoch.md` §5).
   */
  private readOnly = false;
  /**
   * The sessions whose content changed since the last write, or `null` for "unknown — write
   * everything". A runtime marks its own session at every persist (it is the only thing a
   * runtime can change), so a turn in a large profile re-serializes **one** conversation
   * instead of all of them; any write nobody marked writes everything, which is why a
   * forgotten mark costs time and never content (see `writePayload`).
   */
  private dirtySessions = new Set<string>();
  /** node key (\u0000-separated) -> the digest the last write put on disk (see persistDigest). */
  private nodeDigests = new Map<string, string>();
  private activeSessionId = '';
  /** The one in-flight automatic-title request (a session switch does not cancel it). */
  private titleJob: { sessionId: string; controller: AbortController } | null = null;
  /** Sessions waiting for an automatic-title pass, drained one at a time. */
  private titlePending = new Set<string>();
  /** Stopper for the host event-loop lag watch (diagnostics only). */
  private stopLagWatch: (() => void) | null = null;
  /**
   * The last reported view state per session, so `[panel] session=… visible=… active=…` is
   * written for the initial report and for every change and never twice for the same pair: VS
   * Code re-reports the pair on every tab switch, and a file someone has to read by hand is the
   * one place repetition costs. A tab that is on screen is the precondition of every stall
   * investigation (see `onStallReport`), so "was it even visible when it froze?" is a question a
   * report has to answer.
   */
  private readonly viewStates = new Map<string, { visible: boolean; active: boolean }>();
  /**
   * When each session's last failed delivery was reported, keyed by session and message type
   * (`POST_FAILED_REPORT_MS`). A dead document fails every message of a streaming turn, so the
   * reporting window is what keeps one defect from filling the file.
   */
  private readonly postFailedAt = new Map<string, number>();
  /** The window-focus listener (diagnostics only); disposed with the provider. */
  private windowStateSub: vscode.Disposable | null = null;
  /** The stall episode in flight per session, from `stale` until `recovered` (see `StallEpisode`). */
  private readonly stallEpisodes = new Map<string, StallEpisode>();
  /** When each session's tab last went off screen, for the return nudge (see `onPanelViewState`). */
  private readonly tabHiddenSince = new Map<string, number>();
  /** The probes still being waited on, by probe id (see `ProbeWait`). */
  private readonly probeWaits = new Map<number, ProbeWait>();
  /** Monotonic probe ids: every line carries the id its report will quote back. */
  private probeSeq = 0;
  /** When each session's last probe went out (the `PROBE_DEDUPE_MS` window). */
  private readonly lastProbeAt = new Map<string, number>();
  /** When each session's last ladder started (the `LADDER_COOLDOWN_MS` window). */
  private readonly lastLadderAt = new Map<string, number>();
  /**
   * Dev-only tee of the perf lines (see `openPerfTee`): non-null only when
   * `SPINNEY_PERF_LOG` named a file at construction. The output channel stays the
   * primary sink — this is a copy for the simulation harness (`tools/sim/run.mjs`),
   * which has no way to read the channel back.
   */
  private perfTee: fs.WriteStream | null = null;
  /** The file the tee writes to (for the `Spinney: Open Diagnostics Log` command). */
  private perfTeeFile: string | null = null;
  /** Lines the tee dropped because it could not keep up (reported when it closes). */
  private perfTeeDropped = 0;
  /**
   * This extension's own version, read once from its `package.json`. It names the build
   * in the `[env]` line *and* decides whether the diagnostics log is on by default: a
   * version carrying `-diag` is a build made for a user to run and send back (see
   * `openPerfTee`), so no environment variable and no setting are involved.
   */
  private extensionVersion = '?';
  /** Sidebar refreshes per second — a runaway refresh rate is a stutter on its own. */
  private refreshCount = 0;
  private refreshWindow = 0;
  private titleDrainTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly storage: vscode.Memento,
    private readonly globalStorage?: vscode.Uri,
    /**
     * The other Memento *scope*, for the handful of **small** keys (the
     * active-session pointer, the model/effort default, the two backfill markers).
     * VS Code keeps an extension's whole `workspaceState` as ONE row — measured at
     * 118,860,732 chars here, all of our keys inside it — so a 40-byte update in
     * there still re-serializes and rewrites all of it (`lag blocked 549ms` right
     * after a switch's pointer write). The content blob stays in `storage`; the
     * small keys must not.
     */
    private readonly smallStorage?: vscode.Memento,
    /**
     * Where the API key lives. It is a **secret**, so it goes through
     * `context.secrets` (OS-encrypted, never written to `settings.json`, never
     * synced), with `DEEPSEEK_API_KEY` as the environment fallback. Optional so a
     * caller without one (a test) still constructs — then only the environment
     * variable can supply a key.
     */
    private readonly secrets?: vscode.SecretStorage,
  ) {
    this.mediaVersion = Date.now().toString(36);
    this.readOwnVersion(extensionUri);
    // The channel stamps what it is handed, not the other way round: the writers the provider
    // does not own (the `[layout]` dump of a webview report, which `SessionRuntime` writes
    // through `RuntimeHost.output`) write bare lines, and layout evidence without a time is
    // worth nothing next to the stall report it belongs to (see `StampedOutputChannel`).
    this.output = new StampedOutputChannel(vscode.window.createOutputChannel('Spinney'), (line) =>
      this.stampLine(line),
    );
    this.openPerfTee();
    // The output channel is the primary sink; the tee only copies what is already
    // written there (dev-only, and off unless `SPINNEY_PERF_LOG` names a file).
    setPerfSink((line) => {
      const stamped = this.stampLine(line);
      this.output.appendLine(stamped);
      this.teePerfLine(stamped);
    });
    // Which display language the UI is in, and whether a catalog was found for it
    // (see src/i18n.ts): a non-English window without one simply stays English, and
    // this line is the only way to tell that apart from "nothing to translate".
    // Stamped at the site *and* by the channel: this is the anchor every later line is read
    // against ("when did this window start?"), and the two stamps cannot disagree —
    // `stampLine` is idempotent, so the line carries the first one and only the first one.
    this.output.appendLine(this.stampLine(l10nDiagnostics(this.extensionUri)));
    // The host's own event loop is watched from here on: a stall in the extension
    // host (persist, a tree rebuild) shows up as a late timer, which no `perf()`
    // line can report while it is blocked.
    this.stopLagWatch = startLagWatch();
    // …and what is most likely to have blocked it is appended to that same line: an
    // O(1) readout of the persistence machinery (see `hostContext`).
    setLagContextProvider(() => this.hostContext());
    // An op whose own deadline passes with no `webview report` is the other half of "the tab
    // stopped painting": the perf layer knows that operation never came back and asks this
    // just before it ends the op, so the probe below leaves evidence where there was silence.
    setOpTimeoutHook((_label, subject) => this.onOpDeadline(subject));
    // The window's own focus, because a tab in an unfocused window is painted on a different
    // clock than one in front of the user: "was the window even focused?" has to be answerable
    // from the file. The event only fires on a change, so no de-dupe is needed here.
    this.windowStateSub = vscode.window.onDidChangeWindowState((state) => {
      perf(`window active=${state.focused}`);
    });
    // Keep the workspace lock alive: a heartbeat that stops is how a *live* window is
    // told apart from a killed one, and letting it lapse would hand the files to a second
    // window while this one is still writing them.
    this.storeHeartbeat = setInterval(() => {
      const store = this.store;
      if (store && !this.disposed) {
        void store.heartbeat(this.ownerId).catch(() => undefined);
      }
    }, STORE_HEARTBEAT_MS);
    this.storeHeartbeat.unref?.();
    // The user's providers and model cards must be installed before anything
    // derives a model list, a context window or an image capability from the
    // catalog.
    this.applyModelCards();
    // Resolve the active card/level before loading sessions so the restored
    // system prompt carries the correct identity.
    const runtime = this.loadRuntimeConfig();
    this.defaultModel = runtime.model;
    this.defaultThinkingEffort = runtime.thinkingEffort;
    // Snapshot AGENTS.md before building the prompts so the workspace
    // instructions are fixed for the whole session.
    this.loadAgentsMd();
    // The session store comes up before anything reads a session: it decides whether the
    // content lives in files from here on, or falls back to the Memento row.
    this.store = this.openStore();
    this.storeWritable = this.openStoreLock();
    // The client registry must exist before any runtime builds its agent: it is
    // what turns a card into a provider, its `baseUrl` and its API key.
    this.clients = new ClientRegistry({ apiKeyFor: (providerId) => this.readApiKeyFor(providerId) });
    this.clients.applyCatalog();
    // SecretStorage is asynchronous, so keys are read lazily; this first pass
    // warms them (and logs which providers have one). Nothing can send a turn
    // before the user types one.
    void this.refreshKeys('startup');
    // The Model Card Tree page: its own editor tab, the editor of
    // `spinney.providers` / `spinney.modelCards` / `spinney.model`.
    this.modelTree = new ModelTreeController({
      extensionUri: this.extensionUri,
      mediaVersion: this.mediaVersion,
      hasKey: (providerId) => this.clients.hasKey(providerId),
      storeKey: (providerId, key) => this.storeKeyFor(providerId, key),
      clearKey: (providerId) => this.clearKeyFor(providerId),
      onSaved: () => this.onModelCardsSaved(),
      log: (line) => this.output.appendLine(line),
    });
    // The panel manager needs only callbacks, so it can be built before the
    // sessions (runtimes post into it lazily).
    this.panels = new PanelManager({
      extensionUri: this.extensionUri,
      titleFor: (sessionId) => this.panelTitle(sessionId),
      getHtml: (webview) => this.getHtml(webview),
      onMessage: (panel, message) => this.handlePanelMessage(panel, message),
      onFocusChange: (sessionId) => this.onPanelFocus(sessionId),
      onClosed: (sessionId) => this.onPanelClosed(sessionId),
      // The tab's own visible/active pair: half of what a stall report means, and the
      // precondition of acting on one (see `onStallReport`).
      onViewState: (sessionId, state) => this.onPanelViewState(sessionId, state),
      // A delivery that failed is the other half of "the tab is not painting": the document
      // is not there at all (see `onPostFailed`).
      onPostFailed: (sessionId, type) => this.onPostFailed(sessionId, type),
    });
    this.loadSessions();
    // The two context lines come after the sessions are in, so they can name the store
    // root and the workspace key that will hold them: every later line is unreadable
    // without them (a user's report has no developer sitting next to it).
    this.logEnvironment();
    this.logEffectiveConfig();
    // Every background terminal belongs to a (session, node); the hub routes an
    // update/finish to the runtime that owns the session (an absent runtime
    // means the session is not loaded — nothing to repaint).
    this.backgroundHub.setHooks({
      onUpdated: (owner) => this.runtimes.get(owner.sessionId)?.refreshBackgrounds(),
      onFinish: (owner, task) => this.runtimes.get(owner.sessionId)?.onBackgroundFinished(owner, task),
      onRegistered: (owner, task) => this.runtimes.get(owner.sessionId)?.onBackgroundRegistered(owner, task),
    });
    // Runtimes are created on demand (`runtimeFor`), NOT for every stored
    // session: a runtime builds its own agent history when it is constructed, and
    // a profile can hold dozens of sessions — rebuilding every history at
    // activation would cost startup time and memory for conversations nobody is
    // looking at. An absent runtime is simply an idle session (nothing running).
    this.scheduleTranscriptBackfill();
    this.scheduleTitleBackfill();
  }

  getConfig(): HarnessConfig {
    const cfg = vscode.workspace.getConfiguration('spinney');
    // `spinney.model` holds a **card id**. `resolveModel` heals a stale value
    // (a deleted card, or a pre-card model id) back to the first usable card.
    const defaultCardId = this.resolveModel((cfg.get<string>('model') ?? '').trim());
    // The reply-language setting is a dropdown of VS Code language tags plus
    // `auto`; the prompt wants a language *name*, so `auto` is resolved here
    // against the display language of this window (`replyLanguageName` also maps
    // a tag to its CLDR name and falls back to English for a blank locale).
    const replyLanguage = replyLanguageName(cfg.get<string>('replyLanguage') ?? '', vscode.env.language);
    const foldToolCalls = cfg.get<boolean>('foldToolCalls') ?? true;
    const foldThinking = cfg.get<boolean>('foldThinking') ?? true;
    const foldWork = cfg.get<boolean>('foldWork') ?? true;
    const maxConcurrentSubagents = cfg.get<number>('maxConcurrentSubagents') ?? 15;
    const maxLevel2Subagents = cfg.get<number>('maxLevel2Subagents') ?? 2;
    const saveSubAgentTranscripts = cfg.get<boolean>('saveSubAgentTranscripts') ?? true;
    const saveSessionTranscripts = cfg.get<boolean>('saveSessionTranscripts') ?? true;
    const subAgentTranscriptDir = (cfg.get<string>('subAgentTranscriptDir') ?? '').trim();
    const autoSessionTitles = cfg.get<boolean>('autoSessionTitles') ?? true;
    // The composer's snippets: the shipped rows plus the user's own, keyed by
    // display name (`spinney.promptSections`). Resolved here rather than cached, so
    // the list is live on the next `postConfig` — the same shape every other key
    // follows.
    const promptSnippets = resolvePromptSnippets(cfg.get<unknown>('promptSections'));
    return { defaultCardId, replyLanguage, foldToolCalls, foldThinking, foldWork, maxConcurrentSubagents, maxLevel2Subagents, saveSubAgentTranscripts, saveSessionTranscripts, subAgentTranscriptDir, autoSessionTitles, promptSnippets };
  }

  // ---- API keys (SecretStorage: one entry per provider) ----

  /**
   * A provider's API key: its own SecretStorage entry (`spinney.apiKey` for the
   * built-in provider, `spinney.apiKey.<providerId>` for every other one — see
   * `apiKeySecretName` in `modelTree.ts`), with `DEEPSEEK_API_KEY` as the
   * fallback for the built-in provider. A key is **not** a setting: a key in
   * `settings.json` is plain text in a file that gets synced, diffed and pasted
   * around.
   *
   * Called by the `ClientRegistry`, which caches the answer; `refreshKeys`
   * invalidates that cache. A SecretStorage read can fail (a locked keyring, a
   * headless host) — that is not fatal: the environment variable is still a
   * valid home for a key.
   */
  private async readApiKeyFor(providerId: string): Promise<string> {
    if (this.secrets) {
      try {
        const stored = ((await this.secrets.get(apiKeySecretName(providerId))) ?? '').trim();
        if (stored) {
          return stored;
        }
      } catch (err) {
        this.output.appendLine(
          `[config] could not read the secret storage: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return providerId === DEFAULT_PROVIDER_ID ? (process.env.DEEPSEEK_API_KEY ?? '').trim() : '';
  }

  /**
   * Re-read every provider's key (the registry caches them) and say in the output
   * channel which ones are configured. Called once at activation and again after
   * a key is set or cleared — by the `spinney.setApiKey` / `spinney.clearApiKey`
   * commands or by the Model Card Tree page — so this window never needs a reload
   * to pick a key up. Every open tab then refreshes its wallet readout: the new
   * key may be exactly what that provider's balance line was missing.
   */
  async refreshKeys(reason: string): Promise<void> {
    this.clients.invalidateKeys();
    const parts: string[] = [];
    for (const provider of providerSpecs()) {
      const key = await this.clients.keyFor(provider.id);
      parts.push(`${provider.name}=${key ? 'set' : 'missing'}`);
      if (key) {
        this.missingKeyNotified = true; // a nudge is pointless once a key exists
      }
    }
    this.output.appendLine(`[config] api keys (${reason}): ${parts.join(', ')}`);
    for (const rt of this.runtimes.values()) {
      void rt.refreshBalance();
    }
  }

  /** Store a key for one provider (the page's key field, and the command). */
  private async storeKeyFor(providerId: string, key: string): Promise<void> {
    const value = (key ?? '').trim();
    if (!value) {
      return;
    }
    if (!this.secrets) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t(
          'Spinney: this host has no secret storage; set the DEEPSEEK_API_KEY environment variable instead.',
        ),
      );
      return;
    }
    await this.secrets.store(apiKeySecretName(providerId), value);
    await this.refreshKeys(`setApiKey:${providerId}`);
  }

  /** Forget one provider's key (`DEEPSEEK_API_KEY` may still serve the built-in one). */
  private async clearKeyFor(providerId: string): Promise<void> {
    await this.secrets?.delete(apiKeySecretName(providerId));
    await this.refreshKeys(`clearApiKey:${providerId}`);
  }

  /**
   * `spinney.setApiKey`: ask for the key (masked), store it in SecretStorage and
   * install it live. The provider defaults to the built-in one; the Model Card
   * Tree page passes the provider it is editing.
   */
  async setApiKeyInteractive(providerId = DEFAULT_PROVIDER_ID): Promise<void> {
    const provider = providerSpecs().find((p) => p.id === providerId);
    const value = await vscode.window.showInputBox({
      prompt: vscode.l10n.t(
        'API key for {0} — stored in the OS-encrypted secret storage, not in settings.json.',
        provider?.name ?? providerId,
      ),
      placeHolder: 'sk-…',
      password: true,
      ignoreFocusOut: true,
      validateInput: (input) => (input.trim() ? undefined : vscode.l10n.t('An API key is required.')),
    });
    const key = (value ?? '').trim();
    if (!key) {
      return; // cancelled
    }
    await this.storeKeyFor(providerId, key);
    void vscode.window.showInformationMessage(vscode.l10n.t('Spinney: API key saved.'));
  }

  /** `spinney.clearApiKey`: drop the stored key of one provider. */
  async clearApiKey(providerId = DEFAULT_PROVIDER_ID): Promise<void> {
    await this.clearKeyFor(providerId);
    void vscode.window.showInformationMessage(
      this.missingKeyNotified
        ? vscode.l10n.t('Spinney: stored API key cleared — still using the DEEPSEEK_API_KEY environment variable.')
        : vscode.l10n.t('Spinney: API key cleared.'),
    );
    this.missingKeyNotified = false;
  }

  /**
   * The one nudge for a missing key, shown *before* a send is accepted. It is a
   * non-modal notification with a button, deliberately not awaited: a missing key
   * must never block the composer (the request itself reports the real error).
   * Shown at most once per window, for the provider the default card routes to.
   */
  private async warnMissingApiKey(): Promise<void> {
    if (this.missingKeyNotified) {
      return;
    }
    const card = resolveCard(this.defaultModel) ?? cards()[0];
    if (!card) {
      return;
    }
    if (await this.clients.hasKey(card.providerId)) {
      this.missingKeyNotified = true;
      return;
    }
    this.missingKeyNotified = true;
    const SET_API_KEY = vscode.l10n.t('Set API Key');
    void vscode.window
      .showWarningMessage(vscode.l10n.t('Spinney: no API key is configured for this provider yet.'), SET_API_KEY)
      .then((pick) => {
        if (pick === SET_API_KEY) {
          void vscode.commands.executeCommand('spinney.setApiKey', card.providerId);
        }
      });
  }

  /**
   * Read AGENTS.md from the workspace root and snapshot it into the agent
   * prompt. The snapshot is taken once at session start, so later edits to
   * AGENTS.md do not propagate to the system prompt.
   */
  private loadAgentsMd(): void {
    let root: string;
    try {
      root = getWorkspaceRoot();
    } catch {
      Agent.setAgentsMd(null);
      this.output.appendLine(`[agents.md] none (no workspace folder; agent root = ${agentRootInfo().root})`);
      return;
    }
    const agentsMdPath = path.join(root, 'AGENTS.md');
    try {
      const content = fs.readFileSync(agentsMdPath, 'utf8');
      Agent.setAgentsMd(content);
      this.output.appendLine(`[agents.md] loaded ${agentsMdPath}`);
    } catch {
      Agent.setAgentsMd(null);
    }
  }

  /**
   * Called when the set of workspace folders changes (a folder was opened or
   * closed): re-read AGENTS.md and log the new mode plus the agent root. No
   * chat notice is posted — the conversation must stay clean. `transcriptRoot()`
   * and the prompt's `{{environment}}` line are live (they re-read on each use),
   * so they need no handling here.
   */
  public onWorkspaceFoldersChanged(): void {
    this.loadAgentsMd();
    const info = agentRootInfo();
    this.output.appendLine(`[workspace] folders changed → ${info.kind} mode; agent root = ${info.root}`);
  }

  /**
   * Apply a settings change to the live objects, so editing `spinney.*`
   * takes effect in this window instead of only after a reload.
   *
   * - **base URL** and the **API key** of a provider are read into that
   *   provider's `ApiClient` through `ClientRegistry`: the first by
   *   `applyCatalog()`, the second by `refreshKeys` (a key is not a setting — it
   *   lives in SecretStorage, installed by `spinney.setApiKey`, so a settings
   *   event only invalidates the cache). Every runtime's agent and every
   *   sub-agent reaches the network through that registry, so a new provider URL
   *   works on the very next request, even mid-turn.
   * - The **context window** and the **sub-agent pool limit** are
   *   pushed to their live owners (every runtime).
   * - **`spinney.model`** (the default card) and **`spinney.modelCards`** are
   *   applied only when those keys actually changed, and then only to sessions
   *   that have **no pick of their own**: the selection is per session, so a tab's
   *   explicit dropdown pick wins over the setting (a pick anchored to the
   *   *previous* default card is retired, see `loadRuntimeConfig`). Like the
   *   dropdowns, the value is skipped while that session is running. A card edit
   *   also re-clamps every session's thinking level against the card's own menu.
   * - **`replyLanguage`** is written into the system prompt, so it is pushed to
   *   every runtime (`SessionRuntime.applyReplyLanguage`) when its key changed
   *   — again skipped for a session that is mid-turn. Without a per-session pick
   *   to arbitrate, the setting is the only source: the runtime replaces the value
   *   and warns the session about the prompt-cache miss the change implies.
   *
   * Every other `spinney.*` key is already read lazily at its point of use
   * — `autoSessionTitles`, `maxLevel2Subagents`, `saveSessionTranscripts`,
   * `saveSubAgentTranscripts`, `subAgentTranscriptDir`, `maxInlineToolOutput`,
   * `commandTimeout` — so nothing else has to happen here.
   */
  public onConfigurationChanged(event?: vscode.ConfigurationChangeEvent): void {
    const cfg = this.getConfig();
    // Re-read the provider/card catalog first: it decides the recognized model
    // list, every context window and every image capability derived below.
    this.applyModelCards();
    this.clients.applyCatalog();
    const modelChanged = !event || event.affectsConfiguration('spinney.model');
    const catalogChanged =
      !event || event.affectsConfiguration('spinney.modelCards') || event.affectsConfiguration('spinney.providers');
    // The reply language is written into the system prompt, so a change to it is
    // pushed to every live session exactly like a model change — including
    // the cache-miss warning the runtime posts.
    const languageChanged = !event || event.affectsConfiguration('spinney.replyLanguage');
    if (modelChanged || catalogChanged) {
      // A settings edit also moves the default for sessions created from now on
      // (and retires a persisted record made against an older setting value).
      // Recompute it *before* the loop below, so the sessions without a pick adopt
      // exactly what a session created right now would start from.
      const defaults = this.loadRuntimeConfig();
      this.defaultModel = defaults.model;
      this.defaultThinkingEffort = defaults.thinkingEffort;
    }
    let skippedBusy = false;
    for (const rt of this.runtimes.values()) {
      rt.setSubAgentPoolLimit(cfg.maxConcurrentSubagents);
      rt.recheckContextWindow();
      if (modelChanged || catalogChanged) {
        if (rt.busy) {
          skippedBusy = true;
        } else {
          // The runtime applies it only when this session has no effective pick,
          // and re-clamps the session's level against the card it lands on.
          rt.applyDefaultModel(this.defaultModel);
        }
      }
      if (languageChanged) {
        if (rt.busy) {
          skippedBusy = true;
        } else {
          // No per-session pick here: the setting is the only source, so it simply
          // replaces the old value (and warns about the prompt-cache miss).
          rt.applyReplyLanguage(cfg.replyLanguage);
        }
      }
      // Repaint the dropdowns and the fold defaults (the webview re-applies the
      // latter to the cards already on screen).
      rt.postConfig();
    }
    if (skippedBusy) {
      this.output.appendLine('[config] model/reply-language change skipped: a turn is running');
    }
    if (!event || event.affectsConfiguration('spinney.providers')) {
      // The endpoints changed: the credit line answers from that host.
      for (const rt of this.runtimes.values()) {
        void rt.refreshBalance();
      }
    }
    this.output.appendLine(
      `[config] settings changed live: providers=${providerSpecs().length} cards=${cards().length} default=${this.defaultModel} maxSubagents=${cfg.maxConcurrentSubagents}`,
    );
  }

  /**
   * The context window of a model card. The card carries its own window (the Model
   * Card Tree page is the editor of record), so there is no global override left:
   * an id the catalog does not know falls back to the built-in window.
   */
  getContextWindow(model: string): number {
    return contextWindowFor(model);
  }

  /**
   * Read `spinney.providers` / `spinney.modelCards`, install them as the catalog,
   * and report what was installed. Those two keys plus `spinney.model` are the only
   * model configuration there is: a profile with neither gets the vendored
   * fallback card, so there is always exactly one usable model.
   *
   * Bad rows are skipped (never half-applied) and written to the output channel —
   * the page shows the same problems in its banner, in the display language
   * (`issues` are structured, `errors` is their English reading for this channel),
   * and silence would make a typo look like a harness bug.
   */
  private applyModelCards(): void {
    const cfg = vscode.workspace.getConfiguration('spinney');
    const parsed = parseCatalog(cfg.get<unknown>('providers'), cfg.get<unknown>('modelCards'));
    setCatalog(parsed.providers, parsed.cards);
    for (const error of parsed.errors) {
      this.output.appendLine(`[config] model cards: ${error}`);
    }
    this.output.appendLine(
      `[config] installed ${parsed.providers.length} provider(s), ${parsed.cards.length} card(s)`,
    );
  }

  /**
   * A save from the Model Card Tree page. The page already wrote the settings; this
   * is what makes the change live in exactly the same way a settings edit does —
   * new catalog, new limits, new keys, and every session that has no pick of its
   * own adopting the new default.
   */
  private onModelCardsSaved(): void {
    this.applyModelCards();
    this.clients.applyCatalog();
    this.clients.invalidateKeys();
    const defaults = this.loadRuntimeConfig();
    this.defaultModel = defaults.model;
    this.defaultThinkingEffort = defaults.thinkingEffort;
    for (const rt of this.runtimes.values()) {
      if (!rt.busy) {
        rt.applyDefaultModel(this.defaultModel);
      }
      rt.recheckContextWindow();
      rt.postConfig();
    }
  }

  /**
   * Accept a value the catalog knows: a card id first, then a card name and its
   * wire model name (so a hand-typed `spinney.model`, a card's name and the
   * `model` argument of `spawn_agents` all resolve). Anything else falls back to
   * the first usable card and says so — a stale id must not silently hide images
   * or mis-size the context indicator. The line is logged once per distinct
   * value, because this runs on every `getConfig()`.
   */
  resolveModel(candidate: string): string {
    const card = resolveCard(candidate);
    if (card) {
      return card.id;
    }
    const fallback = cards()[0];
    const value = (candidate ?? '').trim();
    if (value && value !== this.lastUnknownModel) {
      this.lastUnknownModel = value;
      this.output.appendLine(
        `[config] unknown model "${value}": not a model card — using "${fallback.id}" (${cardDisplayName(fallback)})`,
      );
    }
    return fallback.id;
  }

  /** The system prompt the active (last-focused) session would send next. */
  systemPrompt(): string {
    const rt = this.runtimes.get(this.activeSessionId);
    const card = resolveCard(this.defaultModel);
    return rt
      ? rt.systemPromptText()
      : Agent.systemPrompt(
          cardDisplayName(card),
          normalizeEffort(card, this.defaultThinkingEffort),
          this.getConfig().replyLanguage,
        );
  }

  /**
   * The **default** card/level: the persisted `spinney.runtimeConfig` record
   * falling back to the settings. A session's own pick is layered on top of this
   * by `effectiveModel` / `effectiveEffort` — this method only answers "what would
   * a session with no pick start from?".
   */
  private loadRuntimeConfig(): RuntimeConfig {
    const defaults = this.getConfig();
    const stored = this.readSmall<Partial<RuntimeConfig>>(CONFIG_KEY) ?? {};
    // A dropdown pick shadows the setting only while that setting is unchanged:
    // editing `spinney.model` — in settings.json or in the Model Card Tree page —
    // is an explicit choice as well, so it wins over a pick made *before* the edit
    // (a pick made after it is persisted together with the new setting value and
    // keeps winning). A record without the snapshot fields predates this rule, so
    // it is trusted.
    const picked =
      stored.model && (stored.modelFromSettings === undefined || stored.modelFromSettings === defaults.defaultCardId)
        ? stored.model
        : defaults.defaultCardId;
    const model = this.resolveModel(picked);
    // The level has no setting of its own any more: each card declares its own
    // default, and a stored pick only has to survive until the runtime clamps it
    // against that card's menu (`normalizeEffort`). `effortFromSettings` records
    // the card default a pick was made against; it is informational.
    const card = resolveCard(model);
    const thinkingEffort = normalizeEffort(card, stored.thinkingEffort ?? card?.defaultEffort ?? DEFAULT_EFFORT);
    return { model, thinkingEffort };
  }

  /**
   * The card/level a session runs with: its own pick when that pick still shadows
   * the setting it was made under (`sessionModelPick`), else the persisted default
   * above — which itself falls back to `spinney.model`. The level is always clamped
   * against the card that lands: a session whose stored level is not on that card's
   * menu runs on the card's default. Resolved here, once, and handed to the runtime
   * at construction; the runtime keeps the live value from then on and writes a
   * change back onto the session (`setModel` / `setThinkingEffort`).
   */
  private effectiveModel(session: AgentSession): string {
    const pick = sessionModelPick(session, this.getConfig().defaultCardId);
    return pick ? this.resolveModel(pick) : this.defaultModel;
  }

  private effectiveEffort(session: AgentSession, cardId: string): ThinkingEffort {
    const card = resolveCard(cardId);
    return normalizeEffort(card, sessionEffortPick(session, card?.defaultEffort ?? DEFAULT_EFFORT));
  }

  /**
   * Remember an explicit per-tab pick as the **default for future sessions**. The
   * live selection lives on the session itself (a runtime writes `session.model` /
   * `session.effort` and persists that with the session), so this memento write is
   * only the seed for sessions created later — it never touches an existing
   * session's own choice.
   */
  persistRuntimeConfig(cardId: string, thinkingEffort: ThinkingEffort): void {
    this.defaultModel = cardId;
    this.defaultThinkingEffort = thinkingEffort;
    const cfg = this.getConfig();
    const card = resolveCard(cardId);
    void this.writeSmall(CONFIG_KEY, {
      model: cardId,
      thinkingEffort,
      modelFromSettings: cfg.defaultCardId,
      effortFromSettings: card?.defaultEffort,
    } satisfies RuntimeConfig);
  }

  /**
   * The runtime for a session, created on demand and cached. Replaces the old
   * `activateSession`: there is no "active session's agent" any more, every
   * session keeps its own runtime for the whole window.
   */
  private runtimeFor(session: AgentSession): SessionRuntime {
    let rt = this.runtimes.get(session.id);
    if (!rt) {
      const cardId = this.effectiveModel(session);
      // Building a runtime seeds the view-derived counters from the stored tree, so
      // the first switch to a session that has never run in this window pays for it.
      rt = timedSync(
        'runtime-create',
        () =>
          new SessionRuntime(
            this,
            session,
            this.clients,
            cardId,
            this.effectiveEffort(session, cardId),
            this.backgroundHub,
          ),
        `session=${session.id} nodes=${Object.keys(session.nodes).length}`,
      );
      this.runtimes.set(session.id, rt);
      // A chain that predates the epoch model has no frozen envelope: adopt one now, once,
      // so from here on its bytes are stable (`adoptLegacyEpoch`).
      if (!this.readOnly) {
        rt.adoptLegacyEpoch();
      }
      this.notifyStateChanged();
    }
    return rt;
  }

  // ---- Session management ----

  private loadSessions(): void {
    const t0 = Date.now();
    const legacyRaw = this.storage.get<unknown>(STORAGE_KEY);
    // Reading the store never needs the lock: a window that lost the race still shows the
    // workspace's sessions, it just cannot write them (see `readOnly`).
    const fromStore = this.store ? this.store.readAllSync() : null;
    const storeSessions = (fromStore?.sessions ?? []) as AgentSession[];
    // The files win; the Memento row is the fallback (state written before the store
    // existed, or a window that could not take the workspace lock).
    const useStore = storeSessions.length > 0;
    const rawState = useStore ? undefined : legacyRaw;
    const { activeSessionId, sessions, migrated } = useStore
      ? { activeSessionId: this.readSmall<string>(ACTIVE_SESSION_KEY) ?? '', sessions: storeSessions, migrated: false }
      : migrateState(rawState);
    // Both sources have been healed already, and neither branch has to remember: the
    // store's reader runs `normalizeSession` on the way out (`openStore`'s `normalize`),
    // and `migrateState` does it for the Memento row. So the heal — drop the stale system
    // prompt, downgrade a turn that was still running, unlink dangling children, turn a
    // pre-forest `rootId` into `rootIds` — is exactly once per session, and the loaded
    // tree is always API-valid on activation.
    this.sessions = sessions;
    // The pre-tree (v1) safety copy belongs on disk, not in the memento: it is
    // ~20 M chars of the blob that nothing ever reads again, and VS Code
    // re-serializes the whole memento on every write.
    this.moveV1BackupOut(migrated ? rawState : undefined);
    let createdSession = false;
    if (this.sessions.length === 0) {
      this.createSessionInMemory();
      createdSession = true;
    }
    const placeholderId = createdSession ? this.sessions[0].id : null;
    // The pointer lives in its own key; the blob's field is the pre-split fallback.
    const remembered = this.readSmall<string>(ACTIVE_SESSION_KEY);
    const wanted = typeof remembered === 'string' && remembered ? remembered : activeSessionId;
    const active = this.sessions.find((s) => s.id === wanted);
    this.activeSessionId = active ? active.id : this.sessions[0].id;
    const nodes = this.sessions.reduce((n, s) => n + Object.keys(s.nodes).length, 0);
    const skipped = fromStore?.skipped ?? 0;
    perf(
      () =>
        `load-sessions ${Date.now() - t0}ms sessions=${this.sessions.length} nodes=${nodes}` +
        ` source=${useStore ? 'store' : rawState === undefined ? 'empty' : 'memento'}` +
        (skipped ? ` skipped=${skipped}` : '') +
        (migrated ? ' migrated=v1' : ''),
    );
    this.persistActiveSession();
    // Move the content out of the row on first sight of legacy state. It verifies what it
    // wrote before it clears anything (see `migrateToStore`).
    if (!useStore && rawState !== undefined) {
      this.migrateToStore(rawState, sessions);
    }
    if (!useStore && rawState === undefined) {
      // Nothing here and nothing in the row: this workspace's sessions may still exist
      // under a *different* extension id (a rename, a reinstall, a second publisher) —
      // `globalStorage` itself is named after the id, so that is where they would be.
      this.adoptFromOtherRoots(placeholderId);
    }
    // Write the state back only when loading actually *changed* it: the heal pass
    // (`migrateState` / `normalizeTreeSession`) is idempotent and re-runs on every
    // activation, so re-serializing ~108 M chars "just in case" cost a couple of
    // seconds of blocked host on every start — and, because writes are coalesced,
    // it landed 800 ms later, right on top of the first session switch.
    if (migrated || createdSession) {
      this.persistNow();
    }
  }

  /**
   * Open the session store, if this window can have one. The root is a **fixed** folder
   * under global storage (never derived from the extension id, so a rename moves nothing),
   * overridable by `spinney.dataDir`. No global storage (a test host) means no store and
   * the Memento keeps doing the work.
   */
  private openStore(): SessionStore | null {
    const globalStorage = this.globalStorage?.fsPath;
    if (!globalStorage) {
      return null;
    }
    const configured = vscode.workspace.getConfiguration('spinney').get<string>('dataDir') ?? '';
    const key = workspaceKeyFor(vscode.workspace.workspaceFolders?.[0]?.uri.toString());
    const root = defaultDataRoot(globalStorage, configured);
    // Where else could this workspace's sessions be? `context.globalStorageUri` is
    // `<profile>/globalStorage/<publisher.name>` — **the parent folder is the extension
    // id** — so a fixed last segment alone does NOT survive a rename: the whole folder
    // moves. What does is looking at the siblings (`*/spinney`) and adopting from them,
    // which is why that list is computed here, before anything reads a session.
    this.storeCandidates = this.storeCandidatesFor(globalStorage, root, configured);
    const store = new SessionStore({
      root,
      workspaceKey: key,
      onLog: (line) => this.output.appendLine(line),
      // The read boundary heals (`SessionStore`'s own doc says why it is the reader's job):
      // a session file written by an older build — a pre-forest `rootId`, a chain with no
      // frozen epoch — is normalized the moment it is read, whichever path read it.
      normalize: (session) => normalizeSession(session) ?? session,
    });
    perf(() => `store-open root=${store.root} key=${key} candidates=${this.storeCandidates.length}`);
    return store;
  }

  /**
   * The roots worth looking at, besides the one we write to: every sibling
   * `<profile>/globalStorage/<other-id>/spinney` — what a rename, a reinstall or a
   * second publisher leaves behind — and, when `spinney.dataDir` pins the root, the
   * default location under the current id (so pinning the setting does not hide history
   * that was already there).
   */
  private storeCandidatesFor(globalStorage: string, ownRoot: string, configured: string): string[] {
    const out: string[] = [];
    const push = (candidate: string): void => {
      if (candidate && candidate !== ownRoot && !out.includes(candidate)) {
        out.push(candidate);
      }
    };
    const profile = path.dirname(globalStorage); // …/globalStorage
    if (configured.trim()) {
      push(defaultDataRoot(globalStorage));
    }
    try {
      for (const entry of fs.readdirSync(profile, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          push(path.join(profile, entry.name, STORE_DIR_NAME));
        }
      }
    } catch {
      /* no readable profile folder: nothing to discover */
    }
    return out;
  }

  /**
   * Adopt another root's sessions when this one has none — the rename case. It runs after
   * the workspace lock is settled (an adoption is a write) and only ever **reads** the
   * other root: the sessions are copied into this one, which stays the single live root.
   * A placeholder session created because this root looked empty is cleaned up, so the
   * user does not get an empty conversation beside their restored history.
   */
  private adoptFromOtherRoots(placeholderId: string | null): void {
    const store = this.store;
    if (!store || !this.storeWritable || this.storeCandidates.length === 0) {
      return;
    }
    void (async () => {
      try {
        await (this.lockPending ?? Promise.resolve(true));
        const roots = await SessionStore.discover(this.storeCandidates);
        let adopted = 0;
        for (const root of roots) {
          const result = await store.adoptFrom(root);
          adopted += result.adopted;
          if (result.adopted > 0) {
            this.output.appendLine(`[store] restored ${result.adopted} session(s) from ${root}`);
          }
        }
        if (adopted === 0) {
          return;
        }
        if (placeholderId) {
          await store.deleteSession(placeholderId);
        }
        const back = store.readAllSync();
        const sessions = back.sessions as AgentSession[];
        if (sessions.length === 0) {
          return;
        }
        this.sessions = sessions;
        if (!this.sessions.some((s) => s.id === this.activeSessionId)) {
          this.activeSessionId = this.sessions[0].id;
          this.persistActiveSession();
        }
        this.notifyStateChanged();
        perf(() => `store-adopted sessions=${adopted} total=${sessions.length} placeholders=${placeholderId ? 1 : 0}`);
      } catch (err) {
        this.output.appendLine(
          `[store] could not adopt another root (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    })();
  }

  /**
   * Bring the store up and take its workspace lock. A lock held by a **live** window is
   * not stolen: that window keeps writing files alone and this one falls back to the
   * Memento, because two windows writing the same session file is the one way to lose
   * content that the Memento's whole-state write could not. A stale lock (a killed window,
   * a dead pid) is taken over, so a crash never freezes the store.
   */
  private openStoreLock(): boolean {
    const store = this.store;
    if (!store) {
      return false;
    }
    if (!store.ensureRootSync()) {
      return false;
    }
    const owner = `${this.ownerId}`;
    let acquired = false;
    let tookOver = false;
    let holder: string | undefined;
    // `acquireLock` is async (it re-reads to break a takeover race), so the very first
    // writes of this window are held back until it answers — the lock is a promise the
    // rest of the provider can rely on being settled, not a guess.
    const pending = store.acquireLock(owner).then(
      (result) => {
        acquired = result.acquired;
        tookOver = result.tookOver;
        holder = result.holder?.owner;
        this.storeWritable = acquired;
        this.storeLockedOut = !acquired;
        this.readOnly = !acquired;
        perf(
          () =>
            `store-lock ${acquired ? 'acquired' : 'refused'}${tookOver ? ' took-over=true' : ''}` +
            (holder ? ` holder=${holder}` : ''),
        );
        if (!acquired) {
          this.output.appendLine(
            '[store] another window owns this workspace\u2019s session files — this window is read-only',
          );
          // Say it where the user is looking, once per session that is open.
          for (const rt of this.runtimes.values()) {
            rt.postNotice(
              'warning',
              vscode.l10n.t(
                'Another window owns this workspace\u2019s sessions, so this window is read-only. Close that window (or use it) to continue here.',
              ),
            );
          }
          this.notifyStateChanged();
        }
        return acquired;
      },
      () => false,
    );
    this.lockPending = pending;
    return true;
  }

  /**
   * Move the content out of the Memento row into the store files — once, verifiably:
   *
   *  1. write every session through the store and flush;
   *  2. **read it all back** and compare (a session count that does not match, or an
   *     unreadable file, aborts the migration and leaves the row alone);
   *  3. park the raw row as `<root>/migrated-state-<date>.json`, so the pre-migration
   *     state exists as a file the user could restore;
   *  4. only then clear the big key — the small keys stay, they are the pointer and the
   *     model defaults, and they are what tells a future activation which session was open.
   *
   * Idempotent and resumable: the marker is written last, and anything that fails leaves
   * the row in place so the next activation simply tries again.
   */
  private migrateToStore(legacyRaw: unknown, parsed: AgentSession[]): void {
    const store = this.store;
    if (!store || !this.storeWritable) {
      return;
    }
    if (this.readSmall<string>(DATA_MIGRATED_KEY) === DATA_MIGRATED_VERSION) {
      return;
    }
    void (async () => {
      const t0 = Date.now();
      try {
        await (this.lockPending ?? Promise.resolve(true));
        const sessions = parsed;
        if (sessions.length === 0) {
          return;
        }
        // 1. Park the raw row **first**: the copied source exists as a file before a single
        // byte is written anywhere else, and if the parking fails nothing else happens.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const parked = await store.parkFile(`${MIGRATION_BACKUP_PREFIX}-${stamp}.json`, JSON.stringify(legacyRaw));
        if (!parked) {
          this.output.appendLine('[store] migration NOT completed: could not park the copied row');
          return;
        }
        // 2. Write every session through the store, then **read it all back** and compare.
        // A count that does not match, or one unreadable file, aborts with the row intact.
        for (const session of sessions) {
          store.writeSession(session.id, session, storeSummaryOf(session));
        }
        await store.writeIndex(sessions.map(storeSummaryOf));
        await store.flush();
        const back = store.readAllSync();
        if (back.sessions.length !== sessions.length || back.skipped > 0) {
          this.output.appendLine(
            `[store] migration NOT completed: wrote ${sessions.length} session(s), read back ` +
              `${back.sessions.length} (skipped ${back.skipped}) — the Memento row is untouched, ` +
              `the copied row is at ${parked}`,
          );
          return;
        }
        // 3. Only now clear the big key. The small keys stay: they are the pointer and the
        // model defaults, and they are what tells the next activation which session was open.
        await this.storage.update(STORAGE_KEY, undefined);
        await this.writeSmall(DATA_MIGRATED_KEY, DATA_MIGRATED_VERSION);
        this.storeWritable = true;
        perf(() => `store-migrated sessions=${sessions.length} ms=${Date.now() - t0} parked=${parked}`);
        this.output.appendLine(
          `[store] session content moved out of the Memento → ${store.root} ` +
            `(${sessions.length} session(s)); the previous row is kept at ${parked}`,
        );
      } catch (err) {
        this.output.appendLine(
          `[store] migration failed (${err instanceof Error ? err.message : String(err)}) — the Memento row is untouched`,
        );
      }
    })();
  }

  /**
   * Re-read every session from the store and put it in front of the user — the half that
   * makes an import (or an adoption) visible without a window reload: the sessions array is
   * the single source the sidebar, the panels and the control plane all read.
   */
  private refreshSessionsFromStore(): boolean {
    const store = this.store;
    if (!store) {
      return false;
    }
    const back = store.readAllSync();
    const sessions = back.sessions as AgentSession[];
    if (sessions.length === 0) {
      return false;
    }
    this.sessions = sessions;
    if (!this.sessions.some((s) => s.id === this.activeSessionId)) {
      this.activeSessionId = this.sessions[0].id;
      this.persistActiveSession();
    }
    this.notifyStateChanged();
    return true;
  }

  /**
   * `Spinney: Export Session Data` — copy the whole data root where the user says, so the
   * history can live outside this machine profile (a backup, a synced folder, another box).
   *
   * The live store is copied **as it stands**: the `.trash` folder (deleted sessions), the
   * `locks` (per-window, and a stale lock in a restored copy would block writing) and the
   * parked migration blobs (the pre-store Memento copy, tens of megabytes) stay behind, so an
   * export is exactly "the sessions and nothing else".
   */
  async exportSessionData(): Promise<void> {
    const store = this.store;
    if (!store) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('Spinney: this window has no session data folder to export.'),
      );
      return;
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: vscode.l10n.t('Export here'),
      title: vscode.l10n.t('Export Spinney session data'),
    });
    const target = picked?.[0]?.fsPath;
    if (!target) {
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = path.join(target, `spinney-export-${stamp}`);
    try {
      const skip = [path.join(store.root, 'locks'), path.join(store.sessionsDir, '.trash')];
      fs.cpSync(store.root, destination, {
        recursive: true,
        filter: (source) =>
          !skip.includes(source) &&
          !path.basename(source).startsWith(`${MIGRATION_BACKUP_PREFIX}-`) &&
          !source.includes(`${path.sep}.trash`),
      });
      this.output.appendLine(`[store] exported ${store.root} → ${destination}`);
      const open = vscode.l10n.t('Show in Explorer');
      const answer = await vscode.window.showInformationMessage(
        vscode.l10n.t('Spinney: session data exported to {0}', destination),
        open,
      );
      if (answer === open) {
        void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(destination));
      }
    } catch (err) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t(
          'Spinney: could not export the session data ({0}).',
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
  }

  /**
   * `Spinney: Import Session Data` — adopt another root's sessions into this one: an export
   * taken from another machine, or the folder an older install left behind under another
   * extension id (which is how a rename is recovered). It only ever **reads** the folder the
   * user picks, and a session already here wins, so importing twice is a no-op.
   */
  async importSessionData(): Promise<void> {
    const store = this.store;
    if (!store) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('Spinney: this window has no session data folder to import into.'),
      );
      return;
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: vscode.l10n.t('Import from here'),
      title: vscode.l10n.t('Import Spinney session data'),
    });
    const source = picked?.[0]?.fsPath;
    if (!source) {
      return;
    }
    if (!looksLikeStoreRoot(source)) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('Spinney: that folder does not hold Spinney session data.'),
      );
      return;
    }
    try {
      const result = await store.adoptFrom(source);
      if (result.adopted > 0) {
        this.refreshSessionsFromStore();
      }
      this.output.appendLine(`[store] imported ${result.adopted} session(s) from ${source} (${result.skipped} already present)`);
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          'Spinney: imported {0} session(s); {1} were already present.',
          String(result.adopted),
          String(result.skipped),
        ),
      );
    } catch (err) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t(
          'Spinney: could not import the session data ({0}).',
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
  }
  /**
   * A `SessionRuntime` reporting that its own session's content changed (see
   * `RuntimeHost.markSessionDirty`). Called on every one of its writes, so this set is the
   * complete answer to "what has to be re-serialized" for the hot path.
   */
  markSessionDirty(sessionId: string): void {
    if (sessionId) {
      this.dirtySessions.add(sessionId);
    }
  }

  /**
   * Write the changed sessions (plus the index) through the store.
   *
   * `built` holds **only the sessions whose content changed** — a runtime names its own at
   * every persist, so a turn in a 30-session profile re-serializes one conversation instead
   * of all of them (measured: 382 ms of blocked host and 803 ms of writes for 86 M chars
   * before this). `summaries` is the *whole* list, from memory: the index is the sidebar's
   * view of the profile and must not shrink to whatever this write happened to touch.
   *
   * Without a usable store the Memento keeps working exactly as before, with the full
   * payload (a test host, a read-only profile, or another window holding the workspace lock).
   */
  private writePayload(
    built: { session: AgentSession; dirtyNodes: string[] }[],
    full: StoredState,
    summaries: SessionSummary[],
  ): Promise<{ ms: number; writes: number; skipped: number; chars: number } | undefined> {
    const store = this.store;
    if (!store || !this.storeWritable) {
      // No store: the Memento write reports nothing (there is nothing to attribute).
      return Promise.resolve(this.storage.update(STORAGE_KEY, full)).then(() => undefined);
    }
    const jobs: Promise<{ chars: number; ms: number; skipped: boolean }[]>[] = [];
    for (const { session, dirtyNodes } of built) {
      // The session object carries **every** node id (the store needs them to notice a node
      // that is gone), but only `dirtyNodes` are serialized: that is the whole v2 win. Each
      // returned job settles with what *that* write cost, so the report is this persist's own.
      jobs.push(store.writeSession(session.id, session, storeSummaryOf(session), dirtyNodes));
    }
    void store.writeIndex(summaries);
    return Promise.all(jobs).then((groups) => {
      const results = groups.flat();
      return {
        ms: results.reduce((n, r) => n + r.ms, 0),
        writes: results.filter((r) => !r.skipped).length,
        // A job the queue replaced before it ran: this persist's content is still on disk, in
        // the body that superseded it. Reporting the count keeps a `writes=0` line from
        // looking like a broken instrument.
        skipped: results.filter((r) => r.skipped).length,
        chars: results.reduce((n, r) => n + r.chars, 0),
      };
    });
  }

  /**
   * Park the pre-tree (v1) state as a file in global storage and drop the memento
   * key. It exists so a pre-tree build could still read the old shape; the
   * migration has long completed, and in the memento it is ~15% of every write
   * (see `docs/agents/invariants/streaming-perf.md`). The data is kept, only moved.
   */
  private moveV1BackupOut(freshV1?: unknown): void {
    let backup: unknown = freshV1;
    if (backup === undefined) {
      backup = this.storage.get<unknown>(STORAGE_BACKUP_KEY);
    }
    if (backup === undefined) {
      return;
    }
    const dir = this.globalStorage?.fsPath;
    if (!dir) {
      this.output.appendLine('[migrate] v1 backup left in the memento (no global storage to move it to)');
      return;
    }
    try {
      const file = path.join(dir, V1_BACKUP_FILE);
      fs.writeFileSync(file, JSON.stringify(backup), 'utf8');
      void this.storage.update(STORAGE_BACKUP_KEY, undefined);
      this.output.appendLine(`[migrate] pre-tree (v1) state moved out of the memento → ${file}`);
    } catch (err) {
      this.output.appendLine(
        `[migrate] could not move the v1 backup out: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * The Memento that owns the small keys (see the constructor). Falls back to the
   * content one when no separate scope was provided (no-repo mode, tests): there
   * the two are the same object anyway.
   */
  private get small(): vscode.Memento {
    return this.smallStorage ?? this.storage;
  }

  /**
   * Read a small key. A value that only the big row has (state written before this
   * split) is adopted: returned now, written small for next time. The big row is
   * deliberately not cleaned — deleting a key there would rewrite all 119 M chars
   * for a few bytes — so a stale copy simply loses to the small one from then on.
   */
  private readSmall<T>(key: string): T | undefined {
    const small = this.small.get<T>(key);
    if (small !== undefined) {
      return small;
    }
    const legacy = this.storage.get<T>(key);
    if (legacy !== undefined) {
      void this.small.update(key, legacy);
    }
    return legacy;
  }

  /** Write a small key (cheap: it lands in a tiny row, not in the content blob). */
  private writeSmall(key: string, value: unknown): Thenable<void> {
    return this.small.update(key, value);
  }

  /**
   * Write **only** the active-session pointer. A switch moves a pointer, not the
   * conversation, so it must not go through `persist()` (111 M chars, ~1.6 s) — and
   * it must not land in the content Memento either, where even a 40-byte update
   * rewrites the whole row (`readSmall`). Called from every path that moves the
   * pointer, including the content persist, so the two can never disagree for long.
   */
  private persistActiveSession(): void {
    if (this.lastActiveWritten === this.activeSessionId) {
      return;
    }
    this.lastActiveWritten = this.activeSessionId;
    const t0 = Date.now();
    this.trackWrite(this.writeSmall(ACTIVE_SESSION_KEY, this.activeSessionId));
    perf(() => `persist-active session=${this.activeSessionId} ${Date.now() - t0}ms`);
  }

  /** Track the newest write(s): the control plane awaits this before a reboot. */
  private trackWrite(pending: Thenable<unknown>): void {
    this.lastPersist = this.lastPersist
      .then(() => pending)
      .then(
        () => undefined,
        () => undefined,
      );
  }

  /**
   * Queue the content write. Writing the whole window state is expensive (~111 M
   * chars, ~1 s of blocked host in a real profile), and state changes arrive in
   * bursts — a turn with a dozen tool calls used to pay that price a dozen times —
   * so writes are coalesced: the burst pays once. The 3 s ceiling bounds how stale
   * the stored state can get while changes keep coming.
   *
   * A caller that must not lose what it just changed (a finished turn, a deletion,
   * a hand-off to the control plane) uses `persistNow()`.
   */
  persist(): void {
    this.dirty = true;
    this.deferredWrites++;
    if (this.dirtySince === 0) {
      this.dirtySince = Date.now();
    }
    if (this.persistTimer != null) {
      clearTimeout(this.persistTimer);
    }
    const waited = Date.now() - this.dirtySince;
    const wait = Math.max(0, Math.min(PERSIST_DEBOUNCE_MS, PERSIST_MAX_WAIT_MS - waited));
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, wait);
  }

  /**
   * Write the content immediately (cancelling a pending coalesced write). Every
   * path that could otherwise lose real state — or leave the memento listing a
   * branch whose transcript dumps are already deleted — goes through this.
   */
  persistNow(): void {
    if (this.persistTimer != null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const coalesced = this.deferredWrites;
    this.dirty = false;
    this.dirtySince = 0;
    this.deferredWrites = 0;
    const t0 = Date.now();
    // The size estimate rides along with the payload build (one pass over data we
    // already touch). A second pass over ~108 M chars, or a `JSON.stringify`, used
    // to cost a few hundred ms *inside* the operation the line is about.
    let chars = 0;
    const addText = (text: unknown): void => {
      if (typeof text === 'string') {
        chars += text.length;
      }
    };
    const clipItem = (item: DisplayItem): DisplayItem => {
      const clipped = clipDisplayItem(item);
      addText(clipped.text);
      addText(clipped.thinking);
      addText(clipped.args);
      addText(clipped.content);
      addText(clipped.doneText);
      for (const attachment of clipped.attachments ?? []) {
        addText(attachment.dataUrl);
        addText(attachment.name);
      }
      return clipped;
    };
    // Messages are stored **verbatim**: what a node keeps has to be byte-identical
    // to what was sent to the API, or the provider's prefix cache is lost from the
    // first truncated message on after every reload. So this hook only accumulates
    // the size readout and returns the message untouched — there is no message cap.
    const countMsg = (msg: ChatMessage): ChatMessage => {
      addText(msg.reasoning_content);
      if (typeof msg.content === 'string') {
        addText(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content as { text?: string; image_url?: { url?: string } }[]) {
          addText(part.text);
          addText(part.image_url?.url);
        }
      }
      for (const call of msg.tool_calls ?? []) {
        addText(call.function?.arguments);
      }
      return msg;
    };
    // **Which sessions changed?** A runtime names its own at every persist (see
    // `markSessionDirty`), and nothing marked means "unknown — write everything". That
    // asymmetry is deliberate: a forgotten mark costs time, never content.
    const dirty = this.dirtySessions;
    const targets = dirty.size > 0 ? this.sessions.filter((s) => dirty.has(s.id)) : this.sessions;
    /** One node, clipped for storage (the caller decides *which* nodes need it). */
    const clipNode = (node: TreeNode): TreeNode => {
      addText(node.title);
      addText(node.bgCommand);
      addText(node.bgOutputTail);
      return {
        ...node,
        displayItems: node.displayItems.map(clipItem),
        messages: node.messages.map(countMsg),
      };
    };
    const clipSession = (s: AgentSession): AgentSession => {
      addText(s.title);
      return {
        ...s,
        orphanItems: s.orphanItems.map(clipItem),
        nodes: Object.fromEntries(
          Object.entries(s.nodes).map(([id, node]): [string, TreeNode] => {
            addText(node.title);
            addText(node.bgCommand);
            addText(node.bgOutputTail);
            return [
              id,
              {
                ...node,
                displayItems: node.displayItems.map(clipItem),
                messages: node.messages.map(countMsg),
              },
            ];
          }),
        ),
      };
    };
    // The files we rewrite this time, and — separately — the index, which describes the
    // whole profile and must not shrink to whatever this write happened to touch.
    // Without a usable store the Memento still needs the **whole** state, so the full
    // payload is built only on that path: the store path never walks an unchanged session.
    const tSelect = Date.now();
    const storeWrite = Boolean(this.store && this.storeWritable);
    if (this.store && !this.storeWritable) {
      // Read-only window: the store belongs to another window and there is deliberately no
      // second write path to fall back to, so a queued write is simply dropped.
      perf(() => 'persist-skipped read-only=true');
      return;
    }
    // **Which nodes changed?** One digest per node, compared with what the last write put on
    // disk. A session holds its whole history, so writing it whole on every turn end cost
    // 17.5 MB of `JSON.stringify` and 17.5 MB of writes per *turn* while 99% of it had not
    // moved; from here only the nodes whose digest moved are clipped and written, and every
    // other node keeps its file untouched.
    const dirtyNodesFor = (s: AgentSession): string[] => {
      const changed: string[] = [];
      for (const [nodeId, node] of Object.entries(s.nodes)) {
        const key = `${s.id}\u0000${nodeId}`;
        const digest = nodeDigest(node);
        if (this.nodeDigests.get(key) !== digest) {
          changed.push(nodeId);
          this.nodeDigests.set(key, digest);
        }
      }
      return changed;
    };
    const built = storeWrite
      ? targets.map((s) => {
          const dirtyNodes = dirtyNodesFor(s);
          const nodes: Record<string, TreeNode> = {};
          for (const [nodeId, node] of Object.entries(s.nodes)) {
            // An untouched node is handed through **as it is**: it is never serialized (the
            // store queues only the dirty ones), its id is all the header needs.
            nodes[nodeId] = dirtyNodes.includes(nodeId) ? clipNode(node) : node;
          }
          addText(s.title);
          return { session: { ...s, orphanItems: s.orphanItems.map(clipItem), nodes }, dirtyNodes };
        })
      : [];
    const payload: StoredState = {
      version: STORED_STATE_VERSION,
      activeSessionId: this.activeSessionId,
      sessions: storeWrite ? [] : this.sessions.map(clipSession),
    };
    const summaries = storeWrite ? this.sessions.map(storeSummaryOf) : [];
    const tBuild = Date.now();
    dirty.clear();
    const session = this.getActiveSession();
    const nodeCount = session ? Object.keys(session.nodes).length : 0;
    const msgCount = session ? pathMessages(session, session.activeNodeId).length : 0;
    const items = session
      ? session.activeNodeId
        ? session.nodes[session.activeNodeId]?.displayItems.length ?? 0
        : session.orphanItems.length
      : 0;
    const counts = `sessions=${this.sessions.length} nodes=${nodeCount} items=${items} msgs=${msgCount}`;
    const via = this.store && this.storeWritable ? 'store' : 'memento';
    const extra =
      counts +
      ` via=${via}` +
      (via === 'store' ? ` dirty=${built.length}/${this.sessions.length}` : '') +
      (coalesced > 1 ? ` coalesced=${coalesced}` : '');
    // Remember the shape of this write for the lag context provider (`hostContext`):
    // both numbers are in hand here already, so a stall can name the write that
    // caused it without a second pass over the whole state.
    this.persistChars = chars;
    this.persistCounts = counts;
    // From here until the promise settles a content write is in flight. Everything
    // above this line is synchronous, so no timer could have fired inside it.
    this.persistInFlightSince = Date.now();
    const writeStartedAt = Date.now();
    // One file per **changed** session, plus the index — never the whole window at once.
    const pending = this.writePayload(built, payload, summaries);
    const tQueue = Date.now();
    // Where the synchronous part of a write goes, in one line: the change detection
    // (`select`), the payload build of what changed (`build`) and queuing it (`queue`).
    // `persist-queued` is the sum, and this is what says which of the three to look at.
    perf(
      () =>
        `persist-phases select=${tBuild - tSelect}ms build=${tQueue - tBuild}ms queue=${Date.now() - tQueue}ms ` +
        `dirtyNodes=${built.reduce((n, b) => n + b.dirtyNodes.length, 0)}`,
    );
    // The control plane awaits these before handing over to a reboot, so a kill
    // right after a turn cannot lose the last write.
    this.trackWrite(pending);
    // Keep the pointer key in step with the blob (it is the one the next
    // activation reads first) — cheap, and it never writes the same value twice.
    this.persistActiveSession();
    perf(() => `persist-queued ${Date.now() - t0}ms ${extra} chars≈${chars}`);
    void pending.then(
      (stats) => {
        if (stats) {
          // The write's own cost, measured inside the queue. `persist-done` below measures how
          // late the callback ran on a busy host, which is a different question.
          perf(() => `persist-written ms=${stats.ms} writes=${stats.writes} skipped=${stats.skipped} chars=${stats.chars}`);
        }
        this.persistLastMs = Date.now() - writeStartedAt;
        this.persistInFlightSince = 0;
        this.persistLastDoneAt = Date.now();
        perf(() => `persist-done ${Date.now() - t0}ms ${extra} chars≈${chars}`);
      },
      (err: unknown) => {
        this.persistLastMs = Date.now() - writeStartedAt;
        this.persistInFlightSince = 0;
        this.persistLastDoneAt = Date.now();
        perf(
          () => `persist-fail ${Date.now() - t0}ms ${extra} ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
  }

  /**
   * Write anything pending and resolve once every write has settled — the
   * hand-off point for the control plane (`/wait-for-finish`, `/reload-window`)
   * and for extension deactivation, where a coalesced write must not be lost.
   */
  async flushPersist(): Promise<void> {
    if (this.dirty || this.persistTimer != null) {
      this.persistNow();
    }
    await this.lastPersist;
    // The store's queue is where the bytes actually go; a hand-off that does not await
    // it can lose the just-finished turn.
    await this.store?.flush();
  }

  /**
   * The ` | ctx:` tail of a `lag blocked` line: one line, O(1), answering "what is
   * most likely blocking the host right now?". Registered with
   * `setLagContextProvider` in the constructor and asked once per reported stall
   * burst.
   *
   * It must never build a payload, `JSON.stringify` anything or walk
   * sessions/nodes/messages: it runs *after* the loop was blocked, so any real work
   * here would only extend the stall it describes. Everything it prints was already
   * computed by `persistNow()` (kept in fields for exactly this) or is a counter
   * read (`dirty`, `deferredWrites`, `Map.size`).
   *
   * Extension point: the next useful term is a *per-instant* blocker counter — how
   * many tree rebuilds, sub-agent jobs and streaming turns are live right now. Those
   * live in `src/chat/runtime.ts`; when they are wired up, keep them as plain
   * counters on the existing objects (never a walk) and append them below.
   */
  private hostContext(): string {
    const now = Date.now();
    const persist = this.persistInFlightSince
      ? `persist in-flight ${now - this.persistInFlightSince}ms`
      : this.persistLastDoneAt
        ? `persist idle, last done ${now - this.persistLastDoneAt}ms ago (took ${this.persistLastMs}ms)`
        : 'persist idle, none this window';
    // `deferredWrites` counts the content changes coalesced behind the running (or
    // pending) write, so a rising `queued=` is a burst accumulating.
    const queued = this.dirty ? this.deferredWrites : 0;
    // Live units of host work (`rg:15` while 15 sub-agents search at once, …) plus the
    // open webview ops: a stall the persistence side cannot explain has to name whatever
    // else was running, or the next investigation starts from zero again.
    const work = [workReadout(), liveOpCount() ? `op:${liveOpCount()}` : ''].filter(Boolean).join(' ');
    return (
      `${persist}, chars≈${this.persistChars}, queued=${queued}` +
      (work ? `, work=[${work}]` : ', work=[idle]') +
      ` | ${heapReadout()}` +
      (this.persistCounts ? `, ${this.persistCounts}` : '')
    );
  }

  /**
   * The perf tee: every `[perf]` (and `harnessLog`) line also goes to a file.
   *
   * **It is on in a released build**, because the person who has to send the file is a user
   * with a slow machine, not a developer with an environment variable: the Spinney output
   * channel has no read-back API, so a file is the only thing a report can contain. The file
   * is one per window, bounded by rotation, and only the newest few survive
   * (`src/chat/diagnosticsLog.ts`); `spinney.diagnostics.log` turns it off.
   *
   * `SPINNEY_PERF_LOG` still wins when it is set: that is how the simulation harness
   * (`tools/sim/run.mjs`) reads the lines, and it must be able to point the log anywhere.
   *
   * A *bounded* async writer on purpose: an append must never block the host (that is the very
   * thing the perf lines measure), so writes go through a stream (`fs.createWriteStream`,
   * flags `'a'`) instead of `appendFileSync`; past {@link PERF_TEE_MAX_BUFFER} of un-flushed
   * bytes lines are dropped rather than queued, and every error is swallowed. The output
   * channel stays the primary sink, so a failing tee can never lose a diagnostic line.
   */
  private openPerfTee(): void {
    const requested = (process.env.SPINNEY_PERF_LOG ?? '').trim();
    let file = requested;
    if (!file && this.diagnosticsEnabled()) {
      const dir = this.store?.root ?? (this.globalStorage ? path.join(this.globalStorage.fsPath, 'spinney') : '');
      if (dir) {
        file = prepareDiagnosticsLog(dir, process.pid);
      }
    }
    if (!file || this.perfTee) {
      return;
    }
    try {
      const fresh = !fs.existsSync(file) || fs.statSync(file).size === 0;
      const stream = fs.createWriteStream(file, { flags: 'a' });
      // A dev-only tee must never surface an error (a read-only path, a full disk):
      // swallowing the event is what keeps an EPIPE from becoming an unhandled one.
      stream.on('error', () => undefined);
      this.perfTee = stream;
      this.perfTeeFile = file;
      if (fresh) {
        // Self-describing, and the first thing a reader sees: this file exists to be sent.
        stream.write(diagnosticsHeader(file, this.extensionVersion));
      }
    } catch {
      this.perfTee = null;
      this.perfTeeFile = null;
    }
  }

  /** Is the diagnostics log enabled? A setting, so a user can stop the file. */
  private diagnosticsEnabled(): boolean {
    return vscode.workspace.getConfiguration('spinney').get<boolean>('diagnostics.log') ?? true;
  }

  /**
   * `Spinney: Open Diagnostics Log` — reveal the newest log in the OS file manager. Without it
   * a user asked to "send the log" has to be told a path with a profile name in it; with it
   * they get the file selected and can attach it.
   */
  async openDiagnosticsLog(): Promise<void> {
    const dir = this.store?.root ?? (this.globalStorage ? path.join(this.globalStorage.fsPath, 'spinney') : '');
    const file = dir ? newestDiagnosticsLog(dir) : null;
    if (!file) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Spinney: no diagnostics log yet. Use the extension for a moment, or turn on spinney.diagnostics.log.'),
      );
      return;
    }
    const open = vscode.l10n.t('Show in Explorer');
    const answer = await vscode.window.showInformationMessage(
      vscode.l10n.t('Spinney: diagnostics log: {0}', file),
      open,
    );
    if (answer === open) {
      void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(file));
    }
  }

  /** Read this extension's own version (and remember it) — the build's name. */
  private readOwnVersion(extensionUri: vscode.Uri): void {
    try {
      const raw = fs.readFileSync(path.join(extensionUri.fsPath, 'package.json'), 'utf8');
      const parsed = JSON.parse(raw) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version) {
        this.extensionVersion = parsed.version;
      }
    } catch {
      /* an unreadable package.json is not a reason to fail activation */
    }
  }

  /**
   * One line describing the machine, the build and where the data lives — the context every
   * other line needs. A report from a user's machine is unreadable without it: which build
   * ran, which VS Code (that decides whether the bundled ripgrep is findable at all), how
   * many cores, and which workspace and store root are in play.
   */
  private logEnvironment(): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const memGb = (os.totalmem() / 1024 ** 3).toFixed(1);
    perf(
      () =>
        `env version=${this.extensionVersion} diag=${this.diagnosticsEnabled() ? 'on' : 'off'} ` +
        `vscode=${vscode.version} node=${process.versions.node} ${process.platform}-${process.arch} ` +
        `cpus=${os.cpus().length} mem=${memGb}GB appRoot=${vscode.env.appRoot || '(none)'} ` +
        `folders=${folders.length}${folders[0] ? ` root=${folders[0].uri.fsPath}` : ''} ` +
        `store=${this.store?.root ?? '(none)'} key=${workspaceKeyFor(folders[0]?.uri.toString())} ` +
        `language=${vscode.env.language}`,
    );
  }

  /**
   * The settings this build actually reads, resolved once, in one line: a report that says
   * "still slow with 15 sub-agents" is only interpretable next to the concurrency limits,
   * the transcript settings and the data folder that were in force.
   */
  private logEffectiveConfig(): void {
    const cfg = this.getConfig();
    const raw = vscode.workspace.getConfiguration('spinney');
    const num = (key: string, fallback: number): number => raw.get<number>(key) ?? fallback;
    perf(
      () =>
        `config effective maxSubagents=${cfg.maxConcurrentSubagents} maxLevel2=${cfg.maxLevel2Subagents} ` +
        `maxInlineToolOutput=${num('maxInlineToolOutput', 32768)} ` +
        `commandMaxForegroundDuration=${num('commandMaxForegroundDuration', 300)}s ` +
        `saveSessionTranscripts=${cfg.saveSessionTranscripts} saveSubAgentTranscripts=${cfg.saveSubAgentTranscripts} ` +
        `transcriptDir=${cfg.subAgentTranscriptDir || '(global storage)'} ` +
        `dataDir=${(raw.get<string>('dataDir') ?? '').trim() || '(default)'} ` +
        `autoSessionTitles=${cfg.autoSessionTitles} replyLanguage=${cfg.replyLanguage} ` +
        `defaultCard=${cfg.defaultCardId} providers=${providerSpecs().length} cards=${cards().length}`,
    );
  }

  /**
   * `<line> | at=<ISO>` — every line that reaches the output channel or the diagnostics file
   * carries the time it was written, because neither has a per-line clock of its own: the
   * log's header only names when the window started, so "when did this happen?" — and worse,
   * "was there a hole here?" — used to be unanswerable. A tool that hangs writes no line at
   * all until it returns, which is why `executeToolCall` announces each call's start.
   *
   * A **suffix**, deliberately, not a prefix: `tools/sim/run.mjs` (`analysePerfLog`) keeps
   * lines with `startsWith('[perf]')`, strips `^\[perf\]\s*` and then matches several
   * `^`-anchored patterns (`^lag blocked`, `^persist-queued`, `^op#…`), so a prefix would
   * silently drop every one of those measurements; a suffix breaks nothing (its only
   * `$`-anchored shape tolerates a trailing detail). The diagnostics header lines keep
   * their `#` shape — they are written straight to the stream by `openPerfTee`.
   */
  private stampLine(line: string): string {
    // Idempotent: a line may pass through here twice — the perf sink and `outputLog` stamp
    // before writing, and the channel stamps whatever it is handed (`StampedOutputChannel`) —
    // and two timestamps on one line would be a bug of its own.
    return line.includes(' | at=') ? line : `${line} | at=${new Date().toISOString()}`;
  }

  /** Append one perf line to the dev-only tee (see `openPerfTee`); never blocks. */
  private teePerfLine(line: string): void {
    const stream = this.perfTee;
    if (!stream) {
      return;
    }
    if (stream.writableLength > PERF_TEE_MAX_BUFFER) {
      this.perfTeeDropped++;
      return;
    }
    try {
      stream.write(`${line}\n`);
    } catch {
      /* dev-only tee: losing a line here must not affect the host */
    }
  }

  /**
   * Flush and close the dev-only tee. Called from `dispose()`, i.e. also from
   * `shutdown()` (which awaits `flushPersist()` first, so the teed lines of the last
   * write are still written). A gap is reported *into the file*, where the harness
   * reading it can see it.
   */
  private closePerfTee(): void {
    const stream = this.perfTee;
    const dropped = this.perfTeeDropped;
    this.perfTee = null;
    this.perfTeeDropped = 0;
    if (!stream) {
      return;
    }
    try {
      if (dropped > 0) {
        stream.write(`[perf] dev tee dropped ${dropped} line(s) (SPINNEY_PERF_LOG could not keep up)\n`);
      }
      stream.end();
    } catch {
      /* dev-only tee */
    }
  }

  /** The last focused tab's session id (persisted active session). */
  get currentSessionId(): string {
    return this.activeSessionId;
  }

  private getActiveSession(): AgentSession | undefined {
    return this.sessions.find((s) => s.id === this.activeSessionId);
  }

  /** Notify the host (the sidebar) that some state it renders has changed. */
  stateChanged(): void {
    this.notifyStateChanged();
    // The room's `instances` announcement is what a peer's tree draws, so it follows the
    // same changes the sidebar does. The service coalesces, and with no room online it
    // returns immediately (see `RemoteService.onLocalStateChanged`).
    this.remoteService?.onLocalStateChanged();
  }

  /**
   * Fire the sidebar refresh — and keep an eye on it. A refresh makes VS Code
   * re-read every session row (title, node count, "time ago"), so it is the
   * cheapest way to make a session switch stutter: it is reported when one call
   * takes real time, or when they come in faster than a human can read them.
   */
  private notifyStateChanged(): void {
    const t0 = Date.now();
    this.onStateChanged?.();
    const ms = Date.now() - t0;
    if (ms >= 50) {
      perf(`sidebar-refresh ${ms}ms (${this.sessions.length} sessions)`);
    }
    const now = Date.now();
    if (this.refreshWindow === 0) {
      this.refreshWindow = now;
    }
    this.refreshCount++;
    if (now - this.refreshWindow >= 1000) {
      if (this.refreshCount >= 10) {
        perf(`sidebar-refresh ${this.refreshCount}/s`);
      }
      this.refreshCount = 0;
      this.refreshWindow = now;
    }
  }

  /** Sidebar rows: one per session, newest update first. */
  getSessionTreeItems(): SessionTreeItem[] {
    return this.sessions
      .map((s) => {
        const rt = this.runtimes.get(s.id);
        const runningBg = rt ? rt.hasRunningNodeBackground() : false;
        return {
          id: s.id,
          title: s.title,
          updatedAt: s.updatedAt,
          nodeCount: Object.keys(s.nodes).length,
          active: s.id === this.activeSessionId,
          busy: (rt ? rt.isRunning() : false) || runningBg,
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private createSessionInMemory(): AgentSession {
    const session: AgentSession = {
      id: newId(),
      title: defaultSessionTitle(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      nodes: {},
      rootIds: [],
      activeNodeId: null,
      orphanItems: [],
    };
    this.sessions.push(session);
    this.activeSessionId = session.id;
    return session;
  }

  // ---- Session titles (automatic + explicit) ----

  /**
   * Apply a title to a session and propagate it everywhere it is shown (sidebar
   * list + editor tab title). `manual` locks the title so the automatic namer
   * never overwrites it; `auto` records the growth/cooldown bookkeeping. The
   * session's `updatedAt` is deliberately untouched: renaming must not reorder
   * the sidebar (which sorts by it).
   */
  private applySessionTitle(session: AgentSession, title: string, source: TitleSource): void {
    const clean = sanitizeTitle(title, '');
    if (!clean) {
      return;
    }
    const changed = clean !== session.title || source !== session.titleSource;
    session.title = clean;
    session.titleSource = source;
    if (source === 'manual') {
      session.titleLocked = true;
      delete session.titleAutoAt;
      delete session.titleAutoNodes;
    } else if (source === 'auto') {
      session.titleAutoAt = Date.now();
      session.titleAutoNodes = turnCount(session);
    }
    this.persist();
    if (!changed) {
      return; // bookkeeping only (same title, refreshed cooldown)
    }
    this.notifyStateChanged();
    this.panels.setTitle(session.id, this.panelTitle(session.id));
  }

  /**
   * Set a session title explicitly (sidebar command or the `rename_session`
   * tool) and lock it against the automatic namer.
   */
  renameSession(sessionId: string, title: string): { ok: boolean; error?: string; title?: string } {
    if (this.readOnly) {
      return { ok: false, error: this.readOnlyNotice() };
    }
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) {
      return { ok: false, error: `no such session: ${sessionId}` };
    }
    const clean = sanitizeTitle(title, '');
    if (!clean) {
      return { ok: false, error: 'the title is empty' };
    }
    this.applySessionTitle(session, clean, 'manual');
    this.outputLog(`[title] ${session.id} -> "${clean}" (manual, locked)`);
    return { ok: true, title: clean };
  }

  /** `rename_session` tool: an explicit, locking rename (main agent only). */
  handleRenameSession(args: Record<string, unknown>): string {
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    if (!title) {
      return 'Error: "title" is required.';
    }
    const wanted = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
    const session = wanted ? this.sessions.find((s) => s.id === wanted) : this.getActiveSession();
    if (!session) {
      return `Error: no such session: ${wanted || '(active)'}.`;
    }
    const result = this.renameSession(session.id, title);
    if (!result.ok) {
      return `Error: ${result.error}`;
    }
    return `Renamed session ${session.id} to "${result.title}". Automatic naming is now locked for it.`;
  }

  /** Sidebar command: ask for a title and lock it. */
  async renameSessionInteractive(arg: unknown): Promise<void> {
    const session = this.sessionFromArg(arg);
    if (!session) {
      return;
    }
    const title = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Session title — renaming locks it, so automatic naming will not overwrite it.'),
      value: session.title,
      placeHolder: vscode.l10n.t('Short, one line'),
      validateInput: (value) => (value.trim() ? undefined : vscode.l10n.t('A title is required.')),
    });
    if (title === undefined) {
      return; // cancelled
    }
    this.renameSession(session.id, title);
  }

  /** Sidebar command: drop the manual lock and regenerate the title now. */
  async autoRenameSession(arg: unknown): Promise<void> {
    const session = this.sessionFromArg(arg);
    if (!session) {
      return;
    }
    if (!buildTitleDigest(session)) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('This session has no conversation yet — there is nothing to name from.'),
      );
      return;
    }
    session.titleLocked = false;
    delete session.titleAutoAt;
    delete session.titleAutoNodes;
    this.persist();
    this.outputLog(`[title] ${session.id} unlocked; regenerating`);
    await this.generateSessionTitle(session, 'requested');
  }

  /** Resolve a command argument (session id string or tree item) to a session. */
  private sessionFromArg(arg: unknown): AgentSession | undefined {
    const id =
      typeof arg === 'string'
        ? arg
        : arg && typeof arg === 'object' && 'id' in arg
          ? String((arg as { id?: unknown }).id ?? '')
          : '';
    return id ? this.sessions.find((s) => s.id === id) : this.getActiveSession();
  }

  /** Queue a session for an automatic (re)title, if the gates allow it. */
  requestAutoTitle(session: AgentSession): void {
    if (!this.getConfig().autoSessionTitles) {
      return;
    }
    if (!shouldAutoTitle(session)) {
      return;
    }
    this.titlePending.add(session.id);
    this.scheduleTitleDrain();
  }

  /** Coalesce title work so a burst of finished turns issues at most one pass. */
  private scheduleTitleDrain(): void {
    if (this.titleDrainTimer != null) {
      return;
    }
    this.titleDrainTimer = setTimeout(() => {
      this.titleDrainTimer = null;
      void this.drainTitles();
    }, 1200);
  }

  /**
   * Run the queued title jobs one at a time. A title request is a small
   * independent completion, so it does not need the agent to be idle — only
   * serialized against another title request.
   */
  private async drainTitles(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.titleJob) {
      this.scheduleTitleDrain();
      return;
    }
    const id = [...this.titlePending][0];
    if (id === undefined) {
      return;
    }
    this.titlePending.delete(id);
    const session = this.sessions.find((s) => s.id === id);
    if (session) {
      await this.generateSessionTitle(session, 'auto');
    }
    if (this.titlePending.size > 0) {
      this.scheduleTitleDrain();
    }
  }

  /**
   * Generate a title for one session with a single non-streaming completion and
   * apply it. Never throws: no API key, a timeout or an API error falls back to
   * the heuristic (first-prompt) title. A manual rename that lands while the
   * request is in flight wins.
   */
  private async generateSessionTitle(session: AgentSession, reason: string): Promise<void> {
    if (this.titleJob) {
      // One title request at a time; retry once the current one lands.
      this.titlePending.add(session.id);
      this.scheduleTitleDrain();
      return;
    }
    const digest = buildTitleDigest(session);
    if (!digest) {
      return;
    }
    const controller = new AbortController();
    this.titleJob = { sessionId: session.id, controller };
    const timer = setTimeout(() => controller.abort(), TITLE_REQUEST_TIMEOUT_MS);
    const t0 = Date.now();
    let title = '';
    let how = 'model';
    const card = resolveCard(this.effectiveModel(session)) ?? cards()[0];
    try {
      // Titles are bookkeeping: they go through the *card's* provider but take no
      // concurrency slot, so a batch of them can never starve the conversation.
      const { text, usage } = await this.clients.complete(card, {
        messages: buildTitleMessages(digest, session.title),
        maxTokens: TITLE_MAX_TOKENS,
        temperature: 0.3,
        signal: controller.signal,
      });
      title = sanitizeTitle(text, '');
      if (usage) {
        this.outputLog(`[title] ${session.id} model=${cardDisplayName(card)} tokens=${usage.total_tokens}`);
      }
    } catch (err) {
      how = 'heuristic';
      this.outputLog(`[title] ${session.id} model call failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
      this.titleJob = null;
    }
    if (this.disposed || !this.sessions.includes(session) || session.titleLocked) {
      return;
    }
    if (!title) {
      title = heuristicTitle(session);
      how = 'heuristic';
    }
    this.applySessionTitle(session, title, 'auto');
    this.outputLog(`[title] ${session.id} -> "${session.title}" (${how}, ${reason}, ${Date.now() - t0}ms)`);
  }

  private scheduleTitleBackfill(): void {
    if (this.readSmall<string>(TITLE_BACKFILL_KEY) === TITLE_BACKFILL_VERSION) {
      return;
    }
    // Not marked when the setting is off, so enabling it later still backfills.
    if (!this.getConfig().autoSessionTitles) {
      return;
    }
    setTimeout(() => void this.backfillSessionTitles(), 3000);
  }

  /**
   * Name the sessions that predate automatic naming (and any session whose title
   * is still provisional), once. Batched so a long history costs a handful of
   * requests instead of one per session; a line the model failed to answer falls
   * back to the heuristic title. The marker is only written when the pass
   * completes, so an interrupted one resumes on the next activation.
   */
  private async backfillSessionTitles(): Promise<void> {
    const t0 = Date.now();
    const deadline = t0 + TITLE_BACKFILL_DEADLINE_MS;
    const done = new Set<string>();
    let renamed = 0;
    let visited = 0;
    while (!this.disposed && Date.now() < deadline) {
      const eligible = this.sessions.filter(
        (s) => !done.has(s.id) && shouldAutoTitle(s) && !!buildTitleDigest(s),
      );
      if (eligible.length === 0) {
        break;
      }
      const batch = eligible.slice(0, TITLE_BATCH_SIZE);
      for (const session of batch) {
        done.add(session.id);
      }
      // Only serialize against another title request: a small non-streaming
      // completion is safe while a turn streams.
      while (!this.disposed && this.titleJob) {
        if (Date.now() >= deadline) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (this.disposed || Date.now() >= deadline) {
        break;
      }
      visited += batch.length;
      const result = await this.generateTitleBatch(batch);
      if (!result.ok) {
        // The model is unavailable (no key / API error). Leave the marker unset
        // so the pass retries once a key is configured, instead of stamping the
        // sessions with the titles they already had.
        this.outputLog(`[title] backfill paused: model unavailable (${visited} visited)`);
        return;
      }
      renamed += result.renamed;
    }
    if (this.disposed || Date.now() >= deadline) {
      this.outputLog(`[title] backfill paused (${visited} visited, ${Date.now() - t0}ms)`);
      return; // marker unset ⇒ resumes next activation
    }
    await this.writeSmall(TITLE_BACKFILL_KEY, TITLE_BACKFILL_VERSION);
    this.outputLog(`[title] backfill: ${renamed}/${visited} renamed in ${Date.now() - t0}ms`);
  }

  /** One batched backfill request; reports whether the model answered. */
  private async generateTitleBatch(sessions: AgentSession[]): Promise<{ renamed: number; ok: boolean }> {
    const entries = sessions.map((s) => ({
      id: s.id,
      currentTitle: s.title,
      digest: buildTitleDigest(s),
    }));
    const controller = new AbortController();
    this.titleJob = { sessionId: sessions[0].id, controller };
    const timer = setTimeout(() => controller.abort(), TITLE_REQUEST_TIMEOUT_MS);
    let titles: Array<string | null> = entries.map(() => null);
    let ok = true;
    const card = resolveCard(this.defaultModel) ?? cards()[0];
    try {
      // Ungated like the single title request (see `generateSessionTitle`).
      const { text, usage } = await this.clients.complete(card, {
        messages: buildBatchTitleMessages(entries),
        maxTokens: TITLE_BATCH_MAX_TOKENS,
        temperature: 0.3,
        signal: controller.signal,
      });
      titles = parseBatchTitles(text, entries.length);
      if (usage) {
        this.outputLog(`[title] batch of ${entries.length} tokens=${usage.total_tokens}`);
      }
    } catch (err) {
      ok = false;
      this.outputLog(`[title] batch failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
      this.titleJob = null;
    }
    if (!ok) {
      return { renamed: 0, ok: false };
    }
    let renamed = 0;
    for (let i = 0; i < sessions.length; i++) {
      if (this.disposed) {
        break;
      }
      const session = sessions[i];
      if (!this.sessions.includes(session) || session.titleLocked) {
        continue;
      }
      const before = session.title;
      // A line the model omitted falls back to the heuristic (first prompt).
      this.applySessionTitle(session, titles[i] ?? heuristicTitle(session), 'auto');
      if (session.title !== before) {
        renamed++;
      }
    }
    this.outputLog(`[title] backfill batch: ${renamed}/${sessions.length} renamed`);
    return { renamed, ok: true };
  }

  // ---- Transcripts ----

  /**
   * Root folder holding every session's transcript dumps (`<root>/<sessionId>/`).
   * Defaults to the extension's global storage (never the user's repo);
   * `spinney.subAgentTranscriptDir` redirects it, with a relative path
   * resolving against the harness root (the workspace folder, or the scratch
   * folder when no folder is open).
   */
  transcriptRoot(): string {
    const configured = this.getConfig().subAgentTranscriptDir;
    if (configured) {
      return resolvePath(configured);
    }
    if (this.globalStorage) {
      return path.join(this.globalStorage.fsPath, 'transcripts');
    }
    return path.join(os.tmpdir(), 'spinney-transcripts');
  }

  /** One session's transcript folder (main-agent turns + sub-agent runs). */
  transcriptDir(sessionId: string): string {
    return path.join(this.transcriptRoot(), sessionId);
  }

  /**
   * Dump a finished main-agent turn to `<transcriptDir>/<nodeId>.jsonl`. Session
   * history otherwise lives only in the Memento (a sqlite blob no tool can
   * grep), so this is what makes `search_transcripts` able to recall a previous
   * conversation. Mirrors the node: a turn that a later injected notice turn
   * reuses is rewritten. Never throws into the agent loop.
   */
  dumpSessionTranscript(node: TreeNode, session: AgentSession, status: TurnStatus): void {
    if (!this.getConfig().saveSessionTranscripts || isSidecar(node)) {
      return;
    }
    const messages = node.messages;
    if (messages.length === 0) {
      return;
    }
    const first = messages[0];
    const prompt = first.role === 'user' ? messageText(first.content) : node.title;
    try {
      const ref = writeSessionTranscript({
        dir: this.transcriptDir(session.id),
        nodeId: node.id,
        sessionId: session.id,
        sessionTitle: session.title,
        parentId: node.parentId,
        pathIds: pathIds(session, node.id),
        // Where this turn's context window started, so a reader of the dump knows
        // why the prefix it describes has no ancestor history.
        contextBaseId: node.contextBaseId,
        title: node.title,
        model: this.modelLabelFor(this.runtimes.get(session.id)?.model ?? this.defaultModel),
        status,
        prompt,
        summary: this.summaryPreview(node),
        startedAt: node.createdAt,
        endedAt: Date.now(),
        messages,
        usage: nodeUsage(node),
      });
      this.output.appendLine(`[transcript] session ${ref.file} lines=${ref.lines} bytes=${ref.bytes}`);
      // A turn a peer started also records **where it came from**, in the dump's line-1
      // meta record (`docs/agents/plans/remote-control.md` §13) — never in the message
      // text: the bytes the provider sees must not change. The writer's meta is a fixed
      // field list, so the record is completed here once its queued write has landed.
      const origin = nodeOrigin(node);
      if (origin) {
        void flushTranscripts()
          .then(() => writeOriginIntoTranscript(ref.file, origin))
          .catch(() => undefined);
      }
    } catch (err) {
      this.output.appendLine(`[transcript] session write failed for ${node.id}: ${String(err)}`);
    }
  }

  /**
   * One-time backfill: sessions whose turns finished before the transcript
   * dumps existed have no JSONL on disk, so `search_transcripts` cannot see
   * them. Walk the restored trees once and dump every node that has no file yet
   * — an existing dump is never overwritten. Deferred off activation (the UI is
   * already up) and remembered in the Memento, so it costs one pass per install.
   */
  private scheduleTranscriptBackfill(): void {
    if (this.readSmall<string>(TRANSCRIPT_BACKFILL_KEY) === TRANSCRIPT_BACKFILL_VERSION) {
      return;
    }
    // Not marked when the setting is off, so enabling it later still backfills.
    if (!this.getConfig().saveSessionTranscripts) {
      return;
    }
    setTimeout(() => void this.backfillTranscripts(), 1500);
  }

  private async backfillTranscripts(): Promise<void> {
    const t0 = Date.now();
    let written = 0;
    let skipped = 0;
    let bytes = 0;
    let visited = 0;
    for (const session of [...this.sessions]) {
      const dir = this.transcriptDir(session.id);
      for (const node of Object.values(session.nodes)) {
        if (this.disposed) {
          // Marker left unset: the next activation resumes (files already
          // written are skipped, so an interrupted pass just fills the gaps).
          return;
        }
        if (node.messages.length === 0) {
          continue;
        }
        if (fs.existsSync(path.join(dir, `${node.id}.jsonl`))) {
          skipped++;
          continue;
        }
        try {
          bytes += this.writeBackfillDump(session, node, dir);
          written++;
        } catch (err) {
          this.output.appendLine(`[transcript] backfill failed for ${session.id}/${node.id}: ${String(err)}`);
        }
        // Yield periodically so a huge history cannot stall the extension host.
        if (++visited % 25 === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    }
    await this.writeSmall(TRANSCRIPT_BACKFILL_KEY, TRANSCRIPT_BACKFILL_VERSION);
    this.output.appendLine(
      `[transcript] backfill: ${written} written, ${skipped} already on disk, ${(bytes / 1024).toFixed(1)} KB, ${
        Date.now() - t0
      }ms`,
    );
  }

  /** Reconstruct one historical node's dump (main-agent turn or sub-agent run). */
  private writeBackfillDump(session: AgentSession, node: TreeNode, dir: string): number {
    const first = node.messages[0];
    const prompt = first && first.role === 'user' ? messageText(first.content) : node.title;
    if (node.kind === 'agent') {
      return writeSubAgentTranscript({
        dir,
        nodeId: node.id,
        sessionId: session.id,
        depth: node.agentDepth ?? 1,
        write: !!node.agentWrite,
        model: this.modelLabelFor(node.agentModel || this.runtimes.get(session.id)?.model || this.defaultModel),
        status: node.agentStatus ?? node.status,
        resumed: false,
        instruction: node.title,
        summary: node.agentSummary ?? this.summaryPreview(node),
        // Both timestamps are the node's creation time (only that survives in
        // the tree); `backfilled: true` marks the dump as reconstructed.
        startedAt: node.createdAt,
        endedAt: node.createdAt,
        // A sub-agent's synthesized prompt is not stored on its node.
        systemPrompt: '',
        messages: node.messages,
        usage: nodeUsage(node),
        backfilled: true,
      }).bytes;
    }
    return writeSessionTranscript({
      dir,
      nodeId: node.id,
      sessionId: session.id,
      sessionTitle: session.title,
      parentId: node.parentId,
      pathIds: pathIds(session, node.id),
      title: node.title,
      model: this.modelLabelFor(this.runtimes.get(session.id)?.model ?? this.defaultModel),
      status: node.status,
      prompt,
      summary: this.summaryPreview(node),
      startedAt: node.createdAt,
      endedAt: node.createdAt,
      messages: node.messages,
      usage: nodeUsage(node),
      backfilled: true,
    }).bytes;
  }

  /**
   * Dump a finished sub-agent's whole conversation (system prompt + every API
   * message, tool calls and results included) to `<transcriptDir>/<nodeId>.jsonl`.
   * Never throws into the agent loop: a failure just leaves the node without a
   * transcript path.
   */
  writeSubAgentTranscript(
    job: SubAgentJob,
    subAgent: Agent,
    status: string,
    summary: string,
    startedAt: number,
  ): string | undefined {
    if (!this.getConfig().saveSubAgentTranscripts) {
      return undefined;
    }
    const all = subAgent.getMessages();
    const first = all[0];
    const systemPrompt =
      first && first.role === 'system' && typeof first.content === 'string' ? first.content : '';
    const sessionId = job.sessionId ?? this.activeSessionId ?? 'unknown';
    try {
      const ref = writeSubAgentTranscript({
        dir: this.transcriptDir(sessionId),
        nodeId: job.node.id,
        sessionId,
        depth: job.node.agentDepth ?? 1,
        write: job.spec.write,
        model: this.modelLabelFor(
          job.spec.model || job.node.agentModel || this.runtimes.get(sessionId)?.model || this.defaultModel,
        ),
        status,
        resumed: !!job.resume,
        instruction: job.spec.instruction,
        summary,
        startedAt,
        endedAt: Date.now(),
        systemPrompt,
        messages: all.filter((m) => m.role !== 'system'),
        usage: sumUsage(job.node.displayItems.map((item) => item.usage)),
      });
      this.output.appendLine(`[transcript] ${ref.file} lines=${ref.lines} bytes=${ref.bytes}`);
      return ref.file;
    } catch (err) {
      this.output.appendLine(`[transcript] write failed for ${job.node.id}: ${String(err)}`);
      return undefined;
    }
  }

  /**
   * What a transcript's `model` field should say. A transcript dumps what the API
   * actually received, but the meta line is read by humans and by
   * `search_transcripts`, so it carries the **card's display name** (name, or
   * `name (oaiModel)`) rather than the GUID that `session.model` holds.
   */
  private modelLabelFor(value: string | undefined): string {
    return cardDisplayName(resolveCard(value ?? '') ?? resolveCard(this.defaultModel));
  }

  /** First line of a turn's answer, used as a collapsed-card / transcript summary. */
  private summaryPreview(node: TreeNode): string {
    for (let i = node.displayItems.length - 1; i >= 0; i--) {
      const item = node.displayItems[i];
      if (item.kind === 'assistant' && item.text) {
        return sliceText(item.text.split('\n')[0].trim(), 120);
      }
    }
    return sliceText(node.title, 80);
  }

  // ---- Session hop (global bookkeeping) ----

  /**
   * The agent handed a task to a fresh session via `hop_session`: queue it with a
   * return address. The hop itself can only start once this turn ends, so the
   * provider's session-start queue does the work; the armed `hopReturn` then
   * routes the hopped session's answer back here. `node` is the caller's own node
   * (P3 binds the handler per node); the hop contract is session-wide, so it does
   * not change the behaviour — it just makes the caller explicit.
   */
  handleHopSession(rt: SessionRuntime, node: TreeNode, args: Record<string, unknown>): string {
    void node;
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!prompt) {
      return 'Error: "prompt" is required.';
    }
    if (this.hopReturn) {
      return 'Error: a session hop is already in progress.';
    }
    if (this.pendingSessionStart) {
      return 'Error: a session start is already queued.';
    }
    const session = rt.session;
    if (rt.hasRunningNodeBackground()) {
      return 'Error: a background terminal is still running in this session; finish or kill it before hopping.';
    }
    const returnNodeId = typeof args.returnNodeId === 'string' ? args.returnNodeId.trim() : '';
    if (returnNodeId && !session.nodes[returnNodeId]) {
      return `Error: no such node in this session: ${returnNodeId} (use list_nodes to see the tree).`;
    }
    const title = typeof args.title === 'string' ? sliceText(args.title.trim(), 80) : '';
    this.pendingSessionStart = { title: title || undefined, prompt };
    this.hopReturn = {
      originSessionId: session.id,
      armedAt: Date.now(),
      returnNodeId: returnNodeId || undefined,
    };
    this.outputLog(`[hop] queued: ${prompt.slice(0, 80)}${returnNodeId ? ` (return node ${returnNodeId})` : ''}`);
    return (
      'Queued. This turn is over: a fresh session will run your task now, and when it finishes ' +
      `you will be resumed here with its final answer as a user message` +
      (returnNodeId ? `, as a new branch off node ${returnNodeId}.` : '.')
    );
  }

  /**
   * A turn just finished in a runtime: if a hop is armed and that turn belongs to
   * the hopped session, queue its final answer back to the origin session, then
   * kick any queued `POST /session/start` (the handoff runs once the agent is
   * idle). Folding the kick in here keeps `finishTurn` on the narrow host API.
   */
  queueHopReturn(rt: SessionRuntime, node: TreeNode | null, status: TurnStatus): void {
    this.maybeDeliverHopReturn(rt, node, status);
    // A queued `POST /session/start` (the agent handing a task to a fresh
    // session) runs once this turn is fully closed out.
    this.runPendingSessionStart();
  }

  /**
   * If a hop is armed and the turn that just finished belongs to the hopped
   * session (a session created after the hop was queued), deliver that session's
   * final answer back to the origin session as a queued start.
   */
  private maybeDeliverHopReturn(rt: SessionRuntime, node: TreeNode | null, status: TurnStatus): void {
    const hop = this.hopReturn;
    const session = rt.session;
    if (!hop || session.id === hop.originSessionId) {
      return;
    }
    // Only the freshly created target session counts — a manual session switch
    // while a hop is in flight must not fire the return.
    if ((session.createdAt ?? 0) < hop.armedAt - 1000) {
      return;
    }
    this.hopReturn = null;
    const origin = this.sessions.find((s) => s.id === hop.originSessionId);
    if (!origin) {
      this.outputLog('[hop] origin session is gone; dropping the result');
      return;
    }
    if (this.pendingSessionStart) {
      this.outputLog('[hop] a session start is already queued; dropping the result');
      return;
    }
    const answer = node ? lastAssistantText(node) : '';
    const clipped = answer.length > 8000 ? `${sliceText(answer, 8000)}\n…[truncated]` : answer;
    this.pendingSessionStart = {
      sessionId: hop.originSessionId,
      nodeId: hop.returnNodeId,
      prompt:
        `[session hop receipt] The task you dispatched to the new session "${session.title}" (${session.id}) has finished (status: ${status}).\n` +
        `Its final reply:\n\n${clipped || '(the new session produced no text reply)'}\n\n` +
        `(search_transcripts sessionId=${session.id} has the full trace if you need it)`,
    };
    this.outputLog(
      `[hop] returning to ${hop.originSessionId}` +
        `${hop.returnNodeId ? ` node ${hop.returnNodeId}` : ''} (status ${status}, ${clipped.length} chars)`,
    );
  }

  /** Run a queued session start as soon as the agent is really idle. */
  private runPendingSessionStart(): void {
    const pending = this.pendingSessionStart;
    if (!pending) {
      return;
    }
    if (this.disposed || !this.globallyIdle()) {
      setTimeout(() => this.runPendingSessionStart(), 50);
      return;
    }
    this.pendingSessionStart = null;
    void this.controlStartSession(pending).then(
      (r) => {
        this.outputLog(`[http] queued session/start -> ${JSON.stringify(r)}`);
        if (!r.ok) {
          // A hop whose start failed must not stay armed, or the next turn to
          // finish anywhere would report back into the origin session.
          this.hopReturn = null;
        }
      },
      (err) => {
        this.hopReturn = null;
        this.outputLog(`[http] queued session/start failed: ${err instanceof Error ? err.message : String(err)}`);
      },
    );
  }

  /** True when no session has a run, a sub-agent or a background terminal live. */
  private globallyIdle(): boolean {
    for (const rt of this.runtimes.values()) {
      if (rt.isRunning() || rt.runningSubAgentCount() > 0 || rt.hasRunningNodeBackground()) {
        return false;
      }
    }
    return true;
  }

  private anyRunningTurn(): boolean {
    for (const rt of this.runtimes.values()) {
      if (rt.isRunning()) {
        return true;
      }
    }
    return false;
  }

  private anyRunningBackground(): boolean {
    for (const rt of this.runtimes.values()) {
      if (rt.hasRunningNodeBackground()) {
        return true;
      }
    }
    return false;
  }

  private anyRunningSubAgents(): boolean {
    for (const rt of this.runtimes.values()) {
      if (rt.runningSubAgentCount() > 0) {
        return true;
      }
    }
    return false;
  }

  // ---- Panel lifecycle ----

  private panelTitle(sessionId: string): string {
    const session = this.sessions.find((s) => s.id === sessionId);
    return vscode.l10n.t('Agent Chat Tree — {0}', session ? session.title : vscode.l10n.t('Session'));
  }

  /** A tab became the focused one: `activeSessionId` is exactly that. */
  private onPanelFocus(sessionId: string): void {
    this.setActiveSession(sessionId);
  }

  /**
   * Mark a session as the active one (sidebar highlight, palette fallbacks, and
   * the control plane's `sessionId`/`nodeId` readout — `hvsc` carries those into
   * its `/continue`). Called when a tab gains focus *and* whenever a caller
   * explicitly shows a session (`openSession`, `POST /navigate`): a window that is
   * not focused may never deliver `onDidChangeViewState`, and the carry must not
   * depend on it.
   */
  private setActiveSession(sessionId: string): void {
    if (this.activeSessionId === sessionId) {
      opMark('active-session', 'unchanged');
      return;
    }
    this.activeSessionId = sessionId;
    // The pointer only: the conversation did not change, so this must not
    // re-serialize the whole window state (that was ~1.6 s of blocked host on
    // every switch — see docs/agents/invariants/streaming-perf.md).
    this.persistActiveSession();
    this.notifyStateChanged();
  }

  private onPanelClosed(sessionId: string): void {
    // Closing a tab does NOT delete the session (its runtime keeps running).
    this.output.appendLine(`[panel] closed chat tab for session ${sessionId}`);
    // The tab's own bookkeeping goes with the tab: a tab reopened later has to report its view
    // state as the initial one, and a stall episode cannot outlive the document that was
    // painting. A probe already in flight is deliberately left alone: "no reply in 3000ms" is
    // precisely what a torn-down webview answers, and that is the evidence, not a leftover.
    this.viewStates.delete(sessionId);
    this.stallEpisodes.delete(sessionId);
    this.tabHiddenSince.delete(sessionId);
    // The delivery-failure window is keyed by session *and* message type, so it is dropped by
    // prefix: a tab reopened later starts with a clean slate instead of inheriting the minute a
    // previous document was silent for.
    for (const key of [...this.postFailedAt.keys()]) {
      if (key.startsWith(`${sessionId}\u0000`)) {
        this.postFailedAt.delete(key);
      }
    }
  }

  // ---- View state, and "the tab stopped painting" (webview stalls) ----

  /**
   * `onViewState` (`PanelManager`): record a tab's visible/active pair and write
   * `[panel] session=<id> visible=<bool> active=<bool>` for the **initial** report and for every
   * change, never for a repeat. VS Code re-reports the same pair on every tab switch, and a
   * diagnostics file somebody has to read by hand is the one place repetition costs real time.
   */
  private onPanelViewState(sessionId: string, state: { visible: boolean; active: boolean }): void {
    const before = this.viewStates.get(sessionId);
    this.viewStates.set(sessionId, state);
    if (before && before.visible === state.visible && before.active === state.active) {
      return;
    }
    // Through the perf sink rather than the channel alone: "was the tab even on screen when it
    // froze?" is a question the *file* someone sends has to answer, and only the sink reaches it.
    harnessLog(`[panel] session=${sessionId} visible=${state.visible} active=${state.active}`);
    const now = Date.now();
    if (state.visible) {
      const since = this.tabHiddenSince.get(sessionId);
      this.tabHiddenSince.delete(sessionId);
      // Coming back to a tab is the one moment the host nudges without being asked: the surface
      // was not repainted while the tab was away, a nudge is the only repair that costs no state,
      // and its answer (`webview-nudge-frame`) is what says whether that surface could be
      // repainted or had to be rebuilt (see `VISIBLE_NUDGE_HIDDEN_MS`).
      if (since != null && now - since >= VISIBLE_NUDGE_HIDDEN_MS) {
        this.nudgeOnReturn(sessionId, now - since);
      }
      return;
    }
    this.tabHiddenSince.set(sessionId, now);
  }

  /**
   * One nudge per return to the front, logged with how long the tab was away. It carries
   * `force`, because this is the case a re-applied transform is not enough for: the surface was
   * never repainted while the tab was in the background, and the invalidation that answers a
   * stale raster is dropping and retaking the canvas' layer (`media/main.js` `perfOnNudge`).
   */
  private nudgeOnReturn(sessionId: string, hiddenMs: number): void {
    const panel = this.panels.get(sessionId);
    if (!panel) {
      return;
    }
    const id = ++this.probeSeq;
    perf(`nudge session=${sessionId} probe#${id} reason=visible hidden=${Math.round(hiddenMs)}ms`);
    panel.nudge(id, { reason: 'visible', force: true });
  }

  /**
   * A `postMessage` to a chat tab was rejected: the webview document is gone, so that tab can
   * never show what the host sends it (`ChatPanel.send`). The rejection used to be swallowed, and
   * "the host is posting into a document that is not there" is the first of the two shapes a tab
   * that stopped painting takes — the second, a document that is there and paints nothing, is what
   * the stall report and the probe are for.
   *
   * Once per session, per message type and minute (see {@link POST_FAILED_REPORT_MS}): a turn
   * streaming into a dead document fails hundreds of messages in a row, and the first one carries
   * all of the news.
   */
  private onPostFailed(sessionId: string, type: string): void {
    const key = `${sessionId}\u0000${type}`;
    const now = Date.now();
    if (now - (this.postFailedAt.get(key) ?? 0) < POST_FAILED_REPORT_MS) {
      return;
    }
    this.postFailedAt.set(key, now);
    perf(`post-failed session=${sessionId} type=${type}`);
  }

  /**
   * The host's half of the stall diagnostic, called for every `perfDiag` report *after*
   * `logWebviewReport` wrote that report's own line. Only the reports the host has to **act**
   * on are read here; everything else in the webview's diagnostics is already logged and needs
   * no reaction.
   *
   * Wrapped, because this is bookkeeping sitting next to a live message handler: one bad report
   * must never break a turn, a switch or the UI.
   */
  private onPerfDiag(sessionId: string, report: Record<string, unknown>): void {
    try {
      const kind = typeof report.kind === 'string' ? report.kind : '';
      if (kind === 'stall') {
        this.onStallReport(sessionId, report);
        return;
      }
      if (kind === 'visibility') {
        // A document that goes hidden ends its stall episode **without** a `recovered` (a
        // hidden tab is supposed to stop painting, so there is nothing to recover from), which
        // means the host has to end it here too: kept, this session would count as "already
        // investigated" for the rest of the window and no later stall in it would ever be
        // probed. The probe gate (`visible && active`) already refuses to act on a hidden tab.
        if (report.state === 'hidden') {
          this.endStallEpisode(sessionId);
        }
        return;
      }
      const id = Number(report.id);
      if (!Number.isFinite(id) || id <= 0) {
        return;
      }
      if (kind === 'probe') {
        this.onProbeReply(id);
      } else if (kind === 'probe-frame') {
        this.onProbeFrame(id);
      } else if (kind === 'nudge-frame') {
        this.onNudgeFrame(id);
      }
    } catch (err) {
      perf(`probe-bookkeeping-error ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * The webview reported that a tab stopped painting (`stall`). It wrote its own automatic line
   * through `logWebviewReport`, so this is the host's reaction only — never a second line.
   *
   * A `stale` report is acted on **only** when that session's tab is `visible && active`: VS
   * Code stops animation frames and timers in a tab nobody is looking at, so a hidden tab that
   * is not painting is expected, and investigating it would only produce noise. A `recovered`
   * report clears the episode (and whatever the ladder was still waiting for).
   *
   * WHY the ladder stops where it does: a frozen tab must stay **visible**. Silently repairing
   * it — a forced re-raster, a full `postAllState`, an automatic document reload — hides the
   * defect: the user stops reporting it and walks away thinking the extension is unstable. The
   * nudge is allowed because it is a legitimate cure with no state loss (it only re-applies the
   * existing transform and re-runs relayout, and never moves the camera); everything above it is
   * the user's call, through `Spinney: Reload Chat Webview`.
   */
  private onStallReport(sessionId: string, report: Record<string, unknown>): void {
    const state = typeof report.state === 'string' ? report.state : '';
    if (state === 'recovered') {
      this.endStallEpisode(sessionId);
      return;
    }
    if (state !== 'stale' || this.disposed) {
      return;
    }
    const panel = this.panels.get(sessionId);
    if (!panel || !panel.visible() || !panel.active()) {
      return; // a tab nobody is looking at is allowed to not paint
    }
    if (this.stallEpisodes.has(sessionId)) {
      return; // one ladder per episode: a re-reported `stale` is the same frozen screen
    }
    const now = Date.now();
    const episode: StallEpisode = { startedAt: now };
    this.stallEpisodes.set(sessionId, episode);
    // The episode is recorded before the guards below, because "this episode has already been
    // looked at" has to hold for the whole of it: the webview re-sends a `stale` every 10 s
    // while the screen stays frozen, and a repeat must not restart the investigation.
    //
    // Two ladders in one session stay a minute apart: a tab that stalls, is nudged and stalls
    // again is one condition, and a second probe run inside that minute cannot say more than
    // the first. Only a ladder that really went out starts that clock.
    if (now - (this.lastLadderAt.get(sessionId) ?? 0) < LADDER_COOLDOWN_MS) {
      return;
    }
    // Rung 0: the probe. Its reply, its frame and the nudge's frame continue the ladder in
    // `onProbeReply` / `onProbeFrame` / `onNudgeFrame` below; `0` means the probe guards
    // refused it (no tab, or one probe in the last 10 s), so no ladder ran and none to cool down.
    if (this.requestProbe(sessionId, episode) === 0) {
      return;
    }
    this.lastLadderAt.set(sessionId, now);
  }

  /**
   * Rung 0 of the ladder, and the whole of the op-deadline probe: ask this session's webview
   * what it is doing (`ChatPanel.probe`), which it answers with a `probe` report (its counters
   * and surface readout) and then a `probe-frame` report, both carrying the id. `episode` says
   * which of the two callers this is: a ladder's probe continues into the nudge, while an
   * op-deadline probe stops at the answer — for a cold switch that never reported a paint, the
   * logged reply *is* the evidence, and there is no frame to repair.
   *
   * Returns the probe id, or 0 when the guards refused the probe: no tab, a tab nobody is
   * looking at, or a probe already sent for this session within {@link PROBE_DEDUPE_MS} (the
   * de-dupe that keeps the webview's own stall detector and an op deadline from measuring the
   * same second twice).
   */
  private requestProbe(sessionId: string, episode: StallEpisode | null): number {
    const panel = this.panels.get(sessionId);
    if (!panel || !panel.visible() || !panel.active()) {
      return 0;
    }
    const now = Date.now();
    if (now - (this.lastProbeAt.get(sessionId) ?? 0) < PROBE_DEDUPE_MS) {
      return 0;
    }
    const probeId = ++this.probeSeq;
    this.lastProbeAt.set(sessionId, now);
    this.probeWaits.set(probeId, {
      sessionId,
      episode,
      stage: 'reply',
      requestedAt: now,
      timer: this.armDiagnosticTimer(PROBE_REPLY_TIMEOUT_MS, () => {
        const w = this.probeWaits.get(probeId);
        if (!w) {
          return;
        }
        // The wait is **kept**: a tab whose script the engine froze is not gone, and the answer
        // it gives when it wakes is the whole of the evidence (the measured case answered 257 s
        // after the request, and that number is what identified the freeze). A second, much
        // longer deadline forgets the probe, because the `dead` line is already on the record.
        w.late = true;
        perf(
          `webview-probe-dead session=${sessionId} probe#${probeId} ` +
            `(no reply in ${PROBE_REPLY_TIMEOUT_MS}ms)`,
        );
        w.timer = this.armDiagnosticTimer(PROBE_LATE_WINDOW_MS, () => {
          if (this.probeWaits.get(probeId) === w) {
            this.probeWaits.delete(probeId);
          }
        });
      }),
    });
    // The evidence line first, then the ask: a line written after the call is a line that is
    // missing when the call throws, which is exactly the case this diagnostic exists for.
    perf(`webview-probe-request session=${sessionId} probe#${probeId}`);
    panel.probe(probeId);
    return probeId;
  }

  /** The webview answered a probe: the ladder moves on to the frame that answer promised. */
  private onProbeReply(id: number): void {
    const wait = this.probeWaits.get(id);
    if (!wait || wait.stage !== 'reply') {
      return; // a reply to a probe that was already resolved (or timed out)
    }
    clearTimeout(wait.timer);
    if (wait.late) {
      // The reply missed its deadline and arrived anyway: how much it missed by is the finding
      // (a tab whose script the engine froze answers in one burst when it wakes — 257 s in the
      // case that showed this), and the ladder it belongs to goes on.
      perf(
        `webview-probe-late session=${wait.sessionId} probe#${id} ms=${Date.now() - wait.requestedAt}`,
      );
    }
    if (!wait.episode) {
      this.probeWaits.delete(id); // op-deadline probe: the reply that was just logged is all of it
      return;
    }
    // The reply alone proves nothing about the screen: a script can still run its counters while
    // nothing reaches the surface. The frame is what separates "the tab can paint" from "the tab
    // is alive but its surface is gone", and only the first one is worth nudging.
    wait.stage = 'probe-frame';
    wait.timer = this.armDiagnosticTimer(PROBE_FRAME_TIMEOUT_MS, () => {
      this.probeWaits.delete(id);
      perf(
        `webview-probe-noframe session=${wait.sessionId} probe#${id} ` +
          `(no frame in ${PROBE_FRAME_TIMEOUT_MS}ms)`,
      );
    });
  }

  /**
   * The probe's frame arrived: the tab can still take a frame, and the one repair the host makes
   * on its own is the nudge. Exactly one per episode — the ladder never goes above rung 1, and
   * the reason it cannot is in `onStallReport`.
   */
  private onProbeFrame(id: number): void {
    const wait = this.probeWaits.get(id);
    if (!wait || wait.stage !== 'probe-frame') {
      return;
    }
    clearTimeout(wait.timer);
    const { sessionId, episode } = wait;
    if (!episode) {
      this.probeWaits.delete(id);
      return;
    }
    const panel = this.panels.get(sessionId);
    if (!panel) {
      this.probeWaits.delete(id); // the tab went away mid-ladder: nothing is left to repair
      return;
    }
    wait.stage = 'nudge-frame';
    perf(`nudge session=${sessionId} probe#${id} reason=stale`);
    panel.nudge(id);
    wait.timer = this.armDiagnosticTimer(NUDGE_FRAME_TIMEOUT_MS, () => {
      this.probeWaits.delete(id);
      // The repair did not take. Say it in two parts — the repair that failed, and the stall
      // that is now the user's to report — and then **stop**: no reload, no repaint, no
      // escalation. The broken screen stays on purpose (see `onStallReport`).
      perf(`nudge-still-stale session=${sessionId} probe#${id}`);
      perf(
        `webview-stale-unresolved session=${sessionId} probe#${id} ` +
          `ms=${Date.now() - episode.startedAt} ladder=r0,r1`,
      );
    });
  }

  /**
   * The nudge painted: the repair worked, and the ladder is finished. The episode stays open
   * until the webview reports `recovered` (or goes hidden), so a `stale` it repeats in the same
   * episode cannot start a second ladder.
   */
  private onNudgeFrame(id: number): void {
    const wait = this.probeWaits.get(id);
    if (!wait || wait.stage !== 'nudge-frame') {
      return;
    }
    clearTimeout(wait.timer);
    this.probeWaits.delete(id);
  }

  /**
   * End a session's stall episode, and with it the ladder's pending deadlines: every one of them
   * would write a line about a stall that is over. An op-deadline probe is deliberately left
   * running — its reply is evidence about an *operation*, not about this stall, and the webview
   * answering late is news either way.
   */
  private endStallEpisode(sessionId: string): void {
    // Only the episode ends here. A probe already in flight for it is deliberately left alone,
    // deadline and all: a stall that a `recovered` ends in the same millisecond the probe went
    // out is exactly the case whose answer still says something — the measured 174-second freeze
    // was reported as `stale ms=174746` with `recovered` 12 ms later, its probe was cancelled on
    // the spot, and the ladder therefore never ran once in five logs of real use.
    this.stallEpisodes.delete(sessionId);
  }

  /**
   * One diagnostic deadline. `.unref()` where the host has it, so a pending ladder is never a
   * reason for the extension host to stay alive; `dispose` clears whatever is still pending.
   */
  private armDiagnosticTimer(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  }

  /**
   * An op's deadline passed with no `webview report`: an operation the user was waiting for
   * never produced a frame. Ask that session's tab what it is doing, so the log says what the
   * webview was busy with instead of only that nothing came back — this is the evidence a cold
   * switch that never reported a paint leaves behind, and the reason the hook exists at all.
   *
   * The same probe-request path as a ladder's first rung, with the same
   * {@link PROBE_DEDUPE_MS} de-dupe, so a stall that trips an op deadline as well is still one
   * probe. An op without a `subject` is one that is not about a session's tab, and there is
   * nothing to ask about it.
   */
  private onOpDeadline(subject?: string): void {
    if (!subject || this.disposed) {
      return;
    }
    try {
      this.requestProbe(subject, null);
    } catch (err) {
      perf(`probe-bookkeeping-error ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Route a message to the panel's session's runtime. */
  /** RuntimeHost: a read-only window refuses every mutation (`dispatchUserMessage`). */
  isReadOnly(): boolean {
    return this.readOnly;
  }

  /**
   * The **mirror seam**: every session-facing host→webview message funnels through here
   * (`SessionRuntime.post` → `RuntimeHost.postTo`), so this is the one place the remote
   * publisher can be handed exactly what a local tab receives — with no second copy of the
   * protocol to keep in step (`docs/agents/plans/remote-control.md` §5).
   *
   * The local delivery happens **first**, and the mirror is called after it inside a
   * `try`: a peer, a transport defect or a full mirror queue must never delay, block or
   * fail the owner's own webview, agent loop or tool call (§7). The call itself is
   * cheap — the service returns before copying anything unless a room is online *and*
   * some peer attached to this session.
   */
  postTo(sessionId: string, message: unknown): void {
    this.panels.get(sessionId)?.post(message);
    try {
      this.remoteService?.mirrorLocal(sessionId, message);
    } catch (err) {
      // Best effort by contract: the mirror is a copy, never the delivery.
      this.output.appendLine(`[remote] mirror failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * The remote publisher of this window, set once by `activate()` right after both exist
   * (`RemoteService` needs this provider as its host). `undefined` until then, and in a
   * host that never enables the feature it stays a service with nothing to do.
   */
  attachRemote(service: RemoteService): void {
    this.remoteService = service;
  }

  // ---- Remote publisher host (src/remote/remoteService.ts) ----

  /** Does this window have this session at all? (`attach` to anything else is refused.) */
  hasSession(sessionId: string): boolean {
    return this.sessions.some((s) => s.id === sessionId);
  }

  /**
   * The `tree` message a local webview would receive for this session — the state an
   * `attach` is answered with.
   *
   * It asks the session's runtime for the message instead of posting it, so answering a
   * peer never repaints the owner's own tab. A session with no runtime yet gets one, which
   * is the same lazy materialization opening its tab would do (and which every local path
   * does on its first message); a session this window does not have answers `null`.
   */
  remoteTreeMessage(sessionId: string): unknown | null {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session || this.disposed) {
      return null;
    }
    return this.runtimeFor(session).treeMessage();
  }

  /**
   * Apply one webview→host message a peer submitted (`input`), through the **same** path a
   * local webview message takes — `handleSessionMessage`, i.e. the one switch that routes
   * `userMessage`, `stop`, `setModel`, `loadAgentItems` and the rest. There is therefore
   * no remote-only code path that could behave differently from clicking the same control
   * in a local tab.
   *
   * Refusals are returned as codes (the caller answers `error{code}` per
   * `remote/PROTOCOL.md` §5) and nothing is dispatched: an unknown session, a malformed
   * message, and — the important one — a window that lost the workspace lock
   * (`this.readOnly`), which refuses every remote mutation exactly like a local one.
   *
   * Idempotency (a replayed frame after a peer's reconnect) is *not* handled here: it
   * belongs where the frame id is, in the service's short-lived de-dupe cache.
   */
  applyRemoteInput(sessionId: string, message: unknown, origin: RemoteOrigin): RemoteInputResult {
    if (!this.hasSession(sessionId)) {
      return 'unknown-session';
    }
    if (this.readOnly) {
      return 'readonly';
    }
    const type = (message as { type?: unknown } | null | undefined)?.type;
    if (typeof type !== 'string' || !type) {
      return 'bad-message';
    }
    this.output.appendLine(
      `[remote] input ${type} session=${sessionId} from ${origin.deviceName || origin.peerId}`,
    );
    // **The one place a remote input deliberately bypasses the owner's dialog.**
    //
    // Deleting a branch is irreversible, so locally it always goes through a modal
    // (`deleteBranchInteractive`). The frozen user-facing contract says the confirmation
    // belongs where the click happened: a peer clicking the card's 🗑 must NOT pop a modal
    // on the owner's screen (`docs/agents/plans/remote-control.md` §3 — "anything about
    // reading and interacting with your own device happens on the surface you are
    // operating"). So the replica shows the confirm itself and marks this one input
    // `confirmed: true`; only that marker reaches the non-interactive path.
    //
    // An input WITHOUT the marker is not refused — it falls through to the switch below,
    // where `deleteBranch` still asks the owner (`deleteBranchInteractive`). A peer can
    // therefore not skip the confirm by leaving the field out, and a local webview is
    // unaffected because it never sends the field at all.
    if (type === 'deleteBranch' && (message as { confirmed?: unknown }).confirmed === true) {
      const nodeId = String((message as { id?: unknown }).id ?? '');
      this.output.appendLine(
        `[remote] confirmed deleteBranch session=${sessionId} node=${nodeId} from ${origin.deviceName || origin.peerId}`,
      );
      this.deleteBranch(sessionId, nodeId);
      return 'ok';
    }
    void this.handleSessionMessage(sessionId, message, undefined, origin);
    return 'ok';
  }

  /**
   * One control-plane `cmd` from a peer (`remoteService.ts`, `remote/PROTOCOL.md` §5).
   *
   * It dispatches to the **same four methods the local HTTP plane answers**
   * (`controlStartSession` / `controlNavigate` / `controlContinueFrom` / `controlStop`,
   * `src/http/controlServer.ts`), so a remote command and an HTTP call cannot behave
   * differently — this method adds no semantics of its own, only the refusal **code** the
   * wire wants (`unknown-session` / `readonly` / `busy`) in place of an English sentence.
   * These exist as `cmd` frames at all because the affordances behind them have no webview
   * message to ride: a message sent from the room tree continues a session that may not be
   * open in a tab at all, and "create a session on that machine" cannot be expressed by a
   * composer that is not there.
   *
   * `args` is untrusted JSON written by another machine: every field is read through a
   * type check, and an absent one is `undefined` — exactly what the route's own optional
   * parameters mean.
   */
  async remoteCommand(command: string, args: Record<string, unknown>): Promise<RemoteCommandOutcome> {
    const str = (value: unknown): string | undefined =>
      typeof value === 'string' && value ? value : undefined;
    const sessionId = str(args.sessionId);
    const nodeId = str(args.nodeId);
    if (sessionId && !this.hasSession(sessionId)) {
      return { ok: false, code: 'unknown-session', message: `this window has no session ${sessionId}` };
    }
    // A window that lost the workspace lock may not mutate a conversation from anywhere —
    // `controlStartSession` says so itself; the check is repeated here so the peer learns
    // the *code* the protocol defines instead of the sentence. `stop` and `navigate` are
    // deliberately not gated: killing work and moving the view focus write no conversation
    // bytes, and refusing them would leave a peer unable to stop a run it started.
    if (this.readOnly && (command === 'session/start' || command === 'continue')) {
      return {
        ok: false,
        code: 'readonly',
        message: 'another window owns this workspace\u2019s sessions; this window is read-only',
      };
    }
    switch (command) {
      case 'session/start':
        return this.remoteOutcome(
          await this.controlStartSession({
            sessionId,
            nodeId,
            title: str(args.title),
            prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
            returnTo: args.returnTo === true,
            returnNodeId: str(args.returnNodeId),
          }),
        );
      case 'navigate':
        if (!nodeId) {
          return { ok: false, code: 'unsupported', message: 'navigate needs a nodeId' };
        }
        return this.remoteOutcome(await this.controlNavigate({ sessionId, nodeId }));
      case 'continue':
        if (typeof args.message !== 'string' || !args.message.trim()) {
          return { ok: false, code: 'unsupported', message: 'continue needs a message' };
        }
        return this.remoteOutcome(
          await this.controlContinueFrom({ sessionId, nodeId, message: args.message }),
        );
      case 'stop':
        return this.remoteOutcome(await this.controlStop({ sessionId, nodeId }));
      default:
        return { ok: false, code: 'unsupported', message: `unknown command "${command}"` };
    }
  }

  /**
   * A control route's answer, in the two shapes the wire has: a `result` body when it
   * worked, an `error{code}` when it did not. The route's own sentence (`result.error`) is
   * passed through as the error message — it is control-plane text, deliberately English
   * (`docs/agents/invariants/i18n.md`).
   */
  private remoteOutcome(result: ControlResult): RemoteCommandOutcome {
    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(result)) {
      if (value !== undefined) {
        body[key] = value;
      }
    }
    if (result.ok) {
      return { ok: true, body };
    }
    return {
      ok: false,
      code: result.busy ? 'busy' : 'unsupported',
      message: result.error ?? 'the command was refused',
      body,
    };
  }

  /**
   * Window recovery: VS Code recreated this webview panel from the editor state
   * it serialized at shutdown (`registerWebviewPanelSerializer`, wired in
   * extension.ts). Adopt the panel, bind it to the session it was showing and
   * let its `ready` repaint it. Without this the chat tab silently disappears on
   * every reload.
   */
  restorePanel(panel: vscode.WebviewPanel, state: unknown): void {
    if (this.disposed) {
      panel.dispose();
      return;
    }
    // The session to show is the one the webview remembered via setState before
    // the reload; fall back to the persisted active session when it is missing
    // (older build) or no longer exists (deleted meanwhile).
    const remembered = (state as { sessionId?: unknown } | undefined)?.sessionId;
    const rememberedSession =
      typeof remembered === 'string' ? this.sessions.find((s) => s.id === remembered) : undefined;
    const session = rememberedSession ?? this.getActiveSession();
    if (!session) {
      panel.dispose();
      return;
    }
    const adopted = this.panels.adopt(panel, session.id);
    adopted.setTitle(this.panelTitle(session.id));
    this.output.appendLine(`[panel] restored chat tab for session ${session.id}`);
    // The webview posts 'ready' once its script loads; that repaints it.
  }

  // ---- Model Card Tree page ----

  /**
   * Open (or focus) the Model Card Tree tab — the `Spinney: Model Cards` command
   * and the gear button beside the chat's model dropdown both land here. There is
   * one page per window: the controller owns it and focuses the existing tab
   * instead of opening a second one.
   */
  openModelTree(): void {
    if (this.disposed) {
      return;
    }
    this.modelTree.open();
    this.output.appendLine('[model-tree] page opened');
  }

  /**
   * Window recovery for the page: VS Code hands the serialized panel back (its
   * view type is registered in `extension.ts`), and the controller adopts it so
   * the tab survives a reload exactly like a chat tab does.
   */
  restoreModelPanel(panel: vscode.WebviewPanel): void {
    if (this.disposed) {
      panel.dispose();
      return;
    }
    this.modelTree.restore(panel);
    this.output.appendLine('[panel] restored the model-cards tab');
  }

  // ---- Commands ----

  /**
   * Open a session's tab, tracing the whole switch. The op is the operation the
   * user experiences: tab creation, the HTML shell, the runtime, the persistence
   * write — and, through the id the repaint messages carry (`reset`/`tree`/`path`
   * → `opTag`), the webview's render, which reports back and ends the op. A tab
   * that is already open only needs `reveal`, so its op ends immediately.
   */
  private openTab(sessionId: string, label: string): void {
    const cold = !this.panels.has(sessionId);
    const op = beginOp(label, `session=${sessionId} cold=${cold}`, { awaitWebview: cold, subject: sessionId });
    try {
      this.panels.ensure(sessionId);
    } finally {
      if (!cold) {
        op.end('tab already open (no repaint)');
      }
    }
  }

  /**
   * Open the fully-rendered system prompt in an editor tab
   * (spinney.showSystemPrompt). The content is rendered from the *current*
   * session state — the active model, the reasoning effort, the reply language and
   * the AGENTS.md snapshot taken when the session started — so it is exactly what
   * the model would receive on the next turn.
   */
  async showSystemPrompt(): Promise<void> {
    const content = this.systemPrompt();
    const doc = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  /**
   * `Spinney: Reload Chat Webview` — rebuild the **active** session's tab from scratch. This is
   * the user's own escalation after a stall: the host deliberately leaves a broken screen
   * visible instead of repairing it behind the user's back (see `onStallReport`), so the one
   * repair with a price — a fresh document, which loses the scroll position and the expanded
   * cards — is a command the user asks for while looking at the frozen tab.
   *
   * The session, its runtime and a running turn are untouched: only the view is rebuilt, and the
   * fresh script posts `ready`, which drives the usual repaint.
   */
  reloadActiveChatWebview(): void {
    const sessionId = this.activeSessionId;
    const panel = this.panels.get(sessionId);
    if (!panel) {
      // No tab is open for the active session: an information message, not an error — the user
      // may well have closed the tab that was stuck.
      void vscode.window.showInformationMessage(vscode.l10n.t('Spinney: no chat tab is open for this window.'));
      return;
    }
    // No line of its own: `ChatPanel.reload` writes `[panel] webview reload session=…`, and the
    // command is the only caller — a second line would say the same thing twice.
    panel.reload();
  }

  /**
   * Open (or focus) a session's tab. Opening a session never activates, stops or
   * otherwise touches another session — they can all run at once.
   */
  openSession(id: string): void {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) {
      return;
    }
    const cold = !this.panels.has(session.id);
    const op = beginOp('switch-session', `session=${session.id} cold=${cold}`, {
      awaitWebview: cold,
      subject: session.id,
    });
    try {
      this.panels.ensure(session.id);
      this.setActiveSession(session.id);
    } finally {
      // A tab that was already open needed no repaint, so nothing will ever report
      // on this op: it ends here, and its marks still say what the reveal and the
      // active-session bookkeeping (persist + sidebar refresh) cost.
      if (!cold) {
        op.end('tab already open (no repaint)');
      }
    }
  }

  newSession(): void {
    if (this.readOnly) {
      void vscode.window.showWarningMessage(this.readOnlyNotice());
      return;
    }
    const session = this.createSessionInMemory();
    // A new session always gets a fresh tab, so this op waits for the webview's
    // first paint like any other cold switch.
    const op = beginOp('new-session', `session=${session.id}`, { awaitWebview: true, subject: session.id });
    this.persist();
    try {
      this.panels.ensure(session.id);
    } catch (err) {
      op.end('failed');
      throw err;
    }
  }

  /**
   * The one confirmation gate for "this action kills running background
   * terminals". Deleting a session, clearing a conversation and deleting a
   * branch all funnel through it, so no path silently tears down a process the
   * user is still watching. The context rollover passes its own `header` because
   * *its* call kills sub-agents too, not just terminals; the default keeps the
   * terminal-only wording (and, being a real call site, keeps the key visible to
   * the l10n extractor).
   */
  private async confirmKillBackgrounds(detail: string, action: string, header = vscode.l10n.t('Background terminals are still running.')): Promise<boolean> {
    const pick = await vscode.window.showWarningMessage(
      header,
      { modal: true, detail },
      action,
    );
    return pick === action;
  }

  deleteSession(id: string, confirmedKill = false): void {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) {
      return;
    }
    const rt = this.runtimes.get(id);
    // Refuse while a turn streams (its node would vanish under it). Running
    // background jobs are only killed after a modal confirmation.
    if (rt && rt.isRunning()) {
      rt.postNotice(
        'warning',
        vscode.l10n.t(
          'Cannot delete a session while a turn is running. Wait for it to finish (or stop it) first.',
        ),
      );
      return;
    }
    const jobs = rt ? rt.runningBackgroundCount() : 0;
    if (jobs > 0 && !confirmedKill) {
      void this.confirmKillBackgrounds(
        vscode.l10n.t(
          '{0} background terminal(s) of this session are still running. Deleting the session kills them (their processes are torn down).',
          jobs,
        ),
        vscode.l10n.t('Delete session and kill'),
      ).then((ok) => {
        if (ok) {
          this.deleteSession(id, true);
        }
      });
      return;
    }
    this.deleteSessionNow(id);
  }

  /**
   * Delete every selected session at once (sidebar multi-select →
   * `spinney.deleteSessions`). ONE modal confirmation covers the batch: it
   * names the sessions, the turn cards and the transcript dumps that go, and the
   * running background terminals that will be killed. A session with a live
   * *turn* is skipped rather than silently dropped — its node would vanish under
   * the running agent — and reported afterwards.
   */
  async deleteSessionsInteractive(ids: string[]): Promise<void> {
    if (this.readOnly) {
      void vscode.window.showWarningMessage(this.readOnlyNotice());
      return;
    }
    const known = ids.filter((id) => this.sessions.some((s) => s.id === id));
    if (known.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t('No sessions are selected.'));
      return;
    }
    if (known.length === 1) {
      // A single selection keeps the single-session path and its wording.
      this.deleteSession(known[0]);
      return;
    }
    const busy = known.filter((id) => this.runtimes.get(id)?.isRunning() === true);
    const doomed = known.filter((id) => !busy.includes(id));
    if (doomed.length === 0) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('Every selected session is running a turn. Stop them (or wait for them) and try again.'),
      );
      return;
    }
    const turns = doomed.reduce(
      (n, id) => n + Object.keys(this.sessions.find((s) => s.id === id)?.nodes ?? {}).length,
      0,
    );
    const jobs = doomed.reduce((n, id) => n + (this.runtimes.get(id)?.runningBackgroundCount() ?? 0), 0);
    const detail = [
      vscode.l10n.t('{0} session(s) and {1} turn card(s) are removed from this window.', doomed.length, turns),
      vscode.l10n.t(
        'Their transcript dumps are deleted from disk, so search_transcripts will no longer find them.',
      ),
      jobs > 0 ? vscode.l10n.t('{0} running background terminal(s) will be killed.', jobs) : '',
      busy.length > 0 ? vscode.l10n.t('Skipped (a turn is running): {0} session(s).', busy.length) : '',
      vscode.l10n.t('This cannot be undone.'),
    ]
      .filter(Boolean)
      .join('\n');
    const label = vscode.l10n.t('Delete {0} Sessions', doomed.length);
    const pick = await vscode.window.showWarningMessage(
      vscode.l10n.t('Delete {0} sessions?', doomed.length),
      { modal: true, detail },
      label,
    );
    if (pick !== label) {
      return;
    }
    // One teardown per session, one bookkeeping pass at the end: a batch must not
    // grow a replacement session after each removal.
    for (const id of doomed) {
      this.deleteSessionNow(id, true);
    }
    this.finishDeletions();
    if (busy.length > 0) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('{0} session(s) were left running and not deleted.', busy.length),
      );
    }
    this.outputLog(
      `[sessions] deleted ${doomed.length} session(s)` +
        `${busy.length > 0 ? `, skipped ${busy.length} running` : ''}`,
    );
  }

  /**
   * Tear one session down: its runtime (killing the background terminals it owns),
   * its tab, its transcript dumps and any session-start/hop record that points at
   * it. `deferFinish` skips the shared tail (keep at least one session, move the
   * active pointer, persist, refresh) so a batch can do it once at the end.
   */
  private deleteSessionNow(id: string, deferFinish = false): boolean {
    const idx = this.sessions.findIndex((s) => s.id === id);
    if (idx === -1) {
      return false;
    }
    const rt = this.runtimes.get(id);
    if (rt) {
      rt.dispose();
      this.runtimes.delete(id);
    }
    this.panels.close(id);
    // Drop the session's transcript dumps too (turns + sub-agent runs).
    removeTranscriptDir(this.transcriptDir(id));
    // A queued start / armed hop that targets this session can never land.
    if (this.pendingSessionStart?.sessionId === id) {
      this.pendingSessionStart = null;
    }
    if (this.hopReturn?.originSessionId === id) {
      this.hopReturn = null;
    }
    this.sessions.splice(idx, 1);
    if (!deferFinish) {
      this.finishDeletions();
    }
    return true;
  }

  /** Post-deletion bookkeeping, shared by the single and the batch path. */
  private finishDeletions(): void {
    if (this.sessions.length === 0) {
      // A window always has one session, so the chat is never left with nothing.
      this.createSessionInMemory();
    }
    if (!this.sessions.some((s) => s.id === this.activeSessionId)) {
      this.activeSessionId = this.sessions[0].id;
    }
    // A deletion against the stored state: a coalesced write here would leave a
    // deleted session (or one whose transcript dumps are already gone) coming back
    // after a crash, so this one is written now.
    this.persistNow();
    this.persistActiveSession();
    this.notifyStateChanged();
  }

  /** Clear one session's conversation (the panel that invoked `clear`). */
  clear(sessionId?: string, confirmedKill = false): void {
    if (this.readOnly) {
      void vscode.window.showWarningMessage(this.readOnlyNotice());
      return;
    }
    const id = sessionId ?? this.activeSessionId;
    const session = this.sessions.find((s) => s.id === id);
    if (!session) {
      return;
    }
    const rt = this.runtimeFor(session);
    if (rt.isRunning()) {
      rt.postNotice(
        'warning',
        vscode.l10n.t(
          'Cannot clear the conversation while a turn is running. Wait for it to finish (or stop it) first.',
        ),
      );
      return;
    }
    const jobs = rt.runningBackgroundCount();
    if (jobs > 0 && !confirmedKill) {
      void this.confirmKillBackgrounds(
        vscode.l10n.t(
          '{0} background terminal(s) of this session are still running. Clearing the conversation kills them (their processes are torn down).',
          jobs,
        ),
        vscode.l10n.t('Clear and kill'),
      ).then((ok) => {
        if (ok) {
          this.clear(id, true);
        }
      });
      return;
    }
    // Reset the runtime: agent history, tree, queued notices, background history.
    rt.clearConversation();
    // ...and its automatic title: the next turn names the fresh conversation.
    delete session.titleAutoAt;
    delete session.titleAutoNodes;
    if (!session.titleLocked) {
      session.title = defaultSessionTitle();
      session.titleSource = 'provisional';
      this.notifyStateChanged();
    }
    // The cleared conversation's transcript dumps are stale now.
    removeTranscriptDir(this.transcriptDir(session.id));
    // Written now: the dumps are already gone from disk, so a stale memento would
    // resurrect a conversation whose transcripts no longer exist.
    this.persistNow();
  }

  // ---- Branch deletion ----

  /**
   * Ask for a branch deletion (webview card button / palette command). Deleting
   * a branch is irreversible — it drops the subtree from the session history AND
   * the matching transcript dumps on disk — so it always goes through a modal
   * confirmation, never a single click. Returns true when something was removed.
   */
  async deleteBranchInteractive(sessionId: string, nodeId: string): Promise<boolean> {
    const session = this.sessions.find((s) => s.id === sessionId);
    const node = session?.nodes[nodeId];
    if (!session || !node) {
      return false;
    }
    const rt = this.runtimeFor(session);
    const blocked = this.branchDeletionBlocked(session, rt, nodeId);
    if (blocked) {
      rt.postNotice('warning', blocked);
      return false;
    }
    const ids = branchIds(session, nodeId);
    const turns = ids.filter((id) => !isSidecar(session.nodes[id])).length;
    const agents = ids.length - turns;
    // A branch owns its background jobs: deleting it kills whatever it spawned,
    // so the confirmation says so before anything is torn down.
    const jobs = rt.runningBackgroundsForNodes(ids);
    const detail = [
      agents > 0
        ? vscode.l10n.t(
            'History: {0} turn(s) and {1} sub-agent card(s) are removed from this conversation.',
            turns,
            agents,
          )
        : vscode.l10n.t('History: {0} turn(s) are removed from this conversation.', turns),
      vscode.l10n.t(
        'Transcripts: their JSONL dumps are deleted from disk, so search_transcripts will no longer find them.',
      ),
      jobs > 0
        ? vscode.l10n.t('Background: {0} running terminal(s) owned by this branch will be killed.', jobs)
        : '',
      vscode.l10n.t('The checked-out node moves to the parent of the deleted branch.'),
      vscode.l10n.t('This cannot be undone.'),
    ]
      .filter(Boolean)
      .join('\n');
    const DELETE_BRANCH = vscode.l10n.t('Delete Branch');
    const pick = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Delete this branch — "{0}" and everything below it?',
        node.title || vscode.l10n.t('untitled'),
      ),
      { modal: true, detail },
      DELETE_BRANCH,
    );
    if (pick !== DELETE_BRANCH) {
      return false;
    }
    return this.deleteBranch(session.id, nodeId);
  }

  /** Palette command: delete the branch rooted at the active session's checkout. */
  async deleteCheckedOutBranchInteractive(): Promise<boolean> {
    const session = this.getActiveSession();
    const nodeId = session?.activeNodeId;
    if (!session || !nodeId) {
      void vscode.window.showInformationMessage(vscode.l10n.t('There is no checked-out turn to delete.'));
      return false;
    }
    return this.deleteBranchInteractive(session.id, nodeId);
  }

  /**
   * Why this branch cannot be deleted right now ('' when it can). A turn (main
   * or sub-agent) that is still running must never lose the node it is writing
   * into.
   */
  private branchDeletionBlocked(session: AgentSession, rt: SessionRuntime, nodeId: string): string {
    if (rt.isRunning() || rt.agentRunning()) {
      return vscode.l10n.t('Cannot delete a branch while the agent is running. Wait for the turn to finish.');
    }
    if (branchIds(session, nodeId).some((id) => rt.hasRunningSubAgent(id))) {
      return vscode.l10n.t('Cannot delete a branch that contains a running sub-agent. Kill it first.');
    }
    return '';
  }

  /**
   * Apply a confirmed branch deletion to a session: drop the subtree from the
   * tree, delete the matching transcript dumps (a node's dump is
   * `<transcriptDir>/<nodeId>.jsonl` for both main turns and sub-agent runs, plus
   * any absolute path a sub-agent recorded under a different transcript root),
   * move the checkout off the removed subtree, and repaint. Returns false when
   * the node is unknown, belongs to another session, or a turn started while the
   * confirmation dialog was open.
   */
  deleteBranch(sessionId: string, nodeId: string): boolean {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session || !session.nodes[nodeId]) {
      return false;
    }
    const rt = this.runtimeFor(session);
    // Re-checked here too: an async sub-agent batch can inject a turn while the
    // modal dialog is open, and that turn's node must not be deleted under it.
    const blocked = this.branchDeletionBlocked(session, rt, nodeId);
    if (blocked) {
      rt.postNotice('warning', blocked);
      return false;
    }
    const ids = branchIds(session, nodeId);
    // Collect the recorded paths before the nodes are gone.
    const recorded = ids
      .map((id) => session.nodes[id].agentTranscript)
      .filter((file): file is string => !!file);
    detachBranch(session, nodeId);
    const dir = this.transcriptDir(session.id);
    let dropped = removeTranscripts(dir, ids);
    for (const file of recorded) {
      if (removeTranscriptFile(file)) {
        dropped++;
      }
    }
    // Drop anything the removed nodes still queued, re-check out the survivor and repaint.
    rt.afterBranchDetach(ids);
    if (Object.keys(session.nodes).length === 0) {
      // The whole tree went (the deleted branch was the root): mirror `clear()`
      // so the next turn names the now-empty conversation again.
      delete session.titleAutoAt;
      delete session.titleAutoNodes;
      if (!session.titleLocked) {
        session.title = defaultSessionTitle();
        session.titleSource = 'provisional';
      }
      this.panels.setTitle(session.id, this.panelTitle(session.id));
    }
    this.persistActiveSession();
    // A branch deletion also drops transcript dumps from disk (`removeTranscripts`
    // above): the stored state must stop listing those nodes now, not in 800 ms.
    this.persistNow();
    // The sidebar row shows the node count + "time ago", both of which moved.
    this.notifyStateChanged();
    this.outputLog(
      `[branch] deleted ${ids.length} node(s) at ${nodeId} in ${session.id}; ${dropped} transcript dump(s) removed`,
    );
    return true;
  }

  // ---- External control plane (src/http/controlServer.ts) ----

  /** Append a line to the Spinney output channel (used by the control plane). */
  outputLog(line: string): void {
    this.output.appendLine(this.stampLine(line));
  }

  controlState(): ControlState {
    const session = this.getActiveSession();
    const activeRt = session ? this.runtimes.get(session.id) : undefined;
    return {
      busy: this.anyRunningTurn(),
      sessionId: session?.id ?? null,
      activeNodeId: session?.activeNodeId ?? null,
      runningSubAgents: activeRt ? activeRt.runningSubAgentCount() : 0,
      runningBackgrounds: activeRt ? activeRt.hasRunningBackground() : false,
      sessions: this.sessions.map((s) => {
        const rt = this.runtimes.get(s.id);
        return {
          id: s.id,
          title: s.title,
          nodes: Object.keys(s.nodes).length,
          active: s.id === this.activeSessionId,
          titleSource: s.titleSource,
          titleLocked: s.titleLocked === true ? true : undefined,
          running: rt ? rt.isRunning() : false,
          runningNodes: rt ? rt.runningNodes() : [],
          // Not streaming, but still owning unfinished work (a running background
          // job / async sub-agent batch, or a notice about to be injected into it):
          // that node refuses a send until the work has been delivered.
          lockedNodes: rt ? rt.lockedNodes() : [],
          runningBackgrounds: rt ? rt.hasRunningBackground() : false,
          // Which branch owns each running job: a controller can verify that a job
          // stayed with the node that spawned it while the view moved elsewhere.
          backgroundNodes: rt ? rt.backgroundNodes() : [],
          // The per-session card/level, straight off the session's runtime (an
          // unloaded session reports the selection it would start from). `model` is
          // the card id — the wire readout a controller correlates on, never a
          // validation of it; `modelName` says what a human calls that card.
          model: rt ? rt.model : this.effectiveModel(s),
          modelName: cardDisplayName(resolveCard(rt ? rt.model : this.effectiveModel(s))),
          effort: rt ? rt.thinkingEffort : this.effectiveEffort(s, this.effectiveModel(s)),
        };
      }),
    };
  }

  /**
   * Block until the agent is idle. `scope:'turn'` (default) waits for the active
   * (last-focused) session's in-flight turn; `scope:'all'` waits until no run, no
   * sub-agent and no background job exists anywhere. The last `persist()` write is
   * awaited before returning so the caller may kill the process immediately
   * after. Never interrupts a turn unless `interrupt` is set. The returned
   * `sessionId` / `nodeId` are the active session's (`hvsc` carries them into its
   * `/continue`).
   */
  async controlWaitForFinish(opts: WaitForFinishOptions): Promise<ControlResult> {
    const scope = opts.scope === 'all' ? 'all' : 'turn';
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.max(0, Math.min(opts.timeoutMs ?? 0, 600000)) : 30000;
    const activeSession = this.getActiveSession();
    const activeRt = activeSession ? this.runtimes.get(activeSession.id) : undefined;
    const idle = (): boolean => {
      if (scope === 'all') {
        return this.globallyIdle();
      }
      return activeRt ? !activeRt.isRunning() : !this.anyRunningTurn();
    };
    if (opts.interrupt && !idle()) {
      for (const rt of this.runtimes.values()) {
        if (rt.isRunning()) {
          rt.onStop();
        }
      }
    }
    const deadline = Date.now() + timeoutMs;
    while (!idle()) {
      if (Date.now() >= deadline) {
        const state = this.controlState();
        return {
          ok: false,
          idle: false,
          error: 'timeout',
          busy: state.busy,
          runningSubAgents: state.runningSubAgents,
          runningBackgrounds: state.runningBackgrounds,
          sessionId: state.sessionId,
          nodeId: state.activeNodeId,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    // Hand-off: everything pending must be on disk before the caller (an external
    // supervisor) may kill or reload this window — the state write *and* the queued
    // transcript dumps, which reach disk asynchronously now.
    await this.flushPersist();
    await flushTranscripts();
    const holdMs = Number.isFinite(opts.holdMs) ? Math.max(0, Math.min(opts.holdMs ?? 0, 600000)) : 0;
    if (holdMs > 0) {
      this.controlHoldUntil = Date.now() + holdMs;
    }
    const state = this.controlState();
    return { ok: true, idle: true, busy: false, sessionId: state.sessionId, nodeId: state.activeNodeId };
  }

  /** Check out a node in an explicitly-named (or the active) session and show it. */
  async controlNavigate(opts: { sessionId?: string; nodeId: string }): Promise<ControlResult> {
    const session = opts.sessionId ? this.sessions.find((s) => s.id === opts.sessionId) : this.getActiveSession();
    if (!session) {
      return { ok: false, error: `no such session: ${opts.sessionId ?? '(active)'}` };
    }
    if (!session.nodes[opts.nodeId]) {
      return { ok: false, error: `no such node: ${opts.nodeId}` };
    }
    const rt = this.runtimeFor(session);
    this.panels.ensure(session.id);
    this.setActiveSession(session.id);
    rt.handleCheckout(opts.nodeId);
    return { ok: true, sessionId: session.id, nodeId: opts.nodeId };
  }

  /** Send a caller-supplied message that continues from `nodeId` (a new child turn). */
  async controlContinueFrom(opts: { sessionId?: string; nodeId?: string; message: string }): Promise<ControlResult> {
    const message = (opts.message ?? '').trim();
    if (!message) {
      return { ok: false, error: 'message is required' };
    }
    const session = opts.sessionId ? this.sessions.find((s) => s.id === opts.sessionId) : this.getActiveSession();
    if (!session) {
      return { ok: false, error: `no such session: ${opts.sessionId ?? '(active)'}` };
    }
    const rt = this.runtimeFor(session);
    const nodeId = opts.nodeId ?? session.activeNodeId ?? session.rootIds[0];
    // P3: node-scoped. This refuses only when the *basis node* — the node the new
    // turn would continue from — is itself streaming (the composer's Stop-not-Send
    // rule); a run on another branch of the same session must not block it.
    if (nodeId && rt.runningNodes().includes(nodeId)) {
      return { ok: false, error: 'the agent is busy; wait for it to finish first' };
    }
    // Same node-scoped rule as the composer: unfinished work owned by this node
    // (a background job, an async sub-agent batch) blocks a send until it has been
    // delivered, or the notice would be injected into the node the new turn branches
    // from.
    if (nodeId && rt.lockedNodes().includes(nodeId)) {
      return { ok: false, error: 'this node is waiting for its background task or sub-agent to finish' };
    }
    this.panels.ensure(session.id);
    if (nodeId) {
      if (!session.nodes[nodeId]) {
        return { ok: false, error: `no such node: ${nodeId}` };
      }
      rt.handleCheckout(nodeId);
    }
    await this.dispatchUserMessage(rt, message, []);
    return { ok: true, sessionId: session.id, nodeId: session.activeNodeId };
  }

  /**
   * Stop (`POST /stop`): `nodeId` is a **union kill** — that node's live run, its
   * background terminals and its running sub-agents, with the completion notices
   * written back into the node's own history instead of opening a turn (the
   * composer's bottom-right button while a node runs or owns unfinished work).
   * Without `nodeId`, every run of the session (else the active session) is
   * cancelled and background jobs are left alone. Returns how many pieces of work
   * were stopped — `stopped: 0` when nothing was running is still `ok`. An unknown
   * session is refused (409). Deliberately does not touch the reload hold.
   */
  async controlStop(opts: { sessionId?: string; nodeId?: string }): Promise<ControlResult> {
    const session = opts.sessionId ? this.sessions.find((s) => s.id === opts.sessionId) : this.getActiveSession();
    if (!session) {
      return { ok: false, error: `no such session: ${opts.sessionId ?? '(active)'}` };
    }
    const rt = this.runtimeFor(session);
    const stopped = rt.stop(opts.nodeId);
    return { ok: true, sessionId: session.id, nodeId: opts.nodeId ?? session.activeNodeId, stopped };
  }

  /**
   * Create a fresh session (or jump to an existing one) and optionally send a
   * caller-supplied prompt as its first turn. With `sessionId` the target session
   * is resolved explicitly and refused only while the **target node** (the
   * `nodeId` given, else the view focus) has a live run — P3, so a session that is
   * streaming on another branch may still be started here. Without `sessionId` a
   * fresh session is created immediately when another turn is running; only a hop
   * (`returnTo`) queues, since its return trip needs the origin idle. With
   * `returnTo` the hopped session's final answer is delivered back to the session
   * that was active when the hop was queued, branching off `returnNodeId` when
   * that is given. `nodeId` checks out a node in the target session before the
   * prompt is sent.
   */
  async controlStartSession(opts: {
    sessionId?: string;
    nodeId?: string;
    title?: string;
    prompt?: string;
    returnTo?: boolean;
    returnNodeId?: string;
  }): Promise<ControlResult> {
    if (this.readOnly) {
      return { ok: false, error: 'another window owns this workspace\u2019s sessions; this window is read-only' };
    }
    const prompt = (opts.prompt ?? '').trim();
    if (opts.sessionId) {
      const session = this.sessions.find((s) => s.id === opts.sessionId);
      if (!session) {
        return { ok: false, error: `no such session: ${opts.sessionId}` };
      }
      const rt = this.runtimeFor(session);
      // P3: node-scoped — the session may be streaming on another branch while the
      // target node is free. Only a live run on the target node refuses.
      const targetNode = opts.nodeId ?? session.activeNodeId ?? session.rootIds[0];
      if (targetNode && rt.runningNodes().includes(targetNode)) {
        return { ok: false, error: 'the agent is busy; wait for it to finish first', busy: true };
      }
      if (targetNode && rt.lockedNodes().includes(targetNode)) {
        // Node-scoped like the composer: unfinished work owned by the target blocks
        // the send, so the completion notice is not injected into the node the new
        // turn would branch from. A queued hop return only fires when this window is
        // globally idle, so it can never land here.
        return {
          ok: false,
          error: 'this node is waiting for its background task or sub-agent to finish',
          busy: true,
        };
      }
      if (opts.nodeId) {
        if (!session.nodes[opts.nodeId]) {
          return { ok: false, error: `no such node: ${opts.nodeId}` };
        }
        rt.handleCheckout(opts.nodeId);
      }
      this.panels.ensure(session.id);
      this.setActiveSession(session.id);
      if (!prompt) {
        return { ok: true, sessionId: session.id, nodeId: session.activeNodeId, prompted: false };
      }
      // onUserMessage names a fresh session from its first message when no title
      // was supplied, so a caller-supplied title wins and a bare prompt titles it.
      await this.dispatchUserMessage(rt, prompt, []);
      return { ok: true, sessionId: session.id, nodeId: session.activeNodeId, prompted: true };
    }
    if (this.anyRunningTurn() || this.anyRunningBackground()) {
      // A *different* session is running. The single-agent design had to queue here
      // (only one turn could exist at a time); sessions are independent now, so a
      // fresh session starts right away — that is the concurrency this phase adds.
      if (prompt && !opts.returnTo) {
        return this.startFreshSession({ title: opts.title, prompt });
      }
      // A hop (`returnTo`) still queues: its contract is "your turn is over, the
      // fresh session reports back", and the return trip needs the origin idle.
      if (prompt) {
        if (this.pendingSessionStart) {
          return { ok: false, error: 'a session start is already queued', busy: true };
        }
        if (this.hopReturn) {
          return { ok: false, error: 'a session hop is already in progress', busy: true };
        }
        const origin = this.getActiveSession();
        this.pendingSessionStart = { title: opts.title, prompt: opts.prompt };
        if (origin) {
          this.hopReturn = {
            originSessionId: origin.id,
            armedAt: Date.now(),
            returnNodeId: opts.returnNodeId || undefined,
          };
        }
        this.outputLog(`[http] session/start queued (${(opts.prompt ?? '').slice(0, 60)})`);
        return { ok: true, queued: true };
      }
      return { ok: false, error: 'the agent is busy; wait for it to finish first', busy: true };
    }
    if (!prompt) {
      const session = this.createSessionInMemory();
      if (opts.title?.trim()) {
        this.applySessionTitle(session, opts.title.trim(), 'manual');
      }
      this.runtimeFor(session);
      // The caller already has this session's id and may `/continue` it right away,
      // so it has to exist on disk before the reply is sent.
      this.persistNow();
      this.panels.ensure(session.id);
      return { ok: true, sessionId: session.id, nodeId: session.activeNodeId, prompted: false };
    }
    return this.startFreshSession({ title: opts.title, prompt });
  }

  /**
   * Create a session, title it, open its tab and send `prompt` as its first turn.
   * Shared by the idle path and the "another session is running" path — the latter
   * is what makes sessions genuinely concurrent (P1).
   */
  private async startFreshSession(opts: { title?: string; prompt: string }): Promise<ControlResult> {
    const session = this.createSessionInMemory();
    if (opts.title?.trim()) {
      // A caller-supplied title is explicit: lock it so automatic naming never
      // overwrites what the dispatcher asked for.
      this.applySessionTitle(session, opts.title.trim(), 'manual');
    }
    const rt = this.runtimeFor(session);
    // The turn below is about to write into this session; a fresh session that only
    // exists in memory would be lost by a reload that arrives mid-turn.
    this.persistNow();
    this.panels.ensure(session.id);
    await this.dispatchUserMessage(rt, opts.prompt, []);
    return { ok: true, sessionId: session.id, nodeId: session.activeNodeId, prompted: true };
  }

  /**
   * Ask VS Code to reload this window. Replies 202 immediately and reloads a
   * moment later (after the pending persist lands), because the reload kills
   * this process — the caller can only observe it as a *new* instance.
   */
  controlReloadWindow(): ControlResult {
    if (this.anyRunningTurn()) {
      return { ok: false, error: 'the agent is busy; wait for it to finish first', busy: true };
    }
    if (this.anyRunningSubAgents() || this.anyRunningBackground()) {
      return { ok: false, error: 'sub-agents or background terminals are still running', busy: true };
    }
    // A reload kills this process: flush the coalesced write first, or the reload
    // itself could lose the state it is reloading for.
    void Promise.all([this.flushPersist(), flushTranscripts()]).finally(() => {
      setTimeout(() => {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }, 400);
    });
    return { ok: true };
  }

  // ---- Webview routing ----

  private async dispatchUserMessage(
    rt: SessionRuntime,
    text: string,
    attachments: UserAttachment[],
    origin?: RemoteOrigin,
  ): Promise<void> {
    if (this.isHeld()) {
      rt.postNotice(
        'warning',
        vscode.l10n.t('An external controller is rebooting the window; please wait a moment.'),
      );
      return;
    }
    if (this.readOnly) {
      rt.postNotice('warning', this.readOnlyNotice());
      return;
    }
    // The setup gate: a plain send always uses the checked-out chain's frozen setup, so a
    // pick made on that chain has to be confirmed before it is discarded. Dismissing the
    // dialog sends nothing — "default send always uses the old setup" has to be true even
    // when the user walks away from the question.
    if (rt.hasUserDrift()) {
      const choice = await this.askSetups('user');
      if (!choice) {
        return;
      }
      if (choice === 'current') {
        rt.discardPendingSetup();
      } else if (!this.forkFor(rt)) {
        return;
      }
    }
    // A send is the moment a key matters: nudge once (never block — the request
    // itself reports the real error).
    void this.warnMissingApiKey();
    // `origin` is the remote-origin mark of the turn this send starts (`RemoteOrigin`):
    // the runtime writes it onto the node it creates, and the transcript dump carries it
    // in its line-1 meta. The message text itself is never touched.
    await rt.onUserMessage(text, attachments, origin);
    // The composer holds the text until this point: a question answered with "No" must not
    // eat what the user typed (`composerClear`).
    this.postTo(rt.sessionId, { type: 'composerClear' });
  }

  /**
   * The composer's "send with the latest setup" entry: ask, then send into the tree the
   * answer names. `Continue with current setup` here means "do not fork after all" — the
   * user asked for the question, not necessarily for the fork.
   */
  private async forkAndSend(rt: SessionRuntime, text: string, attachments: UserAttachment[]): Promise<void> {
    if (this.readOnly) {
      rt.postNotice('warning', this.readOnlyNotice());
      return;
    }
    const choice = await this.askSetups('user');
    if (!choice) {
      return;
    }
    if (choice === 'latest') {
      if (!this.forkFor(rt)) {
        return;
      }
    } else {
      rt.discardPendingSetup();
    }
    await this.dispatchUserMessage(rt, text, attachments);
  }

  /**
   * Continue a near-full or refused chain in a **new node**: ask which setup it should
   * start with, gate the kills when the node still owns work, then start it. Both branches
   * are free — a new context has no cached prefix to lose — which is exactly why the user
   * gets the choice here (`docs/agents/plans/session-epoch.md` §4.5).
   */
  private async rolloverWithSetup(rt: SessionRuntime, id: string): Promise<void> {
    if (this.readOnly) {
      rt.postNotice('warning', this.readOnlyNotice());
      return;
    }
    const choice = await this.askSetups('rollover');
    if (!choice) {
      return;
    }
    const work = rt.lockedWorkCount(id);
    if (work > 0) {
      const ok = await this.confirmKillBackgrounds(
        vscode.l10n.t('{0} piece(s) of work are still running here (background terminals and sub-agents). Continuing in a new window stops them; what they produced stays in the transcript.', work),
        vscode.l10n.t('Continue and stop them'),
        vscode.l10n.t('Work is still running in this window.'),
      );
      if (!ok) {
        return;
      }
    }
    const started = await rt.rolloverContext(id, choice);
    if (!started) {
      rt.postNotice(
        'warning',
        vscode.l10n.t('Could not continue in a new context here — wait for the running turn to finish and try again.'),
      );
    }
  }

  /** The one read-only sentence, in one place. */
  private readOnlyNotice(): string {
    return vscode.l10n.t(
      'Another window owns this workspace\u2019s sessions, so this window is read-only. Close that window (or use it) to continue here.',
    );
  }

  /**
   * Ask which setup a continuation should use. The first action is the default (Enter) and
   * is always the conservative one — the setup that is already frozen — because the
   * alternative starts a new tree; dismissing the dialog changes nothing at all.
   */
  private async askSetups(kind: 'user' | 'rollover'): Promise<'current' | 'latest' | null> {
    const currentLabel = vscode.l10n.t('Continue with current setup');
    const latestLabel = vscode.l10n.t('Continue with latest setup');
    const header = vscode.l10n.t('Continue with a new setup?');
    const detail =
      kind === 'user'
        ? vscode.l10n.t(
            'This conversation is frozen on its own setup, so a plain send always uses it. Continuing with the latest setup copies this tree into a new one; this tree keeps its setup and its prompt cache.',
          )
        : vscode.l10n.t(
            'A new context window starts empty, so the latest setup costs nothing here. Continuing with the current setup keeps this conversation on the setup it was frozen with.',
          );
    const pick = await vscode.window.showWarningMessage(header, { modal: true, detail }, currentLabel, latestLabel);
    if (pick === latestLabel) {
      return 'latest';
    }
    return pick === currentLabel ? 'current' : null;
  }

  /** Fork the checked-out tree under the live setup; `null` when it cannot be done. */
  private forkFor(rt: SessionRuntime): boolean {
    const id = rt.session.activeNodeId;
    if (!id) {
      return true; // nothing to copy: the next send freezes the live setup anyway
    }
    const forked = rt.forkTree(id);
    if (!forked) {
      rt.postNotice(
        'warning',
        vscode.l10n.t('Could not start a new setup here — wait for the running turn to finish and try again.'),
      );
      return false;
    }
    return true;
  }

  /**
   * True while an external controller is reloading the window. The runtimes check
   * this before starting *any* turn, so the reload cannot be raced by an injected
   * background/sub-agent notice turn.
   */
  isHeld(): boolean {
    return Date.now() < this.controlHoldUntil;
  }

  /** Messages from a panel's webview, resolved in that panel's session. */
  private handlePanelMessage(panel: ChatPanel, message: any): void | Promise<void> {
    return this.handleSessionMessage(panel.sessionId, message, panel);
  }

  /**
   * One webview→host message, resolved in `sessionId` — the single routing point both
   * surfaces reach: a local tab's webview ({@link handlePanelMessage}, with its panel) and
   * a remote peer's `input` frame (`applyRemoteInput`, called by
   * `src/remote/remoteService.ts`, without one).
   *
   * `panel` is present only for a local tab, because it is about *that tab*: the `ready`
   * handshake, its held messages and its age are the tab's own business, and a peer may
   * not submit `ready` anyway (it is not on `ACCEPT_FROM_PEER`).
   *
   * `origin` marks a turn a peer started (see `RemoteOrigin`): it is used only where a node
   * is created, and it never touches the message text that goes to the provider.
   */
  private handleSessionMessage(
    sessionId: string,
    message: any,
    panel?: ChatPanel,
    origin?: RemoteOrigin,
  ): void | Promise<void> {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) {
      return;
    }
    // The webview's half of a traced operation (its render timings) is pure
    // diagnostics: answer it *before* `runtimeFor`, which would build a whole
    // session runtime just to log a line.
    if (message?.type === 'perfDiag') {
      logWebviewReport(`session=${session.id}`, message);
      // …and the reports the host has to *act* on (a stall, a probe answer) are read from
      // the same message: the line above is written here, so the reaction must not write it
      // a second time.
      this.onPerfDiag(session.id, message);
      return;
    }
    if (message?.type === 'ready') {
      if (!panel) {
        return; // a boot handshake belongs to a tab; no tab, nothing to hand it to
      }
      // The tab is repainting itself. Open (or join) the op for **this** session
      // before its runtime is built, so `runtime-create` and the repaint marks land
      // on the tab's own operation rather than on whichever other tab is repainting
      // right now (a window reload restores every tab at once).
      startRepaintOp('panel-repaint', session.id);
    }
    const rt = this.runtimeFor(session);
    switch (message?.type) {
      case 'ready': {
        // The guard above already refused a `ready` without a tab; the local name is what
        // lets the four tab-scoped calls below say what they are for.
        const tab = panel;
        if (!tab) {
          return;
        }
        // Order matters: the tab is up (release it), then the single full repaint,
        // then whatever was held before it (e.g. deltas of a turn that started while
        // this tab was still loading its scripts). The age says whether a cold
        // switch's cost is ours (host work) or the browser's (loading main.js,
        // markdown-it, tree.js and the layout engine) — nothing else reports that.
        perf(() => `webview-ready session=${session.id} +${tab.ageMs()}ms`);
        tab.markReady();
        rt.postAllState();
        tab.flushHeld();
        return;
      }
      case 'loadAgentItems':
        // A sub-agent card was expanded: its transcript was deliberately left out of
        // the `tree` message (see `SessionRuntime.postTree`).
        rt.onAgentItems(String(message.id ?? ''));
        return;
      case 'userMessage':
        return this.dispatchUserMessage(rt, String(message.text ?? ''), message.attachments ?? [], origin);
      case 'forkTurn':
        // The composer's new-setup entry: same question as the drift gate, but asked
        // explicitly, and the answer may be "keep this setup" (then nothing forks).
        return void this.forkAndSend(rt, String(message.text ?? ''), message.attachments ?? []);
      case 'continueTurn':
        // The ▶ button on a card whose turn was interrupted / failed: the harness
        // writes the message (see `SessionRuntime.continueFrom`), so the reboot
        // hold and the per-node "already running" refusal stay in that one place.
        void rt.continueFrom(String(message.id ?? ''));
        return;
      case 'rolloverTurn': {
        // The rollover variant of the ▶ button: the window is full, so the turn
        // continues in a new, empty context window (see
        // `docs/agents/invariants/context-rollover.md`). Starting one STOPS whatever is
        // still running on that node — its background terminals and its sub-agent
        // subtree — because their results could never reach the new window. That is the
        // same destructive step the delete/clear paths gate behind a modal, so it is
        // gated here too, and only when there is actually something to stop.
        const id = String(message.id ?? '');
        if (!rt.canRollover(id)) {
          // Not a context-window failure after all: the ordinary in-place continue is
          // the right action, so the button can never dead-end.
          void rt.continueFrom(id);
          return;
        }
        void this.rolloverWithSetup(rt, id);
        return;
      }
      case 'checkout':
        rt.handleCheckout(String(message.id ?? ''));
        return;
      case 'setNodeSize':
        rt.onSetNodeSize(String(message.id ?? ''), Math.round(Number(message.w)), Math.round(Number(message.h)));
        return;
      case 'killAgent':
        rt.onKillAgent(String(message.id ?? ''));
        return;
      case 'deleteBranch':
        void this.deleteBranchInteractive(session.id, String(message.id ?? ''));
        return;
      case 'copyNodeId':
        // The card header's context menu (`media/main.js` `openNodeMenu`): the id
        // names the node in `list_nodes`, in the transcript dumps and in every
        // `[node <id>]` output-channel line, so it has to be copyable from the card.
        void this.copyNodeId(session, String(message.id ?? ''));
        return;
      case 'layoutDiagnostic':
        rt.logLayoutDiagnostic(message.nodes, message.overlaps, message.connections, message.force);
        return;
      case 'pickImage':
        void rt.handlePickImage();
        return;
      case 'stop':
        // `stop {nodeId}` is the composer's Stop: a union kill of everything that node
        // owns (turn + background terminals + sub-agents), whose notices are written
        // back into the node instead of continuing the conversation. An omitted
        // `nodeId` cancels every run of this session (the pre-P3 behaviour).
        rt.stop(typeof message.nodeId === 'string' && message.nodeId ? message.nodeId : undefined);
        return;
      case 'setModel':
        // The value is a card id (the dropdown's option value); `setModel` heals
        // anything else through `resolveModel`.
        rt.setModel(String(message.model ?? ''));
        return;
      case 'setThinkingEffort':
        // A free-form level: the session clamps it against its card's menu.
        rt.setThinkingEffort(String(message.effort ?? ''));
        return;
      case 'openModelTree':
        // The gear beside the model dropdown. Opening the page is a host concern
        // (one tab per window), so the webview only asks for it.
        this.openModelTree();
        return;
      case 'openExternal': {
        const url = String(message.url ?? '');
        let uri: vscode.Uri;
        try {
          uri = vscode.Uri.parse(url);
        } catch {
          return;
        }
        if (uri.scheme === 'http' || uri.scheme === 'https' || uri.scheme === 'mailto') {
          void vscode.env.openExternal(uri);
        }
        return;
      }
      case 'killBackground':
        rt.onKillBackground(Number(message.id));
        return;
      case 'clear':
        this.clear(session.id);
        return;
      default:
        return;
    }
  }

  /**
   * Copy one node's id to the clipboard — the card header's context menu
   * (`media/main.js` `openNodeMenu`). Validated against the session's own nodes: a
   * menu that outlived its node (the branch was deleted, or the tab switched
   * sessions between opening and clicking) must copy nothing rather than write an id
   * that names nothing. The clipboard write goes through the host, exactly like the
   * sidebar's Copy Session ID, so it also gets the status-bar confirmation a
   * webview cannot show.
   */
  private async copyNodeId(session: AgentSession, id: string): Promise<void> {
    if (!id || !session.nodes[id]) {
      return;
    }
    await vscode.env.clipboard.writeText(id);
    vscode.window.setStatusBarMessage(vscode.l10n.t('Copied node id: {0}', id), 2000);
  }

  /** Kill every running background terminal (session delete / extension dispose). */
  /**
   * Extension deactivation (a window close, a reload, the host shutting down):
   * write what is pending, wait for it, then tear down. `dispose()` cannot await,
   * and a coalesced write must not be lost with the host.
   */
  async shutdown(): Promise<void> {
    try {
      await this.flushPersist();
      await flushTranscripts();
    } catch {
      /* best effort: a failing write must not block teardown */
    }
    // Give the workspace lock back, so the next window (or the next activation) is not
    // waiting out the heartbeat before it may write the files.
    try {
      await this.store?.releaseLock(this.ownerId);
    } catch {
      /* the lock file may already be gone */
    }
    this.dispose();
  }

  dispose(): void {
    // A coalesced write must not die with the host: this is the last moment the
    // state can be handed over (a window close, a reload, an extension shutdown).
    if (this.dirty || this.persistTimer != null) {
      this.persistNow();
    }
    this.disposed = true;
    if (this.titleDrainTimer != null) {
      clearTimeout(this.titleDrainTimer);
      this.titleDrainTimer = null;
    }
    this.titleJob?.controller.abort();
    this.titleJob = null;
    this.titlePending.clear();
    this.stopLagWatch?.();
    this.stopLagWatch = null;
    if (this.storeHeartbeat) {
      clearInterval(this.storeHeartbeat);
      this.storeHeartbeat = null;
    }
    setPerfSink(null);
    setLagContextProvider(null);
    setOpTimeoutHook(null);
    // No diagnostic deadline may outlive the provider: a ladder's timer would write a line
    // about a window that is gone. With them go the per-session maps that state belongs to.
    for (const wait of this.probeWaits.values()) {
      clearTimeout(wait.timer);
    }
    this.probeWaits.clear();
    this.stallEpisodes.clear();
    this.tabHiddenSince.clear();
    this.viewStates.clear();
    this.postFailedAt.clear();
    this.lastProbeAt.clear();
    this.lastLadderAt.clear();
    this.windowStateSub?.dispose();
    this.windowStateSub = null;
    for (const rt of this.runtimes.values()) {
      rt.dispose();
    }
    this.runtimes.clear();
    // Nothing may outlive the provider: every registry the hub still holds is
    // torn down with its process tree.
    this.backgroundHub.killAll();
    // Deliberately NOT disposing the webview panels: disposing closes the editor
    // tabs, and a tab must outlive the extension host so VS Code can hand it
    // back through the webview panel serializer on the next activation
    // (restorePanel). VS Code tears the webviews down with the extension host.
    this.output.dispose();
    this.closePerfTee();
  }

  /**
   * The chat document. The template itself lives in `webviewShell.ts`, because the
   * **replicated session panel** (`src/remote/remoteSessionPanel.ts`) opens the very same
   * document for another window's session: one renderer, two surfaces, and therefore one
   * shell that cannot drift from itself (see that module's comment, and the two guards
   * `npm run check:webview` / `node tools/check-remote-assets.js`).
   */
  private getHtml(webview: vscode.Webview): string {
    return buildChatShell(webview, { extensionUri: this.extensionUri, mediaVersion: this.mediaVersion });
  }
}
