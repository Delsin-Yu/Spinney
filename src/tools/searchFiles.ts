import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentTool } from '../agent/types';
import { beginWork, countWork, perf } from '../perf';
import { RequestGate } from '../agent/requestGate';
import { sliceText } from '../text';
import {
  SKIP_DIRS,
  ensureNotAborted,
  getAgentRoot,
  getWorkspaceRoot,
  globToRegex,
  hasWorkspaceFolder,
  limitInline,
  resolvePath,
  searchExcludeGlobs,
  searchTimeoutError,
  searchTimeoutSeconds,
} from './index';

/**
 * Files larger than this are not searched. Raised from 1 MB to 8 MB: a search's job is
 * to tell *excluded* from *absent*, and a bundled minified file or a generated table is
 * text that has to answer — while past 8 MB a single file can still eat the whole
 * budget of a call.
 */
const MAX_SEARCH_FILE = 8 * 1024 * 1024;
const MAX_SEARCH_FILES = 4000;
const MAX_SEARCH_MATCHES = 300;
const MAX_CONTEXT_LINES = 10;

/**
 * A NUL byte inside the first 8 KB means binary data — ripgrep's own first-cut
 * test. Fonts, generated tables and images are full of them, and regexing their
 * bytes line by line costs seconds per file and can only ever yield garbage. Only
 * the fallback walk needs this; rg does it itself.
 */
const BINARY_SNIFF_BYTES = 8192;

/**
 * How many ripgrep children may be in flight at once — the host-side **work budget**
 * (`lag blocked`, R1). A child scans off the JS thread, but spawning it, reading its
 * stdout and formatting its hits all happen *on* it, and a 15-sub-agent storm fires
 * dozens of searches at the same moment.
 *
 * Measured, offline, over the simulation fixture (32 whole-tree scans fired at once, the
 * shape 15 sub-agents × 2 searches produce), with the host's own 250 ms lag watch:
 *
 *   unbounded (32 at once)   890 ms wall   `lag blocked` worst **482 ms** (1 late tick)
 *   gated    (6 at a time)   741 ms wall   `lag blocked` worst   **0 ms** (0 late ticks)
 *
 * The gate is not a slowdown — it is *faster*: 32 processes at once thrash the machine and
 * the loop never gets an idle gap. 6 is the value that was measured; it is a mechanism,
 * not a setting, so it does not touch any documented default.
 */
const RG_CONCURRENCY = 6;
const rgGate = new RequestGate(RG_CONCURRENCY);

/** ripgrep's binary name on this platform. */
const RG_BIN = process.platform === 'win32' ? 'rg.exe' : 'rg';

/**
 * The extension's own root: this file compiles to `out/tools/`, so two levels up is the
 * folder `package.json` sits in — and `media/vendor/ripgrep/` is inside it, in the
 * `.vsix` as much as in a checkout.
 */
const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');

/**
 * The scope echo: "the search was narrowed by your settings / ignore files", so the
 * model can tell *excluded* from *absent*. Without it, a hitless search reads as
 * "this does not exist" and the model goes back to walking the tree by hand.
 */
const SCOPE_NOTE = '\n…[scope: search.exclude/files.exclude/.gitignore honored]';

/**
 * The same echo for a search **outside** the open workspace folder: `search.exclude` and
 * `files.exclude` describe the workspace, so they are not applied out there — only the
 * directories that are never worth walking are, in both execution paths.
 */
const OUTSIDE_SCOPE_NOTE =
  '\n…[scope: the root is outside the workspace — search.exclude/files.exclude not applied; .git and ' +
  'node_modules/out/dist/build/.spinney are always skipped]';

/** Why a search stopped before it had scanned everything. */
type CapReason = 'none' | 'matches' | 'wall' | 'files';

/** One search's hits plus the counters the `search-files` perf line reports. */
interface SearchOutcome {
  results: string[];
  matches: number;
  files: number;
  reason: CapReason;
  /** How many `search.exclude` / `files.exclude` patterns were in effect (0 outside the workspace). */
  scope: number;
  via: 'rg' | 'walk';
  /** How long the child waited for a slot in the work budget (0 for the walk). */
  waitMs: number;
  /** Files the walk skipped for size; rg skips them silently, so it reports 0. */
  skippedLarge: number;
}

/** Everything one search needs, resolved once and read by both paths. */
interface SearchOptions {
  root: string;
  /** The pattern as written: rg compiles it in its own dialect. */
  rawPattern: string;
  /** The same pattern compiled as a JS regex — the contract's dialect, and the walk's. */
  re: RegExp;
  caseSensitive: boolean;
  /** The `glob` argument as written (rg globs) and compiled (the walk). */
  rawGlob: string | null;
  glob: RegExp | null;
  context: number;
  maxResults: number;
  /** `search.exclude` + `files.exclude` — empty when the root is not inside the workspace. */
  excludes: string[];
  display: (full: string) => string;
  /** `Date.now()` when the call's one budget is spent — shared by rg and the walk. */
  deadlineAt: number;
  signal?: AbortSignal;
}

/** Trailing note appended to a search result that stopped before scanning everything. */
function searchCapNote(reason: CapReason, maxResults: number, skippedLarge: number): string {
  const notes: string[] = [];
  if (reason === 'matches') {
    notes.push(
      `reached the ${maxResults}-match cap (hard cap ${MAX_SEARCH_MATCHES}) — results may be incomplete; ` +
        'narrow the pattern, add a glob, or raise maxResults',
    );
  } else if (reason === 'files') {
    notes.push(
      `stopped after ${MAX_SEARCH_FILES} files — results may be incomplete; ` +
        'narrow the pattern, add a glob, or exclude more of the tree',
    );
  }
  // `wall` has no note: a search that runs out of its budget answers an `Error:` line
  // instead of a partial page, so there is nothing here to hand the model as results.
  if (skippedLarge > 0) {
    notes.push(`skipped ${skippedLarge} file(s) larger than ${MAX_SEARCH_FILE} bytes`);
  }
  return notes.length ? `\n…[search stopped early: ${notes.join('; ')}.]` : '';
}

// ---- ripgrep -----------------------------------------------------------------

/**
 * Every place a ripgrep binary may live, **in the order they are probed**:
 *
 * 1. the extension's own vendored copy — `media/vendor/ripgrep/<platform>-<arch>/rg`,
 *    downloaded from the official BurntSushi/ripgrep release (see that folder's
 *    `PROVENANCE.md`). It is first because it is the one binary whose existence the
 *    extension itself guarantees, on every platform and in the `.vsix` as much as in a
 *    checkout, so a search does not depend on what the host happens to bundle;
 * 2. VS Code's bundled ripgrep under `vscode.env.appRoot`. Current builds ship the
 *    *universal* package, one binary per platform-architecture under `bin/<platform>-<arch>/`;
 *    older builds shipped `@vscode/ripgrep` with a single `bin/rg` (a folder that still
 *    exists and is empty on a current build — which is why the universal path is tried
 *    too). Unpacked comes first (a packaged VS Code keeps the binary outside
 *    `node_modules.asar`);
 * 3. plain `rg` on `PATH` — only the spawn can say whether that one exists.
 */
function ripgrepCandidates(): string[] {
  const appRoot = vscode.env.appRoot;
  const bundled = appRoot
    ? [
        `node_modules.asar.unpacked/@vscode/ripgrep/bin/${RG_BIN}`,
        `node_modules/@vscode/ripgrep/bin/${RG_BIN}`,
        `node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/${process.platform}-${process.arch}/${RG_BIN}`,
        `node_modules/@vscode/ripgrep-universal/bin/${process.platform}-${process.arch}/${RG_BIN}`,
      ].map((rel) => path.join(appRoot, rel))
    : [];
  return [
    path.join(EXTENSION_ROOT, 'media', 'vendor', 'ripgrep', `${process.platform}-${process.arch}`, RG_BIN),
    ...bundled,
    RG_BIN,
  ];
}

/**
 * The candidates that are already known **not** to work on this machine: an absolute
 * path that does not exist, or a binary that failed to spawn. Only the candidate that
 * failed is forgotten — one broken binary must not disable ripgrep for the session,
 * which is what a single "rg is gone" verdict used to do.
 */
const rgUnusable = new Set<string>();
/** A vendored/bundled binary that ran this session: logged once, not once per search. */
let rgReported: string | null = null;

/** The next candidate worth probing, or `null` once every one of them is unusable. */
function nextRipgrep(): string | null {
  for (const candidate of ripgrepCandidates()) {
    if (rgUnusable.has(candidate)) {
      continue;
    }
    if (candidate === RG_BIN) {
      // PATH: only the spawn 'error' event can answer.
      if (rgReported !== candidate) {
        rgReported = candidate;
        perf(() => `search rg=PATH (${RG_BIN})`);
      }
      return candidate;
    }
    try {
      if (!fs.existsSync(candidate)) {
        rgUnusable.add(candidate);
        continue;
      }
    } catch {
      rgUnusable.add(candidate);
      continue;
    }
    if (rgReported !== candidate) {
      rgReported = candidate;
      // Logged once per session: which ripgrep answered decides whether the vendored
      // binary (or the host's) is in play at all, and a report from a machine that
      // silently fell back to the in-process walk would otherwise look identical.
      perf(() => `search rg=${candidate}`);
    }
    return candidate;
  }
  if (rgReported !== 'missing') {
    rgReported = 'missing';
    perf('search rg=missing (no vendored, bundled or PATH rg — searches use the in-process walk)');
  }
  return null;
}

/**
 * Give up on **one** binary (a spawn failure, or a file that exists and cannot run):
 * that candidate is dropped from the probe list and the next one is tried, so a stale
 * bundled `rg` no longer costs the session its ripgrep.
 */
function forgetRipgrep(command: string): void {
  rgUnusable.add(command);
  if (rgReported === command) {
    rgReported = null;
  }
  perf(() => `search rg=${command} cannot run — trying the next candidate`);
}

/**
 * The ripgrep argv for one search. `--json` is used because its events map exactly
 * onto the tool's documented output (`path.text` + `line_number` + `lines.text` →
 * `file:line: text`; a context event → the `-` separator form), whereas the
 * line-oriented output would have to be re-split on separators that a path may
 * itself contain. `.` keeps every reported path relative to the root we are already
 * cwd'd in, and `-e` keeps a pattern starting with `-` from being read as a flag.
 *
 * No `--no-ignore`: honouring `.gitignore`/`.ignore` is deliberate. `--hidden` keeps
 * dot-directories searchable (the old walk did search them). `SKIP_DIRS` goes in as
 * globs so rg prunes exactly the directories the walk does — `.git` first among them,
 * since it is the one hidden tree that is always huge, and `out/`, `dist/`,
 * `node_modules/` and the agent's own `.spinney/` scratch after it.
 */
function rgArgs(opts: SearchOptions): string[] {
  const args = [
    '--json',
    // Deterministic: a user's RIPGREP_CONFIG_PATH must not change what the tool means.
    '--no-config',
    '--hidden',
    '--max-filesize',
    String(MAX_SEARCH_FILE),
    '-e',
    opts.rawPattern,
  ];
  if (!opts.caseSensitive) {
    args.push('-i');
  }
  if (opts.context > 0) {
    args.push('-C', String(opts.context));
  }
  if (opts.rawGlob) {
    args.push(`--glob=${opts.rawGlob}`);
  }
  for (const dir of SKIP_DIRS) {
    args.push(`--glob=!**/${dir}/**`);
  }
  for (const exclude of opts.excludes) {
    args.push(`--glob=!${exclude}`);
  }
  args.push('.');
  return args;
}

/** One line of `rg --json` output, as far as this tool cares. */
interface RgEvent {
  type?: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string; bytes?: string };
    line_number?: number;
    stats?: { searches?: number };
  };
}

/**
 * Control characters that never belong to a line of source code (BEL, ESC, NUL, …).
 * A font or a generated table is full of them, and ripgrep reports such a file as
 * *text* whenever its bytes happen to decode — so the check cannot rely on rg's own
 * binary verdict alone.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** One line's text the way `rg --json` reports it, or `null` for a binary line. */
function rgLineText(lines: { text?: string; bytes?: string } | undefined): string | null {
  // A line rg could not decode arrives as base64 `bytes`. That is the binary signal:
  // ripgrep *does* report the first match of a binary file, and decoding that blob
  // would hand the model mojibake as a "hit".
  if (typeof lines?.bytes === 'string' && lines.bytes) {
    return null;
  }
  if (typeof lines?.text !== 'string') {
    return null;
  }
  const trimmed = lines.text.trim();
  if (CONTROL_CHARS.test(trimmed)) {
    return null;
  }
  return sliceText(trimmed, 160);
}

/** A path as rg reported it (relative to the root we cwd'd into), slash-joined. */
function rgRelative(raw: string): string {
  const slashed = raw.replace(/\\/g, '/');
  return slashed.startsWith('./') ? slashed.slice(2) : slashed;
}

/** ripgrep's own binary verdict is only a NUL byte; a control-character belt is needed too. */
function looksBinary(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i++) {
    const byte = buffer[i];
    if (byte === 0 || byte < 0x09 || (byte > 0x0d && byte < 0x20) || byte === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * What one ripgrep attempt answered: the hits (possibly a budget stop), a **refusal**
 * of the query itself (`outcome: null` — the pattern is outside rg's dialect, so the
 * walk is the honest answer and the next candidate would refuse it too), or a binary
 * that **could not run** (`candidateDead` — that candidate is forgotten and the next
 * one is tried).
 */
interface RgAttempt {
  outcome: SearchOutcome | null;
  candidateDead: boolean;
}

/**
 * Run ripgrep for one search in a **child process** — off the extension host's only
 * JS thread, which is the whole point: a "does this exist?" search no longer has to
 * scan the tree on the thread the UI runs on.
 *
 * The child is killed the moment `maxResults` matches are in, and again when the
 * call's one budget (`opts.deadlineAt`) runs out — the timer is armed with whatever is
 * *left* of it, so a slot queued behind the work budget comes out of the same budget.
 * Resolves with `outcome: null` when rg cannot answer this query, so the caller can
 * fall back to the walk; otherwise it resolves with the hits collected so far.
 */
async function runRipgrep(command: string, opts: SearchOptions): Promise<RgAttempt> {
  // Take a slot before the child exists: this is the work budget (see RG_CONCURRENCY).
  // The wait is reported on the `search-files` line: with fifteen sub-agents searching at
  // once it is the number that says whether the budget is doing its job.
  const gateStarted = Date.now();
  try {
    await rgGate.acquire(opts.signal);
  } catch {
    // Aborted while queued: the caller's own `ensureNotAborted` reports it the same way.
    throw new Error('Operation aborted.');
  }
  /** The slot wait only — measured *before* the child exists, never the scan's own time. */
  const gateWaitMs = Date.now() - gateStarted;
  // The budget is one budget: a call that spent it waiting for a slot has nothing left
  // for the child, and says so without spawning anything.
  const remaining = opts.deadlineAt - Date.now();
  if (remaining <= 0) {
    rgGate.release();
    return {
      outcome: {
        results: [],
        matches: 0,
        files: 0,
        reason: 'wall',
        scope: opts.excludes.length,
        via: 'rg',
        waitMs: gateWaitMs,
        skippedLarge: 0,
      },
      candidateDead: false,
    };
  }
  // Counted as live host work for the whole lifetime of the child: the scan runs off the
  // loop, but its output is read and parsed *on* it, which is what a `lag blocked` line
  // has to be able to name (`work=[rg:6]` with the gate in place, `rg:14` without it).
  const endWork = beginWork('rg');
  countWork('rg-spawn');
  const releaseSlot = (): void => {
    rgGate.release();
    endWork();
  };
  return new Promise<RgAttempt>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, rgArgs(opts), {
        cwd: opts.root,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      releaseSlot();
      forgetRipgrep(command);
      resolve({ outcome: null, candidateDead: true });
      return;
    }

    const results: string[] = [];
    const seen = new Set<string>();
    /** Paths whose content is not text: their hits are dropped, never decoded. */
    const binary = new Set<string>();
    let matches = 0;
    let searched = 0;
    let reason: CapReason = 'none';
    let refused = false;
    let dead = false;
    let settled = false;
    let buffered = '';
    let deadline: ReturnType<typeof setTimeout> | undefined;

    /** Resolve once, and never leave the timer or the abort listener behind. */
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      releaseSlot();
      if (deadline) {
        clearTimeout(deadline);
      }
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        outcome:
          refused || dead
            ? null
            : {
                results,
                matches,
                // `searched` is rg's own count from its `end` event, which a killed run
                // never reaches; `seen` is the files we actually saw hits in, so the
                // larger of the two is the honest answer.
                files: Math.max(searched, seen.size),
                reason,
                scope: opts.excludes.length,
                via: 'rg',
                waitMs: gateWaitMs,
                skippedLarge: 0,
              },
        candidateDead: dead,
      });
    };

    const kill = (): void => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    };

    /** Stop the run now: the verdict already collected stands. */
    const stop = (why: CapReason): void => {
      if (settled) {
        return;
      }
      reason = why;
      kill();
      finish();
    };

    function onAbort(): void {
      kill();
      finish();
    }

    const handleEvent = (line: string): void => {
      if (settled || !line) {
        return;
      }
      let event: RgEvent;
      try {
        event = JSON.parse(line) as RgEvent;
      } catch {
        return; // not a frame we understand
      }
      if (event.type === 'end' || event.type === 'summary') {
        const count = event.data?.stats?.searches;
        if (typeof count === 'number') {
          searched = count;
        }
        return;
      }
      if (event.type !== 'match' && event.type !== 'context') {
        return;
      }
      const relative = event.data?.path?.text;
      const lineNumber = event.data?.line_number;
      if (typeof relative !== 'string' || typeof lineNumber !== 'number') {
        return;
      }
      const rel = rgRelative(relative);
      const hit = event.type === 'match';
      const text = rgLineText(event.data?.lines);
      if (text === null) {
        // A binary line: skip this file for the rest of the search, and count the
        // match it would have spent a slot on as *not* a match.
        binary.add(rel);
        return;
      }
      if (binary.has(rel)) {
        return;
      }
      if (!seen.has(rel)) {
        seen.add(rel);
        if (seen.size > MAX_SEARCH_FILES) {
          stop('files');
          return;
        }
      }
      if (hit) {
        matches++;
      }
      const label = opts.display(path.isAbsolute(relative) ? relative : path.join(opts.root, rel));
      const separator = hit ? ':' : '-';
      results.push(`${label}${separator}${lineNumber}${separator} ${text}`);
      if (hit && matches >= opts.maxResults) {
        stop('matches'); // the early kill: nothing else is worth reading
      }
    };

    child.stdout?.setEncoding('utf8'); // StringDecoder: a chunk boundary may split a character
    child.stdout?.on('data', (chunk: string) => {
      if (settled) {
        return;
      }
      buffered += chunk;
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        handleEvent(line);
        if (settled) {
          return;
        }
        newline = buffered.indexOf('\n');
      }
    });
    // Drained, not kept: the child must never block on a full stderr pipe.
    child.stderr?.on('data', () => undefined);

    child.on('error', () => {
      // A start failure (ENOENT for `rg` on PATH, or a binary that cannot run). Only
      // THIS candidate is forgotten; the caller tries the next one, and only when none
      // is left does the walk run.
      forgetRipgrep(command);
      dead = true;
      kill();
      finish();
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      // Exit 2 = rg refused the search (a regex outside its dialect — no lookaround
      // or backreferences — or an unreadable path). With nothing collected, the
      // walk, which evaluates JS regex semantics, is the honest answer; with hits in
      // hand, keep them.
      if (code === 2 && results.length === 0) {
        refused = true;
      }
      finish();
    });

    deadline = setTimeout(() => stop('wall'), Math.max(0, opts.deadlineAt - Date.now()));
    if (opts.signal) {
      opts.signal.addEventListener('abort', onAbort, { once: true });
      if (opts.signal.aborted) {
        onAbort();
      }
    }
  });
}

// ---- the in-process walk (the fallback) --------------------------------------

/**
 * The original in-process walk, kept working — it is the only path when no ripgrep
 * exists — but brought in line with the rg path: the same exclusions, the same
 * binary test, and the same two ceilings. It also keeps `SKIP_DIRS` on top of the
 * settings (`out/`, `dist/` are build output, and a repo-wide search must never
 * return the agent's own `.spinney/` scratch); the walk cannot read `.gitignore`, so
 * that set is the conservative stand-in for it.
 */
async function runWalk(opts: SearchOptions): Promise<SearchOutcome> {
  const results: string[] = [];
  let matches = 0;
  let files = 0;
  let skippedLarge = 0;
  let reason: CapReason = 'none';
  const excludePatterns = opts.excludes.map(globToRegex);
  // The same single budget the rg attempt was given: whatever is left of it, not a
  // fresh twenty seconds on top.
  const deadlineAt = opts.deadlineAt;

  /**
   * Does a root-relative path fall under an exclusion? A directory is probed as
   * `dir/x` too, so a pattern like node_modules (recursive) prunes the directory
   * itself instead of only the first file inside it.
   */
  const excluded = (relPath: string, isDirectory: boolean): boolean =>
    excludePatterns.some((re) => re.test(relPath) || (isDirectory && re.test(`${relPath}/x`)));

  /** Append every hit in one file's text (plus optional context lines). */
  const searchText = (text: string, label: string): void => {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!opts.re.test(lines[i])) {
        continue;
      }
      if (matches >= opts.maxResults) {
        reason = 'matches';
        return;
      }
      matches++;
      if (opts.context > 0) {
        const from = Math.max(0, i - opts.context);
        const to = Math.min(lines.length - 1, i + opts.context);
        for (let j = from; j <= to; j++) {
          const sep = j === i ? ':' : '-';
          results.push(`${label}${sep}${j + 1}${sep} ${sliceText(lines[j].trim(), 160)}`);
        }
      } else {
        results.push(`${label}:${i + 1}: ${sliceText(lines[i].trim(), 160)}`);
      }
    }
  };

  const walk = async (dir: string, rel: string): Promise<void> => {
    if (opts.signal?.aborted) {
      throw new Error('Operation aborted.');
    }
    if (reason !== 'none') {
      return;
    }
    if (files >= MAX_SEARCH_FILES) {
      reason = 'files';
      return;
    }
    if (Date.now() >= deadlineAt) {
      reason = 'wall';
      return;
    }
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (opts.signal?.aborted) {
        throw new Error('Operation aborted.');
      }
      if (reason !== 'none') {
        return;
      }
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || excluded(relPath, true)) {
          continue;
        }
        await walk(path.join(dir, entry.name), relPath);
        continue;
      }
      if (opts.glob && !opts.glob.test(relPath)) {
        continue;
      }
      if (excluded(relPath, false)) {
        continue;
      }
      if (files >= MAX_SEARCH_FILES) {
        reason = 'files';
        return;
      }
      if (Date.now() >= deadlineAt) {
        reason = 'wall';
        return;
      }
      files++;
      const full = path.join(dir, entry.name);
      let buffer: Buffer;
      try {
        const stat = await fs.promises.stat(full);
        if (stat.size > MAX_SEARCH_FILE) {
          skippedLarge++;
          continue;
        }
        buffer = await fs.promises.readFile(full);
      } catch {
        continue;
      }
      if (looksBinary(buffer)) {
        continue; // a font or a generated table is not text to regex
      }
      searchText(buffer.toString('utf8'), opts.display(full));
      if (reason !== 'none') {
        return;
      }
    }
  };

  await walk(opts.root, '');
  // The walk only checks the clock between files, so the last one can carry it past the
  // budget: a search that finished *late* ran out of time just the same, and must answer
  // the timeout instead of a page that is missing whatever it did not reach.
  if (reason === 'none' && Date.now() >= deadlineAt) {
    reason = 'wall';
  }
  return {
    results,
    matches,
    files,
    reason,
    scope: opts.excludes.length,
    via: 'walk',
    waitMs: 0,
    skippedLarge,
  };
}

/** Does the search root carry an ignore file rg will honour (for the scope echo)? */
function hasIgnoreFile(root: string): boolean {
  try {
    return fs.existsSync(path.join(root, '.gitignore')) || fs.existsSync(path.join(root, '.ignore'));
  } catch {
    return false;
  }
}

export const searchFilesTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'search_files',
      description:
        'Search files for a regex pattern and return matching "file:line: text" lines (paths are relative to the harness root; absolute when no folder is open). `path` may be a file or a directory (default = the harness root: the workspace folder, or the harness scratch folder when no folder is open). An optional glob (e.g. "**/*.ts") filters which files are searched; caseSensitive defaults to false; maxResults caps the matches (default 200, hard cap 300); context adds up to 10 surrounding lines per match (context lines use "-" separators, e.g. "src/a.ts-11- text"). Prefer MANY SMALL CHEAP searches to one wide one: a narrow path plus a tight pattern is answered in milliseconds, while a whole-tree scan of a vague pattern can only end in nothing or a timeout. Every call has ONE hard time budget — spinney.searchTimeoutSeconds, 10 seconds by default — shared by the whole call, so narrowing the path, tightening the pattern, adding a glob or lowering context is how you stay inside it; when the budget runs out the result is an `Error: search_files timed out after N s …` line with NO hits and no count, and the answer is to search a smaller part of the tree (if even a simple query times out, ask the user to raise spinney.searchTimeoutSeconds). Inside the workspace the search honors `search.exclude`, `files.exclude` and `.gitignore`, so a path the user excluded is never reported and the result says so (`…[scope: …]`); a root OUTSIDE the workspace is searched without those two settings, because they describe the workspace. `.git` and node_modules/out/dist/build/.spinney are skipped in both cases, and binary files are skipped too. When the search stops before scanning everything (match cap / file ceiling / oversized files) the result ends with an explicit note — never treat a capped result as complete. Prefer this over searching through the shell: the result tells excluded from absent instead of reading as "nothing found", and the shell has no budget behind it.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex to search for (JS regex syntax).' },
          path: { type: 'string', description: 'File or directory to search (default = the harness root: the workspace folder, or the harness scratch folder when no folder is open).' },
          glob: { type: 'string', description: 'Optional glob filter, e.g. "**/*.ts".' },
          caseSensitive: { type: 'boolean', description: 'Default false.' },
          maxResults: { type: 'number', description: 'Default 200 (capped at 300).' },
          context: { type: 'number', description: 'Lines of context around each match (0-10, default 0).' },
        },
        required: ['pattern'],
      },
    },
  },
  async execute(args, signal) {
    ensureNotAborted(signal);
    const pattern = String(args.pattern ?? '');
    if (!pattern) {
      return 'Error: search_files requires a "pattern".';
    }
    let re: RegExp;
    try {
      re = new RegExp(pattern, args.caseSensitive ? '' : 'i');
    } catch (err) {
      return `Error: invalid regex: ${err instanceof Error ? err.message : String(err)}`;
    }
    const root = args.path ? resolvePath(String(args.path)) : getAgentRoot();
    const rawGlob = args.glob ? String(args.glob) : null;
    const maxResults =
      typeof args.maxResults === 'number' ? Math.min(Math.max(1, args.maxResults), MAX_SEARCH_MATCHES) : 200;
    const context =
      typeof args.context === 'number' ? Math.min(Math.max(0, Math.floor(args.context)), MAX_CONTEXT_LINES) : 0;
    // With no folder open we print absolute paths: scratch-root-relative paths would be ambiguous.
    const wsRoot = hasWorkspaceFolder() ? getWorkspaceRoot() : null;

    /** Path shown in a hit: workspace-relative when inside it, else absolute. */
    const display = (full: string): string => {
      if (wsRoot) {
        const rel = path.relative(wsRoot, full).split(path.sep).join('/');
        if (rel && !rel.startsWith('..')) {
          return rel;
        }
      }
      return full.split(path.sep).join('/');
    };

    let rootStat;
    try {
      rootStat = await fs.promises.stat(root);
    } catch {
      return `Error: no such file or directory: ${root}`;
    }

    const started = Date.now();
    // ONE budget for the whole call, read live: the rg child, a slot queued behind the
    // work budget, and the fallback walk all draw from it — a search cannot spend ten
    // seconds in ripgrep and ten more in the walk.
    const timeoutSec = searchTimeoutSeconds();
    const deadlineAt = started + timeoutSec * 1000;

    /** Assemble (and log) one search's result. A budget stop answers an `Error:` line. */
    const report = (outcome: SearchOutcome, scopeNote: string): string => {
      perf(
        () =>
          `search-files ms=${Date.now() - started} files=${outcome.files} matches=${outcome.matches} ` +
          `capped=${outcome.reason} via=${outcome.via} scope=${outcome.scope} wait=${outcome.waitMs}ms`,
      );
      // A timeout is not a partial result: no hits and no count, because a page that
      // stops mid-tree reads as "this is all there is".
      if (outcome.reason === 'wall') {
        return searchTimeoutError('search_files', root, timeoutSec);
      }
      const text = outcome.results.length
        ? outcome.results.join('\n') + searchCapNote(outcome.reason, maxResults, outcome.skippedLarge) + scopeNote
        : `(no matches)${scopeNote}`;
      return limitInline(text, 'search_files');
    };

    // `path` may name a single file (the parameter says so) — search just it,
    // in-process: it is one file, and an explicitly named path is a request to read
    // it whatever it holds. No exclusion applies, so there is no scope echo.
    if (rootStat.isFile()) {
      const text = await fs.promises.readFile(root, 'utf8');
      const lines = text.split('\n');
      const results: string[] = [];
      let matches = 0;
      let capped = false;
      const label = display(root);
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) {
          continue;
        }
        if (matches >= maxResults) {
          capped = true;
          break;
        }
        matches++;
        if (context > 0) {
          const from = Math.max(0, i - context);
          const to = Math.min(lines.length - 1, i + context);
          for (let j = from; j <= to; j++) {
            const sep = j === i ? ':' : '-';
            results.push(`${label}${sep}${j + 1}${sep} ${sliceText(lines[j].trim(), 160)}`);
          }
        } else {
          results.push(`${label}:${i + 1}: ${sliceText(lines[i].trim(), 160)}`);
        }
      }
      return report(
        {
          results,
          matches,
          files: 1,
          reason: capped ? 'matches' : 'none',
          scope: 0,
          via: 'walk',
          waitMs: 0,
          skippedLarge: 0,
        },
        '',
      );
    }

    // `search.exclude` / `files.exclude` describe the WORKSPACE, so they only apply when
    // the search root is inside the open folder — a search out in the global storage or
    // another repository is not narrowed by this workspace's settings. `SKIP_DIRS`
    // (node_modules, .git, out, dist, build, .spinney) is a property of the tool, not of
    // the workspace, and always applies — to rg as `--glob` negations and to the walk.
    const insideWorkspace = isInsideWorkspace(wsRoot, root);
    const excludes = insideWorkspace ? [...new Set(searchExcludeGlobs())] : [];
    const options: SearchOptions = {
      root,
      rawPattern: pattern,
      re,
      caseSensitive: args.caseSensitive === true,
      rawGlob,
      glob: rawGlob ? globToRegex(rawGlob) : null,
      context,
      maxResults,
      excludes,
      display,
      deadlineAt,
      signal,
    };

    // Every candidate in order, and only THIS candidate is dropped on a spawn failure:
    // `nextRipgrep()` walks the vendored binary, VS Code's bundled ones and then PATH,
    // skipping whatever already failed. Only when none is left does the walk run — inside
    // the same budget.
    let outcome: SearchOutcome | null = null;
    for (;;) {
      const rg = nextRipgrep();
      if (!rg) {
        break;
      }
      const attempt = await runRipgrep(rg, options);
      if (attempt.outcome) {
        outcome = attempt.outcome;
        break;
      }
      if (!attempt.candidateDead) {
        // rg ran and refused the query (a pattern outside its dialect): the next
        // candidate would refuse it too, so the walk is the honest answer.
        break;
      }
    }
    ensureNotAborted(signal);
    if (!outcome) {
      outcome = await runWalk(options);
    }
    const scopeNote = insideWorkspace
      ? excludes.length > 0 || hasIgnoreFile(root)
        ? SCOPE_NOTE
        : ''
      : OUTSIDE_SCOPE_NOTE;
    return report(outcome, scopeNote);
  },
};

/**
 * Is `root` inside the open workspace folder? A parent of it is **outside**: the two
 * `*.exclude` settings describe what the workspace contains, and a search above it is
 * asking a different question.
 */
function isInsideWorkspace(wsRoot: string | null, root: string): boolean {
  if (!wsRoot) {
    return false;
  }
  const rel = path.relative(wsRoot, root);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
