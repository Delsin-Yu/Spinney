/**
 * Chat Tree — the session data model.
 *
 * A session is a tree of turn nodes. One node = one turn: a user prompt plus
 * everything the agent produced for it (answer text, reasoning, tool calls and
 * their results). The flat message history the API needs is the concatenation of
 * the nodes along the path from the root to the checked-out node — see
 * `pathMessages`. The system prompt is never stored in a node; it is synthesized
 * on activation (`Agent.systemPrompt`).
 *
 * Invariants (also documented in AGENTS.md):
 *  - a non-empty `node.messages` starts with a `user` message;
 *  - a node's `messages` are written once, when its turn ends;
 *  - the assembled path must go through `Agent.sanitizeMessages` before use, and
 *    the sanitized copy must never be written back into the nodes.
 */
import { ChatMessage, Usage } from '../agent/types';

export type TurnStatus = 'pending' | 'running' | 'done' | 'interrupted' | 'error';

/** A locally held image attachment (data URL + optional filename). */
export interface UserAttachment {
  dataUrl: string;
  name?: string;
}

/** One entry of the UI transcript, persisted so a session restores its view. */
export interface DisplayItem {
  kind: 'user' | 'assistant' | 'tool' | 'notice' | 'background';
  id?: string;
  text?: string;
  thinking?: string;
  noticeKind?: 'warning' | 'info';
  name?: string;
  args?: string;
  content?: string;
  status?: 'running' | 'done';
  error?: boolean;
  attachments?: UserAttachment[];
  usage?: Usage;
  /** For a background notice card: the status phrase, e.g. "finished with exit code 0". */
  doneText?: string;
}

/** One turn (block) in the session tree. */
export interface TreeNode {
  id: string;
  parentId: string | null;
  /** Creation order; `children[0]` is the continuation of the original chain. */
  children: string[];
  /** API messages this turn contributed. Non-empty ⇒ starts with a user message. */
  messages: ChatMessage[];
  /** UI transcript for this turn. */
  displayItems: DisplayItem[];
  status: TurnStatus;
  /** Card title, derived from this turn's user prompt. */
  title: string;
  createdAt: number;
  /** Optional user-resized card bounds (px). Absent ⇒ size from CSS defaults. */
  customSize?: { w: number; h: number };
  /** 'agent' = a sub-agent branch (display-only sidecar; not in the API path). */
  kind?: 'turn' | 'agent';
  /** 0 = main agent turn, 1 = sub-agent, 2 = sub-sub-agent (max depth). */
  agentDepth?: number;
  agentStatus?: 'running' | 'done' | 'killed' | 'error';
  /** Sub-agent's final answer / error / killed note (for the collapsed card). */
  agentSummary?: string;
  agentModel?: string;
  agentWrite?: boolean;
}

/** A persisted conversation: a tree of turns plus the checked-out node. */
export interface AgentSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  nodes: Record<string, TreeNode>;
  /** First node (the initial commit); null for an empty session. */
  rootId: string | null;
  /** Currently checked-out node = the parent of the next prompt. */
  activeNodeId: string | null;
  /** Transcript entries that belong to no turn (e.g. a notice on an empty session). */
  orphanItems: DisplayItem[];
}

export interface StoredState {
  version: number;
  activeSessionId: string;
  sessions: AgentSession[];
}

export const STORED_STATE_VERSION = 2;

/** Shape of the pre-tree (v1) persisted state, kept for migration only. */
interface LegacySession {
  id?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  messages?: ChatMessage[];
  displayItems?: DisplayItem[];
}

interface LegacyState {
  activeSessionId?: string;
  sessions?: LegacySession[];
}

/** Opaque id generator (session ids and node ids share the shape). */
export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** First line of a prompt, clipped, used as the node card title. */
export function titleFromPrompt(text: string): string {
  const first = (text || '').trim().split('\n')[0].trim();
  return (first || 'Turn').slice(0, 80);
}

/** Plain text of a message's content (text parts joined; images ignored). */
export function messageText(content: ChatMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join(' ');
}

export function createNode(
  id: string,
  parentId: string | null,
  title: string,
  status: TurnStatus,
): TreeNode {
  return {
    id,
    parentId,
    children: [],
    messages: [],
    displayItems: [],
    status,
    title,
    createdAt: Date.now(),
  };
}

/**
 * Link a node into the tree and check it out. Sets `rootId` when this is the
 * first node and appends it to the parent's `children`.
 */
export function attachNode(session: AgentSession, node: TreeNode): void {
  session.nodes[node.id] = node;
  const parent = node.parentId ? session.nodes[node.parentId] : undefined;
  if (parent) {
    // A turn continuation is the main-chain spine: keep it before any sub-agent
    // (kind === 'agent') siblings, so sub-agents branch off to the side instead
    // of being confused with a conversational branch.
    if (node.kind === 'agent') {
      parent.children.push(node.id);
    } else {
      const firstAgent = parent.children.findIndex((c) => session.nodes[c]?.kind === 'agent');
      if (firstAgent === -1) {
        parent.children.push(node.id);
      } else {
        parent.children.splice(firstAgent, 0, node.id);
      }
    }
  } else {
    node.parentId = null;
    if (!session.rootId) {
      session.rootId = node.id;
    }
  }
  session.activeNodeId = node.id;
  session.updatedAt = Date.now();
}

/** Node ids from the root down to `nodeId` (empty when the node is unknown). */
export function pathIds(session: AgentSession, nodeId: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur = nodeId;
  while (cur && !seen.has(cur)) {
    const node = session.nodes[cur];
    if (!node) {
      break;
    }
    seen.add(cur);
    out.push(cur);
    cur = node.parentId;
  }
  return out.reverse();
}

/** The flat API history of a branch: every turn node's messages along the path.
 * Agent (sub-agent) nodes are display-only sidecars — their internal conversation
 * is a separate history and must never be concatenated into the parent's. */
export function pathMessages(session: AgentSession, nodeId: string | null): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const id of pathIds(session, nodeId)) {
    const node = session.nodes[id];
    if (node && node.kind !== 'agent') {
      out.push(...node.messages);
    }
  }
  return out;
}

/** The usage of the turn's last message (attached by the provider to the last item). */
export function nodeUsage(node: TreeNode): Usage | undefined {
  for (let i = node.displayItems.length - 1; i >= 0; i--) {
    const usage = node.displayItems[i].usage;
    if (usage) {
      return usage;
    }
  }
  return undefined;
}

/** Follow the newest child chain from `fromId` down to a leaf. */
export function leafOf(session: AgentSession, fromId: string | null): string | null {
  const seen = new Set<string>();
  let cur = fromId;
  while (cur && session.nodes[cur] && !seen.has(cur)) {
    seen.add(cur);
    const kids = session.nodes[cur].children;
    if (kids.length === 0) {
      return cur;
    }
    cur = kids[kids.length - 1];
  }
  return cur && session.nodes[cur] ? cur : null;
}

/**
 * Heal a session loaded from storage: drop the system prompt out of node
 * messages, downgrade a turn that was still running when the extension host went
 * away, drop empty placeholder nodes, unlink dangling children, and re-pick the
 * root / checked-out node when they no longer exist.
 */
export function pruneSession(session: AgentSession): void {
  if (!Array.isArray(session.orphanItems)) {
    session.orphanItems = [];
  }
  for (const node of Object.values(session.nodes)) {
    if (!Array.isArray(node.messages)) {
      node.messages = [];
    }
    if (node.messages.some((m) => m.role === 'system')) {
      // The system prompt is synthesized per activation; a stored one would be
      // stale (wrong model identity) and duplicated on the next request.
      node.messages = node.messages.filter((m) => m.role !== 'system');
    }
    if (!Array.isArray(node.displayItems)) {
      node.displayItems = [];
    }
    if (!Array.isArray(node.children)) {
      node.children = [];
    }
    if (node.status === 'running' || node.status === 'pending') {
      // The turn never finished; its message slice may be missing. Keeping the
      // node as interrupted keeps the user prompt and the partial transcript.
      node.status = 'interrupted';
    }
    // A sub-agent that was still running when the host went away is gone; mark its
    // card killed so a resumed follow-up does not double-run a live branch.
    if (node.kind === 'agent' && node.agentStatus === 'running') {
      node.agentStatus = 'killed';
    }
    if (node.messages.length === 0 && node.displayItems.length === 0 && node.children.length === 0) {
      delete session.nodes[node.id];
    }
  }
  for (const node of Object.values(session.nodes)) {
    node.children = node.children.filter((childId) => !!session.nodes[childId]);
  }
  if (!session.rootId || !session.nodes[session.rootId]) {
    const roots = Object.values(session.nodes)
      .filter((n) => !n.parentId || !session.nodes[n.parentId])
      .sort((a, b) => a.createdAt - b.createdAt);
    session.rootId = roots[0]?.id ?? null;
  }
  if (!session.activeNodeId || !session.nodes[session.activeNodeId]) {
    session.activeNodeId = leafOf(session, session.rootId);
  }
}

/**
 * Read persisted state and normalize it to the tree model. Pre-tree (v1)
 * sessions are converted by splitting their flat message list at each user
 * message; the transcript items are re-attached by walking both lists in
 * parallel (best effort — interrupt and background notices are user messages
 * without a matching user bubble, so the two lists do not line up exactly).
 */
export function migrateState(raw: unknown): {
  activeSessionId: string;
  sessions: AgentSession[];
  migrated: boolean;
} {
  const state = (raw ?? {}) as Partial<StoredState> & LegacyState;
  const rawSessions = Array.isArray(state.sessions) ? state.sessions : [];
  let migrated = false;
  const sessions: AgentSession[] = [];
  for (const entry of rawSessions as unknown[]) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    if ((entry as AgentSession).nodes) {
      sessions.push(normalizeTreeSession(entry as AgentSession));
    } else {
      migrated = true;
      sessions.push(fromLegacySession(entry as LegacySession));
    }
  }
  const activeSessionId = typeof state.activeSessionId === 'string' ? state.activeSessionId : '';
  return { activeSessionId, sessions, migrated };
}

function normalizeTreeSession(raw: AgentSession): AgentSession {
  const session: AgentSession = {
    id: raw.id || newId(),
    title: raw.title || 'New session',
    createdAt: raw.createdAt || Date.now(),
    updatedAt: raw.updatedAt || Date.now(),
    nodes: {},
    rootId: raw.rootId ?? null,
    activeNodeId: raw.activeNodeId ?? null,
    orphanItems: Array.isArray(raw.orphanItems) ? raw.orphanItems : [],
  };
  for (const [id, node] of Object.entries(raw.nodes ?? {})) {
    const n: TreeNode = {
      id,
      parentId: node.parentId ?? null,
      children: Array.isArray(node.children) ? node.children.slice() : [],
      messages: Array.isArray(node.messages) ? node.messages : [],
      displayItems: Array.isArray(node.displayItems) ? node.displayItems : [],
      status: node.status ?? 'done',
      title: node.title || '',
      createdAt: node.createdAt || Date.now(),
      customSize: node.customSize && typeof node.customSize.w === 'number' && typeof node.customSize.h === 'number'
        ? { w: node.customSize.w, h: node.customSize.h }
        : undefined,
    };
    n.kind = node.kind === 'agent' ? 'agent' : undefined;
    n.agentDepth = typeof node.agentDepth === 'number' ? node.agentDepth : undefined;
    n.agentStatus = (node.agentStatus as TreeNode['agentStatus']) ?? undefined;
    n.agentSummary = typeof node.agentSummary === 'string' ? node.agentSummary : undefined;
    n.agentModel = typeof node.agentModel === 'string' ? node.agentModel : undefined;
    n.agentWrite = typeof node.agentWrite === 'boolean' ? node.agentWrite : undefined;
    session.nodes[id] = n;
  }
  pruneSession(session);
  return session;
}

function fromLegacySession(raw: LegacySession): AgentSession {
  const session: AgentSession = {
    id: raw.id || newId(),
    title: raw.title || 'New session',
    createdAt: raw.createdAt || Date.now(),
    updatedAt: raw.updatedAt || Date.now(),
    nodes: {},
    rootId: null,
    activeNodeId: null,
    orphanItems: [],
  };

  // Split the flat history at every user message. A slice always starts with a
  // user message; anything before the first one (there should be nothing but
  // the system prompt) has no turn to belong to and is dropped.
  const slices: ChatMessage[][] = [];
  for (const message of raw.messages ?? []) {
    if (message.role === 'system') {
      continue;
    }
    if (message.role === 'user') {
      slices.push([message]);
    } else if (slices.length > 0) {
      slices[slices.length - 1].push(message);
    }
  }

  const ordered: TreeNode[] = [];
  let prev: TreeNode | null = null;
  for (const slice of slices) {
    const node = createNode(newId(), prev ? prev.id : null, titleFromPrompt(messageText(slice[0].content)), 'done');
    node.messages = slice;
    session.nodes[node.id] = node;
    if (prev) {
      prev.children.push(node.id);
    } else {
      session.rootId = node.id;
    }
    prev = node;
    ordered.push(node);
  }
  session.activeNodeId = prev ? prev.id : null;

  // Re-attach the transcript: a user item advances to the next turn.
  let cursor = -1;
  for (const item of raw.displayItems ?? []) {
    if (item.kind === 'user') {
      cursor++;
    }
    if (cursor < 0 || cursor >= ordered.length) {
      session.orphanItems.push(item);
    } else {
      ordered[cursor].displayItems.push(item);
    }
  }
  return session;
}
