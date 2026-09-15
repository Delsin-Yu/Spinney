#!/usr/bin/env node
/*
 * migrate-state.mjs — move an existing install's data from the pre-rename
 * extension id to the new one. Dev-only tooling: it lives in the repo, but
 * `tools/**` is excluded from the packaged extension (.vscodeignore).
 *
 * ============================================================================
 *  *** RUN THIS WITH VS CODE CLOSED. ***
 *  VS Code keeps every `state.vscdb` open for the whole session. Writing while
 *  it runs fails with SQLITE_BUSY / EBUSY, or worse, is silently undone when
 *  VS Code flushes its own in-memory copy of the row at shutdown. Close every
 *  VS Code window (all of them — the DB is per window *and* one global one)
 *  before `--apply`. The script checks, refuses, and says so when it cannot
 *  get the write lock.
 * ============================================================================
 *
 * WHAT IT DOES
 *
 *   1. Renames `<globalStorage>/<from>` to `<globalStorage>/<to>`: that folder
 *      holds the transcript dumps, the no-repo scratch root, the pre-tree (v1)
 *      state backup and the HTTP control-plane token files.
 *
 *   2. Rewrites the SQLite rows VS Code keys an extension's data by, in every
 *      database it finds:
 *        - `<globalStorage>/state.vscdb` — one row per extension id
 *          (`globalState`: the active-session pointer, the model/effort default,
 *          the backfill markers) plus the workbench rows of the view container;
 *        - `<workspaceStorage>/<hash>/state.vscdb` — the same for
 *          `workspaceState` (the session tree itself; here that row is ~126 MB).
 *      Inside a memento the per-key prefix is renamed (`agentHarness.` →
 *      `spinney.`); workbench rows that name the old view container or the old
 *      webview panel (`workbench.view.extension.agentHarness*`,
 *      `memento/webviewView.agentHarness.chat`) are renamed to the ids the
 *      renamed extension actually reads. The new row is written first and the
 *      old one is deleted last, inside one transaction per database.
 *
 * Every run starts as a DRY RUN: it prints the paths, the row sizes and the key
 * mappings it would perform and writes nothing. `--apply` performs them.
 *
 * USAGE
 *   node tools/migrate-state.mjs                    # dry run (default)
 *   node tools/migrate-state.mjs --apply            # perform the migration
 *   node tools/migrate-state.mjs --from <oldId> --to <newId>
 *   node tools/migrate-state.mjs --global-storage <dir> --workspace-storage <dir>
 *   node tools/migrate-state.mjs --help
 *
 * The storage roots are detected per platform (VS Code stable):
 *   win32   %APPDATA%/Code/User/{globalStorage,workspaceStorage}
 *   darwin  ~/Library/Application Support/Code/User/{globalStorage,workspaceStorage}
 *   linux   ~/.config/Code/User/{globalStorage,workspaceStorage}
 * and the two `--*-storage` flags override them (for an Insiders/OSS build, or
 * for pointing the script at a copy).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULTS = {
  /** The pre-rename extension id (its rows and its globalStorage folder). */
  from: 'minimal-host.minimal-agent-harness',
  /** The renamed extension id (`publisher.name` in package.json). */
  to: 'de-yu.spinney',
  /** The old / new activity-bar view container id, as it appears in row keys. */
  fromContainer: 'agentHarness',
  toContainer: 'spinney',
};

/**
 * Values up to this size get an identifier rewrite applied to the raw JSON text
 * (the workbench rows: view-container state, `.state.hidden`). Above it only the
 * *keys* are rewritten — a memento blob holds conversation text, and a blind
 * string replace inside it would corrupt code the user pasted.
 */
const SMALL_VALUE_LIMIT = 1 << 20; // 1 MiB

const problems = [];
const notes = [];

// --- argument parsing ---------------------------------------------------------

function fail(message) {
  console.error(`migrate-state: ${message}`);
  console.error('Run `node tools/migrate-state.mjs --help` for usage.');
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { apply: false, ...DEFAULTS, globalStorage: null, workspaceStorage: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) fail(`missing value for ${arg}`);
      return next;
    };
    switch (arg) {
      case '--apply':
        opts.apply = true;
        break;
      case '--dry-run':
        opts.apply = false;
        break;
      case '--from':
        opts.from = value();
        break;
      case '--to':
        opts.to = value();
        break;
      case '--from-container':
        opts.fromContainer = value();
        break;
      case '--to-container':
        opts.toContainer = value();
        break;
      case '--global-storage':
        opts.globalStorage = path.resolve(value());
        break;
      case '--workspace-storage':
        opts.workspaceStorage = path.resolve(value());
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

const HELP = `migrate-state.mjs — move an install's data from an old extension id to a new one.

  node tools/migrate-state.mjs [options]

  --dry-run              print the plan, write nothing (default)
  --apply                perform the plan
  --from <id>            old extension id   (default: ${DEFAULTS.from})
  --to <id>              new extension id   (default: ${DEFAULTS.to})
  --from-container <id>  old view container id in row keys (default: ${DEFAULTS.fromContainer})
  --to-container <id>    new view container id in row keys (default: ${DEFAULTS.toContainer})
  --global-storage <dir>    override the detected <User>/globalStorage
  --workspace-storage <dir> override the detected <User>/workspaceStorage
  -h, --help

Run it with VS Code closed: writing a state.vscdb the running window still holds
open either fails (SQLITE_BUSY / EBUSY) or is undone when that window saves.`;

// --- platform paths -----------------------------------------------------------

/** The `<User>` folder of a VS Code stable install, per platform. */
function defaultUserDir(platform = process.platform, env = process.env, home = os.homedir()) {
  switch (platform) {
    case 'win32':
      return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Code', 'User');
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Code', 'User');
    default:
      return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Code', 'User');
  }
}

// --- row planning -------------------------------------------------------------

function renameIdentifiers(text, from, to) {
  return text.split(from).join(to);
}

/**
 * Row keys whose *shape* changed with the rename, not just a prefix. The chat's
 * webview panel is the case: it used to be the view `agentHarness.chat`, and the
 * renamed extension registers it as the panel `spinney.chatTree`, so a plain
 * identifier replacement would write a key nothing reads.
 */
function wholeKeyRename(key, opts) {
  if (key === `memento/webviewView.${opts.fromContainer}.chat`) {
    return `memento/webviewView.${opts.toContainer}.chatTree`;
  }
  return null;
}

function describeError(err) {
  const message = err && err.message ? err.message : String(err);
  if (/SQLITE_BUSY|SQLITE_LOCKED|EBUSY|EACCES|EPERM|locked|another process/i.test(message)) {
    return `${message} — VS Code is holding this database open; close every VS Code window and re-run.`;
  }
  return message;
}

function toText(value) {
  if (value == null) return '';
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

/**
 * What the migration would do to one `ItemTable` row, or null when the row is
 * untouched. The value is re-serialized only for the extension's own memento
 * row; every other matched row keeps its bytes (with a small-value identifier
 * rewrite where the row's own JSON names the old container).
 */
function planRow(key, value, opts, existing) {
  const text = toText(value);
  const bytes = Buffer.byteLength(text, 'utf8');

  // (a) The extension's memento row: rename the per-key prefixes inside the JSON.
  if (key === opts.from) {
    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      problems.push(`${opts.from}: the memento row is not valid JSON (${describeError(err)}) — left alone`);
      return null;
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      problems.push(`${opts.from}: the memento row is not a JSON object — left alone`);
      return null;
    }
    const renamed = {};
    const mappings = [];
    for (const [inner, innerValue] of Object.entries(json)) {
      const next = inner.startsWith(`${opts.fromContainer}.`)
        ? `${opts.toContainer}.${inner.slice(opts.fromContainer.length + 1)}`
        : inner;
      if (next !== inner) {
        mappings.push(`${inner} → ${next}`);
      }
      renamed[next] = innerValue;
    }
    let mergedFrom = '';
    if (existing) {
      // A partially migrated profile: the new row is already there. The old data
      // is the real data, so it wins for the keys both have; keys only the new
      // row has are kept.
      for (const [inner, innerValue] of Object.entries(existing)) {
        if (!(inner in renamed)) {
          renamed[inner] = innerValue;
          mergedFrom += ` (kept ${inner})`;
        }
      }
    }
    return {
      oldKey: key,
      newKey: opts.to,
      newValue: JSON.stringify(renamed),
      bytes,
      mappings,
      detail: mappings.length > 0 ? `${mappings.length} memento key(s) renamed${mergedFrom}` : `no key to rename${mergedFrom}`,
    };
  }

  // (b) A workbench row that names the old container / webview panel.
  const newKey = wholeKeyRename(key, opts) ?? renameIdentifiers(key, opts.fromContainer, opts.toContainer);
  if (newKey === key) {
    return null;
  }
  const newText =
    bytes <= SMALL_VALUE_LIMIT ? renameIdentifiers(text, opts.fromContainer, opts.toContainer) : text;
  return {
    oldKey: key,
    newKey,
    newValue: newText,
    bytes,
    mappings: [`${key} → ${newKey}`],
    detail: `workbench row renamed${text !== newText ? ' (value ids renamed too)' : ''}`,
  };
}

/** Every planned row of one database, plus whatever could not be read. */
function planDatabase(file, label, opts) {
  const plan = { file, label, rows: [], error: null };
  if (!fs.existsSync(file)) {
    return plan;
  }
  let db;
  const isReadOnly = !opts.apply;
  try {
    db = new DatabaseSync(file, isReadOnly ? { readOnly: true } : undefined);
  } catch (err) {
    // A read-only open can fail where a read-write one succeeds (a DB that still
    // needs journal recovery). Retry plainly before giving up — a dry run never
    // writes anything anyway.
    try {
      db = new DatabaseSync(file);
    } catch (err2) {
      plan.error = describeError(err2 || err);
      return plan;
    }
  }
  try {
    let rows;
    try {
      rows = db.prepare('SELECT key, value FROM ItemTable').all();
    } catch (err) {
      plan.error = describeError(err);
      return plan;
    }
    const byKey = new Map(rows.map((row) => [toText(row.key), row.value]));
    for (const row of rows) {
      const key = toText(row.key);
      const existing =
        key === opts.from && byKey.has(opts.to) ? safeJson(byKey.get(opts.to)) : undefined;
      const planned = planRow(key, row.value, opts, existing);
      if (planned) {
        plan.rows.push(planned);
      }
    }
  } finally {
    db.close();
  }
  return plan;
}

function safeJson(text) {
  try {
    const value = JSON.parse(toText(text));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

// --- apply --------------------------------------------------------------------

function applyDatabase(plan) {
  const db = new DatabaseSync(plan.file);
  try {
    // BEGIN IMMEDIATE takes the write lock up front, so contention is reported
    // here (one clear error) instead of halfway through the row writes.
    db.exec('BEGIN IMMEDIATE');
    try {
      const insert = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
      const remove = db.prepare('DELETE FROM ItemTable WHERE key = ?');
      for (const row of plan.rows) {
        insert.run(row.newKey, row.newValue);
      }
      // The old rows go last: a crash between the two leaves a readable copy
      // under each key, never nothing.
      for (const row of plan.rows) {
        if (row.oldKey !== row.newKey) {
          remove.run(row.oldKey);
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* the transaction is already gone; report the original failure */
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

// --- reporting ----------------------------------------------------------------

function fmt(n) {
  return typeof n === 'number' ? n.toLocaleString('en-US') : String(n);
}

function classifyGlobalStorage(dir) {
  try {
    return `${fs.readdirSync(dir).length} entry/entries`;
  } catch {
    return 'unreadable';
  }
}

function printHeader(opts, userDir) {
  console.log(opts.apply ? 'migrate-state: APPLY' : 'migrate-state: DRY RUN (nothing is written)');
  console.log(`  from:      ${opts.from}`);
  console.log(`  to:        ${opts.to}`);
  console.log(`  container: ${opts.fromContainer} → ${opts.toContainer}`);
  console.log(`  user dir:  ${userDir}`);
  if (opts.apply) {
    console.log('  (VS Code must be closed — see the header of this script)');
  }
  console.log('');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const userDir = defaultUserDir();
  const globalStorage = opts.globalStorage ?? path.join(userDir, 'globalStorage');
  const workspaceStorage = opts.workspaceStorage ?? path.join(userDir, 'workspaceStorage');

  printHeader(opts, userDir);

  // ---- step 1: the globalStorage folder ----
  console.log('step 1 — globalStorage folder');
  const fromDir = path.join(globalStorage, opts.from);
  const toDir = path.join(globalStorage, opts.to);
  if (!opts.globalStorage && !fs.existsSync(userDir)) {
    console.log(`  [warn] no VS Code user folder at ${userDir} — pass --global-storage/--workspace-storage`);
    problems.push(`no VS Code user folder at ${userDir}`);
  }
  if (!fs.existsSync(fromDir)) {
    console.log(`  [skip] ${fromDir} does not exist`);
  } else if (fs.existsSync(toDir)) {
    console.log(`  [skip] ${toDir} already exists — not overwriting it`);
    notes.push(`${opts.to} already exists in globalStorage`);
  } else {
    console.log(`  [${opts.apply ? 'rename' : 'plan  '}] ${fromDir}`);
    console.log(`           → ${toDir}  (${classifyGlobalStorage(fromDir)})`);
    if (opts.apply) {
      try {
        fs.renameSync(fromDir, toDir);
      } catch (err) {
        problems.push(`could not rename ${fromDir}: ${describeError(err)}`);
        console.log(`  [fail] ${describeError(err)}`);
      }
    }
  }
  console.log('');

  // ---- step 2: the SQLite databases ----
  console.log('step 2 — state.vscdb rows');
  const databases = [];
  const globalDb = path.join(globalStorage, 'state.vscdb');
  if (fs.existsSync(globalDb)) {
    databases.push({ file: globalDb, label: 'globalStorage' });
  }
  let workspaceHashes = [];
  try {
    workspaceHashes = fs.readdirSync(workspaceStorage);
  } catch {
    console.log(`  [warn] no workspaceStorage at ${workspaceStorage}`);
  }
  for (const hash of workspaceHashes) {
    const file = path.join(workspaceStorage, hash, 'state.vscdb');
    if (fs.existsSync(file)) {
      databases.push({ file, label: `workspaceStorage/${hash}` });
    }
  }

  let touchedDatabases = 0;
  let touchedRows = 0;
  for (const { file, label } of databases) {
    const plan = planDatabase(file, label, opts);
    if (plan.error) {
      console.log(`  [fail] ${file}`);
      console.log(`         ${plan.error}`);
      problems.push(`${file}: ${plan.error}`);
      continue;
    }
    if (plan.rows.length === 0) {
      continue;
    }
    touchedDatabases++;
    console.log(`  [${opts.apply ? 'write ' : 'plan  '}] ${label}`);
    console.log(`          ${file}`);
    for (const row of plan.rows) {
      console.log(`          row ${row.oldKey}`);
      console.log(`           →  ${row.newKey}   (${fmt(row.bytes)} bytes) — ${row.detail}`);
      for (const mapping of row.mappings.slice(0, 8)) {
        console.log(`                 ${mapping}`);
      }
      if (row.mappings.length > 8) {
        console.log(`                 …and ${row.mappings.length - 8} more`);
      }
    }
    touchedRows += plan.rows.length;
    if (opts.apply) {
      try {
        applyDatabase(plan);
      } catch (err) {
        problems.push(`${file}: ${describeError(err)}`);
        console.log(`  [fail] ${describeError(err)}`);
      }
    }
  }
  if (touchedDatabases === 0) {
    console.log('  [skip] no row naming the old id in any state.vscdb');
  }
  console.log('');

  console.log(
    opts.apply
      ? `migrate-state: applied ${touchedRows} row(s) in ${touchedDatabases} database(s).`
      : `migrate-state: dry run — ${touchedRows} row(s) in ${touchedDatabases} database(s) would change. Re-run with --apply.`,
  );
  for (const note of notes) {
    console.log(`  note: ${note}`);
  }
  if (problems.length > 0) {
    console.error('');
    for (const problem of problems) {
      console.error(`  problem: ${problem}`);
    }
    return 1;
  }
  return 0;
}

process.exit(main());
