import { describeFetchError } from '../agent/netError';
import { sliceText } from '../text';
import { absoluteUrl, decodeBody, decodeEntities, hasClass, scanTags, textOf } from './webHtml';

/**
 * The built-in search backends — the whole of "where results come from".
 *
 * There is **no provider setting and no API key**: the list below is what ships,
 * and adding an engine means adding one row here plus a saved response under
 * `tools/fixtures/web-backends/` for the acceptance driver. Two decisions in
 * this table were made from measurements on the target network, not from taste:
 *
 * - **Machine formats first.** `Bing` publishes an RSS view of its results
 *   (`&format=rss`) that answers with real `<item>` entries from the region that
 *   blocks Google, DuckDuckGo, Mojeek and Wikipedia — and it needs no HTML
 *   parsing to read, so a redesign of the result page cannot break it. The same
 *   reasoning puts the HN/StackExchange/GitHub JSON APIs ahead of every scraper.
 * - **Scrapers are a maintenance treadmill.** Every engine that was measured
 *   answered a plain `curl` with a CAPTCHA from a foreign IP and with results
 *   from the target region, which is exactly why a backend must be *classified*
 *   (see {@link classify}) rather than trusted: the same request can return
 *   captcha, consent, rate-limit or markup drift, and the difference decides
 *   whether retrying is useful or a waste of the turn's budget.
 *
 * A backend that cannot be parsed is deliberately **absent**, not wishful: no
 * row exists for an engine whose real markup was never captured, because a
 * parser written from memory returns zero hits silently — the one failure mode
 * that looks like success.
 */

export interface SearchHit {
  title: string;
  url: string;
  snippet?: string;
  /** The id of the backend that produced it. */
  engine: string;
}

/** What the body of a backend's response looks like, before parsing. */
export type BackendShape = 'xml' | 'json' | 'html';

export interface RawHit {
  title: string;
  url: string;
  snippet?: string;
}

export interface WebBackend {
  id: string;
  /** Shown in the result header and in the self-test table. */
  label: string;
  shape: BackendShape;
  /** `cn` = the endpoint is meant for the target region and fails abroad. */
  reach: 'any' | 'cn';
  /** The `Accept-Language` the endpoint prefers. */
  lang?: string;
  /** The notes shown in the self-test table and the tool's diagnostics. */
  note: string;
  build(query: string, count: number): string;
  parse(body: string): RawHit[];
  /** A body matching this is a wall (captcha / consent / verify), not a result page. */
  blocked?: RegExp;
}

const q = (value: string): string => encodeURIComponent(value);

/** Text between the end of `tag` and its closing counterpart. */
function innerText(html: string, tagEnd: number, closeName: string): string {
  const close = new RegExp(`</${closeName}\\s*>`, 'i');
  const match = close.exec(html.slice(tagEnd));
  const inner = match ? html.slice(tagEnd, tagEnd + match.index) : html.slice(tagEnd);
  return textOf(inner);
}

/**
 * Bing sometimes wraps a result link in a click-tracker
 * (`/ck/a?…&u=a1<base64url of the real URL>`). Returning the tracker would hand
 * the agent a URL that resolves to another tracker, so the payload is unwrapped
 * when it is present and the href is used verbatim otherwise.
 */
export function unwrapBingUrl(href: string, base: string): string | undefined {
  const direct = absoluteUrl(href, base);
  if (!direct) {
    return undefined;
  }
  const payload = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(direct);
  if (payload) {
    try {
      const decoded = Buffer.from(payload[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      if (/^https?:\/\//i.test(decoded)) {
        return decoded;
      }
    } catch {
      // A malformed payload is not worth failing the whole result over.
    }
  }
  return direct;
}

/** The first anchor in `chunk` whose resolved href is a real http(s) URL. */
function firstAnchor(chunk: string, base: string, unwrap = false): { url: string; title: string } | undefined {
  for (const tag of scanTags(chunk)) {
    if (tag.name !== 'a') {
      continue;
    }
    const href = tag.attrs.href ?? '';
    const url = unwrap ? unwrapBingUrl(href, base) : absoluteUrl(href, base);
    if (!url) {
      continue;
    }
    return { url, title: innerText(chunk, tag.end, 'a') };
  }
  return undefined;
}

/** The text of the first element carrying `className`, or `''`. */
function classText(chunk: string, className: string): string {
  for (const tag of scanTags(chunk)) {
    if (hasClass(tag, className)) {
      const text = innerText(chunk, tag.end, tag.name);
      if (text) {
        return text;
      }
    }
  }
  return '';
}

/** Split markup into blocks starting at each element with `className`. */
function blocksByClass(html: string, className: string): string[] {
  const marks: number[] = [];
  for (const tag of scanTags(html)) {
    if (hasClass(tag, className)) {
      marks.push(tag.start);
    }
  }
  return marks.map((start, index) => html.slice(start, index + 1 < marks.length ? marks[index + 1] : html.length));
}

function tidy(value: string, limit = 320): string {
  const text = decodeEntities(value).replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${sliceText(text, limit - 1)}\u2026` : text;
}

/** Parse the RSS view Bing serves for `&format=rss`. */
function parseRssItems(body: string): RawHit[] {
  const hits: RawHit[] = [];
  const re = /<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body))) {
    const item = match[1];
    const cdata = (tag: string): string => {
      const found = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, 'i').exec(item);
      if (!found) {
        return '';
      }
      const raw = found[1].trim();
      const cd = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(raw);
      return cd ? cd[1] : decodeEntities(raw);
    };
    const url = cdata('link') || cdata('guid');
    const title = tidy(cdata('title'));
    if (!title || !/^https?:\/\//i.test(url)) {
      continue;
    }
    hits.push({ title, url, snippet: tidy(textOf(cdata('description')), 320) });
  }
  return hits;
}

/** Bing's HTML result page (`class="b_algo"` blocks). */
function parseBingHtml(body: string): RawHit[] {
  const base = 'https://www.bing.com/';
  const hits: RawHit[] = [];
  for (const block of blocksByClass(body, 'b_algo')) {
    const anchor = firstAnchor(block, base, true);
    if (!anchor || !anchor.title) {
      continue;
    }
    const snippet = classText(block, 'b_lineclamp2') || classText(block, 'b_lineclamp3') || classText(block, 'b_caption');
    hits.push({ title: tidy(anchor.title), url: anchor.url, snippet: tidy(snippet) });
  }
  return hits;
}

/**
 * 360 (`so.com`). Its result links are redirects, but the anchor carries the
 * real destination in `data-mdurl` — using it avoids one extra request per hit.
 */
function parseSo360(body: string): RawHit[] {
  const base = 'https://www.so.com/';
  const hits: RawHit[] = [];
  for (const block of blocksByClass(body, 'res-list')) {
    let url = '';
    let title = '';
    for (const tag of scanTags(block)) {
      if (tag.name !== 'a') {
        continue;
      }
      const md = tag.attrs['data-mdurl'];
      const text = innerText(block, tag.end, 'a');
      if (md && /^https?:\/\//i.test(md)) {
        url = md;
        title = text;
        break;
      }
      if (!url) {
        const href = absoluteUrl(tag.attrs.href ?? '', base);
        if (href && !/so\.com\/link/.test(href)) {
          url = href;
          title = text;
        }
      }
    }
    if (!url || !title) {
      continue;
    }
    const snippet = classText(block, 'res-desc') || classText(block, 'res-rich') || classText(block, 'res-comm-con');
    hits.push({ title: tidy(title), url, snippet: tidy(snippet) });
  }
  return hits;
}

/**
 * Baidu. Organic results carry the real destination in `data-url`; the sponsored
 * ones (`data-tools` → `baidu.php?url=…`) deliberately do not, which makes
 * "has a `data-url`" the filter that keeps advertising out of the results.
 */
function parseBaidu(body: string): RawHit[] {
  const base = 'https://www.baidu.com/';
  const hits: RawHit[] = [];
  const blocks: string[] = [];
  const marks: number[] = [];
  for (const tag of scanTags(body)) {
    if (tag.name === 'div' && hasClass(tag, 'result')) {
      marks.push(tag.start);
    }
  }
  marks.forEach((start, index) => blocks.push(body.slice(start, index + 1 < marks.length ? marks[index + 1] : body.length)));
  for (const block of blocks) {
    let url = '';
    let title = '';
    const tags = scanTags(block);
    for (const tag of tags) {
      const candidate = tag.attrs['data-url'];
      if (candidate && /^https?:\/\//i.test(candidate) && !/baidu\.php/.test(candidate)) {
        url = candidate;
        break;
      }
    }
    for (const tag of tags) {
      if (tag.name === 'h3') {
        const anchor = firstAnchor(block.slice(tag.start), base);
        if (anchor) {
          title = anchor.title;
          break;
        }
      }
    }
    if (!url || !title) {
      continue;
    }
    const whole = textOf(block);
    const snippet = whole.startsWith(title) ? whole.slice(title.length) : whole;
    hits.push({ title: tidy(title), url, snippet: tidy(snippet) });
  }
  return hits;
}

/** Sogou (`class="vrwrap"` blocks; the title anchor holds a real URL). */
function parseSogou(body: string): RawHit[] {
  const base = 'https://www.sogou.com/';
  const hits: RawHit[] = [];
  for (const block of blocksByClass(body, 'vrwrap')) {
    const anchor = firstAnchor(block, base);
    if (!anchor || !anchor.title) {
      continue;
    }
    const snippet = classText(block, 'star-wiki') || classText(block, 'space-txt') || classText(block, 'text-layout') || classText(block, 'fz-mid');
    hits.push({ title: tidy(anchor.title), url: anchor.url, snippet: tidy(snippet) });
  }
  return hits;
}

/** Hacker News (Algolia's keyless JSON index — no captcha, no key). */
function parseHackerNews(body: string): RawHit[] {
  const data = JSON.parse(body) as { hits?: Array<Record<string, unknown>> };
  const hits: RawHit[] = [];
  for (const hit of data.hits ?? []) {
    const title = String(hit.title ?? hit.story_title ?? '').trim();
    const url = String(hit.url ?? hit.story_url ?? `https://news.ycombinator.com/item?id=${hit.objectID ?? ''}`);
    if (!title || !/^https?:\/\//i.test(url)) {
      continue;
    }
    const points = typeof hit.points === 'number' ? `${hit.points} points · ` : '';
    const comments = typeof hit.num_comments === 'number' ? `${hit.num_comments} comments` : '';
    hits.push({
      title: tidy(title),
      url,
      snippet: tidy(`${points}${comments}`.trim() || 'Hacker News'),
    });
  }
  return hits;
}

/** StackExchange's public JSON API (keyless; throttled per IP). */
function parseStackExchange(body: string): RawHit[] {
  const data = JSON.parse(body) as { items?: Array<Record<string, unknown>> };
  const hits: RawHit[] = [];
  for (const item of data.items ?? []) {
    const title = tidy(String(item.title ?? ''));
    const url = String(item.link ?? '');
    if (!title || !/^https?:\/\//i.test(url)) {
      continue;
    }
    const tags = Array.isArray(item.tags) ? item.tags.slice(0, 5).join(', ') : '';
    const score = typeof item.score === 'number' ? `score ${item.score}` : '';
    hits.push({ title, url, snippet: tidy([tags, score].filter(Boolean).join(' · ')) });
  }
  return hits;
}

/** GitHub's repository search (keyless at 10 requests/minute). */
function parseGitHub(body: string): RawHit[] {
  const data = JSON.parse(body) as { items?: Array<Record<string, unknown>> };
  const hits: RawHit[] = [];
  for (const item of data.items ?? []) {
    const title = tidy(String(item.full_name ?? ''));
    const url = String(item.html_url ?? '');
    if (!title || !/^https?:\/\//i.test(url)) {
      continue;
    }
    const stars = typeof item.stargazers_count === 'number' ? `${item.stargazers_count}★` : '';
    const language = item.language ? String(item.language) : '';
    const description = tidy(String(item.description ?? ''), 200);
    hits.push({
      title,
      url,
      snippet: tidy([description, [stars, language].filter(Boolean).join(' ')].filter(Boolean).join(' — ')),
    });
  }
  return hits;
}

/**
 * The shipped backends, in the order they are tried. Order is the priority: the
 * machine-format endpoints come first because they are cheap, stable and
 * region-proof; the scrapers follow, most region-appropriate first.
 */
export const WEB_BACKENDS: readonly WebBackend[] = [
  {
    id: 'bing-rss',
    label: 'Bing (RSS)',
    shape: 'xml',
    reach: 'any',
    lang: 'zh-CN,zh;q=0.9,en;q=0.8',
    note: 'machine format — the most reliable general index from the target region',
    build: (query, count) => `https://www.bing.com/search?q=${q(query)}&format=rss&count=${Math.max(10, count)}`,
    parse: parseRssItems,
  },
  {
    id: 'so360',
    label: '360 Search',
    shape: 'html',
    reach: 'cn',
    lang: 'zh-CN,zh;q=0.9',
    note: 'HTML scrape; links carry data-mdurl (no redirect resolution needed)',
    build: (query) => `https://www.so.com/s?q=${q(query)}`,
    parse: parseSo360,
    blocked: /请输入验证码|安全验证|访问过于频繁/,
  },
  {
    id: 'baidu',
    label: 'Baidu',
    shape: 'html',
    reach: 'cn',
    lang: 'zh-CN,zh;q=0.9',
    note: 'HTML scrape; organic results carry data-url, ads do not',
    build: (query) => `https://www.baidu.com/s?wd=${q(query)}`,
    parse: parseBaidu,
    blocked: /百度安全验证|安全验证|网络不给力/,
  },
  {
    id: 'sogou',
    label: 'Sogou',
    shape: 'html',
    reach: 'cn',
    lang: 'zh-CN,zh;q=0.9',
    note: 'HTML scrape; the title anchor in each vrwrap holds a real URL',
    build: (query) => `https://www.sogou.com/web?query=${q(query)}`,
    parse: parseSogou,
    blocked: /请输入验证码|验证码|反爬/,
  },
  {
    id: 'bing',
    label: 'Bing',
    shape: 'html',
    reach: 'any',
    lang: 'zh-CN,zh;q=0.9,en;q=0.8',
    note: 'HTML scrape of the same index as the RSS backend (fallback)',
    build: (query) => `https://www.bing.com/search?q=${q(query)}`,
    parse: parseBingHtml,
  },
  {
    id: 'hn',
    label: 'Hacker News',
    shape: 'json',
    reach: 'any',
    note: 'keyless JSON API — good for tooling/startup chatter',
    build: (query, count) => `https://hn.algolia.com/api/v1/search?query=${q(query)}&hitsPerPage=${count}`,
    parse: parseHackerNews,
  },
  {
    id: 'stackexchange',
    label: 'StackExchange',
    shape: 'json',
    reach: 'any',
    note: 'keyless JSON API — programming answers',
    build: (query, count) =>
      `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${q(query)}&site=stackoverflow&pagesize=${count}&filter=default`,
    parse: parseStackExchange,
  },
  {
    id: 'github',
    label: 'GitHub',
    shape: 'json',
    reach: 'any',
    note: 'keyless repository search (10 requests/minute)',
    build: (query, count) => `https://api.github.com/search/repositories?q=${q(query)}&per_page=${count}`,
    parse: parseGitHub,
  },
];

/** How long a backend sits out after an outcome, in milliseconds. */
const COOLDOWN_MS: Record<Outcome, number> = {
  ok: 0,
  empty: 60_000,
  'parse-empty': 30 * 60_000,
  unexpected: 30 * 60_000,
  blocked: 30 * 60_000,
  'rate-limited': 10 * 60_000,
  'http-error': 2 * 60_000,
  timeout: 2 * 60_000,
  aborted: 0,
};

/**
 * What actually happened. The distinction is the point of the whole module:
 * `blocked` must not be retried (the wall is real and 30 minutes long), while a
 * `timeout` is worth one more try; `parse-empty` means the page loaded but this
 * build cannot read it — the upstream markup moved.
 */
export type Outcome =
  | 'ok'
  | 'empty'
  | 'parse-empty'
  | 'unexpected'
  | 'blocked'
  | 'rate-limited'
  | 'http-error'
  | 'timeout'
  | 'aborted';

export interface Attempt {
  id: string;
  label: string;
  outcome: Outcome;
  /** Milliseconds spent on this backend. */
  ms: number;
  /** Hits parsed (0 unless the outcome is `ok`). */
  count: number;
  /** One short reason, for the diagnostics line and the self-test table. */
  detail?: string;
}

/** A backend's health, as the runner remembers it for this extension host. */
interface Health {
  failures: number;
  openUntil: number;
  lastOutcome?: Outcome;
}

const health = new Map<string, Health>();

/** Is this backend sitting out, and for how much longer? */
export function backendCooldown(id: string, now = Date.now()): number {
  const entry = health.get(id);
  if (!entry) {
    return 0;
  }
  return Math.max(0, entry.openUntil - now);
}

/** Record an outcome and open (or close) the backend's cooldown accordingly. */
export function recordOutcome(id: string, outcome: Outcome, now = Date.now()): void {
  const entry = health.get(id) ?? { failures: 0, openUntil: 0 };
  if (outcome === 'ok') {
    health.delete(id);
    return;
  }
  if (outcome === 'aborted' || outcome === 'empty') {
    health.set(id, { ...entry, lastOutcome: outcome });
    return;
  }
  entry.failures += 1;
  entry.lastOutcome = outcome;
  // A wall or a moved page is not a transient failure: sit out immediately.
  const base = COOLDOWN_MS[outcome];
  const scaled = outcome === 'timeout' || outcome === 'http-error' ? base * Math.min(entry.failures, 3) : base;
  entry.openUntil = now + scaled;
  health.set(id, entry);
}

/** Forget everything (used by the self-test command before it measures). */
export function resetHealth(): void {
  health.clear();
}

/** The health snapshot, for the self-test's reporting. */
export function healthSnapshot(): Array<{ id: string; cooldownMs: number; failures: number; lastOutcome?: Outcome }> {
  const now = Date.now();
  return WEB_BACKENDS.map((backend) => {
    const entry = health.get(backend.id);
    return {
      id: backend.id,
      cooldownMs: Math.max(0, (entry?.openUntil ?? 0) - now),
      failures: entry?.failures ?? 0,
      lastOutcome: entry?.lastOutcome,
    };
  });
}

/** Read a response body, stopping at `maxBytes` (a hostile page must not be read whole). */
export async function readCapped(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`response is ${declared} bytes, over the ${maxBytes} byte cap`);
  }
  const body = response.body;
  if (!body) {
    return new Uint8Array(await response.arrayBuffer());
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal?.aborted) {
        throw new Error('aborted');
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(value);
        total += value.byteLength;
        if (total > maxBytes) {
          throw new Error(`response exceeded the ${maxBytes} byte cap`);
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Cancelling a finished or failed stream is not an error worth reporting.
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** The browser-shaped request headers every backend uses. */
function headersFor(backend: WebBackend): Record<string, string> {
  return {
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'accept-language': backend.lang ?? 'en-US,en;q=0.9',
    accept:
      backend.shape === 'json'
        ? 'application/json,text/plain;q=0.9,*/*;q=0.5'
        : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5',
  };
}

const MAX_BODY_BYTES = 3 * 1024 * 1024;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 9_000;

/**
 * Run one backend once and classify the result. Nothing here throws: a failed
 * backend is data (see {@link Attempt}), because "which of the eight answers on
 * this network" is the question the tool exists to answer.
 */
export async function attemptBackend(
  backend: WebBackend,
  query: string,
  count: number,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ attempt: Attempt; hits: SearchHit[] }> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const done = (outcome: Outcome, hits: SearchHit[], detail?: string): { attempt: Attempt; hits: SearchHit[] } => ({
    attempt: { id: backend.id, label: backend.label, outcome, ms: Date.now() - started, count: hits.length, detail },
    hits,
  });
  try {
    const response = await fetch(backend.build(query, count), {
      headers: headersFor(backend),
      redirect: 'follow',
      signal: controller.signal,
    });
    if (response.status === 429 || response.status === 403) {
      return done('rate-limited', [], `HTTP ${response.status}`);
    }
    if (!response.ok) {
      return done('http-error', [], `HTTP ${response.status}`);
    }
    const bytes = await readCapped(response, MAX_BODY_BYTES, controller.signal);
    const { text, charset } = decodeBody(bytes, response.headers.get('content-type'));
    if (backend.shape === 'xml' && !/^\s*(?:<\?xml|<rss|<feed)/i.test(text)) {
      return done('unexpected', [], `expected XML, got ${charset} ${bytes.byteLength}B`);
    }
    if (backend.shape === 'json' && !/^\s*[[{]/.test(text)) {
      const since = /"message"\s*:\s*"([^"]{0,80})/.exec(text);
      return done('unexpected', [], since ? `JSON error: ${since[1]}` : 'expected JSON');
    }
    if (backend.blocked?.test(text)) {
      // Only an early suspicion: the body is parsed first and the marker decides
      // nothing on its own (see `classifyEmpty`).
      backend.blocked.lastIndex = 0;
    }
    let raw: RawHit[];
    try {
      raw = backend.parse(text);
    } catch (error) {
      return done('parse-empty', [], `parse failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const hits: SearchHit[] = raw
      .filter((hit) => hit.title && /^https?:\/\//i.test(hit.url))
      .map((hit) => ({ ...hit, engine: backend.id }));
    if (hits.length > 0) {
      return done('ok', hits);
    }
    const classified = classifyEmpty(backend, text);
    return done(classified.outcome, [], classified.detail ?? `${bytes.byteLength}B, charset ${charset}, 0 hits`);
  } catch (error) {
    if (options.signal?.aborted) {
      return done('aborted', [], 'turn aborted');
    }
    const message = describeFetchError(error);
    if (controller.signal.aborted && !/cap|exceeded/i.test(message)) {
      return done('timeout', [], `${timeoutMs}ms`);
    }
    return done('http-error', [], sliceText(message, 120));
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** Tracking parameters that make two spellings of the same result look different. */
const TRACKING_PARAMS = /^(utm_|spm$|spm_|from$|source$|ref$|referrer$|wfr$|gclid$|fbclid$|msclkid$|yclid$|scm$|share_|_hs|igshid$|mkt_tok$|trk$|ei$|sa$|ved$|usg$|oq$|rsv_|bd_|tn$|wd$|wd_)/i;

/** A URL's identity for deduplication: no fragment, no tracking, no trailing slash. */
export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    let text = url.toString();
    if (text.endsWith('/')) {
      text = text.slice(0, -1);
    }
    return text;
  } catch {
    return raw;
  }
}

/**
 * The tokens a query is matched against: latin/digit words of 2+ characters, and —
 * because Chinese is not space-separated — the single characters and bigrams of a
 * CJK run. English function words are dropped: they appear in every page and would
 * make any result look relevant.
 */
export function queryTokens(query: string): string[] {
  const text = query.toLowerCase();
  const tokens = new Set<string>();
  for (const word of text.match(/[a-z0-9][a-z0-9+#._-]{1,}/g) ?? []) {
    tokens.add(word);
  }
  for (const run of text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g) ?? []) {
    for (let i = 0; i < run.length; i++) {
      tokens.add(run[i]);
      if (i + 1 < run.length) {
        tokens.add(run.slice(i, i + 2));
      }
    }
  }
  for (const stop of ['the', 'and', 'for', 'with', 'how', 'what', 'why', 'does', 'into', 'from', 'that', 'this', 'are', 'you']) {
    tokens.delete(stop);
  }
  return [...tokens];
}

/**
 * How much of the query a hit actually contains, as a 0–1 fraction of its tokens.
 *
 * This exists because "the backend answered" and "the answer is about your
 * question" are different facts, and the first one alone made the chain stop too
 * early: Bing's RSS view answers with *something* for almost any input (a measured
 * example: `t3.gg browserbase` returned thyroid-medicine pages, and `site:` is
 * ignored outright), so a query about nothing at all came back as ten fund pages
 * and every remaining backend was never tried. Ranking by term overlap is the
 * cheap fix — no model call, no extra request — and it also gives the caller a
 * truthful signal when nothing matched at all.
 */
export function hitRelevance(hit: RawHit | SearchHit, tokens: string[]): number {
  if (tokens.length === 0) {
    return 1;
  }
  const haystack = `${hit.title} ${hit.snippet ?? ''} ${hit.url}`.toLowerCase();
  let matched = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      matched++;
    }
  }
  return matched / tokens.length;
}

/**
 * The score at which a hit counts as "about the query" rather than merely
 * "returned by a backend". Half the query's terms is deliberately harsher than a
 * single overlapping word: measured live, a nonsense query
 * (`zynthos flumox reranker quantization bug tracker`) matched pages *about bug
 * trackers* on two of its seven terms, and reporting those as matches is exactly
 * the false confidence this scoring exists to prevent.
 */
export const RELEVANT_SCORE = 0.5;

/**
 * What an empty result means. The order is the whole point:
 *
 *  - a wall marker on a page that parsed to **nothing** is a captcha/consent wall;
 *  - a well-formed machine body (JSON/XML) with zero entries is an honest "no
 *    results for this query" — *not* damage, so it must not bench the backend. This
 *    was learned the hard way: every JSON backend used to report `parse-empty`
 *    (a 30 minute cooldown) whenever a query simply had no matches, so one unlucky
 *    query silently disabled Hacker News, StackExchange and GitHub for half an hour;
 *  - an HTML page that parsed to nothing is markup drift.
 *
 * The marker test runs **after** parsing, never before: a real result page can
 * carry the word 验证码 in a footer or an inline script, and classifying such a page
 * as `blocked` both hides its results and puts a healthy engine in a long cooldown
 * (measured live on `so360` and `sogou` before this moved here).
 */
export function classifyEmpty(backend: WebBackend, body: string): { outcome: Outcome; detail?: string } {
  const marker = backend.blocked?.exec(body)?.[0];
  if (marker) {
    return { outcome: 'blocked', detail: marker };
  }
  if (backend.shape === 'json' || backend.shape === 'xml') {
    return { outcome: 'empty', detail: 'no entries for this query' };
  }
  return { outcome: 'parse-empty', detail: 'no result block could be read (the page may have changed)' };
}

export interface SearchReport {
  hits: SearchHit[];
  attempts: Attempt[];
  /** How many of the returned `hits` match at least half of the query's terms. */
  matched: number;
  /** Backends that were skipped because they were still in cooldown. */
  skipped: Array<{ id: string; label: string; cooldownMs: number; lastOutcome?: Outcome }>;
}

/**
 * Search the backends in order, merging what comes back until `count` hits **that
 * match the query** are collected, or the budget runs out.
 *
 * Merging rather than "first winner takes all" is deliberate: a single engine
 * answers a Chinese query from a code corpus badly and a tooling query from an
 * encyclopedia badly, and the four machine-format backends cost a few hundred
 * milliseconds together. The budget is what keeps that honest — the call must
 * never outlive the turn's foreground slice.
 *
 * The "that match the query" half is what the first acceptance run proved
 * necessary: with a plain count-based stop, one backend that answers with
 * anything (Bing RSS) satisfied the request on its own, so the other seven —
 * including all three keyless JSON APIs — were never reached, and the user got
 * unrelated results that *looked* like an answer. The chain therefore keeps
 * going while nothing matches, and when nothing matches even at the end the
 * report says so instead of dressing feed noise up as a result (see
 * {@link hitRelevance}).
 */
export async function runWebSearch(
  query: string,
  count: number,
  options: { signal?: AbortSignal; budgetMs?: number; ignoreHealth?: boolean; attemptTimeoutMs?: number } = {},
): Promise<SearchReport> {
  const budgetMs = options.budgetMs ?? 25_000;
  const deadline = Date.now() + budgetMs;
  const tokens = queryTokens(query);
  const hits: SearchHit[] = [];
  const matchedKeys = new Set<string>();
  const seen = new Set<string>();
  const attempts: Attempt[] = [];
  const skipped: SearchReport['skipped'] = [];
  const openIds = WEB_BACKENDS.map((backend) => backend.id).filter((id) => backendCooldown(id) > 0);
  for (const backend of WEB_BACKENDS) {
    if (options.signal?.aborted) {
      break;
    }
    const cooldown = options.ignoreHealth ? 0 : backendCooldown(backend.id);
    // Every backend sitting out is a diagnosis, not a reason to give up silently:
    // when all of them are open they are tried anyway, so the user still learns
    // *why* nothing answered.
    if (cooldown > 0 && openIds.length < WEB_BACKENDS.length) {
      skipped.push({ id: backend.id, label: backend.label, cooldownMs: cooldown, lastOutcome: health.get(backend.id)?.lastOutcome });
      continue;
    }
    if (Date.now() >= deadline) {
      break;
    }
    const remaining = Math.max(1_000, Math.min(options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS, deadline - Date.now()));
    const { attempt, hits: found } = await attemptBackend(backend, query, count, {
      signal: options.signal,
      timeoutMs: remaining,
    });
    attempts.push(attempt);
    if (!options.ignoreHealth) {
      recordOutcome(backend.id, attempt.outcome);
    }
    for (const hit of found) {
      const key = normalizeUrl(hit.url);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      hits.push(hit);
      if (hitRelevance(hit, tokens) >= RELEVANT_SCORE) {
        matchedKeys.add(key);
      }
    }
    if (matchedKeys.size >= count) {
      break;
    }
  }
  // Best first, but only reordered: a stable sort keeps the backend order as the
  // tie-breaker, so two equally relevant hits still read in chain order.
  const scored = hits
    .map((hit, index) => ({ hit, index, score: hitRelevance(hit, tokens) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const returned = scored.slice(0, count);
  return {
    hits: returned.map((entry) => entry.hit),
    attempts,
    matched: returned.filter((entry) => entry.score >= RELEVANT_SCORE).length,
    skipped,
  };
}

/** Probe every backend once, ignoring cooldowns — the self-test command's engine. */
export async function probeAllBackends(
  query: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Attempt[]> {
  const attempts: Attempt[] = [];
  for (const backend of WEB_BACKENDS) {
    if (options.signal?.aborted) {
      break;
    }
    const { attempt } = await attemptBackend(backend, query, 5, { signal: options.signal, timeoutMs: options.timeoutMs });
    attempts.push(attempt);
  }
  return attempts;
}
