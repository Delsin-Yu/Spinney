/*
 * args-acceptance — the tool-argument contract, as a build-time guard.
 *
 * It stubs `vscode` (the `Module._load` hook `exec-cwd-acceptance.js` uses) and
 * drives `ToolRegistry.execute`, exactly as the host does, so the assertions run
 * against the *compiled* tools — which is why it needs `out/` and runs after
 * `compile` in `vscode:prepublish`, right after `check:cwd`.
 *
 * What it pins — the four halves of the frame removal and the one tool that
 * replaced it:
 *   1. Arguments are **strict JSON only**. The verbatim-frame form (a JSON header
 *      line followed by `<<<RAW:key>>>…<<<END_RAW:key>>>` blocks) was removed from
 *      `parseArgs`, so that text is now a plain parse error — no second syntax,
 *      and nothing is written. A JSON value that is not an object is refused the
 *      same way, and `embeddedFrameError` is gone from the module's exports.
 *   2. A value that *is* the old frame (entirely wrapped in
 *      `<<<RAW:key>>>…<<<END_RAW:key>>>`) answers the one non-parsing sentinel —
 *      `Error: the verbatim frame form was removed from this harness; …` — and
 *      nothing is written. The check is anchored on **both** boundaries: markers
 *      in the middle of a payload are legitimate file text and must still be
 *      written, so the guard pins that half too.
 *   3. `append_file` exists: it creates a missing file (and its parents), appends
 *      to an existing one, keeps the file's own CRLF/LF style, and reports
 *      `Appended to <path> (N lines added, M lines total).` Its description has to
 *      tell the model the write-then-append-chunks story, because a tool
 *      description is the only place a model can learn the shape (the prompt
 *      carries no tool list).
 *   4. `write_file` still works, and neither it nor `replace_in_file` advertises
 *      the deleted `frame` argument any more.
 *
 * Run: npm run check:args   /   node tools/args-acceptance.js
 */
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');

/** The one model-facing sentence the removed frame shape answers with. */
const FRAME_REMOVED =
  'Error: the verbatim frame form was removed from this harness; send the value as a plain ' +
  'JSON string instead. Nothing was written.';

const vscodeStub = {
  env: {},
  workspace: {
    workspaceFolders: [
      { uri: { fsPath: ROOT, toString: () => 'file:///' + ROOT.split(path.sep).join('/') } },
    ],
    getConfiguration: () => ({ get: () => undefined }),
  },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.call(this, request, parent, isMain);
};

const toolsIndex = require(path.join(OUT, 'tools', 'index.js'));
const { ToolRegistry } = toolsIndex;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spinney-args-'));
const file = (name) => path.join(tmpRoot, name);
const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);
const problems = [];
let total = 0;
const check = (label, cond, detail) => {
  total += 1;
  console.log(`  [${cond ? 'ok  ' : 'FAIL'}] ${label}${detail !== undefined ? `  (${detail})` : ''}`);
  if (!cond) problems.push(label);
};
/** A value is CRLF-clean when it has CRLF and not one bare LF. */
const onlyCrlf = (s) => s.includes('\r\n') && !/[^\r]\n/.test(s);
/** ...and LF-clean when it has no CR at all. */
const onlyLf = (s) => !s.includes('\r') && s.includes('\n');

const reg = new ToolRegistry();
const call = (name, args) => reg.execute(name, JSON.stringify(args));
const def = (name) => reg.definitions.find((d) => d.function.name === name);
/** The old frame form as *argument text*: a header line, then the markers outside the JSON. */
const asFrameText = (headerObj, key, payload) =>
  `${JSON.stringify(headerObj)}\n<<<RAW:${key}>>>\n${payload}\n<<<END_RAW:${key}>>>`;

(async () => {
  try {
    console.log('== arguments are strict JSON only ==');
    const plain = file('plain.txt');
    const wrote = await call('write_file', { path: plain, content: 'one\ntwo\n' });
    check('a JSON call still writes the file', exists(plain) && read(plain) === 'one\ntwo\n', JSON.stringify(read(plain)));
    check('and reports the write', /^Wrote .*\(3 lines, LF\)\. \(\+2 -0\)$/.test(wrote), wrote.trim());

    const frameTextFile = file('frame-text.txt');
    const frameText = await reg.execute('write_file', asFrameText({ path: frameTextFile }, 'content', 'verbatim\ntext'));
    check(
      'the frame form as argument text is a parse error now',
      /^Error: could not parse tool arguments: Could not parse tool arguments as JSON:/.test(frameText),
      frameText.split('\n')[0].slice(0, 90),
    );
    check('and nothing was written', !exists(frameTextFile));

    const arrayArgs = await reg.execute('write_file', '["a.ts", "x"]');
    check('a non-object JSON value is refused the same way', /^Error: could not parse tool arguments:/.test(arrayArgs), arrayArgs.slice(0, 60));
    const junk = await reg.execute('write_file', 'not json at all');
    check('unparseable text keeps the JSON error path', /^Error: could not parse tool arguments:/.test(junk), junk.slice(0, 60));

    console.log('== the removed frame, as a whole value ==');
    check('embeddedFrameError is gone from the exports', toolsIndex.embeddedFrameError === undefined);
    check('the sentinel helper is what is left', typeof toolsIndex.verbatimFrameError === 'function');

    const sentinelFile = file('sentinel.txt');
    const sentinel = await call('write_file', {
      path: sentinelFile,
      content: '<<<RAW:content>>>\nsome text\n<<<END_RAW:content>>>',
    });
    check('write_file answers the removal sentinel', sentinel === FRAME_REMOVED, JSON.stringify(sentinel));
    check('and writes nothing at all', !exists(sentinelFile));

    const padded = await call('write_file', {
      path: sentinelFile,
      content: '  \n<<<RAW:content>>>\nx\n<<<END_RAW:content>>>\n  ',
    });
    check('the check tolerates surrounding whitespace (the old anchoring)', padded === FRAME_REMOVED, JSON.stringify(padded));
    check('still nothing written', !exists(sentinelFile));

    const target = file('replace-target.txt');
    fs.writeFileSync(target, 'alpha\nbeta\n', 'utf8');
    const replaceSentinel = await call('replace_in_file', {
      path: target,
      oldText: 'beta',
      newText: '<<<RAW:newText>>>\ngamma\n<<<END_RAW:newText>>>',
    });
    check('replace_in_file answers the same sentinel', replaceSentinel === FRAME_REMOVED, JSON.stringify(replaceSentinel));
    check('and leaves the file byte-identical', read(target) === 'alpha\nbeta\n', JSON.stringify(read(target)));
    const oldSentinel = await call('replace_in_file', {
      path: target,
      oldText: '<<<RAW:oldText>>>\nbeta\n<<<END_RAW:oldText>>>',
      newText: 'gamma',
    });
    check('the oldText half is checked too', oldSentinel === FRAME_REMOVED, JSON.stringify(oldSentinel));
    check('the file is still byte-identical', read(target) === 'alpha\nbeta\n');

    const middle = file('middle.txt');
    const middleContent = 'a\n<<<RAW:content>>>\ninner\n<<<END_RAW:content>>>\nb\n';
    const middleAnswer = await call('write_file', { path: middle, content: middleContent });
    check(
      'markers in the middle of a payload are legitimate file text',
      /^Wrote /.test(middleAnswer) && read(middle) === middleContent,
      middleAnswer.trim(),
    );

    console.log('== append_file ==');
    check('append_file is registered', typeof def('append_file') === 'object' && reg.names.includes('append_file'));
    const appendSchema = def('append_file').function.parameters;
    check('its args are path + content, both required', JSON.stringify(appendSchema.required) === '["path","content"]', JSON.stringify(appendSchema.required));
    check('it says write_file first, then chunks', /write the first part with write_file/.test(def('append_file').function.description) && /bounded chunks/.test(def('append_file').function.description));

    const fresh = file(path.join('nested', 'fresh.txt'));
    const freshAnswer = await call('append_file', { path: fresh, content: 'one\ntwo\n' });
    check('a missing file and its parents are created', exists(fresh) && read(fresh) === 'one\ntwo\n', JSON.stringify(read(fresh)));
    check('the answer counts the lines', freshAnswer === `Appended to ${fresh} (3 lines added, 3 lines total). (+2 -0)`, freshAnswer);

    const grownAnswer = await call('append_file', { path: fresh, content: 'three\n' });
    check('content is added at the end, in order', read(fresh) === 'one\ntwo\nthree\n', JSON.stringify(read(fresh)));
    check('the answer reports the addition and the total', grownAnswer === `Appended to ${fresh} (1 lines added, 4 lines total). (+1 -0)`, grownAnswer);

    const crlfFile = file('crlf.txt');
    fs.writeFileSync(crlfFile, 'first\r\nsecond\r\n', 'utf8');
    await call('append_file', { path: crlfFile, content: 'third\nfourth\n' });
    check('an existing CRLF file keeps CRLF', onlyCrlf(read(crlfFile)), JSON.stringify(read(crlfFile)));
    check('and the appended text is all there', read(crlfFile) === 'first\r\nsecond\r\nthird\r\nfourth\r\n', JSON.stringify(read(crlfFile)));

    const lfFile = file('lf.txt');
    fs.writeFileSync(lfFile, 'first\nsecond\n', 'utf8');
    await call('append_file', { path: lfFile, content: 'third\r\nfourth\r\n' });
    check('an existing LF file keeps LF', onlyLf(read(lfFile)), JSON.stringify(read(lfFile)));
    check('and the appended text is all there', read(lfFile) === 'first\nsecond\nthird\nfourth\n', JSON.stringify(read(lfFile)));

    const newCrlf = file('new-crlf.txt');
    await call('append_file', { path: newCrlf, content: 'x\r\ny\r\n' });
    check('a new file is written exactly as supplied', read(newCrlf) === 'x\r\ny\r\n', JSON.stringify(read(newCrlf)));

    const appendSentinel = await call('append_file', { path: crlfFile, content: '<<<RAW:content>>>\nx\n<<<END_RAW:content>>>' });
    check('append_file refuses the removed frame too', appendSentinel === FRAME_REMOVED, JSON.stringify(appendSentinel));
    check('and changes nothing', read(crlfFile) === 'first\r\nsecond\r\nthird\r\nfourth\r\n');

    console.log('== write_file / replace_in_file are unchanged otherwise ==');
    for (const name of ['write_file', 'replace_in_file']) {
      const schema = def(name).function.parameters;
      check(`${name} no longer advertises "frame"`, !('frame' in schema.properties), Object.keys(schema.properties).join(','));
      check(`${name}'s description no longer mentions frame/RAW`, !/frame|RAW/.test(def(name).function.description));
    }
    const rewrite = file('crlf.txt');
    const rewriteAnswer = await call('write_file', { path: rewrite, content: 'only\nline\n' });
    check('write_file still overwrites', read(rewrite) === 'only\r\nline\r\n', JSON.stringify(read(rewrite)));
    check('and still reports the file EOL', /\(3 lines, CRLF\)\. \(\+2 -4\)$/.test(rewriteAnswer), rewriteAnswer.trim());
    const replaced = await call('replace_in_file', { path: target, oldText: 'beta', newText: 'gamma\ndelta' });
    check('replace_in_file still replaces exactly once', /^Replaced one occurrence in /.test(replaced) && read(target) === 'alpha\ngamma\ndelta\n', read(target));
    // The line diff rides on the same answer, and for an edit it is the real one: one line
    // in, two lines out, so `+2 -1` rather than a count of the replaced block.
    check('and reports the lines it changed', /\(\+2 -1\)$/.test(replaced), replaced.trim());
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log('');
  if (problems.length) {
    console.log(`FAIL args: ${problems.length} of ${total} check(s) failed`);
    process.exit(1);
  }
  console.log(
    `PASS args: ${total}/${total} checks — arguments are strict JSON only, the removed frame answers one sentinel and writes nothing, ` +
      'append_file creates/appends while keeping the file EOL, and write_file / replace_in_file are unchanged',
  );
})();
