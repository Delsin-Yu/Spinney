/*
 * websearch-acceptance — drives the COMPILED web tools with a stubbed `vscode`,
 * so the parts that cannot be trusted to stay working are tested without a window
 * and without the network (dev-only; not shipped in the `.vsix`).
 *
 * Why it exists: `web_search` reads search-result pages. An engine that redesigns
 * its markup does not return an error — it returns a *different page*, the parser
 * finds nothing, and the tool reports "no results", which looks exactly like "the
 * answer does not exist". The only defence that has ever worked for this class of
 * code is a saved response per engine: every parser below is asserted against
 * `tools/fixtures/web-backends/<id>.body`, captured from the real endpoint. When an
 * engine changes its page, this script fails instead of the user.
 *
 * It also pins the decisions that were made against real behaviour: private-address
 * refusal for `web_fetch` (including the URL-normalization tricks), gbk decoding,
 * CJK-safe text extraction, result de-duplication, and the per-backend cooldown.
 *
 *   npx tsc -p ./ && node tools/websearch-acceptance.js [<outDir>]
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.resolve(
  process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(ROOT, 'out'),
);
const FIXTURES = path.join(__dirname, 'fixtures', 'web-backends');

const vscodeStub = {
  env: { appRoot: null, language: 'en' },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: ROOT, toString: () => 'file:///' + ROOT.split(path.sep).join('/') } }],
    getConfiguration: () => ({ get: () => undefined }),
  },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  return origLoad.call(this, request, parent, isMain);
};

const webHtml = require(path.join(OUT_DIR, 'tools', 'webHtml.js'));
const webBackends = require(path.join(OUT_DIR, 'tools', 'webBackends.js'));
const webFetch = require(path.join(OUT_DIR, 'tools', 'webFetch.js'));
const webSearch = require(path.join(OUT_DIR, 'tools', 'webSearch.js'));

let failures = 0;
let checks = 0;

function check(name, condition, detail) {
  checks++;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function fixture(id) {
  const file = path.join(FIXTURES, `${id}.body`);
  if (!fs.existsSync(file)) {
    throw new Error(`missing fixture ${file}`);
  }
  return fs.readFileSync(file, 'utf8');
}

function backend(id) {
  const found = webBackends.WEB_BACKENDS.find((candidate) => candidate.id === id);
  if (!found) {
    throw new Error(`no backend "${id}" in the table`);
  }
  return found;
}

async function main() {
  console.log('\n== parsers against the saved responses ==');
  const EXPECTED = [
    { id: 'bing-rss', min: 5, note: 'RSS items' },
    { id: 'bing', min: 5, note: 'b_algo blocks' },
    { id: 'so360', min: 5, note: 'res-list blocks' },
    { id: 'baidu', min: 3, note: 'organic result blocks' },
    { id: 'sogou', min: 5, note: 'vrwrap blocks' },
    { id: 'hn', min: 1, note: 'Algolia JSON hits' },
    { id: 'stackexchange', min: 1, note: 'StackExchange JSON items' },
    { id: 'github', min: 1, note: 'GitHub repository items' },
  ];
  for (const { id, min, note } of EXPECTED) {
    let hits = [];
    let error;
    try {
      hits = backend(id).parse(fixture(id));
    } catch (err) {
      error = err;
    }
    const bad = hits.find(
      (hit) => !hit.title || !/^https?:\/\//i.test(hit.url) || /[<>]/.test(hit.title) || hit.url.startsWith('/'),
    );
    check(
      `${id}: parses >= ${min} ${note}`,
      !error && hits.length >= min && !bad,
      error ? error.message : `got ${hits.length}${bad ? `, bad entry ${JSON.stringify(bad).slice(0, 120)}` : ''}`,
    );
  }

  console.log('\n== engine-specific traps the parsers must keep avoiding ==');
  const so360 = backend('so360').parse(fixture('so360'));
  check(
    'so360: uses data-mdurl, not the /link redirect',
    so360.some((hit) => /^https?:\/\/(www\.)?deepseek\.com/.test(hit.url)) && !so360.some((hit) => /so\.com\/link/.test(hit.url)),
    so360[0] && so360[0].url,
  );
  const baidu = backend('baidu').parse(fixture('baidu'));
  check('baidu: no sponsored baidu.php redirects', !baidu.some((hit) => /baidu\.php/.test(hit.url)), baidu[0] && baidu[0].url);
  const bing = backend('bing').parse(fixture('bing'));
  check('bing: no click-tracker URLs survive', !bing.some((hit) => /bing\.com\/ck\//.test(hit.url)), bing[0] && bing[0].url);
  const sogou = backend('sogou').parse(fixture('sogou'));
  check('sogou: every href is absolute', sogou.every((hit) => /^https?:\/\//.test(hit.url)), sogou[0] && sogou[0].url);
  check(
    'the wall detectors match the real wall pages',
    backend('baidu').blocked.test('<title>百度安全验证</title>') &&
      backend('sogou').blocked.test('请输入验证码') &&
      !backend('baidu').blocked.test('<title>deepseek_百度搜索</title>'),
  );
  check(
    'an RSS-shaped body is distinguishable from an HTML wall',
    /^\s*(?:<\?xml|<rss|<feed)/i.test(fixture('bing-rss')) && !/^\s*(?:<\?xml|<rss|<feed)/i.test(fixture('baidu')),
  );

  console.log('\n== url identity (de-duplication) ==');
  const a = webBackends.normalizeUrl('https://www.Example.com/page/?utm_source=x&utm_medium=y#section');
  const b = webBackends.normalizeUrl('https://example.com/page');
  check('tracking parameters, www, trailing slash and fragment collapse', a === b, `${a} vs ${b}`);
  check(
    'query parameters still separate two results',
    webBackends.normalizeUrl('https://example.com/a?id=1') !== webBackends.normalizeUrl('https://example.com/a?id=2'),
  );

  console.log('\n== backend cooldown (the region-adaptive half) ==');
  webBackends.resetHealth();
  check('a healthy backend is not skipped', webBackends.backendCooldown('baidu') === 0);
  webBackends.recordOutcome('baidu', 'blocked');
  check('a captcha wall opens a long cooldown', webBackends.backendCooldown('baidu') > 20 * 60_000);
  webBackends.recordOutcome('baidu', 'ok');
  check('one success clears it', webBackends.backendCooldown('baidu') === 0);
  webBackends.recordOutcome('so360', 'timeout');
  const first = webBackends.backendCooldown('so360');
  webBackends.recordOutcome('so360', 'timeout');
  check(
    'transient failures back off further on repeat',
    webBackends.backendCooldown('so360') > first,
    `${first} then ${webBackends.backendCooldown('so360')}`,
  );
  webBackends.resetHealth();

  console.log('\n== charset decoding ==');
  const gbk = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]); // 中文 in GBK
  const decoded = webHtml.decodeBody(gbk, 'text/html; charset=gb2312');
  check('gb2312 is really decoded as gbk', decoded.text === '中文' && decoded.charset === 'gbk', JSON.stringify(decoded));
  const declared = webHtml.decodeBody(
    Uint8Array.from(Buffer.from('<html><head><meta charset="gb18030"></head></html>', 'utf8')),
    'text/html',
  );
  check('a meta charset is honoured when the header is silent', declared.charset === 'gbk', declared.charset);
  const utf8 = webHtml.decodeBody(Uint8Array.from(Buffer.from('中文 ok', 'utf8')), 'text/html; charset=utf-8');
  check('utf-8 stays utf-8', utf8.text === '中文 ok', utf8.text);

  console.log('\n== text extraction ==');
  const html =
    '<html><head><style>p{color:red}</style><script>var a = "</div>";</script></head>' +
    '<body><nav>menu</nav><p>中文<b>粗体</b>文字</p><p>second &amp; <a href="/x">link</a></p></body></html>';
  const text = webHtml.textOf(html);
  check('script and style content never leaks into text', !/color:red|var a/.test(text), text);
  check('entities are decoded', text.includes('second &') && !text.includes('&amp;'), text);
  check('CJK does not gain spaces around inline tags', text.includes('中文粗体文字'), text);
  const markdown = webHtml.htmlToMarkdown(webHtml.stripChrome(html), 'https://example.com/base/');
  check('links become absolute markdown links', markdown.includes('[link](https://example.com/x)'), markdown);
  check('navigation is dropped', !markdown.includes('menu'), markdown);

  console.log('\n== web_fetch boundaries ==');
  const privateAddresses = [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '198.18.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1',
  ];
  const publicAddresses = ['93.184.216.34', '8.8.8.8', '1.1.1.1', '2606:4700::1111'];
  check(
    'private/reserved addresses are refused',
    privateAddresses.every((address) => !webFetch.isPublicAddress(address)),
    privateAddresses.filter((address) => webFetch.isPublicAddress(address)).join(', ') || undefined,
  );
  check(
    'public addresses are allowed',
    publicAddresses.every((address) => webFetch.isPublicAddress(address)),
    publicAddresses.filter((address) => !webFetch.isPublicAddress(address)).join(', ') || undefined,
  );
  const leaked = [];
  const rejections = [
    ['file:///etc/passwd', 'non-http protocol'],
    ['http://localhost/', 'localhost'],
    ['http://127.0.0.1/', 'loopback literal'],
    ['http://[::1]/', 'ipv6 loopback'],
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
    ['http://2130706433/', 'decimal-encoded loopback'],
    ['http://0x7f.0.0.1/', 'hex-encoded loopback'],
    ['http://127.0.0.1\\@example.com/', 'backslash userinfo trick'],
    ['http://foo.local/', 'local-only name'],
    ['http://bar.internal/', 'internal name'],
  ];
  for (const [url, why] of rejections) {
    if (!(await webFetch.publicUrlProblem(url))) {
      leaked.push(`${url} (${why})`);
    }
  }
  check('web_fetch refuses every private/loopback spelling', leaked.length === 0, leaked.join('; ') || undefined);

  console.log('\n== relevance (why the chain keeps going past its first backend) ==');
  {
    const tokens = webBackends.queryTokens('non-layered-tidy-tree-layout npm usage example');
    check('latin query tokens keep hyphenated names whole', tokens.includes('non-layered-tidy-tree-layout'), tokens.join(','));
    check('english function words are dropped', !webBackends.queryTokens('how to use this').includes('how'));
    const cjk = webBackends.queryTokens('DeepSeek 本地部署 显存');
    check('a Chinese query yields character bigrams', cjk.includes('部署') && cjk.includes('显存'), cjk.join(','));
    const nonsense = webBackends.queryTokens('zynthos flumox reranker quantization bug tracker');
    const fund = {
      title: 'VFINX-Vanguard 500 Index Fund',
      url: 'https://finance.example.com/vfinx',
      snippet: 'Expense ratio 0.14%, minimum investment 3000 USD',
    };
    check('an unrelated page scores zero against a nonsense query', webBackends.hitRelevance(fund, nonsense) === 0);
    check('the same page scores zero against a Chinese query', webBackends.hitRelevance(fund, cjk) === 0);
    const onTopic = {
      title: 'non-layered-tidy-tree-layout 用法',
      url: 'https://example.com/p/123',
      snippet: 'npm usage example for the layout engine',
    };
    check('an on-topic page scores above zero', webBackends.hitRelevance(onTopic, tokens) > 0);
    check('an empty token list is treated as "everything matches"', webBackends.hitRelevance(fund, []) === 1);
    // The live defect: "bug tracker" pages matched two of seven nonsense tokens and
    // were reported as matches. The bar must sit above that.
    const weak = { title: 'Bug-Tracker 缺陷跟踪系统', url: 'https://example.com/bug', snippet: 'bug tracker 百科' };
    check(
      'a two-of-seven overlap is below the relevance bar',
      webBackends.hitRelevance(weak, nonsense) < webBackends.RELEVANT_SCORE,
      String(webBackends.hitRelevance(weak, nonsense)),
    );
    check(
      'a two-of-four overlap is below the bar while a three-of-four overlap passes',
      webBackends.hitRelevance({ title: 'deepseek 部署', url: 'https://e.com/a', snippet: '' }, cjk) <
        webBackends.RELEVANT_SCORE &&
        webBackends.hitRelevance({ title: 'DeepSeek 本地部署显存', url: 'https://e.com/a', snippet: '' }, cjk) >=
          webBackends.RELEVANT_SCORE,
    );
  }

  console.log('\n== an empty result is not always damage ==');
  {
    const htmlWithFooterWall = '<html><body><div class="result">x</div>联系我们，遇到验证码请反馈</body></html>';
    check(
      'a result page that merely mentions 验证码 is not blocked (parse first)',
      webBackends.classifyEmpty(backend('baidu'), htmlWithFooterWall).outcome === 'parse-empty',
    );
    check(
      'a wall page with no results is blocked',
      webBackends.classifyEmpty(backend('baidu'), '<html><title>百度安全验证</title></html>').outcome === 'blocked',
    );
    check(
      'an empty JSON body is an honest "no results", not damage',
      webBackends.classifyEmpty(backend('github'), '{"total_count":0,"items":[]}').outcome === 'empty',
    );
    check(
      'an empty RSS feed is an honest "no results", not damage',
      webBackends.classifyEmpty(backend('bing-rss'), '<rss version="2.0"><channel></channel></rss>').outcome === 'empty',
    );
    check(
      'a wall page yields no parseable results, which is why the marker is only consulted for an empty parse',
      backend('baidu').parse('<html><title>百度安全验证</title></html>').length === 0 &&
        backend('baidu').blocked.test('<title>百度安全验证</title>'),
    );
  }

  console.log('\n== tool surface ==');
  check(
    'web_search is a tool with a required query',
    webSearch.webSearchTool.definition.function.name === 'web_search' &&
      webSearch.webSearchTool.definition.function.parameters.required.join(',') === 'query',
  );
  check(
    'the tool description warns that results are untrusted data',
    /untrusted/i.test(webSearch.webSearchTool.definition.function.description) &&
      /never/i.test(webSearch.webSearchTool.definition.function.description),
  );
  check(
    'web_fetch is a tool with a required url',
    webFetch.webFetchTool.definition.function.name === 'web_fetch' &&
      webFetch.webFetchTool.definition.function.parameters.required.join(',') === 'url',
  );
  check(
    'web_fetch says it runs no JavaScript',
    /does NOT run JavaScript/i.test(webFetch.webFetchTool.definition.function.description),
  );
  check(
    'every backend row carries an id, label, shape and note',
    webBackends.WEB_BACKENDS.every((entry) => entry.id && entry.label && entry.note && entry.shape),
  );
  const empty = await webSearch.webSearchTool.execute({ query: '' }, undefined);
  check('an empty query is refused with a clear error', /non-empty/.test(empty), empty);

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\nwebsearch-acceptance crashed: ${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
