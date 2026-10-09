/*
 * check-continue — the transparent-retry / resume work, as a build-time guard.
 *
 * A transient model-call failure must not become visible in the model's own
 * conversation. `Agent.runTurn` (src/agent/agent.ts) puts a **turn-level ladder** on
 * top of the client's unchanged per-request one (`MAX_ATTEMPTS` in apiClient.ts still
 * applies, inside each of these): one turn may make at most `TRANSPARENT_ATTEMPTS`
 * (3) further WHOLE-REQUEST re-issues within a `TRANSPARENT_BUDGET_MS` (6 min)
 * wall-clock budget. During the ladder the history is re-sent **exactly as it
 * stands** and NOTHING is said to the model:
 *
 *   - a failed request that streamed nothing leaves the history byte-identical;
 *   - a failed request that had already streamed leaves that output behind as the
 *     model's own assistant message (a checkpoint: no `tool_calls`,
 *     `content || reasoning`, and `reasoning_content` kept whenever there was
 *     reasoning — thinking mode refuses a content-only message) and
 *     still adds no user message;
 *   - when the ladder is spent the failure surfaces exactly as it always did (an
 *     `error` event → the ⚠️ item, `node.status='error'`, the retry button) — the
 *     user sees it, the model does not.
 *
 * The rollback on a non-interrupt error **and** on an interrupt drops only the
 * INCOMPLETE tail (it delegates to the existing `Agent.sanitizeMessages`), so the
 * tool rounds a turn had already COMPLETED survive it. That is the point of the whole
 * change, and it is why the resume paths (the ▶ Continue / ↻ Retry button, through the
 * new `Agent.resumeTurn(): string | undefined`) can say nothing at all: the history is
 * already the truth. The one exception is a tool call stranded by a Stop, which
 * produces exactly one pure-fact user message
 * (`[Harness] Your previous <…> was cut off and did not finish; do not assume it
 * completed.`). A user who presses Stop and then TYPES a new prompt keeps the old
 * `buildInterruptNotice` wording — which is why the two helpers that used to speak for
 * a failure (`CONTINUE_MESSAGE` / `buildFailureContinue`) are asserted gone from `src/`
 * below.
 *
 * None of this is observable without a provider, and all of it is invisible until a
 * connection breaks: a wrong rollback re-sends a tool window the API rejects, and a
 * ladder that narrated its failures would corrupt the very prefix the prompt cache
 * depends on (`docs/agents/invariants/api-retries.md`). So the guard drives the REAL
 * `Agent` (`out/agent/agent.js`) against a minimal stub client — no network, no
 * window — and awaits each turn by resolving a promise from the `onEvent` hook on
 * `done` / `error` / `interrupted`.
 *
 * `agent.js` imports `vscode`, so it is loaded through a `Module._load` stub — the
 * same idiom `tools/rollover-acceptance.js` uses to reach a provider-owned module.
 *
 * Needs `out/` (run `npm run compile` first).
 *
 * Run: npm run check:continue   /   node tools/check-continue.js
 */
const fs = require('fs');
const Module = require('module');
const path = require('path');

const root = path.resolve(__dirname, '..');

// --- the vscode stub (agent.js imports it) ------------------------------------

const vscodeStub = {
  l10n: { t: (text, ...args) => String(text).replace(/\{(\d+)\}/g, (_, i) => String(args[i] ?? '')) },
  env: { language: 'en' },
  window: {
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {}, clear() {} }),
  },
  workspace: {
    getConfiguration: () => ({ get: () => undefined, has: () => false, update: async () => undefined }),
    workspaceFolders: [],
  },
  Uri: { file: (p) => ({ fsPath: p, scheme: 'file', toString: () => String(p) }) },
  EventEmitter: class {
    constructor() {
      this.event = () => ({ dispose() {} });
    }
    fire() {}
    dispose() {}
  },
  Disposable: class {
    constructor(fn) {
      this.fn = fn;
    }
    dispose() {
      this.fn && this.fn();
    }
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { One: 1, Active: -1, Beside: 2 },
  extensions: { getExtension: () => undefined },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

// --- the compiled halves under test -------------------------------------------

const agentPath = path.join(root, 'out', 'agent', 'agent.js');
if (!fs.existsSync(agentPath)) {
  console.log('FAIL check-continue: out/agent/agent.js is missing — run `npm run compile` first.');
  process.exit(1);
}
const A = require(agentPath);
const { ApiError, isRetriableStatus } = require(path.join(root, 'out', 'agent', 'apiClient.js'));

const problems = [];
const ok = (label, cond, detail) => {
  if (cond) console.log(`  [ok  ] ${label}${detail ? '  (' + detail + ')' : ''}`);
  else {
    console.log(`  [FAIL] ${label}${detail ? '  (' + detail + ')' : ''}`);
    problems.push(label);
  }
};
const note = (text) => console.log(`  [note] ${text}`);

const clone = (value) => JSON.parse(JSON.stringify(value));
const json = (value) => JSON.stringify(value);
const roles = (messages) => messages.map((m) => m.role).join(',');
const userCount = (messages) => messages.filter((m) => m.role === 'user').length;
const eventSummary = (events) =>
  events.map((e) => (e.type === 'retry' ? `retry(${e.attempt}/${e.max})` : e.type)).join(',') || '(none)';

/** The marker every stub failure carries, so "the model was told nothing" is provable. */
const FAIL_TOKEN = 'stub-transient-failure';

/** One deterministic model card: no provider, no catalog, no key. */
const CARD = {
  id: 'guard-card',
  name: 'guard-model',
  providerId: 'guard-provider',
  oaiModel: 'guard-model',
  contextWindow: 1_048_576,
  vision: { enabled: false, transport: 'openai' },
  efforts: ['none', 'medium'],
  defaultEffort: 'medium',
  concurrency: 0,
};

// --- the stub client, the stub tool set, and the driver ------------------------

const chunk = (delta) => ({ choices: [{ index: 0, delta }] });

/** A request that fails at once, streaming nothing: what the turn's ladder sees. */
const stepFail = (status) => async function* () {
  throw new ApiError(`${FAIL_TOKEN} (${status})`, status);
};

/** A request that streams partials and only then fails: the ladder has a checkpoint. */
const stepPartialThenFail = (status, { text = '', reasoning = '' } = {}) => async function* () {
  if (reasoning) yield chunk({ reasoning_content: reasoning });
  if (text) yield chunk({ content: text });
  throw new ApiError(`${FAIL_TOKEN} after streaming (${status})`, status);
};

/** A round that answers with a tool call, so the turn continues into another round. */
const stepToolCall = (id, name, args) => async function* () {
  yield chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] });
};

/** A round that answers with text and no tool call: the turn is done. */
const stepAnswer = (text) => async function* () {
  yield chunk({ content: text });
};

/** A stream the user stops halfway: the partial text is all this round produced. */
const stepAbortAfterText = (text) => async function* (agent) {
  yield chunk({ content: text });
  agent.cancel();
};

/** A stream the user stops with a tool call drafted and unfinished: it is stranded. */
const stepAbortAfterToolCall = (id, name, args) => async function* (agent) {
  yield chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] });
  agent.cancel();
};

/** Stop pressed while the request is failing: the ladder must not re-issue. */
const stepAbortThenFail = (status) => async function* (agent) {
  agent.cancel();
  throw new ApiError(`${FAIL_TOKEN} while stopped (${status})`, status);
};

/**
 * One driver: the stub client a turn talks to, the tool set it sees, and everything a
 * check reads back — what every request carried (byte for byte), what the agent
 * reported, and which tools the registry was asked to run.
 *
 * The stub answers from a queued list, one entry per request, and the **last** entry
 * repeats: `answer(stepFail(503))` alone means "every request fails", while
 * `answer(stepToolCall(...)).answer(stepFail(503))` means "the first round works, the
 * second one never does". A step is an async generator, so it can stream deltas, throw
 * a transient `ApiError`, or press Stop on the agent halfway through.
 *
 * The history starts as one `system` message: the real system prompt is a page of text
 * that would drown the byte comparisons below, and nothing in this guard reads it.
 */
function driver() {
  const calls = [];
  const queue = [];
  const events = [];
  const executed = [];
  let settleNow = null;
  let settled = false;

  const stub = {
    calls,
    queue,
    agent: null,
    /** Answer the next request with `factory` (`answer` chains; the last one repeats). */
    answer(factory) {
      queue.push(factory);
      return stub;
    },
    async *stream(card, request) {
      calls.push({ messages: clone(request.messages), card });
      const factory = queue.length > 0 ? queue[Math.min(calls.length - 1, queue.length - 1)] : stepFail(500);
      yield* factory(stub.agent);
    },
    async upload() {
      throw new Error('check-continue: no image is uploaded in this guard');
    },
  };

  const tools = {
    definitions: [],
    async execute(name) {
      executed.push(name);
      return 'ok';
    },
  };

  const agent = new A.Agent(stub, tools, (event) => {
    events.push(event);
    if (event.type === 'done' || event.type === 'error' || event.type === 'interrupted') {
      settled = true;
      const wake = settleNow;
      settleNow = null;
      if (wake) wake();
    }
  });
  agent.setCard(CARD);
  agent.setMessages([{ role: 'system', content: 'sys' }]);
  stub.agent = agent;

  /**
   * Await the next terminal event, or give up after `timeoutMs`: a turn that never
   * ends is a failure of its own, and the guard must not hang on it.
   */
  async function settle(timeoutMs = 2000) {
    if (!settled) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          settleNow = null;
          resolve();
        }, timeoutMs);
        settleNow = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    const outcome = settled ? 'settled' : 'timeout';
    settled = false;
    return outcome;
  }

  return { stub, agent, events, executed, settle };
}

/** `resumeTurn()` behind a guard: a missing method is a reported failure, not a crash. */
function callResumeTurn(agent) {
  if (typeof agent.resumeTurn !== 'function') {
    return { missing: true, value: undefined };
  }
  try {
    return { missing: false, value: agent.resumeTurn() };
  } catch (err) {
    return { missing: false, value: undefined, threw: err && err.message };
  }
}

// --- the checks ---------------------------------------------------------------

async function main() {
  // ---- (1) a failure that streamed nothing ----------------------------------
  console.log('-- (1) a transient failure that streamed nothing says nothing to the model --');
  {
    const d = driver();
    d.stub.answer(stepFail(503));
    const from = d.events.length;
    d.agent.sendUserMessage('do the thing');
    const outcome = await d.settle();
    const events = d.events.slice(from);
    const carried = d.stub.calls.length > 0 ? d.stub.calls[0].messages : [];
    const history = d.agent.getMessages();

    ok('the turn ends once the ladder is spent', outcome === 'settled' && events.some((e) => e.type === 'error'), eventSummary(events));
    ok(
      'the failure surfaces as ONE `error` event and not as a `done`',
      events.filter((e) => e.type === 'error').length === 1 && !events.some((e) => e.type === 'done'),
      eventSummary(events),
    );
    ok(
      'the request was re-issued exactly TRANSPARENT_ATTEMPTS times',
      events.filter((e) => e.type === 'retry').length === A.TRANSPARENT_ATTEMPTS &&
        d.stub.calls.length === 1 + A.TRANSPARENT_ATTEMPTS,
      `${d.stub.calls.length} request(s), ${eventSummary(events)}`,
    );
    ok('the history is byte-identical to what the request carried', json(history) === json(carried), roles(history) || '(empty)');
    ok(
      '  … and so was every re-issue (nothing was added between attempts)',
      d.stub.calls.length > 1 && d.stub.calls.every((c) => json(c.messages) === json(carried)),
      `${d.stub.calls.length} request(s)`,
    );
    ok('no message of the history mentions the failure', !json(history).includes(FAIL_TOKEN), roles(history));
  }

  // ---- (2) a failure after output had streamed ------------------------------
  console.log('-- (2) a failure after output had streamed leaves ONE checkpoint and no user message --');
  {
    const d = driver();
    d.stub.answer(stepPartialThenFail(503, { reasoning: 'thinking hard', text: 'half an answer' })).answer(stepFail(503));
    d.agent.sendUserMessage('the ask');
    const outcome = await d.settle();
    const carried = d.stub.calls.length > 0 ? d.stub.calls[0].messages : [];
    const history = d.agent.getMessages();
    const added = history.slice(carried.length);

    ok('the turn ends in the `error` the user sees', outcome === 'settled' && d.events.some((e) => e.type === 'error'), eventSummary(d.events));
    ok('the history gained exactly one message', added.length === 1, `${added.length} message(s): ${json(added)}`);
    ok('  … it is an assistant message', added.length === 1 && added[0].role === 'assistant', roles(history));
    ok('  … carrying the streamed content', added.length === 1 && added[0].content === 'half an answer', json(added[0]));
    ok('  … with NO tool_calls', added.length === 1 && added[0].tool_calls === undefined, json(added[0]));
    ok(
      '  … and the reasoning that came with that content',
      added.length === 1 && added[0].reasoning_content === 'thinking hard',
      json(added[0]),
    );
    ok('no user message was added (the model is told nothing)', userCount(history) === userCount(carried), `${userCount(carried)} → ${userCount(history)}`);
    ok('and no message mentions the failure', !json(history).includes(FAIL_TOKEN), roles(history));
    ok(
      'the re-issue re-sent the history as it stood, checkpoint included',
      d.stub.calls.length > 1 && json(d.stub.calls[1].messages) === json(history),
      d.stub.calls.length > 1 ? roles(d.stub.calls[1].messages) : 'the ladder made no re-issue',
    );
  }
  {
    // The other half of the checkpoint rule: reasoning with no answer text yet is
    // mirrored into `content` (an assistant message carrying neither is refused by the
    // API) — and the reasoning **stays** as `reasoning_content`. Thinking mode refuses a
    // content-only message outright (`The reasoning_content in the thinking mode must be
    // passed back to the API.`, a 400), so the mirror may not consume it: one string in
    // both fields is what the provider accepts, and a checkpoint sent without it kills
    // the whole conversation below that node.
    const d = driver();
    d.stub.answer(stepPartialThenFail(503, { reasoning: 'only reasoning' })).answer(stepFail(503));
    d.agent.sendUserMessage('the ask');
    const outcome = await d.settle();
    const carried = d.stub.calls.length > 0 ? d.stub.calls[0].messages : [];
    const added = d.agent.getMessages().slice(carried.length);
    ok(
      'a reasoning-only partial is mirrored into `content`, once',
      outcome === 'settled' && added.length === 1 && added[0].content === 'only reasoning',
      json(added),
    );
    ok(
      '  … and the reasoning it came from is still passed back (thinking mode demands it)',
      added.length === 1 && added[0].reasoning_content === 'only reasoning',
      json(added),
    );
  }
  {
    // What a build that dropped the reasoning left behind: an assistant message with
    // content and no `reasoning_content` — the exact shape the provider answers with a
    // 400. `sanitizeMessages` runs on assembly, so a stored history (and a live session
    // that already hit that 400) is repaired on its next send instead of staying dead.
    const fromOldBuild = A.Agent.sanitizeMessages([
      { role: 'user', content: 'x' },
      // A content-less partial: mirrored into `content` **and** kept as reasoning.
      { role: 'assistant', content: null, reasoning_content: 'kept thinking' },
      // What the old heal produced: the reasoning mirrored, the reasoning itself gone.
      // Nothing can invent it back — the point is only that the shape is not re-created.
      { role: 'assistant', content: 'mirrored thinking', reasoning_content: undefined },
    ]);
    ok(
      'a content-less stored partial is mirrored without losing the reasoning',
      fromOldBuild.length === 3 &&
        fromOldBuild[1].content === 'kept thinking' &&
        fromOldBuild[1].reasoning_content === 'kept thinking',
      json(fromOldBuild),
    );
    ok(
      '  … while a message whose reasoning is already gone is left as it stands',
      fromOldBuild[2].content === 'mirrored thinking' && fromOldBuild[2].reasoning_content === undefined,
      json(fromOldBuild),
    );
  }

  // ---- (3) resumeTurn() with no stranded tool -------------------------------
  console.log('-- (3) resumeTurn() on a node with no stranded tool adds nothing --');
  {
    // (a) the ↻ Retry path: the turn died on an error, so there is no straggler.
    const d = driver();
    d.stub.answer(stepFail(503));
    d.agent.sendUserMessage('the ask');
    await d.settle();
    d.stub.queue.length = 0;
    d.stub.answer(stepAnswer('resumed'));
    const before = json(d.agent.getMessages());
    const callsBefore = d.stub.calls.length;
    const ret = callResumeTurn(d.agent);
    // Read synchronously: a request the resume makes has not answered yet, so this is
    // the history the resume itself decided to send.
    const afterCall = json(d.agent.getMessages());

    ok('Agent.resumeTurn() is implemented', !ret.missing, ret.missing ? 'no `resumeTurn` on the Agent' : (ret.threw ? `threw ${ret.threw}` : 'callable'));
    ok('an error node with no stranded tool gains no message', afterCall === before, `before=${before} after=${afterCall}`);
    ok('  … and resumeTurn() returns undefined (nothing for the host to show)', ret.value === undefined, json(ret.value));

    const outcome = await d.settle();
    const messages = d.agent.getMessages();
    ok(
      'the resumed turn told the model nothing: no user message, no fact line',
      !json(messages).includes('cut off') && userCount(messages) === userCount(JSON.parse(before)),
      `${roles(messages)} · ${eventSummary(d.events.slice(-3))}`,
    );
    if (d.stub.calls.length > callsBefore) {
      ok(
        '  … and the request it made carried the history exactly as it stands',
        json(d.stub.calls[callsBefore].messages) === before,
        roles(d.stub.calls[callsBefore].messages),
      );
      note(`the resume made a request of its own (${outcome})`);
    } else {
      note('resumeTurn() prepared the history without making a request itself — either shape leaves the history untouched');
    }
  }
  {
    // (b) the ▶ Continue path after a Stop that landed while text streamed: the
    // interruption is real, but it stranded no tool call, so there is no fact to state.
    const d = driver();
    d.stub.answer(stepAbortAfterText('partial text'));
    d.agent.sendUserMessage('the ask');
    const outcome = await d.settle();
    ok(
      'a Stop mid-text takes the interrupted path',
      outcome === 'settled' && d.events.some((e) => e.type === 'interrupted'),
      eventSummary(d.events),
    );

    d.stub.queue.length = 0;
    d.stub.answer(stepAnswer('resumed'));
    const before = json(d.agent.getMessages());
    const callsBefore = d.stub.calls.length;
    const ret = callResumeTurn(d.agent);
    const afterCall = json(d.agent.getMessages());

    ok(
      'an interrupted node with no stranded tool gains no message',
      !ret.missing && afterCall === before,
      ret.missing ? 'no `resumeTurn` on the Agent' : `before=${before} after=${afterCall}`,
    );
    ok('  … and returns undefined', ret.value === undefined, json(ret.value));

    await d.settle();
    const messages = d.agent.getMessages();
    ok(
      '  … so the model only sees the checkpoint the Stop already left',
      userCount(messages) === userCount(JSON.parse(before)) && !json(messages).includes('cut off'),
      roles(messages),
    );
    if (d.stub.calls.length > callsBefore) {
      ok(
        '  … and the request carried the history exactly as it stands',
        json(d.stub.calls[callsBefore].messages) === before,
        roles(d.stub.calls[callsBefore].messages),
      );
    }
  }

  // ---- (4) resumeTurn() with a tool call stranded by a Stop ------------------
  console.log('-- (4) resumeTurn() with a tool call stranded by a Stop says one fact line --');
  {
    const d = driver();
    d.stub.answer(stepAbortAfterToolCall('call_stranded', 'write_file', '{"path":"a.md"}'));
    d.agent.sendUserMessage('the ask');
    const outcome = await d.settle();
    ok(
      'the Stop stranded the drafted tool call',
      outcome === 'settled' && d.events.some((e) => e.type === 'interrupted'),
      eventSummary(d.events),
    );

    d.stub.queue.length = 0;
    d.stub.answer(stepAnswer('resumed'));
    const before = clone(d.agent.getMessages());
    const ret = callResumeTurn(d.agent);
    const after = d.agent.getMessages();
    const text = typeof ret.value === 'string' ? ret.value : '';

    ok('resumeTurn() returned the fact line', typeof ret.value === 'string', json(ret.value));
    ok(
      '  … it is the frozen frame',
      text.startsWith('[Harness] Your previous ') &&
        text.endsWith('was cut off and did not finish; do not assume it completed.'),
      json(text),
    );
    ok('  … it says "cut off"', text.includes('cut off'));
    ok('  … and it names the stranded tool', text.includes('write_file'), json(text));
    for (const forbidden of ['discarded', 'fresh input', 'Redo', 'Continue from where you stopped']) {
      ok(`  … and none of ${JSON.stringify(forbidden)}`, !text.includes(forbidden));
    }
    ok(
      'exactly ONE message was added, and it is that user message',
      after.length === before.length + 1 &&
        after[after.length - 1].role === 'user' &&
        after[after.length - 1].content === text,
      roles(after),
    );
    ok('  … so the model is told the fact and nothing else', userCount(after) === userCount(before) + 1, `${userCount(before)} → ${userCount(after)}`);

    await d.settle();
    ok(
      'the resumed turn adds no further user message',
      userCount(d.agent.getMessages()) === userCount(before) + 1,
      `${userCount(d.agent.getMessages())} user message(s)`,
    );
  }

  // ---- (5) the ladder policy is pure and exact ------------------------------
  console.log('-- (5) shouldReissueTransparently is pure and exact --');
  {
    ok('TRANSPARENT_ATTEMPTS is the frozen 3', A.TRANSPARENT_ATTEMPTS === 3, String(A.TRANSPARENT_ATTEMPTS));
    ok('TRANSPARENT_BUDGET_MS is the frozen 6 minutes', A.TRANSPARENT_BUDGET_MS === 6 * 60_000, String(A.TRANSPARENT_BUDGET_MS));
    ok('shouldReissueTransparently is exported', typeof A.shouldReissueTransparently === 'function', typeof A.shouldReissueTransparently);

    const fn = A.shouldReissueTransparently;
    const deadline = 1_000_000;
    const now = deadline - 1;
    const cases = [
      ['a 401 (an auth refusal) is never re-issued', 401, 0, now, deadline, false],
      ['a 400 is never re-issued', 400, 0, now, deadline, false],
      ['a 403 is never re-issued', 403, 0, now, deadline, false],
      ['a 404 is never re-issued', 404, 0, now, deadline, false],
      ['a 422 is never re-issued', 422, 0, now, deadline, false],
      ['no status at all (a network failure) is re-issued', undefined, 0, now, deadline, true],
      ['a 408 is re-issued', 408, 0, now, deadline, true],
      ['a 429 is re-issued', 429, 0, now, deadline, true],
      ['a 500 is re-issued', 500, 0, now, deadline, true],
      ['a 503 is re-issued', 503, 0, now, deadline, true],
      ['reissuesUsed === TRANSPARENT_ATTEMPTS is spent (network)', undefined, A.TRANSPARENT_ATTEMPTS, now, deadline, false],
      [
        'reissuesUsed === TRANSPARENT_ATTEMPTS is spent (transient status too)',
        500,
        A.TRANSPARENT_ATTEMPTS,
        now,
        deadline,
        false,
      ],
      [
        'the last re-issue before the ceiling is still allowed',
        500,
        A.TRANSPARENT_ATTEMPTS - 1,
        now,
        deadline,
        true,
      ],
      ['now > deadline is spent (network)', undefined, 0, deadline + 1, deadline, false],
      ['now > deadline is spent (transient status too)', 503, 0, deadline + 1, deadline, false],
      ['now === deadline is spent (the budget is exclusive)', undefined, 0, deadline, deadline, false],
      ['the last millisecond inside the budget is still allowed', undefined, 0, deadline - 1, deadline, true],
    ];

    if (typeof fn === 'function') {
      const answer = (row) => {
        try {
          return fn(row[1], row[2], row[3], row[4]);
        } catch (err) {
          return `threw: ${err && err.message}`;
        }
      };
      const results = cases.map(answer);
      cases.forEach((row, i) => ok(row[0], results[i] === row[5], `${json(results[i])} (wanted ${json(row[5])})`));
      const reversed = [];
      for (let i = cases.length - 1; i >= 0; i--) {
        reversed[i] = answer(cases[i]);
      }
      ok('  … and it is pure: the same inputs answer the same way, in any order', json(reversed) === json(results));
      ok('  … and an allowed re-issue agrees with the frozen predicate', fn(429, 0, now, deadline) === (0 < A.TRANSPARENT_ATTEMPTS && now < deadline && isRetriableStatus(429)));
    }

    console.log('-- the client half: what "transient" means (`isRetriableStatus`) --');
    ok(
      'a refusal status (400/401/403/404/422) is not retriable',
      [400, 401, 403, 404, 422].every((status) => isRetriableStatus(status) === false),
    );
    ok('408/429/500/503 are retriable', [408, 429, 500, 503].every((status) => isRetriableStatus(status) === true));
  }

  // ---- (6) the ladder stops, and a COMPLETED tool round survives -------------
  console.log('-- (6) the ladder stops after TRANSPARENT_ATTEMPTS, and a completed tool round survives --');
  {
    const d = driver();
    d.stub.answer(stepToolCall('call_round_1', 'read_file', '{"path":"a"}')).answer(stepFail(503));
    const from = d.events.length;
    d.agent.sendUserMessage('read the file');
    const outcome = await d.settle();
    const events = d.events.slice(from);
    const retries = events.filter((e) => e.type === 'retry');
    const messages = d.agent.getMessages();
    const failedRound = d.stub.calls.length > 1 ? d.stub.calls[1].messages : [];

    ok(
      'the first round really completed its tool call',
      d.executed.join(',') === 'read_file' && roles(messages).startsWith('system,user,assistant,tool'),
      `tools: ${d.executed.join(',') || '(none)'} · ${roles(messages)}`,
    );
    ok('the turn ends (the failure is not swallowed)', outcome === 'settled' && events.filter((e) => e.type === 'error').length === 1, eventSummary(events));
    ok(
      `the failing round was re-issued exactly ${A.TRANSPARENT_ATTEMPTS} time(s), then given up on`,
      retries.length === A.TRANSPARENT_ATTEMPTS && d.stub.calls.length === 2 + A.TRANSPARENT_ATTEMPTS,
      `${d.stub.calls.length} request(s) = 1 tool round + 1 attempt + ${retries.length} re-issue(s)`,
    );
    ok(
      '  … and each re-issue counts up 1-based against that ceiling',
      retries.map((e) => e.attempt).join(',') === '1,2,3' && retries.every((e) => e.max === A.TRANSPARENT_ATTEMPTS),
      eventSummary(events),
    );
    ok('no re-issue happened after the ceiling', !events.some((e) => e.type === 'done'), eventSummary(events));
    ok(
      'the COMPLETED tool round is still in the history (only the incomplete tail was dropped)',
      roles(messages) === 'system,user,assistant,tool',
      roles(messages),
    );
    ok(
      '  … with its `tool_calls` block intact',
      messages[2] &&
        Array.isArray(messages[2].tool_calls) &&
        messages[2].tool_calls.length === 1 &&
        messages[2].tool_calls[0].id === 'call_round_1',
      json(messages[2] && messages[2].tool_calls),
    );
    ok(
      '  … and the tool response that answers it',
      messages[3] &&
        messages[3].role === 'tool' &&
        messages[3].tool_call_id === 'call_round_1' &&
        String(messages[3].content).endsWith('ok'),
      json(messages[3]),
    );
    ok(
      'the rollback restored exactly the history the failed request carried',
      d.stub.calls.length > 1 && json(messages) === json(failedRound),
      roles(messages),
    );
    ok(
      '  … and every re-issue re-sent that same history (the model was told nothing)',
      d.stub.calls.slice(1).every((c) => json(c.messages) === json(failedRound)),
      `${d.stub.calls.length - 1} request(s)`,
    );
    ok('the failure added no user message and no failure text', userCount(messages) === 1 && !json(messages).includes(FAIL_TOKEN), roles(messages));
    ok(
      '  … so the surviving history is API-valid as it stands',
      json(A.Agent.sanitizeMessages(messages)) === json(messages),
      'sanitizeMessages(messages) === messages',
    );
  }

  // ---- (7) a Stop during the ladder -----------------------------------------
  console.log('-- (7) a Stop during the ladder takes the INTERRUPTED path and re-issues nothing --');
  {
    const d = driver();
    d.stub.answer(stepAbortThenFail(503));
    d.agent.sendUserMessage('the ask');
    const outcome = await d.settle();
    const events = d.events;
    const carried = d.stub.calls.length > 0 ? d.stub.calls[0].messages : [];

    ok('the turn ends `interrupted`', outcome === 'settled' && events.filter((e) => e.type === 'interrupted').length === 1, eventSummary(events));
    ok('  … and never as an `error`', events.filter((e) => e.type === 'error').length === 0, eventSummary(events));
    ok('no re-issue was made', events.filter((e) => e.type === 'retry').length === 0 && d.stub.calls.length === 1, `${d.stub.calls.length} request(s)`);
    ok('the aborted turn left the history as the request carried it', json(d.agent.getMessages()) === json(carried), roles(d.agent.getMessages()));
    ok('  … and told the model nothing about the failure', !json(d.agent.getMessages()).includes(FAIL_TOKEN));
  }
  {
    // The interrupt path's rollback is narrowed too: a round that finished before the
    // Stop is work the model already paid for, and resuming must not re-run it.
    const d = driver();
    d.stub.answer(stepToolCall('call_round_1', 'read_file', '{"path":"a"}')).answer(stepAbortThenFail(503));
    d.agent.sendUserMessage('read the file');
    const outcome = await d.settle();
    const messages = d.agent.getMessages();
    ok(
      'a Stop after a completed tool round keeps that round',
      outcome === 'settled' && d.events.some((e) => e.type === 'interrupted') && roles(messages) === 'system,user,assistant,tool',
      `${roles(messages)} · ${eventSummary(d.events)}`,
    );
    ok(
      '  … byte-for-byte as the interrupted request carried it',
      d.stub.calls.length > 1 && json(messages) === json(d.stub.calls[1].messages),
      roles(messages),
    );
  }

  // ---- (8) the deleted helpers ----------------------------------------------
  console.log('-- (8) the two deleted continue helpers are gone from src/ --');
  {
    const files = sourceFiles(path.join(root, 'src'));
    ok('the sweep really read src/', files.length > 20, `${files.length} file(s)`);
    const hits = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const needle of ['CONTINUE_MESSAGE', 'buildFailureContinue']) {
        if (text.includes(needle)) {
          hits.push(`${path.relative(root, file)}: ${needle}`);
        }
      }
    }
    ok('neither `CONTINUE_MESSAGE` nor `buildFailureContinue` is left anywhere in src/', hits.length === 0, hits.join('; ') || 'no hits');
  }
}

/** Every file under `dir`, recursively (src/ has no build output and no symlinks). */
function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

main().then(
  () => {
    console.log('');
    if (problems.length) {
      console.log(`FAIL check-continue: ${problems.length} check(s) failed`);
      for (const problem of [...new Set(problems)].slice(0, 12)) {
        console.log('  ' + problem);
      }
      process.exit(1);
    }
    console.log(
      'PASS check-continue: the turn-level ladder re-issues whole requests without telling the model anything, a streamed partial survives as one checkpoint, the rollback drops only the incomplete tail (completed tool rounds survive an error and a Stop), resumeTurn() speaks only the stranded-tool fact, and the old continue helpers are gone from src/',
    );
    process.exit(0);
  },
  (err) => {
    console.log(`FAIL check-continue: the guard itself threw — ${(err && err.stack) || err}`);
    process.exit(1);
  },
);
