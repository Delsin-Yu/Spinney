import * as fs from 'fs';
import * as path from 'path';
import { DeepSeekClient } from './deepseek';
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
  isVisionModel,
} from './types';
import { perf } from '../perf';

const CORE_PROMPT = [
  '你是一个自主、全能的代理，运行在 Visual Studio Code 工作区里，帮用户处理各类任务：日常沟通、创作型写作、调研、数据处理、编程、跑命令、自动化工作流等。',
  '',
  '## 语言',
  '- 默认简体中文（zh-Hans），主动用中文答；用户用其他语言也保持中文，除非用户明确要求用别的语言。',
  '- 代码、文件路径、命令输出、标识符保持原样，不翻译。',
  '- 中文正文要自然、地道，禁止机翻腔／AI 腔：不生造英文直译的别扭说法（如 take effect→「咬人」、land→「落地」、gate→「闸门」），不中英夹杂、不堆术语、不故作高深；拿不准就写大白话。代码／标识符仍保持英文。',
  '- 默认保持轻松语气；只有安全／医疗／法律／财务、用户明确需求正式、生产事故／正式文档、或会误导时才回到正经回答。',
  '',
  '## 该问就问',
  '- 请求真的含糊（多种理解、缺关键细节、选择会改变结果）时，先问一个短澄清问题，列出最可能的选项，让用户一句话能答；意图清楚就直接做，别瞎猜。',
  '',
  '## 工具',
  '通过函数调用（tool_calls）调工具，一次一个，等结果再走下一步；不要自己写工具 JSON，直接发调用。',
  '- read_file(path, startLine?, endLine?) — 读文件，可选行号范围（从 1 开始）。',
  '- write_file(path, content) — 覆盖写文件（自动建父目录）。',
  '- replace_in_file(path, oldText, newText) — 精确子串替换；oldText 必须只出现一次。',
  '- list_dir(path) — 列目录。',
  '- exec_command(command, cwd?, timeout?, timeout_behavior?) — 在工作区根目录跑 shell 命令；timeout_behavior 取 "stop"（默认，超时即杀掉）/ "move_to_background"（超时转为后台并返回 id）/ "start_in_background"（立刻后台运行并返回 id）。',
  '- check_background_terminal(pid) — 查询后台命令是否还在跑、退出码与已累积输出。',
  '- kill_background(pid) — 杀掉某个后台命令（可随时调）。',
  '- join_background(pid) — 阻塞等待某个后台命令结束并取回完整输出（会响应 Stop）。',
  '- read_image(path) — 读磁盘里的图片给视觉模型看（仅 deepseek-v4-flash-vision-exp / deepseek-v4.1-flash-expires-on-0910 支持；图片会被上传到 Files API 并以 file_id 引用）。',
  '',
  '## 后台终端',
  '- 用 exec_command 的 timeout_behavior=start_in_background / move_to_background 会把耗时命令转为后台终端，并返回一个 id（这是给 agent 用的代号，不是真实 OS pid）。',
  '- 用 check_background_terminal / kill_background / join_background 管理某个 id；join 会阻塞到命令结束，适合“等后台构建跑完再取结果”。',
  '- 后台命令自然结束或被用户杀掉时，harness 会在合适的时机（当前回合结束后）把通知注入给你。',
  '',
  '## 调用规范',
  '- 参数给完整合法 JSON；编辑文件前先读，用 read_file 输出原样作 oldText。',
  '- 命令失败读报错，修深层原因（最小修复）；工具返回后看结果再决定下一步。',
  '- 有依赖的步骤等上一步结果，别并行瞎发；任务做完直接回一句话，不再调工具。',
  '',
  '## 写内容不转义',
  '- 大段/多行内容用 verbatim frame，免得转义换行、引号、反斜杠。',
  '- write_file：JSON 头（path）放前，内容包在标记里：',
  '  { "path": "src/a.ts" }',
  '  <<<RAW:content>>>',
  '  ...原样文本（任意字符、任意换行）...',
  '  <<<END_RAW:content>>>',
  '- replace_in_file：',
  '  { "path": "src/a.ts" }',
  '  <<<RAW:oldText>>>',
  '  ...要匹配的原文...',
  '  <<<END_RAW:oldText>>>',
  '  <<<RAW:newText>>>',
  '  ...替换文本...',
  '  <<<END_RAW:newText>>>',
  '- JSON 头里设 frame:true 走 verbatim；字段名必须完全匹配（content/oldText/newText），大字符串才用 frame。',
  '',
  '## 风格',
  '- 在用户工作区干活，路径可绝对或相对根；回复简洁，解释放回复不放文件。',
  '- 没被要求就不改东西；改多个文件一次一个。',
  '- 用户能看到你的思路和推理，别把推理当隐私藏着。',
].join('\n');

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

/**
 * Tool the vision model can call to look at an image file on disk. Unlike the
 * text tools, the actual image is handed to the model through an injected
 * `user` message — a `tool` message cannot carry an image content block. The
 * image is uploaded to the DeepSeek Files API so the request references the
 * returned `file_id` rather than inlining base64 into the body.
 */
const READ_IMAGE_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_image',
    description:
      'Read an image file from disk and make it visible to the vision model. Path may be absolute or relative to the workspace root. Use this when you need to see or analyze an image file. The image is uploaded to the DeepSeek Files API and referenced by file_id. Only supported by the vision models (deepseek-v4-flash-vision-exp, deepseek-v4.1-flash-expires-on-0910).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the image file.' },
      },
      required: ['path'],
    },
  },
};

/**
 * The main agent can spawn sub-agents. Each spec carries a required `write` flag
 * (true ⇒ the sub-agent may write files and run commands; false ⇒ read-only),
 * an `instruction`, and an optional `model`. `mode` is "sync" (block and return
 * all summaries) or "async" (return immediately, results delivered as notices).
 */
const SPAWN_AGENTS_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'spawn_agents',
    description:
      'Spawn one or more sub-agents as parallel worker branches. Each agent runs its own conversation with a lean prompt and returns a summary. `agents` is an array of { instruction (the task), write (REQUIRED boolean: true allows the sub-agent to write_file / replace_in_file / exec_command; false is read-only: read_file / list_dir / search_files), model (optional; only set a different model when the user explicitly asked you to) }. `mode` is "sync" (default: block until all finish, return every summary) or "async" (return immediately with the agent ids; results are delivered to you as a notice when each finishes).',
    parameters: {
      type: 'object',
      properties: {
        agents: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              instruction: { type: 'string', description: 'The task for this sub-agent.' },
              write: { type: 'boolean', description: 'REQUIRED. true = may write files and run commands; false = read-only.' },
              model: { type: 'string', description: 'Optional different model id. Only set it when the user explicitly asked you to use another model.' },
            },
            required: ['instruction', 'write'],
          },
        },
        mode: { type: 'string', enum: ['sync', 'async'], description: 'sync (default) or async.' },
      },
      required: ['agents'],
    },
  },
};

/**
 * The main agent (or a depth-1 sub-agent) can message an already-finished
 * sub-agent to make it continue: `send_agent_message` appends a follow-up
 * instruction to that sub-agent's own history and re-runs it. `id` is the agent
 * node id returned by a previous `spawn_agents`. `write`/`model` optionally
 * override the run's permission/model (model only for one the user explicitly
 * asked for). `mode` is "sync" (default: block and return the result) or
 * "async" (return immediately; the result is delivered as a notice).
 */
const SEND_AGENT_MESSAGE_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'send_agent_message',
    description:
      'Send a follow-up message to a previously spawned (now finished) sub-agent so it resumes and continues its task, then return the result. `id` is the agent node id from a prior spawn_agents result. `message` is the follow-up instruction. `write` (optional) overrides this run\'s write permission (defaults to the sub-agent\'s original). `model` (optional) overrides the model — only set it when the user explicitly asked for a different model. `mode` is "sync" (default: block and return the result) or "async" (return immediately with the id; the result is delivered as a notice).',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The agent node id from a prior spawn_agents result.',
        },
        message: {
          type: 'string',
          description: 'The follow-up instruction for the sub-agent.',
        },
        write: {
          type: 'boolean',
          description: 'Optional. Override this run\'s write permission.',
        },
        model: {
          type: 'string',
          description: "Optional. Override the model. Only set it when the user explicitly asked for a different model.",
        },
        mode: {
          type: 'string',
          enum: ['sync', 'async'],
          description: 'sync (default) or async.',
        },
      },
      required: ['id', 'message'],
    },
  },
};

/** The identity lines shared by the leading system prompt. */
function identityLines(model: string, effort: ThinkingEffort): string[] {
  const lines: string[] = [
    '你是「Minimal Agent Harness」（agentHarness）——一个自主、全能的代理。',
    '你当前运行在「' + (model || 'deepseek-chat') + '」模型上。',
  ];
  if (effort && effort !== 'none') {
    lines.push('你的推理努力当前设为「' + effort + '」。');
  }
  return lines;
}

/** Snapshot of the workspace AGENTS.md appended to the system prompt. Set once per session. */
let agentsMdSnapshot: string | null = null;

/**
 * Build the leading system prompt: the agent's identity (model + reasoning
 * effort) followed by the core instructions and, if present, the workspace
 * AGENTS.md snapshot. This is the first message and, on a model/effort switch,
 * it is rewritten in place to keep the identity authoritative.
 */
function buildSystemPrompt(model: string, effort: ThinkingEffort): string {
  const base = identityLines(model, effort).join('\n') + '\n\n' + CORE_PROMPT;
  const agentsMd = agentsMdSnapshot?.trim();
  if (agentsMd) {
    return base + '\n\n## 工作区 AGENTS.md（项目说明）\n' + agentsMd;
  }
  return base;
}

export class Agent {
  /**
   * Set a snapshot of the workspace AGENTS.md to be appended to the system
   * prompt. Call this once when a session starts so the appended instructions
   * are fixed for the session; later edits to AGENTS.md do not propagate to the
   * prompt. Pass null (or omit the call) when no AGENTS.md is present.
   */
  static setAgentsMd(content: string | null): void {
    agentsMdSnapshot = content;
  }

  /** Fresh conversation history consisting of just the system prompt. */
  static initialMessages(model = '', effort: ThinkingEffort = 'none'): ChatMessage[] {
    return [{ role: 'system', content: buildSystemPrompt(model, effort) }];
  }

  /** The current system prompt (used to refresh persisted sessions). */
  static systemPrompt(model = '', effort: ThinkingEffort = 'none'): string {
    return buildSystemPrompt(model, effort);
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
      // reasoning), drop it entirely.
      if (msg.role === 'assistant' && !msg.content && (!msg.tool_calls || msg.tool_calls.length === 0)) {
        if (msg.reasoning_content) {
          msg.content = msg.reasoning_content;
          msg.reasoning_content = undefined;
        } else {
          continue;
        }
      }

      result.push(msg);

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
  /** Whether this agent may spawn sub-agents (a depth-2 sub-agent may not). */
  private canSpawn = true;

  constructor(
    private readonly client: DeepSeekClient,
    private readonly tools: ToolRegistry,
    private readonly onEvent: (event: AgentEvent) => void,
    private readonly maxTurns = 20,
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

  /** Set a provider hook that runs sub-agents for the `spawn_agents` tool. */
  setSpawnHandler(handler: ((args: Record<string, unknown>, signal: AbortSignal) => Promise<string>) | null): void {
    this.spawnHandler = handler;
  }

  /** Set a provider hook that resumes a finished sub-agent for `send_agent_message`. */
  setSendMessageHandler(handler: ((args: Record<string, unknown>, signal: AbortSignal) => Promise<string>) | null): void {
    this.sendMessageHandler = handler;
  }

  /** Allow/deny this agent from spawning sub-agents (a depth-2 agent may not). */
  setCanSpawn(v: boolean): void {
    this.canSpawn = v;
  }

  /**
   * Rewrite the leading system prompt to the current identity (model + effort).
   * The core instructions (CORE_PROMPT) are identical every time, so only the
   * identity line is updated; the rest of the conversation history is preserved.
   * Switching is applied in place because it invalidates the prompt cache anyway
   * and the first message is the most authoritative identity signal.
   */
  private refreshSystemIdentity(): void {
    if (this.messages[0]?.role === 'system') {
      this.messages[0].content = buildSystemPrompt(this.model, this.thinkingEffort);
    }
  }

  reset(): void {
    this.messages = Agent.initialMessages(this.model, this.thinkingEffort);
    this.pendingImageFiles = [];
  }

  /**
   * Lean system prompt for a sub-agent: a compact worker identity instead of the
   * full CORE_PROMPT + AGENTS.md (saves tokens), followed by a note that it was
   * dispatched by the main agent.
   */
  static subAgentSystemPrompt(model = '', effort: ThinkingEffort = 'none', depth = 1, write = false): string {
    const id = identityLines(model, effort);
    const mode = write
      ? 'you may read, search, write files, and run commands.'
      : 'you are read-only: you may read and search files, but may NOT write files or run commands.';
    return (
      id.join('\n') +
      '\n\n你是「子代理」——由主 agent 派遣的一个独立工作单元' +
      (depth === 2 ? '（子-子代理）' : '') +
      '。你的目标是把分配给你的任务做完并给出简洁结论；' +
      mode +
      '\n- 用中文回答；保持简洁，把结论写清楚。' +
      '\n- 你只对派发你的 agent 汇报，不要主动越权改别的文件。'
    );
  }

  /** Tool definitions exposed to the model: the registry plus read_image and,
   * for agents that may spawn, spawn_agents + send_agent_message. */
  private getTools(): ToolDefinition[] {
    return [
      ...this.tools.definitions,
      READ_IMAGE_TOOL,
      ...(this.canSpawn ? [SPAWN_AGENTS_TOOL, SEND_AGENT_MESSAGE_TOOL] : []),
    ];
  }

  /**
   * The message history as it should be sent to the API for the current model.
   * Image content blocks (`image_url` / `file`) are only valid on the vision
   * model; when a text-only model is active we send a copy in which each image
   * block is replaced by a short placeholder so the request does not 400. The
   * stored history is never modified, so switching back to the vision model
   * restores the original image blocks.
   */
  private messagesForCurrentModel(): ChatMessage[] {
    if (isVisionModel(this.model)) {
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
      return {
        ...m,
        content: parts.map((p): ContentPart => {
          if (p.type === 'image_url' || p.type === 'file') {
            return { type: 'text', text: '[image hidden: the current model does not support images]' };
          }
          return p;
        }),
      };
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
        this.lastTurnInterrupted = true;
        this.lastInterruptedTools = this.captureInterruptedToolCalls(err);
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
      result = this.spawnHandler
        ? await this.spawnHandler(args, signal)
        : 'Error: sub-agents are not available in this session.';
    } else if (call.function.name === 'send_agent_message') {
      // Resuming a finished sub-agent is also the provider's job. Delegate; the
      // result (a resume confirmation or, in sync mode, the follow-up outcome)
      // is returned as the tool result.
      const args = parseToolArgs(call.function.arguments);
      result = this.sendMessageHandler
        ? await this.sendMessageHandler(args, signal)
        : 'Error: sub-agent messaging is not available in this session.';
    } else {
      result = await this.tools.execute(call.function.name, call.function.arguments, signal);
    }
    perf(
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
      return (
        `Error: the current model (${this.model || 'default'}) does not support images. ` +
        'Switch to a vision model (deepseek-v4-flash-vision-exp or deepseek-v4.1-flash-expires-on-0910) to read image files.'
      );
    }
    if (!filePath) {
      return 'Error: read_image requires a "path" argument.';
    }
    const resolved = resolvePath(filePath);
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
  private async requestAssistantMessage(signal: AbortSignal): Promise<{ message: ChatMessage; indices: number[]; usage?: Usage }> {
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
}
