import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Agent } from '../agent/agent';
import { DeepSeekClient, DeepSeekBalance } from '../agent/deepseek';
import { AgentEvent, ChatMessage, ContentPart, ThinkingEffort, Usage } from '../agent/types';
import { DEFAULT_MODEL, contextWindowFor, isKnownModel, isVisionModel, visionModelsLabel } from '../agent/models';
import {
  AgentSession,
  DisplayItem,
  StoredState,
  STORED_STATE_VERSION,
  TitleSource,
  TreeNode,
  TurnStatus,
  UserAttachment,
  attachNode,
  branchIds,
  createNode,
  detachBranch,
  migrateState,
  messageText,
  newId,
  nodeUsage,
  pathIds,
  pathMessages,
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
import { getWorkspaceRoot, resolvePath, ToolRegistry } from '../tools';
import { BackgroundRegistry, BackgroundTask } from '../tools/background';
import { ChatPanel } from './ChatPanel';
import { SessionTreeItem } from './SessionsProvider';
import { SubAgentPool } from './SubAgentPool';
import {
  removeTranscriptDir,
  removeTranscriptFile,
  removeTranscripts,
  sumUsage,
  summarizeTranscript,
  writeSessionTranscript,
  writeSubAgentTranscript,
} from './transcript';
import { ControlHost, ControlResult, ControlState, WaitForFinishOptions } from '../http/controlServer';
import { perf, setPerfSink } from '../perf';

// Model ids, context windows and image support all live in one place:
// `src/agent/models.ts` (verified against `package.json` by tools/check-models.js).
const STORAGE_KEY = 'agentHarness.state';
/** One-shot marker for the historical-transcript backfill (see `backfillTranscripts`). */
const TRANSCRIPT_BACKFILL_KEY = 'agentHarness.transcriptBackfill';
const TRANSCRIPT_BACKFILL_VERSION = 'v1';
/** One-shot marker for the historical session-title backfill (see `backfillSessionTitles`). */
const TITLE_BACKFILL_KEY = 'agentHarness.sessionTitleBackfill';
const TITLE_BACKFILL_VERSION = 'v1';
/** How long one title completion may take before falling back to the heuristic. */
const TITLE_REQUEST_TIMEOUT_MS = 25_000;
/** Give up a backfill pass after this long; the marker stays unset so it resumes. */
const TITLE_BACKFILL_DEADLINE_MS = 10 * 60 * 1000;
/** One-shot copy of the pre-tree (v1) state, written before the first migration. */
const STORAGE_BACKUP_KEY = 'agentHarness.state.v1backup';
const CONFIG_KEY = 'agentHarness.runtimeConfig';
/** Cap tool output stored/shown in the webview so a 16 MiB command dump cannot freeze the UI. */
const UI_TOOL_CONTENT_CAP = 32 * 1024;

function clipForUi(text: string, cap = UI_TOOL_CONTENT_CAP): string {
  if (text.length <= cap) {
    return text;
  }
  return `${text.slice(0, cap)}\n…[truncated ${text.length - cap} chars for UI]`;
}

/** Shrink tool cards in the UI transcript; agent `messages` keep the full tool payload. */
function clipDisplayItem(item: DisplayItem): DisplayItem {
  if (item.kind === 'tool') {
    const args = item.args ? clipForUi(item.args, 8 * 1024) : item.args;
    const content = item.content ? clipForUi(item.content) : item.content;
    if (args === item.args && content === item.content) {
      return item;
    }
    return { ...item, args, content };
  }
  if (item.kind === 'assistant' && item.thinking && item.thinking.length > 64 * 1024) {
    return { ...item, thinking: clipForUi(item.thinking, 64 * 1024) };
  }
  return item;
}

/**
 * Cap a single message's content in the *persisted* copy. The in-memory history
 * keeps the full payload; only what goes into `vscode.Memento` is bounded, so one
 * huge tool result cannot make every `persist()` write tens of MiB.
 */
const STORAGE_MESSAGE_CAP = 64 * 1024;

function clipMessageForStorage(msg: ChatMessage): ChatMessage {
  if (typeof msg.content === 'string' && msg.content.length > STORAGE_MESSAGE_CAP) {
    return { ...msg, content: clipForUi(msg.content, STORAGE_MESSAGE_CAP) };
  }
  return msg;
}

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

/** Locally persists the active model + thinking-effort selection. */
interface RuntimeConfig {
  model: string;
  thinkingEffort: ThinkingEffort;
}

/** One sub-agent run: its dispatch spec plus the tree node that owns it. */
interface SubAgentJob {
  spec: { instruction: string; write: boolean; model?: string };
  node: TreeNode;
  resume?: boolean;
  /** Session the node belongs to (for the transcript folder; falls back to active). */
  sessionId?: string;
}

/** A background terminal summarized for the webview UI. */
interface BackgroundInfo {
  id: number;
  command: string;
  status: 'running' | 'finished';
  exitCode: number | null;
  killed: boolean;
  elapsed: number;
  truncated: boolean;
  outputTail: string;
  /** True when the job finished but the agent has not yet been notified. */
  pendingDelivery: boolean;
}

/** A queued background-completion notification waiting for the agent to go idle. */
interface BackgroundNotice {
  sessionId: string;
  text: string;
  /** The background-terminal id, used to drop a notice the agent already handled via join/kill. */
  taskId: number;
  /** Card fields: task id, command, status phrase, and output tail. */
  id: number;
  cmd: string;
  doneText: string;
  output: string;
}

/** Decode the base64 payload of a `data:<mime>;base64,<data>` URL into bytes. */
function dataUrlBytes(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Buffer.from(base64, 'base64');
}

export class ChatViewProvider implements ControlHost {
  /** The chat is rendered in an editor panel (P1). A single panel for now; the
   * multi-panel mouth is a list of ChatPanel keyed by sessionId. */
  private panel: ChatPanel | null = null;
  /** Fired when the sidebar's session list should re-read its items. */
  onStateChanged?: () => void;

  private agent!: Agent;
  private client!: DeepSeekClient;
  private tools!: ToolRegistry;
  /** Last `storage.update` write; the control plane awaits it before a reboot. */
  private lastPersist: Promise<void> = Promise.resolve();
  /** While `Date.now() < controlHoldUntil` an external controller is rebooting. */
  private controlHoldUntil = 0;
  private displayItems: DisplayItem[] = [];
  /** The turn node currently being produced (null while the agent is idle). */
  private activeTurnNode: TreeNode | null = null;
  /** Length of the flat path before the current turn; the turn's messages are sliced from it. */
  private turnPrefixLen = 0;
  /** Node whose turn was interrupted last; a branch switch drops the pending notice. */
  private lastInterruptedNodeId: string | null = null;
  private busy = false;
  /** Per-session background-terminal registries (one per conversation). */
  private sessionRegistries = new Map<string, BackgroundRegistry>();
  /** Background-completion notifications waiting for the agent to go idle. */
  private backgroundNotifQueue: BackgroundNotice[] = [];
  /** Set when the provider is being torn down; suppresses background notifications. */
  private disposed = false;
  /** Aborts an in-flight image upload (attachment path) when the user stops. */
  private uploadController: AbortController | null = null;
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
  private lastStatus = '';
  /** Cache-busting suffix for media URLs; changes per extension session. */
  private readonly mediaVersion: string;
  private readonly output: vscode.OutputChannel;
  private model = DEFAULT_MODEL;
  private thinkingEffort: ThinkingEffort = 'none';
  private contextWindow = contextWindowFor(DEFAULT_MODEL);
  private currentPromptTokens = 0;
  private sessions: AgentSession[] = [];
  private activeSessionId = '';
  /** Coalesced stream fragments waiting to be posted to the webview. */
  private pendingTextDelta = '';
  private pendingThinkingDelta = '';
  private pendingToolDeltas = new Map<number, { id?: string; name: string; args: string }>();
  private streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private bgFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Coalesces idle background-notice delivery so a burst of finishes batches into one turn. */
  private backgroundDrainTimer: ReturnType<typeof setTimeout> | null = null;
  private streamFlushCount = 0;
  private streamFlushBytes = 0;
  private streamFlushWindow = 0;
  /** Concurrency pool for the main agent's level-1 sub-agents (set per session). */
  private subAgentPool: SubAgentPool | null = null;
  /** Per-parent count of level-2 sub-agents spawned (budgeted by maxLevel2Subagents). */
  private level2Counts = new Map<string, number>();
  /** Running sub-agents: agentNodeId -> { agent, abort } for individual kill. */
  private runningSubAgents = new Map<string, { agent: Agent; abort: AbortController }>();
  /** Sub-agent completion notifications queued for the parent (async mode). */
  private subAgentNoticeQueue: Array<{ nodeId: string; summary: string; status: string; count?: number }> = [];
  /** Async depth-2 results queued for a still-running sub-agent parent, resumed on its finish. */
  private subAgentChildNotices = new Map<string, Array<{ message: string }>>();
  private lastSubAgentDrain: ReturnType<typeof setTimeout> | null = null;
  /** The one in-flight automatic-title request (a session switch does not cancel it). */
  private titleJob: { sessionId: string; controller: AbortController } | null = null;
  /** Sessions waiting for an automatic-title pass, drained one at a time. */
  private titlePending = new Set<string>();
  private titleDrainTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly storage: vscode.Memento,
    private readonly globalStorage?: vscode.Uri,
  ) {
    this.mediaVersion = Date.now().toString(36);
    this.output = vscode.window.createOutputChannel('Agent Harness');
    setPerfSink((line) => this.output.appendLine(line));
    // Resolve the active model/effort before loading sessions so the restored
    // system prompt carries the correct identity.
    const runtime = this.loadRuntimeConfig();
    this.model = runtime.model;
    this.thinkingEffort = runtime.thinkingEffort;
    // Snapshot AGENTS.md before building the prompt so the workspace
    // instructions are fixed for the whole session.
    this.loadAgentsMd();
    this.loadSessions();
    this.buildAgent();
    const active = this.getActiveSession();
    if (active) {
      this.activateSession(active);
    }
    this.scheduleTranscriptBackfill();
    this.scheduleTitleBackfill();
  }

  private getConfig(): {
    apiKey: string;
    model: string;
    baseUrl: string;
    maxTurns: number;
    thinkingEffort: ThinkingEffort;
    foldToolCalls: boolean;
    foldThinking: boolean;
    maxConcurrentSubagents: number;
    maxLevel2Subagents: number;
    saveSubAgentTranscripts: boolean;
    saveSessionTranscripts: boolean;
    subAgentTranscriptDir: string;
    autoSessionTitles: boolean;
  } {
    const cfg = vscode.workspace.getConfiguration('agentHarness');
    const apiKey = (cfg.get<string>('apiKey') ?? '').trim() || (process.env.DEEPSEEK_API_KEY ?? '').trim();
    const model = cfg.get<string>('model') ?? DEFAULT_MODEL;
    const baseUrl = cfg.get<string>('baseUrl') ?? 'https://api.deepseek.com';
    const maxTurns = cfg.get<number>('maxTurns') ?? 20;
    const thinkingEffort = (cfg.get<string>('thinkingEffort') ?? 'none') as ThinkingEffort;
    const foldToolCalls = cfg.get<boolean>('foldToolCalls') ?? true;
    const foldThinking = cfg.get<boolean>('foldThinking') ?? true;
    const maxConcurrentSubagents = cfg.get<number>('maxConcurrentSubagents') ?? 15;
    const maxLevel2Subagents = cfg.get<number>('maxLevel2Subagents') ?? 2;
    const saveSubAgentTranscripts = cfg.get<boolean>('saveSubAgentTranscripts') ?? true;
    const saveSessionTranscripts = cfg.get<boolean>('saveSessionTranscripts') ?? true;
    const subAgentTranscriptDir = (cfg.get<string>('subAgentTranscriptDir') ?? '').trim();
    const autoSessionTitles = cfg.get<boolean>('autoSessionTitles') ?? true;
    return { apiKey, model, baseUrl, maxTurns, thinkingEffort, foldToolCalls, foldThinking, maxConcurrentSubagents, maxLevel2Subagents, saveSubAgentTranscripts, saveSessionTranscripts, subAgentTranscriptDir, autoSessionTitles };
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

  private buildAgent(): void {
    const { apiKey, baseUrl, maxTurns } = this.getConfig();
    // Model and effort were already resolved (incl. runtime persistence) in the
    // constructor; apply them here so the client and agent are in sync.
    this.contextWindow = this.getContextWindow(this.model);
    this.client = new DeepSeekClient({ apiKey, baseUrl, model: this.model });
    this.tools = new ToolRegistry();
    // `search_transcripts` reads the harness's own transcript dumps; the roots
    // depend on config + global storage, so hand it a live resolver.
    this.tools.setTranscriptRoots(() => [this.transcriptRoot()]);
    this.agent = new Agent(this.client, this.tools, (event) => this.handleAgentEvent(event), maxTurns);
    this.agent.setModel(this.model);
    this.agent.setThinkingEffort(this.thinkingEffort);
    // The main agent can spawn sub-agents: hand it the provider's orchestrator.
    this.agent.setSpawnHandler((args, signal) => this.handleSpawnAgents(args, signal));
    // And it can resume a finished sub-agent with a follow-up message.
    this.agent.setSendMessageHandler((args, signal) => this.handleSendAgentMessage(args, signal));
    // And it can hand a self-contained task to a fresh session, which reports
    // its answer back here (only the main agent may do this).
    this.agent.setCanHop(true);
    this.agent.setHopHandler((args) => Promise.resolve(this.handleHopSession(args)));
    this.agent.setListNodeHandler(() => Promise.resolve(this.handleListNodes()));
    // And it can rename the session (an explicit rename locks the title, so the
    // automatic namer leaves it alone).
    this.agent.setRenameSessionHandler((args) => Promise.resolve(this.handleRenameSession(args)));
  }

  private getContextWindow(model: string): number {
    const override = vscode.workspace
      .getConfiguration('agentHarness')
      .get<number>('contextWindow');
    if (override && override > 0) {
      return override;
    }
    return contextWindowFor(model);
  }

  /** Prompt size of the checked-out branch, taken from its latest turn's usage. */
  private getLatestPromptTokens(): number {
    const items = this.activePathItems();
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.usage && typeof item.usage.prompt_tokens === 'number') {
        return item.usage.prompt_tokens;
      }
    }
    return 0;
  }

  private postContext(): void {
    this.post({
      type: 'context',
      used: this.currentPromptTokens,
      total: this.contextWindow,
      model: this.model,
    });
  }

  /** Token totals for the checked-out branch, derived from each turn's usage. */
  private computeSessionStats(): {
    totalTokens: number;
    cacheHit: number;
    cacheMiss: number;
    cacheHitRate: number;
    cacheKnown: boolean;
  } {
    let totalTokens = 0;
    let cacheHit = 0;
    let cacheMiss = 0;
    for (const item of this.activePathItems()) {
      if (!item.usage) continue;
      totalTokens += item.usage.total_tokens || 0;
      cacheHit += item.usage.prompt_cache_hit_tokens || 0;
      cacheMiss += item.usage.prompt_cache_miss_tokens || 0;
    }
    const denom = cacheHit + cacheMiss;
    const cacheKnown = denom > 0;
    const cacheHitRate = cacheKnown ? (cacheHit / denom) * 100 : 0;
    return { totalTokens, cacheHit, cacheMiss, cacheHitRate, cacheKnown };
  }

  private postSessionStats(): void {
    this.post({ type: 'sessionStats', stats: this.computeSessionStats() });
  }

  /**
   * Fetch the account's wallet balance and push it to the webview. Best-effort:
   * on failure (no key / network / off-API scope) we log to the output channel
   * and leave whatever balance the UI already shows (falling back to "–"). This
   * is account-level, so it is the same across sessions and is refreshed at the
   * start and after each turn so the displayed credit stays current.
   */
  private async refreshBalance(): Promise<void> {
    try {
      const balance: DeepSeekBalance = await this.client.getBalance();
      this.post({ type: 'balance', balance });
    } catch (err) {
      this.output.appendLine(`[balance] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private postConfig(): void {
    const cfg = this.getConfig();
    this.post({
      type: 'config',
      model: this.model,
      thinkingEffort: this.thinkingEffort,
      foldToolCalls: cfg.foldToolCalls,
      foldThinking: cfg.foldThinking,
    });
  }

  /** Effective model/effort = persisted runtime selection, falling back to settings. */
  private loadRuntimeConfig(): RuntimeConfig {
    const defaults = this.getConfig();
    const stored = this.storage.get<Partial<RuntimeConfig>>(CONFIG_KEY) ?? {};
    return {
      model: stored.model ?? defaults.model,
      thinkingEffort: stored.thinkingEffort ?? defaults.thinkingEffort,
    };
  }

  private persistRuntimeConfig(): void {
    void this.storage.update(CONFIG_KEY, {
      model: this.model,
      thinkingEffort: this.thinkingEffort,
    } satisfies RuntimeConfig);
  }

  /** True if the checked-out branch has any conversation beyond the system prompt. */
  private hasHistory(): boolean {
    return this.activePathItems().length > 0;
  }

  /** True if the checked-out branch's history carries any image content blocks. */
  private activeSessionHasImages(): boolean {
    const session = this.getActiveSession();
    if (!session) {
      return false;
    }
    return pathMessages(session, session.activeNodeId).some(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        m.content.some((p) => p.type === 'image_url' || p.type === 'file'),
    );
  }

  private postNotice(kind: 'warning' | 'info', text: string): void {
    this.pushItem({ kind: 'notice', noticeKind: kind, text });
    this.post({ type: 'notice', kind, text });
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
    if (migrated && rawState) {
      // The tree format is not readable by the pre-tree build, so keep a copy of
      // the original state before the first write in the new format.
      void this.storage.update(STORAGE_BACKUP_KEY, rawState);
      this.output.appendLine(`[migrate] pre-tree state backed up to ${STORAGE_BACKUP_KEY}`);
    }
    if (this.sessions.length === 0) {
      this.createSessionInMemory();
    }
    const active = this.sessions.find((s) => s.id === activeSessionId);
    this.activeSessionId = active ? active.id : this.sessions[0].id;
    // Ensure a background-terminal registry exists for every session.
    for (const s of this.sessions) {
      this.createRegistryForSession(s.id);
    }
    const nodes = this.sessions.reduce((n, s) => n + Object.keys(s.nodes).length, 0);
    perf(
      () =>
        `load-sessions ${Date.now() - t0}ms sessions=${this.sessions.length} nodes=${nodes}` +
        (migrated ? ' migrated=v1' : ''),
    );
    // Persist the (possibly migrated/healed) state so a resumed session is always valid.
    this.persist();
  }

  private persist(): void {
    const t0 = Date.now();
    const payload: StoredState = {
      version: STORED_STATE_VERSION,
      activeSessionId: this.activeSessionId,
      sessions: this.sessions.map((s) => ({
        ...s,
        orphanItems: s.orphanItems.map(clipDisplayItem),
        nodes: Object.fromEntries(
          Object.entries(s.nodes).map(([id, node]): [string, TreeNode] => [
            id,
            {
              ...node,
              displayItems: node.displayItems.map(clipDisplayItem),
              messages: node.messages.map(clipMessageForStorage),
            },
          ]),
        ),
      })),
    };
    const session = this.getActiveSession();
    const nodeCount = session ? Object.keys(session.nodes).length : 0;
    const msgCount = session ? pathMessages(session, session.activeNodeId).length : 0;
    const extra =
      `sessions=${this.sessions.length} nodes=${nodeCount} items=${this.displayItems.length} msgs=${msgCount}`;
    const pending = this.storage.update(STORAGE_KEY, payload);
    // The control plane awaits this before handing over to a reboot, so a kill
    // right after a turn cannot lose the last write.
    this.lastPersist = Promise.resolve(pending).then(
      () => undefined,
      () => undefined,
    );
    perf(() => `persist-queued ${Date.now() - t0}ms ${extra}`);
    void pending.then(
      () => perf(() => `persist-done ${Date.now() - t0}ms ${extra}`),
      (err: unknown) =>
        perf(() => `persist-fail ${Date.now() - t0}ms ${extra} ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  /** The session currently shown in the (single) panel. */
  get currentSessionId(): string {
    return this.activeSessionId;
  }

  private getActiveSession(): AgentSession | undefined {
    return this.sessions.find((s) => s.id === this.activeSessionId);
  }

  /** Sidebar rows: one per session, newest update first. */
  getSessionTreeItems(): SessionTreeItem[] {
    return this.sessions
      .map((s) => {
        const reg = this.sessionRegistries.get(s.id);
        const runningBg = reg ? reg.runningCount() > 0 : false;
        return {
          id: s.id,
          title: s.title,
          updatedAt: s.updatedAt,
          nodeCount: Object.keys(s.nodes).length,
          active: s.id === this.activeSessionId,
          busy: (s.id === this.activeSessionId ? this.busy : false) || runningBg,
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private createSessionInMemory(): AgentSession {
    const session: AgentSession = {
      id: newId(),
      title: 'New session',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      nodes: {},
      rootId: null,
      activeNodeId: null,
      orphanItems: [],
    };
    this.sessions.push(session);
    this.createRegistryForSession(session.id);
    this.activeSessionId = session.id;
    return session;
  }

  /**
   * Create (or return the existing) background-terminal registry for a session,
   * wiring the UI-refresh and completion-notification callbacks.
   */
  private createRegistryForSession(sessionId: string): BackgroundRegistry {
    const existing = this.sessionRegistries.get(sessionId);
    if (existing) {
      return existing;
    }
    const reg = new BackgroundRegistry();
    reg.setOnUpdated(() => {
      if (sessionId === this.activeSessionId) {
        this.postBackgrounds();
      }
    });
    reg.setOnFinish((task) => this.onBackgroundFinished(sessionId, task));
    this.sessionRegistries.set(sessionId, reg);
    return reg;
  }

  private activateSession(session: AgentSession): void {
    this.activeSessionId = session.id;
    this.uploadController = null;
    this.activeTurnNode = null;
    this.turnPrefixLen = 0;
    // A different conversation: any pending interruption notice belongs to the
    // session we just left.
    this.lastInterruptedNodeId = null;
    this.agent.resetInterruptState();
    // A fresh sub-agent pool + budget for the newly active session.
    this.subAgentPool = new SubAgentPool(this.getConfig().maxConcurrentSubagents);
    this.level2Counts.clear();
    this.subAgentNoticeQueue.length = 0;
    this.subAgentChildNotices.clear();
    // Point the agent history and the transcript pointer at the checked-out node.
    this.checkoutNode(session, session.activeNodeId);
    // Point the tool registry at this session's background registry so
    // exec_command and the background tools read the right one.
    this.tools.setBackgroundRegistry(this.createRegistryForSession(session.id));
    this.currentPromptTokens = this.getLatestPromptTokens();
    this.setBusy(false);
    this.lastStatus = '';
    // The webview is repainted by the caller (postAllState) once the panel is
    // ensured; here we only refresh the sidebar.
    this.onStateChanged?.();
    // Deliver any background-completion notice queued for this session (e.g. it
    // finished while the agent was busy and the user switched away before the
    // drain ran).
    this.drainBackgroundQueue();
  }

  /**
   * Check out a node: the agent's history becomes root→node and the transcript
   * pointer moves to that node's items (or the session's orphan bucket when the
   * session has no node yet). Callers are responsible for posting to the webview.
   */
  private checkoutNode(session: AgentSession, nodeId: string | null): void {
    session.activeNodeId = nodeId;
    this.agent.setMessages(this.buildPath(session, nodeId));
    const node = nodeId ? session.nodes[nodeId] : undefined;
    this.displayItems = node ? node.displayItems : session.orphanItems;
  }

  /** The flat API history of a branch: a fresh system prompt + the path messages. */
  private buildPath(session: AgentSession, nodeId: string | null): ChatMessage[] {
    const system: ChatMessage = {
      role: 'system',
      content: Agent.systemPrompt(this.model, this.thinkingEffort),
    };
    // sanitizeMessages returns a derived copy; it is never written back into the
    // nodes, so the stored history keeps its original shape.
    return Agent.sanitizeMessages([system, ...pathMessages(session, nodeId)]);
  }

  /** Every transcript item of the checked-out branch, in reading order. */
  private activePathItems(): DisplayItem[] {
    const session = this.getActiveSession();
    if (!session) {
      return [];
    }
    const items: DisplayItem[] = [...session.orphanItems];
    for (const id of pathIds(session, session.activeNodeId)) {
      const node = session.nodes[id];
      if (node) {
        items.push(...node.displayItems);
      }
    }
    return items;
  }

  /**
   * Check out another node (tree UI "click a block"). Blocked while the agent is
   * busy or a background terminal is running, like every other session change.
   */
  private handleCheckout(nodeId: string): void {
    if (this.busy || this.activeSessionHasRunningBackground()) {
      this.postNotice(
        'warning',
        'Cannot switch branches while the agent or a background terminal is running.',
      );
      return;
    }
    const session = this.getActiveSession();
    if (!session || !session.nodes[nodeId] || nodeId === session.activeNodeId) {
      return;
    }
    this.checkoutNode(session, nodeId);
    this.currentPromptTokens = this.getLatestPromptTokens();
    // No `reset`/`tree`: the structure is unchanged, so the webview just repaints
    // the active path in place (no tear-down → no blink), then pans to it.
    this.postPath();
    this.post({ type: 'panTo', id: nodeId });
    this.postContext();
    this.postSessionStats();
  }

  /** The node that owns the main agent's streaming: the active turn node while a
   * turn runs, else the checked-out node. Sub-agents route their own events by
   * `nodeId`, so this is the ONLY target for `nodeId`-less (main) deltas — it must
   * never be a sub-agent sidecar, or the main reply would be drawn into it. */
  private mainStreamNodeId(session: AgentSession | null | undefined): string | null {
    return this.activeTurnNode?.id ?? session?.activeNodeId ?? null;
  }

  /** Structural summary of the session tree (no transcript items). */
  /** The checked-out branch's transcript, grouped by node (for the tree view). */
  private postPath(): void {
    const session = this.getActiveSession();
    if (!session) {
      this.post({ type: 'path', ids: [], nodes: [] });
      return;
    }
    const ids = pathIds(session, this.mainStreamNodeId(session));
    const nodes = ids.map((id) => {
      const node = session.nodes[id];
      return {
        id,
        status: node.status,
        items: node.displayItems.map(clipDisplayItem),
      };
    });
    this.post({ type: 'path', ids, nodes });
  }
  private postTree(): void {
    const session = this.getActiveSession();
    const nodes = session
      ? Object.values(session.nodes).map((node) => ({
          id: node.id,
          parentId: node.parentId,
          children: node.children.slice(),
          title: node.title,
          status: node.status,
          createdAt: node.createdAt,
          preview: this.nodePreview(node),
          usage: nodeUsage(node),
          size: node.customSize ?? null,
          kind: node.kind,
          agentDepth: node.agentDepth,
          agentStatus: node.agentStatus,
          agentModel: node.agentModel,
          agentWrite: node.agentWrite,
          // Agent nodes carry their own transcript so they re-render after reload.
          items: node.kind === 'agent' ? node.displayItems.map(clipDisplayItem) : undefined,
        }))
      : [];
    this.post({
      type: 'tree',
      activeId: this.mainStreamNodeId(session),
      rootId: session?.rootId ?? null,
      nodes,
    });
  }

  /** First line of the turn's answer, used as a collapsed card preview. */
  private nodePreview(node: TreeNode): string {
    for (let i = node.displayItems.length - 1; i >= 0; i--) {
      const item = node.displayItems[i];
      if (item.kind === 'assistant' && item.text) {
        return item.text.split('\n')[0].trim().slice(0, 120);
      }
    }
    return node.title.slice(0, 80);
  }

  /** Persist a user-resized card's bounds onto a node (drag-resize finished). */
  private onSetNodeSize(id: string, w: number, h: number): void {
    const session = this.getActiveSession();
    const node = session?.nodes[id];
    if (!node || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      return;
    }
    node.customSize = { w, h };
    this.persist();
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
    this.onStateChanged?.();
    if (this.panel && this.panel.sessionId === session.id) {
      this.panel.setTitle(this.panelTitle(session.id));
    }
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
  private handleRenameSession(args: Record<string, unknown>): string {
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
      prompt: 'Session title — renaming locks it, so automatic naming will not overwrite it.',
      value: session.title,
      placeHolder: 'Short, one line',
      validateInput: (value) => (value.trim() ? undefined : 'A title is required.'),
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
        'This session has no conversation yet — there is nothing to name from.',
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
  private requestAutoTitle(session: AgentSession): void {
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
        model: this.model,
        maxTokens: TITLE_MAX_TOKENS,
        temperature: 0.3,
        signal: controller.signal,
      });
      title = sanitizeTitle(text, '');
      if (usage) {
        this.outputLog(`[title] ${session.id} model=${this.model} tokens=${usage.total_tokens}`);
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
    if (this.storage.get<string>(TITLE_BACKFILL_KEY) === TITLE_BACKFILL_VERSION) {
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
    await this.storage.update(TITLE_BACKFILL_KEY, TITLE_BACKFILL_VERSION);
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
        model: this.model,
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

  // ---- Sub-agents ----

  /** Tools a sub-agent may use, by `write` flag. */
  private subAgentTools(write: boolean): ToolRegistry {
    const read = ['read_file', 'list_dir', 'search_files', 'search_transcripts'];
    const writeTools = ['write_file', 'replace_in_file', 'exec_command'];
    if (write) {
      return this.tools.subset([...read, ...writeTools]);
    }
    // Read-only sub-agents: the write tools stay registered with a rejecting
    // executor (defense-in-depth) but are hidden from the model's tool list, so
    // it does not spend a round proposing a tool it can never use.
    return this.tools.subset([...read, ...writeTools]).withBlocked(writeTools).withHidden(writeTools);
  }

  /**
   * Root folder holding every session's transcript dumps (`<root>/<sessionId>/`).
   * Defaults to the extension's global storage (never the user's repo);
   * `agentHarness.subAgentTranscriptDir` redirects it to a workspace-relative path.
   */
  private transcriptRoot(): string {
    const configured = this.getConfig().subAgentTranscriptDir;
    if (configured) {
      try {
        return resolvePath(configured);
      } catch {
        // No workspace folder open — fall through to global storage.
      }
    }
    if (this.globalStorage) {
      return path.join(this.globalStorage.fsPath, 'transcripts');
    }
    return path.join(os.tmpdir(), 'agent-harness-transcripts');
  }

  /** One session's transcript folder (main-agent turns + sub-agent runs). */
  private transcriptDir(sessionId: string): string {
    return path.join(this.transcriptRoot(), sessionId);
  }

  /** " · transcript: <path>" suffix for a sub-agent completion note ('' when off). */
  private transcriptNote(node: TreeNode): string {
    return node.agentTranscript ? ` · transcript: ${node.agentTranscript}` : '';
  }

  /**
   * Dump a finished main-agent turn to `<transcriptDir>/<nodeId>.jsonl`. Session
   * history otherwise lives only in the Memento (a sqlite blob no tool can
   * grep), so this is what makes `search_transcripts` able to recall a previous
   * conversation. Mirrors the node: a turn that a later injected notice turn
   * reuses is rewritten. Never throws into the agent loop.
   */
  private dumpSessionTranscript(node: TreeNode, session: AgentSession, status: TurnStatus): void {
    if (!this.getConfig().saveSessionTranscripts || node.kind === 'agent') {
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
        title: node.title,
        model: this.model,
        status,
        prompt,
        summary: this.nodePreview(node),
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
    if (this.storage.get<string>(TRANSCRIPT_BACKFILL_KEY) === TRANSCRIPT_BACKFILL_VERSION) {
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
    await this.storage.update(TRANSCRIPT_BACKFILL_KEY, TRANSCRIPT_BACKFILL_VERSION);
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
        model: node.agentModel || this.model,
        status: node.agentStatus ?? node.status,
        resumed: false,
        instruction: node.title,
        summary: node.agentSummary ?? this.nodePreview(node),
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
      model: this.model,
      status: node.status,
      prompt,
      summary: this.nodePreview(node),
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
  private writeSubAgentTranscript(
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
    const sessionId = job.sessionId ?? this.getActiveSession()?.id ?? 'unknown';
    try {
      const ref = writeSubAgentTranscript({
        dir: this.transcriptDir(sessionId),
        nodeId: job.node.id,
        sessionId,
        depth: job.node.agentDepth ?? 1,
        write: job.spec.write,
        model: job.spec.model || this.model,
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

  /** The main agent spawned sub-agents: delegates to the shared orchestrator. */
  private handleSpawnAgents(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    // Prefer the running turn's node; fall back to the checked-out node so a
    // provider-injected turn (e.g. an async batch notice) can still spawn.
    const parent =
      this.activeTurnNode ?? (this.getActiveSession()?.nodes[this.getActiveSession()!.activeNodeId ?? ''] ?? null);
    if (!parent) {
      return Promise.resolve('Error: no active turn to attach sub-agents to.');
    }
    return this.spawnChildren(parent, args, signal);
  }

  /** A sub-agent spawned its own (level-2) sub-agents. */
  private handleSubAgentSpawn(parent: TreeNode, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    return this.spawnChildren(parent, args, signal);
  }

  /** The main agent resumed a finished sub-agent via `send_agent_message`
   * (trusted: it may raise or lower the target's `write`). */
  private handleSendAgentMessage(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const session = this.getActiveSession();
    if (!session) {
      return Promise.resolve('Error: no active session.');
    }
    const id = String(args.id ?? '');
    const node = session.nodes[id];
    if (!node || node.kind !== 'agent') {
      return Promise.resolve(`Error: no sub-agent with id "${id}".`);
    }
    let write = node.agentWrite ?? false;
    if (typeof args.write === 'boolean') {
      write = args.write;
    }
    const override = this.parseModelOverride(args.model);
    if (override.error) {
      return Promise.resolve(override.error);
    }
    return this.resumeSubAgent(session, node, String(args.message ?? ''), String(args.mode ?? 'sync'), write, override.model, signal);
  }

  /**
   * A depth-1 sub-agent resumed one of its own finished sub-agents
   * (`send_agent_message` for a writable worker, `send_readonly_agent_message`
   * for a read-only one). Least privilege: the target must be a **direct child**
   * of the caller, and the resumed run's `write` is the AND of the caller's and
   * the target's — a sub-agent can never raise a child's permission.
   */
  private handleSubAgentSendMessage(parent: TreeNode, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const session = this.getActiveSession();
    const id = String(args.id ?? '');
    const node = session?.nodes[id];
    if (!session || !node || node.kind !== 'agent') {
      return Promise.resolve(`Error: no sub-agent with id "${id}".`);
    }
    if (node.parentId !== parent.id) {
      return Promise.resolve('Error: you may only message a sub-agent that you spawned yourself.');
    }
    const override = this.parseModelOverride(args.model);
    if (override.error) {
      return Promise.resolve(override.error);
    }
    const write = parent.agentWrite === true && node.agentWrite === true;
    return this.resumeSubAgent(session, node, String(args.message ?? ''), String(args.mode ?? 'sync'), write, override.model, signal);
  }

  /** Validate an optional `model` override; returns `{ model }` or `{ error }`. */
  private parseModelOverride(value: unknown): { model?: string; error?: string } {
    if (typeof value !== 'string' || !value) {
      return {};
    }
    if (!isKnownModel(value)) {
      return { error: `Error: unknown model "${value}".` };
    }
    return { model: value };
  }

  /** Shared resume path for `send_agent_message` / `send_readonly_agent_message`. */
  private resumeSubAgent(
    session: AgentSession,
    node: TreeNode,
    message: string,
    mode: string,
    write: boolean,
    model: string | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    if (!message) {
      return Promise.resolve('Error: a follow-up "message" is required.');
    }
    if (mode !== 'sync' && mode !== 'async') {
      return Promise.resolve(`Error: invalid mode "${mode}". Use "sync" or "async".`);
    }
    if (this.runningSubAgents.has(node.id)) {
      return Promise.resolve(
        'Error: that sub-agent is still running. Wait for it to finish (or kill it) before sending a follow-up.',
      );
    }
    const effectiveModel = model ?? node.agentModel ?? this.model;
    node.agentWrite = write;
    node.agentModel = effectiveModel;
    const job: SubAgentJob = {
      node,
      spec: { instruction: message, write, model: effectiveModel !== this.model ? effectiveModel : undefined },
      resume: true,
      sessionId: session.id,
    };
    if (mode === 'async') {
      void this.runSubAgent(job, signal).then((r) => this.deliverResumeAsync(node, r), () => {});
      return Promise.resolve(JSON.stringify({ resumed: true, id: node.id, async: true }));
    }
    return this.runSubAgent(job, signal).then((r) =>
      JSON.stringify({
        resumed: true,
        id: node.id,
        ok: r.ok,
        summary: r.summary,
        model: r.model,
        transcript: node.agentTranscript,
        stats: summarizeTranscript(node.messages),
      }),
    );
  }

  /** Async resume: deliver the resumed sub-agent's outcome to whoever owns it —
   * the main agent (a card + one notice) or a sub-agent parent (queued/auto-resumed). */
  private deliverResumeAsync(node: TreeNode, result: { ok: boolean; summary: string; model?: string }): void {
    const parent = this.getActiveSession()?.nodes[node.parentId ?? ''] ?? null;
    if (!parent) {
      return;
    }
    const cardText = `子代理 #${node.id.slice(-6)} ${result.ok ? '完成' : '失败'}: ${result.summary || '(no summary)'}${this.transcriptNote(node)}`;
    parent.displayItems.push({
      kind: 'background',
      id: `sub-msg-${node.id}`,
      name: '子代理完成',
      content: cardText,
      doneText: '子代理完成',
    });
    this.post({
      type: 'backgroundNotice',
      item: { id: `sub-msg-${node.id}`, name: '子代理完成', doneText: '子代理完成', content: cardText },
    });
    if (parent.kind === 'agent') {
      // The owner is a sub-agent: hand it the result the same way an async child
      // batch is handed over (queued for its next finish, or auto-resumed), so the
      // notice is never injected as a main-agent turn bound to a sub-agent node.
      this.queueSubAgentChildNotice(parent, [{ ok: result.ok, summary: result.summary, node }]);
    } else {
      this.subAgentNoticeQueue.push({ nodeId: parent.id, summary: cardText, status: 'done', count: 1 });
      this.scheduleSubAgentDrain();
    }
    this.persist();
  }

  /**
   * Create agent child nodes under `parent`, run them (in parallel, pool-limited
   * for level-1), and return the spawn result. `sync` blocks and returns the
   * summaries; `async` returns immediately and delivers per-job results as an
   * injected notification to the parent when idle.
   */
  private async spawnChildren(parent: TreeNode, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const session = this.getActiveSession();
    if (!session) {
      return 'Error: no active session.';
    }
    // Capture the checked-out node BEFORE attachNode below mutates it, so a spawn
    // can restore it even when the spawn's `parent` is itself a sub-agent.
    const prevActive = session.activeNodeId;
    const rawAgents = Array.isArray(args.agents) ? args.agents : [];
    if (rawAgents.length === 0) {
      return 'Error: spawn_agents requires a non-empty "agents" array.';
    }
    const mode = String(args.mode ?? 'sync');
    if (mode !== 'sync' && mode !== 'async') {
      return `Error: invalid mode "${mode}". Use "sync" or "async".`;
    }
    const childDepth = (parent.agentDepth ?? 0) + 1;
    // Defense-in-depth: a read-only sub-agent must never create a writable child,
    // even if a spawn call somehow reaches the provider.
    const parentReadOnly = parent.kind === 'agent' && parent.agentWrite === false;
    if (childDepth > 2) {
      return 'Error: a sub-sub-sub-agent is not allowed (max sub-agent depth is 2).';
    }
    // Level-2 budget: per-parent count.
    if (childDepth === 2) {
      const used = this.level2Counts.get(parent.id) ?? 0;
      const budget = this.getConfig().maxLevel2Subagents;
      if (rawAgents.length > Math.max(0, budget - used)) {
        return `Error: this sub-agent may start at most ${budget} sub-sub-agents (${used} already started).`;
      }
      this.level2Counts.set(parent.id, used + rawAgents.length);
    }

    // Build a node + spec per task.
    const jobs: SubAgentJob[] = [];
    for (const raw of rawAgents) {
      const spec = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const instruction = String(spec.instruction ?? '');
      const write = parentReadOnly ? false : spec.write === true;
      const model = typeof spec.model === 'string' ? spec.model : undefined;
      if (!instruction) {
        return 'Error: each agent spec requires an "instruction".';
      }
      if (model && !isKnownModel(model)) {
        return `Error: unknown model "${model}".`;
      }
      const node = createNode(newId(), parent.id, `子代理: ${instruction.slice(0, 32)}`, 'running');
      node.kind = 'agent';
      node.agentDepth = childDepth;
      node.agentStatus = 'running';
      node.agentModel = model || this.model;
      node.agentWrite = write;
      node.children = [];
      node.displayItems.push({ kind: 'user', text: instruction });
      attachNode(session, node);
      jobs.push({ spec: { instruction, write, model }, node, sessionId: session.id });
    }
    // Restore the checked-out node BEFORE repainting the tree: attachNode moved it
    // to the last agent child, and postTree derives activeId from it. The active
    // node must always be a real conversational node — the main turn node while a
    // turn runs, otherwise the user's checkout — NEVER a sub-agent sidecar.
    // Restoring to `parent.id` broke nested spawns (where parent is itself a
    // sub-agent), which pinned messagesEl to that sub-agent card and let the main
    // agent's reply leak into the sub-agent's window.
    const streamTarget = this.activeTurnNode?.id ?? prevActive ?? parent.id;
    if (session.activeNodeId !== streamTarget) {
      session.activeNodeId = streamTarget;
    }
    this.postTree();

    if (mode === 'async') {
      const mainParent = parent.id === this.activeTurnNode?.id;
      const tasks = jobs.map((job) => {
        const run = () => this.runSubAgent(job, signal);
        return (childDepth === 1 && this.subAgentPool ? this.subAgentPool.withSlot(run) : run()).then((result) => ({ job, result }));
      });
      // Notify the parent once the whole batch settles, so it reacts a single time.
      void Promise.allSettled(tasks).then((settled) => {
        const list = settled.map((s, i) =>
          s.status === 'fulfilled' ? s.value : { job: jobs[i], result: { ok: false, summary: 'cancelled' } },
        );
        this.onAsyncBatchDone(mainParent, parent, list.map((l) => ({ ...l.result, node: l.job.node })));
      });
      return JSON.stringify({
        spawned: jobs.length,
        async: true,
        ids: jobs.map((j) => j.node.id),
        transcriptDir: this.transcriptDir(session.id),
      });
    }

    const runAll = async () => {
      const results = await Promise.all(
        jobs.map((job) => (childDepth === 1 && this.subAgentPool ? this.subAgentPool.withSlot(() => this.runSubAgent(job, signal)) : this.runSubAgent(job, signal))),
      );
      return {
        results: results.map((r, i) => ({
          agentNodeId: jobs[i].node.id,
          transcript: jobs[i].node.agentTranscript,
          stats: summarizeTranscript(jobs[i].node.messages),
          ...r,
        })),
      };
    };
    return JSON.stringify(await runAll());
  }

  /** Run one sub-agent to completion and resolve its result. When `resume` is set,
   * the sub-agent's stored conversation is prepended so a follow-up continues it. */
  private runSubAgent(
    job: SubAgentJob,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; summary: string; model?: string }> {
    return new Promise((resolve) => {
      const abort = new AbortController();
      const onAbort = () => abort.abort();
      signal.addEventListener('abort', onAbort, { once: true });

      const startedAt = Date.now();
      const subTools = this.subAgentTools(job.spec.write);
      let finished = false;
      let subAgent: Agent | null = null;
      const finish = (status: 'done' | 'killed' | 'error', summary: string) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', onAbort);
        this.runningSubAgents.delete(job.node.id);
        job.node.agentStatus = status;
        job.node.status = status === 'done' ? 'done' : status === 'error' ? 'error' : 'interrupted';
        job.node.agentSummary = summary;
        // Persist the sub-agent's conversation (minus the synthesized system prompt)
        // so a later send_agent_message (or an async child-notice resume) can
        // continue it, even across an extension-host restart.
        if (subAgent) {
          job.node.messages = subAgent.getMessages().filter((m) => m.role !== 'system');
          // …and dump the same conversation to disk (JSONL) so the *caller* can
          // read the full tool-call history it cannot see in the summary.
          job.node.agentTranscript = this.writeSubAgentTranscript(job, subAgent, status, summary, startedAt);
        }
        this.post({ type: 'agentDone', id: job.node.id, status, summary });
        this.persist();
        // This sub-agent (depth-1) may have async depth-2 results queued while it ran.
        this.flushSubAgentChildNotices(job.node);
        resolve({ ok: status === 'done', summary, model: job.spec.model || this.model });
      };

      const sub = new Agent(this.client, subTools, (event) => this.handleSubAgentEvent(job.node, event, finish), this.getConfig().maxTurns);
      subAgent = sub;
      sub.setModel(job.spec.model || this.model);
      sub.setThinkingEffort(this.thinkingEffort);
      // Depth is hard-capped at 2, so only a depth-1 sub-agent may fan out. A
      // writable one gets `spawn_agents` (children may write); a read-only one
      // gets `spawn_readonly_agents` instead, whose args cannot express
      // `write:true` — so it keeps read-only parallelism without an escalation
      // path. `setCanSpawn*` decides which spawn/message tools are advertised to
      // the model (see `Agent.getTools`);
      // `Agent.executeToolCall` returns a clear error if they are called anyway.
      const depth = job.node.agentDepth ?? 1;
      const canSpawn = depth < 2 && job.spec.write;
      const canSpawnReadOnly = depth < 2 && !job.spec.write;
      sub.setCanSpawn(canSpawn);
      sub.setCanSpawnReadOnly(canSpawnReadOnly);
      if (canSpawn || canSpawnReadOnly) {
        sub.setSpawnHandler((args2, sig2) => this.handleSubAgentSpawn(job.node, args2, sig2));
        // Resume of its own children. The provider's sub-agent path enforces
        // least privilege: target must be a direct child, and its write
        // permission is capped by the caller's.
        sub.setSendMessageHandler((args2, sig2) => this.handleSubAgentSendMessage(job.node, args2, sig2));
      }
      const effectiveModel = job.spec.model || this.model;
      const system = Agent.subAgentSystemPrompt(effectiveModel, this.thinkingEffort, depth, job.spec.write);
      // Lean system prompt (not the full main prompt/AGENTS.md) + dispatched note.
      // On a resume, prepend the stored conversation so the follow-up continues
      // where the sub-agent left off.
      sub.setMessages(
        job.resume
          ? Agent.sanitizeMessages([{ role: 'system', content: system }, ...(job.node.messages ?? [])])
          : [{ role: 'system', content: system }],
      );
      job.node.agentStatus = 'running';
      job.node.status = 'running';
      if (job.resume) {
        // The follow-up becomes a new user card in this sub-agent's transcript.
        job.node.displayItems.push({ kind: 'user', text: job.spec.instruction });
      }
      this.runningSubAgents.set(job.node.id, { agent: sub, abort });
      this.post({ type: 'agentStart', id: job.node.id, depth, model: effectiveModel, write: job.spec.write });
      void sub.sendUserMessage(job.spec.instruction);
    });
  }

  /**
   * Async mode: the depth-1 sub-agent's own (depth-2) sub-agents finished while
   * it was still running. If the parent is done we resume it with the notification
   * so it can react; if it is still running we leave the notice queued and deliver
   * it at the parent's next finish. This is the "parent receives its own children's
   * results" counterpart to the main agent's async delivery.
   */
  private queueSubAgentChildNotice(parent: TreeNode, results: Array<{ ok: boolean; summary: string; node: TreeNode }>): void {
    const lines = results.map(
      (r) => `子代理 #${r.node.id.slice(-6)} ${r.ok ? '完成' : '失败'}: ${r.summary || '(no summary)'}${this.transcriptNote(r.node)}`,
    );
    const notice = `[子代理批次] ${results.length} 个子代理完成\n${lines.join('\n')}`;
    if (this.runningSubAgents.has(parent.id)) {
      // Parent still working: deliver when it reaches a rest point (its finish).
      const q = this.subAgentChildNotices.get(parent.id) ?? [];
      q.push({ message: notice });
      this.subAgentChildNotices.set(parent.id, q);
      return;
    }
    // Parent already finished: resume it so it can react to its children.
    const abort = new AbortController();
    void this.runSubAgent(
      { node: parent, spec: { instruction: notice, write: parent.agentWrite ?? false, model: undefined }, resume: true, sessionId: this.getActiveSession()?.id },
      abort.signal,
    );
  }

  /** Deliver queued async child results to a sub-agent that just finished. */
  private flushSubAgentChildNotices(node: TreeNode): void {
    const queued = this.subAgentChildNotices.get(node.id);
    if (!queued || queued.length === 0) {
      return;
    }
    const notice = queued.shift()!;
    if (queued.length === 0) {
      this.subAgentChildNotices.delete(node.id);
    }
    if (this.runningSubAgents.has(node.id)) {
      // A newer run already owns this node; leave the notice for it.
      return;
    }
    const abort = new AbortController();
    void this.runSubAgent(
      { node, spec: { instruction: notice.message, write: node.agentWrite ?? false, model: undefined }, resume: true, sessionId: this.getActiveSession()?.id },
      abort.signal,
    );
  }

  /** Route a sub-agent's events to its own node (streaming carries a nodeId). */
  private handleSubAgentEvent(node: TreeNode, event: AgentEvent, finish: (status: 'done' | 'killed' | 'error', summary: string) => void): void {
    const id = node.id;
    const items = node.displayItems;
    switch (event.type) {
      case 'streamDelta':
        this.commitSubText(items, event.content);
        this.post({ type: 'delta', text: event.content, nodeId: id });
        break;
      case 'reasoningDelta':
        this.commitSubThinking(items, event.content);
        this.post({ type: 'thinkingDelta', text: event.content, nodeId: id });
        break;
      case 'toolStart':
        this.commitSubTool(items, event.id, event.name, event.args);
        this.post({ type: 'toolStart', id: event.id, name: event.name, args: clipForUi(event.args, 8 * 1024), index: event.index, nodeId: id });
        break;
      case 'toolEnd':
        this.commitSubToolResult(items, event.id, event.content);
        this.post({ type: 'toolEnd', id: event.id, name: event.name, content: clipForUi(event.content), nodeId: id });
        break;
      case 'usage':
        this.commitSubUsage(items, event.usage);
        this.post({ type: 'usage', usage: event.usage, nodeId: id });
        break;
      case 'status':
        break;
      case 'done':
        finish('done', this.subAgentSummary(items));
        break;
      case 'interrupted':
        finish('killed', 'interrupted');
        break;
      case 'error':
        finish('error', event.message);
        break;
      default:
        break;
    }
  }

  // ---- Sub-agent displayItems commits (kept in sync with the main handler) ----
  /** Prefer the last substantial assistant answer for the sub-agent summary. */
  private subAgentSummary(items: DisplayItem[]): string {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.kind === 'assistant' && item.text && item.text.trim().length > 10) {
        return item.text.trim();
      }
    }
    const last = items[items.length - 1];
    return last && last.kind === 'assistant' && last.text ? last.text.trim() : 'done';
  }

  private commitSubText(items: DisplayItem[], text: string): void {
    const last = items[items.length - 1];
    if (last && last.kind === 'assistant' && !last.error) {
      last.text = (last.text ?? '') + text;
    } else {
      items.push({ kind: 'assistant', text });
    }
  }

  private commitSubThinking(items: DisplayItem[], text: string): void {
    const last = items[items.length - 1];
    if (last && last.kind === 'assistant' && !last.error) {
      last.thinking = (last.thinking ?? '') + text;
    } else {
      items.push({ kind: 'assistant', thinking: text });
    }
  }

  private commitSubTool(items: DisplayItem[], id: string, name: string, args: string): void {
    items.push({ kind: 'tool', id, name, args: clipForUi(args, 8 * 1024), status: 'running' });
  }

  private commitSubToolResult(items: DisplayItem[], id: string, content: string): void {
    const item = items.find((it) => it.kind === 'tool' && it.id === id);
    if (item) {
      item.status = 'done';
      item.content = clipForUi(content);
    }
  }

  private commitSubUsage(items: DisplayItem[], usage: Usage): void {
    const last = items[items.length - 1];
    if (last && (last.kind === 'assistant' || last.kind === 'tool') && !last.error) {
      last.usage = usage;
    }
  }

  /** Individual kill of a running sub-agent (from the webview Kill button). */
  private onKillAgent(id: string): void {
    const entry = this.runningSubAgents.get(id);
    if (!entry) {
      return;
    }
    entry.abort.abort();
    entry.agent.cancel();
  }

  /** Clean up a finished/killed sub-agent (no-op guard for stale kills). */
  private onSubAgentDone(node: TreeNode, result: { ok: boolean; summary: string }): void {
    if (node.agentStatus === 'running') {
      node.agentStatus = result.ok ? 'done' : 'killed';
      node.agentSummary = result.summary;
      this.post({ type: 'agentDone', id: node.id, status: node.agentStatus, summary: result.summary });
      this.persist();
    }
  }

  /** Dump a layout diagnostic (overlapping cards + tree connections) to the log. */
  private logLayoutDiagnostic(nodes: unknown, overlaps: unknown, connections: unknown, force: unknown): void {
    const out = this.output;
    out.appendLine(force ? '[layout] manual diagnostic:' : '[layout] overlaps detected (auto):');
    if (Array.isArray(overlaps)) {
      for (const o of overlaps) {
        if (o && typeof o === 'object') {
          const oo = o as { a?: string; b?: string; ta?: string; tb?: string; over?: number };
          out.appendLine(`[layout] OVERLAP ${oo.a}("${oo.ta}") × ${oo.b}("${oo.tb}") area=${oo.over}`);
        }
      }
    }
    if (Array.isArray(nodes)) {
      for (const n of nodes) {
        if (n && typeof n === 'object') {
          const nn = n as { id?: string; kind?: string; parent?: string; title?: string; x?: number; y?: number; w?: number; h?: number };
          out.appendLine(`[layout] NODE ${nn.id} kind=${nn.kind} parent=${nn.parent} "${nn.title}" x=${nn.x} y=${nn.y} ${nn.w}x${nn.h}`);
        }
      }
    }
    if (Array.isArray(connections)) {
      for (const c of connections) {
        if (c && typeof c === 'object') {
          const cc = c as { parent?: string; child?: string };
          out.appendLine(`[layout] EDGE ${cc.parent} -> ${cc.child}`);
        }
      }
    }
  }

  /**
   * Async mode, all sub-agents of the batch settled: push one clearly-separated
   * completion card into the parent node (like a background terminal card) and
   * deliver one combined notice so the main agent reacts a single time. All
   * still belongs to the single parent node.
   */
  private onAsyncBatchDone(mainParent: boolean, parent: TreeNode, results: Array<{ ok: boolean; summary: string; node: TreeNode }>): void {
    if (!mainParent) {
      // The parent is a sub-agent: deliver its children's completion to it so it
      // can react (S2). It may still be running; queue or resume accordingly.
      this.queueSubAgentChildNotice(parent, results);
      return;
    }
    const lines = results.map((r) => `子代理 #${r.node.id.slice(-6)} ${r.ok ? '完成' : '失败'}: ${r.summary || '(no summary)'}${this.transcriptNote(r.node)}`);
    const cardText = lines.join('\n');
    const doneText = `${results.length} 个子代理完成`;
    // 1. A dedicated card at the end of the main node (visual separation).
    parent.displayItems.push({ kind: 'background', id: `sub-aware-${parent.id}`, name: '子代理完成', content: cardText, doneText });
    this.post({ type: 'backgroundNotice', item: { id: `sub-${parent.id}`, name: '子代理完成', doneText, content: cardText } });
    // 2. One combined notice → the main agent answers once.
    this.subAgentNoticeQueue.push({ nodeId: parent.id, summary: cardText, status: 'done', count: results.length });
    this.scheduleSubAgentDrain();
    this.persist();
  }

  private scheduleSubAgentDrain(): void {
    if (this.busy) {
      return;
    }
    if (this.lastSubAgentDrain != null) {
      return;
    }
    this.lastSubAgentDrain = setTimeout(() => {
      this.lastSubAgentDrain = null;
      this.drainSubAgentNotices();
    }, 75);
  }

  /** When the main agent is idle, deliver queued async sub-agent results. */
  private drainSubAgentNotices(): void {
    if (this.disposed || this.busy) {
      return;
    }
    // The agent's `finally` hasn't reset `isRunning` yet when this is called from
    // the `done` callback — sendUserMessage would drop the notice. Defer a tick.
    if (this.agent.running) {
      setTimeout(() => this.drainSubAgentNotices(), 0);
      return;
    }
    const session = this.getActiveSession();
    // Drop notices whose node belongs to a session that is no longer active: the
    // sub-agent's card is already in that session's tree, and injecting the turn
    // into whatever session is now active would pollute its history (the parent
    // node would not even resolve there).
    const notices = this.subAgentNoticeQueue.splice(0).filter((n) => session?.nodes[n.nodeId] !== undefined);
    if (notices.length === 0) {
      return;
    }
    // Bind this injected turn to the parent node: it bypasses beginTurn, so
    // activeTurnNode is null — but the reply (and any further spawn) must belong
    // to that node. Set the context so events route there and spawn works.
    const parentId = notices[0].nodeId;
    const parent = session!.nodes[parentId];
    // Continue from the parent node's path: an injected turn bypasses beginTurn,
    // so pin the agent's history to this node explicitly (the user may have
    // checked out another branch while the async batch was running).
    if (parent && session) {
      this.agent.setMessages(this.buildPath(session, parent.id));
    }
    this.activeTurnNode = parent ?? null;
    this.displayItems = parent ? parent.displayItems : this.displayItems;
    // The slice basis must match `finishTurn`'s array — `agent.getMessages()`,
    // which includes the leading system message. Using `parent.messages.length`
    // (the node's own messages only) re-included ancestor history in the node.
    this.turnPrefixLen = this.agent.getMessages().length;
    this.lastStatus = '子代理完成';
    this.setBusy(true);
    this.post({ type: 'status', text: this.lastStatus });
    // Re-affirm the active node in the webview BEFORE the resumed turn streams: a
    // nested sub-agent spawn may have left messagesEl pinned to a sub-agent card,
    // and this injected turn has no `path`/`tree` round-trip of its own. postPath
    // uses mainStreamNodeId (= this turn's parent), so setActiveLeaf re-pins
    // messagesEl to the main node and the reply cannot leak into a sub-agent card.
    this.postPath();
    // One clean combined message: per batch, a header + the per-sub-agent lines.
    const parts = notices.map((n) => {
      const count = n.count ?? 1;
      const head = n.status === 'done' ? `${count} 个子代理完成` : `${count} 个子代理完成（含失败/中断）`;
      return `[子代理批次] ${head}\n${n.summary || '(no summary)'}`;
    });
    this.agent.sendUserMessage(`子代理通知：\n${parts.join('\n\n')}`);
  }

  private cleanupSubAgents(): void {
    for (const [, entry] of this.runningSubAgents) {
      entry.abort.abort();
      entry.agent.cancel();
    }
    this.runningSubAgents.clear();
  }

  /**
   * Create this turn's node, check it out, and record where its message slice
   * starts. The caller pushes the turn's display items and then sends the
   * prompt to the agent.
   */
  private beginTurn(title: string): TreeNode | null {
    const session = this.getActiveSession();
    if (!session) {
      return null;
    }
    const parentId = session.activeNodeId;
    // The interruption notice only makes sense when this turn continues from the
    // turn that was actually interrupted.
    if (parentId !== this.lastInterruptedNodeId) {
      this.agent.resetInterruptState();
    }
    const node = createNode(newId(), parentId, title, 'running');
    attachNode(session, node);
    this.activeTurnNode = node;
    this.displayItems = node.displayItems;
    // The new node contributes no messages yet, so this is the parent's path.
    this.agent.setMessages(this.buildPath(session, node.id));
    this.turnPrefixLen = this.agent.getMessages().length;
    this.postTree();
    this.post({ type: 'panTo', id: node.id });
    return node;
  }

  /**
   * Close out the running turn: store exactly the messages the agent appended
   * during it (the interrupt checkpoint and the error rollback both land here),
   * then persist, and patch just this card instead of resending the whole tree.
   */
  private finishTurn(status: TurnStatus): void {
    const node = this.activeTurnNode;
    this.activeTurnNode = null;
    const session = this.getActiveSession();
    if (node && session && session.nodes[node.id]) {
      node.messages = this.agent.getMessages().slice(this.turnPrefixLen);
      node.status = status;
      session.updatedAt = Date.now();
      // Mirror the finished turn to disk so it stays searchable later.
      this.dumpSessionTranscript(node, session, status);
      // A finished turn is the moment to (re)name the session. An interrupted
      // turn has no reliable content yet, so it is skipped.
      if (status !== 'interrupted') {
        this.requestAutoTitle(session);
      }
    }
    this.persist();
    if (node && session?.nodes[node.id]) {
      this.post({
        type: 'nodeUpdate',
        id: node.id,
        status: node.status,
        title: node.title,
        usage: nodeUsage(node),
      });
    }
    // A hopped session's turn just ended: queue the trip back to the session
    // that dispatched it, carrying this turn's final answer. The queued start
    // below picks it up once the agent is idle.
    this.queueHopReturn(node, session, status);
    // A queued `POST /session/start` (the agent handing a task to a fresh
    // session) runs once this turn is fully closed out.
    this.runPendingSessionStart();
  }

  /**
   * The agent handed a task to a fresh session via `hop_session`: queue it with a
   * return address. The hop itself can only start once this turn ends, so the
   * provider's session-start queue does the work; the armed `hopReturn` then
   * routes the hopped session's answer back here.
   */
  private handleHopSession(args: Record<string, unknown>): string {
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
    const session = this.getActiveSession();
    if (!session) {
      return 'Error: no active session.';
    }
    if (this.activeSessionHasRunningBackground()) {
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
   * `list_nodes` tool: render the active session's tree (id, status, parent,
   * title) so the agent can name a node — e.g. as `hop_session`'s
   * `returnNodeId`. Node ids otherwise live only in the persisted tree.
   */
  private handleListNodes(): string {
    const session = this.getActiveSession();
    if (!session) {
      return 'Error: no active session.';
    }
    const depthOf = (node: TreeNode): number => {
      let depth = 0;
      let parent = node.parentId ? session.nodes[node.parentId] : undefined;
      while (parent && depth < 64) {
        depth++;
        parent = parent.parentId ? session.nodes[parent.parentId] : undefined;
      }
      return depth;
    };
    const ordered = Object.values(session.nodes).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    const lines = ordered.map((node) => {
      const marks = [node.kind === 'agent' ? 'agent' : 'turn', node.kind === 'agent' ? node.agentStatus ?? node.status : node.status];
      if (node.id === session.activeNodeId) {
        marks.push('checked out');
      }
      const parent = node.parentId ? ` parent=${node.parentId}` : '';
      return `${'  '.repeat(depthOf(node))}- ${node.id}  [${marks.join(', ')}]${parent}  ${node.title}`;
    });
    return [
      `session ${session.id} "${session.title}" — ${ordered.length} nodes, checked out: ${session.activeNodeId ?? '(none)'}`,
      ...lines,
    ].join('\n');
  }

  /**
   * If a hop is armed and the turn that just finished belongs to the hopped
   * session (a session created after the hop was queued), deliver that session's
   * final answer back to the origin session as a queued start.
   */
  private queueHopReturn(node: TreeNode | null, session: AgentSession | null | undefined, status: TurnStatus): void {
    const hop = this.hopReturn;
    if (!hop || !session || session.id === hop.originSessionId) {
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
        `[会话跳转回执] 你派到新会话「${session.title}」(${session.id}) 的任务已结束（状态：${status}）。\n` +
        `它的最终回复：\n\n${clipped || '(新会话没有产出文本回复)'}\n\n` +
        `（需要完整过程可用 search_transcripts sessionId=${session.id} 检索）`,
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
    if (this.disposed || this.busy || this.agent.running || this.activeSessionHasRunningBackground()) {
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

  // ---- Public command entry points ----

  /** Open the chat panel for the active session (agentHarness.openChat / focus). */
  openChat(): void {
    const session = this.getActiveSession();
    if (!session) {
      return;
    }
    this.ensurePanel(session.id);
  }

  /**
   * Open the fully-rendered system prompt in an editor tab
   * (agentHarness.showSystemPrompt). The content is rendered from the *current*
   * session state — the active model, the reasoning effort and the AGENTS.md
   * snapshot taken when the session started — so it is exactly what the model
   * would receive on the next turn.
   */
  async showSystemPrompt(): Promise<void> {
    const content = Agent.systemPrompt(this.model, this.thinkingEffort);
    const doc = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  /** Open (or rebind) the panel to a session and check it out. */
  openSession(id: string): void {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) {
      return;
    }
    if (id === this.activeSessionId) {
      // Already checked out; just bring the panel forward (allowed even while the
      // session runs a background job).
      this.ensurePanel(id);
      return;
    }
    if (this.busy || this.activeSessionHasRunningBackground()) {
      this.postNotice(
        'warning',
        'Cannot switch session while background terminals are running. Wait for them to finish or kill them from the Background panel first.',
      );
      return;
    }
    this.activateSession(session);
    this.ensurePanel(session.id);
  }

  newSession(): void {
    if (this.busy || this.activeSessionHasRunningBackground()) {
      this.postNotice(
        'warning',
        'Cannot start a new session while background terminals are running. Wait for them to finish or kill them from the Background panel first.',
      );
      return;
    }
    const session = this.createSessionInMemory();
    this.activateSession(session);
    this.persist();
    this.ensurePanel(session.id);
  }

  deleteSession(id: string): void {
    if (this.busy || this.activeSessionHasRunningBackground()) {
      this.postNotice(
        'warning',
        'Cannot delete a session while background terminals are running. Wait for them to finish or kill them from the Background panel first.',
      );
      return;
    }
    const idx = this.sessions.findIndex((s) => s.id === id);
    if (idx === -1) {
      return;
    }
    // Tear down any background terminals owned by the session being removed.
    const deletedReg = this.sessionRegistries.get(id);
    if (deletedReg) {
      deletedReg.killAll();
      this.sessionRegistries.delete(id);
    }
    // Drop any queued completion notice still waiting for that session.
    this.backgroundNotifQueue = this.backgroundNotifQueue.filter((q) => q.sessionId !== id);
    // Drop the session's transcript dumps too (turns + sub-agent runs).
    removeTranscriptDir(this.transcriptDir(id));
    this.sessions.splice(idx, 1);
    if (this.sessions.length === 0) {
      this.createSessionInMemory();
    }
    this.activeSessionId = this.sessions.some((s) => s.id === this.activeSessionId)
      ? this.activeSessionId
      : this.sessions[0].id;
    this.activateSession(this.getActiveSession()!);
    this.persist();
    // If the deleted session owned the open panel, rebind it to the new active one.
    this.ensurePanel(this.getActiveSession()!.id);
  }

  clear(): void {
    if (this.busy || this.activeSessionHasRunningBackground()) {
      this.postNotice(
        'warning',
        'Cannot clear the conversation while background terminals are running. Wait for them to finish or kill them from the Background panel first.',
      );
      return;
    }
    this.agent.reset();
    this.agent.resetInterruptState();
    this.lastInterruptedNodeId = null;
    this.activeTurnNode = null;
    this.turnPrefixLen = 0;
    this.uploadController = null;
    const session = this.getActiveSession();
    if (session) {
      // A cleared conversation keeps its identity but loses the whole tree.
      session.nodes = {};
      session.rootId = null;
      session.activeNodeId = null;
      session.orphanItems.length = 0;
      session.updatedAt = Date.now();
      // ...and its automatic title: the next turn names the fresh conversation.
      delete session.titleAutoAt;
      delete session.titleAutoNodes;
      if (!session.titleLocked) {
        session.title = 'New session';
        session.titleSource = 'provisional';
        this.onStateChanged?.();
      }
      this.displayItems = session.orphanItems;
    }
    this.setBusy(false);
    this.lastStatus = '';
    this.currentPromptTokens = 0;
    // A cleared conversation drops its background-terminal history too (it is
    // blocked while any are still running, so these are all finished).
    this.sessionRegistries.get(this.activeSessionId)?.clearAll();
    this.backgroundNotifQueue = this.backgroundNotifQueue.filter(
      (q) => q.sessionId !== this.activeSessionId,
    );
    this.subAgentNoticeQueue.length = 0;
    this.subAgentChildNotices.clear();
    // The cleared conversation's transcript dumps are stale now.
    removeTranscriptDir(this.transcriptDir(this.activeSessionId));
    if (this.backgroundDrainTimer != null) {
      clearTimeout(this.backgroundDrainTimer);
      this.backgroundDrainTimer = null;
    }
    this.post({ type: 'reset' });
    this.postBackgrounds();
    this.postContext();
    this.postSessionStats();
    this.postTree();
    this.persist();
  }

  // ---- Branch deletion ----

  /**
   * Ask for a branch deletion (webview card button / palette command). Deleting
   * a branch is irreversible — it drops the subtree from the session history AND
   * the matching transcript dumps on disk — so it always goes through a modal
   * confirmation, never a single click. Returns true when something was removed.
   */
  async deleteBranchInteractive(nodeId: string): Promise<boolean> {
    const session = this.getActiveSession();
    const node = session?.nodes[nodeId];
    if (!session || !node) {
      return false;
    }
    const blocked = this.branchDeletionBlocked(session, nodeId);
    if (blocked) {
      this.postNotice('warning', blocked);
      return false;
    }
    const ids = branchIds(session, nodeId);
    const turns = ids.filter((id) => session.nodes[id]?.kind !== 'agent').length;
    const agents = ids.length - turns;
    const detail = [
      `History: ${turns} turn(s)${agents > 0 ? ` and ${agents} sub-agent card(s)` : ''} are removed from this conversation.`,
      'Transcripts: their JSONL dumps are deleted from disk, so search_transcripts will no longer find them.',
      'The checked-out node moves to the parent of the deleted branch.',
      'This cannot be undone.',
    ].join('\n');
    const pick = await vscode.window.showWarningMessage(
      `Delete this branch — "${node.title || 'untitled'}" and everything below it?`,
      { modal: true, detail },
      'Delete Branch',
    );
    if (pick !== 'Delete Branch') {
      return false;
    }
    return this.deleteBranch(nodeId);
  }

  /** Palette command: delete the branch rooted at the checked-out node. */
  async deleteCheckedOutBranchInteractive(): Promise<boolean> {
    const session = this.getActiveSession();
    const nodeId = session?.activeNodeId;
    if (!session || !nodeId) {
      void vscode.window.showInformationMessage('There is no checked-out turn to delete.');
      return false;
    }
    return this.deleteBranchInteractive(nodeId);
  }

  /**
   * Why this branch cannot be deleted right now ('' when it can). A turn (main
   * or sub-agent) that is still running must never lose the node it is writing
   * into.
   */
  private branchDeletionBlocked(session: AgentSession, nodeId: string): string {
    if (this.busy || this.agent.running) {
      return 'Cannot delete a branch while the agent is running. Wait for the turn to finish.';
    }
    if (branchIds(session, nodeId).some((id) => this.runningSubAgents.has(id))) {
      return 'Cannot delete a branch that contains a running sub-agent. Kill it first.';
    }
    return '';
  }

  /**
   * Apply a confirmed branch deletion to the active session: drop the subtree
   * from the tree, delete the matching transcript dumps (a node's dump is
   * `<transcriptDir>/<nodeId>.jsonl` for both main turns and sub-agent runs, plus
   * any absolute path a sub-agent recorded under a different transcript root),
   * move the checkout off the removed subtree, and repaint. Returns false when
   * the node is unknown, belongs to another session, or a turn started while the
   * confirmation dialog was open.
   */
  deleteBranch(nodeId: string): boolean {
    const session = this.getActiveSession();
    if (!session || !session.nodes[nodeId]) {
      return false;
    }
    // Re-checked here too: an async sub-agent batch can inject a turn while the
    // modal dialog is open, and that turn's node must not be deleted under it.
    const blocked = this.branchDeletionBlocked(session, nodeId);
    if (blocked) {
      this.postNotice('warning', blocked);
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
    if (this.lastInterruptedNodeId && ids.includes(this.lastInterruptedNodeId)) {
      // The turn whose interruption notice was pending no longer exists.
      this.lastInterruptedNodeId = null;
    }
    if (Object.keys(session.nodes).length === 0) {
      // The whole tree went (the deleted branch was the root): mirror `clear()`
      // so the next turn names the now-empty conversation again.
      delete session.titleAutoAt;
      delete session.titleAutoNodes;
      if (!session.titleLocked) {
        session.title = 'New session';
        session.titleSource = 'provisional';
      }
      this.panel?.setTitle(this.panelTitle(session.id));
    }
    // Depth-2 results queued for a removed (finished) sub-agent can never be
    // delivered; a queued main-agent notice for a removed node is dropped by
    // drainSubAgentNotices itself (it filters on the node still existing).
    for (const id of ids) {
      this.subAgentChildNotices.delete(id);
    }
    this.checkoutNode(session, session.activeNodeId);
    this.currentPromptTokens = this.getLatestPromptTokens();
    this.postTree();
    this.postPath();
    if (session.activeNodeId) {
      this.post({ type: 'panTo', id: session.activeNodeId });
    }
    this.postContext();
    this.postSessionStats();
    this.persist();
    // The sidebar row shows the node count + "time ago", both of which moved.
    this.onStateChanged?.();
    this.outputLog(
      `[branch] deleted ${ids.length} node(s) at ${nodeId} in ${session.id}; ${dropped} transcript dump(s) removed`,
    );
    return true;
  }

  // ---- External control plane (src/http/controlServer.ts) ----

  /** Append a line to the Agent Harness output channel (used by the control plane). */
  outputLog(line: string): void {
    this.output.appendLine(line);
  }

  controlState(): ControlState {
    const session = this.getActiveSession();
    return {
      busy: this.busy || this.agent.running,
      sessionId: session?.id ?? null,
      activeNodeId: session?.activeNodeId ?? null,
      runningSubAgents: this.runningSubAgents.size,
      runningBackgrounds: this.activeSessionHasRunningBackground(),
      sessions: this.sessions.map((s) => ({
        id: s.id,
        title: s.title,
        nodes: Object.keys(s.nodes).length,
        active: s.id === this.activeSessionId,
        titleSource: s.titleSource,
        titleLocked: s.titleLocked === true ? true : undefined,
      })),
    };
  }

  /**
   * Block until the agent is idle. `scope:'all'` also waits for sub-agents and
   * background terminals. The last `persist()` write is awaited before returning
   * so the caller may kill the process immediately after. Never interrupts a
   * turn unless `interrupt` is set.
   */
  async controlWaitForFinish(opts: WaitForFinishOptions): Promise<ControlResult> {
    const scope = opts.scope === 'all' ? 'all' : 'turn';
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.max(0, Math.min(opts.timeoutMs ?? 0, 600000)) : 30000;
    const idle = (): boolean => {
      if (this.busy || this.agent.running) {
        return false;
      }
      if (scope === 'all' && (this.runningSubAgents.size > 0 || this.activeSessionHasRunningBackground())) {
        return false;
      }
      return true;
    };
    if (opts.interrupt && !idle()) {
      this.onStop();
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
    await this.lastPersist;
    const holdMs = Number.isFinite(opts.holdMs) ? Math.max(0, Math.min(opts.holdMs ?? 0, 600000)) : 0;
    if (holdMs > 0) {
      this.controlHoldUntil = Date.now() + holdMs;
    }
    const state = this.controlState();
    return { ok: true, idle: true, busy: false, sessionId: state.sessionId, nodeId: state.activeNodeId };
  }

  /** Check out a node (switching session first when needed) and show the panel. */
  async controlNavigate(opts: { sessionId?: string; nodeId: string }): Promise<ControlResult> {
    const session = opts.sessionId ? this.sessions.find((s) => s.id === opts.sessionId) : this.getActiveSession();
    if (!session) {
      return { ok: false, error: `no such session: ${opts.sessionId ?? '(active)'}` };
    }
    if (session.id !== this.activeSessionId) {
      this.openSession(session.id);
    }
    if (!session.nodes[opts.nodeId]) {
      return { ok: false, error: `no such node: ${opts.nodeId}` };
    }
    this.handleCheckout(opts.nodeId);
    this.ensurePanel(session.id);
    return { ok: true, sessionId: session.id, nodeId: opts.nodeId };
  }

  /** Send a caller-supplied message that continues from `nodeId` (a new child turn). */
  async controlContinueFrom(opts: { sessionId?: string; nodeId?: string; message: string }): Promise<ControlResult> {
    const message = (opts.message ?? '').trim();
    if (!message) {
      return { ok: false, error: 'message is required' };
    }
    if (this.busy || this.agent.running) {
      return { ok: false, error: 'the agent is busy; wait for it to finish first' };
    }
    const session = opts.sessionId ? this.sessions.find((s) => s.id === opts.sessionId) : this.getActiveSession();
    if (!session) {
      return { ok: false, error: `no such session: ${opts.sessionId ?? '(active)'}` };
    }
    if (session.id !== this.activeSessionId) {
      this.openSession(session.id);
    }
    const nodeId = opts.nodeId ?? session.activeNodeId ?? session.rootId;
    if (nodeId) {
      if (!session.nodes[nodeId]) {
        return { ok: false, error: `no such node: ${nodeId}` };
      }
      this.handleCheckout(nodeId);
    }
    this.ensurePanel(session.id);
    await this.onUserMessage(message);
    return { ok: true, sessionId: session.id, nodeId: session.activeNodeId };
  }

  /**
   * Create a fresh session (or jump to an existing one) and optionally send a
   * caller-supplied prompt as its first turn. The harness drives one session at
   * a time, so this refuses while the active session is busy — unless the caller
   * asks for a fresh session with a prompt, which is queued instead. With
   * `returnTo` the hopped session's final answer is delivered back to the
   * session that was active when the hop was queued (the `hop_session` path),
   * branching off `returnNodeId` when that is given. `nodeId` checks out a node
   * in the target session before the prompt is sent.
   */
  async controlStartSession(opts: {
    sessionId?: string;
    nodeId?: string;
    title?: string;
    prompt?: string;
    returnTo?: boolean;
    returnNodeId?: string;
  }): Promise<ControlResult> {
    if (this.busy || this.agent.running || this.activeSessionHasRunningBackground()) {
      // The agent calling this is *by definition* mid-turn. Queue a fresh
      // session + prompt so the handoff runs the moment this turn ends.
      if (!opts.sessionId && (opts.prompt ?? '').trim()) {
        if (this.pendingSessionStart) {
          return { ok: false, error: 'a session start is already queued', busy: true };
        }
        if (opts.returnTo && this.hopReturn) {
          return { ok: false, error: 'a session hop is already in progress', busy: true };
        }
        const origin = this.getActiveSession();
        this.pendingSessionStart = { title: opts.title, prompt: opts.prompt };
        if (opts.returnTo && origin) {
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
    let session: AgentSession | undefined;
    if (opts.sessionId) {
      session = this.sessions.find((s) => s.id === opts.sessionId);
      if (!session) {
        return { ok: false, error: `no such session: ${opts.sessionId}` };
      }
      if (session.id !== this.activeSessionId) {
        this.activateSession(session);
      }
    } else {
      session = this.createSessionInMemory();
      if (opts.title?.trim()) {
        // A caller-supplied title is explicit: lock it so automatic naming
        // never overwrites what the dispatcher asked for.
        this.applySessionTitle(session, opts.title.trim(), 'manual');
      }
      this.activateSession(session);
      this.persist();
    }
    if (opts.nodeId) {
      if (!session.nodes[opts.nodeId]) {
        return { ok: false, error: `no such node: ${opts.nodeId}` };
      }
      this.handleCheckout(opts.nodeId);
    }
    this.ensurePanel(session.id);
    const prompt = (opts.prompt ?? '').trim();
    if (!prompt) {
      return { ok: true, sessionId: session.id, nodeId: session.activeNodeId, prompted: false };
    }
    // onUserMessage names a fresh session from its first message when no title
    // was supplied, so a caller-supplied title wins and a bare prompt titles it.
    await this.onUserMessage(prompt);
    return { ok: true, sessionId: session.id, nodeId: session.activeNodeId, prompted: true };
  }

  /**
   * Ask VS Code to reload this window. Replies 202 immediately and reloads a
   * moment later (after the pending persist lands), because the reload kills
   * this process — the caller can only observe it as a *new* instance.
   */
  controlReloadWindow(): ControlResult {
    if (this.busy || this.agent.running) {
      return { ok: false, error: 'the agent is busy; wait for it to finish first', busy: true };
    }
    if (this.runningSubAgents.size > 0 || this.activeSessionHasRunningBackground()) {
      return { ok: false, error: 'sub-agents or background terminals are still running', busy: true };
    }
    void this.lastPersist.finally(() => {
      setTimeout(() => {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }, 400);
    });
    return { ok: true };
  }

  // ---- Panel lifecycle ----

  private panelTitle(sessionId: string): string {
    const session = this.sessions.find((s) => s.id === sessionId);
    return `Agent Chat Tree — ${session ? session.title : 'Session'}`;
  }

  private createPanel(sessionId: string): ChatPanel {
    let created!: ChatPanel;
    created = ChatPanel.create({
      sessionId,
      title: this.panelTitle(sessionId),
      extensionUri: this.extensionUri,
      getHtml: (webview) => this.getHtml(webview),
      onMessage: (message) => this.handlePanelMessage(message),
      onDispose: () => {
        // The webview is gone; state stays in this provider so it can be reopened.
        if (this.panel === created) {
          this.panel = null;
        }
      },
    });
    return created;
  }

  /**
   * Window recovery: VS Code recreated this webview panel from the editor state
   * it serialized at shutdown (`registerWebviewPanelSerializer`, wired in
   * extension.ts). Adopt the panel, bind it to the session it was showing and
   * repaint it. Without this the chat tab silently disappears on every reload.
   */
  restorePanel(panel: vscode.WebviewPanel, state: unknown): void {
    if (this.disposed || this.panel) {
      // Shutting down, or a chat tab is already bound (never expected with a
      // single panel): drop the extra one so the user does not get two tabs.
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
    if (session.id !== this.activeSessionId) {
      // Show the panel's session as the active one so tree, agent history and
      // composer all agree with what is on screen.
      this.activateSession(session);
    }
    let restored!: ChatPanel;
    restored = ChatPanel.revive({
      sessionId: session.id,
      panel,
      getHtml: (webview) => this.getHtml(webview),
      onMessage: (message) => this.handlePanelMessage(message),
      onDispose: () => {
        if (this.panel === restored) {
          this.panel = null;
        }
      },
    });
    this.panel = restored;
    restored.setTitle(this.panelTitle(session.id));
    this.output.appendLine(`[panel] restored chat tab for session ${session.id}`);
    // The webview posts 'ready' once its script loads; that repaints it.
  }

  /**
   * Bring a panel for `sessionId` to the foreground. A single panel is reused for
   * v1 — switching sessions rebinds the open webview to the new session. (The
   * mouth for several parallel chats is to keep a list of ChatPanel keyed by
   * sessionId and create a new one here instead of rebinding.)
   */
  private ensurePanel(sessionId: string): void {
    if (this.disposed) {
      return;
    }
    if (this.panel && this.panel.sessionId === sessionId) {
      this.panel.focus();
      return;
    }
    if (this.panel) {
      this.panel.sessionId = sessionId;
      this.panel.setTitle(this.panelTitle(sessionId));
      this.panel.focus();
      // The webview is already loaded; repaint it for the new session.
      this.postAllState();
      return;
    }
    this.panel = this.createPanel(sessionId);
    this.panel.focus();
    // A fresh panel posts 'ready' once its script loads, and we repaint then.
  }

  /** Full repaint of the open panel (used on session switch / panel rerender). */
  private postAllState(): void {
    this.currentPromptTokens = this.getLatestPromptTokens();
    this.post({ type: 'reset' });
    this.postState();
    this.postTree();
    this.postPath();
    this.postConfig();
    this.postContext();
    this.postSessionStats();
    this.postBackgrounds();
    void this.refreshBalance();
  }

  /** Messages from the webview, routed to the active session's handler. */
  private handlePanelMessage(message: any): void | Promise<void> {
    switch (message?.type) {
      case 'ready':
        this.postAllState();
        return;
      case 'userMessage':
        return this.onUserMessage(String(message.text ?? ''), message.attachments ?? []);
      case 'checkout':
        this.handleCheckout(String(message.id ?? ''));
        return;
      case 'setNodeSize':
        this.onSetNodeSize(String(message.id ?? ''), Math.round(Number(message.w)), Math.round(Number(message.h)));
        return;
      case 'killAgent':
        this.onKillAgent(String(message.id ?? ''));
        return;
      case 'deleteBranch':
        void this.deleteBranchInteractive(String(message.id ?? ''));
        return;
      case 'layoutDiagnostic':
        this.logLayoutDiagnostic(message.nodes, message.overlaps, message.connections, message.force);
        return;
      case 'pickImage':
        void this.handlePickImage();
        return;
      case 'stop':
        this.onStop();
        return;
      case 'setModel':
        this.onSetModel(String(message.model ?? ''));
        return;
      case 'setThinkingEffort':
        this.onSetThinkingEffort(String(message.effort ?? 'none') as ThinkingEffort);
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
        this.onKillBackground(Number(message.id));
        return;
      case 'clear':
        this.clear();
        return;
      default:
        return;
    }
  }

  private async onUserMessage(text: string, attachments: UserAttachment[] = []): Promise<void> {
    if (this.busy) {
      return;
    }
    if (Date.now() < this.controlHoldUntil) {
      this.postNotice('warning', 'An external controller is rebooting the window; please wait a moment.');
      return;
    }
    const userText = text.trim();

    // Only models that accept image input may carry image blocks; on a text-only
    // model DeepSeek returns a 400. Drop the attachments, send the text alone,
    // and tell the user to switch models rather than failing the request.
    if (attachments.length > 0 && !isVisionModel(this.model)) {
      const vision = visionModelsLabel();
      this.postNotice(
        'warning',
        'Images are not supported by the current model (' +
          (this.model || DEFAULT_MODEL) +
          '). ' +
          (vision
            ? `Switch to a vision model (${vision}) to attach or paste an image.`
            : 'No vision model is configured for this harness.'),
      );
      attachments = [];
    }

    // Upload any attached images to the DeepSeek Files API and reference them by
    // file_id via a `file` content block, instead of inlining base64. This keeps
    // the request body under the 48 MiB inline limit and lets each image be up to
    // 64 MiB. Image blocks are only allowed in user messages.
    let content: string | ContentPart[];
    if (attachments.length > 0) {
      this.setBusy(true);
      this.lastStatus = 'Uploading images…';
      this.post({ type: 'status', text: this.lastStatus });
      this.uploadController = new AbortController();
      const uploadSignal = this.uploadController.signal;
      const parts: ContentPart[] = [];
      if (userText) {
        parts.push({ type: 'text', text: userText });
      }
      const failed: string[] = [];
      for (const att of attachments) {
        try {
          const bytes = dataUrlBytes(att.dataUrl);
          const uploaded = await this.client.uploadFile(bytes, att.name || 'image', uploadSignal);
          parts.push({ type: 'file', file_id: uploaded.id });
        } catch (err) {
          if (uploadSignal.aborted) {
            // The user pressed Stop during upload: reset and do not send.
            this.uploadController = null;
            this.setBusy(false);
            this.lastStatus = 'Interrupted';
            this.post({ type: 'status', text: 'Interrupted' });
            this.post({ type: 'interrupted' });
            return;
          }
          failed.push(att.name || 'image');
          this.output.appendLine(`[image] upload failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      this.uploadController = null;
      if (failed.length > 0) {
        this.postNotice('warning', 'Could not upload: ' + failed.join(', ') + '. Those images were omitted.');
      }
      if (parts.length === 0) {
        // Nothing to send (no text and every upload failed).
        this.setBusy(false);
        this.lastStatus = '';
        this.post({ type: 'status', text: '' });
        return;
      }
      content = parts;
    } else {
      content = userText;
    }

    if (typeof content === 'string' && !content) {
      return;
    }
    if (Array.isArray(content) && content.length === 0) {
      return;
    }

    // Name a fresh session from its first user message (provisional: the
    // automatic namer replaces it with a model-generated title once the turn
    // finishes).
    const session = this.getActiveSession();
    if (session) {
      if (session.title === 'New session' && (userText || attachments.length > 0)) {
        session.title = (userText || 'New session').slice(0, 40);
        session.titleSource = 'provisional';
        this.onStateChanged?.();
      }
      session.updatedAt = Date.now();
    }

    // This turn becomes a new node, checked out as a child of the currently
    // selected node — a branch when that node already had children.
    const node = this.beginTurn(titleFromPrompt(userText || attachments[0]?.name || ''));
    if (!node) {
      return;
    }
    this.pushItem({ kind: 'user', text: userText, attachments });
    this.post({ type: 'user', text: userText, attachments });
    this.setBusy(true);
    this.lastStatus = 'Thinking…';
    this.post({ type: 'status', text: this.lastStatus });
    void this.agent.sendUserMessage(content);
  }

  private onSetModel(model: string): void {
    if (this.busy) {
      return;
    }
    if (!model || model === this.model) {
      return;
    }
    this.model = model;
    this.agent.setModel(model);
    this.contextWindow = this.getContextWindow(model);
    this.persistRuntimeConfig();
    this.postConfig();
    this.postContext();
    if (this.hasHistory()) {
      let notice =
        'Model changed to ' + model + '. Existing conversation history was produced under a different model, so the next request may miss the prompt cache and reprocess the full context.';
      if (!isVisionModel(model) && this.activeSessionHasImages()) {
        notice +=
          ' Image blocks are hidden for this text-only model (the image data is kept) and will be restored when you switch back to a vision model.';
      }
      this.postNotice('warning', notice);
    }
    this.output.appendLine(`[config] model=${model}`);
  }

  private onSetThinkingEffort(effort: ThinkingEffort): void {
    if (this.busy) {
      return;
    }
    if (effort === this.thinkingEffort) {
      return;
    }
    this.thinkingEffort = effort;
    this.agent.setThinkingEffort(effort);
    this.persistRuntimeConfig();
    this.postConfig();
    if (this.hasHistory()) {
      this.postNotice(
        'warning',
        'Thinking effort changed to "' + effort + '". This affects the next request; the prompt cache may be missed.',
      );
    }
    this.output.appendLine(`[config] thinkingEffort=${effort}`);
  }

  /** Open a file picker, read the chosen image, and send a base64 data URL back. */
  private async handlePickImage(): Promise<void> {
    const result = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
      openLabel: 'Attach Image',
    });
    if (!result || result.length === 0) {
      return;
    }
    const filePath = result[0].fsPath;
    try {
      const buffer = await fs.promises.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime =
        ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
      this.post({ type: 'imagePicked', dataUrl, name: path.basename(filePath) });
    } catch (err) {
      this.post({
        type: 'error',
        message: `Could not read image: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private onStop(): void {
    // Abort an in-flight image upload, then stop the agent turn if one is running.
    this.uploadController?.abort();
    this.agent.cancel();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.postState();
    this.onStateChanged?.();
  }

  /**
   * Push the busy/status state plus whether the session is locked (busy OR any
   * background terminal still running). The webview disables session switching
   * while locked so a session with running background jobs cannot be left.
   */
  private postState(): void {
    const reg = this.sessionRegistries.get(this.activeSessionId);
    const runningBg = reg ? reg.runningCount() > 0 : false;
    const sessionLocked = this.busy || runningBg;
    // `sessionId` lets the webview remember which session it shows (vscode.setState),
    // so a reloaded window can restore the tab bound to the same conversation.
    this.post({
      type: 'state',
      busy: this.busy,
      status: this.lastStatus,
      sessionLocked,
      sessionId: this.activeSessionId,
    });
  }

  // ---- Background terminal management ----

  /** True when the active session has at least one still-running background terminal. */
  private activeSessionHasRunningBackground(): boolean {
    const reg = this.sessionRegistries.get(this.activeSessionId);
    return reg ? reg.runningCount() > 0 : false;
  }

  private toBackgroundInfo(task: BackgroundTask): BackgroundInfo {
    const out = task.handle.getOutput().trim();
    const outputTail = out.length > 800 ? '…' + out.slice(-800) : out;
    return {
      id: task.id,
      command: task.command,
      status: task.status,
      exitCode: task.exitCode,
      killed: task.killed,
      elapsed: Math.round((Date.now() - task.startedAt) / 1000),
      truncated: task.truncated,
      outputTail,
      pendingDelivery: task.status === 'finished' && !task.delivered,
    };
  }

  private postBackgrounds(): void {
    // Background output can fire onUpdated many times per second. Coalesce UI
    // refreshes so a chatty process cannot freeze the webview.
    if (this.bgFlushTimer != null) {
      return;
    }
    this.bgFlushTimer = setTimeout(() => {
      this.bgFlushTimer = null;
      this.postBackgroundsNow();
    }, 200);
  }

  private postBackgroundsNow(): void {
    const t0 = Date.now();
    const reg = this.sessionRegistries.get(this.activeSessionId);
    // Show running jobs plus finished ones still awaiting delivery (their notice
    // has not reached the agent yet). Delivered jobs drop out, so the list never
    // accumulates stale entries.
    const tasks = reg
      ? reg
          .list()
          .filter((t) => t.status === 'running' || (t.status === 'finished' && !t.delivered))
          .map((t) => this.toBackgroundInfo(t))
      : [];
    this.post({ type: 'background', tasks });
    this.postState();
    perf(() => `backgrounds ${Date.now() - t0}ms tasks=${tasks.length}`);
  }

  /** Mark a task's completion notice as delivered so it leaves the pending panel. */
  private markDelivered(sessionId: string, taskId: number): void {
    const reg = this.sessionRegistries.get(sessionId);
    const task = reg?.get(taskId);
    if (task) {
      task.delivered = true;
    }
  }

  /**
   * Called when a background terminal transitions to finished (naturally or via
   * kill). Builds the notice, queues it, and drains immediately — delivering now
   * if the agent is idle, or waiting for the current turn to finish otherwise.
   */
  private onBackgroundFinished(sessionId: string, task: BackgroundTask): void {
    if (this.disposed) {
      return;
    }
    if (task.notifyAgent !== true) {
      // Tool-initiated kill/join already informed the agent via the tool result, so
      // the task is considered delivered and leaves the pending panel state.
      task.delivered = true;
      this.postBackgrounds();
      return;
    }
    const notice = this.buildBackgroundNotice(task);
    if (sessionId !== this.activeSessionId) {
      // Defensive: a background task for a non-active session finished. The
      // session lock normally prevents this; fall back to a UI-only notice.
      this.postNotice('info', notice.text);
      return;
    }
    this.backgroundNotifQueue.push({ ...notice, sessionId });
    this.scheduleBackgroundDrain();
  }

  /**
   * Coalesce idle background-notice delivery: several jobs finishing in quick
   * succession while the agent is idle are batched into a single turn instead of
   * one turn each. While the agent is busy the notices simply stay queued and are
   * drained when the current turn ends.
   */
  private scheduleBackgroundDrain(): void {
    if (this.busy) {
      return;
    }
    if (this.backgroundDrainTimer != null) {
      return;
    }
    this.backgroundDrainTimer = setTimeout(() => {
      this.backgroundDrainTimer = null;
      this.drainBackgroundQueue();
    }, 75);
  }

  private buildBackgroundNotice(task: BackgroundTask): Omit<BackgroundNotice, 'sessionId'> {
    const cmd = this.truncateField(task.command, 100);
    const doneText = task.killed
      ? 'was killed by the user'
      : `finished with exit code ${task.exitCode ?? 'unknown'}`;
    const output = this.truncateField(task.handle.getOutput().trim(), 1200);
    const text = `Background command \`${cmd}\` (id ${task.id}) ${doneText}.${output ? `\nOutput:\n${output}` : ''}`;
    return { taskId: task.id, id: task.id, cmd, doneText, output, text };
  }

  private truncateField(value: string, limit: number): string {
    return value.length > limit ? value.slice(0, limit) + '…' : value;
  }

  /** Combine several queued notices into one agent-facing message. */
  private combineNotices(notices: BackgroundNotice[]): string {
    if (notices.length === 1) {
      return notices[0].text;
    }
    const lines = notices.map((n) => `- ${n.text}`);
    return `[Background terminal notice] ${notices.length} background tasks finished:\n${lines.join('\n')}`;
  }

  /**
   * Deliver a batch of background-completion notices: render one card per notice
   * in the webview, then start a single turn with a combined message so the
   * agent reacts once (instead of one auto-turn per finished job). Re-queues if
   * the agent became busy in the meantime.
   */
  private injectBackgroundNotices(notices: BackgroundNotice[]): void {
    if (this.disposed) {
      return;
    }
    if (notices.length === 0) {
      return;
    }
    if (this.busy) {
      this.backgroundNotifQueue.push(...notices);
      return;
    }
    // The notice turn is a new node, checked out under the currently selected
    // node, so the cards and the agent's reply land in their own block.
    const title =
      notices.length === 1
        ? `Background #${notices[0].id}: ${notices[0].cmd}`
        : `Background: ${notices.length} tasks finished`;
    if (!this.beginTurn(titleFromPrompt(title))) {
      this.backgroundNotifQueue.push(...notices);
      return;
    }
    for (const n of notices) {
      // The notice is now reaching the agent, so the task leaves the pending panel.
      this.markDelivered(n.sessionId, n.taskId);
      this.pushItem({ kind: 'background', id: String(n.id), name: n.cmd, doneText: n.doneText, content: n.output });
      this.post({
        type: 'backgroundNotice',
        item: { id: n.id, name: n.cmd, doneText: n.doneText, content: n.output },
      });
    }
    // Refresh the panel so the just-delivered jobs drop out of the pending list.
    this.postBackgrounds();
    this.lastStatus = 'Background terminal finished';
    this.setBusy(true);
    this.post({ type: 'status', text: this.lastStatus });
    this.agent.sendUserMessage(this.combineNotices(notices));
  }

  /** True when the task was later joined or killed via a tool (or no longer exists). */
  private taskAlreadyHandled(sessionId: string, taskId: number): boolean {
    const reg = this.sessionRegistries.get(sessionId);
    const task = reg?.get(taskId);
    if (!task) {
      // The task was removed (cleared session / deleted); its notice is stale.
      return true;
    }
    return task.notifyAgent !== true;
  }

  /**
   * After a turn ends, deliver any background-completion notifications queued
   * while it was running. Deferred a tick so the previous turn's finally block
   * has reset agent.running to false (otherwise sendUserMessage rejects). Drops
   * notices for tasks already handled by a join/kill instead of delivering them.
   */
  private drainBackgroundQueue(): void {
    if (this.busy) {
      return;
    }
    const queue = this.backgroundNotifQueue;
    // Collect every real (not already handled) notice for the active session so
    // they can be delivered together in one turn rather than one per turn.
    const real: BackgroundNotice[] = [];
    let i = 0;
    while (i < queue.length) {
      const q = queue[i];
      if (q.sessionId !== this.activeSessionId) {
        i++;
        continue;
      }
      if (this.taskAlreadyHandled(q.sessionId, q.taskId)) {
        // The agent already handled this task via join/kill (or it was removed):
        // drop the stale notice and treat the job as delivered so it also leaves
        // the pending panel.
        this.markDelivered(q.sessionId, q.taskId);
        queue.splice(i, 1);
        continue;
      }
      real.push(queue.splice(i, 1)[0]);
    }
    if (real.length === 0) {
      // Only stale notices were dropped; refresh so those jobs leave the pending panel.
      this.postBackgrounds();
      return;
    }
    setTimeout(() => {
      if (this.busy) {
        this.backgroundNotifQueue.push(...real);
        return;
      }
      this.injectBackgroundNotices(real);
    }, 0);
  }

  /** Kill a background terminal from the UI's Background panel. */
  private onKillBackground(id: number): void {
    const reg = this.sessionRegistries.get(this.activeSessionId);
    if (!reg) {
      return;
    }
    const task = reg.get(id);
    if (!task) {
      return;
    }
    if (task.status !== 'running') {
      this.postNotice('info', `Background terminal ${id} is not running.`);
      return;
    }
    // User-initiated kill: notify the agent (queue if busy, deliver if idle).
    reg.kill(id, { notifyAgent: true });
    this.postBackgrounds();
  }

  /** Kill every running background terminal (session delete / extension dispose). */
  dispose(): void {
    this.disposed = true;
    if (this.streamFlushTimer != null) {
      clearTimeout(this.streamFlushTimer);
      this.streamFlushTimer = null;
    }
    if (this.bgFlushTimer != null) {
      clearTimeout(this.bgFlushTimer);
      this.bgFlushTimer = null;
    }
    if (this.backgroundDrainTimer != null) {
      clearTimeout(this.backgroundDrainTimer);
      this.backgroundDrainTimer = null;
    }
    if (this.titleDrainTimer != null) {
      clearTimeout(this.titleDrainTimer);
      this.titleDrainTimer = null;
    }
    this.titleJob?.controller.abort();
    this.titleJob = null;
    this.titlePending.clear();
    setPerfSink(null);
    for (const reg of this.sessionRegistries.values()) {
      reg.killAll();
    }
    this.cleanupSubAgents();
    // Deliberately NOT disposing the webview panel: disposing closes the editor
    // tab, and the tab must outlive the extension host so VS Code can hand it
    // back through the webview panel serializer on the next activation
    // (restorePanel). VS Code tears the webview down with the extension host.
    this.panel = null;
    this.output.dispose();
  }

  private logUsage(usage: Usage): void {
    this.output.appendLine(
      `[usage] total=${usage.total_tokens} prompt=${usage.prompt_tokens} ` +
        `completion=${usage.completion_tokens} ` +
        `cache_hit=${usage.prompt_cache_hit_tokens ?? 0} ` +
        `cache_miss=${usage.prompt_cache_miss_tokens ?? 0}`,
    );
  }

  private handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'status':
        this.lastStatus = event.text;
        this.post({ type: 'status', text: event.text });
        break;
      case 'streamDelta':
        this.appendDelta(event.content);
        break;
      case 'reasoningDelta':
        this.appendThinkingDelta(event.content);
        break;
      case 'assistantDone':
        this.flushStreamDeltas();
        break;
      case 'usage':
        this.flushStreamDeltas();
        this.logUsage(event.usage);
        this.currentPromptTokens = event.usage.prompt_tokens;
        this.postContext();
        {
          // The turn's usage belongs on the turn's window: the assistant bubble
          // for a text answer, or the tool call card for a tool-call turn. Attach
          // it to whichever item concluded the turn (the last item) so the token
          // count shows in place and is never hoisted into an empty message bubble.
          const last = this.displayItems[this.displayItems.length - 1];
          if (last && (last.kind === 'assistant' || last.kind === 'tool') && !last.error) {
            last.usage = event.usage;
          }
          this.post({ type: 'usage', usage: event.usage });
        }
        // Recompute the session totals after this turn's usage is attached to the
        // display items, so the cumulative counters include the turn just finished.
        this.postSessionStats();
        break;
      case 'toolCallDelta':
        this.queueToolCallDelta(event.index, event.id, event.name, event.args);
        break;
      case 'toolStart':
        this.flushStreamDeltas();
        // Once a tool call starts running, reflect it in the header instead of
        // the generic "Thinking…".
        if (event.name) {
          this.lastStatus = `Calling ${event.name}…`;
          this.post({ type: 'status', text: this.lastStatus });
        }
        this.pushItem({
          kind: 'tool',
          id: event.id,
          name: event.name,
          args: clipForUi(event.args, 8 * 1024),
          status: 'running',
        });
        this.post({
          type: 'toolStart',
          id: event.id,
          name: event.name,
          args: clipForUi(event.args, 8 * 1024),
          index: event.index,
        });
        break;
      case 'toolEnd':
        this.updateToolItem(event.id, event.content);
        this.post({
          type: 'toolEnd',
          id: event.id,
          name: event.name,
          content: clipForUi(event.content),
        });
        break;
      case 'done':
        this.flushStreamDeltas();
        this.setBusy(false);
        // Preserve an informative final status (e.g. loop-limit note) if one was
        // set; otherwise fall back to a simple "Done".
        if (!this.lastStatus || this.lastStatus === 'Thinking…') {
          this.lastStatus = 'Done';
        }
        this.post({ type: 'status', text: this.lastStatus });
        this.post({ type: 'done' });
        this.finishTurn('done');
        void this.refreshBalance();
        this.drainBackgroundQueue();
        this.drainSubAgentNotices();
        break;
      case 'interrupted':
        this.flushStreamDeltas();
        this.lastStatus = 'Interrupted';
        this.setBusy(false);
        this.post({ type: 'interrupted' });
        // Remember where the stop landed so a turn that continues from this same
        // node still gets the interruption notice.
        this.lastInterruptedNodeId = this.activeTurnNode?.id ?? null;
        this.finishTurn('interrupted');
        void this.refreshBalance();
        this.drainBackgroundQueue();
        this.drainSubAgentNotices();
        break;
      case 'error':
        this.flushStreamDeltas();
        this.lastStatus = 'Error';
        this.pushItem({ kind: 'assistant', text: `⚠️ ${event.message}`, error: true });
        this.post({ type: 'error', message: event.message });
        this.setBusy(false);
        this.finishTurn('error');
        void this.refreshBalance();
        this.drainBackgroundQueue();
        this.drainSubAgentNotices();
        break;
      default:
        break;
    }
  }

  private pushItem(item: DisplayItem): void {
    this.displayItems.push(item);
  }

  private appendDelta(text: string): void {
    this.pendingTextDelta += text;
    this.scheduleStreamFlush();
  }

  private appendThinkingDelta(text: string): void {
    this.pendingThinkingDelta += text;
    this.scheduleStreamFlush();
  }

  private commitTextDelta(text: string): void {
    const last = this.displayItems[this.displayItems.length - 1];
    if (last && last.kind === 'assistant' && !last.error) {
      last.text = (last.text ?? '') + text;
    } else {
      this.displayItems.push({ kind: 'assistant', text });
    }
  }

  private commitThinkingDelta(text: string): void {
    const last = this.displayItems[this.displayItems.length - 1];
    if (last && last.kind === 'assistant' && !last.error) {
      last.thinking = (last.thinking ?? '') + text;
    } else {
      this.displayItems.push({ kind: 'assistant', thinking: text });
    }
  }

  private queueToolCallDelta(index: number, id?: string, name?: string, args?: string): void {
    const existing = this.pendingToolDeltas.get(index) ?? { id, name: '', args: '' };
    if (id) {
      existing.id = id;
    }
    if (name) {
      existing.name += name;
    }
    if (args) {
      existing.args += args;
    }
    this.pendingToolDeltas.set(index, existing);
    this.scheduleStreamFlush();
  }

  private scheduleStreamFlush(): void {
    if (this.streamFlushTimer != null) {
      return;
    }
    this.streamFlushTimer = setTimeout(() => {
      this.streamFlushTimer = null;
      this.flushStreamDeltas();
    }, 50);
  }

  private flushStreamDeltas(): void {
    if (this.streamFlushTimer != null) {
      clearTimeout(this.streamFlushTimer);
      this.streamFlushTimer = null;
    }
    const text = this.pendingTextDelta;
    const thinking = this.pendingThinkingDelta;
    const tools = this.pendingToolDeltas.size;
    if (!text && !thinking && tools === 0) {
      return;
    }
    this.pendingTextDelta = '';
    this.pendingThinkingDelta = '';
    const bytes = text.length + thinking.length;
    this.streamFlushCount++;
    this.streamFlushBytes += bytes;
    const now = Date.now();
    if (this.streamFlushWindow === 0) {
      this.streamFlushWindow = now;
    }
    if (text) {
      this.commitTextDelta(text);
      this.post({ type: 'delta', text });
    }
    if (thinking) {
      this.commitThinkingDelta(thinking);
      this.post({ type: 'thinkingDelta', text: thinking });
    }
    if (tools > 0) {
      for (const [index, draft] of this.pendingToolDeltas) {
        this.post({
          type: 'toolCallDelta',
          index,
          id: draft.id,
          name: draft.name,
          args: clipForUi(draft.args, 8 * 1024),
        });
      }
      this.pendingToolDeltas.clear();
    }
    if (now - this.streamFlushWindow >= 2000) {
      perf(
        () =>
          `stream-flush n=${this.streamFlushCount} bytes=${this.streamFlushBytes} ` +
          `window=${now - this.streamFlushWindow}ms items=${this.displayItems.length}`,
      );
      this.streamFlushCount = 0;
      this.streamFlushBytes = 0;
      this.streamFlushWindow = now;
    }
  }

  private updateToolItem(id: string, content: string): void {
    const item = this.displayItems.find((it) => it.kind === 'tool' && it.id === id);
    if (item) {
      item.status = 'done';
      item.content = clipForUi(content);
    }
  }

  private post(message: unknown): void {
    this.panel?.post(message);
  }

  private getHtml(webview: vscode.Webview): string {
    // A cache-busting version suffix so the webview re-fetches media files when
    // they change (asWebviewUri does not change with file content).
    const v = this.mediaVersion;
    const withV = (uri: string) => `${uri}${uri.includes('?') ? '&' : '?'}v=${v}`;
    const scriptUri = withV(String(webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js'))));
    const markdownItUri = withV(String(webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'markdown-it.min.js'))));
    const treeUri = withV(String(webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'tree.js'))));
    // Vendored, pinned tree-layout engine (non-layered-tidy-tree-layout@2.0.2, MIT).
    // Not an npm dependency — see media/vendor/non-layered-tidy-tree-layout/PROVENANCE.md.
    const layoutEngineUri = withV(String(webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'vendor', 'non-layered-tidy-tree-layout', 'dist', 'non-layered-tidy-tree-layout.js'))));
    const styleUri = withV(String(webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'style.css'))));
    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}';" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Agent Harness</title>
</head>
<body>
  <div id="tree-toolbar">
    <button id="follow-btn" class="active" title="Follow the active node">⦿</button>
    <button id="fit-btn" title="Fit the tree to view">⤢</button>
  </div>
  <div id="tree-wrap">
    <div id="tree-canvas">
      <svg id="tree-edges"></svg>
    </div>
  </div>
  <div id="bg-panel" class="hidden">
    <div id="bg-head">
      <span class="bg-title">Background</span>
      <span id="bg-count" class="bg-count"></span>
    </div>
    <div id="bg-list"></div>
  </div>
  <div id="composer">
    <div id="branch-banner" class="hidden"></div>
    <div id="attachments"></div>
    <div id="composer-row">
      <textarea id="input" placeholder="Ask the agent… (Enter to send, Shift+Enter for newline)" rows="1" spellcheck="false" autocorrect="off" autocapitalize="off" autocomplete="off"></textarea>
      <div id="composer-controls">
        <button id="attach-btn" class="icon-btn" title="Attach image" aria-label="Attach image">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <select id="model-select" title="Model"></select>
        <select id="effort-select" title="Thinking effort">
          <option value="none">none</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
        <div id="actions">
          <button id="stop-btn" class="hidden">Stop</button>
          <button id="send-btn">Send</button>
        </div>
      </div>
    </div>
    <div id="meter-row-readout" title="Session prompt-cache hit rate + wallet">
      <span id="status-dot" class="dot idle"></span>
      <span id="status-text"></span>
      <span id="metrics">
        <span id="context" title="Context window usage">
          <span id="context-label">ctx 0%</span>
        </span>
        <span id="stat-balance">bal –</span>
        <span id="tps-meter" title="Token generation rate (realtime estimate)">
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
