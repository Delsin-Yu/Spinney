/*
 * check-remote-assets — the guard that stops the Android renderer from drifting.
 *
 * WHAT IT GUARDS, AND WHY IT IS THE ONLY THING THAT DOES. The phone's replicated session view
 * is the repo's own `media/main.js` running in a WebView (`remote/PROTOCOL.md` §5): one
 * renderer, three places. An APK cannot load a file out of `media/`, so the runtime is
 * *copied* into `remote/android/app/src/main/assets/` and committed. The moment one of those
 * copies differs from its source, the phone is running a second, silently older renderer —
 * and a rendering divergence would look like a transport defect forever, because nothing in
 * the product can tell the two apart.
 *
 * WHAT IT CHECKS. For every row of `remote/android/remote-assets.json`:
 *
 *   1. the source exists (a renamed media file must break the build, not the app);
 *   2. the copy exists — a missing copy is a build failure, never a silent fallback;
 *   3. `sha256(copy) === sha256(source)` — byte-identical, not "looks the same";
 *   4. **the syntax floor**: no post-ES2018 operator (`??`, `?.`, `??=`, `&&=`, `||=`) in a
 *      script this WebView has to parse — the copied renderer, `tree.js`, the vendored
 *      markdown-it and layout engine, and the shell's own scripts. On an older device the
 *      WebView is an older Chromium, and one of these operators does not degrade the page: the
 *      whole file fails to **parse**, so the shell's static HTML is on screen and every card is
 *      missing, silently. Comments (line and block) and quoted strings are ignored, because the
 *      file that explains the rule necessarily names the operator;
 *   5. nothing unmanaged is sitting in the generated trees: a hand-edited or hand-added file
 *      under `assets/webview/` or `assets/l10n/` is exactly the drift this guard exists for;
 *   6. every catalog the repo ships (`l10n/bundle.l10n.*.json`) has a manifest row, so adding
 *      a language is a build failure until somebody adds the Android copy — a phone showing
 *      English for a language the desktop translates is a divergence too;
 *   7. the `shell` block: `assets/shell/session.html` mirrors the DOM of
 *      `ChatViewProvider.getHtml()` (it cannot be copied — three rewrites stand between them), so
 *      the element ids are compared in both directions, plus every id the copied `media/main.js`
 *      and `tree.js` look up. A template that cannot be located is reported and skipped: a
 *      refactor is not a broken copy.
 *
 * A failure names the file, the two hashes and the one command that fixes it.
 *
 * Run: node tools/check-remote-assets.js
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const manifestPath = path.join(root, 'remote', 'android', 'remote-assets.json');
const FIX = 'node tools/sync-remote-assets.js';
const problems = [];

function rel(absolute) {
  return path.relative(root, absolute).split(path.sep).join('/');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

if (!fs.existsSync(manifestPath)) {
  console.error('check-remote-assets: remote/android/remote-assets.json is missing');
  console.error(`  - a missing manifest is a missing contract: restore it, then run \`${FIX}\``);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (err) {
  console.error(`check-remote-assets: cannot parse remote/android/remote-assets.json (${err.message})`);
  process.exit(1);
}

const destRoot = path.join(root, manifest.destRoot);
const rows = manifest.assets;
let checked = 0;
let totalBytes = 0;

/** Every destination the manifest claims, normalized, so 5 and 6 can tell managed from not. */
const managed = new Set();
for (const row of rows) {
  const dest = path.resolve(destRoot, row.to);
  const inside = path.relative(destRoot, dest);
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    problems.push(`${row.to} — escapes ${manifest.destRoot}; a generated asset stays inside it`);
    continue;
  }
  const key = path.relative(root, dest).split(path.sep).join('/');
  if (managed.has(key)) {
    problems.push(`${row.to} — listed twice in remote/android/remote-assets.json; one row per file`);
    continue;
  }
  managed.add(key);

  const source = path.join(root, row.from);
  const sourceName = rel(source);

  // 1. the source
  if (!fs.existsSync(source)) {
    problems.push(
      `${sourceName} is missing, so ${key} cannot be checked ` +
        `(the manifest row is stale — fix remote/android/remote-assets.json, then run \`${FIX}\`)`,
    );
    continue;
  }
  if (fs.statSync(source).isDirectory()) {
    problems.push(`${sourceName} is a directory — the manifest lists files, one row each`);
    continue;
  }

  // 2. the copy
  if (!fs.existsSync(dest)) {
    problems.push(`${key} is missing (copy of ${sourceName}) — fix with: \`${FIX}\``);
    continue;
  }
  if (fs.statSync(dest).isDirectory()) {
    problems.push(`${key} is a directory, but it is copied from the file ${sourceName} — fix with: \`${FIX}\``);
    continue;
  }

  // 3. byte-identity
  const sourceHash = sha256(source);
  const destHash = sha256(dest);
  const sourceSize = fs.statSync(source).size;
  const destSize = fs.statSync(dest).size;
  if (sourceHash !== destHash) {
    const stale = destSize !== sourceSize;
    problems.push(
      `${key} has DRIFTED from ${sourceName} — the phone would run a second, older renderer.\n` +
        `      ${descend(sourceName, sourceSize)}: sha256 ${sourceHash}\n` +
        `      ${descend(key, destSize)}: sha256 ${destHash}${stale ? ' (different length)' : ' (same length, different bytes)'}\n` +
        `      fix with: \`${FIX}\` (never edit a copied asset by hand)`,
    );
    continue;
  }

  checked++;
  totalBytes += sourceSize;
}

function descend(name, size) {
  // Aligned to the deeper of the two names, so the two hashes read as a comparison.
  const pad = ' '.repeat(Math.max(0, 62 - name.length));
  return `${name}${pad} ${String(size).padStart(8)} bytes`;
}

// 4. the syntax floor: no post-ES2018 operator in anything this WebView has to parse.
//
// WHY IT IS HERE. `media/main.js` is written once and rendered twice: by the desktop's Electron
// Chromium and by this WebView, which on an older device is a much older Chromium. One operator
// newer than the floor does not make the page degrade — the file fails to **parse**, so
// `media/main.js` never runs at all, never posts the `ready` the Kotlin host waits for
// (`SessionWebView.kt`), and the replica shows the shell's static HTML with every card missing
// and nothing in the logcat to say why. That is exactly what an optional `?.` in the shared
// renderer did on an Android 9 emulator, so the floor is checked here, where the copies are
// checked, and the failure says what to write instead.
//
// WHAT IT IS NOT. It is a scanner for the operator family that has already cost us a device
// afternoon, not a parser and not an ES-level linter: numeric separators (`1_000`), class
// fields, `#private` names and optional `catch {}` are newer than ES2018 too (the shipped
// renderer already uses the last one) and are deliberately out of scope, because a false
// positive fails a release and costs more than a hole this comment names. A regex literal is
// not masked either: telling one from a division needs a token-level parse this guard will not
// grow a dependency for, and no file here spells an operator inside a pattern.
const SYNTAX_FLOOR = 2018;

/**
 * The operators this guard refuses, longest token first — `??=` must be tried before `??`, or a
 * single miss would be reported as two. `explicit` is the substitution a reader is asked to
 * write; it is the whole remedy, which is why it is data here and not prose.
 */
const MODERN_OPERATORS = [
  {
    token: '??=',
    name: 'nullish-coalescing assignment',
    spec: 'ES2021',
    explicit: 'if (value === undefined || value === null) value = fallback;',
  },
  {
    token: '&&=',
    name: 'logical AND assignment',
    spec: 'ES2021',
    explicit: 'value = value ? fallback : value;',
  },
  {
    token: '||=',
    name: 'logical OR assignment',
    spec: 'ES2021',
    explicit: 'value = value ? value : fallback;',
  },
  {
    token: '??',
    name: 'nullish coalescing',
    spec: 'ES2020',
    explicit: 'value === undefined || value === null ? fallback : value',
  },
  {
    token: '?.',
    name: 'optional chaining',
    spec: 'ES2020',
    // Only when a property read follows, so a conditional on a bare fraction
    // (`x ? .5 : 1`) is not a hit.
    followedBy: /[A-Za-z_$[(]/,
    explicit: 'value === undefined || value === null ? undefined : value.prop',
  },
];

/**
 * Which characters of `text` are **code**: everything that is not inside a `//` comment, a
 * block comment, a quoted string or a template literal's text part. Returned as a byte per
 * character, so a hit's index is an index in the original text and its line number is the
 * original line number — the only reason this is a scanner and not a regex.
 *
 * Comments and strings are what makes the difference between a guard and a nuisance: the file
 * that explains the rule, and every `tr('…')` string in the renderer, has to be free to spell
 * the operator it is talking about.
 *
 * A template literal's `${ … }` is code (a `??` there is a real hit) and its text part is not.
 * An unterminated quote or comment swallows only to the end of its line or file, so a stray
 * apostrophe cannot hide the rest of a real hit.
 */
function codeMask(text) {
  const mask = new Uint8Array(text.length);
  // One frame per open template literal: `null` while its text part is being read, or the
  // `{`…`}` depth of the substitution it is currently in.
  const templates = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const top = templates.length ? templates[templates.length - 1] : null;
    const inTemplateText = templates.length > 0 && top === null;
    const inSubstitution = typeof top === 'number';

    if (inTemplateText) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '`') {
        templates.pop();
        i += 1;
        continue;
      }
      if (ch === '$' && text[i + 1] === '{') {
        templates[templates.length - 1] = 0;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      i = endOfQuoted(text, i);
      continue;
    }
    if (ch === '`') {
      templates.push(null);
      i += 1;
      continue;
    }
    if (ch === '{' && inSubstitution) {
      templates[templates.length - 1] = top + 1;
    } else if (ch === '}' && inSubstitution) {
      if (top === 0) {
        // The substitution ends: the template's text part resumes, so the `}` is code (it is
        // the boundary) and the frame stays open as a text part.
        templates[templates.length - 1] = null;
      } else {
        templates[templates.length - 1] = top - 1;
      }
    }
    mask[i] = 1;
    i += 1;
  }
  return mask;
}

/** The index just past the quoted string that starts at `start`; a newline ends it early. */
function endOfQuoted(text, start) {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) {
      return i + 1;
    }
    if (ch === '\n') {
      return i;
    }
    i += 1;
  }
  return i;
}

/** 1-based line numbers, so a hit index can be printed as the line a reader will open. */
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

function lineOf(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** One line of the source, trimmed, for the failure message. */
function excerptAt(text, index) {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  const line = text.slice(start, end < 0 ? text.length : end).trim();
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

// The scripts the WebView parses, which is the **copy** of each manifest row whose source is
// JavaScript (the renderer, the tree, both vendored files) plus the shell's own scripts — those
// have no row, because they are authored for Android rather than copied from `media/`. Nothing
// else is scanned: the catalogs and the stylesheet have no syntax to fail on, and `session.html`
// only ever loads scripts.
//
// Scanning the copy and not the source is deliberate: these are the bytes the WebView parses,
// and a hand-added operator in a generated tree is a failure this guard should name rather than
// infer from a hash. Each entry keeps the source it is derived from, so the remedy can name the
// file a reader is allowed to edit (rule 5: a copied asset is never hand-written).
const SYNTAX_TARGETS = [];
for (const row of rows) {
  if (row.from.endsWith('.js')) {
    SYNTAX_TARGETS.push({ file: path.join(destRoot, row.to), origin: row.from });
  }
}
const shellDir = path.join(destRoot, 'shell');
if (fs.existsSync(shellDir)) {
  for (const entry of fs.readdirSync(shellDir)) {
    if (entry.endsWith('.js')) {
      SYNTAX_TARGETS.push({ file: path.join(shellDir, entry), origin: null });
    }
  }
}

const MAX_SYNTAX_REPORTS = 20;
let syntaxFiles = 0;
for (const target of SYNTAX_TARGETS) {
  if (!fs.existsSync(target.file) || fs.statSync(target.file).isDirectory()) {
    continue; // already reported by rule 2, or a shell script that cannot be read
  }
  const name = rel(target.file);
  const text = fs.readFileSync(target.file, 'utf8');
  const mask = codeMask(text);
  const starts = lineStarts(text);
  syntaxFiles++;

  const hits = [];
  const seen = new Set();
  for (let i = 0; i < text.length; i++) {
    if (mask[i] !== 1) {
      continue;
    }
    for (const operator of MODERN_OPERATORS) {
      if (!text.startsWith(operator.token, i)) {
        continue;
      }
      if (operator.followedBy) {
        const after = text[i + operator.token.length];
        if (after === undefined || !operator.followedBy.test(after)) {
          continue;
        }
      }
      const key = `${operator.token}:${lineOf(starts, i)}`;
      if (seen.has(key)) {
        break;
      }
      seen.add(key);
      hits.push({ operator, index: i });
      break;
    }
  }

  const where = target.origin
    ? `in ${target.origin} (the source this copy is derived from), then run \`${FIX}\``
    : `in ${name} itself, then run \`node tools/check-remote-assets.js\``;
  for (const hit of hits.slice(0, MAX_SYNTAX_REPORTS)) {
    const line = lineOf(starts, hit.index);
    problems.push(
      `${name}:${line} — the \`${hit.operator.token}\` (${hit.operator.name}, ${hit.operator.spec}) ` +
        `operator is newer than this asset's ES${SYNTAX_FLOOR} syntax floor.\n` +
        `      ${excerptAt(text, hit.index)}\n` +
        `      the phone's WebView is an older Chromium: the whole file fails to PARSE, so the shell's ` +
        `static HTML is on screen and every card is missing, with no error on the phone to say why.\n` +
        `      fix: write the explicit form — \`${hit.operator.explicit}\` — ${where}`,
    );
  }
  if (hits.length > MAX_SYNTAX_REPORTS) {
    problems.push(
      `${name} has ${hits.length} post-ES${SYNTAX_FLOOR} operator(s); the ${MAX_SYNTAX_REPORTS} earliest ` +
        `are listed above. They all take the same remedy: the explicit form, then \`${FIX}\``,
    );
  }
}

// 5. an unmanaged file inside a generated tree is the same drift by another route.
const GENERATED_SUBDIRS = ['webview', 'l10n'];
for (const subdir of GENERATED_SUBDIRS) {
  const dir = path.join(destRoot, subdir);
  if (!fs.existsSync(dir)) {
    continue;
  }
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const key = rel(full);
      if (!managed.has(key)) {
        problems.push(
          `${key} is not in remote/android/remote-assets.json, but it sits in a generated tree ` +
            `(assets/${subdir}/). A copied asset is derived, never hand-written.\n` +
            `      fix: delete it, or add a manifest row and copy it with \`${FIX}\``,
        );
      }
    }
  };
  walk(dir);
}

// 6. a new catalog language needs an Android copy — and a *generated* catalog must never get one.
//
// WHY this is a content rule and not a skip-list of names. The release gate runs
// `npm run sync:l10n` (see `vscode:prepublish`) *before* this guard, and that script writes the
// reported-tag aliases VS Code looks up: `l10n/bundle.l10n.zh-cn.json` and `…zh-tw.json`, copies
// of the canonical `zh-Hans` / `zh-Hant` catalogs. They are generated, gitignored, and
// `build-deploy.ps1` deletes them again in its `finally`. A phone must therefore neither ship one
// (a copy whose source disappears at the end of a package run is a copy with no source) nor
// depend on one (`L10n.kt` canonicalises `zh-cn` → `zh-Hans` before it looks anything up).
//
// The honest way to tell an authored catalog from a generated alias without hard-coding names is
// the property that *defines* an alias: `sync-l10n-aliases.js` only ever writes a byte-for-byte
// copy of its canonical source — it even refuses to delete an alias that has been edited, so a
// file this rule calls an alias is one this repo's own tooling produced. So:
//
//   - a catalog a manifest row copies               → authored; its copy is checked by rule 3;
//   - a catalog whose bytes equal a row's source    → a generated alias: fine, and never copied;
//   - anything else                                 → a **new authored language**: a failure until
//                                                     it has a row, because a phone showing English
//                                                     for a language the desktop translates is a
//                                                     divergence of exactly the kind this guard is
//                                                     for.
//
// The converse is checked too: if a row's own source is a byte-copy of another row's source, the
// manifest is pointing at an alias, which is the mistake this rule exists to prevent.
const catalogDir = path.join(root, 'l10n');
if (fs.existsSync(catalogDir)) {
  const shippedCatalogs = [];
  for (const row of rows) {
    if (!row.from.startsWith('l10n/')) continue;
    const source = path.join(root, row.from);
    if (!fs.existsSync(source) || fs.statSync(source).isDirectory()) continue;
    shippedCatalogs.push({ name: row.from, hash: sha256(source) });
  }
  const shippedByHash = new Map(shippedCatalogs.map((catalog) => [catalog.hash, catalog.name]));

  for (const entry of fs.readdirSync(catalogDir)) {
    if (!/^bundle\.l10n\..+\.json$/.test(entry)) {
      continue;
    }
    const sourceName = `l10n/${entry}`;
    if (rows.some((row) => row.from === sourceName)) {
      continue; // authored, and already checked byte for byte against its copy
    }
    const aliasOf = shippedByHash.get(sha256(path.join(catalogDir, entry)));
    if (aliasOf !== undefined) {
      continue; // a generated alias of a catalog we already ship — VS Code's name for the same language
    }
    problems.push(
      `${sourceName} is a catalog ${manifest.destRoot} would not copy, and its bytes are not a copy ` +
        `of any catalog we ship — so it is a new authored language, and that language would show ` +
        `English on the phone while the desktop translates it.\n` +
        `      fix: add a row for ${sourceName} to remote/android/remote-assets.json (under the canonical, ` +
        `region-invariant tag), then run \`${FIX}\``,
    );
  }

  // …and the converse: a row that names a generated alias instead of the authored catalog.
  // Reported once per pair, not once per side.
  for (let i = 0; i < shippedCatalogs.length; i++) {
    const twinIndex = shippedCatalogs.findIndex(
      (other, j) => j > i && other.hash === shippedCatalogs[i].hash,
    );
    if (twinIndex < 0) {
      continue;
    }
    const catalog = shippedCatalogs[i];
    const twin = shippedCatalogs[twinIndex];
    const canonical = [catalog.name, twin.name].sort()[0];
    problems.push(
      `${catalog.name} and ${twin.name} are byte-identical, so one of them is a generated alias of ` +
        `the other (the reported-tag copy \`npm run sync:l10n\` writes for \`vsce\`, which is deleted ` +
        `again at the end of a package run).\n` +
        `      fix: keep one row, for the canonical tag (${canonical}), and delete the other from ` +
        `remote/android/remote-assets.json`,
    );
  }
}

// 7. the shell's DOM: the one pairing that is *mirrored* rather than copied.
//
// `assets/shell/session.html` is the DOM `ChatViewProvider.getHtml()` renders, with the asset
// URLs, the l10n injection and the CSP nonce rewritten. Nothing copies it — it cannot be copied,
// because of those three rewrites — so without this check the pairing is a comment, and a new
// element id in `getHtml()` that `media/main.js` looks up would fail on the phone in a way a
// VS Code window never can. That is the same renderer divergence the hash checks catch, by
// another route, so it fails the same way.
//
// The `template` is a TypeScript source file read as text: only the ids matter, and a template
// that cannot be located is *reported and skipped* rather than failed — a refactor of
// `getHtml()` is not a broken asset copy.
const shell = manifest.shell;
let shellIdCount = 0;
if (shell) {
  const shellPath = path.join(root, shell.file);
  const shellName = rel(shellPath);
  // The host's shell moved out of `ChatViewProvider.getHtml()` into one shared builder
  // (`src/chat/webviewShell.ts`), because M2's replicated-session panel opens the very same
  // document and the two templates may not drift. The manifest still names the old location,
  // so the candidates are tried in order: the shared builder first, the manifest's own row as
  // the fallback. Without this the guard would find no template, print a note and *skip* the
  // DOM pairing — i.e. silently stop guarding the thing it exists for. (One-line change:
  // `templatePath` is now the first existing candidate.)
  const templatePath = [path.join(root, 'src', 'chat', 'webviewShell.ts'), path.join(root, shell.template)].find(
    (candidate) => fs.existsSync(candidate),
  );
  if (!fs.existsSync(shellPath)) {
    problems.push(
      `${shellName} is missing — the session view has no shell. Restore it, or re-derive it with \`${shell.generator}\``,
    );
  } else if (!templatePath) {
    console.log(
      `check-remote-assets: note — neither src/chat/webviewShell.ts nor ${shell.template} exists, so the shell's ` +
        `DOM pairing (${shellName} vs the host's getHtml()) could not be checked`,
    );
  } else {
    const lines = fs.readFileSync(templatePath, 'utf8').split(/\r?\n/);
    const start = lines.findIndex((line) => line.includes('return `<!DOCTYPE html>'));
    const end = lines.findIndex((line, i) => i > start && line.trim() === '</html>`;');
    if (start < 0 || end < 0) {
      console.log(
        `check-remote-assets: note — getHtml()'s template literal could not be located in ` +
          `${rel(templatePath)}, so the shell's DOM pairing was not checked`,
      );
    } else {
      const templateText = lines.slice(start, end + 1).join('\n');
      const idsIn = (text) => new Set([...text.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
      const wanted = idsIn(templateText);
      const have = idsIn(fs.readFileSync(shellPath, 'utf8'));
      shellIdCount = have.size;

      for (const id of wanted) {
        if (!have.has(id)) {
          problems.push(
            `${shellName} is missing the element id "${id}", which the host's getHtml() renders.\n` +
              `      the shell mirrors that DOM; re-derive it with \`${shell.generator}\` and diff`,
          );
        }
      }
      for (const id of have) {
        if (!wanted.has(id)) {
          problems.push(
            `${shellName} has an element id "${id}" that the host's getHtml() does not render.\n` +
              `      the shell mirrors that DOM — an extra id is the same divergence in the other ` +
              `direction; re-derive it with \`${shell.generator}\` and diff`,
          );
        }
      }

      // And the ids the shipped renderer *looks up* must exist here: a webview that cannot find
      // an element it addresses freezes on stale values, which is exactly how a webview defect
      // hides.
      const lookedUp = new Set();
      for (const asset of shell.webview) {
        const assetPath = path.join(root, asset);
        if (!fs.existsSync(assetPath)) {
          problems.push(`${rel(assetPath)} is missing — run \`${FIX}\``);
          continue;
        }
        const text = fs.readFileSync(assetPath, 'utf8');
        for (const m of text.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) lookedUp.add(m[1]);
        for (const m of text.matchAll(/querySelector(?:All)?\(\s*'#([A-Za-z0-9_-]+)/g)) lookedUp.add(m[1]);
      }
      for (const id of lookedUp) {
        if (!have.has(id)) {
          problems.push(
            `${shellName} does not render the element id "${id}", which the shipped renderer looks up ` +
              `(getElementById / querySelector).\n` +
              `      the phone would freeze on stale values; re-derive the shell with \`${shell.generator}\` and diff`,
          );
        }
      }

      // Class attributes too: `style.css` is the shipped stylesheet and it is shared, so an
      // element whose class drifted renders differently on the phone with nothing to catch it —
      // and a class is not an id, so the checks above would pass.
      const classesIn = (text) =>
        [...text.matchAll(/class="([^"]+)"/g)].map((m) => m[1]).sort().join('|');
      const hostClasses = classesIn(templateText);
      const shellClasses = classesIn(fs.readFileSync(shellPath, 'utf8'));
      if (hostClasses !== shellClasses) {
        problems.push(
          `${shellName}'s class attributes differ from the host's getHtml() DOM, so the shared ` +
            `style.css would paint the phone differently.\n` +
            `      host:    ${hostClasses}\n` +
            `      android: ${shellClasses}\n` +
            `      re-derive the shell with \`${shell.generator}\` and diff`,
        );
      }
    }
  }
}

if (problems.length) {
  console.error(`check-remote-assets: ${problems.length} problem(s)`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

console.log(
  `check-remote-assets: ok — ${checked}/${rows.length} generated asset(s) byte-identical to their source ` +
    `(${totalBytes} bytes); no unmanaged file in assets/webview or assets/l10n` +
    `; syntax floor: ${syntaxFiles} script(s) parsed, no post-ES${SYNTAX_FLOOR} operator` +
    (shell && shellIdCount > 0 ? `; shell DOM: ${shellIdCount} element ids, matching the host's getHtml()` : ''),
);
