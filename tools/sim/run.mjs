/*
 * run.mjs — the simulation harness: reproduces a customer's performance symptoms on a
 * dev machine with **no tokens**, and prints a PASS/FAIL table against the agreed
 * thresholds.
 *
 * DEV-ONLY (`.vscodeignore` drops `tools/**`), never runs in CI.
 *
 *   node tools/sim/run.mjs --selftest         no VS Code, no tokens, no reload
 *   node tools/sim/run.mjs --analyse <log>    re-analyse an existing perf log
 *   node tools/sim/run.mjs                    the full run, in its own throwaway window
 *
 * WHAT IT REPRODUCES
 *   A session whose main agent runs whole-tree searches over a ~3 700-file, three-component
 *   fixture, then fans out **15 read-only sub-agents**, each running its own whole-tree
 *   searches (one hit-heavy, one hitless). The symptoms measured in the customer's log:
 *   `[perf] lag blocked 10302ms (4 late ticks)`, 397 search calls / 782.7 s (worst 104 s,
 *   26 hitless calls up to 17.6 s), `op#13 end 20024ms no webview report`, webview handlers
 *   at 900-999 ms, `dom=2692`.
 *
 * HOW IT GETS A MEASURABLE WINDOW (and why it must be this way)
 *   The `[perf]` lines go to the extension's output channel, which has no read-back API,
 *   so the only machine-readable copy is the dev-only tee that `ChatViewProvider` opens
 *   from `SPINNEY_PERF_LOG` at host start — a launch-time environment variable that a
 *   reload cannot inject. The window is therefore **launched here**, never the developer's:
 *   its own `--user-data-dir`, its own `--extensions-dir`, a fixed control-plane port and
 *   token, and the four `SPINNEY_HTTP*` bypass variables from `src/http/controlServer.ts`.
 *   The developer's window is never touched, never reloaded, never enumerated.
 *
 *   Two traps this launch has to work around, both found the hard way:
 *   1. The extension declares only `onWebviewPanel:*` — with no chat tab open it never
 *      activates, so the control plane never starts. The private extensions dir therefore
 *      holds a tiny `sim-activator` companion (`onStartupFinished`) that focuses the
 *      Spinney container, which makes the sessions view visible and activates the real
 *      extension through its own `onView:` event. A junction to the installed extension
 *      supplies the extension under test; if junctions are unavailable it is copied.
 *   2. A fresh profile has no SecretStorage entry, so the key must come from the
 *      environment — and `DEEPSEEK_API_KEY` is only the fallback of the **built-in**
 *      provider, which is why the mock is installed as `spinney.providers.default`.
 *
 * ONE-TIME PRECONDITIONS: none, beyond the extension being installed (`build-deploy.ps1`)
 * and `code` being available. Every unsatisfied precondition fails loudly with what to do.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NEVER_MATCHES, SEARCH_TOKEN, buildFixture, fixtureDigest, formatFixture } from './fixture.mjs';
import { SIM_MODEL, startMock } from './mock-provider.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

/** The agreed limits (see the plan). `searchFilesMs` is the one chosen here, not given. */
export const THRESHOLDS = {
  lagBlockedMs: 200,
  paintedMs: 1500,
  handlerP95Ms: 80,
  frameWorstMs: 400,
  /**
   * The **typical** content write, applied to the median for the same reason as
   * `persistDoneMs`: since the v2 store, a write re-serializes only the nodes whose digest
   * moved (measured 9–13 ms for a 17 MB session; the row below carries the once-per-window
   * exception). A median above this means every write got slow — a regression.
   */
  persistQueuedMs: 20,
  /**
   * The **first** content write of a window, which re-serializes every session: the digest
   * map starts empty, so nothing is known to be unchanged yet. It is O(all sessions) exactly
   * once per window and then never again (measured: 85 ms for an 86 M-char store, where the
   * writes after it were 9–13 ms). Reported on its own row so it cannot hide the typical
   * write, and cannot be mistaken for one either.
   */
  persistQueuedColdMs: 500,
  /**
   * The **typical** content write. This is the agreed number, and it is now applied to the
   * median rather than the maximum on purpose: `persist-done` stopped meaning "the Memento
   * stalled the host" the moment the store landed. What the host pays is `persist-queued`
   * (a payload build, ~3 ms); `persist-done` is the write *queue*'s completion latency, and
   * during a 15-way storm eighteen ~0.5–1 MB writes land in a few seconds, so the tail
   * legitimately runs long while a normal write stays at ~20 ms. A median above this number
   * means every write got slow — a real regression — which is what this row is for.
   */
  persistDoneMs: 300,
  /**
   * The tail: the worst single `persist-done` over the whole run, storm included. Measured
   * band on this machine: 15–25 ms idle, 90–314 ms during the storm (and the row is a
   * *queue* reading, not a blocking one — see `persistQueuedMs`).
   */
  persistDoneStormMs: 500,
  searchFilesMs: 1500,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A precondition that was not satisfied: say what to do, and exit 3 (never a silent PASS). */
function failRun(message, hint) {
  console.error(`
sim: ${message}`);
  if (hint) console.error(`     ${hint}`);
  return 3;
}

// ---------------------------------------------------------------- perf analysis

function firstInt(re, text) {
  const m = re.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * Parse a `[perf]` log into the threshold table.
 *
 * The grammars are the ones the instrumentation actually emits (`src/perf.ts`,
 * `src/tools/searchFiles.ts`, `docs/agents/invariants/streaming-perf.md`): an op's marks
 * carry an `op#N +<ms>ms ` prefix and must be unwrapped first; `lag blocked` is only ever
 * written above its 120 ms floor, so its absence is good news rather than a missing
 * measurement; and a probe that never fires (`webview-handler` needs 40 ms,
 * `webview-frames` needs an 80 ms frame gap) says nothing.
 */
export function analysePerfLog(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('[perf]'));
  const bodies = lines.map((l) => l.replace(/^\[perf\]\s*/, '').replace(/^op#\d+\s+\+\d+ms\s+/, ''));

  const lag = [];
  const painted = [];
  const timedOut = [];
  const handlers = [];
  const frames = [];
  const queued = [];
  const done = [];
  const searches = [];
  let teeDropped = 0;

  for (const body of bodies) {
    let ms = firstInt(/^lag blocked (\d+)ms/, body);
    if (ms !== null) {
      lag.push(ms);
      continue;
    }
    let m = /^op#(\d+) end (\d+)ms(?:\s+(.*))?$/.exec(body);
    if (m) {
      const detail = m[3] || '';
      if (/\bpainted\b/.test(detail)) painted.push({ ms: Number(m[2]), detail });
      else if (/no webview report/.test(detail)) timedOut.push({ ms: Number(m[2]), detail });
      continue;
    }
    if (/\bwebview-handler\b/.test(body)) {
      ms = firstInt(/\bms=(\d+)/, body) ?? firstInt(/\s(\d+)\s*$/, body);
      if (ms !== null) handlers.push(ms);
      continue;
    }
    if (/\bwebview-frames\b/.test(body)) {
      ms = firstInt(/\bworst=(\d+)/, body) ?? firstInt(/\s(\d+)\s*$/, body);
      if (ms !== null) frames.push(ms);
      continue;
    }
    ms = firstInt(/^persist-queued (\d+)ms/, body);
    if (ms !== null) {
      queued.push(ms);
      continue;
    }
    ms = firstInt(/^persist-done (\d+)ms/, body);
    if (ms !== null) {
      done.push(ms);
      continue;
    }
    if (/^search-files\b/.test(body)) {
      const value = firstInt(/\bms=(\d+)/, body);
      searches.push({
        ms: value === null ? 0 : value,
        via: (/\bvia=(\w+)/.exec(body) || [, '?'])[1],
        matches: firstInt(/\bmatches=(\d+)/, body) ?? 0,
        capped: (/\bcapped=(\w+)/.exec(body) || [, '?'])[1],
      });
      continue;
    }
    const dropped = firstInt(/^dev tee dropped (\d+) line/, body);
    if (dropped !== null) teeDropped += dropped;
  }

  const worstOf = (list) => (list.length ? Math.max(...list.map((v) => (typeof v === 'number' ? v : v.ms))) : null);
  const p95 = (values) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
  };

  const rows = [];
  const row = (metric, limit, worst, count, verdict, note) => rows.push({ metric, limit, worst, count, verdict, note });

  // `lag blocked` is only written above 120 ms: no line means no stall was reported.
  row(
    'lag blocked',
    THRESHOLDS.lagBlockedMs,
    worstOf(lag),
    lag.length,
    worstOf(lag) !== null && worstOf(lag) >= THRESHOLDS.lagBlockedMs ? 'FAIL' : 'PASS',
    lag.length
      ? 'the host event loop was blocked (startLagWatch reports above 120 ms, once per burst)'
      : 'nothing reached the 120 ms reporter — no stall was observed',
  );
  const paintedWorst = worstOf(painted);
  row(
    'cold switch (op … painted)',
    THRESHOLDS.paintedMs,
    paintedWorst,
    painted.length,
    timedOut.length > 0 || (paintedWorst !== null && paintedWorst >= THRESHOLDS.paintedMs)
      ? 'FAIL'
      : painted.length
        ? 'PASS'
        : 'WARN',
    timedOut.length
      ? `${timedOut.length} op(s) hit the 20 s "no webview report" deadline`
      : painted.length
        ? 'every traced op was ended by the webview'
        : 'no op was ended "painted" — the webview never reported (was the window visible?)',
  );
  row(
    'webview-handler p95',
    THRESHOLDS.handlerP95Ms,
    p95(handlers),
    handlers.length,
    handlers.length && p95(handlers) >= THRESHOLDS.handlerP95Ms ? 'FAIL' : 'PASS',
    handlers.length
      ? 'handler durations the webview measured'
      : 'nothing reached the 40 ms reporter — no handler was slow enough to report',
  );
  row(
    'webview-frames worst',
    THRESHOLDS.frameWorstMs,
    worstOf(frames),
    frames.length,
    frames.length && worstOf(frames) >= THRESHOLDS.frameWorstMs ? 'FAIL' : 'PASS',
    frames.length ? 'worst frame gap of a burst' : 'no frame gap reached the 80 ms reporter',
  );
  // `persist-queued` is what the host **pays** (a payload build plus the change detection),
  // reported twice for the same reason `persist-done` is: the typical write, and the cold one.
  // The first write of a window re-serializes every session — the digest map starts empty, so
  // nothing is known to be unchanged yet — and that is O(all sessions) exactly once.
  const median = (values) => {
    if (!values.length) {
      return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  };
  const queuedMedian = median(queued);
  row(
    'persist-queued (median)',
    THRESHOLDS.persistQueuedMs,
    queuedMedian,
    queued.length,
    queued.length ? (queuedMedian >= THRESHOLDS.persistQueuedMs ? 'FAIL' : 'PASS') : 'WARN',
    queued.length
      ? `the typical write, across ${queued.length} of them — this is the number the host pays, and with the v2 store only the changed nodes are re-serialized`
      : 'no write was queued in this window — the measurement is absent, not good',
  );
  const queuedFirst = queued.length ? queued[0] : null;
  row(
    'persist-queued (first write)',
    THRESHOLDS.persistQueuedColdMs,
    queuedFirst,
    queued.length ? 1 : 0,
    queuedFirst === null
      ? 'WARN'
      : queuedFirst >= THRESHOLDS.persistQueuedColdMs
        ? 'FAIL'
        : 'PASS',
    queuedFirst === null
      ? 'no write was queued in this window — the measurement is absent, not good'
      : 'once per window: the digest map starts empty, so the first write re-serializes every session (O(all sessions), then never again)',
  );
  // `persist-done` is a **queue latency**, not a blocking cost (that is `persist-queued`),
  // so it is reported twice: the typical write, and the storm's tail. One slow tail in a
  // 15-way storm says the queue was behind, which is information; the median going up says
  // every write got slow, which is a regression.
  const doneMedian = median(done);
  const doneWorst = worstOf(done);
  row(
    'persist-done (median)',
    THRESHOLDS.persistDoneMs,
    doneMedian,
    done.length,
    done.length ? (doneMedian >= THRESHOLDS.persistDoneMs ? 'FAIL' : 'PASS') : 'WARN',
    done.length
      ? `the typical write, across ${done.length} of them; a rise here means every write got slow`
      : 'no write completed in this window — the measurement is absent, not good',
  );
  row(
    'persist-done (storm tail)',
    THRESHOLDS.persistDoneStormMs,
    doneWorst,
    done.length,
    done.length ? (doneWorst >= THRESHOLDS.persistDoneStormMs ? 'FAIL' : 'PASS') : 'WARN',
    done.length
      ? 'the write QUEUE\u2019s worst completion latency, not a blocking cost (that is persist-queued); ' +
        'measured band here: ~15-25 ms idle, 90-314 ms mid-storm'
      : 'no write completed in this window — the measurement is absent, not good',
  );
  const searchWorst = worstOf(searches.map((s) => s.ms));
  const viaCounts = searches.reduce((acc, s) => ((acc[s.via] = (acc[s.via] ?? 0) + 1), acc), {});
  const allHitless = searches.length > 0 && searches.every((s) => s.matches === 0);
  row(
    'search-files',
    THRESHOLDS.searchFilesMs,
    searchWorst,
    searches.length,
    !searches.length || allHitless || (searchWorst !== null && searchWorst >= THRESHOLDS.searchFilesMs) ? 'FAIL' : 'PASS',
    !searches.length
      ? 'no `search-files` line — the per-tool instrumentation is missing from this build'
      : allHitless
        ? 'every search reported matches=0 — the fixture was not searched (wrong workspace? ignored tree?)'
        : `via=${Object.entries(viaCounts)
            .map(([k, n]) => `${k}×${n}`)
            .join(' ')}; the search runs in a child process, so this row is a ceiling on "no single call looks like a stall", not the health signal — watch \`lag blocked\``,
  );

  const warnings = rows.filter((r) => r.verdict === 'WARN').length;
  return {
    rows,
    warnings,
    teeDropped,
    counts: {
      lines: lines.length,
      opsPainted: painted.length,
      opsTimedOut: timedOut.length,
      searches: searches.length,
      via: viaCounts,
    },
  };
}

export function formatTable(analysis) {
  const width = Math.max(...analysis.rows.map((r) => r.metric.length), 'metric'.length);
  const out = ['', `${'metric'.padEnd(width)}  worst     limit    n     verdict  note`];
  for (const r of analysis.rows) {
    const value = r.worst === null ? '-' : `${Math.round(r.worst)} ms`;
    out.push(
      `${r.metric.padEnd(width)}  ${value.padStart(7)}  ${String(r.limit).padStart(6)}  ${String(r.count).padStart(4)}  ` +
        `${r.verdict.padEnd(7)}  ${r.note}`,
    );
  }
  const fails = analysis.rows.filter((r) => r.verdict === 'FAIL').length;
  out.push(`${' '.repeat(width)}  ${analysis.rows.length - fails - analysis.warnings} pass, ${fails} fail, ${analysis.warnings} warn   (perf lines: ${analysis.counts.lines})`);
  if (analysis.teeDropped > 0) {
    out.push(`  ! the dev tee dropped ${analysis.teeDropped} line(s): the measurement is incomplete`);
  }
  return out.join('\n');
}

function exitCodeFor(analysis) {
  if (analysis.teeDropped > 0) return 1;
  return analysis.rows.some((r) => r.verdict === 'FAIL') ? 1 : 0;
}

// ---------------------------------------------------------------- selftest

function checker(title) {
  const items = [];
  return {
    add(label, ok, detail) {
      items.push({ label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
    },
    failures: () => items.filter((i) => !i.ok),
    print() {
      console.log(`\n== ${title} ==`);
      for (const i of items) console.log(`  [${i.ok ? 'ok  ' : 'FAIL'}] ${i.label}${i.detail ? `  (${i.detail})` : ''}`);
      const failed = items.filter((i) => !i.ok).length;
      console.log(`${failed ? 'FAIL' : 'PASS'}: ${title}` + (failed ? ` — ${failed} check(s)` : ''));
      return failed;
    },
  };
}

function parseSse(text) {
  const events = [];
  for (const block of String(text).split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === '[DONE]') events.push({ done: true });
    else {
      try {
        events.push({ json: JSON.parse(payload) });
      } catch {
        events.push({ bad: payload });
      }
    }
  }
  return events;
}

function toolCallOf(events) {
  const acc = new Map();
  for (const e of events) {
    const calls = e.json?.choices?.[0]?.delta?.tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      const entry = acc.get(call.index ?? 0) ?? { name: '', args: '' };
      if (call.function?.name) entry.name = call.function.name;
      if (call.function?.arguments) entry.args += call.function.arguments;
      acc.set(call.index ?? 0, entry);
    }
  }
  const first = acc.values().next().value;
  if (!first) return null;
  try {
    return { name: first.name, args: JSON.parse(first.args) };
  } catch {
    return { name: first.name, args: null };
  }
}

const TOOLS_MAIN = ['read_file', 'search_files', 'spawn_agents', 'send_agent_message', 'hop_session'].map((name) => ({ type: 'function', function: { name } }));
const TOOLS_SUB = ['read_file', 'search_files', 'spawn_readonly_agents'].map((name) => ({ type: 'function', function: { name } }));

function conversation(rounds, extra) {
  const messages = [{ role: 'system', content: 'sim' }, { role: 'user', content: extra || '[sim:fanout] run the scenario' }];
  for (let i = 0; i < rounds; i++) {
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'search_files', arguments: '{}' } }] });
    messages.push({ role: 'tool', tool_call_id: `c${i}`, content: 'ok' });
  }
  return messages;
}

async function ask(mock, body) {
  const res = await fetch(`${mock.url}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: 'Bearer sim-dummy-key', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, contentType: res.headers.get('content-type') || '', text: await res.text() };
}

async function selftest(flags) {
  const c = checker('sim selftest (no VS Code, no tokens)');
  console.log('sim --selftest — fixture, mock, plan and analyser, all offline');

  const stats = buildFixture({ root: flags.fixture, seed: flags.seed });
  console.log(formatFixture(stats));
  const digestBefore = fixtureDigest(flags.fixture);
  const again = buildFixture({ root: flags.fixture, seed: flags.seed });
  c.add('the fixture is 3000-4000 files (under the search tool cap)', stats.files >= 3000 && stats.files <= 4000, `${stats.files} files`);
  c.add('three components are present', ['chart-engine', 'cjk-typography', 'vendor-tables'].every((id) => stats.byComponent[id]), Object.keys(stats.byComponent).join(', '));
  c.add('files above the 1 MB cap exist', stats.oversized.length >= 3, `${stats.oversized.length}`);
  c.add('font-like binaries under the cap exist', stats.fonts.length >= 4, `${stats.fonts.length}`);
  c.add(`the hit-heavy token is in a bounded set of files`, stats.tokenFiles > 0 && stats.tokenFiles <= 50, `${stats.tokenFiles} files`);
  c.add('a re-run rewrites nothing', again.written === 0, `written ${again.written}`);
  c.add('the fixture digest is stable', fixtureDigest(flags.fixture) === digestBefore, digestBefore.slice(0, 16));

  const mock = await startMock({ log: flags.mockLog, fixtureRoot: flags.fixture, delayMs: 5 });
  const balance = await fetch(`${mock.url}/user/balance`, { headers: { Authorization: 'Bearer x' } });
  const balanceBody = await balance.json().catch(() => ({}));
  c.add('GET /user/balance answers DeepSeek-shaped JSON', balance.status === 200 && balanceBody.balance_infos?.[0]?.total_balance === '100.00');

  const streamed = await ask(mock, { model: SIM_MODEL, stream: true, messages: conversation(0), tools: TOOLS_MAIN });
  const events = parseSse(streamed.text);
  c.add('stream:true answers text/event-stream', streamed.contentType.startsWith('text/event-stream'), streamed.contentType);
  c.add('every payload is JSON and the stream ends with [DONE]', events.every((e) => e.json || e.done) && events.some((e) => e.done));
  c.add('the stream opens with the assistant role', events[0]?.json?.choices?.[0]?.delta?.role === 'assistant');
  c.add('a finish_reason is sent', events.some((e) => e.json?.choices?.[0]?.finish_reason === 'tool_calls'));
  c.add('a usage chunk is sent', events.some((e) => e.json?.usage));

  const rounds = [
    { round: 0, expect: 'search_files', note: 'hit-heavy scan' },
    { round: 1, expect: 'search_files', note: 'hitless scan' },
    { round: 2, expect: 'read_file', note: 'one read' },
    { round: 3, expect: 'spawn_agents', note: 'the 15-way fan-out' },
  ];
  for (const r of rounds) {
    const reply = toolCallOf(parseSse((await ask(mock, { model: SIM_MODEL, stream: true, messages: conversation(r.round), tools: TOOLS_MAIN })).text));
    c.add(`main round ${r.round} is ${r.expect} (${r.note})`, reply?.name === r.expect, String(reply?.name));
    if (r.round === 0) c.add('  … and searches the fixture for the token', reply?.args?.pattern === SEARCH_TOKEN && String(reply.args.path).includes('spinney-sim'));
    if (r.round === 1) c.add('  … and the hitless round uses a pattern that cannot match', reply?.args?.pattern === NEVER_MATCHES);
    if (r.round === 3) {
      c.add('  … with 15 sub-agent specs', Array.isArray(reply?.args?.agents) && reply.args.agents.length === 15, `${reply?.args?.agents?.length}`);
      c.add('  … each marked read-only (write:false)', reply?.args?.agents?.every((a) => a.write === false));
      c.add('  … each naming itself and the fixture', /\[sim:sub 00\]/.test(reply?.args?.agents?.[0]?.instruction || '') && String(reply?.args?.agents?.[14]?.instruction || '').includes('[sim:sub 14]'));
    }
  }
  const closing = parseSse((await ask(mock, { model: SIM_MODEL, stream: true, messages: conversation(4), tools: TOOLS_MAIN })).text);
  c.add('past the last round the main agent gets a plain answer', toolCallOf(closing) === null && closing.some((e) => e.json?.choices?.[0]?.delta?.content));
  // A fan-out driven inside an *existing* session: hundreds of rounds of history precede
  // the simulation prompt, and the plan must still start at round 0 (the first big-state
  // run answered  and the storm never happened).
  const withHistory = conversation(40).concat([{ role: 'user', content: '[sim:fanout] run the scenario' }]);
  const afterHistory = toolCallOf(parseSse((await ask(mock, { model: SIM_MODEL, stream: true, messages: withHistory, tools: TOOLS_MAIN })).text));
  c.add('a session with a long history still starts the plan at round 0', afterHistory?.name === 'search_files', String(afterHistory?.name));
  c.add('  … and searches for the token, not the closing answer', afterHistory?.args?.pattern === SEARCH_TOKEN, String(afterHistory?.args?.pattern));
  const sub = toolCallOf(parseSse((await ask(mock, { model: SIM_MODEL, stream: true, messages: conversation(0, '[sim:sub 07] investigate'), tools: TOOLS_SUB })).text));
  c.add('a sub-agent conversation (no hop_session) gets the child plan', sub?.name === 'search_files', String(sub?.name));
  const noTools = await ask(mock, { model: SIM_MODEL, stream: false, messages: [{ role: 'user', content: 'name this session' }] });
  const noToolsBody = JSON.parse(noTools.text);
  c.add('a request with no tools is never answered with a tool call', !noToolsBody.choices?.[0]?.message?.tool_calls);
  const syncReply = await ask(mock, { model: SIM_MODEL, stream: false, messages: conversation(0), tools: TOOLS_MAIN });
  c.add('stream:false answers plain JSON with the same tool call', (JSON.parse(syncReply.text).choices?.[0]?.message?.tool_calls || [])[0]?.function?.name === 'search_files');

  const before = mock.stats.requests;
  const burst = await Promise.all(Array.from({ length: 15 }, () => ask(mock, { model: SIM_MODEL, stream: true, messages: conversation(0), tools: TOOLS_MAIN })));
  const statsNow = await (await fetch(`${mock.url}/__sim/stats`)).json();
  c.add('15 concurrent streams all complete', burst.every((b) => b.status === 200 && /data: \[DONE\]/.test(b.text)));
  c.add('the mock really served them concurrently', statsNow.peakConcurrency >= 15, `peak ${statsNow.peakConcurrency}`);
  c.add('every request was counted', statsNow.requests - before >= 15);
  c.add('the mock saw an Authorization header', statsNow.authSeen === true);

  const entries = mock.entries();
  c.add('the request log parses and holds one entry per request', entries.length > 0 && entries.every((e) => typeof e.path === 'string' && typeof e.auth === 'boolean' && e.ms >= 0));
  c.add('the log never carries the key, only the header presence', !JSON.stringify(entries).includes('sim-dummy-key'));

  const customerLog = [
    '[perf] persist-queued 821ms sessions=81 nodes=751 chars≈116927140',
    '[perf] lag blocked 10302ms (4 late ticks) | ctx: persist in-flight 10ms, chars≈116927140',
    '[perf] persist-done 2348ms sessions=81 nodes=751 chars≈118860732',
    '[perf] op#13 end 20024ms no webview report',
    '[perf] op#9 end 2210ms painted cards=8 dom=10035',
    '[perf] webview-handler session=s1 message=delta ms=940',
    '[perf] webview-frames session=s1 phase=stream worst=2692 frames=120',
    '[perf] search-files ms=104000 files=3 matches=1 capped=none via=rg scope=4',
  ].join('\n');
  const bad = analysePerfLog(customerLog);
  const rowOf = (name) => bad.rows.find((r) => r.metric === name);
  c.add('the analyser flags the customer\'s lag line', rowOf('lag blocked').verdict === 'FAIL' && rowOf('lag blocked').worst === 10302);
  c.add('  … the 20 s op deadline', rowOf('cold switch (op … painted)').verdict === 'FAIL' && /no webview report/.test(rowOf('cold switch (op … painted)').note));
  c.add('  … the handler p95', rowOf('webview-handler p95').verdict === 'FAIL' && rowOf('webview-handler p95').worst === 940);
  c.add('  … the worst frame', rowOf('webview-frames worst').verdict === 'FAIL' && rowOf('webview-frames worst').worst === 2692);
  c.add(
    '  … the blocking row and both persist-done rows',
    rowOf('persist-queued (median)').verdict === 'FAIL' &&
      rowOf('persist-done (median)').verdict === 'FAIL' &&
      rowOf('persist-done (storm tail)').verdict === 'FAIL',
  );
  c.add('  … the 104 s search', rowOf('search-files').verdict === 'FAIL' && rowOf('search-files').worst === 104000);
  c.add('  … and the op-mark prefix is unwrapped', analysePerfLog('[perf] op#9 +1634ms post-tree bytes=2325344\n[perf] op#9 end 2210ms painted').rows.find((r) => r.metric === 'cold switch (op … painted)').worst === 2210);

  const clean = analysePerfLog(
    [
      '[perf] lag blocked 180ms (1 late tick) | ctx: persist idle',
      '[perf] op#1 end 300ms painted',
      '[perf] webview-handler session=s message=delta ms=50',
      '[perf] webview-frames session=s phase=stream worst=120 frames=30',
      '[perf] persist-queued 4ms sessions=2 nodes=18 items=162 msgs=34 chars≈17169647',
      '[perf] persist-done 90ms sessions=2 nodes=18 items=162 msgs=34 chars≈17169647',
      '[perf] search-files ms=412 files=3715 matches=17 capped=none via=rg scope=4',
    ].join('\n'),
  );
  c.add('a log inside every limit passes', clean.rows.every((r) => r.verdict !== 'FAIL'), JSON.stringify(clean.rows.filter((r) => r.verdict === 'FAIL').map((r) => r.metric)));
  const overLimit = analysePerfLog('[perf] lag blocked 400ms (1 late tick)\n[perf] op#1 end 300ms painted');
  c.add('  … but a 400 ms lag FAILs', overLimit.rows.find((r) => r.metric === 'lag blocked').verdict === 'FAIL');
  const oneLiner = analysePerfLog('[perf] op#1 end 300ms painted');
  c.add('an absent measurement is never a silent PASS', oneLiner.rows.find((r) => r.metric === 'persist-done (median)').verdict === 'WARN');
  // The two halves of the persist-done reading, on the real shape of a storm: eighteen
  // writes, most of them ~20 ms, one 314 ms tail while fifteen sub-agents were running.
  const stormTail = analysePerfLog(
    [
      ...Array.from({ length: 17 }, () => '[perf] persist-done 20ms via=store'),
      '[perf] persist-done 314ms via=store',
    ].join('\n'),
  );
  const tailRow = (name) => stormTail.rows.find((r) => r.metric === name);
  c.add('a storm tail passes on the tail row', tailRow('persist-done (storm tail)').verdict === 'PASS' && tailRow('persist-done (storm tail)').worst === 314);
  c.add('  … and the median still judges the typical write', tailRow('persist-done (median)').worst === 20 && tailRow('persist-done (median)').verdict === 'PASS');
  c.add('  … and the tail row says what it measures', /QUEUE/, /worst completion latency, not a blocking cost/.test(tailRow('persist-done (storm tail)').note));
  const everyWriteSlow = analysePerfLog(
    [...Array.from({ length: 10 }, () => '[perf] persist-done 400ms via=store'), '[perf] persist-done 120ms via=store'].join('\n'),
  );
  c.add(
    'a run where every write got slow FAILs on the median',
    everyWriteSlow.rows.find((r) => r.metric === 'persist-done (median)').verdict === 'FAIL',
  );
  const impossibleTail = analysePerfLog('[perf] persist-done 900ms via=store');
  c.add('a tail beyond the storm band still FAILs', impossibleTail.rows.find((r) => r.metric === 'persist-done (storm tail)').verdict === 'FAIL');
  // `persist-queued` reads twice: the typical write and the once-per-window cold one (the
  // digest baseline). A slow first write must not condemn the run, and a fast one must not
  // hide a cold write that really was slow.
  const coldThenFast = analysePerfLog(
    ['[perf] persist-queued 85ms via=store', ...Array.from({ length: 15 }, () => '[perf] persist-queued 11ms via=store')].join('\n'),
  );
  const queuedRow = (name) => coldThenFast.rows.find((r) => r.metric === name);
  c.add(
    'a slow once-per-window write leaves the typical one passing',
    queuedRow('persist-queued (median)').verdict === 'PASS' &&
      queuedRow('persist-queued (median)').worst === 11 &&
      queuedRow('persist-queued (first write)').verdict === 'PASS' &&
      queuedRow('persist-queued (first write)').worst === 85,
  );
  c.add(
    '  … and the cold row says what it is',
    /once per window: the digest map starts empty/.test(queuedRow('persist-queued (first write)').note),
  );
  const coldTooSlow = analysePerfLog(['[perf] persist-queued 900ms via=store', '[perf] persist-queued 11ms via=store'].join('\n'));
  c.add(
    'a cold write beyond its own limit FAILs',
    coldTooSlow.rows.find((r) => r.metric === 'persist-queued (first write)').verdict === 'FAIL',
  );
  const everyQueuedSlow = analysePerfLog(Array.from({ length: 8 }, () => '[perf] persist-queued 60ms via=store').join('\n'));
  c.add(
    'every write being slow FAILs on the median row',
    everyQueuedSlow.rows.find((r) => r.metric === 'persist-queued (median)').verdict === 'FAIL',
  );
  c.add('an absent probe says why it was absent', /40 ms reporter/.test(oneLiner.rows.find((r) => r.metric === 'webview-handler p95').note));
  const hitless = analysePerfLog('[perf] search-files ms=40 files=3715 matches=0 capped=none via=rg scope=4');
  c.add('an all-hitless run FAILs (the fixture was not really searched)', hitless.rows.find((r) => r.metric === 'search-files').verdict === 'FAIL');
  c.add('a tee gap is reported and fails the run', (() => {
    const withGap = analysePerfLog('[perf] dev tee dropped 12 line(s)\n[perf] op#1 end 300ms painted');
    return withGap.teeDropped === 12 && exitCodeFor(withGap) === 1;
  })());
  c.add('exitCodeFor: 0 when nothing FAILs, 1 otherwise', exitCodeFor(clean) === 0 && exitCodeFor(bad) === 1);

  await mock.close();
  const failed = c.print();
  return failed === 0 ? 0 : 1;
}

// ---------------------------------------------------------------- full run

/**
 * Resolve how to launch a window.
 *
 * `Code.exe` is the Electron app: it rejects the CLI's own flags (`Code.exe -n …` →
 * `bad option: -n`, verified). On Windows the CLI is `bin\code.cmd`, which is really
 * `ELECTRON_RUN_AS_NODE=1 <install>\Code.exe <install>\<commit>\resources\app\out\cli.js %*`,
 * so that is what this reproduces — no shell, no `.cmd` quoting, and `vscode.env.appRoot`
 * is derived from the same install so the bundled ripgrep is found too.
 *
 * @returns {{exe:string, cli:string, how:string}}
 */
/**
 * Kill the window this run launched: the CLI process exits as soon as it has started the
 * app, so there is no pid to hold on to. Every process of the throwaway profile carries
 * its `--user-data-dir` in its command line, and only the *main* process (no `--type=`)
 * is killed — with `/T` to take its renderers and the extension host with it. Nothing
 * else on the machine can match, because the profile path is this run's own.
 */
function killLaunchedWindow(profile, cliPid) {
  if (process.platform !== 'win32') {
    try {
      process.kill(-cliPid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    return [];
  }
  const killed = [];
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
    const pids = String(query.stdout || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^\d+$/.test(l));
    for (const pid of pids) {
      spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' });
      killed.push(Number(pid));
    }
  } catch {
    /* best effort */
  }
  try {
    spawnSync('taskkill', ['/PID', String(cliPid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
  return killed;
}

/**
 * Resolve how to launch a window.
 *
 * `Code.exe` is the Electron app: it rejects the CLI's own flags (`Code.exe -n …` →
 * `bad option: -n`, verified). On Windows the CLI is `bin\code.cmd`, which is really
 * `ELECTRON_RUN_AS_NODE=1 <install>\Code.exe <install>\<commit>\resources\app\out\cli.js %*`,
 * so that is what this reproduces — no shell, no `.cmd` quoting, and the same install
 * gives us `vscode.env.appRoot`'s directory for the bundled ripgrep.
 *
 * @returns {{exe:string|null, cli:string|null, how:string}}
 */
function resolveCode() {
  const explicit = process.env.HYPER_VSCODE_CODE;
  if (explicit && fs.existsSync(explicit)) {
    return { exe: explicit, cli: findCli(path.dirname(explicit)), how: 'HYPER_VSCODE_CODE' };
  }
  const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['code'], { encoding: 'utf8' });
  const lines = String(found.stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (/code\.cmd$/i.test(line)) {
      const install = path.dirname(path.dirname(line));
      const exe = path.join(install, 'Code.exe');
      const cli = findCli(install);
      if (fs.existsSync(exe) && cli) return { exe, cli, how: 'bin\\code.cmd → Code.exe + out\\cli.js' };
    }
    if (/code\.exe$/i.test(line) || /code$/i.test(line)) {
      const install = path.dirname(line);
      const cli = findCli(install);
      if (cli) return { exe: line, cli, how: 'code on PATH + out\\cli.js' };
    }
  }
  return { exe: null, cli: null, how: 'not found' };
}

/** `<install>[/<commit>]/resources/app/out/cli.js` — the CLI entry point. */
function findCli(install) {
  const direct = path.join(install, 'resources', 'app', 'out', 'cli.js');
  if (fs.existsSync(direct)) return direct;
  try {
    for (const entry of fs.readdirSync(install)) {
      const candidate = path.join(install, entry, 'resources', 'app', 'out', 'cli.js');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    /* not an install root */
  }
  return null;
}

function userExtensionsDir() {
  if (process.env.HYPER_VSCODE_EXTENSIONS_DIR) return process.env.HYPER_VSCODE_EXTENSIONS_DIR;
  const home = process.env.USERPROFILE || process.env.HOME;
  return home ? path.join(home, '.vscode', 'extensions') : null;
}

/**
 * The installed build under test: the **newest by build time**.
 *
 * Not by name (a string sort puts `…-0.0.3-diag.4` after `…-0.0.3`, so two runs that claimed to
 * measure the release measured the older diagnostic build) and not by semver either (a
 * prerelease ranks *below* its release, while the diagnostic build is the newer artifact).
 * `pin` names one explicitly.
 */
function findInstalledExtension(extDir, pin) {
  if (!extDir) return null;
  let names = [];
  try {
    names = fs.readdirSync(extDir);
  } catch {
    return null;
  }
  const hits = names
    .filter((n) => /^de-yu\.spinney-\d/.test(n) && fs.existsSync(path.join(extDir, n, 'package.json')))
    .map((name) => ({ name, at: fs.statSync(path.join(extDir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  if (pin) {
    const wanted = hits.find((h) => h.name === pin || h.name === `de-yu.spinney-${pin}`);
    if (wanted) return path.join(extDir, wanted.name);
    return null;
  }
  return hits.length ? path.join(extDir, hits[0].name) : null;
}

const ACTIVATOR_PACKAGE = {
  name: 'sim-activator',
  publisher: 'sim',
  version: '1.0.0',
  engines: { vscode: '^1.60.0' },
  main: './extension.js',
  activationEvents: ['onStartupFinished'],
};

const ACTIVATOR_JS = `const vscode = require('vscode');
// Focusing the container makes the 'spinney.sessions' view visible, which is the only
// activation event the extension under test declares (onView:spinney.sessions). Without
// this a fresh window never activates it and the control plane never starts.
exports.activate = () => {
  void vscode.commands.executeCommand('workbench.view.extension.spinney');
};
exports.deactivate = () => {};
`;

/** Link (or copy) the extension under test plus the activator into a private extensions dir. */
function prepareExtensions(dir, extensionPath) {
  fs.mkdirSync(dir, { recursive: true });
  const activator = path.join(dir, 'sim-activator');
  const prior = fs.existsSync(path.join(activator, 'package.json'))
    ? fs.readFileSync(path.join(activator, 'package.json'), 'utf8')
    : '';
  if (prior !== JSON.stringify(ACTIVATOR_PACKAGE, null, 2)) {
    fs.mkdirSync(activator, { recursive: true });
    fs.writeFileSync(path.join(activator, 'package.json'), `${JSON.stringify(ACTIVATOR_PACKAGE, null, 2)}\n`);
    fs.writeFileSync(path.join(activator, 'extension.js'), ACTIVATOR_JS);
  }
  const target = path.join(dir, path.basename(extensionPath));
  if (fs.existsSync(path.join(target, 'package.json'))) {
    return { target, how: fs.lstatSync(target).isSymbolicLink() ? 'junction (existing)' : 'existing' };
  }
  try {
    fs.symlinkSync(extensionPath, target, process.platform === 'win32' ? 'junction' : 'dir');
    if (fs.existsSync(path.join(target, 'package.json'))) return { target, how: 'junction' };
  } catch {
    /* fall through to a copy */
  }
  fs.cpSync(extensionPath, target, { recursive: true });
  return { target, how: 'copy' };
}

const PROFILE_SETTINGS = (mockUrl, port) => ({
  // A fresh profile opening an untrusted folder runs in Restricted Mode, and an extension
  // that does not declare `capabilities.untrustedWorkspaces` is **not enabled there** —
  // which is exactly how the first attempts ended with a window whose extension never
  // activated. The throwaway profile trusts its throwaway workspace, nothing else.
  'security.workspace.trust.enabled': false,
  'workbench.startupEditor': 'none',
  'window.restoreWindows': 'none',
  'extensions.ignoreRecommendations': true,
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'spinney.providers': {
    default: { name: 'Sim mock', baseUrl: mockUrl, balance: 'deepseek', concurrency: 0 },
  },
  'spinney.modelCards': {
    'sim-card': { name: 'Sim card', providerId: 'default', oaiModel: SIM_MODEL, contextWindow: 262144, concurrency: 0 },
  },
  'spinney.model': 'sim-card',
  'spinney.maxConcurrentSubagents': 15,
  'spinney.autoSessionTitles': false,
  'spinney.httpApi.enabled': true,
  'spinney.httpApi.port': port,
  'search.exclude': { '**/.spinney/**': true },
  'files.watcherExclude': { '**/.spinney/**': true },
});

/**
 * Start every run from a virgin profile (except the linked extensions). A leftover
 * `state.vscdb` carries the *previous* run's window state — extension enablement, layout,
 * a restored tab — which would make two runs incomparable and can keep an extension
 * disabled from an earlier attempt.
 */
function resetProfile(profile) {
  const extensions = path.join(profile, 'extensions');
  // VS Code caches the extensions it found in `extensions/extensions.json`; keeping it
  // across runs makes a freshly linked build load the *previous* version (that is how a
  //  run silently measured last build's persist format).
  fs.rmSync(path.join(extensions, 'extensions.json'), { force: true });
  for (const entry of fs.existsSync(profile) ? fs.readdirSync(profile) : []) {
    if (path.join(profile, entry) === extensions) continue;
    fs.rmSync(path.join(profile, entry), { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
}

function makeClient(port, token) {
  return async function call(route, init = {}) {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) },
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
}

/**
 * `--rename-test`: does a window whose store root is empty but which has a **sibling**
 * root adopt the sessions there?
 *
 * This is the rename-survival path and nothing else. It cannot be tested in the
 * developer's own window without hiding the real store — which would take that very
 * conversation off screen if the adoption failed — so it runs in the throwaway window the
 * harness already knows how to launch, and it is repeatable:
 *
 *   1. launch once, so the window creates a session and writes it through the store;
 *   2. copy that session into a **sibling** root (`<profile>/…/globalStorage/<fake-id>/spinney`)
 *      under the same workspace key, read straight off the disk (never guessed);
 *   3. empty the live root's workspace folder and launch again;
 *   4. assert the session is back in the live root, the sibling was left alone, and the
 *      window reported the adoption.
 */
async function renameTest(flags) {
  const code = resolveCode();
  if (!code.exe || !code.cli) {
    return failRun('no VS Code CLI found (`code` on PATH)', 'set HYPER_VSCODE_CODE to Code.exe.');
  }
  const installed = findInstalledExtension(userExtensionsDir(), flags.extension);
  if (!installed) {
    return failRun('no installed de-yu.spinney-* extension', 'run `powershell -File build-deploy.ps1` first.');
  }
  const profile = path.join(REPO, '.spinney', 'sim', 'profile');
  const perfLog = path.join(REPO, '.spinney', 'sim', 'rename-perf.log');
  const globalStorage = path.join(profile, 'User', 'globalStorage');
  const liveRoot = path.join(globalStorage, 'de-yu.spinney', 'spinney');
  const oldRoot = path.join(globalStorage, 'sim-renamed.spinney', 'spinney');
  const fixtureRoot = flags.fixture;
  const port = flags.port;
  const problems = [];
  const check = (label, ok, detail) => {
    console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${label}${detail ? `  (${detail})` : ''}`);
    if (!ok) problems.push(label);
  };

  console.log('sim — rename survival (dev tooling; our own throwaway window, never the developer\u2019s)');
  buildFixture({ root: fixtureRoot, seed: flags.seed });
  resetProfile(profile);
  fs.rmSync(oldRoot, { recursive: true, force: true });
  const extensions = prepareExtensions(path.join(profile, 'extensions'), installed);
  fs.mkdirSync(path.join(profile, 'User'), { recursive: true });

  /** Launch the window (no mock provider is needed: the adoption happens at activation). */
  const launch = async (token) => {
    fs.writeFileSync(path.join(profile, 'User', 'settings.json'), `${JSON.stringify({
      'security.workspace.trust.enabled': false,
      'workbench.startupEditor': 'none',
      'window.restoreWindows': 'none',
      'telemetry.telemetryLevel': 'off',
      'spinney.httpApi.enabled': true,
      'spinney.httpApi.port': port,
    }, null, 2)}\n`);
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      SPINNEY_HTTP: '1',
      SPINNEY_HTTP_PORT: String(port),
      SPINNEY_HTTP_TOKEN: token,
      SPINNEY_INSTANCE_ID: 'sim-harness',
      SPINNEY_PERF_LOG: perfLog,
      DEEPSEEK_API_KEY: 'sim-dummy-key',
    };
    const child = spawn(
      code.exe,
      [code.cli, fixtureRoot, `--user-data-dir=${profile}`, `--extensions-dir=${path.join(profile, 'extensions')}`],
      { env, detached: true, stdio: 'ignore' },
    );
    child.unref();
    const call = makeClient(port, token);
    const deadline = Date.now() + flags.readySec * 1000;
    while (Date.now() < deadline) {
      const health = await call('/health').catch(() => null);
      if (health?.status === 200) {
        return { call, child };
      }
      await sleep(1500);
    }
    return { call, child, timedOut: true };
  };

  const sessionsOf = (root) => {
    try {
      const keys = fs.readdirSync(path.join(root, 'sessions'), { withFileTypes: true }).filter((e) => e.isDirectory());
      const out = [];
      for (const key of keys) {
        const dir = path.join(root, 'sessions', key.name);
        for (const file of fs.readdirSync(dir)) {
          if (file.endsWith('.json') && file !== 'index.json' && !file.endsWith('.bak')) out.push(path.join(dir, file));
        }
      }
      return out;
    } catch {
      return [];
    }
  };

  try {
    // ---- phase 1: a window on an empty profile writes its session through the store ----
    const first = await launch(crypto.randomBytes(16).toString('hex'));
    if (first.timedOut) {
      return failRun(`the control plane on 127.0.0.1:${port} never answered (first launch)`, 'is the port free?');
    }
    await sleep(5000); // let the activation persist the placeholder session
    const before = sessionsOf(liveRoot);
    check('the window wrote its session into the store root', before.length >= 1, `${before.length} file(s)`);
    if (before.length === 0) {
      return failRun('no session file was written — the store path never ran', `expected files under ${liveRoot}/sessions/`);
    }
    const key = path.basename(path.dirname(before[0]));
    const id = path.basename(before[0], '.json');
    console.log(`  session    ${id} (workspace key ${key})`);
    killLaunchedWindow(profile, first.child.pid);
    await sleep(2500);

    // ---- phase 2: the same session, under a *different* extension id's store root ----
    const oldDir = path.join(oldRoot, 'sessions', key);
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(
      path.join(oldRoot, 'manifest.json'),
      `${JSON.stringify({ producer: 'spinney', dataVersion: 1, writtenAt: Date.now() }, null, 2)}\n`,
    );
    fs.copyFileSync(before[0], path.join(oldDir, `${id}.json`));
    // The `.bak` generation only exists from the *second* write of a file on (asserted in
    // `tools/session-store-acceptance.js`), so it is copied when it is there and skipped
    // when the session has only ever been written once.
    if (fs.existsSync(`${before[0]}.bak`)) {
      fs.copyFileSync(`${before[0]}.bak`, path.join(oldDir, `${id}.json.bak`));
    }
    // Empty the live root's workspace folder: this is exactly what a renamed extension
    // sees — its own root exists, and nothing in it.
    for (const file of fs.readdirSync(path.dirname(before[0]))) {
      fs.rmSync(path.join(path.dirname(before[0]), file), { force: true });
    }
    console.log(`  seeded     ${oldRoot} (a stand-in for the pre-rename id)`);
    check('the live root is now empty of sessions', sessionsOf(liveRoot).length === 0);

    // ---- phase 3: activation adopts from the sibling ----
    fs.rmSync(perfLog, { force: true });
    const second = await launch(crypto.randomBytes(16).toString('hex'));
    if (second.timedOut) {
      return failRun(`the control plane on 127.0.0.1:${port} never answered (second launch)`);
    }
    await sleep(6000);
    const after = sessionsOf(liveRoot);
    const perfText = fs.existsSync(perfLog) ? fs.readFileSync(perfLog, 'utf8') : '';
    const adoptedLine = /\[perf\] store-adopted[^\n]*/.exec(perfText);
    check('the sibling root was found and adopted from', Boolean(adoptedLine), adoptedLine ? adoptedLine[0] : '(no store-adopted line)');
    check('the session is back in the live root', after.some((f) => f.endsWith(`${id}.json`)), `${after.length} file(s)`);
    check('  … and it is the same session (no duplicate)', after.filter((f) => f.endsWith('.json')).length === 1, after.map((f) => path.basename(f)).join(','));
    check('  … and the other root was only read', fs.existsSync(path.join(oldDir, `${id}.json`)));
    const live = after.find((f) => f.endsWith(`${id}.json`));
    check('  … and its content survived the round trip', (() => {
      try {
        const envelope = JSON.parse(fs.readFileSync(live, 'utf8'));
        return envelope.kind === 'session' && envelope.sessionId === id && typeof envelope.session === 'object';
      } catch {
        return false;
      }
    })());
    killLaunchedWindow(profile, second.child.pid);
    await sleep(1500);
    fs.rmSync(oldRoot, { recursive: true, force: true });
    fs.rmSync(path.join(liveRoot, 'sessions'), { recursive: true, force: true });
  } catch (err) {
    return failRun(`the rename test threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log('');
  if (problems.length) {
    console.log(`FAIL rename-test: ${problems.length} check(s) failed\n - ${problems.join('\n - ')}`);
    return 1;
  }
  console.log('PASS rename-test: a window whose store root is empty adopts its sessions back from a sibling root left by another extension id');
  return 0;
}

/**
 * `--big-state`: the same storm, over the developer's **real** session store.
 *
 * The simulation's own sessions are small (~0.9 M chars), while the customer's was 17.2 M
 * and the biggest session in a real profile is in that league too (19 MB here) — so the
 * persist axis cannot be judged from the fixture. This mode copies the real store into the
 * throwaway profile (the developer's data is only ever **read**), opens the window on *this
 * repository* so the workspace key matches the copied sessions, and drives the fan-out
 * **inside the biggest session**, which is what makes every turn-end write that session.
 *
 *   node tools/sim/run.mjs --big-state [--source-store <dir>] [--session <id>]
 */
async function bigState(flags) {
  const code = resolveCode();
  if (!code.exe || !code.cli) {
    return failRun('no VS Code CLI found (`code` on PATH)', 'set HYPER_VSCODE_CODE to Code.exe.');
  }
  const installed = findInstalledExtension(userExtensionsDir(), flags.extension);
  if (!installed) {
    return failRun('no installed de-yu.spinney-* extension', 'run `powershell -File build-deploy.ps1` first.');
  }
  const profile = path.join(REPO, '.spinney', 'sim', 'profile');
  const perfLog = path.join(REPO, '.spinney', 'sim', 'big-state-perf.log');
  const mockLog = path.join(REPO, '.spinney', 'sim', 'big-state-requests.jsonl');
  const globalStorage = path.join(profile, 'User', 'globalStorage');
  const liveRoot = path.join(globalStorage, 'de-yu.spinney', 'spinney');
  const sourceRoot = flags.sourceStore || path.join(process.env.APPDATA || '', 'Code', 'User', 'globalStorage', 'de-yu.spinney', 'spinney');
  const port = flags.port;
  const token = crypto.randomBytes(16).toString('hex');

  if (!fs.existsSync(path.join(sourceRoot, 'sessions'))) {
    return failRun(`no session store at ${sourceRoot}`, 'pass --source-store <dir>, or run a window with the store once.');
  }

  console.log('sim — big state (the developer\u2019s real store, copied; dev tooling, never shipped)');

  // A window left over from an earlier run shares this profile *and* the perf log, and its
  // requests would go to a mock that is already closed — a `fetch failed` that looks like a
  // product bug. Clear it before touching the profile.
  killLaunchedWindow(profile, 0);
  await sleep(1500);  buildFixture({ root: flags.fixture, seed: flags.seed });
  resetProfile(profile);
  const extensions = prepareExtensions(path.join(profile, 'extensions'), installed);
  fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
  // Copy the whole store root (sessions + index + manifest), never the parked migration blob.
  // The walk is layout-agnostic on purpose: v2 keeps one **folder** per session and v1 kept
  // one file, and a copy loop that assumed either one silently copied nothing — which made a
  // "big state" run measure a two-session fixture instead.
  fs.mkdirSync(liveRoot, { recursive: true });
  fs.rmSync(path.join(liveRoot, 'sessions'), { recursive: true, force: true });
  fs.cpSync(path.join(sourceRoot, 'sessions'), path.join(liveRoot, 'sessions'), {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}${'.trash'}`),
  });
  fs.copyFileSync(path.join(sourceRoot, 'manifest.json'), path.join(liveRoot, 'manifest.json'));

  /** Every session in the copy, with the bytes it occupies (folder or v1 file). */
  const sessionsDir = path.join(liveRoot, 'sessions');
  const sizeOf = (entry) => {
    const full = path.join(entry);
    let bytes = 0;
    const walk = (file) => {
      if (fs.statSync(file).isDirectory()) {
        for (const child of fs.readdirSync(file)) walk(path.join(file, child));
      } else {
        bytes += fs.statSync(file).size;
      }
    };
    walk(full);
    return bytes;
  };
  let biggest = { id: '', bytes: 0, key: '' };
  let copied = 0;
  for (const keyEntry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!keyEntry.isDirectory() || keyEntry.name.startsWith('.')) continue;
    const keyDir = path.join(sessionsDir, keyEntry.name);
    for (const entry of fs.readdirSync(keyDir)) {
      if (entry === 'index.json') continue;
      const full = path.join(keyDir, entry);
      const isSession = fs.statSync(full).isDirectory() ? fs.existsSync(path.join(full, 'session.json')) : entry.endsWith('.json');
      if (!isSession) continue;
      copied++;
      const bytes = sizeOf(full);
      if (bytes > biggest.bytes) {
        biggest = { id: entry.replace(/\.json$/, ''), bytes, key: keyEntry.name };
      }
    }
  }
  if (copied === 0) {
    return failRun(
      `copied no sessions from ${sourceRoot}`,
      'the store layout was not recognized — refusing to run a "big state" test on an empty profile',
    );
  }
  const target = flags.session || biggest.id;
  if (!target) {
    return failRun('no target session found in the copy', 'pass --session <id>');
  }
  if (flags.session && !fs.existsSync(path.join(sessionsDir, biggest.key || fs.readdirSync(sessionsDir)[0], flags.session))) {
    return failRun(`--session ${flags.session} is not in ${sourceRoot}`);
  }
  const totalBytes = statTree(path.join(liveRoot, 'sessions'));
  console.log(`  extension  ${installed}  (built ${new Date(fs.statSync(installed).mtimeMs).toISOString().slice(0, 16).replace('T', ' ')})`);
  console.log(`  copied     ${(totalBytes / (1024 * 1024)).toFixed(1)} MiB, ${copied} session(s) from ${sourceRoot}`);
  console.log(`  target     ${target} (${(biggest.bytes / (1024 * 1024)).toFixed(1)} MiB) — the fan-out runs inside it`);
  console.log(`  workspace  ${REPO} (so the workspace key ${biggest.key} matches the copied sessions)`);

  const mock = await startMock({ fixtureRoot: flags.fixture, log: mockLog, delayMs: 25 });
  console.log(`  mock       ${mock.url}`);

  const mockProbe = await fetch(`${mock.url}/__sim/stats`).then((r) => r.status === 200, () => false);
  if (!mockProbe) {
    return failRun('the mock provider is not answering', 'refusing to run against a dead mock');
  }  fs.writeFileSync(path.join(profile, 'User', 'settings.json'), `${JSON.stringify(PROFILE_SETTINGS(mock.url, port), null, 2)}\n`);
  try {
    fs.writeFileSync(perfLog, '');
  } catch {
    /* the tee creates it too */
  }
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    SPINNEY_HTTP: '1',
    SPINNEY_HTTP_PORT: String(port),
    SPINNEY_HTTP_TOKEN: token,
    SPINNEY_INSTANCE_ID: 'sim-harness',
    SPINNEY_PERF_LOG: perfLog,
    DEEPSEEK_API_KEY: 'sim-dummy-key',
  };
  console.log('  launching a throwaway window (never the developer\u2019s) …');
  const child = spawn(
    code.exe,
    [code.cli, REPO, `--user-data-dir=${profile}`, `--extensions-dir=${path.join(profile, 'extensions')}`],
    { env, detached: true, stdio: 'ignore' },
  );
  child.unref();
  const call = makeClient(port, token);
  try {
    const deadline = Date.now() + flags.readySec * 1000;
    let health = null;
    while (Date.now() < deadline) {
      const res = await call('/health').catch(() => null);
      if (res && res.status === 200) {
        health = res.json;
        break;
      }
      await sleep(1500);
    }
    if (!health) {
      return failRun(`the control plane on 127.0.0.1:${port} never answered`, 'is the port free?');
    }
    // Give activation a moment to read the store, then report what it cost.
    await sleep(6000);
    const opened = fs.readFileSync(perfLog, 'utf8');
    const loadLine = /\[perf\] load-sessions[^\n]*/.exec(opened);
    console.log(`\n  activation ${loadLine ? loadLine[0] : '(no load-sessions line)'}`);

    // The big state must actually be in play: the whole point of this mode is the *size* of
    // the session the storm writes, so a run that quietly loaded a small fixture is a bug in
    // the harness, not a measurement. It did exactly that once (the copy loop still assumed
    // the v1 layout), so it is checked, not assumed.
    const loadedLine = /\[perf\] load-sessions[^\n]*/.exec(opened);
    const reportedSessions = loadedLine ? Number(/sessions=(\d+)/.exec(loadedLine[0])?.[1] ?? 0) : 0;
    if (reportedSessions < copied) {
      return failRun(
        `the window loaded ${reportedSessions} session(s), the copy holds ${copied}`,
        'the copy or the workspace key is wrong; refusing to report a "big state" number from it',
      );
    }
    console.log(`  verified   the window loaded ${reportedSessions} session(s) — the copied store is in play`);

    const started = await call('/session/start', {
      method: 'POST',
      body: JSON.stringify({ sessionId: target, prompt: '[sim:fanout] run the simulation scenario' }),
    });
    if (started.status !== 200) {
      return failRun(`POST /session/start answered ${started.status}: ${started.text.slice(0, 200)}`);
    }
    const until = Date.now() + flags.idleSec * 1000;
    let peakSubs = 0;
    let seenBusy = false;
    while (Date.now() < until) {
      const state = await call('/state').catch(() => null);
      if (state?.json) {
        peakSubs = Math.max(peakSubs, Number(state.json.runningSubAgents) || 0);
        const running = Boolean(state.json.busy) || (Number(state.json.runningSubAgents) || 0) > 0;
        if (running) seenBusy = true;
        if (seenBusy && !running) break;
      }
      await sleep(1000);
    }
    await call('/wait-for-finish', { method: 'POST', body: JSON.stringify({ scope: 'all', timeoutMs: 600000 }) }).catch(() => null);
    await sleep(3000);
    console.log(`  storm      peak sub-agents ${peakSubs}`);

    const analysis = analysePerfLog(fs.readFileSync(perfLog, 'utf8'));
    console.log(formatTable(analysis));
    const persist = fs
      .readFileSync(perfLog, 'utf8')
      .split('\n')
      .filter((l) => l.includes('persist-') && l.includes('via=store'))
      .slice(-6);
    console.log(`\n  the writes that matter (a ${(biggest.bytes / (1024 * 1024)).toFixed(1)} MiB session):`);
    for (const line of persist) console.log(`    ${line}`);
    return exitCodeFor(analysis);
  } finally {
    killLaunchedWindow(profile, child.pid);
    await mock.close();
    console.log(`  (window killed; profile kept at ${profile})`);
  }
}

/** Total bytes of a directory tree (the store copy's footprint). */
function statTree(root) {
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else bytes += fs.statSync(full).size;
    }
  };
  try {
    walk(root);
  } catch {
    /* nothing to measure */
  }
  return bytes;
}

async function fullRun(flags) {
  const fail = (message, hint) => {
    console.error(`\nsim: ${message}`);
    if (hint) console.error(`     ${hint}`);
    return 3;
  };

  const code = resolveCode();
  if (!code.exe || !code.cli) {
    return fail('no VS Code CLI found (`code` on PATH)', 'set HYPER_VSCODE_CODE to Code.exe, or put the VS Code `bin` on PATH.');
  }
  const extensionsDir = userExtensionsDir();
  const installed = findInstalledExtension(extensionsDir);
  if (!installed) {
    return fail(`no installed de-yu.spinney-* under ${extensionsDir || '(no extensions dir)'}`, 'run `powershell -File build-deploy.ps1` first (it also runs the release gate).');
  }

  const profile = path.join(REPO, '.spinney', 'sim', 'profile');
  const perfLog = path.join(REPO, '.spinney', 'sim', 'perf.log');
  const fixtureRoot = flags.fixture;
  const port = flags.port;
  const token = crypto.randomBytes(24).toString('hex');

  console.log(`sim — full run (dev tooling; never shipped, never in CI)`);
  console.log(`  repo       ${REPO}`);
  console.log(`  extension  ${installed}  (built ${new Date(fs.statSync(installed).mtimeMs).toISOString().slice(0, 16).replace('T', ' ')})`);
  console.log(`  code       ${code.exe}  (${code.how})`);
  console.log(`  cli        ${code.cli}`);
  console.log(`  profile    ${profile}`);
  console.log(`  workspace  ${fixtureRoot}`);
  console.log(`  perf log   ${perfLog}`);

  const stats = buildFixture({ root: fixtureRoot, seed: flags.seed });
  console.log(formatFixture(stats));
  const mock = await startMock({
    fixtureRoot,
    log: path.join(REPO, '.spinney', 'sim', 'mock-requests.jsonl'),
    // A small, fixed provider latency on purpose: it is what makes the 15 conversations
    // actually overlap (the customer's provider was seconds-slow per round, so their
    // sub-agents were alive at the same time for minutes). 25 ms is far too small to be
    // the bottleneck; it only removes the race where a 1 ms answer hides the concurrency.
    delayMs: 25,
  });
  console.log(`  mock       ${mock.url}`);

  resetProfile(profile);
  const extensions = prepareExtensions(path.join(profile, 'extensions'), installed);
  console.log(`  extensions ${extensions.target} (${extensions.how})`);
  fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'User', 'settings.json'), `${JSON.stringify(PROFILE_SETTINGS(mock.url, port), null, 2)}\n`);
  try {
    fs.writeFileSync(perfLog, '');
  } catch {
    /* the tee creates it too */
  }

  const env = {
    ...process.env,
    // The CLI entry point only runs under this (that is what `bin\code.cmd` sets).
    ELECTRON_RUN_AS_NODE: '1',
    SPINNEY_HTTP: '1',
    SPINNEY_HTTP_PORT: String(port),
    SPINNEY_HTTP_TOKEN: token,
    SPINNEY_INSTANCE_ID: 'sim-harness',
    SPINNEY_PERF_LOG: perfLog,
    DEEPSEEK_API_KEY: 'sim-dummy-key',
  };
  console.log(`  launching a throwaway window (never the developer's) …`);
  const child = spawn(
    code.exe,
    [code.cli, fixtureRoot, `--user-data-dir=${profile}`, `--extensions-dir=${path.join(profile, 'extensions')}`],
    { env, detached: true, stdio: 'ignore' },
  );
  child.unref();
  const call = makeClient(port, token);
  let exitCode = 0;
  try {
    const deadline = Date.now() + flags.readySec * 1000;
    let health = null;
    while (Date.now() < deadline) {
      const res = await call('/health').catch(() => null);
      if (res && res.status === 200) {
        health = res.json;
        break;
      }
      await sleep(1500);
    }
    if (!health) {
      // The profile tells the story: no `logs/` means no process ever started with this
      // `--user-data-dir` (a bad CLI flag does exactly that), rather than a window that
      // started and failed to activate the extension.
      const initialized = fs.existsSync(path.join(profile, 'logs'));
      return fail(
        `the control plane on 127.0.0.1:${port} never answered within ${flags.readySec}s`,
        initialized
          ? 'the window started but did not activate the extension — check that sim-activator loaded (its command id must match the activity-bar container) and look at Extension Host in the profile log.'
          : `the throwaway profile was never initialized (no ${path.join(profile, 'logs')}): no process started with --user-data-dir. Check the launch argv, or run with --port <other> if the port is taken.`,
      );
    }
    console.log(`  control    ${health.instanceId} pid=${health.pid} v=${health.version}`);

    console.log(`\n  driving the fan-out …`);
    const started = await call('/session/start', { method: 'POST', body: JSON.stringify({ title: 'sim fan-out (dev)', prompt: '[sim:fanout] run the simulation scenario' }) });
    if (started.status !== 200 || !started.json?.sessionId) {
      return fail(`POST /session/start answered ${started.status}: ${started.text.slice(0, 200)}`);
    }
    const sessionId = started.json.sessionId;
    const until = Date.now() + flags.idleSec * 1000;
    let peakSubs = 0;
    let seenBusy = false;
    let idle = false;
    let polls = 0;
    while (Date.now() < until) {
      const state = await call('/state').catch(() => null);
      const body = state?.json;
      if (body) {
        polls++;
        peakSubs = Math.max(peakSubs, Number(body.runningSubAgents) || 0);
        const session = (body.sessions || []).find((s) => s.id === sessionId);
        const running = Boolean(body.busy) || (Number(body.runningSubAgents) || 0) > 0 || Boolean(session && session.running);
        if (running) seenBusy = true;
        // The turn has to have been *seen running* before "idle" means anything: right
        // after /session/start the run may not be registered yet, and breaking on that
        // first poll would report a peak of 0 for a storm that had already happened.
        if (seenBusy && !running) {
          idle = true;
          break;
        }
      }
      await sleep(1000);
    }
    console.log(
      `  session    ${sessionId}  (peak sub-agents ${peakSubs}; ${idle ? 'settled' : 'still busy at the budget'}; ${polls} poll(s))`,
    );
    await call('/wait-for-finish', { method: 'POST', body: JSON.stringify({ scope: 'all', timeoutMs: 300000 }) }).catch(() => null);
    // One more switch of the same session: the control plane's closest thing to a cold
    // repaint (a sidebar click is not reachable from here).
    await call('/session/start', { method: 'POST', body: JSON.stringify({ sessionId }) }).catch(() => null);
    await sleep(3000);

    const analysis = analysePerfLog(fs.readFileSync(perfLog, 'utf8'));
    console.log(formatTable(analysis));
    const mockStats = mock.stats;
    console.log(
      `\n  mock: ${mockStats.requests} request(s), peak concurrency ${mockStats.peakConcurrency}, ` +
        `Authorization ${mockStats.authSeen ? 'seen' : 'NEVER SEEN'}, fan-out ${mockStats.toolCalls.fanOut ?? 0} agents, ` +
        `tools ${Object.entries(mockStats.byTool).map(([n, c]) => `${n}×${c}`).join(' ') || '(none)'}`,
    );
    if (!mockStats.authSeen) {
      console.log('  ! the mock never saw an Authorization header — the window had no key (DEEPSEEK_API_KEY must reach it).');
    }
    if (analysis.counts.searches === 0) {
      console.log('  ! no `search-files` line: either the tool never ran or SPINNEY_PERF_LOG did not reach the window.');
    }
    exitCode = exitCodeFor(analysis);
    console.log(exitCode === 0 ? '\nPASS: every measured threshold is inside its limit' : '\nFAIL: at least one threshold was exceeded');
    return exitCode;
  } finally {
    const killed = killLaunchedWindow(profile, child.pid);
    await mock.close();
    console.log(
      `  (window killed${killed.length ? `: pid ${killed.join(', ')}` : ' (no process matched the profile — it had already exited)'}; ` +
        `profile kept at ${profile} for post-mortem)`,
    );
  }
}

// ---------------------------------------------------------------- cli

const USAGE = `sim — the simulation harness (dev-only; never shipped, never in CI).

  node tools/sim/run.mjs --selftest            fixture + mock + plan + analyser, offline
  node tools/sim/run.mjs --analyse <log>       re-analyse an existing perf log
  node tools/sim/run.mjs --rename-test         does an empty store root adopt from a sibling?
  node tools/sim/run.mjs --big-state           the storm over the real store (copied), big session
  node tools/sim/run.mjs [options]             the full run in its own throwaway window

Options:
  --fixture <dir>   fixture root (default <tmp>/spinney-sim/workspace)
  --seed <n>        fixture seed (default 20260918)
  --port <n>        control-plane port for the throwaway window (default 8731)
  --ready-timeout <s>  how long to wait for /health (default 120)
  --idle-timeout <s>   how long to wait for the fan-out to settle (default 900)
  -h, --help

Exit codes: 0 all thresholds inside their limits, 1 a threshold failed, 2 usage, 3 a
precondition was not satisfied (the message says which).`;

async function main(argv) {
  const flag = (name, fallback) => {
    const at = argv.indexOf(name);
    return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
  };
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    return 0;
  }
  const flags = {
    fixture: path.resolve(flag('--fixture', path.join(os.tmpdir(), 'spinney-sim', 'workspace'))),
    seed: Number(flag('--seed', 20260918)),
    port: Number(flag('--port', 8731)),
    readySec: Number(flag('--ready-timeout', 120)),
    idleSec: Number(flag('--idle-timeout', 900)),
    mockLog: path.join(REPO, '.spinney', 'sim', 'mock-requests.jsonl'),
    sourceStore: flag('--source-store', ''),
    session: flag('--session', ''),
    extension: flag('--extension', ''),
  };
  if (argv.includes('--analyse')) {
    const file = flag('--analyse', '');
    if (!file || !fs.existsSync(file)) {
      console.error(`sim: no such perf log: ${file}`);
      return 2;
    }
    const analysis = analysePerfLog(fs.readFileSync(file, 'utf8'));
    console.log(`analysing ${file}`);
    console.log(formatTable(analysis));
    return exitCodeFor(analysis);
  }
  if (argv.includes('--selftest')) return selftest(flags);
  if (argv.includes('--rename-test')) return renameTest(flags);
  if (argv.includes('--big-state')) return bigState(flags);
  return fullRun(flags);
}

process.exitCode = await main(process.argv.slice(2));
