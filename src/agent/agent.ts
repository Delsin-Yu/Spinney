import { DeepSeekClient } from './deepseek';
import { ToolRegistry } from '../tools';
import { AgentEvent, ChatMessage, ContentPart, ThinkingEffort, ToolCall, Usage } from './types';

const CORE_PROMPT = [
  'You are an autonomous, all-purpose agent running inside a Visual Studio Code workspace.',
  'Help the user with any agentic task — coding, debugging, research, data or file work,',
  'running commands, automating workflows, and more — using the tools available to you.',
  '',
  '## Language',
  '- Always reply in Simplified Chinese (zh-Hans).',
  '- Keep code, file paths, command output, and identifiers in their original form.',
  '',
  '## Available tools',
  'You invoke tools through function calling (tool_calls). Call one tool at a time and wait for',
  'its result before deciding the next step. Do not write the tool JSON yourself — emit a tool call.',
  '',
  '- read_file(path, startLine?, endLine?) — read a file, optionally a 1-based line range.',
  '- write_file(path, content) — overwrite a file (creates parent directories).',
  '- replace_in_file(path, oldText, newText) — replace one exact substring; oldText must appear exactly once.',
  '- list_dir(path) — list the entries of a directory.',
  '- exec_command(command, cwd?, timeout?) — run a shell command in the workspace root.',
  '',
  '## How to make tool calls',
  '- Use function calling to invoke a tool; provide complete, valid JSON arguments.',
  '- Read a file before editing it, and confirm the exact existing text before replace_in_file.',
  '- If a command fails, read the error and fix the underlying cause. Prefer the smallest fix.',
  '- After a tool returns, inspect its result, then decide the next action.',
  '- When a later step depends on an earlier result, wait for that result before calling the next tool.',
  '- Keep calling tools as needed; when the task is done, reply to the user directly with no tool call.',
  '',
  '## Style',
  '- Work inside the user\'s workspace. Paths may be absolute or relative to the workspace root.',
  '- Keep visible replies concise. Put explanation in the reply, not in the files.',
  '- When you change several files, do them one at a time.',
].join('\n');

/**
 * Build the system prompt, telling the model who it is (identity + active model
 * and reasoning effort). Changing the model/effort rebuilds this prompt, which
 * is the first message of every request.
 */
function buildSystemPrompt(model: string, effort: ThinkingEffort): string {
  const lines: string[] = [
    'You are the "Minimal Agent Harness" (agentHarness) — an autonomous, all-purpose coding agent.',
    'You are currently running on the "' + (model || 'deepseek-chat') + '" model.',
  ];
  if (effort && effort !== 'none') {
    lines.push('Your reasoning effort is currently set to "' + effort + '".');
  }
  return lines.join('\n') + '\n\n' + CORE_PROMPT;
}

export class Agent {
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
  private model = '';
  private thinkingEffort: ThinkingEffort = 'none';

  constructor(
    private readonly client: DeepSeekClient,
    private readonly tools: ToolRegistry,
    private readonly onEvent: (event: AgentEvent) => void,
    private readonly maxTurns = 20,
  ) {
    this.reset();
  }

  /** Set the model used for subsequent completions (also refreshes identity). */
  setModel(model: string): void {
    this.model = model;
    this.applySystemIdentity();
  }

  /** Set the reasoning-effort mode for subsequent completions. */
  setThinkingEffort(effort: ThinkingEffort): void {
    this.thinkingEffort = effort;
    this.applySystemIdentity();
  }

  /** Refresh the assistant identity (model + effort) in the system message. */
  private applySystemIdentity(): void {
    if (this.messages[0]?.role === 'system') {
      this.messages[0].content = buildSystemPrompt(this.model, this.thinkingEffort);
    }
  }

  reset(): void {
    this.messages = Agent.initialMessages(this.model, this.thinkingEffort);
  }

  /** Replace the conversation history (used when switching sessions). */
  setMessages(messages: ChatMessage[]): void {
    this.messages = messages;
    this.applySystemIdentity();
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  cancel(): void {
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
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    // Everything appended during this turn; roll back on failure.
    this.messages.push({ role: 'user', content });
    const turnStartIndex = this.messages.length;

    void this.runTurn(signal, turnStartIndex);
  }

  private async runTurn(signal: AbortSignal, turnStartIndex: number): Promise<void> {
    try {
      let toolTurnCount = 0;
      while (true) {
        if (signal.aborted) {
          throw new Error('interrupted');
        }

        this.onEvent({ type: 'status', text: 'Thinking…' });
        const assistant = await this.requestAssistantMessage(signal);
        const iterationStart = this.messages.length;
        this.messages.push(assistant);

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

          for (const call of assistant.tool_calls) {
            if (signal.aborted) {
              throw new Error('interrupted');
            }
            await this.executeToolCall(call, signal);
          }
          continue;
        }

        // No tool calls: final answer is done.
        this.onEvent({ type: 'status', text: 'Done' });
        this.onEvent({ type: 'done' });
        return;
      }
    } catch (err) {
      // Roll back any partial assistant/tool messages added this turn so the
      // transcript stays consistent for the next request.
      this.messages.splice(turnStartIndex);

      if (signal.aborted) {
        this.onEvent({ type: 'interrupted' });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.onEvent({ type: 'error', message });
    } finally {
      this.isRunning = false;
      this.abortController = null;
    }
  }

  private async executeToolCall(call: ToolCall, signal: AbortSignal): Promise<void> {
    this.onEvent({ type: 'toolStart', id: call.id, name: call.function.name, args: call.function.arguments });
    const result = await this.tools.execute(call.function.name, call.function.arguments, signal);
    this.onEvent({ type: 'toolEnd', id: call.id, name: call.function.name, content: result });
    this.messages.push({ role: 'tool', tool_call_id: call.id, content: result });
  }

  /**
   * Stream one assistant response, assembling content and tool calls from the
   * incremental SSE chunks. Emits streamDelta events for live text.
   */
  private async requestAssistantMessage(signal: AbortSignal): Promise<ChatMessage> {
    const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>();
    let content = '';
    let reasoning = '';
    let usage: Usage | undefined;

    for await (const chunk of this.client.stream({
      messages: this.messages,
      tools: this.tools.definitions,
      signal,
      model: this.model || undefined,
      thinkingEffort: this.thinkingEffort,
    })) {
      if (chunk.usage) {
        usage = chunk.usage;
      }
      const choice = chunk.choices?.[0];
      if (!choice) {
        continue;
      }

      const delta = choice.delta;
      if (delta?.reasoning_content) {
        reasoning += delta.reasoning_content;
        this.onEvent({ type: 'reasoningDelta', content: delta.reasoning_content });
      }
      if (delta?.content) {
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
        }
      }
    }

    const toolCalls: ToolCall[] = [...toolCallMap.values()]
      .filter((tc) => tc.name)
      .map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      }));

    if (usage) {
      this.onEvent({ type: 'usage', usage });
    }
    this.onEvent({ type: 'assistantDone' });

    return {
      role: 'assistant',
      content: content || null,
      reasoning_content: reasoning || undefined,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }
}
