#!/usr/bin/env node
/**
 * harness-test.mjs — control-plane acceptance harness for the multi-session /
 * multi-branch work (docs/agents/multi-session.md, phases P1–P4).
 *
 * It drives the **live extension** over its local HTTP control plane
 * (`src/http/controlServer.ts`) and asserts host behaviour end to end:
 * concurrent sessions, navigation without disturbing a running turn, and
 * node-local background ownership. Message ownership is checked against the
 * on-disk transcript dumps the host writes per turn
 * (`<transcriptRoot>/<sessionId>/<nodeId>.jsonl`).
 *
 * Deliberately NOT used: `POST /wait-for-finish`. The caller is *by definition*
 * an agent turn, which makes the window busy for as long as the caller runs —
 * blocking on "idle" would deadlock. Every suite polls `GET /state` instead.
 *
 * Discovery mirrors `tools/hyper-vscode/hvsc.mjs`: read
 * `<globalStorage>/http/<instanceId>.json` (port + bearer token + pid +
 * workspace) from the usual VS Code global-storage folders, keep the newest
 * record whose pid answers `process.kill(pid, 0)`.
 *
 * Phasing: the spec is implemented P1→P4, so suites are **phased tolerant**.
 * A suite that needs a `/state` field the host does not expose yet prints
 * `SKIP <suite>: missing <field> (expected in phase Pn)` and exits 0. A suite
 * exits 1 only when the host *contradicts* an asserted fact (duplicate session
 * ids, a session that should be running reports idle, a turn's message landing
 * in another session's transcript, …).
 *
 * Dev tooling, never shipped: `.vscodeignore` already excludes `tools/**`.
 *
 * Usage:
 *   node tools/harness-test.mjs <suite...|all> [options]
 *
 *   Suites: health sessions concurrency navigation background signals branch selftest
 *
 *   --instance <pid-NNNN>    target that discovery instance (by id or file stem)
 *   --discovery <file>       target the control plane recorded in that JSON file
 *   --port <n> --token <t>   skip discovery entirely
 *   --global-storage <dir>   look for <dir>/http/<instanceId>.json (else the
 *                            usual Code/Cursor/VSCodium folders; also honours
 *                            $HARNESS_GLOBAL_STORAGE / $HYPER_VSCODE_GLOBAL_STORAGE)
 *   --transcript-root <dir>  override the transcript root
 *   --timeout <seconds>      per-suite budget (default 180)
 *   --interval <ms>          /state poll interval (default 250)
 *   --json                   machine-readable output (stdout is JSON only)
 *   --keep                    leave created sessions in place (silences the note)
 *   --keep-focus              do not restore the session that was active at start
 *   -h, --help
 *
 * Exit codes: 0 = every suite PASS/SKIP, 1 = a suite FAILED, 2 = usage error,
 * 3 = no reachable window. `selftest` needs no window at all.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXT_ID = 'deyu.spinney';
const SUITES = ['health', 'sessions', 'concurrency', 'navigation', 'background', 'signals', 'branch', 'selftest'];
const DEFAULT_TIMEOUT_SEC = 180;
const DEFAULT_INTERVAL_MS = 250;
/** How long a suite waits for a turn's transcript dump to appear. */
const TRANSCRIPT_WAIT_MS = 60_000;
/** Per-HTTP-request budget. */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * The `/state` fields the suites assert on, and the phase that introduces them.
 * Used verbatim in the `SKIP … missing <field> (expected in phase …)` note.
 */
const FIELD_PHASE = {
  'sessions[].running': 'P1 (per-session runtimes)',
  'sessions[].runningNodes': 'P1 (runs keyed by node)',
  'sessions[].nodes': 'P1 (per-session runtimes)',
  'sessions[].runningBackgrounds': 'P2 (node-local background ownership)',
  'sessions[].backgroundNodes': 'P2 (node-local background ownership)',
  'backgrounds[].nodeId': 'P2 (node-local background ownership)',
  // The `signals` suite would like the id-level view of the tree. `/state` exposes a
  // node *count*, never per-node records, so these two stay `skip`s — the facts they
  // would prove are asserted indirectly (owner id + unchanged count + the dump only a
  // main turn node writes).
  'sessions[].bgNodes': "P2 (a job card is a `kind:'bg'` node — /state reports counts, not ids)",
  'sessions[].cardDelivered': 'P2 (D1: `Delivered` is a tree/webview flag, not a control-plane field)',
};

const USAGE = `harness-test — drives the live Spinney window over its local control plane
(docs/agents/multi-session.md). Dev tooling; never shipped.

Usage:
  node tools/harness-test.mjs <suite...|all> [options]

Suites:
  health        GET /health + GET /state shape (discovery target, session list)
  sessions      two POST /session/start sessions: distinct, listed, message ownership
  concurrency   both sessions report a live run at the same time
  navigation    POST /navigate + POST /continue on one session, another keeps running
  background    a start_in_background job's ownership as reported by /state
  signals       a finished job's notice lands INSIDE the owning node: no new node,
                unchanged node count, backgroundNodes still the turn node
  branch        two nodes of ONE session stream at once; node-scoped POST /stop
  selftest      pure-logic checks of this script's own helpers (needs no window)

Options:
  --instance <pid-NNNN>    target that discovery instance (id or file stem)
  --discovery <file>       target the control plane in that discovery JSON
  --port <n> --token <t>   skip discovery entirely
  --global-storage <dir>   where to look for <dir>/http/<instanceId>.json
  --transcript-root <dir>  override the transcript root
  --timeout <seconds>      per-suite budget (default ${DEFAULT_TIMEOUT_SEC})
  --interval <ms>          /state poll interval (default ${DEFAULT_INTERVAL_MS})
  --json                   machine-readable output
  --keep                   leave created sessions in place (silences the note)
  --keep-focus             do not restore the session that was active at start
  -h, --help

Exit codes: 0 pass/skip, 1 failure, 2 usage error, 3 no reachable window.`;

// ---------------------------------------------------------------------------
// Small generic helpers (pure; covered by the selftest suite)
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Collector for one suite's checks. `ok`/`fail` decide PASS vs FAIL. */
function makeChecks() {
  const items = [];
  return {
    items,
    check(label, ok, detail = '') {
      items.push({ status: ok ? 'ok' : 'fail', label, detail: String(detail ?? '') });
      return Boolean(ok);
    },
    note(label) {
      items.push({ status: 'note', label, detail: '' });
    },
    /** A check the host cannot answer yet — never turns the suite into a FAIL. */
    subskip(label, reason) {
      items.push({ status: 'skip', label, detail: String(reason ?? '') });
    },
    failures() {
      return items.filter((i) => i.status === 'fail');
    },
  };
}

function suiteResult(name, status, message, checks) {
  return { name, status, message, checks: checks ? checks.items : [] };
}

/**
 * Poll `fn` until it returns a defined value or the budget runs out. `fn`
 * receives the 1-based poll index. Returns `{ok, value, polls}`.
 */
async function pollUntil(fn, { timeoutMs, intervalMs = DEFAULT_INTERVAL_MS, sleepFn = sleep, now = Date.now } = {}) {
  // A non-finite budget must fail fast, never spin: an undefined timeout used
  // to make `deadline` NaN, and `now() >= NaN` is always false.
  const budget = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0;
  const deadline = now() + budget;
  let polls = 0;
  for (;;) {
    polls += 1;
    const value = await fn(polls);
    if (value !== undefined && value !== null && value !== false) {
      return { ok: true, value, polls };
    }
    if (now() >= deadline) {
      return { ok: false, value, polls };
    }
    await sleepFn(intervalMs);
  }
}

/** `sessions[].running` / `a.b` / `items[].id` → {found, values}. */
function resolveField(root, expr) {
  const text = String(expr ?? '').trim();
  if (!text) {
    throw new Error('empty field expression');
  }
  const steps = [];
  for (const seg of text.split('.')) {
    const m = /^([A-Za-z0-9_$]+)(\[\])?$/.exec(seg);
    if (!m) {
      throw new Error(`bad field expression: ${expr}`);
    }
    steps.push({ key: m[1], each: Boolean(m[2]) });
  }
  let current = [root];
  for (const step of steps) {
    const next = [];
    for (const node of current) {
      if (node === null || typeof node !== 'object') {
        continue;
      }
      const value = node[step.key];
      if (value === undefined) {
        continue;
      }
      if (step.each) {
        if (Array.isArray(value)) {
          next.push(...value);
        }
      } else {
        next.push(value);
      }
    }
    current = next;
  }
  return { found: current.length > 0, values: current };
}

/** Every expression in `exprs` the state does not expose. */
function missingFields(state, exprs) {
  return exprs.filter((expr) => !resolveField(state, expr).found);
}

/** The first expression in `exprs` the state exposes, or null. */
function pickField(state, exprs) {
  for (const expr of exprs) {
    if (resolveField(state, expr).found) {
      return expr;
    }
  }
  return null;
}

/** Human phase label for a `/state` field. */
function phaseFor(expr) {
  return FIELD_PHASE[expr] ?? 'a later phase';
}

/** Stable, unique-ish marker used to trace a message through the host. */
function makeRunId(now = Date.now(), rand = Math.random) {
  return `harness-${now.toString(36)}-${rand().toString(36).slice(2, 6)}`;
}

/**
 * What to do with the window's focus (the active session) once the run is over.
 *
 * The whole point of a self-driving loop: every suite that drives the control
 * plane activates a *test* session, and the supervisor's next reboot re-reads
 * the active session into its own `/continue`. Restoring the session that was
 * active when the run started keeps the orchestrator's conversation alive.
 */
function focusRestorePlan(focus, { keepFocus = false } = {}) {
  if (!focus || !focus.sessionId) {
    return { action: 'none', reason: 'no active session was recorded at the start' };
  }
  if (keepFocus) {
    return { action: 'skip', reason: `--keep-focus (active session was ${focus.sessionId})` };
  }
  return { action: 'restore', reason: `active session at start: ${focus.sessionId}` };
}

/** `--a=b` → `--a b`, so both spellings parse. */
function normalizeArgv(argv) {
  const out = [];
  for (const arg of argv) {
    const m = /^(--[A-Za-z-]+)=(.*)$/.exec(arg);
    if (m) {
      out.push(m[1], m[2]);
    } else {
      out.push(arg);
    }
  }
  return out;
}

function toNumber(value, flag) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`${flag} expects a number, got "${value}"`);
  }
  return n;
}

function parseArgs(argv) {
  const args = normalizeArgv(argv);
  const out = {
    suites: [],
    json: false,
    keep: false,
    keepFocus: false,
    help: false,
    timeoutSec: DEFAULT_TIMEOUT_SEC,
    intervalMs: DEFAULT_INTERVAL_MS,
    instance: null,
    discovery: null,
    port: null,
    token: null,
    globalStorage: null,
    transcriptRoot: null,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = () => {
      const v = args[i + 1];
      if (v === undefined) {
        throw new Error(`missing value for ${arg}`);
      }
      i += 1;
      return v;
    };
    if (arg === '-h' || arg === '--help') {
      out.help = true;
    } else if (arg === '--json') {
      out.json = true;
    } else if (arg === '--keep') {
      out.keep = true;
    } else if (arg === '--keep-focus') {
      out.keepFocus = true;
    } else if (arg === '--timeout') {
      out.timeoutSec = toNumber(value(), arg);
      if (!(out.timeoutSec > 0)) {
        throw new Error('--timeout must be > 0 seconds');
      }
      out.timeoutMs = out.timeoutSec * 1000;
    } else if (arg === '--interval') {
      out.intervalMs = Math.max(50, toNumber(value(), arg));
    } else if (arg === '--instance') {
      out.instance = value();
    } else if (arg === '--discovery') {
      out.discovery = path.resolve(value());
    } else if (arg === '--port') {
      out.port = toNumber(value(), arg);
    } else if (arg === '--token') {
      out.token = value();
    } else if (arg === '--global-storage') {
      out.globalStorage = path.resolve(value());
    } else if (arg === '--transcript-root') {
      out.transcriptRoot = path.resolve(value());
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      out.suites.push(arg);
    }
  }
  if ((out.port === null) !== (out.token === null)) {
    throw new Error('--port and --token must be given together');
  }
  out.timeoutMs = out.timeoutSec * 1000;
  return out;
}

/** `all` → every suite, in dependency order; duplicates collapse. */
function expandSuites(requested) {
  if (!requested || requested.length === 0) {
    throw new Error('no suite given (use <suite...|all>)');
  }
  const names = [];
  for (const name of requested) {
    const list = name === 'all' ? SUITES : [name];
    for (const one of list) {
      if (!SUITES.includes(one)) {
        throw new Error(`unknown suite: ${one} (known: ${SUITES.join(', ')})`);
      }
      if (!names.includes(one)) {
        names.push(one);
      }
    }
  }
  return names;
}

/** Is that pid alive? EPERM means "alive, not ours". */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err) && err.code === 'EPERM';
  }
}

/** Where the extension writes its per-process discovery files (mirrors hvsc). */
function globalStorageDirs(env = process.env) {
  const override = (env.HARNESS_GLOBAL_STORAGE || env.HYPER_VSCODE_GLOBAL_STORAGE || '').trim();
  if (override) {
    return [override];
  }
  const dirs = [];
  const appData = env.APPDATA;
  if (appData) {
    for (const flavor of ['Code', 'Code - Insiders', 'Cursor', 'VSCodium']) {
      dirs.push(path.join(appData, flavor, 'User', 'globalStorage', EXT_ID));
    }
  }
  const home = env.HOME || env.USERPROFILE;
  if (home) {
    dirs.push(path.join(home, '.config', 'Code', 'User', 'globalStorage', EXT_ID));
    dirs.push(path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', EXT_ID));
  }
  return dirs;
}

/**
 * Pick a control plane out of the discovery records (newest first). Pure: the
 * caller supplies `{file, rec, alive, mtimeMs}` candidates.
 */
function selectTarget(candidates, { instance = null, explicitFile = null } = {}) {
  let pool = candidates;
  if (explicitFile) {
    pool = candidates.filter((c) => c.file === explicitFile);
    if (pool.length === 0) {
      return { error: `no usable discovery record in ${explicitFile}` };
    }
  } else {
    pool = candidates.filter((c) => c.alive !== false);
  }
  if (instance) {
    pool = pool.filter((c) => c.rec.instanceId === instance || path.basename(c.file).replace(/\.json$/, '') === instance);
    if (pool.length === 0) {
      return { error: `no live control plane for instance "${instance}"`, candidates };
    }
  }
  if (pool.length === 0) {
    const stale = candidates.length ? ` (${candidates.length} stale/unreadable discovery file(s))` : '';
    return { error: `no live harness window found${stale} — is spinney.httpApi.enabled on?`, candidates };
  }
  const best = pool[0];
  return {
    target: {
      instanceId: best.rec.instanceId ?? path.basename(best.file).replace(/\.json$/, ''),
      pid: best.rec.pid ?? null,
      port: best.rec.port,
      token: best.rec.token,
      workspace: best.rec.workspace ?? null,
      version: best.rec.version ?? '',
      startedAt: best.rec.startedAt ?? null,
      file: best.file,
      how: explicitFile ? 'explicit --discovery file' : instance ? 'matched --instance' : 'newest live discovery record',
    },
  };
}

/** Read every discovery record on disk, newest first. */
function readCandidates(flags, env = process.env, deps = {}) {
  const dirs = flags.globalStorage ? [flags.globalStorage] : globalStorageDirs(env);
  const alive = deps.pidAlive ?? pidAlive;
  const candidates = [];
  for (const dir of dirs) {
    const httpDir = path.join(dir, 'http');
    let entries;
    try {
      entries = fs.readdirSync(httpDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const file = path.join(httpDir, name);
      let rec;
      let mtimeMs = 0;
      try {
        rec = JSON.parse(fs.readFileSync(file, 'utf8'));
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (!rec || typeof rec.port !== 'number' || typeof rec.token !== 'string' || !rec.token) {
        continue;
      }
      candidates.push({
        file,
        rec,
        mtimeMs,
        alive: typeof rec.pid === 'number' ? alive(rec.pid) : true,
      });
    }
  }
  candidates.sort((a, b) => (b.mtimeMs || b.rec.startedAt || 0) - (a.mtimeMs || a.rec.startedAt || 0));
  return candidates;
}

/**
 * Mirror of `transcriptRoot()` in `src/chat/ChatViewProvider.ts`: an explicit
 * override wins; otherwise `<globalStorage>/transcripts`; a relative override
 * resolves against the harness root (workspace folder, else the no-workspace
 * scratch root under global storage).
 */
function transcriptRootFor({ override = null, setting = '', globalStorage = null, workspace = null, tmpDir = os.tmpdir() } = {}) {
  if (override) {
    return path.resolve(override);
  }
  const configured = String(setting ?? '').trim();
  if (configured) {
    if (path.isAbsolute(configured)) {
      return configured;
    }
    const base = workspace || (globalStorage ? path.join(globalStorage, 'no-workspace') : path.join(tmpDir, 'spinney-storage'));
    return path.resolve(base, configured);
  }
  if (globalStorage) {
    return path.join(globalStorage, 'transcripts');
  }
  return path.join(tmpDir, 'spinney-transcripts');
}

/** Lenient JSONC read (VS Code settings allow comments). */
function readJsonc(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    /* fall through: strip comments + trailing commas */
  }
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'\\])\/\/[^\n]*/g, '$1')
    .replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

/**
 * Resolve one `spinney.*` setting the way the host does: the workspace's
 * `.vscode/settings.json` wins over the user's `settings.json` (machine /
 * workspace-folder layers are not modelled — the harness reads the same keys
 * from the same two files in practice).
 */
function readSetting(key, { workspace = null, appData = null, env = process.env } = {}) {
  const files = [];
  if (workspace) {
    files.push(path.join(workspace, '.vscode', 'settings.json'));
  }
  const data = appData ?? env.APPDATA;
  if (data) {
    files.push(path.join(data, 'Code', 'User', 'settings.json'));
  }
  for (const file of files) {
    const json = readJsonc(file);
    if (json && Object.prototype.hasOwnProperty.call(json, key)) {
      return json[key];
    }
  }
  return undefined;
}

// ---- transcript dumps ------------------------------------------------------

/** Flatten a message's content (string or content-part array) to plain text. */
function flattenContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') {
      continue;
    }
    if (part.type === 'text') {
      parts.push(String(part.text ?? ''));
    } else if (part.type === 'file') {
      parts.push(`[image ${String(part.file_id ?? '')}]`);
    } else if (part.type === 'image_url') {
      parts.push('[image]');
    }
  }
  return parts.join(' ');
}

/** One message's searchable text (thinking included). */
function messageText(message) {
  if (!message || typeof message !== 'object') {
    return '';
  }
  const body = flattenContent(message.content);
  const thinking = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
  return thinking ? `${body}\n${thinking}` : body;
}

/** Parse a JSONL transcript: line 1 = meta, the rest = API messages. */
function parseTranscriptJsonl(text) {
  const lines = String(text ?? '').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const safe = (raw) => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  const meta = lines.length > 0 ? safe(lines[0]) : null;
  const messages = [];
  for (let i = 1; i < lines.length; i += 1) {
    const parsed = safe(lines[i]);
    if (parsed) {
      messages.push(parsed);
    }
  }
  return { meta, messages, lines: lines.length };
}

/** Whole-file text (meta included) — the cheap ownership probe. */
function transcriptText(parsed) {
  const head = parsed.meta ? JSON.stringify(parsed.meta) : '';
  return [head, ...parsed.messages.map((m) => `${m.role ?? '?'}: ${messageText(m)}`)].join('\n');
}

/** The user prompts recorded in a transcript. */
function userTexts(parsed) {
  return parsed.messages.filter((m) => m.role === 'user').map((m) => messageText(m));
}

/** Tool calls of one name, with parsed arguments (invalid JSON → `{}`). */
function toolCallsOf(parsed, name) {
  const out = [];
  for (const message of parsed.messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) {
      continue;
    }
    for (const call of message.tool_calls) {
      const fn = call?.function ?? {};
      if (fn.name !== name) {
        continue;
      }
      let args = {};
      try {
        args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments ?? {};
      } catch {
        args = {};
      }
      out.push({ id: call?.id ?? '', args });
    }
  }
  return out;
}

// ---- completion signals (what the `signals` suite reads) -------------------

/**
 * The host's background-completion wording (`runtime.ts` `buildBackgroundSignal`),
 * as it appears in the `role:'user'` message injected into the owning node. Every
 * prompt this harness sends deliberately avoids it, so finding both fragments in a
 * dump can only mean the host put them there.
 */
const SIGNAL_FRAGMENTS = ['Background command', 'finished with exit code'];

/**
 * The injected completion notice inside one node's transcript, if any: the first
 * `role:'user'` message carrying the host's wording, plus the role of the message
 * right before it — the injection *point*.
 *
 * Which role precedes it is implementation-defined and both are correct
 * (`docs/agents/invariants/conversation-validity.md`):
 *   - `tool`      — the owner's turn was still streaming, so the signal landed at
 *                   the next tool boundary (`Agent.setSignalHandler`, the mid-turn
 *                   hook added by the signal work);
 *   - `assistant` — the turn had already closed, so the host delivered it as an
 *                   injected turn on that same node (`beginInjectedTurn`, `fresh:false`).
 * A notice that *is* the node's first message is neither: that is the shape of the
 * old "one node per notice" behaviour this work removes.
 */
function findSignalNotice(parsed, { fragments = SIGNAL_FRAGMENTS } = {}) {
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message || message.role !== 'user') {
      continue;
    }
    const text = messageText(message);
    if (!fragments.every((fragment) => text.includes(fragment))) {
      continue;
    }
    const before = i > 0 ? String(messages[i - 1]?.role ?? '?') : null;
    return {
      index: i,
      total: messages.length,
      text,
      before,
      /** Human label of the boundary the notice was injected at. */
      boundary: before === 'tool' ? 'tool batch' : before === 'assistant' ? 'turn closed' : null,
      injected: before === 'tool' || before === 'assistant',
    };
  }
  return null;
}

/** Parse a node's dump straight off disk; `null` when it is not there (yet). */
function readTranscriptNow(cx, sessionId, nodeId) {
  const file = path.join(cx.transcriptDir(sessionId), `${nodeId}.jsonl`);
  try {
    return { file, parsed: parseTranscriptJsonl(fs.readFileSync(file, 'utf8')) };
  } catch {
    return null;
  }
}

/** Every `<nodeId>.jsonl` dump in one session's transcript folder. */
function sessionTranscriptFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((name) => name.endsWith('.jsonl')).map((name) => path.join(dir, name));
}

/** The session's dumps that carry an injected completion notice, with their node. */
function dumpsWithNotice(dir, { fragments = SIGNAL_FRAGMENTS } = {}) {
  const out = [];
  for (const file of sessionTranscriptFiles(dir)) {
    let parsed;
    try {
      parsed = parseTranscriptJsonl(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const notice = findSignalNotice(parsed, { fragments });
    if (notice) {
      out.push({ file, nodeId: path.basename(file, '.jsonl'), notice });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTTP client (no /wait-for-finish: it would deadlock an agent caller)
// ---------------------------------------------------------------------------

function timeoutSignal(ms) {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
}

function makeClient(target) {
  const base = `http://127.0.0.1:${target.port}`;
  async function request(method, route, body) {
    const headers = { Authorization: `Bearer ${target.token}` };
    const init = { method, headers, signal: timeoutSignal(REQUEST_TIMEOUT_MS) };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(base + route, init);
    } catch (err) {
      throw new Error(`${method} ${route} failed: ${err && err.message ? err.message : String(err)}`);
    }
    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    return { status: res.status, body: parsed ?? {} };
  }
  return {
    base,
    request,
    health: () => request('GET', '/health'),
    state: () => request('GET', '/state'),
    startSession: (payload) => request('POST', '/session/start', payload),
    navigate: (payload) => request('POST', '/navigate', payload),
    continueFrom: (payload) => request('POST', '/continue', payload),
    stop: (payload) => request('POST', '/stop', payload),
  };
}

// ---------------------------------------------------------------------------
// Suite plumbing
// ---------------------------------------------------------------------------

/** Sessions listed by `/state`, keyed by id. */
function sessionMap(state) {
  const list = resolveField(state, 'sessions').values[0];
  const map = new Map();
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (entry && typeof entry.id === 'string') {
        map.set(entry.id, entry);
      }
    }
  }
  return map;
}

/** Does session `id` report a live run, using the field the host exposes? */
function isSessionRunning(state, id, field) {
  const info = sessionMap(state).get(id);
  if (!info) {
    return false;
  }
  if (field === 'sessions[].runningNodes') {
    return Array.isArray(info.runningNodes) && info.runningNodes.length > 0;
  }
  if (field === 'sessions[].running') {
    return info.running === true;
  }
  return false;
}

/** Node ids a session (by id) reports as live, from `sessions[].runningNodes`. */
function sessionRunningNodes(state, sessionId) {
  const info = sessionMap(state).get(sessionId);
  return info && Array.isArray(info.runningNodes) ? info.runningNodes.map(String) : [];
}

/**
 * Node ids a session (by id) reports as owning a **running** background job, from
 * `sessions[].backgroundNodes`; `null` when the host does not expose the field at
 * all (so a caller can tell "absent" from "empty").
 */
function sessionBackgroundNodes(state, sessionId) {
  const info = sessionMap(state).get(sessionId);
  return info && Array.isArray(info.backgroundNodes) ? info.backgroundNodes.map(String) : null;
}

/**
 * `/state`'s node count for one session — every tree node, sidecar cards included —
 * or `null` when the session (or the field) is absent.
 */
function sessionNodeCount(state, sessionId) {
  const info = sessionMap(state).get(sessionId);
  return info && Number.isFinite(info.nodes) ? info.nodes : null;
}

/**
 * Does `/state` show a live run for that session, tolerating either field shape
 * (`running:true` or a non-empty `runningNodes`)? A field-agnostic liveness probe
 * for callers that must not depend on which field the host happens to expose.
 */
function stateShowsRun(state, sessionId) {
  const info = sessionMap(state).get(sessionId);
  if (!info) {
    return false;
  }
  return info.running === true || (Array.isArray(info.runningNodes) && info.runningNodes.length > 0);
}

/**
 * Did a control-plane call land? `200` and not `ok:false`. A refused branch
 * answers `409` / `ok:false`; the `202 queued` form is not a start, so it does
 * not count either.
 */
function apiAccepted(res) {
  return Boolean(res) && res.status === 200 && res.body && res.body.ok !== false;
}

/**
 * Ordered targets for the "same-node exclusion" probe: the newest node this
 * suite opened that is still live, then the basis node when it too is live (the
 * literal "same node" a repeat continue would revisit). Empty when neither is.
 */
function branchExclusionTargets(runningNodes, opened, basis) {
  const running = Array.isArray(runningNodes) ? runningNodes.map(String) : [];
  const targets = [];
  const mine = (Array.isArray(opened) ? opened : []).map(String).filter((id) => id && running.includes(id));
  if (mine.length > 0) {
    targets.push(mine[mine.length - 1]);
  }
  if (basis && running.includes(String(basis)) && !targets.includes(String(basis))) {
    targets.push(String(basis));
  }
  return targets;
}

/**
 * Wait (generously) for a session's runs to drain, so a later branch is opened
 * off an *idle* basis. Emits a heartbeat every `logMs` — a slow settle should be
 * visible, not mysterious. Returns true once `/state` reports no live node for
 * `sessionId` (and never a bogus "settled" because `/state` was unreachable).
 */
async function waitForSessionIdle(cx, sessionId, { budgetMs = 180000, logMs = 5000 } = {}) {
  const startedAt = Date.now();
  let lastLog = startedAt;
  const result = await pollUntil(
    async () => {
      const res = await cx.client.state();
      const running = res.status === 200 && res.body && res.body.ok !== false ? sessionRunningNodes(res.body, sessionId) : null;
      const now = Date.now();
      if (now - lastLog >= logMs) {
        lastLog = now;
        const secs = Math.round((now - startedAt) / 1000);
        cx.emit(
          `           … ${sessionId}: ${
            running === null ? 'no /state yet' : running.length ? `still running [${running.join(', ')}]` : 'idle'
          } (${secs}s)`,
        );
      }
      return running !== null && running.length === 0 ? true : undefined;
    },
    { timeoutMs: budgetMs, intervalMs: Math.max(cx.flags.intervalMs, 500) },
  );
  return result.ok;
}

/** Poll `/state` until `predicate(state)` holds; keeps the observation trail. */
async function pollState(cx, predicate, timeoutMs) {
  const observations = [];
  let last = null;
  const result = await pollUntil(
    async () => {
      const res = await cx.client.state();
      if (res.status === 200 && res.body && res.body.ok !== false) {
        last = res.body;
        observations.push(res.body);
        if (predicate(last)) {
          return last;
        }
      }
      return undefined;
    },
    { timeoutMs, intervalMs: cx.flags.intervalMs },
  );
  return { ok: result.ok, state: result.ok ? result.value : last, observations, polls: result.polls };
}

/** Poll the disk for a turn's transcript dump. */
async function waitForFile(file, timeoutMs, intervalMs = 500) {
  const result = await pollUntil(() => (fs.existsSync(file) ? file : undefined), { timeoutMs, intervalMs });
  return result.ok ? result.value : null;
}

/** `null` when no dump should be expected (setting off) or is not there yet. */
async function readTranscript(cx, sessionId, nodeId, { waitMs = TRANSCRIPT_WAIT_MS } = {}) {
  if (!cx.saveSessionTranscripts) {
    return { skip: 'spinney.saveSessionTranscripts is off — this host writes no per-turn dumps' };
  }
  const file = path.join(cx.transcriptDir(sessionId), `${nodeId}.jsonl`);
  const found = fs.existsSync(file) ? file : await waitForFile(file, waitMs);
  if (!found) {
    return { skip: `no transcript dump at ${file} after ${Math.round(waitMs / 1000)}s` };
  }
  return { file, parsed: parseTranscriptJsonl(fs.readFileSync(file, 'utf8')) };
}

/**
 * Ownership assertions for one turn: the dump must carry the right ids and the
 * run's marker, and must not carry another run's marker.
 */
function ownershipChecks(cx, checks, label, read, { sessionId, nodeId, marker, foreign = [] }) {
  if (read.skip) {
    checks.subskip(`${label}: message ownership`, read.skip);
    return;
  }
  const { meta, messages } = read.parsed;
  const text = transcriptText(read.parsed);
  checks.check(`${label}: dump meta kind=session`, meta?.kind === 'session', `kind=${meta?.kind}`);
  checks.check(`${label}: dump meta.sessionId=${sessionId}`, meta?.sessionId === sessionId, `meta.sessionId=${meta?.sessionId}`);
  checks.check(`${label}: dump meta.nodeId=${nodeId}`, meta?.nodeId === nodeId, `meta.nodeId=${meta?.nodeId}`);
  checks.check(
    `${label}: own marker recorded in this turn`,
    userTexts(read.parsed).some((t) => t.includes(marker)) || String(meta?.prompt ?? '').includes(marker),
    `${messages.length} message(s)`,
  );
  for (const other of foreign) {
    checks.check(`${label}: no foreign marker "${other}"`, !text.includes(other));
  }
}

// ---- session creation shared by the suites ----

const sleepCmd = (ms) => `node -e "setTimeout(()=>{},${ms})"`;

/** A prompt that keeps one run busy long enough to observe concurrency. */
function longRunPrompt(runId, label, ms = 15000) {
  const args = JSON.stringify({ command: sleepCmd(ms) });
  return (
    `HARNESS-TEST ${runId} ${label}: call the exec_command tool exactly once with ${args} ` +
    '(no other arguments), wait for it to finish, then reply with the single word "ok". ' +
    'Do not call any other tool.'
  );
}

/** A prompt that makes the agent start an exec_command in the background. */
function backgroundPrompt(runId) {
  const args = JSON.stringify({ command: sleepCmd(25000), timeout_behavior: 'start_in_background' });
  return (
    `HARNESS-TEST ${runId} BG: call the exec_command tool exactly once with ${args}, ` +
    'then reply with the returned background id and nothing else. Do not call any other tool.'
  );
}

/**
 * The `signals` suite's prompt: start a short background job, then keep the *same*
 * turn busy with two foreground rounds, so the job finishes **while its owner still
 * streams** — the mid-turn delivery path. The wording deliberately avoids the host's
 * own completion phrases ("Background command", "finished with exit code"), so
 * finding them in a dump can only mean the host injected them.
 */
function signalPrompt(runId, { jobMs = 6000, busyMs = 12000 } = {}) {
  const job = JSON.stringify({ command: sleepCmd(jobMs), timeout_behavior: 'start_in_background' });
  const wait = JSON.stringify({ command: sleepCmd(busyMs) });
  return (
    `HARNESS-TEST ${runId} SIG: a timing check of background terminals. ` +
    `Step 1: call the exec_command tool with ${job} — that starts a short job and returns immediately. ` +
    `Step 2: then call exec_command with ${wait} and wait for it to finish; do not put it in the background. ` +
    `Step 3: call exec_command once more with ${wait} and wait for it to finish. ` +
    'Then reply with the single word "DONE". Use the exec_command tool only, and do not join, kill or poll the background terminal.'
  );
}

/**
 * The branch suite's first prompt: a short task (~12 s) whose turn 1 drains
 * quickly, leaving an *idle* basis node to open the two concurrent branches from.
 */
function branchStartPrompt(runId, ms = 12000) {
  const args = JSON.stringify({ command: sleepCmd(ms) });
  return (
    `HARNESS-TEST ${runId} BR1: call the exec_command tool exactly once with ${args} ` +
    '(no other arguments), wait for it to finish, then reply with the single word "DONE". ' +
    'Do not call any other tool.'
  );
}

/**
 * `POST /session/start` with a prompt. Returns `{sessionId, nodeId, status}`,
 * or `{skip}` when the host legitimately cannot start it yet (queued because a
 * turn is running = P4's "start immediately"; refused while busy = P1's
 * concurrent sessions), or `{fail}` for a real error.
 */
async function startSession(cx, { label, prompt }) {
  const title = `harness-test ${cx.runId} ${label}`;
  const res = await cx.client.startSession({ title, prompt });
  const body = res.body ?? {};
  if (res.status === 200 && typeof body.sessionId === 'string' && body.sessionId) {
    cx.ctx.created.push({ id: body.sessionId, nodeId: body.nodeId ?? null, title, label, suite: cx.currentSuite });
    return { sessionId: body.sessionId, nodeId: typeof body.nodeId === 'string' ? body.nodeId : null, status: res.status };
  }
  if (res.status === 202 || body.queued === true) {
    return {
      skip:
        'POST /session/start returned 202 queued (the window is busy; starts run when the current turn ends) — ' +
        '"/session/start starts immediately" is phase P4',
    };
  }
  if (res.status === 409) {
    return {
      skip:
        `POST /session/start refused (409: ${body.error ?? 'busy'}) — starting a session while a turn runs ` +
        'is phase P1 (concurrent sessions) / P4 ("starts immediately")',
    };
  }
  return { fail: `POST /session/start → HTTP ${res.status}: ${body.error ?? JSON.stringify(body)}` };
}

/**
 * Two sessions with a long-running turn each; shared between suites. The cached
 * pair is reused only while **both turns are still live** — an `all` run reaches
 * `concurrency` after `sessions` has already drained the pair, and reusing a
 * drained pair is exactly what made that suite flaky. A stale pair is replaced
 * by a fresh one, started back-to-back (A then B) so the two ~20 s turns overlap.
 */
async function ensureTwoSessions(cx) {
  if (cx.ctx.two) {
    const now = await cx.client.state();
    if (stateShowsRun(now.body, cx.ctx.two.a.sessionId) && stateShowsRun(now.body, cx.ctx.two.b.sessionId)) {
      return cx.ctx.two;
    }
  }
  const a = await startSession(cx, { label: 'A', prompt: longRunPrompt(cx.runId, 'A', 20000) });
  if (a.fail) {
    return { fail: a.fail };
  }
  if (a.skip) {
    return { skip: a.skip };
  }
  const b = await startSession(cx, { label: 'B', prompt: longRunPrompt(cx.runId, 'B', 20000) });
  if (b.fail) {
    return { fail: b.fail };
  }
  if (b.skip) {
    return { skip: b.skip };
  }
  cx.ctx.two = { a, b, markerA: `HARNESS-TEST ${cx.runId} A`, markerB: `HARNESS-TEST ${cx.runId} B` };
  return cx.ctx.two;
}

// ---------------------------------------------------------------------------
// Suite: health
// ---------------------------------------------------------------------------

async function suiteHealth(cx) {
  const checks = makeChecks();
  const name = 'health';
  const health = await cx.client.health();
  checks.check('GET /health answers 200', health.status === 200, `status=${health.status}`);
  if (health.status !== 200) {
    return suiteResult(name, 'FAIL', `GET /health → ${health.status} ${JSON.stringify(health.body)}`, checks);
  }
  checks.check('/health ok=true', health.body.ok === true);
  checks.check(
    cx.target.instanceId ? `/health instanceId=${cx.target.instanceId}` : `/health instanceId=${health.body.instanceId}`,
    !cx.target.instanceId || health.body.instanceId === cx.target.instanceId,
    `got ${health.body.instanceId}`,
  );
  if (cx.target.pid !== null) {
    checks.check(`/health pid=${cx.target.pid}`, health.body.pid === cx.target.pid, `got ${health.body.pid}`);
  }
  checks.check(`/health port=${cx.target.port}`, health.body.port === cx.target.port, `got ${health.body.port}`);

  const state = await cx.client.state();
  checks.check('GET /state answers 200', state.status === 200, `status=${state.status}`);
  if (state.status !== 200) {
    return suiteResult(name, 'FAIL', `GET /state → ${state.status}`, checks);
  }
  const body = state.body;
  checks.check('/state ok=true', body.ok === true);
  checks.check('/state busy is a boolean', typeof body.busy === 'boolean', `busy=${JSON.stringify(body.busy)}`);
  const sessionsField = resolveField(body, 'sessions');
  checks.check(
    '/state sessions is an array',
    sessionsField.found && Array.isArray(sessionsField.values[0]),
    `type=${Array.isArray(sessionsField.values[0]) ? 'array' : typeof sessionsField.values[0]}`,
  );
  if (!Array.isArray(sessionsField.values[0])) {
    return suiteResult(name, 'FAIL', '/state.sessions is not an array', checks);
  }
  const sessions = sessionsField.values[0];
  const ids = sessions.map((s) => s && s.id);
  checks.check(
    'every session entry has id/title/nodes',
    sessions.every((s) => s && typeof s.id === 'string' && typeof s.title === 'string' && Number.isFinite(s.nodes)),
  );
  checks.check('session ids are unique', new Set(ids).size === ids.length, `${ids.length} session(s)`);
  const active = sessions.filter((s) => s && s.active === true);
  checks.check(
    'at most one session is active',
    active.length <= 1,
    active.map((s) => s.id).join(', ') || 'none',
  );
  checks.check(
    '/state.sessionId is a listed session',
    body.sessionId === null || body.sessionId === undefined || ids.includes(body.sessionId),
    `sessionId=${JSON.stringify(body.sessionId)}`,
  );
  if (active.length === 1) {
    checks.check('/state.sessionId matches the active session', active[0].id === body.sessionId, `active=${active[0].id}`);
  }
  checks.check(
    '/state.activeNodeId is a string or null',
    body.activeNodeId === null || typeof body.activeNodeId === 'string',
    `activeNodeId=${JSON.stringify(body.activeNodeId)}`,
  );
  const runningNodes = resolveField(body, 'sessions[].runningNodes');
  checks.note(
    sessions.length === 0
      ? 'no session yet — per-session fields (running / runningNodes) cannot be probed in this sample'
      : runningNodes.found
        ? 'per-session runningNodes exposed'
        : 'per-session runningNodes absent (phase P1) — concurrency/navigation will SKIP',
  );
  const bad = checks.failures();
  return suiteResult(
    name,
    bad.length ? 'FAIL' : 'PASS',
    bad.length ? `${bad.length} check(s) failed` : `${sessions.length} session(s), busy=${body.busy}`,
    checks,
  );
}

// ---------------------------------------------------------------------------
// Suite: sessions
// ---------------------------------------------------------------------------

async function suiteSessions(cx) {
  const checks = makeChecks();
  const name = 'sessions';
  const two = await ensureTwoSessions(cx);
  if (two.fail) {
    return suiteResult(name, 'FAIL', two.fail, checks);
  }
  if (two.skip) {
    checks.note(
      'the start was accepted by the host but did not produce a session in this run ' +
        '(a queued start runs when the current turn ends)',
    );
    return suiteResult(name, 'SKIP', two.skip, checks);
  }
  const { a, b, markerA, markerB } = two;
  checks.check('two distinct session ids', a.sessionId !== b.sessionId, `${a.sessionId} vs ${b.sessionId}`);
  checks.check('both starts returned a node id', Boolean(a.nodeId) && Boolean(b.nodeId), `${a.nodeId} / ${b.nodeId}`);
  checks.check('the two turns opened distinct nodes', a.nodeId !== b.nodeId, `${a.nodeId} vs ${b.nodeId}`);

  const stateRes = await cx.client.state();
  const map = sessionMap(stateRes.body);
  checks.check('session A is listed in /state', map.has(a.sessionId));
  checks.check('session B is listed in /state', map.has(b.sessionId));
  const listed = resolveField(stateRes.body, 'sessions').values[0] ?? [];
  const titles = new Map(listed.map((s) => [s.id, s.title]));
  checks.check(
    'each session carries the caller-supplied title',
    String(titles.get(a.sessionId) ?? '').includes(cx.runId) && String(titles.get(b.sessionId) ?? '').includes(cx.runId),
    `${titles.get(a.sessionId)} | ${titles.get(b.sessionId)}`,
  );

  // Message ownership: each prompt's marker must land in its own transcript.
  const readA = await readTranscript(cx, a.sessionId, a.nodeId);
  const readB = await readTranscript(cx, b.sessionId, b.nodeId);
  ownershipChecks(cx, checks, 'session A', readA, {
    sessionId: a.sessionId,
    nodeId: a.nodeId,
    marker: markerA,
    foreign: [markerB],
  });
  ownershipChecks(cx, checks, 'session B', readB, {
    sessionId: b.sessionId,
    nodeId: b.nodeId,
    marker: markerB,
    foreign: [markerA],
  });
  const bad = checks.failures();
  return suiteResult(
    name,
    bad.length ? 'FAIL' : 'PASS',
    bad.length ? `${bad.length} check(s) failed` : `created ${a.sessionId} and ${b.sessionId}`,
    checks,
  );
}

// ---------------------------------------------------------------------------
// Suite: concurrency
// ---------------------------------------------------------------------------

async function suiteConcurrency(cx) {
  const checks = makeChecks();
  const name = 'concurrency';
  const probe = await cx.client.state();
  const field = pickField(probe.body, ['sessions[].runningNodes', 'sessions[].running']);
  if (!field) {
    return suiteResult(
      name,
      'SKIP',
      `missing /state.sessions[].running (expected in phase ${phaseFor('sessions[].running')})`,
      checks,
    );
  }
  const two = await ensureTwoSessions(cx);
  if (two.fail) {
    return suiteResult(name, 'FAIL', two.fail, checks);
  }
  if (two.skip) {
    return suiteResult(name, 'SKIP', two.skip, checks);
  }
  const { a, b } = two;
  // Both sessions must be live with a non-empty `runningNodes` in ONE sample.
  const both = (state) => isSessionRunning(state, a.sessionId, field) && isSessionRunning(state, b.sessionId, field);

  // The very next request after the two `/session/start` calls is this sample — a
  // tight first poll, so a wide (~20 s) overlap cannot slip past a delayed one.
  const observations = [];
  let polls = 1;
  const first = await cx.client.state();
  if (first.status === 200 && first.body && first.body.ok !== false) {
    observations.push(first.body);
  }
  let sawBoth = observations.some(both);
  if (!sawBoth) {
    const run = await pollState(cx, both, Math.min(cx.flags.timeoutMs, 60000));
    observations.push(...run.observations);
    polls += run.polls;
    sawBoth = run.ok;
  }
  const seenA = observations.some((s) => isSessionRunning(s, a.sessionId, field));
  const seenB = observations.some((s) => isSessionRunning(s, b.sessionId, field));
  checks.note(`observed via ${field} over ${polls} poll(s): A ran=${seenA}, B ran=${seenB}`);
  if (sawBoth) {
    checks.check('both sessions report a live run in one /state sample', true, `${a.sessionId} && ${b.sessionId}`);
    return suiteResult(name, 'PASS', 'both sessions ran at the same time', checks);
  }
  if (!seenA && !seenB) {
    // Genuinely inconclusive: nothing was ever observed running (e.g. the turns
    // finished before the first sample). The counts are in the message so a human
    // can tell flakiness from a real gate.
    return suiteResult(
      name,
      'SKIP',
      `inconclusive: no live run seen for either session in ${polls} sample(s) (A ran=${seenA} B ran=${seenB}) — the turns may have finished before the first sample`,
      checks,
    );
  }
  const missingSide = seenA ? b.sessionId : a.sessionId;
  const ranSide = seenA ? a.sessionId : b.sessionId;
  checks.check('both sessions report a live run in one /state sample', false, `only ${ranSide} was ever observed running`);
  return suiteResult(
    name,
    'FAIL',
    seenA && seenB
      ? 'both sessions ran, but never at the same time (the host serialises runs)'
      : `session ${missingSide} never reported a run while ${ranSide} did`,
    checks,
  );
}

// ---------------------------------------------------------------------------
// Suite: navigation
// ---------------------------------------------------------------------------

async function suiteNavigation(cx) {
  const checks = makeChecks();
  const name = 'navigation';
  const probe = await cx.client.state();
  const field = pickField(probe.body, ['sessions[].running', 'sessions[].runningNodes']);
  if (!field) {
    return suiteResult(
      name,
      'SKIP',
      `missing /state.sessions[].running (expected in phase ${phaseFor('sessions[].running')})`,
      checks,
    );
  }
  const two = await ensureTwoSessions(cx);
  if (two.fail) {
    return suiteResult(name, 'FAIL', two.fail, checks);
  }
  if (two.skip) {
    return suiteResult(name, 'SKIP', two.skip, checks);
  }
  const { a, b, markerA } = two;

  // 1. View focus moves to B without touching A's run.
  const navB = await cx.client.navigate({ sessionId: b.sessionId, nodeId: b.nodeId });
  checks.check('POST /navigate (session B) → ok', navB.status === 200 && navB.body.ok === true, `HTTP ${navB.status}`);
  checks.check(
    '/navigate reports the target session/node',
    navB.body.sessionId === b.sessionId && navB.body.nodeId === b.nodeId,
    `${navB.body.sessionId} / ${navB.body.nodeId}`,
  );
  const focused = await pollState(
    cx,
    (state) => state.sessionId === b.sessionId && state.activeNodeId === b.nodeId,
    Math.min(cx.flags.timeoutMs, 15000),
  );
  checks.check(
    '/state focus moved to session B',
    focused.ok,
    `sessionId=${focused.state?.sessionId} activeNodeId=${focused.state?.activeNodeId}`,
  );
  const aAliveAfterNav = focused.state ? isSessionRunning(focused.state, a.sessionId, field) : null;

  // 2. …and back to A.
  const navA = await cx.client.navigate({ sessionId: a.sessionId, nodeId: a.nodeId });
  checks.check('POST /navigate (session A) → ok', navA.status === 200 && navA.body.ok === true, `HTTP ${navA.status}`);
  const back = await pollState(
    cx,
    (state) => state.sessionId === a.sessionId && state.activeNodeId === a.nodeId,
    Math.min(cx.flags.timeoutMs, 15000),
  );
  checks.check('/state focus moved back to session A', back.ok, `sessionId=${back.state?.sessionId}`);
  const beforeContinue = await cx.client.state();
  const aRunningBefore = isSessionRunning(beforeContinue.body, a.sessionId, field);

  // 3. Continue session B from its own node while A keeps running.
  const marker = `HARNESS-TEST ${cx.runId} NAV`;
  const tContinue = Date.now();
  const cont = await cx.client.continueFrom({ sessionId: b.sessionId, nodeId: b.nodeId, message: `${marker}` });
  if (cont.status === 409 || cont.body.ok === false) {
    checks.note(`POST /continue → ${cont.status} ${cont.body.error ?? ''}`);
    return suiteResult(
      name,
      'SKIP',
      `POST /continue refused while another session runs (HTTP ${cont.status}: ${cont.body.error ?? 'busy'}) — concurrent sessions are phase P1`,
      checks,
    );
  }
  checks.check('POST /continue → ok', cont.status === 200, `HTTP ${cont.status}`);
  const newNode = typeof cont.body.nodeId === 'string' ? cont.body.nodeId : null;
  checks.check('POST /continue reports a new node id', Boolean(newNode) && newNode !== b.nodeId, `${b.nodeId} → ${newNode}`);

  // 4. A's run must be untouched by the navigation + continue on B.
  const after = await pollState(
    cx,
    (state) => isSessionRunning(state, b.sessionId, field),
    Math.min(cx.flags.timeoutMs, 30000),
  );
  checks.check('session B reports the continued node running', after.ok || Boolean(newNode), 'polled via /state');
  if (aRunningBefore) {
    const aRunningAfter = after.state ? isSessionRunning(after.state, a.sessionId, field) : false;
    if (aRunningAfter) {
      checks.check('session A kept running while B was navigated and continued', true);
    } else {
      const ended = await turnEndedNaturally(cx, a.sessionId, a.nodeId, tContinue);
      if (ended) {
        checks.subskip('session A kept running while B was continued', `A's turn ended on its own at ${new Date(ended).toISOString()}`);
      } else {
        checks.check('session A kept running while B was navigated and continued', false, 'A reported idle with no finished transcript');
      }
    }
  } else {
    checks.subskip('session A kept running while B was continued', "A's run was already over before /continue");
  }

  // 5. Ownership: the continue's message belongs to B's new node, not A.
  if (newNode) {
    const read = await readTranscript(cx, b.sessionId, newNode);
    ownershipChecks(cx, checks, 'continue on B', read, {
      sessionId: b.sessionId,
      nodeId: newNode,
      marker,
      foreign: [markerA],
    });
    const readA = await readTranscript(cx, a.sessionId, a.nodeId, { waitMs: 5000 });
    if (!readA.skip) {
      checks.check('the continue message did not leak into session A', !transcriptText(readA.parsed).includes(marker));
    }
  }
  const bad = checks.failures().length;
  return suiteResult(name, bad ? 'FAIL' : 'PASS', bad ? `${bad} check(s) failed` : 'navigation and continue are session-local', checks);
}

/** Did that node's turn really finish before `beforeTs`? (avoids a false FAIL) */
async function turnEndedNaturally(cx, sessionId, nodeId, beforeTs) {
  const file = path.join(cx.transcriptDir(sessionId), `${nodeId}.jsonl`);
  if (!fs.existsSync(file)) {
    return null;
  }
  const { meta } = parseTranscriptJsonl(fs.readFileSync(file, 'utf8'));
  const endedAt = Number(meta?.endedAt);
  if (Number.isFinite(endedAt) && endedAt <= beforeTs + 2000) {
    return endedAt;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Suite: background
// ---------------------------------------------------------------------------

/**
 * P2 acceptance: a background job belongs to the **node** that spawned it, and
 * moving the view must not move the ownership ("a notice for node X arrives even
 * when the view sits on node Y"). Ownership is read from
 * `/state.sessions[].backgroundNodes` (node ids owning at least one running job).
 */
async function suiteBackground(cx) {
  const checks = makeChecks();
  const name = 'background';
  const missingField = `missing sessions[].backgroundNodes (expected in phase ${phaseFor('sessions[].backgroundNodes')})`;
  /** Node ids that own a running background, straight from /state. */
  const ownedNodesOf = (state, sessionId) => {
    const info = sessionMap(state).get(sessionId);
    if (info && Array.isArray(info.backgroundNodes)) {
      return info.backgroundNodes.map(String);
    }
    const top = resolveField(state, 'backgrounds[].nodeId');
    return top.found ? top.values.map(String) : null;
  };

  // Gate *before* spending a real turn. A probe with no session at all cannot
  // tell "field absent" from "empty list", so it is re-checked after the start.
  const probe = await cx.client.state();
  const probeSessions = resolveField(probe.body, 'sessions').values[0];
  const probed = Array.isArray(probeSessions) && probeSessions.length > 0;
  if (probed && !resolveField(probe.body, 'sessions[].backgroundNodes').found) {
    return suiteResult(name, 'SKIP', missingField, checks);
  }

  const started = await startSession(cx, { label: 'BG', prompt: backgroundPrompt(cx.runId) });
  if (started.fail) {
    return suiteResult(name, 'FAIL', started.fail, checks);
  }
  if (started.skip) {
    return suiteResult(name, 'SKIP', started.skip, checks);
  }
  const sessionId = started.sessionId;
  const ownerNode = started.nodeId;
  checks.note(`owning session ${sessionId} / node ${ownerNode}`);

  if (!probed) {
    const after = await cx.client.state();
    if (!resolveField(after.body, 'sessions[].backgroundNodes').found && !resolveField(after.body, 'backgrounds[].nodeId').found) {
      return suiteResult(name, 'SKIP', missingField, checks);
    }
  }

  // 1. The job shows up as exactly one entry in the owning session's list.
  const observed = await pollState(
    cx,
    (state) => {
      const nodes = ownedNodesOf(state, sessionId);
      return nodes && nodes.length > 0 ? nodes : undefined;
    },
    Math.min(cx.flags.timeoutMs, 60000),
  );
  const ownerList = observed.state ? ownedNodesOf(observed.state, sessionId) : null;

  // The dump proves a background job really was started, which separates "the
  // host is wrong" (FAIL) from "the prompt did not drive a job" (SKIP).
  const marker = `HARNESS-TEST ${cx.runId} BG`;
  const dump = await readTranscript(cx, sessionId, ownerNode);
  let bgCalls = [];
  if (!dump.skip) {
    checks.check(
      'the dump belongs to the background prompt',
      userTexts(dump.parsed).some((t) => t.includes(marker)) || String(dump.parsed.meta?.prompt ?? '').includes(marker),
      `${dump.parsed.messages.length} message(s)`,
    );
    bgCalls = toolCallsOf(dump.parsed, 'exec_command').filter(
      (c) => c.args && c.args.timeout_behavior === 'start_in_background',
    );
  }
  if (observed.ok && bgCalls.length > 0) {
    checks.check(
      'the owning node transcript holds the exec_command call',
      true,
      `${bgCalls.length} background call(s)`,
    );
  }
  if (!observed.ok) {
    if (dump.skip || bgCalls.length === 0) {
      checks.subskip('the run started a background job', dump.skip ?? `${bgCalls.length} background call(s) in the dump`);
      return suiteResult(
        name,
        'SKIP',
        'inconclusive: no background job observable yet (the prompt may not have driven one)',
        checks,
      );
    }
    checks.check(
      'the owning session lists the background node in sessions[].backgroundNodes',
      false,
      'a background job was started but /state never reported an owning node',
    );
    return suiteResult(name, 'FAIL', 'the host never reported the running background', checks);
  }
  checks.check('exactly one node owns the background', ownerList.length === 1, `backgroundNodes=[${ownerList.join(', ')}]`);
  checks.check(
    `the owner is the node that started the job (${ownerNode})`,
    ownerList[0] === ownerNode,
    `reported ${ownerList[0]}`,
  );
  const ownerInfo = sessionMap(observed.state).get(sessionId);
  if (ownerInfo && Object.prototype.hasOwnProperty.call(ownerInfo, 'runningBackgrounds')) {
    checks.check(
      'the owning session also reports runningBackgrounds',
      Boolean(ownerInfo.runningBackgrounds),
      `runningBackgrounds=${JSON.stringify(ownerInfo.runningBackgrounds)}`,
    );
  }
  // 2. Move the view inside the same session: ownership must not follow it.
  const navMessage = `HARNESS-TEST ${cx.runId} BGV: reply with the single word "ok" and do not call any tool.`;
  const cont = await cx.client.continueFrom({ sessionId, nodeId: ownerNode, message: navMessage });
  if (cont.status === 409 || cont.body.ok === false) {
    checks.subskip(
      'moving the view inside the session does not move background ownership',
      `POST /continue → HTTP ${cont.status} (${cont.body.error ?? 'busy'})`,
    );
    const bad = checks.failures().length;
    return suiteResult(
      name,
      bad ? 'FAIL' : 'SKIP',
      bad
        ? `${bad} check(s) failed`
        : 'ownership verified before the view move; the move itself could not be exercised (POST /continue refused)',
      checks,
    );
  }
  checks.check('POST /continue opened another node in the owning session', cont.status === 200, `HTTP ${cont.status}`);
  const otherNode = typeof cont.body.nodeId === 'string' ? cont.body.nodeId : null;
  checks.check(
    'the other node is distinct from the owner',
    Boolean(otherNode) && otherNode !== ownerNode,
    `${ownerNode} → ${otherNode}`,
  );
  if (otherNode) {
    const nav = await cx.client.navigate({ sessionId, nodeId: otherNode });
    checks.check('POST /navigate → ok', nav.status === 200 && nav.body.ok === true, `HTTP ${nav.status}`);
    const moved = await pollState(
      cx,
      (state) => state.sessionId === sessionId && state.activeNodeId === otherNode,
      Math.min(cx.flags.timeoutMs, 15000),
    );
    checks.check(
      'the view focus sits on the other node',
      moved.ok,
      `sessionId=${moved.state?.sessionId} activeNodeId=${moved.state?.activeNodeId}`,
    );
    const afterList = moved.state ? ownedNodesOf(moved.state, sessionId) : null;
    checks.check(
      'moving the view did not move background ownership',
      Array.isArray(afterList) && afterList.length === 1 && afterList[0] === ownerNode,
      `backgroundNodes=${JSON.stringify(afterList)}`,
    );
    checks.check(
      'the newly focused node owns no background',
      Array.isArray(afterList) && !afterList.includes(otherNode),
      `backgroundNodes=${JSON.stringify(afterList)}`,
    );
  }
  const bad = checks.failures().length;
  return suiteResult(
    name,
    bad ? 'FAIL' : 'PASS',
    bad ? `${bad} check(s) failed` : `background owned by ${ownerNode} in ${sessionId}, unchanged by the view move`,
    checks,
  );
}

// ---------------------------------------------------------------------------
// Suite: signals (a completion signal lands INSIDE the node that started the job)
// ---------------------------------------------------------------------------

/**
 * Acceptance for the completion-signal work (§3.2/§3.3, §4 P0+P1, §6 of the plan
 * that landed it): a finished background terminal is delivered into the
 * node that started it — never into a new node, never as a user bubble.
 *
 *   1. `/session/start` runs a turn that starts a short background job and then
 *      keeps working (two foreground tool rounds), so the job finishes **while its
 *      owner still streams** — the mid-turn delivery path the plan's P1 adds;
 *   2. the owning node's own transcript dump must gain a `role:'user'` message
 *      carrying the host's completion wording, at an injection point: right after
 *      the whole tool batch of a round (mid-turn hook) or right after the reply
 *      that closed the turn (idle injected turn). A notice that *opens* a node is
 *      the shape this work removes;
 *   3. the session's node count must be **unchanged** by the delivery — the notice
 *      creates no node — and the owning turn node must still exist;
 *   4. `sessions[].backgroundNodes` still reports the **turn** node that started the
 *      job, never the `kind:'bg'` card it spawned (`docs/agents/invariants/background-terminals.md`).
 *
 * `/state` exposes a node *count* and the background owner ids, never a per-node id
 * list nor a `delivered` flag, so the id-level halves of (3)/(4) are `skip`s and the
 * facts are proved indirectly: the owner id, the unchanged count, and a dump only a
 * main turn node writes (a `kind:'bg'` card is a sidecar and never dumps).
 */
async function suiteSignals(cx) {
  const checks = makeChecks();
  const name = 'signals';

  if (!cx.saveSessionTranscripts) {
    return suiteResult(
      name,
      'SKIP',
      'spinney.saveSessionTranscripts is off — where a completion signal lands is only observable in the per-node transcript dump',
      checks,
    );
  }

  // ---- phase gate (cheap; no turn is spent when the capability is absent) ----
  const gate = (state) => missingFields(state, ['sessions[].nodes', 'sessions[].backgroundNodes']);
  const skipMissing = (missing) =>
    suiteResult(
      name,
      'SKIP',
      `missing /state ${missing.join(' + ')} (expected in phase ${phaseFor(missing[0])})`,
      checks,
    );
  const probe = await cx.client.state();
  const probeSessions = resolveField(probe.body, 'sessions').values[0];
  const probed = Array.isArray(probeSessions) && probeSessions.length > 0;
  if (probed && gate(probe.body).length > 0) {
    return skipMissing(gate(probe.body));
  }

  const started = await startSession(cx, { label: 'SIG', prompt: signalPrompt(cx.runId) });
  if (started.fail) {
    return suiteResult(name, 'FAIL', started.fail, checks);
  }
  if (started.skip) {
    return suiteResult(name, 'SKIP', started.skip, checks);
  }
  const sessionId = started.sessionId;
  const ownerNode = started.nodeId;
  checks.note(`owning session ${sessionId} / turn node ${ownerNode}`);

  if (!probed) {
    const after = await cx.client.state();
    if (gate(after.body).length > 0) {
      return skipMissing(gate(after.body));
    }
  }
  // ---- 1. the job registers under the turn node that started it ----
  // The pre-delivery snapshot: the card exists from `register` onward (the hub's
  // `onRegistered` hook runs synchronously), so this count already includes it.
  const jobBudgetMs = Math.min(cx.flags.timeoutMs, 60000);
  const observed = await pollState(
    cx,
    (state) => {
      const owners = sessionBackgroundNodes(state, sessionId);
      return owners && owners.length > 0 ? owners : undefined;
    },
    jobBudgetMs,
  );
  if (!observed.ok) {
    // Separate "the host is wrong" from "the prompt did not drive a job": the dump
    // proves whether a background command was really started.
    const read = await readTranscript(cx, sessionId, ownerNode, { waitMs: jobBudgetMs });
    const calls = read.skip
      ? []
      : toolCallsOf(read.parsed, 'exec_command').filter((c) => c.args && c.args.timeout_behavior === 'start_in_background');
    if (read.skip || calls.length === 0) {
      checks.subskip('the run started a background job', read.skip ?? `${calls.length} start_in_background call(s) in the dump`);
      return suiteResult(name, 'SKIP', 'inconclusive: no background job observable (the prompt may not have driven one)', checks);
    }
    checks.check(
      'the owning session lists the background node in sessions[].backgroundNodes',
      false,
      'a background job was started but /state never reported an owning node',
    );
    return suiteResult(name, 'FAIL', 'the host never reported the running background', checks);
  }
  const ownerList = sessionBackgroundNodes(observed.state, sessionId) ?? [];
  const nodeCountBefore = sessionNodeCount(observed.state, sessionId);
  checks.note(`pre-delivery snapshot: nodes=${nodeCountBefore}, backgroundNodes=[${ownerList.join(', ')}]`);

  // (c) Semantics unchanged: the owner is the *turn* node, and only it owns the job.
  checks.check('exactly one node owns the running background', ownerList.length === 1, `backgroundNodes=[${ownerList.join(', ')}]`);
  checks.check(
    `the owner is the node that started the job (${ownerNode})`,
    ownerList[0] === ownerNode,
    `reported ${ownerList[0]}`,
  );

  // ---- 2. wait for the notice to land in that node's own transcript ----
  // Sampling `/state` alongside the dump also catches the headline P1 condition:
  // "the job finished while its owner turn was still streaming".
  const waitMs = Math.min(cx.flags.timeoutMs, 120000);
  let midTurnWindow = false;
  const landed = await pollUntil(
    async () => {
      const state = await cx.client.state();
      if (state.status === 200 && state.body && state.body.ok !== false) {
        const owners = sessionBackgroundNodes(state.body, sessionId) ?? [];
        if (!owners.includes(ownerNode) && sessionRunningNodes(state.body, sessionId).includes(ownerNode)) {
          midTurnWindow = true;
        }
      }
      const read = readTranscriptNow(cx, sessionId, ownerNode);
      const notice = read ? findSignalNotice(read.parsed) : null;
      if (notice) {
        return { notice };
      }
      // Early bail-out: a notice in ANOTHER node is the removed shape — do not spend
      // the rest of the budget pretending it may still land here.
      const elsewhere = dumpsWithNotice(cx.transcriptDir(sessionId)).filter((hit) => hit.nodeId !== ownerNode);
      return elsewhere.length > 0 ? { elsewhere } : undefined;
    },
    { timeoutMs: waitMs, intervalMs: Math.max(cx.flags.intervalMs, 500) },
  );
  if (landed.ok && landed.value.elsewhere) {
    return signalsWithoutNotice(cx, checks, { name, sessionId, ownerNode, waitMs, elsewhere: landed.value.elsewhere });
  }
  if (!landed.ok) {
    return signalsWithoutNotice(cx, checks, { name, sessionId, ownerNode, waitMs });
  }
  const notice = landed.value.notice;

  // (b) The landing point: a `user` message inside the owner's OWN transcript, at an
  // injection point — never the message that opened a node.
  checks.check(
    "the completion notice lands in the owning node's own transcript",
    true,
    `user message ${notice.index + 1}/${notice.total}: "${notice.text.split('\n')[0].slice(0, 90)}"`,
  );
  checks.check(
    "the notice did not open a node (it is not that node's first message)",
    notice.index > 0,
    `index ${notice.index} of ${notice.total}`,
  );
  if (notice.injected) {
    checks.check(
      "the notice sits at an injection point (after a tool batch, or after the turn's reply)",
      true,
      `preceded by a "${notice.before}" message — ${
        notice.before === 'tool' ? 'tool boundary (mid-turn hook)' : 'the turn had closed (idle injected turn)'
      }`,
    );
  } else {
    checks.subskip(
      "the notice sits at an injection point (after a tool batch, or after the turn's reply)",
      `the message before it has role ${JSON.stringify(notice.before)} — the node's own history ended there (an interrupted or empty turn), which /state cannot distinguish`,
    );
  }
  checks.note(
    midTurnWindow
      ? 'the job finished while its owner turn was still streaming → the notice was eligible for the mid-turn hook (P1)'
      : 'no /state sample caught "job finished while its owner still streamed" — the notice went through the idle injected-turn path (P0)',
  );

  // ---- 3. the delivery created no node, and the owner is still there ----
  const after = await cx.client.state();
  const nodeCountAfter = sessionNodeCount(after.body, sessionId);
  checks.check(
    'the delivery did not add a node to the session',
    Number.isFinite(nodeCountBefore) && nodeCountBefore === nodeCountAfter,
    `nodes ${nodeCountBefore} → ${nodeCountAfter}`,
  );
  // The control plane's only per-node probe is `/navigate` ("no such node: X" ⇒ gone);
  // checking the owner out is harmless here (the harness restores the view focus at the
  // end of the run) and re-affirms the card the notice landed in.
  const nav = await cx.client.navigate({ sessionId, nodeId: ownerNode });
  checks.check(
    `the node that owns the job still exists (${ownerNode})`,
    apiAccepted(nav),
    `POST /navigate → HTTP ${nav.status}${nav.body && nav.body.error ? `: ${nav.body.error}` : ''}`,
  );
  const ownerDump = path.join(cx.transcriptDir(sessionId), `${ownerNode}.jsonl`);
  const ownerHasDump = fs.existsSync(ownerDump);
  checks.check(
    'the reported owner is a main turn node, not a display-only card',
    ownerHasDump,
    `dump ${ownerNode}.jsonl ${ownerHasDump ? 'present' : 'missing'}`,
  );

  // The control plane has no per-node view, so these two stay skips (the facts above
  // are only indirect evidence for them).
  checks.subskip(
    "the job's card is a node of its own (id-level)",
    `missing /state field sessions[].bgNodes (${phaseFor('sessions[].bgNodes')}) — evidenced indirectly by the unchanged node count and the owner id`,
  );
  checks.subskip(
    'the card flips to Delivered when the notice lands',
    `missing /state field sessions[].cardDelivered (${phaseFor('sessions[].cardDelivered')}) — the badge lives in the tree/webview, not on the control plane`,
  );

  const bad = checks.failures().length;
  return suiteResult(
    name,
    bad ? 'FAIL' : 'PASS',
    bad
      ? `${bad} check(s) failed`
      : `the notice for a job of ${sessionId} landed in ${ownerNode} (${notice.boundary ?? notice.before}) without adding a node`,
    checks,
  );
}

/**
 * No notice in the owner's dump. Tell the three reasons apart: it landed in another
 * node (the shape this work removes → FAIL), the model joined/killed the job through
 * a tool (`notifyAgent: false` — that tool result *is* the signal → SKIP), or the job
 * is simply still running (→ SKIP).
 */
async function signalsWithoutNotice(cx, checks, { name, sessionId, ownerNode, waitMs, elsewhere = null }) {
  const landedElsewhere = elsewhere ?? dumpsWithNotice(cx.transcriptDir(sessionId)).filter((hit) => hit.nodeId !== ownerNode);
  if (landedElsewhere.length > 0) {
    checks.check(
      "the completion notice lands in the owning node's own transcript",
      false,
      `found in ${landedElsewhere.map((hit) => hit.nodeId).join(', ')} instead of ${ownerNode} — a notice opened a node (the removed shape)`,
    );
    return suiteResult(
      name,
      'FAIL',
      `the completion notice opened a new node (${landedElsewhere[0].nodeId}) instead of landing in ${ownerNode}`,
      checks,
    );
  }
  const read = readTranscriptNow(cx, sessionId, ownerNode);
  const absorbed = read
    ? ['join_background', 'kill_background'].some((tool) => toolCallsOf(read.parsed, tool).length > 0)
    : false;
  if (absorbed) {
    checks.subskip(
      "the completion notice lands in the owning node's own transcript",
      'the model joined/killed the job through a tool — that tool result IS the signal, so no notice is sent',
    );
    return suiteResult(name, 'SKIP', 'inconclusive: the job was joined/killed through a tool, whose result is the signal', checks);
  }
  const now = await cx.client.state();
  if ((sessionBackgroundNodes(now.body, sessionId) ?? []).includes(ownerNode)) {
    return suiteResult(
      name,
      'SKIP',
      `inconclusive: the background job was still running when the ${Math.round(waitMs / 1000)}s notice budget ran out`,
      checks,
    );
  }
  checks.check(
    "the completion notice lands in the owning node's own transcript",
    false,
    `no user message with the completion wording in ${ownerNode}.jsonl, and the job is no longer running`,
  );
  return suiteResult(name, 'FAIL', `the job finished but its completion notice never reached ${ownerNode}'s transcript`, checks);
}

// ---------------------------------------------------------------------------
// Suite: branch (P3 — two nodes of ONE session stream at once)
// ---------------------------------------------------------------------------

/**
 * P3 acceptance: within ONE session two *different* nodes stream at the same
 * time, and the host keeps them independent (docs/agents/multi-session.md §2.3):
 *
 *   1. `/session/start` opens node N1 and turn 1 runs; poll `/state` until it
 *      settles (a generous wait) so the basis node is idle;
 *   2. two `POST /continue {sessionId, nodeId: N1}` calls back-to-back open N2
 *      and N3 — distinct sibling branches — and both start streaming. This is the
 *      P3 unlock (P2 refuses *any* second run of the session). Waiting for the
 *      basis to settle is deliberate: spec §1's Stop-not-Send rule means a node
 *      that is *itself* running refuses a send, so a branch is opened off an
 *      *idle* node — never off a running one;
 *   3. one `/state` sample lists BOTH running nodes;
 *   4. a concurrent `POST /continue` into a node that is *already streaming* is
 *      refused — the same-node exclusion (one agent per node);
 *   5. each branch's transcript dump carries only its own prompt marker;
 *   6. `POST /stop {sessionId, nodeId: N2}` stops that node **only** — N3 keeps
 *      running — and the stopped node's dump ends `status:"interrupted"`;
 *   7. `POST /stop {sessionId}` leaves the whole session idle.
 *
 * The phase gate is "cannot get two live nodes at all".
 */
async function suiteBranch(cx) {
  const checks = makeChecks();
  const name = 'branch';

  // ---- phase gates (cheap; no turn is spent when the capability is absent) ----
  const probe = await cx.client.state();
  if (!resolveField(probe.body, 'sessions[].runningNodes').found) {
    return suiteResult(
      name,
      'SKIP',
      `missing phase-P3 capability: /state.sessions[].runningNodes (expected in ${phaseFor('sessions[].runningNodes')})`,
      checks,
    );
  }
  // `POST /stop` with ids no live run can own: on P2 the route is unknown (404
  // `unknown route`), on P3 it is a no-op reporting nothing stopped. It can never
  // touch a real run, so it is safe to probe before spending a turn.
  const stopProbe = await cx.client.stop({ sessionId: `harness-test-probe-${cx.runId}`, nodeId: 'harness-test-probe-node' });
  const stopKnown = !(stopProbe.status === 404 && /unknown route/i.test(String(stopProbe.body?.error ?? '')));
  if (!stopKnown) {
    return suiteResult(
      name,
      'SKIP',
      `missing phase-P3 capability: POST /stop is unknown (HTTP ${stopProbe.status}: ${stopProbe.body?.error ?? 'unknown route'})`,
      checks,
    );
  }
  checks.note(`POST /stop is present (probe → HTTP ${stopProbe.status}${stopProbe.body?.error ? `: ${stopProbe.body.error}` : ''})`);

  const markerN1 = `HARNESS-TEST ${cx.runId} BR1`;
  const markerN2 = `HARNESS-TEST ${cx.runId} BR2`;
  const markerN3 = `HARNESS-TEST ${cx.runId} BR3`;
  const markerX = `HARNESS-TEST ${cx.runId} BRX`;

  // ---- 1. one session; turn 1 (node N1) runs, then settles to idle ----
  const started = await startSession(cx, { label: 'BR', prompt: branchStartPrompt(cx.runId) });
  if (started.fail) {
    return suiteResult(name, 'FAIL', started.fail, checks);
  }
  if (started.skip) {
    return suiteResult(name, 'SKIP', started.skip, checks);
  }
  const sessionId = started.sessionId;
  const N1 = started.nodeId;
  checks.check('/session/start reported a first node N1', Boolean(N1), `N1=${N1}`);
  const n1Live = await pollState(cx, (s) => sessionRunningNodes(s, sessionId).includes(N1), Math.min(cx.flags.timeoutMs, 20000));
  checks.check(
    'turn 1 (N1) reports running',
    n1Live.ok,
    `runningNodes=${JSON.stringify(n1Live.state ? sessionRunningNodes(n1Live.state, sessionId) : null)}`,
  );
  if (!n1Live.ok) {
    return suiteResult(
      name,
      'SKIP',
      'inconclusive: node N1 never reported a live run (the first prompt may have finished before the first poll)',
      checks,
    );
  }
  // A branch is opened off an *idle* basis (spec §1 Stop-not-Send: a running node
  // refuses a send), so let N1's own turn drain first — generous, with a heartbeat.
  const settled = await waitForSessionIdle(cx, sessionId, { budgetMs: Math.min(cx.flags.timeoutMs, 180000) });
  if (!settled) {
    return suiteResult(
      name,
      'SKIP',
      'missing phase-P3 capability: node N1 never settled to idle — a second branch cannot be opened while its basis still streams',
      checks,
    );
  }
  checks.check('N1 settled to idle, giving an idle basis to branch from', true);

  // ---- 2. P3 unlock: two /continue calls back-to-back off the idle basis ----
  const c2 = await cx.client.continueFrom({ sessionId, nodeId: N1, message: longRunPrompt(cx.runId, 'BR2', 40000) });
  const c3 = await cx.client.continueFrom({ sessionId, nodeId: N1, message: longRunPrompt(cx.runId, 'BR3', 40000) });
  const N2 = apiAccepted(c2) && typeof c2.body.nodeId === 'string' ? c2.body.nodeId : null;
  const N3 = apiAccepted(c3) && typeof c3.body.nodeId === 'string' ? c3.body.nodeId : null;
  if (!N2 || !N3 || N2 === N1 || N3 === N1 || N2 === N3) {
    return suiteResult(
      name,
      'SKIP',
      'missing phase-P3 capability: two back-to-back branches off idle N1 were not both accepted ' +
        `(HTTP ${c2.status}${c2.body?.error ? `: ${c2.body.error}` : ''} / HTTP ${c3.status}${c3.body?.error ? `: ${c3.body.error}` : ''}) — the host still serialises the session's runs`,
      checks,
    );
  }
  const opened = [N2, N3];
  checks.check('POST /continue (1/2) off idle N1 opened N2', N2 !== N1, `N1 ${N1} → N2 ${N2}`);
  checks.check('POST /continue (2/2) off idle N1 opened N3', N3 !== N1, `N1 ${N1} → N3 ${N3}`);
  checks.check('the two branches are distinct siblings under N1', N2 !== N3, `N2=${N2} N3=${N3}`);

  // ---- 3. one /state sample holds two live nodes ----
  const both = await pollState(
    cx,
    (s) => {
      const rn = sessionRunningNodes(s, sessionId);
      return rn.length >= 2 && opened.every((n) => rn.includes(n));
    },
    Math.min(cx.flags.timeoutMs, 30000),
  );
  const sample = both.state ? sessionRunningNodes(both.state, sessionId) : [];
  if (!both.ok) {
    return suiteResult(
      name,
      'SKIP',
      `missing phase-P3 capability: /state never listed two running nodes of ${sessionId} (last sample ${JSON.stringify(sample)})`,
      checks,
    );
  }
  checks.check('one /state sample lists >= 2 running nodes of this session', sample.length >= 2, `runningNodes=${JSON.stringify(sample)}`);
  checks.check(
    'that sample includes both branch nodes',
    opened.every((n) => sample.includes(n)),
    `opened=${JSON.stringify(opened)} sample=${JSON.stringify(sample)}`,
  );

  // ---- 4. same-node exclusion: a send into a live node is refused ----
  const exclTargets = branchExclusionTargets(sample, opened, N1);
  if (exclTargets.length === 0) {
    checks.subskip('a concurrent POST /continue on an already-running node is refused', 'no live node to target');
  } else {
    let refusedAt = null;
    const tried = [];
    for (const target of exclTargets) {
      const res = await cx.client.continueFrom({ sessionId, nodeId: target, message: longRunPrompt(cx.runId, 'BRX', 1000) });
      if (!apiAccepted(res)) {
        refusedAt = { target, res };
        break;
      }
      tried.push(`${target}→accepted${typeof res.body?.nodeId === 'string' ? `(${res.body.nodeId})` : ''}`);
    }
    checks.check(
      'a concurrent POST /continue on an already-running node is refused (same-node exclusion)',
      refusedAt !== null,
      refusedAt
        ? `refused ${refusedAt.target}: HTTP ${refusedAt.res.status}${refusedAt.res.body?.error ? `: ${refusedAt.res.body.error}` : ''}`
        : `no target refused: ${tried.join(', ')}`,
    );
  }

  // ---- 5. node-scoped stop: the stopped node dies alone ----
  const beforeStop = await cx.client.state();
  const runningNow = sessionRunningNodes(beforeStop.body, sessionId);
  const stopTarget = opened.find((n) => runningNow.includes(n)) ?? null;
  const survivor = runningNow.find((n) => n !== stopTarget) ?? null;
  if (!stopTarget) {
    checks.subskip('POST /stop {sessionId, nodeId} cancels only that node', 'no branch node was still running at stop time');
  } else {
    const stopNode = await cx.client.stop({ sessionId, nodeId: stopTarget });
    checks.check(
      `POST /stop {sessionId, nodeId:${stopTarget}} → ok`,
      apiAccepted(stopNode),
      `HTTP ${stopNode.status} ${JSON.stringify(stopNode.body)}`,
    );
    if (survivor) {
      const still = await pollState(
        cx,
        (s) => {
          const rn = sessionRunningNodes(s, sessionId);
          return !rn.includes(stopTarget) && rn.includes(survivor);
        },
        Math.min(cx.flags.timeoutMs, 20000),
      );
      checks.check(
        `stop is node-scoped: ${survivor} kept running while ${stopTarget} stopped`,
        still.ok,
        `runningNodes=${JSON.stringify(still.state ? sessionRunningNodes(still.state, sessionId) : null)}`,
      );
    } else {
      checks.subskip('stop is node-scoped (a sibling keeps running)', 'no second live node at stop time');
    }
    const read = await readTranscript(cx, sessionId, stopTarget);
    if (read.skip) {
      checks.subskip(`the stopped node ${stopTarget} ends interrupted`, read.skip);
    } else {
      checks.check(
        `the stopped node ${stopTarget} ends status="interrupted"`,
        read.parsed.meta?.status === 'interrupted',
        `status=${read.parsed.meta?.status}`,
      );
    }
  }

  // ---- 6. session-wide stop leaves the session idle ----
  const stopAll = await cx.client.stop({ sessionId });
  checks.check('POST /stop {sessionId} → ok', apiAccepted(stopAll), `HTTP ${stopAll.status} ${JSON.stringify(stopAll.body)}`);
  const idle = await pollState(
    cx,
    (s) => {
      const info = sessionMap(s).get(sessionId);
      return sessionRunningNodes(s, sessionId).length === 0 && (!info || info.running !== true);
    },
    Math.min(cx.flags.timeoutMs, 30000),
  );
  checks.check(
    'after POST /stop {sessionId} the session reports no running node',
    idle.ok,
    `runningNodes=${JSON.stringify(idle.state ? sessionRunningNodes(idle.state, sessionId) : null)}`,
  );

  // ---- 7. transcript isolation (dumps are written when a turn closes) ----
  const branches = [
    { node: N1, marker: markerN1 },
    { node: N2, marker: markerN2 },
    { node: N3, marker: markerN3 },
  ].filter((b) => b.node);
  for (const { node, marker } of branches) {
    const foreign = branches.filter((b) => b.node !== node).map((b) => b.marker).concat([markerX]);
    const read = await readTranscript(cx, sessionId, node);
    ownershipChecks(cx, checks, `branch node ${node}`, read, { sessionId, nodeId: node, marker, foreign });
  }

  const bad = checks.failures().length;
  return suiteResult(
    name,
    bad ? 'FAIL' : 'PASS',
    bad
      ? `${bad} check(s) failed`
      : `session ${sessionId}: ${branches.length} nodes, two streamed at once, node-scoped stop verified`,
    checks,
  );
}

// ---------------------------------------------------------------------------
// Suite: selftest (pure logic — no window required)
// ---------------------------------------------------------------------------

function suiteSelftest(cx) {
  const checks = makeChecks();
  const name = 'selftest';
  /** Assert that `fn` throws (used for the argument/expression guards). */
  const expectThrow = (label, fn) => {
    let threw = false;
    let detail = '';
    try {
      fn();
    } catch (err) {
      threw = true;
      detail = err && err.message ? err.message : String(err);
    }
    checks.check(label, threw, detail);
  };

  // -- parseArgs
  const parsed = parseArgs(['--json', 'health', '--timeout', '42', '--instance', 'pid-1', '--interval', '100']);
  checks.check('parseArgs reads suites and flags', parsed.json && parsed.timeoutSec === 42 && parsed.intervalMs === 100 && parsed.instance === 'pid-1' && parsed.suites.join() === 'health');
  const eq = parseArgs(['--port=9335', '--token=abc', 'all']);
  checks.check('parseArgs accepts --k=v', eq.port === 9335 && eq.token === 'abc' && eq.suites.join() === 'all');
  checks.check('parseArgs defaults', parseArgs(['health']).timeoutSec === DEFAULT_TIMEOUT_SEC && parseArgs(['health']).intervalMs === DEFAULT_INTERVAL_MS);
  checks.check(
    'parseArgs derives a finite timeoutMs budget',
    parseArgs(['health', '--timeout', '7']).timeoutMs === 7000 && parseArgs(['health']).timeoutMs === DEFAULT_TIMEOUT_SEC * 1000,
  );
  checks.check(
    'parseArgs reads --keep / --keep-focus',
    parseArgs(['health', '--keep']).keep === true && parseArgs(['health', '--keep-focus']).keepFocus === true,
  );
  checks.check(
    'parseArgs defaults keep/keep-focus to false',
    parseArgs(['health']).keep === false && parseArgs(['health']).keepFocus === false,
  );
  checks.check(
    'focusRestorePlan: nothing remembered',
    focusRestorePlan(null).action === 'none' && focusRestorePlan({ sessionId: '' }).action === 'none',
  );
  checks.check(
    'focusRestorePlan: restore the remembered session',
    focusRestorePlan({ sessionId: 's1', nodeId: 'n1' }).action === 'restore' &&
      focusRestorePlan({ sessionId: 's1' }).reason.includes('s1'),
  );
  checks.check(
    'focusRestorePlan: --keep-focus skips',
    focusRestorePlan({ sessionId: 's1' }, { keepFocus: true }).action === 'skip',
  );
  expectThrow('parseArgs rejects a missing value', () => parseArgs(['health', '--timeout']));
  expectThrow('parseArgs rejects --port without --token', () => parseArgs(['health', '--port', '9335']));
  expectThrow('parseArgs rejects an unknown option', () => parseArgs(['health', '--nope']));
  checks.check('expandSuites(all) lists every suite', expandSuites(['all']).join() === SUITES.join());
  checks.check('expandSuites de-duplicates in order', expandSuites(['health', 'health', 'selftest']).join() === 'health,selftest');
  expectThrow('expandSuites rejects unknown suites', () => expandSuites(['nope']));
  expectThrow('expandSuites rejects an empty request', () => expandSuites([]));

  // -- pid probe
  checks.check('pidAlive(process.pid) is true', pidAlive(process.pid) === true);
  checks.check('pidAlive(4e9) is false', pidAlive(4_000_000_000) === false);
  checks.check('pidAlive(0) is false', pidAlive(0) === false);

  // -- field resolution
  const sample = { busy: true, sessions: [{ id: 's1', running: true, runningNodes: ['n1', 'n2'] }, { id: 's2', running: false }] };
  checks.check('resolveField finds a top-level field', resolveField(sample, 'busy').values[0] === true);
  checks.check('resolveField walks arrays', resolveField(sample, 'sessions[].id').values.join() === 's1,s2');
  checks.check('resolveField walks nested arrays', resolveField(sample, 'sessions[].runningNodes[].x').found === false);
  checks.check('resolveField reports a missing field', resolveField(sample, 'sessions[].runningBackgrounds').found === false);
  checks.check(
    'resolveField handles a missing container',
    resolveField(sample, 'backgrounds[].nodeId').found === false && resolveField(null, 'busy').found === false,
  );
  expectThrow('resolveField rejects a bad expression', () => resolveField(sample, 'sessions[0].id'));
  checks.check(
    'missingFields + phaseFor name the phase',
    missingFields(sample, ['busy', 'sessions[].running', 'sessions[].runningBackgrounds']).join() === 'sessions[].runningBackgrounds' &&
      phaseFor('sessions[].runningBackgrounds').startsWith('P2'),
  );
  checks.check(
    'pickField prefers the first available alternative',
    pickField(sample, ['sessions[].runningBackgrounds', 'sessions[].running']) === 'sessions[].running',
  );

  // -- discovery selection
  const mk = (file, rec, alive, mtimeMs = 0) => ({ file, rec, alive, mtimeMs });
  const cands = [
    mk('C:/gs/http/pid-9.json', { instanceId: 'pid-9', pid: 9, port: 1, token: 't9', workspace: 'C:/a' }, false, 500),
    mk('C:/gs/http/pid-7.json', { instanceId: 'pid-7', pid: 7, port: 2, token: 't7', workspace: 'C:/b' }, true, 400),
    mk('C:/gs/http/pid-7.json', { instanceId: 'pid-7', pid: 7, port: 2, token: 't7' }, true, 400),
  ];
  checks.check('selectTarget skips dead pids', selectTarget(cands).target.instanceId === 'pid-7');
  checks.check('selectTarget honours --instance', selectTarget(cands, { instance: 'pid-7' }).target.port === 2);
  checks.check('selectTarget fails for an unknown instance', Boolean(selectTarget(cands, { instance: 'pid-404' }).error));
  checks.check(
    'selectTarget honours an explicit file',
    selectTarget(cands, { explicitFile: 'C:/gs/http/pid-7.json' }).target.token === 't7',
  );
  checks.check('selectTarget reports no live window', Boolean(selectTarget([cands[0]]).error));
  checks.check('selectTarget survives an empty candidate list', Boolean(selectTarget([]).error));
  checks.check('selectTarget rejects an unknown explicit file', Boolean(selectTarget(cands, { explicitFile: 'C:/gs/http/x.json' }).error));

  // -- global storage + transcript root
  checks.check(
    'globalStorageDirs follows $APPDATA',
    globalStorageDirs({ APPDATA: 'C:/Users/u/AppData/Roaming' }).includes(
      path.join('C:/Users/u/AppData/Roaming', 'Code', 'User', 'globalStorage', EXT_ID),
    ),
  );
  checks.check(
    'globalStorageDirs honours the env override',
    globalStorageDirs({ HARNESS_GLOBAL_STORAGE: 'D:/gs' }).join() === 'D:/gs',
  );
  checks.check(
    'transcriptRootFor defaults to <globalStorage>/transcripts',
    transcriptRootFor({ globalStorage: 'C:/gs' }) === path.join('C:/gs', 'transcripts'),
  );
  checks.check(
    'transcriptRootFor resolves a relative setting against the workspace',
    transcriptRootFor({ setting: 'dumps', globalStorage: 'C:/gs', workspace: 'D:/repo' }) === path.resolve('D:/repo/dumps'),
  );
  checks.check(
    'transcriptRootFor resolves a relative setting against the scratch root',
    transcriptRootFor({ setting: 'dumps', globalStorage: 'C:/gs' }) === path.resolve('C:/gs/no-workspace/dumps'),
  );
  checks.check(
    'transcriptRootFor keeps an absolute setting',
    transcriptRootFor({ setting: 'D:/tx', globalStorage: 'C:/gs' }) === 'D:/tx',
  );
  checks.check('transcriptRootFor falls back to tmpdir', transcriptRootFor({ tmpDir: 'C:/tmp' }) === path.join('C:/tmp', 'spinney-transcripts'));

  // -- transcript parsing
  const jsonl =
    JSON.stringify({ type: 'meta', kind: 'session', sessionId: 's1', nodeId: 'n1', prompt: 'hello MARK' }) +
    '\n' +
    JSON.stringify({ type: 'message', index: 0, role: 'user', content: 'hello MARK' }) +
    '\n' +
    JSON.stringify({ type: 'message', index: 1, role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'exec_command', arguments: '{"timeout_behavior":"start_in_background"}' } }] }) +
    '\n';
  const t = parseTranscriptJsonl(jsonl);
  checks.check('parseTranscriptJsonl reads meta + messages', t.meta.nodeId === 'n1' && t.messages.length === 2 && t.lines === 3);
  checks.check('parseTranscriptJsonl tolerates an empty file', parseTranscriptJsonl('').meta === null);
  checks.check('parseTranscriptJsonl skips broken lines', parseTranscriptJsonl('{oops}\nnot json\n').messages.length === 0);
  checks.check('userTexts finds the prompt', userTexts(t).some((x) => x.includes('MARK')));
  checks.check('transcriptText spans meta and messages', transcriptText(t).includes('hello MARK') && transcriptText(t).includes('n1'));
  checks.check(
    'toolCallsOf parses arguments',
    toolCallsOf(t, 'exec_command')[0]?.args.timeout_behavior === 'start_in_background' &&
      toolCallsOf(t, 'read_file').length === 0,
  );
  checks.check(
    'flattenContent handles strings, parts and junk',
    flattenContent('a') === 'a' &&
      flattenContent([{ type: 'text', text: 'b' }, { type: 'file', file_id: 'f' }, { type: 'image_url' }]).includes('b') &&
      flattenContent(undefined) === '',
  );

  // -- completion notices (the `signals` suite)
  const noticeText = 'Background command `node -e "setTimeout(()=>{},6000)"` (id 1) finished with exit code 0.';
  const sigJsonl = (messages) =>
    [
      JSON.stringify({ type: 'meta', kind: 'session', sessionId: 's1', nodeId: 'n1' }),
      ...messages.map((m) => JSON.stringify(m)),
    ].join('\n') + '\n';
  const sigCall = {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'c1', function: { name: 'exec_command', arguments: '{"timeout_behavior":"start_in_background"}' } }],
  };
  const mid = findSignalNotice(
    parseTranscriptJsonl(
      sigJsonl([
        { role: 'user', content: 'HARNESS-TEST RID SIG: a timing check' },
        sigCall,
        { role: 'tool', tool_call_id: 'c1', content: '[command started in background: id 1]' },
        { role: 'user', content: noticeText },
        { role: 'assistant', content: 'DONE' },
      ]),
    ),
  );
  checks.check(
    'findSignalNotice finds a mid-turn notice at the tool boundary',
    mid !== null && mid.index === 3 && mid.total === 5 && mid.before === 'tool' && mid.boundary === 'tool batch' && mid.injected === true,
  );
  const idle = findSignalNotice(
    parseTranscriptJsonl(
      sigJsonl([
        { role: 'user', content: 'HARNESS-TEST RID SIG: a timing check' },
        { role: 'assistant', content: 'started id 1' },
        { role: 'user', content: noticeText },
        { role: 'assistant', content: 'ok' },
      ]),
    ),
  );
  checks.check(
    'findSignalNotice accepts the closed-turn shape (idle injected turn)',
    idle !== null && idle.before === 'assistant' && idle.boundary === 'turn closed' && idle.injected === true,
  );
  const opened = findSignalNotice(
    parseTranscriptJsonl(sigJsonl([{ role: 'user', content: noticeText }, { role: 'assistant', content: 'ok' }])),
  );
  checks.check(
    'findSignalNotice flags a notice that opened a node (the removed shape)',
    opened !== null && opened.index === 0 && opened.before === null && opened.injected === false && opened.boundary === null,
  );
  checks.check(
    'findSignalNotice ignores tool output, other transcripts and junk',
    findSignalNotice(parseTranscriptJsonl(sigJsonl([{ role: 'tool', tool_call_id: 'c1', content: '[command started in background: id 1]' }]))) === null &&
      findSignalNotice(t) === null &&
      findSignalNotice(null) === null,
  );
  checks.check(
    'the harness never sends the host completion wording in its own prompts',
    SIGNAL_FRAGMENTS.every((fragment) => noticeText.includes(fragment)) &&
      !signalPrompt('RID').includes('Background command') &&
      !signalPrompt('RID').includes('finished with exit code'),
  );
  checks.check(
    'signalPrompt drives a background job then two foreground rounds',
    signalPrompt('RID').includes('HARNESS-TEST RID SIG') &&
      signalPrompt('RID').includes('"timeout_behavior":"start_in_background"') &&
      signalPrompt('RID').includes('6000') &&
      signalPrompt('RID', { jobMs: 1500 }).includes('1500'),
  );
  checks.check(
    'sessionNodeCount reads the per-session node count',
    sessionNodeCount({ sessions: [{ id: 's1', nodes: 3 }, { id: 's2' }] }, 's1') === 3 &&
      sessionNodeCount({ sessions: [{ id: 's2' }] }, 's2') === null &&
      sessionNodeCount({}, 'sx') === null,
  );
  checks.check(
    'sessionBackgroundNodes tells "absent" from "empty"',
    sessionBackgroundNodes({ sessions: [{ id: 's1', backgroundNodes: ['n1'] }, { id: 's2', backgroundNodes: [] }] }, 's1').join() === 'n1' &&
      sessionBackgroundNodes({ sessions: [{ id: 's2', backgroundNodes: [] }] }, 's2').length === 0 &&
      sessionBackgroundNodes({ sessions: [{ id: 's2' }] }, 's2') === null &&
      sessionBackgroundNodes({}, 'sx') === null,
  );
  checks.check(
    'signals is a registered suite',
    SUITES.includes('signals') && expandSuites(['signals']).join() === 'signals',
  );

  // -- poll helpers
  checks.check('makeRunId produces a marker prefix', /^harness-[a-z0-9]+-[a-z0-9]+$/.test(makeRunId(1, () => 0.5)));
  checks.check('sleepCmd builds the probe command', sleepCmd(15000) === 'node -e "setTimeout(()=>{},15000)"');
  checks.check(
    'longRunPrompt / backgroundPrompt carry the marker + tool args',
    longRunPrompt('RID', 'A').includes('HARNESS-TEST RID A') &&
      longRunPrompt('RID', 'A').includes('exec_command') &&
      backgroundPrompt('RID').includes('"timeout_behavior":"start_in_background"'),
  );

  // -- branch helpers
  const bsample = { sessions: [{ id: 's1', runningNodes: ['n1', 'n2'] }, { id: 's2', runningNodes: [] }] };
  checks.check("sessionRunningNodes reads a session's live nodes", sessionRunningNodes(bsample, 's1').join() === 'n1,n2');
  checks.check(
    'sessionRunningNodes is [] for an idle / missing session',
    sessionRunningNodes(bsample, 's2').join() === '' && sessionRunningNodes(bsample, 'nope').join() === '',
  );
  checks.check(
    'stateShowsRun tolerates either live field',
    stateShowsRun({ sessions: [{ id: 's1', running: true }, { id: 's2', runningNodes: ['n1'] }, { id: 's3', running: false, runningNodes: [] }] }, 's1') === true &&
      stateShowsRun({ sessions: [{ id: 's2', runningNodes: ['n1'] }] }, 's2') === true &&
      stateShowsRun({ sessions: [{ id: 's3', running: false, runningNodes: [] }] }, 's3') === false &&
      stateShowsRun({ sessions: [] }, 's9') === false,
  );
  checks.check(
    'apiAccepted accepts 200 without ok:false',
    apiAccepted({ status: 200, body: { ok: true, nodeId: 'x' } }) && apiAccepted({ status: 200, body: {} }),
  );
  checks.check(
    'apiAccepted rejects 409 / ok:false / 202 queued',
    !apiAccepted({ status: 409, body: { ok: false } }) &&
      !apiAccepted({ status: 200, body: { ok: false } }) &&
      !apiAccepted({ status: 202, body: { queued: true } }),
  );
  checks.check(
    'branchExclusionTargets prefers a live node this suite opened, then the basis',
    branchExclusionTargets(['n1', 'n2', 'n3'], ['n2', 'n9'], 'n1').join() === 'n2,n1',
  );
  checks.check(
    'branchExclusionTargets covers the basis even when it is the only live node',
    branchExclusionTargets(['n1'], [], 'n1').join() === 'n1',
  );
  checks.check(
    'branchExclusionTargets is [] when nothing runs',
    branchExclusionTargets([], ['n1'], 'n1').join() === '' && branchExclusionTargets(null, null, null).join() === '',
  );
  checks.check(
    'longRunPrompt honours a custom sleep',
    longRunPrompt('RID', 'BR', 30000).includes('30000') && longRunPrompt('RID', 'BR').includes('15000'),
  );
  checks.check(
    'branchStartPrompt is a short settle task that replies DONE',
    branchStartPrompt('RID').includes('HARNESS-TEST RID BR1') &&
      branchStartPrompt('RID').includes('12000') &&
      branchStartPrompt('RID').includes('DONE'),
  );

  // -- check bookkeeping
  const probeChecks = makeChecks();
  probeChecks.check('ok', true);
  probeChecks.check('bad', false, 'why');
  probeChecks.note('note');
  probeChecks.subskip('skipped', 'later phase');
  checks.check(
    'makeChecks counts failures only for failed checks',
    probeChecks.failures().length === 1 && probeChecks.items.length === 4 && probeChecks.items[0].status === 'ok',
  );
  checks.check('suiteResult carries checks', suiteResult('x', 'PASS', 'm', probeChecks).checks.length === 4);

  return suiteResult(name, checks.failures().length ? 'FAIL' : 'PASS', 'pure-logic helpers', checks);
}

/** Async half of the selftest (kept separate so its awaits are explicit). */
async function selftestAsync(cx, result) {
  const checks = makeChecks();
  const counter = { n: 0 };
  const fast = await pollUntil(
    async () => {
      counter.n += 1;
      return counter.n >= 3 ? 'done' : undefined;
    },
    { timeoutMs: 1000, intervalMs: 1, sleepFn: async () => {} },
  );
  checks.check('pollUntil resolves on a defined value', fast.ok && fast.value === 'done' && fast.polls === 3);
  const timeout = await pollUntil(async () => undefined, { timeoutMs: 0, intervalMs: 1, sleepFn: async () => {} });
  checks.check('pollUntil reports a timeout', timeout.ok === false && typeof timeout.polls === 'number');
  const noBudget = await pollUntil(async () => undefined, { intervalMs: 1, sleepFn: async () => {} });
  checks.check('pollUntil fails fast on a missing budget (no spin)', noBudget.ok === false);
  const capped = await pollUntil(async () => false, { timeoutMs: 0, intervalMs: 1, sleepFn: async () => {} });
  checks.check('pollUntil treats false as "keep polling"', capped.ok === false);
  const file = path.join(os.tmpdir(), `harness-test-selftest-${process.pid}.tmp`);
  fs.writeFileSync(file, 'x');
  const found = await waitForFile(file, 1000, 5);
  const missing = await waitForFile(`${file}.nope`, 10, 5);
  fs.rmSync(file, { force: true });
  checks.check('waitForFile finds an existing file and times out otherwise', found === file && missing === null);

  // `readTranscriptNow` / `dumpsWithNotice` over a real (temporary) session folder.
  const sigDir = path.join(os.tmpdir(), `harness-test-signals-${process.pid}`);
  fs.mkdirSync(sigDir, { recursive: true });
  const sigLines = (nodeId, body) =>
    [JSON.stringify({ type: 'meta', kind: 'session', nodeId }), ...body.map((m) => JSON.stringify(m))].join('\n') + '\n';
  const sigNotice = 'Background command `cmd` (id 1) finished with exit code 0.';
  fs.writeFileSync(
    path.join(sigDir, 'n1.jsonl'),
    sigLines('n1', [{ role: 'user', content: 'prompt' }, { role: 'user', content: sigNotice }]),
  );
  fs.writeFileSync(path.join(sigDir, 'n2.jsonl'), sigLines('n2', [{ role: 'user', content: 'no notice here' }]));
  const readBack = readTranscriptNow({ transcriptDir: () => sigDir }, 's1', 'n1');
  const notThere = readTranscriptNow({ transcriptDir: () => sigDir }, 's1', 'nope');
  const carrying = dumpsWithNotice(sigDir);
  fs.rmSync(sigDir, { recursive: true, force: true });
  checks.check(
    'readTranscriptNow parses a dump and tolerates a missing one',
    readBack !== null && readBack.parsed.meta.nodeId === 'n1' && readBack.parsed.messages.length === 2 && notThere === null,
  );
  checks.check(
    'dumpsWithNotice names only the dumps carrying a notice',
    carrying.length === 1 && carrying[0].nodeId === 'n1' && carrying[0].notice.index === 1,
  );
  checks.check('dumpsWithNotice tolerates a missing folder', dumpsWithNotice(path.join(sigDir, 'gone')).length === 0);
  checks.check('timeoutSignal is available on this Node', typeof timeoutSignal === 'function');
  checks.check(
    'selectTarget output feeds the client',
    makeClient({ port: 1, token: 'x' }).base === 'http://127.0.0.1:1',
  );
  checks.check('the client never exposes /wait-for-finish', !Object.keys(makeClient({ port: 1, token: 'x' })).includes('waitForFinish'));
  const failures = checks.failures();
  for (const item of checks.items) {
    result.checks.push(item);
  }
  if (failures.length) {
    result.status = 'FAIL';
    result.message = `${failures.length} async check(s) failed`;
  }
  return result;
}

async function suiteSelftestAll(cx) {
  const result = suiteSelftest(cx);
  await selftestAsync(cx, result);
  if (result.status === 'PASS') {
    result.message = `${result.checks.length} pure-logic checks`;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const SUITE_FNS = {
  health: suiteHealth,
  sessions: suiteSessions,
  concurrency: suiteConcurrency,
  navigation: suiteNavigation,
  background: suiteBackground,
  signals: suiteSignals,
  branch: suiteBranch,
  selftest: suiteSelftestAll,
};

function resolveTarget(flags, env = process.env) {
  if (flags.port !== null) {
    return {
      target: {
        instanceId: flags.instance ?? null,
        pid: null,
        port: flags.port,
        token: flags.token,
        workspace: null,
        version: '',
        file: null,
        how: '--port/--token',
      },
    };
  }
  const candidates = readCandidates(flags, env);
  const picked = selectTarget(candidates, { instance: flags.instance, explicitFile: flags.discovery });
  if (picked.error) {
    const known = candidates
      .map((c) => `${c.rec.instanceId ?? path.basename(c.file)}${c.alive ? '' : ' (dead pid)'}`)
      .join(', ');
    return { error: `${picked.error}${known ? ` [discovered: ${known}]` : ''}` };
  }
  return picked;
}

function printSuite(cx, result) {
  cx.emit('');
  cx.emit(`-- ${result.name} ${'-'.repeat(Math.max(1, 56 - result.name.length))}`);
  for (const item of result.checks) {
    const mark = item.status === 'ok' ? 'ok  ' : item.status === 'fail' ? 'FAIL' : item.status === 'skip' ? 'skip' : '    ';
    cx.emit(`  [${mark}] ${item.label}${item.detail ? `  (${item.detail})` : ''}`);
  }
  cx.emit(`${result.status} ${result.name}: ${result.message}`);
}

async function main(argv) {
  let flags;
  try {
    flags = parseArgs(argv);
  } catch (err) {
    console.error(`harness-test: ${err && err.message ? err.message : String(err)}`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (flags.help) {
    console.log(USAGE);
    return;
  }
  let names;
  try {
    names = expandSuites(flags.suites);
  } catch (err) {
    console.error(`harness-test: ${err && err.message ? err.message : String(err)}`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const out = {
    tool: 'harness-test',
    runId: makeRunId(),
    target: null,
    transcriptRoot: null,
    focus: null,
    suites: [],
    created: [],
    notes: [],
    summary: { pass: 0, fail: 0, skip: 0 },
  };
  const emit = (line) => {
    if (!flags.json) {
      console.log(line);
    }
  };

  const cx = {
    flags,
    runId: out.runId,
    target: null,
    client: null,
    transcriptRoot: null,
    transcriptDir: (sessionId) => path.join(cx.transcriptRoot, sessionId),
    saveSessionTranscripts: true,
    ctx: { created: [], two: null },
    currentSuite: null,
    focus: null,
    emit,
    note(line) {
      out.notes.push(line);
      emit(`note: ${line}`);
    },
  };

  const needsWindow = names.some((n) => n !== 'selftest');
  if (needsWindow) {
    const picked = resolveTarget(flags);
    if (picked.error || !picked.target) {
      console.error(`harness-test: ${picked.error ?? 'no control plane resolved'}`);
      console.error('hint: pass --instance <pid-NNNN>, --discovery <file>, or --port <n> --token <t>.');
      process.exitCode = 3;
      return;
    }
    cx.target = picked.target;
    out.target = picked.target;
    cx.client = makeClient(picked.target);
    try {
      const health = await cx.client.health();
      if (health.status !== 200) {
        console.error(`harness-test: ${cx.client.base}/health answered ${health.status} for ${picked.target.instanceId}`);
        process.exitCode = 3;
        return;
      }
    } catch (err) {
      console.error(`harness-test: cannot reach ${cx.client.base} (${err && err.message ? err.message : String(err)})`);
      process.exitCode = 3;
      return;
    }
    const env = process.env;
    const setting = readSetting('spinney.subAgentTranscriptDir', {
      workspace: picked.target.workspace,
      env,
    });
    cx.saveSessionTranscripts = readSetting('spinney.saveSessionTranscripts', {
      workspace: picked.target.workspace,
      env,
    }) !== false;
    const globalStorage = flags.globalStorage ?? (() => {
      const dirs = globalStorageDirs(env);
      for (const dir of dirs) {
        if (fs.existsSync(path.join(dir, 'http'))) {
          return dir;
        }
      }
      return dirs[0] ?? null;
    })();
    cx.transcriptRoot = transcriptRootFor({
      override: flags.transcriptRoot,
      setting: typeof setting === 'string' ? setting : '',
      globalStorage,
      workspace: picked.target.workspace,
    });
    out.transcriptRoot = cx.transcriptRoot;

    // Remember what the window is focused on, so the run can put it back: every
    // suite below activates a test session, and a supervisor that re-reads the
    // active session into its next /continue would otherwise never resume this
    // conversation.
    try {
      const initial = await cx.client.state();
      const sessionId = typeof initial.body?.sessionId === 'string' ? initial.body.sessionId : null;
      if (sessionId) {
        const nodeId = typeof initial.body.activeNodeId === 'string' ? initial.body.activeNodeId : null;
        cx.focus = { sessionId, nodeId };
        emit(`focus    : started on session ${sessionId}${nodeId ? ` (node ${nodeId})` : ''} — will be restored`);
      } else {
        const plan = focusRestorePlan(null);
        out.focus = { remembered: null, action: 'none', reason: plan.reason };
        emit(`focus    : ${plan.reason} — nothing to restore`);
      }
    } catch (err) {
      const reason = `could not read /state (${err && err.message ? err.message : String(err)}) — nothing to restore`;
      out.focus = { remembered: null, action: 'none', reason };
      emit(`focus    : ${reason}`);
    }
  }

  emit('harness-test — control-plane acceptance for docs/agents/multi-session.md');
  emit(`run id   : ${out.runId}`);
  emit(`suites   : ${names.join(', ')}`);
  if (cx.target) {
    emit(`target   : ${cx.target.instanceId ?? '(unknown instance)'}  http://127.0.0.1:${cx.target.port}  (${cx.target.how})`);
    emit(
      `window   : workspace=${cx.target.workspace ?? '(none)'}  pid=${cx.target.pid ?? '?'}  version=${cx.target.version || '?'}` +
        (cx.target.file ? `\n           discovery=${cx.target.file}` : ''),
    );
    emit(`transcripts: ${cx.transcriptRoot}${cx.saveSessionTranscripts ? '' : '  (saveSessionTranscripts=off)'}`);
  }
  emit(`budget   : ${flags.timeoutSec}s per suite, /state poll every ${flags.intervalMs}ms`);

  const started = Date.now();
  for (const suiteName of names) {
    cx.currentSuite = suiteName;
    let result;
    const t0 = Date.now();
    try {
      result = await SUITE_FNS[suiteName](cx);
    } catch (err) {
      const checks = makeChecks();
      checks.check(`${suiteName} ran without throwing`, false, err && err.stack ? err.stack.split('\n')[0] : String(err));
      result = suiteResult(suiteName, 'FAIL', `threw: ${err && err.message ? err.message : String(err)}`, checks);
    }
    result.name = suiteName;
    result.ms = Date.now() - t0;
    out.suites.push(result);
    if (result.status === 'PASS') {
      out.summary.pass += 1;
    } else if (result.status === 'FAIL') {
      out.summary.fail += 1;
    } else {
      out.summary.skip += 1;
    }
    printSuite(cx, result);
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  // Put the window's focus back (unless --keep-focus): `/session/start` with a
  // sessionId and no prompt is the host's "jump to that session" form.
  const focusPlan = focusRestorePlan(cx.focus, { keepFocus: flags.keepFocus });
  out.focus = { remembered: cx.focus?.sessionId ?? null, action: focusPlan.action, reason: focusPlan.reason };
  if (focusPlan.action === 'restore') {
    let restored = false;
    let how = 'POST /session/start {sessionId}';
    let why = '';
    const already =
      (await (async () => {
        try {
          const now = await cx.client.state();
          const sameSession = now.body?.sessionId === cx.focus.sessionId;
          const sameNode = !cx.focus.nodeId || now.body?.activeNodeId === cx.focus.nodeId;
          return sameSession && sameNode;
        } catch {
          return false;
        }
      })());
    if (already) {
      out.focus.action = 'already';
      out.focus.restored = true;
      emit(`focus    : already on session ${cx.focus.sessionId} — nothing to restore`);
    } else {
      try {
        const res = await cx.client.startSession({ sessionId: cx.focus.sessionId });
        restored = res.status === 200 && res.body.ok !== false;
        why = restored ? '' : `HTTP ${res.status}${res.body.error ? `: ${res.body.error}` : ''}`;
      } catch (err) {
        why = err && err.message ? err.message : String(err);
      }
      if (!restored && cx.focus.nodeId) {
        // Fallback: the jump may be refused while a turn runs, but checking a node
        // out is allowed at any time (spec §3.2 `checkout`).
        try {
          const nav = await cx.client.navigate({ sessionId: cx.focus.sessionId, nodeId: cx.focus.nodeId });
          restored = nav.status === 200 && nav.body.ok !== false;
          how = 'POST /navigate {sessionId, nodeId}';
          if (!restored) {
            why = `${why}; /navigate → HTTP ${nav.status}${nav.body.error ? `: ${nav.body.error}` : ''}`;
          }
        } catch (err) {
          why = `${why}; ${err && err.message ? err.message : String(err)}`;
        }
      }
      out.focus.restored = restored;
      out.focus.how = restored ? how : null;
      if (restored) {
        emit(`focus    : restored session ${cx.focus.sessionId} via ${how}`);
      } else {
        const line = `focus    : could NOT restore session ${cx.focus.sessionId} (${why})`;
        emit(line);
        cx.note(`${line} — the supervisor may capture a test session as the active one`);
      }
    }
  } else if (focusPlan.action === 'skip') {
    out.focus.restored = null;
    emit(`focus    : ${focusPlan.reason}`);
  }

  out.created = cx.ctx.created;
  emit('');
  emit(`created sessions: ${cx.ctx.created.length}`);
  for (const created of cx.ctx.created) {
    emit(`  ${created.id}  node=${created.nodeId ?? '?'}  "${created.title}"  (${created.suite ?? '?'})`);
  }
  if (cx.ctx.created.length > 0 && !flags.keep) {
    const ids = cx.ctx.created.map((c) => c.id).join(', ');
    cx.note(
      `the control plane exposes no delete-session route, so the harness-test sessions above are left in place: ${ids} ` +
        '(delete them in the Sessions view, or pass --keep to silence this note)',
    );
  }
  emit('');
  emit(
    `summary: PASS ${out.summary.pass}  FAIL ${out.summary.fail}  SKIP ${out.summary.skip}   ` +
      `(${out.suites.length} suite(s) in ${elapsed}s)`,
  );
  if (out.summary.skip > 0) {
    emit('skips are phase gates (see docs/agents/multi-session.md §5), not passes');
  }

  if (flags.json) {
    console.log(JSON.stringify(out, null, 2));
  }
  process.exitCode = out.summary.fail > 0 ? 1 : 0;
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`harness-test: unexpected failure: ${err && err.stack ? err.stack : String(err)}`);
  process.exitCode = 1;
});
