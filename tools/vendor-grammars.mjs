#!/usr/bin/env node
/**
 * Re-vendor the TextMate grammars under `media/vendor/textmate-grammars/`.
 *
 * Dev-only: it is excluded from the package (`tools/**`), never runs at install or
 * build time, and the files it writes are the pinned copies that ship.
 *
 * Two upstreams, on purpose:
 *
 *  - `microsoft/vscode` at a release tag — every grammar its built-in language
 *    extensions declare. One tag, one notice file, and the include closure is
 *    complete because the whole set is present.
 *  - `tm-grammars` (shikijs/textmate-grammars-themes) — the handful of languages
 *    VS Code does not ship, taken as normalized JSON out of one tarball whose
 *    `NOTICE` records each file's upstream, SPDX id and license text.
 *
 * Usage:
 *   node tools/vendor-grammars.mjs --vscode 1.146.0 --shiki <unpacked tm-grammars dir>
 *
 * `--shiki` points at the extracted npm tarball (`package/` inside it), because the
 * pin record quotes the tarball integrity of the published package.
 *
 * It writes `index.json` beside the grammars: scope -> file, language id -> scope,
 * and alias -> language id. Nothing in the extension reads that file by hand; see
 * `src/chat/codeHighlight.ts`.
 */
import { mkdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'media/vendor/textmate-grammars';
const VSCODE_GRAMMARS = `${ROOT}/vscode`;
const SHIKI_GRAMMARS = `${ROOT}/tm-grammars`;

/** The languages VS Code does not ship a grammar for (see docs/agents/invariants/vendored-deps.md). */
const SHIKI_WANTED = [
  'diff', 'toml', 'kotlin', 'scala', 'haskell', 'elixir', 'graphql', 'proto',
  'terraform', 'hcl', 'cmake', 'nginx',
];

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const VSCODE_TAG = opt('vscode');
const SHIKI_DIR = opt('shiki');
if (!VSCODE_TAG || !SHIKI_DIR) {
  console.error('usage: node tools/vendor-grammars.mjs --vscode <tag> --shiki <unpacked tm-grammars dir>');
  process.exit(2);
}

const UA = { 'User-Agent': 'spinney-vendor-script' };

async function getText(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) return null;
  return res.text();
}

async function getJson(url) {
  const text = await getText(url);
  return text ? JSON.parse(text) : null;
}

/** Run `task` over `items`, at most `limit` at a time, keeping the input order. */
async function pool(items, limit, task) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await task(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

const raw = (path) => `https://raw.githubusercontent.com/microsoft/vscode/${VSCODE_TAG}/${path}`;

async function put(relPath, bytes) {
  const abs = join(relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
  return bytes.length;
}

async function main() {
  const scopes = {};
  const languages = {};
  const aliases = {};
  const fileExts = {};
  const conflicts = [];
  let files = 0;
  let bytes = 0;

  // ---- 1. microsoft/vscode: every built-in language extension's grammars ----
  const listing = await getJson(
    `https://api.github.com/repos/microsoft/vscode/contents/extensions?ref=${VSCODE_TAG}`,
  );
  if (!listing) throw new Error(`cannot list extensions at ${VSCODE_TAG}`);
  const deps = listing.filter((e) => e.type === 'dir');
  console.log(`vscode ${VSCODE_TAG}: ${deps.length} extension directories`);

  const manifests = await pool(deps, 8, async (dir) => {
    const json = await getJson(raw(`extensions/${dir.name}/package.json`)).catch(() => null);
    return json ? { name: dir.name, json } : null;
  });

  const wanted = [];
  for (const entry of manifests) {
    if (!entry) continue;
    const c = entry.json.contributes || {};
    for (const lang of c.languages || []) {
      if (!lang.id) continue;
      languages[lang.id] = languages[lang.id] || null; // filled once a grammar is known
      for (const alias of lang.aliases || []) {
        const key = String(alias).toLowerCase();
        if (!key) continue;
        if (aliases[key] && aliases[key] !== lang.id) { conflicts.push(`alias ${key}: ${aliases[key]} kept`); continue; }
        aliases[key] = lang.id;
      }
      // File extensions double as fence words: `yml`, `cc`, `h`, `kt`, `md` are what a
      // model writes in the info string, and they are not aliases.
      for (const ext of lang.extensions || []) {
        const key = String(ext).replace(/^\./, '').toLowerCase();
        if (!key) continue;
        if (fileExts[key] && fileExts[key] !== lang.id) { conflicts.push(`ext ${key}: ${fileExts[key]} kept`); continue; }
        fileExts[key] = lang.id;
      }
    }
    for (const g of c.grammars || []) {
      if (!g.scopeName || !g.path) continue;
      const rel = String(g.path).replace(/^\.\//, '');
      wanted.push({ ext: entry.name, scopeName: g.scopeName, language: g.language, rel });
    }
  }
  console.log(`vscode: ${wanted.length} grammar declarations`);

  const downloaded = await pool(wanted, 8, async (g) => {
    const rel = posix.join('vscode', g.ext, g.rel);
    const text = await getText(raw(`extensions/${g.ext}/${g.rel}`));
    if (text === null) { console.warn(`  missing ${g.ext}/${g.rel}`); return null; }
    const size = await put(join(ROOT, rel), text);
    return { ...g, rel, size };
  });

  for (const g of downloaded) {
    if (!g) continue;
    files += 1; bytes += g.size;
    if (scopes[g.scopeName]) { conflicts.push(`scope ${g.scopeName}: ${scopes[g.scopeName]} kept`); continue; }
    scopes[g.scopeName] = g.rel;
  }

  // One language can declare several grammars (`cpp` also declares the embedded-macro
  // and CUDA grammars), so the *primary* one is chosen by shape, not by file order.
  const candidates = new Map();
  for (const g of downloaded) {
    if (!g || !g.language) continue;
    if (scopes[g.scopeName] !== g.rel) continue; // a duplicate scope that lost
    if (!candidates.has(g.language)) candidates.set(g.language, []);
    candidates.get(g.language).push(g);
  }
  const rank = (language, scopeName) => {
    const id = language.toLowerCase();
    const s = scopeName.toLowerCase();
    if (s === `source.${id}`) return 0;
    if (s === `text.html.${id}`) return 1;
    if (s === `text.${id}`) return 2;
    if (s === `source.${id}.basic`) return 3;
    if (s.split('.').includes(id)) return 4;
    if (s.startsWith(`source.${id}.`)) return 5;
    if (s.startsWith(`text.${id}.`)) return 6;
    if (s.includes(id)) return 8;
    return 20;
  };
  for (const [language, list] of candidates) {
    list.sort((a, b) => rank(language, a.scopeName) - rank(language, b.scopeName)
      || a.scopeName.length - b.scopeName.length);
    languages[language] = list[0].scopeName;
  }
  // A couple of ids are carried by a grammar that declares no `language` at all
  // (`text.html.basic`), so the scope is named here instead of guessed.
  const PREFERRED_SCOPE = { html: 'text.html.basic', markdown: 'text.html.markdown' };
  for (const [id, scope] of Object.entries(PREFERRED_SCOPE)) {
    if (scopes[scope]) languages[id] = scope;
  }
  // An id with no grammar of its own stays unmapped rather than mapping to nothing,
  // unless the scope set holds the obvious scope for it.
  for (const id of Object.keys(languages)) {
    if (languages[id]) continue;
    for (const candidate of [`source.${id}`, `text.${id}`, `text.html.${id}`]) {
      if (scopes[candidate]) { languages[id] = candidate; break; }
    }
    if (!languages[id]) delete languages[id];
  }

  const notice = await getText(raw('ThirdPartyNotices.txt'));
  if (notice) await put(join(ROOT, 'vscode-ThirdPartyNotices.txt'), notice);

  // ---- 2. tm-grammars: the languages VS Code does not ship ----
  const shikiIndex = await import(pathToFileURL(join(SHIKI_DIR, 'index.js')).href);
  const byName = new Map(shikiIndex.grammars.map((g) => [g.name, g]));
  for (const name of SHIKI_WANTED) {
    const meta = byName.get(name);
    if (!meta) { console.warn(`  tm-grammars has no ${name}`); continue; }
    const src = join(SHIKI_DIR, 'grammars', `${name}.json`);
    const rel = posix.join('tm-grammars', `${name}.json`);
    await mkdir(join(ROOT, 'tm-grammars'), { recursive: true });
    await copyFile(src, join(ROOT, rel));
    files += 1;
    bytes += (await stat(src)).size;
    languages[name] = meta.scopeName;
    for (const alias of meta.aliases || []) {
      const key = String(alias).toLowerCase();
      if (aliases[key] && aliases[key] !== name) { conflicts.push(`alias ${key}: ${aliases[key]} kept`); continue; }
      aliases[key] = name;
    }
    if (scopes[meta.scopeName]) { conflicts.push(`scope ${meta.scopeName}: ${scopes[meta.scopeName]} kept`); continue; }
    scopes[meta.scopeName] = rel;
  }
  await copyFile(join(SHIKI_DIR, 'NOTICE'), join(ROOT, 'tm-grammars-NOTICE.txt'));
  await copyFile(join(SHIKI_DIR, 'LICENSE'), join(ROOT, 'tm-grammars-LICENSE.txt'));

  // ---- 3. the index the extension actually reads ----
  const index = {
    version: 1,
    sources: { 'microsoft/vscode': VSCODE_TAG, 'tm-grammars': '1.32.22' },
    scopes,
    languages,
    aliases,
    extensions: fileExts,
  };
  await writeFile(join(ROOT, 'index.json'), JSON.stringify(index, null, 1) + '\n');

  const langCount = Object.values(languages).filter(Boolean).length;
  console.log(`wrote ${files} grammar files, ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`${Object.keys(scopes).length} scopes, ${langCount} languages, ${Object.keys(aliases).length} aliases`);
  if (conflicts.length) {
    console.log(`${conflicts.length} duplicate declarations kept the first grammar:`);
    for (const c of conflicts.slice(0, 40)) console.log(`  ${c}`);
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
