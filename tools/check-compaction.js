/*
 * check-compaction — the **handoff summary** of a context rollover, as a build-time
 * guard (`docs/agents/invariants/context-rollover.md` §5a/§6).
 *
 * Why it exists: every rule this feature has lives on a path that costs a request and
 * is invisible until it runs against a real, enormous window. A summary built from the
 * whole chain instead of the window sends a request the window it is summarising could
 * not afford; an unbounded source is a request that cannot fit the new window either;
 * a summary handed over without its headings is a narrative the next agent cannot
 * navigate; and a failure that is not a fallback would block a rollover the user has
 * already confirmed. None of that throws, so nothing else would notice.
 *
 * It drives the **compiled** pure module (`src/agent/compaction.ts`), so it needs `out/`
 * (`npm run compile` first) and it is pure node — no window, no network.
 *
 * Run: npm run check:compaction   /   node tools/check-compaction.js
 */
const path = require('path');
const C = require(path.join(__dirname, '..', 'out', 'agent', 'compaction.js'));

const problems = [];
const ok = (label, cond, detail) => {
  if (cond) console.log(`  [ok  ] ${label}${detail ? '  (' + detail + ')' : ''}`);
  else {
    console.log(`  [FAIL] ${label}${detail ? '  (' + detail + ')' : ''}`);
    problems.push(label);
  }
};

const user = (text) => ({ role: 'user', content: text });
const assistant = (text, toolCalls) => ({
  role: 'assistant',
  content: text,
  ...(toolCalls ? { tool_calls: toolCalls } : {}),
});
const toolResult = (id, content) => ({ role: 'tool', tool_call_id: id, content });
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: args } });

// ---- §1: the selected input is one window, clipped, and never the whole chain --------

console.log('-- the bounds are the documented numbers --');
ok('the input bound is 60000 chars', C.COMPACTION_INPUT_MAX_CHARS === 60000, String(C.COMPACTION_INPUT_MAX_CHARS));
ok('a user message is clipped to 500 chars', C.COMPACTION_USER_CLIP === 500, String(C.COMPACTION_USER_CLIP));
ok('a tool result keeps 200 chars', C.COMPACTION_TOOL_RESULT_CLIP === 200, String(C.COMPACTION_TOOL_RESULT_CLIP));
ok('at most the last 8 assistant texts are kept', C.COMPACTION_LAST_ASSISTANT === 8, String(C.COMPACTION_LAST_ASSISTANT));

console.log('-- the first request verbatim, every request clipped, and the count --');
{
  const first = 'FIRST-REQUEST ' + 'x'.repeat(4000);
  const second = 'SECOND-REQUEST ' + 'y'.repeat(3000);
  const source = C.extractCompactionSource([user(first), assistant('an answer'), user(second)]);
  ok('the window is reported as a fact line', source.text.includes('user messages: 2'), source.text.split('\n')[0]);
  ok('the count is on the source', source.userCount === 2, String(source.userCount));
  ok('the first user message is verbatim (not clipped to 500)', source.text.includes(first), `${first.length} chars`);
  ok(
    'every user message is listed, clipped to 500 chars',
    source.text.includes('SECOND-REQUEST ') && !source.text.includes(second),
    `second is ${second.length} chars`,
  );
  ok('the clip is announced with an ellipsis', source.text.includes('SECOND-REQUEST ' + 'y'.repeat(500 - 15) + '…'));
  const clippedBlock = source.text.split('\n').find((line) => line.startsWith('SECOND-REQUEST ')) ?? '';
  ok('  … and the clipped block is at most 501 chars', clippedBlock.length <= 501, String(clippedBlock.length));
}

console.log('-- harness-authored notices are not user requests --');
{
  const source = C.extractCompactionSource([
    user('[Harness: context window reset]\nThe previous conversation could not be sent …'),
    user('the real request'),
    user('[Harness] Your previous exec_command was cut off and did not finish.'),
  ]);
  ok('a harness note is not counted', source.userCount === 1, String(source.userCount));
  ok(
    'an interrupt notice and a writeback are not requests either',
    C.extractCompactionSource([
      user('[Interruption notice] The user stopped your previous response before it was complete.'),
      user('Background command `npm test` (id 3) finished with exit code 0 after 2s.'),
      user('a real one'),
    ]).userCount === 1,
  );
  ok(
    'the detector names all three openings',
    C.isHarnessAuthored('[Harness…') &&
      C.isHarnessAuthored('[Interruption notice] x') &&
      C.isHarnessAuthored('Background command `x`') &&
      !C.isHarnessAuthored('a real request'),
  );
  ok('  … and the real request is the first one', source.text.includes('First user message (verbatim):\nthe real request'));
}

console.log('-- assistant texts: only the last turns --');
{
  const messages = [user('start')];
  for (let i = 1; i <= 10; i++) {
    messages.push(assistant(`ASSISTANT-TURN-${i} ` + 'z'.repeat(20)));
  }
  const source = C.extractCompactionSource(messages);
  ok('the oldest two assistant texts are gone', !source.text.includes('ASSISTANT-TURN-1 ') && !source.text.includes('ASSISTANT-TURN-2 '));
  ok('the newest one is kept', source.text.includes('ASSISTANT-TURN-10 '));
  ok('  … and eight of them are kept', !!source.text.match(/Assistant text 8 of the last 8/));
}

console.log('-- a tool call is name -> brief -> first line of the result, 200 chars --');
{
  const longResult = 'RESULT-FIRST-LINE ' + 'q'.repeat(500) + '\nRESULT-SECOND-LINE';
  const source = C.extractCompactionSource([
    user('start'),
    assistant('', [call('c1', 'read_file', '{"path":"a.ts","x":' + 'w'.repeat(400) + '}')]),
    toolResult('c1', longResult),
  ]);
  const entryLine = source.text.split('\n').find((line) => line.startsWith('read_file -> ')) ?? '';
  ok('the entry starts with the tool name', entryLine.startsWith('read_file -> '), entryLine.slice(0, 60));
  ok('the brief is clipped', entryLine.includes('…') && !entryLine.includes('w'.repeat(400)));
  ok('the result keeps its first line only', entryLine.includes('RESULT-FIRST-LINE') && !entryLine.includes('RESULT-SECOND-LINE'));
  ok('  … clipped to 200 chars', !entryLine.includes(longResult.split('\n')[0].trim()));
  const resultPart = entryLine.split(' -> ').slice(2).join(' -> ');
  ok('  … so the result part is at most 201 chars', resultPart.length <= 201, String(resultPart.length));
  ok('the source counts the call', source.toolCallCount === 1, String(source.toolCallCount));
}

// ---- §2: the 60k bound, and head+tail when the window is bigger ----------------------

console.log('-- an oversized window is bounded, keeping the head and the tail --');
{
  const messages = [user('HEAD-REQUEST the very first thing the user asked')];
  for (let i = 0; i < 300; i++) {
    messages.push(user(`MIDDLE-${i} ` + 'm'.repeat(2000)));
  }
  messages.push(user('TAIL-REQUEST the last thing the user asked'));
  const source = C.extractCompactionSource(messages);
  ok('the source is inside the 60k bound', source.chars <= C.COMPACTION_INPUT_MAX_CHARS, `${source.chars} chars`);
  ok('  … and it is not empty', source.chars > 1000, `${source.chars} chars`);
  ok('the first request survives the bound', source.text.includes('HEAD-REQUEST'));
  ok('the last request survives the bound', source.text.includes('TAIL-REQUEST'));
  ok('the middle is dropped', !source.text.includes('MIDDLE-150 '), 'MIDDLE-150 absent');
  ok('the cut is announced as a clip', source.text.includes('compaction input clipped:'));
  ok('  … with a character count', /compaction input clipped: \d+ chars/.test(source.text));
  ok('the dropped size is reported', source.omittedChars > 0, String(source.omittedChars));
  ok('every user message is still counted', source.userCount === 302, String(source.userCount));
}

console.log('-- a custom bound is honoured, and a small window is not clipped --');
{
  const big = C.extractCompactionSource([user('A ' + 'a'.repeat(3000)), user('B ' + 'b'.repeat(3000))], { maxChars: 2000 });
  ok('a custom maxChars bounds the source', big.chars <= 2000, `${big.chars} chars`);
  ok('  … and it announces the clip', big.text.includes('compaction input clipped:'));
  const small = C.extractCompactionSource([user('short request'), assistant('short answer')]);
  ok('a window that fits is not marked as clipped', !small.text.includes('compaction input clipped:') && small.omittedChars === 0);
}

// ---- §3: a window that starts from a handoff summary is marked as such ---------------

console.log('-- the previous-summary marking --');
{
  const pointer = C.extractCompactionSource([
    user(C.ROLLOVER_HARNESS_TITLE + '\nThe previous conversation could not be sent …'),
    user('continue the work'),
  ]);
  ok('the plain pointer title is not a previous summary', pointer.priorSummary === false);
  ok('  … and no marking line is written', !pointer.text.includes('already starts from an earlier handoff summary'));

  const summarized = C.extractCompactionSource([
    user(C.COMPACTION_HARNESS_TITLE + '\n\n## Primary Request and Intent\n…'),
    user('carry on'),
  ]);
  ok('the summary title marks the window', summarized.priorSummary === true);
  ok(
    'the input tells the model to carry the items forward',
    summarized.text.includes('already starts from an earlier handoff summary'),
  );
  ok('the detector agrees on its own', C.detectPriorHandoffSummary([user(C.COMPACTION_HARNESS_TITLE)]) === true);
  ok('  … and a real user message is not one', C.detectPriorHandoffSummary([user('hello')]) === false);
}

// ---- §4: the eleven-section schema, and the nine required headings -------------------

console.log('-- the schema is eleven sections; nine are required --');
{
  ok('eleven sections are declared', C.COMPACTION_SECTIONS.length === 11, String(C.COMPACTION_SECTIONS.length));
  ok('nine of them are required', C.COMPACTION_REQUIRED_SECTIONS.length === 9, String(C.COMPACTION_REQUIRED_SECTIONS.length));
  const all = C.COMPACTION_SECTIONS.map((heading) => `## ${heading}\n- a fact`).join('\n');
  ok('all eleven satisfies the validation', C.missingCompactionSections(all).length === 0);
  const nine = C.COMPACTION_REQUIRED_SECTIONS.map((heading) => `## ${heading}\n- a fact`).join('\n');
  ok('the two local extras are optional', C.missingCompactionSections(nine).length === 0);
  const missing = C.missingCompactionSections(nine.replace('## Pending Tasks\n- a fact\n', ''));
  ok('a missing heading is named', missing.length === 1 && missing[0] === 'Pending Tasks', missing.join(','));
  ok(
    'any heading level and casing is accepted',
    C.missingCompactionSections(C.COMPACTION_REQUIRED_SECTIONS.map((h) => `# ${h.toLowerCase()}:`).join('\n')).length === 0,
  );
  ok('prose without headings is invalid', C.missingCompactionSections('Here is what happened…').length === 9);
}

// ---- §5: the fallback decision, and the two outcomes ---------------------------------

console.log('-- the fallback decision --');
{
  const all = C.COMPACTION_SECTIONS.map((heading) => `## ${heading}\n- a fact`).join('\n');
  const good = C.classifyCompactionAnswer({ text: all });
  ok('a valid answer becomes the summary', good.ok === true && good.summary.startsWith('## Primary Request'));
  ok('  … trimmed', C.classifyCompactionAnswer({ text: `\n\n${all}\n\n` }).summary === all);
  const timeout = C.classifyCompactionAnswer({ text: undefined, failed: 'timeout' });
  ok('a timeout is a fallback', timeout.ok === false && timeout.reason === 'timeout');
  const error = C.classifyCompactionAnswer({ text: undefined, failed: 'error' });
  ok('an error is a fallback', error.ok === false && error.reason === 'error');
  ok('an empty answer is a fallback', C.classifyCompactionAnswer({ text: '' }).reason === 'empty');
  ok('whitespace only is empty', C.classifyCompactionAnswer({ text: '  \n ' }).reason === 'empty');
  ok('a missing answer is empty', C.classifyCompactionAnswer({}).reason === 'empty');
  const invalid = C.classifyCompactionAnswer({ text: '## Primary Request and Intent\njust this' });
  ok('a missing heading is invalid', invalid.ok === false && invalid.reason === 'invalid');
  ok(
    'the failure never throws, whatever it is given',
    typeof C.classifyCompactionAnswer({ text: 42 }) === 'object' && C.classifyCompactionAnswer({ text: 42 }).reason === 'empty',
  );
}

// ---- §6: the request is the documented one, and the diagnostics say what happened ----

console.log('-- the request: no tools, non-streaming, capped, cold --');
{
  ok('the output cap is 1500 tokens', C.COMPACTION_MAX_OUTPUT_TOKENS === 1500, String(C.COMPACTION_MAX_OUTPUT_TOKENS));
  ok('the hard timeout is 30 s', C.COMPACTION_TIMEOUT_MS === 30000, String(C.COMPACTION_TIMEOUT_MS));
  const source = C.extractCompactionSource([user('start the work'), assistant('on it')]);
  const request = C.buildCompactionRequest(source);
  ok('one request carries the cap', request.maxTokens === C.COMPACTION_MAX_OUTPUT_TOKENS);
  ok('the temperature is low', request.temperature > 0 && request.temperature <= 0.3, String(request.temperature));
  ok('exactly one user message is sent', request.messages.length === 1 && request.messages[0].role === 'user');
  ok('no tools are sent', request.tools === undefined && !('tools' in request));
  const prompt = request.messages[0].content;
  ok('the prompt names all eleven headings', C.COMPACTION_SECTIONS.every((h) => prompt.includes(`## ${h}`)));
  ok('the prompt states the handoff contract', /Handoff Contract: state that you are the same agent/.test(prompt));
  ok('the prompt marks code sections for re-reading', prompt.includes('re-read before editing'));
  ok('the prompt asks for the quoted next step', prompt.includes("quote the user's own words"));
  ok('the prompt carries the window between its markers', prompt.includes('--- BEGIN WINDOW ---') && prompt.includes(source.text));
  const prior = C.extractCompactionSource([user(C.COMPACTION_HARNESS_TITLE), user('carry on')]);
  ok(
    'a previous summary is carried forward in the prompt too',
    C.buildCompactionPrompt(prior).includes('carry its unresolved items forward'),
  );
  const retry = C.buildCompactionRetryMessages(source, 'a prose answer', ['Pending Tasks', 'Current Work']);
  ok('the one retry keeps the model answer and names the missing headings', retry.length === 3 && retry[1].role === 'assistant' && /Pending Tasks.*Current Work/.test(retry[2].content));
}

console.log('-- the diagnostics line --');
{
  const good = C.compactionDiagLine({ inputChars: 12345, outputTokens: 800, ms: 2400, outcome: 'summary' });
  ok('a summary line reports in/out/ms', good.startsWith('compaction in=12345chars out=800tok ms=2400 '), good);
  ok('  … and outcome=summary', good.endsWith('outcome=summary'), good);
  const fallback = C.compactionDiagLine({ inputChars: 10, outputTokens: 0, ms: 30000, outcome: 'timeout' });
  ok('a fallback line names its reason', fallback.endsWith('outcome=fallback:timeout'), fallback);
  ok(
    'every failure reason is a fallback token',
    ['timeout', 'error', 'empty', 'invalid'].every((reason) =>
      C.compactionDiagLine({ inputChars: 1, outputTokens: 0, ms: 1, outcome: reason }).includes(`outcome=fallback:${reason}`),
    ),
  );
}

console.log('');
if (problems.length) {
  console.log(`FAIL compaction: ${problems.length} check(s) failed`);
  process.exit(1);
}
console.log(
  'PASS compaction: the summary input is one bounded window (head+tail, marked when it follows a summary), the prompt is the eleven-section schema with nine required headings, the request is capped and cold, and every failure falls back to the pointer',
);
