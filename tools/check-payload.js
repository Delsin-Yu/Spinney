/*
 * check-payload — the request body, and the command that shows it, as a build-time
 * guard (`docs/agents/invariants/request-payload.md`).
 *
 * Why it exists: `Spinney: Show Request Payload` is only useful if what it shows is what
 * would be **sent**. The two can drift apart in exactly one way — a second body
 * constructor, or an inline body that grows back beside the shared one — and neither
 * shows up as an error: the command keeps opening a tab, and the tab keeps looking
 * plausible while the wire does something else. So this guard pins the body itself:
 *
 *   1. the one constructor's output, field by field and key order included (that order
 *      is what the provider's prompt cache keys on);
 *   2. `ApiClient.stream()` and `ApiClient.complete()` really call it (read off the
 *      compiled methods, not off the source text, so a moved method cannot fool it);
 *   3. `SessionRuntime.requestPayload()` builds its body that way and normalises it the
 *      way the wire does (source scan: it lives behind `vscode`, so it cannot be
 *      required here);
 *   4. nothing in either file names a model id — the wire name always comes from the
 *      card (`src/agent/models.ts` is the only place an id may be written).
 *
 * Needs `out/` (run `npm run compile` first).
 *
 * Run: npm run check:payload   /   node tools/check-payload.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const apiPath = path.join(root, 'out', 'agent', 'apiClient.js');
const modelsPath = path.join(root, 'out', 'agent', 'models.js');

for (const [label, file] of [
  ['out/agent/apiClient.js', apiPath],
  ['out/agent/models.js', modelsPath],
]) {
  if (!fs.existsSync(file)) {
    console.error(`check-payload: ${label} is missing — run \`npm run compile\` first.`);
    process.exit(1);
  }
}

const { ApiClient, buildChatRequestBody, chatCompletionsUrl } = require(apiPath);
const { MODEL_CATALOG } = require(modelsPath);

const problems = [];
const ok = (label, cond, detail) => {
  console.log(`  [${cond ? 'ok  ' : 'FAIL'}] ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) {
    problems.push(label);
  }
};

const messages = [
  { role: 'system', content: 'SYSTEM' },
  { role: 'user', content: 'hello' },
];
const tools = [
  {
    type: 'function',
    function: { name: 'exec_command', description: 'run', parameters: { type: 'object', properties: {} } },
  },
];

// ---- §1: the body, field by field ----------------------------------------------------

console.log('-- a streaming request always says stream: true and include_usage --');
{
  const body = buildChatRequestBody({ model: 'whatever-the-card-says', messages, stream: true });
  ok('stream is exactly true', body.stream === true, String(body.stream));
  ok('stream_options.include_usage is true', body.stream_options?.include_usage === true);
  ok(
    'a non-streaming request carries no stream_options at all',
    !('stream_options' in buildChatRequestBody({ model: 'm', messages, stream: false })),
  );
  ok('a non-streaming request says stream: false', buildChatRequestBody({ model: 'm', messages, stream: false }).stream === false);
}

console.log('-- the model is the resolved string, verbatim --');
{
  const body = buildChatRequestBody({ model: 'the-wire-name', messages, stream: true });
  ok('model is passed through untouched', body.model === 'the-wire-name', String(body.model));
  ok('messages are passed through untouched', body.messages === messages);
}

console.log('-- tools appear only when there are some --');
{
  ok('no tools key without tools', !('tools' in buildChatRequestBody({ model: 'm', messages, stream: true })));
  ok('no tools key for an empty array', !('tools' in buildChatRequestBody({ model: 'm', messages, tools: [], stream: true })));
  const withTools = buildChatRequestBody({ model: 'm', messages, tools, stream: true });
  ok('the tools array is the one given', withTools.tools === tools);
}

console.log('-- reasoning_effort is omitted for none --');
{
  const none = buildChatRequestBody({ model: 'm', messages, thinkingEffort: 'none', stream: true });
  ok("absent when the level is 'none'", !('reasoning_effort' in none));
  ok('absent when there is no level at all', !('reasoning_effort' in buildChatRequestBody({ model: 'm', messages, stream: true })));
  const high = buildChatRequestBody({ model: 'm', messages, thinkingEffort: 'high', stream: true });
  ok('the level verbatim otherwise', high.reasoning_effort === 'high', String(high.reasoning_effort));
}

console.log('-- max_tokens and temperature appear only when given --');
{
  const bare = buildChatRequestBody({ model: 'm', messages, stream: true });
  ok('neither key without them', !('max_tokens' in bare) && !('temperature' in bare));
  ok(
    'max_tokens 0 is not a value',
    !('max_tokens' in buildChatRequestBody({ model: 'm', messages, maxTokens: 0, stream: true })),
  );
  ok(
    'max_tokens -1 is not a value',
    !('max_tokens' in buildChatRequestBody({ model: 'm', messages, maxTokens: -1, stream: true })),
  );
  ok(
    'max_tokens is floored',
    buildChatRequestBody({ model: 'm', messages, maxTokens: 12.7, stream: true }).max_tokens === 12,
  );
  ok(
    'temperature NaN is not a value',
    !('temperature' in buildChatRequestBody({ model: 'm', messages, temperature: NaN, stream: true })),
  );
  const warm = buildChatRequestBody({ model: 'm', messages, temperature: 0.3, stream: true });
  ok('temperature 0.3 goes through', warm.temperature === 0.3, String(warm.temperature));
  const zero = buildChatRequestBody({ model: 'm', messages, temperature: 0, stream: true });
  ok('temperature 0 is a value, not an absence', zero.temperature === 0);
}

console.log('-- key order is part of the output (the prefix cache keys on it) --');
{
  const full = (stream) =>
    Object.keys(
      buildChatRequestBody({
        model: 'm',
        messages,
        tools,
        thinkingEffort: 'high',
        maxTokens: 128,
        temperature: 0.2,
        stream,
      }),
    );
  const streamKeys = full(true);
  const completeKeys = full(false);
  ok(
    'stream: model, messages, stream, stream_options, tools, reasoning_effort, max_tokens, temperature',
    streamKeys.join(',') ===
      'model,messages,stream,stream_options,tools,reasoning_effort,max_tokens,temperature',
    streamKeys.join(','),
  );
  ok(
    'complete: the same minus stream_options',
    completeKeys.join(',') === 'model,messages,stream,tools,reasoning_effort,max_tokens,temperature',
    completeKeys.join(','),
  );
}

console.log('-- the same input twice builds the same body (it is pure) --');
{
  const input = {
    model: 'm',
    messages,
    tools,
    thinkingEffort: 'high',
    maxTokens: 128,
    temperature: 0.2,
    stream: true,
  };
  const a = buildChatRequestBody(input);
  const b = buildChatRequestBody(input);
  ok('deeply equal', JSON.stringify(a) === JSON.stringify(b));
  ok('and two distinct objects (a caller cannot corrupt the next)', a !== b);
  ok(
    'nothing is left behind on the input',
    Object.keys(input).join(',') === 'model,messages,tools,thinkingEffort,maxTokens,temperature,stream',
  );
  ok('no credential can be in the body (the key is a header)', !JSON.stringify(a).includes('Bearer'));
  ok('no Authorization field', !('Authorization' in a) && !('authorization' in a));
}

console.log('-- the endpoint is one spelling --');
{
  ok('baseUrl + /chat/completions', chatCompletionsUrl('https://example.test') === 'https://example.test/chat/completions');
  ok('one trailing slash is tolerated', chatCompletionsUrl('https://example.test/') === 'https://example.test/chat/completions');
}

// ---- §2: the call sites --------------------------------------------------------------

console.log('-- stream() and complete() call the one constructor --');
{
  const streamBody = ApiClient.prototype.stream.toString();
  const completeBody = ApiClient.prototype.complete.toString();
  ok('stream() calls buildChatRequestBody', streamBody.includes('buildChatRequestBody'));
  ok('complete() calls buildChatRequestBody', completeBody.includes('buildChatRequestBody'));
  // The body's own fields, as assignments: a comment may name one without building it,
  // and the call itself carries the request's own `maxTokens` / `temperature` arguments.
  const fields = ['body.stream_options =', 'body.tools =', 'body.reasoning_effort =', 'body.max_tokens =', 'body.temperature ='];
  ok('stream() builds no body field of its own', fields.every((f) => !streamBody.includes(f)), fields.filter((f) => streamBody.includes(f)).join(', '));
  ok('complete() builds no body field of its own', fields.every((f) => !completeBody.includes(f)), fields.filter((f) => completeBody.includes(f)).join(', '));
  const builderBody = buildChatRequestBody.toString();
  const count = (text, needle) => text.split(needle).length - 1;
  ok('the constructor owns stream_options (exactly one)', count(builderBody, 'body.stream_options =') === 1);
  ok('the constructor owns tools (exactly one)', count(builderBody, 'body.tools =') === 1);
  ok('the constructor owns reasoning_effort (exactly one)', count(builderBody, 'body.reasoning_effort =') === 1);
  ok('the constructor owns max_tokens (exactly one)', count(builderBody, 'body.max_tokens =') === 1);
  ok('the constructor owns temperature (exactly one)', count(builderBody, 'body.temperature =') === 1);
  // The compiled call shape (`(0, text_1.wellFormedDeep)(body)`) is what both paths do,
  // so the shorthand below is the same assertion without pinning the import form.
  ok(
    'the wire copy is wellFormedDeep-normalised in stream()',
    streamBody.includes('wellFormedDeep)(body)'),
  );
  ok(
    'the wire copy is wellFormedDeep-normalised in complete()',
    completeBody.includes('wellFormedDeep)(body)'),
  );
}

console.log('-- the command builds its body the same way --');
{
  const runtimeSource = fs.readFileSync(path.join(root, 'src', 'chat', 'runtime.ts'), 'utf8');
  const start = runtimeSource.indexOf('requestPayload():');
  const stop = start < 0 ? -1 : runtimeSource.indexOf('\n  /**', start);
  const region = start < 0 ? '' : runtimeSource.slice(start, stop > start ? stop : start + 4000);
  ok('SessionRuntime.requestPayload() exists', start > 0);
  ok('it calls buildChatRequestBody', region.includes('buildChatRequestBody'));
  ok('it normalises with wellFormedDeep like the wire does', region.includes('wellFormedDeep('));
  ok('it sends the card wire name, never a literal', region.includes('card.oaiModel'));
  ok('it streams (the interactive request is a stream)', /stream:\s*true/.test(region));
  ok('it names no credential', !/apiKey|Authorization|Bearer/i.test(region));
  const provider = fs.readFileSync(path.join(root, 'src', 'chat', 'ChatViewProvider.ts'), 'utf8');
  ok('the command renders that payload as JSON', /JSON\.stringify\(payload\.body,\s*null,\s*2\)/.test(provider));
  ok('and opens an untitled document (no temp file)', !/writeFileSync\(.*payload/i.test(provider));
}

// ---- §3: no model id literal -------------------------------------------------------

console.log('-- the wire model name always comes from the card --');
{
  const ids = MODEL_CATALOG.map((m) => m.id.toLowerCase());
  const modelRe = new RegExp([...new Set([...ids, 'deepseek-[a-z0-9][a-z0-9.\\-]*'])].join('|'), 'gi');
  // The bare dialect word (`vision.transport === 'deepseek'`) is not a model id: the
  // pattern needs the dash, which every catalog id has.
  const offenders = [];
  for (const rel of ['src/agent/apiClient.ts', 'src/chat/runtime.ts']) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    text.split(/\r?\n/).forEach((line, i) => {
      const hit = line.match(modelRe);
      if (hit) {
        offenders.push(`${rel}:${i + 1}: ${hit.join(', ')}`);
      }
    });
  }
  ok('no model id literal in the payload path', offenders.length === 0, offenders.join('; '));
}

console.log('');
if (problems.length) {
  console.log(`FAIL payload: ${problems.length} check(s) failed`);
  process.exit(1);
}
console.log(
  'PASS payload: one body constructor, called by stream(), complete() and Show Request Payload, ' +
    'inside one set of wire rules (stream/stream_options, tools only when non-empty, no reasoning_effort for none, ' +
    'max_tokens/temperature only when given) and no model id in sight',
);
