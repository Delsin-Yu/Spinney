import * as path from 'path';
import { ChatMessage, StreamChunk, ThinkingEffort, ToolDefinition, UploadedFile, detectImageMime, imageIntegrityError } from './types';
import { perf } from '../perf';

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

/** A single currency balance entry from DeepSeek's `/user/balance` endpoint. */
export interface DeepSeekBalanceEntry {
  currency: string;
  totalBalance: number;
  grantedBalance: number;
  toppedUpBalance: number;
}

/** Wallet balance from DeepSeek's `/user/balance` endpoint (account-level). */
export interface DeepSeekBalance {
  isAvailable: boolean;
  /** One entry per currency DeepSeek reports (e.g. CNY and USD). */
  balances: DeepSeekBalanceEntry[];
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
   * Fetch the account's wallet balance from DeepSeek's `/user/balance` endpoint.
   * Used to show the remaining credit in the UI. Throws `DeepSeekError` on
   * missing key, network failure, or malformed response so the caller can
   * degrade gracefully (i.e. hide the balance) instead of crashing the view.
   */
  async getBalance(): Promise<DeepSeekBalance> {
    if (!this.options.apiKey) {
      throw new DeepSeekError(
        'No DeepSeek API key configured. Set "agentHarness.apiKey" or the DEEPSEEK_API_KEY environment variable.',
      );
    }
    const url = `${this.options.baseUrl.replace(/\/$/, '')}/user/balance`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new DeepSeekError(`Network error fetching balance: ${message}`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new DeepSeekError(`DeepSeek balance error ${response.status}: ${text || response.statusText}`, response.status);
    }
    const data = (await response.json()) as {
      is_available?: boolean;
      balance_infos?: Array<{
        currency?: string;
        total_balance?: string;
        granted_balance?: string;
        topped_up_balance?: string;
      }>;
    };
    const infos = data.balance_infos ?? [];
    if (infos.length === 0) {
      throw new DeepSeekError('DeepSeek balance response is missing balance_infos.');
    }
    return {
      isAvailable: !!data.is_available,
      balances: infos.map((info) => ({
        currency: info.currency ?? 'CNY',
        totalBalance: Number(info.total_balance ?? 0),
        grantedBalance: Number(info.granted_balance ?? 0),
        toppedUpBalance: Number(info.topped_up_balance ?? 0),
      })),
    };
  }

  /**
   * Upload an image to the DeepSeek Files API and return its `file_id` (form
   * `file-api-...`) so a later chat request can reference it with a `file`
   * content block (`{ type: 'file', file_id }`). Using an uploaded file avoids
   * the inline base64 limits: a file referenced by file_id may be up to 64 MiB
   * and does not count against the 48 MiB request-body limit.
   *
   * The image is detected by magic bytes, not by filename/MIME, so we send the
   * raw bytes and let DeepSeek read the format from content. Throws
   * `DeepSeekError` on an unsupported format, an invalid response, or a network
   * failure so the caller can surface a clean message to the agent.
   */
  async uploadFile(bytes: Uint8Array, filename = 'image', signal?: AbortSignal): Promise<UploadedFile> {
    if (!this.options.apiKey) {
      throw new DeepSeekError(
        'No DeepSeek API key configured. Set "agentHarness.apiKey" or the DEEPSEEK_API_KEY environment variable.',
      );
    }
    const mime = detectImageMime(bytes);
    if (!mime) {
      throw new DeepSeekError('Unsupported image format. Supported formats: JPEG, PNG, GIF, WebP.');
    }
    const integrity = imageIntegrityError(bytes);
    if (integrity) {
      throw new DeepSeekError(`Invalid image: ${integrity}.`);
    }

    const url = `${this.options.baseUrl.replace(/\/$/, '')}/files`;
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mime }), path.basename(filename) || filename);
    form.append('purpose', 'user_data');

    let response: Response;
    try {
      // Do NOT set Content-Type: the runtime sets the multipart boundary.
      response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        body: form,
        signal,
      });
    } catch (err) {
      if (signal?.aborted) {
        throw new DeepSeekError('Upload aborted.');
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new DeepSeekError(`Network error uploading image: ${message}`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new DeepSeekError(`DeepSeek files error ${response.status}: ${text || response.statusText}`, response.status);
    }
    const data = (await response.json()) as { id?: string; filename?: string; bytes?: number };
    if (!data.id) {
      throw new DeepSeekError('DeepSeek files response is missing the file id.');
    }
    return {
      id: data.id,
      filename: data.filename ?? path.basename(filename),
      bytes: data.bytes ?? bytes.length,
    };
  }

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
      const serStart = Date.now();
      const payload = JSON.stringify(body);
      perf(`request-json ${Date.now() - serStart}ms bytes=${payload.length} msgs=${messages.length}`);
      const fetchStart = Date.now();
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.apiKey}`,
        },
        body: payload,
        signal,
      });
      perf(`request-headers ${Date.now() - fetchStart}ms status=${response.status}`);
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
      // Check the signal before every read so a cancellation is honoured even
      // if the underlying body stream does not reject on abort. This guarantees
      // we stop the moment Stop is pressed and discard any buffered future data.
      if (signal?.aborted) {
        throw new DeepSeekError('Request aborted.');
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by newlines.
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        // Re-check after every buffered line so already-buffered events do not
        // keep streaming out after the request has been aborted.
        if (signal?.aborted) {
          throw new DeepSeekError('Request aborted.');
        }
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
