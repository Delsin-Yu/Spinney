/*
 * check-compaction — the **handoff** of a context window, as a build-time guard
 * (`docs/agents/invariants/context-rollover.md` §6, `docs/agents/invariants/compress-node.md`).
 *
 * Why it exists: every rule this feature has lives on a path that costs a turn and is
 * invisible until it runs against a real, enormous window. A compression built from the
 * whole chain instead of the window hands the next agent the wrong history; an unbounded
 * source is a turn that cannot fit; a handoff whose instruction lost a section is not a
 * handoff; and a pointer text that dropped the original request turns the new window into a
 * different task. None of that throws, so nothing else would notice.
 *
 * It drives the **compiled pure module** (`src/agent/compaction.ts`), so it needs `out/`
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

// ---- The request's own handoff is a turn now: the one-shot summariser is retired -------

console.log('-- the retired one-shot summariser is gone --');
ok('no buildCompactionRequest', C.buildCompactionRequest === undefined);
ok('no buildCompactionRetryMessages', C.buildCompactionRetryMessages === undefined);
ok('no COMPACTION_TIMEOUT_MS', C.COMPACTION_TIMEOUT_MS === undefined);
ok('no COMPACTION_MAX_OUTPUT_TOKENS', C.COMPACTION_MAX_OUTPUT_TOKENS === undefined);
ok('no buildCompactionPrompt', C.buildCompactionPrompt === undefined);
ok('the detector and the validators are kept', [
  C.extractCompactionSource,
  C.detectPriorHandoffSummary,
  C.missingCompactionSections,
  C.classifyCompactionAnswer,
  C.compactionDiagLine,
].every((fn) => typeof fn === 'function'));

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
  ok('the first real request is returned verbatim', C.firstUserRequest([
    user('[Harness: context window reset]\npointer'),
    user('THE ORIGINAL TASK'),
    user('a later one'),
  ]) === 'THE ORIGINAL TASK');
  ok('  … and a window with no request answers nothing', C.firstUserRequest([user('[Harness: x]')]) === '');
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

// ---- §3: a window that starts from a handoff is marked as such -----------------------

console.log('-- the previous-handoff marking --');
{
  const pointer = C.extractCompactionSource([
    user(C.ROLLOVER_HARNESS_TITLE + '\nThe previous conversation could not be sent …'),
    user('continue the work'),
  ]);
  ok('the plain pointer title is not a previous handoff', pointer.priorSummary === false);
  ok('  … and no marking line is written', !pointer.text.includes('already starts from an earlier handoff summary'));

  const compressed = C.extractCompactionSource([
    user(C.COMPACTION_HARNESS_TITLE + '\n\n## Objective\n…'),
    user('carry on'),
  ]);
  ok('the handoff title marks the window', compressed.priorSummary === true);
  ok(
    'the input tells the model to carry the items forward',
    compressed.text.includes('already starts from an earlier handoff summary'),
  );
  ok('the detector agrees on its own', C.detectPriorHandoffSummary([user(C.COMPACTION_HARNESS_TITLE)]) === true);
  ok('  … and a real user message is not one', C.detectPriorHandoffSummary([user('hello')]) === false);
}

// ---- §4: the eight-section schema, seven of them required ---------------------------

console.log('-- the schema is the paper\'s: eight sections, seven required --');
{
  ok('eight sections are declared', C.COMPRESS_SECTIONS.length === 8, String(C.COMPRESS_SECTIONS.length));
  ok('seven of them are required', C.COMPRESS_REQUIRED_SECTIONS.length === 7, String(C.COMPRESS_REQUIRED_SECTIONS.length));
  ok('Objective is required', C.COMPRESS_REQUIRED_SECTIONS.includes('Objective'));
  ok('Durable references is asked for and not required', !C.COMPRESS_REQUIRED_SECTIONS.includes('Durable references'));
  const all = C.COMPRESS_SECTIONS.map((heading) => `## ${heading}\n- a fact`).join('\n');
  ok('all eight satisfies the validation', C.missingCompactionSections(all).length === 0);
  const seven = C.COMPRESS_REQUIRED_SECTIONS.map((heading) => `## ${heading}\n- a fact`).join('\n');
  ok('the optional eighth is optional', C.missingCompactionSections(seven).length === 0);
  const missing = C.missingCompactionSections(seven.replace('## Dead ends\n- a fact\n', ''));
  ok('a missing heading is named', missing.length === 1 && missing[0] === 'Dead ends', missing.join(','));
  ok(
    'any heading level and casing is accepted',
    C.missingCompactionSections(C.COMPRESS_REQUIRED_SECTIONS.map((h) => `# ${h.toLowerCase()}:`).join('\n')).length === 0,
  );
  ok('prose without headings is invalid', C.missingCompactionSections('Here is what happened…').length === 7);
  const instruction = C.COMPRESS_INSTRUCTION;
  ok('the instruction names all eight headings', C.COMPRESS_SECTIONS.every((h) => instruction.includes(`## ${h}`)));
  ok('the instruction quotes the original task rule', instruction.includes('Quote the original task verbatim'));
  ok('the instruction forbids invented observations', instruction.includes('Never invent an observation'));
  ok('the instruction asks for English Markdown', instruction.includes('Write English Markdown'));
  ok('the instruction is not a record of the past', instruction.includes('It is not a record of what happened'));
}

// ---- §5: the decision, and the three outcomes a compression can have -----------------

console.log('-- the decision --');
{
  const all = C.COMPRESS_SECTIONS.map((heading) => `## ${heading}\n- a fact`).join('\n');
  const good = C.classifyCompactionAnswer({ text: all });
  ok('a valid answer becomes the handoff', good.ok === true && good.summary.startsWith('## Objective'));
  ok('  … trimmed', C.classifyCompactionAnswer({ text: `\n\n${all}\n\n` }).summary === all);
  const timeout = C.classifyCompactionAnswer({ text: undefined, failed: 'timeout' });
  ok('a timeout is still expressible', timeout.ok === false && timeout.reason === 'timeout');
  ok('an empty answer is empty', C.classifyCompactionAnswer({ text: '' }).reason === 'empty');
  ok('whitespace only is empty', C.classifyCompactionAnswer({ text: '  \n ' }).reason === 'empty');
  ok('a missing answer is empty', C.classifyCompactionAnswer({}).reason === 'empty');
  const invalid = C.classifyCompactionAnswer({ text: '## Objective\njust this' });
  ok('a missing heading is invalid (and the window still opens)', invalid.ok === false && invalid.reason === 'invalid');
  ok(
    'the decision never throws, whatever it is given',
    typeof C.classifyCompactionAnswer({ text: 42 }) === 'object' && C.classifyCompactionAnswer({ text: 42 }).reason === 'empty',
  );
}

// ---- §6: the two texts a window is handed --------------------------------------------

console.log('-- the compression instruction: the facts, then the fixed ask --');
{
  const source = C.extractCompactionSource([user('THE ORIGINAL TASK'), assistant('half of it')]);
  const text = C.buildCompressInstruction({
    sessionId: 'sess-1',
    previousNodeId: 'p0',
    transcriptPath: '/tmp/sess-1/p0.jsonl',
    transcriptExists: true,
    source,
    files: ['src/a.ts', 'src/b.ts'],
    usage: { used: 900000, window: 1048576, pct: 86 },
    killedBackground: [{ id: 3, command: 'npm run build', state: 'stopped by the rollover' }],
    killedSubAgents: [{ nodeId: 'sub1', transcript: '/tmp/sess-1/sub1.jsonl' }],
  });
  ok('it opens as the harness compression turn', text.startsWith('[Harness: compression turn]'));
  ok('it names the previous window', text.includes('Previous window: node p0 of session sess-1.'));
  ok('it gives the transcript pointer', text.includes('/tmp/sess-1/p0.jsonl') && text.includes('search_transcripts'));
  ok('it states the size as a fact with no reason clause', text.includes("The previous window used 900000 of this model's 1048576-token context (86%).") && !text.includes('rollover threshold'));
  ok('it lists the changed files', text.includes('- src/a.ts') && text.includes('- src/b.ts') && text.includes('re-read'));
  ok('it names the killed work', text.includes('background terminal #3') && text.includes('sub-agent node sub1'));
  ok('it carries the window between its markers', text.includes('--- BEGIN WINDOW ---') && text.includes('THE ORIGINAL TASK') && text.includes('--- END WINDOW ---'));
  ok('it ends with the fixed instruction verbatim', text.endsWith(C.COMPRESS_INSTRUCTION));
  const degraded = C.buildCompressInstruction({
    sessionId: 's',
    previousNodeId: 'p',
    transcriptPath: '/nope.jsonl',
    transcriptExists: false,
    source,
    killedBackground: [],
    killedSubAgents: [],
  });
  ok('a missing transcript degrades instead of pointing at nothing', degraded.includes('not available on disk'));
  ok('  … and it still carries the instruction', degraded.endsWith(C.COMPRESS_INSTRUCTION));
}

console.log('-- the pointer text (Simple) --');
{
  const pointer = C.buildContextRolloverMessage({
    reason: 'full',
    sessionId: 'sess-1',
    previousNodeId: 'p0',
    transcriptPath: '/tmp/sess-1/p0.jsonl',
    transcriptExists: true,
    request: 'now FINISH-THE-JOB',
    attachments: 2,
    answer: 'half an answer',
    firstRequest: 'THE ORIGINAL TASK',
    files: ['src/a.ts'],
    usage: { used: 1048576, window: 1048576, pct: 100 },
    killedBackground: [{ id: 3, command: 'npm run build', state: 'stopped by the rollover' }],
    killedSubAgents: [],
  });
  ok('it starts with the pointer title', pointer.startsWith(C.ROLLOVER_HARNESS_TITLE));
  ok('it says the provider refused the tokens', pointer.includes('the context window was full'));
  ok('it names the previous window', pointer.includes('Previous window: node p0 of session sess-1.'));
  ok('it states the size with the refusal tail', pointer.includes('which is at or past the limit this provider accepts for one request.'));
  ok('it points at the transcript', pointer.includes('/tmp/sess-1/p0.jsonl'));
  ok('it quotes the ORIGINAL task verbatim', pointer.includes("The user's first request in that window, verbatim: THE ORIGINAL TASK"));
  ok('it quotes the last request verbatim with the attachment count', pointer.includes("the user's last request: now FINISH-THE-JOB (the original request had 2 attachment(s))"));
  ok('it carries the last answer', pointer.includes('the last answer you gave: half an answer'));
  ok('it lists the files to re-read', pointer.includes('- src/a.ts'));
  ok('it names the killed work', pointer.includes('background terminal #3'));
  const near = C.buildContextRolloverMessage({
    reason: 'near',
    sessionId: 's',
    previousNodeId: 'p',
    transcriptPath: '/x.jsonl',
    transcriptExists: false,
    request: 'r',
    attachments: 0,
    answer: 'a',
    usage: { used: 90, window: 100, pct: 90 },
  });
  ok('a near window says nothing was refused', near.includes('nothing was refused yet') && !near.includes('the context window was full'));
  ok('  … and it degrades the missing transcript', near.includes('not available on disk'));
  ok('  … with an absent killed-work list', !near.includes('Stopped when this window was opened:'));
}

console.log('-- the compressed window (Agentic): the handoff first, then the facts --');
{
  const summary = [C.COMPRESS_SECTIONS.map((h) => `## ${h}\n- a fact`).join('\n')];
  const compressed = C.buildContextRolloverMessage({
    reason: 'compress',
    sessionId: 'sess-1',
    previousNodeId: 'p0',
    transcriptPath: '/tmp/sess-1/p0.jsonl',
    transcriptExists: true,
    request: 'now FINISH-THE-JOB',
    attachments: 0,
    answer: 'half an answer',
    firstRequest: 'THE ORIGINAL TASK',
    files: ['src/a.ts'],
    usage: { used: 400000, window: 1048576, pct: 38 },
    killedBackground: [],
    killedSubAgents: [],
    summary: summary[0],
  });
  ok('it starts with the handoff title the next compression reads', compressed.startsWith(C.COMPACTION_HARNESS_TITLE));
  ok('the handoff comes first', compressed.indexOf('## Objective') < compressed.indexOf('Previous window:'));
  ok('  … and it is verbatim', compressed.includes(summary[0]));
  ok('the original task is still quoted', compressed.includes('THE ORIGINAL TASK'));
  ok('the size line claims no refusal', compressed.includes('the window was compressed to continue the conversation in a shorter one.'));
  ok('it is not a pointer rollover', !compressed.includes('could not be sent to the model any more'));
  ok('  … and it is detected as a previous handoff by the next compression', C.detectPriorHandoffSummary([
    user(compressed),
    user('next request'),
  ]) === true);
}

// ---- §7: the changed files, read out of the transcript items -------------------------

console.log('-- the changed-file list --');
{
  const items = [
    { kind: 'tool', name: 'write_file', args: '{"path":"src/a.ts","content":"x"}' },
    { kind: 'tool', name: 'read_file', args: '{"path":"src/read-only.ts"}' },
    { kind: 'tool', name: 'replace_in_file', args: '{"path":"src/b.ts","oldText":"a","newText":"b"}' },
    { kind: 'tool', name: 'append_file', args: '{"path":"src/a.ts","content":"y"}' },
    { kind: 'tool', name: 'exec_command', args: '{"command":"git status"}' },
    { kind: 'tool', name: 'write_file', args: 'not json' },
    { kind: 'assistant', text: 'done' },
  ];
  const files = C.editedFilesFromItems(items);
  ok('only the editing tools count', files.join(',') === 'src/a.ts,src/b.ts', files.join(','));
  ok('  … in the order they were touched, without duplicates', files.length === 2);
  ok('a read is not a change', !files.includes('src/read-only.ts'));
  ok('a broken item costs nothing', C.editedFilesFromItems([{ kind: 'tool', name: 'write_file', args: '{' }]).length === 0);
}

console.log('-- the diagnostics line --');
{
  const good = C.compactionDiagLine({ inputChars: 12345, outputTokens: 800, ms: 2400, outcome: 'summary' });
  ok('a handoff line reports in/out/ms', good.startsWith('compaction in=12345chars out=800tok ms=2400 '), good);
  ok('  … and outcome=summary', good.endsWith('outcome=summary'), good);
  const fallback = C.compactionDiagLine({ inputChars: 10, outputTokens: 0, ms: 30000, outcome: 'invalid' });
  ok('a missing-section line names its reason', fallback.endsWith('outcome=fallback:invalid'), fallback);
}

console.log('');
if (problems.length) {
  console.log(`FAIL compaction: ${problems.length} check(s) failed`);
  process.exit(1);
}
console.log(
  'PASS compaction: the input is one bounded window (head+tail, marked when it follows a handoff), the instruction is the eight-section ask with seven required, the pointer text carries the original task and the changed files, and every outcome is data the caller acts on',
);
