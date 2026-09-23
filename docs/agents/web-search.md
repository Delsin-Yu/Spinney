# Web search (the two built-in web tools)

`web_search` and `web_fetch` are registry tools (`src/tools/webSearch.ts`,
`src/tools/webFetch.ts`) over a backend table (`src/tools/webBackends.ts`) and a
hand-written HTML layer (`src/tools/webHtml.ts`). They need **no API key, no
provider row and no setting** — that is the whole point, and it is a decision, not
a shortcut:

- The target network blocks Google, DuckDuckGo, Mojeek and Wikipedia, while the
  commercial search APIs behind them need a foreign card and have unstable
  latency from there. A tool that only works after the user buys access is a tool
  the agent cannot use.
- The same backend list is **half-dead on the other side of that line**: measured
  from a VPN exit (`loc=US`), Baidu, Sogou and Mojeek answered with captcha walls
  (`百度安全验证`, `验证码`, `Captcha`) and SearXNG's public instance with a challenge
  page, while from the target region (`loc=CN`) those three answer normally and
  DuckDuckGo/Mojeek/Wikipedia do not connect at all. Nothing may assume which side
  this machine is on — see "Learning the network" below.

## The backend table

Order is priority. Machine formats come first: they are cheap, they survive a
redesign of a result page, and they are the same from any region.

| id | kind | region | why it is here |
| --- | --- | --- | --- |
| `bing-rss` | RSS (`&format=rss`) | any | the most reliable general index from the target region; real `<item>` entries |
| `so360` | HTML | cn | `res-list` blocks; the anchor carries the real URL in `data-mdurl` |
| `baidu` | HTML | cn | organic blocks carry `data-url`; the sponsored ones (`baidu.php`) do not, which is the filter that keeps ads out |
| `sogou` | HTML | cn | `vrwrap` blocks; the title anchor holds a real URL |
| `bing` | HTML | any | the same index as `bing-rss`, kept as a fallback (`b_algo` blocks) |
| `hn` | JSON | any | Hacker News via Algolia — keyless, good for tooling chatter |
| `stackexchange` | JSON | any | programming answers, keyless |
| `github` | JSON | any | repository search (10 requests/minute unauthenticated) |

**Adding a backend is one row plus one fixture.** No row exists for an engine
whose real markup was never captured: a parser written from memory returns zero
hits silently, which is the one failure mode that looks like success. The
acceptance driver (`tools/websearch-acceptance.js`, `npm run check:websearch`)
asserts every parser against `tools/fixtures/web-backends/<id>.body`, a response
captured from the real endpoint — so when an engine changes its page, the guard
fails instead of the user. It also pins the traps: `so360` must use `data-mdurl`
and not its `/link` redirect, `baidu` must not emit `baidu.php`, `bing` must not
emit a `/ck/a` click-tracker, `sogou` hrefs must be absolute.

Deliberately **absent**: Quark (its results are not in the served HTML) and every
engine that could not be measured from this machine.

## Learning the network (classification + cooldown)

A search backend answers in one of nine ways, and the difference decides whether a
retry is useful (`src/tools/webBackends.ts`):

`ok` · `empty` · `parse-empty` · `unexpected` · `blocked` · `rate-limited` ·
`http-error` · `timeout` · `aborted`

- `blocked` (captcha/consent/verify) and `parse-empty` (page loaded, nothing
  readable — the upstream markup moved) open a **30 minute** cooldown: the wall is
  real and retrying is a waste of the turn. Two rules were measured into this
  bullet. First, the wall marker is consulted **only when the page parsed to
  nothing** (`classifyEmpty`): a genuine result page can carry 验证码 in a footer or
  an inline script, and testing the marker first classified healthy `so360`/`sogou`
  pages as walls *and* benched them. Second, a well-formed JSON/XML body with zero
  entries is `empty` (no cooldown) and not `parse-empty`: a query with no matches
  used to bench Hacker News, StackExchange and GitHub for half an hour, which is
  damage the backend never did.
- The CN engines **throttle**: within one session, a burst of consecutive queries
  made `so360` serve `<title>访问异常页面` (6.8 KB, zero result blocks) and `sogou` a
  captcha page, while the same queries answered normally again a minute later. So
  a `blocked` here is real *and* temporary — the cooldown is what keeps a retry
  from hammering its way into a longer ban, and the chain simply falls through to
  `baidu`/`bing` meanwhile.
- `rate-limited` (HTTP 429/403) opens 10 minutes.
- `timeout` and `http-error` open 2 minutes and back off up to 3× on repeats,
  because those are the transient ones.
- Any `ok` clears the record.

The state is **in memory for the extension host**, so a reload forgets it. That is
a deliberate v1 limit, not an oversight: the mechanism earns its keep within a
session (a blocked backend must not be re-tried on every search of a long turn
sequence), and persisting it across reloads would need a store keyed by network —
the next step if a real session shows the cost.

`runWebSearch` walks the table, skips backends in cooldown, merges what answers
(de-duplicated by `normalizeUrl`: no fragment, no tracking parameters, no `www.`,
no trailing slash) until the requested count is reached **by hits that match the
query**, or a 25 s budget is spent. Merging is deliberate: one engine answers a
Chinese query from a code corpus badly and a tooling query from an encyclopedia
badly. If **every** backend is in cooldown they are all tried anyway, because "all
eight are quiet" is a diagnosis the user needs, and the tool result says so (the
same reason `search_files` reports `via=rg|walk`: a silent engine swap is
undebuggable).

The relevance half exists because the first live acceptance run caught its absence.
With a plain count-based stop, `bing-rss` — whose query semantics are weak
(measured earlier: `t3.gg browserbase` returned thyroid-medicine pages, and `site:`
is ignored outright) — answered a nonsense query with ten unrelated fund pages, and
the other seven backends were never tried at all; the same run could not reach
`bing`/`hn`/`stackexchange`/`github` with any query. So `hitRelevance` scores every
hit by the fraction of the query's tokens it contains (latin words as written; CJK
characters **and** bigrams, because Chinese is not space-separated, with English
function words dropped), the chain keeps going while nothing matches, and results
are ranked best-first with the backend order as the tie-breaker. The result then
says `N matching the query terms`, or — when nothing matched — an explicit sentence
that the backends answered but nothing matched. Feed noise is never presented as an
answer.

The `attempts:` line in every result names each backend's outcome, and
`Spinney: Test Web Search Backends` (`src/tools/webSearchDiagnostics.ts`) probes
all of them once, ignores the cooldowns, records nothing, and opens a table with
outcome, time and hits per backend. Its strings are localized
(`l10n/bundle.l10n.*.json`); the outcome tokens (`ok`, `blocked`, …) are not — they
are log fields, like `via=rg|walk`.

## `web_fetch` boundaries

- **No JavaScript, no interaction.** A page that renders client-side comes back
  thin, and the tool says so instead of pretending. This is not a browser, and it
  does not try to be: the vendors who sell browser sessions list exactly the
  operational surface that implies (session lifecycle, stealth, proxy rotation),
  and their own documentation argues the browser is the *cheap* part of it.
- **Private addresses are refused** (`publicUrlProblem`): `localhost`, `*.local`,
  `*.internal`, and every private/reserved range, including the cloud metadata
  address. The check runs on **every redirect hop** (the fetch follows redirects
  by hand with `redirect: 'manual'`), because a public URL that 302s to
  `127.0.0.1` is the classic bypass. The parse half of the defence is WHATWG
  `new URL()` itself: it normalizes `2130706433`, `0x7f.0.0.1` and
  `http://127.0.0.1\@evil.com/` into the host the socket would really use — the
  acceptance driver pins each of those spellings.
- **Residual risk, stated rather than hidden:** the hostname is resolved for the
  check and resolved again for the connection, so a DNS entry that changes between
  the two (DNS rebinding) is not caught. Pinning the address needs a custom
  connector, which the zero-dependency rule rules out. The exposure is bounded by
  what the tool can do with the result — it returns text to a model, it does not
  execute anything.
- **2 MB, read streaming** — a cap checked after `arrayBuffer()` is not a cap.
- **The page's own charset**, via `decodeBody` (`gbk`/`gb2312`/`gb18030` →
  `gbk`, `latin1` → `windows-1252`, otherwise the declared label, UTF-8 as the
  floor). Wrong here is worse than a fetch error: `gbk` bytes read as UTF-8 are
  replacement characters that look like content.
- **A failure says why.** `describeFetchError` surfaces `error.cause`: Node leaves
  `message` as the useless `fetch failed` and puts `ENOTFOUND` / `ECONNRESET` /
  `UND_ERR_*` / the TLS code in `cause`. Without it the first acceptance run could
  not tell a DNS failure from a blocked site on three huggingface.co URLs (10 s
  each, no status, no reason).
- **An empty extraction is reported, never silent.** `HTTP 200 · 72914 bytes` with
  no readable text looks like success; the note is therefore driven by the size of
  the **result**, not by which extraction path ran — `no readable text was found —
  the page most likely renders its content with JavaScript, or it blocks automated
  readers`. A genuinely thin page says so too.
- **HTML → Markdown** in `webHtml.ts`: headings, paragraphs, lists, links,
  emphasis, code, tables; script/style/nav/header/footer/iframe/svg are dropped.
  Two rules that were learned from real pages: never scan raw HTML with a regex
  that spans tags (inline JavaScript contains `<` and `>`), and never insert a
  space at a tag boundary (joining two Chinese fragments with a space is visible
  in every sentence the model then reads).
- **Untrusted data.** Both tool descriptions carry it, and the results repeat it:
  an instruction found on a page is not a grant (see `AGENTS.md`, "untrusted
  data").

## Where the shape comes from

The research behind these decisions is summarized here so a future change does not
re-litigate it from taste:

- `dirmacs/daedra` (Rust, MIT): machine-format backends before scrapers, per-backend
  circuit breakers, classified retry ("bot protection and rate-limit errors fail
  fast"), relevance merge. Its backend list is Western-only, which is exactly what
  this table replaces.
- `Aas-ee/open-websearch` and `open-webui`'s `retrieval/web/**`: the per-engine
  `index`/`parser` split, the CN engine set, and `open-webui`'s `utils.py` as the
  reference SSRF implementation (hostname resolution, embedded-IPv4 checks,
  `_SSRFSafeConnector` for DNS rebinding).
- `searxng/searxng`: per-engine suspension times (`SearxEngineCaptcha: 3600`) —
  the same idea as the cooldown table here — and the fact that its own
  `search.formats` ships `html` only, i.e. `format=json` is opt-in.
- Commercial pricing, which is where this design stops: Browserbase charges
  **$7 / 1k** searches and **$0.5–1 / 1k** fetches, but **$0.10–0.12 per browser
  hour** plus **$10–12 / GB** of proxy traffic. The cheap tier is worth embedding;
  the expensive tier is not worth building.
- `microsoft/playwright-mcp`'s own README ("coding agents increasingly favour CLI
  over MCP: they avoid loading large tool schemas and verbose accessibility trees
  into the model context") plus the wider criticism of MCP tool bloat: keep the
  surface narrow — two tools, no browser.

## Deliberate v1 limits

- **Extraction fidelity has a ceiling.** A page whose model names live inside card
  components (measured on one vendor's "build" console page) comes back without
  them. The converter keeps headings, links, lists and code; it is not a layout
  engine.
- **Only the cooldown's *recovery* is unobserved.** The `blocked` classification
  itself has been seen live (see the throttling note above: after a burst of
  queries `so360` served its access-anomaly page and `sogou` a captcha page, and
  `sogou` answered normally again within the minute). What nobody has watched yet
  is a backend coming back *after* its cooldown expires and a later search using it
  again — the five-minute check is to search, wait out the window, and search again.

- No `spinney.webSearch.*` setting and no keyed backend. A self-hosted SearXNG
  (`?format=json`, opt-in on the instance) is the obvious first optional row if a
  user needs one; it would add a setting and therefore a manual section.
- No persistence of backend health across reloads (see above).
- No proxy support: `fetch` in the extension host does not read the system proxy,
  and honoring `http.proxy` would mean a dependency.
- No PDF, no binaries, no crawling, no multi-page research loop.
- Sub-agents get both tools (they are read-only in the sense that matters — nothing
  on this machine changes), which is also how a read-only sub-agent finally gets a
  network research surface at all: `exec_command` is a *write* tool and stays hidden
  from it.
