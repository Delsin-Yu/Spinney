/**
 * agentsMd.ts — the two AGENTS.md instruction files, **read at use**.
 *
 * The instructions are prompt bytes: `{{agentsMd}}` in `src/agent/prompt.ts`, rendered
 * into the envelope a chain freezes (`SessionRuntime.freezeEpoch`) and hashed into
 * `Epoch.agentsMdHash`, which the drift check compares (`setupState`). Both halves
 * therefore need the *current* bytes, and there are two ways to be wrong about that:
 *
 *  - a snapshot taken once when the extension host started misses every edit made while
 *    VS Code was closed — the common case, since a user edits AGENTS.md in another
 *    window or in an editor that has just quit;
 *  - re-reading and re-rendering on every check would be a synchronous disk read on a
 *    path that runs on every `postConfig`.
 *
 * So the reader below is **mtime-cached**: one `statSync` per file per use, and a
 * full `readFileSync` only when the file's modification time or size moved. An edit is
 * seen by the next `setupState()` / `freezeEpoch()`, which is exactly what "read at
 * use" has to mean — and, because a frozen epoch is never re-rendered, seeing it there
 * never rewrites a prefix that is already in the provider's cache; it only makes the
 * composer's drift mark appear so the user can start a new epoch.
 *
 * The once-per-window snapshots (`Agent.setAgentsMd` / `setGlobalAgentsMd`, kept for
 * `ChatViewProvider.loadAgentsMd`) are now only a **fallback**: a file that cannot be
 * read for a reason other than "it is not there" (permissions, a directory, a device
 * that went away) falls back to what the window last managed to read, so a transient
 * failure cannot silently drop the instructions from the prompt.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentsMdSources, currentAgentsMdSources } from '../agent/prompt';
import { getWorkspaceRoot } from '../tools';

/** One file's cached state: what was read, and the identity that read it. */
interface CachedFile {
  mtimeMs: number;
  size: number;
  /** The file's content, or null when it is not there. */
  text: string | null;
}

/** Per-path cache. A path is stable within a window; a workspace change adds one. */
const cache = new Map<string, CachedFile>();

/**
 * Where the systemwide AGENTS.md lives: `~/.spinney/AGENTS.md`.
 *
 * The home directory is the point of it — the file has to outlive a profile switch, an
 * extension rename and a change of workspace, and global storage does none of that (its
 * folder is named after the extension id and it moves with the profile). `storageDir` is
 * the fallback only when a host reports no home directory. An empty string means there is
 * nowhere to put the file.
 */
export function globalAgentsMdPath(storageDir: string): string {
  let home = '';
  try {
    home = os.homedir();
  } catch {
    home = '';
  }
  if (home) {
    return path.join(home, '.spinney', 'AGENTS.md');
  }
  return storageDir ? path.join(storageDir, 'AGENTS.md') : '';
}

/** The workspace root's own `AGENTS.md`, or `undefined` when no folder is open. */
export function workspaceAgentsMdPath(): string | undefined {
  try {
    return path.join(getWorkspaceRoot(), 'AGENTS.md');
  } catch {
    return undefined;
  }
}

/**
 * Read one file through the cache. `undefined` means "there is no path to read", which
 * is the caller's cue to use its fallback; `null` means "the file is not there", which is
 * a real answer and never falls back (a deleted AGENTS.md must leave the prompt, not
 * linger as a stale snapshot).
 */
function readCached(file: string | undefined): { value: string | null } | undefined {
  if (!file) {
    return undefined;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // Gone is an answer; anything else is a failure the fallback covers.
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      cache.set(file, { mtimeMs: 0, size: 0, text: null });
      return { value: null };
    }
    return undefined;
  }
  const known = cache.get(file);
  if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) {
    return { value: known.text };
  }
  try {
    const text = fs.readFileSync(file, 'utf8');
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, text });
    return { value: text };
  } catch {
    // A file that exists but cannot be read: keep whatever the last successful read was
    // (or the window's snapshot below) rather than dropping the instructions.
    return undefined;
  }
}

/**
 * The instruction files **as they are on disk right now**, falling back to the window's
 * snapshot per half when a path is unknown or a read fails. This is the one reader the
 * freeze path and the drift check share, so a rendered prompt and the hash that guards it
 * can never disagree about which bytes are in force.
 */
export function liveAgentsMdSources(storageDir: string): AgentsMdSources {
  const snapshot = currentAgentsMdSources();
  const globalRead = readCached(globalAgentsMdPath(storageDir));
  const workspaceRead = readCached(workspaceAgentsMdPath());
  return {
    global: globalRead ? globalRead.value : snapshot.global,
    workspace: workspaceRead ? workspaceRead.value : snapshot.workspace,
  };
}

/** Drop the cache (a workspace-folder change, or a test that writes a fixture). */
export function resetAgentsMdCache(): void {
  cache.clear();
}
