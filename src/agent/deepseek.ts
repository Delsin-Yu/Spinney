import * as path from 'path';
import { ChatMessage, StreamChunk, ThinkingEffort, ToolDefinition, UploadedFile, Usage, detectImageMime, imageIntegrityError } from './types';
import { perf } from '../perf';

/**
 * Transparent retry policy for one chat-completions request: the initial attempt
 * plus up to `MAX_ATTEMPTS - 1` retries on a *transient* failure (network error,
 * HTTP 408/429/5xx). Auth/validation failures (400/401/403/404…) are never
 * retried — they cannot fix themselves, and retrying would only hide them.
 * Backoff doubles from `RETRY_BASE_DELAY_MS` and is capped, so the worst case
 * (10 attempts) is ~2.5 minutes; Stop interrupts a pending wait immediately.
 */
const MAX_ATTEMPTS = 10;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;

/** A transient HTTP status worth another attempt; anything else is a refusal. */
function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Backoff before the next attempt (`attempt` is 1-based: the attempt that failed). */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
}

/**
 * A retry about to be made. Reported so the UI can say "retrying (2/10)…"
 * instead of looking hung, and so the output channel records what went wrong.
 */
export interface RetryInfo {
  /** The attempt that failed (1-based): `2` means the second try failed. */
  attempt: number;
  /** Total attempts allowed before giving up. */
  maxAttempts: number;
  /** Milliseconds the client waits before that next attempt. */
  delayMs: number;
  /** One-line reason (HTTP error text / network message), clipped for display. */
  reason: string;
}

export type RetryReporter = (info: RetryInfo) => void;

/** Flatten an error body (which may be multi-line JSON/HTML) into one clipped line. */
function clipReason(reason: string, max = 160): string {
  const oneLine = reason.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** Name the attempt count on an error — but only when retries actually happened. */
function withAttempts(error: DeepSeekError, attempt: number): DeepSeekError {
  return attempt > 1 ? new DeepSeekError(`${error.message} (after ${attempt} attempts)`, error.status) : error;
}

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
  /** Cap the completion length (`max_tokens`). Omitted when not a positive number. */
  maxTokens?: number;
  /** Sampling temperature. Omitted when not a finite number. */
  temperature?: number;
  /**
   * Called before each transparent retry of a transient failure, so the caller
   * can surface "retrying (2/10)…" while it waits out the backoff.
   */
  onRetry?: RetryReporter;
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
   * Update the connection settings **in place**. The same client instance is
   * shared by the main agent and every sub-agent, so installing a new `baseUrl`
   * (or `apiKey`) here — `ChatViewProvider.loadApiKey` / `onConfigurationChanged`
   * — makes it work on the very next request: no window reload, and safe to call
   * mid-turn (each request reads the options when it is built). Fields absent
   * from the patch are kept.
   */
  configure(patch: Partial<DeepSeekOptions>): void {
    if (typeof patch.apiKey === 'string') {
      this.options.apiKey = patch.apiKey;
    }
    if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) {
      this.options.baseUrl = patch.baseUrl;
    }
    if (typeof patch.model === 'string' && patch.model.trim()) {
      this.options.model = patch.model;
    }
  }

  /**
   * Fetch the account's wallet balance from DeepSeek's `/user/balance` endpoint.
   * Used to show the remaining credit in the UI. Throws `DeepSeekError` on
   * missing key, network failure, or malformed response so the caller can
   * degrade gracefully (i.e. hide the balance) instead of crashing the view.
   */
  async getBalance(): Promise<DeepSeekBalance> {
    if (!this.options.apiKey) {
      throw new DeepSeekError(
        'No DeepSeek API key configured. Run the spinney.setApiKey command (or set the DEEPSEEK_API_KEY environment variable).',
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
        'No DeepSeek API key configured. Run the spinney.setApiKey command (or set the DEEPSEEK_API_KEY environment variable).',
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
        'No DeepSeek API key configured. Run the spinney.setApiKey command (or set the DEEPSEEK_API_KEY environment variable).',
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
    if (typeof request.maxTokens === 'number' && request.maxTokens > 0) {
      body.max_tokens = Math.floor(request.maxTokens);
    }
    if (typeof request.temperature === 'number' && Number.isFinite(request.temperature)) {
      body.temperature = request.temperature;
    }

    const payload = JSON.stringify(body);
    perf(() => `request-json bytes=${payload.length} msgs=${messages.length}`);

    // One attempt = open + read. A retry is only transparent while *nothing* has
    // been yielded yet: after the first chunk the caller has already assembled
    // output from it, so re-sending would duplicate what it was told. A failure
    // after that point is therefore fatal, not retried.
    let attempt = 1;
    while (true) {
      const opened = await this.postWithRetry(url, payload, { signal, onRetry: request.onRetry }, attempt);
      attempt = opened.attempt;
      let yielded = false;
      let readError: DeepSeekError | undefined;
      try {
        for await (const chunk of this.readStream(opened.response, signal)) {
          yielded = true;
          yield chunk;
        }
      } catch (err) {
        if (signal?.aborted) {
          throw new DeepSeekError('Request aborted.');
        }
        const message = err instanceof Error ? err.message : String(err);
        readError = new DeepSeekError(`Network error reading DeepSeek stream: ${message}`);
      }
      if (!readError) {
        return;
      }
      if (yielded || !(await this.retryLater(attempt, readError.message, request.onRetry, signal))) {
        throw withAttempts(readError, attempt);
      }
      attempt += 1;
    }
  }

  /**
   * Read one SSE body, yielding parsed chunks. Cancellation is checked before
   * every read **and** after every buffered line, so a Stop discards data that
   * already arrived; the final `data:` line is flushed even when it came without
   * a trailing newline.
   */
  private async *readStream(response: Response, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    if (!response.body) {
      throw new DeepSeekError('DeepSeek returned no response body.');
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

    // The stream ended without a trailing newline: flush the decoder's pending
    // bytes and parse whatever is left, so a final `data:` event is not dropped.
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      const data = tail.slice(5).trim();
      if (data && data !== '[DONE]') {
        try {
          yield JSON.parse(data) as StreamChunk;
        } catch {
          // Ignore malformed JSON from the stream.
        }
      }
    }
  }

  /**
   * POST a JSON body, transparently retrying transient failures (network error,
   * HTTP 408/429/5xx) up to `MAX_ATTEMPTS` total attempts. Returns the successful
   * response together with the attempt that produced it, so a caller that keeps
   * retrying (the streaming reader) can carry the count forward instead of
   * restarting it. Throws the `DeepSeekError` of the last failure — annotated
   * with the attempt count when retries actually happened.
   */
  private async postWithRetry(
    url: string,
    payload: string,
    opts: { signal?: AbortSignal; onRetry?: RetryReporter },
    attemptStart = 1,
  ): Promise<{ response: Response; attempt: number }> {
    let last: DeepSeekError | undefined;
    for (let attempt = attemptStart; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: Response;
      const fetchStart = Date.now();
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.options.apiKey}`,
          },
          body: payload,
          signal: opts.signal,
        });
      } catch (err) {
        if (opts.signal?.aborted) {
          throw new DeepSeekError('Request aborted.');
        }
        const message = err instanceof Error ? err.message : String(err);
        last = new DeepSeekError(`Network error calling DeepSeek: ${message}`);
        if (!(await this.retryLater(attempt, last.message, opts.onRetry, opts.signal))) {
          throw withAttempts(last, attempt);
        }
        continue;
      }
      perf(() => `request-headers ${Date.now() - fetchStart}ms status=${response.status} attempt=${attempt}`);
      if (response.ok && response.body) {
        return { response, attempt };
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        last = new DeepSeekError(
          `DeepSeek API error ${response.status}: ${text || response.statusText}`,
          response.status,
        );
        if (
          !isRetriableStatus(response.status) ||
          !(await this.retryLater(attempt, last.message, opts.onRetry, opts.signal))
        ) {
          throw withAttempts(last, attempt);
        }
        continue;
      }
      // 200 without a body: nothing to read, so the attempt produced no answer.
      last = new DeepSeekError('DeepSeek returned no response body.');
      if (!(await this.retryLater(attempt, last.message, opts.onRetry, opts.signal))) {
        throw withAttempts(last, attempt);
      }
    }
    throw last ?? new DeepSeekError(`DeepSeek request failed after ${MAX_ATTEMPTS} attempts.`);
  }

  /**
   * Announce one retry and wait out its backoff. Returns false when there is no
   * next attempt to make (the attempt budget is spent, or the request was aborted
   * during the wait), so the caller throws instead of looping.
   */
  private async retryLater(
    attempt: number,
    reason: string,
    onRetry?: RetryReporter,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (attempt >= MAX_ATTEMPTS || signal?.aborted) {
      return false;
    }
    const delayMs = retryDelay(attempt);
    onRetry?.({ attempt, maxAttempts: MAX_ATTEMPTS, delayMs, reason: clipReason(reason) });
    perf(() => `[retry] attempt ${attempt + 1}/${MAX_ATTEMPTS} in ${delayMs}ms: ${clipReason(reason)}`);
    return this.sleep(delayMs, signal);
  }

  /** Sleep `ms`, waking immediately (returning false) when the request is aborted. */
  private sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve(false);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve(true);
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Non-streaming completion (`stream: false`), for small side tasks that want a
   * single short answer and no SSE plumbing — e.g. generating a session title.
   * Returns the assistant text ('' when the API answered with nothing) and the
   * usage when the API reported it. Throws `DeepSeekError` like `stream`.
   */
  async complete(request: CompletionRequest): Promise<{ text: string; usage?: Usage }> {
    if (!this.options.apiKey) {
      throw new DeepSeekError(
        'No DeepSeek API key configured. Run the spinney.setApiKey command (or set the DEEPSEEK_API_KEY environment variable).',
      );
    }
    const url = `${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model: request.model && request.model.trim() ? request.model : this.options.model,
      messages: request.messages,
      stream: false,
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools;
    }
    if (request.thinkingEffort && request.thinkingEffort !== 'none') {
      body.reasoning_effort = request.thinkingEffort;
    }
    if (typeof request.maxTokens === 'number' && request.maxTokens > 0) {
      body.max_tokens = Math.floor(request.maxTokens);
    }
    if (typeof request.temperature === 'number' && Number.isFinite(request.temperature)) {
      body.temperature = request.temperature;
    }

    // Same transparent retry policy as `stream` (transient failures only).
    const { response } = await this.postWithRetry(url, JSON.stringify(body), {
      signal: request.signal,
      onRetry: request.onRetry,
    });
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: Usage;
    };
    const text = data.choices?.[0]?.message?.content ?? '';
    return { text: typeof text === 'string' ? text : '', usage: data.usage };
  }
}
