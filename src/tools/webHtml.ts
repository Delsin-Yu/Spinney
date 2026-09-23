/**
 * The HTML half of the built-in web tools (`web_search` / `web_fetch`).
 *
 * It is written by hand — no `cheerio`, no `jsdom`, no `node-html-parser` —
 * because this extension ships **zero runtime dependencies**: adding a parser
 * would mean auditing a transitive tree, and adding a *DOM* would mean shipping
 * one, while the two things actually needed here are small: read the handful of
 * attributes a search result carries, and turn an article into text.
 *
 * Three rules shape the code below, and each one was learned from a real page:
 *
 * 1. **Never scan raw HTML with a regex that spans tags.** Bing and Sogou inline
 *    JavaScript contains `<` and `>`; a "match everything until the next `<`"
 *    regex silently eats the rest of the document once it walks into a script.
 *    {@link scanTags} therefore skips the *content* of `script`/`style` and
 *    understands quoted attribute values, so an attribute holding `>` cannot
 *    end a tag early.
 * 2. **Multi-line markup is normal.** CN engines serve their results one
 *    attribute per line (`class="vr-title"\n  vrcid="…"`), so a block splitter
 *    must work on tag positions, not on `.`-matches inside a single line.
 * 3. **CJK must not gain spaces.** Stripping a tag inserts *nothing*; only
 *    block-level boundaries become a newline. Joining two Chinese fragments
 *    with a space is a visible defect in every sentence the model then reads.
 */

/** A tag as {@link scanTags} sees it: name, attributes and its byte range. */
export interface HtmlTag {
  name: string;
  attrs: Record<string, string>;
  /** The tag itself, verbatim (`<a href="…">`). */
  raw: string;
  /** Index of the opening `<` in the source. */
  start: number;
  /** Index just past the closing `>`. */
  end: number;
  selfClosing: boolean;
}

/** Tags whose text content is not markup and must never be scanned. */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);

/** Block-level tags: a boundary here becomes a newline in extracted text. */
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot',
  'th', 'thead', 'tr', 'ul',
]);

/** Regions that carry navigation rather than content (dropped by {@link mainHtml}). */
const CHROME_TAGS = new Set(['nav', 'header', 'footer', 'aside', 'form', 'noscript', 'template', 'svg', 'iframe', 'button']);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ensp: '\u2002',
  emsp: '\u2003', thinsp: '\u2009', copy: '\u00a9', reg: '\u00ae', trade: '\u2122',
  hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201c', rdquo: '\u201d', laquo: '\u00ab', raquo: '\u00bb', middot: '\u00b7',
  bull: '\u2022', deg: '\u00b0', times: '\u00d7', divide: '\u00f7', plusmn: '\u00b1',
  sup2: '\u00b2', sup3: '\u00b3', frac12: '\u00bd', euro: '\u20ac', pound: '\u00a3',
  yen: '\u00a5', cent: '\u00a2', sect: '\u00a7', para: '\u00b6', dagger: '\u2020',
  permil: '\u2030', prime: '\u2032', Prime: '\u2033', larr: '\u2190', rarr: '\u2192',
  uarr: '\u2191', darr: '\u2193', harr: '\u2194', infin: '\u221e', ne: '\u2260',
  le: '\u2264', ge: '\u2265', minus: '\u2212', lowast: '\u2217', radic: '\u221a',
  sim: '\u223c', asymp: '\u2248', equiv: '\u2261', shy: '\u00ad', ordf: '\u00aa',
  ordm: '\u00ba', iexcl: '\u00a1', iquest: '\u00bf', acute: '\u00b4', cedil: '\u00b8',
};

/** Resolve HTML character references (named, decimal and hexadecimal). */
export function decodeEntities(input: string): string {
  if (input.indexOf('&') < 0) {
    return input;
  }
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
        return match;
      }
      // Lone surrogates would make the string invalid UTF-16; keep the source text.
      if (code >= 0xd800 && code <= 0xdfff) {
        return match;
      }
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body];
    return named === undefined ? match : named;
  });
}

/** Parse the attributes out of one raw tag. Values are entity-decoded. */
function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const body = raw.replace(/^<\/?[a-zA-Z0-9:-]+/, '').replace(/\/?>$/, '');
  const re = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body))) {
    const name = match[1].toLowerCase();
    const value = match[3] ?? match[4] ?? match[5] ?? '';
    if (!(name in attrs)) {
      attrs[name] = decodeEntities(value);
    }
  }
  return attrs;
}

/**
 * Walk the markup and return every opening tag with its position — skipping
 * comments, the doctype, and the raw text content of `script`/`style`/`textarea`.
 * Quoted attribute values are respected, so `data-x="a>b"` cannot end a tag.
 */
export function scanTags(html: string): HtmlTag[] {
  const out: HtmlTag[] = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      break;
    }
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const closing = html[lt + 1] === '/';
    const nameStart = lt + (closing ? 2 : 1);
    let j = nameStart;
    while (j < n && /[a-zA-Z0-9:_-]/.test(html[j])) {
      j++;
    }
    const name = html.slice(nameStart, j).toLowerCase();
    if (!name) {
      i = lt + 1;
      continue;
    }
    let k = j;
    let quote = '';
    while (k < n) {
      const c = html[k];
      if (quote) {
        if (c === quote) {
          quote = '';
        }
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
      k++;
    }
    const raw = html.slice(lt, Math.min(k + 1, n));
    const selfClosing = /\/>$/.test(raw);
    if (!closing) {
      out.push({ name, attrs: parseAttrs(raw), raw, start: lt, end: k + 1, selfClosing });
    }
    i = k + 1;
    if (!closing && !selfClosing && RAW_TEXT_TAGS.has(name)) {
      const close = new RegExp(`</${name}\\s*>`, 'i');
      const match = close.exec(html.slice(i));
      i = match ? i + match.index + match[0].length : n;
    }
  }
  return out;
}

/** Does this tag carry this CSS class (`class="a b"`)? */
export function hasClass(tag: HtmlTag, name: string): boolean {
  const value = tag.attrs.class;
  if (!value) {
    return false;
  }
  return value.split(/\s+/).includes(name);
}

/** Remove every tag and comment, leaving text; block boundaries become newlines. */
export function textOf(html: string): string {
  const withoutRaw = html.replace(/<(script|style|textarea|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const withoutComments = withoutRaw.replace(/<!--[\s\S]*?-->/g, ' ');
  const withBreaks = withoutComments.replace(
    /<\/?([a-zA-Z][a-zA-Z0-9:-]*)\b[^>]*>/g,
    (_match, name: string) => (BLOCK_TAGS.has(name.toLowerCase()) ? '\n' : ''),
  );
  return normalizeText(decodeEntities(withBreaks));
}

/** Collapse whitespace, keep paragraph breaks, never insert spaces around CJK. */
export function normalizeText(input: string): string {
  return input
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line, index, all) => line !== '' || (index > 0 && index < all.length - 1))
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Resolve a possibly-relative href against the page it was found on. */
export function absoluteUrl(href: string, baseUrl: string): string | undefined {
  const trimmed = href.trim();
  if (!trimmed || /^(javascript|data|mailto|tel|about|blob):/i.test(trimmed) || trimmed.startsWith('#')) {
    return undefined;
  }
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return undefined;
  }
}

/** The charset named by a `Content-Type` header, if any. */
export function charsetFromContentType(contentType: string | null | undefined): string | undefined {
  const match = /charset\s*=\s*"?([\w-]+)/i.exec(contentType ?? '');
  return match ? match[1].toLowerCase() : undefined;
}

/** The charset a page declares for itself (`<meta charset>` / `http-equiv`). */
export function charsetFromMeta(head: string): string | undefined {
  const direct = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head);
  if (direct) {
    return direct[1].toLowerCase();
  }
  const equiv = /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)/i.exec(head);
  return equiv ? equiv[1].toLowerCase() : undefined;
}

/**
 * Normalize a charset label into something `TextDecoder` accepts. The labels CN
 * sites actually send are the problem: `gb2312` and `gb18030` are aliases of
 * `gbk` for decoding purposes, and a bare `iso-8859-1` is served by every
 * Windows codepage in practice.
 */
export function normalizeCharset(label: string | undefined): string {
  const name = (label ?? '').trim().toLowerCase().replace(/['"]/g, '');
  if (!name) {
    return 'utf-8';
  }
  if (name === 'gb2312' || name === 'gb_2312' || name === 'gb18030' || name === 'x-gbk') {
    return 'gbk';
  }
  if (name === 'latin1' || name === 'iso-8859-1' || name === 'us-ascii' || name === 'ascii') {
    return 'windows-1252';
  }
  if (name === 'utf8') {
    return 'utf-8';
  }
  return name;
}

/** Is this label one `TextDecoder` in this runtime knows how to build? */
function decoderFor(label: string, fatal = false) {
  try {
    return new TextDecoder(label, { fatal });
  } catch {
    return undefined;
  }
}

/**
 * Decode a response body with the charset the page actually declares, falling
 * back to UTF-8. Getting this wrong is not cosmetic: `gbk` bytes read as UTF-8
 * are replacement characters, and a search result whose title is `?????` tells
 * the model nothing.
 */
export function decodeBody(bytes: Uint8Array, contentType?: string | null): { text: string; charset: string } {
  const head = (() => {
    try {
      return new TextDecoder('utf-8').decode(bytes.subarray(0, 4096));
    } catch {
      return '';
    }
  })();
  const declared = charsetFromContentType(contentType) ?? charsetFromMeta(head);
  const candidates = [normalizeCharset(declared), 'utf-8'].filter((v, i, all) => all.indexOf(v) === i);
  for (const label of candidates) {
    const decoder = decoderFor(label);
    if (!decoder) {
      continue;
    }
    const text = decoder.decode(bytes);
    // A decoded body with replacement characters is the signature of a wrong guess.
    if (label === 'utf-8' || !text.includes('\ufffd')) {
      return { text, charset: label };
    }
  }
  return { text: new TextDecoder('utf-8').decode(bytes), charset: 'utf-8' };
}

/**
 * Pick the block most likely to be the article. A crude density heuristic beats
 * a dependency here: `article`/`main`/`role=main` win when they hold enough
 * text, otherwise `<body>` is used as-is and the chrome is stripped later.
 */
export function mainHtml(html: string): string {
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html);
  const scoped = body ? body[1] : html;
  const candidates: string[] = [];
  for (const pattern of [
    /<article\b[^>]*>[\s\S]*?<\/article>/gi,
    /<main\b[^>]*>[\s\S]*?<\/main>/gi,
    /<div\b[^>]*\brole\s*=\s*["']main["'][^>]*>[\s\S]*?<\/div>/gi,
    /<div\b[^>]*\bid\s*=\s*["'](?:content|main|article)["'][^>]*>[\s\S]*?<\/div>/gi,
  ]) {
    for (const match of scoped.match(pattern) ?? []) {
      candidates.push(match);
    }
  }
  const best = candidates
    .map((candidate) => ({ candidate, length: textOf(candidate).length }))
    .sort((a, b) => b.length - a.length)[0];
  return best && best.length > 400 ? best.candidate : scoped;
}

/** Drop navigation/footer/script regions from an already-chosen main block. */
export function stripChrome(html: string): string {
  return html
    .replace(/<(script|style|noscript|template|svg|iframe|canvas|video|audio)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(new RegExp(`<(${[...CHROME_TAGS].join('|')})\\b[^>]*>[\\s\\S]*?</\\1\\s*>`, 'gi'), ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

/** Everything inside a tag, verbatim — used for `<script type="application/ld+json">`. */
export function scriptContents(html: string, typeMatch: RegExp): string[] {
  const out: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    if (typeMatch.test(match[1])) {
      out.push(match[2]);
    }
  }
  return out;
}

/**
 * Convert HTML to Markdown. Deliberately small: headings, paragraphs, lists,
 * links, emphasis, code and tables — the shapes that carry meaning in the pages
 * an agent fetches. Anything else degrades to its text, which is the correct
 * failure direction for a model reading the result.
 */
export function htmlToMarkdown(html: string, baseUrl: string): string {
  let out = stripChrome(html);
  const inline = (fragment: string): string =>
    decodeEntities(fragment).replace(/\s+/g, ' ').trim();

  out = out.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_m, body: string) => {
    const code = decodeEntities(body.replace(/<[^>]+>/g, '')).replace(/^\n+|\n+$/g, '');
    return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`;
  });
  out = out.replace(/<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, tag: string, body: string) => {
    return `\n\n${'#'.repeat(Number(tag[1]))} ${inline(body.replace(/<[^>]+>/g, ''))}\n\n`;
  });
  out = out.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_m, attrs: string, body: string) => {
    const label = inline(body.replace(/<[^>]+>/g, ''));
    const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
    const target = href ? absoluteUrl(decodeEntities(href[2] ?? href[3] ?? href[4] ?? ''), baseUrl) : undefined;
    if (!label) {
      return target ? `[${target}](${target})` : '';
    }
    return target ? `[${label}](${target})` : label;
  });
  out = out.replace(/<img\b[^>]*>/gi, (tag: string) => {
    const alt = /\balt\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
    const src = /\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
    const label = decodeEntities(alt?.[2] ?? alt?.[3] ?? alt?.[4] ?? '');
    const target = src ? absoluteUrl(decodeEntities(src[2] ?? src[3] ?? src[4] ?? ''), baseUrl) : undefined;
    return target ? `![${inline(label)}](${target})` : '';
  });
  out = out.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t: string, body: string) => `**${inline(body.replace(/<[^>]+>/g, ''))}**`);
  out = out.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t: string, body: string) => `*${inline(body.replace(/<[^>]+>/g, ''))}*`);
  out = out.replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_m, body: string) => `\`${inline(body.replace(/<[^>]+>/g, ''))}\``);
  out = out.replace(/<li\b[^>]*>/gi, '\n- ');
  out = out.replace(/<\/(td|th)\s*>/gi, ' | ');
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<\/(p|div|li|tr|ul|ol|section|blockquote|table|dd|dt)\s*>/gi, '\n\n');
  out = out.replace(/<[^>]+>/g, '');
  out = decodeEntities(out);
  return out
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => (/^(\s*[-*|]|\s*\d+\.)/.test(line) ? line.replace(/\s+$/, '') : line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
