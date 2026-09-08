import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Agent } from '../agent/agent';
import { DeepSeekClient, DeepSeekBalance } from '../agent/deepseek';
import { AgentEvent, ChatMessage, ContentPart, ThinkingEffort, Usage, isVisionModel } from '../agent/types';
import { getWorkspaceRoot, ToolRegistry } from '../tools';
import { BackgroundRegistry, BackgroundTask } from '../tools/background';
import { perf, setPerfSink } from '../perf';

/** Known context-window sizes (in tokens) per model, for the usage indicator. */
const CONTEXT_WINDOWS: Record<string, number> = {
  'deepseek-v4-flash': 1_000_000,
  'deepseek-v4-pro': 1_000_000,
  'deepseek-v4-flash-vision-exp': 1_000_000,
  'deepseek-v4.1-flash-expires-on-0910': 1_000_000,
  'deepseek-chat': 1_000_000,
  'deepseek-reasoner': 1_000_000,
};
const DEFAULT_CONTEXT_WINDOW = 1_000_000;
const STORAGE_KEY = 'agentHarness.state';
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

/** Locally persists the active model + thinking-effort selection. */
interface RuntimeConfig {
  model: string;
  thinkingEffort: ThinkingEffort;
}

interface UserAttachment {
  dataUrl: string;
  name?: string;
}

interface DisplayItem {
  kind: 'user' | 'assistant' | 'tool' | 'notice' | 'background';
  id?: string;
  text?: string;
  thinking?: string;
  noticeKind?: 'warning' | 'info';
  name?: string;
  args?: string;
  content?: string;
  status?: 'running' | 'done';
  error?: boolean;
  attachments?: UserAttachment[];
  usage?: Usage;
  /** For a background notice card: the status phrase, e.g. "finished with exit code 0". */
  doneText?: string;
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

/** A persisted agent conversation (its own history + UI transcript). */
interface AgentSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  displayItems: DisplayItem[];
}

interface StoredState {
  activeSessionId: string;
  sessions: AgentSession[];
}

interface SessionMeta {
  id: string;
  title: string;
}

/** Decode the base64 payload of a `data:<mime>;base64,<data>` URL into bytes. */
function dataUrlBytes(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Buffer.from(base64, 'base64');
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'agentHarness.chat';

  private view?: vscode.WebviewView;
  private agent!: Agent;
  private client!: DeepSeekClient;
  private tools!: ToolRegistry;
  private displayItems: DisplayItem[] = [];
  private busy = false;
  /** Per-session background-terminal registries (one per conversation). */
  private sessionRegistries = new Map<string, BackgroundRegistry>();
  /** Background-completion notifications waiting for the agent to go idle. */
  private backgroundNotifQueue: BackgroundNotice[] = [];
  /** Set when the provider is being torn down; suppresses background notifications. */
  private disposed = false;
  /** Aborts an in-flight image upload (attachment path) when the user stops. */
  private uploadController: AbortController | null = null;
  private lastStatus = '';
  private readonly output: vscode.OutputChannel;
  private model = 'deepseek-chat';
  private thinkingEffort: ThinkingEffort = 'none';
  private contextWindow = DEFAULT_CONTEXT_WINDOW;
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

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly storage: vscode.Memento,
  ) {
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
  }

  private getConfig(): {
    apiKey: string;
    model: string;
    baseUrl: string;
    maxTurns: number;
    thinkingEffort: ThinkingEffort;
  } {
    const cfg = vscode.workspace.getConfiguration('agentHarness');
    const apiKey = (cfg.get<string>('apiKey') ?? '').trim() || (process.env.DEEPSEEK_API_KEY ?? '').trim();
    const model = cfg.get<string>('model') ?? 'deepseek-chat';
    const baseUrl = cfg.get<string>('baseUrl') ?? 'https://api.deepseek.com';
    const maxTurns = cfg.get<number>('maxTurns') ?? 20;
    const thinkingEffort = (cfg.get<string>('thinkingEffort') ?? 'none') as ThinkingEffort;
    return { apiKey, model, baseUrl, maxTurns, thinkingEffort };
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
    this.agent = new Agent(this.client, this.tools, (event) => this.handleAgentEvent(event), maxTurns);
    this.agent.setModel(this.model);
    this.agent.setThinkingEffort(this.thinkingEffort);
  }

  private getContextWindow(model: string): number {
    const override = vscode.workspace
      .getConfiguration('agentHarness')
      .get<number>('contextWindow');
    if (override && override > 0) {
      return override;
    }
    return CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW;
  }

  private getLatestPromptTokens(): number {
    for (let i = this.displayItems.length - 1; i >= 0; i--) {
      const item = this.displayItems[i];
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

  /** Session-wide token totals derived from the usage attached to each turn. */
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
    for (const item of this.displayItems) {
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
    this.post({
      type: 'config',
      model: this.model,
      thinkingEffort: this.thinkingEffort,
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

  /** True if the active session has any conversation beyond the system prompt. */
  private hasHistory(): boolean {
    const session = this.getActiveSession();
    if (!session) {
      return false;
    }
    return session.messages.some((m) => m.role !== 'system');
  }

  /** True if the active session's history carries any image content blocks. */
  private activeSessionHasImages(): boolean {
    const session = this.getActiveSession();
    if (!session) {
      return false;
    }
    return session.messages.some(
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
    const state = this.storage.get<StoredState>(STORAGE_KEY);
    if (state && Array.isArray(state.sessions) && state.sessions.length > 0) {
      this.sessions = state.sessions.map((s) => {
        let messages = (s.messages ?? Agent.initialMessages()).slice();
        // Heal corrupt persisted state (e.g. a dangling tool_calls message).
        // The leading system prompt's identity is refreshed to the current
        // model/effort selection; the core instructions and full history are
        // preserved, so switching models keeps an authoritative identity.
        messages = Agent.sanitizeMessages(messages);
        if (messages[0]?.role === 'system') {
          messages[0] = { role: 'system', content: Agent.systemPrompt(this.model, this.thinkingEffort) };
        } else {
          messages = [{ role: 'system', content: Agent.systemPrompt(this.model, this.thinkingEffort) }, ...messages];
        }
        const displayItems = (s.displayItems ?? []).map(clipDisplayItem);
        return { ...s, messages, displayItems };
      });
      const active = this.sessions.find((s) => s.id === state.activeSessionId);
      this.activeSessionId = active ? active.id : this.sessions[0].id;
    } else {
      this.createSessionInMemory();
    }
    // Ensure a background-terminal registry exists for every session.
    for (const s of this.sessions) {
      this.createRegistryForSession(s.id);
    }
    // Persist the (possibly healed) state so a resumed session is always valid.
    perf(
      `load-sessions ${Date.now() - t0}ms sessions=${this.sessions.length} ` +
        `items=${this.getActiveSession()?.displayItems.length ?? 0}`,
    );
    this.persist();
  }

  private persist(): void {
    const t0 = Date.now();
    const payload: StoredState = {
      activeSessionId: this.activeSessionId,
      sessions: this.sessions.map((s) => ({
        ...s,
        displayItems: s.displayItems.map(clipDisplayItem),
      })),
    };
    const msgCount = this.getActiveSession()?.messages.length ?? 0;
    const extra =
      `sessions=${this.sessions.length} items=${this.displayItems.length} msgs=${msgCount}`;
    const pending = this.storage.update(STORAGE_KEY, payload);
    perf(`persist-queued ${Date.now() - t0}ms ${extra}`);
    void pending.then(
      () => perf(`persist-done ${Date.now() - t0}ms ${extra}`),
      (err: unknown) =>
        perf(`persist-fail ${Date.now() - t0}ms ${extra} ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  private newId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  private getActiveSession(): AgentSession | undefined {
    return this.sessions.find((s) => s.id === this.activeSessionId);
  }

  private sessionsMeta(): SessionMeta[] {
    return this.sessions.map((s) => ({ id: s.id, title: s.title }));
  }

  private createSessionInMemory(): AgentSession {
    const session: AgentSession = {
      id: this.newId(),
      title: 'New session',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: Agent.initialMessages(this.model, this.thinkingEffort),
      displayItems: [],
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
    // Point the provider and the agent at this session's live arrays so that
    // in-memory mutations during a turn are reflected in the session.
    this.displayItems = session.displayItems;
    this.agent.setMessages(session.messages);
    // Point the tool registry at this session's background registry so
    // exec_command and the background tools read the right one.
    this.tools.setBackgroundRegistry(this.createRegistryForSession(session.id));
    this.currentPromptTokens = this.getLatestPromptTokens();
    this.setBusy(false);
    this.lastStatus = '';
    this.post({ type: 'sessions', sessions: this.sessionsMeta(), activeId: this.activeSessionId });
    this.post({ type: 'reset' });
    this.postHistory();
    this.postConfig();
    this.postContext();
    this.postSessionStats();
    this.postBackgrounds();
    // Deliver any background-completion notice queued for this session (e.g. it
    // finished while the agent was busy and the user switched away before the
    // drain ran).
    this.drainBackgroundQueue();
  }

  private handleNewSession(): void {
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
  }

  private handleSwitchSession(id: string): void {
    if (this.busy || this.activeSessionHasRunningBackground()) {
      this.postNotice(
        'warning',
        'Cannot switch session while background terminals are running. Wait for them to finish or kill them from the Background panel first.',
      );
      return;
    }
    const session = this.sessions.find((s) => s.id === id);
    if (!session || id === this.activeSessionId) {
      return;
    }
    this.activateSession(session);
  }

  private handleDeleteSession(id: string): void {
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
    this.sessions.splice(idx, 1);
    if (this.sessions.length === 0) {
      this.createSessionInMemory();
    }
    this.activeSessionId = this.sessions.some((s) => s.id === this.activeSessionId)
      ? this.activeSessionId
      : this.sessions[0].id;
    this.activateSession(this.getActiveSession()!);
    this.persist();
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
    this.uploadController = null;
    const session = this.getActiveSession();
    if (session) {
      session.messages = this.agent.getMessages();
      session.displayItems.length = 0;
      this.displayItems = session.displayItems;
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
    if (this.backgroundDrainTimer != null) {
      clearTimeout(this.backgroundDrainTimer);
      this.backgroundDrainTimer = null;
    }
    this.post({ type: 'reset' });
    this.postBackgrounds();
    this.postContext();
    this.postSessionStats();
    this.persist();
  }

  private persistActiveSession(): void {
    const session = this.getActiveSession();
    if (session) {
      session.messages = this.agent.getMessages();
      session.updatedAt = Date.now();
      this.persist();
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'ready':
          this.currentPromptTokens = this.getLatestPromptTokens();
          this.post({
            type: 'sessions',
            sessions: this.sessionsMeta(),
            activeId: this.activeSessionId,
          });
          this.postState();
          this.postHistory();
          this.postConfig();
          this.postContext();
          this.postSessionStats();
          this.postBackgrounds();
          void this.refreshBalance();
          break;
        case 'userMessage':
          await this.onUserMessage(String(message.text ?? ''), message.attachments ?? []);
          break;
        case 'newSession':
          this.handleNewSession();
          break;
        case 'switchSession':
          this.handleSwitchSession(String(message.id ?? ''));
          break;
        case 'deleteSession':
          this.handleDeleteSession(String(message.id ?? this.activeSessionId));
          break;
        case 'pickImage':
          void this.handlePickImage();
          break;
        case 'stop':
          this.onStop();
          break;
        case 'setModel':
          this.onSetModel(String(message.model ?? ''));
          break;
        case 'setThinkingEffort':
          this.onSetThinkingEffort(String(message.effort ?? 'none') as ThinkingEffort);
          break;
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
          break;
        }
        case 'killBackground':
          this.onKillBackground(Number(message.id));
          break;
        case 'clear':
          this.clear();
          break;
        default:
          break;
      }
    });
  }

  private async onUserMessage(text: string, attachments: UserAttachment[] = []): Promise<void> {
    if (this.busy) {
      return;
    }
    const userText = text.trim();

    // Only the vision model accepts image blocks; on a text-only model DeepSeek
    // returns a 400. Drop the attachments, send the text alone, and tell the
    // user to switch models rather than failing the request.
    if (attachments.length > 0 && !isVisionModel(this.model)) {
      this.postNotice(
        'warning',
        'Images are not supported by the current model (' +
          (this.model || 'deepseek-chat') +
          '). Switch to a vision model (deepseek-v4-flash-vision-exp or deepseek-v4.1-flash-expires-on-0910) to attach or paste an image.',
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

    // Name a fresh session from its first user message.
    const session = this.getActiveSession();
    if (session) {
      if (session.title === 'New session' && (userText || attachments.length > 0)) {
        session.title = (userText || 'New session').slice(0, 40);
        this.post({ type: 'sessions', sessions: this.sessionsMeta(), activeId: this.activeSessionId });
      }
      session.updatedAt = Date.now();
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
    this.post({ type: 'state', busy: this.busy, status: this.lastStatus, sessionLocked });
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
    perf(`backgrounds ${Date.now() - t0}ms tasks=${tasks.length}`);
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
    setPerfSink(null);
    for (const reg of this.sessionRegistries.values()) {
      reg.killAll();
    }
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
        this.persistActiveSession();
        void this.refreshBalance();
        this.drainBackgroundQueue();
        break;
      case 'interrupted':
        this.flushStreamDeltas();
        this.lastStatus = 'Interrupted';
        this.setBusy(false);
        this.post({ type: 'interrupted' });
        this.persistActiveSession();
        void this.refreshBalance();
        this.drainBackgroundQueue();
        break;
      case 'error':
        this.flushStreamDeltas();
        this.lastStatus = 'Error';
        this.pushItem({ kind: 'assistant', text: `⚠️ ${event.message}`, error: true });
        this.post({ type: 'error', message: event.message });
        this.setBusy(false);
        this.persistActiveSession();
        void this.refreshBalance();
        this.drainBackgroundQueue();
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

  private postHistory(): void {
    const items = this.displayItems.map(clipDisplayItem);
    perf(`post-history items=${items.length}`);
    this.post({ type: 'history', items });
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js'),
    );
    const markdownItUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'markdown-it.min.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'style.css'),
    );
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
  <div id="session-bar">
    <select id="session-select" title="Switch session"></select>
    <button id="new-session-btn" class="icon-btn" title="New session">＋</button>
    <button id="delete-session-btn" class="icon-btn" title="Delete session">🗑</button>
  </div>
  <div id="messages-wrap">
    <div id="messages"></div>
    <div id="scroll-lock" class="locked" title="Auto-scroll locked to the newest output"></div>
  </div>
  <div id="bg-panel" class="hidden">
    <div id="bg-head">
      <span class="bg-title">Background</span>
      <span id="bg-count" class="bg-count"></span>
    </div>
    <div id="bg-list"></div>
  </div>
  <div id="composer">
    <div id="attachments"></div>
    <div id="composer-row">
      <textarea id="input" placeholder="Ask the agent… (Enter to send, Shift+Enter for newline)" rows="4" spellcheck="false" autocorrect="off" autocapitalize="off" autocomplete="off"></textarea>
      <div id="composer-controls">
        <button id="attach-btn" class="icon-btn" title="Attach image">📎</button>
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
      <span id="context" title="Context window usage">
        <span id="context-label">ctx 0%</span>
      </span>
      <span id="stat-cache">cache –</span>
      <span id="stat-balance">bal –</span>
      <span id="tps-meter" title="Token generation rate (realtime estimate)">
        <span id="tps-value">0</span>
        <span id="tps-unit">tok/s</span>
      </span>
    </div>
  </div>
  <script nonce="${nonce}" src="${markdownItUri}"></script>
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
