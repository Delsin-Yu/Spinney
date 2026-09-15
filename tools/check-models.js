// check-models.js — fails the build when a model id drifts away from the catalog.
//
// The catalog lives in `src/agent/models.ts` (compiled to `out/agent/models.js`).
// Two rules are enforced, both about *naming a model id*, never about behaviour:
//
//   1. User-facing copy (`package.json`'s enum + settings description, README.md,
//      docs/**) may name models, but only ones the catalog has. A renamed or
//      dropped model therefore cannot leave a stale id behind in the UI or docs.
//   2. Plugin text and code (`src/**/*.ts`, minus the catalog itself) may **not**
//      name a model id at all. The system prompt, tool descriptions and tool
//      error messages must derive the names at runtime (`visionModelsLabel()`),
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
const idSet = new Set(ids);

// Matches the harness's model ids but not hostnames such as api.deepseek.com.
const MODEL_RE = /deepseek-(?:chat|reasoner|v[0-9][0-9a-zA-Z.\-]*)/g;

const problems = [];

function scan(file, text, { allowAny = false } = {}) {
  const lines = text.split(/\r?\n/);
  // A fenced block whose info string mentions `model-table` documents the
  // `spinney.modelTable` syntax, so the ids inside it are *examples of user
  // configuration*, not copy about the catalog. Everything else is scanned.
  let fence = false;
  let modelTableFence = false;
  lines.forEach((line, i) => {
    const fenceMatch = /^\s*(`{3,})(.*)$/.exec(line);
    if (fenceMatch) {
      if (fence) {
        fence = false;
        modelTableFence = false;
      } else {
        fence = true;
        modelTableFence = fenceMatch[2].includes('model-table');
      }
      return;
    }
    if (modelTableFence) {
      return;
    }
    for (const match of line.match(MODEL_RE) || []) {
      if (allowAny ? !idSet.has(match) : idSet.has(match)) {
        problems.push(
          allowAny
            ? `${file}:${i + 1}: names an unknown model "${match}" (add it to MODEL_CATALOG or reword)`
            : `${file}:${i + 1}: hardcodes the model id "${match}" — use DEFAULT_MODEL / visionModelsLabel() from src/agent/models.ts`,
        );
      }
    }
  });
}

// --- 1. the settings enum must contain exactly the catalog, nothing else ------
// (`spinney.modelTable` is deliberately *not* scanned: its whole purpose is
// naming models the catalog does not have.)
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
const enumIds = Array.isArray(modelProp?.enum) ? modelProp.enum : [];
const missing = ids.filter((id) => !enumIds.includes(id));
const extra = enumIds.filter((id) => !idSet.has(id));
if (missing.length) {
  problems.push(`package.json: spinney.model.enum is missing ${missing.join(', ')}`);
}
if (extra.length) {
  problems.push(`package.json: spinney.model.enum lists unknown ${extra.join(', ')}`);
}
if (modelProp?.default !== DEFAULT_MODEL) {
  problems.push(`package.json: spinney.model.default is "${modelProp?.default}", expected "${DEFAULT_MODEL}"`);
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
// The webview lives in media/ and must not carry a second copy of the catalog
// either: it renders the model list the provider posts (`spinney.modelTable`
// included). Vendored JS is off limits — it is hash-fixed.
walkCode(path.join(root, 'media'), '.js', (rel) => rel.startsWith(path.join('media', 'vendor')));

if (problems.length) {
  console.error('check-models: model ids drifted\n');
  for (const p of problems) {
    console.error('  ' + p);
  }
  console.error(`\nThe single source of truth is src/agent/models.ts (${ids.length} models: ${ids.join(', ')}).`);
  process.exit(1);
}

const vision = MODEL_CATALOG.filter((m) => m.vision).map((m) => m.id);
console.log(`check-models: OK — ${ids.length} models, ${vision.length} accepting images (${vision.join(', ')}).`);
