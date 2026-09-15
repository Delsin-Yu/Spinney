/**
 * Local HTTP control plane (opt-in, off by default).
 *
 * The extension cannot reload its own window and report back — it dies with the
 * reload. So the external supervisor (`tools/hyper-vscode`, the `hvsc` CLI) owns
 * the process lifecycle and uses this endpoint to:
 *
 *   1. `GET  /health`          is the new instance up?
 *   2. `GET  /state`           which session/node is checked out, is it busy?
 *   3. `POST /wait-for-finish` block until the agent is idle (and its last write
 *                              is flushed) — the caller then kills the process
 *   4. `POST /navigate`        check out a node (and open the panel)
 *   5. `POST /continue`        send a user message that continues from a node
 *   6. `POST /session/start`   create (or jump to) a session and optionally send
 *                              a caller-supplied prompt as its first turn
 *   7. `POST /stop`            cancel a node's run (or every run of a session)
 *   8. `POST /reload-window`   ask VS Code to reload this window (202; the reply
 *                              is observed as a *new* instance on the other side)
 *
 * Bound to 127.0.0.1 and gated by a bearer token generated per process; the
 * port/token are written to `<globalStorage>/http/<instanceId>.json` (0600) so
 * the supervisor can discover them. `SPINNEY_INSTANCE_ID`,
 * `SPINNEY_HTTP_PORT` and `SPINNEY_HTTP_TOKEN` override the
 * discovery identity (the supervisor sets the instance id when it spawns `code`).
 *
 * `/continue` makes the agent run a caller-supplied instruction, i.e. it is a
 * local-trust RCE boundary: keep `spinney.httpApi.enabled` off unless a
 * controller needs it, and never log the token.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';

export interface ControlSessionInfo {
  id: string;
  title: string;
  nodes: number;
  active: boolean;
  /** Origin of the title ('provisional' | 'auto' | 'manual'); absent ⇒ provisional. */
  titleSource?: string;
  /** A manual rename locked the title, so automatic naming leaves it alone. */
  titleLocked?: boolean;
  /** True while this session has an in-flight turn (or an image upload). */
  running: boolean;
  /** Node ids of the session's live turn runs (empty when idle). */
  runningNodes: string[];
  /**
   * Node ids that are not streaming but still own unfinished work — a running
   * background terminal, a running sub-agent batch, or a completion notice waiting
   * to be injected into them. A send from such a node is refused (`/continue`,
   * `/session/start`) and the composer is locked (same rule as the webview).
   */
  lockedNodes: string[];
  /** True while this session owns at least one running background terminal. */
  runningBackgrounds: boolean;
  /** Node ids that own at least one still-running background terminal (P2). */
  backgroundNodes: string[];
  /**
   * The model / thinking effort this session runs with (P4: the selection is per
   * session, so each tab may differ). Strings on purpose — the control plane is a
   * wire readout and never validates a model id.
   */
  model?: string;
  effort?: string;
}

export interface ControlState {
  busy: boolean;
  sessionId: string | null;
  activeNodeId: string | null;
  runningSubAgents: number;
  runningBackgrounds: boolean;
  sessions: ControlSessionInfo[];
}

export interface ControlResult {
  ok: boolean;
  error?: string;
  idle?: boolean;
  sessionId?: string | null;
  nodeId?: string | null;
  busy?: boolean;
  runningSubAgents?: number;
  runningBackgrounds?: boolean;
  /** `POST /session/start`: whether the caller's prompt was sent as a turn. */
  prompted?: boolean;
  /** `POST /session/start`: the start was queued to run when the turn ends. */
  queued?: boolean;
  /** `POST /stop`: how many agents (one per run) were cancelled. */
  stopped?: number;
}

export interface WaitForFinishOptions {
  /** `turn` (default) = no in-flight turn; `all` = also no sub-agents/background jobs. */
  scope?: 'turn' | 'all';
  timeoutMs?: number;
  /** Hold the session idle for this long after returning (blocks new turns). */
  holdMs?: number;
  /** Escape hatch: cancel the running turn instead of waiting for it. */
  interrupt?: boolean;
}

/** What the provider must implement for the server to be useful. */
export interface ControlHost {
  controlState(): ControlState;
  controlWaitForFinish(opts: WaitForFinishOptions): Promise<ControlResult>;
  controlNavigate(opts: { sessionId?: string; nodeId: string }): Promise<ControlResult>;
  controlContinueFrom(opts: { sessionId?: string; nodeId?: string; message: string }): Promise<ControlResult>;
  /**
   * Stop runs: `nodeId`'s run only when given, otherwise every run of the session
   * (`sessionId`, else the active session). Never weakens the reload hold. A
   * session that is unknown is refused (409); nothing running is `stopped: 0`.
   */
  controlStop(opts: { sessionId?: string; nodeId?: string }): Promise<ControlResult>;
  /**
   * Start a session and optionally send a caller-supplied prompt as its first
   * turn. Without `sessionId` a fresh session is created (and titled from the
   * prompt); with it the caller jumps to that session instead. `returnTo` arms a
   * hop: the fresh session's final answer is delivered back to the session that
   * was active when the hop was queued, as a new branch off `returnNodeId` when
   * that is given. `nodeId` checks out a node in the target session first.
   */
  controlStartSession(opts: {
    sessionId?: string;
    nodeId?: string;
    title?: string;
    prompt?: string;
    returnTo?: boolean;
    returnNodeId?: string;
  }): Promise<ControlResult>;
  /**
   * Reload this window (`workbench.action.reloadWindow`). The only way to restart
   * an instance that shares the user's profile — the supervisor cannot kill it
   * without killing every other window of the same main process.
   */
  controlReloadWindow(): ControlResult;
}

const MAX_BODY = 64 * 1024;

export class ControlServer implements vscode.Disposable {
  private server: http.Server | null = null;
  private readonly token: string;
  private discoveryFile: string | null = null;
  private readonly instanceId: string;
  private readonly startedAt = Date.now();

  constructor(
    private readonly host: ControlHost,
    private readonly globalStorage: vscode.Uri | undefined,
    private readonly log: (line: string) => void,
  ) {
    this.instanceId = (process.env.SPINNEY_INSTANCE_ID ?? '').trim() || `pid-${process.pid}`;
    this.token = (process.env.SPINNEY_HTTP_TOKEN ?? '').trim() || crypto.randomBytes(24).toString('hex');
  }

  /** Start listening when enabled; a no-op otherwise. Never throws. */
  async start(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('spinney');
    // Off by default; a supervisor may opt in per instance with the env var.
    const enabled = (cfg.get<boolean>('httpApi.enabled') ?? false) || process.env.SPINNEY_HTTP === '1';
    if (!enabled) {
      return;
    }
    const configured = cfg.get<number>('httpApi.port') ?? 0;
    const envPort = Number(process.env.SPINNEY_HTTP_PORT ?? '');
    const port = Number.isFinite(envPort) && envPort > 0 ? envPort : configured;
    try {
      const server = http.createServer((req, res) => {
        void this.handle(req, res);
      });
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server.once('error', onError);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', onError);
          resolve();
        });
      });
      this.server = server;
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      this.writeDiscovery(actualPort);
      this.log(`[http] control plane on http://127.0.0.1:${actualPort} (instance ${this.instanceId})`);
      if (this.discoveryFile) {
        this.log(`[http] discovery: ${this.discoveryFile}`);
      }
    } catch (err) {
      this.log(`[http] control plane failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Re-read the configuration and rebind the listener. Called when
   * `spinney.httpApi.*` changes, so enabling/disabling the control plane
   * (or moving its port) does not need a window reload. `start()` is a no-op
   * when the plane is disabled, which is how a disable takes effect.
   */
  async restart(): Promise<void> {
    this.dispose();
    await this.start();
  }

  dispose(): void {
    this.server?.close();
    this.server = null;
    if (this.discoveryFile) {
      try {
        fs.rmSync(this.discoveryFile, { force: true });
      } catch {
        // Best effort: a stale file is pruned by the supervisor's pid check.
      }
      this.discoveryFile = null;
    }
  }

  private writeDiscovery(port: number): void {
    if (!this.globalStorage) {
      return;
    }
    try {
      const dir = path.join(this.globalStorage.fsPath, 'http');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${this.instanceId}.json`);
      const payload = {
        instanceId: this.instanceId,
        pid: process.pid,
        port,
        token: this.token,
        workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
        startedAt: this.startedAt,
        version: vscode.extensions.getExtension('de-yu.spinney')?.packageJSON?.version ?? '',
      };
      fs.writeFileSync(file, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
      this.discoveryFile = file;
    } catch (err) {
      this.log(`[http] could not write the discovery file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body: unknown): void => {
      const text = JSON.stringify(body ?? {});
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(text);
    };
    try {
      const remote = req.socket.remoteAddress ?? '';
      if (remote && remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
        send(403, { ok: false, error: 'loopback only' });
        return;
      }
      if (req.headers.authorization !== `Bearer ${this.token}`) {
        send(401, { ok: false, error: 'unauthorized' });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const route = `${req.method ?? 'GET'} ${url.pathname.replace(/\/+$/, '') || '/'}`;

      if (route === 'GET /health') {
        const state = this.host.controlState();
        send(200, {
          ok: true,
          instanceId: this.instanceId,
          pid: process.pid,
          port: (this.server?.address() as { port?: number } | null)?.port ?? null,
          startedAt: this.startedAt,
          busy: state.busy,
          sessionId: state.sessionId,
        });
        return;
      }
      if (route === 'GET /state') {
        send(200, { ok: true, ...this.host.controlState() });
        return;
      }
      if (route === 'POST /wait-for-finish') {
        const body = await this.readBody(req);
        const result = await this.host.controlWaitForFinish({
          scope: body.scope === 'all' ? 'all' : 'turn',
          timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : 30000,
          holdMs: typeof body.holdMs === 'number' ? body.holdMs : 0,
          interrupt: body.interrupt === true,
        });
        send(result.ok ? 200 : 408, result);
        return;
      }
      if (route === 'POST /navigate') {
        const body = await this.readBody(req);
        if (typeof body.nodeId !== 'string' || !body.nodeId) {
          send(400, { ok: false, error: 'nodeId is required' });
          return;
        }
        const result = await this.host.controlNavigate({
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
          nodeId: body.nodeId,
        });
        send(result.ok ? 200 : 409, result);
        return;
      }
      if (route === 'POST /continue') {
        const body = await this.readBody(req);
        if (typeof body.message !== 'string' || !body.message.trim()) {
          send(400, { ok: false, error: 'message is required (supplied by the caller)' });
          return;
        }
        const result = await this.host.controlContinueFrom({
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
          nodeId: typeof body.nodeId === 'string' ? body.nodeId : undefined,
          message: body.message,
        });
        send(result.ok ? 200 : 409, result);
        return;
      }
      if (route === 'POST /stop') {
        const body = await this.readBody(req);
        const result = await this.host.controlStop({
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
          nodeId: typeof body.nodeId === 'string' ? body.nodeId : undefined,
        });
        send(result.ok ? 200 : 409, result);
        return;
      }
      if (route === 'POST /session/start') {
        const body = await this.readBody(req);
        const result = await this.host.controlStartSession({
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
          nodeId: typeof body.nodeId === 'string' ? body.nodeId : undefined,
          title: typeof body.title === 'string' ? body.title : undefined,
          prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
          returnTo: body.returnTo === true,
          returnNodeId: typeof body.returnNodeId === 'string' ? body.returnNodeId : undefined,
        });
        send(result.ok ? (result.queued ? 202 : 200) : 409, result);
        return;
      }
      if (route === 'POST /reload-window') {
        const result = this.host.controlReloadWindow();
        send(result.ok ? 202 : 409, result);
        return;
      }
      send(404, { ok: false, error: `unknown route: ${route}` });
    } catch (err) {
      send(500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new Error('request body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        if (!text) {
          resolve({});
          return;
        }
        try {
          const parsed = JSON.parse(text);
          resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {});
        } catch {
          reject(new Error('invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }
}
