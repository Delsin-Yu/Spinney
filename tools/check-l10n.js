// check-l10n.js — fails the build when the UI catalogs drift from the UI code.
//
// The extension keeps exactly one catalog per language and keys it by the English
// source string (VS Code's own `l10n/bundle.l10n.<locale>.json` convention), so
// nothing can be "translated twice" — but nothing catches a *stale* key either:
// reword a dialog and the old entry just sits there, or add a string and the window
// silently falls back to English while the catalog still looks complete. Neither
// shows up as a compile error, and `check-webview.js` cannot see it (it loads
// `media/main.js` with no dictionary at all, by design).
//
// So this script reads the three places a translatable string can live —
//   host      src/**/*.ts    → `vscode.l10n.t('<English source>')`
//   webview   media/*.js     → `tr('<English source>')`
//   manifest  package.json   → `%key%`, resolved through `package.nls.json`
// — and asserts, for every locale shipped in `l10n/` and `package.nls.*.json`:
//
//   1. every source string used in the code has an entry (no silent English),
//   2. every entry is still used in the code (no stale translation),
//   3. a translation uses the same `{0}` / `{1}` placeholders as its source,
//   4. the per-locale manifest files cover exactly the keys of `package.nls.json`,
//   5. every `%key%` in package.json is defined in `package.nls.json`,
//   6. every generated alias (`zh-cn` copying `zh-Hans`, see `src/languageTags.ts`)
//      exists and is byte-identical to the canonical catalog it copies.
//
// Rule 6 is the one that is not about translation quality at all: VS Code reads
// `l10n/bundle.l10n.<what it reports>.json` and `package.nls.<what it reports>.json`
// itself, the repo only authors the canonical, region-invariant names, and
// `tools/sync-l10n-aliases.js` writes those copies for the length of a package run.
// A `.vsix` packaged without them has a Chinese webview and an English host — the
// one failure this whole arrangement exists to prevent.
//
// Run by `npm run check:l10n`, which `vsce package` executes through
// `vscode:prepublish`, so this fails packaging, not the user's window.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const problems = [];
const notes = [];

let REPORTED_TAGS;
try {
  // The canonical ↔ reported tag pair, read from the compiled module for the same
  // reason `check-models.js` reads `out/agent/models.js`: one table, no copy here.
  ({ REPORTED_TAGS } = require(path.join(root, 'out', 'languageTags.js')));
} catch (err) {
  console.error(`check-l10n: cannot read out/languageTags.js (${err.message})`);
  console.error('  - run `npm run compile` first (vscode:prepublish does)');
  process.exit(1);
}

/** The reported tag of a catalog → the canonical tag whose content it copies. */
const ALIAS_OF = Object.fromEntries(
  Object.entries(REPORTED_TAGS).map(([canonical, reported]) => [reported, canonical]),
);

/**
 * A generated alias is a byte-for-byte copy, so there is nothing to check *inside*
 * one — only that it exists (the `.vsix` needs it) and that it still matches the
 * canonical catalog it copies.
 */
function checkAlias(dir, prefix, reported) {
  const canonical = ALIAS_OF[reported];
  const aliasName = `${prefix}${reported}.json`;
  const sourceName = `${prefix}${canonical}.json`;
  const aliasPath = path.join(dir, aliasName);
  const sourcePath = path.join(dir, sourceName);
  const label = dir === root ? aliasName : path.join(path.relative(root, dir), aliasName);
  const sourceLabel = dir === root ? sourceName : path.join(path.relative(root, dir), sourceName);
  if (!fs.existsSync(sourcePath)) {
    problems.push(`${sourceLabel} — missing (${label} copies it)`);
  } else if (!fs.readFileSync(aliasPath).equals(fs.readFileSync(sourcePath))) {
    problems.push(`${label} — differs from ${sourceLabel}: it is generated, run \`npm run sync:l10n\``);
  } else {
    notes.push(`${label}: generated alias of ${sourceLabel}`);
  }
}

/** Directories walked for host strings. */
const SRC_DIRS = ['src'];
/** Files walked for webview strings. `tree.js` is pure geometry and has none. */
const MEDIA_DIRS = ['media'];

/**
 * A translatable call site must pass **one string literal**, so the extractor can
 * see the key: `vscode.l10n.t('Send')`, `tr('{0} nodes', n)`. A concatenated or
 * template-literal message is invisible here (and would also be invisible to a
 * translator), which is why this is a hard rule and not a style preference.
 */
const HOST_CALL = /vscode\.l10n\.t\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
const WEBVIEW_CALL = /(?<![\w.$])tr\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g;

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'vendor' || entry.name === 'out') {
        continue;
      }
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

/** Turn a JS string literal's body into the value the running code would see. */
function unescapeLiteral(body) {
  return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (all, esc) => {
    switch (esc[0]) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'u':
      case 'x':
        return String.fromCharCode(parseInt(esc.slice(1), 16));
      default:
        return esc; // \' \" \\ \` and anything else: the character itself
    }
  });
}

function collect(pattern, files, used, where) {
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const key = unescapeLiteral(match[2]);
      const line = text.slice(0, match.index).split('\n').length;
      if (!key.trim()) {
        problems.push(`${path.relative(root, file)}:${line} — empty translation key`);
        continue;
      }
      const hit = used.get(key);
      if (hit) {
        hit.push(`${where}:${path.relative(root, file)}:${line}`);
      } else {
        used.set(key, [`${where}:${path.relative(root, file)}:${line}`]);
      }
    }
  }
}

/** The `{0}` / `{1}` … placeholders of a string, as a sorted, deduplicated list. */
function placeholders(text) {
  return [...new Set([...text.matchAll(/\{(\d+)\}/g)].map((m) => m[1]))].sort().join(',');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    problems.push(`${path.relative(root, file)} — not valid JSON: ${err.message}`);
    return null;
  }
}

// ---- 1. the strings the code actually asks for ---------------------------

const used = new Map();
collect(HOST_CALL, walk(path.join(root, 'src'), []).filter((f) => f.endsWith('.ts')), used, 'host');
collect(WEBVIEW_CALL, walk(path.join(root, 'media'), []).filter((f) => f.endsWith('.js')), used, 'webview');
notes.push(`${used.size} translatable string(s) in the code`);

// ---- 2. the catalogs ------------------------------------------------------

const l10nDir = path.join(root, 'l10n');
const bundleFiles = fs.existsSync(l10nDir)
  ? fs.readdirSync(l10nDir).filter((name) => /^bundle\.l10n\.[^.]+\.json$/.test(name))
  : [];

if (bundleFiles.length === 0) {
  notes.push('no l10n/bundle.l10n.<locale>.json: the UI is English only');
}

for (const name of bundleFiles) {
  const locale = name.replace(/^bundle\.l10n\./, '').replace(/\.json$/, '');
  if (ALIAS_OF[locale]) {
    checkAlias(l10nDir, 'bundle.l10n.', locale);
    continue; // a generated copy: its content is the canonical catalog's, below
  }
  const bundle = readJson(path.join(l10nDir, name));
  if (!bundle) {
    continue;
  }
  const keys = Object.keys(bundle);
  for (const key of keys) {
    if (!bundle[key] || typeof bundle[key] !== 'string') {
      problems.push(`l10n/${name} — "${key}" is not a non-empty string`);
    }
  }
  for (const [key, sites] of used) {
    if (!(key in bundle)) {
      problems.push(`l10n/${name} — missing "${key}" (used by ${sites[0]})`);
      continue;
    }
    const want = placeholders(key);
    const got = placeholders(bundle[key]);
    if (want !== got) {
      problems.push(
        `l10n/${name} — placeholder mismatch for "${key}": source has [${want}], translation has [${got}]`,
      );
    }
  }
  for (const key of keys) {
    if (!used.has(key)) {
      problems.push(`l10n/${name} — stale "${key}" (no code asks for it any more)`);
    }
  }
  notes.push(`l10n/${name}: ${keys.length} entrie(s) for ${locale}`);
}

for (const [canonical, reported] of Object.entries(REPORTED_TAGS)) {
  if (
    bundleFiles.includes(`bundle.l10n.${canonical}.json`) &&
    !bundleFiles.includes(`bundle.l10n.${reported}.json`)
  ) {
    problems.push(`l10n/bundle.l10n.${reported}.json — missing (generated): run \`npm run sync:l10n\``);
  }
}

// ---- 3. the manifest ------------------------------------------------------

const manifestPath = path.join(root, 'package.json');
const manifestText = fs.readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(manifestText);

if (manifest.l10n !== './l10n') {
  problems.push('package.json — "l10n": "./l10n" is missing (vscode.l10n and package.nls read that folder)');
}

const defaultNls = readJson(path.join(root, 'package.nls.json'));
if (!defaultNls) {
  problems.push('package.nls.json — missing (every %key% in package.json must resolve in English)');
} else {
  const referenced = new Set([...manifestText.matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]));
  for (const key of referenced) {
    if (!(key in defaultNls)) {
      problems.push(`package.nls.json — "%${key}%" is used in package.json but not defined`);
    }
  }
  for (const key of Object.keys(defaultNls)) {
    if (!referenced.has(key)) {
      problems.push(`package.nls.json — "${key}" is defined but no longer used in package.json`);
    }
  }
  notes.push(`package.nls.json: ${Object.keys(defaultNls).length} entrie(s)`);

  const localeFiles = fs
    .readdirSync(root)
    .filter((name) => /^package\.nls\.[^.]+\.json$/.test(name));
  for (const name of localeFiles) {
    const locale = name.replace(/^package\.nls\./, '').replace(/\.json$/, '');
    if (ALIAS_OF[locale]) {
      checkAlias(root, 'package.nls.', locale);
      continue; // a generated copy: its content is the canonical catalog's, below
    }
    const bundle = readJson(path.join(root, name));
    if (!bundle) {
      continue;
    }
    for (const key of Object.keys(defaultNls)) {
      if (!(key in bundle)) {
        problems.push(`${name} — missing "${key}"`);
        continue;
      }
      const want = placeholders(defaultNls[key]);
      const got = placeholders(bundle[key]);
      if (want !== got) {
        problems.push(
          `${name} — placeholder mismatch for "${key}": source has [${want}], translation has [${got}]`,
        );
      }
    }
    for (const key of Object.keys(bundle)) {
      if (!(key in defaultNls)) {
        problems.push(`${name} — stale "${key}" (not in package.nls.json)`);
      }
    }
    notes.push(`${name}: ${Object.keys(bundle).length} entrie(s) for ${locale}`);
  }

  for (const [canonical, reported] of Object.entries(REPORTED_TAGS)) {
    if (
      localeFiles.includes(`package.nls.${canonical}.json`) &&
      !localeFiles.includes(`package.nls.${reported}.json`)
    ) {
      problems.push(`package.nls.${reported}.json — missing (generated): run \`npm run sync:l10n\``);
    }
  }
}

// ---- report ---------------------------------------------------------------

if (process.argv.includes('--verbose')) {
  console.log(notes.join('\n'));
}

if (problems.length) {
  console.error(`check-l10n: ${problems.length} problem(s)`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

console.log(`check-l10n: ok (${notes.join('; ')})`);
