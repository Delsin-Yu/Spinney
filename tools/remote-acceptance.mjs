/*
 * remote-acceptance — the **end-to-end** acceptance of remote control: a real VS Code
 * window, a real relay, and a second room member.
 *
 * WHY THIS FILE EXISTS. Every other remote-control test in this repo stops one step short of
 * the machine the feature is for. `tools/check-remote.js` pins the crypto and the two message
 * tables; `tools/relay-acceptance.js` drives the transport against a relay *stub*;
 * `tools/remote-surfaces-acceptance.js` runs the real `RemoteService` against a *recorded*
 * transport with `vscode` stubbed out. None of them ever had a real window in a room, so none
 * of them can see the three facts that matter most:
 *
 *   1. a window really publishes **itself** — its own `hello`, its own device name, its own
 *      real session list, its own session tree — into a room it was configured for;
 *   2. a second room member really drives it: an `input` really starts a turn **in that
 *      window**, a `cmd` really creates and stops a session there, and a replayed frame id
 *      really does not start a second one — each read back through the window's own control
 *      plane rather than trusted from a mirror frame this script also wrote;
 *   3. the diagnostics-stay-local rule (`remote/PROTOCOL.md` §6) really holds for every byte
 *      that crossed the mirror.
 *
 * HOW IT GETS A WINDOW WITHOUT TOUCHING THE DEVELOPER'S. Exactly the way `tools/sim/run.mjs`
 * does: the window is **launched here**, with its own `--user-data-dir` and its own
 * `--extensions-dir`, the `SPINNEY_HTTP*` bypasses for the control plane, and the
 * `SPINNEY_REMOTE*` bypasses for the room (whose token otherwise lives in SecretStorage and
 * cannot be written from outside a window — see `src/remote/roomsStore.ts`). A tiny
 * `onStartupFinished` companion in the private extensions dir focuses the Spinney container,
 * which is the only way this extension activates (`onWebviewPanel:*`), and the extension under
 * test is this **repo** under a junction named the way VS Code expects, so the window runs the
 * tree this run compiled rather than the last packaged `.vsix`.
 *
 * The other member is plain Node using the **real compiled product code**: `RelayTransport`
 * (`out/remote/relayClient.js`) seals and opens every frame, `deriveRoom`
 * (`out/remote/rooms.js`) derives the room from the token, and `out/remote/frames.js` supplies
 * the frame ids. It is the shape the Android app will be: a peer that speaks the protocol and
 * nothing else. It is not the only one either: the run keeps a **second** such member in the
 * window's own room, because a room of three is the real case — a window, a desktop peer and a
 * phone — and "a second sender's frames are deliverable, addressed exactly as the protocol says"
 * is only observable where a second sender exists.
 *
 * THE RELAY IS THE REAL ONE: `dotnet build -c Release` in `remote/server`, then the JIT dll
 * (`remote/server/bin/Release/net10.0/spinney-relay.dll`) on an ephemeral loopback port. The
 * Native AOT publish is a Linux artifact and is deliberately not involved.
 *
 * WHAT IT NEEDS: `npm run compile` (it loads `out/`), the .NET SDK, and a machine that can open
 * a window (`code` on PATH, or `HYPER_VSCODE_CODE`). Dev-only: `.vscodeignore` drops
 * `tools/**`, and it is deliberately **not** part of `vscode:prepublish` — the precedent is
 * `npm run sim`. On a machine with no display, run it under `xvfb-run` (Linux) or a desktop
 * session; the launch failure says so with the argv and the window's own log.
 *
 * Usage:
 *   node tools/remote-acceptance.mjs [--ready-timeout <s>] [--budget <s>] [--keep]
 *                                    [--profile <dir>] [--extension <path>] [-h|--help]
 *
 * Exit codes: 0 every check passed, 1 a check failed (or a case timed out), 2 usage error,
 * 3 a precondition was not satisfied (no `out/`, no `code`, no .NET SDK, no window).
 *
 * Every await is bounded: a step that never settles fails the run instead of hanging it, and
 * the `finally` tears the window and the relay down whichever way the run ended.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

// ---------------------------------------------------------------------------
// The report: the repo's `[ok  ]` / `FAIL` house style, and one PASS line at the end
// ---------------------------------------------------------------------------

const checks = [];

/** One assertion. Both lines are printed, so a PASS always means "every check ran". */
function check(label, ok, detail) {
  checks.push({ label, ok: Boolean(ok) });
  console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${label}${detail === undefined || detail === '' ? '' : `  (${detail})`}`);
  return Boolean(ok);
}

/** Something this run observed but does not judge — said out loud, never a silent pass. */
function note(text) {
  console.log(`  [note] ${text}`);
}

const failures = () => checks.filter((c) => !c.ok);

class Precondition extends Error {}
class Timeout extends Error {}

/**
 * A precondition that was not satisfied: say what to do and exit 3, never a silent PASS.
 * Everything launched so far is torn down by the caller's `finally`.
 */
function failPrecondition(message, hint) {
  console.error(`\nremote-acceptance: ${message}`);
  if (hint) {
    for (const line of String(hint).split('\n')) {
      console.error(`                  ${line}`);
    }
  }
  throw new Precondition(message);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `fn` until it answers something truthy — bounded, so a case that never settles fails
 * the run instead of hanging it. A timeout records a FAIL and throws (unless `record` is
 * false, for a probe whose caller then judges the outcome itself).
 */
async function waitFor(label, fn, timeoutMs, stepMs = 200, record = true) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try {
      value = await fn();
    } catch {
      value = undefined;
    }
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      if (record) {
        check(`${label} (within ${Math.round(timeoutMs / 1000)}s)`, false, 'timed out');
      }
      throw new Timeout(label);
    }
    await sleep(stepMs);
  }
}

// ---------------------------------------------------------------------------
// Launching a throwaway VS Code window (the mechanics of tools/sim/run.mjs)
// ---------------------------------------------------------------------------

/** `<install>[/<commit>]/resources/app/out/cli.js` — the CLI entry point. */
function findCli(install) {
  const direct = path.join(install, 'resources', 'app', 'out', 'cli.js');
  if (fs.existsSync(direct)) {
    return direct;
  }
  try {
    for (const entry of fs.readdirSync(install)) {
      const candidate = path.join(install, entry, 'resources', 'app', 'out', 'cli.js');
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    /* not an install root */
  }
  return null;
}

/**
 * How to launch a window. `Code.exe` is the Electron app and rejects the CLI's own flags, so
 * this reproduces what `bin\code.cmd` does: `ELECTRON_RUN_AS_NODE=1 Code.exe <cli.js> …`.
 */
function resolveCode() {
  const explicit = process.env.HYPER_VSCODE_CODE;
  if (explicit && fs.existsSync(explicit)) {
    const cli = findCli(path.dirname(explicit));
    if (cli) {
      return { exe: explicit, cli, how: 'HYPER_VSCODE_CODE' };
    }
  }
  const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['code'], { encoding: 'utf8' });
  for (const line of String(found.stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)) {
    if (/code\.cmd$/i.test(line)) {
      const install = path.dirname(path.dirname(line));
      const exe = path.join(install, 'Code.exe');
      const cli = findCli(install);
      if (fs.existsSync(exe) && cli) {
        return { exe, cli, how: 'bin\\code.cmd → Code.exe + out\\cli.js' };
      }
    }
    if (/code(\.exe)?$/i.test(line)) {
      const install = path.dirname(line);
      const cli = findCli(install);
      if (cli) {
        return { exe: line, cli, how: 'code on PATH + out/cli.js' };
      }
    }
  }
  return { exe: null, cli: null, how: 'not found' };
}

const ACTIVATOR_PACKAGE = {
  name: 'ra-activator',
  publisher: 'ra',
  version: '1.0.0',
  engines: { vscode: '^1.60.0' },
  main: './extension.js',
  activationEvents: ['onStartupFinished'],
};

/**
 * The companion the extension needs to activate at all: it declares only
 * `onWebviewPanel:*`, so a fresh window with no chat tab open never activates it and the
 * control plane never starts. Focusing the container makes the sessions view visible, which
 * is `onView:spinney.sessions` — an activation event of its own.
 */
const ACTIVATOR_JS = `const vscode = require('vscode');
exports.activate = () => { void vscode.commands.executeCommand('workbench.view.extension.spinney'); };
exports.deactivate = () => {};
`;

/**
 * Write the activator and link the extension under test into the private extensions dir,
 * under the `<publisher>.<name>-<version>` name VS Code scans for.
 *
 * The extension under test is the **repo**, not the installed `.vsix`: this run has to exercise
 * the tree it just compiled (and the `SPINNEY_REMOTE*` seam only exists there).
 */
function prepareExtensions(dir, extensionPath, publisher, name, version) {
  fs.mkdirSync(dir, { recursive: true });
  const activator = path.join(dir, 'ra-activator');
  fs.mkdirSync(activator, { recursive: true });
  fs.writeFileSync(path.join(activator, 'package.json'), `${JSON.stringify(ACTIVATOR_PACKAGE, null, 2)}\n`);
  fs.writeFileSync(path.join(activator, 'extension.js'), ACTIVATOR_JS);

  const target = path.join(dir, `${publisher}.${name}-${version}`);
  fs.rmSync(target, { recursive: true, force: true });
  try {
    fs.symlinkSync(extensionPath, target, process.platform === 'win32' ? 'junction' : 'dir');
    if (fs.existsSync(path.join(target, 'package.json'))) {
      return { target, how: 'junction' };
    }
  } catch {
    /* fall through to a copy */
  }
  fs.cpSync(extensionPath, target, { recursive: true });
  return { target, how: 'copy' };
}

/** A fresh profile every run: a leftover `state.vscdb` carries the *previous* run's state. */
function resetProfile(profile) {
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    /* nothing to remove */
  }
  fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
  fs.mkdirSync(path.join(profile, 'extensions'), { recursive: true });
}

/** A free loopback port, picked by the OS rather than hard-coded. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Kill every process of the throwaway profile — the CLI exits as soon as it has started the
 * app, so there is no pid worth holding on to. Only the *main* process (no `--type=`) is
 * killed, with `/T` so its renderers and the extension host go with it; the profile path is
 * this run's own, so nothing else on the machine can match.
 */
function killWindow(profile, cliPid) {
  const killed = [];
  if (process.platform !== 'win32') {
    if (cliPid) {
      try {
        process.kill(-cliPid, 'SIGTERM');
        killed.push(cliPid);
      } catch {
        /* already gone */
      }
    }
    return killed;
  }
  try {
    const query = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { $_.CommandLine -like '*${profile.replace(/'/g, "''")}*' -and $_.CommandLine -notlike '*--type=*' } | ForEach-Object { $_.ProcessId }`,
      ],
      { encoding: 'utf8' },
    );
    for (const pid of String(query.stdout || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^\d+$/.test(l))) {
      spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' });
      killed.push(Number(pid));
    }
  } catch {
    /* best effort */
  }
  if (cliPid) {
    spawnSync('taskkill', ['/PID', String(cliPid), '/T', '/F'], { stdio: 'ignore' });
  }
  return killed;
}

/** pids of the windows launched with that profile, still alive (the teardown's own evidence). */
function windowPids(profile) {
  if (process.platform !== 'win32') {
    return [];
  }
  try {
    const query = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { $_.CommandLine -like '*${profile.replace(/'/g, "''")}*' } | ForEach-Object { $_.ProcessId }`,
      ],
      { encoding: 'utf8' },
    );
    return String(query.stdout || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^\d+$/.test(l));
  } catch {
    return [];
  }
}

/** pids of `dotnet` processes running the relay dll, still alive. */
function relayPids() {
  if (process.platform !== 'win32') {
    return String(spawnSync('pgrep', ['-f', 'spinney-relay'], { encoding: 'utf8' }).stdout || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^\d+$/.test(l));
  }
  try {
    const query = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='dotnet.exe'" | Where-Object { $_.CommandLine -like '*spinney-relay*' } | ForEach-Object { $_.ProcessId }`,
      ],
      { encoding: 'utf8' },
    );
    return String(query.stdout || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^\d+$/.test(l));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The relay (the real C# one, JIT)
// ---------------------------------------------------------------------------

const RELAY_DIR = path.join(REPO, 'remote', 'server');
const RELAY_DLL = path.join(RELAY_DIR, 'bin', 'Release', 'net10.0', 'spinney-relay.dll');

/**
 * Build the relay and start it on an ephemeral loopback port.
 *
 * `dotnet build -c Release` is incremental (seconds) and runs every time on purpose: the relay
 * under test must be the source in this tree, not whatever dll was left behind.
 */
async function startRelay() {
  const build = spawnSync('dotnet', ['build', '-c', 'Release'], { cwd: RELAY_DIR, encoding: 'utf8', timeout: 300000 });
  if (build.error || build.status !== 0) {
    failPrecondition(
      `the relay did not build (\`dotnet build -c Release\` in ${RELAY_DIR})`,
      `${build.error && build.error.code === 'ENOENT' ? 'no `dotnet` on PATH: install the .NET SDK.' : ''}\n${String(build.stdout || '').split('\n').slice(-10).join('\n')}\n${String(build.stderr || '').split('\n').slice(-10).join('\n')}`,
    );
  }
  if (!fs.existsSync(RELAY_DLL)) {
    failPrecondition(`the relay build produced no ${RELAY_DLL}`, 'run `dotnet build -c Release` in remote/server by hand.');
  }
  check('the relay built (`dotnet build -c Release`, the JIT dll is there)', true, path.relative(REPO, RELAY_DLL));

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn('dotnet', [RELAY_DLL, '--urls', url], {
    cwd: RELAY_DIR,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk) => (output += String(chunk)));
  child.stderr?.on('data', (chunk) => (output += String(chunk)));
  child.unref?.();

  const stop = () => {
    try {
      if (process.platform !== 'win32') {
        process.kill(-child.pid, 'SIGTERM');
      } else {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      }
    } catch {
      /* already gone */
    }
  };

  try {
    await waitFor(
      `the relay answers GET /healthz on ${url}`,
      async () => {
        try {
          const res = await fetch(`${url}/healthz`);
          return res.status === 200 ? await res.json() : null;
        } catch {
          return null;
        }
      },
      30000,
      300,
    );
  } catch (err) {
    stop();
    failPrecondition(`the relay started but never answered /healthz on ${url}`, output.split('\n').slice(-10).join('\n'));
    void err;
  }
  check('the relay answers GET /healthz on an ephemeral port', true, url);
  return { url, stop, child };
}

// ---------------------------------------------------------------------------
// The provider the window talks to: one answer, then a turn that never ends
// ---------------------------------------------------------------------------

/**
 * A deliberately **hanging** OpenAI-compatible endpoint, after one completed answer.
 *
 * The run needs observable *state*, not a long conversation: `/state` must show a session
 * idle with one node (so `attach` has a real tree to mirror), then **running** with a node
 * count that grew (so "the input really started a turn" is a control-plane fact), then idle
 * again (so `cmd{stop}` is a control-plane fact). An instant provider makes a turn too short
 * to see; a refusing one makes it die before the first poll. So: the first `complete` chat
 * request is answered with a short, valid completion, and every later one sends the SSE
 * headers plus a comment line every 3 s and never a token — enough to hold the turn open
 * (`src/agent/apiClient.ts` resets its 20 s first-chunk / 60 s mid-answer watchdogs on any
 * byte) while producing nothing. `/user/balance` is answered because the window reads it.
 */
function startProvider({ complete = 1 } = {}) {
  const state = { chat: 0, completed: 0, hanging: 0, balance: 0, open: new Set() };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname.endsWith('/user/balance')) {
      state.balance += 1;
      const body = JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '100.00', granted_balance: '100.00', topped_up_balance: '0.00' }],
      });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      const parts = [];
      req.on('data', (chunk) => parts.push(chunk));
      req.on('end', () => {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(parts).toString('utf8'));
        } catch {
          /* an unparseable body is answered as a plain completion */
        }
        state.chat += 1;
        const model = typeof body.model === 'string' ? body.model : 'ra-model';
        if (state.chat <= complete) {
          state.completed += 1;
          const base = { id: `ra-${state.chat}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model };
          if (body.stream === true) {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
            const chunks = [
              { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
              { ...base, choices: [{ index: 0, delta: { content: 'remote-acceptance: answered locally, nothing to do.' }, finish_reason: null }] },
              { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
              { ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
            ];
            for (const chunk of chunks) {
              if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              }
            }
            if (!res.writableEnded) {
              res.write('data: [DONE]\n\n');
              res.end();
            }
            return;
          }
          const payload = JSON.stringify({
            id: base.id,
            object: 'chat.completion',
            created: base.created,
            model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'remote-acceptance: answered locally, nothing to do.' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          });
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
          res.end(payload);
          return;
        }
        // From here on: headers, a comment every 3 s, and no answer, forever.
        state.hanging += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.flushHeaders?.();
        const timer = setInterval(() => {
          if (res.writableEnded || res.destroyed) {
            clearInterval(timer);
            state.open.delete(timer);
            return;
          }
          res.write(': keepalive\n\n');
        }, 3000);
        timer.unref?.();
        state.open.add(timer);
        res.on('close', () => {
          clearInterval(timer);
          state.open.delete(timer);
        });
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        state,
        async close() {
          for (const timer of state.open) {
            clearInterval(timer);
          }
          state.open.clear();
          await new Promise((done) => server.close(done));
        },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// The control plane client (the window's own readout — what a mirror frame may not replace)
// ---------------------------------------------------------------------------

function makeClient(port, token) {
  const call = async (route, init = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      ...init,
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not json */
    }
    return { status: res.status, json, text };
  };
  return {
    call,
    health: () => call('/health'),
    state: () => call('/state'),
    startSession: (payload) => call('/session/start', { method: 'POST', body: JSON.stringify(payload) }),
  };
}

/** One session row of `/state`, by id. */
function sessionRow(state, sessionId) {
  return (state?.sessions || []).find((s) => s?.id === sessionId) ?? null;
}

/** The `/state` node count of one session, or null when the session is absent. */
function nodeCount(state, sessionId) {
  const row = sessionRow(state, sessionId);
  return row && Number.isFinite(row.nodes) ? row.nodes : null;
}

/** Is that session streaming (either field shape the plane uses)? */
function isRunning(state, sessionId) {
  const row = sessionRow(state, sessionId);
  return Boolean(row) && (row.running === true || (Array.isArray(row.runningNodes) && row.runningNodes.length > 0));
}

/** Every key of a JSON value, at any depth — the trace scan walks the whole payload. */
function allKeys(value, out = []) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      allKeys(entry, out);
    }
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      out.push(key);
      allKeys(entry, out);
    }
  }
  return out;
}

/** Windows paths differ in case between VS Code (`d:\…`) and Node (`D:\…`). */
function samePath(a, b) {
  return typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/**
 * What a failed launch has to say for itself: the extension host's own log and the Spinney
 * output channel of the newest window, which is where "the extension did not activate" is
 * actually explained.
 *
 * Deliberately *not* "the newest `.log` under the profile": that is just as likely to be
 * `editSessions.log` or a language server's log, and printing one of those beside a launch
 * failure reads like a diagnosis while saying nothing (measured the hard way — a window whose
 * `out/` was being rewritten by another process reported `Cannot find module …out/extension.js`
 * only in the extension host log).
 */
function launchDiagnostics(profile) {
  const lines = [];
  const logsDir = path.join(profile, 'logs');
  let runDir = null;
  try {
    const dirs = fs.readdirSync(logsDir).sort();
    runDir = dirs.length ? path.join(logsDir, dirs[dirs.length - 1]) : null;
  } catch {
    return '(the profile has no logs/ directory — no process started with --user-data-dir)';
  }
  const windows = (() => {
    try {
      return fs
        .readdirSync(runDir)
        .filter((name) => /^window\d+$/.test(name))
        .sort();
    } catch {
      return [];
    }
  })();
  for (const windowName of windows.length ? windows : ['window1']) {
    const exthost = path.join(runDir, windowName, 'exthost');
    const files = [];
    const add = (file) => {
      if (fs.existsSync(file)) {
        files.push(file);
      }
    };
    add(path.join(exthost, 'exthost.log'));
    try {
      for (const entry of fs.readdirSync(exthost)) {
        // The extension's own output channel, wherever VS Code numbered it.
        if (/^output_logging_/.test(entry)) {
          for (const inner of fs.readdirSync(path.join(exthost, entry))) {
            if (/Spinney.*\.log$/i.test(inner)) {
              add(path.join(exthost, entry, inner));
            }
          }
        }
      }
    } catch {
      /* no output logs in this window */
    }
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
      lines.push(`--- ${path.relative(profile, file)} (last ${Math.min(20, text.length)} lines) ---`);
      lines.push(...text.slice(-20));
    }
  }
  return lines.length ? lines.join('\n') : `(no exthost.log under ${runDir})`;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const USAGE = `remote-acceptance — end-to-end acceptance for remote control (dev-only; never shipped,
never in vscode:prepublish). Launches a throwaway VS Code window, the real relay, and a second
room member built from the compiled product code, then checks that the window really publishes
itself, that the member really drives it, and that diagnostics stay local.

  node tools/remote-acceptance.mjs [options]

Options:
  --ready-timeout <s>  how long to wait for the window's control plane (default 150)
  --budget <s>         the whole run's budget; it kills everything and fails when it expires
                       (default 270)
  --profile <dir>      where the throwaway profile lives (default <repo>/.spinney/remote-acceptance)
  --extension <path>   the extension under test (default: this repo, so the window really runs
                       the tree this run compiled)
  --keep               keep the throwaway profile for post-mortem (it is kept anyway; this
                       only silences the closing note)
  -h, --help

Exit codes: 0 pass, 1 a check failed, 2 usage, 3 a precondition was not satisfied.`;

const KNOWN_FLAGS = new Set(['--ready-timeout', '--budget', '--profile', '--extension', '--keep', '-h', '--help']);

function parseArgs(argv) {
  const out = { readySec: 150, budgetSec: 270, root: path.join(REPO, '.spinney', 'remote-acceptance'), extension: REPO, keep: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error(`missing value for ${arg}`);
      }
      i += 1;
      return next;
    };
    if (arg === '-h' || arg === '--help') {
      out.help = true;
    } else if (arg === '--keep') {
      out.keep = true;
    } else if (arg === '--ready-timeout') {
      out.readySec = Number(value());
    } else if (arg === '--budget') {
      out.budgetSec = Number(value());
    } else if (arg === '--profile') {
      out.root = path.resolve(value());
    } else if (arg === '--extension') {
      out.extension = path.resolve(value());
    } else if (!KNOWN_FLAGS.has(arg)) {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!Number.isFinite(out.readySec) || out.readySec <= 0) {
    throw new Error('--ready-timeout must be a positive number of seconds');
  }
  if (!Number.isFinite(out.budgetSec) || out.budgetSec <= 0) {
    throw new Error('--budget must be a positive number of seconds');
  }
  return out;
}

async function main(argv) {
  let flags;
  try {
    flags = parseArgs(argv);
  } catch (err) {
    console.error(`remote-acceptance: ${err instanceof Error ? err.message : String(err)}`);
    console.error(USAGE);
    return 2;
  }
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }

  const startedAt = Date.now();
  const runId = Math.random().toString(36).slice(2, 8);

  // ---- the compiled product code this run drives, and the window's own build
  const outRemote = path.join(REPO, 'out', 'remote');
  for (const name of ['relayClient.js', 'rooms.js', 'frames.js', 'allowlist.js']) {
    if (!fs.existsSync(path.join(outRemote, name))) {
      console.error(`\nremote-acceptance: out/remote/${name} is missing — run \`npm run compile\` first.`);
      return 3;
    }
  }
  const relayClient = require(path.join(outRemote, 'relayClient.js'));
  const rooms = require(path.join(outRemote, 'rooms.js'));
  const frames = require(path.join(outRemote, 'frames.js'));
  const allowlist = require(path.join(outRemote, 'allowlist.js'));

  const code = resolveCode();
  if (!code.exe || !code.cli) {
    console.error('\nremote-acceptance: no VS Code CLI found (`code` on PATH)');
    console.error('                  set HYPER_VSCODE_CODE to Code.exe, or put the VS Code `bin` on PATH.');
    console.error('                  a window needs a display: on a machine without one, run this under `xvfb-run`.');
    return 3;
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(flags.extension, 'package.json'), 'utf8'));
  if (pkg.name !== 'spinney') {
    console.error(`\nremote-acceptance: ${flags.extension} is not the Spinney extension`);
    return 3;
  }

  // ---- the room, the throwaway paths, and the one secret (never printed)
  const TOKEN = `remote-acceptance-${runId}-${'0123456789abcdef'.repeat(3)}`;
  const ROOM = `acceptance-${runId}`;
  const INSTANCE = 'remote-acceptance';
  const HTTP_TOKEN = `ra-http-${runId}`;
  const profile = flags.root;
  const extDir = path.join(profile, 'extensions');
  const workspace = path.join(flags.root, 'workspace');
  const perfLog = path.join(flags.root, 'perf.log');
  const roomKeys = rooms.deriveRoom(TOKEN);

  console.log('remote-acceptance — a real window in a room, driven by a second member (dev-only)');
  console.log(`  run        ${runId}`);
  console.log(`  repo       ${REPO}`);
  console.log(`  extension  ${flags.extension}  (${pkg.publisher}.${pkg.name}-${pkg.version})`);
  console.log(`  code       ${code.exe}  (${code.how})`);
  console.log(`  profile    ${profile}   (this run's own; the developer's profile is never touched)`);
  console.log(`  workspace  ${workspace}`);
  console.log(`  room       ${ROOM}  (room id ${roomKeys.roomId}, derived from the token)`);
  console.log(`  token      ${TOKEN.length} characters, not shown (a token in a log is a leaked token)`);

  let windowChild = null;
  let relay = null;
  let provider = null;
  const members = [];
  let teardownDone = false;

  const runTeardown = () => {
    if (teardownDone) {
      return;
    }
    teardownDone = true;
    for (const member of members) {
      try {
        member.transport.stop();
      } catch {
        /* already gone */
      }
    }
    if (provider) {
      void provider.close().catch(() => undefined);
    }
    if (relay) {
      relay.stop();
    }
    if (windowChild) {
      killWindow(profile, windowChild.pid);
    }
  };

  // A run that overruns its budget is torn down and failed rather than left hanging.
  const watchdog = setTimeout(() => {
    console.error(`\nFAIL remote-acceptance: the run exceeded its ${flags.budgetSec}s budget — tearing down`);
    runTeardown();
    process.exit(1);
  }, Math.max(30, flags.budgetSec) * 1000);
  watchdog.unref?.();

  try {
    // ---- 1. the relay, and the provider the window will talk to
    relay = await startRelay();
    provider = await startProvider({ complete: 1 });

    // ---- 2. the second room member: real compiled transport, real key schedule
    //
    // It joins **before** the window is launched, and that ordering is the whole point: the
    // relay only delivers a frame to the peers that are in the room when it is posted, so a
    // member that joined after the window would never see the `hello` the window sends when it
    // joins — the one announcement this run exists to observe.
    const makeMember = (deviceId, label) => {
      const framesSeen = [];
      const transport = new relayClient.RelayTransport({
        relayUrl: relay.url,
        roomId: roomKeys.roomId,
        encKey: roomKeys.encKey,
        deviceId,
        // A member is a replica: it joins the room the window created, and cannot bring one into
        // being (`PROTOCOL.md` §3, `/v2`'s `mode`). A member that could create rooms would hide
        // exactly the failure this run is here to see.
        joinMode: 'join',
        onFrame: (frame) => framesSeen.push({ at: Date.now(), frame }),
        onStatus: () => {},
      });
      return { label, transport, frames: framesSeen, send: (frame) => transport.send(frame) };
    };
    const me = makeMember('remote-acceptance-member', 'member');
    members.push(me);
    me.transport.start();
    await waitFor('the member joins the room', () => (me.transport.status.phase === 'online' ? me.transport.status : null), 20000, 100);
    check(
      'a second room member joined from Node (the compiled transport, the derived room id)',
      me.transport.status.phase === 'online',
      `peer ${me.transport.status.peerId}, room id ${roomKeys.roomId}`,
    );

    // ---- 3. the throwaway profile: virgin, private, and configured entirely from outside
    resetProfile(profile);
    fs.mkdirSync(workspace, { recursive: true });
    const linked = prepareExtensions(extDir, flags.extension, pkg.publisher.toLowerCase(), pkg.name, pkg.version);
    fs.writeFileSync(
      path.join(profile, 'User', 'settings.json'),
      `${JSON.stringify(
        {
          // A fresh profile opening a folder runs in Restricted Mode, and an extension
          // without `capabilities.untrustedWorkspaces` is not enabled there at all.
          'security.workspace.trust.enabled': false,
          'workbench.startupEditor': 'none',
          'window.restoreWindows': 'none',
          extensions: { ignoreRecommendations: true },
          'telemetry.telemetryLevel': 'off',
          'update.mode': 'none',
          // One model card at the hanging endpoint, on the built-in provider id — that is
          // the one whose key falls back to `DEEPSEEK_API_KEY`, which is what a fresh
          // profile has instead of a SecretStorage entry.
          'spinney.providers': { default: { name: 'Remote acceptance', baseUrl: provider.url, balance: 'deepseek', concurrency: 0 } },
          'spinney.modelCards': { 'ra-card': { name: 'Remote acceptance card', providerId: 'default', oaiModel: 'ra-model', contextWindow: 262144, concurrency: 0 } },
          'spinney.model': 'ra-card',
          'spinney.autoSessionTitles': false,
          // `spinney.remote.*` is deliberately **absent** here: the room comes from the
          // SPINNEY_REMOTE* variables alone, which is the seam this run exists to prove.
        },
        null,
        2,
      )}\n`,
    );
    const userDataDir = path.join(process.env.APPDATA || '', 'Code');
    check(
      'the private profile is this run\u2019s own, not the developer\u2019s',
      !path.resolve(profile).toLowerCase().startsWith(path.resolve(userDataDir).toLowerCase()),
      `${path.resolve(profile)} (extension under test linked as ${linked.how}: ${linked.target})`,
    );
    // The linked tree must be complete *now*: `spawn` happens milliseconds later, and a separate
    // process rewriting `out/` in between (another agent running `npm run compile`, a clean
    // checkout) makes the window fail to activate with a `Cannot find module …/out/extension.js`
    // that looks like a product bug. It is a precondition, so it is stated as one.
    const linkedEntry = path.join(linked.target, 'out', 'extension.js');
    check(
      'the linked extension resolves to a complete build (out/extension.js is there)',
      fs.existsSync(linkedEntry),
      path.relative(profile, linkedEntry),
    );
    if (!fs.existsSync(linkedEntry)) {
      failPrecondition(
        `${linkedEntry} does not resolve — the window could not activate the extension`,
        'run `npm run compile`, and make sure nothing else is rewriting out/ while this run starts.',
      );
    }

    // ---- 4. launch the window, with the control-plane and remote-control bypasses
    const httpPort = await freePort();
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      SPINNEY_HTTP: '1',
      SPINNEY_HTTP_PORT: String(httpPort),
      SPINNEY_HTTP_TOKEN: HTTP_TOKEN,
      SPINNEY_INSTANCE_ID: INSTANCE,
      SPINNEY_REMOTE: '1',
      SPINNEY_REMOTE_TOKEN: TOKEN,
      SPINNEY_REMOTE_ROOM: ROOM,
      SPINNEY_REMOTE_URL: relay.url,
      SPINNEY_PERF_LOG: perfLog,
      DEEPSEEK_API_KEY: 'remote-acceptance-key',
    };
    const launchArgv = [code.cli, workspace, `--user-data-dir=${profile}`, `--extensions-dir=${extDir}`];
    console.log(`\n  launch     ${code.exe} ${launchArgv.join(' ')}`);
    console.log(
      `  env        SPINNEY_HTTP=1 SPINNEY_HTTP_PORT=${httpPort} SPINNEY_INSTANCE_ID=${INSTANCE} SPINNEY_REMOTE=1 ` +
        `SPINNEY_REMOTE_ROOM=${ROOM} SPINNEY_REMOTE_URL=${relay.url} SPINNEY_REMOTE_TOKEN=<not shown> SPINNEY_PERF_LOG=<perf.log>`,
    );
    fs.writeFileSync(perfLog, '');
    windowChild = spawn(code.exe, launchArgv, { env, detached: true, stdio: 'ignore' });
    windowChild.unref();
    const cli = makeClient(httpPort, HTTP_TOKEN);

    let health = null;
    try {
      health = await waitFor(
        `the window's control plane answers GET /health on 127.0.0.1:${httpPort}`,
        async () => {
          const res = await cli.health().catch(() => null);
          return res && res.status === 200 ? res.json : null;
        },
        flags.readySec * 1000,
        1500,
      );
    } catch {
      // The profile tells the story: no `logs/` means no process ever started with this
      // `--user-data-dir` (a bad argv or no display), rather than a window that started and
      // never activated the extension.
      const initialized = fs.existsSync(path.join(profile, 'logs'));
      failPrecondition(
        `the throwaway window's control plane never answered on 127.0.0.1:${httpPort} within ${flags.readySec}s`,
        `launched: ${code.exe} ${launchArgv.join(' ')}\n` +
          (fs.existsSync(linkedEntry)
            ? 'the linked build is still complete, so the window started and the extension host refused it — its own log follows'
            : `the linked build vanished under this run: ${linkedEntry} is gone (something rewrote out/ after the launch)`) +
          `\n${initialized ? launchDiagnostics(profile) : ''}`,
      );
    }
    check('the throwaway window started and answers its control plane', health?.ok === true, `pid ${health?.pid}, instance ${health?.instanceId}`);

    /** The window's relay peer id, learned from its own `hello` (never assumed). */
    let windowPeer = null;
    const fromWindow = (frame) => windowPeer !== null && frame.from === windowPeer;

    // ---- 5. the window publishes itself: hello, then instances
    console.log('\n-- the window publishes itself into the room --');
    const hello = await waitFor(
      'the window sends its hello',
      () => me.frames.find((entry) => entry.frame.type === 'hello' && entry.frame.body?.instanceId === INSTANCE) ?? null,
      60000,
      200,
    );
    windowPeer = hello.frame.from;
    check('the window joined the room and sent `hello`', Boolean(hello.frame.from), `peer ${windowPeer}`);
    check(
      '`hello` names the device and the instance',
      hello.frame.body.deviceName === os.hostname() && hello.frame.body.instanceId === INSTANCE,
      `${hello.frame.body.deviceName} / ${hello.frame.body.instanceId}`,
    );
    check(
      '`hello` carries the protocol version and this window\u2019s workspace',
      hello.frame.body.proto === frames.FRAME_VERSION && samePath(hello.frame.body.workspace, workspace),
      `proto ${hello.frame.body.proto}, workspace ${hello.frame.body.workspace}`,
    );
    check(
      '`hello`\u2019s deviceId is sha256(machineId + roomId), not a raw machine id',
      /^[0-9a-f]{64}$/.test(String(hello.frame.body.deviceId)),
      `${String(hello.frame.body.deviceId).slice(0, 16)}…`,
    );

    // Answer it: a peer only learns about another peer from that peer's own `hello`, so a
    // member that joined *before* the window is invisible to it until it says so again.
    me.send({
      type: 'hello',
      to: windowPeer,
      body: { deviceId: 'remote-acceptance-member', deviceName: os.hostname(), instanceId: 'node-member', workspace: REPO, appVersion: pkg.version, proto: frames.FRAME_VERSION },
    });
    const announce = await waitFor(
      'the window announces its instances',
      () => me.frames.find((entry) => entry.frame.type === 'instances' && fromWindow(entry.frame)) ?? null,
      30000,
      200,
    );
    const ownRow = announce.frame.body.instances.find((row) => row?.instanceId === INSTANCE);
    check('the window announced `instances` for its own instance', Boolean(ownRow), `${announce.frame.body.instances?.length ?? 0} instance row(s)`);
    check('the announced row carries this window\u2019s workspace', ownRow && samePath(ownRow.workspace, workspace), ownRow?.workspace);

    // ---- 6. a real session, created through the control plane, seen in the room
    console.log('\n-- the room sees the window\u2019s real sessions --');
    const title = `remote-acceptance ${runId} primary`;
    const created = await cli.startSession({ title, prompt: `remote-acceptance ${runId}: the first turn of the published session` });
    if (created.status !== 200 || typeof created.json?.sessionId !== 'string') {
      failPrecondition(`POST /session/start answered ${created.status}: ${created.text.slice(0, 200)}`);
    }
    const sessionId = created.json.sessionId;
    check('the control plane created a real session (with one completed turn)', created.json.ok === true, `${sessionId} "${title}"`);
    await waitFor(
      'the window\u2019s first turn finishes',
      async () => (isRunning((await cli.state()).json, sessionId) ? null : true),
      30000,
      250,
    );
    const idleState = (await cli.state()).json;
    check('the published session is idle with one node after that turn', nodeCount(idleState, sessionId) === 1 && !isRunning(idleState, sessionId), `nodes ${nodeCount(idleState, sessionId)}`);

    // `resync` is the "I dropped frames, send fresh state" frame: the window answers it with
    // its instances, which is also how this run learns the session list *after* creating one.
    const resyncId = frames.newFrameId();
    const beforeResync = me.frames.length;
    me.send({ type: 'resync', id: resyncId, to: windowPeer, body: {} });
    const announced = await waitFor(
      'the window answers the resync with its instances',
      () =>
        me.frames
          .slice(beforeResync)
          .find((entry) => entry.frame.body?.instances?.some((i) => i?.sessions?.some((s) => s?.id === sessionId))) ?? null,
      30000,
      200,
    );
    check('a `resync` is answered (the window re-announced itself)', announced.frame.type === 'instances' && fromWindow(announced.frame), `frame from ${announced.frame.from}`);
    const rowInRoom = announced.frame.body.instances.find((i) => i.instanceId === INSTANCE).sessions.find((s) => s.id === sessionId);
    check('the announcement lists the session the control plane created', Boolean(rowInRoom), sessionId);
    check('the announced session carries its real title, not a placeholder', rowInRoom?.title === title, JSON.stringify(rowInRoom?.title));
    check('the announced session carries the node count the plane reports', rowInRoom?.nodes === nodeCount(idleState, sessionId), `room ${rowInRoom?.nodes} vs plane ${nodeCount(idleState, sessionId)}`);

    // ---- 7. attach: the mirror must carry the session's own tree
    console.log('\n-- attach, and the mirrored tree --');
    me.send({ type: 'attach', id: frames.newFrameId(), to: windowPeer, body: { sessionId } });
    const treeMirror = await waitFor(
      'the publisher answers attach with a mirror frame',
      () => me.frames.find((entry) => entry.frame.type === 'mirror' && entry.frame.body?.sessionId === sessionId && entry.frame.body?.message?.type === 'tree') ?? null,
      30000,
      200,
    );
    check('`attach` yields a `mirror` frame for that session', true, `message type ${treeMirror.frame.body.message.type}`);
    check(
      'the mirrored payload is the session\u2019s own `tree` (nodes, rootIds)',
      treeMirror.frame.body.message.type === 'tree' && Array.isArray(treeMirror.frame.body.message.nodes) && treeMirror.frame.body.message.nodes.length > 0 && Array.isArray(treeMirror.frame.body.message.rootIds),
      `${treeMirror.frame.body.message.nodes.length} node(s)`,
    );
    check(
      'the mirrored tree is the session the control plane reports',
      treeMirror.frame.body.message.nodes.length === nodeCount(idleState, sessionId),
      `mirror ${treeMirror.frame.body.message.nodes.length} vs /state ${nodeCount(idleState, sessionId)}`,
    );
    const firstNodeId = treeMirror.frame.body.message.rootIds[0] ?? treeMirror.frame.body.message.nodes[0]?.id;

    // ---- 8. an input really starts a turn in that window
    console.log('\n-- an input really starts a turn --');
    const nodesBefore = nodeCount(idleState, sessionId);
    const inputId = frames.newFrameId();
    const input = { sessionId, message: { type: 'userMessage', text: `remote-acceptance ${runId}: this turn must really start` } };
    me.send({ type: 'input', id: inputId, to: windowPeer, body: input });
    let sawRunning = false;
    const grew = await waitFor(
      'the turn starts (read back through the control plane)',
      async () => {
        const state = (await cli.state()).json;
        if (isRunning(state, sessionId)) {
          sawRunning = true;
        }
        const now = nodeCount(state, sessionId);
        return sawRunning && now !== null && now > nodesBefore ? { now, state } : null;
      },
      30000,
      250,
    );
    check('`GET /state` showed the session running after the input', sawRunning, 'observed live, not inferred from a mirror frame this run wrote');
    check('the session\u2019s node count grew (a turn really started)', grew.now > nodesBefore, `nodes ${nodesBefore} → ${grew.now}`);
    const nodesAfterInput = grew.now;
    const runningAfterInput = sessionRow(grew.state, sessionId)?.runningNodes ?? [];

    // ---- 9. the same frame id again must not start a second turn
    console.log('\n-- a replayed frame id does not start a second turn --');
    me.send({ type: 'input', id: inputId, to: windowPeer, body: input });
    const replayAnswer = await waitFor(
      'the publisher answers the repeated frame id',
      () => me.frames.find((entry) => entry.frame.type === 'result' && entry.frame.id === inputId) ?? null,
      20000,
      100,
    );
    check('the repeated `input` frame id is answered with a `result` frame', true, `body ${JSON.stringify(replayAnswer.frame.body)}`);
    check('the answer says duplicated, so nothing was dispatched twice', replayAnswer.frame.body?.duplicated === true, JSON.stringify(replayAnswer.frame.body));
    await sleep(3000);
    const afterReplay = (await cli.state()).json;
    check('no second turn started (the plane\u2019s node count is unchanged)', nodeCount(afterReplay, sessionId) === nodesAfterInput, `nodes ${nodesAfterInput} → ${nodeCount(afterReplay, sessionId)}`);
    check(
      'still exactly the one node the first input started',
      JSON.stringify(sessionRow(afterReplay, sessionId)?.runningNodes ?? []) === JSON.stringify(runningAfterInput),
      `runningNodes ${JSON.stringify(sessionRow(afterReplay, sessionId)?.runningNodes)}`,
    );

    // ---- 10. cmd{session/start} and cmd{stop}
    console.log('\n-- a command from the room creates and stops a session --');
    const secondTitle = `remote-acceptance ${runId} second`;
    const startId = frames.newFrameId();
    me.send({
      type: 'cmd',
      id: startId,
      to: windowPeer,
      body: { command: 'session/start', args: { title: secondTitle, prompt: `remote-acceptance ${runId}: the second session's turn` } },
    });
    const startAnswer = await waitFor(
      'cmd{session/start} is answered',
      () => me.frames.find((entry) => entry.frame.type === 'result' && entry.frame.id === startId) ?? null,
      30000,
      100,
    );
    const secondSessionId = String(startAnswer.frame.body?.sessionId ?? '');
    check('cmd{session/start} answered ok with a session id', startAnswer.frame.body?.ok === true && secondSessionId.length > 0, JSON.stringify(startAnswer.frame.body));
    const withSecond = await waitFor(
      'the control plane lists the session the room created',
      async () => {
        const state = (await cli.state()).json;
        return sessionRow(state, secondSessionId) ? state : null;
      },
      20000,
      250,
    );
    check('`GET /state` lists that session (it really exists in the window)', true, `${secondSessionId} "${sessionRow(withSecond, secondSessionId).title}"`);
    await waitFor('the second session\u2019s turn is running', async () => (isRunning((await cli.state()).json, secondSessionId) ? true : null), 20000, 250);
    check('a turn really started in the session the room created', true, 'observed live through /state');

    const stopId = frames.newFrameId();
    me.send({ type: 'cmd', id: stopId, to: windowPeer, body: { command: 'stop', args: { sessionId: secondSessionId } } });
    const stopAnswer = await waitFor(
      'cmd{stop} is answered',
      () => me.frames.find((entry) => entry.frame.type === 'result' && entry.frame.id === stopId) ?? null,
      30000,
      100,
    );
    check('cmd{stop} answered ok and reported what it stopped', stopAnswer.frame.body?.ok === true && Number(stopAnswer.frame.body?.stopped ?? 0) >= 1, JSON.stringify(stopAnswer.frame.body));
    const afterStop = await waitFor(
      'the stopped session goes idle',
      async () => {
        const state = (await cli.state()).json;
        return isRunning(state, secondSessionId) ? null : state;
      },
      30000,
      250,
    );
    check('the stopped session reports no live run', !isRunning(afterStop, secondSessionId), `runningNodes ${JSON.stringify(sessionRow(afterStop, secondSessionId)?.runningNodes)}`);

    const stopFirstId = frames.newFrameId();
    me.send({ type: 'cmd', id: stopFirstId, to: windowPeer, body: { command: 'stop', args: { sessionId } } });
    const stopFirst = await waitFor(
      'cmd{stop} on the first session is answered',
      () => me.frames.find((entry) => entry.frame.type === 'result' && entry.frame.id === stopFirstId) ?? null,
      30000,
      100,
    );
    check('cmd{stop} stopped the turn the room had started', stopFirst.frame.body?.ok === true && Number(stopFirst.frame.body?.stopped ?? 0) >= 1, JSON.stringify(stopFirst.frame.body));
    await waitFor('the first session goes idle', async () => (isRunning((await cli.state()).json, sessionId) ? null : true), 30000, 250);
    check('the first session is idle again after the stop', !isRunning((await cli.state()).json, sessionId), 'verified through /state');

    // ---- 11. diagnostics stay local (remote/PROTOCOL.md §6)
    console.log('\n-- diagnostics stay local --');
    // A checkout is a *traced* repaint (`startRepaintOp('checkout-node')`), so the `path`
    // message the local tab receives carries a `traceId` — and the copy that crosses the
    // mirror must not. Waiting for that one message is what makes the scan below bite:
    // without it the run could only assert a negative nobody exercised.
    const beforeCheckout = me.frames.length;
    me.send({ type: 'input', id: frames.newFrameId(), to: windowPeer, body: { sessionId, message: { type: 'checkout', id: firstNodeId } } });
    const tracedMirror = await waitFor(
      'the traced checkout repaint reaches the mirror',
      () => me.frames.slice(beforeCheckout).find((entry) => entry.frame.type === 'mirror' && entry.frame.body?.message?.type === 'path') ?? null,
      20000,
      100,
    ).catch(() => null);
    check('a traced repaint (the checkout of a node) really was mirrored', Boolean(tracedMirror), tracedMirror ? `a \`path\` message, ${JSON.stringify(tracedMirror.frame.body.message).length} chars` : 'no `path` mirror arrived');

    const mirrored = me.frames.filter((entry) => entry.frame.type === 'mirror');
    const offenders = mirrored.filter((entry) => allKeys(entry.frame.body?.message).some((key) => key === 'traceId' || key.toLowerCase().startsWith('perf')));
    check(
      'no mirrored payload carries a perf trace (no `traceId`, no `perf*` key, at any depth)',
      offenders.length === 0,
      `${mirrored.length} mirrored message(s) scanned${offenders.length ? `, first offender: ${JSON.stringify(offenders[0].frame.body.message).slice(0, 120)}` : ''}`,
    );
    const forbidden = mirrored.filter((entry) => !allowlist.mayMirrorToPeer(String(entry.frame.body?.message?.type)));
    check(
      'every mirrored message type is on the deny-by-default mirror list',
      forbidden.length === 0,
      forbidden.length ? `off the list: ${[...new Set(forbidden.map((f) => f.frame.body?.message?.type))].join(', ')}` : `${new Set(mirrored.map((f) => f.frame.body?.message?.type)).size} distinct type(s), all allow-listed`,
    );

    // The positive control for the two checks above: the perf tee records the byte length of
    // the message the *local* tab received, so if the trace id was dropped on the way into the
    // room that length is the mirrored one plus `,"traceId":<n>`. If the strip were removed the
    // two would be equal, and a check that only asserted "nobody saw a traceId" would pass
    // vacuously because nothing traced was ever mirrored at all.
    const perfText = fs.existsSync(perfLog) ? fs.readFileSync(perfLog, 'utf8') : '';
    const localPosts = [...perfText.matchAll(/\[perf\] op#\d+ \+\d+ms post-(tree|path) bytes=(\d+)/g)].map((m) => ({ type: m[1], bytes: Number(m[2]) }));
    const mirroredLengths = mirrored
      .map((entry) => entry.frame.body?.message)
      .filter((message) => message?.type === 'tree' || message?.type === 'path')
      .map((message) => JSON.stringify(message).length);
    const stripProof = localPosts.find((post) => mirroredLengths.some((len) => post.bytes - len >= 12 && post.bytes - len - 11 <= 4));
    check(
      'the trace id was really stripped on the way into the room (the local post is longer by `,"traceId":N`)',
      Boolean(stripProof),
      stripProof
        ? `local post-${stripProof.type} bytes=${stripProof.bytes}, mirrored ${mirroredLengths.find((len) => stripProof.bytes - len >= 12)} — the difference is the trace id`
        : `${localPosts.length} traced local repaint(s) logged, ${mirroredLengths.length} mirrored tree/path message(s) — no pair differs by a trace id`,
    );

    // ---- 12. three members in one room: a third sender's frames arrive, and a frame for
    //           somebody else is still not delivered to the member it does not name
    console.log('\n-- three members in one room, and addressing --');

    // 12a. The case that was impossible to mirror until the replay window became one window
    // **per sender salt** (`relayClient.ts`, `REPLAY_SALTS_MAX`): every sender's `seq` starts at
    // 1 on its own connection, so a single window per receiving connection refused a second
    // sender's frames as replays — and a room of three rendered exactly one member. It is an
    // assertion now, and it is deliberately strict: the frame must arrive, must carry the third
    // member's own peer id as `from` (a member cannot pass by receiving its own frame back), and
    // must arrive with the receiver's refusal counters untouched (a delivered frame is not a
    // refused one, and a *refused* frame would not be a delivery either).
    const thirdFrames = [];
    const third = new relayClient.RelayTransport({
      relayUrl: relay.url,
      roomId: roomKeys.roomId,
      encKey: roomKeys.encKey,
      deviceId: 'remote-acceptance-third',
      joinMode: 'join', // a member joins the window's room; it does not create one
      onFrame: (frame) => thirdFrames.push(frame),
      onStatus: () => {},
    });
    members.push({ label: 'third member', transport: third });
    third.start();
    await waitFor('the third member joins the window\u2019s room', () => (third.status.phase === 'online' ? third.status : null), 20000, 100);
    check(
      'a third member joined the window\u2019s own room (three members, one room)',
      third.status.phase === 'online' && third.status.peerId !== me.transport.status.peerId && third.status.peerId !== windowPeer,
      `third peer ${third.status.peerId}, this member ${me.transport.status.peerId}, window ${windowPeer}`,
    );

    const refusedBeforeThird = { ...me.transport.status.inboundRefused };
    const thirdFrameId = frames.newFrameId();
    third.send({ type: 'ping', id: thirdFrameId, to: '*', body: {} });
    const thirdFrame = await waitFor(
      'the third member\u2019s broadcast frame arrives at this member',
      () => me.frames.find((entry) => entry.frame.id === thirdFrameId) ?? null,
      15000,
      100,
      false,
    ).catch(() => null);
    const refusedByThird = Object.fromEntries(
      Object.entries(me.transport.status.inboundRefused)
        .map(([kind, count]) => [kind, count - refusedBeforeThird[kind]])
        .filter(([, delta]) => delta !== 0),
    );
    check(
      'a broadcast frame from a third member in a three-member room is delivered',
      Boolean(thirdFrame),
      thirdFrame ? `frame ${thirdFrameId}, type ${thirdFrame.frame.type}` : `frame ${thirdFrameId} never arrived (refusals: ${JSON.stringify(refusedByThird)})`,
    );
    check(
      '  … and it is the third member\u2019s own frame, not this member\u2019s echoed back',
      Boolean(thirdFrame) && thirdFrame.frame.from === third.status.peerId && thirdFrame.frame.from !== me.transport.status.peerId && thirdFrame.frame.from !== windowPeer,
      `from ${thirdFrame?.frame.from} (third ${third.status.peerId}, this member ${me.transport.status.peerId}, window ${windowPeer})`,
    );
    check(
      '  … delivered, not refused: the receiver\u2019s refusal counters did not move',
      Object.keys(refusedByThird).length === 0,
      Object.keys(refusedByThird).length ? `refusals: ${JSON.stringify(refusedByThird)}` : `all six counters still at ${JSON.stringify(me.transport.status.inboundRefused)}`,
    );

    // 12b. The delivery half of the addressing rule, now measured **in that same room**: the
    // third member fans a frame addressed to "deadbeef" out to every other peer, and this member
    // must not deliver it. The room needs no substitute any more — 12a is the positive control
    // that a frame from this very sender does arrive, and the counters are the discriminator: a
    // frame dropped by the `to` filter is not counted, while one refused by the transport would
    // be. (That distinction is what a single-sender room used to be needed for.)
    const refusedBeforeStray = { ...me.transport.status.inboundRefused };
    const strayId = frames.newFrameId();
    third.send({ type: 'ping', id: strayId, to: 'deadbeef', body: {} });
    await sleep(2500);
    const refusedByStray = Object.fromEntries(
      Object.entries(me.transport.status.inboundRefused)
        .map(([kind, count]) => [kind, count - refusedBeforeStray[kind]])
        .filter(([, delta]) => delta !== 0),
    );
    check(
      'a frame addressed to a peer that is not this member is not delivered to it',
      !me.frames.some((entry) => entry.frame.id === strayId) && Object.keys(refusedByStray).length === 0,
      `frame ${strayId} was addressed to "deadbeef" and dropped by the \`to\` filter, without being counted as a refusal (${JSON.stringify(refusedByStray) || 'no refusal at all'})`,
    );

    // 12c. The window as receiver: an `attach` addressed to a peer that is not it must be
    // dropped by its own transport's `to` filter — no `mirror`, no `error`… and the same frame,
    // addressed to the window, **is** acted on, or this check would also pass for a window that
    // ignored every `attach` the run sent.
    const beforeMisaddressed = me.frames.length;
    const misaddressedId = frames.newFrameId();
    me.send({ type: 'attach', id: misaddressedId, to: 'deadbeef', body: { sessionId } });
    await sleep(2500);
    const answeredMisaddressed = me.frames.slice(beforeMisaddressed).some((entry) => entry.frame.type === 'error' && entry.frame.body?.ref === misaddressedId);
    const mirroredMisaddressed = me.frames.slice(beforeMisaddressed).some((entry) => entry.frame.type === 'mirror' && entry.frame.body?.sessionId === sessionId);
    check(
      'a frame addressed to another peer is not acted on by the window either',
      !answeredMisaddressed && !mirroredMisaddressed,
      `frame ${misaddressedId} was addressed to "deadbeef" — the relay fanned it out, the window's transport dropped it`,
    );
    const beforeAddressed = me.frames.length;
    me.send({ type: 'attach', id: frames.newFrameId(), to: windowPeer, body: { sessionId } });
    const controlMirror = await waitFor(
      'the same frame, addressed to the window, is answered',
      () => me.frames.slice(beforeAddressed).find((entry) => entry.frame.type === 'mirror' && entry.frame.body?.message?.type === 'tree') ?? null,
      20000,
      100,
      false,
    ).catch(() => null);
    check(
      'the same frame addressed to the window IS acted on (so the check above is not vacuous)',
      Boolean(controlMirror),
      controlMirror ? 'a `mirror` carrying the tree answered the addressed `attach`' : 'no mirror for the addressed attach',
    );
    note(
      'three members share one room in this run (the window, this member and a third): the per-salt replay window ' +
        '(`relayClient.ts`, `REPLAY_SALTS_MAX`) is what makes a second sender\u2019s frames deliverable, and the checks above pin it.',
    );

    // ---- 13. teardown, and the proof that nothing survived it
    console.log('\n-- teardown --');
    runTeardown();
    await sleep(2500);
    const strayWindows = windowPids(profile);
    check(
      'no window process of this run survived it',
      strayWindows.length === 0,
      strayWindows.length ? `pids ${strayWindows.join(', ')}` : 'checked: Get-CimInstance Win32_Process (Code.exe) filtered by this run\u2019s --user-data-dir',
    );
    const strayRelays = relayPids();
    check(
      'no relay process survived it',
      strayRelays.length === 0,
      strayRelays.length ? `pids ${strayRelays.join(', ')}` : 'checked: Get-CimInstance Win32_Process (dotnet.exe) filtered by spinney-relay',
    );
    check(
      'every Node room member stopped its transport',
      members.every((member) => member.transport.status.phase === 'idle'),
      members.map((member) => `${member.label}=${member.transport.status.phase}`).join(' '),
    );
  } catch (err) {
    if (!(err instanceof Precondition) && !(err instanceof Timeout)) {
      check(`the run threw: ${err instanceof Error ? err.message : String(err)}`, false, err instanceof Error && err.stack ? err.stack.split('\n')[1]?.trim() : '');
    }
  } finally {
    runTeardown();
    clearTimeout(watchdog);
  }

  const failed = failures();
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log('');
  if (failed.length) {
    console.log(`FAIL remote-acceptance: ${failed.length} of ${checks.length} check(s) failed (${elapsed}s):`);
    for (const item of failed) {
      console.log(`  - ${item.label}`);
    }
    return 1;
  }
  console.log(
    `PASS remote-acceptance: ${checks.length}/${checks.length} checks — a throwaway window published itself into a room over the real relay, ` +
      'a second member read its real sessions, attached to one, started and stopped turns through it, and no diagnostics crossed the mirror ' +
      `(${elapsed}s)`,
  );
  if (!flags.keep) {
    note(`the throwaway profile is kept for post-mortem at ${profile}`);
  }
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
