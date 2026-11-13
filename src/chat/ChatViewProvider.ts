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
  VENDORED_CARD,
  cardDisplayName,
  cards,
  contextWindowFor,
  normalizeEffort,
  parseCatalog,
  providerById,
  providerSpecs,
  resolveCard,
  setCatalog,
  type SearchProvider,
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
  epochForNode,
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
  titleFromPrompt,
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
import { AgentsMdSources, systemPrompt } from '../agent/prompt';
import {
  globalAgentsMdPath as liveGlobalAgentsMdPath,
  liveAgentsMdSources,
  resetAgentsMdCache,
} from './agentsMd';
import { defaultSessionTitle, l10nDiagnostics } from '../i18n';
import { buildChatShell } from './webviewShell';
import { BackgroundHub, BackgroundOwner } from './backgroundHub';
import { BackgroundTask } from '../tools/background';
import { ChatPanel } from './ChatPanel';
import { PanelManager } from './panels';
import {
  HarnessConfig,
  RuntimeHost,
  SessionRuntime,
  SubAgentJob,
  backgroundOutputTail,
  clipDisplayItem,
} from './runtime';
import { SessionTreeItem } from './SessionsProvider';
import { ModelTreeController, apiKeySecretName, searchKeySecretName } from './modelTree';
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
import { setSearchAccessResolver } from '../tools/webAccess';

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
 * How a session hop ends for the origin conversation.
 *
 * - `return_when_finished` (the default): the child session's final answer is
 *   delivered back as a user message once the child **calls `finish_hop`** and its
 *   session is idle. A turn end is not a hand-back.
 * - `fire_and_forget`: the child runs the task and **nothing** comes back; the
 *   origin is never resumed by it, and no trace is written into its tree.
 */
type HopMode = 'return_when_finished' | 'fire_and_forget';

const HOP_MODES: readonly HopMode[] = ['return_when_finished', 'fire_and_forget'];

/** Parse the `mode` argument; `null` means the caller sent something unknown. */
function parseHopMode(raw: unknown): HopMode | null {
  if (raw === undefined || raw === null || raw === '') {
    return 'return_when_finished';
  }
  return typeof raw === 'string' && (HOP_MODES as readonly string[]).includes(raw) ? (raw as HopMode) : null;
}

/**
 * The model-facing preamble a hopped-to session's **first** prompt carries. The tool
 * list already says what `finish_hop` *does*; this says the one thing a schema cannot
 * — that nothing comes back on its own. Ending a turn, an interrupt and a Stop all
 * leave the origin waiting, which is what lets the user steer the hopped session; the
 * call is the hand-back. English on purpose: it is prompt text read by the model, not
 * a UI string (`docs/agents/invariants/i18n.md`).
 */
function hopChildPreamble(originSessionId: string, dispatchNodeId: string, landingNodeId: string): string {
  const landing =
    landingNodeId === dispatchNodeId
      ? `omit it to land on node ${dispatchNodeId}, the node that dispatched this task`
      : `omit it to land on node ${landingNodeId}, the node your dispatcher chose`;
  return [
    `[hop] This session was started by a hop from another conversation — session ${originSessionId}, node ${dispatchNodeId} — and that conversation is waiting for you.`,
    'Nothing returns to it on its own: ending a turn, being interrupted, being stopped and idling all leave it waiting. That is deliberate — the user can interrupt or steer you at any time, and you keep the work.',
    'When the work is complete, call the finish_hop tool. Your final reply of that turn is then delivered to the caller as a message to its agent, so put everything it needs in that reply.',
    `finish_hop's optional \`source_session_node_id\` picks the node of session ${originSessionId} the reply lands on (as a new branch); ${landing}. search_transcripts sessionId=${originSessionId} reads that conversation's nodes and messages, which is how you name one.`,
    'Call finish_hop once, when the work really is done — after that this session has nothing left to hand back.',
  ].join('\n');
}

/**
 * One in-flight session handoff (`hop_session` / `POST /session/start` with
 * `returnTo`).
 *
 * `targetSessionId` is the **identity** of the child: it is written in the same
 * synchronous step that creates the session, before the child's first turn can
 * start, and the return trip matches on it alone — never on a timestamp or on
 * "the first new session that finishes", which is how a receipt used to be
 * attributed to the wrong conversation.
 */
interface Hop {
  id: string;
  originSessionId: string;
  /** The node the hop was dispatched from — the default place the answer lands. */
  originNodeId: string;
  /** Explicit override of the branch point (validated in the origin session). */
  returnNodeId?: string;
  mode: HopMode;
  armedAt: number;
  targetSessionId?: string;
  /**
   * Set by the child's `finish_hop`: **the hopped-to session decides when it
   * returns**. Until this is true `maybeDeliverHopReturn` does nothing at all — a
   * turn end, an interrupt and a Stop leave the hop armed and the origin waiting,
   * which is what makes a hopped session steerable. Once it is true the idle-wait
   * below runs unchanged: record the turn's final answer, wait for the child to be
   * idle, deliver, retire.
   */
  finishRequested?: boolean;
  /**
   * The node of the origin session the report lands on, chosen by `finish_hop`'s
   * optional `source_session_node_id` (else `returnNodeId`, else the node the hop
   * was dispatched from). Recorded at the call so the receipt needs no second
   * lookup.
   */
  handBackNodeId?: string;
  /**
   * What the child's last finished turn said, recorded at the end of a turn that
   * ran **after** `finishRequested` was set. The receipt is queued only once the
   * child session is **idle**: while it still
   * owns a running node background job, a running sub-agent batch or a queued
   * completion notice, the hop stays armed and every later turn end refreshes this
   * (see `maybeDeliverHopReturn` / `kickHopWork`). A return that ignored it released
   * the origin while the child kept working, and both then wrote one working tree.
   */
  pendingReturn?: { status: TurnStatus; answer: string; at: number };
}

/** A hop whose child session does not exist yet (its origin turn has not ended). */
interface PendingHopStart {
  hop: Hop;
  title?: string;
  prompt: string;
}

/** A finished child's answer waiting for its return node to be free. */
interface PendingReceipt {
  hop: Hop;
  prompt: string;
  queuedAt: number;
  /** Dispatch attempts that found a free node but did not start a turn. */
  attempts: number;
}

/** How often a waiting hop start / receipt is retried while it cannot land. */
const HOP_RETRY_MS = 200;
/**
 * How often an armed hop re-checks a child that ended a turn but still owns
 * unfinished work (a running node background job, a running sub-agent batch, or a
 * queued notice). `HOP_RETRY_MS` is for work that is already queued to land; a
 * child's background job can run for many minutes, so its wait polls at this rate.
 */
const HOP_IDLE_RECHECK_MS = 1000;
/**
 * How long one receipt may keep failing to start a turn on a node it saw free
 * (200 ms × 1500 = 5 min) before it is dropped with a log line. A node that is
 * merely busy or locked never counts: only an attempt that saw a free node counts.
 */
const HOP_RECEIPT_MAX_ATTEMPTS = 1500;
/**
 * The longest a receipt waits for a return node that never frees up (30 minutes).
 * The child's transcript is on disk, so dropping it is a log line and a lost
 * resume, never lost work.
 */
const HOP_RECEIPT_MAX_WAIT_MS = 30 * 60 * 1000;

/**
 * How long the window-global terminal dock's snapshot is coalesced away. The
 * per-session `backgrounds` snapshot uses the same 200 ms window (`SessionRuntime`),
 * so a chatty process costs both views the same handful of repaints a second.
 */
const BACKGROUNDS_GLOBAL_MS = 200;

/**
 * A job's identity across the window: a task id is **session-local** (the hub mints it
 * from a per-session counter), so the session has to travel with it. The separator is
 * `\0`, which no session id contains.
 */
function bgDockHandle(sessionId: string, taskId: number): string {
  return `${sessionId}\u0000${taskId}`;
}

/**
 * One job of the window-global terminal dock (`backgroundsGlobal`): every **detached**
 * command of every session, running or finished, as one flat list. A detached job is
 * session-wide fire-and-forget (it locks no node and notifies nobody), so the dock is its
 * only home; a `background` job lives beside its node instead.
 *
 * It is the same job the owning node's `kind:'bg'` card renders, plus the two things a
 * dock row alone can say — which **session** it belongs to (its title) and the card node
 * the dock's ✕ names. The hub is in-memory, so a job whose process is gone is rebuilt
 * from its persisted record; `detached` (the `shared` badge) is the one fact only the
 * live task can answer, exactly as on the card.
 */
export interface GlobalBackgroundInfo {
  /** The session the job belongs to (task ids repeat across sessions). */
  sessionId: string;
  /** That session's title, so a row says which conversation it came from. */
  sessionTitle: string;
  /** The session-local task id (`#<id>` on the row, and what kill names). */
  id: number;
  /** The `kind:'bg'` record the dock's ✕ dismisses (`null` when its branch is gone). */
  cardNodeId: string | null;
  command: string;
  status: 'running' | 'finished';
  exitCode: number | null;
  killed: boolean;
  /** The live task's `start_detached` flag (a restored record has no task to ask). */
  detached: boolean;
  /** Host epoch ms: the origin the row's elapsed chip ticks from. */
  startedAt: number;
  /** Where the chip freezes (null while the job runs). */
  finishedAt: number | null;
  /** The job's newest output (≤800 chars), from the live task or its record. */
  outputTail: string;
  /** The completion notice reached its reader (the card's `Delivered` badge). */
  delivered: boolean;
  /**
   * The user removed this job from the dock (`bgDockDismissed` on its record). The host
   * sends only the jobs the dock should list, and `false` travels on every one of those;
   * a row that still arrives marked `dismissed` is not rendered (see `media/main.js`).
   */
  dismissed: boolean;
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
 * What a freshly created systemwide `AGENTS.md` starts with: one comment line that
 * says what the file does.
 *
 * It has to be that short, because the file's content becomes system-prompt bytes
 * verbatim — every column here is sent to the model in every workspace. It is
 * localized (the user reads it in an editor) and an HTML comment (the model reads it
 * as an aside, not as an instruction).
 */
function globalAgentsMdStub(): string {
  const note = vscode.l10n.t(
    'Global instructions for every workspace: Spinney adds this file to the system prompt of every session. Reload the window after you edit it.',
  );
  return `<!-- ${note} -->\n`;
}

/**
 * The image bytes a `read_image` viewer may be handed in one answer: a data URL inflates
 * the file by a third, so 4 MiB of image is already a ~5.5 MB message, and anything larger
 * is a page the reader should look at in an editor instead (the row offers the click).
 */
const IMAGE_VIEW_MAX_BYTES = 4 * 1024 * 1024;

/** The content types the image viewer can inline by file extension. */
const IMAGE_VIEW_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
};

/**
 * The coordinator. P1 split every per-session / per-turn concern out into
 * `SessionRuntime` (see `src/chat/runtime.ts`) and every editor tab out into
 * `PanelManager` (see `src/chat/panels.ts`); this class owns what is genuinely
 * global:
 *
 *  - sessions and their persistence (`spinney.state`);
 *  - the `sessionId → SessionRuntime` map (`runtimes`);
 *  - tabs (`panels`), titles, transcripts, config, the control plane;
 *  - the global hop bookkeeping (`hopsByOrigin` / `hopsByTarget` / the queues).
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
  /**
   * One hop per origin session, at most: a second hop from the same session is
   * refused, while a hop in another session is independent.
   */
  private hopsByOrigin = new Map<string, Hop>();
  /**
   * The same hops, keyed by the **child session** they created. This index is the
   * return trip's whole identity: a turn that finishes in a session that is not in
   * here can never be mistaken for a hopped child.
   */
  private hopsByTarget = new Map<string, Hop>();
  /** Hop starts waiting for their origin session to finish the dispatching turn. */
  private pendingHopStarts: PendingHopStart[] = [];
  /** Receipts waiting for the origin node to be free again (busy / locked / held). */
  private pendingReceipts: PendingReceipt[] = [];
  /** The single timer that drains both queues (see `kickHopWork`). */
  private hopWorkTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Cache-busting suffix for media URLs; changes per extension session. Public because the
   * Model Card Tree page renders its own document and has to bust the same cache.
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
  /**
   * The window-global terminal dock's removal list, **in memory**: one handle per job
   * the user removed from the dock, keyed `sessionId\0taskId` (task ids are
   * session-local, so the pair is a job's identity). The durable form is
   * `bgDockDismissed` on the `kind:'bg'` record; this set is a view of it, rebuilt from
   * the sessions at load (`rebuildBgDismissed`) and kept in step with every dismissal,
   * so a snapshot never has to walk every session's tree twice.
   */
  private readonly bgDismissed = new Set<string>();
  /** The coalescing timer of the window-global `backgroundsGlobal` snapshot (~200 ms). */
  private bgGlobalTimer: ReturnType<typeof setTimeout> | null = null;
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
      // …and every tab is told, because the webview's frame sampler has to know it as well:
      // a window that is not in front must not be reported as a frozen screen, and the
      // snapshot each return sends is what shows the surface nobody was watching (see
      // `ChatPanel.reportWindowFocus`). Read-only for the tabs — nothing else changes.
      for (const id of this.panels.ids()) {
        this.panels.get(id)?.reportWindowFocus(state.focused);
      }
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
    this.clients = new ClientRegistry({
      apiKeyFor: (providerId) => this.readApiKeyFor(providerId),
      // What every request calls itself on the wire. A gateway that asks a coding agent to
      // identify itself must not be shown a generic HTTP library's name, and the version is
      // the one this window is actually running (`readOwnVersion`).
      userAgent: this.extensionVersion && this.extensionVersion !== '?' ? `spinney/${this.extensionVersion}` : 'spinney',
    });
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
      hasSearchToken: (dialect) => this.hasSearchKeyFor(dialect),
      storeSearchToken: (dialect, token) => this.storeSearchKeyFor(dialect, token),
      clearSearchToken: (dialect) => this.clearSearchKeyFor(dialect),
      onSaved: () => this.onModelCardsSaved(),
      log: (line) => this.output.appendLine(line),
    });
    // The two web tools ask this window one question per call: which engine leads, and
    // with what token. It has to be a resolver, not a captured value — the answer is the
    // **running node's** card (`ToolRegistry.setWebCard`), the endpoint is that card's
    // provider, and the token may be typed while the session is open. `undefined` means
    // no node (the self-test command): the vendored card answers, which is the shipped
    // dialect.
    setSearchAccessResolver(async (card) => {
      const target = card ?? VENDORED_CARD;
      const provider = providerById(target.providerId);
      if (target.searchProvider !== 'deepseek') {
        return { provider: 'builtin', baseUrl: provider.baseUrl, token: '' };
      }
      // The request goes to the card's own provider, so the token is that provider's
      // key — the two can never come from different hosts. The stored search token is
      // the override for when they are different *accounts*.
      const token = (await this.readSearchKeyFor(target.searchProvider)) || (await this.readApiKeyFor(provider.id));
      return { provider: target.searchProvider, baseUrl: provider.baseUrl, token };
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
    // A supervisor's reload may have carried a message for this instance (the daemon
    // that asked for the reload can die with it): deliver it once the window is idle.
    this.schedulePendingContinue();
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
      onRegistered: (owner, task) => this.onBackgroundRegistered(owner, task),
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
    const maxConcurrentSubagents = cfg.get<number>('maxConcurrentSubagents') ?? 15;
    const maxLevel2Subagents = cfg.get<number>('maxLevel2Subagents') ?? 2;
    const saveSubAgentTranscripts = cfg.get<boolean>('saveSubAgentTranscripts') ?? true;
    const saveSessionTranscripts = cfg.get<boolean>('saveSessionTranscripts') ?? true;
    const subAgentTranscriptDir = (cfg.get<string>('subAgentTranscriptDir') ?? '').trim();
    const autoSessionTitles = cfg.get<boolean>('autoSessionTitles') ?? true;
    // `hop_session` is the one tool a setting can take away. It is read live here
    // (and again from the provider's own gate) so switching it off reaches the next
    // turn; a chain that already froze the schema keeps advertising it and the call
    // is refused instead — the epoch rules forbid rewriting a sent prefix.
    const hopSessionEnabled = cfg.get<boolean>('hopSession.enabled') ?? true;
    // The composer's snippets: the shipped rows plus the user's own, keyed by
    // display name (`spinney.promptSections`). Resolved here rather than cached, so
    // the list is live on the next `postConfig` — the same shape every other key
    // follows.
    const promptSnippets = resolvePromptSnippets(cfg.get<unknown>('promptSections'));
    // The appear animation (`docs/agents/invariants/streaming-perf.md`). It is a
    // paint-only flag: with it off the webview renders exactly as it did before the
    // animation existed, and the text is complete in either case.
    const streamAnimation = cfg.get<boolean>('streamAnimation') ?? true;
    return { defaultCardId, replyLanguage, maxConcurrentSubagents, maxLevel2Subagents, saveSubAgentTranscripts, saveSessionTranscripts, subAgentTranscriptDir, autoSessionTitles, hopSessionEnabled, promptSnippets, streamAnimation };
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

  // ---- search tokens (SecretStorage: one entry per dialect) ----

  /**
   * A search dialect's own token, or '' when none is stored. This is the **override**:
   * a card's provider key is what authenticates its search request unless this is set,
   * which is why the vendored card needs no extra configuration. It exists for the case
   * the two are different keys — chat through a relay, search straight at the vendor —
   * and it is read on every call, so a new token is live with the next `web_search`.
   */
  private async readSearchKeyFor(dialect: SearchProvider): Promise<string> {
    if (!this.secrets) {
      return '';
    }
    try {
      return ((await this.secrets.get(searchKeySecretName(dialect))) ?? '').trim();
    } catch (err) {
      this.output.appendLine(
        `[config] could not read the search token: ${err instanceof Error ? err.message : String(err)}`,
      );
      return '';
    }
  }

  /** True when the dialect has its own token (the page shows "set" for it). */
  private async hasSearchKeyFor(dialect: SearchProvider): Promise<boolean> {
    return (await this.readSearchKeyFor(dialect)) !== '';
  }

  private async storeSearchKeyFor(dialect: SearchProvider, token: string): Promise<void> {
    const value = (token ?? '').trim();
    if (!value || !this.secrets) {
      return;
    }
    await this.secrets.store(searchKeySecretName(dialect), value);
    this.output.appendLine(`[config] search token (${dialect}): set`);
  }

  private async clearSearchKeyFor(dialect: SearchProvider): Promise<void> {
    await this.secrets?.delete(searchKeySecretName(dialect));
    this.output.appendLine(`[config] search token (${dialect}): cleared`);
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
   * Read the AGENTS.md files into the window's **fallback snapshot**:
   *
   * - the **systemwide** one, `<home>/.spinney/AGENTS.md` — the instructions that
   *   apply to every workspace on this machine (and the only ones no-repo mode can
   *   have, where there is no workspace root at all), and
   * - the workspace root's own `AGENTS.md`.
   *
   * Neither is the source of truth any more: `agentsMdSources()` reads both files **at
   * use** through a small mtime cache (`src/chat/agentsMd.ts`), so an edit made while
   * VS Code was closed — or during a session — is seen by the next drift check and the
   * next freeze. What is set here is the floor: a file that exists but cannot be read for
   * any reason other than "it is gone" falls back to this snapshot, so a transient
   * failure cannot silently drop the instructions from the prompt.
   */
  private loadAgentsMd(): void {
    this.loadGlobalAgentsMd();
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
      this.output.appendLine(`[agents.md] fallback snapshot ${agentsMdPath}`);
    } catch {
      Agent.setAgentsMd(null);
    }
  }

  /**
   * The instructions **as they are on disk right now** — the reader every prompt path and
   * the drift check share (`docs/agents/invariants/system-prompt.md`). It is what
   * `freezeEpoch` renders and hashes, and what `setupState` hashes again, so an edit is
   * seen by the next check instead of needing a window reload. `resetAgentsMdCache` on a
   * workspace-folder change, because the workspace path is part of the key.
   */
  agentsMdSources(): AgentsMdSources {
    return liveAgentsMdSources(this.globalStorage?.fsPath ?? '');
  }

  /**
   * Where the systemwide AGENTS.md lives: `~/.spinney/AGENTS.md`.
   *
   * The home directory is the point of it — the file has to outlive a profile
   * switch, an extension rename and a change of workspace, and global storage does
   * none of that (its folder is named after the extension id and it moves with the
   * profile). It is the fallback only when a host reports no home directory. Empty
   * string means there is nowhere to put the file.
   */
  private globalAgentsMdPath(): string {
    return liveGlobalAgentsMdPath(this.globalStorage?.fsPath ?? '');
  }

  /** Read the systemwide AGENTS.md into the window's fallback snapshot (see {@link loadAgentsMd}). */
  private loadGlobalAgentsMd(): void {
    const file = this.globalAgentsMdPath();
    if (!file) {
      Agent.setGlobalAgentsMd(null);
      return;
    }
    try {
      Agent.setGlobalAgentsMd(fs.readFileSync(file, 'utf8'));
      this.output.appendLine(`[agents.md] fallback snapshot ${file}`);
    } catch {
      Agent.setGlobalAgentsMd(null);
    }
  }

  /**
   * `Spinney: Open Global AGENTS.md` — create `~/.spinney/AGENTS.md` if it is
   * missing and open it for editing.
   *
   * A real file, unlike a manual page or the system prompt preview, because the
   * whole point is to keep editing it. It is a **snapshot** source all the same: an
   * edit takes effect in the next window, so this command opens the file and stops
   * there — it never re-renders a prompt behind a frozen epoch's back. The stub it
   * writes on creation is one comment line saying what the file is, because its
   * content becomes prompt bytes verbatim.
   */
  async openGlobalAgentsMd(): Promise<void> {
    const file = this.globalAgentsMdPath();
    if (!file) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('Spinney: no folder is available for the global AGENTS.md.'),
      );
      return;
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, globalAgentsMdStub(), 'utf8');
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Spinney: cannot create the global AGENTS.md ({0}).', reason),
      );
      return;
    }
    this.output.appendLine(`[agents.md] opened ${file}`);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  /**
   * Called when the set of workspace folders changes (a folder was opened or
   * closed): re-read the AGENTS.md snapshots (the systemwide one with the
   * workspace one — one code path, and re-reading a file that did not change is
   * harmless) and log the new mode plus the agent root. No
   * chat notice is posted — the conversation must stay clean. `transcriptRoot()`
   * and the prompt's `{{environment}}` line are live (they re-read on each use),
   * so they need no handling here.
   */
  public onWorkspaceFoldersChanged(): void {
    // The workspace path is part of the live reader's cache key: a folder change must not
    // keep answering with the previous workspace's instructions.
    resetAgentsMdCache();
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
    // A session runtime renders its own preview (the node in view, its pending pick, the
    // instructions on disk right now); with no runtime this is the same render for the
    // default card.
    return rt
      ? rt.systemPromptText()
      : systemPrompt(
          cardDisplayName(card),
          normalizeEffort(card, this.defaultThinkingEffort),
          this.getConfig().replyLanguage,
          undefined,
          this.agentsMdSources(),
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
    // The dock's removal list is a view of `bgDockDismissed` on every `kind:'bg'`
    // record, so it is rebuilt from exactly the sessions that were just loaded.
    this.rebuildBgDismissed();
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
        this.rebuildBgDismissed();
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
    // The sessions in front of the user changed wholesale: so did what the dock lists.
    this.rebuildBgDismissed();
    if (!this.sessions.some((s) => s.id === this.activeSessionId)) {
      this.activeSessionId = this.sessions[0].id;
      this.persistActiveSession();
    }
    this.notifyStateChanged();
    this.scheduleBackgroundsGlobal();
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
        `execForegroundSeconds=${num('execForegroundSeconds', 30)}s ` +
        `subAgentSyncSeconds=${num('subAgentSyncSeconds', 300)}s ` +
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

  /**
   * `rename_session` tool: an explicit, locking rename (main agent only).
   * `callerSessionId` is the session the calling agent runs in — the default target,
   * so an agent working in a background tab never renames whatever tab has focus.
   */
  handleRenameSession(args: Record<string, unknown>, callerSessionId?: string): string {
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    if (!title) {
      return 'Error: "title" is required.';
    }
    const wanted = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
    const session = wanted
      ? this.sessions.find((s) => s.id === wanted)
      : callerSessionId
        ? this.sessions.find((s) => s.id === callerSessionId)
        : this.getActiveSession();
    if (!session) {
      return `Error: no such session: ${wanted || callerSessionId || '(active)'}.`;
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
   * The conversation a **bookkeeping** request about this session names, for a provider
   * whose row asks for one: the context window the session is looking at, and the
   * session's own id when it has no frozen envelope yet. A provider whose dialect
   * requires a session id must never be sent a request without one, which is why this
   * falls back rather than answering ''.
   */
  private sessionConversation(session: AgentSession): string {
    return epochForNode(session, session.activeNodeId)?.id ?? session.id;
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
        providerSession: this.sessionConversation(session),
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
        // One batch covers several sessions, so there is no single conversation to name:
        // the name is the one of the session whose title request this batch stands in
        // for — the first — and a provider that requires an id still gets a stable one.
        providerSession: this.sessionConversation(sessions[0]),
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

  // ---- Session hop (provider bookkeeping) ----

  /** `spinney.hopSession.enabled`, read live (the handler refuses, the schema follows). */
  private hopSessionEnabled(): boolean {
    return vscode.workspace.getConfiguration('spinney').get<boolean>('hopSession.enabled') ?? true;
  }

  /**
   * Every hop the provider still owns (one per origin, plus their children), for the
   * two indexes and for `/state`.
   */
  private allHops(): Hop[] {
    return [...new Set([...this.hopsByOrigin.values(), ...this.hopsByTarget.values()])];
  }

  /**
   * The agent handed a task to a fresh session via `hop_session`: queue it with a
   * return address. The hop itself can only start once this turn ends; the armed hop
   * then routes the child's answer back here. `node` is the caller's own node (P3
   * binds the handler per node) and it is the **default** place the answer lands —
   * the hop leaves from the node it was dispatched from, not from whatever is
   * checked out when it comes back.
   *
   * One hop may be in flight per **origin session**; a hop in another session is
   * independent and does not block this one.
   */
  handleHopSession(rt: SessionRuntime, node: TreeNode, args: Record<string, unknown>): string {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!prompt) {
      return 'Error: "prompt" is required.';
    }
    if (!this.hopSessionEnabled()) {
      return 'Error: session hopping is disabled by the "spinney.hopSession.enabled" setting.';
    }
    if (this.readOnly) {
      return 'Error: another window owns this workspace\u2019s sessions, so this window cannot start a session (it is read-only).';
    }
    const mode = parseHopMode(args.mode);
    if (!mode) {
      return `Error: unknown "mode" ${JSON.stringify(args.mode)}; use "return_when_finished" or "fire_and_forget".`;
    }
    const session = rt.session;
    if (this.hopsByOrigin.has(session.id)) {
      return 'Error: a session hop from this session is already in progress.';
    }
    if (this.pendingHopStarts.some((p) => p.hop.originSessionId === session.id)) {
      return 'Error: a session start from this session is already queued.';
    }
    if (rt.hasRunningNodeBackground()) {
      return 'Error: a background terminal is still running in this session; finish or kill it before hopping.';
    }
    const returnNodeId = typeof args.returnNodeId === 'string' ? args.returnNodeId.trim() : '';
    if (mode === 'fire_and_forget' && returnNodeId) {
      return 'Error: "returnNodeId" cannot be used with mode "fire_and_forget" (nothing returns to this session).';
    }
    if (returnNodeId && !session.nodes[returnNodeId]) {
      return `Error: no such node in this session: ${returnNodeId} (use list_nodes to see the tree).`;
    }
    const title = typeof args.title === 'string' ? sliceText(args.title.trim(), 80) : '';
    const hop: Hop = {
      id: newId(),
      originSessionId: session.id,
      originNodeId: node.id,
      returnNodeId: returnNodeId || undefined,
      mode,
      armedAt: Date.now(),
    };
    if (mode === 'return_when_finished') {
      this.hopsByOrigin.set(session.id, hop);
    }
    this.pendingHopStarts.push({ hop, title: title || undefined, prompt });
    this.kickHopWork();
    this.outputLog(
      `[hop] queued (${mode}): ${prompt.slice(0, 80)}` +
        (mode === 'return_when_finished'
          ? ` (return to ${session.id} node ${returnNodeId || node.id})`
          : ' (no receipt)'),
    );
    if (mode === 'fire_and_forget') {
      return (
        'Queued. This turn is over: a fresh session will run your task now. ' +
        'Mode "fire_and_forget" means nothing comes back — this conversation will not be resumed by it, ' +
        'so put anything the user needs in your reply before ending the turn. ' +
        'The child session appears in the session list, and search_transcripts can read its trace later.'
      );
    }
    return (
      'Queued. This turn is over: a fresh session will run your task now. ' +
      'Nothing comes back until that session calls its own finish_hop tool — a turn ending, an interrupt ' +
      'and a Stop are not a hand-back, and it may be interrupted or steered by the user as often as it ' +
      'takes. When it calls finish_hop and is idle, you are resumed here with its final reply as a user ' +
      'message, as a new branch off ' +
      (returnNodeId ? `node ${returnNodeId}.` : `the node you dispatched from (${node.id}).`) +
      ' The child chooses that landing node itself (`source_session_node_id`), defaulting to this one.'
    );
  }

  /**
   * The hop that **started this session** — the capability lookup behind
   * `finish_hop`. It reads the session's own record (`AgentSession.hopOrigin`), not
   * the in-flight hop: the tool set an epoch froze must not change when the hop is
   * retired, and a handed-back session keeps answering "no armed hop" instead of
   * quietly losing the tool. A `fire_and_forget` child and every session no hop
   * started answer `null`.
   */
  hopTargetFor(sessionId: string): { originSessionId: string; originNodeId: string } | null {
    const origin = this.sessions.find((s) => s.id === sessionId)?.hopOrigin;
    return origin ? { originSessionId: origin.sessionId, originNodeId: origin.nodeId } : null;
  }

  /**
   * `finish_hop` from the hopped-to session: the child decides when it returns.
   *
   * The call only **marks** the hop and stores where the report lands; the delivery
   * is the existing idle-wait path (`maybeDeliverHopReturn` → `deliverHopReturn`),
   * which now does nothing at all until this flag is set. A second call answers the
   * same error as a call with no hop at all: the hand-back is spent.
   */
  handleFinishHop(rt: SessionRuntime, node: TreeNode, args: Record<string, unknown>): string {
    const hop = this.hopsByTarget.get(rt.session.id);
    if (!hop || hop.mode !== 'return_when_finished' || hop.finishRequested) {
      return 'Error: this session has no armed hop (it was already handed back, or none was started).';
    }
    if (this.disposed) {
      return 'Error: this window is shutting down, so the hop cannot be handed back.';
    }
    const wanted = typeof args.source_session_node_id === 'string' ? args.source_session_node_id.trim() : '';
    let landing = hop.returnNodeId ?? hop.originNodeId;
    if (wanted) {
      const origin = this.sessions.find((s) => s.id === hop.originSessionId);
      if (!origin) {
        return `Error: the source session ${hop.originSessionId} no longer exists, so there is nothing to hand this report back to.`;
      }
      const target = origin.nodes[wanted];
      if (!target) {
        return (
          `Error: no such node in the source session ${hop.originSessionId}: ${wanted} ` +
          `(search_transcripts sessionId=${hop.originSessionId} lists its nodes).`
        );
      }
      if (isSidecar(target)) {
        return (
          `Error: node ${wanted} in the source session ${hop.originSessionId} is a sidecar (a sub-agent or a ` +
          `background-job card), not a conversation node; pick a turn node ` +
          `(search_transcripts sessionId=${hop.originSessionId} shows them).`
        );
      }
      landing = wanted;
    }
    hop.finishRequested = true;
    hop.handBackNodeId = landing;
    this.kickHopWork();
    this.outputLog(
      `[hop] child ${rt.session.id} called finish_hop after a turn of ${node.id}; the report returns to ` +
        `${hop.originSessionId} node ${landing}`,
    );
    return (
      `Handed back. This turn's final reply is delivered to session ${hop.originSessionId} as a new branch off ` +
      `node ${landing} once this session is idle. Nothing else returns from here, and finish_hop cannot be ` +
      'called again in this session.'
    );
  }

  /**
   * A turn just finished in a runtime: if the finished turn belongs to a hopped
   * session (matched by its id, never by a timestamp), queue its final answer back
   * to the origin session; then drain anything a free session/node now allows. Folding
   * the kick in here keeps `finishTurn` on the narrow host API.
   */
  queueHopReturn(rt: SessionRuntime, node: TreeNode | null, status: TurnStatus): void {
    this.maybeDeliverHopReturn(rt, node, status);
    this.kickHopWork();
  }

  /**
   * If the turn that just finished belongs to a hopped session — the session the hop
   * created — deliver its final answer back to the origin session. A turn in any
   * other session is ignored: attribution is by the child's id, so a conversation
   * created while the hop was in flight can no longer steal the receipt.
   *
   * **The child decides when it returns.** Until it calls `finish_hop` this does
   * nothing at all: no recorded answer, no receipt, no retire. That is what makes a
   * hopped session steerable — a turn ending, an interrupt and a Stop all leave the
   * hop armed and the origin waiting, instead of pulling the caller back the moment
   * the child pauses.
   */
  private maybeDeliverHopReturn(rt: SessionRuntime, node: TreeNode | null, status: TurnStatus): void {
    const session = rt.session;
    const hop = this.hopsByTarget.get(session.id);
    if (!hop) {
      return;
    }
    if (node && isSidecar(node)) {
      return;
    }
    if (hop.mode !== 'return_when_finished') {
      this.retireHop(hop, `child ${session.id} finished (status ${status})`);
      return;
    }
    if (!hop.finishRequested) {
      this.outputLog(
        `[hop] child ${session.id} finished a turn (status ${status}) without finish_hop; ` +
          'the hop stays armed and nothing returns',
      );
      return;
    }
    // Record what this turn said. The child may continue (an injected notice reuses
    // the node, so the transcript and this answer grow), and the receipt must carry
    // the **last** thing it said, not the first turn that happened to end.
    hop.pendingReturn = {
      status,
      answer: node ? lastAssistantText(node) : '',
      at: Date.now(),
    };
    if (this.sessionStillWorking(rt)) {
      // A turn ending is not the task ending: the child may still own a running
      // background job, a sub-agent batch, or a notice already queued for it. This is
      // exactly the bug the wait exists for: a hop came back while the child kept
      // working, the origin went on to run its own commands on the same repository,
      // and the two blocked each other's repo lock. `kickHopWork` re-checks and
      // delivers once the child session is idle, and the next turn end refreshes
      // `pendingReturn` above with the newer answer.
      this.outputLog(
        `[hop] child ${session.id} finished a turn (status ${status}) but still owns unfinished ` +
          `work; the return waits for it`,
      );
      this.kickHopWork(HOP_IDLE_RECHECK_MS);
      return;
    }
    this.deliverHopReturn(hop);
  }

  /**
   * Queue a child's answer back to the origin, now that the child session is idle —
   * the child has called `finish_hop`, so the hop is spent and is retired here. It is
   * never retired at a turn end: only the hand-back ends a hop.
   */
  private deliverHopReturn(hop: Hop): void {
    const pending = hop.pendingReturn;
    if (!pending) {
      return;
    }
    const childId = hop.targetSessionId ?? '';
    const child = this.sessions.find((s) => s.id === childId);
    const origin = this.sessions.find((s) => s.id === hop.originSessionId);
    this.retireHop(hop, `child ${childId || '(unknown)'} called finish_hop and is idle`);
    if (!origin) {
      this.outputLog('[hop] origin session is gone; dropping the result');
      return;
    }
    const clipped =
      pending.answer.length > 8000 ? `${sliceText(pending.answer, 8000)}\n…[truncated]` : pending.answer;
    const receipt: PendingReceipt = {
      hop,
      attempts: 0,
      queuedAt: Date.now(),
      prompt:
        `[session hop receipt] The child session "${child ? child.title : childId}" (${childId}) called ` +
        `finish_hop and handed back its report.\n` +
        `Its final reply:\n\n${clipped || '(the new session produced no text reply)'}\n\n` +
        `(search_transcripts sessionId=${childId} has the full trace if you need it)`,
    };
    this.pendingReceipts.push(receipt);
    this.outputLog(
      `[hop] receipt queued for ${hop.originSessionId} node ${this.landingNodeId(hop)} ` +
        `(status ${pending.status}, ${clipped.length} chars)`,
    );
    // Try right away; whatever cannot land now waits for a free node (see kickHopWork).
    this.deliverReceipt(receipt);
  }

  /**
   * Deliver one receipt as a **user message** in the origin session, branched from an
   * explicit node — without opening/focusing a tab and without moving the session's
   * checkout. It is not a user *send*: the setup-drift dialog, the composer clear and
   * the API-key nudge are all skipped (`opts.injected`), so an unanswered drift
   * question can neither fork the tree nor swallow the answer.
   *
   * Returns true when the receipt left the queue; false when it must wait.
   */
  private deliverReceipt(receipt: PendingReceipt): boolean {
    const index = this.pendingReceipts.indexOf(receipt);
    if (index < 0) {
      return false;
    }
    const hop = receipt.hop;
    const drop = (why: string): false => {
      this.pendingReceipts.splice(index, 1);
      this.outputLog(`[hop] receipt dropped: ${why}`);
      return false;
    };
    const origin = this.sessions.find((s) => s.id === hop.originSessionId);
    if (!origin) {
      return drop('the origin session is gone');
    }
    if (Date.now() - receipt.queuedAt > HOP_RECEIPT_MAX_WAIT_MS) {
      return drop(`the return node stayed unavailable for ${Math.round(HOP_RECEIPT_MAX_WAIT_MS / 60000)} min`);
    }
    const nodeId = this.landingNodeId(hop);
    if (!nodeId || !origin.nodes[nodeId]) {
      return drop(`the return node ${nodeId || '(none)'} is gone`);
    }
    if (this.disposed || this.isHeld()) {
      return false; // a reboot hold: retry when it lifts
    }
    if (this.readOnly) {
      return drop('this window is read-only');
    }
    const rt = this.runtimeFor(origin);
    if (rt.runningNodes().includes(nodeId) || rt.lockedNodes().includes(nodeId)) {
      return false; // the node is busy or still owns unfinished work: wait for it
    }
    if (receipt.attempts >= HOP_RECEIPT_MAX_ATTEMPTS) {
      return drop(`the return node stayed busy for ${HOP_RECEIPT_MAX_ATTEMPTS} attempts`);
    }
    this.pendingReceipts.splice(index, 1);
    receipt.attempts += 1;
    const before = Object.keys(origin.nodes).length;
    void rt
      .onUserMessage(receipt.prompt, [], { basisNodeId: nodeId })
      .then(() => {
        if (this.disposed) {
          return;
        }
        if (Object.keys(origin.nodes).length > before) {
          this.outputLog(`[hop] receipt delivered to ${hop.originSessionId} node ${nodeId}`);
          return;
        }
        // The turn did not start (a race with a lock or the hold): put it back and let
        // the drain retry, instead of losing the child's answer.
        this.pendingReceipts.unshift(receipt);
        this.outputLog('[hop] receipt could not start a turn yet; it stays queued');
        this.kickHopWork(HOP_RETRY_MS);
      })
      .catch((err) => {
        if (this.disposed) {
          return;
        }
        this.pendingReceipts.unshift(receipt);
        this.outputLog(
          `[hop] receipt failed to start a turn: ${err instanceof Error ? err.message : String(err)} (it stays queued)`,
        );
        this.kickHopWork(HOP_RETRY_MS);
      });
    return true;
  }

  /**
   * The one timer that drains both queues: hop starts whose origin session is idle,
   * and receipts whose return node is free. It keeps re-arming while work remains, so
   * a hop in a long-lived session is never lost to a busy sibling node.
   */
  private kickHopWork(delayMs = 0): void {
    if (this.disposed || this.hopWorkTimer !== null) {
      return;
    }
    this.hopWorkTimer = setTimeout(() => {
      this.hopWorkTimer = null;
      if (this.disposed) {
        return;
      }
      for (const pending of [...this.pendingHopStarts]) {
        if (!this.originIdle(pending.hop.originSessionId)) {
          continue;
        }
        this.pendingHopStarts = this.pendingHopStarts.filter((p) => p !== pending);
        void this.startHop(pending);
      }
      for (const receipt of [...this.pendingReceipts]) {
        this.deliverReceipt(receipt);
      }
      // A hop whose child ended a turn but still owned work when it did: deliver now
      // that the child session is idle (a running turn, a running background job, a
      // sub-agent batch and a queued notice all keep it waiting). The map is copied
      // first because delivering retires the hop and edits the map mid-iteration.
      let waitingForChildren = false;
      for (const hop of [...this.hopsByTarget.values()]) {
        if (!hop.pendingReturn) {
          continue;
        }
        const child = hop.targetSessionId ? this.runtimes.get(hop.targetSessionId) : undefined;
        if (child && this.sessionStillWorking(child)) {
          waitingForChildren = true;
          continue;
        }
        this.deliverHopReturn(hop);
      }
      if (this.pendingHopStarts.length > 0 || this.pendingReceipts.length > 0) {
        this.kickHopWork(HOP_RETRY_MS);
      } else if (waitingForChildren) {
        this.kickHopWork(HOP_IDLE_RECHECK_MS);
      }
    }, delayMs);
  }

  /**
   * Start one queued hop: create the child session and bind its id **before** its
   * first turn can start, so the return trip can never be attributed to another
   * conversation.
   *
   * A `return_when_finished` child's first prompt carries the model-facing preamble
   * (`hopChildPreamble`) — nothing returns until it calls `finish_hop` — while the
   * session's title still comes from the caller's own `title` argument (the
   * provisional seed is the dispatcher's prompt, never the preamble).
   */
  private async startHop(pending: PendingHopStart): Promise<void> {
    const hop = pending.hop;
    if (!this.sessions.some((s) => s.id === hop.originSessionId)) {
      this.retireHop(hop, 'its origin session is gone');
      return;
    }
    const returns = hop.mode === 'return_when_finished';
    const prompt = returns
      ? `${hopChildPreamble(hop.originSessionId, hop.originNodeId, this.landingNodeId(hop))}\n\n---\n\n${pending.prompt}`
      : pending.prompt;
    const titleSeed = returns ? sliceText(titleFromPrompt(pending.prompt), 40) : undefined;
    const result = await this.controlStartSession(
      { title: pending.title, prompt },
      {
        titleSeed,
        hopStart: true,
        onSessionCreated: (sessionId) => {
          hop.targetSessionId = sessionId;
          if (hop.mode === 'return_when_finished' && this.hopsByOrigin.get(hop.originSessionId) === hop) {
            this.hopsByTarget.set(sessionId, hop);
            // The child's own record of the hop: it is what advertises `finish_hop`
            // to that session's main agent, before (and after) the first turn.
            const child = this.sessions.find((s) => s.id === sessionId);
            if (child) {
              child.hopOrigin = { sessionId: hop.originSessionId, nodeId: this.landingNodeId(hop) };
            }
            this.outputLog(
              `[hop] child ${sessionId} reports back to ${hop.originSessionId} node ` +
                `${this.landingNodeId(hop)} when it calls finish_hop`,
            );
          } else {
            this.outputLog(
              hop.mode === 'fire_and_forget'
                ? `[hop] child ${sessionId} (fire_and_forget: no receipt)`
                : `[hop] child ${sessionId} started, but this hop was disarmed while it started (no receipt)`,
            );
          }
        },
      },
    );
    if (!result.ok) {
      this.retireHop(hop, `start failed: ${result.error ?? 'unknown'}`);
    }
  }

  /**
   * Arm a hop on behalf of the control plane (`POST /session/start {returnTo:true}`):
   * the same queue the tool uses. The origin is **required** (`originSessionId`) and
   * never inferred — the answer belongs to the conversation the caller names, not to
   * whichever tab happens to have focus. Returns `{ok:true, queued:true}`: a hop is
   * always asynchronous.
   */
  private armHopFromControl(
    title: string | undefined,
    prompt: string,
    returnNodeId: string | undefined,
    originSessionId: string | undefined,
  ): ControlResult {
    if (!prompt) {
      return { ok: false, error: 'returnTo requires a prompt (the task the fresh session runs)' };
    }
    if (!originSessionId) {
      return {
        ok: false,
        error: 'returnTo requires originSessionId: this API never guesses which session the answer belongs to',
      };
    }
    const origin = this.sessions.find((s) => s.id === originSessionId);
    if (!origin) {
      return { ok: false, error: `no such session: ${originSessionId}` };
    }
    if (this.hopsByOrigin.has(origin.id)) {
      return { ok: false, error: 'a session hop from this session is already in progress', busy: true };
    }
    const nodeId = returnNodeId || origin.activeNodeId || origin.rootIds[0] || '';
    if (!nodeId || !origin.nodes[nodeId]) {
      return {
        ok: false,
        error: returnNodeId ? `no such node in session ${origin.id}: ${returnNodeId}` : 'the origin session has no node to return to',
      };
    }
    const hop: Hop = {
      id: newId(),
      originSessionId: origin.id,
      originNodeId: nodeId,
      returnNodeId: returnNodeId || undefined,
      mode: 'return_when_finished',
      armedAt: Date.now(),
    };
    this.hopsByOrigin.set(origin.id, hop);
    this.pendingHopStarts.push({ hop, title: title || undefined, prompt });
    this.kickHopWork();
    this.outputLog(`[http] session/start hop queued for ${origin.id} (${prompt.slice(0, 60)})`);
    return { ok: true, queued: true, originSessionId: origin.id };
  }

  /**
   * The node of the origin session a hop's report lands on: the child's own
   * `source_session_node_id` when its `finish_hop` named one, else the caller's
   * `returnNodeId`, else the node the hop was dispatched from.
   */
  private landingNodeId(hop: Hop): string {
    return hop.handBackNodeId ?? hop.returnNodeId ?? hop.originNodeId;
  }

  /**
   * Give up a hop: forget it in both indexes and in the receipt queue, so nothing
   * keeps pointing at a conversation that can no longer answer.
   */
  private retireHop(hop: Hop, why: string): void {
    if (this.hopsByOrigin.get(hop.originSessionId) === hop) {
      this.hopsByOrigin.delete(hop.originSessionId);
    }
    if (hop.targetSessionId !== undefined && this.hopsByTarget.get(hop.targetSessionId) === hop) {
      this.hopsByTarget.delete(hop.targetSessionId);
    }
    this.pendingReceipts = this.pendingReceipts.filter((r) => r.hop !== hop);
    this.outputLog(`[hop] hop ${hop.id} closed: ${why}`);
  }

  /** True when the session has no live turn (a session that was never opened is idle). */
  private originIdle(sessionId: string): boolean {
    const rt = this.runtimes.get(sessionId);
    return !rt || !rt.isRunning();
  }

  /**
   * True while a session still owns the work its last finished turn started: a
   * running **node** background job, a running sub-agent batch, or a completion
   * notice already queued for a node. `lockedNodes` is exactly that set, and it is
   * the same predicate the composer reads for its Stop button — the two must agree,
   * or the hop return and the UI would disagree about "finished". A `start_detached`
   * job is absent from it by design: it never reports back, so waiting for it would
   * hold the hop forever.
   */
  private sessionStillWorking(rt: SessionRuntime): boolean {
    return rt.runningNodes().length > 0 || rt.lockedNodes().length > 0;
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
   * Deliver one session-facing host→webview message (`SessionRuntime.post` →
   * `RuntimeHost.postTo`) to the tab that renders this session. A session with no open tab
   * has no view to update, so the message is simply dropped.
   */
  postTo(sessionId: string, message: unknown): void {
    this.panels.get(sessionId)?.post(message);
  }

  /**
   * The pixels a `read_image` viewer asked for, as a data URL.
   *
   * The webview cannot read a file and the panel's `asWebviewUri` is not the same thing for
   * every scope, so the host reads the file and inlines it: `img-src data:` is already in
   * the shell's CSP. The bytes travel once, when the row is expanded, and the cap keeps a
   * wall-sized screenshot from becoming a multi-megabyte message (a file over it is
   * answered with the reason, and the viewer says so).
   *
   * The answer also carries the file's mtime, because the viewer is about **that call's**
   * image: if the file has been rewritten since, the pixels below are the current file, and
   * the row says so instead of pretending they are what the model saw.
   *
   * The path is resolved here, not by the webview: the request carries the argument the
   * model gave `read_image`, which is usually **workspace-relative**, and a webview has no
   * root to resolve against while the extension host's own cwd is not the workspace. This is
   * the same rule `openFile` follows, and it is what the tool itself did when it read the
   * file — so the viewer shows the file the model was given.
   */
  private async answerImageUrl(sessionId: string, message: any): Promise<void> {
    const requestId = String(message?.requestId ?? '');
    const target = String(message?.path ?? '');
    const answer = (payload: Record<string, unknown>) =>
      this.postTo(sessionId, { type: 'imageUrlAnswer', requestId, ...payload });
    // Before the resolve: an empty path would resolve to the agent root, i.e. a directory.
    if (!target) {
      answer({ error: 'no path' });
      return;
    }
    const filePath = resolvePath(target);
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) {
        answer({ error: 'not a file', mtime: stat.mtimeMs });
        return;
      }
      if (stat.size > IMAGE_VIEW_MAX_BYTES) {
        answer({ error: 'too large', mtime: stat.mtimeMs, bytes: stat.size });
        return;
      }
      const bytes = await fs.promises.readFile(filePath);
      const ext = (/\.([a-z0-9]+)$/i.exec(filePath) || [])[1];
      const type = IMAGE_VIEW_TYPES[String(ext || '').toLowerCase()] || 'application/octet-stream';
      answer({ url: `data:${type};base64,${bytes.toString('base64')}`, mtime: stat.mtimeMs, bytes: stat.size });
    } catch (err) {
      answer({ error: err instanceof Error ? err.message : String(err) });
    }
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
    // Every hop that touches this session is dead: its origin can never be resumed
    // with a receipt, and a child of this session can no longer report anywhere.
    for (const hop of this.allHops()) {
      if (hop.originSessionId === id || hop.targetSessionId === id) {
        this.retireHop(hop, `session ${id} was deleted`);
      }
    }
    this.pendingHopStarts = this.pendingHopStarts.filter((p) => p.hop.originSessionId !== id);
    this.pendingReceipts = this.pendingReceipts.filter((r) => r.hop.originSessionId !== id);
    this.sessions.splice(idx, 1);
    // Its `kind:'bg'` records are gone with it, so its dock handles are too.
    this.forgetBgDismissed(id);
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
    // Deleting sessions removes `kind:'bg'` records, so the dock's list changed too.
    this.scheduleBackgroundsGlobal();
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
    // The tree (and with it every `kind:'bg'` record) is gone: the dock's removal list
    // for this session goes with it, and every tab's dock repaints.
    this.forgetBgDismissed(session.id);
    this.scheduleBackgroundsGlobal();
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
    // A deleted branch takes its `kind:'bg'` records (and their dock rows) with it.
    this.scheduleBackgroundsGlobal();
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
      hops: this.allHops().map((hop) => ({
        originSessionId: hop.originSessionId,
        originNodeId: hop.originNodeId,
        targetSessionId: hop.targetSessionId,
        returnNodeId: hop.returnNodeId,
        mode: hop.mode,
        armedAt: hop.armedAt,
        finishRequested: hop.finishRequested === true ? true : undefined,
      })),
      pendingReceipts: this.pendingReceipts.length,
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
   * fresh session is created immediately when another turn is running. A hop
   * (`returnTo`) always queues: its contract is "the caller's turn is over, the
   * fresh session reports back", and the answer is delivered to the origin session
   * as a new branch off `returnNodeId` when that is given. `nodeId` checks out a
   * node in the target session before the prompt is sent.
   */
  async controlStartSession(
    opts: {
      sessionId?: string;
      nodeId?: string;
      title?: string;
      prompt?: string;
      returnTo?: boolean;
      returnNodeId?: string;
      /** `hop_session`'s `mode` (also accepted here so both entry points agree). */
      mode?: string;
      /** The origin of a `returnTo` hop (never inferred — see `armHopFromControl`). */
      originSessionId?: string;
    },
    internal?: {
      /** Called with the new session id the instant it exists, before its first turn. */
      onSessionCreated?: (sessionId: string) => void;
      /** This call **is** a queued hop's start: other sessions running is expected. */
      hopStart?: boolean;
      /**
       * A provisional title for the new session, taken from the dispatcher's own
       * prompt. A hop's child carries a model-facing preamble in its first turn, and
       * the runtime would otherwise name the session after that preamble instead of
       * after the task. Provisional, so automatic naming still replaces it.
       */
      titleSeed?: string;
    },
  ): Promise<ControlResult> {
    if (this.readOnly) {
      return { ok: false, error: 'another window owns this workspace\u2019s sessions; this window is read-only' };
    }
    const prompt = (opts.prompt ?? '').trim();
    if (opts.returnTo) {
      // A hop is always asynchronous, and its origin is **explicit**: the control
      // plane has no idea which conversation a caller means, and guessing "the last
      // focused tab" is how an answer used to land in the wrong session.
      if (opts.sessionId) {
        return {
          ok: false,
          error: 'returnTo always creates a fresh session; drop sessionId (POST /continue brings a caller-supplied message back)',
        };
      }
      const mode = parseHopMode(opts.mode);
      if (!mode) {
        return { ok: false, error: `unknown "mode": use "return_when_finished" or "fire_and_forget"` };
      }
      if (mode === 'fire_and_forget') {
        return {
          ok: false,
          error: 'mode "fire_and_forget" cannot be combined with returnTo (nothing would return); drop returnTo for a fire-and-forget start',
        };
      }
      return this.armHopFromControl(opts.title, prompt, opts.returnNodeId, opts.originSessionId);
    }
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
      // fresh session starts right away — that is the concurrency this phase adds,
      // and a hop start runs this way once its own origin has finished.
      if (prompt) {
        return this.startFreshSession({ title: opts.title, prompt }, internal);
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
    return this.startFreshSession({ title: opts.title, prompt }, internal);
  }

  /**
   * Create a session, title it, open its tab and send `prompt` as its first turn.
   * Shared by the idle path and the "another session is running" path — the latter
   * is what makes sessions genuinely concurrent (P1). `internal.onSessionCreated`
   * runs **synchronously between** `createSessionInMemory()` and the dispatch, which
   * is what lets a hop bind its child's id before the child's first turn can end.
   */
  private async startFreshSession(
    opts: { title?: string; prompt: string },
    internal?: { onSessionCreated?: (sessionId: string) => void; titleSeed?: string },
  ): Promise<ControlResult> {
    const session = this.createSessionInMemory();
    // The hop's target id must exist before the turn does: a child's turn can never
    // finish before its own identity is recorded (`Hop.targetSessionId`).
    internal?.onSessionCreated?.(session.id);
    if (internal?.titleSeed) {
      // Provisional: a hop child is named after the dispatcher's task, not after the
      // preamble its first turn carries, and automatic naming may still replace it.
      this.applySessionTitle(session, internal.titleSeed, 'provisional');
    }
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
   *
   * `opts.continue` is the reload's own message: it is **persisted here, before the
   * reload**, and delivered by the next instance once it is idle (`schedulePendingContinue`),
   * so a supervisor that dies with the reload cannot lose it — the daemon a harness
   * starts from inside the window is exactly such a supervisor. The caller gets
   * `continueQueued: true` and must not post `/continue` itself.
   */
  controlReloadWindow(opts?: {
    continue?: { message: string; sessionId?: string; nodeId?: string };
  }): ControlResult {
    if (this.anyRunningTurn()) {
      return { ok: false, error: 'the agent is busy; wait for it to finish first', busy: true };
    }
    if (this.anyRunningSubAgents() || this.anyRunningBackground()) {
      return { ok: false, error: 'sub-agents or background terminals are still running', busy: true };
    }
    const queued = opts?.continue ? this.writePendingContinue(opts.continue) : false;
    // A reload kills this process: flush the coalesced write first, or the reload
    // itself could lose the state it is reloading for.
    void Promise.all([this.flushPersist(), flushTranscripts()]).finally(() => {
      setTimeout(() => {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }, 400);
    });
    return queued ? { ok: true, continueQueued: true } : { ok: true };
  }

  /** The file the *next* instance reads for a reload's own message. */
  private pendingContinueFile(): string | null {
    if (!this.globalStorage) return null;
    return path.join(this.globalStorage.fsPath, 'spinney', 'pending-continue.json');
  }

  /** Persist a reload's continue; `false` means it must go the old way (post-reload). */
  private writePendingContinue(carry: { message: string; sessionId?: string; nodeId?: string }): boolean {
    const file = this.pendingContinueFile();
    const message = (carry.message ?? '').trim();
    if (!file || !message) return false;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({
          workspaceKey: workspaceKeyFor(vscode.workspace.workspaceFolders?.[0]?.uri.toString()),
          at: Date.now(),
          message,
          sessionId: carry.sessionId ?? null,
          nodeId: carry.nodeId ?? null,
        }),
        'utf8',
      );
      return true;
    } catch (err) {
      this.outputLog(`[control] could not persist the reload continue: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Deliver the previous instance's reload continue, once. Read at activation and
   * removed immediately (a stale or foreign-workspace file is dropped, never replayed),
   * then retried while the window is held or busy; a session that no longer exists
   * drops it with a line, which is the only way to tell that apart from "never sent".
   */
  private schedulePendingContinue(): void {
    const file = this.pendingContinueFile();
    if (!file) return;
    let carry: { message: string; sessionId?: string; nodeId?: string } | null = null;
    try {
      if (!fs.existsSync(file)) return;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      const key = workspaceKeyFor(vscode.workspace.workspaceFolders?.[0]?.uri.toString());
      const at = Number(raw.at ?? 0);
      const fresh = Date.now() - at < 10 * 60 * 1000;
      if (raw.workspaceKey === key && typeof raw.message === 'string' && raw.message.trim() && fresh) {
        carry = {
          message: String(raw.message),
          sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : undefined,
          nodeId: typeof raw.nodeId === 'string' ? raw.nodeId : undefined,
        };
      } else {
        this.outputLog('[control] a reload continue was stale or for another workspace; dropped');
      }
    } catch {
      // A half-written file is not a message.
    } finally {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* nothing to remove */
      }
    }
    if (carry) this.deliverPendingContinue(carry);
  }

  /** The retry ladder behind `schedulePendingContinue` (held/busy are transient). */
  private deliverPendingContinue(
    carry: { message: string; sessionId?: string; nodeId?: string },
    attempt = 0,
  ): void {
    if (this.disposed) return;
    if (this.isHeld() || this.anyRunningTurn()) {
      if (attempt < 120) {
        const timer = setTimeout(() => this.deliverPendingContinue(carry, attempt + 1), 1000);
        timer.unref?.();
      }
      return;
    }
    void this.controlContinueFrom(carry)
      .then((result) => {
        if (result.ok) {
          this.outputLog('[control] continued after the reload');
          return;
        }
        if (result.busy && attempt < 120) {
          const timer = setTimeout(() => this.deliverPendingContinue(carry, attempt + 1), 1000);
          timer.unref?.();
          return;
        }
        this.outputLog(`[control] the reload continue was dropped: ${result.error ?? 'unknown error'}`);
      })
      .catch((err) => {
        this.outputLog(`[control] the reload continue failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  // ---- The window-global terminal dock ----
  //
  // Every **detached** command of the window — running or finished, whatever session and
  // whatever tab — is one list, broadcast as `backgroundsGlobal` to **every** open chat
  // panel. A detached job is session-wide fire-and-forget: it locks no node, notifies
  // nobody, so this list is the only place that can show it or kill it. A `background` job
  // is a node job and lives beside its node (the `kind:'bg'` card), never here. Each row is
  // still the same job body the card renders (one shared builder), so the dock can never
  // say something a card does not.
  //
  // Two sources, de-duplicated by `(sessionId, id)`: the live hub tasks of every
  // session, and the persisted `kind:'bg'` record nodes of every session (delivered
  // ones included — that is what survives a reload, because the hub is in-memory).
  // The removal list is `bgDockDismissed` on the record itself.

  /**
   * Rebuild the in-memory removal list from the sessions just loaded, adopted or
   * imported. `bgDockDismissed` on each `kind:'bg'` record is the durable form, so a
   * reload needs no second store and no migration.
   */
  private rebuildBgDismissed(): void {
    this.bgDismissed.clear();
    for (const session of this.sessions) {
      for (const node of Object.values(session.nodes)) {
        if (node.kind === 'bg' && node.bgDockDismissed === true && node.bgTaskId != null) {
          this.bgDismissed.add(bgDockHandle(session.id, node.bgTaskId));
        }
      }
    }
  }

  /** Forget a session's dock handles (its records are gone with it). */
  private forgetBgDismissed(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const key of [...this.bgDismissed]) {
      if (key.startsWith(prefix)) {
        this.bgDismissed.delete(key);
      }
    }
  }

  /**
   * The hub's `onRegistered`, once per job: two things must happen before the job's first
   * update arrives, and they belong together because a job that reuses an id needs the one
   * *and* a card.
   *
   * The dismissal: a **new** job can reuse an id, because the minting counter lives in the
   * hub, which is in-memory and starts again at 1 after every reload, while `bgDismissed`
   * is keyed `(sessionId, taskId)` and is rebuilt from the durable `bgDockDismissed`
   * records. Without clearing the stale handle, a job dismissed before a reload would
   * silence the next job that happens to take the same id, for good. A job that has just
   * started is never dismissed, so the delete is unconditional.
   *
   * The card: the owning session's runtime creates the `kind:'bg'` sidecar that mirrors the
   * job. A session with no runtime has no view to update (nothing is running there).
   *
   * A method rather than a closure so `tools/dock-acceptance.js` can drive it: this is the
   * half of the dock's membership that a reload is the only real test of, and it was
   * exactly the half that broke.
   */
  private onBackgroundRegistered(owner: BackgroundOwner, task: BackgroundTask): void {
    this.bgDismissed.delete(bgDockHandle(owner.sessionId, task.id));
    this.runtimes.get(owner.sessionId)?.onBackgroundRegistered(owner, task);
  }

  /**
   * Every job the dock lists, in the order it shows them: running first, then
   * finished, newest first inside each group.
   *
   * A job the user dismissed is left out (a running job can never be dismissed, so
   * nothing live disappears). A job whose card is gone — a branch deleted while the
   * process still runs — keeps its row (`cardNodeId: null`): the process is real, and
   * the dock is the only place that could still show or kill it.
   */
  private globalBackgroundJobs(): GlobalBackgroundInfo[] {
    const jobs: GlobalBackgroundInfo[] = [];
    for (const session of this.sessions) {
      const live = new Map<number, BackgroundTask>();
      for (const hit of this.backgroundHub.listForSession(session.id)) {
        live.set(hit.task.id, hit.task);
      }
      const seen = new Set<number>();
      const push = (taskId: number, node: TreeNode | undefined): void => {
        if (seen.has(taskId)) {
          return;
        }
        seen.add(taskId);
        if (this.bgDismissed.has(bgDockHandle(session.id, taskId))) {
          return;
        }
        const task = live.get(taskId);
        // Only a **detached** job belongs in the window-global dock: it is session-wide
        // fire-and-forget, it locks no node and notifies nobody, so this list is the only
        // place that can show it (or kill it). A `background` job is a node job — it has a
        // card of its own beside that node, and that card is where it lives. Without a live
        // task the record's own durable flag answers (a restored job has no hub entry).
        if (task ? task.detached !== true : node?.bgDetached !== true) {
          return;
        }
        const running = task ? task.status === 'running' : false;
        // The record is the only clock a restored card has: the job's start is the
        // card's own `createdAt`, and its frozen duration gives the end.
        const startedAt = task ? task.startedAt : node?.createdAt ?? 0;
        const frozen = typeof node?.bgElapsedMs === 'number' ? startedAt + node.bgElapsedMs : null;
        jobs.push({
          sessionId: session.id,
          sessionTitle: session.title,
          id: taskId,
          cardNodeId: node?.id ?? null,
          command: node?.bgCommand ?? task?.command ?? node?.title ?? '',
          status: running ? 'running' : 'finished',
          exitCode: task ? task.exitCode : node?.bgExitCode ?? null,
          killed: task ? task.killed === true : node?.bgKilled === true,
          // A restored record has no task left to ask, so it never claims `shared`
          // (same rule as the card's `bgDetached`).
          detached: task ? task.detached === true : false,
          startedAt,
          finishedAt: task ? task.finishedAt : frozen,
          outputTail: task ? backgroundOutputTail(task) : node?.bgOutputTail ?? '',
          delivered: task ? task.delivered === true : node?.delivered === true,
          dismissed: false,
        });
      };
      // The records first: each carries its card node (the dock's ✕ names it)…
      for (const node of Object.values(session.nodes)) {
        if (node.kind === 'bg' && node.bgTaskId != null) {
          push(node.bgTaskId, node);
        }
      }
      // …then any live task with no card left, which would otherwise be invisible.
      for (const taskId of live.keys()) {
        push(taskId, undefined);
      }
    }
    jobs.sort(
      (a, b) =>
        (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) ||
        b.startedAt - a.startedAt ||
        a.sessionId.localeCompare(b.sessionId) ||
        a.id - b.id,
    );
    return jobs;
  }

  /**
   * Coalesce the window-global snapshot (~200 ms), exactly like the per-session one:
   * a chatty process fires the hub's `onUpdated` many times a second, and the dock of
   * every tab must not pay for each of them.
   */
  scheduleBackgroundsGlobal(): void {
    if (this.disposed || this.bgGlobalTimer != null) {
      return;
    }
    this.bgGlobalTimer = setTimeout(() => {
      this.bgGlobalTimer = null;
      this.postBackgroundsGlobal();
    }, BACKGROUNDS_GLOBAL_MS);
  }

  /** Deliver the window-global snapshot to every open chat tab (a session id is not asked). */
  postBackgroundsGlobal(): void {
    if (this.disposed) {
      return;
    }
    const jobs = this.globalBackgroundJobs();
    for (const id of this.panels.ids()) {
      this.panels.get(id)?.post({ type: 'backgroundsGlobal', jobs });
    }
  }

  /** RuntimeHost: a background terminal of one session changed (see its doc). */
  backgroundsChanged(): void {
    this.scheduleBackgroundsGlobal();
  }

  /**
   * The dock's **kill** (`killBackground {sessionId, id}`): the id is session-local, so
   * the session travels with it and a job can be killed from any tab — including one
   * belonging to a session whose own tab is not open. That session's runtime is created
   * on demand, which is what creates the job's card and delivers the kill's notice; the
   * window-global snapshot is then reposted for the tab that asked.
   */
  private killBackgroundIn(sessionId: string, id: number): void {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session || !Number.isFinite(id)) {
      return;
    }
    this.runtimeFor(session).onKillBackground(id);
    this.scheduleBackgroundsGlobal();
  }

  /**
   * The dock's **✕**: stop listing one job — a field on its record (`bgDockDismissed`),
   * persisted with the session, so the removal survives a reload. The card itself is
   * untouched: the tree's delete removes the record, the dock's ✕ only stops listing it,
   * and those two gestures stay separate.
   *
   * A **running** job is refused: the dock must never be able to hide work in progress
   * (the button is not rendered for one, and the host re-checks because the click can
   * race the job's own end).
   */
  private dismissBackground(sessionId: string, cardNodeId: string): void {
    if (this.readOnly) {
      return;
    }
    const session = this.sessions.find((s) => s.id === sessionId);
    const node = session && cardNodeId ? session.nodes[cardNodeId] : undefined;
    if (!session || !node || node.kind !== 'bg' || node.bgTaskId == null) {
      return;
    }
    if (this.backgroundHub.lookup(session.id, node.bgTaskId)?.task.status === 'running') {
      return;
    }
    if (node.bgDockDismissed !== true) {
      node.bgDockDismissed = true;
      this.bgDismissed.add(bgDockHandle(session.id, node.bgTaskId));
      // The record is the durable form: written now, so a reload cannot resurrect a
      // row the user just removed.
      this.markSessionDirty(session.id);
      this.persistNow();
    }
    this.scheduleBackgroundsGlobal();
  }

  /**
   * `Clear finished`: dismiss every finished job of **every** session at once — the dock
   * is window-global, so its clear is too. Running jobs are left alone, and the cards
   * stay where they are (see {@link dismissBackground}).
   */
  private clearFinishedBackgrounds(): void {
    if (this.readOnly) {
      return;
    }
    const changed = new Set<string>();
    for (const session of this.sessions) {
      for (const node of Object.values(session.nodes)) {
        if (node.kind !== 'bg' || node.bgTaskId == null || node.bgDockDismissed === true) {
          continue;
        }
        if (this.backgroundHub.lookup(session.id, node.bgTaskId)?.task.status === 'running') {
          continue;
        }
        node.bgDockDismissed = true;
        this.bgDismissed.add(bgDockHandle(session.id, node.bgTaskId));
        changed.add(session.id);
      }
    }
    if (changed.size > 0) {
      for (const id of changed) {
        this.markSessionDirty(id);
      }
      this.persistNow();
    }
    this.scheduleBackgroundsGlobal();
  }

  // ---- Webview routing ----

  private async dispatchUserMessage(
    rt: SessionRuntime,
    text: string,
    attachments: UserAttachment[],
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
    // A window the provider already refused is refused **here** too: the same request
    // cannot be sent again, and the composer's new-epoch entry is the way out
    // (`newContextEntry`). The Send button is already disabled there; this is the
    // host-side half of one rule, so a stale or scripted send cannot walk into it.
    if (rt.contextStateLive() === 'full') {
      rt.postNotice(
        'warning',
        vscode.l10n.t(
          'This context window is full, so the request was not sent. Use “Continue with new context” to carry the conversation into a new window.',
        ),
      );
      return;
    }
    // A send is the moment a key matters: nudge once (never block — the request
    // itself reports the real error).
    void this.warnMissingApiKey();
    await rt.onUserMessage(text, attachments);
    // The composer holds the text until this point: a refused send must not eat what the
    // user typed (`composerClear`).
    this.postTo(rt.sessionId, { type: 'composerClear' });
  }

  /**
   * The composer's **one** new-epoch entry (`newContextTurn`) — the replacement for the
   * three entries that used to disagree: the card's `⧉ Continue in a new window`, the
   * harness-drift `⧉` hint, and the modal a plain send raised when the user changed the
   * model / effort / language.
   *
   * The backend is the **trigger**, never a choice of the webview
   * (`SessionRuntime.newEpochTrigger`):
   *
   *  - context `near`/`full` → a **new context window** (`rolloverContext`), the only
   *    answer to a history that no longer fits. Its preconditions are re-checked here
   *    (a node, not a sidecar, not running, no conversational child) and a failure is a
   *    notice — nothing is started, nothing is killed.
   *  - setup drift only → a **fork** under the live setup (`forkTree`), so the old tree
   *    keeps the bytes and the provider cache entry it was built with. The composer's
   *    text becomes a normal send in the new tree; with an empty box there is nothing to
   *    send and the fork alone is the whole action.
   *
   * Then **one** modal question (the details differ per backend), and after the answer
   * the trigger is re-validated: the state may have changed while the question was open
   * (a turn finished, a dropdown moved, the window filled), and sending under an answer
   * given for a different state would be the bug this check exists for. Dismissing the
   * modal sends nothing, kills nothing and leaves the composer's text alone.
   */
  private async newContextEntry(
    rt: SessionRuntime,
    text: string,
    attachments: UserAttachment[],
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
    const trigger = rt.newEpochTrigger();
    if (!trigger) {
      rt.postNotice(
        'info',
        vscode.l10n.t('Nothing to do: this conversation is on its own setup, and its context window has room left.'),
      );
      return;
    }
    const nodeId = rt.session.activeNodeId ?? '';
    if (trigger === 'context' && !rt.canRollover(nodeId)) {
      // One predicate covers all four preconditions, and `false` here means the state
      // moved between the click and this line.
      rt.postNotice(
        'warning',
        vscode.l10n.t('Could not continue in a new context here — wait for the running turn to finish and try again.'),
      );
      return;
    }
    const answer = await this.confirmEpochChange(rt, trigger);
    if (!answer) {
      return;
    }
    if (rt.newEpochTrigger() !== trigger) {
      rt.postNotice(
        'warning',
        vscode.l10n.t('Nothing was sent: the setup or the context window changed while the question was open. Try again.'),
      );
      return;
    }
    if (trigger === 'drift') {
      await this.forkEntry(rt, text, attachments);
      return;
    }
    // The new window inherits the checked-out chain's frozen epoch (`'current'`): the
    // question this entry asks is about the *window*, not about the setup, and a window
    // that inherits keeps the bytes the conversation was already written in. Acting on a
    // drift is still available afterwards — the composer's entry stays offerable.
    const work = rt.lockedWorkCount(nodeId);
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
    const started = await rt.rolloverContext(nodeId, 'current', {
      text,
      handoff: answer === 'summary' ? 'summary' : 'continue',
    });
    if (!started) {
      rt.postNotice(
        'warning',
        vscode.l10n.t('Could not continue in a new context here — wait for the running turn to finish and try again.'),
      );
      return;
    }
    this.postTo(rt.sessionId, { type: 'composerClear' });
  }

  /**
   * The fork half of the new-epoch entry: copy the tree under the live setup, then send
   * the composer's text there as an ordinary turn (`onUserMessage`), attachments and all.
   * An empty box forks only — there is no user message to invent.
   */
  private async forkEntry(rt: SessionRuntime, text: string, attachments: UserAttachment[]): Promise<void> {
    if (!this.forkFor(rt)) {
      return;
    }
    if (!text.trim() && attachments.length === 0) {
      return;
    }
    void this.warnMissingApiKey();
    await rt.onUserMessage(text, attachments);
    this.postTo(rt.sessionId, { type: 'composerClear' });
  }

  /**
   * The one modal question the new-epoch entry asks, and its answer:
   *
   *  - a **context** continuation asks how the previous window is handed over — a written
   *    summary (one extra request, `handoff: 'summary'`) or the pointer to the previous
   *    branch, which the new window can read itself (`'continue'`). Neither costs the
   *    other's work, so this is a real choice.
   *  - a **setup** change asks whether the history may be re-sent under the new
   *    configuration. It cannot be silent: the provider has never seen those bytes under
   *    that card, so the request misses its prefix cache — and the number says how much
   *    history is about to be re-read.
   *
   * `null` means the user dismissed it: nothing is sent, nothing is killed, and the
   * composer keeps its text.
   */
  private async confirmEpochChange(
    rt: SessionRuntime,
    trigger: 'context' | 'drift',
  ): Promise<'summary' | 'continue' | boolean | null> {
    if (trigger === 'context') {
      const summaryLabel = vscode.l10n.t('Write a handoff summary');
      const continueLabel = vscode.l10n.t('Just continue');
      const pick = await vscode.window.showWarningMessage(
        vscode.l10n.t('Continue in a new context window?'),
        {
          modal: true,
          detail: vscode.l10n.t(
            'The agent that takes over continues this conversation in a new window. It can either receive a handoff summary (one extra request) or be pointed at the previous branch and read the record itself.',
          ),
        },
        summaryLabel,
        continueLabel,
      );
      if (pick === summaryLabel) {
        return 'summary';
      }
      return pick === continueLabel ? 'continue' : null;
    }
    const continueLabel = vscode.l10n.t('Continue');
    const pick = await vscode.window.showWarningMessage(
      vscode.l10n.t('Continue with the new workspace or model configuration?'),
      {
        modal: true,
        detail: vscode.l10n.t(
          'The conversation history (about {0} tokens for the current model) will be sent to the provider under the new configuration. This request will miss the provider\u2019s cache.',
          rt.chainPromptTokensLive(),
        ),
      },
      continueLabel,
    );
    return pick === continueLabel;
  }

  /** The one read-only sentence, in one place. */
  private readOnlyNotice(): string {
    return vscode.l10n.t(
      'Another window owns this workspace\u2019s sessions, so this window is read-only. Close that window (or use it) to continue here.',
    );
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
   * One webview→host message, resolved in `sessionId` — the single routing point a tab's
   * webview reaches ({@link handlePanelMessage}, with its panel).
   *
   * `panel` is present only for a local tab, because it is about *that tab*: the `ready`
   * handshake, its held messages and its age are the tab's own business.
   */
  private handleSessionMessage(
    sessionId: string,
    message: any,
    panel?: ChatPanel,
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
        // The window-global dock is not part of a session's repaint: a tab that has just
        // come up starts with **every** job of the window, or a reload would show an empty
        // dock until the next job happens to change.
        this.postBackgroundsGlobal();
        tab.flushHeld();
        return;
      }
      case 'loadAgentItems':
        // A sub-agent card was expanded: its transcript was deliberately left out of
        // the `tree` message (see `SessionRuntime.postTree`).
        rt.onAgentItems(String(message.id ?? ''));
        return;
      case 'loadNodeItems':
        // A card asked for **one** node's items: a card whose items never arrived says it is
        // waiting and asks once (`media/main.js`). Same shape, same refusals as
        // `loadAgentItems` above: a node this session does not have is answered with nothing.
        rt.onNodeItems(String(message.id ?? ''));
        return;
      case 'userMessage':
        return this.dispatchUserMessage(rt, String(message.text ?? ''), message.attachments ?? []);
      case 'newContextTurn':
        // The composer's ONE new-epoch entry: a new context window when the chain is
        // near/full, a fork under the live setup when only the setup drifted. The host
        // picks the backend, asks one modal question and re-validates the trigger
        // (`newContextEntry`), so the webview never has to know which case it is in.
        return void this.newContextEntry(rt, String(message.text ?? ''), message.attachments ?? []);
      case 'continueTurn':
        // The ▶ button on a card whose turn was interrupted / failed: the harness
        // writes the message (see `SessionRuntime.continueFrom`), so the reboot
        // hold and the per-node "already running" refusal stay in that one place.
        void rt.continueFrom(String(message.id ?? ''));
        return;
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
      case 'openFile': {
        // A viewer's own click (an image, a search hit, a diff's path): show the file in an
        // editor tab. The path comes from a tool call this session ran, and the only thing
        // this does is open it, so nothing is written and nothing outside this window changes.
        //
        // The path is resolved against the agent root because `search_files` prints
        // **workspace-relative** paths (`src/a.ts:12: …`), and `Uri.file` would read one as
        // relative to the extension host's cwd. `resolvePath` also maps the Git-Bash form
        // (`/d/Repos/x`) onto the drive path, and leaves an absolute path alone — which is
        // what a `search_transcripts` hit carries (the dumps live outside the workspace).
        const target = String(message.path ?? '');
        if (!target) {
          return;
        }
        const uri = vscode.Uri.file(resolvePath(target));
        // A hit names a line; an image click names none. A line this build cannot read is
        // not a reason to refuse the click: the file still opens.
        const line = Number(message.line);
        if (Number.isFinite(line) && line >= 1) {
          void vscode.window
            .showTextDocument(uri, {
              preview: true,
              selection: new vscode.Range(line - 1, 0, line - 1, 0),
            })
            .then(undefined, () => {
              // The file could not be shown as a text document (deleted, binary, unreadable).
              // `vscode.open` reports that itself instead of this handler swallowing it.
              void vscode.commands.executeCommand('vscode.open', uri);
            });
          return;
        }
        void vscode.commands.executeCommand('vscode.open', uri);
        return;
      }
      case 'imageUrl':
        // A `read_image` viewer asked for pixels. The webview cannot read a file, so the
        // host answers with bytes; the answering itself is asynchronous, and this handler
        // is not (`SessionRuntime` calls it synchronously for most message types).
        void this.answerImageUrl(session.id, message);
        return;
      case 'killBackground':
        // Two senders, one action: a job card's ✕ posts a bare `{ id }` (resolved in the
        // tab's own session), the window-global dock posts `{ sessionId, id }` because it
        // lists every session — a task id is session-local, so the session has to travel.
        this.killBackgroundIn(
          typeof message.sessionId === 'string' && message.sessionId ? message.sessionId : session.id,
          Number(message.id),
        );
        return;
      case 'dismissBackground':
        // The dock's ✕: stop listing one job (a field on its `kind:'bg'` record, persisted
        // with the session). The card, its terminal state and its `Delivered` badge stay.
        this.dismissBackground(String(message.sessionId ?? session.id), String(message.cardNodeId ?? ''));
        return;
      case 'clearFinishedBackgrounds':
        // The dock's `Clear finished`: every finished job of the window, every session.
        this.clearFinishedBackgrounds();
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
    if (this.hopWorkTimer !== null) {
      clearTimeout(this.hopWorkTimer);
      this.hopWorkTimer = null;
    }
    this.pendingHopStarts = [];
    this.pendingReceipts = [];
    this.hopsByOrigin.clear();
    this.hopsByTarget.clear();
    if (this.bgGlobalTimer != null) {
      clearTimeout(this.bgGlobalTimer);
      this.bgGlobalTimer = null;
    }
    this.bgDismissed.clear();
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
   * The chat document. The template itself lives in `webviewShell.ts`, so the shell is one
   * module that cannot drift from itself (`npm run check:webview` pins the renderer's
   * behaviour).
   */
  private getHtml(webview: vscode.Webview): string {
    return buildChatShell(webview, { extensionUri: this.extensionUri, mediaVersion: this.mediaVersion });
  }
}
