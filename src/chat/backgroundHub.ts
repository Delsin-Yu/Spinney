/**
 * BackgroundHub — one per window. The hub owns every background terminal in the
 * window, keyed by (session, node): a job belongs to the node whose turn spawned
 * it, so it renders inside that node's card and never leaks into another branch
 * or session (see `docs/agents/multi-session.md` §2 / §4.1).
 *
 * Task ids are **session-local**: the hub mints them from a per-session counter,
 * so two nodes of one session never collide, and the same number may exist in
 * two different sessions — every lookup is session-scoped. A per-session
 * `id -> owner` index makes `lookup` able to find a task in its owning node's
 * registry.
 *
 * This is a pure module (no `vscode`): the coordinator wires its UI callbacks
 * through {@link BackgroundHub.setHooks}, and the tools reach the hub through a
 * {@link BackgroundAccess}. It is smoke-testable with a fake `CommandHandle`.
 */
import { BackgroundRegistry, BackgroundTask, CommandHandle } from '../tools/background';

/** The (session, node) a background terminal belongs to. */
export interface BackgroundOwner {
  sessionId: string;
  nodeId: string;
}

/** A task resolved together with the owner it belongs to. */
export interface BackgroundHit {
  owner: BackgroundOwner;
  task: BackgroundTask;
}

/**
 * UI callbacks the coordinator installs once per window (after `loadSessions`).
 * They are read at call time, so a lazily created registry still sees the hooks
 * that were set afterwards.
 */
export interface BackgroundHubHooks {
  /** A task of this owner was registered or changed state (repaint its dock). */
  onUpdated?: (owner: BackgroundOwner) => void;
  /** A task of this owner transitioned to finished (deliver the notice). */
  onFinish?: (owner: BackgroundOwner, task: BackgroundTask) => void;
}

/** What the tools get: the owner they register into + the hub they resolve ids in. */
export interface BackgroundAccess {
  /** The running turn's node, else the view-focus node; `null` = no owner. */
  currentOwner(): BackgroundOwner | null;
  hub: BackgroundHub;
}

/** Task order: ascending id (the mint order). */
function byId(a: BackgroundTask, b: BackgroundTask): number {
  return a.id - b.id;
}

export class BackgroundHub {
  /** sessionId -> (nodeId -> registry), in creation order (stable listing). */
  private readonly registries = new Map<string, Map<string, BackgroundRegistry>>();
  /** sessionId -> last minted id. Ids are unique within a session and never reused. */
  private readonly counters = new Map<string, number>();
  /** sessionId -> (id -> owning node), so a session-local id resolves to its node. */
  private readonly owners = new Map<string, Map<number, BackgroundOwner>>();
  private hooks: BackgroundHubHooks = {};

  /** Install/refresh the coordinator's UI callbacks (read at call time). */
  setHooks(hooks: BackgroundHubHooks): void {
    this.hooks = hooks;
  }

  /** The registry of one (session, node), created lazily and wired to the hooks. */
  registryFor(owner: BackgroundOwner): BackgroundRegistry {
    let byNode = this.registries.get(owner.sessionId);
    if (!byNode) {
      byNode = new Map();
      this.registries.set(owner.sessionId, byNode);
    }
    let registry = byNode.get(owner.nodeId);
    if (!registry) {
      registry = new BackgroundRegistry();
      // Read the hooks at call time: the coordinator installs them once, after
      // the lazily created registries may already exist.
      registry.setOnUpdated(() => this.hooks.onUpdated?.(owner));
      registry.setOnFinish((task) => this.hooks.onFinish?.(owner, task));
      byNode.set(owner.nodeId, registry);
    }
    return registry;
  }

  /**
   * Register a spawned command as a background terminal and return its
   * session-local id. The id is minted here (never in the registry) so it is
   * unique across every node of the session.
   */
  register(owner: BackgroundOwner, handle: CommandHandle, command: string, cwd: string, notifyAgent = true): number {
    const id = this.mintId(owner.sessionId);
    this.registryFor(owner).register(handle, command, cwd, notifyAgent, id);
    this.ownerIndex(owner.sessionId).set(id, owner);
    return id;
  }

  /** Resolve a session-local id to its owner + task; `undefined` when unknown. */
  lookup(sessionId: string, id: number): BackgroundHit | undefined {
    const owner = this.owners.get(sessionId)?.get(id);
    if (!owner) {
      return undefined;
    }
    const task = this.findRegistry(sessionId, owner.nodeId)?.get(id);
    if (!task) {
      return undefined;
    }
    return { owner, task };
  }

  /** Every task of one node, ordered by id. */
  listForNode(sessionId: string, nodeId: string): BackgroundTask[] {
    const registry = this.findRegistry(sessionId, nodeId);
    return registry ? registry.list().sort(byId) : [];
  }

  /**
   * Every task of a session, each tagged with its owning node. Order is stable:
   * registries in creation order, tasks by id.
   */
  listForSession(sessionId: string): BackgroundHit[] {
    const byNode = this.registries.get(sessionId);
    if (!byNode) {
      return [];
    }
    const out: BackgroundHit[] = [];
    for (const [nodeId, registry] of byNode) {
      const owner: BackgroundOwner = { sessionId, nodeId };
      for (const task of registry.list().sort(byId)) {
        out.push({ owner, task });
      }
    }
    return out;
  }

  /** How many jobs of one node are still running. */
  runningForNode(sessionId: string, nodeId: string): number {
    return this.findRegistry(sessionId, nodeId)?.runningCount() ?? 0;
  }

  /**
   * Kill one task by session-local id (a no-op when the id is unknown). The
   * registry it lives in is found through the owner index, so callers never need
   * to know which node owns the job.
   */
  kill(sessionId: string, id: number, opts?: { notifyAgent?: boolean }): BackgroundTask | undefined {
    const hit = this.lookup(sessionId, id);
    if (!hit) {
      return undefined;
    }
    return this.registryFor(hit.owner).kill(id, opts);
  }

  /** Wait for one task by session-local id; rejects when the id is unknown. */
  waitFor(sessionId: string, id: number, signal?: AbortSignal): Promise<BackgroundTask> {
    const hit = this.lookup(sessionId, id);
    if (!hit) {
      return Promise.reject(new Error(`No background terminal with id ${id}.`));
    }
    return this.registryFor(hit.owner).waitFor(id, signal);
  }

  /**
   * Drop a node's jobs and its registry. With `kill` the running process trees
   * are torn down first; without it they are only forgotten. The session's id
   * counter is kept (a session never reuses an id).
   */
  removeNode(sessionId: string, nodeId: string, opts?: { kill?: boolean }): void {
    const byNode = this.registries.get(sessionId);
    const registry = byNode?.get(nodeId);
    if (!byNode || !registry) {
      return;
    }
    const ids = registry.list().map((t) => t.id);
    if (opts?.kill) {
      registry.killAll();
    }
    byNode.delete(nodeId);
    if (byNode.size === 0) {
      this.registries.delete(sessionId);
    }
    const index = this.owners.get(sessionId);
    if (index) {
      for (const id of ids) {
        index.delete(id);
      }
    }
  }

  /**
   * Drop every job of a session (all its nodes), killing the process trees when
   * asked, and forget the session's id counter and index. A later session with
   * the same id starts from a clean slate.
   */
  removeSession(sessionId: string, opts?: { kill?: boolean }): void {
    const byNode = this.registries.get(sessionId);
    if (byNode) {
      if (opts?.kill) {
        for (const registry of byNode.values()) {
          registry.killAll();
        }
      }
      this.registries.delete(sessionId);
    }
    this.owners.delete(sessionId);
    this.counters.delete(sessionId);
  }

  /** Kill every job of every session/node and forget everything (window dispose). */
  killAll(): void {
    for (const byNode of this.registries.values()) {
      for (const registry of byNode.values()) {
        registry.killAll();
      }
    }
    this.registries.clear();
    this.owners.clear();
    this.counters.clear();
  }

  // ---- internal ----

  /** A registry that already exists (never creates one). */
  private findRegistry(sessionId: string, nodeId: string): BackgroundRegistry | undefined {
    return this.registries.get(sessionId)?.get(nodeId);
  }

  private ownerIndex(sessionId: string): Map<number, BackgroundOwner> {
    let index = this.owners.get(sessionId);
    if (!index) {
      index = new Map();
      this.owners.set(sessionId, index);
    }
    return index;
  }

  private mintId(sessionId: string): number {
    const id = (this.counters.get(sessionId) ?? 0) + 1;
    this.counters.set(sessionId, id);
    return id;
  }
}
