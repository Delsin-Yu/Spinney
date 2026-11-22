/**
 * mentionIndex.ts — the host side of the composer's `@` file picker: the file index, the
 * directory listing, and the one attach dialog, in the single file that owns every
 * `vscode`, `fs` and `child_process` call the picker needs (`mentions.ts` beside it is
 * pure logic, so the guard can drive the matcher without an Extension Host).
 *
 * Three sources answer one query, and the *shape of the query text* picks which — the
 * classifier lives in `./mentions` because it is pure and testable:
 *
 *   - **workspace** — a ripgrep index of the agent root, built once and cached. The
 *     flags and the two exclusion sources are deliberately identical to `search_files`,
 *     so "what the agent can find" and "what the user can point at" are the same set
 *     (`docs/agents/plans/mention-syntax.md` §7);
 *   - **absolute** — one `readdir` of the directory the typed path names, with the trailing
 *     fragment matched against that directory's entries by the same engine the workspace
 *     uses. The directory part is never interpreted (§4); the fragment is, so `rt`, `*.cs`
 *     and `cundang` mean here what they mean over the workspace. A fragment with no hit
 *     answers with no rows at all: nothing outside the typing path is ever offered;
 *   - **no folder open** — there is no index to build, so the menu is a listing of the
 *     scratch root from the start and the caller's one footer line says so. A `@` picker
 *     that goes dead in an empty window would be a feature that exists only in repos.
 *
 * Two rules this file exists to keep:
 *
 *   1. **A query never throws and never opens a VS Code notice.** The menu is non-modal
 *      and the user is still typing, so an `EACCES` directory, a half-typed path or a
 *      missing ripgrep becomes one dim `note` row; the next keystroke is the fix, and a
 *      modal box over the composer steals the focus that fix needs.
 *   2. **One insert shape.** A workspace pick inserts a forward-slash relative path, and a
 *      file chosen through the dialog that lies inside the agent root is normalised by the
 *      same function ({@link workspaceRelativePath}) — so typing `@`, clicking a row and
 *      using the attach button cannot produce three spellings of one file (§4).
 */
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { SKIP_DIRS, getAgentRoot, hasWorkspaceFolder, resolvePath, searchExcludeGlobs } from '../tools/index';
import type { MentionItem, MentionScope } from './mentions';
import { classifyMentionQuery, firstSegment, rankMentions, recentMentions, splitTypedPath } from './mentions';
import { pinyin } from './pinyin';

/** What one composer query answered, ready for `{ type: 'mentionResult' }` (§8). */
export interface MentionAnswer {
  /** Which source answered — the webview reads it as "the menu is in path mode now". */
  scope: MentionScope;
  /** The rows, already ranked (§6.6) or already in directory order (§4). */
  items: MentionItem[];
  /** One sentence for the menu footer, already localized here with `vscode.l10n.t`. */
  note?: string;
  /** The index stopped at {@link INDEX_CAP} paths, so the list is a prefix of the tree. */
  truncated?: boolean;
}

/**
 * How many paths the index keeps. Past this the footer says the list is partial: 50k is
 * several times the file count of the repositories this extension is used in, so hitting
 * it is a signal (a monorepo, a forgotten exclusion) rather than a normal state.
 */
const INDEX_CAP = 50_000;

/**
 * What makes a workspace query a PATH query instead of a file-name search (§3.2): a prefix is a
 * place to look, and walking it one segment at a time is the whole point of the menu's `Tab`.
 * No file name contains a separator, so this test can never mistake a name for a path.
 */
const SEPARATOR = /[\\/]/;

/** Rows one workspace query answers with, after sorting — the plan's 50 (§6.6). */
const ROW_LIMIT = 50;

/**
 * Entries one directory listing shows, plus a `…` row when there are more (§7). A
 * directory with hundreds of entries is a *listing*, not a search: the user narrows it by
 * typing another segment instead of scrolling 4000 rows of `node_modules`.
 */
const DIR_CAP = 200;

/**
 * Entries one absolute query ranks against. `readdir` hands back everything the directory
 * holds, and a name fragment has to be matched against *all* of it to be honest, but a
 * `node_modules` with 60k entries must not turn one keystroke into a 60k-row scan: past this
 * the list is a prefix and the menu says so with the same `…` row the listing uses.
 */
const RANK_SCAN_CAP = 5000;

/** ripgrep's binary name on this platform — the same name `search_files` looks for. */
const RG_BIN = process.platform === 'win32' ? 'rg.exe' : 'rg';

/**
 * The extension's own root: this file compiles to `out/chat/`, so two levels up is the
 * folder `package.json` sits in — and `media/vendor/ripgrep/` is inside it, in the
 * `.vsix` as much as in a checkout.
 */
const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Every place a ripgrep binary may live, **in the order they are probed** — the same list,
 * in the same order, as `src/tools/searchFiles.ts`.
 *
 * It is repeated rather than imported because that module keeps its resolver private (it
 * owns its own "this candidate is dead" memory, which a second caller must not disturb).
 * What matters is not sharing the code but sharing the *choice*: the vendored copy under
 * `media/vendor/ripgrep/` is first here too, so the picker and `search_files` run the same
 * binary and list the same files — and a machine that fell back to VS Code's bundled copy,
 * or to `rg` on `PATH`, must not end up with two different ripgreps disagreeing about what
 * exists.
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
 * The argv of one index build:
 *
 *   `rg --files --null --hidden --no-config`, plus one `--glob` that excludes each
 *   `SKIP_DIRS` entry (the same recursive-exclusion glob `search_files` builds) and one
 *   `--glob` per `search.exclude` / `files.exclude` pattern.
 *
 * `--null` because a path may itself contain a newline, and splitting a listing on `\n`
 * would then invent two files out of one. `--hidden` keeps dot-directories listable (the
 * picker is how a user points at `.github/workflows/…`). `--no-config` because a user's
 * `RIPGREP_CONFIG_PATH` must not change what the menu means. No `--no-ignore`: honouring
 * `.gitignore` is the whole reason the index uses ripgrep instead of a walk — the files
 * the agent would never be shown are not files the user should be offered.
 *
 * The path argument is omitted on purpose: `rg --files` defaults to `./` and reports every
 * path relative to the `cwd` we spawn in, which is exactly the shape the index stores.
 */
function rgArgs(): string[] {
  const args = ['--files', '--null', '--hidden', '--no-config'];
  for (const dir of SKIP_DIRS) {
    args.push(`--glob=!**/${dir}/**`);
  }
  for (const exclude of searchExcludeGlobs()) {
    args.push(`--glob=!${exclude}`);
  }
  return args;
}

/** One ripgrep candidate's answer: the relative paths it listed, and whether it was capped. */
interface IndexRun {
  paths: string[];
  truncated: boolean;
}

/**
 * A path in the one spelling everything downstream speaks: forward slashes.
 *
 * ripgrep prints a Windows path with backslashes, and both the matcher (§6.4 treats `/`,
 * `_`, `-`, `.` as segment starts) and the insert shape (§4: a workspace pick is a
 * relative path with forward slashes) assume `/`. On POSIX nothing is rewritten: a
 * backslash is a legal filename character there, so replacing it would corrupt a name.
 */
function toSlash(file: string): string {
  return process.platform === 'win32' ? file.replace(/\\/g, '/') : file;
}

/** Split a NUL-separated `rg --files --null` listing into relative paths, capped. */
function parseListing(chunks: Buffer[]): string[] {
  const text = Buffer.concat(chunks).toString('utf8');
  const paths: string[] = [];
  for (const raw of text.split('\0')) {
    if (!raw) {
      continue;
    }
    // `rg` may prefix with `./` depending on how the search path was given; the index
    // stores `src/a.ts`, never `./src/a.ts`, because that string is what gets inserted.
    paths.push(toSlash(raw).replace(/^\.\//, ''));
    if (paths.length >= INDEX_CAP) {
      break;
    }
  }
  return paths;
}

/**
 * Run one `rg --files` against the agent root and collect its listing.
 *
 * `null` means **this candidate could not answer** — it never spawned (ENOENT), or it
 * exited with ripgrep's `2` (a broken `--glob` from an exotic `search.exclude`, a
 * permission wall) — and the caller's job is then to try the next candidate, not to give
 * up on ripgrep. Exit code `1` is *not* a failure: `rg --files` exits 1 when it found no
 * file at all, which is a legitimate (empty) answer.
 *
 * Output is read incrementally and the child is killed the moment it has produced one path
 * past the cap: a monorepo with a million paths would otherwise be buffered whole just to
 * be sliced, and the slice is the only part that is ever used.
 *
 * `log` receives rg's own first stderr line when the candidate fails — a broken user glob
 * is otherwise indistinguishable in the channel from "ripgrep was not installed".
 */
function runRipgrep(command: string, root: string, log: (line: string) => void): Promise<IndexRun | null> {
  return new Promise<IndexRun | null>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, rgArgs(), {
        cwd: root,
        // Windows: no console window may flash for a keystroke in the composer, and no
        // shell may interpret the globs — this argv is already fully built.
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve(null);
      return;
    }

    const chunks: Buffer[] = [];
    let entries = 0;
    let truncated = false;
    let settled = false;
    let stderr = '';

    const finish = (run: IndexRun | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (!run && stderr.trim()) {
        // rg's own words about a broken `--glob` (an exotic `search.exclude`) are the one
        // thing that says *why* the index had to degrade, so they get a diagnostic line.
        log(`[mention] rg said: ${stderr.split(/\r?\n/).find((line) => line.trim()) ?? stderr.trim()}`);
      }
      resolve(run);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      // A NUL byte is one complete path (`--null`), so counting them counts the listing
      // without decoding anything yet.
      for (let i = 0; i < chunk.length; i += 1) {
        if (chunk[i] !== 0) {
          continue;
        }
        entries += 1;
        if (entries > INDEX_CAP) {
          truncated = true;
          try {
            child.kill();
          } catch {
            // Already gone; the listing we have is still the answer.
          }
          finish({ paths: parseListing(chunks), truncated });
          return;
        }
      }
    });
    // stderr is drained as it arrives, not read at the end: an unread pipe fills up and
    // eventually stalls the child, which on a big tree looks exactly like a slow index.
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 512) {
        stderr += chunk.toString('utf8');
      }
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      finish(code === 0 || code === 1 ? { paths: parseListing(chunks), truncated } : null);
    });
  });
}

/**
 * The shortest honest form of an OS failure: the error `code` (`ENOENT`, `EACCES`,
 * `ENOTDIR`) when there is one. Node's full message repeats the path and the syscall,
 * which the note row already shows in its own words.
 */
function reasonText(err: unknown): string {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code) {
      return code;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Byte order, not `localeCompare`: a listing and the index must come back in the same
 * order on every machine, and a locale collation is not stable across them (nor across
 * two windows of the same machine at different display languages).
 */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A path relative to the agent root with forward slashes — the one insert shape for a
 * workspace file (§4) — or `null` when the path is not under the root.
 *
 * Used twice on purpose: the index stores its paths this way, and {@link MentionIndex.browse}
 * normalises the dialog's answer with it. The runtime hands this same function to
 * `pickAttachment` as its `insideRoot` normaliser, so a file reached by typing `@`, by
 * accepting a row, or through the attach dialog inserts the identical string.
 */
export function workspaceRelativePath(abs: string): string | null {
  return relativeInside(getAgentRoot(), abs);
}

/** {@link workspaceRelativePath} for an explicit root (the index resolves its own once). */
function relativeInside(root: string, abs: string): string | null {
  let rel: string;
  try {
    rel = path.relative(root, abs);
  } catch {
    return null;
  }
  // `''` is the root itself (never a file), `..` climbs out, and an absolute result is
  // what win32 returns for a path on another drive — all three are "outside the root".
  if (!rel || path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) {
    return null;
  }
  return rel.split(path.sep).join('/');
}

/**
 * The separator the query was typed with, so the path the menu inserts reads the way the
 * user writes paths — `/d/repos/x/` grows `/a.ts` and `D:\repos\x\` grows `\a.ts`.
 *
 * A query with no separator at all (`~`, `C:`) gets the native one, which is the only
 * separator the expanded home or drive root can be joined with without inventing a mixed
 * path.
 */
function typedSeparator(typed: string): string {
  for (let i = typed.length - 1; i >= 0; i -= 1) {
    const ch = typed[i];
    if (ch === '/' || ch === '\\') {
      return ch;
    }
  }
  return path.sep;
}

/** Rewrite every separator of a resolved path as the one the user typed. */
function withSeparator(resolved: string, separator: string): string {
  return separator === path.sep ? resolved : resolved.replace(/[\\/]/g, separator);
}

/** `base` + `name`, joined with the typed separator and never doubled at a drive root. */
function joinEntry(base: string, name: string, separator: string): string {
  const head = withSeparator(base, separator).replace(/[\\/]+$/, '');
  return head + separator + name;
}

/**
 * Where a typed path points. `~` is the OS home and nothing else is expanded, because a
 * shell-style variable (`$HOME`) in a path is a *command* concept — the menu matches the
 * fragment but never expands a variable, so a user who wants one can type the real path.
 */
function resolveTypedPath(typed: string): string {
  if (!typed) {
    // The empty query of a no-folder window: the scratch root, which is where relative
    // paths go in that mode (`docs/agents/no-repo-mode.md`).
    return getAgentRoot();
  }
  if (typed === '~') {
    return os.homedir();
  }
  if (/^~[\\/]/.test(typed)) {
    return path.join(os.homedir(), typed.slice(2));
  }
  // `resolvePath` is the one seam that maps `/d/repos/x` onto `D:\repos\x` and resolves a
  // relative path (`./`, `../`, `.`) against the agent root — so the path the menu walks
  // is the path the agent would read.
  return resolvePath(typed);
}

/**
 * One dim row the menu shows in place of matches: a reason, or the truncation marker. It
 * inserts nothing (accepting it must be a no-op for the webview), so nothing it says can
 * reach the composer or the model.
 */
function noteRow(text: string): MentionItem {
  return { kind: 'note', label: text, insert: '' };
}


/**
 * Directories first, then files, each in name order: `readdir` returns whatever order the
 * filesystem keeps, which on ext4 is not alphabetical and on a network drive is not stable
 * between two calls.
 */
function compareEntry(a: fs.Dirent, b: fs.Dirent): number {
  const aDir = a.isDirectory();
  const bDir = b.isDirectory();
  if (aDir !== bDir) {
    return aDir ? -1 : 1;
  }
  return compareText(a.name, b.name);
}

/**
 * The host-side file index and the two dialogs the `@` picker needs.
 *
 * One instance belongs to one chat surface; `dispose()` drops its workspace listeners.
 */
export class MentionIndex {
  private readonly output: vscode.OutputChannel;

  /** The cached index (`paths` in insert shape), or `null` when there is nothing to serve. */
  private paths: string[] | null = null;
  private truncated = false;
  /** Which source built {@link paths} — reported to the footer so a degraded list says so. */
  private source: 'rg' | 'findFiles' = 'rg';
  /** Set by an invalidation; cleared by the build that observed the matching generation. */
  private dirty = true;
  /**
   * Bumped on every invalidation. A build compares it before clearing `dirty`, so a file
   * created *while* the child was walking does not get silently marked as already listed —
   * which in this repository is the normal case, not a corner one.
   */
  private generation = 0;
  /**
   * The build in flight. Typing `@a`, `@ab`, `@abc` is three queries within a few hundred
   * milliseconds; they must share one `rg --files`, not spawn three.
   */
  private building: Promise<void> | null = null;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(output: vscode.OutputChannel) {
    this.output = output;
    // The index is **invalidated, never watched**: VS Code already emits these four
    // events for its own explorer, and a rebuild is one `rg --files` on the next
    // keystroke — cheaper than keeping a watcher alive over a tree this size, and unable
    // to drift out of sync with the same filesystem events VS Code itself trusts.
    const onWorkspaceChange = (): void => this.invalidate();
    this.subscriptions.push(
      vscode.workspace.onDidCreateFiles(onWorkspaceChange),
      vscode.workspace.onDidDeleteFiles(onWorkspaceChange),
      vscode.workspace.onDidRenameFiles(onWorkspaceChange),
      vscode.workspace.onDidChangeWorkspaceFolders(onWorkspaceChange),
    );
  }

  /** Forget the cached file list; the next query rebuilds it. */
  invalidate(): void {
    this.generation += 1;
    this.paths = null;
    this.dirty = true;
  }

  /**
   * Which source the last build used, and whether a folder is open. Before the first
   * query `source` names the intended one (`rg`), which is why the footer must not treat a
   * pre-build answer as a measurement: `hasFolder === false` is the fact the composer's
   * no-folder line is built from.
   */
  info(): { hasFolder: boolean; source: 'rg' | 'findFiles' } {
    return { hasFolder: hasWorkspaceFolder(), source: this.source };
  }

  /**
   * Answer one composer query. Never throws: a broken index answers with one `note` row,
   * because a picker that cannot answer must still be a picker the user can type in.
   */
  async query(query: string, recent: string[]): Promise<MentionAnswer> {
    let scope: MentionScope = 'workspace';
    try {
      // The classifier is the host's single reading of §4's table: it answers which scope
      // the raw text is in and hands the text back untouched, so the `~` expansion and the
      // Git-Bash drive mapping have exactly one implementation (below, and in `resolvePath`).
      const classified = classifyMentionQuery(query);
      scope = classified.scope;
      if (scope === 'absolute') {
        return await this.answerPath(classified.path, 'absolute');
      }
      if (SEPARATOR.test(query)) {
        // A directory prefix is a PLACE, not a name (§3.2): `src/chat/` lists that directory, and
        // every row it offers inserts a **workspace-relative** path, so `Tab` walks a long path one
        // segment at a time. A query with no separator is a file-name search over the index, and it
        // never comes here.
        return await this.answerPath(query, 'workspace');
      }
      if (!hasWorkspaceFolder()) {
        // No folder is open, so there is nothing to index: the menu is a listing of the
        // scratch root, and the caller's own footer line says why. No note of our own —
        // one sentence in the footer is the contract (§7), and this is the caller's.
        return await this.answerPath('', 'workspace');
      }
      return await this.answerWorkspace(query, recent);
    } catch (err) {
      this.output.appendLine(`[mention] query failed: ${reasonText(err)}`);
      return { scope, items: [noteRow(vscode.l10n.t('The file index is unavailable: {0}', reasonText(err)))] };
    }
  }

  /**
   * The `Browse…` row: open the dialog and return the chosen path, or `null` when
   * cancelled. The answer is in the same shape a menu pick inserts (§4), so the webview
   * can hand it to the same insertion function.
   */
  async browse(): Promise<string | null> {
    let picked: vscode.Uri[] | undefined;
    try {
      picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        // No `filters`: this row exists for the file the index cannot find — a path
        // outside the workspace, a name `.gitignore` hides — so a filter would defeat it.
        openLabel: vscode.l10n.t('Attach'),
      });
    } catch (err) {
      this.output.appendLine(`[mention] browse failed: ${reasonText(err)}`);
      return null;
    }
    if (!picked || picked.length === 0) {
      return null;
    }
    const abs = picked[0].fsPath;
    // Inside the agent root the dialog's answer becomes the workspace-relative path a
    // menu pick would insert; outside it stays the native absolute path, which is the only
    // spelling that can be read back.
    return workspaceRelativePath(abs) ?? abs;
  }

  /** Drop the workspace listeners. The caller owns this instance's lifetime. */
  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
  }

  /** Rebuild the index if it is stale, sharing one build between queries that overlap. */
  private async ensureIndex(): Promise<void> {
    while (this.dirty) {
      if (!this.building) {
        this.building = this.build().finally(() => {
          this.building = null;
        });
      }
      // A failed build rethrows here and leaves `dirty` set, so the *next* query retries
      // instead of the index being permanently dead. A build that finished while a newer
      // invalidation arrived loops once more.
      await this.building;
    }
  }

  /** One build, one `rg --files`, one fallback path. Never called twice at once. */
  private async build(): Promise<void> {
    const generation = this.generation;
    const root = getAgentRoot();
    const startedAt = Date.now();
    const run = await this.indexWithRipgrep(root);
    if (run) {
      this.paths = run.paths.sort(compareText);
      this.truncated = run.truncated;
      this.source = 'rg';
    } else {
      // §7's degraded path: the same one `search_files` takes when its binary is gone.
      // It honours `files.exclude` / `search.exclude` but not `.gitignore`, which is why
      // the footer names the source.
      const found = await this.indexWithFindFiles(root);
      this.paths = found.paths.sort(compareText);
      this.truncated = found.truncated;
      this.source = 'findFiles';
    }
    this.dirty = this.generation !== generation;
    this.output.appendLine(
      `[mention] index ${this.paths.length} files via ${this.source} in ${Date.now() - startedAt} ms` +
        (this.truncated ? ' (capped)' : ''),
    );
  }

  /** Probe the ripgrep candidates in order; `null` once every one of them has failed. */
  private async indexWithRipgrep(root: string): Promise<IndexRun | null> {
    for (const candidate of ripgrepCandidates()) {
      if (candidate !== RG_BIN) {
        try {
          if (!fs.existsSync(candidate)) {
            continue;
          }
        } catch {
          continue;
        }
      }
      const run = await runRipgrep(candidate, root, (line) => this.output.appendLine(line));
      if (run) {
        // Logged once per build, not per query: which ripgrep answered decides whether the
        // vendored copy or the host's is in play, and a session that silently degraded
        // would otherwise look identical in the channel.
        this.output.appendLine(`[mention] index rg=${candidate}`);
        return run;
      }
      this.output.appendLine(`[mention] index rg=${candidate} cannot run — trying the next candidate`);
    }
    return null;
  }

  /** The fallback index: VS Code's own file search, capped and root-relative. */
  private async indexWithFindFiles(root: string): Promise<IndexRun> {
    // One past the cap, so "there are more" is a measurement rather than a guess.
    const uris = await vscode.workspace.findFiles('**/*', undefined, INDEX_CAP + 1);
    const paths: string[] = [];
    for (const uri of uris) {
      const rel = relativeInside(root, uri.fsPath);
      // A multi-root workspace searches every folder; the index belongs to the agent root
      // alone, so anything outside it is dropped instead of being given a `../` path.
      if (rel) {
        paths.push(rel);
      }
      if (paths.length >= INDEX_CAP) {
        break;
      }
    }
    return { paths, truncated: uris.length > INDEX_CAP };
  }

  /** Workspace scope: rank the cached index, or list this session's recent picks. */
  private async answerWorkspace(query: string, recent: string[]): Promise<MentionAnswer> {
    await this.ensureIndex();
    const paths = this.paths ?? [];
    const items = query
      ? rankMentions(query, paths, { limit: ROW_LIMIT, pinyin, max: paths.length })
      : // An empty query is the "what did I just look at" list (§5): this session's picks
        // first, then the index in path order, so the menu is never an empty box.
        recentMentions(recent, paths, ROW_LIMIT);
    const answer: MentionAnswer = { scope: 'workspace', items };
    if (this.truncated) {
      // Truncation wins over the source: a partial list is the fact the user has to know
      // before they conclude a file is absent, whereas the source only explains *why* the
      // exclusions may differ. One sentence is the contract, so one of the two is shown.
      answer.note = vscode.l10n.t('Only the first {0} files are listed.', String(INDEX_CAP));
      answer.truncated = true;
    } else if (this.source === 'findFiles') {
      answer.note = vscode.l10n.t('The list falls back to the editor search, which does not honour .gitignore.');
    }
    return answer;
  }

  /**
   * A path query: match the name fragment being typed against the entries of the directory that
   * fragment sits in (§3.2, §4).
   *
   * The directory is the text before the last separator, read with one `readdir`; a trailing
   * separator (an empty fragment) means "show me this directory", which is the step a `Tab` walks
   * down. `scope` decides only how a row is NAMED: an `absolute` query inserts the machine path, a
   * `workspace` one inserts a workspace-relative path, so a drilled reference comes out exactly
   * like a picked one.
   *
   * **The scope is the typing path and nothing else.** A fragment with no hit answers with no rows
   * at all: there is no fall back to the workspace index or to any other directory, because a
   * candidate the user did not point at is a candidate they then have to disbelieve.
   *
   * `readdir` is per query rather than cached: a listing is one syscall on a directory the user is
   * already looking at, and a cached one would show a file the agent just wrote as absent.
   */
  private async answerPath(typed: string, scope: MentionScope): Promise<MentionAnswer> {
    const separator = typedSeparator(typed);
    const { dir, fragment } = splitTypedPath(typed);
    const named = resolveTypedPath(dir);

    // The longest existing ancestor: `~/proj/sub/di` while `sub` is still being typed is not
    // a failure, it is `~/proj` with the fragment `sub`. Climbing stops at the first readable
    // ancestor, so the rows stay about the path that is in the box and a half-typed segment
    // stops being the normal state of `ENOENT`.
    let target = named;
    let rest = fragment;
    let entries: fs.Dirent[] | null = null;
    for (;;) {
      try {
        entries = await fs.promises.readdir(target, { withFileTypes: true });
        break;
      } catch (err) {
        const up = path.dirname(target);
        if (up === target) {
          return {
            scope: 'absolute',
            items: [noteRow(vscode.l10n.t('Cannot list {0}: {1}', named, reasonText(err)))],
          };
        }
        const segment = path.basename(target);
        rest = rest ? segment + path.sep + rest : segment;
        target = up;
      }
    }

    const match = firstSegment(rest);
    const ordered = entries.slice().sort(compareEntry);
    // How a row names its entry: an absolute query gets the machine path, a workspace one the
    // relative path the index itself is built from. `base` is the same decision for the dimmed
    // column, and it comes from the RESOLVED directory so a climbed ancestor still shows right.
    const base =
      scope === 'absolute'
        ? withSeparator(target, separator)
        : relativeInside(getAgentRoot(), target) ?? '';
    const insertFor = (name: string): string =>
      scope === 'absolute' ? joinEntry(target, name, separator) : base ? joinEntry(base, name, '/') : name;

    if (!match) {
      const items: MentionItem[] = [];
      for (const entry of ordered.slice(0, DIR_CAP)) {
        items.push(await this.entryRow(entry, target, base, insertFor));
      }
      if (ordered.length > DIR_CAP) {
        // The glyph is a marker, not prose, so it is deliberately untranslated (`i18n.md`).
        items.push(noteRow('…'));
      }
      return { scope, items };
    }

    // One row per matching entry, ranked by the workspace engine over the entry NAMES: the
    // directory is already fixed by what the user typed, so the only thing left to match is
    // the name, and reusing `rankMentions` is what makes `rt`, `*.cs`, `src/[` and `cundang`
    // mean in this directory exactly what they mean over the workspace.
    const ranked = rankMentions(
      match,
      ordered.map((entry) => entry.name),
      { limit: ROW_LIMIT, pinyin, max: RANK_SCAN_CAP },
    );
    const byName = new Map<string, fs.Dirent>();
    for (const entry of ordered) {
      byName.set(entry.name, entry);
    }
    const items: MentionItem[] = [];
    for (const row of ranked) {
      // A row's `insert` is the path it was ranked as, which for a bare name is the name.
      const entry = byName.get(row.insert) ?? byName.get(row.label);
      if (!entry) {
        continue;
      }
      const item = await this.entryRow(entry, target, base, insertFor);
      if (row.matches && row.matches.length) {
        // The indices already address the label: the label is the entry name (plus the
        // directory's trailing `/`, which only ever sits past the last index).
        item.matches = row.matches;
      }
      items.push(item);
    }
    if (!items.length) {
      // No hit is no row (§4): a path query never widens its scope, so an empty answer is the
      // honest one, and the webview closes the menu on it (§3).
      return { scope, items: [] };
    }
    if (ordered.length > RANK_SCAN_CAP) {
      items.push(noteRow('…'));
    }
    return { scope, items };
  }

  /**
   * One directory entry as a row: the entry NAME is the label, not the whole path, because an
   * absolute path in a 560 px menu pushes the basename (the only part that differs between rows)
   * off its right edge. Directories keep a trailing `/` so a listing reads like a listing (§5) and
   * so a `Tab` on one visibly grows the path being walked; the *insert* is the entry's path in the
   * query's own scope (`insertFor`).
   */
  private async entryRow(
    entry: fs.Dirent,
    target: string,
    base: string,
    insertFor: (name: string) => string,
  ): Promise<MentionItem> {
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      // A `Dirent` never follows a link, and a symlinked directory (a pnpm store, a workspace
      // shim) has to keep its `/` or the row is indistinguishable from a file. Only a shown
      // entry is stat'ed, so this stays one syscall per visible symlink.
      try {
        isDir = (await fs.promises.stat(path.join(target, entry.name))).isDirectory();
      } catch {
        // A dangling link is a file row; accepting it is what produces the reason.
        isDir = false;
      }
    }
    return {
      kind: isDir ? 'dir' : 'file',
      label: isDir ? `${entry.name}/` : entry.name,
      detail: base,
      insert: insertFor(entry.name),
    };
  }
}
