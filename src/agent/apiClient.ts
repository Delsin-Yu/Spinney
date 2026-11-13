import * as path from 'path';
import { ChatMessage, StreamChunk, ThinkingEffort, ToolDefinition, UploadedFile, Usage, detectImageMime, imageIntegrityError } from './types';
import { perf } from '../perf';
import { clipText, wellFormedDeep } from '../text';
import { describeFetchError } from './netError';

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

/**
 * A transient HTTP status worth another attempt; anything else is a refusal.
 *
 * Exported for the agent's **turn-level** ladder (`shouldReissueTransparently` in
 * `agent.ts`), which re-issues the whole request once this per-attempt ladder is
 * exhausted: the two must agree on what "transient" means, or a 400 would be
 * re-sent from above after this client already decided it was fatal.
 */
export function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Backoff before the next attempt (`attempt` is 1-based: the attempt that failed). */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
}

/**
 * Stall watchdogs for one attempt. The retry policy above only ever reacts to an
 * **error**, and a connection that goes quiet neither errors nor ends: without
 * these timers the only thing that can end such a request is the user pressing
 * Stop, which is exactly the "first answer takes forever, Stop + Continue fixes
 * it" symptom. The healthy baseline is narrow — over ~1000 logged requests the
 * time from send to response headers was 0.5–3.4 s (p99 ≈ 2.9 s) — so a much
 * longer silence is an anomaly, and aborting it is safe: the abort tears the
 * socket down, so the retry leaves on a connection that is known to be fresh.
 */
const FIRST_BYTE_TIMEOUT_MS = 20_000;
/**
 * The first request after a long silence is the one most likely to be handed a
 * pooled keep-alive socket the provider already dropped while the window sat
 * idle, so it gets the shorter budget: fail fast, retry, and be done in ~13 s
 * instead of hanging until the user notices.
 */
const FIRST_BYTE_TIMEOUT_AFTER_IDLE_MS = 12_000;
/** Headers arrived but no payload: still retriable, nothing has been yielded yet. */
const FIRST_CHUNK_TIMEOUT_MS = 20_000;
/** Silence *inside* an answer (thoughts and tool args pulse every ~50 ms). */
const STREAM_IDLE_TIMEOUT_MS = 60_000;
/** No request for this long counts as "the client was idle" (see the header budget). */
const IDLE_GAP_MS = 60_000;
/** While a request waits for its first byte, say so at this cadence. */
const SLOW_HEADERS_NOTICE_MS = 5_000;

/**
 * One attempt's own signal: the caller's Stop **plus** the watchdogs of this
 * attempt. They have to stay separate signals, because the retry policy keys on
 * the *caller's*: `opts.signal.aborted` means "the user stopped the run — never
 * retry", while a watchdog abort means "this connection went quiet — worth
 * another try on a fresh socket". Aborting this one tears the attempt's socket
 * down without touching the caller's run.
 */
interface AttemptWatch {
  controller: AbortController;
  /** The signal the request is sent on and its body is read on. */
  signal: AbortSignal;
  /** Why a watchdog ended the attempt; undefined while the attempt is healthy. */
  stalled?: string;
  /** Drop the listener on the caller's signal once the attempt is over. */
  detach(): void;
}

function watchAttempt(outer?: AbortSignal): AttemptWatch {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (outer) {
    if (outer.aborted) {
      controller.abort();
    } else {
      outer.addEventListener('abort', onAbort, { once: true });
    }
  }
  return {
    controller,
    signal: controller.signal,
    detach: () => outer?.removeEventListener('abort', onAbort),
  };
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
  return oneLine.length > max ? clipText(oneLine, max) : oneLine;
}

/** Name the attempt count on an error — but only when retries actually happened. */
function withAttempts(error: ApiError, attempt: number): ApiError {
  return attempt > 1 ? new ApiError(`${error.message} (after ${attempt} attempts)`, error.status) : error;
}

/**
 * How a provider is told **which conversation** a request belongs to, when it asks for
 * one. It is the third per-row declaration of this kind (after a card's image transport
 * and a provider's wallet dialect), and like the other two it is a declaration and never
 * a probe: the user is the one who knows which endpoint they pointed at.
 *
 * `opencode` is the OpenCode Console gateway, whose "Go" plan **requires** a stable
 * `x-opencode-session: ses_…` on every request so it can route a conversation
 * consistently and reuse its prompt cache. `none` sends no such header — the honest
 * answer for an OpenAI-compatible endpoint that never asked for one.
 */
export type SessionDialect = 'none' | 'opencode';

/** Every value `sessionHeader` accepts, in the order the settings schema offers them. */
export const SESSION_DIALECTS: readonly SessionDialect[] = ['none', 'opencode'];

/**
 * True when the value is one of the dialects. The settings parser owns the call: a row
 * that names an unknown dialect is refused rather than silently sent without a header.
 */
export function isSessionDialect(value: unknown): value is SessionDialect {
  return typeof value === 'string' && (SESSION_DIALECTS as readonly string[]).includes(value);
}

/**
 * What this client calls itself on the wire when nothing installed a version. A coding
 * agent is asked to identify itself rather than look like a generic HTTP library, so
 * every request carries `spinney/<version>` — see {@link ClientOptions.userAgent}.
 */
export const DEFAULT_USER_AGENT = 'spinney';

export interface ClientOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Which conversation header this endpoint takes (`ProviderSpec.sessionHeader`). */
  sessionHeader?: SessionDialect;
  /**
   * What the client calls itself on the wire (`spinney/<version>`, installed at
   * activation from the package manifest). Absent means {@link DEFAULT_USER_AGENT}.
   */
  userAgent?: string;
}

/**
 * The endpoint a chat request goes to: `<baseUrl>/chat/completions`, with one trailing
 * slash tolerated. Exported because `Spinney: Show Request Payload` reports the URL it
 * would send (`SessionRuntime.requestPayload`), and a second spelling of the same
 * endpoint would make that report a lie.
 */
export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/chat/completions`;
}

/** Everything {@link buildChatRequestBody} needs. The model is already resolved. */
export interface ChatRequestBodyInput {
  /** The wire model name, resolved by the caller — it becomes `body.model` verbatim. */
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** Omitted when `'none'`: the provider's "think normally" is the absence of the field. */
  thinkingEffort?: ThinkingEffort;
  /** `max_tokens`, when the caller gave a positive number. */
  maxTokens?: number;
  /** `temperature`, when the caller gave a finite number. */
  temperature?: number;
  /** `true` for `stream()`, `false` for `complete()` — the one field the two differ in. */
  stream: boolean;
}

/**
 * The chat-completions request body, built in exactly one place.
 *
 * This is **the only** body constructor: `stream()` and `complete()` both call it, and so
 * does `Spinney: Show Request Payload` (`SessionRuntime.requestPayload()`), which is what
 * makes "the payload shown" the payload sent instead of a re-rendering of it
 * (`docs/agents/invariants/request-payload.md`).
 *
 * Every rule here is the wire's own, and `tools/check-payload.js` pins each one: a
 * streaming request always says `stream: true` and `stream_options.include_usage`; `tools`
 * appears only when it is non-empty; `reasoning_effort` is omitted for `none`; `max_tokens`
 * and `temperature` appear only when the caller gave a usable number. **Key order is part
 * of the output** — it is what the provider's prompt cache keys on — so the assignment
 * order below is load-bearing, and the `stream_options` line has to stay right after
 * `stream`, where it has always been.
 */
export function buildChatRequestBody(input: ChatRequestBodyInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
    stream: input.stream,
  };
  if (input.stream) {
    body.stream_options = { include_usage: true };
  }
  if (input.tools && input.tools.length > 0) {
    body.tools = input.tools;
  }
  if (input.thinkingEffort && input.thinkingEffort !== 'none') {
    body.reasoning_effort = input.thinkingEffort;
  }
  if (typeof input.maxTokens === 'number' && input.maxTokens > 0) {
    body.max_tokens = Math.floor(input.maxTokens);
  }
  if (typeof input.temperature === 'number' && Number.isFinite(input.temperature)) {
    body.temperature = input.temperature;
  }
  return body;
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
  /**
   * The conversation this request belongs to: a frozen context window's id for a turn,
   * or a sub-agent's own node id for its own history. Sent as the provider's session
   * header **only** when that provider's dialect asks for one
   * ({@link SessionDialect}), and omitted otherwise. The value is opaque to the
   * provider — it is only ever compared with itself, to route the conversation and to
   * key its prompt cache.
   */
  providerSession?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Minimal, dependency-free client for an OpenAI-compatible chat completions
 * endpoint. One instance per provider (`ClientRegistry`); the endpoint and the
 * key are installed with `configure`, so nothing here is vendor-specific. Uses the global `fetch` available in the VS Code
 * Node.js runtime (Node 18+).
 */
export class ApiClient {
  /**
   * When the last attempt started, on this shared client. Only used to tell a
   * request that follows a long silence (the socket may be half-open) from one in
   * the middle of a turn, which gets the normal first-byte budget.
   */
  private lastAttemptAt = 0;

  constructor(private readonly options: ClientOptions) {}

  /**
   * Update the connection settings **in place**. The same client instance is
   * shared by the main agent and every sub-agent, so installing a new `baseUrl`
   * (or `apiKey`) here — `ChatViewProvider.loadApiKey` / `onConfigurationChanged`
   * — makes it work on the very next request: no window reload, and safe to call
   * mid-turn (each request reads the options when it is built). Fields absent
   * from the patch are kept.
   */
  configure(patch: Partial<ClientOptions>): void {
    if (typeof patch.apiKey === 'string') {
      this.options.apiKey = patch.apiKey;
    }
    if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) {
      this.options.baseUrl = patch.baseUrl;
    }
    if (typeof patch.model === 'string' && patch.model.trim()) {
      this.options.model = patch.model;
    }
    if (isSessionDialect(patch.sessionHeader)) {
      this.options.sessionHeader = patch.sessionHeader;
    }
    if (typeof patch.userAgent === 'string' && patch.userAgent.trim()) {
      this.options.userAgent = patch.userAgent;
    }
  }

  /**
   * The headers every request to this endpoint carries. `Content-Type` is left out for
   * the multipart upload, whose boundary the runtime sets itself.
   */
  private headers(contentType: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.apiKey}`,
      'User-Agent': this.options.userAgent?.trim() || DEFAULT_USER_AGENT,
    };
    if (contentType) {
      headers['Content-Type'] = 'application/json';
    }
    return headers;
  }

  /**
   * The conversation header this endpoint's dialect carries, when it has one and the
   * request names a conversation. The caller's key is opaque and travels verbatim; only
   * the header name and the `ses_` prefix belong to the dialect. An empty key sends
   * nothing at all rather than a header the provider would have to ignore.
   */
  private conversationHeaders(session: string | undefined): Record<string, string> {
    const key = (session ?? '').trim();
    if (this.options.sessionHeader !== 'opencode' || !key) {
      return {};
    }
    return { 'x-opencode-session': `ses_${key}` };
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
   * `ApiError` on an unsupported format, an invalid response, or a network
   * failure so the caller can surface a clean message to the agent.
   */
  async uploadFile(bytes: Uint8Array, filename = 'image', signal?: AbortSignal): Promise<UploadedFile> {
    if (!this.options.apiKey) {
      throw new ApiError(
        'No API key configured for this provider. Run the spinney.setApiKey command (or set the DEEPSEEK_API_KEY environment variable for the built-in provider).',
      );
    }
    const mime = detectImageMime(bytes);
    if (!mime) {
      throw new ApiError('Unsupported image format. Supported formats: JPEG, PNG, GIF, WebP.');
    }
    const integrity = imageIntegrityError(bytes);
    if (integrity) {
      throw new ApiError(`Invalid image: ${integrity}.`);
    }

    const url = `${this.options.baseUrl.replace(/\/$/, '')}/files`;
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mime }), path.basename(filename) || filename);
    form.append('purpose', 'user_data');

    let response: Response;
    try {
      // Do NOT set Content-Type: the runtime sets the multipart boundary. No conversation
      // header either: this is the DeepSeek Files API, so a provider that speaks it is
      // never the one whose dialect asks for a session id (and no endpoint with that
      // dialect has a files API at all — a card on it must use the `openai` transport).
      response = await fetch(url, {
        method: 'POST',
        headers: this.headers(false),
        body: form,
        signal,
      });
    } catch (err) {
      if (signal?.aborted) {
        throw new ApiError('Upload aborted.');
      }
      throw new ApiError(`Network error uploading image: ${describeFetchError(err)}`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ApiError(`Files API error ${response.status}: ${text || response.statusText}`, response.status);
    }
    const data = (await response.json()) as { id?: string; filename?: string; bytes?: number };
    if (!data.id) {
      throw new ApiError('The files response is missing the file id.');
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
      throw new ApiError(
        'No API key configured for this provider. Run the spinney.setApiKey command (or set the DEEPSEEK_API_KEY environment variable for the built-in provider).',
      );
    }

    const url = chatCompletionsUrl(this.options.baseUrl);
    // The body is built by the one constructor (`buildChatRequestBody`) the Show Request
    // Payload command calls too, so what that command shows is what this sends.
    const body = buildChatRequestBody({
      model: request.model && request.model.trim() ? request.model : this.options.model,
      messages,
      tools,
      thinkingEffort: request.thinkingEffort,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      stream: true,
    });

    // `wellFormedDeep` on the whole body — messages plus the card-supplied `model`/`reasoning_effort`/`tools`: an
    // unpaired surrogate (a clipped emoji half, a paste into a card field) serialises as `\ud83d` and the provider
    // answers 400 `unexpected end of hex escape`, killing the request. Only the wire copy is normalised (the helper copies), the caller's messages are untouched.
    const payload = JSON.stringify(wellFormedDeep(body));
    perf(() => `request-json bytes=${payload.length} msgs=${messages.length}`);

    // One attempt = open + read. A retry is only transparent while *nothing* has
    // been yielded yet: after the first chunk the caller has already assembled
    // output from it, so re-sending would duplicate what it was told. A failure
    // after that point is therefore fatal, not retried.
    let attempt = 1;
    while (true) {
      const opened = await this.postWithRetry(url, payload, { signal, onRetry: request.onRetry, session: request.providerSession }, attempt);
      attempt = opened.attempt;
      let yielded = false;
      let readError: ApiError | undefined;
      try {
        for await (const chunk of this.readStream(opened.response, signal, opened.watch, attempt)) {
          yielded = true;
          yield chunk;
        }
      } catch (err) {
        if (signal?.aborted) {
          throw new ApiError('Request aborted.');
        }
        // A watchdog abort reads as a body error here; name the real reason so the
        // UI's ↻ Retry says "no data for Ns" instead of a bogus network failure.
        readError = opened.watch.stalled
          ? new ApiError(`Stream stalled: ${opened.watch.stalled}.`)
          : new ApiError(
              `Network error reading the response stream: ${describeFetchError(err)}`,
            );
        if (opened.watch.stalled) {
          // A post-yield stall is fatal (no retry line will follow), so record it.
          perf(() => `request-stall ${opened.watch.stalled} yielded=${yielded}`);
        }
      } finally {
        opened.watch.detach();
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
   *
   * `signal` is the caller's (a Stop), `watch` this attempt's own signal plus its
   * stall watchdog: the gap *between* two reads is timed here, because a body that
   * stops delivering is the second half of the same hang the header watchdog
   * covers.
   */
  private async *readStream(
    response: Response,
    signal: AbortSignal | undefined,
    watch: AttemptWatch,
    attempt: number,
  ): AsyncGenerator<StreamChunk> {
    if (!response.body) {
      throw new ApiError('The API returned no response body.');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let firstChunk = true;
    const readStart = Date.now();

    while (true) {
      // Check the signal before every read so a cancellation is honoured even
      // if the underlying body stream does not reject on abort. This guarantees
      // we stop the moment Stop is pressed and discard any buffered future data.
      if (signal?.aborted) {
        throw new ApiError('Request aborted.');
      }
      // Nothing has been yielded before the first chunk, so that wait is still
      // retriable; once tokens are flowing a silence is fatal instead (see the
      // caller: re-sending would duplicate output the caller already assembled).
      const idleMs = firstChunk ? FIRST_CHUNK_TIMEOUT_MS : STREAM_IDLE_TIMEOUT_MS;
      const idleTimer = setTimeout(() => {
        watch.stalled = `no data for ${idleMs}ms ${firstChunk ? 'before the first chunk' : 'mid-answer'}`;
        watch.controller.abort();
      }, idleMs);
      let done = false;
      let value: Uint8Array | undefined;
      try {
        const read = await reader.read();
        done = read.done;
        value = read.value;
      } finally {
        clearTimeout(idleTimer);
      }
      if (done) {
        break;
      }
      if (firstChunk) {
        firstChunk = false;
        perf(() => `request-first-chunk ${Date.now() - readStart}ms attempt=${attempt}`);
      }
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by newlines.
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        // Re-check after every buffered line so already-buffered events do not
        // keep streaming out after the request has been aborted.
        if (signal?.aborted) {
          throw new ApiError('Request aborted.');
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
   * restarting it. Throws the `ApiError` of the last failure — annotated
   * with the attempt count when retries actually happened.
   */
  private async postWithRetry(
    url: string,
    payload: string,
    opts: { signal?: AbortSignal; onRetry?: RetryReporter; session?: string },
    attemptStart = 1,
  ): Promise<{ response: Response; attempt: number; watch: AttemptWatch }> {
    const headers = { ...this.headers(true), ...this.conversationHeaders(opts.session) };
    let last: ApiError | undefined;
    for (let attempt = attemptStart; attempt <= MAX_ATTEMPTS; attempt++) {
      // A request that follows a long silence is the one most likely to be handed
      // a pooled keep-alive socket the provider already dropped, so it gets the
      // shorter first-byte budget: fail fast, retry, and the retry leaves on a
      // connection that is known to be new (the abort tore the old one down).
      const idle = this.lastAttemptAt > 0 && Date.now() - this.lastAttemptAt >= IDLE_GAP_MS;
      this.lastAttemptAt = Date.now();
      const budget = idle ? FIRST_BYTE_TIMEOUT_AFTER_IDLE_MS : FIRST_BYTE_TIMEOUT_MS;
      const watch = watchAttempt(opts.signal);
      const fetchStart = Date.now();
      // Say it out loud while it is happening: an attempt with no first byte logs
      // nothing at all, which is exactly why this used to look like a hung model.
      const slowNotice = setInterval(
        () =>
          perf(
            () => `request-headers pending ${Date.now() - fetchStart}ms attempt=${attempt} idle=${idle}`,
          ),
        SLOW_HEADERS_NOTICE_MS,
      );
      const firstByteTimer = setTimeout(() => {
        watch.stalled = `no response headers for ${budget}ms`;
        watch.controller.abort();
      }, budget);
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: payload,
          signal: watch.signal,
        });
      } catch (err) {
        clearInterval(slowNotice);
        clearTimeout(firstByteTimer);
        watch.detach();
        if (opts.signal?.aborted) {
          throw new ApiError('Request aborted.');
        }
        const message = describeFetchError(err);
        last = watch.stalled
          ? new ApiError(`${watch.stalled} (attempt ${attempt}).`)
          : new ApiError(`Network error calling the API: ${message}`);
        perf(() => `request-timeout ${watch.stalled ? 'headers' : 'network'} ${Date.now() - fetchStart}ms attempt=${attempt}`);
        if (!(await this.retryLater(attempt, last.message, opts.onRetry, opts.signal))) {
          throw withAttempts(last, attempt);
        }
        continue;
      }
      clearInterval(slowNotice);
      clearTimeout(firstByteTimer);
      perf(
        () =>
          `request-headers ${Date.now() - fetchStart}ms status=${response.status} attempt=${attempt} ` +
          `idle=${idle} budget=${budget}ms`,
      );
      if (response.ok && response.body) {
        return { response, attempt, watch };
      }
      // Every path below ends the attempt without reading a body: stop watching it.
      watch.detach();
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        last = new ApiError(
          `API error ${response.status}: ${text || response.statusText}`,
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
      last = new ApiError('The API returned no response body.');
      if (!(await this.retryLater(attempt, last.message, opts.onRetry, opts.signal))) {
        throw withAttempts(last, attempt);
      }
    }
    throw last ?? new ApiError(`The request failed after ${MAX_ATTEMPTS} attempts.`);
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
   * usage when the API reported it. Throws `ApiError` like `stream`.
   */
  async complete(request: CompletionRequest): Promise<{ text: string; usage?: Usage }> {
    if (!this.options.apiKey) {
      throw new ApiError(
        'No API key configured for this provider. Run the spinney.setApiKey command (or set the DEEPSEEK_API_KEY environment variable for the built-in provider).',
      );
    }
    const url = chatCompletionsUrl(this.options.baseUrl);
    // The same one constructor `stream()` uses — only `stream: false` differs.
    const body = buildChatRequestBody({
      model: request.model && request.model.trim() ? request.model : this.options.model,
      messages: request.messages,
      tools: request.tools,
      thinkingEffort: request.thinkingEffort,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      stream: false,
    });

    // Same transparent retry policy as `stream` (transient failures only) and the
    // same first-byte watchdog. The body read itself is not watched: this path is
    // used for short side answers (session titles), whose caller already bounds it
    // with its own abort timer.
    // Same rule as `stream`: the whole body — the card-supplied `model` included — is normalised on the wire.
    const { response, watch } = await this.postWithRetry(url, JSON.stringify(wellFormedDeep(body)), {
      signal: request.signal,
      onRetry: request.onRetry,
      session: request.providerSession,
    });
    let data: {
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: Usage;
    };
    try {
      data = (await response.json()) as typeof data;
    } finally {
      watch.detach();
    }
    const text = data.choices?.[0]?.message?.content ?? '';
    return { text: typeof text === 'string' ? text : '', usage: data.usage };
  }
}
