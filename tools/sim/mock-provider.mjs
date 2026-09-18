/*
 * mock-provider.mjs — a scripted DeepSeek-compatible endpoint for the simulation harness.
 *
 * DEV-ONLY (`.vscodeignore` drops `tools/**`), never runs in CI, no tokens, no real
 * network: it listens on 127.0.0.1 and answers from a fixed script.
 *   node tools/sim/mock-provider.mjs [--port <n>] [--log <file>] [--fixture <dir>] [--delay <ms>]
 *
 * WHAT IT REPRODUCES
 *   The load that produced the customer's symptoms: a session whose main agent runs
 *   whole-tree searches over a big multi-component workspace, then fans out **15
 *   read-only sub-agents**, each of which runs its own whole-tree searches. The scripts
 *   are chosen to hit the two worst shapes: a hit-heavy scan that must complete
 *   (`capped=none`) and a **hitless** whole-tree scan, which is the case that cost up to
 *   17.6 s each in the customer's log.
 *
 * WHY IT IS SHAPED THIS WAY
 *   - The round index is derived from the request itself — the number of assistant
 *     messages carrying `tool_calls` — so the mock is stateless and can serve 15
 *     concurrent conversations without bookkeeping (each sub-agent counts its own
 *     rounds).
 *   - The main agent and a sub-agent are told apart by the advertised tool list: only the
 *     main agent gets `hop_session` (`SessionRuntime` calls `setCanHop(true)` for it and
 *     never for a sub-agent), so a fan-out round can never be replayed into a child and
 *     recursion stays one level deep.
 *   - A request that advertises **no tools** is always answered with a plain message:
 *     a session-title or summary completion can never be fed a tool call.
 *   - It must never be the bottleneck: answers are written as fast as the socket takes
 *     them (`--delay` is for deliberately overlapping requests in `--selftest`).
 *
 * THE REQUEST LOG (JSONL, one line per request, written when the response closes)
 *   { seq, method, path, kind, auth, bytes, start, end, ms, concurrency, stream, round,
 *     tool, agents }
 *   `auth` is a boolean — whether an `Authorization` header was present. The header's
 *   value is never recorded.
 *
 * ONE-TIME PRECONDITIONS
 *   None for this file. The window it serves is launched by tools/sim/run.mjs; a missing
 *   API key in that window shows up here as `auth: false` on every request.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEVER_MATCHES, SEARCH_TOKEN } from './fixture.mjs';

/** The harness's own marker so a log line is self-explaining. */
export const SIM_MODEL = 'sim-model';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : '')).join(' ');
  }
  return '';
}

/** Every text fragment of a request, tool arguments included. */
function requestText(body) {
  const parts = [];
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    parts.push(textOf(message?.content));
    for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
      parts.push(String(call?.function?.name ?? ''), String(call?.function?.arguments ?? ''));
    }
  }
  return parts.join('\n');
}

/**
 * Assistant messages that carried tool calls **since this conversation's simulation prompt**:
 * the round index.
 *
 * Counting from the start of the request would be wrong for the case this harness most needs
 * — a fan-out driven *inside an existing session*, whose history already holds hundreds of
 * tool-call rounds. The first measured big-state run answered `round: 403` and the storm never
 * happened: the mock thought the plan was long over. The marker in the prompt ("[sim:fanout]",
 * "[sim:sub NN]") is the start of the simulated conversation; a request without one counts
 * from the beginning, as before.
 */
function roundIndex(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = textOf(messages[i]?.content);
    if (text.includes('[sim:fanout]') || /\[sim:sub \d+\]/.test(text)) {
      start = i + 1;
      break;
    }
  }
  let rounds = 0;
  for (let i = start; i < messages.length; i++) {
    const message = messages[i];
    if (message && message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) rounds++;
  }
  return rounds;
}

function toolNames(body) {
  return (Array.isArray(body?.tools) ? body.tools : []).map((tool) => tool?.function?.name).filter(Boolean);
}

/**
 * The fixture path a sub-agent should search. **Not** parsed out of the request: the
 * sub-agent's instruction does carry it, but a conversation accumulates earlier tool
 * results, and the fixture's own generated lines contain backticks (`doc` files look like
 * ``- `t_123` — …``), so a text extraction greedily swallows result lines and produces an
 * invalid path — which is exactly how the first measured storm ended up exercising nothing
 * (`Error: no such file or directory: <path> — …`, 30 wasted calls). The mock knows where
 * the fixture is; it says so.
 */
function searchPathFrom(_body, fallback) {
  return fallback;
}

/** The 15 fan-out instructions, each naming itself and the fixture. */
export function subAgentSpecs(fixtureRoot) {
  const components = ['chart-engine', 'cjk-typography', 'vendor-tables'];
  return Array.from({ length: 15 }, (_, i) => ({
    // `write` is REQUIRED by `spawn_agents`, and `false` is what makes each child a
    // read-only sub-agent (the shape the customer's storm used).
    write: false,
    instruction:
      `[sim:sub ${String(i).padStart(2, '0')}] Read-only investigation of the ${components[i % components.length]} ` +
      `component. Run one whole-tree search_files for \`${SEARCH_TOKEN}\` under \`${fixtureRoot}\` (no glob, default ` +
      `maxResults), then one for \`${NEVER_MATCHES}\`, then read \`README.md\` there, then reply with the match count in one line.`,
  }));
}

/**
 * Pick this request's answer.
 *
 * @returns {{round:number, tool:{name:string,args:object}|null, text:string, note:string}}
 */
export function chooseReply(body, fixtureRoot) {
  const names = toolNames(body);
  const round = roundIndex(body);
  if (names.length === 0) {
    return { round, tool: null, text: 'sim: ok', note: 'no tools advertised — never a tool call' };
  }
  const isMain = names.includes('hop_session');
  const text = requestText(body);
  const isSub = /\[sim:sub \d+\]/.test(text);
  const root = searchPathFrom(body, fixtureRoot);
  if (isMain) {
    const main = [
      { tool: { name: 'search_files', args: { pattern: SEARCH_TOKEN, path: root, maxResults: 300 } }, note: 'main 1: hit-heavy whole-tree scan' },
      { tool: { name: 'search_files', args: { pattern: NEVER_MATCHES, path: root } }, note: 'main 2: hitless whole-tree scan (the expensive case)' },
      { tool: { name: 'read_file', args: { path: 'README.md' } }, note: 'main 3: one small read' },
      // `spawn_agents` is the MAIN agent's tool; `spawn_readonly_agents` belongs to a
      // read-only parent spawning depth-2 children and is refused here
      // (`Error: this agent may not spawn sub-agents …`, measured).
      { tool: { name: 'spawn_agents', args: { agents: subAgentSpecs(root), mode: 'sync' } }, note: 'main 4: fan out 15 read-only sub-agents' },
    ];
    const step = main[round];
    if (step) return { round, tool: step.tool, text: '', note: step.note };
    return { round, tool: null, text: 'sim: fan-out complete.', note: 'main closing answer' };
  }
  const sub = isSub ? [
    { tool: { name: 'search_files', args: { pattern: SEARCH_TOKEN, path: root, maxResults: 300 } }, note: 'sub 1: whole-tree scan' },
    { tool: { name: 'search_files', args: { pattern: NEVER_MATCHES, path: root } }, note: 'sub 2: hitless whole-tree scan' },
    { tool: { name: 'read_file', args: { path: 'README.md' } }, note: 'sub 3: one small read' },
  ] : main.slice(0, 3);
  const step = sub[round];
  if (step) return { round, tool: step.tool, text: '', note: step.note };
  return { round, tool: null, text: 'sim: sub-agent report complete.', note: 'sub closing answer' };
}

function sseChunks(reply, model, seq) {
  const base = { id: `sim-${seq}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model };
  const chunks = [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }];
  if (!reply.tool) {
    const text = reply.text || 'sim: ok';
    const half = Math.max(1, Math.floor(text.length / 2));
    for (const piece of [text.slice(0, half), text.slice(half)].filter(Boolean)) {
      chunks.push({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
    }
  } else {
    const args = JSON.stringify(reply.tool.args);
    // The client accumulates by index: the name arrives once, the arguments in pieces.
    chunks.push({
      ...base,
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: `sim_call_${seq}`, type: 'function', function: { name: reply.tool.name, arguments: '' } }] },
          finish_reason: null,
        },
      ],
    });
    const half = Math.max(1, Math.floor(args.length / 2));
    for (const piece of [args.slice(0, half), args.slice(half)].filter(Boolean)) {
      chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] }, finish_reason: null }] });
    }
  }
  chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: reply.tool ? 'tool_calls' : 'stop' }] });
  chunks.push({ ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  return chunks;
}

function jsonBody(reply, model, seq) {
  const message = { role: 'assistant', content: reply.tool ? null : reply.text || 'sim: ok' };
  if (reply.tool) {
    message.tool_calls = [{ id: `sim_call_${seq}`, type: 'function', function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } }];
  }
  return {
    id: `sim-${seq}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: reply.tool ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

/**
 * Start the mock. Everything is optional.
 *
 * @returns {Promise<{port:number,url:string,logFile:string,stats:object,entries:Function,close:Function}>}
 */
export async function startMock(options = {}) {
  const logFile = path.resolve(options.log || path.join(process.cwd(), '.spinney', 'sim', 'mock-requests.jsonl'));
  const fixtureRoot = options.fixtureRoot || path.join(process.cwd(), '.spinney', 'sim', 'workspace');
  const delayMs = Number(options.delayMs) || 0;
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  try {
    fs.writeFileSync(logFile, '');
  } catch {
    /* append-only is fine too */
  }

  const stats = { requests: 0, peakConcurrency: 0, authSeen: false, authMissing: 0, streamed: 0, sync: 0, aborted: 0, byTool: {}, toolCalls: {} };
  let inflight = 0;
  let seq = 0;

  const log = (entry) => {
    try {
      fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
    } catch {
      /* never let a log break a response */
    }
  };
  const json = (res, status, payload) => {
    const text = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      const parts = [];
      req.on('data', (chunk) => parts.push(chunk));
      req.on('end', () => resolve(Buffer.concat(parts)));
      req.on('error', () => resolve(Buffer.concat(parts)));
    });

  const server = http.createServer(async (req, res) => {
    const entry = {
      seq: ++seq,
      method: req.method,
      path: req.url,
      auth: Boolean(req.headers.authorization),
      bytes: 0,
      start: Date.now(),
      startedAt: new Date().toISOString(),
      concurrency: ++inflight,
    };
    stats.requests++;
    stats.peakConcurrency = Math.max(stats.peakConcurrency, entry.concurrency);
    if (entry.auth) stats.authSeen = true;
    else stats.authMissing++;
    let logged = false;
    const finishLog = (aborted) => {
      if (logged) return;
      logged = true;
      entry.end = Date.now();
      entry.ms = entry.end - entry.start;
      entry.aborted = aborted === true;
      if (entry.aborted) stats.aborted++;
      inflight--;
      log(entry);
    };
    res.on('close', () => finishLog(!res.writableEnded));

    const url = String(req.url || '/').split('?')[0];
    let body = {};
    try {
      const raw = await readBody(req);
      entry.bytes = raw.length;
      if (raw.length) body = JSON.parse(raw.toString('utf8'));
    } catch {
      entry.parseError = true;
    }

    if (req.method === 'GET' && url.endsWith('/user/balance')) {
      entry.kind = 'balance';
      json(res, 200, { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '100.00', granted_balance: '100.00', topped_up_balance: '0.00' }] });
      finishLog(false);
      return;
    }
    if (req.method === 'GET' && url.endsWith('/__sim/stats')) {
      entry.kind = 'stats';
      json(res, 200, { ...stats, inflight, logFile, fixtureRoot });
      finishLog(false);
      return;
    }
    if (req.method === 'POST' && url.endsWith('/chat/completions')) {
      const reply = chooseReply(body, fixtureRoot);
      entry.round = reply.round;
      entry.note = reply.note;
      entry.stream = body.stream === true;
      entry.tool = reply.tool ? reply.tool.name : null;
      if (reply.tool) {
        stats.byTool[reply.tool.name] = (stats.byTool[reply.tool.name] ?? 0) + 1;
        if (Array.isArray(reply.tool.args?.agents)) stats.toolCalls.fanOut = Math.max(stats.toolCalls.fanOut ?? 0, reply.tool.args.agents.length);
      }
      if (delayMs > 0) await sleep(delayMs);
      if (!entry.stream) {
        entry.kind = 'chat-sync';
        stats.sync++;
        json(res, 200, jsonBody(reply, body.model || SIM_MODEL, entry.seq));
        finishLog(false);
        return;
      }
      entry.kind = 'chat-stream';
      stats.streamed++;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      for (const chunk of sseChunks(reply, body.model || SIM_MODEL, entry.seq)) {
        if (res.writableEnded) break;
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      if (!res.writableEnded) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
      finishLog(false);
      return;
    }
    entry.kind = 'unknown';
    json(res, 404, { error: { message: `sim mock: unknown route ${url}`, type: 'invalid_request_error' } });
    finishLog(false);
  });
  server.keepAliveTimeout = 300_000;
  server.requestTimeout = 0;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(options.port) || 0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  let closed = false;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    logFile,
    stats,
    entries() {
      try {
        return fs
          .readFileSync(logFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (name, fallback) => {
    const at = argv.indexOf(name);
    return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
  };
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log('usage: node tools/sim/mock-provider.mjs [--port <n>] [--log <file>] [--fixture <dir>] [--delay <ms>]');
  } else {
    const mock = await startMock({
      port: flag('--port', 0),
      log: flag('--log', undefined),
      fixtureRoot: flag('--fixture', undefined),
      delayMs: flag('--delay', 0),
    });
    console.log(`mock-provider: ${mock.url} (log ${mock.logFile})`);
    const stop = () => {
      void mock.close().then(() => process.exit(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }
}
