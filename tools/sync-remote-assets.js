/*
 * sync-remote-assets — copy the webview runtime the Android app must ship, and nothing else.
 *
 * WHY THIS EXISTS. The replicated session view on the phone is not a second renderer: it is
 * the repo's own `media/main.js` (plus `tree.js`, the vendored layout engine, the vendored
 * markdown-it and `style.css`) running inside an Android WebView, with a Kotlin shim that
 * supplies the one coupling point (`acquireVsCodeApi()` at `media/main.js:2`) and the host
 * half of the message protocol. `remote/PROTOCOL.md` §5 and
 * `docs/agents/plans/remote-control.md` §5 put it plainly: one renderer, three places. A
 * *copied* file is the only way an APK can contain it, so the copies are generated here,
 * committed, and guarded byte for byte by `tools/check-remote-assets.js`.
 *
 * WHAT IT WRITES. Every row of `remote/android/remote-assets.json`:
 *
 *   media/main.js                 -> assets/webview/main.js
 *   media/tree.js                 -> assets/webview/tree.js
 *   media/style.css               -> assets/webview/style.css
 *   media/vendor/**               -> assets/webview/vendor/**
 *   l10n/bundle.l10n.<tag>.json   -> assets/l10n/bundle.l10n.<tag>.json
 *
 * The l10n copies are the *shipped* catalogs (`l10n/`), one per language the repo authors.
 * English is the source language and has no catalog file — `media/main.js`'s `tr()` falls back
 * to the English source string, exactly as it does in an English VS Code window — so there is
 * deliberately nothing to copy for it, and a missing `<tag>` file is a fallback, not an error.
 *
 * What this script does **not** touch: the `shell` block of the same manifest
 * (`assets/shell/session.html`, `session-shim.js`, `session-boot.js`). Those are Android-owned,
 * hand-written files, not copies — the shell has three rewrites in it (asset URLs, the l10n
 * injection, the CSP nonce) that no copy could carry. Do not "fix" the manifest by moving them
 * into `assets`; `check-remote-assets.js` guards the shell's DOM pairing instead.
 *
 * HOUSE RULES (the same ones `tools/sync-l10n-aliases.js` follows):
 *   - the Android side never hand-edits a copied asset; a copy is derived, or it is gone;
 *   - `--clean` removes exactly what this script generates, and refuses to delete a file it
 *     cannot show it generated;
 *   - one obvious summary line on success, a non-zero exit on a real failure.
 *
 * Run: node tools/sync-remote-assets.js [--clean]
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const manifestPath = path.join(root, 'remote', 'android', 'remote-assets.json');

const problems = [];
const notes = [];

if (!fs.existsSync(manifestPath)) {
  console.error('sync-remote-assets: remote/android/remote-assets.json is missing');
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (err) {
  console.error(`sync-remote-assets: cannot parse remote/android/remote-assets.json (${err.message})`);
  process.exit(1);
}

const destRoot = path.join(root, manifest.destRoot);
const clean = process.argv.includes('--clean');

/** A generated destination, resolved and checked to stay inside the destination root. */
function destinationFor(row) {
  const full = path.resolve(destRoot, row.to);
  const inside = path.relative(destRoot, full);
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    problems.push(`${row.to} — escapes ${manifest.destRoot}; a generated asset stays inside it`);
    return null;
  }
  return full;
}

/** Remove now-empty directories between [dir] and the destination root, and no further. */
function pruneEmptyDirs(dir) {
  let current = dir;
  while (path.relative(destRoot, current) !== '' && current.startsWith(destRoot)) {
    let entries;
    try {
      entries = fs.readdirSync(current);
    } catch {
      return;
    }
    if (entries.length > 0) {
      return;
    }
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

let wrote = 0;
let refreshed = 0;
let unchanged = 0;
let removed = 0;

for (const row of manifest.assets) {
  const source = path.join(root, row.from);
  const dest = destinationFor(row);
  if (!dest) {
    continue;
  }
  const destName = path.relative(root, dest).split(path.sep).join('/');
  const sourceName = path.relative(root, source).split(path.sep).join('/');

  if (clean) {
    if (!fs.existsSync(dest)) {
      continue; // already clean
    }
    if (fs.statSync(dest).isDirectory()) {
      problems.push(`${destName} — a generated destination is a file, but this is a directory; not deleting`);
      continue;
    }
    if (!fs.existsSync(source)) {
      problems.push(`${destName} — no ${sourceName} to compare with; not deleting`);
      continue;
    }
    const drift = !fs.readFileSync(source).equals(fs.readFileSync(dest));
    fs.unlinkSync(dest);
    pruneEmptyDirs(path.dirname(dest));
    removed++;
    notes.push(drift ? `removed ${destName} (it had drifted from ${sourceName})` : `removed ${destName}`);
    continue;
  }

  if (!fs.existsSync(source)) {
    problems.push(`${sourceName} — missing; the manifest row ${row.to} cannot be generated`);
    continue;
  }
  if (fs.statSync(source).isDirectory()) {
    problems.push(`${sourceName} — the manifest lists files, not directories`);
    continue;
  }

  const bytes = fs.readFileSync(source);
  const existed = fs.existsSync(dest);
  if (existed && fs.statSync(dest).isDirectory()) {
    problems.push(`${destName} — a generated destination is a file, but this is a directory`);
    continue;
  }
  if (existed && fs.readFileSync(dest).equals(bytes)) {
    unchanged++;
    continue; // already in sync: keep the timestamp, and the note list honest
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, bytes);
  if (existed) {
    refreshed++;
    notes.push(`refreshed ${destName} (${bytes.length} bytes, copy of ${sourceName})`);
  } else {
    wrote++;
    notes.push(`wrote ${destName} (${bytes.length} bytes, copy of ${sourceName})`);
  }
}

if (clean) {
  // A cleanup must not leave an empty destination root behind pretending to hold something.
  if (fs.existsSync(destRoot)) {
    pruneEmptyDirs(destRoot);
  }
}

if (problems.length) {
  console.error(`sync-remote-assets: ${problems.length} problem(s)`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

const total = manifest.assets.length;
if (clean) {
  console.log(
    `sync-remote-assets: clean ok (${removed}/${total} generated asset(s) removed${notes.length ? `; ${notes.join('; ')}` : ''})`,
  );
} else {
  console.log(
    `sync-remote-assets: sync ok — ${total} asset(s): ${wrote} written, ${refreshed} refreshed, ` +
      `${unchanged} already identical${notes.length ? `; ${notes.join('; ')}` : ''}`,
  );
}
