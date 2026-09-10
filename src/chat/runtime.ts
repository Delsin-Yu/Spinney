/**
 * SessionRuntime — everything that belongs to one session, plus its in-flight
 * turn(s). P1 moved per-session and per-turn state out of `ChatViewProvider` so
 * the provider can be a pure coordinator (sessions on disk, tabs, titles,
 * transcripts, the control plane) and each session can stream on its own.
 *
 * Two notions that used to be one are now separate (see
 * `docs/agents/multi-session.md` §2.1):
 *
 *  - **view focus** = `session.activeNodeId`: which branch the tab expands,
 *    where the composer docks, what `path` describes. `checkoutNode` moves it
 *    and repaints — it must never touch the agent history while a run is live.
 *  - **turn basis** = the node a `TurnRun` is bound to (`run.nodeId`): the agent
 *    history is (re)based only at `beginTurn`, the one safe moment, and a run
 *    writes exclusively into `run.node`'s messages/displayItems.
 *
 * Consequently every streaming message carries an explicit `nodeId`; the
 * webview never infers the stream target from the view.
 *
 * P3 runs several turns of one session at the same time, one per **node**: every
 * node that has ever run a turn owns a *worker* — its own `Agent` (whose event
 * handler, sub-agent and hop/session hooks all close over that node) plus its own
 * `ToolRegistry` (whose background owner is that node) — see
 * `docs/agents/multi-session.md` §2.3. A run is keyed by its node, so a new turn
 * is refused only when the node it would continue from is itself streaming, and
 * the interruption notice is bookkept per node so concurrent branches cannot
 * clobber each other.
 *
 * The runtime reaches the provider through the narrow `RuntimeHost` interface
 * (transcripts, config, persistence, panel routing, the global hop bookkeeping).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Agent } from '../agent/agent';
import { DeepSeekBalance, DeepSeekClient } from '../agent/deepseek';
import { AgentEvent, ChatMessage, ContentPart, ThinkingEffort, Usage } from '../agent/types';
import {
  DEFAULT_MODEL,
  isKnownModel,
  isVisionModel,
  modelIds,
  visionModelIds,
  visionModelsLabel,
} from '../agent/models';
import {
  AgentSession,
  DisplayItem,
  TreeNode,
  TurnStatus,
  UserAttachment,
  attachNode,
  createNode,
  newId,
  nodeUsage,
  pathIds,
  pathMessages,
  sessionEffortPick,
  sessionModelPick,
  titleFromPrompt,
} from './tree';
import { ToolRegistry } from '../tools';
import { BackgroundTask } from '../tools/background';
import { BackgroundHub, BackgroundOwner } from './backgroundHub';
import { SubAgentPool } from './SubAgentPool';
import { sumUsage, summarizeTranscript } from './transcript';
import { perf } from '../perf';

/** Cap tool output stored/shown in the webview so a 16 MiB command dump cannot freeze the UI. */
export const UI_TOOL_CONTENT_CAP = 32 * 1024;

export function clipForUi(text: string, cap = UI_TOOL_CONTENT_CAP): string {
  if (text.length <= cap) {
    return text;
  }
  return `${text.slice(0, cap)}\n…[truncated ${text.length - cap} chars for UI]`;
}

/** Shrink tool cards in the UI transcript; agent `messages` keep the full tool payload. */
export function clipDisplayItem(item: DisplayItem): DisplayItem {
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
export const STORAGE_MESSAGE_CAP = 64 * 1024;

export function clipMessageForStorage(msg: ChatMessage): ChatMessage {
  if (typeof msg.content === 'string' && msg.content.length > STORAGE_MESSAGE_CAP) {
    return { ...msg, content: clipForUi(msg.content, STORAGE_MESSAGE_CAP) };
  }
  return msg;
}

/**
 * The shape `ChatViewProvider.getConfig()` returns. Both sides need the type, so
 * it lives here next to the runtime that consumes most of it.
 */
export interface HarnessConfig {
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
}

/** One sub-agent run: its dispatch spec plus the tree node that owns it. */
export interface SubAgentJob {
  spec: { instruction: string; write: boolean; model?: string };
  node: TreeNode;
  resume?: boolean;
  /** Session the node belongs to (for the transcript folder; falls back to active). */
  sessionId?: string;
}

/** A background terminal summarized for the webview UI. */
interface BackgroundInfo {
  id: number;
  /** The node that owns the job — its card renders the dock (P2). */
  nodeId: string;
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
  text: string;
  /** The background-terminal id, used to drop a notice the agent already handled via join/kill. */
  taskId: number;
  /** The node the job belongs to: the notice turn is based on it, never on the view. */
  nodeId: string;
  /** Card fields: task id, command, status phrase, and output tail. */
  id: number;
  cmd: string;
  doneText: string;
  output: string;
}

/**
 * One send = one new node (or, for an injected turn, one existing node it
 * continues). Holds the streaming basis and the coalescing buffers for exactly
 * that node, so a view change can never redirect the stream.
 */
export interface TurnRun {
  nodeId: string;
  node: TreeNode;
  /** The agent that streams this run: the worker of `node` (P3, §2.3). */
  agent: Agent;
  /** Streaming target: always `node.displayItems`. */
  items: DisplayItem[];
  /** Length of the flat path before this run; the run's messages are sliced from it. */
  prefixLen: number;
  /**
   * The message that sat at `prefixLen - 1` when the run started. Identity, not
   * equality: if the agent's history was swapped mid-run this no longer matches
   * and `finishTurn` refuses to write the slice.
   */
  prefixTail: ChatMessage | null;
  /** True when this run created its node (a user turn), false for an injected turn. */
  fresh: boolean;
  pendingText: string;
  pendingThinking: string;
  pendingTools: Map<number, { id?: string; name: string; args: string }>;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * The provider surface the runtime may use. Kept deliberately narrow: anything
 * about sessions-on-disk, tabs, titles, transcripts, config or the global hop
 * bookkeeping stays on the provider.
 */
export interface RuntimeHost {
  readonly output: vscode.OutputChannel;
  /** True once the provider is tearing down; suppresses async deliveries. */
  readonly disposed: boolean;
  getConfig(): HarnessConfig;
  persist(): void;
  stateChanged(): void;
  /**
   * Remember an explicit per-session pick as the **default for future sessions**:
   * the persisted `agentHarness.runtimeConfig` record plus the provider's
   * `defaultModel` / `defaultThinkingEffort` seeds. P4 moved the live selection
   * onto the session (`session.model` / `session.effort`, written by `setModel` /
   * `setThinkingEffort` and saved with `persist()`), so this call must never
   * overwrite another session's own choice — it only seeds the next one.
   */
  persistRuntimeConfig(model: string, thinkingEffort: ThinkingEffort): void;
  postTo(sessionId: string, message: unknown): void;
  transcriptRoot(): string;
  transcriptDir(sessionId: string): string;
  dumpSessionTranscript(node: TreeNode, session: AgentSession, status: TurnStatus): void;
  writeSubAgentTranscript(
    job: SubAgentJob,
    subAgent: Agent,
    status: string,
    summary: string,
    startedAt: number,
  ): string | undefined;
  getContextWindow(model: string): number;
  systemPrompt(): string;
  requestAutoTitle(session: AgentSession): void;
  resolveModel(candidate: string): string;
  handleHopSession(rt: SessionRuntime, node: TreeNode, args: Record<string, unknown>): string;
  handleRenameSession(args: Record<string, unknown>): string;
  queueHopReturn(rt: SessionRuntime, node: TreeNode | null, status: TurnStatus): void;
  /**
   * True while an external controller is reloading the window (`/wait-for-finish`
   * with a hold). Every turn start — including an injected notice turn — must
   * check it: `/reload-window` refuses to run while a turn does.
   */
  isHeld(): boolean;
}

/** Decode the base64 payload of a `data:<mime>;base64,<data>` URL into bytes. */
function dataUrlBytes(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Buffer.from(base64, 'base64');
}

export class SessionRuntime {
  readonly sessionId: string;
  readonly session: AgentSession;

  private readonly client: DeepSeekClient;

  // ---- per-run / per-session state (moved off the provider in P1) ----
  /**
   * The window-level background hub. Registries live per (session, node), so a
   * job belongs to the node whose turn spawned it and never leaks into another
   * session/branch.
   */
  readonly hub: BackgroundHub;
  busy = false;
  lastStatus = '';
  currentPromptTokens = 0;
  /** Aborts an in-flight image upload (attachment path) when the user stops. */
  uploadController: AbortController | null = null;

  /**
   * One worker per node that has ever run a turn (P3, §2.3). Its `Agent`'s event
   * handler and every provider hook it exposes close over that node, and its
   * `ToolRegistry` mints background jobs under that node — so nothing ever has to
   * ask "which run is this?". Created lazily by `workerFor`.
   */
  private readonly nodeWorkers = new Map<string, { agent: Agent; tools: ToolRegistry }>();
  /**
   * Nodes whose agent currently holds a pending interruption notice (P3), keyed
   * by node id so a concurrent branch's interruption cannot clobber this one. A
   * new run on node M inherits its parent P's notice (`transferInterruptTo`) only
   * when P is in here, and otherwise clears its own stale notice — the P1 rule,
   * made per node.
   */
  private readonly interruptedNodes = new Map<string, Agent>();

  /** Live turns, keyed by the node each is bound to. P3: several may coexist. */
  readonly runs = new Map<string, TurnRun>();

  /** Concurrency pool for the main agent's level-1 sub-agents (per session). */
  readonly subAgentPool: SubAgentPool;
  /** Per-parent count of level-2 sub-agents spawned (budgeted by maxLevel2Subagents). */
  readonly level2Counts = new Map<string, number>();
  /** Running sub-agents: agentNodeId -> { agent, abort } for individual kill. */
  readonly runningSubAgents = new Map<string, { agent: Agent; abort: AbortController }>();
  /** Sub-agent completion notifications queued for the parent (async mode). */
  readonly subAgentNoticeQueue: Array<{ nodeId: string; summary: string; status: string; count?: number }> = [];
  /** Async depth-2 results queued for a still-running sub-agent parent, resumed on its finish. */
  readonly subAgentChildNotices = new Map<string, Array<{ message: string }>>();
  private lastSubAgentDrain: ReturnType<typeof setTimeout> | null = null;

  /** Background-completion notifications waiting for the agent to go idle. */
  private backgroundNotifQueue: BackgroundNotice[] = [];
  /** Coalesces idle background-notice delivery so a burst of finishes batches into one turn. */
  private backgroundDrainTimer: ReturnType<typeof setTimeout> | null = null;
  /** Coalesces background UI refreshes (chatty processes fire onUpdated many times/s). */
  private bgFlushTimer: ReturnType<typeof setTimeout> | null = null;

  // Streaming perf counters (reset on a 2s window; see flushStreamDeltas).
  private streamFlushCount = 0;
  private streamFlushBytes = 0;
  private streamFlushWindow = 0;

  /**
   * The model/thinking-effort of this session. Seeded at construction from the
   * session's own pick when it still shadows the setting it was made under, else
   * from the provider's defaults (`agentHarness.runtimeConfig`, then the
   * settings); a change made here is written back onto `this.session` and saved
   * with it (P4). Every node worker is seeded/pushed from these two fields, so a
   * session's branches all run the same selection.
   */
  model: string;
  thinkingEffort: ThinkingEffort;
  contextWindow: number;

  /** Set by `dispose()`: a deleted session's runtime must stop delivering. */
  private disposed = false;

  constructor(
    private readonly host: RuntimeHost,
    session: AgentSession,
    client: DeepSeekClient,
    model: string,
    thinkingEffort: ThinkingEffort,
    hub: BackgroundHub,
  ) {
    this.session = session;
    this.sessionId = session.id;
    this.client = client;
    this.model = model;
    this.thinkingEffort = thinkingEffort;
    this.contextWindow = host.getContextWindow(model);
    this.hub = hub;

    // A fresh sub-agent pool + budget for this session.
    this.subAgentPool = new SubAgentPool(this.host.getConfig().maxConcurrentSubagents);

    // P3: there is deliberately no session-wide agent any more. Node workers are
    // created lazily by `workerFor`, and a node's agent history is built only when
    // a run starts on it (`beginTurn` / `beginInjectedTurn`), so construction has
    // nothing to (re)base — it only seeds the view-derived counters.
    this.currentPromptTokens = this.getLatestPromptTokens();

    // Deliver any background-completion notice queued for this session (e.g. it
    // finished while the agent was busy and the user switched away before the
    // drain ran).
    this.drainBackgroundQueue();
  }

  /**
   * The worker for a node, created on first use (P3, §2.3). Its tools register
   * background jobs under **this** node, and its agent's provider hooks all close
   * over the same node, so a `spawn_agents` / `send_agent_message` / `hop_session`
   * call made during node X's turn always acts for X — never for "the active
   * turn", which no longer exists once two branches may run at once. Model and
   * thinking effort are seeded from this runtime's current (per-session) values.
   */
  private workerFor(node: TreeNode): { agent: Agent; tools: ToolRegistry } {
    let worker = this.nodeWorkers.get(node.id);
    if (!worker) {
      const tools = new ToolRegistry();
      // `search_transcripts` reads the harness's own transcript dumps; the roots
      // depend on config + global storage, so hand it a live resolver.
      tools.setTranscriptRoots(() => [this.host.transcriptRoot()]);
      // One access object per node: registries live per (session, node) inside the
      // hub, so a job belongs to the branch whose turn spawned it and a task id
      // stays session-local.
      tools.setBackgroundAccess({
        currentOwner: () => ({ sessionId: this.sessionId, nodeId: node.id }),
        hub: this.hub,
      });
      const agent = new Agent(this.client, tools, (event) => this.handleAgentEventFor(node, event), this.host.getConfig().maxTurns);
      agent.setModel(this.model);
      agent.setThinkingEffort(this.thinkingEffort);
      // This agent can spawn sub-agents: hand it this runtime's orchestrator,
      // bound to the same node.
      agent.setSpawnHandler((args, signal) => this.handleSpawnAgents(node, args, signal));
      // And it can resume a finished sub-agent with a follow-up message.
      agent.setSendMessageHandler((args, signal) => this.handleSendAgentMessage(node, args, signal));
      // And it can hand a self-contained task to a fresh session, which reports
      // its answer back here (only the main agent may do this).
      agent.setCanHop(true);
      agent.setHopHandler((args) => Promise.resolve(this.host.handleHopSession(this, node, args)));
      agent.setListNodeHandler(() => Promise.resolve(this.handleListNodes(node)));
      // And it can rename the session (an explicit rename locks the title, so the
      // automatic namer leaves it alone).
      agent.setRenameSessionHandler((args) => Promise.resolve(this.host.handleRenameSession(args)));
      worker = { agent, tools };
      this.nodeWorkers.set(node.id, worker);
    }
    return worker;
  }

  // ---- Queries used by the coordinator ----

  /** True while a turn (or its image upload) is in flight. */
  isRunning(): boolean {
    return this.busy || this.runs.size > 0;
  }

  /** Node ids with a live run. */
  runningNodes(): string[] {
    return [...this.runs.keys()];
  }

  /** True while any node worker's agent is mid-turn (defensive; see `isRunning`). */
  agentRunning(): boolean {
    for (const worker of this.nodeWorkers.values()) {
      if (worker.agent.running) {
        return true;
      }
    }
    return false;
  }

  /** True while this session owns at least one running background job. */
  hasRunningBackground(): boolean {
    return this.runningBackgroundCount() > 0;
  }

  /** How many background jobs of this session are still running. */
  runningBackgroundCount(): number {
    return this.hub.listForSession(this.sessionId).filter((hit) => hit.task.status === 'running').length;
  }

  /**
   * The nodes of this session that own at least one still-running background job.
   * The control plane reports it so a controller (or a test) can verify that a job
   * stayed with the branch that spawned it while the view moved elsewhere.
   */
  backgroundNodes(): string[] {
    const nodes: string[] = [];
    for (const hit of this.hub.listForSession(this.sessionId)) {
      if (hit.task.status === 'running' && !nodes.includes(hit.owner.nodeId)) {
        nodes.push(hit.owner.nodeId);
      }
    }
    return nodes;
  }

  /**
   * Running background jobs owned by any of these nodes. The delete/clear paths
   * use it to decide whether a "kill them too?" confirmation is needed.
   */
  runningBackgroundsForNodes(ids: string[]): number {
    let n = 0;
    for (const id of ids) {
      n += this.hub.runningForNode(this.sessionId, id);
    }
    return n;
  }

  runningSubAgentCount(): number {
    return this.runningSubAgents.size;
  }

  hasRunningSubAgent(id: string): boolean {
    return this.runningSubAgents.has(id);
  }

  /** The system prompt this session would send on its next request. */
  systemPromptText(): string {
    return Agent.systemPrompt(this.model, this.thinkingEffort);
  }

  /** Tear down: kill background jobs, abort sub-agents, cancel timers. */
  dispose(): void {
    this.disposed = true;
    if (this.backgroundDrainTimer != null) {
      clearTimeout(this.backgroundDrainTimer);
      this.backgroundDrainTimer = null;
    }
    if (this.bgFlushTimer != null) {
      clearTimeout(this.bgFlushTimer);
      this.bgFlushTimer = null;
    }
    if (this.lastSubAgentDrain != null) {
      clearTimeout(this.lastSubAgentDrain);
      this.lastSubAgentDrain = null;
    }
    for (const run of this.runs.values()) {
      if (run.flushTimer != null) {
        clearTimeout(run.flushTimer);
        run.flushTimer = null;
      }
    }
    // Kill and forget every job this session owns (registries are per node).
    this.hub.removeSession(this.sessionId, { kill: true });
    this.cleanupSubAgents();
    // Drop every node worker (and its agent) with the runtime.
    this.nodeWorkers.clear();
    this.interruptedNodes.clear();
  }

  /** True once the runtime (or the whole extension) is shutting down. */
  private get dead(): boolean {
    return this.disposed || this.host.disposed;
  }

  private post(message: unknown): void {
    this.host.postTo(this.sessionId, message);
  }

  // ---- Configuration ----

  /**
   * The tab's own model pick (P4). Refused while a turn streams (a mid-turn swap
   * invalidates the request the agent is building) and while the selection is
   * unchanged, exactly like the old provider-side handler.
   */
  setModel(model: string): void {
    this.changeModel(model, true);
  }

  /**
   * Adopt a changed `agentHarness.model` setting. Only a session with no
   * effective pick follows it — an explicit per-tab pick keeps winning, exactly
   * like the old "dropdown pick shadows the setting" rule — with the same caveat
   * as the global record: editing the setting is an explicit choice too, so a
   * pick anchored to the previous setting value is retired here and the setting
   * takes over (see `loadRuntimeConfig` in the provider).
   */
  applyDefaultModel(model: string): void {
    this.changeModel(model, false);
  }

  /**
   * The one model path, for both a dropdown pick (`explicit`) and a setting that
   * changed on its own. `explicit` is what decides the *bookkeeping*: a pick is
   * written onto the session and remembered as the default for future sessions,
   * while an adopted setting simply follows the session's "no pick" state.
   */
  private changeModel(model: string, explicit: boolean): void {
    if (this.busy) {
      return;
    }
    if (!explicit && sessionModelPick(this.session, this.host.getConfig().model) !== undefined) {
      // This tab picked a model itself and the setting it was picked against has
      // not changed: the per-session selection wins over the settings value.
      return;
    }
    // A pick anchored to an older `agentHarness.model` value loses to the edited
    // setting, so it is dropped here rather than being resurrected on the next
    // reload (where `sessionModelPick` would ignore it anyway).
    const hadPick = this.session.model !== undefined;
    // A stale id (settings left over from an older catalog) resolves to the
    // default rather than silently mis-sizing the indicator or hiding images.
    const next = this.host.resolveModel(model);
    if (!next) {
      return;
    }
    if (explicit) {
      this.session.model = next;
      this.session.modelFromSettings = this.host.getConfig().model;
    } else {
      delete this.session.model;
      delete this.session.modelFromSettings;
    }
    if (next === this.model) {
      // Nothing to push to the agents, but the session's stored pick may still
      // have moved (a fresh pick, or a stale one being retired).
      if (explicit || hadPick) {
        this.host.persist();
      }
      return;
    }
    this.model = next;
    // The selection is per session, so it is pushed to every node worker (a
    // worker created later is seeded from `this.model` in `workerFor`).
    for (const worker of this.nodeWorkers.values()) {
      worker.agent.setModel(next);
    }
    this.contextWindow = this.host.getContextWindow(next);
    // The session owns the selection: save it with the session …
    this.host.persist();
    if (explicit) {
      // … and only an explicit pick also becomes the seed for future sessions.
      this.host.persistRuntimeConfig(this.model, this.thinkingEffort);
    }
    this.postConfig();
    this.postContext();
    if (this.hasHistory()) {
      let notice =
        'Model changed to ' + next + '. Existing conversation history was produced under a different model, so the next request may miss the prompt cache and reprocess the full context.';
      if (!isVisionModel(next) && this.activeSessionHasImages()) {
        notice +=
          ' Image blocks are hidden for this text-only model (the image data is kept) and will be restored when you switch back to a vision model.';
      }
      this.postNotice('warning', notice);
    }
    this.host.output.appendLine(`[config] model=${next}${explicit ? ' (session pick)' : ' (settings)'}`);
  }

  /** The tab's own thinking-effort pick (P4); see `setModel`. */
  setThinkingEffort(effort: ThinkingEffort): void {
    this.changeEffort(effort, true);
  }

  /** Adopt a changed `agentHarness.thinkingEffort` setting; see `applyDefaultModel`. */
  applyDefaultEffort(effort: ThinkingEffort): void {
    this.changeEffort(effort, false);
  }

  private changeEffort(effort: ThinkingEffort, explicit: boolean): void {
    if (this.busy) {
      return;
    }
    if (!explicit && sessionEffortPick(this.session, this.host.getConfig().thinkingEffort) !== undefined) {
      return; // this tab picked an effort itself and its anchor setting is unchanged
    }
    const hadPick = this.session.effort !== undefined;
    if (explicit) {
      this.session.effort = effort;
      this.session.effortFromSettings = this.host.getConfig().thinkingEffort;
    } else {
      delete this.session.effort;
      delete this.session.effortFromSettings;
    }
    if (effort === this.thinkingEffort) {
      if (explicit || hadPick) {
        this.host.persist();
      }
      return;
    }
    this.thinkingEffort = effort;
    for (const worker of this.nodeWorkers.values()) {
      worker.agent.setThinkingEffort(effort);
    }
    this.host.persist();
    if (explicit) {
      this.host.persistRuntimeConfig(this.model, this.thinkingEffort);
    }
    this.postConfig();
    if (this.hasHistory()) {
      this.postNotice(
        'warning',
        'Thinking effort changed to "' + effort + '". This affects the next request; the prompt cache may be missed.',
      );
    }
    this.host.output.appendLine(`[config] thinkingEffort=${effort}${explicit ? ' (session pick)' : ' (settings)'}`);
  }

  /** Push a settings change onto every node worker (`agentHarness.maxTurns`). */
  setMaxTurns(maxTurns: number): void {
    for (const worker of this.nodeWorkers.values()) {
      worker.agent.setMaxTurns(maxTurns);
    }
  }

  /** Push a settings change onto the live sub-agent pool. */
  setSubAgentPoolLimit(maxConcurrent: number): void {
    this.subAgentPool.setMaxConcurrent(maxConcurrent);
  }

  /** Re-read the context window for the current model and repaint if it moved. */
  recheckContextWindow(): void {
    const contextWindow = this.host.getContextWindow(this.model);
    if (contextWindow !== this.contextWindow) {
      this.contextWindow = contextWindow;
      this.postContext();
    }
  }

  /** True if the checked-out branch has any conversation beyond the system prompt. */
  private hasHistory(): boolean {
    return this.activePathItems().length > 0;
  }

  /** True if the checked-out branch's history carries any image content blocks. */
  private activeSessionHasImages(): boolean {
    const session = this.session;
    return pathMessages(session, session.activeNodeId).some(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        m.content.some((p) => p.type === 'image_url' || p.type === 'file'),
    );
  }

  // ---- Checkout / view focus ----

  /**
   * Check out a node: the view focus becomes `nodeId` (root→node defines the
   * `path` the tab shows and where the composer docks). P3 keeps **no** session
   * agent to rebase — each node worker's history is rebuilt when a run starts on
   * its node (`beginTurn`), the one safe moment — so a checkout is always
   * view-only and can never disturb a live run. Callers post to the webview.
   */
  private checkoutNode(session: AgentSession, nodeId: string | null): void {
    session.activeNodeId = nodeId;
  }

  /** The flat API history of a branch: a fresh system prompt + the path messages. */
  private buildPath(session: AgentSession, nodeId: string | null): ChatMessage[] {
    const system: ChatMessage = {
      role: 'system',
      content: this.systemPromptText(),
    };
    // sanitizeMessages returns a derived copy; it is never written back into the
    // nodes, so the stored history keeps its original shape.
    return Agent.sanitizeMessages([system, ...pathMessages(session, nodeId)]);
  }

  /** Every transcript item of the checked-out branch, in reading order. */
  private activePathItems(): DisplayItem[] {
    const session = this.session;
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
   * Check out another node (tree UI "click a block"). A view-only switch: it is
   * allowed while a run streams (the run keeps writing into its own node) and
   * only ignores unknown or already-checked-out nodes.
   */
  handleCheckout(nodeId: string): void {
    const session = this.session;
    if (!session.nodes[nodeId] || nodeId === session.activeNodeId) {
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

  /** Persist a user-resized card's bounds onto a node (drag-resize finished). */
  onSetNodeSize(id: string, w: number, h: number): void {
    const node = this.session.nodes[id];
    if (!node || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      return;
    }
    node.customSize = { w, h };
    this.host.persist();
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

  // ---- Repaints ----

  /** Structural summary of the session tree + the view/stream ids (no items). */
  postTree(): void {
    const session = this.session;
    const nodes = Object.values(session.nodes).map((node) => ({
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
    }));
    this.post({
      type: 'tree',
      activeId: this.activeStreamNodeId(),
      viewId: session.activeNodeId,
      rootId: session.rootId ?? null,
      nodes,
    });
  }

  /** The checked-out branch's transcript, grouped by node (for the tree view). */
  postPath(): void {
    const session = this.session;
    const ids = pathIds(session, session.activeNodeId);
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

  postContext(): void {
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

  postSessionStats(): void {
    this.post({ type: 'sessionStats', stats: this.computeSessionStats() });
  }

  postConfig(): void {
    const cfg = this.host.getConfig();
    this.post({
      type: 'config',
      model: this.model,
      // The dropdown offers the vendored model plus whatever the user added in
      // `agentHarness.modelTable`, and the image affordances follow the same
      // list — no second copy of the catalog in the webview.
      models: modelIds(),
      visionModels: visionModelIds(),
      thinkingEffort: this.thinkingEffort,
      foldToolCalls: cfg.foldToolCalls,
      foldThinking: cfg.foldThinking,
    });
  }

  /**
   * Push the busy/status state for this session plus the nodes that are
   * streaming. The webview shows Stop iff the view focus is one of
   * `runningNodes`; `sessionId` lets it remember its session (vscode.setState).
   */
  postState(): void {
    this.post({
      type: 'state',
      sessionId: this.sessionId,
      busy: this.isRunning(),
      status: this.lastStatus,
      runningNodes: this.runningNodes(),
    });
  }

  /**
   * Fetch the account's wallet balance and push it to this session's tab.
   * Best-effort: on failure (no key / network / off-API scope) we log to the
   * output channel and leave whatever balance the UI already shows. Account-level
   * (identical across sessions), refreshed at the start and after each turn.
   */
  async refreshBalance(): Promise<void> {
    try {
      const balance: DeepSeekBalance = await this.client.getBalance();
      this.post({ type: 'balance', balance });
    } catch (err) {
      this.host.output.appendLine(`[balance] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Full repaint of this session's tab (used on activation / panel rerender). */
  postAllState(): void {
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

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.postState();
    this.host.stateChanged();
  }

  private pushItem(item: DisplayItem): void {
    this.currentItems().push(item);
  }

  /** Append a notice card to the current turn/view and push it to the webview. */
  postNotice(kind: 'warning' | 'info', text: string): void {
    this.pushItem({ kind: 'notice', noticeKind: kind, text });
    this.post({ type: 'notice', kind, text });
  }

  /** Where a non-streaming item belongs: the focused node's run, else the view node. */
  private currentItems(): DisplayItem[] {
    const run = this.viewRun();
    return run ? run.items : this.viewItems();
  }

  /** The view focus node's items (or the session's orphan bucket). */
  private viewItems(): DisplayItem[] {
    const session = this.session;
    const node = session.activeNodeId ? session.nodes[session.activeNodeId] : undefined;
    return node ? node.displayItems : session.orphanItems;
  }

  /** The run bound to the current view focus, when that node is streaming. */
  private viewRun(): TurnRun | undefined {
    const id = this.session.activeNodeId;
    return id ? this.runs.get(id) : undefined;
  }

  /**
   * The node `tree.activeId` reports. This is a routing *hint* for the webview
   * only (every streaming message carries its own explicit `nodeId`): the focused
   * node's run when one exists, else any live run's node, else null.
   */
  private activeStreamNodeId(): string | null {
    const focused = this.viewRun();
    if (focused) {
      return focused.nodeId;
    }
    const any = this.runs.values().next().value as TurnRun | undefined;
    return any ? any.nodeId : null;
  }

  /**
   * Recompute the session-level `busy` flag from the live runs. P3 needs this:
   * one run finishing must not mark the session idle while another still streams,
   * or the notice drains would inject a turn into a busy session.
   */
  private syncBusy(): void {
    this.setBusy(this.uploadController != null || this.runs.size > 0);
  }

  // ---- Turn lifecycle ----

  /**
   * Create this turn's node, check it out (view focus follows the composer), and
   * record where its message slice starts. The caller pushes the turn's display
   * items and then sends the prompt to the node's own agent.
   *
   * P3 refuses to start only when the node this turn would continue from
   * (`parentId`) is *itself* streaming — two different branches of one session
   * may run at once, and the composer's Stop-not-Send rule already prevents
   * sending into a node that is running.
   *
   * `opts.parentId` overrides the basis node: an injected background notice is
   * based on the node that *owns* the job, not on the view focus, and passes
   * `pan: false` so the arrival of a notice never yanks what the user is
   * looking at.
   */
  private beginTurn(title: string, opts?: { parentId?: string | null; pan?: boolean }): TurnRun | null {
    const session = this.session;
    if (this.host.isHeld()) {
      // An external controller is reloading the window (`/wait-for-finish` with a
      // hold). `/reload-window` refuses to run while any turn does, so *every* turn
      // start has to go through this gate — including the injected ones (background
      // and sub-agent notices), which is exactly the race that killed two reboots.
      // Callers re-queue and the drain retries once the hold expires.
      return null;
    }
    const parentId = opts?.parentId !== undefined ? opts.parentId : session.activeNodeId;
    // P3: only the basis node must be free. `parentId` null (the session's first
    // turn) can never be running, so it is never refused.
    if (parentId != null && this.runs.has(parentId)) {
      this.postNotice(
        'warning',
        'A turn is already running in this session. Wait for it to finish (or stop it) before sending another.',
      );
      return null;
    }
    const node = createNode(newId(), parentId, title, 'running');
    attachNode(session, node);
    const worker = this.workerFor(node);
    // The interruption notice only makes sense when this turn continues from the
    // turn that was actually interrupted. P3 keys the pending notice per node, so
    // the new node's agent inherits its parent's notice (delivered once) or clears
    // any stale one of its own.
    const source = parentId != null ? this.interruptedNodes.get(parentId) : undefined;
    if (source) {
      worker.agent.transferInterruptTo(source);
    } else {
      worker.agent.resetInterruptState();
    }
    // The new node contributes no messages yet, so this is the parent's path;
    // the basis and the array are recorded together so they cannot drift apart.
    const messages = this.buildPath(session, node.id);
    worker.agent.setMessages(messages);
    const run: TurnRun = {
      nodeId: node.id,
      node,
      agent: worker.agent,
      items: node.displayItems,
      prefixLen: worker.agent.getMessages().length,
      prefixTail: worker.agent.getMessages()[worker.agent.getMessages().length - 1] ?? null,
      fresh: true,
      pendingText: '',
      pendingThinking: '',
      pendingTools: new Map(),
      flushTimer: null,
    };
    this.runs.set(node.id, run);
    this.postTree();
    if (opts?.pan !== false) {
      this.post({ type: 'panTo', id: node.id });
    }
    return run;
  }

  /**
   * Bind a run to an *existing* node (an injected sub-agent notice turn). Unlike
   * `beginTurn` this does not create a node and does not move the view focus;
   * the reply is appended to the node's existing messages (`fresh = false`). P3
   * binds it to that node's own worker and refuses only when that node is already
   * streaming, so it may run beside a run on another branch.
   */
  private beginInjectedTurn(node: TreeNode): TurnRun | null {
    if (this.host.isHeld()) {
      // Same gate as `beginTurn`: a held window must not gain a turn, or the
      // reload that is about to happen is refused ("the agent is busy").
      return null;
    }
    if (this.runs.has(node.id)) {
      // That node already has a live run; there is no second basis to bind.
      return null;
    }
    const worker = this.workerFor(node);
    const messages = this.buildPath(this.session, node.id);
    worker.agent.setMessages(messages);
    const run: TurnRun = {
      nodeId: node.id,
      node,
      agent: worker.agent,
      items: node.displayItems,
      prefixLen: messages.length,
      prefixTail: messages[messages.length - 1] ?? null,
      fresh: false,
      pendingText: '',
      pendingThinking: '',
      pendingTools: new Map(),
      flushTimer: null,
    };
    this.runs.set(node.id, run);
    return run;
  }

  /**
   * Close out a run: store exactly the messages the agent appended during it
   * (the interrupt checkpoint and the error rollback both land here), then
   * persist, and patch just this card instead of resending the whole tree.
   *
   * The slice is *verified* before it is written. `run.prefixLen` /
   * `run.prefixTail` describe the history this run started from; if the agent's
   * array was swapped since, the offset no longer means "the run's own messages"
   * and slicing it would store ancestor history in the node. Losing a turn's
   * messages to a log line beats silently duplicating ~1M tokens.
   */
  private finishTurn(run: TurnRun, status: TurnStatus): void {
    const node = run.node;
    this.runs.delete(run.nodeId);
    if (run.flushTimer != null) {
      clearTimeout(run.flushTimer);
      run.flushTimer = null;
    }
    const session = this.session;
    if (node && session.nodes[node.id]) {
      // P3: slice the *run's own* agent history, not a session-wide one.
      const messages = run.agent.getMessages();
      const start = run.prefixLen;
      const intact = start > 0 && start <= messages.length && messages[start - 1] === run.prefixTail;
      if (intact) {
        const added = messages.slice(start);
        // An injected (sub-agent notice / hop answer) turn continues a node that
        // already holds the turn that spawned it — appending keeps both; a user
        // turn owns the node `beginTurn` just created for it, so it assigns.
        node.messages = run.fresh ? added : [...node.messages, ...added];
      } else {
        this.host.output.appendLine(
          `[slice] ${node.id}: skipped storing this turn's messages — the agent history was ` +
            `replaced mid-turn (basis ${start}, tail ${run.prefixTail ? 'set' : 'unset'}, ` +
            `${messages.length} messages now; kept ${node.messages.length})`,
        );
      }
      node.status = status;
      session.updatedAt = Date.now();
      // Mirror the finished turn to disk so it stays searchable later.
      this.host.dumpSessionTranscript(node, session, status);
      // A finished turn is the moment to (re)name the session. An interrupted
      // turn has no reliable content yet, so it is skipped.
      if (status !== 'interrupted') {
        this.host.requestAutoTitle(session);
      }
    }
    this.host.persist();
    if (node && session.nodes[node.id]) {
      this.post({
        type: 'nodeUpdate',
        id: node.id,
        status: node.status,
        title: node.title,
        usage: nodeUsage(node),
      });
    }
    // A hopped session's turn just ended: queue the trip back to the session
    // that dispatched it, carrying this turn's final answer (the provider also
    // kicks any queued `POST /session/start` once this turn is fully closed).
    this.host.queueHopReturn(this, node, status);
  }

  // ---- User input / stop / image picker ----

  async onUserMessage(text: string, attachments: UserAttachment[] = []): Promise<void> {
    // P3: only the node this turn would continue from must be free — another
    // branch of this session may stream meanwhile. (This mirrors the composer's
    // Stop-not-Send rule; `beginTurn` re-checks the same condition once the basis
    // is known.)
    const basis = this.session.activeNodeId;
    if (basis && this.runs.has(basis)) {
      return;
    }
    if (this.host.isHeld()) {
      this.postNotice('warning', 'An external controller is rebooting the window; please wait a moment.');
      return;
    }
    const userText = text.trim();

    // Only models declared image-capable (catalog + `agentHarness.modelTable`) may
    // carry image blocks. A model that is not would not 400 — DeepSeek silently
    // swaps the image for an "[Unsupported Image]" text part and the model then
    // invents what it cannot see — so drop the attachments, send the text alone,
    // and tell the user to switch models.
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
            // Another branch may still be streaming; only this session's own
            // upload is ending here.
            this.syncBusy();
            this.lastStatus = 'Interrupted';
            this.post({ type: 'status', text: 'Interrupted' });
            this.post({ type: 'interrupted' });
            return;
          }
          failed.push(att.name || 'image');
          this.host.output.appendLine(`[image] upload failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      this.uploadController = null;
      if (failed.length > 0) {
        this.postNotice('warning', 'Could not upload: ' + failed.join(', ') + '. Those images were omitted.');
      }
      if (parts.length === 0) {
        // Nothing to send (no text and every upload failed).
        this.syncBusy();
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
    const session = this.session;
    if (session.title === 'New session' && (userText || attachments.length > 0)) {
      session.title = (userText || 'New session').slice(0, 40);
      session.titleSource = 'provisional';
      this.host.stateChanged();
    }
    session.updatedAt = Date.now();

    // This turn becomes a new node, checked out as a child of the currently
    // selected node — a branch when that node already had children.
    const run = this.beginTurn(titleFromPrompt(userText || attachments[0]?.name || ''));
    if (!run) {
      return;
    }
    run.items.push({ kind: 'user', text: userText, attachments });
    this.post({ type: 'user', text: userText, attachments });
    this.setBusy(true);
    this.lastStatus = 'Thinking…';
    this.post({ type: 'status', text: this.lastStatus });
    void run.agent.sendUserMessage(content);
  }

  /**
   * Stop runs: `nodeId`'s agent only when given, otherwise every live run's agent
   * of this session. Returns how many agents were cancelled. Also aborts an
   * in-flight image upload (there is one per session).
   */
  stop(nodeId?: string): number {
    this.uploadController?.abort();
    let stopped = 0;
    if (nodeId) {
      const run = this.runs.get(nodeId);
      const agent = run?.agent ?? this.nodeWorkers.get(nodeId)?.agent;
      if (agent && (run || agent.running)) {
        agent.cancel();
        stopped++;
      }
    } else {
      const seen = new Set<Agent>();
      for (const run of this.runs.values()) {
        if (!seen.has(run.agent)) {
          seen.add(run.agent);
          run.agent.cancel();
          stopped++;
        }
      }
    }
    return stopped;
  }

  /** Stop every run of this session (the control plane's interrupt path). */
  onStop(): void {
    this.stop();
  }

  /** Open a file picker, read the chosen image, and send a base64 data URL back. */
  async handlePickImage(): Promise<void> {
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

  // ---- Agent events / streaming ----

  private logUsage(usage: Usage): void {
    this.host.output.appendLine(
      `[usage] total=${usage.total_tokens} prompt=${usage.prompt_tokens} ` +
        `completion=${usage.completion_tokens} ` +
        `cache_hit=${usage.prompt_cache_hit_tokens ?? 0} ` +
        `cache_miss=${usage.prompt_cache_miss_tokens ?? 0}`,
    );
  }

  /**
   * Route one agent event into the run bound to `node` (P3). The agent is the
   * node's own worker, so the run is whichever run currently holds that node, and
   * every reference below goes through `run` rather than through "the active
   * turn" — a second branch streaming at the same time is simply a different
   * `run` and never receives these events.
   */
  private handleAgentEventFor(node: TreeNode, event: AgentEvent): void {
    const run = this.runs.get(node.id);
    switch (event.type) {
      case 'status':
        this.lastStatus = event.text;
        this.post({ type: 'status', text: event.text });
        break;
      case 'streamDelta':
        if (run) this.appendDelta(run, event.content);
        break;
      case 'reasoningDelta':
        if (run) this.appendThinkingDelta(run, event.content);
        break;
      case 'assistantDone':
        if (run) this.flushStreamDeltas(run);
        break;
      case 'usage':
        if (run) {
          this.flushStreamDeltas(run);
          this.logUsage(event.usage);
          this.currentPromptTokens = event.usage.prompt_tokens;
          this.postContext();
          // The turn's usage belongs on the turn's window: the assistant bubble
          // for a text answer, or the tool call card for a tool-call turn. Attach
          // it to whichever item concluded the turn (the last item) so the token
          // count shows in place and is never hoisted into an empty message bubble.
          const last = run.items[run.items.length - 1];
          if (last && (last.kind === 'assistant' || last.kind === 'tool') && !last.error) {
            last.usage = event.usage;
          }
          this.post({ type: 'usage', usage: event.usage, nodeId: run.nodeId });
          // Recompute the session totals after this turn's usage is attached to
          // the display items, so the cumulative counters include the turn just
          // finished.
          this.postSessionStats();
        }
        break;
      case 'toolCallDelta':
        if (run) this.queueToolCallDelta(run, event.index, event.id, event.name, event.args);
        break;
      case 'toolStart':
        if (run) {
          this.flushStreamDeltas(run);
          // Once a tool call starts running, reflect it in the header instead of
          // the generic "Thinking…".
          if (event.name) {
            this.lastStatus = `Calling ${event.name}…`;
            this.post({ type: 'status', text: this.lastStatus });
          }
          run.items.push({
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
            nodeId: run.nodeId,
          });
        }
        break;
      case 'toolEnd':
        if (run) {
          this.updateToolItem(run, event.id, event.content);
          this.post({
            type: 'toolEnd',
            id: event.id,
            name: event.name,
            content: clipForUi(event.content),
            nodeId: run.nodeId,
          });
        }
        break;
      case 'done':
        if (run) this.flushStreamDeltas(run);
        // Preserve an informative final status (e.g. loop-limit note) if one was
        // set; otherwise fall back to a simple "Done".
        if (!this.lastStatus || this.lastStatus === 'Thinking…') {
          this.lastStatus = 'Done';
        }
        this.post({ type: 'status', text: this.lastStatus });
        this.post({ type: 'done', nodeId: run?.nodeId });
        if (run) this.finishTurn(run, 'done');
        // P3: `busy` clears only once the *last* run of the session is gone.
        this.syncBusy();
        void this.refreshBalance();
        this.drainBackgroundQueue();
        this.drainSubAgentNotices();
        break;
      case 'interrupted':
        if (run) this.flushStreamDeltas(run);
        this.lastStatus = 'Interrupted';
        this.post({ type: 'interrupted', nodeId: run?.nodeId });
        // Remember, per node, which worker holds the pending interruption notice,
        // so a turn that continues from this node still gets it while a
        // concurrent branch's own interruption cannot clobber it.
        if (run) this.interruptedNodes.set(run.nodeId, run.agent);
        if (run) this.finishTurn(run, 'interrupted');
        this.syncBusy();
        void this.refreshBalance();
        this.drainBackgroundQueue();
        this.drainSubAgentNotices();
        break;
      case 'error':
        if (run) {
          this.flushStreamDeltas(run);
          this.lastStatus = 'Error';
          run.items.push({ kind: 'assistant', text: `⚠️ ${event.message}`, error: true });
          this.post({ type: 'error', message: event.message, nodeId: run.nodeId });
        } else {
          this.lastStatus = 'Error';
        }
        if (run) this.finishTurn(run, 'error');
        this.syncBusy();
        void this.refreshBalance();
        this.drainBackgroundQueue();
        this.drainSubAgentNotices();
        break;
      default:
        break;
    }
  }

  private appendDelta(run: TurnRun, text: string): void {
    run.pendingText += text;
    this.scheduleStreamFlush(run);
  }

  private appendThinkingDelta(run: TurnRun, text: string): void {
    run.pendingThinking += text;
    this.scheduleStreamFlush(run);
  }

  private commitTextDelta(run: TurnRun, text: string): void {
    const last = run.items[run.items.length - 1];
    if (last && last.kind === 'assistant' && !last.error) {
      last.text = (last.text ?? '') + text;
    } else {
      run.items.push({ kind: 'assistant', text });
    }
  }

  private commitThinkingDelta(run: TurnRun, text: string): void {
    const last = run.items[run.items.length - 1];
    if (last && last.kind === 'assistant' && !last.error) {
      last.thinking = (last.thinking ?? '') + text;
    } else {
      run.items.push({ kind: 'assistant', thinking: text });
    }
  }

  private queueToolCallDelta(run: TurnRun, index: number, id?: string, name?: string, args?: string): void {
    const existing = run.pendingTools.get(index) ?? { id, name: '', args: '' };
    if (id) {
      existing.id = id;
    }
    if (name) {
      existing.name += name;
    }
    if (args) {
      existing.args += args;
    }
    run.pendingTools.set(index, existing);
    this.scheduleStreamFlush(run);
  }

  private scheduleStreamFlush(run: TurnRun): void {
    if (run.flushTimer != null) {
      return;
    }
    run.flushTimer = setTimeout(() => {
      run.flushTimer = null;
      this.flushStreamDeltas(run);
    }, 50);
  }

  private flushStreamDeltas(run: TurnRun): void {
    if (run.flushTimer != null) {
      clearTimeout(run.flushTimer);
      run.flushTimer = null;
    }
    const text = run.pendingText;
    const thinking = run.pendingThinking;
    const tools = run.pendingTools.size;
    if (!text && !thinking && tools === 0) {
      return;
    }
    run.pendingText = '';
    run.pendingThinking = '';
    const bytes = text.length + thinking.length;
    this.streamFlushCount++;
    this.streamFlushBytes += bytes;
    const now = Date.now();
    if (this.streamFlushWindow === 0) {
      this.streamFlushWindow = now;
    }
    if (text) {
      this.commitTextDelta(run, text);
      this.post({ type: 'delta', text, nodeId: run.nodeId });
    }
    if (thinking) {
      this.commitThinkingDelta(run, thinking);
      this.post({ type: 'thinkingDelta', text: thinking, nodeId: run.nodeId });
    }
    if (tools > 0) {
      for (const [index, draft] of run.pendingTools) {
        this.post({
          type: 'toolCallDelta',
          index,
          id: draft.id,
          name: draft.name,
          args: clipForUi(draft.args, 8 * 1024),
          nodeId: run.nodeId,
        });
      }
      run.pendingTools.clear();
    }
    if (now - this.streamFlushWindow >= 2000) {
      perf(
        () =>
          `stream-flush n=${this.streamFlushCount} bytes=${this.streamFlushBytes} ` +
          `window=${now - this.streamFlushWindow}ms items=${run.items.length}`,
      );
      this.streamFlushCount = 0;
      this.streamFlushBytes = 0;
      this.streamFlushWindow = now;
    }
  }

  private updateToolItem(run: TurnRun, id: string, content: string): void {
    const item = run.items.find((it) => it.kind === 'tool' && it.id === id);
    if (item) {
      item.status = 'done';
      item.content = clipForUi(content);
    }
  }

  // ---- Sub-agents ----

  /**
   * Tools a sub-agent may use, by `write` flag, bound to the node it acts for
   * (P3): building from `workerFor(node).tools` means the sub-agent's background
   * jobs register under the same node as its own spawn/send handlers, instead of
   * under "the active turn" (which is ambiguous once two branches run at once).
   */
  private subAgentTools(node: TreeNode, write: boolean): ToolRegistry {
    const base = this.workerFor(node).tools;
    const read = ['read_file', 'list_dir', 'search_files', 'search_transcripts'];
    const writeTools = ['write_file', 'replace_in_file', 'exec_command'];
    if (write) {
      return base.subset([...read, ...writeTools]);
    }
    // Read-only sub-agents: the write tools stay registered with a rejecting
    // executor (defense-in-depth) but are hidden from the model's tool list, so
    // it does not spend a round proposing a tool it can never use.
    return base.subset([...read, ...writeTools]).withBlocked(writeTools).withHidden(writeTools);
  }

  /** " · transcript: <path>" suffix for a sub-agent completion note ('' when off). */
  private transcriptNote(node: TreeNode): string {
    return node.agentTranscript ? ` · transcript: ${node.agentTranscript}` : '';
  }

  /**
   * The main agent spawned sub-agents. The handler is bound to the node whose
   * turn called `spawn_agents` (P3), so the children always attach to *that*
   * node — no "which run is this?" lookup, and no fallback to the view focus.
   */
  private handleSpawnAgents(node: TreeNode, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const parent = this.session.nodes[node.id];
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
   * (trusted: it may raise or lower the target's `write`). `caller` is the calling
   * node (P3 binds the handler per node); the lookup is session-wide exactly as
   * before. */
  private handleSendAgentMessage(caller: TreeNode, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    void caller;
    const session = this.session;
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
    const session = this.session;
    const id = String(args.id ?? '');
    const node = session.nodes[id];
    if (!node || node.kind !== 'agent') {
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
    const parent = this.session.nodes[node.parentId ?? ''] ?? null;
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
      nodeId: parent.id,
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
    this.host.persist();
  }

  /**
   * Create agent child nodes under `parent`, run them (in parallel, pool-limited
   * for level-1), and return the spawn result. `sync` blocks and returns the
   * summaries; `async` returns immediately and delivers per-job results as an
   * injected notification to the parent when idle.
   */
  private async spawnChildren(parent: TreeNode, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const session = this.session;
    // Capture the view focus BEFORE attachNode below moves it to the new
    // (sidecar) agent node, so we can restore it: a sub-agent card is display-only
    // and must never become the view focus/composer dock.
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
      const budget = this.host.getConfig().maxLevel2Subagents;
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
    // Restore the view focus we captured above: attachNode moved it to the last
    // agent child, and the view must stay where the user left it. The stream
    // target is tracked separately (`runs`), so nothing else needs pinning here.
    if (session.activeNodeId !== prevActive) {
      session.activeNodeId = prevActive;
    }
    this.postTree();

    if (mode === 'async') {
      // A main-agent turn node owns the batch; a sub-agent node instead hands the
      // result to its own parent (see `onAsyncBatchDone`). P3 cannot ask "the
      // active run" any more — `parent`'s kind is the stable answer.
      const mainParent = parent.kind !== 'agent';
      const tasks = jobs.map((job) => {
        const run = () => this.runSubAgent(job, signal);
        return (childDepth === 1 ? this.subAgentPool.withSlot(run) : run()).then((result) => ({ job, result }));
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
        transcriptDir: this.host.transcriptDir(session.id),
      });
    }

    const runAll = async () => {
      const results = await Promise.all(
        jobs.map((job) => (childDepth === 1 ? this.subAgentPool.withSlot(() => this.runSubAgent(job, signal)) : this.runSubAgent(job, signal))),
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
      const subTools = this.subAgentTools(job.node, job.spec.write);
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
          job.node.agentTranscript = this.host.writeSubAgentTranscript(job, subAgent, status, summary, startedAt);
        }
        this.post({ type: 'agentDone', id: job.node.id, status, summary });
        this.host.persist();
        // This sub-agent (depth-1) may have async depth-2 results queued while it ran.
        this.flushSubAgentChildNotices(job.node);
        resolve({ ok: status === 'done', summary, model: job.spec.model || this.model });
      };

      const sub = new Agent(this.client, subTools, (event) => this.handleSubAgentEvent(job.node, event, finish), this.host.getConfig().maxTurns);
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
      { node: parent, spec: { instruction: notice, write: parent.agentWrite ?? false, model: undefined }, resume: true, sessionId: this.sessionId },
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
      { node, spec: { instruction: notice.message, write: node.agentWrite ?? false, model: undefined }, resume: true, sessionId: this.sessionId },
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
  onKillAgent(id: string): void {
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
      this.host.persist();
    }
  }

  /** Dump a layout diagnostic (overlapping cards + tree connections) to the log. */
  logLayoutDiagnostic(nodes: unknown, overlaps: unknown, connections: unknown, force: unknown): void {
    const out = this.host.output;
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
    this.post({ type: 'backgroundNotice', nodeId: parent.id, item: { id: `sub-${parent.id}`, name: '子代理完成', doneText, content: cardText } });
    // 2. One combined notice → the main agent answers once.
    this.subAgentNoticeQueue.push({ nodeId: parent.id, summary: cardText, status: 'done', count: results.length });
    this.scheduleSubAgentDrain();
    this.host.persist();
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
    if (this.dead || this.busy) {
      return;
    }
    if (this.heldBackoff(() => this.scheduleSubAgentDrain())) {
      return;
    }
    // The worker's `finally` hasn't reset `isRunning` yet when this is called from
    // the `done` callback — sendUserMessage would drop the notice. Defer a tick.
    // P3: the agent that matters is the *target node's* worker.
    const firstId = this.subAgentNoticeQueue.find((n) => this.session.nodes[n.nodeId] !== undefined)?.nodeId;
    const targetAgent = firstId ? this.nodeWorkers.get(firstId)?.agent : undefined;
    if (targetAgent && targetAgent.running) {
      setTimeout(() => this.drainSubAgentNotices(), 0);
      return;
    }
    // Notices are session-local now, so a notice whose node no longer exists is
    // simply stale (its branch/session was deleted) and gets dropped.
    const notices = this.subAgentNoticeQueue.splice(0).filter((n) => this.session.nodes[n.nodeId] !== undefined);
    if (notices.length === 0) {
      return;
    }
    // Bind this injected turn to the parent node: it bypasses beginTurn, so the
    // reply (and any further spawn) must belong to that node.
    const parentId = notices[0].nodeId;
    const parent = this.session.nodes[parentId];
    // Continue from the parent node's path: an injected turn bypasses beginTurn,
    // so pin the *node's own agent* history to this node explicitly (the user may
    // have checked out another branch while the async batch was running).
    const run = parent ? this.beginInjectedTurn(parent) : null;
    if (!parent || !run) {
      // Held (a reload is due), the node vanished, or that node already has a live
      // run: put the notices back so the drain retries later instead of dropping
      // them.
      this.subAgentNoticeQueue.push(...notices);
      this.scheduleSubAgentDrain();
      return;
    }
    this.lastStatus = '子代理完成';
    this.setBusy(true);
    this.post({ type: 'status', text: this.lastStatus });
    // Re-affirm the view in the webview BEFORE the resumed turn streams: a nested
    // sub-agent spawn may have left messagesEl pinned to a sub-agent card, and
    // this injected turn has no `path`/`tree` round-trip of its own. postPath
    // follows the view focus, so the reply cannot leak into a sub-agent card.
    this.postPath();
    // One clean combined message: per batch, a header + the per-sub-agent lines.
    const parts = notices.map((n) => {
      const count = n.count ?? 1;
      const head = n.status === 'done' ? `${count} 个子代理完成` : `${count} 个子代理完成（含失败/中断）`;
      return `[子代理批次] ${head}\n${n.summary || '(no summary)'}`;
    });
    run.agent.sendUserMessage(`子代理通知：\n${parts.join('\n\n')}`);
  }

  private cleanupSubAgents(): void {
    for (const [, entry] of this.runningSubAgents) {
      entry.abort.abort();
      entry.agent.cancel();
    }
    this.runningSubAgents.clear();
  }

  /**
   * `list_nodes` tool: render this session's tree (id, status, parent, title) so
   * the agent can name a node — e.g. as `hop_session`'s `returnNodeId`. Node ids
   * otherwise live only in the persisted tree. `node` is the caller's own node
   * (P3 binds the handler per node); the rendered tree is always the whole
   * session's, exactly as before.
   */
  private handleListNodes(node: TreeNode): string {
    const session = this.session;
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

  // ---- Background terminals ----

  private toBackgroundInfo(owner: BackgroundOwner, task: BackgroundTask): BackgroundInfo {
    const out = task.handle.getOutput().trim();
    const outputTail = out.length > 800 ? '…' + out.slice(-800) : out;
    return {
      id: task.id,
      nodeId: owner.nodeId,
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

  /** The hub calls this for a job of this session (any of its nodes). */
  refreshBackgrounds(): void {
    this.postBackgrounds();
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
    // One flat list for the whole session: every task tagged with its owning
    // node, so the webview renders each node's own dock (there is no panel).
    // Running jobs plus finished ones still awaiting delivery (their notice has
    // not reached the agent yet); delivered jobs drop out, so the list never
    // accumulates stale entries.
    const tasks = this.hub
      .listForSession(this.sessionId)
      .filter(({ task }) => task.status === 'running' || (task.status === 'finished' && !task.delivered))
      .map(({ owner, task }) => this.toBackgroundInfo(owner, task));
    this.post({ type: 'backgrounds', tasks });
    this.postState();
    perf(() => `backgrounds ${Date.now() - t0}ms tasks=${tasks.length}`);
  }

  /** Mark a task's completion notice as delivered so it leaves the pending dock state. */
  private markDelivered(taskId: number): void {
    const hit = this.hub.lookup(this.sessionId, taskId);
    if (hit) {
      hit.task.delivered = true;
    }
  }

  /**
   * While an external controller holds the window (a reload is due), no turn may
   * start — `/reload-window` refuses while one does. A drain that finds itself
   * held retries later instead of spinning its 75 ms timer. Returns true when the
   * caller must back off.
   */
  private heldBackoff(reschedule: () => void): boolean {
    if (!this.host.isHeld()) {
      return false;
    }
    setTimeout(reschedule, 500);
    return true;
  }

  /**
   * Called by the hub when a background terminal of this session transitions to
   * finished (naturally or via kill). Builds the notice, queues it, and drains
   * immediately — delivering now if the agent is idle, or waiting for the
   * current turn to finish otherwise.
   */
  onBackgroundFinished(owner: BackgroundOwner, task: BackgroundTask): void {
    if (this.dead) {
      return;
    }
    if (task.notifyAgent !== true) {
      // Tool-initiated kill/join already informed the agent via the tool result, so
      // the task is considered delivered and leaves the pending dock state.
      task.delivered = true;
      this.postBackgrounds();
      return;
    }
    const notice = this.buildBackgroundNotice(owner, task);
    this.backgroundNotifQueue.push(notice);
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

  private buildBackgroundNotice(owner: BackgroundOwner, task: BackgroundTask): BackgroundNotice {
    const cmd = this.truncateField(task.command, 100);
    const doneText = task.killed
      ? 'was killed by the user'
      : `finished with exit code ${task.exitCode ?? 'unknown'}`;
    const output = this.truncateField(task.handle.getOutput().trim(), 1200);
    const text = `Background command \`${cmd}\` (id ${task.id}) ${doneText}.${output ? `\nOutput:\n${output}` : ''}`;
    return { text, taskId: task.id, nodeId: owner.nodeId, id: task.id, cmd, doneText, output };
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
   * in the owning node's branch, then start a single turn with a combined
   * message so the agent reacts once (instead of one auto-turn per finished job).
   *
   * The notice turn is based on the node that *owns* the job — never on the view
   * focus — and does not pan the view, so a job finishing in node X while the
   * user sits on node Y lands in X without moving anything. One group (owner node)
   * goes per drain: `beginTurn` refuses when that owner node is itself streaming
   * (P3), and the rest is re-queued to drain when the session is free again.
   */
  private injectBackgroundNotices(notices: BackgroundNotice[]): void {
    if (this.dead) {
      return;
    }
    if (notices.length === 0) {
      return;
    }
    if (this.busy) {
      this.backgroundNotifQueue.push(...notices);
      return;
    }
    const groups = new Map<string, BackgroundNotice[]>();
    for (const n of notices) {
      const group = groups.get(n.nodeId);
      if (group) {
        group.push(n);
      } else {
        groups.set(n.nodeId, [n]);
      }
    }
    const first = [...groups.entries()].find(([nodeId]) => Boolean(this.session.nodes[nodeId]));
    if (!first) {
      // Every notice's owning node is gone (its branch was deleted): drop them.
      for (const n of notices) {
        this.markDelivered(n.taskId);
      }
      this.postBackgrounds();
      return;
    }
    const [ownerNodeId, batch] = first;
    const deferred = notices.filter((n) => n.nodeId !== ownerNodeId);
    if (deferred.length > 0) {
      this.backgroundNotifQueue.push(...deferred);
    }
    // The notice turn is a new node *under the owning node*, so the card and the
    // agent's reply land in their own block of the branch that spawned the job.
    const title =
      batch.length === 1
        ? `Background #${batch[0].id}: ${batch[0].cmd}`
        : `Background: ${batch.length} tasks finished`;
    const run = this.beginTurn(titleFromPrompt(title), { parentId: ownerNodeId, pan: false });
    if (!run) {
      this.backgroundNotifQueue.push(...batch);
      return;
    }
    for (const n of batch) {
      // The notice is now reaching the agent, so the task leaves the pending dock.
      this.markDelivered(n.taskId);
      run.items.push({ kind: 'background', id: String(n.id), name: n.cmd, doneText: n.doneText, content: n.output });
      this.post({
        type: 'backgroundNotice',
        nodeId: run.nodeId,
        item: { id: n.id, name: n.cmd, doneText: n.doneText, content: n.output },
      });
    }
    // Refresh the docks so the just-delivered jobs drop out of the pending list.
    this.postBackgrounds();
    this.lastStatus = 'Background terminal finished';
    this.setBusy(true);
    this.post({ type: 'status', text: this.lastStatus });
    run.agent.sendUserMessage(this.combineNotices(batch));
  }

  /**
   * True when a queued notice must not be delivered: the task was later joined or
   * killed via a tool, it no longer exists (cleared/removed), or the node that
   * owned it is gone (its branch was deleted).
   */
  private taskAlreadyHandled(notice: BackgroundNotice): boolean {
    const hit = this.hub.lookup(this.sessionId, notice.taskId);
    if (!hit) {
      // The task was removed (cleared session / deleted); its notice is stale.
      return true;
    }
    if (!this.session.nodes[notice.nodeId]) {
      // The owning branch was deleted; nothing may own the notice any more.
      return true;
    }
    return hit.task.notifyAgent !== true;
  }

  /**
   * After a turn ends, deliver any background-completion notifications queued
   * while it was running. Deferred a tick so the previous turn's finally block
   * has reset agent.running to false (otherwise sendUserMessage rejects). Drops
   * notices for tasks already handled by a join/kill instead of delivering them.
   */
  drainBackgroundQueue(): void {
    if (this.busy) {
      return;
    }
    if (this.heldBackoff(() => this.scheduleBackgroundDrain())) {
      return;
    }
    const queue = this.backgroundNotifQueue;
    // Collect every real (not already handled) notice so they can be delivered
    // together in one turn rather than one per turn.
    const real: BackgroundNotice[] = [];
    let i = 0;
    while (i < queue.length) {
      const q = queue[i];
      if (this.taskAlreadyHandled(q)) {
        // The agent already handled this task via join/kill (or it was removed):
        // drop the stale notice and treat the job as delivered so it also leaves
        // the pending panel.
        this.markDelivered(q.taskId);
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

  /** Kill a background terminal from the UI (a node card's dock). */
  onKillBackground(id: number): void {
    const hit = this.hub.lookup(this.sessionId, id);
    if (!hit) {
      return;
    }
    if (hit.task.status !== 'running') {
      this.postNotice('info', `Background terminal ${id} is not running.`);
      return;
    }
    // User-initiated kill: notify the agent (queue if busy, deliver if idle).
    this.hub.registryFor(hit.owner).kill(id, { notifyAgent: true });
    this.postBackgrounds();
  }

  // ---- Bulk mutations owned by the coordinator ----

  /**
   * Clear the conversation (the `clear` command / webview button): keep the
   * session's identity but drop the whole tree, every node worker (and its agent
   * history), the queued notices and the background-terminal history. The
   * provider removes the transcript dumps and resets the automatic-title
   * bookkeeping.
   */
  clearConversation(): void {
    // P3: the tree goes, so every node worker (and its agent) goes with it.
    this.nodeWorkers.clear();
    this.interruptedNodes.clear();
    for (const run of this.runs.values()) {
      if (run.flushTimer != null) {
        clearTimeout(run.flushTimer);
        run.flushTimer = null;
      }
    }
    this.runs.clear();
    this.uploadController = null;
    const session = this.session;
    // A cleared conversation keeps its identity but loses the whole tree.
    session.nodes = {};
    session.rootId = null;
    session.activeNodeId = null;
    session.orphanItems.length = 0;
    session.updatedAt = Date.now();
    // A cleared conversation drops its background jobs too: the provider asks
    // for a confirmation first, so anything still running here is killed here.
    this.hub.removeSession(this.sessionId, { kill: true });
    this.backgroundNotifQueue = [];
    this.subAgentNoticeQueue.length = 0;
    this.subAgentChildNotices.clear();
    if (this.backgroundDrainTimer != null) {
      clearTimeout(this.backgroundDrainTimer);
      this.backgroundDrainTimer = null;
    }
    this.setBusy(false);
    this.lastStatus = '';
    this.currentPromptTokens = 0;
    this.post({ type: 'reset' });
    this.postBackgrounds();
    this.postContext();
    this.postSessionStats();
    this.postTree();
  }

  /**
   * Apply a confirmed branch deletion to this session: drop anything the removed
   * nodes still queued (the pending interruption notice, async child notices),
   * re-check out the surviving view focus and repaint. The provider does the tree
   * surgery, the transcript dumps and the persistence.
   */
  afterBranchDetach(ids: string[]): void {
    // Drop the removed nodes' workers and any pending interruption notice they
    // held: their branches no longer exist.
    for (const id of ids) {
      this.interruptedNodes.delete(id);
      this.nodeWorkers.delete(id);
    }
    // Depth-2 results queued for a removed (finished) sub-agent can never be
    // delivered; a queued main-agent notice for a removed node is dropped by
    // drainSubAgentNotices itself (it filters on the node still existing).
    for (const id of ids) {
      this.subAgentChildNotices.delete(id);
    }
    // Background jobs are owned by nodes: dropping a branch kills the jobs it
    // spawned (the provider confirmed that with the user) and drops its notices.
    for (const id of ids) {
      this.hub.removeNode(this.sessionId, id, { kill: true });
    }
    this.backgroundNotifQueue = this.backgroundNotifQueue.filter((n) => !ids.includes(n.nodeId));
    this.postBackgrounds();
    this.checkoutNode(this.session, this.session.activeNodeId);
    this.currentPromptTokens = this.getLatestPromptTokens();
    this.postTree();
    this.postPath();
    if (this.session.activeNodeId) {
      this.post({ type: 'panTo', id: this.session.activeNodeId });
    }
    this.postContext();
    this.postSessionStats();
  }
}
