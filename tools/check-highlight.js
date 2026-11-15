#!/usr/bin/env node
/**
 * Guard for the vendored syntax colouring (see `docs/agents/invariants/vendored-deps.md`).
 *
 * Packaging fails when: a vendored bundle stops being eval-free (the webview CSP must
 * never need `'unsafe-eval'`), a grammar the index names is missing or unparseable, a
 * language this build promises no longer resolves, the engine stops colouring it, or the
 * webview's copy of the content key drifts from the host's.
 *
 * It loads the vendored engine exactly the way `src/chat/codeHighlight.ts` does, so a
 * broken pin fails here instead of turning every code block grey in a user's window.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'media', 'vendor');
const GRAMMAR_DIR = path.join(VENDOR, 'textmate-grammars');
const TEXTMATE = path.join(VENDOR, 'vscode-textmate', 'release', 'main.js');
const ONIG = path.join(VENDOR, 'vscode-oniguruma', 'release', 'main.js');
const ONIG_WASM = path.join(VENDOR, 'vscode-oniguruma', 'release', 'onig.wasm');

/** The fence words this build promises to colour (TIOBE's top 20 minus the tail, plus the conversation set). */
const PROMISED = [
  'python', 'c', 'java', 'cpp', 'csharp', 'javascript', 'r', 'sql', 'go', 'rust',
  'php', 'perl', 'swift', 'dart', 'typescript', 'tsx', 'jsx', 'json', 'yaml', 'xml',
  'html', 'css', 'scss', 'less', 'markdown', 'bash', 'sh', 'powershell', 'ps1', 'dockerfile',
  'makefile', 'diff', 'toml', 'kotlin', 'scala', 'haskell', 'elixir', 'graphql', 'proto',
  'terraform', 'cmake', 'nginx',
];

/** `lang` -> the class a sample block must produce. */
const CASES = [
  ['python', 'def f(x):\n    # note\n    return "s"', ['tm-k', 'tm-c', 'tm-s']],
  ['cpp', '#include <string>\nint main() { return 42; }', ['tm-k', 'tm-n']],
  ['bash', 'for f in *.txt; do echo "$f"; done', ['tm-k', 'tm-s']],
  ['powershell', 'Get-ChildItem | Where-Object { $_.Length -gt 1 }', ['tm-n']],
  ['json', '{"a": 1, "b": true}', ['tm-n']],
  ['diff', '--- a\n+++ b\n-old\n+new', ['tm-del', 'tm-add']],
  ['kick-start-only', 'no', []],
];

function assertEvalFree(file) {
  const src = fs.readFileSync(file, 'utf8');
  assert(!/\beval\s*\(/.test(src), `${path.relative(ROOT, file)} must stay eval-free`);
  assert(!/new Function\s*\(/.test(src), `${path.relative(ROOT, file)} must stay Function-free`);
}

/** The content key, duplicated on purpose: the host and the webview must agree on it. */
function key(lang, text) {
  const all = String(lang).toLowerCase() + '\0' + text;
  let h = 0x811c9dc5;
  for (let i = 0; i < all.length; i++) h = Math.imul(h ^ all.charCodeAt(i), 0x01000193) >>> 0;
  return `${h.toString(16)}:${all.length}`;
}

function resolve(index, lang) {
  const k = String(lang).toLowerCase();
  return index.languages[k] ?? index.languages[index.aliases[k]] ?? index.languages[index.extensions[k]] ?? null;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeHtml = (text) => text.replace(/[&<>"]/g, (ch) => ESC[ch]);

/** A deliberately small copy of the host's scope rules; it only has to agree on the classes the cases name. */
function classOf(scopes) {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const s = scopes[i];
    if (s.startsWith('comment')) return 'tm-c';
    if (s.startsWith('string.regexp')) return 'tm-r';
    if (s.startsWith('string')) return 'tm-s';
    if (s.startsWith('keyword') || s.startsWith('storage')) return 'tm-k';
    if (s.startsWith('constant.numeric') || s.startsWith('constant.language') || s.startsWith('constant.other')) return 'tm-n';
    if (s.startsWith('entity.name.function') || s.startsWith('support.function')) return 'tm-f';
    if (s.startsWith('entity.name.type') || s.startsWith('support.type') || s.startsWith('support.class')) return 'tm-t';
    if (s.startsWith('variable')) return 'tm-v';
    if (s.startsWith('markup.inserted')) return 'tm-add';
    if (s.startsWith('markup.deleted')) return 'tm-del';
    if (s.startsWith('markup.changed')) return 'tm-chg';
  }
  return null;
}

function render(vsctm, grammar, code) {
  let stack = vsctm.INITIAL;
  const out = [];
  for (const line of code.split('\n')) {
    const result = grammar.tokenizeLine(line, stack);
    stack = result.ruleStack;
    let html = '';
    for (const token of result.tokens) {
      const text = line.slice(token.startIndex, token.endIndex);
      if (!text) continue;
      const cls = classOf(token.scopes);
      html += cls ? `<span class="${cls}">${escapeHtml(text)}</span>` : escapeHtml(text);
    }
    out.push(html);
  }
  return out.join('\n');
}

function main() {
  assertEvalFree(TEXTMATE);
  assertEvalFree(ONIG);
  assert(fs.existsSync(ONIG_WASM), 'media/vendor/vscode-oniguruma/release/onig.wasm must ship');

  const index = JSON.parse(fs.readFileSync(path.join(GRAMMAR_DIR, 'index.json'), 'utf8'));
  assert(index.scopes && index.languages, 'index.json must carry scopes and languages');
  assert(Object.keys(index.languages).length >= 70, 'index.json lost most of its languages');
  for (const [scope, rel] of Object.entries(index.scopes)) {
    const file = path.join(GRAMMAR_DIR, rel);
    assert(fs.existsSync(file), `index.json points at a missing grammar: ${scope} -> ${rel}`);
  }

  const missing = PROMISED.filter((lang) => !resolve(index, lang));
  assert.deepStrictEqual(missing, [], `no grammar for: ${missing.join(', ')}`);

  // The webview's key must be the same function: both constants, or the two sides stop
  // agreeing and every fence silently stays plain.
  const webview = fs.readFileSync(path.join(ROOT, 'media', 'main.js'), 'utf8');
  assert(webview.includes('0x811c9dc5') && webview.includes('0x01000193'),
    'media/main.js `hlKey` must keep the same FNV-1a constants as the host');
  assert.strictEqual(key('ts', 'x'), 'eeae4cf8:4', 'the content key changed shape');

  const vsctm = require(TEXTMATE);
  const onig = require(ONIG);
  return onig
    .loadWASM({ data: fs.readFileSync(ONIG_WASM) })
    .then(() => {
      const registry = new vsctm.Registry({
        onigLib: Promise.resolve({
          createOnigScanner: (patterns) => new onig.OnigScanner(patterns),
          createOnigString: (s) => new onig.OnigString(s),
        }),
        loadGrammar: (scopeName) => {
          const rel = index.scopes[scopeName];
          if (!rel) return Promise.resolve(null);
          return Promise.resolve(vsctm.parseRawGrammar(fs.readFileSync(path.join(GRAMMAR_DIR, rel), 'utf8'), rel));
        },
      });
      return CASES.reduce(
        (chain, [lang, code, classes]) => chain.then(async () => {
          const scope = resolve(index, lang);
          if (!scope) return; // `kick-start-only` is the negative control, by design
          const grammar = await registry.loadGrammar(scope);
          assert(grammar, `grammar for ${lang} (${scope}) did not load`);
          const html = render(vsctm, grammar, code);
          for (const cls of classes) {
            assert(html.includes(`class="${cls}"`), `${lang}: expected a ${cls} span, got ${html.slice(0, 200)}`);
          }
        }),
        Promise.resolve(),
      );
    })
    .then(() => {
      console.log(`check:highlight OK — ${Object.keys(index.scopes).length} scopes, ${PROMISED.length} promised languages, ${CASES.length - 1} rendered`);
    });
}

Promise.resolve()
  .then(main)
  .catch((error) => {
    console.error(`check:highlight FAILED: ${error && error.message ? error.message : error}`);
    process.exit(1);
  });
