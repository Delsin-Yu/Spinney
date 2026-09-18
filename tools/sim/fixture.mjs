/*
 * fixture.mjs — the synthetic workspace the simulation harness searches.
 *
 * DEV-ONLY (`.vscodeignore` drops `tools/**`), never runs in CI, no provider and no
 * tokens. `node tools/sim/fixture.mjs [--root <dir>] [--seed <n>] [--force] [--json]`
 *
 * WHAT IT REPRODUCES
 *   The customer's repository shape: three heavy components in one tree — a "chart
 *   engine", a "CJK typography engine" and a "vendor tables" package — with generated
 *   numeric tables, dense text/locale files (CJK strings throughout), several sub-1 MB
 *   **binary assets that look like real fonts** (so the search path's binary handling is
 *   exercised), and a few text files **above the 1 MB search cap**. Roughly 3 700 files
 *   at scale 1, which stays under `MAX_SEARCH_FILES` (4000) so a whole-tree search can
 *   still finish with `capped=none` — the harness needs a *complete* scan to be
 *   comparable run to run.
 *
 * WHERE IT GOES, AND WHY (not an accident)
 *   The default root is `<os.tmpdir()>/spinney-sim/workspace` — deliberately **outside**
 *   the repository. ripgrep honours `.gitignore` (verified with `rg --debug`: this repo's
 *   `.spinney/`, `out/`, `node_modules/` are all ignored), and while a *search root* is
 *   never ignored itself, keeping the fixture out of the repo removes the whole question,
 *   keeps ~4 000 generated files out of the developer's file watcher and git status, and
 *   means a run cannot be confused by whatever the repo's ignore files say next week.
 *   Pass `--root` to put it somewhere else.
 *
 * DETERMINISM
 *   Every file's content is a pure function of (relative path, seed), so a re-run
 *   rewrites nothing and the manifest (path + size + digest) is identical — the harness
 *   asserts that, because a fixture that drifts makes two runs incomparable.
 *
 * The token `SimMarker` appears in at most 50 files (a couple of lines each): the
 * hit-heavy round must reach the match cap only if the harness *wants* it to, and a
 * whole-tree scan must be able to complete.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Present in the hit-heavy round's target files — never in every file. */
export const SEARCH_TOKEN = 'SimMarker';
/** Present in exactly one file per component: a narrow search must be able to hit. */
export const ANCHOR_TOKEN = 'SimAnchorGtable';
/** Present nowhere: the whole-tree hitless round. */
export const NEVER_MATCHES = 'zzz-sim-never-matches-zzz';
/** `src/tools/searchFiles.ts` skips a file whose size exceeds this. */
export const OVERSIZE_BYTES = 1_000_000;
/** Default tree size; keep the total under the tool's 4000-file ceiling. */
export const DEFAULT_FILES = 3700;

const CJK = ['字形', '字距', '行送り', '縦書き', '字面', '描画', '表組', 'チャート', '字幅', '調整', '組版', '字間', '字形表'];
const WORDS = ['advance', 'kerning', 'baseline', 'em', 'row', 'column', 'glyph'];

/** Components: a name, a file budget, and what kind of files it gets. */
export const COMPONENTS = [
  {
    id: 'chart-engine',
    blurb: 'a 2D charting engine (renderers, tables, locales)',
    share: 0.34,
    fonts: ['chart-atlas.woff2', 'chart-atlas-bold.woff2', 'chart-metrics.ttf'],
    oversize: ['data/large/chart_glyph_atlas.txt', 'data/large/chart_metrics_dump.json'],
  },
  {
    id: 'cjk-typography',
    blurb: 'a CJK typography engine (shaping tables, metrics, dictionaries)',
    share: 0.44,
    fonts: ['cjk-mincho.otf', 'cjk-gothic.woff2', 'cjk-kai.ttf'],
    oversize: ['data/large/cjk_ideograph_table.txt', 'data/large/cjk_kerning_matrix.txt'],
  },
  {
    id: 'vendor-tables',
    blurb: 'generated vendor tables consumed by both engines',
    share: 0.22,
    fonts: [],
    oversize: [],
  },
];

const GROUPS = [
  { dir: 'src', kinds: ['code'], perKind: 140 },
  { dir: 'src/tables', kinds: ['table'], perKind: 260 },
  { dir: 'src/modules', kinds: ['code'], perKind: 40, dirs: 24 },
  { dir: 'src/i18n', kinds: ['locale'], perKind: 90 },
  { dir: 'docs', kinds: ['doc'], perKind: 70 },
  { dir: 'test', kinds: ['test'], perKind: 120 },
];

function hash32(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lineFor(kind, index, rand, withToken) {
  const cjk = CJK[(rand() * CJK.length) | 0];
  const word = WORDS[(rand() * WORDS.length) | 0];
  const n = (rand() * 4096) | 0;
  const marker = withToken ? ` ${SEARCH_TOKEN} entry` : '';
  switch (kind) {
    case 'table':
      return `  { "range": "0x${n.toString(16)}", "name": "${cjk}", ${word}: ${n} },${marker}`;
    case 'code':
      return `export function glyph${index}(input: number): number { return (input ^ 0x${n.toString(16)}) + ${index}; } // ${cjk}`;
    case 'locale':
      return `  "key_${index}": "${cjk} ${word} — ${'字'.repeat(1 + ((rand() * 3) | 0))}",${marker}`;
    case 'doc':
      return `- \`t_${index}\` — ${cjk} ${word} ${n}: table-backed${marker}`;
    case 'test':
      return `it('spec ${index} ${word}', () => { expect(glyph${index}(${index % 9})).toBeDefined(); });`;
    default:
      return `${kind} ${index} ${word}`;
  }
}

function textFor(rel, seed, kind, sizeBytes, withToken) {
  const rand = rng(hash32(`${seed}|${rel}`));
  const head = kind === 'locale' ? ['{'] : [`// ${rel}`, `// generated by tools/sim/fixture.mjs (seed ${seed}) — deterministic.`];
  if (withToken) head.push(`// ${SEARCH_TOKEN}: ${ANCHOR_TOKEN} marker for the simulation harness.`);
  let bytes = Buffer.byteLength(`${head.join('\n')}\n`, 'utf8');
  const lines = [...head];
  let index = 0;
  // Stop with a margin: a generated line is up to ~120 bytes, and overshooting the
  // target would leave no room for the exact-size pad below (which is what makes the
  // on-disk size a pure function of the path, and the build idempotent).
  while (bytes < sizeBytes - 256) {
    const line = lineFor(kind, index++, rand, withToken);
    bytes += Buffer.byteLength(line, 'utf8') + 1;
    lines.push(line);
  }
  if (kind === 'locale') lines.push('  "_end": "end"\n}');
  let body = `${lines.join('\n')}\n`;
  // Pad to *exactly* `sizeBytes` with an ASCII tail. The tree is only ever searched,
  // never parsed or compiled, so a filler line is harmless — and the exact size is
  // what lets a re-run recognise its own output without regenerating 25 MB of text.
  const pad = sizeBytes - Buffer.byteLength(body, 'utf8') - 1;
  if (pad > 0) body += `${'x'.repeat(pad)}\n`;
  return body;
}

function binaryFor(rel, seed, size) {
  const buf = Buffer.alloc(size);
  if (rel.endsWith('.woff2')) buf.write('wOF2', 0, 'ascii');
  else if (rel.endsWith('.otf')) buf.write('OTTO', 0, 'ascii');
  else {
    buf[0] = 0x00;
    buf[1] = 0x01;
    buf[2] = 0x00;
    buf[3] = 0x00;
  }
  const rand = rng(hash32(`${seed}|${rel}`));
  for (let i = 4; i < size; i++) buf[i] = (rand() * 256) | 0;
  return buf;
}

/** A manifest of what is on disk: sorted `rel|size` lines plus one content digest. */
export function fixtureDigest(root) {
  const rows = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) rows.push(`${path.relative(root, full).split(path.sep).join('/')}|${fs.statSync(full).size}`);
    }
  };
  walk(root);
  rows.sort();
  const sample = rows.length ? path.join(root, ...rows[0].split('|')[0].split('/')) : '';
  const extra = sample && fs.existsSync(sample) ? fs.readFileSync(sample) : Buffer.alloc(0);
  return crypto.createHash('sha256').update(rows.join('\n')).update(extra).digest('hex');
}

/**
 * Build (or refresh) the fixture. Deterministic and idempotent: a re-run reuses every
 * file whose size already matches, so `written` is 0 on the second call.
 */
export function buildFixture(options = {}) {
  const root = path.resolve(options.root || path.join(os.tmpdir(), 'spinney-sim', 'workspace'));
  const seed = options.seed ?? 20260918;
  const scale = options.scale ?? 1;
  const force = options.force === true;
  const total = Math.max(200, Math.round(DEFAULT_FILES * scale));
  const stats = { root, seed, scale, written: 0, reused: 0, files: 0, dirs: 0, bytes: 0 };

  fs.mkdirSync(root, { recursive: true });
  const put = (rel, make, expectedSize) => {
    const file = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (!force && fs.statSync(file).size === expectedSize) {
        stats.reused++;
        return;
      }
    } catch {
      /* not there yet */
    }
    const body = make();
    fs.writeFileSync(file, body);
    stats.written++;
  };

  // The fixture carries its own ignore file: whoever searches it gets the same view
  // whether or not the enclosing directory is a git repository.
  const ignoreBody = '*.log\n';
  put('.gitignore', () => ignoreBody, Buffer.byteLength(ignoreBody));
  const readme = `# Simulation workspace\n\nGenerated by \`tools/sim/fixture.mjs\` (seed ${seed}).\n\nThis tree is throwaway: the harness deletes it.\n`;
  put('README.md', () => readme, Buffer.byteLength(readme));

  let tokenFiles = 0;
  const tokenBudget = 50;
  for (const component of COMPONENTS) {
    const budget = Math.max(60, Math.round(total * component.share));
    let placed = 0;
    const manifestJson = `${JSON.stringify({ name: component.id, private: true, description: component.blurb }, null, 2)}\n`;
    put(`${component.id}/package.json`, () => manifestJson, Buffer.byteLength(manifestJson));
    for (const group of GROUPS) {
      const dirCount = group.dirs || 1;
      const perDir = Math.max(1, Math.round((budget * group.perKind) / (group.kinds.length * 600 * dirCount)));
      for (let d = 0; d < dirCount && placed < budget; d++) {
        for (let i = 0; i < perDir && placed < budget; i++) {
          const kind = group.kinds[i % group.kinds.length];
          const rel = `${component.id}/${group.dir}${dirCount > 1 ? `/m${String(d).padStart(2, '0')}` : ''}/${kind}_${String(i).padStart(3, '0')}.${kind === 'locale' ? 'json' : kind === 'doc' ? 'md' : 'ts'}`;
          const size = 1400 + (hash32(`${seed}|${rel}`) % 7000);
          const withToken = tokenFiles < tokenBudget && i === 0 && d === 0;
          if (withToken) tokenFiles++;
          put(rel, () => textFor(rel, seed, kind, size, withToken), size);
          placed++;
        }
      }
    }
    for (const font of component.fonts) {
      const rel = `${component.id}/assets/fonts/${font}`;
      const size = 120_000 + (hash32(`${seed}|${rel}`) % 680_000);
      put(rel, () => binaryFor(rel, seed, size), size);
    }
    for (const big of component.oversize) {
      const rel = `${component.id}/${big}`;
      // Text (not binary) so the tool's *size* skip is what excludes it, and the cap
      // note names it — a binary would be skipped twice over and prove nothing.
      const size = OVERSIZE_BYTES + 20_000 + (hash32(`${seed}|${rel}`) % 60_000);
      put(rel, () => textFor(rel, seed, 'table', size, false), size);
    }
  }

  // Count what is really there (the size-driven loop above is approximate by design).
  const manifest = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stats.dirs++;
        walk(full);
      } else if (entry.isFile()) {
        const size = fs.statSync(full).size;
        manifest.push({ rel: path.relative(root, full).split(path.sep).join('/'), size });
        stats.files++;
        stats.bytes += size;
      }
    }
  };
  walk(root);
  manifest.sort((a, b) => (a.rel < b.rel ? -1 : 1));

  const byComponent = {};
  for (const row of manifest) {
    const top = row.rel.includes('/') ? row.rel.split('/')[0] : '(root)';
    const bucket = (byComponent[top] ??= { files: 0, bytes: 0 });
    bucket.files++;
    bucket.bytes += row.size;
  }
  stats.manifest = manifest;
  stats.byComponent = byComponent;
  stats.oversized = manifest.filter((r) => r.size > OVERSIZE_BYTES);
  stats.fonts = manifest.filter((r) => /\.(woff2|ttf|otf)$/.test(r.rel));
  stats.tokenFiles = manifest.filter((r) => {
    if (r.size > OVERSIZE_BYTES) return false;
    try {
      return fs.readFileSync(path.join(root, ...r.rel.split('/')), 'utf8').includes(SEARCH_TOKEN) && r.size < 40_000;
    } catch {
      return false;
    }
  }).length;
  return stats;
}

export function formatFixture(stats) {
  const mib = (n) => `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  const lines = [
    `fixture   ${stats.root}`,
    `  seed ${stats.seed}  scale ${stats.scale}  (written ${stats.written}, reused ${stats.reused})`,
    `  files ${stats.files}  dirs ${stats.dirs}  bytes ${stats.bytes.toLocaleString('en-US')} (${mib(stats.bytes)})`,
  ];
  for (const [id, bucket] of Object.entries(stats.byComponent).sort((a, b) => b[1].files - a[1].files)) {
    lines.push(`    ${id.padEnd(16)} ${String(bucket.files).padStart(5)} files  ${mib(bucket.bytes).padStart(10)}`);
  }
  lines.push(`  files over ${OVERSIZE_BYTES.toLocaleString('en-US')} B (skipped by the search): ${stats.oversized.length}`);
  lines.push(`  font-like binaries under the cap: ${stats.fonts.length}`);
  lines.push(`  files carrying ${SEARCH_TOKEN} (hit-heavy round): ${stats.tokenFiles}`);
  return lines.join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (name, fallback) => {
    const at = argv.indexOf(name);
    return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
  };
  try {
    if (argv.includes('-h') || argv.includes('--help')) {
      console.log('usage: node tools/sim/fixture.mjs [--root <dir>] [--seed <n>] [--scale <n>] [--force] [--json]');
    } else {
      const stats = buildFixture({
        root: flag('--root', undefined),
        seed: Number(flag('--seed', 20260918)),
        scale: Number(flag('--scale', 1)),
        force: argv.includes('--force'),
      });
      console.log(formatFixture(stats));
      console.log(`  digest ${fixtureDigest(stats.root).slice(0, 16)}`);
      if (argv.includes('--json')) {
        console.log(JSON.stringify({ root: stats.root, files: stats.files, dirs: stats.dirs, bytes: stats.bytes, oversized: stats.oversized.length, fonts: stats.fonts.length, tokenFiles: stats.tokenFiles }, null, 2));
      }
    }
  } catch (err) {
    console.error(`fixture: ${err && err.message ? err.message : String(err)}`);
    process.exitCode = 2;
  }
}
