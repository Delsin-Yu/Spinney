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
 *   6. `POST /reload-window`   ask VS Code to reload this window (202; the reply
 *                              is observed as a *new* instance on the other side)
 *
 * Bound to 127.0.0.1 and gated by a bearer token generated per process; the
 * port/token are written to `<globalStorage>/http/<instanceId>.json` (0600) so
 * the supervisor can discover them. `AGENT_HARNESS_INSTANCE_ID`,
 * `AGENT_HARNESS_HTTP_PORT` and `AGENT_HARNESS_HTTP_TOKEN` override the
 * discovery identity (the supervisor sets the instance id when it spawns `code`).
 *
 * `/continue` makes the agent run a caller-supplied instruction, i.e. it is a
 * local-trust RCE boundary: keep `agentHarness.httpApi.enabled` off unless a
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
    this.instanceId = (process.env.AGENT_HARNESS_INSTANCE_ID ?? '').trim() || `pid-${process.pid}`;
    this.token = (process.env.AGENT_HARNESS_HTTP_TOKEN ?? '').trim() || crypto.randomBytes(24).toString('hex');
  }

  /** Start listening when enabled; a no-op otherwise. Never throws. */
  async start(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('agentHarness');
    // Off by default; a supervisor may opt in per instance with the env var.
    const enabled = (cfg.get<boolean>('httpApi.enabled') ?? false) || process.env.AGENT_HARNESS_HTTP === '1';
    if (!enabled) {
      return;
    }
    const configured = cfg.get<number>('httpApi.port') ?? 0;
    const envPort = Number(process.env.AGENT_HARNESS_HTTP_PORT ?? '');
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
        version: vscode.extensions.getExtension('minimal-host.minimal-agent-harness')?.packageJSON?.version ?? '',
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
