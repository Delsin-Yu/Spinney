import * as fs from 'fs';
import * as path from 'path';
import { DeepSeekClient, DeepSeekError, RetryInfo } from './deepseek';
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
import { DEFAULT_MODEL, isVisionModel, visionModelsLabel } from './models';
import * as prompt from './prompt';
import { ToolCapabilities, interceptedDefinitions } from './tools';
import { perf } from '../perf';

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
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
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
  return `Model call failed (${info.attempt}/${info.maxAttempts}); retrying in ${seconds}…`;
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
  static initialMessages(model = '', effort: ThinkingEffort = 'none'): ChatMessage[] {
    return [{ role: 'system', content: prompt.systemPrompt(model, effort) }];
  }

  /** The current system prompt (used to refresh persisted sessions). */
  static systemPrompt(model = '', effort: ThinkingEffort = 'none'): string {
    return prompt.systemPrompt(model, effort);
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
  /** Files uploaded by read_image this turn; flushed as a user content block. */
  private pendingImageFiles: Array<{ file_id: string; path: string }> = [];
  private model = '';
  private thinkingEffort: ThinkingEffort = 'none';
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
   * Images the provider rejected as unsupported (by `file_id` / `image_url`).
   * They are hidden from every request body rather than deleted from the stored
   * history, mirroring how a non-vision model hides images. Ids are unique per
   * upload, so keeping them across session switches is harmless and avoids
   * re-triggering the same 400 on every turn.
   */
  private rejectedImageIds = new Set<string>();

  constructor(
    private readonly client: DeepSeekClient,
    private readonly tools: ToolRegistry,
    private readonly onEvent: (event: AgentEvent) => void,
    private maxTurns = 20,
  ) {
    this.reset();
  }

  /** Set the model used for subsequent completions. */
  setModel(model: string): void {
    this.model = model;
    this.refreshSystemIdentity();
  }

  /** Set the reasoning-effort mode for subsequent completions. */
  setThinkingEffort(effort: ThinkingEffort): void {
    this.thinkingEffort = effort;
    this.refreshSystemIdentity();
  }

  /**
   * Set the tool-round limit for subsequent turns (`spinney.maxTurns` may
   * change while the window is open). A non-positive/non-finite value is ignored
   * so a bad setting cannot disable the loop guard entirely.
   */
  setMaxTurns(maxTurns: number): void {
    if (Number.isFinite(maxTurns) && maxTurns > 0) {
      this.maxTurns = Math.floor(maxTurns);
    }
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
   * Rewrite the leading system prompt to the current identity (model + effort).
   * The instructions are identical every time, so only the identity/environment
   * lines are updated; the rest of the conversation history is preserved.
   * Switching is applied in place because it invalidates the prompt cache anyway
   * and the first message is the most authoritative identity signal.
   */
  private refreshSystemIdentity(): void {
    if (this.messages[0]?.role === 'system') {
      this.messages[0].content = prompt.systemPrompt(this.model, this.thinkingEffort);
    }
  }

  reset(): void {
    this.messages = Agent.initialMessages(this.model, this.thinkingEffort);
    this.pendingImageFiles = [];
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
      vision: isVisionModel(this.model),
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
    return [...this.tools.definitions, ...interceptedDefinitions(this.toolCapabilities())];
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

  /**
   * The message history as it should be sent to the API for the current model.
   * Image content blocks (`image_url` / `file`) are only valid on the vision
   * model; when a text-only model is active we send a copy in which each image
   * block is replaced by a short placeholder so the request does not 400.
   * Images the provider itself rejected are replaced the same way, for every
   * model. The stored history is never modified, so switching models restores
   * the original image blocks (a provider-rejected one stays hidden).
   */
  private messagesForCurrentModel(): ChatMessage[] {
    const vision = isVisionModel(this.model);
    if (vision && this.rejectedImageIds.size === 0) {
      return this.messages;
    }
    return this.messages.map((m) => {
      if (m.role !== 'user' || typeof m.content === 'string' || !Array.isArray(m.content)) {
        return m;
      }
      const parts = m.content;
      if (!parts.some((p) => p.type === 'image_url' || p.type === 'file')) {
        return m;
      }
      let changed = false;
      const content = parts.map((p): ContentPart => {
        const id = this.imagePartId(p);
        if (id === null) {
          return p;
        }
        if (!vision) {
          changed = true;
          return { type: 'text', text: '[image hidden: the current model does not support images]' };
        }
        if (this.rejectedImageIds.has(id)) {
          changed = true;
          return { type: 'text', text: '[image removed: the provider rejected it as unsupported]' };
        }
        return p;
      });
      return changed ? { ...m, content } : m;
    });
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
    // Discard any image uploaded in a previously interrupted turn (it was never
    // flushed as a user block, so it must not leak into this turn).
    this.pendingImageFiles = [];
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
      let toolTurnCount = 0;
      while (true) {
        if (this.isStopped(signal)) {
          throw new Error('interrupted');
        }

        this.onEvent({ type: 'status', text: 'Thinking…' });
        const reqStart = Date.now();
        const { message: assistant, indices, usage } = await this.requestAssistantMessage(signal);
        perf(
          () =>
            `assistant-round ${Date.now() - reqStart}ms msgs=${this.messages.length} ` +
            `tools=${assistant.tool_calls?.length ?? 0} ` +
            `chars=${typeof assistant.content === 'string' ? assistant.content.length : 0}`,
        );
        const iterationStart = this.messages.length;
        // Never retain an assistant message the API would reject: a turn must
        // carry content or tool_calls. A completely empty response (no content,
        // no reasoning, no tool_calls) has nothing worth keeping in history.
        const hasToolCalls = !!(assistant.tool_calls && assistant.tool_calls.length > 0);
        const hasContent = typeof assistant.content === 'string' && assistant.content.trim().length > 0;
        if (hasToolCalls || hasContent) {
          this.messages.push(assistant);
        }

        if (assistant.tool_calls && assistant.tool_calls.length > 0) {
          toolTurnCount++;
          if (toolTurnCount > this.maxTurns) {
            // Roll back the just-added assistant message that carries tool_calls
            // (without its tool responses) so the persisted transcript stays valid
            // across restarts and never triggers a 400 on resume.
            this.messages.splice(iterationStart);
            this.onEvent({
              type: 'status',
              text: `Stopped after ${this.maxTurns} tool rounds (loop limit).`,
            });
            this.onEvent({ type: 'done' });
            return;
          }

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
          if (this.pendingImageFiles.length > 0) {
            this.messages.push({
              role: 'user',
              content: [
                { type: 'text', text: 'Image(s) requested via read_image:' },
                ...this.pendingImageFiles.map((f) => ({ type: 'file' as const, file_id: f.file_id })),
              ],
            });
            this.pendingImageFiles.length = 0;
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
        this.onEvent({ type: 'status', text: 'Done' });
        this.onEvent({ type: 'done' });
        return;
      }
    } catch (err) {
      // Any image uploaded this turn but not flushed must be discarded (it would
      // otherwise leak into the next turn's tool window).
      this.pendingImageFiles = [];
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
    this.onEvent({
      type: 'toolStart',
      id: call.id,
      name: call.function.name,
      args: call.function.arguments,
      index,
    });
    const t0 = Date.now();
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
    perf(
      () =>
        `tool ${call.function.name} ${Date.now() - t0}ms args=${call.function.arguments.length} ` +
        `result=${result.length}`,
    );
    this.onEvent({ type: 'toolEnd', id: call.id, name: call.function.name, content: result });
    this.messages.push({ role: 'tool', tool_call_id: call.id, content: result });
  }

  /**
   * Handle the read_image tool call: read the file, upload it to the DeepSeek
   * Files API, and queue the returned file_id for injection as a user content
   * block after all tool responses are pushed (see runTurn). The `tool` message
   * itself carries only a short confirmation, never the image bytes.
   */
  private async executeReadImage(call: ToolCall, signal: AbortSignal, index?: number): Promise<void> {
    this.onEvent({
      type: 'toolStart',
      id: call.id,
      name: 'read_image',
      args: call.function.arguments,
      index,
    });

    let imagePath = '';
    try {
      const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      imagePath = String(args.path ?? '');
    } catch {
      imagePath = '';
    }

    const result = await this.tryReadImage(imagePath, signal);
    this.onEvent({ type: 'toolEnd', id: call.id, name: 'read_image', content: result });
    this.messages.push({ role: 'tool', tool_call_id: call.id, content: result });
  }

  /** Read + validate an image file and upload it, or return a friendly error. */
  private async tryReadImage(filePath: string, signal?: AbortSignal): Promise<string> {
    if (!isVisionModel(this.model)) {
      const vision = visionModelsLabel();
      return (
        `Error: the current model (${this.model || DEFAULT_MODEL}) does not support images. ` +
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
    if (buffer.length > 64 * 1024 * 1024) {
      return `Error: image ${resolved} is ${(buffer.length / 1024 / 1024).toFixed(1)} MiB; the Files API allows at most 64 MiB per image.`;
    }
    if (!detectImageMime(buffer)) {
      return `Error: ${resolved} is not a supported image. Supported formats: JPEG, PNG, GIF, WebP.`;
    }
    try {
      const uploaded = await this.client.uploadFile(buffer, path.basename(resolved), signal);
      this.pendingImageFiles.push({ file_id: uploaded.id, path: resolved });
      return `Loaded image ${resolved} -> ${uploaded.id} (${uploaded.filename}, ${(uploaded.bytes / 1024).toFixed(1)} KiB).`;
    } catch (err) {
      return `Error: upload failed: ${err instanceof Error ? err.message : String(err)}`;
    }
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
      for await (const chunk of this.client.stream({
        messages: this.messagesForCurrentModel(),
        tools: this.getTools(),
        signal,
        model: this.model || undefined,
        thinkingEffort: this.thinkingEffort,
        // The client retries transient failures itself (network / 429 / 5xx);
        // mirror each retry into the status line so a slow retry does not look
        // like a hung turn.
        onRetry: (info) => this.onEvent({ type: 'status', text: retryStatus(info) }),
      })) {
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
        this.onEvent({ type: 'status', text: 'The provider rejected an image; hiding it and retrying…' });
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
   * Detect a provider "unsupported image" 400 and record the offending
   * image(s) so `messagesForCurrentModel` hides them on every later request.
   * DeepSeek names the offending message (`.messages[<n>].image[...]`); when it
   * does, only that message's images are recorded, otherwise every image in the
   * history. The stored history is left untouched. Returns true when a new
   * image was recorded, i.e. when a retry can make progress.
   */
  private markRejectedImages(err: unknown): boolean {
    if (!(err instanceof DeepSeekError) || err.status !== 400) {
      return false;
    }
    if (!/unsupported image/i.test(err.message)) {
      return false;
    }
    const match = /messages\[(\d+)\]/.exec(err.message);
    const named = match ? this.messages[Number(match[1])] : undefined;
    const targets: ChatMessage[] = named ? [named] : this.messages;
    let added = 0;
    for (const message of targets) {
      if (message.role !== 'user' || !Array.isArray(message.content)) {
        continue;
      }
      for (const part of message.content) {
        const id = this.imagePartId(part);
        if (id !== null && !this.rejectedImageIds.has(id)) {
          this.rejectedImageIds.add(id);
          added++;
        }
      }
    }
    return added > 0;
  }
}
