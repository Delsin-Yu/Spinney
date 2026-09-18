/*
 * transcript-queue-acceptance — the transcript write queue's ordering invariants,
 * driven directly against the COMPILED module (dev-only; not a build guard, and never
 * shipped in the `.vsix`).
 *
 * Why it exists: a dump used to be `mkdirSync` + `writeFileSync` on the host thread, and
 * with 15 sub-agents finishing at once that put a 700 KB–1 MB write per turn on the one
 * thread the UI runs on. The fix is an async queue, and a queue introduces an ordering
 * question that synchronous code could not have: **a deletion has to win over a write
 * that is still pending, or "the files are gone" is undone a moment later**
 * (`invariants/session-persistence.md`). That is what this pins, along with the two
 * properties the queue must not lose — the file format, and the synchronous
 * `{ file, lines, bytes }` a caller still gets back.
 *
 *   npx tsc -p ./ && node tools/transcript-queue-acceptance.js [<outDir>]
 *
 * No window, no provider, no tokens. Everything happens under `.spinney/` (gitignored).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(
  process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(ROOT, 'out'),
);
const { writeSessionTranscript, writeSubAgentTranscript, removeTranscripts, removeTranscriptFile, removeTranscriptDir, flushTranscripts, hasPendingTranscriptWrite } = require(
  path.join(OUT, 'chat', 'transcript.js'),
);

const problems = [];
const check = (label, ok, detail) => {
  console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) problems.push(label);
};

const SANDBOX = path.join(ROOT, '.spinney', 'transcript-queue');
const sessionInput = (dir, nodeId, prompt) => ({
  dir,
  nodeId,
  sessionId: 'sess-1',
  sessionTitle: 'queue acceptance',
  parentId: null,
  pathIds: [nodeId],
  title: prompt,
  model: 'sim-model',
  status: 'done',
  prompt,
  summary: 'done',
  startedAt: 1,
  endedAt: 2,
  messages: [
    { role: 'user', content: prompt },
    { role: 'assistant', content: `answer for ${prompt}` },
  ],
});

(async () => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  const dir = path.join(SANDBOX, 'sess-1');

  console.log('== the writer is synchronous in its answer, asynchronous on disk ==');
  const ref = writeSessionTranscript(sessionInput(dir, 'n1', 'first'));
  check('a ref comes back with a path, a line count and a byte count', Boolean(ref.file && ref.lines >= 3 && ref.bytes > 0), JSON.stringify(ref));
  check('a queued dump counts as present before it is on disk', hasPendingTranscriptWrite(ref.file) || fs.existsSync(ref.file));
  await flushTranscripts();
  check('flushTranscripts() puts it on disk', fs.existsSync(ref.file));
  check('  … and the queue is empty afterwards', !hasPendingTranscriptWrite(ref.file));
  check('the file layout is unchanged (meta line 1, then one message per line)', (() => {
    const lines = fs.readFileSync(ref.file, 'utf8').split('\n').filter(Boolean);
    if (lines.length !== ref.lines) return false;
    const meta = JSON.parse(lines[0]);
    return meta.type === 'meta' && meta.kind === 'session' && lines.slice(1).every((l, i) => {
      const msg = JSON.parse(l);
      // `index` is 0-based (the writer's `forEach` index); the *line* is index + 2.
      return msg.type === 'message' && msg.index === i && typeof msg.role === 'string';
    });
  })());

  console.log('\n== a later write for the same path replaces the pending one ==');
  const second = writeSessionTranscript(sessionInput(dir, 'n1', 'second'));
  const third = writeSessionTranscript(sessionInput(dir, 'n1', 'third'));
  await flushTranscripts();
  const body = fs.readFileSync(third.file, 'utf8');
  check('the last body is what lands', body.includes('third') && !body.includes('second'), `${second.bytes} then ${third.bytes}`);
  check('only one file exists for that node', fs.readdirSync(dir).filter((f) => f === 'n1.jsonl').length === 1);

  console.log('\n== a deletion wins over a pending write ==');
  const doomed = writeSessionTranscript(sessionInput(dir, 'n2', 'doomed'));
  const removed = removeTranscripts(dir, ['n2']);
  await flushTranscripts();
  check('the queued dump was cancelled, not written', !fs.existsSync(doomed.file));
  check('  … and the deletion reports it as removed', removed === 1, `removed=${removed}`);
  check('  … and nothing is left pending for it', !hasPendingTranscriptWrite(doomed.file));

  console.log('\n== a deletion of a whole session folder wins over an in-flight write ==');
  const flying = writeSessionTranscript(sessionInput(dir, 'n3', 'in flight'));
  removeTranscriptDir(dir); // while n3 is queued or already being written
  await flushTranscripts();
  check('the folder is gone once the queue drains', !fs.existsSync(dir));
  check('  … including the dump that was in flight', !fs.existsSync(flying.file));

  console.log('\n== a write after a deletion brings the dump back ==');
  const revived = writeSessionTranscript(sessionInput(dir, 'n4', 'revived'));
  await flushTranscripts();
  check('the tombstone was cleared by the new write', fs.existsSync(revived.file), revived.file);
  check('  … and it is readable JSONL again', (() => {
    const lines = fs.readFileSync(revived.file, 'utf8').split('\n').filter(Boolean);
    return JSON.parse(lines[0]).type === 'meta' && lines.length === 3;
  })());

  console.log('\n== removeTranscriptFile() reports a cancelled-only dump ==');
  const orphan = writeSessionTranscript(sessionInput(dir, 'n5', 'orphan'));
  const gone = removeTranscriptFile(orphan.file);
  await flushTranscripts();
  check('a queued-only dump reports as removed', gone === true);
  check('  … and it never appears on disk', !fs.existsSync(orphan.file));
  check('an unknown path is still reported as not removed', removeTranscriptFile(path.join(dir, 'nope.jsonl')) === false);

  console.log('\n== a sub-agent dump goes through the same queue ==');
  const sub = writeSubAgentTranscript({
    dir,
    nodeId: 'a1',
    sessionId: 'sess-1',
    depth: 1,
    write: false,
    model: 'sim-model',
    status: 'done',
    resumed: false,
    instruction: 'investigate',
    summary: 'nothing',
    startedAt: 1,
    endedAt: 2,
    systemPrompt: 'lean',
    messages: [{ role: 'user', content: 'investigate' }, { role: 'assistant', content: 'nothing' }],
  });
  check('a sub-agent ref comes back synchronously', Boolean(sub.file && sub.lines >= 3), JSON.stringify(sub));
  check('  … and is queued, not written inline', hasPendingTranscriptWrite(sub.file) || fs.existsSync(sub.file));
  await flushTranscripts();
  check('  … and lands after the flush, keeping the system prompt in the meta', (() => {
    const meta = JSON.parse(fs.readFileSync(sub.file, 'utf8').split('\n')[0]);
    return meta.kind === 'subagent' && meta.systemPrompt === 'lean' && meta.messageCount === 2;
  })());

  fs.rmSync(SANDBOX, { recursive: true, force: true });
  console.log('');
  if (problems.length) {
    console.log(`FAIL transcript-queue-acceptance: ${problems.length} check(s) failed\n - ${problems.join('\n - ')}`);
    process.exit(1);
  }
  console.log('PASS transcript-queue-acceptance: the queue keeps the dump format, answers synchronously, coalesces rewrites, and lets a deletion win over a pending or in-flight write');
})().catch((err) => {
  console.error(`transcript-queue-acceptance: ${err && err.stack ? err.stack : String(err)}`);
  process.exit(2);
});
