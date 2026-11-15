/**
 * Syntax colouring for fenced code blocks, computed **in the extension host**.
 *
 * Why the host and not the webview: the colouring engine is what VS Code itself uses
 * (`vscode-textmate` on top of `vscode-oniguruma`), and oniguruma is a WebAssembly
 * module. A webview would need `'wasm-unsafe-eval'` in its CSP to compile it, and its
 * render path is synchronous (`media/main.js` `renderMarkdown`), while loading a
 * grammar is not. The extension host has neither problem: wasm runs under Node, and a
 * finished answer can wait a few milliseconds for its spans.
 *
 * The grammars and the two runtime bundles are vendored under `media/vendor/` — see
 * `docs/agents/invariants/vendored-deps.md`. Nothing here is resolved from npm, and
 * nothing is downloaded: the index and the grammar files are read off the extension's
 * own install directory.
 *
 * The module is deliberately *pull*: the webview asks for the fences it could not
 * colour, the host answers with an escaped HTML fragment per fence, cached by the same
 * content key on both sides. That keeps `ok` streaming untouched (a half-written fence
 * is never coloured, because nobody asks for one — the webview only asks on a render it
 * already believes complete) and it needs no lifecycle hook in `SessionRuntime`.
 */
import * as fs from 'fs';
import * as path from 'path';

// ---- The vendored engine, typed just enough ----------------------------------

interface TextMateToken {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly scopes: readonly string[];
}

interface TextMateGrammar {
  tokenizeLine(line: string, prevState: unknown): { tokens: readonly TextMateToken[]; ruleStack: unknown };
}

interface TextMateRegistry {
  loadGrammar(scopeName: string): Promise<TextMateGrammar | undefined>;
}

interface TextMateModule {
  Registry: new (options: Record<string, unknown>) => TextMateRegistry;
  INITIAL: unknown;
  parseRawGrammar(content: string, filePath?: string): unknown;
}

interface OnigurumaModule {
  loadWASM(options: { data: Uint8Array }): Promise<void>;
  OnigScanner: new (patterns: string[]) => unknown;
  OnigString: new (text: string) => unknown;
}

/** `<extension root>/media/vendor`, relative to this file in `out/chat/`. */
const VENDOR = path.resolve(__dirname, '..', '..', 'media', 'vendor');
const GRAMMAR_DIR = path.join(VENDOR, 'textmate-grammars');

const TEXTMATE_MAIN = path.join(VENDOR, 'vscode-textmate', 'release', 'main.js');
const ONIG_MAIN = path.join(VENDOR, 'vscode-oniguruma', 'release', 'main.js');
const ONIG_WASM = path.join(VENDOR, 'vscode-oniguruma', 'release', 'onig.wasm');

/** One fence the webview could not colour, exactly as markdown-it handed it over. */
export interface HighlightItem {
  readonly lang: string;
  readonly text: string;
}

interface GrammarIndex {
  readonly scopes: Record<string, string>;
  readonly languages: Record<string, string>;
  readonly aliases: Record<string, string>;
  readonly extensions: Record<string, string>;
}

/** Past these a block is left plain: colouring is a nicety, not worth a stalled host. */
const MAX_BLOCK_CHARS = 200_000;
const MAX_BLOCK_LINES = 4000;
const MAX_CACHE = 512;

const cache = new Map<string, string>();
let engine: Promise<Engine | null> | null = null;

interface Engine {
  readonly registry: TextMateRegistry;
  readonly vsctm: TextMateModule;
  readonly index: GrammarIndex;
}

/**
 * The key both sides agree on. Same algorithm in `media/main.js` (`hlKey`) — a 32-bit
 * FNV-1a over the language and the code, plus the length, so a collision would need two
 * equally long blocks with the same hash. The webview cannot use `crypto.subtle`
 * (asynchronous), and a full copy of the code as a key would double every payload.
 */
export function highlightKey(lang: string, text: string): string {
  const all = lang.toLowerCase() + '\0' + text;
  let h = 0x811c9dc5;
  for (let i = 0; i < all.length; i++) {
    h = Math.imul(h ^ all.charCodeAt(i), 0x01000193) >>> 0;
  }
  return `${h.toString(16)}:${all.length}`;
}

/** A fence's info string to a scope name, through the vendored index. */
function scopeFor(index: GrammarIndex, lang: string): string | null {
  const key = lang.trim().toLowerCase();
  if (!key) return null;
  return (
    index.languages[key] ??
    index.languages[index.aliases[key]] ??
    index.languages[index.extensions[key]] ??
    null
  );
}

/**
 * The class names the webview's stylesheet knows. Ordered rules, matched from the
 * innermost scope outward, which is how a theme resolves a token: the most specific
 * scope wins and a bare `punctuation` gets no span at all.
 */
function classForScope(scope: string): string | null {
  if (scope.startsWith('comment')) return 'tm-c';
  if (scope.startsWith('string.regexp')) return 'tm-r';
  if (scope.startsWith('string')) return 'tm-s';
  if (scope.startsWith('keyword.operator')) return 'tm-o';
  if (scope.startsWith('keyword') || scope.startsWith('storage')) return 'tm-k';
  if (scope.startsWith('constant.numeric')) return 'tm-n';
  if (scope.startsWith('constant.character.escape')) return 'tm-e';
  if (scope.startsWith('constant.language') || scope.startsWith('constant.other')) return 'tm-n';
  if (scope.startsWith('entity.name.function') || scope.startsWith('support.function')) return 'tm-f';
  if (scope.startsWith('entity.name.type') || scope.startsWith('entity.name.class')) return 'tm-t';
  if (scope.startsWith('entity.name.tag') || scope.startsWith('entity.name.namespace')) return 'tm-t';
  if (scope.startsWith('support.type') || scope.startsWith('support.class')) return 'tm-t';
  if (scope.startsWith('entity.name')) return 'tm-f';
  if (scope.startsWith('variable.parameter')) return 'tm-v';
  if (scope.startsWith('variable.language') || scope.startsWith('variable.other')) return 'tm-v';
  if (scope.startsWith('markup.inserted')) return 'tm-add';
  if (scope.startsWith('markup.deleted')) return 'tm-del';
  if (scope.startsWith('markup.changed')) return 'tm-chg';
  if (scope.startsWith('markup.heading')) return 'tm-k';
  if (scope.startsWith('markup.bold') || scope.startsWith('markup.italic')) return 'tm-b';
  if (scope.startsWith('invalid')) return 'tm-i';
  return null;
}

function classFor(scopes: readonly string[]): string | null {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const cls = classForScope(scopes[i]);
    if (cls) return cls;
  }
  return null;
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => ENTITIES[ch]);
}

/** One fence, tokenized line by line, as the inner HTML of its `<code>` element. */
function renderCode(engine: Engine, grammar: TextMateGrammar, code: string): string {
  const lines = code.split(/\r\n|\n/);
  const out: string[] = [];
  let stack = engine.vsctm.INITIAL;
  for (const line of lines) {
    const result = grammar.tokenizeLine(line, stack);
    stack = result.ruleStack;
    let html = '';
    for (const token of result.tokens) {
      const text = line.slice(token.startIndex, token.endIndex);
      if (!text) continue;
      const cls = classFor(token.scopes);
      html += cls ? `<span class="${cls}">${escapeHtml(text)}</span>` : escapeHtml(text);
    }
    out.push(html);
  }
  return out.join('\n');
}

/** Build the registry once: read the index, load the wasm, wire `loadGrammar`. */
async function build(report: (line: string) => void): Promise<Engine | null> {
  let vsctm: TextMateModule;
  let oniguruma: OnigurumaModule;
  let index: GrammarIndex;
  try {
    // `require` and not an import: these are vendored browser bundles, not modules of
    // this project, and `package.json` never names them (see the vendoring invariant).
    vsctm = require(TEXTMATE_MAIN) as TextMateModule;
    oniguruma = require(ONIG_MAIN) as OnigurumaModule;
    index = JSON.parse(fs.readFileSync(path.join(GRAMMAR_DIR, 'index.json'), 'utf8')) as GrammarIndex;
    await oniguruma.loadWASM({ data: fs.readFileSync(ONIG_WASM) });
  } catch (error) {
    report(`syntax colouring unavailable: ${String(error)}`);
    return null;
  }

  const registry = new vsctm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns: string[]) => new oniguruma.OnigScanner(patterns),
      createOnigString: (text: string) => new oniguruma.OnigString(text),
    }),
    loadGrammar: async (scopeName: string) => {
      const rel = index.scopes[scopeName];
      if (!rel) return null;
      // The real file name, extension and all: `parseRawGrammar` sniffs plist grammars
      // by their own extension, and a handful of the vendored ones are still XML.
      const file = path.join(GRAMMAR_DIR, rel);
      try {
        return vsctm.parseRawGrammar(fs.readFileSync(file, 'utf8'), rel);
      } catch {
        return null;
      }
    },
  });

  return { registry, vsctm, index };
}

function remember(key: string, html: string): void {
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, html);
}

/**
 * Start the engine now, so the first finished answer does not pay for it.
 *
 * Called from `activate`. It never throws and never blocks: a failure leaves the
 * engine `null` and every fence renders as plain text, which is exactly what a build
 * without the vendored files does.
 */
export function warmUpCodeHighlight(report: (line: string) => void = () => undefined): void {
  if (engine) return;
  engine = build(report).catch((error) => {
    report(`syntax colouring unavailable: ${String(error)}`);
    return null;
  });
}

/**
 * Answer the webview: one entry per fence it asked about, and nothing for a language
 * this build has no grammar for (the caller keeps that fence plain).
 */
export async function highlightEntries(
  items: readonly HighlightItem[],
  report: (line: string) => void = () => undefined,
): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  if (!items.length) return entries;
  warmUpCodeHighlight(report);
  const built = await engine;
  if (!built) return entries;

  for (const item of items) {
    if (typeof item?.lang !== 'string' || typeof item?.text !== 'string') continue;
    const key = highlightKey(item.lang, item.text);
    const hit = cache.get(key);
    if (hit !== undefined) {
      entries[key] = hit;
      continue;
    }
    if (item.text.length > MAX_BLOCK_CHARS) continue;
    const scope = scopeFor(built.index, item.lang);
    if (!scope) continue;
    try {
      const grammar = await built.registry.loadGrammar(scope);
      if (!grammar) continue;
      const lines = item.text.split('\n').length;
      if (lines > MAX_BLOCK_LINES) continue;
      const html = renderCode(built, grammar, item.text);
      remember(key, html);
      entries[key] = html;
    } catch (error) {
      // One grammar that cannot cope with one block must not cost the turn: the fence
      // stays plain and the reason goes to the diagnostics log.
      report(`syntax colouring failed for ${item.lang}: ${String(error)}`);
    }
  }
  return entries;
}
