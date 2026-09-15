// sync-l10n-aliases.js — writes (and cleans up) the catalogs *VS Code* looks up.
//
// The repo authors one catalog per language under its canonical, region-invariant
// tag — `package.nls.zh-Hans.json`, `l10n/bundle.l10n.zh-Hans.json` — but VS Code
// looks a catalog up by the tag **it** reports, which for Chinese is still the
// legacy region id (`vscode-language-pack-zh-hans` carries `"languageId":
// "zh-cn"`, so `vscode.env.language` is `zh-cn`). It reads those two files itself,
// with no fallback and no alias table of its own:
//
//   package.nls.<tag>.json        the manifest strings (`%key%` in package.json)
//   l10n/bundle.l10n.<tag>.json   the host strings (`vscode.l10n.t`)
//
// So the reported-tag copies are *generated*: written here for exactly as long as
// `vsce` is reading the tree, and removed again by `--clean` once it has. Nothing
// generated is ever committed — `.gitignore` lists the four names — and the pair
// itself lives in `src/languageTags.ts`, which this script reads out of `out/`
// (compiled by then: `vscode:prepublish` runs `compile` first, exactly as it does
// for `check-models.js` and `out/agent/models.js`).
//
// See docs/agents/invariants/i18n.md.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const problems = [];
const notes = [];

/** The two catalogs VS Code reads itself, as [directory, file-name prefix]. */
const CATALOGS = [
  ['', 'package.nls.'],
  ['l10n', 'bundle.l10n.'],
];

let REPORTED_TAGS;
try {
  ({ REPORTED_TAGS } = require(path.join(root, 'out', 'languageTags.js')));
} catch (err) {
  console.error(`sync-l10n-aliases: cannot read out/languageTags.js (${err.message})`);
  console.error('  - run `npm run compile` first (vscode:prepublish does)');
  process.exit(1);
}

const clean = process.argv.includes('--clean');

const file = (dir, prefix, tag) => path.join(root, dir, `${prefix}${tag}.json`);

for (const [canonical, reported] of Object.entries(REPORTED_TAGS)) {
  for (const [dir, prefix] of CATALOGS) {
    const source = file(dir, prefix, canonical);
    const alias = file(dir, prefix, reported);
    const name = path.relative(root, alias);

    if (clean) {
      if (!fs.existsSync(alias)) {
        continue; // already clean
      }
      if (!fs.existsSync(source)) {
        problems.push(`${name} — no ${path.relative(root, source)} to compare with; not deleting`);
        continue;
      }
      // Only a byte-for-byte copy is ours to delete: if it differs, someone edited
      // a file that is about to be thrown away, and saying so beats losing it.
      if (!fs.readFileSync(source).equals(fs.readFileSync(alias))) {
        problems.push(`${name} — differs from ${path.relative(root, source)}; not deleting`);
        continue;
      }
      fs.unlinkSync(alias);
      notes.push(`removed ${name}`);
      continue;
    }

    if (!fs.existsSync(source)) {
      problems.push(`${path.relative(root, source)} — missing (the canonical catalog is what the repo authors)`);
      continue;
    }
    const bytes = fs.readFileSync(source);
    if (fs.existsSync(alias) && fs.readFileSync(alias).equals(bytes)) {
      continue; // already in sync: keep the timestamp, and the note list honest
    }
    const existed = fs.existsSync(alias);
    fs.writeFileSync(alias, bytes);
    notes.push(`${existed ? 'refreshed' : 'wrote'} ${name} (copy of ${path.relative(root, source)})`);
  }
}

if (problems.length) {
  console.error(`sync-l10n-aliases: ${problems.length} problem(s)`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

console.log(
  `sync-l10n-aliases: ${clean ? 'clean' : 'sync'} ok` +
    (notes.length ? ` (${notes.join('; ')})` : ' (nothing to do)'),
);
