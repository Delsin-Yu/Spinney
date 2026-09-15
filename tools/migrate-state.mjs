#!/usr/bin/env node
/*
 * migrate-state.mjs — the one migration this repo carries: an install that only
 * ever ran Minimal Agent Harness (`minimal-host.minimal-agent-harness`) moves to
 * Spinney (`DE-YU.spinney`).
 *
 * Dev-only tooling: `tools/**` is excluded from the packaged extension.
 *
 * ============================================================================
 *  RUN IT WITH VS CODE CLOSED. Every window keeps its `state.vscdb` open and
 *  writes the file back from its in-memory copy when it exits, which silently
 *  undoes a write made underneath it. `--apply` refuses to start while a Code /
 *  VSCodium process is up. Run this from a plain terminal, or --force past the
 *  check once you know no window holds these databases.
 * ============================================================================
 *
 * ONE ID, TWO CASE-SENSITIVE SPELLINGS — the trap this script exists for:
 *   - a MEMENTO ROW key in `state.vscdb` keeps the case the manifest declared,
 *     because VS Code keys a row by `publisher.name` verbatim: `DE-YU.spinney`;
 *   - the `globalStorage` FOLDER is that same id LOWERCASED, because the shipped
 *     code resolves it as `joinPath(globalStorageHome, identifier.value.toLowerCase())`:
 *     `de-yu.spinney`.
 * SQLite item keys are case-sensitive, so the lowercased form is a row nothing
 * ever reads: the old tree stays invisible under the old key and the next
 * activation writes a fresh, empty row under the real one. Both halves are
 * printed before anything is written, precisely because the wrong one looks like
 * a success.
 *
 * WHAT IT DOES (a dry run unless `--apply` is given)
 *
 *   1. Merges `<globalStorage>/minimal-host.minimal-agent-harness` into
 *      `<globalStorage>/de-yu.spinney`: the transcript dumps, the no-workspace
 *      scratch root, `state-v1-backup.json` and the control-plane `http/` token
 *      files. A name that exists in both keeps the file already in the target
 *      (that is the one the renamed build has been reading) and says so; the
 *      old folder is removed only once it is empty.
 *
 *   2. Re-keys the rows, in the global `state.vscdb` and in every workspace one:
 *      the extension's memento row `minimal-host.minimal-agent-harness` →
 *      `DE-YU.spinney`, with the per-key prefixes inside its value renamed
 *      (`agentHarness.*` → `spinney.*`), plus the workbench rows that name the
 *      old activity-bar container (`workbench.view.extension.agentHarness*`,
 *      value included) and the old chat webview
 *      (`memento/webviewView.agentHarness.chat*`, which the panel
 *      `spinney.chatTree` replaced).
 *      Inside the memento value only KEYS are rewritten, never the strings: a
 *      conversation can quote anything, including the prefix. Per database the
 *      new rows are written first and the old ones deleted last, in one
 *      transaction.
 *      If the target row already exists (the renamed build has run at least
 *      once), the two merge: `spinney.state` unions its sessions by id — the
 *      richer copy of a shared id wins, so a stub left before the rename cannot
 *      replace the tree the new build has been writing — and for every other
 *      shared key the OLD row wins, because it is the row that holds the
 *      history. The plan prints each of those decisions (`kept …`, `source wins
 *      over …`).
 *
 *   3. Reads the result back and prints the sessions every row holds, so a silent
 *      no-op fails loudly.
 *
 * NOT MIGRATED, ON PURPOSE
 *   - Secrets: VS Code does not re-key `secret://…` rows on a rename, and their
 *     values are encrypted, so the new build asks for the API key once more.
 *   - `<repo>/.agent-harness` scratch folders of the old build (tool output only).
 *
 * USAGE
 *   node tools/migrate-state.mjs                 # dry run: print the plan
 *   node tools/migrate-state.mjs --apply         # do it, with VS Code closed
 *   node tools/migrate-state.mjs --global-storage <dir> --workspace-storage <dir>
 *   node tools/migrate-state.mjs --help
 *
 * The storage roots are detected per platform (VS Code stable):
 *   win32   %APPDATA%/Code/User/{globalStorage,workspaceStorage}
 *   darwin  ~/Library/Application Support/Code/User/{globalStorage,workspaceStorage}
 *   linux   ~/.config/Code/User/{globalStorage,workspaceStorage}
 * and the two `--*-storage` flags override them — for an Insiders/VSCodium build,
 * or for a copy of a profile to rehearse the run on.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// --- the migration, in one place ---------------------------------------------

const M = {
  /** The old id as that manifest declared it — the case its rows carry. */
  fromId: 'minimal-host.minimal-agent-harness',
  /** The current id as package.json declares it — the case VS Code reads. */
  toId: 'DE-YU.spinney',
  /** The same two ids lowercased: the globalStorage folder names. */
  fromFolder: 'minimal-host.minimal-agent-harness',
  toFolder: 'de-yu.spinney',
  /** Memento key prefixes inside the extension's own state row. */
  fromPrefix: 'agentHarness.',
  toPrefix: 'spinney.',
  /** The activity-bar view container, as it appears in workbench row keys and values. */
  fromContainer: 'agentHarness',
  toContainer: 'spinney',
  /** A row whose key *shape* also changed: the old chat webview became this panel. */
  renamedRows: {
    'memento/webviewView.agentHarness.chat': 'memento/webviewView.spinney.chatTree',
  },
};

/**
 * Above this size a value is never string-rewritten: a big blob holds
 * conversations, and a blind replace inside one would corrupt pasted text.
 */
const VALUE_REWRITE_LIMIT = 1 << 20;

/** A state row key inside the memento, e.g. `spinney.state`. */
const STATE_KEY = `${M.toPrefix}state`;

const problems = [];
const notes = [];

// --- arguments ----------------------------------------------------------------

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { apply: false, force: false, globalStorage: null, workspaceStorage: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) {
        throw new UsageError(`missing value for ${arg}`);
      }
      return next;
    };
    switch (arg) {
      case '--apply':
        opts.apply = true;
        break;
      case '--dry-run':
        opts.apply = false;
        break;
      case '--force':
        opts.force = true;
        break;
      case '--global-storage':
        opts.globalStorage = path.resolve(value());
        break;
      case '--workspace-storage':
        opts.workspaceStorage = path.resolve(value());
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

const HELP = `migrate-state.mjs — move an install from Minimal Agent Harness to Spinney.

  node tools/migrate-state.mjs [options]

  --dry-run                 print the plan, write nothing (default)
  --apply                   perform the plan
  --force                   apply even while VS Code is running
  --global-storage <dir>    override the detected <User>/globalStorage
  --workspace-storage <dir> override the detected <User>/workspaceStorage
  -h, --help

The two ids are fixed: ${M.fromId} → ${M.toId}. The memento ROW keys keep
the manifest case (${M.toId}); the globalStorage FOLDER is the same id
lowercased (${M.toFolder}). Run it with VS Code closed.`;

// --- small helpers ------------------------------------------------------------

function fmtBytes(n) {
  return `${n.toLocaleString('en-US')} B`;
}

function toText(value) {
  if (value == null) {
    return '';
  }
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

function describeError(err) {
  const message = err && err.message ? err.message : String(err);
  if (/SQLITE_BUSY|SQLITE_LOCKED|EBUSY|EACCES|EPERM|locked|another process/i.test(message)) {
    return `${message} — VS Code is holding this database open; close every VS Code window and re-run.`;
  }
  return message;
}

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

function vscodeRunning() {
  try {
    if (process.platform === 'win32') {
      const result = spawnSync('tasklist', ['/NH', '/FO', 'CSV'], { encoding: 'utf8' });
      return /"(Code|Code - Insiders|VSCodium)\.exe"/i.test(result.stdout || '');
    }
    const result = spawnSync('pgrep', ['-f', 'Microsoft VS Code|/usr/share/code/code|vscodium'], { encoding: 'utf8' });
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Every `state.vscdb` the migration looks at: the global one, then one per workspace. */
function collectDatabases(globalStorage, workspaceStorage) {
  const databases = [];
  const globalDb = path.join(globalStorage, 'state.vscdb');
  if (fs.existsSync(globalDb)) {
    databases.push({ file: globalDb, label: 'globalStorage' });
  }
  let hashes = [];
  try {
    hashes = fs.readdirSync(workspaceStorage);
  } catch {
    /* no workspaceStorage: nothing to migrate there */
  }
  for (const hash of hashes) {
    const file = path.join(workspaceStorage, hash, 'state.vscdb');
    if (fs.existsSync(file)) {
      databases.push({ file, label: `workspaceStorage/${hash}` });
    }
  }
  return databases;
}

// --- step 1: the storage folder -----------------------------------------------

/**
 * The steps that turn `from` into `to`: `rename` when the target is free,
 * otherwise a recursive merge — `mkdir`, `move`, `keep` (the target already has
 * that name, so its file wins), `rmdir` (only ever removes an emptied folder).
 */
function planFolder(from, to) {
  if (!fs.existsSync(to)) {
    return [{ kind: 'rename', src: from, dst: to }];
  }
  const steps = [];
  const walk = (src, dst) => {
    steps.push({ kind: 'mkdir', path: dst });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const childSrc = path.join(src, entry.name);
      const childDst = path.join(dst, entry.name);
      if (!fs.existsSync(childDst)) {
        steps.push({ kind: 'move', src: childSrc, dst: childDst });
      } else if (entry.isDirectory() && fs.statSync(childDst).isDirectory()) {
        walk(childSrc, childDst);
      } else {
        steps.push({ kind: 'keep', src: childSrc, dst: childDst });
      }
    }
    steps.push({ kind: 'rmdir', path: src });
  };
  walk(from, to);
  return steps;
}

function printFolderPlan(fromDir, toDir) {
  if (!fs.existsSync(fromDir)) {
    console.log(`  [skip  ] ${fromDir} does not exist${fs.existsSync(toDir) ? ' (the old folder is already gone)' : ''}`);
    return [];
  }
  const steps = planFolder(fromDir, toDir);
  if (steps[0].kind === 'rename') {
    let entries = 0;
    try {
      entries = fs.readdirSync(fromDir).length;
    } catch {
      /* reported as a problem when the rename runs */
    }
    console.log(`  [plan  ] ${fromDir}`);
    console.log(`        →  ${toDir}   (${entries} entry/entries)`);
    return steps;
  }
  const moves = steps.filter((step) => step.kind === 'move');
  const keeps = steps.filter((step) => step.kind === 'keep');
  console.log(`  [plan  ] merge into the existing ${toDir}`);
  console.log(`        ${moves.length} entry/entries to move, ${keeps.length} name(s) already there:`);
  for (const step of moves.slice(0, 8)) {
    console.log(`          move  ${path.relative(toDir, step.dst)}`);
  }
  if (moves.length > 8) {
    console.log(`          …and ${moves.length - 8} more`);
  }
  for (const step of keeps) {
    console.log(`          keep  ${path.relative(toDir, step.dst)} (already in the target; left at ${step.src})`);
    notes.push(`the target already had ${path.relative(toDir, step.dst)} — kept it, the old copy is still in ${fromDir}`);
  }
  return steps;
}

function applyFolderSteps(steps) {
  for (const step of steps) {
    try {
      switch (step.kind) {
        case 'rename':
        case 'move':
          fs.renameSync(step.src, step.dst);
          break;
        case 'mkdir':
          fs.mkdirSync(step.path, { recursive: true });
          break;
        case 'rmdir':
          if (fs.readdirSync(step.path).length === 0) {
            fs.rmdirSync(step.path);
          }
          break;
        default:
          break; // 'keep' needs no action
      }
    } catch (err) {
      problems.push(`${step.kind} ${step.src ?? step.path}: ${describeError(err)}`);
    }
  }
}

// --- step 2: the rows ---------------------------------------------------------

/** The new key of a workbench row that names the old container, or null. */
function renamedKey(key) {
  if (M.renamedRows[key]) {
    return M.renamedRows[key];
  }
  const prefix = `workbench.view.extension.${M.fromContainer}`;
  if (key === prefix || key.startsWith(`${prefix}.`)) {
    return `workbench.view.extension.${M.toContainer}${key.slice(prefix.length)}`;
  }
  const webview = `memento/webviewView.${M.fromContainer}.`;
  if (key.startsWith(webview)) {
    return `memento/webviewView.${M.toContainer}.${key.slice(webview.length)}`;
  }
  return null;
}

/**
 * A workbench row's value names the container's views too
 * (`[{"id":"agentHarness.chat",…}]`), so those ids are rewritten as well — but
 * only for the container rows, and never in a value big enough to be data.
 */
function renamedRowValue(key, text) {
  if (!key.startsWith('workbench.view.extension.')) {
    return text;
  }
  return Buffer.byteLength(text, 'utf8') <= VALUE_REWRITE_LIMIT
    ? text.split(M.fromContainer).join(M.toContainer)
    : text;
}

/** The sessions of a state value, in either storage shape (array or numeric-key object). */
function listSessions(state) {
  const sessions = state?.sessions;
  if (Array.isArray(sessions)) {
    return sessions.filter((session) => session && typeof session === 'object' && typeof session.id === 'string');
  }
  if (sessions && typeof sessions === 'object') {
    return Object.values(sessions).filter((session) => session && typeof session === 'object' && typeof session.id === 'string');
  }
  return [];
}

/** How much history a session object holds — the yardstick for "the richer copy". */
function sessionWeight(session) {
  const nodes = session?.nodes && typeof session.nodes === 'object' ? Object.keys(session.nodes).length : 0;
  const messages = Array.isArray(session?.messages) ? session.messages.length : 0;
  return nodes + messages;
}

/**
 * Union two `spinney.state` values by session id. The old row contributes the
 * migrated history, the new row whatever the renamed build recorded since it was
 * installed, and neither may lose a conversation: a shared id keeps its richer
 * copy, and the active-session pointer follows whichever id still exists.
 */
function unionState(source, target) {
  const byId = new Map();
  const added = [];
  const replaced = [];
  for (const session of listSessions(source)) {
    byId.set(session.id, session);
  }
  for (const session of listSessions(target)) {
    const existing = byId.get(session.id);
    if (!existing) {
      byId.set(session.id, session);
      added.push(session.id);
    } else if (sessionWeight(session) > sessionWeight(existing)) {
      byId.set(session.id, session);
      replaced.push(session.id);
    }
  }
  const sessions = [...byId.values()];
  const known = new Set(sessions.map((session) => session.id));
  const activeSessionId = [source?.activeSessionId, target?.activeSessionId].find(
    (id) => typeof id === 'string' && known.has(id),
  );
  return { state: { ...source, sessions, activeSessionId: activeSessionId ?? '' }, added, replaced };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The extension's own memento row: one JSON object, one key per `update`. The
 * keys move to the new prefix; their values do not — a stored conversation can
 * contain any text, including the prefix itself. When the target row already
 * exists the two are merged (see the header).
 */
function planMementoRow(key, text, byKey, plan) {
  let source;
  try {
    source = JSON.parse(text);
  } catch (err) {
    problems.push(`${key}: the memento row is not valid JSON (${describeError(err)}) — left alone`);
    return;
  }
  if (!isPlainObject(source)) {
    problems.push(`${key}: the memento row is not a JSON object — left alone`);
    return;
  }

  const renamed = {};
  const mappings = [];
  for (const [inner, value] of Object.entries(source)) {
    const next = inner.startsWith(M.fromPrefix) ? `${M.toPrefix}${inner.slice(M.fromPrefix.length)}` : inner;
    if (next !== inner) {
      mappings.push(`${inner} → ${next}`);
    }
    renamed[next] = value;
  }

  const kept = [];
  const overwritten = [];
  const unions = [];
  if (byKey.has(M.toId)) {
    const target = safeJsonObject(byKey.get(M.toId));
    if (!target) {
      notes.push(`${M.toId} already exists and is not a JSON object — left alone, only the old row is re-keyed`);
    } else {
      for (const [inner, value] of Object.entries(target)) {
        if (!(inner in renamed)) {
          renamed[inner] = value;
          kept.push(inner);
        } else if (inner === STATE_KEY && isPlainObject(renamed[inner]) && isPlainObject(value)) {
          const union = unionState(renamed[inner], value);
          renamed[inner] = union.state;
          unions.push(
            `${inner}: merged, +${union.added.length} session(s) from the new row` +
              (union.replaced.length ? `, ${union.replaced.length} shared id(s) kept the richer copy` : ''),
          );
        } else {
          overwritten.push(inner);
        }
      }
    }
  }

  const parts = [];
  parts.push(mappings.length ? `${mappings.length} memento key(s) renamed` : 'no key to rename');
  parts.push(...unions);
  if (kept.length) {
    parts.push(`kept ${kept.join(', ')} (only the new row had it)`);
  }
  if (overwritten.length) {
    parts.push(`source wins over ${overwritten.join(', ')}`);
  }

  plan.rows.push({
    oldKey: key,
    newKey: M.toId,
    newValue: JSON.stringify(renamed),
    bytes: Buffer.byteLength(text, 'utf8'),
    mappings,
    detail: parts.join('; '),
  });
}

function safeJsonObject(text) {
  try {
    const value = JSON.parse(toText(text));
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Queue one planned row. Two old rows can land on the same new key — the old chat
 * webview and the chat panel both become `memento/webviewView.spinney.chatTree` —
 * so the longer value wins and the loser stays where it is, said out loud either
 * way. A row the target already has is listed as replaced, not overwritten in
 * silence.
 */
function pushRow(plan, row, byKey) {
  const clash = plan.rows.find((planned) => planned.newKey === row.newKey);
  if (clash) {
    const keep = clash.bytes >= row.bytes ? clash : row;
    const drop = keep === clash ? row : clash;
    notes.push(
      `${plan.label}: ${drop.oldKey} and ${keep.oldKey} both become ${row.newKey} — the longer value ` +
        `(${keep.oldKey}) is used, ${drop.oldKey} is left in place`,
    );
    if (keep === row) {
      plan.rows.splice(plan.rows.indexOf(clash), 1);
    } else {
      return;
    }
  }
  if (byKey.has(row.newKey)) {
    notes.push(`${plan.label}: ${row.newKey} already exists and is replaced by ${row.oldKey} (${fmtBytes(row.bytes)})`);
  }
  plan.rows.push(row);
}

/** Every row one database needs, plus whatever could not be read. */
function planDatabase(file, label) {
  const plan = { file, label, rows: [] };
  if (!fs.existsSync(file)) {
    return plan;
  }
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (err) {
    // A read-only open can fail where a read-write one succeeds (a database that
    // still needs journal recovery). A dry run writes nothing either way.
    try {
      db = new DatabaseSync(file);
    } catch (err2) {
      problems.push(`${file}: ${describeError(err2 || err)}`);
      return plan;
    }
  }
  try {
    let rows;
    try {
      rows = db.prepare('SELECT key, value FROM ItemTable').all();
    } catch (err) {
      problems.push(`${file}: ${describeError(err)}`);
      return plan;
    }
    const byKey = new Map(rows.map((row) => [toText(row.key), row.value]));
    const wanted = M.toId.toLowerCase();
    const variant = [...byKey.keys()].find((key) => key !== M.toId && key.toLowerCase() === wanted);
    if (variant) {
      notes.push(
        `${file}: a row named ${variant} also exists. VS Code reads the memento under the manifest case ` +
          `(${M.toId}), so that row is dead weight — it is left alone.`,
      );
    }
    for (const row of rows) {
      const key = toText(row.key);
      const text = toText(row.value);
      if (key === M.fromId) {
        planMementoRow(key, text, byKey, plan);
        continue;
      }
      const newKey = renamedKey(key);
      if (newKey && newKey !== key) {
        const newValue = renamedRowValue(key, text);
        pushRow(plan, {
          oldKey: key,
          newKey,
          newValue,
          bytes: Buffer.byteLength(text, 'utf8'),
          mappings: [],
          detail: `row renamed${text !== newValue ? ', view ids in the value too' : ''}`,
        }, byKey);
      }
    }
  } finally {
    db.close();
  }
  return plan;
}

/** Write one database's rows: new first, old last, inside one transaction. */
function applyDatabase(plan) {
  let db;
  try {
    db = new DatabaseSync(plan.file);
  } catch (err) {
    return describeError(err);
  }
  try {
    // BEGIN IMMEDIATE takes the write lock up front, so contention shows up as one
    // clear error instead of halfway through the row writes.
    db.exec('BEGIN IMMEDIATE');
    try {
      const insert = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
      const remove = db.prepare('DELETE FROM ItemTable WHERE key = ?');
      for (const row of plan.rows) {
        insert.run(row.newKey, row.newValue);
      }
      // The old rows go last: a crash in between leaves a readable copy under each
      // key, never nothing.
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
    return null;
  } catch (err) {
    return describeError(err);
  } finally {
    db.close();
  }
}

function printRowPlans(plans, apply) {
  let databases = 0;
  let rows = 0;
  for (const plan of plans) {
    if (plan.rows.length === 0) {
      continue;
    }
    databases++;
    console.log(`  [${apply ? 'write' : 'plan '}] ${plan.label} — ${plan.file}`);
    for (const row of plan.rows) {
      rows++;
      console.log(`          ${row.oldKey}`);
      console.log(`           →  ${row.newKey}   (${fmtBytes(row.bytes)}) — ${row.detail}`);
      for (const mapping of row.mappings.slice(0, 8)) {
        console.log(`                 ${mapping}`);
      }
      if (row.mappings.length > 8) {
        console.log(`                 …and ${row.mappings.length - 8} more`);
      }
    }
  }
  if (rows === 0) {
    console.log('  [skip  ] no row naming the old id in any state.vscdb');
  }
  return { databases, rows };
}

// --- step 3: read back --------------------------------------------------------

/** The number of sessions a memento row holds, or null when it cannot be read. */
function sessionsInMemento(text) {
  const memento = safeJsonObject(text);
  if (!memento) {
    return null;
  }
  const state = memento[STATE_KEY];
  if (state === undefined) {
    return 0; // this row holds only the small keys (the global one usually does)
  }
  return listSessions(isPlainObject(state) ? state : {}).length;
}

function verify(databases) {
  let total = 0;
  for (const { file, label } of databases) {
    try {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(M.toId);
        if (!row) {
          console.log(`  [warn  ] ${label} — no ${M.toId} row`);
          continue;
        }
        const sessions = sessionsInMemento(toText(row.value));
        if (sessions === null) {
          console.log(`  [warn  ] ${label} — the ${M.toId} row is not readable JSON`);
          continue;
        }
        total += sessions;
        console.log(`  [ok    ] ${label} — ${M.toId} holds ${sessions} session(s)`);
      } finally {
        db.close();
      }
    } catch (err) {
      problems.push(`${file}: could not read the row back — ${describeError(err)}`);
    }
  }
  return total;
}

// --- main ---------------------------------------------------------------------

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) {
      throw err;
    }
    console.error(`migrate-state: ${err.message}`);
    console.error('Run `node tools/migrate-state.mjs --help` for usage.');
    return 2;
  }
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const userDir = defaultUserDir();
  const globalStorage = opts.globalStorage ?? path.join(userDir, 'globalStorage');
  const workspaceStorage = opts.workspaceStorage ?? path.join(userDir, 'workspaceStorage');
  const fromDir = path.join(globalStorage, M.fromFolder);
  const toDir = path.join(globalStorage, M.toFolder);

  if (opts.apply && !opts.force && vscodeRunning()) {
    console.error('migrate-state: VS Code is running. Close every window and run this from a plain');
    console.error('  terminal (cmd, PowerShell, a POSIX shell), or pass --force if you know that no');
    console.error('  window holds these databases open — a write underneath a running window is');
    console.error('  silently undone when it exits.');
    return 1;
  }

  console.log(
    opts.apply
      ? 'migrate-state: APPLY — Minimal Agent Harness → Spinney'
      : 'migrate-state: DRY RUN — Minimal Agent Harness → Spinney (nothing is written)',
  );
  console.log(`  memento rows: ${M.fromId} → ${M.toId}   (the manifest case)`);
  console.log(`  folder:       ${fromDir}`);
  console.log(`             →  ${toDir}   (the lowercased form)`);
  console.log(`  user dir:     ${userDir}`);
  console.log('');

  const databases = collectDatabases(globalStorage, workspaceStorage);

  // ---- step 1: the storage folder ----
  console.log('step 1 — the storage folder');
  const folderSteps = printFolderPlan(fromDir, toDir);
  if (opts.apply) {
    applyFolderSteps(folderSteps);
  }
  console.log('');

  // ---- step 2: the rows ----
  console.log('step 2 — the memento rows');
  const plans = databases.map(({ file, label }) => planDatabase(file, label));
  const counts = printRowPlans(plans, opts.apply);
  if (opts.apply) {
    for (const plan of plans) {
      if (plan.rows.length === 0) {
        continue;
      }
      const error = applyDatabase(plan);
      if (error) {
        problems.push(`${plan.file}: ${error}`);
        console.log(`  [fail  ] ${plan.label} — ${error}`);
      }
    }
  }
  console.log('');

  // ---- step 3: read back ----
  let sessions = 0;
  if (opts.apply) {
    console.log('step 3 — read back');
    sessions = verify(collectDatabases(globalStorage, workspaceStorage));
    console.log('');
  }

  console.log(
    opts.apply
      ? `migrate-state: applied ${counts.rows} row(s) in ${counts.databases} database(s)` +
          (sessions ? ` — ${sessions} session(s) readable under ${M.toId}.` : '.')
      : `migrate-state: dry run — ${counts.rows} row(s) in ${counts.databases} database(s) would change. Re-run with --apply.`,
  );
  console.log(`  note: secrets are not migrated — ${M.toId} asks for the API key once more.`);
  console.log('  note: `<repo>/.agent-harness` scratch folders of the old build are left alone (tool output only).');
  for (const note of notes) {
    console.log(`  note: ${note}`);
  }

  if (problems.length) {
    console.error('');
    for (const problem of problems) {
      console.error(`  problem: ${problem}`);
    }
    return 1;
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
