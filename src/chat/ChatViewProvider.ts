import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Agent } from '../agent/agent';
import { DeepSeekClient } from '../agent/deepseek';
import { AgentEvent, ChatMessage, ContentPart, ThinkingEffort, Usage } from '../agent/types';
import { ToolRegistry } from '../tools';

/** Known context-window sizes (in tokens) per model, for the usage indicator. */
const CONTEXT_WINDOWS: Record<string, number> = {
  'deepseek-v4-flash': 1_000_000,
  'deepseek-v4-pro': 1_000_000,
  'deepseek-v4-flash-vision-exp': 1_000_000,
  'deepseek-chat': 1_000_000,
  'deepseek-reasoner': 1_000_000,
};
const DEFAULT_CONTEXT_WINDOW = 1_000_000;
const STORAGE_KEY = 'agentHarness.state';
const CONFIG_KEY = 'agentHarness.runtimeConfig';

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
  kind: 'user' | 'assistant' | 'tool' | 'notice';
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

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'agentHarness.chat';

  private view?: vscode.WebviewView;
  private agent!: Agent;
  private displayItems: DisplayItem[] = [];
  private busy = false;
  private lastStatus = '';
  private readonly output: vscode.OutputChannel;
  private model = 'deepseek-chat';
  private thinkingEffort: ThinkingEffort = 'none';
  private contextWindow = DEFAULT_CONTEXT_WINDOW;
  private currentPromptTokens = 0;
  private sessions: AgentSession[] = [];
  private activeSessionId = '';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly storage: vscode.Memento,
  ) {
    this.output = vscode.window.createOutputChannel('Agent Harness');
    // Resolve the active model/effort before loading sessions so the restored
    // system prompt carries the correct identity.
    const runtime = this.loadRuntimeConfig();
    this.model = runtime.model;
    this.thinkingEffort = runtime.thinkingEffort;
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

  private buildAgent(): void {
    const { apiKey, baseUrl, maxTurns } = this.getConfig();
    // Model and effort were already resolved (incl. runtime persistence) in the
    // constructor; apply them here so the client and agent are in sync.
    this.contextWindow = this.getContextWindow(this.model);
    const client = new DeepSeekClient({ apiKey, baseUrl, model: this.model });
    const tools = new ToolRegistry();
    this.agent = new Agent(client, tools, (event) => this.handleAgentEvent(event), maxTurns);
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

  private postNotice(kind: 'warning' | 'info', text: string): void {
    this.pushItem({ kind: 'notice', noticeKind: kind, text });
    this.post({ type: 'notice', kind, text });
  }

  // ---- Session management ----

  private loadSessions(): void {
    const state = this.storage.get<StoredState>(STORAGE_KEY);
    if (state && Array.isArray(state.sessions) && state.sessions.length > 0) {
      this.sessions = state.sessions.map((s) => {
        let messages = (s.messages ?? Agent.initialMessages()).slice();
        // Heal corrupt persisted state (e.g. a dangling tool_calls message) and
        // refresh to the current system prompt.
        messages = Agent.sanitizeMessages(messages);
        if (messages[0] && messages[0].role === 'system') {
          messages[0] = { role: 'system', content: Agent.systemPrompt(this.model, this.thinkingEffort) };
        }
        return { ...s, messages, displayItems: s.displayItems ?? [] };
      });
      const active = this.sessions.find((s) => s.id === state.activeSessionId);
      this.activeSessionId = active ? active.id : this.sessions[0].id;
    } else {
      this.createSessionInMemory();
    }
    // Persist the (possibly healed) state so a resumed session is always valid.
    this.persist();
  }

  private persist(): void {
    void this.storage.update(STORAGE_KEY, {
      activeSessionId: this.activeSessionId,
      sessions: this.sessions,
    } satisfies StoredState);
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
    this.activeSessionId = session.id;
    return session;
  }

  private activateSession(session: AgentSession): void {
    this.activeSessionId = session.id;
    // Point the provider and the agent at this session's live arrays so that
    // in-memory mutations during a turn are reflected in the session.
    this.displayItems = session.displayItems;
    this.agent.setMessages(session.messages);
    this.currentPromptTokens = this.getLatestPromptTokens();
    this.setBusy(false);
    this.lastStatus = '';
    this.post({ type: 'sessions', sessions: this.sessionsMeta(), activeId: this.activeSessionId });
    this.post({ type: 'reset' });
    this.post({ type: 'history', items: this.displayItems });
    this.postConfig();
    this.postContext();
  }

  private handleNewSession(): void {
    if (this.busy) {
      return;
    }
    const session = this.createSessionInMemory();
    this.activateSession(session);
    this.persist();
  }

  private handleSwitchSession(id: string): void {
    if (this.busy) {
      return;
    }
    const session = this.sessions.find((s) => s.id === id);
    if (!session || id === this.activeSessionId) {
      return;
    }
    this.activateSession(session);
  }

  private handleDeleteSession(id: string): void {
    if (this.busy) {
      return;
    }
    const idx = this.sessions.findIndex((s) => s.id === id);
    if (idx === -1) {
      return;
    }
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
    this.agent.reset();
    const session = this.getActiveSession();
    if (session) {
      session.messages = this.agent.getMessages();
      session.displayItems.length = 0;
      this.displayItems = session.displayItems;
    }
    this.setBusy(false);
    this.lastStatus = '';
    this.currentPromptTokens = 0;
    this.post({ type: 'reset' });
    this.postContext();
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
          this.post({ type: 'state', busy: this.busy, status: this.lastStatus });
          this.post({ type: 'history', items: this.displayItems });
          this.postConfig();
          this.postContext();
          break;
        case 'userMessage':
          this.onUserMessage(String(message.text ?? ''), message.attachments ?? []);
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
        case 'clear':
          this.clear();
          break;
        default:
          break;
      }
    });
  }

  private onUserMessage(text: string, attachments: UserAttachment[] = []): void {
    if (this.busy) {
      return;
    }
    const userText = text.trim();

    // Build the API content. If images are attached, send a multimodal content
    // array (images are only allowed in user messages).
    let content: string | ContentPart[];
    if (attachments.length > 0) {
      const parts: ContentPart[] = [];
      if (userText) {
        parts.push({ type: 'text', text: userText });
      }
      for (const att of attachments) {
        parts.push({ type: 'image_url', image_url: { url: att.dataUrl } });
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
      this.postNotice(
        'warning',
        'Model changed to ' + model + '. Existing conversation history was produced under a different model, so the next request may miss the prompt cache and reprocess the full context.',
      );
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
    this.agent.cancel();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.post({ type: 'state', busy, status: this.lastStatus });
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
        // Nothing to do; the assistant bubble is complete for now.
        break;
      case 'usage':
        this.logUsage(event.usage);
        this.currentPromptTokens = event.usage.prompt_tokens;
        this.postContext();
        {
          const last = this.displayItems[this.displayItems.length - 1];
          if (last && last.kind === 'assistant' && !last.error) {
            last.usage = event.usage;
            this.post({ type: 'usage', usage: event.usage });
          }
        }
        break;
      case 'toolStart':
        this.pushItem({
          kind: 'tool',
          id: event.id,
          name: event.name,
          args: event.args,
          status: 'running',
        });
        this.post({
          type: 'toolStart',
          id: event.id,
          name: event.name,
          args: event.args,
        });
        break;
      case 'toolEnd':
        this.updateToolItem(event.id, event.content);
        this.post({
          type: 'toolEnd',
          id: event.id,
          name: event.name,
          content: event.content,
        });
        break;
      case 'done':
        this.setBusy(false);
        // Preserve an informative final status (e.g. loop-limit note) if one was
        // set; otherwise fall back to a simple "Done".
        if (!this.lastStatus || this.lastStatus === 'Thinking…') {
          this.lastStatus = 'Done';
        }
        this.post({ type: 'status', text: this.lastStatus });
        this.post({ type: 'done' });
        this.persistActiveSession();
        break;
      case 'interrupted':
        this.lastStatus = 'Interrupted';
        this.setBusy(false);
        this.post({ type: 'interrupted' });
        this.persistActiveSession();
        break;
      case 'error':
        this.lastStatus = 'Error';
        this.pushItem({ kind: 'assistant', text: `⚠️ ${event.message}`, error: true });
        this.post({ type: 'error', message: event.message });
        this.setBusy(false);
        this.persistActiveSession();
        break;
      default:
        break;
    }
  }

  private pushItem(item: DisplayItem): void {
    this.displayItems.push(item);
  }

  private appendDelta(text: string): void {
    const last = this.displayItems[this.displayItems.length - 1];
    if (last && last.kind === 'assistant' && !last.error) {
      last.text = (last.text ?? '') + text;
    } else {
      this.displayItems.push({ kind: 'assistant', text });
    }
    this.post({ type: 'delta', text });
  }

  private appendThinkingDelta(text: string): void {
    const last = this.displayItems[this.displayItems.length - 1];
    if (last && last.kind === 'assistant' && !last.error) {
      last.thinking = (last.thinking ?? '') + text;
    } else {
      this.displayItems.push({ kind: 'assistant', thinking: text });
    }
    this.post({ type: 'thinkingDelta', text });
  }

  private updateToolItem(id: string, content: string): void {
    const item = this.displayItems.find((it) => it.kind === 'tool' && it.id === id);
    if (item) {
      item.status = 'done';
      item.content = content;
    }
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js'),
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
  <div id="header">
    <span id="status-dot" class="dot idle"></span>
    <span id="status-text">Ready</span>
    <div id="context" title="Context window usage">
      <div id="context-bar"><div id="context-fill"></div></div>
      <span id="context-label">ctx 0</span>
    </div>
    <button id="clear-btn" class="icon-btn" title="Clear conversation">clear</button>
  </div>
  <div id="session-bar">
    <select id="session-select" title="Switch session"></select>
    <button id="new-session-btn" class="icon-btn" title="New session">＋</button>
    <button id="delete-session-btn" class="icon-btn" title="Delete session">🗑</button>
  </div>
  <div id="config-bar">
    <label class="cfg">
      <span>Model</span>
      <select id="model-select" title="Model"></select>
    </label>
    <label class="cfg">
      <span>Effort</span>
      <select id="effort-select" title="Thinking effort">
        <option value="none">none</option>
        <option value="low">low</option>
        <option value="medium">medium</option>
        <option value="high">high</option>
      </select>
    </label>
  </div>
  <div id="messages"></div>
  <div id="composer">
    <div id="attachments"></div>
    <div id="composer-row">
      <button id="attach-btn" class="icon-btn" title="Attach image">📎</button>
      <textarea id="input" placeholder="Ask the agent… (Enter to send, Shift+Enter for newline)" rows="1"></textarea>
      <div id="actions">
        <button id="stop-btn" class="hidden">Stop</button>
        <button id="send-btn">Send</button>
      </div>
    </div>
  </div>
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
