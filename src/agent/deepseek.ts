import { ChatMessage, StreamChunk, ThinkingEffort, ToolDefinition } from './types';

export interface DeepSeekOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  /** Override the model for this request. Defaults to the client's configured model. */
  model?: string;
  /** Reasoning effort for this request. Omitted when 'none' / undefined. */
  thinkingEffort?: ThinkingEffort;
}

export class DeepSeekError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'DeepSeekError';
  }
}

/**
 * Minimal, dependency-free client for the OpenAI-compatible DeepSeek chat
 * completions endpoint. Uses the global `fetch` available in the VS Code
 * Node.js runtime (Node 18+).
 */
export class DeepSeekClient {
  constructor(private readonly options: DeepSeekOptions) {}

  /**
   * Stream a chat completion. Yields raw SSE payload chunks (parsed from JSON)
   * for callers to assemble into assistant text and tool calls.
   */
  async *stream(request: CompletionRequest): AsyncGenerator<StreamChunk> {
    const { messages, tools, signal } = request;
    if (!this.options.apiKey) {
      throw new DeepSeekError(
        'No DeepSeek API key configured. Set "agentHarness.apiKey" or the DEEPSEEK_API_KEY environment variable.',
      );
    }

    const url = `${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model: request.model && request.model.trim() ? request.model : this.options.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
    }
    if (request.thinkingEffort && request.thinkingEffort !== 'none') {
      body.reasoning_effort = request.thinkingEffort;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) {
        throw new DeepSeekError('Request aborted.');
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new DeepSeekError(`Network error calling DeepSeek: ${message}`);
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw new DeepSeekError(
        `DeepSeek API error ${response.status}: ${text || response.statusText}`,
        response.status,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by newlines.
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');

        if (!line.startsWith('data:')) {
          continue;
        }
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          return;
        }
        try {
          yield JSON.parse(data) as StreamChunk;
        } catch {
          // Ignore malformed JSON from the stream.
        }
      }
    }
  }
}
