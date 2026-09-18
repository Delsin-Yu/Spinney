/**
 * The session store: session **content** as plain files, not as one Memento row.
 *
 * Why this exists (`invariants/session-persistence.md`):
 *
 *  - VS Code keeps an extension's whole `workspaceState` as **one** row, so every write
 *    re-serialized and rewrote all of it — measured at 17.2 M chars / multi-second
 *    `persist-done` on a real profile, and `persist-queued` 100–250 ms of *blocking* host
 *    work on every burst.
 *  - That row is keyed by the extension id: a rename made the data invisible (not
 *    deleted — undiscoverable) and the first activation under the new id wrote an empty
 *    row over it. That is a real incident this design has to make impossible.
 *
 * So the content lives in files under a **fixed, id-independent** root, with three rules
 * that carry the weight:
 *
 *  1. **The index is a cache.** `<key>/index.json` exists to make the sidebar cheap, and
 *     `rebuildIndex()` reconstructs it from the files alone. Nothing that can be lost
 *     orphans the content.
 *  2. **A write is atomic and keeps one generation.** `tmp` → the old file renamed to
 *     `.bak` → the tmp renamed over it: every step is a rename, so at least one complete
 *     version is on disk at all times, and a `.tmp`-only leftover is ignored on read.
 *  3. **A deletion moves to `.trash`, it never unlinks.** This is the same rule the v1
 *     state backup follows ("move the data, never discard it").
 *
 * The module is deliberately **vscode-free**: the caller passes the global-storage path
 * and the workspace identity, which keeps the whole thing testable in a plain node script
 * (`tools/session-store-acceptance.js`) and keeps the storage decisions in one file.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { WriteResult, cancelWrites, flushWrites, hasPendingWrite, isUnder, queueWrite } from './fileWriteQueue';

/** The store's own file-format version (independent of the extension's version). */
export const STORE_VERSION = 2;
/** The producer string a manifest must carry for a folder to be recognized as ours. */
export const STORE_PRODUCER = 'spinney';
const MANIFEST_FILE = 'manifest.json';
const INDEX_FILE = 'index.json';
const SESSIONS_DIR = 'sessions';
const LOCKS_DIR = 'locks';
const TRASH_DIR = '.trash';
/** One folder per session: its header here, one file per node under {@link NODES_DIR}. */
const HEADER_FILE = 'session.json';
const NODES_DIR = 'nodes';
/** The v1 layout: one whole session per file (`<id>.json`), kept for the migration. */
const LEGACY_SUFFIX = '.json';
/** A session file this large is not ours; refuse to read it rather than load a blob. */
const MAX_SESSION_BYTES = 256 * 1024 * 1024;
/** A lock whose heartbeat is older than this belongs to a dead window. */
export const LOCK_STALE_MS = 45_000;

export interface StoreManifest {
  producer: string;
  dataVersion: number;
  writtenAt: number;
}

/** The cheap, sidebar-sized view of one session — what `index.json` holds. */
export interface SessionSummary {
  id: string;
  title: string;
  titleSource?: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
  activeNodeId: string;
  model?: string;
  effort?: string;
}

/**
 * The v2 session header: everything about a session **except** its nodes, which live in
 * their own files. Small on purpose — it is rewritten on every change, so it must never
 * grow with the conversation.
 */
interface SessionHeaderFile {
  version: number;
  kind: 'session';
  sessionId: string;
  updatedAt: number;
  summary: SessionSummary;
  nodeIds: string[];
  session: unknown;
}

/** One node's file: the v2 unit of change. */
interface NodeFile {
  version: number;
  kind: 'node';
  sessionId: string;
  nodeId: string;
  updatedAt: number;
  node: unknown;
}

/** The v1 envelope, one whole session per file — read by the migration, never written. */
interface LegacySessionFile {
  version: number;
  kind: 'session';
  sessionId: string;
  updatedAt: number;
  summary: SessionSummary;
  session: unknown;
}

interface IndexFile {
  version: number;
  key: string;
  writtenAt: number;
  sessions: SessionSummary[];
}

export interface LockInfo {
  owner: string;
  pid: number;
  heartbeat: number;
  startedAt: number;
}

export interface LockResult {
  acquired: boolean;
  /** True when a stale lock was replaced (`acquired` is then also true). */
  tookOver: boolean;
  holder?: LockInfo;
}

export interface StoreOptions {
  /** The writable root (`<globalStorage>/spinney`, or `spinney.dataDir`). */
  root: string;
  /**
   * The workspace identity this store holds sessions for — one subfolder per workspace,
   * which is what keeps today's "opening another folder shows other sessions" behaviour
   * while still being one root to back up. `no-workspace` mirrors the no-repo mode.
   */
  workspaceKey: string;
  /** Injectable clock, so the acceptance script can age a heartbeat. */
  now?: () => number;
  /** Where a skipped/corrupt file is reported (the output channel, in practice). */
  onLog?: (line: string) => void;
}

/**
 * The default root: a **fixed** folder name under global storage, deliberately not
 * derived from `publisher.name` — a rename must not move the user's data. `override`
 * (the future `spinney.dataDir` setting) wins.
 */
export function defaultDataRoot(globalStorageFsPath: string, override?: string): string {
  const trimmed = (override ?? '').trim();
  return trimmed ? path.resolve(trimmed) : path.join(globalStorageFsPath, STORE_PRODUCER);
}

/**
 * A stable per-workspace key: a digest of the workspace folder's uri, or `no-workspace`.
 * A digest (not the path) keeps the layout filesystem-safe and case-stable.
 */
export function workspaceKeyFor(workspaceUri: string | null | undefined): string {
  const uri = (workspaceUri ?? '').trim();
  if (!uri) {
    return 'no-workspace';
  }
  return crypto.createHash('sha1').update(uri).digest('hex').slice(0, 16);
}

/** Does this folder look like a store root we wrote (manifest, or a `sessions/` tree)? */
export function looksLikeStoreRoot(dir: string): boolean {
  try {
    if (fs.statSync(path.join(dir, MANIFEST_FILE)).isFile()) {
      return true;
    }
  } catch {
    /* no manifest */
  }
  try {
    return fs.statSync(path.join(dir, SESSIONS_DIR)).isDirectory();
  } catch {
    return false;
  }
}

export class SessionStore {
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private indexCache: SessionSummary[] | null = null;
  /** The v1→v2 layout migration runs at most once per store instance. */
  private migrating = false;

  constructor(private readonly opts: StoreOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.onLog ?? (() => undefined);
  }

  get root(): string {
    return this.opts.root;
  }

  get key(): string {
    return this.opts.workspaceKey;
  }

  get sessionsDir(): string {
    return path.join(this.opts.root, SESSIONS_DIR, this.opts.workspaceKey);
  }

  get indexFile(): string {
    return path.join(this.sessionsDir, INDEX_FILE);
  }

  get lockFile(): string {
    return path.join(this.opts.root, LOCKS_DIR, `${this.opts.workspaceKey}.lock`);
  }

  get trashDir(): string {
    return path.join(this.sessionsDir, TRASH_DIR);
  }

  /** The session's folder (`sessions/<key>/<id>/`) — the v2 layout. */
  sessionDir(id: string): string {
    return path.join(this.sessionsDir, id);
  }

  /** The session's header: everything about it except its nodes. */
  headerFile(id: string): string {
    return path.join(this.sessionDir(id), HEADER_FILE);
  }

  /** One node's own file. */
  nodeFile(id: string, nodeId: string): string {
    return path.join(this.sessionDir(id), NODES_DIR, `${nodeId}${LEGACY_SUFFIX}`);
  }

  /** The **v1** path (one whole session per file) — read by the migration, never written. */
  sessionFile(id: string): string {
    return path.join(this.sessionsDir, `${id}${LEGACY_SUFFIX}`);
  }

  /** Create the root and its manifest if they are not there yet. */
  async ensureRoot(): Promise<StoreManifest> {
    const existing = this.readManifestSync();
    if (existing) {
      if (existing.dataVersion < STORE_VERSION) {
        await this.migrateLegacyLayout();
      }
      return { ...existing, dataVersion: STORE_VERSION };
    }
    const manifest: StoreManifest = { producer: STORE_PRODUCER, dataVersion: STORE_VERSION, writtenAt: this.now() };
    await fs.promises.mkdir(this.sessionsDir, { recursive: true });
    await fs.promises.mkdir(path.dirname(this.lockFile), { recursive: true });
    // The manifest is small and read by discovery: write it synchronously so a caller can
    // rely on it being there the moment this resolves.
    fs.writeFileSync(path.join(this.opts.root, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return manifest;
  }

  private readManifestSync(): StoreManifest | null {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.opts.root, MANIFEST_FILE), 'utf8')) as StoreManifest;
      if (raw && raw.producer === STORE_PRODUCER && typeof raw.dataVersion === 'number') {
        return raw;
      }
      this.log(`[store] ${this.root}: manifest is not ours (producer=${String(raw?.producer)})`);
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Queue a session's content: its small header, and **only the nodes that changed**.
   *
   * This is the whole point of the v2 layout. A real session holds its entire API history,
   * so rewriting it on every turn end cost 17.5 MB of `JSON.stringify` and 17.5 MB of writes
   * per turn (measured: 91 ms of blocked host, 800 ms of writes) while 99% of it had not
   * moved. With one file per node, a turn end writes the turn's own node plus the header —
   * a fraction of a percent of the session.
   *
   * `dirtyNodes` is the caller's answer to "which nodes changed"; `null`/`undefined` means
   * **unknown, write every node**, which is what a write nobody could attribute gets (a
   * forgotten mark costs time, never content).
   */
  writeSession(id: string, session: unknown, summary: SessionSummary, dirtyNodes?: string[] | null): Promise<WriteResult[]> {
    const whole = (session ?? {}) as { nodes?: Record<string, unknown> };
    const nodes = whole.nodes && typeof whole.nodes === 'object' ? whole.nodes : {};
    const withoutNodes = { ...(whole as Record<string, unknown>) };
    delete withoutNodes.nodes;
    const nodeIds = Object.keys(nodes);
    const header: SessionHeaderFile = {
      version: STORE_VERSION,
      kind: 'session',
      sessionId: id,
      updatedAt: summary.updatedAt,
      summary,
      nodeIds,
      session: withoutNodes,
    };
    // Serialized here, on purpose: an unserializable session is a bug in the caller and
    // must throw where it happened, not inside a background drain — and a header is small.
    // The jobs this write queued: their promises are the caller's own attribution, so
    // `persist-written` counts exactly the bytes of *this* persist (a global counter was
    // stolen by whichever caller resolved first, and the activation-time layout migration
    // drowned every persist in its 19 MB).
    const jobs: Promise<WriteResult>[] = [
      queueWrite(this.sessionDir(id), this.headerFile(id), `${JSON.stringify(header)}\n`, { atomic: true }),
    ];
    const writeAll = !Array.isArray(dirtyNodes);
    const targets = writeAll ? nodeIds : nodeIds.filter((nodeId) => (dirtyNodes as string[]).includes(nodeId));
    for (const nodeId of targets) {
      const node: NodeFile = {
        version: STORE_VERSION,
        kind: 'node',
        sessionId: id,
        nodeId,
        updatedAt: typeof summary.updatedAt === 'number' ? summary.updatedAt : this.now(),
        node: nodes[nodeId],
      };
      // The **nodes** folder is the destination: the queue creates the directory it is
      // given, and handing it the session folder would leave `nodes/` missing (the write
      // would then fail inside the drain, which swallows it — a silent empty store, which
      // is exactly what the acceptance script caught).
      const nodesDir = path.join(this.sessionDir(id), NODES_DIR);
      jobs.push(queueWrite(nodesDir, this.nodeFile(id, nodeId), `${JSON.stringify(node)}\n`, { atomic: true }));
    }
    // A node the session no longer has must lose its file, or a deleted branch would come
    // back on the next load. Only the *folder* is listed, and only for a session this write
    // is about, so the cost is a handful of entries.
    let stale: string[] = [];
    try {
      stale = fs
        .readdirSync(path.join(this.sessionDir(id), NODES_DIR))
        .filter((name) => name.endsWith(LEGACY_SUFFIX))
        .map((name) => name.slice(0, -LEGACY_SUFFIX.length))
        .filter((nodeId) => !nodeIds.includes(nodeId));
    } catch {
      /* no node folder yet */
    }
    for (const nodeId of stale) {
      cancelWrites((candidate) => candidate === this.nodeFile(id, nodeId) || candidate === `${this.nodeFile(id, nodeId)}.tmp`, 'file');
      try {
        fs.rmSync(this.nodeFile(id, nodeId), { force: true });
      } catch {
        /* already gone */
      }
    }
    this.indexCache = null;
    return Promise.all(jobs);
  }

  /** Refresh the index cache from the in-memory summaries (a rebuild reads the files). */
  async writeIndex(summaries: SessionSummary[]): Promise<void> {
    const index: IndexFile = { version: STORE_VERSION, key: this.opts.workspaceKey, writtenAt: this.now(), sessions: summaries };
    queueWrite(this.sessionsDir, this.indexFile, `${JSON.stringify(index)}\n`);
    this.indexCache = summaries;
  }

  hasPending(id: string): boolean {
    // The header is written on every change to a session, so it answers "is a write for this
    // session still queued?" — a node write is always queued together with it.
    const file = this.headerFile(id);
    return hasPendingWrite(`${file}.tmp`) || hasPendingWrite(file);
  }

  /** Resolve when every queued write (session bodies, renames, the index) has settled. */
  async flush(): Promise<void> {
    await flushWrites();
  }

  /**
   * Read one session: its header, then each node file it names. A node that cannot be read
   * costs **that node** and is reported, never the session (its `.bak` is next to it).
   *
   * Async like the rest of the read API, but implemented over the synchronous twin: the
   * reads that matter — activation, and a rebuild after a lost index — are whole-profile
   * sweeps either way, and one code path is one place to get the format right.
   */
  async readSession(id: string): Promise<{ id: string; summary: SessionSummary; session: unknown; file: string } | null> {
    return this.readSessionSync(id);
  }

  /**
   * Read a **v1** session file (one whole session per file). Kept because two real cases need
   * it: the one-time layout migration, and adopting from a root an older build wrote.
   */
  readLegacySync(id: string): { id: string; summary: SessionSummary; session: unknown; file: string } | null {
    const file = this.sessionFile(id);
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_SESSION_BYTES) {
        this.log(`[store] ${path.basename(file)}: ${stat.size} bytes — refusing to load it`);
        return null;
      }
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as LegacySessionFile;
      if (!raw || raw.kind !== 'session' || typeof raw.version !== 'number' || raw.sessionId !== id || raw.version > STORE_VERSION) {
        this.log(`[store] ${path.basename(file)}: not a current session file — skipped`);
        return null;
      }
      return { id, summary: raw.summary, session: raw.session, file };
    } catch {
      return null;
    }
  }

  /**
   * Convert the v1 layout (one file per session) into the v2 one (a folder per session, one
   * file per node). Idempotent, and deliberately **not** on the read path: `readSessionSync`
   * falls back to a v1 file, so the migration is an optimization that a crash or a kill can
   * interrupt safely. The v1 file is **renamed** to `<id>.json.v1`, never deleted — the same
   * "move the data, never discard it" rule the rest of the store follows.
   */
  async migrateLegacyLayout(): Promise<number> {
    // The gate is "are there v1 files?", not the manifest: a manifest that says v2 while v1
    // files sit beside it (a half-finished migration, a hand-edited root) must still convert,
    // and a v2 root simply finds nothing to do.
    if (this.migrating) {
      return 0;
    }
    this.migrating = true;
    let converted = 0;
    try {
      let names: string[] = [];
      try {
        names = await fs.promises.readdir(this.sessionsDir);
      } catch {
        return 0;
      }
      for (const name of names) {
        if (!name.endsWith(LEGACY_SUFFIX) || name === INDEX_FILE) {
          continue;
        }
        const id = name.slice(0, -LEGACY_SUFFIX.length);
        const loaded = this.readLegacySync(id);
        if (!loaded) {
          continue;
        }
        // Write the v2 folder (all nodes), wait for it to land, and only then park the v1
        // file: the moment before the rename, the session exists in both layouts.
        this.writeSession(id, loaded.session, loaded.summary, null);
        await this.flush();
        try {
          await fs.promises.rename(this.sessionFile(id), `${this.sessionFile(id)}.v1`);
        } catch {
          /* the v1 file could not be parked: leave it, the v2 folder is authoritative */
        }
        converted++;
      }
      if (converted >= 0) {
        const manifest: StoreManifest = { producer: STORE_PRODUCER, dataVersion: STORE_VERSION, writtenAt: this.now() };
        fs.writeFileSync(path.join(this.opts.root, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        this.indexCache = null;
        this.log(`[store] session layout migrated to v2: ${converted} session folder(s); the v1 files are kept as *.json.v1`);
      }
      return converted;
    } finally {
      this.migrating = false;
    }
  }

  /** List every session id in this workspace's folder (files only, no content). */
  /**
   * Every session id in this workspace's folder: one per **v2 session folder**, plus the v1
   * files a not-yet-migrated root still holds (both read through `readSessionSync`).
   */
  async listIds(): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(this.sessionsDir, { withFileTypes: true });
      const ids = new Set<string>();
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && fs.existsSync(this.headerFile(entry.name))) {
          ids.add(entry.name);
        } else if (entry.isFile() && entry.name.endsWith(LEGACY_SUFFIX) && entry.name !== INDEX_FILE) {
          ids.add(entry.name.slice(0, -LEGACY_SUFFIX.length));
        }
      }
      return [...ids].sort();
    } catch {
      return [];
    }
  }

  /**
   * Rebuild the index from the files — the answer to "what if `index.json` is lost?".
   * A corrupt or unreadable session file is counted and skipped, never thrown: one bad
   * file must not cost the user the rest of their history.
   */
  async rebuildIndex(): Promise<{ sessions: SessionSummary[]; skipped: number }> {
    const sessions: SessionSummary[] = [];
    let skipped = 0;
    for (const id of await this.listIds()) {
      const loaded = await this.readSession(id);
      if (!loaded || !loaded.summary) {
        skipped++;
        continue;
      }
      sessions.push(loaded.summary);
    }
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    if (skipped > 0) {
      this.log(`[store] rebuilt the index with ${skipped} unreadable session file(s) skipped`);
    }
    await this.writeIndex(sessions);
    await this.flush();
    return { sessions, skipped };
  }

  /**
   * The sidebar's view: the index when it is there, a rebuild when it is not. A cached
   * answer is reused until a write invalidates it, so a burst of lookups is one read.
   */
  async listSessions(): Promise<SessionSummary[]> {
    if (this.indexCache) {
      return this.indexCache;
    }
    try {
      const index = JSON.parse(await fs.promises.readFile(this.indexFile, 'utf8')) as IndexFile;
      if (index && index.version === STORE_VERSION && Array.isArray(index.sessions)) {
        this.indexCache = index.sessions;
        return index.sessions;
      }
      this.log('[store] the index is not ours or is a newer version — rebuilding it');
    } catch {
      /* no index yet: it is a cache, so build it */
    }
    return (await this.rebuildIndex()).sessions;
  }

  /**
   * Delete a session by **moving it to `.trash/<ts>/`**. Nothing is unlinked: the same
   * rule the v1 state backup follows, and the only thing standing between a mis-click
   * and a lost conversation. A write still queued for it is cancelled first.
   */
  async deleteSession(id: string): Promise<boolean> {
    // A v2 session is a **folder**, so the whole folder moves to the trash — header, every
    // node file and their `.bak` generations with it. The v1 file (a root that has not been
    // migrated) moves too.
    const dir = this.sessionDir(id);
    const legacy = this.sessionFile(id);
    const cancelled = cancelWrites(
      (candidate) => isUnder(dir, candidate) || candidate === legacy || candidate === `${legacy}.tmp`,
      'dir',
    );
    const trash = path.join(this.trashDir, String(this.now()));
    await fs.promises.mkdir(trash, { recursive: true });
    let moved = false;
    try {
      await fs.promises.rename(dir, path.join(trash, id));
      moved = true;
    } catch {
      /* no folder: only a v1 file, or only queued writes */
    }
    for (const suffix of ['', '.bak', '.v1']) {
      try {
        await fs.promises.rename(`${legacy}${suffix}`, path.join(trash, `${id}.json${suffix}`));
        moved = true;
      } catch {
        /* nothing under that name */
      }
    }
    this.indexCache = null;
    if (!moved && cancelled === 0) {
      return false;
    }
    const remaining = (await this.listSessions()).filter((s) => s.id !== id);
    await this.writeIndex(remaining);
    await this.flush();
    return true;
  }

  /** Delete a whole workspace folder (a "clear everything" action): same trash rule. */
  async trashWorkspace(): Promise<number> {
    const ids = await this.listIds();
    cancelWrites((candidate) => isUnder(this.sessionsDir, candidate), 'dir');
    const dir = path.join(this.trashDir, String(this.now()));
    await fs.promises.mkdir(dir, { recursive: true });
    let moved = 0;
    for (const id of ids) {
      try {
        await fs.promises.rename(this.sessionDir(id), path.join(dir, id));
        moved++;
        continue;
      } catch {
        /* no v2 folder for this id */
      }
      try {
        await fs.promises.rename(this.sessionFile(id), path.join(dir, `${id}.json`));
        moved++;
      } catch {
        /* already gone */
      }
    }
    await fs.promises.rm(this.indexFile, { force: true });
    this.indexCache = null;
    return moved;
  }

  /**
   * Read every session **synchronously** — the activation path, where the caller must
   * have its sessions before it can render anything (exactly what `Memento.get` gave it).
   * The bodies are the same bytes the Memento row used to deserialize, but they are read
   * one file at a time and a corrupt one costs only itself. The *writes* are the
   * asynchronous half; a later step can make this lazy per session.
   */
  readAllSync(): { sessions: unknown[]; summaries: SessionSummary[]; skipped: number } {
    const summaries: SessionSummary[] = [];
    const sessions: unknown[] = [];
    let skipped = 0;
    let ids: string[] = [];
    try {
      const ids2 = new Set<string>();
      for (const entry of fs.readdirSync(this.sessionsDir, { withFileTypes: true })) {
        // v2: a folder per session. v1: `<id>.json` — read through the same reader, which
        // knows both, so a root that has not been migrated yet still loads.
        if (entry.isDirectory() && !entry.name.startsWith('.') && fs.existsSync(this.headerFile(entry.name))) {
          ids2.add(entry.name);
        } else if (entry.isFile() && entry.name.endsWith(LEGACY_SUFFIX) && entry.name !== INDEX_FILE) {
          ids2.add(entry.name.slice(0, -LEGACY_SUFFIX.length));
        }
      }
      ids = [...ids2].sort();
    } catch {
      return { sessions, summaries, skipped };
    }
    for (const id of ids) {
      const loaded = this.readSessionSync(id);
      if (!loaded) {
        skipped++;
        continue;
      }
      summaries.push(loaded.summary);
      sessions.push(loaded.session);
    }
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return { sessions, summaries, skipped };
  }

  /** Synchronous twin of {@link readSession} — see it for why there is only one reader. */
  readSessionSync(id: string): { id: string; summary: SessionSummary; session: unknown; file: string } | null {
    const dir = this.sessionDir(id);
    try {
      const header = JSON.parse(fs.readFileSync(this.headerFile(id), 'utf8')) as SessionHeaderFile;
      if (header && header.kind === 'session' && header.sessionId === id && header.version <= STORE_VERSION) {
        const nodes: Record<string, unknown> = {};
        for (const nodeId of Array.isArray(header.nodeIds) ? header.nodeIds : []) {
          try {
            const raw = JSON.parse(fs.readFileSync(this.nodeFile(id, nodeId), 'utf8')) as NodeFile;
            if (raw && raw.kind === 'node' && raw.nodeId === nodeId) {
              nodes[nodeId] = raw.node;
            } else {
              this.log(`[store] ${id}/${nodeId}: not a node file — the node is missing from this load`);
            }
          } catch (err) {
            this.log(
              `[store] ${id}/${nodeId}: ${err instanceof Error ? err.message : String(err)} — the node is missing from this load`,
            );
          }
        }
        return { id, summary: header.summary, session: { ...(header.session as Record<string, unknown>), nodes }, file: dir };
      }
      this.log(`[store] ${id}: header is not a current session header`);
    } catch {
      /* no v2 folder: fall through to the v1 file */
    }
    return this.readLegacySync(id);
  }

  /** Is this store usable at all? False when the root cannot be created/written. */
  ensureRootSync(): boolean {
    try {
      fs.mkdirSync(path.join(this.sessionsDir), { recursive: true });
      fs.mkdirSync(path.dirname(this.lockFile), { recursive: true });
      const manifest = this.readManifestSync();
      if (!manifest) {
        const fresh: StoreManifest = { producer: STORE_PRODUCER, dataVersion: STORE_VERSION, writtenAt: this.now() };
        fs.writeFileSync(path.join(this.opts.root, MANIFEST_FILE), `${JSON.stringify(fresh, null, 2)}\n`, 'utf8');
      } else if (manifest.dataVersion < STORE_VERSION) {
        // A root an older build wrote: convert the layout in the background. The reader
        // handles both layouts in the meantime, so a kill mid-migration loses nothing.
        void this.migrateLegacyLayout();
      }
      return true;
    } catch (err) {
      this.log(`[store] ${this.opts.root}: unusable (${err instanceof Error ? err.message : String(err)})`);
      return false;
    }
  }

  /** Park arbitrary bytes as a file in the root (`migrated-state-<date>.json`). */
  async parkFile(name: string, content: string): Promise<string | null> {
    try {
      const file = path.join(this.opts.root, name);
      await fs.promises.mkdir(this.opts.root, { recursive: true });
      await fs.promises.writeFile(file, content, 'utf8');
      return file;
    } catch (err) {
      this.log(`[store] could not park ${name}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Remove one session file from disk without trashing it (the migration's verification). */
  async rawRemove(id: string): Promise<void> {
    try {
      await fs.promises.rm(this.sessionFile(id), { force: true });
    } catch {
      /* nothing to remove */
    }
  }

  /** Read the index alone (small, cache-shaped). Used to compare against the files. */
  async readIndex(): Promise<SessionSummary[]> {
    try {
      const index = JSON.parse(await fs.promises.readFile(this.indexFile, 'utf8')) as IndexFile;
      return index && Array.isArray(index.sessions) ? index.sessions : [];
    } catch {
      return [];
    }
  }

  /** The index is a cache: invalidate it so the next read rebuilds from the files. */
  invalidateIndex(): void {
    this.indexCache = null;
  }

  // ---- the lock: one writer per workspace ------------------------------------

  /**
   * Take the workspace lock. A lock held by a **live** owner is refused (never two
   * writers on one workspace folder); one whose heartbeat is stale or whose pid is gone
   * is taken over, which is what keeps a killed window from bricking the store.
   */
  async acquireLock(owner: string): Promise<LockResult> {
    const held = await this.lockHolder();
    if (held && held.owner !== owner && this.isLive(held)) {
      return { acquired: false, tookOver: false, holder: held };
    }
    const tookOver = Boolean(held && held.owner !== owner);
    const info: LockInfo = { owner, pid: process.pid, heartbeat: this.now(), startedAt: this.now() };
    await fs.promises.mkdir(path.dirname(this.lockFile), { recursive: true });
    await fs.promises.writeFile(this.lockFile, `${JSON.stringify(info)}\n`, 'utf8');
    // Re-read: two windows racing a stale takeover must not both believe they won.
    const check = await this.lockHolder();
    if (!check || check.owner !== owner) {
      return { acquired: false, tookOver, holder: check ?? undefined };
    }
    return { acquired: true, tookOver };
  }

  /** Refresh our own lock. Returns false when someone else holds it now. */
  async heartbeat(owner: string): Promise<boolean> {
    const held = await this.lockHolder();
    if (!held || held.owner !== owner) {
      return false;
    }
    const info: LockInfo = { ...held, pid: process.pid, heartbeat: this.now() };
    try {
      await fs.promises.writeFile(this.lockFile, `${JSON.stringify(info)}\n`, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /** Release the lock, but only if it is ours. */
  async releaseLock(owner: string): Promise<void> {
    const held = await this.lockHolder();
    if (held && held.owner !== owner) {
      return;
    }
    try {
      await fs.promises.rm(this.lockFile, { force: true });
    } catch {
      /* already gone */
    }
  }

  /** The current holder, or null. Never throws. */
  async lockHolder(): Promise<LockInfo | null> {
    try {
      const raw = JSON.parse(await fs.promises.readFile(this.lockFile, 'utf8')) as LockInfo;
      if (raw && typeof raw.owner === 'string' && typeof raw.pid === 'number' && typeof raw.heartbeat === 'number') {
        return raw;
      }
    } catch {
      /* no lock, or a torn one: treat it as free */
    }
    return null;
  }

  /** Is the holder alive? A stale heartbeat or a pid that is gone says no. */
  private isLive(info: LockInfo): boolean {
    if (this.now() - info.heartbeat > LOCK_STALE_MS) {
      return false;
    }
    if (info.pid === process.pid) {
      return true;
    }
    try {
      process.kill(info.pid, 0);
      return true;
    } catch (err) {
      // EPERM means the process exists but is not ours; anything else means it is gone.
      return (err as NodeJS.ErrnoException)?.code === 'EPERM';
    }
  }

  // ---- discovery and adoption -------------------------------------------------

  /**
   * Which of these folders are stores we can read, newest first? The caller supplies the
   * candidates (the configured root, the profile's known legacy locations) — this module
   * knows nothing about Memento keys, which is what keeps it testable.
   */
  static async discover(candidates: string[]): Promise<string[]> {
    const found: { root: string; newest: number }[] = [];
    for (const candidate of candidates) {
      if (!candidate || !looksLikeStoreRoot(candidate)) {
        continue;
      }
      let newest = 0;
      try {
        const keys = await fs.promises.readdir(path.join(candidate, SESSIONS_DIR), { withFileTypes: true });
        for (const key of keys) {
          if (!key.isDirectory()) {
            continue;
          }
          const dir = path.join(candidate, SESSIONS_DIR, key.name);
          for (const file of await fs.promises.readdir(dir, { withFileTypes: true })) {
            if (!file.isFile() || !file.name.endsWith('.json') || file.name.endsWith('.bak')) {
              continue;
            }
            const stat = await fs.promises.stat(path.join(dir, file.name));
            newest = Math.max(newest, stat.mtimeMs);
          }
        }
      } catch {
        /* an empty or unreadable root is still a candidate, just an old one */
      }
      found.push({ root: candidate, newest });
    }
    return found.sort((a, b) => b.newest - a.newest).map((entry) => entry.root);
  }

  /**
   * Import another root's sessions into this one — how a rename or a moved profile
   * becomes a non-event. Existing ids are left alone (this is an adopt, not a merge), and
   * the source is never modified.
   */
  async adoptFrom(otherRoot: string): Promise<{ adopted: number; skipped: number }> {
    const other = new SessionStore({ ...this.opts, root: otherRoot, onLog: this.log });
    const mine = new Set(await this.listIds());
    let adopted = 0;
    let skipped = 0;
    for (const id of await other.listIds()) {
      if (mine.has(id)) {
        skipped++;
        continue;
      }
      const loaded = await other.readSession(id);
      if (!loaded) {
        skipped++;
        continue;
      }
      this.writeSession(id, loaded.session, loaded.summary);
      mine.add(id);
      adopted++;
    }
    if (adopted > 0) {
      await this.flush();
      this.indexCache = null;
      await this.rebuildIndex();
      this.log(`[store] adopted ${adopted} session(s) from ${otherRoot}`);
    }
    return { adopted, skipped };
  }
}
