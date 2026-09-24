import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ApiError, RetryInfo } from './apiClient';
import { ClientRegistry, QueueInfo } from './clients';
import { ToolRegistry, resolvePath } from '../tools';
import {
  AgentEvent,
  ChatMessage,
  ContentPart,
  ThinkingEffort,
  ToolCall,
  ToolDefinition,
  Usage,
  detectImageMime,
} from './types';
import {
  IMAGE_BUDGET_RATIO,
  INLINE_REQUEST_BODY_BYTES,
  MAX_IMAGE_BYTES,
  MAX_REQUEST_IMAGE_BYTES,
  ModelCard,
  cardDisplayName,
  isVisionCard,
  visionCardsLabel,
} from './models';
import {
  IMAGE_TARGET_MAX_SIDE,
  ImageTransformRecord,
  Rect,
  TransformOutcome,
  normalizeRect,
  readImageSize,
  transformImage,
} from './imageTransform';

/**
 * The model-facing replacements for an image a request cannot carry. They are stored in the
 * history, not applied at send time: a block rewritten on the way out would change bytes the
 * provider has already cached, which is the one thing this harness must never do
 * (`docs/agents/plans/session-epoch.md` §4.5).
 */
const IMAGE_NEEDS_VISION =
  '[image hidden: the current model does not support images]';
const IMAGE_FOREIGN_UPLOAD =
  '[image hidden: it was uploaded to a provider that this model cannot read from]';
import * as prompt from './prompt';
import { ToolCapabilities, interceptedDefinitions } from './tools';
import { formatDuration } from '../duration';
import { perf } from '../perf';
import { clipText } from '../text';

/**
 * Tools whose result must never carry the generic duration prefix. Two reasons, one
 * list: the `spawn_*` / `send_*` tools answer with **JSON**, where a leading line would
 * break a caller that parses the result (they report `durationMs` inside it instead),
 * and the command tools already name their own duration in the status line the agent
 * reads first.
 */
const DURATION_PREFIX_SKIP = new Set([
  'exec_command',
  'check_background_terminal',
  'kill_background',
  'join_background',
  'spawn_agents',
  'spawn_readonly_agents',
  'send_agent_message',
  'send_readonly_agent_message',
]);

/** From this duration up, a text result is marked with the call's own time. */
const DURATION_PREFIX_MIN_MS = 1000;

/**
 * Mark a text tool result with how long its call took — but only once that is worth
 * knowing (a second or more). A fast call stays unmarked on purpose: the marker then
 * means "this one was slow" instead of costing every result a line, and the common
 * `read_file` / `search_files` round trip reads exactly as it always did. The marker is
 * the FIRST line because an oversized result is spilled by `limitInline`, whose preview
 * keeps only the first 8 lines — a line at the bottom would be the first thing lost,
 * exactly for the slow call whose duration matters most. See `docs/agents/tools.md`.
 */
function withCallDuration(name: string, result: string, ms: number): string {
  if (ms < DURATION_PREFIX_MIN_MS || DURATION_PREFIX_SKIP.has(name)) {
    return result;
  }
  return `[${name} ${formatDuration(ms)}]\n${result}`;
}

/**
 * One image `read_image` attached this turn: either uploaded to the provider's
 * Files API (`file_id` — the card's `deepseek` vision transport) or, for a card
 * whose transport is `openai`, kept as a `data:` URL and sent inside the request
 * body. `bytes` is what that part costs the request (**wire** bytes: the uploaded
 * file, or the base64 URL the inline transport puts in the body) and `transform`
 * is the record of how the source became these bytes — together they are what
 * makes the per-request image budget computable (`docs/agents/plans/image-budget.md` §7).
 */
type PendingImage =
  | { kind: 'file'; fileId: string; path: string; bytes: number; transform?: ImageTransformRecord }
  | { kind: 'inline'; url: string; path: string; bytes: number; transform?: ImageTransformRecord };

/**
 * The host's accounting view, installed **per agent** by the provider that owns the chain
 * (`SessionRuntime.workerFor` / `runSubAgent`). One view per agent, deliberately: branches,
 * sessions and sub-agents all run in parallel, and a process-wide view would answer one
 * chain's request with another chain's index — `read_image` would then attach, or refuse,
 * on a number that describes someone else's history. A view that was never installed means
 * "nothing is known", and the brake then counts only what this agent itself uploaded rather
 * than refusing on a number nobody can vouch for.
 */
export interface ImageAccounting {
  /** Bytes behind one image content part, or undefined when unknown. */
  bytesOf: (part: ContentPart) => number | undefined;
  /** The limit for this card's transport (200 MB referenced, 48 MiB inline). */
  limitBytes: number;
}

/** Bytes as the budget sentences read them: one decimal, in MiB. */
function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/**
 * The one-line pixel story of a transformed image: the **source**'s size (a later `rect` is
 * aimed at the source, not at what we sent), the region that was kept, and the size of what
 * actually leaves. The zoom hint appears only when pixels were really dropped (`scale < 1`),
 * because that is the only case where naming a region buys detail the model did not get.
 */
function describeTransform(t: ImageTransformRecord, scale: number): string {
  const source = t.sourceWidth && t.sourceHeight ? `${t.sourceWidth}x${t.sourceHeight}` : '';
  const region = t.rect ? `, rect ${t.rect.x},${t.rect.y} ${t.rect.w}x${t.rect.h}` : '';
  const sizes = source ? `${source}${region} -> ${t.width}x${t.height}` : `${t.width}x${t.height}`;
  return scale < 1 ? `${sizes}; zoom any region with rect {x,y,w,h} in source pixels` : sizes;
}

/**
 * Injected as an extra user message before a follow-up prompt when the previous
 * turn was interrupted (user pressed Stop). It tells the model that the partial
 * output of that turn was discarded, then leaves the decision to the model:
 * the next message may be a steering correction to continue the current task,
 * or a fresh request to start over. The model judges which is meant from the
 * message itself and the conversation history, so steering commands that tell
 * the agent to fix its reasoning are not force-restarted.
 *
 * When the stop landed while a tool call was being streamed, the notice is
 * prefixed with the specific tool that was interrupted so the model knows what
 * it was doing and can decide to re-issue it or correct it on the next turn.
 */
const INTERRUPT_NOTICE_GENERIC =
  '[Interruption notice] The user stopped your previous response before it was complete; its partial output was discarded. ';

const INTERRUPT_NOTICE_TAIL =
  'Treat the next user message as your fresh input and decide for yourself how to proceed: ' +
  'if it reads as a steering correction or follow-up to the current task, continue that task and apply the correction; ' +
  'if it reads as a new or different request, start over. ' +
  'Do not assume you must restart, and do not try to resume text that is no longer in the conversation.';

/** A partial tool call that was in progress when the user stopped the turn. */
interface InterruptedToolCall {
  name: string;
  arguments: string;
}

/** Cap a field value so a very long command/path does not bloat the notice. */
function truncateField(value: string, limit = 120): string {
  return value.length > limit ? clipText(value, limit) : value;
}

/** Read a single string field out of a (possibly truncated) JSON tool-call payload. */
function extractToolArg(tc: InterruptedToolCall): string | null {
  const key = tc.name === 'exec_command' ? 'command' : 'path';
  const args = tc.arguments;
  if (!args) {
    return null;
  }
  try {
    const obj = JSON.parse(args) as Record<string, unknown>;
    if (obj && typeof obj === 'object' && typeof obj[key] === 'string' && obj[key]) {
      return truncateField(obj[key] as string);
    }
  } catch {
    // Truncated/incomplete JSON (we were cut off mid-write) — fall through to a
    // tolerant regex that still finds the field the tool needs to be describable.
  }
  const m = args.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  return m && m[1] ? truncateField(m[1]) : null;
}

/** Tolerant JSON parse for tool-call arguments (used by the sub-agent hook). */
function parseToolArgs(json: string): Record<string, unknown> {
  try {
    const obj = JSON.parse(json || '{}');
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Human-readable phrase for a single interrupted tool call, e.g. `write_file` tool call that writes to `path`. */
function describeToolCall(tc: InterruptedToolCall): string {
  const name = tc.name;
  const tool = `\`${name}\` tool call`;
  const arg = extractToolArg(tc);
  if (!arg) {
    return tool;
  }
  switch (name) {
    case 'write_file':
      return `${tool} that writes to \`${arg}\``;
    case 'replace_in_file':
      return `${tool} that edits \`${arg}\``;
    case 'read_file':
      return `${tool} that reads \`${arg}\``;
    case 'read_image':
      return `${tool} that reads the image at \`${arg}\``;
    case 'list_dir':
      return `${tool} that lists \`${arg}\``;
    case 'exec_command':
      return `${tool} that runs \`${arg}\``;
    default:
      return tool;
  }
}

/**
 * Build the interruption notice. When interrupted mid-tool-call, prepend the
 * precise stranded tool so the model can re-issue it; otherwise use the generic
 * text. Kept to the minimum — only the tool(s) actually being written when the
 * stop landed are named.
 */
function buildInterruptNotice(tools: InterruptedToolCall[]): string {
  const named = tools.filter((t) => t.name);
  const context = named.map(describeToolCall).join(' and ');
  const lead = context
    ? `[Interruption notice] The user stopped your previous ${context} before it was complete; its partial output was discarded. `
    : INTERRUPT_NOTICE_GENERIC;
  return lead + INTERRUPT_NOTICE_TAIL;
}

/**
 * The status line shown while a failed model call is being retried. Deliberately
 * short — the status bar is one line, and the exact reason is on the output
 * channel (the client logs it) and in the final error if every attempt fails.
 */
function retryStatus(info: RetryInfo): string {
  const seconds = info.delayMs >= 1_000 ? `${Math.round(info.delayMs / 1_000)}s` : `${info.delayMs}ms`;
  return vscode.l10n.t(
    'Model call failed ({0}/{1}); retrying in {2}…',
    info.attempt,
    info.maxAttempts,
    seconds,
  );
}

/**
 * The status line shown while a request waits for a concurrency slot (the
 * provider's or the model card's cap is reached). Without it a queued request is
 * indistinguishable from a slow model.
 */
function queueStatus(info: QueueInfo): string {
  return vscode.l10n.t(
    'Waiting for a free request slot ({0} queued, {1} allowed at once)…',
    info.queued,
    info.limit,
  );
}

/**
 * Thrown when a turn is interrupted (Stop pressed / request aborted). Carries
 * the partial content and reasoning that were streamed up to the interruption so
 * they can be preserved as a checkpoint and replayed to the model on the next
 * turn — letting the agent see where it got cut off and self-correct rather than
 * being force-restarted.
 */
class InterruptedError extends Error {
  constructor(
    public readonly content: string,
    public readonly reasoning: string,
    public readonly toolCalls: InterruptedToolCall[] = [],
  ) {
    super('interrupted');
    this.name = 'InterruptedError';
  }
}

export class Agent {
  /**
   * Set a snapshot of the workspace AGENTS.md to be appended to the system
   * prompt. Call this once when a session starts so the appended instructions
   * are fixed for the session; later edits to AGENTS.md do not propagate to the
   * prompt. Pass null (or omit the call) when no AGENTS.md is present.
   */
  static setAgentsMd(content: string | null): void {
    prompt.setAgentsMd(content);
  }

  /** Fresh conversation history consisting of just the system prompt. */
  static initialMessages(
    model = '',
    effort: ThinkingEffort = 'none',
    language: string = prompt.DEFAULT_REPLY_LANGUAGE,
  ): ChatMessage[] {
    return [{ role: 'system', content: prompt.systemPrompt(model, effort, language) }];
  }

  /** The current system prompt (used to refresh persisted sessions). */
  static systemPrompt(
    model = '',
    effort: ThinkingEffort = 'none',
    language: string = prompt.DEFAULT_REPLY_LANGUAGE,
  ): string {
    return prompt.systemPrompt(model, effort, language);
  }

  /**
   * Ensure the message history is API-valid: every assistant message with
   * `tool_calls` must be immediately followed by a `tool` response for each
   * `tool_call_id`. Drops dangling tool_calls blocks and orphan tool messages
   * that would otherwise cause a 400 error when a session is resumed.
   */
  static sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
    const result: ChatMessage[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === 'tool') {
        const prev = result[result.length - 1];
        const valid = prev && prev.role === 'assistant' && prev.tool_calls && prev.tool_calls.length > 0;
        if (!valid) {
          continue; // drop orphan tool message
        }
        result.push(msg);
        continue;
      }

      // Heal an assistant message that the API would reject: it must carry
      // content or tool_calls. If it has neither, mirror any reasoning into
      // content; if it has nothing at all (no content, no tool_calls, no
      // reasoning), drop it entirely. The healed message is a **copy** — the
      // caller's objects are the persisted nodes' own messages (buildPath passes
      // `pathMessages(...)` by reference), and this function must never write
      // back into them.
      let out = msg;
      if (msg.role === 'assistant' && !msg.content && (!msg.tool_calls || msg.tool_calls.length === 0)) {
        if (msg.reasoning_content) {
          out = { ...msg, content: msg.reasoning_content, reasoning_content: undefined };
        } else {
          continue;
        }
      }

      result.push(out);

      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const ids = new Set(msg.tool_calls.map((tc) => tc.id));
        let j = i + 1;
        while (j < messages.length && ids.size > 0) {
          const next = messages[j];
          if (next.role === 'tool' && next.tool_call_id && ids.has(next.tool_call_id)) {
            ids.delete(next.tool_call_id);
            result.push(next);
            j++;
          } else {
            break;
          }
        }
        if (ids.size > 0) {
          // Incomplete: remove any tool responses we appended, then the
          // assistant message carrying the unresolved tool_calls.
          while (result.length > 0 && result[result.length - 1].role === 'tool') {
            result.pop();
          }
          result.pop();
        } else {
          i = j - 1; // continue after the tool responses
        }
      }
    }
    return result;
  }

  private messages: ChatMessage[] = [];
  private abortController: AbortController | null = null;
  private isRunning = false;
  private cancelled = false;
  private lastTurnInterrupted = false;
  private lastInterruptedTools: InterruptedToolCall[] = [];
  /** Images attached by read_image this turn; flushed as a user content block. */
  private pendingImages: PendingImage[] = [];
  /**
   * What this agent itself put into the request this turn, by the id its part references
   * (`file_id`, or the inline `data:` URL) → the wire bytes that part costs. Kept apart
   * from `pendingImages`, which is drained into a user block after every tool batch: the
   * provider's provenance is written when the turn *ends*, so mid-turn these are the only
   * numbers that exist for the brake's sum (`this.imageAccounting`, §2.2).
   */
  private readonly uploadedThisTurn = new Map<string, number>();
  /**
   * What the host knows about the images this agent's next request would already carry
   * ({@link ImageAccounting}). Set by the provider per agent, and `null` until it is.
   */
  private imageAccounting: ImageAccounting | null = null;
  /** The card this agent runs on (provider, wire name, vision, effort levels). */
  private card?: ModelCard;
  private thinkingEffort: ThinkingEffort = 'none';
  /** Reply language injected as the prompt's `## Language` line. */
  private replyLanguage: string = prompt.DEFAULT_REPLY_LANGUAGE;
  /** Provider hook that runs sub-agents for the `spawn_agents` tool. */
  private spawnHandler: ((args: Record<string, unknown>, signal: AbortSignal) => Promise<string>) | null = null;
  /** Provider hook that resumes a finished sub-agent for the `send_agent_message` tool. */
  private sendMessageHandler: ((args: Record<string, unknown>, signal: AbortSignal) => Promise<string>) | null = null;
  /** Provider hook that hands a task to a fresh session for the `hop_session` tool. */
  private hopHandler: ((args: Record<string, unknown>, signal: AbortSignal) => Promise<string>) | null = null;
  /** Provider hook that renders the active session's tree for `list_nodes`. */
  private listNodesHandler: (() => Promise<string>) | null = null;
  /** Provider hook that renames a session for the `rename_session` tool. */
  private renameSessionHandler: ((args: Record<string, unknown>, signal: AbortSignal) => Promise<string>) | null =
    null;
  /**
   * Provider hook that returns the completion signals (background terminal /
   * async sub-agent) this node's turn should inject **now**. It is consulted at
   * every tool boundary — after the whole tool batch of one assistant round, so
   * the `assistant(tool_calls) -> tool(...)` window stays intact — and the
   * returned texts are pushed as `user` messages right before the next request,
   * exactly like the `read_image` image block. A non-empty result therefore
   * extends the running turn by one round; the model sees the signal on its very
   * next hop instead of at the end of the turn.
   */
  private signalHandler: (() => string[]) | null = null;
  /** Whether `spawn_readonly_agents` is exposed (read-only agents only). */
  private canSpawnReadOnly = false;
  /** Whether this agent may spawn sub-agents (a depth-2 sub-agent may not). */
  private canSpawn = true;
  /** Whether `hop_session` is exposed (main agent only). */
  private canHop = false;
  /**
   * The tool schemas of the epoch this agent is sending with, when it has one. Set from
   * the node's frozen envelope at every turn start; `undefined` means "the live set",
   * which is what a chain without an epoch (a legacy one, or the first turn that is about
   * to freeze) sends.
   */
  private frozenTools?: ToolDefinition[];

  /**
   * Every `read_image` upload this agent made, newest last: the raw material a later
   * epoch needs to translate a `file_id` into whatever another card can read
   * (`docs/agents/plans/session-epoch.md` §6). Accumulated for the agent's lifetime —
   * the message that references an id can be stored long after the upload — and read by
   * the runtime when it writes a finished turn's provenance. `bytes` (wire bytes) and
   * `transform` are the two facts that provenance needs beyond the path: the first makes
   * the per-request image budget exact instead of estimated, the second lets a copied
   * chain rebuild the **same view** rather than inlining the raw source file
   * (`docs/agents/plans/image-budget.md` §2.4).
   */
  private readonly imageUploads: {
    fileId: string;
    providerId: string;
    path?: string;
    bytes: number;
    transform?: ImageTransformRecord;
  }[] = [];

  constructor(
    private readonly clients: ClientRegistry,
    private readonly tools: ToolRegistry,
    private readonly onEvent: (event: AgentEvent) => void,
  ) {
    this.reset();
  }

  /**
   * Set the model card this agent runs on: it decides the provider the request
   * goes to, the wire model name, whether images are allowed and how they travel,
   * and which reasoning levels exist for it.
   */
  setCard(card: ModelCard): void {
    this.card = card;
  }

  /** The card's id ('' before the first {@link setCard}). */
  get cardId(): string {
    return this.card?.id ?? '';
  }

  /** The card's display name, for the prompt's identity line and error texts. */
  private get modelLabel(): string {
    return cardDisplayName(this.card);
  }

  /** Set the reasoning-effort level for subsequent completions. */
  setThinkingEffort(effort: ThinkingEffort): void {
    this.thinkingEffort = effort;
  }

  /** Set the language the agent replies in (the prompt's `## Language` line). */
  setReplyLanguage(language: string): void {
    this.replyLanguage = language || prompt.DEFAULT_REPLY_LANGUAGE;
  }

  /** Set a provider hook that runs sub-agents for the `spawn_agents` tool. */
  setSpawnHandler(handler: ((args: Record<string, unknown>, signal: AbortSignal) => Promise<string>) | null): void {
    this.spawnHandler = handler;
  }

  /** Set a provider hook that resumes a finished sub-agent for `send_agent_message`. */
  setSendMessageHandler(handler: ((args: Record<string, unknown>, signal: AbortSignal) => Promise<string>) | null): void {
    this.sendMessageHandler = handler;
  }

  /** Set a provider hook that hands a task to a fresh session for `hop_session`. */
  setHopHandler(handler: ((args: Record<string, unknown>, signal: AbortSignal) => Promise<string>) | null): void {
    this.hopHandler = handler;
  }

  /** Set a provider hook that renders the active session's tree for `list_nodes`. */
  setListNodeHandler(handler: (() => Promise<string>) | null): void {
    this.listNodesHandler = handler;
  }

  /** Set a provider hook that renames a session for `rename_session`. */
  setRenameSessionHandler(
    handler: ((args: Record<string, unknown>, signal: AbortSignal) => Promise<string>) | null,
  ): void {
    this.renameSessionHandler = handler;
  }

  /**
   * Set the provider hook that delivers queued completion signals (a finished
   * background terminal / async sub-agent) into a **running** turn, at its next
   * tool boundary. The hook returns the texts to inject; it drains its own queue,
   * so it is called at most once per assistant tool round and must be cheap and
   * never throw.
   */
  setSignalHandler(handler: (() => string[]) | null): void {
    this.signalHandler = handler;
  }

  /** Allow/deny this agent from hopping to a fresh session (main agent only). */
  setCanHop(v: boolean): void {
    this.canHop = v;
  }

  /** Allow/deny this agent from spawning sub-agents (a depth-2 agent may not). */
  setCanSpawn(v: boolean): void {
    this.canSpawn = v;
  }

  /**
   * Allow this agent to fan out **read-only** children via
   * `spawn_readonly_agents`. A read-only agent gets this instead of
   * `spawn_agents`, which would let it create a `write:true` child and bypass
   * its own restriction. A depth-2 agent may not (depth is hard-capped at 2).
   */
  setCanSpawnReadOnly(v: boolean): void {
    this.canSpawnReadOnly = v;
  }

  /**
   * Install this agent's view of the images its next request would already carry — what the
   * provider knows about the frozen history (`docs/agents/plans/image-budget.md` §2.2). The
   * other half of the sum is this agent's own record of what it uploaded this turn
   * ({@link uploadedThisTurn}), because a turn's provenance is written only when the turn
   * ends. `null` (the default) means nothing is known: `read_image` then counts only its own
   * uploads and still applies the ceiling's margin, rather than refusing on a number nobody
   * can vouch for.
   */
  setImageAccounting(accounting: ImageAccounting | null): void {
    this.imageAccounting = accounting;
  }

  /** Start a fresh conversation: the system prompt plus nothing else. */
  reset(): void {
    this.messages = Agent.initialMessages(this.modelLabel, this.thinkingEffort, this.replyLanguage);
    this.pendingImages = [];
    this.uploadedThisTurn.clear();
  }

  /**
   * Lean system prompt for a sub-agent: a compact worker identity instead of the
   * full main prompt + AGENTS.md (saves tokens), followed by a note that it was
   * dispatched by the main agent. The template lives in `prompt.ts` next to the
   * main one.
   */
  static subAgentSystemPrompt(model = '', effort: ThinkingEffort = 'none', depth = 1, write = false): string {
    return prompt.subAgentSystemPrompt(model, effort, depth, write);
  }

  /** The capabilities that decide which intercepted tools this agent sees. */
  private toolCapabilities(): ToolCapabilities {
    return {
      vision: isVisionCard(this.card),
      canSpawn: this.canSpawn,
      canSpawnReadOnly: this.canSpawnReadOnly,
      canHop: this.canHop,
    };
  }

  /**
   * Tool definitions exposed to the model: everything the registry holds (the
   * file tools, `exec_command` + the background tools, `search_files`,
   * `search_transcripts`) plus the tools the provider orchestrates and the Agent
   * intercepts: `read_image` (vision models only), the `spawn_*` / `send_*` pair
   * matching this agent's capabilities, and — main agent only — `hop_session` /
   * `list_nodes` / `rename_session`. Every tool is advertised with its full
   * schema; there is no folded "gradual reveal" tier. The intercepted set comes
   * from the same capability flags the system prompt's `## Delegation` guidance
   * assumes, so the two can never disagree.
   */
  private getTools(): ToolDefinition[] {
    if (this.frozenTools) {
      return this.frozenTools;
    }
    return [...this.tools.definitions, ...interceptedDefinitions(this.toolCapabilities())];
  }

  /**
   * The tool schemas this agent would advertise right now. The caller that **freezes**
   * an epoch records them, so the wire model keeps the tools its own instructions were
   * written against — a chain must not silently gain or lose a tool inside a prefix it
   * has already sent (`docs/agents/plans/session-epoch.md`).
   */
  getToolSchemas(): ToolDefinition[] {
    return this.getTools();
  }

  /**
   * Pin the advertised schemas to a frozen set (a resuming chain), or `undefined` to go
   * back to the live capability set. A frozen tool whose implementation no longer exists
   * is answered by the registry as an ordinary tool error — the chain is never rewritten
   * to hide it.
   */
  setToolSchemas(schemas: ToolDefinition[] | undefined): void {
    this.frozenTools = schemas && schemas.length > 0 ? schemas : undefined;
  }

  /**
   * The id a content part references an image by (`file_id` for a Files API
   * upload, the url otherwise), or null for a non-image part. Used to hide an
   * image without touching the stored history.
   */
  private imagePartId(part: ContentPart): string | null {
    if (part.type === 'file') {
      return part.file_id;
    }
    if (part.type === 'image_url') {
      return part.image_url.url;
    }
    return null;
  }


  /** The `read_image` uploads this agent made, for the runtime's provenance record. */
  getImageUploads(): {
    fileId: string;
    providerId: string;
    path?: string;
    bytes: number;
    transform?: ImageTransformRecord;
  }[] {
    return this.imageUploads;
  }

  /** Replace the conversation history (used when switching sessions). */
  setMessages(messages: ChatMessage[]): void {
    this.messages = messages;
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  /**
   * Forget a pending interruption notice. The provider calls this when the
   * active branch changes: the notice only makes sense when the next turn
   * continues from the turn that was actually interrupted.
   */
  resetInterruptState(): void {
    this.lastTurnInterrupted = false;
    this.lastInterruptedTools = [];
  }

  /**
   * Record that this agent's last turn was interrupted, optionally naming the
   * tool call(s) that were in progress. The pending notice is emitted at the
   * start of the next `sendUserMessage` and cleared there. P3 keys the
   * bookkeeping per node, so two concurrent branches never clobber each other's
   * notice.
   */
  markInterrupted(tools: InterruptedToolCall[] = []): void {
    this.lastTurnInterrupted = true;
    this.lastInterruptedTools = tools;
  }

  /**
   * Hand this agent's pending interruption notice to `other`. P3 uses it when a
   * run starts on node M whose parent P was the interrupted node: M is bound to a
   * *different* node worker, so its agent has to inherit P's notice. The source
   * no longer holds it afterwards — the notice is delivered exactly once, the
   * same as the single session-wide agent the pre-P3 code reused. A no-op when
   * `other` has no pending notice, so a fresh continuation of an already-answered
   * interruption does not re-notify.
   */
  transferInterruptTo(other: Agent): void {
    if (!other.lastTurnInterrupted) {
      return;
    }
    this.markInterrupted(other.lastInterruptedTools);
    other.resetInterruptState();
  }

  /** A turn is considered stopped if the stream signal was aborted or Stop was called. */
  private isStopped(signal: AbortSignal): boolean {
    return signal.aborted || this.cancelled;
  }

  /** Immediately stop the running turn: abort the stream and reject further work. */
  cancel(): void {
    this.cancelled = true;
    this.abortController?.abort();
  }

  get running(): boolean {
    return this.isRunning;
  }

  sendUserMessage(content: string | ContentPart[]): void {
    if (this.isRunning) {
      return;
    }
    if (typeof content === 'string') {
      if (!content.trim()) {
        return;
      }
    } else if (content.length === 0) {
      return;
    }

    this.isRunning = true;
    this.cancelled = false;
    // Discard any image attached in a previously interrupted turn (it was never
    // flushed as a user block, so it must not leak into this turn). The per-turn
    // upload record goes with it: from this turn on, the provider's provenance is
    // what knows about the earlier images (`uploadedThisTurn`).
    this.pendingImages = [];
    this.uploadedThisTurn.clear();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    // If the previous turn was interrupted, let the model know its last output
    // was cancelled before we send the user's actual follow-up message. When the
    // stop landed mid-tool-call, the notice names the exact tool that was being
    // written (e.g. `write_file` tool call that writes to `path`).
    if (this.lastTurnInterrupted) {
      this.messages.push({ role: 'user', content: buildInterruptNotice(this.lastInterruptedTools) });
      this.lastTurnInterrupted = false;
      this.lastInterruptedTools = [];
    }

    // Everything appended during this turn; roll back on failure.
    this.messages.push({ role: 'user', content });
    const turnStartIndex = this.messages.length;

    void this.runTurn(signal, turnStartIndex);
  }

  private async runTurn(signal: AbortSignal, turnStartIndex: number): Promise<void> {
    try {
      while (true) {
        if (this.isStopped(signal)) {
          throw new Error('interrupted');
        }

        this.onEvent({ type: 'status', text: vscode.l10n.t('Thinking…') });
        const reqStart = Date.now();
        const { message: assistant, indices, usage } = await this.requestAssistantMessage(signal);
        perf(
          () =>
            `assistant-round ${Date.now() - reqStart}ms msgs=${this.messages.length} ` +
            `tools=${assistant.tool_calls?.length ?? 0} ` +
            `chars=${typeof assistant.content === 'string' ? assistant.content.length : 0}`,
        );
        // Never retain an assistant message the API would reject: a turn must
        // carry content or tool_calls. A completely empty response (no content,
        // no reasoning, no tool_calls) has nothing worth keeping in history.
        const hasToolCalls = !!(assistant.tool_calls && assistant.tool_calls.length > 0);
        const hasContent = typeof assistant.content === 'string' && assistant.content.trim().length > 0;
        if (hasToolCalls || hasContent) {
          this.messages.push(assistant);
        }

        if (assistant.tool_calls && assistant.tool_calls.length > 0) {
          for (let i = 0; i < assistant.tool_calls.length; i++) {
            if (this.isStopped(signal)) {
              throw new Error('interrupted');
            }
            await this.executeToolCall(assistant.tool_calls[i], signal, indices[i]);
          }
          // Completion signals (background terminals / async sub-agents) queue up
          // while this turn runs. They are injected here — after the **whole**
          // tool batch, so the assistant(tool_calls) -> tool(...) window stays
          // intact (a foreign message inside it would make `sanitizeMessages`
          // drop the block on the next resume), and before the next request, so
          // the model reacts on its very next hop instead of at the turn's end.
          // Same shape as the image block below.
          for (const text of this.signalHandler?.() ?? []) {
            this.messages.push({ role: 'user', content: text });
          }
          // Any read_image uploads now become a user content block so the model
          // can actually see them. Image content blocks are only valid in a user
          // message (a tool message cannot carry one), and they must follow the
          // tool responses so the assistant(tool_calls) -> tool(...) ordering
          // stays valid. The model's next turn then sees the image(s).
          if (this.pendingImages.length > 0) {
            this.messages.push({
              role: 'user',
              content: [
                { type: 'text', text: 'Image(s) requested via read_image:' },
                ...this.pendingImages.map(
                  (f): ContentPart =>
                    f.kind === 'file'
                      ? { type: 'file', file_id: f.fileId }
                      : { type: 'image_url', image_url: { url: f.url } },
                ),
              ],
            });
            this.pendingImages.length = 0;
          }
          // The assistant turn that produced these tool calls is now complete and
          // its tool window is fully built. Emit the turn's usage here so the UI
          // attaches the token count to the tool call card(s) instead of hoisting
          // it into an extra (empty) message bubble.
          if (usage) {
            this.onEvent({ type: 'usage', usage });
          }
          continue;
        }

        // No tool calls: final answer is done.
        if (usage) {
          this.onEvent({ type: 'usage', usage });
        }
        this.onEvent({ type: 'status', text: vscode.l10n.t('Done') });
        this.onEvent({ type: 'done' });
        return;
      }
    } catch (err) {
      // Any image attached this turn but not flushed must be discarded (it would
      // otherwise leak into the next turn's tool window).
      this.pendingImages = [];
      const interrupted = this.isStopped(signal) || err instanceof InterruptedError;
      if (interrupted) {
        // Remember the tool call(s) that were in progress so the per-tool
        // interruption notice can name exactly what was stopped.
        this.markInterrupted(this.captureInterruptedToolCalls(err));
        // Preserve any partial output/reasoning streamed up to the interruption
        // as a checkpoint, so the next turn can see where the model cut off and
        // decide (with the interruption notice) whether to continue or restart.
        this.preservePartialTurn(turnStartIndex, err instanceof InterruptedError ? err : undefined);
        this.onEvent({ type: 'interrupted' });
        return;
      }

      // Non-interrupt error: roll back any partial assistant/tool messages added
      // this turn so the transcript stays consistent for the next request.
      this.messages.splice(turnStartIndex);
      const message = err instanceof Error ? err.message : String(err);
      this.onEvent({ type: 'error', message });
    } finally {
      this.isRunning = false;
      this.abortController = null;
    }
  }

  /**
   * On interruption, keep the partial output/reasoning streamed so far as a
   * single "checkpoint" assistant message (with no tool_calls — those are always
   * incomplete when the user stops a turn). This lets the next turn see where the
   * model was cut off, particularly its own reasoning, so it can self-correct
   * rather than being force-restarted.
   *
   * @param turnStartIndex index of the first message appended during this turn
   * @param streamed       interruption error carrying the streamed content/reasoning
   */
  private preservePartialTurn(turnStartIndex: number, streamed?: InterruptedError): void {
    const added = this.messages.splice(turnStartIndex);

    // Prefer the interrupting stream's partials; otherwise recover them from the
    // most recently pushed assistant message (e.g. interruption during tool
    // execution), which is the one that was in progress when the user stopped.
    let content = streamed?.content ?? '';
    let reasoning = streamed?.reasoning ?? '';
    if (!content && !reasoning) {
      let candidate: ChatMessage | undefined;
      for (let i = added.length - 1; i >= 0; i--) {
        if (added[i].role === 'assistant') {
          candidate = added[i];
          break;
        }
      }
      if (candidate) {
        content = typeof candidate.content === 'string' ? candidate.content : '';
        reasoning = candidate.reasoning_content ?? '';
      }
    }

    // Keep only the partial text/reasoning; never carry incomplete tool_calls.
    if (content || reasoning) {
      // The chat-completion API rejects an assistant message that carries neither
      // content nor tool_calls. If the user stopped the model while it was still
      // emitting only reasoning (thinking) and produced no answer text yet, mirror
      // that reasoning into content so the preserved checkpoint stays valid and is
      // not lost from the history on the next turn.
      const effectiveContent = content || reasoning || '';
      this.messages.push({
        role: 'assistant',
        content: effectiveContent,
        // Keep the raw reasoning alongside the content only when both exist; when
        // only reasoning was streamed it is already mirrored into content above.
        reasoning_content: content ? (reasoning || undefined) : undefined,
      });
    }
  }

  /**
   * Determine which tool call(s) were in progress when the user stopped the
   * turn, so the per-tool interruption notice can name them. Prefers the partial
   * calls captured from the stream; when the stop landed during tool execution
   * the in-progress assistant message still carries fully-formed tool_calls, so
   * we describe those (without ever keeping them as a checkpoint).
   */
  private captureInterruptedToolCalls(err: unknown): InterruptedToolCall[] {
    if (err instanceof InterruptedError && err.toolCalls && err.toolCalls.length > 0) {
      return err.toolCalls;
    }
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        return msg.tool_calls.map((tc) => ({
          name: tc.function.name,
          arguments: tc.function.arguments,
        }));
      }
    }
    return [];
  }

  private async executeToolCall(call: ToolCall, signal: AbortSignal, index?: number): Promise<void> {
    if (call.function.name === 'read_image') {
      await this.executeReadImage(call, signal, index);
      return;
    }
    // Capture the start before announcing the call: the UI's elapsed chip ticks
    // from the moment the card appears, and this is the clock the `ms` readout
    // below is measured against.
    const startedAt = Date.now();
    this.onEvent({
      type: 'toolStart',
      id: call.id,
      name: call.function.name,
      args: call.function.arguments,
      index,
      startedAt,
    });
    // Announce the start **before** the body runs. The line below only fires once a tool
    // returns, so a call that hangs (or a turn killed while one is running) used to leave
    // no line at all for it — a silent hole of hours in the diagnostics log.
    perf(`tool-start ${call.function.name} args=${call.function.arguments.length}`);
    let result: string;
    if (call.function.name === 'spawn_agents') {
      // Orchestrating sub-agents is the provider's job (node creation, pool,
      // event routing). Delegate; a fixed string is returned as the tool result.
      const args = parseToolArgs(call.function.arguments);
      result = !this.canSpawn
        ? 'Error: this agent may not spawn sub-agents (not permitted for a read-only agent, or at this depth).'
        : this.spawnHandler
          ? await this.spawnHandler(args, signal)
          : 'Error: sub-agents are not available in this session.';
    } else if (call.function.name === 'spawn_readonly_agents') {
      // The read-only fan-out variant. Rewrite every spec with `write:false` so a
      // `write` key smuggled into the arguments cannot escalate a child.
      const args = parseToolArgs(call.function.arguments);
      const specs = Array.isArray(args.agents) ? (args.agents as unknown[]) : [];
      const readOnlyArgs: Record<string, unknown> = {
        ...args,
        agents: specs.map((entry) => {
          const spec = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
          return { instruction: spec.instruction, model: spec.model, write: false };
        }),
      };
      result = !this.canSpawnReadOnly
        ? 'Error: this agent may not spawn sub-agents (not permitted for a read-only agent, or at this depth).'
        : this.spawnHandler
          ? await this.spawnHandler(readOnlyArgs, signal)
          : 'Error: sub-agents are not available in this session.';
    } else if (call.function.name === 'send_readonly_agent_message') {
      // Read-only resume variant: no write override can be expressed, and any
      // smuggled `write` key is pinned to false before delegating.
      const args = parseToolArgs(call.function.arguments);
      result = !this.canSpawnReadOnly
        ? 'Error: this agent may not message sub-agents (not permitted for a read-only agent, or at this depth).'
        : this.sendMessageHandler
          ? await this.sendMessageHandler({ ...args, write: false }, signal)
          : 'Error: sub-agent messaging is not available in this session.';
    } else if (call.function.name === 'send_agent_message') {
      // Resuming a finished sub-agent is also the provider's job. Delegate; the
      // result (a resume confirmation or, in sync mode, the follow-up outcome)
      // is returned as the tool result.
      const args = parseToolArgs(call.function.arguments);
      result = !this.canSpawn
        ? 'Error: this agent may not message sub-agents (not permitted for a read-only agent, or at this depth).'
        : this.sendMessageHandler
          ? await this.sendMessageHandler(args, signal)
          : 'Error: sub-agent messaging is not available in this session.';
    } else if (call.function.name === 'hop_session') {
      // Handing the task to a fresh session is the provider's job (it owns the
      // session list and the hop-back). Delegate; a fixed string is returned as
      // the tool result.
      const args = parseToolArgs(call.function.arguments);
      result = !this.canHop
        ? 'Error: only the main agent may hop to another session.'
        : this.hopHandler
          ? await this.hopHandler(args, signal)
          : 'Error: session hopping is not available in this session.';
    } else if (call.function.name === 'list_nodes') {
      result = !this.canHop
        ? 'Error: only the main agent may list the session tree.'
        : this.listNodesHandler
          ? await this.listNodesHandler()
          : 'Error: the session tree is not available in this session.';
    } else if (call.function.name === 'rename_session') {
      // Renaming a session is the provider's job (it owns the session list and
      // the title bookkeeping). Delegate; the new title is returned.
      const args = parseToolArgs(call.function.arguments);
      result = !this.canHop
        ? 'Error: only the main agent may rename a session.'
        : this.renameSessionHandler
          ? await this.renameSessionHandler(args, signal)
          : 'Error: session renaming is not available in this session.';
    } else {
      result = await this.tools.execute(call.function.name, call.function.arguments, signal);
    }
    const ms = Date.now() - startedAt;
    perf(
      () =>
        `tool ${call.function.name} ${ms}ms args=${call.function.arguments.length} ` +
        `result=${result.length}`,
    );
    // The model reads the marked result; the UI shows the same number on the card, and
    // both come from this one measurement.
    const content = withCallDuration(call.function.name, result, ms);
    this.onEvent({ type: 'toolEnd', id: call.id, name: call.function.name, content, ms });
    this.messages.push({ role: 'tool', tool_call_id: call.id, content });
  }

  /**
   * Handle the read_image tool call: read the file, upload it to the DeepSeek
   * Files API, and queue the returned file_id for injection as a user content
   * block after all tool responses are pushed (see runTurn). The `tool` message
   * itself carries only a short confirmation, never the image bytes.
   */
  private async executeReadImage(call: ToolCall, signal: AbortSignal, index?: number): Promise<void> {
    // Same clock as the regular path: start before the card is announced, so the
    // upload/read time is included in what the elapsed chip shows.
    const startedAt = Date.now();
    this.onEvent({
      type: 'toolStart',
      id: call.id,
      name: 'read_image',
      args: call.function.arguments,
      index,
      startedAt,
    });

    let imagePath = '';
    let rawRect: unknown;
    try {
      const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      imagePath = String(args.path ?? '');
      rawRect = args.rect;
    } catch {
      imagePath = '';
    }

    const result = await this.tryReadImage(imagePath, rawRect, signal);
    const ms = Date.now() - startedAt;
    // An image read is a call like any other: a slow upload is marked the same way.
    const content = withCallDuration('read_image', result, ms);
    this.onEvent({ type: 'toolEnd', id: call.id, name: 'read_image', content, ms });
    this.messages.push({ role: 'tool', tool_call_id: call.id, content });
  }

  /**
   * Read + validate an image file and attach it, or return a friendly error.
   *
   * Since P1/P2 the bytes that leave here are the **transformed** ones — the optional
   * `rect` crop, then a downscale to {@link IMAGE_TARGET_MAX_SIDE} — and the per-request
   * byte budget is checked before anything is attached, so this request never carries what
   * the provider would refuse (`docs/agents/plans/image-budget.md` §2).
   */
  private async tryReadImage(filePath: string, rawRect?: unknown, signal?: AbortSignal): Promise<string> {
    const card = this.card;
    if (!isVisionCard(card)) {
      const vision = visionCardsLabel();
      return (
        `Error: the current model (${this.modelLabel}) does not support images. ` +
        (vision
          ? `Switch to a vision model (${vision}) to read image files.`
          : 'No vision model is configured for this harness.')
      );
    }
    if (!filePath) {
      return 'Error: read_image requires a "path" argument.';
    }
    let resolved: string;
    try {
      resolved = resolvePath(filePath);
    } catch (err) {
      return `Error: could not resolve image path ${filePath}: ${err instanceof Error ? err.message : String(err)}`;
    }
    let buffer: Buffer;
    try {
      buffer = await fs.promises.readFile(resolved);
    } catch (err) {
      return `Error: could not read image ${resolved}: ${err instanceof Error ? err.message : String(err)}`;
    }
    const miB = MAX_IMAGE_BYTES / 1024 / 1024;
    if (buffer.length > MAX_IMAGE_BYTES) {
      return `Error: image ${resolved} is ${(buffer.length / 1024 / 1024).toFixed(1)} MiB; the limit is ${miB} MiB per image.`;
    }
    const mime = detectImageMime(buffer);
    if (!mime) {
      return `Error: ${resolved} is not a supported image. Supported formats: JPEG, PNG, GIF, WebP.`;
    }
    // The transform sits exactly here: after the cheap checks (an over-size or non-image
    // file must not be decoded) and before the upload (the bytes that ever reach the
    // provider are the small ones). The source's pixel size is read from the header alone,
    // because a `rect` is expressed in source pixels and must be validated against them
    // before anything is decoded.
    const source = readImageSize(buffer, mime);
    let rect: Rect | undefined;
    if (rawRect !== undefined && rawRect !== null) {
      if (!source) {
        // A rect is a claim about pixels. With no size to check it against, honouring it
        // would be a guess and ignoring it would be a silent lie, so it is an ordinary tool
        // error — the same shape as the MAX_IMAGE_BYTES refusal above.
        return (
          `Error: cannot apply a rect to ${resolved}: its pixel size could not be read, and a rect is in source pixels. ` +
          'PNG and JPEG support rect; GIF and WebP are sent as they are.'
        );
      }
      const normalized = normalizeRect(rawRect, source.width, source.height);
      if (!normalized.rect) {
        return (
          `Error: invalid rect for ${resolved} (the image is ${source.width}x${source.height}): ` +
          `${normalized.error ?? 'it leaves no region inside the image.'}`
        );
      }
      rect = normalized.rect;
    }
    let outcome: TransformOutcome | undefined;
    try {
      outcome = await transformImage({ bytes: buffer, mime, rect });
    } catch (err) {
      // The transform is a saving, never a prerequisite: a codec that throws must not turn a
      // read that used to work into a failed turn. `changed` stays false below, so the
      // source bytes ride as they always did and the brake remains the backstop.
      perf(() => `image-transform failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // `changed: false` means the outcome's bytes ARE the input (the transform's contract),
    // so the untouched case keeps both the old bytes and the old sentence.
    const changed = outcome !== undefined && outcome.changed;
    const sentBytes = outcome && changed ? Buffer.from(outcome.bytes) : buffer;
    const sentMime = outcome && changed ? outcome.mime : mime;
    const transform: ImageTransformRecord | undefined =
      outcome && changed
        ? {
            rect: outcome.rect,
            targetMaxSide: IMAGE_TARGET_MAX_SIDE,
            sourceWidth: outcome.sourceWidth,
            sourceHeight: outcome.sourceHeight,
            width: outcome.width,
            height: outcome.height,
          }
        : undefined;
    // What those bytes cost the request: a referenced `file_id` costs the file, while the
    // inline transport base64s the image into the body — four characters per three bytes.
    const inline = card?.vision.transport === 'openai';
    const wireBytes = Math.ceil(sentBytes.length * (inline ? 4 / 3 : 1));
    const refusal = this.imageBudgetRefusal(resolved, wireBytes);
    if (refusal) {
      return refusal;
    }
    // The report that follows the name: the payload's size and, only when the transform
    // changed something, the pixel story the model needs for a later `rect` — the source's
    // size and the region that was kept. Untouched, it is exactly the sentence this tool has
    // always answered with.
    const report = (payloadBytes: number): string =>
      transform
        ? `${(payloadBytes / 1024).toFixed(1)} KiB; ${describeTransform(transform, outcome?.scale ?? 1)}`
        : `${(payloadBytes / 1024).toFixed(1)} KiB`;
    try {
      if (inline) {
        // The card says its provider takes images inline: keep the bytes in the
        // request body instead of uploading them first.
        const url = `data:${sentMime};base64,${sentBytes.toString('base64')}`;
        // Inline, the wire cost is the URL itself (base64), not the image's own size.
        const bytes = url.length;
        this.pendingImages.push({ kind: 'inline', url, path: resolved, bytes, transform });
        this.uploadedThisTurn.set(url, bytes);
        return `Loaded image ${resolved} inline (${report(sentBytes.length)}).`;
      }
      const uploaded = await this.clients.upload(card as ModelCard, sentBytes, path.basename(resolved), signal);
      // The provider's own byte count is what the request will carry, so the budget is
      // recorded from it rather than from our guess at it.
      const bytes = uploaded.bytes > 0 ? uploaded.bytes : sentBytes.length;
      this.pendingImages.push({ kind: 'file', fileId: uploaded.id, path: resolved, bytes, transform });
      this.uploadedThisTurn.set(uploaded.id, bytes);
      // Remember where these bytes came from: a `file_id` is one provider's private
      // handle, so a later epoch that runs on another card can only translate it if the
      // source (here: the local file) is still known (`docs/agents/plans/session-epoch.md` §6).
      this.imageUploads.push({
        fileId: uploaded.id,
        providerId: card?.providerId ?? '',
        path: resolved,
        bytes,
        transform,
      });
      return `Loaded image ${resolved} -> ${uploaded.id} (${uploaded.filename}, ${report(bytes)}).`;
    } catch (err) {
      return `Error: image attach failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * How many of the request's bytes are images. Two contributors, two owners: the provider
   * resolves a part of the frozen history (`bytesOf`), and this agent answers for what it
   * uploaded **this turn** — provenance is written when the turn ends, so a just-uploaded
   * file is invisible to the provider until then. A part neither side can measure counts as
   * 0: an unmeasurable image is a gap in the sum, and the brake prefers an honest
   * under-count to a number nobody can explain. The ceiling's margin (`IMAGE_BUDGET_RATIO`)
   * is what absorbs that gap.
   */
  private imageBytesInUse(): number {
    let total = 0;
    const inHistory = new Set<string>();
    for (const message of this.messages) {
      if (!Array.isArray(message.content)) {
        continue;
      }
      for (const part of message.content) {
        const id = this.imagePartId(part);
        if (id === null) {
          continue;
        }
        inHistory.add(id);
        total += this.imageAccounting?.bytesOf(part) ?? this.uploadedThisTurn.get(id) ?? 0;
      }
    }
    // Uploaded this turn but not yet in the history: the pending block is flushed only after
    // the whole tool batch (`runTurn`), so a second `read_image` in the same batch has to
    // feel the first one's bytes.
    for (const [id, bytes] of this.uploadedThisTurn) {
      if (!inHistory.has(id)) {
        total += bytes;
      }
    }
    return total;
  }

  /**
   * The byte brake (`docs/agents/plans/image-budget.md` §2.2): the tool's answer when the
   * image must **not** be attached, or null when it may be.
   *
   * The limit is the host's `limitBytes` when there is one — it is the transport's own
   * ceiling with the safety margin already taken off — and the same ceiling scaled by
   * {@link IMAGE_BUDGET_RATIO} when there is not. The margin exists because the next request
   * carries whatever is already there: a brake that fires exactly at the wall arrives one
   * image too late, and a false refusal costs one delegation while a false pass costs the
   * whole turn. Nothing is rewritten when it refuses: the model simply does not get the
   * image, and the sentence it gets instead has to be enough to act on. It says how much is
   * in use and what the limit is, forbids describing an image that was never seen and
   * retrying the call that just failed, and names the one real way out — delegating the look
   * to a sub-agent, whose history starts empty and therefore can carry the image this
   * conversation no longer can. An agent that cannot spawn (`depth 2`, or read-only without
   * the fan-out capability, or a session with no sub-agent support at all) has no such way
   * out and is told to report the failure instead; being honest about the dead end is the
   * point.
   */
  private imageBudgetRefusal(path: string, wireBytes: number): string | null {
    const ceiling =
      this.card?.vision.transport === 'openai' ? INLINE_REQUEST_BODY_BYTES : MAX_REQUEST_IMAGE_BYTES;
    // With a host, `limitBytes` is the number to use as given: it is the transport's own
    // ceiling with the margin already taken off (the host owns both because the transport is
    // a property of the card it picked). Without one, the same margin is applied here, so the
    // brake fires in the same place either way.
    const limit = this.imageAccounting?.limitBytes ?? ceiling * IMAGE_BUDGET_RATIO;
    const inUse = this.imageBytesInUse();
    const projected = inUse + wireBytes;
    if (projected <= limit) {
      return null;
    }
    // Only claim a way out the model actually has: the capability flags and the hooks behind
    // them are what `executeToolCall` would answer a `spawn_agents` call with.
    const canSpawn = this.canSpawn && this.spawnHandler !== null;
    const canFanOut = this.canSpawnReadOnly && this.spawnHandler !== null;
    const head =
      `Error: read_image refused ${path}: this request already carries about ${mib(inUse)} of images, and adding this one would make it ${mib(projected)} — over the ${mib(limit)} it is allowed. ` +
      'You have NOT seen this image, so do not describe it or guess at its contents; and do not retry read_image in this conversation — every further call is refused the same way. ';
    if (!canSpawn && !canFanOut) {
      return (
        head +
        'This agent cannot spawn sub-agents (not permitted at this depth or for its capabilities), so there is no way for you to look at the image: stop retrying and report to the user that you could not read it.'
      );
    }
    const tool = canSpawn ? 'spawn_agents' : 'spawn_readonly_agents';
    return (
      head +
      `To look at it, delegate the looking with \`${tool}\`: give the sub-agent an instruction that names the image path(s) and the exact question to answer. ` +
      'A sub-agent starts with an empty history, so it can see images this conversation can no longer carry, and it reports back to you as text. ' +
      'A new context window (the ⧉ rollover) also starts without these images — tell the user that this is the other way forward.'
    );
  }

  /**
   * Stream one assistant response, assembling content and tool calls from the
   * incremental SSE chunks. Emits streamDelta / reasoningDelta / toolCallDelta
   * events for live rendering.
   */
  private async requestAssistantMessage(signal: AbortSignal, imageRetry = 0): Promise<{ message: ChatMessage; indices: number[]; usage?: Usage }> {
    const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>();
    let content = '';
    let reasoning = '';
    let usage: Usage | undefined;

    try {
      const card = this.card;
      if (!card) {
        throw new Error('No model card is configured for this agent.');
      }
      for await (const chunk of this.clients.stream(
        card,
        {
          messages: this.messages,
          tools: this.getTools(),
          signal,
          // The wire model name and the provider come from the card, never from
          // this call site — see `ClientRegistry.stream`.
          thinkingEffort: this.thinkingEffort,
          // The client retries transient failures itself (network / 429 / 5xx);
          // mirror each retry into the status line so a slow retry does not look
          // like a hung turn.
          onRetry: (info) => this.onEvent({ type: 'status', text: retryStatus(info) }),
        },
        // A request that had to wait for a free slot says so instead of looking
        // like a slow model.
        (info) => this.onEvent({ type: 'status', text: queueStatus(info) }),
      )) {
        if (this.isStopped(signal)) {
          throw new Error('interrupted');
        }
        if (chunk.usage) {
          usage = chunk.usage;
        }
        const choice = chunk.choices?.[0];
        if (!choice) {
          continue;
        }

        const delta = choice.delta;
        if (delta?.reasoning_content) {
          if (this.isStopped(signal)) {
            throw new Error('interrupted');
          }
          reasoning += delta.reasoning_content;
          this.onEvent({ type: 'reasoningDelta', content: delta.reasoning_content });
        }
        if (delta?.content) {
          if (this.isStopped(signal)) {
            throw new Error('interrupted');
          }
          content += delta.content;
          this.onEvent({ type: 'streamDelta', content: delta.content });
        }

        if (delta?.tool_calls) {
          for (const call of delta.tool_calls) {
            const existing =
              toolCallMap.get(call.index) ?? { id: call.id ?? `call_${call.index}`, name: '', arguments: '' };
            if (call.id) {
              existing.id = call.id;
            }
            if (call.function?.name) {
              existing.name += call.function.name;
            }
            if (call.function?.arguments) {
              existing.arguments += call.function.arguments;
            }
            toolCallMap.set(call.index, existing);
            // Forward the incremental fragments so the webview can render the
            // tool call being drafted in real time (like streaming thinking).
            this.onEvent({
              type: 'toolCallDelta',
              index: call.index,
              id: existing.id,
              name: call.function?.name,
              args: call.function?.arguments,
            });
          }
        }
      }

      // If the stream returned without throwing (e.g. the reader reached EOF) but
      // Stop was pressed, still treat this as interrupted so no done/assistantDone
      // is emitted and the partial response is discarded.
      if (this.isStopped(signal)) {
        throw new Error('interrupted');
      }
    } catch (err) {
      // A cancellation may surface either as our own 'interrupted' checks above
      // or as a network-level abort thrown by the stream generator. Normalize
      // both into an InterruptedError that carries the partial content/reasoning
      // and any tool call(s) being drafted, so the run loop can preserve them as
      // a checkpoint and name them in the interruption notice.
      if (this.isStopped(signal)) {
        const partialTools = [...toolCallMap.values()]
          .filter((tc) => tc.name)
          .map((tc) => ({ name: tc.name, arguments: tc.arguments }));
        throw new InterruptedError(content, reasoning, partialTools);
      }
      // A provider-side image rejection (e.g. a malformed file that passed the
      // local integrity check) would otherwise 400 every subsequent turn. Hide
      // the offending image from the request body (the stored history keeps it)
      // and retry.
      if (imageRetry < 8 && this.markRejectedImages(err)) {
        this.onEvent({
          type: 'status',
          text: vscode.l10n.t('The provider rejected an image; hiding it and retrying…'),
        });
        return this.requestAssistantMessage(signal, imageRetry + 1);
      }
      throw err;
    }

    // Keep the stream indices alongside the (name-filtered) tool calls so the
    // run loop can map each finalized call back to its draft card.
    const toolCallEntries = [...toolCallMap.entries()].filter(([, tc]) => tc.name);
    const toolCalls: ToolCall[] = toolCallEntries.map(([, tc]) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.arguments },
    }));
    const indices = toolCallEntries.map(([index]) => index);

    this.onEvent({ type: 'assistantDone' });

    // An assistant message must carry either content or tool_calls. When the
    // model emitted only reasoning (thinking) and no answer text, mirror that
    // reasoning into content so the message is API-valid and not lost.
    const hasToolCalls = toolCalls.length > 0;
    const effectiveContent = hasToolCalls ? content : content || reasoning || '';

    return {
      message: {
        role: 'assistant',
        content: effectiveContent || null,
        reasoning_content: reasoning || undefined,
        tool_calls: hasToolCalls ? toolCalls : undefined,
      },
      indices,
      usage,
    };
  }

  /**
   * Detect a provider "unsupported image" 400 and **repair the history itself**: the
   * offending image block becomes its placeholder text part, in the message the turn will
   * store, and the request is retried.
   *
   * This is the one mutation of an already-built history this harness performs, and it is
   * deliberate: the request that carried the image was refused, so nothing past that point
   * was ever cached, and the alternative — hiding the block on every later send — would
   * both rewrite the prefix invisibly and leave the store disagreeing with the wire
   * (`docs/agents/plans/session-epoch.md` §4.5). The repaired text says exactly what the
   * model would otherwise be told, so a reader of the transcript sees the same thing.
   *
   * DeepSeek names the offending message (`.messages[<n>].image[...]`); when it does, only
   * that message's images are replaced, otherwise every image in the history. Returns true
   * when something changed, i.e. when a retry can make progress.
   */
  private markRejectedImages(err: unknown): boolean {
    if (!(err instanceof ApiError) || err.status !== 400) {
      return false;
    }
    if (!/unsupported image/i.test(err.message)) {
      return false;
    }
    const match = /messages\[(\d+)\]/.exec(err.message);
    const named = match ? this.messages[Number(match[1])] : undefined;
    const targets: ChatMessage[] = named ? [named] : this.messages;
    let changed = 0;
    for (const message of targets) {
      if (message.role !== 'user' || !Array.isArray(message.content)) {
        continue;
      }
      const parts = message.content;
      if (!parts.some((part) => this.imagePartId(part) !== null)) {
        continue;
      }
      message.content = parts.map((part): ContentPart => {
        if (this.imagePartId(part) === null) {
          return part;
        }
        changed++;
        return { type: 'text', text: IMAGE_NEEDS_VISION };
      });
    }
    return changed > 0;
  }
}
