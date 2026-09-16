// check-models.js — fails the build when a model id drifts away from the catalog.
//
// The catalog lives in `src/agent/models.ts` (compiled to `out/agent/models.js`).
// It is no longer a list of *models the user may pick*: a model is a **card**
// (`spinney.modelCards`) bound to a **provider** (`spinney.providers`), both edited
// by the Model Card Tree page. The one model the extension ships knowledge about
// is the **fallback card** (`VENDORED_MODEL` / `DEFAULT_MODEL`), which is what a
// fresh profile runs on before anything is configured.
//
// The rules are about *naming a model id*, never about behaviour:
//
//   1. The manifest may name the fallback: `spinney.model.default` must be it, and
//      the two catalog settings the page writes must exist as object schemas.
//   2. User-facing copy (`package.json`'s model description, `README.md`,
//      `docs/**`) may name models, but only ids the catalog has. A renamed or
//      dropped model therefore cannot leave a stale id behind in the UI or docs.
//   3. Plugin text and code (`src/**/*.ts`, minus the catalog itself, and
//      `media/**/*.js`, minus the vendored bundles) may **not** name a model id at
//      all. The system prompt, tool descriptions and tool error messages must
//      derive the names at runtime (`visionCardsLabel()` / `cardDisplayName()`),
//      so a model swap can never turn shipped prompt text into a lie.
//
// One more thing is guarded here, because it drifts the same way: the wallet readout.
// `ProviderSpec.balance` (`src/agent/balance.ts`) is a **declaration on the row** —
// which endpoint's dialect knows that provider's credit — so section 4 pins the
// dialect a silent row lands on, the one an explicit field (or its `wallet` alias)
// wins with, the reset targets, and the request + normalization `fetchBalance` turns
// it into against a stubbed `fetch`.
//
// Run by `npm run check:models`, which `vsce package` executes through
// `vscode:prepublish` — so a drift fails packaging, not the user's session.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const catalogPath = path.join(root, 'out', 'agent', 'models.js');

if (!fs.existsSync(catalogPath)) {
  console.error('check-models: out/agent/models.js is missing — run `npm run compile` first.');
  process.exit(1);
}

const { MODEL_CATALOG, DEFAULT_MODEL } = require(catalogPath);
const ids = MODEL_CATALOG.map((m) => m.id);
// Lowercased: a `DeepSeek-Flash` typo in code is the same drift as the real id.
const idSet = new Set(ids.map((id) => id.toLowerCase()));

// Matches the harness's model ids but not hostnames such as api.deepseek.com: it
// needs the `deepseek-` prefix plus one more name character. The catalog ids are
// listed explicitly too, so a card on another vendor cannot slip past the check,
// and a typo of a real id (`deepseek-flashx`) still fails as an unknown model.
const MODEL_RE = new RegExp(
  [...new Set([...ids.map(escapeRegex), 'deepseek-[a-z0-9][a-z0-9.\\-]*'])].join('|'),
  'gi',
);

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const problems = [];

function scan(file, text, { allowAny = false } = {}) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const match of line.match(MODEL_RE) || []) {
      const id = match.toLowerCase();
      if (allowAny ? !idSet.has(id) : idSet.has(id)) {
        problems.push(
          allowAny
            ? `${file}:${i + 1}: names an unknown model "${match}" (add it to MODEL_CATALOG or reword)`
            : `${file}:${i + 1}: hardcodes the model id "${match}" — use DEFAULT_MODEL / cardDisplayName() from src/agent/models.ts`,
        );
      }
    }
  });
}

// --- 1. the manifest: the fallback default, and the two catalog settings -------
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

/**
 * `contributes.configuration` is contributed as one entry per Settings-UI group
 * (an array of `{ title, properties }`), so flatten it before looking a key up:
 * the sections are presentation, the property set is what this guard checks.
 */
function configurationProperties(contributes) {
  const sections = contributes?.configuration;
  return (Array.isArray(sections) ? sections : sections ? [sections] : []).reduce(
    (all, section) => Object.assign(all, section?.properties ?? {}),
    {},
  );
}

const configProps = configurationProperties(pkg.contributes);
const modelProp = configProps['spinney.model'];
if (modelProp?.default !== DEFAULT_MODEL) {
  problems.push(`package.json: spinney.model.default is "${modelProp?.default}", expected "${DEFAULT_MODEL}"`);
}
for (const key of ['spinney.providers', 'spinney.modelCards']) {
  const prop = configProps[key];
  if (!prop) {
    problems.push(`package.json: ${key} is missing (the Model Card Tree page writes it)`);
  } else if (prop.type !== 'object') {
    problems.push(`package.json: ${key} must be an object of id → fields, got "${prop.type}"`);
  }
}
// The dropdown is built from the cards at runtime, so the setting must NOT carry a
// stale enum any more — an enum is exactly the drift this guard exists to prevent.
if (Array.isArray(modelProp?.enum)) {
  problems.push(`package.json: spinney.model must not carry an enum any more (the cards are the list)`);
}

// --- 2. copy may name models, but only real ones -----------------------------
scan('package.json', JSON.stringify(configProps['spinney.model'], null, 1), { allowAny: true });
scan('README.md', fs.readFileSync(path.join(root, 'README.md'), 'utf8'), { allowAny: true });

for (const dir of ['docs', 'manual']) {
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.md')) {
        scan(path.relative(root, full).replace(/\\/g, '/'), fs.readFileSync(full, 'utf8'), { allowAny: true });
      }
    }
  };
  walk(path.join(root, dir));
}

// --- 3. code and plugin text may not name a model id at all ------------------
const srcRoot = path.join(root, 'src');
const catalogRel = path.join('agent', 'models.ts');

function walkCode(dir, ext, skipRel) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkCode(full, ext, skipRel);
    } else if (entry.name.endsWith(ext)) {
      const rel = path.relative(root, full);
      if (skipRel && skipRel(rel)) {
        continue;
      }
      scan(rel.replace(/\\/g, '/'), fs.readFileSync(full, 'utf8'));
    }
  }
}
walkCode(srcRoot, '.ts', (rel) => rel === path.join('src', catalogRel));
// The webviews live in media/ and must not carry a second copy of the catalog
// either: they render the card list the provider posts. Vendored JS is off limits
// — it is hash-fixed.
walkCode(path.join(root, 'media'), '.js', (rel) => rel.startsWith(path.join('media', 'vendor')));

// --- 4. the wallet readout: a declaration on the row, never a probe -----------
//
// `ProviderSpec.balance` (`src/agent/balance.ts`) is the second thing a provider row
// declares about itself, right after its URL, and it is read on three paths that have
// to agree: the row parser, the reset defaults the Model Card Tree page's ↺ buttons
// apply, and `fetchBalance` itself. None of that shows up in a drift scan, and a wrong
// dialect does not crash either — it renders another vendor's payload as `0.00` next to
// a real account, which is exactly what `balance.ts` refuses to do. The rule is strict
// on purpose: **every** number a dialect's own arithmetic needs is required — DeepSeek's
// `balance_infos` *and* each entry's `total_balance`, OpenRouter's `total_credits` *and*
// `total_usage`, Moonshot's `available_balance` — so a payload that half-arrives throws
// rather than showing a real usage as nothing, or nothing as a real balance. This
// section therefore pins the declaration (1–3) and the one request it turns into (4–5).
//
// The fetch half runs against a **stubbed** `globalThis.fetch`: nothing here may touch
// the network, and the stub is what makes "the URL is the base plus the dialect's own
// path" and "the Bearer header is sent" observable at all.

const balancePath = path.join(root, 'out', 'agent', 'balance.js');
if (!fs.existsSync(balancePath)) {
  console.error('check-models: out/agent/balance.js is missing — run `npm run compile` first.');
  process.exit(1);
}

const { BALANCE_DIALECTS, isBalanceDialect, emptyBalance, fetchBalance } = require(balancePath);
// The same module the scan above requires, asked for the names only the wallet checks
// look at: the row parser, the host table behind it, and the reset targets.
const {
  parseCatalog,
  providerBalanceFromUrl,
  defaultsForProvider,
  VENDORED_PROVIDER,
  BUILTIN_PROVIDER_DEFAULTS,
  FRESH_PROVIDER_DEFAULTS,
  CATALOG_ISSUE_TEXT,
} = require(catalogPath);

// The drift scan fails the build through `problems`; these checks report the same way —
// one line per assertion, the failures collected and listed under one headline.
const walletProblems = [];
const ok = (label, cond, detail) => {
  console.log(`  [${cond ? 'ok  ' : 'FAIL'}] ${label}${detail ? '  (' + detail + ')' : ''}`);
  if (!cond) walletProblems.push(label);
};

/** One provider row as `parseCatalog` reads it: the row it accepted, and what it reported. */
function parseRow(fields) {
  const { providers, errors } = parseCatalog({ row: fields }, {});
  return { row: providers[0], errors };
}

console.log('-- the dialect a silent provider row lands on (by host) --');
const deepseekRow = parseRow({ url: 'https://api.deepseek.com' });
ok(
  'a row with no `balance` field is read by its host: api.deepseek.com → deepseek',
  !!deepseekRow.row && deepseekRow.row.balance === 'deepseek',
  deepseekRow.errors.join(' | '),
);
ok('  … and the row parses cleanly (the user declares nothing)', !!deepseekRow.row && deepseekRow.errors.length === 0);
const localRow = parseRow({ url: 'http://localhost:8000/v1' });
ok('a local endpoint lands on none', !!localRow.row && localRow.row.balance === 'none', String(localRow.row && localRow.row.balance));
ok(
  'providerBalanceFromUrl() agrees on both',
  providerBalanceFromUrl('https://api.deepseek.com') === 'deepseek' && providerBalanceFromUrl('http://localhost:8000/v1') === 'none',
  providerBalanceFromUrl('http://localhost:8000/v1'),
);
ok('  … and a path after the host does not change it', providerBalanceFromUrl('https://api.deepseek.com/v1') === 'deepseek');
ok('  … nor does any other *.deepseek.com host', providerBalanceFromUrl('https://beta.deepseek.com') === 'deepseek');

console.log('-- an explicit dialect, the alias, and the one that is refused --');
const explicitRow = parseRow({ url: 'https://api.deepseek.com', balance: 'openrouter' });
ok('an explicit `balance` survives parseCatalog', !!explicitRow.row && explicitRow.row.balance === 'openrouter', String(explicitRow.row && explicitRow.row.balance));
ok('  … and it wins over the host default', !!explicitRow.row && explicitRow.row.balance !== providerBalanceFromUrl('https://api.deepseek.com'));
const aliasRow = parseRow({ url: 'https://openrouter.ai/api/v1', wallet: 'openrouter' });
ok(
  'the alias key `wallet` is accepted the same way',
  !!aliasRow.row && aliasRow.row.balance === 'openrouter' && aliasRow.errors.length === 0,
  aliasRow.errors.join(' | '),
);
const bogusRow = parseRow({ url: 'https://api.deepseek.com', balance: 'not-a-dialect' });
ok('an unknown dialect makes the row unusable', bogusRow.row === undefined, JSON.stringify(bogusRow.row));
ok(
  '  … with the reason in errors (never silently `none`)',
  bogusRow.errors.length === 1 && bogusRow.errors[0].includes('not-a-dialect'),
  bogusRow.errors.join(' | '),
);
const bogusAlias = parseRow({ url: 'https://api.deepseek.com', wallet: 'not-a-dialect' });
ok('  … and the alias is validated exactly like the field', bogusAlias.row === undefined && bogusAlias.errors.length === 1, bogusAlias.errors.join(' | '));

console.log('-- the reset targets, and the list the page offers --');
ok(
  "defaultsForProvider('default') resets to deepseek",
  defaultsForProvider('default').balance === 'deepseek' && BUILTIN_PROVIDER_DEFAULTS.balance === 'deepseek',
  defaultsForProvider('default').balance,
);
ok('  … and the vendored row itself carries it', VENDORED_PROVIDER.balance === 'deepseek', VENDORED_PROVIDER.balance);
const otherDefaults = defaultsForProvider('wallet-two');
ok('any other provider id resets to none', otherDefaults.balance === 'none' && FRESH_PROVIDER_DEFAULTS.balance === 'none', otherDefaults.balance);
ok("BALANCE_DIALECTS is the four dialects, in the page's order", BALANCE_DIALECTS.join(',') === 'none,deepseek,openrouter,moonshot', BALANCE_DIALECTS.join(','));
ok('  … and only they pass isBalanceDialect()', BALANCE_DIALECTS.every((d) => isBalanceDialect(d)) && !isBalanceDialect('not-a-dialect'));

console.log('-- one readout per dialect, against a stubbed fetch --');

// The real `fetch`, saved once: every stub below puts it back, so a throw inside one
// readout can never leave a fake network installed for the check after it.
const realFetch = globalThis.fetch;
/** The key every request in this section is sent with. */
const WALLET_KEY = 'sk-wallet';

/**
 * Install the stub for ONE readout. It records what it was asked for — the URL and the
 * headers, the two halves of the contract a return value cannot show — and answers
 * `body` at `status`.
 */
function stubFetch(status, body) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: `HTTP ${status}`,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      json: async () => body,
    };
  };
  return calls;
}

/**
 * The four readouts, as the wire really carries them: the provider's `baseUrl` plus the
 * dialect's own path, and the payload each vendor sends. DeepSeek's base carries a
 * **trailing slash** on purpose — a hand-edited settings.json usually has one — and
 * `wantKeys` pins the entry's key *set*, because a `granted: undefined` would stringify
 * away: a field the vendor never sent has to be absent, never a zero.
 */
const WALLET_CASES = [
  {
    dialect: 'deepseek',
    baseUrl: 'https://api.deepseek.com/',
    path: '/user/balance',
    // The numbers arrive as strings.
    body: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '10.00', topped_up_balance: '2.34' }] },
    want: { isAvailable: true, balances: [{ currency: 'CNY', total: 12.34, granted: 10, toppedUp: 2.34 }] },
    wantKeys: 'currency,granted,toppedUp,total',
  },
  {
    dialect: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    path: '/credits',
    body: { data: { total_credits: 10, total_usage: 2.34 } },
    want: { isAvailable: true, balances: [{ currency: 'USD', total: 7.66, used: 2.34 }] },
    wantKeys: 'currency,total,used',
  },
  {
    dialect: 'moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    path: '/users/me/balance',
    body: { data: { available_balance: 30, voucher_balance: 10, cash_balance: 20 } },
    want: { isAvailable: true, balances: [{ currency: 'CNY', total: 30, granted: 10, toppedUp: 20 }] },
    wantKeys: 'currency,granted,toppedUp,total',
  },
  {
    dialect: 'none',
    baseUrl: 'http://localhost:8000/v1',
    path: '',
    // No body at all: this is the one dialect that must not send a request.
    want: { isAvailable: true, balances: [] },
  },
];

/** One readout as the caller builds it; the stub answers whatever dialect it names. */
const walletRequest = (dialect, apiKey = WALLET_KEY) => ({ dialect, baseUrl: 'https://api.deepseek.com', apiKey, providerName: 'Wallet' });

/**
 * Run one readout that must fail, and hand back both halves of the evidence: what it
 * threw (or nothing, when it wrongly answered) and what the stub saw.
 */
async function refusal(request, reply) {
  const calls = stubFetch(reply.status ?? 200, reply.body);
  try {
    await fetchBalance(request);
    return { calls };
  } catch (err) {
    return { err, calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** The awaited half of this section — a function because the summary runs after it. */
async function checkWalletFetch() {
  for (const c of WALLET_CASES) {
    const expected = c.baseUrl.replace(/\/$/, '') + c.path;
    const calls = stubFetch(200, c.body);
    let readout;
    try {
      readout = await fetchBalance({ dialect: c.dialect, baseUrl: c.baseUrl, apiKey: WALLET_KEY, providerName: 'Wallet' });
    } catch (err) {
      ok(`${c.dialect}: the readout is fetched at all`, false, err instanceof Error ? err.message : String(err));
      continue;
    } finally {
      // Restored on every path, the failing one included.
      globalThis.fetch = realFetch;
    }
    if (c.dialect === 'none') {
      ok('none sends no request at all', calls.length === 0, `${calls.length} request(s)`);
      ok('  … and answers the empty readout', JSON.stringify(readout) === JSON.stringify(emptyBalance()), JSON.stringify(readout));
      continue;
    }
    ok(`${c.dialect}: the request is GET ${expected}`, calls.length === 1 && calls[0].url === expected, calls.map((x) => x.url).join(', ') || 'no request');
    ok(
      '  … carrying `Authorization: Bearer <key>`',
      !!calls[0] && calls[0].headers.Authorization === `Bearer ${WALLET_KEY}`,
      calls[0] && String(calls[0].headers.Authorization),
    );
    ok(
      `  … and the ${c.want.balances[0].currency} readout is normalized`,
      JSON.stringify(readout) === JSON.stringify(c.want) && Object.keys(readout.balances[0] ?? {}).sort().join(',') === c.wantKeys,
      JSON.stringify(readout),
    );
  }

  console.log('-- a wrong dialect, a bad status, a missing key: all of them throw --');
  const noInfos = await refusal(walletRequest('deepseek'), { body: { is_available: true } });
  ok(
    'deepseek: a payload without balance_infos throws (never 0.00)',
    !!noInfos.err && /balance_infos/.test(noInfos.err.message),
    noInfos.err && noInfos.err.message,
  );
  // The list is not enough: the entry has to carry the number the line is about, or an
  // account with money in it would render as `0.00`.
  const noTotal = await refusal(walletRequest('deepseek'), { body: { is_available: true, balance_infos: [{ currency: 'CNY' }] } });
  ok(
    'deepseek: an entry without total_balance throws (never 0.00)',
    !!noTotal.err && /total_balance/.test(noTotal.err.message),
    noTotal.err && noTotal.err.message,
  );
  const noCredits = await refusal(walletRequest('openrouter'), { body: { data: { total_usage: 2 } } });
  ok(
    'openrouter: a payload without total_credits throws',
    !!noCredits.err && /total_credits/.test(noCredits.err.message),
    noCredits.err && noCredits.err.message,
  );
  // The spend is required too: without it the remainder would show the whole credit line
  // as still available.
  const noUsage = await refusal(walletRequest('openrouter'), { body: { data: { total_credits: 10 } } });
  ok(
    'openrouter: a payload without total_usage throws',
    !!noUsage.err && /total_usage/.test(noUsage.err.message),
    noUsage.err && noUsage.err.message,
  );
  const noAvailable = await refusal(walletRequest('moonshot'), { body: { data: { cash_balance: 1 } } });
  ok(
    'moonshot: a payload without available_balance throws',
    !!noAvailable.err && /available_balance/.test(noAvailable.err.message),
    noAvailable.err && noAvailable.err.message,
  );
  const serverError = await refusal(walletRequest('deepseek'), { status: 500, body: 'upstream is down' });
  ok('a 500 carries its status on the error', !!serverError.err && serverError.err.status === 500, String(serverError.err && serverError.err.message));
  const keyless = await refusal(walletRequest('deepseek', ''), { body: {} });
  ok('an empty API key throws', !!keyless.err, String(keyless.err && keyless.err.message));
  ok('  … WITHOUT a request being attempted', keyless.calls.length === 0, `${keyless.calls.length} request(s)`);
}

// --- 5. the parser's sentences, and the page's own copy of them ----------------
//
// `src/agent/models.ts` reports an unusable settings row as a **code + arguments**, never
// as a finished sentence, and it cannot own the translation: it must stay free of
// `vscode` (the guards here `require` it in plain node). So `src/chat/modelTree.ts` carries
// the same English source again, as one `vscode.l10n.t` literal per rule (`ISSUE_TEXT`) —
// the shape `tools/check-l10n.js` extracts and the only shape a translator can see.
//
// Two copies of 21 sentences drift in the worst possible way: silently. The page's banner
// would keep showing the *old* wording — in English too, since `l10n.t` falls back to the
// literal — so they are compared here, text against text. The table's shape is part of the
// contract: an entry is `'<code>': (a) => vscode.l10n.t('<English source>', …)`, and a
// rewrite that stops matching fails below rather than passing unnoticed.

const issueProblems = [];
console.log('-- the parser\'s issue sentences, and the page\'s copy of them --');

/** Turn a JS string literal's body into the value the running code would see. */
function unescape(body) {
  return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (all, esc) => {
    switch (esc[0]) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'u':
      case 'x':
        return String.fromCharCode(parseInt(esc.slice(1), 16));
      default:
        return esc; // \" \\ \' and anything else: the character itself
    }
  });
}

/** The `code → English source` pairs of `ISSUE_TEXT` in `src/chat/modelTree.ts`. */
function readIssueTable() {
  const file = path.join(root, 'src', 'chat', 'modelTree.ts');
  const found = new Map();
  const re = /'([a-z][a-z-]*)':\s*\(a\)\s*=>\s*vscode\.l10n\.t\(\s*'((?:\\.|[^'\\])*)'/g;
  const text = fs.readFileSync(file, 'utf8');
  let match;
  while ((match = re.exec(text)) !== null) {
    found.set(match[1], unescape(match[2]));
  }
  return found;
}

{
  const pageTable = readIssueTable();
  const codes = Object.keys(CATALOG_ISSUE_TEXT);
  for (const code of codes) {
    const sentence = CATALOG_ISSUE_TEXT[code];
    if (!pageTable.has(code)) {
      issueProblems.push(
        `src/chat/modelTree.ts has no ISSUE_TEXT entry for "${code}" — the page's banner would show the code instead of a sentence`,
      );
      continue;
    }
    const onPage = pageTable.get(code);
    if (onPage !== sentence) {
      issueProblems.push(`"${code}": the page says ${JSON.stringify(onPage)}, the parser says ${JSON.stringify(sentence)}`);
    }
    pageTable.delete(code);
  }
  for (const code of pageTable.keys()) {
    issueProblems.push(`src/chat/modelTree.ts has an ISSUE_TEXT entry "${code}", which CATALOG_ISSUE_TEXT does not know`);
  }
  if (issueProblems.length === 0) {
    console.log(`  [ok  ] the parser's ${codes.length} issue sentence(s) and the page's copy of them agree`);
  }
}

/**
 * The summary. It is a function rather than the file's last statements because the
 * wallet checks `await`: the OK line and the exit code have to be decided *after* the
 * last readout was fetched, and "printed OK while a check was still pending" is the one
 * failure mode this file cannot have.
 */
function summarize() {
  if (problems.length) {
    console.error('check-models: model ids drifted\n');
    for (const p of problems) {
      console.error('  ' + p);
    }
    console.error(`\nThe single source of truth is src/agent/models.ts (${ids.length} fallback model(s): ${ids.join(', ')}).`);
    process.exit(1);
  }
  if (walletProblems.length) {
    console.error('check-models: the wallet declaration drifted\n');
    for (const p of walletProblems) {
      console.error('  ' + p);
    }
    console.error('\nThe dialects are declared in src/agent/balance.ts and landed on a row by src/agent/models.ts.');
    process.exit(1);
  }
  if (issueProblems.length) {
    console.error('check-models: the catalog-issue sentences drifted\n');
    for (const p of issueProblems) {
      console.error('  ' + p);
    }
    console.error(
      '\nThe English source is CATALOG_ISSUE_TEXT (src/agent/models.ts); the page reads the same sentences through ISSUE_TEXT (src/chat/modelTree.ts).',
    );
    process.exit(1);
  }

  const vision = MODEL_CATALOG.filter((m) => m.vision).map((m) => m.id);
  console.log(
    `check-models: OK — fallback default ${DEFAULT_MODEL}, ${vision.length} accepting images (${vision.join(', ')}); cards come from spinney.modelCards.`,
  );
}

// The wallet section is awaited, so it hands the process over to the summary above. A
// throw from inside it is a broken guard, and a broken guard must fail loudly too.
checkWalletFetch().then(summarize, (err) => {
  console.error(`check-models: the wallet checks threw — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
