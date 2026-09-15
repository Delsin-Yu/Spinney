// check-models.js — fails the build when a model id drifts away from the catalog.
//
// The catalog lives in `src/agent/models.ts` (compiled to `out/agent/models.js`).
// It is no longer a list of *models the user may pick*: a model is a **card**
// (`spinney.modelCards`) bound to a **provider** (`spinney.providers`), both edited
// by the Model Card Tree page. The one model the extension ships knowledge about
// is the **fallback card** (`VENDORED_MODEL` / `DEFAULT_MODEL`), which is what a
// fresh profile runs on before anything is configured.
//
// The rules are about *naming a model id*, never about behaviour:
//
//   1. The manifest may name the fallback: `spinney.model.default` must be it, and
//      the two catalog settings the page writes must exist as object schemas.
//   2. User-facing copy (`package.json`'s model description, `README.md`,
//      `docs/**`) may name models, but only ids the catalog has. A renamed or
//      dropped model therefore cannot leave a stale id behind in the UI or docs.
//   3. Plugin text and code (`src/**/*.ts`, minus the catalog itself, and
//      `media/**/*.js`, minus the vendored bundles) may **not** name a model id at
//      all. The system prompt, tool descriptions and tool error messages must
//      derive the names at runtime (`visionCardsLabel()` / `cardDisplayName()`),
//      so a model swap can never turn shipped prompt text into a lie.
//
// Run by `npm run check:models`, which `vsce package` executes through
// `vscode:prepublish` — so a drift fails packaging, not the user's session.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const catalogPath = path.join(root, 'out', 'agent', 'models.js');

if (!fs.existsSync(catalogPath)) {
  console.error('check-models: out/agent/models.js is missing — run `npm run compile` first.');
  process.exit(1);
}

const { MODEL_CATALOG, DEFAULT_MODEL } = require(catalogPath);
const ids = MODEL_CATALOG.map((m) => m.id);
// Lowercased: a `DeepSeek-Flash` typo in code is the same drift as the real id.
const idSet = new Set(ids.map((id) => id.toLowerCase()));

// Matches the harness's model ids but not hostnames such as api.deepseek.com: it
// needs the `deepseek-` prefix plus one more name character. The catalog ids are
// listed explicitly too, so a card on another vendor cannot slip past the check,
// and a typo of a real id (`deepseek-flashx`) still fails as an unknown model.
const MODEL_RE = new RegExp(
  [...new Set([...ids.map(escapeRegex), 'deepseek-[a-z0-9][a-z0-9.\\-]*'])].join('|'),
  'gi',
);

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const problems = [];

function scan(file, text, { allowAny = false } = {}) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const match of line.match(MODEL_RE) || []) {
      const id = match.toLowerCase();
      if (allowAny ? !idSet.has(id) : idSet.has(id)) {
        problems.push(
          allowAny
            ? `${file}:${i + 1}: names an unknown model "${match}" (add it to MODEL_CATALOG or reword)`
            : `${file}:${i + 1}: hardcodes the model id "${match}" — use DEFAULT_MODEL / cardDisplayName() from src/agent/models.ts`,
        );
      }
    }
  });
}

// --- 1. the manifest: the fallback default, and the two catalog settings -------
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

/**
 * `contributes.configuration` is contributed as one entry per Settings-UI group
 * (an array of `{ title, properties }`), so flatten it before looking a key up:
 * the sections are presentation, the property set is what this guard checks.
 */
function configurationProperties(contributes) {
  const sections = contributes?.configuration;
  return (Array.isArray(sections) ? sections : sections ? [sections] : []).reduce(
    (all, section) => Object.assign(all, section?.properties ?? {}),
    {},
  );
}

const configProps = configurationProperties(pkg.contributes);
const modelProp = configProps['spinney.model'];
if (modelProp?.default !== DEFAULT_MODEL) {
  problems.push(`package.json: spinney.model.default is "${modelProp?.default}", expected "${DEFAULT_MODEL}"`);
}
for (const key of ['spinney.providers', 'spinney.modelCards']) {
  const prop = configProps[key];
  if (!prop) {
    problems.push(`package.json: ${key} is missing (the Model Card Tree page writes it)`);
  } else if (prop.type !== 'object') {
    problems.push(`package.json: ${key} must be an object of id → fields, got "${prop.type}"`);
  }
}
// The dropdown is built from the cards at runtime, so the setting must NOT carry a
// stale enum any more — an enum is exactly the drift this guard exists to prevent.
if (Array.isArray(modelProp?.enum)) {
  problems.push(`package.json: spinney.model must not carry an enum any more (the cards are the list)`);
}

// --- 2. copy may name models, but only real ones -----------------------------
scan('package.json', JSON.stringify(configProps['spinney.model'], null, 1), { allowAny: true });
scan('README.md', fs.readFileSync(path.join(root, 'README.md'), 'utf8'), { allowAny: true });

for (const dir of ['docs']) {
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.md')) {
        scan(path.relative(root, full).replace(/\\/g, '/'), fs.readFileSync(full, 'utf8'), { allowAny: true });
      }
    }
  };
  walk(path.join(root, dir));
}

// --- 3. code and plugin text may not name a model id at all ------------------
const srcRoot = path.join(root, 'src');
const catalogRel = path.join('agent', 'models.ts');

function walkCode(dir, ext, skipRel) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkCode(full, ext, skipRel);
    } else if (entry.name.endsWith(ext)) {
      const rel = path.relative(root, full);
      if (skipRel && skipRel(rel)) {
        continue;
      }
      scan(rel.replace(/\\/g, '/'), fs.readFileSync(full, 'utf8'));
    }
  }
}
walkCode(srcRoot, '.ts', (rel) => rel === path.join('src', catalogRel));
// The webviews live in media/ and must not carry a second copy of the catalog
// either: they render the card list the provider posts. Vendored JS is off limits
// — it is hash-fixed.
walkCode(path.join(root, 'media'), '.js', (rel) => rel.startsWith(path.join('media', 'vendor')));

if (problems.length) {
  console.error('check-models: model ids drifted\n');
  for (const p of problems) {
    console.error('  ' + p);
  }
  console.error(`\nThe single source of truth is src/agent/models.ts (${ids.length} fallback model(s): ${ids.join(', ')}).`);
  process.exit(1);
}

const vision = MODEL_CATALOG.filter((m) => m.vision).map((m) => m.id);
console.log(
  `check-models: OK — fallback default ${DEFAULT_MODEL}, ${vision.length} accepting images (${vision.join(', ')}); cards come from spinney.modelCards.`,
);
