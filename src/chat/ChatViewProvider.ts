import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Agent } from '../agent/agent';
import { DeepSeekClient } from '../agent/deepseek';
import { AgentEvent, ChatMessage, ContentPart, Usage } from '../agent/types';
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

interface UserAttachment {
  dataUrl: string;
  name?: string;
}

interface DisplayItem {
  kind: 'user' | 'assistant' | 'tool';
  id?: string;
  text?: string;
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
  private contextWindow = DEFAULT_CONTEXT_WINDOW;
  private currentPromptTokens = 0;
  private sessions: AgentSession[] = [];
  private activeSessionId = '';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly storage: vscode.Memento,
  ) {
    this.output = vscode.window.createOutputChannel('Agent Harness');
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
  } {
    const cfg = vscode.workspace.getConfiguration('agentHarness');
    const apiKey = (cfg.get<string>('apiKey') ?? '').trim() || (process.env.DEEPSEEK_API_KEY ?? '').trim();
    const model = cfg.get<string>('model') ?? 'deepseek-chat';
    const baseUrl = cfg.get<string>('baseUrl') ?? 'https://api.deepseek.com';
    const maxTurns = cfg.get<number>('maxTurns') ?? 20;
    return { apiKey, model, baseUrl, maxTurns };
  }

  private buildAgent(): void {
    const { apiKey, model, baseUrl, maxTurns } = this.getConfig();
    this.model = model;
    this.contextWindow = this.getContextWindow(model);
    const client = new DeepSeekClient({ apiKey, baseUrl, model });
    const tools = new ToolRegistry();
    this.agent = new Agent(client, tools, (event) => this.handleAgentEvent(event), maxTurns);
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

  // ---- Session management ----

  private loadSessions(): void {
    const state = this.storage.get<StoredState>(STORAGE_KEY);
    if (state && Array.isArray(state.sessions) && state.sessions.length > 0) {
      this.sessions = state.sessions.map((s) => {
        const messages = s.messages ?? Agent.initialMessages();
        // Refresh persisted sessions to use the current system prompt.
        if (messages[0] && messages[0].role === 'system') {
          messages[0] = { role: 'system', content: Agent.systemPrompt() };
        }
        return { ...s, messages, displayItems: s.displayItems ?? [] };
      });
      const active = this.sessions.find((s) => s.id === state.activeSessionId);
      this.activeSessionId = active ? active.id : this.sessions[0].id;
    } else {
      this.createSessionInMemory();
    }
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
      messages: Agent.initialMessages(),
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
