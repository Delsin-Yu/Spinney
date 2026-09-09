#!/usr/bin/env node
/**
 * Hyper-Vscode (`hvsc`) — a workspace-local supervisor for VS Code instances.
 *
 * It owns the process lifecycle (so a "reboot" is just kill + relaunch with the
 * same argv) and exposes a local HTTP endpoint for callers such as the harness
 * agent. The harness side lives behind its own opt-in control plane
 * (`agentHarness.httpApi.enabled`), discovered through
 * `<globalStorage>/http/<instanceId>.json`.
 *
 *   hvsc serve   [--port 7777] [--start <workspace>] [--isolated]   # daemon (run outside VS Code)
 *   hvsc start   <workspace> [--isolated] [--arg <codeArg>]         # launch an instance
 *   hvsc status                                        # list instances
 *   hvsc rm      <instanceId|--stale> [--kill]         # forget (optionally kill an isolated one)
 *   hvsc reboot  <instanceId|--all> --continue "<message>" [--reason "..."] [--wait]
 *   hvsc jobs    [<jobId>]
 *
 * Instances are launched with **profile passthrough** by default (no
 * `--user-data-dir`), so the new window shares the user's profile and therefore
 * the same chat state. The control plane must then be enabled in the user's
 * settings (`agentHarness.httpApi.enabled`), because `code -n` attaches to the
 * running main process and our env vars do not reach the new window. `--isolated`
 * keeps the old behaviour (own profile, own main process → hard kill/relaunch).
 *
 * Daemon API (bearer token in .state/daemon.json):
 *   GET  /health
 *   GET  /instances
 *   POST /instances                { workspace, args?, isolated? }
 *   POST /instances/:id/reboot     { reason?, continue?, timeoutMs?, scope?, wait? }
 *   GET  /jobs/:id
 *   DELETE /instances/:id          { kill? }  # forget a record (kill an isolated one)
 *
 * State lives in .state/ (daemon.json, instances.json, daemon.log) so a daemon
 * restart re-adopts the instances it previously launched.
 *
 * This tool is NOT shipped with the extension (excluded via .vscodeignore).
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(TOOL_DIR, '.state');
const STATE_FILE = join(STATE_DIR, 'daemon.json');
const INSTANCES_FILE = join(STATE_DIR, 'instances.json');
const LOG_FILE = join(STATE_DIR, 'daemon.log');
const EXT_ID = 'minimal-host.minimal-agent-harness';

// ---------------------------------------------------------------- utilities

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Append to .state/daemon.log and echo to the console (best effort). */
function log(line) {
  const stamp = new Date().toISOString();
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `${stamp} ${line}\n`, { flag: 'a' });
  } catch {
    /* logging must never break the daemon */
  }
  console.log(`[hvsc] ${line}`);
}

/** Keep the daemon alive on unexpected errors instead of dying silently. */
function installCrashGuards() {
  process.on('uncaughtException', (err) => {
    log(`UNCAUGHT ${err?.stack ?? err}`);
  });
  process.on('unhandledRejection', (reason) => {
    log(`UNHANDLED_REJECTION ${reason instanceof Error ? reason.stack : String(reason)}`);
  });
}

function argValue(argv, name, fallback = undefined) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function collectArgs(argv, name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && i + 1 < argv.length) out.push(argv[i + 1]);
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/** Where the extension writes its per-process discovery files. */
function globalStorageDirs() {
  const dirs = [];
  const push = (p) => p && dirs.push(p);
  push(process.env.HYPER_VSCODE_GLOBAL_STORAGE);
  const appData = process.env.APPDATA;
  if (appData) {
    for (const flavor of ['Code', 'Code - Insiders', 'Cursor', 'VSCodium']) {
      push(join(appData, flavor, 'User', 'globalStorage', EXT_ID));
    }
  }
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    push(join(home, '.config', 'Code', 'User', 'globalStorage', EXT_ID));
    push(join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', EXT_ID));
  }
  return dirs;
}

/** All live harness discovery records (stale pids are pruned). */
function readDiscoveries() {
  const out = [];
  for (const dir of globalStorageDirs()) {
    const httpDir = join(dir, 'http');
    if (!existsSync(httpDir)) continue;
    for (const file of readdirSync(httpDir)) {
      if (!file.endsWith('.json')) continue;
      const full = join(httpDir, file);
      const rec = readJson(full);
      if (!rec || typeof rec.port !== 'number') {
        rmSync(full, { force: true });
        continue;
      }
      if (typeof rec.pid === 'number' && !pidAlive(rec.pid)) {
        rmSync(full, { force: true });
        continue;
      }
      out.push({ ...rec, file: full });
    }
  }
  return out;
}

/**
 * Find the harness control plane for an instance. In passthrough mode the
 * `AGENT_HARNESS_INSTANCE_ID` env never reaches the new window (it attaches to
 * the running main process), so fall back to "same workspace, started after we
 * launched it, newest first".
 */
/** A recovered record only counts as alive if its control plane appeared soon
 * after we launched (or reloaded) it — not hours later, which is another window. */
const MATCH_WINDOW_MS = 30 * 60 * 1000;

function matchDiscovery(record, claimed) {
  const all = readDiscoveries().filter((d) => !claimed || !claimed.has(d.file));
  const byId = all.find((d) => d.instanceId === record.id);
  if (byId) return byId;
  const since = record.launchedAt ?? record.startedAt ?? 0;
  return (
    all
      .filter(
        (d) =>
          samePath(d.workspace, record.workspace) &&
          (d.startedAt ?? 0) >= since &&
          (d.startedAt ?? 0) - since < MATCH_WINDOW_MS,
      )
      .sort((a, b) => a.startedAt - since - (b.startedAt - since))[0] ?? null
  );
}

/**
 * The harness endpoint a record points at dies with its extension host (window
 * reload, extension-host restart, crash), which leaves a live window behind a
 * *new* discovery file and port. Probe the cached endpoint and re-discover when
 * it no longer answers, so `reboot` never drives a closed port.
 */
async function resolveHarness(record, timeoutMs = 5000) {
  if (record.harness) {
    try {
      const health = await harnessFetch(record.harness, '/health', { timeoutMs });
      if (health.status === 200 && health.json?.ok) return record.harness;
    } catch {
      /* stale endpoint: fall through to re-discovery */
    }
  }
  return matchDiscovery(record) ?? record.harness;
}

async function harnessFetch(rec, path, { method = 'GET', body, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${rec.port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${rec.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------- VS Code control

function userExtensionsDir() {
  if (process.env.HYPER_VSCODE_EXTENSIONS_DIR) return process.env.HYPER_VSCODE_EXTENSIONS_DIR;
  const home = process.env.USERPROFILE || process.env.HOME;
  return home ? join(home, '.vscode', 'extensions') : null;
}

/** The managed profile has its own settings, so bridge the API key from the user's. */
function deepSeekKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const candidates = [];
  const appData = process.env.APPDATA;
  if (appData) candidates.push(join(appData, 'Code', 'User', 'settings.json'));
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) candidates.push(join(home, '.config', 'Code', 'User', 'settings.json'));
  for (const file of candidates) {
    const settings = readJson(file);
    const key = settings?.['agentHarness.apiKey'];
    if (typeof key === 'string' && key.trim()) return key.trim();
  }
  return null;
}

/**
 * Resolve a `code` launcher that can be spawned **without a shell**. Node refuses
 * to exec .cmd/.bat directly and `shell:true` does not escape arguments
 * (DEP0190), so on Windows we prefer the real `Code.exe` next to `bin\code.cmd`.
 */
function resolveCodeExe() {
  const explicit = process.env.HYPER_VSCODE_CODE;
  if (explicit) return explicit;
  if (process.platform !== 'win32') return 'code';
  const r = run('where', ['code']);
  for (const raw of r.out.split(/\r?\n/)) {
    const p = raw.trim();
    if (!p) continue;
    if (/code\.exe$/i.test(p)) return p;
    if (/code\.cmd$/i.test(p)) {
      const exe = join(dirname(p), '..', 'Code.exe');
      if (existsSync(exe)) return resolve(exe);
    }
  }
  return 'Code.exe';
}

/**
 * Launch a managed instance.
 *
 * Default is **profile passthrough**: no `--user-data-dir`, so the new window
 * shares the user's profile (and therefore the same `workspaceState` — the chat
 * session the supervisor wants to talk to). Caveat: `code -n` then attaches to
 * the already-running main process, so our env vars are **not** propagated; the
 * control plane must be enabled in the user's settings instead.
 *
 * `isolated:true` keeps the old behaviour (own `--user-data-dir`, own main
 * process) which allows a hard kill/relaunch but has a separate chat state.
 */
function launchCode(instanceId, workspace, extraArgs = [], opts = {}) {
  const isolated = opts.isolated === true;
  const args = ['-n', workspace];
  let userDataDir = null;
  if (isolated) {
    userDataDir = join(STATE_DIR, `ud-${instanceId}`);
    mkdirSync(userDataDir, { recursive: true });
    args.push(`--user-data-dir=${userDataDir}`);
  }
  const extDir = userExtensionsDir();
  if (extDir) args.push(`--extensions-dir=${extDir}`);
  args.push(...extraArgs);
  const env = { ...process.env, AGENT_HARNESS_INSTANCE_ID: instanceId, AGENT_HARNESS_HTTP: '1' };
  const key = deepSeekKey();
  if (key) env.DEEPSEEK_API_KEY = key;
  const child = spawn(resolveCodeExe(), args, {
    detached: true,
    stdio: 'ignore',
    shell: false,
    env,
  });
  child.unref();
  log(`launch ${instanceId}${isolated ? ' (isolated)' : ' (passthrough)'}: ${resolveCodeExe()} ${args.join(' ')}`);
  return { pid: child.pid, args, isolated, userDataDir, launchedAt: Date.now() };
}

/** Parent of a pid (the VS Code window process owns the extension host). */
function parentPid(pid) {
  if (process.platform === 'win32') {
    const r = run('powershell', [
      '-NoProfile',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
    ]);
    const n = Number(r.out);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const r = run('ps', ['-o', 'ppid=', '-p', String(pid)]);
  const n = Number(r.out);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function killWindow(extensionHostPid) {
  const target = parentPid(extensionHostPid) ?? extensionHostPid;
  if (process.platform === 'win32') {
    run('taskkill', ['/PID', String(target), '/T', '/F']);
    if (target !== extensionHostPid) run('taskkill', ['/PID', String(extensionHostPid), '/T', '/F']);
  } else {
    try {
      process.kill(target, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  return target;
}

function samePath(a, b) {
  if (!a || !b) return false;
  return resolve(a).replace(/[\\/]+/g, '/').toLowerCase() === resolve(b).replace(/[\\/]+/g, '/').toLowerCase();
}

async function waitForHarness(record, since, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rec = matchDiscovery(record);
    if (rec && (rec.startedAt ?? 0) >= since) {
      try {
        const health = await harnessFetch(rec, '/health', { timeoutMs: 5000 });
        if (health.status === 200 && health.json?.ok) return rec;
      } catch {
        /* not up yet */
      }
    }
    await sleep(500);
  }
  return null;
}

// ------------------------------------------------------------------- daemon

/** Bind `server`, falling back to the next port when one is taken (NVIDIA's
 * nvcontainer.exe squats 7770-7778 on this machine, for example). */
async function listenWithRetry(server, startPort, tries = 10) {
  for (let i = 0; i < tries; i++) {
    const candidate = startPort + i;
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(candidate, '127.0.0.1');
      });
      if (candidate !== startPort) log(`port ${startPort} is in use, using ${candidate}`);
      return candidate;
    } catch (err) {
      if (err?.code !== 'EADDRINUSE') throw err;
      log(`port ${candidate} is in use`);
    }
  }
  throw new Error(`no free port in ${startPort}..${startPort + tries - 1}`);
}

async function serve(argv) {
  installCrashGuards();
  const port = Number(argValue(argv, '--port', '7788'));
  const startWorkspace = argValue(argv, '--start');
  const startIsolated = hasFlag(argv, '--isolated');
  const token = randomBytes(24).toString('hex');
  mkdirSync(STATE_DIR, { recursive: true });
  const existing = readJson(STATE_FILE);
  if (existing?.pid && pidAlive(existing.pid) && existing.pid !== process.pid) {
    log(`another daemon is already running (pid ${existing.pid}, port ${existing.port}).`);
    process.exit(1);
  }
  let actualPort = port;

  /** @type {Map<string, any>} */
  const instances = new Map();
  /** @type {Map<string, any>} */
  const jobs = new Map();

  const saveInstances = () => {
    try {
      writeFileSync(INSTANCES_FILE, JSON.stringify([...instances.values()], null, 2));
    } catch (err) {
      log(`could not persist instances: ${err?.message ?? err}`);
    }
  };

  /**
   * Point a record at its *live* harness endpoint and persist the correction.
   * Without this a record keeps aiming at the port of an extension host that has
   * since been replaced, and every later `/wait-for-finish` fails with
   * "fetch failed". Returns the live endpoint (or null when there is none).
   */
  async function refreshRecord(record, timeoutMs = 5000) {
    const rec = await resolveHarness(record, timeoutMs);
    if (rec && rec !== record.harness) {
      const was = record.harness?.port;
      record.harness = rec;
      record.alive = true;
      saveInstances();
      log(`${record.id} harness re-discovered on port ${rec.port} (was ${was ?? 'none'})`);
    }
    return rec;
  }

  // Re-adopt instances recorded by a previous daemon run (a daemon restart used
  // to orphan them: the records only lived in memory). Newest first, and a
  // discovery file may be claimed by only one record.
  const claimed = new Set();
  for (const rec of (readJson(INSTANCES_FILE) ?? []).filter((r) => r?.id).sort((a, b) => (b.launchedAt ?? 0) - (a.launchedAt ?? 0))) {
    rec.harness = matchDiscovery(rec, claimed);
    if (rec.harness) {
      claimed.add(rec.harness.file);
    }
    rec.alive = !!rec.harness;
    instances.set(rec.id, rec);
    log(`recovered instance ${rec.id} (${rec.alive ? `harness :${rec.harness.port}` : 'no live harness'})`);
  }
  if (instances.size > 0) {
    saveInstances();
  }

  async function startInstance(workspace, extraArgs = [], opts = {}) {
    const id = randomUUID().slice(0, 8);
    const abs = resolve(workspace);
    const launched = launchCode(id, abs, extraArgs, opts);
    const record = {
      id,
      workspace: abs,
      extraArgs,
      isolated: launched.isolated,
      codePid: launched.pid ?? null,
      codeArgs: launched.args,
      launchedAt: launched.launchedAt,
      startedAt: launched.launchedAt,
      harness: null,
      alive: false,
    };
    instances.set(id, record);
    saveInstances();
    record.harness = await waitForHarness(record, record.launchedAt, 180000);
    record.alive = !!record.harness;
    saveInstances();
    return record;
  }

  async function rebootInstance(record, opts, job) {
    const mark = (step) => {
      job.steps.push({ at: Date.now(), step });
      log(`${record.id} ${step}`);
    };
    const rec0 = await refreshRecord(record);
    if (!rec0) throw new Error('no harness endpoint discovered for this instance (is agentHarness.httpApi.enabled on?)');
    mark('wait-for-finish');
    const waited = await harnessFetch(rec0, '/wait-for-finish', {
      method: 'POST',
      body: { scope: opts.scope ?? 'all', timeoutMs: opts.timeoutMs ?? 60000, holdMs: opts.holdMs ?? 0, interrupt: opts.interrupt === true },
      timeoutMs: (opts.timeoutMs ?? 60000) + 10000,
    });
    if (waited.status !== 200) {
      throw new Error(`agent did not go idle: ${JSON.stringify(waited.json)}`);
    }
    const carry = { sessionId: waited.json?.sessionId ?? null, nodeId: waited.json?.nodeId ?? null };
    mark(`idle (session=${carry.sessionId} node=${carry.nodeId})`);
    if (record.isolated) {
      // Own main process: a hard kill can only affect this instance.
      rmSync(rec0.file, { force: true });
      mark('killing window');
      killWindow(rec0.pid);
      const killDeadline = Date.now() + 30000;
      while (Date.now() < killDeadline && pidAlive(rec0.pid)) await sleep(300);
      mark('relaunching');
      const launched = launchCode(record.id, record.workspace, record.extraArgs ?? [], { isolated: true });
      record.codePid = launched.pid ?? null;
      record.launchedAt = launched.launchedAt;
    } else {
      // Shared profile: the extension host's parent is the *user's* main process,
      // so killing it would take every window down. Ask the harness to reload.
      mark('reload-window (shared profile)');
      const reload = await harnessFetch(rec0, '/reload-window', { method: 'POST', body: {}, timeoutMs: 15000 });
      if (reload.status !== 202) throw new Error(`/reload-window failed: ${JSON.stringify(reload.json)}`);
      record.launchedAt = Date.now();
    }
    const fresh = await waitForHarness(record, record.launchedAt, 180000);
    if (!fresh) throw new Error('the instance did not come back within 180s');
    record.harness = fresh;
    record.alive = true;
    saveInstances();
    mark(`back up on port ${fresh.port}`);
    if (opts.continueMessage) {
      mark('continue');
      const cont = await harnessFetch(fresh, '/continue', {
        method: 'POST',
        body: { sessionId: carry.sessionId, nodeId: carry.nodeId, message: opts.continueMessage },
        timeoutMs: 30000,
      });
      if (cont.status !== 200) throw new Error(`/continue failed: ${JSON.stringify(cont.json)}`);
    }
    mark('completed');
    return { carry, harness: { port: fresh.port, pid: fresh.pid } };
  }

  function startJob(record, opts) {
    const job = { id: randomUUID().slice(0, 8), instanceId: record.id, status: 'running', startedAt: Date.now(), steps: [], error: null, result: null };
    jobs.set(job.id, job);
    void rebootInstance(record, opts, job)
      .then((result) => {
        job.status = 'completed';
        job.result = result;
      })
      .catch((err) => {
        job.status = 'failed';
        job.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        job.endedAt = Date.now();
      });
    return job;
  }

  const server = createServer((req, res) => {
    const send = (status, body) => {
      if (res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body ?? {}));
    };
    void (async () => {
      try {
        const remote = req.socket.remoteAddress ?? '';
        if (remote && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return send(403, { ok: false, error: 'loopback only' });
        if (req.headers.authorization !== `Bearer ${token}`) return send(401, { ok: false, error: 'unauthorized' });
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
        const body = await new Promise((resolve) => {
          let text = '';
          req.on('data', (c) => {
            text += c;
            if (text.length > 64 * 1024) req.destroy();
          });
          req.on('end', () => {
            try {
              resolve(text.trim() ? JSON.parse(text) : {});
            } catch {
              resolve({});
            }
          });
        });

        if (req.method === 'GET' && parts[0] === 'health') {
          return send(200, { ok: true, pid: process.pid, port: actualPort, instances: instances.size, jobs: jobs.size });
        }
        if (req.method === 'GET' && parts[0] === 'instances' && parts.length === 1) {
          // Re-point stale records before reporting: an extension-host restart
          // moves the control plane to a new port, and reporting the dead one as
          // "alive" hides a perfectly live window (this is how a reboot job ends
          // up failing at its first step with "fetch failed").
          for (const record of instances.values()) {
            record.harnessLive = !!(await refreshRecord(record, 1500));
          }
          return send(200, { ok: true, instances: [...instances.values()] });
        }
        if (req.method === 'POST' && parts[0] === 'instances' && parts.length === 1) {
          if (!body.workspace) return send(400, { ok: false, error: 'workspace is required' });
          const record = await startInstance(
            String(body.workspace),
            Array.isArray(body.args) ? body.args.map(String) : [],
            { isolated: body.isolated === true },
          );
          return send(201, { ok: true, instance: record });
        }
        if (req.method === 'POST' && parts[0] === 'instances' && parts[2] === 'reboot') {
          const record = instances.get(parts[1]);
          if (!record) return send(404, { ok: false, error: `no such instance: ${parts[1]}` });
          const opts = {
            reason: body.reason ?? '',
            continueMessage: typeof body.continue === 'string' ? body.continue : '',
            timeoutMs: Number.isFinite(body.timeoutMs) ? body.timeoutMs : 60000,
            scope: body.scope === 'turn' ? 'turn' : 'all',
            holdMs: Number.isFinite(body.holdMs) ? body.holdMs : 0,
            interrupt: body.interrupt === true,
          };
          const job = startJob(record, opts);
          if (body.wait) {
            while (job.status === 'running') await sleep(250);
            return send(job.status === 'completed' ? 200 : 500, { ok: job.status === 'completed', job });
          }
          return send(202, { ok: true, jobId: job.id, status: job.status });
        }
        if (req.method === 'DELETE' && parts[0] === 'instances' && parts[1]) {
          const record = instances.get(parts[1]);
          if (!record) return send(404, { ok: false, error: `no such instance: ${parts[1]}` });
          let killed = false;
          if (body.kill === true) {
            if (!record.isolated) {
              return send(409, {
                ok: false,
                error:
                  'shared-profile instance: killing it would take every window of the same main process down. ' +
                  'Use `hvsc reboot` (control plane /reload-window), or forget it without --kill.',
              });
            }
            const rec = await resolveHarness(record);
            if (rec) {
              rmSync(rec.file, { force: true });
              killWindow(rec.pid);
            } else if (record.codePid) {
              killWindow(record.codePid);
            }
            killed = true;
          }
          instances.delete(parts[1]);
          saveInstances();
          log(`removed instance ${parts[1]}${killed ? ' (killed)' : ''}`);
          return send(200, { ok: true, removed: parts[1], killed });
        }
        if (req.method === 'GET' && parts[0] === 'jobs' && parts.length === 1) {
          return send(200, { ok: true, jobs: [...jobs.values()] });
        }
        if (req.method === 'GET' && parts[0] === 'jobs' && parts[1]) {
          const job = jobs.get(parts[1]);
          return job ? send(200, { ok: true, job }) : send(404, { ok: false, error: 'no such job' });
        }
        send(404, { ok: false, error: `unknown route: ${req.method} ${url.pathname}` });
      } catch (err) {
        send(500, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });

  server.on('clientError', (err, socket) => {
    log(`client error: ${err?.message ?? err}`);
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  try {
    actualPort = await listenWithRetry(server, port);
  } catch (err) {
    log(`could not listen: ${err?.message ?? err}`);
    process.exit(1);
  }
  writeFileSync(STATE_FILE, JSON.stringify({ port: actualPort, token, pid: process.pid, startedAt: Date.now() }, null, 2));
  log(`daemon on http://127.0.0.1:${actualPort} (token in ${STATE_FILE})`);
  if (startWorkspace) {
    void startInstance(startWorkspace, [], { isolated: startIsolated })
      .then((r) => log(`started ${r.id} -> ${r.workspace}${r.harness ? ` (harness :${r.harness.port})` : ' (harness endpoint not found)'}`))
      .catch((e) => log(`start failed: ${e?.message ?? e}`));
  }
  const shutdown = () => {
    rmSync(STATE_FILE, { force: true });
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ------------------------------------------------------------- CLI client side

function daemon() {
  const rec = readJson(STATE_FILE);
  if (!rec || !rec.port || !pidAlive(rec.pid)) {
    console.error('[hvsc] daemon not running. Start it with:  powershell -File tools/hyper-vscode/serve.ps1');
    process.exit(1);
  }
  return rec;
}

async function daemonFetch(rec, path, { method = 'GET', body, timeoutMs = 180000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${rec.port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${rec.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').trim());
    return;
  }
  if (cmd === 'serve') {
    await serve(argv);
    return;
  }
  const rec = daemon();
  if (cmd === 'status' || cmd === 'instances') {
    const { json } = await daemonFetch(rec, '/instances');
    for (const i of json?.instances ?? []) {
      const stale = i.alive === false || i.harnessLive === false;
      console.log(
        `${i.id}  ${i.workspace}  ${i.isolated ? 'isolated' : 'passthrough'}  ` +
          `harness=${i.harness ? `:${i.harness.port}` : 'not-found'}  ${stale ? 'STALE' : 'alive'}`,
      );
    }
    if (!(json?.instances ?? []).length) console.log('(no instances)');
    return;
  }
  if (cmd === 'start') {
    const workspace = argv[0] && !argv[0].startsWith('--') ? argv[0] : process.cwd();
    const { status, json } = await daemonFetch(rec, '/instances', {
      method: 'POST',
      body: { workspace, args: collectArgs(argv, '--arg'), isolated: hasFlag(argv, '--isolated') },
    });
    console.log(status === 201 ? `${json.instance.id}  ${json.instance.workspace}  harness=${json.instance.harness ? `:${json.instance.harness.port}` : 'not-found'}` : JSON.stringify(json));
    process.exitCode = status === 201 ? 0 : 1;
    return;
  }
  if (cmd === 'reboot') {
    const reason = argValue(argv, '--reason', '');
    const continueMessage = argValue(argv, '--continue', '');
    if (!continueMessage) {
      console.error('[hvsc] --continue "<message>" is required (the caller supplies it).');
      process.exit(1);
    }
    const targets = hasFlag(argv, '--all')
      ? (await daemonFetch(rec, '/instances')).json.instances.map((i) => i.id)
      : [argv[0]].filter((a) => a && !a.startsWith('--'));
    if (!targets.length) {
      console.error('[hvsc] specify an instance id (see `hvsc status`) or --all');
      process.exit(1);
    }
    for (const id of targets) {
      const { status, json } = await daemonFetch(rec, `/instances/${id}/reboot`, {
        method: 'POST',
        body: {
          reason,
          continue: continueMessage,
          timeoutMs: Number(argValue(argv, '--timeout', '60000')),
          scope: argValue(argv, '--scope', 'all'),
          wait: hasFlag(argv, '--wait'),
        },
      });
      if (status === 202) {
        console.log(`${id}: job ${json.jobId} scheduled (poll: hvsc jobs ${json.jobId})`);
      } else {
        console.log(`${id}: ${JSON.stringify(json.job ?? json)}`);
      }
    }
    return;
  }
  if (cmd === 'rm' || cmd === 'forget') {
    if (hasFlag(argv, '--stale')) {
      const all = (await daemonFetch(rec, '/instances')).json?.instances ?? [];
      const stale = all.filter((i) => i.alive === false);
      for (const i of stale) {
        const r = await daemonFetch(rec, `/instances/${i.id}`, { method: 'DELETE' });
        console.log(`${i.id}: ${r.status === 200 ? 'removed' : JSON.stringify(r.json)}`);
      }
      if (!stale.length) console.log('(no stale instances)');
      return;
    }
    const id = argv[0];
    if (!id || id.startsWith('--')) {
      console.error('[hvsc] rm requires an instance id (see `hvsc status`) or --stale');
      process.exit(1);
    }
    const { status, json } = await daemonFetch(rec, `/instances/${id}`, {
      method: 'DELETE',
      body: { kill: hasFlag(argv, '--kill') },
    });
    console.log(status === 200 ? `removed ${id}${json.killed ? ' (killed)' : ''}` : JSON.stringify(json));
    process.exitCode = status === 200 ? 0 : 1;
    return;
  }
  if (cmd === 'jobs') {
    const id = argv[0];
    const { json } = await daemonFetch(rec, id ? `/jobs/${id}` : '/jobs');
    if (id) {
      const job = json?.job;
      if (!job) return console.error('no such job');
      console.log(`job ${job.id} [${job.status}] instance=${job.instanceId}${job.error ? ` error=${job.error}` : ''}`);
      for (const s of job.steps ?? []) console.log(`  +${s.at - job.startedAt}ms ${s.step}`);
      return;
    }
    for (const j of json?.jobs ?? []) console.log(`${j.id}  [${j.status}]  instance=${j.instanceId}${j.error ? `  error=${j.error}` : ''}`);
    return;
  }
  console.error(`[hvsc] unknown command: ${cmd}`);
  process.exit(1);
}

void main();
