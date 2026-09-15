import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Agent } from '../agent/agent';
import { replyLanguageName } from '../agent/languages';
import { DeepSeekClient } from '../agent/deepseek';
import { ChatMessage, ThinkingEffort } from '../agent/types';
import {
  DEFAULT_MODEL,
  contextWindowFor,
  isKnownModel,
  isTableModel,
  modelIds,
  parseModelTable,
  setModelOverrides,
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
import { defaultSessionTitle, displayLocale, l10nDiagnostics, webviewL10n } from '../i18n';
import { BackgroundHub } from './backgroundHub';
import { ChatPanel } from './ChatPanel';
import { PanelManager } from './panels';
import {
  HarnessConfig,
  RuntimeHost,
  SessionRuntime,
  SubAgentJob,
  clipDisplayItem,
  clipMessageForStorage,
} from './runtime';
import { SessionTreeItem } from './SessionsProvider';
import {
  removeTranscriptDir,
  removeTranscriptFile,
  removeTranscripts,
  sumUsage,
  writeSessionTranscript,
  writeSubAgentTranscript,
} from './transcript';
import { ControlHost, ControlResult, ControlState, WaitForFinishOptions } from '../http/controlServer';
import { beginOp, logWebviewReport, opMark, perf, setPerfSink, startLagWatch, startRepaintOp, timedSync } from '../perf';

// Model ids, context windows and image support all live in one place:
// `src/agent/models.ts` (verified against `package.json` by tools/check-models.js).
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
 * The SecretStorage entry holding the DeepSeek API key. It is **not** a setting:
 * a key in `settings.json` is plain text in a file that gets synced, diffed and
 * pasted around, so `spinney.apiKey` was retired in favour of
 * `spinney.setApiKey` → `context.secrets.store(...)`.
 */
const API_KEY_SECRET = 'spinney.apiKey';

/**
 * The last assistant text a finished turn produced (used to carry a hopped
 * session's answer back to the session that dispatched it). Reasoning-only
 * turns fall back to the reasoning text so the caller is not left with nothing.
 */
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
 * Locally persists the active model + thinking-effort selection. The two
 * `*FromSettings` fields record the `spinney.*` values that were in force
 * when the selection was stored, so a later edit of the *setting* (an explicit
 * choice too) can win over an older dropdown pick — see `loadRuntimeConfig`.
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
  /** Shared DeepSeek client; every runtime's agent + sub-agents use it. */
  private readonly client: DeepSeekClient;
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
  /** Cache-busting suffix for media URLs; changes per extension session. */  private readonly mediaVersion: string;
  readonly output: vscode.OutputChannel;
  /**
   * The persisted **default** model/effort selection, used to seed a session that
   * has no pick of its own (P4: each session's own selection lives on
   * `session.model` / `session.effort`). Kept in step with the settings by
   * `onConfigurationChanged`, and updated by `persistRuntimeConfig` whenever a tab
   * picks a value explicitly.
   */
  private defaultModel = DEFAULT_MODEL;
  private defaultThinkingEffort: ThinkingEffort = 'medium';
  /**
   * The live DeepSeek API key: the SecretStorage value when one is stored, else
   * `DEEPSEEK_API_KEY`, else ''. Written by {@link installApiKey} only, and read
   * by `getConfig()` into the shared client.
   */
  private apiKey = '';
  /** True once the "no API key" nudge was shown, so a send only nags once. */
  private missingKeyNotified = false;
  private sessions: AgentSession[] = [];
  private activeSessionId = '';
  /** The one in-flight automatic-title request (a session switch does not cancel it). */
  private titleJob: { sessionId: string; controller: AbortController } | null = null;
  /** Sessions waiting for an automatic-title pass, drained one at a time. */
  private titlePending = new Set<string>();
  /** Stopper for the host event-loop lag watch (diagnostics only). */
  private stopLagWatch: (() => void) | null = null;
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
    this.output = vscode.window.createOutputChannel('Spinney');
    setPerfSink((line) => this.output.appendLine(line));
    // Which display language the UI is in, and whether a catalog was found for it
    // (see src/i18n.ts): a non-English window without one simply stays English, and
    // this line is the only way to tell that apart from "nothing to translate".
    this.output.appendLine(l10nDiagnostics(this.extensionUri));
    // The host's own event loop is watched from here on: a stall in the extension
    // host (persist, a tree rebuild) shows up as a late timer, which no `perf()`
    // line can report while it is blocked.
    this.stopLagWatch = startLagWatch();
    // The user's model table must be installed before anything derives a model
    // list, a context window or an image capability from the catalog.
    this.applyModelTable();
    // Resolve the active model/effort before loading sessions so the restored
    // system prompt carries the correct identity.
    const runtime = this.loadRuntimeConfig();
    this.defaultModel = runtime.model;
    this.defaultThinkingEffort = runtime.thinkingEffort;
    // Snapshot AGENTS.md before building the prompts so the workspace
    // instructions are fixed for the whole session.
    this.loadAgentsMd();
    // The shared client must exist before any runtime builds its agent.
    const cfg = this.getConfig();
    this.client = new DeepSeekClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: this.defaultModel });
    // SecretStorage is asynchronous, so the key is read once here and installed
    // into that shared client a tick later; `getConfig().apiKey` reports the live
    // value from then on. Nothing can send a turn before the user types one.
    void this.loadApiKey('startup');
    // The panel manager needs only callbacks, so it can be built before the
    // sessions (runtimes post into it lazily).
    this.panels = new PanelManager({
      extensionUri: this.extensionUri,
      titleFor: (sessionId) => this.panelTitle(sessionId),
      getHtml: (webview) => this.getHtml(webview),
      onMessage: (panel, message) => this.handlePanelMessage(panel, message),
      onFocusChange: (sessionId) => this.onPanelFocus(sessionId),
      onClosed: (sessionId) => this.onPanelClosed(sessionId),
    });
    this.loadSessions();
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
    // The API key is NOT a setting: it is read from SecretStorage (or the
    // environment) by `readApiKey` and cached here — see `loadApiKey`.
    const apiKey = this.apiKey;
    const model = cfg.get<string>('model') ?? DEFAULT_MODEL;
    // A blank base URL means "use the default" rather than a relative URL.
    const baseUrl = (cfg.get<string>('baseUrl') ?? '').trim() || 'https://api.deepseek.com';
    const thinkingEffort = (cfg.get<string>('thinkingEffort') ?? 'medium') as ThinkingEffort;
    // The reply-language setting is a dropdown of VS Code language tags plus
    // `auto`; the prompt wants a language *name*, so `auto` is resolved here
    // against the display language of this window (`replyLanguageName` also maps
    // a tag to its CLDR name and falls back to English for a blank locale).
    const replyLanguage = replyLanguageName(cfg.get<string>('replyLanguage') ?? '', vscode.env.language);
    const foldToolCalls = cfg.get<boolean>('foldToolCalls') ?? true;
    const foldThinking = cfg.get<boolean>('foldThinking') ?? true;
    const maxConcurrentSubagents = cfg.get<number>('maxConcurrentSubagents') ?? 15;
    const maxLevel2Subagents = cfg.get<number>('maxLevel2Subagents') ?? 2;
    const saveSubAgentTranscripts = cfg.get<boolean>('saveSubAgentTranscripts') ?? true;
    const saveSessionTranscripts = cfg.get<boolean>('saveSessionTranscripts') ?? true;
    const subAgentTranscriptDir = (cfg.get<string>('subAgentTranscriptDir') ?? '').trim();
    const autoSessionTitles = cfg.get<boolean>('autoSessionTitles') ?? true;
    return { apiKey, model, baseUrl, thinkingEffort, replyLanguage, foldToolCalls, foldThinking, maxConcurrentSubagents, maxLevel2Subagents, saveSubAgentTranscripts, saveSessionTranscripts, subAgentTranscriptDir, autoSessionTitles };
  }

  // ---- API key (SecretStorage) ----

  /**
   * Read the key out of SecretStorage, falling back to `DEEPSEEK_API_KEY`, and
   * install it into the shared client. Called once at activation and again after
   * `spinney.setApiKey` / `spinney.clearApiKey`, so this window never needs a
   * reload to pick a key up (the client is shared, so the main agent and every
   * sub-agent use the new one on their very next request).
   */
  async loadApiKey(reason: string): Promise<void> {
    const { key, source } = await this.readApiKey();
    this.installApiKey(key);
    this.output.appendLine(
      `[config] api key (${reason}): ${key ? `loaded from ${source}` : 'missing — run "spinney.setApiKey"'}`,
    );
  }

  /**
   * Resolve the key and say where it came from. A SecretStorage read can fail
   * (a locked keyring, a headless host) — that is not fatal: the environment
   * variable is still a valid home for a key.
   */
  private async readApiKey(): Promise<{ key: string; source: 'SecretStorage' | 'DEEPSEEK_API_KEY' | 'none' }> {
    if (this.secrets) {
      try {
        const stored = ((await this.secrets.get(API_KEY_SECRET)) ?? '').trim();
        if (stored) {
          return { key: stored, source: 'SecretStorage' };
        }
      } catch (err) {
        this.output.appendLine(
          `[config] could not read the secret storage: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const env = (process.env.DEEPSEEK_API_KEY ?? '').trim();
    return env ? { key: env, source: 'DEEPSEEK_API_KEY' } : { key: '', source: 'none' };
  }

  /**
   * Install a key as the live one: cache it, hand it to the shared client (which
   * reads its options when each request is built, so the next one already uses
   * it) and let every open tab refresh its wallet readout — the key may be
   * exactly what was missing.
   */
  private installApiKey(key: string): void {
    this.apiKey = key;
    this.client.configure({ apiKey: key });
    if (!key) {
      return;
    }
    this.missingKeyNotified = true; // a nudge is pointless once a key exists
    for (const rt of this.runtimes.values()) {
      void rt.refreshBalance();
    }
  }

  /**
   * `spinney.setApiKey`: ask for the key (masked), store it in SecretStorage and
   * install it live. The value never touches `settings.json`.
   */
  async setApiKeyInteractive(): Promise<void> {
    const value = await vscode.window.showInputBox({
      prompt: vscode.l10n.t(
        'DeepSeek API key — stored in the OS-encrypted secret storage, not in settings.json.',
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
    if (!this.secrets) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t(
          'Spinney: this host has no secret storage; set the DEEPSEEK_API_KEY environment variable instead.',
        ),
      );
      return;
    }
    await this.secrets.store(API_KEY_SECRET, key);
    await this.loadApiKey('setApiKey');
    void vscode.window.showInformationMessage(vscode.l10n.t('Spinney: API key saved.'));
  }

  /** `spinney.clearApiKey`: drop the stored key (`DEEPSEEK_API_KEY` may still serve requests). */
  async clearApiKey(): Promise<void> {
    await this.secrets?.delete(API_KEY_SECRET);
    await this.loadApiKey('clearApiKey');
    void vscode.window.showInformationMessage(
      this.apiKey
        ? vscode.l10n.t('Spinney: stored API key cleared — still using the DEEPSEEK_API_KEY environment variable.')
        : vscode.l10n.t('Spinney: API key cleared.'),
    );
  }

  /**
   * The one nudge for a missing key, shown *before* a send is accepted. It is a
   * non-modal notification with a button, deliberately not awaited: a missing key
   * must never block the composer (the request itself reports the real error).
   * Shown at most once per window.
   */
  private warnMissingApiKey(): void {
    if (this.apiKey || this.missingKeyNotified) {
      return;
    }
    this.missingKeyNotified = true;
    const SET_API_KEY = vscode.l10n.t('Set API Key');
    void vscode.window
      .showWarningMessage(vscode.l10n.t('Spinney: no DeepSeek API key is configured yet.'), SET_API_KEY)
      .then((pick) => {
        if (pick === SET_API_KEY) {
          void vscode.commands.executeCommand('spinney.setApiKey');
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
   * - **base URL** is re-read into the shared `DeepSeekClient`. The main agent and
   *   every sub-agent hold that same instance, so a new base URL works on the very
   *   next request. This is deliberately applied even while a turn is running: the
   *   options are read when each request is built. The **API key** takes the same
   *   path, but it is not a setting — it is installed by `loadApiKey` (the
   *   `spinney.setApiKey` / `spinney.clearApiKey` commands), so a settings event
   *   never touches it.
   * - The **context window** and the **sub-agent pool limit** are
   *   pushed to their live owners (every runtime).
   * - **`model`** / **`thinkingEffort`** are applied only when those two keys
   *   actually changed, and then only to sessions that have **no pick of their
   *   own**: P4 makes the selection per session, so a tab's explicit dropdown pick
   *   wins over the setting (exactly like the old "dropdown pick shadows the
   *   setting" rule, read per session — a pick anchored to the *previous* setting
   *   value is retired, see `loadRuntimeConfig`). Like the dropdowns, the value is
   *   skipped while that session is running.
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
    // Re-read the model table first: it decides the recognized model list, every
    // context window and every image capability derived below.
    this.applyModelTable();
    this.client.configure({ baseUrl: cfg.baseUrl });
    const modelChanged = !event || event.affectsConfiguration('spinney.model');
    const effortChanged = !event || event.affectsConfiguration('spinney.thinkingEffort');
    // The reply language is written into the system prompt, so a change to it is
    // pushed to every live session exactly like a model/effort change — including
    // the cache-miss warning the runtime posts.
    const languageChanged = !event || event.affectsConfiguration('spinney.replyLanguage');
    if (modelChanged || effortChanged) {
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
      if (modelChanged) {
        if (rt.busy) {
          skippedBusy = true;
        } else {
          // The runtime applies it only when this session has no effective pick.
          rt.applyDefaultModel(this.defaultModel);
        }
      }
      if (effortChanged) {
        if (rt.busy) {
          skippedBusy = true;
        } else {
          // Same rule as the model: an explicit per-tab effort wins.
          rt.applyDefaultEffort(this.defaultThinkingEffort);
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
      this.output.appendLine('[config] model/thinkingEffort/replyLanguage change skipped: a turn is running');
    }
    if (!event || event.affectsConfiguration('spinney.baseUrl')) {
      // The endpoint changed: the credit line it answers comes from that host.
      for (const rt of this.runtimes.values()) {
        void rt.refreshBalance();
      }
    }
    this.output.appendLine(
      `[config] settings changed live: key=${this.apiKey ? 'set' : 'missing'} baseUrl=${cfg.baseUrl} maxSubagents=${cfg.maxConcurrentSubagents}`,
    );
  }

  getContextWindow(model: string): number {
    // A row in `spinney.modelTable` is the most specific answer there is —
    // the user asked for that model explicitly, so it beats the global fallback.
    if (!isTableModel(model)) {
      const override = vscode.workspace
        .getConfiguration('spinney')
        .get<number>('contextWindow');
      if (override && override > 0) {
        return override;
      }
    }
    return contextWindowFor(model);
  }

  /**
   * Read `spinney.modelTable`, install it as the model catalog's override
   * layer, and report what it did. Bad rows are skipped (never half-applied)
   * and written to the output channel — the setting's syntax is documented in
   * `package.json`, and silence would make a typo look like a harness bug.
   */
  private applyModelTable(): void {
    const raw = vscode.workspace.getConfiguration('spinney').get<unknown>('modelTable');
    const { specs, errors } = parseModelTable(raw);
    setModelOverrides(specs);
    this.output.appendLine(
      `[config] modelTable: ${specs.length} model(s) — ${modelIds().length} recognized in total`,
    );
    for (const spec of specs) {
      this.output.appendLine(
        `[config] modelTable: ${spec.id} vision=${spec.vision ? 'yes' : 'no'} max_tokens=${spec.contextWindow}`,
      );
    }
    for (const error of errors) {
      this.output.appendLine(`[config] modelTable: ${error}`);
    }
  }

  /**
   * Accept a model id only if the catalog (vendored + `spinney.modelTable`)
   * knows it; anything else falls back to the default and says so. A stale id in
   * settings must not silently hide images or mis-size the context indicator.
   */
  resolveModel(candidate: string): string {
    if (!candidate || isKnownModel(candidate)) {
      return candidate || DEFAULT_MODEL;
    }
    this.output.appendLine(
      `[config] unknown model "${candidate}": not in the catalog and not in spinney.modelTable — using ${DEFAULT_MODEL}`,
    );
    return DEFAULT_MODEL;
  }

  /** The system prompt the active (last-focused) session would send next. */
  systemPrompt(): string {
    const rt = this.runtimes.get(this.activeSessionId);
    return rt
      ? rt.systemPromptText()
      : Agent.systemPrompt(this.defaultModel, this.defaultThinkingEffort, this.getConfig().replyLanguage);
  }

  /**
   * The **default** model/effort: the persisted `spinney.runtimeConfig`
   * record falling back to the settings. A session's own pick is layered on top
   * of this by `effectiveModel` / `effectiveEffort` (P4) — this method only
   * answers "what would a session with no pick start from?".
   */
  private loadRuntimeConfig(): RuntimeConfig {
    const defaults = this.getConfig();
    const stored = this.readSmall<Partial<RuntimeConfig>>(CONFIG_KEY) ?? {};
    // A dropdown pick shadows the setting only while that setting is unchanged:
    // editing `spinney.model` in settings.json is an explicit choice as
    // well, so it wins over a pick made *before* the edit (a pick made after it
    // is persisted together with the new setting value and keeps winning). A
    // record without the snapshot fields predates this rule, so it is trusted.
    const picked =
      stored.model && (stored.modelFromSettings === undefined || stored.modelFromSettings === defaults.model)
        ? stored.model
        : defaults.model;
    const model = this.resolveModel(picked);
    const thinkingEffort =
      stored.thinkingEffort &&
      (stored.effortFromSettings === undefined || stored.effortFromSettings === defaults.thinkingEffort)
        ? stored.thinkingEffort
        : defaults.thinkingEffort;
    return { model, thinkingEffort };
  }

  /**
   * The model/effort a session runs with (P4): its own pick when that pick still
   * shadows the setting it was made under (`sessionModelPick`), else the persisted
   * default above — which itself falls back to the `spinney.model` /
   * `spinney.thinkingEffort` settings. Resolved here, once, and handed to the
   * runtime at construction; the runtime keeps the live value from then on and
   * writes a change back onto the session (`setModel` / `setThinkingEffort`).
   */
  private effectiveModel(session: AgentSession): string {
    const pick = sessionModelPick(session, this.getConfig().model);
    return pick ? this.resolveModel(pick) : this.defaultModel;
  }

  private effectiveEffort(session: AgentSession): ThinkingEffort {
    return sessionEffortPick(session, this.getConfig().thinkingEffort) ?? this.defaultThinkingEffort;
  }

  /**
   * Remember an explicit per-tab pick as the **default for future sessions**. P4
   * moved the live selection onto the session itself (a runtime writes
   * `session.model` / `session.effort` and persists that with the session), so
   * this memento write is only the seed for sessions created later — it never
   * touches an existing session's own choice.
   */
  persistRuntimeConfig(model: string, thinkingEffort: ThinkingEffort): void {
    this.defaultModel = model;
    this.defaultThinkingEffort = thinkingEffort;
    const cfg = this.getConfig();
    void this.writeSmall(CONFIG_KEY, {
      model,
      thinkingEffort,
      modelFromSettings: cfg.model,
      effortFromSettings: cfg.thinkingEffort,
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
      // Building a runtime seeds the view-derived counters from the stored tree, so
      // the first switch to a session that has never run in this window pays for it.
      rt = timedSync(
        'runtime-create',
        () =>
          new SessionRuntime(
            this,
            session,
            this.client,
            this.effectiveModel(session),
            this.effectiveEffort(session),
            this.backgroundHub,
          ),
        `session=${session.id} nodes=${Object.keys(session.nodes).length}`,
      );
      this.runtimes.set(session.id, rt);
      this.notifyStateChanged();
    }
    return rt;
  }

  // ---- Session management ----

  private loadSessions(): void {
    const t0 = Date.now();
    const rawState = this.storage.get<unknown>(STORAGE_KEY);
    const { activeSessionId, sessions, migrated } = migrateState(rawState);
    // migrateState/normalizeTreeSession already prune every session (drop the
    // stale system prompt, downgrade a turn that was still running, unlink
    // dangling children), so the loaded tree is always API-valid on activation.
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
    // The pointer lives in its own key; the blob's field is the pre-split fallback.
    const remembered = this.readSmall<string>(ACTIVE_SESSION_KEY);
    const wanted = typeof remembered === 'string' && remembered ? remembered : activeSessionId;
    const active = this.sessions.find((s) => s.id === wanted);
    this.activeSessionId = active ? active.id : this.sessions[0].id;
    const nodes = this.sessions.reduce((n, s) => n + Object.keys(s.nodes).length, 0);
    perf(
      () =>
        `load-sessions ${Date.now() - t0}ms sessions=${this.sessions.length} nodes=${nodes}` +
        (migrated ? ' migrated=v1' : ''),
    );
    this.persistActiveSession();
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
    const clipMsg = (msg: ChatMessage): ChatMessage => {
      const clipped = clipMessageForStorage(msg);
      addText(clipped.reasoning_content);
      if (typeof clipped.content === 'string') {
        addText(clipped.content);
      } else if (Array.isArray(clipped.content)) {
        for (const part of clipped.content as { text?: string; image_url?: { url?: string } }[]) {
          addText(part.text);
          addText(part.image_url?.url);
        }
      }
      for (const call of clipped.tool_calls ?? []) {
        addText(call.function?.arguments);
      }
      return clipped;
    };
    const payload: StoredState = {
      version: STORED_STATE_VERSION,
      activeSessionId: this.activeSessionId,
      sessions: this.sessions.map((s) => {
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
                  messages: node.messages.map(clipMsg),
                },
              ];
            }),
          ),
        };
      }),
    };
    const session = this.getActiveSession();
    const nodeCount = session ? Object.keys(session.nodes).length : 0;
    const msgCount = session ? pathMessages(session, session.activeNodeId).length : 0;
    const items = session
      ? session.activeNodeId
        ? session.nodes[session.activeNodeId]?.displayItems.length ?? 0
        : session.orphanItems.length
      : 0;
    const extra =
      `sessions=${this.sessions.length} nodes=${nodeCount} items=${items} msgs=${msgCount}` +
      (coalesced > 1 ? ` coalesced=${coalesced}` : '');
    const pending = this.storage.update(STORAGE_KEY, payload);
    // The control plane awaits these before handing over to a reboot, so a kill
    // right after a turn cannot lose the last write.
    this.trackWrite(pending);
    // Keep the pointer key in step with the blob (it is the one the next
    // activation reads first) — cheap, and it never writes the same value twice.
    this.persistActiveSession();
    perf(() => `persist-queued ${Date.now() - t0}ms ${extra} chars≈${chars}`);
    void pending.then(
      () => perf(() => `persist-done ${Date.now() - t0}ms ${extra} chars≈${chars}`),
      (err: unknown) =>
        perf(() => `persist-fail ${Date.now() - t0}ms ${extra} ${err instanceof Error ? err.message : String(err)}`),
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
        const runningBg = rt ? rt.hasRunningBackground() : false;
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
      rootId: null,
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
    try {
      const { text, usage } = await this.client.complete({
        messages: buildTitleMessages(digest, session.title),
        model: this.defaultModel,
        maxTokens: TITLE_MAX_TOKENS,
        temperature: 0.3,
        signal: controller.signal,
      });
      title = sanitizeTitle(text, '');
      if (usage) {
        this.outputLog(`[title] ${session.id} model=${this.defaultModel} tokens=${usage.total_tokens}`);
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
    try {
      const { text, usage } = await this.client.complete({
        messages: buildBatchTitleMessages(entries),
        model: this.defaultModel,
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
        model: this.runtimes.get(session.id)?.model ?? this.defaultModel,
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
        model: node.agentModel || this.runtimes.get(session.id)?.model || this.defaultModel,
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
      model: this.runtimes.get(session.id)?.model ?? this.defaultModel,
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
        model: job.spec.model || job.node.agentModel || this.runtimes.get(sessionId)?.model || this.defaultModel,
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

  /** First line of a turn's answer, used as a collapsed-card / transcript summary. */
  private summaryPreview(node: TreeNode): string {
    for (let i = node.displayItems.length - 1; i >= 0; i--) {
      const item = node.displayItems[i];
      if (item.kind === 'assistant' && item.text) {
        return item.text.split('\n')[0].trim().slice(0, 120);
      }
    }
    return node.title.slice(0, 80);
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
    if (rt.hasRunningBackground()) {
      return 'Error: a background terminal is still running in this session; finish or kill it before hopping.';
    }
    const returnNodeId = typeof args.returnNodeId === 'string' ? args.returnNodeId.trim() : '';
    if (returnNodeId && !session.nodes[returnNodeId]) {
      return `Error: no such node in this session: ${returnNodeId} (use list_nodes to see the tree).`;
    }
    const title = typeof args.title === 'string' ? args.title.trim().slice(0, 80) : '';
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
    const clipped = answer.length > 8000 ? `${answer.slice(0, 8000)}\n…[truncated]` : answer;
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
      if (rt.isRunning() || rt.runningSubAgentCount() > 0 || rt.hasRunningBackground()) {
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
      if (rt.hasRunningBackground()) {
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
  }

  /** Route a message to the panel's session's runtime. */
  postTo(sessionId: string, message: unknown): void {
    this.panels.get(sessionId)?.post(message);
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
    this.output.appendLine(line);
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
          // P4: the per-session model/effort, straight off the session's runtime
          // (an unloaded session reports the selection it would start from).
          model: rt ? rt.model : this.effectiveModel(s),
          effort: rt ? rt.thinkingEffort : this.effectiveEffort(s),
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
    // supervisor) may kill or reload this window.
    await this.flushPersist();
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
    const nodeId = opts.nodeId ?? session.activeNodeId ?? session.rootId;
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
    const prompt = (opts.prompt ?? '').trim();
    if (opts.sessionId) {
      const session = this.sessions.find((s) => s.id === opts.sessionId);
      if (!session) {
        return { ok: false, error: `no such session: ${opts.sessionId}` };
      }
      const rt = this.runtimeFor(session);
      // P3: node-scoped — the session may be streaming on another branch while the
      // target node is free. Only a live run on the target node refuses.
      const targetNode = opts.nodeId ?? session.activeNodeId ?? session.rootId;
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
    void this.flushPersist().finally(() => {
      setTimeout(() => {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }, 400);
    });
    return { ok: true };
  }

  // ---- Webview routing ----

  /**
   * Send a user message into a runtime. The reboot hold is the one provider-level
   * gate that must still apply to every webview-originated send.
   */
  private async dispatchUserMessage(rt: SessionRuntime, text: string, attachments: UserAttachment[]): Promise<void> {
    if (this.isHeld()) {
      rt.postNotice(
        'warning',
        vscode.l10n.t('An external controller is rebooting the window; please wait a moment.'),
      );
      return;
    }
    // A send is the moment a key matters: nudge once (never block — the request
    // itself reports the real error).
    this.warnMissingApiKey();
    await rt.onUserMessage(text, attachments);
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
    const session = this.sessions.find((s) => s.id === panel.sessionId);
    if (!session) {
      return;
    }
    // The webview's half of a traced operation (its render timings) is pure
    // diagnostics: answer it *before* `runtimeFor`, which would build a whole
    // session runtime just to log a line.
    if (message?.type === 'perfDiag') {
      logWebviewReport(`session=${session.id}`, message);
      return;
    }
    if (message?.type === 'ready') {
      // The tab is repainting itself. Open (or join) the op for **this** session
      // before its runtime is built, so `runtime-create` and the repaint marks land
      // on the tab's own operation rather than on whichever other tab is repainting
      // right now (a window reload restores every tab at once).
      startRepaintOp('panel-repaint', session.id);
    }
    const rt = this.runtimeFor(session);
    switch (message?.type) {
      case 'ready':
        // Order matters: the tab is up (release it), then the single full repaint,
        // then whatever was held before it (e.g. deltas of a turn that started while
        // this tab was still loading its scripts). The age says whether a cold
        // switch's cost is ours (host work) or the browser's (loading main.js,
        // markdown-it, tree.js and the layout engine) — nothing else reports that.
        perf(() => `webview-ready session=${session.id} +${panel.ageMs()}ms`);
        panel.markReady();
        rt.postAllState();
        panel.flushHeld();
        return;
      case 'loadAgentItems':
        // A sub-agent card was expanded: its transcript was deliberately left out of
        // the `tree` message (see `SessionRuntime.postTree`).
        rt.onAgentItems(String(message.id ?? ''));
        return;
      case 'userMessage':
        return this.dispatchUserMessage(rt, String(message.text ?? ''), message.attachments ?? []);
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
        const work = rt.lockedWorkCount(id);
        if (work <= 0) {
          void rt.rolloverContext(id);
          return;
        }
        void this.confirmKillBackgrounds(
          vscode.l10n.t('{0} piece(s) of work are still running here (background terminals and sub-agents). Continuing in a new window stops them; what they produced stays in the transcript.', work),
          vscode.l10n.t('Continue and stop them'),
          vscode.l10n.t('Work is still running in this window.'),
        ).then((ok) => {
          if (ok) {
            void rt.rolloverContext(id);
          }
        });
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
        rt.setModel(String(message.model ?? ''));
        return;
      case 'setThinkingEffort':
        rt.setThinkingEffort(String(message.effort ?? 'none') as ThinkingEffort);
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
    } catch {
      /* best effort: a failing write must not block teardown */
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
    setPerfSink(null);
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
  }

  private getHtml(webview: vscode.Webview): string {
    // A cache-busting version suffix so the webview re-fetches media files when
    // they change (asWebviewUri does not change with file content).
    const v = this.mediaVersion;
    const withV = (uri: string) => `${uri}${uri.includes('?') ? '&' : '?'}v=${v}`;
    const scriptUri = withV(String(webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js'))));
    const markdownItUri = withV(String(webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'vendor', 'markdown-it', 'markdown-it.min.js'))));
    const treeUri = withV(String(webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'tree.js'))));
    // Vendored, pinned tree-layout engine (non-layered-tidy-tree-layout@2.0.2, MIT).
    // Not an npm dependency — see media/vendor/non-layered-tidy-tree-layout/PROVENANCE.md.
    const layoutEngineUri = withV(String(webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'vendor', 'non-layered-tidy-tree-layout', 'dist', 'non-layered-tidy-tree-layout.js'))));
    const styleUri = withV(String(webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'style.css'))));
    const nonce = this.getNonce();
    // The webview has no `vscode.l10n`, so it gets the whole catalog as one
    // inline dictionary and looks strings up itself (media/main.js `tr()`). The
    // shell below is host-rendered and asks `vscode.l10n` directly — the same key,
    // one catalog file (see src/i18n.ts).
    const l10n = JSON.stringify(webviewL10n(this.extensionUri)).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="${displayLocale()}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}';" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Spinney</title>
  <script nonce="${nonce}">window.__spinneyL10n = ${l10n};</script>
</head>
<body>
  <div id="tree-toolbar">
    <button id="follow-btn" class="active" title="${vscode.l10n.t('Follow the active node')}">⦿</button>
    <button id="fit-btn" title="${vscode.l10n.t('Fit the tree to view')}">⤢</button>
  </div>
  <div id="tree-wrap">
    <div id="tree-canvas">
      <svg id="tree-edges"></svg>
    </div>
  </div>
  <div id="composer">
    <div id="branch-banner" class="hidden"></div>
    <div id="attachments"></div>
    <div id="composer-row">
      <textarea id="input" placeholder="${vscode.l10n.t('Ask the agent… (Enter to send, Shift+Enter for newline)')}" rows="1" spellcheck="false" autocorrect="off" autocapitalize="off" autocomplete="off"></textarea>
      <div id="composer-controls">
        <button id="attach-btn" class="icon-btn" title="${vscode.l10n.t('Attach image')}" aria-label="${vscode.l10n.t('Attach image')}">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <select id="model-select" title="${vscode.l10n.t('Model')}"></select>
        <select id="effort-select" title="${vscode.l10n.t('Thinking effort')}">
          <option value="none">${vscode.l10n.t('none')}</option>
          <option value="low">${vscode.l10n.t('low')}</option>
          <option value="medium">${vscode.l10n.t('medium')}</option>
          <option value="high">${vscode.l10n.t('high')}</option>
        </select>
        <div id="actions">
          <button id="stop-btn" class="hidden">${vscode.l10n.t('Stop')}</button>
          <button id="send-btn">${vscode.l10n.t('Send')}</button>
        </div>
      </div>
    </div>
    <div id="meter-row-readout" title="${vscode.l10n.t('Session prompt-cache hit rate + wallet')}">
      <span id="status-dot" class="dot idle"></span>
      <span id="status-text"></span>
      <span id="metrics">
        <span id="context" title="${vscode.l10n.t('Context window usage')}">
          <span id="context-label">ctx 0%</span>
        </span>
        <span id="stat-balance">bal –</span>
        <span id="tps-meter" title="${vscode.l10n.t('Token generation rate (realtime estimate)')}">
          <span id="tps-value">0</span>
          <span id="tps-unit">tok/s</span>
        </span>
      </span>
    </div>
  </div>
  <script nonce="${nonce}" src="${markdownItUri}"></script>
  <script nonce="${nonce}" src="${layoutEngineUri}"></script>
  <script nonce="${nonce}" src="${treeUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
