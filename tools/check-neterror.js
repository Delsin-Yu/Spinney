/*
 * check-neterror — a failed request must name its cause, as a build-time guard (the
 * 2026-09-30 incident).
 *
 * Node reports *every* network failure as `TypeError: fetch failed` and keeps the real
 * reason in `error.cause`. That session lost two days of context to exactly that: 39
 * retries across two endpoints, each one reading `Network error calling the API: fetch
 * failed`, 2–7 ms apart, and the one field that would have named the broken layer — the
 * `ENOTFOUND` / `ECONNREFUSED` / `UND_ERR_*` code — discarded on the way to the log, the
 * retry card and the chat bubble. `src/agent/netError.ts` is the single place that turns a
 * rejected `fetch` into a line a human can act on, and four call sites depend on it
 * (`apiClient.ts`, `balance.ts`, `tools/webFetch.ts`, `tools/webBackends.ts`).
 *
 * It is pure text handling with no window and no provider, so it is cheap to pin, and the
 * shapes that matter are the ones nobody sees until a network breaks. This guard drives the
 * compiled `out/agent/netError.js`:
 *
 *   1. The message stays first and stays what it was, and a generic layer is not repeated:
 *      the top-level `fetch failed`, a message that only repeats its own code, and a cause
 *      that only says what the message already said all contribute nothing twice. A thrown
 *      string is itself; a thrown non-Error is never a crash.
 *   2. The cause tree is walked, not assumed: an undici failure nests an `AggregateError`
 *      whose `errors` array holds one entry per address tried, a driver puts `code` /
 *      `message` / `address` / `port` on its error, and a TLS or DNS failure may be one
 *      level shallower. The walk is depth-bounded and cycle-safe, so a self-referential
 *      `cause` returns instead of hanging the host's only thread.
 *   3. The host phrase is added **only** when the message does not name the address, and
 *      never twice — `getaddrinfo ENOTFOUND api.example.com` already says it. The port
 *      travels with it and arrives as a **number**, which is the half a driver never puts
 *      in the message: `UND_ERR_CONNECT_TIMEOUT · Connect Timeout Error · host:443`.
 *   4. Every output goes through `clipText`, so a 5000-character provider sentence cannot
 *      flood a chat bubble with a network error, and no clip can leave an unpaired
 *      surrogate in it (the 2026-09-24 HTTP 400 — see `tools/check-unicode.js`).
 *   5. The module imports nothing but `../text` — a source-level read, the same idiom
 *      `check-unicode.js` uses. That single dependency is what lets `tools/webFetch.ts`
 *      import `src/agent/netError.ts` while `src/agent/*` imports `src/tools/*`, without
 *      the two directories having to import each other.
 *
 * `node tools/check-neterror.js` runs it directly. It needs `out/` (`npm run compile`
 * first), so it runs after `compile` in `vscode:prepublish`. An explicit path checks the
 * checker itself.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const modulePath = path.join(root, 'out', 'agent', 'netError.js');

let problems = 0;
function ok(name, condition, detail) {
  console.log(`  [${condition ? 'ok  ' : 'FAIL'}] ${name}${detail === undefined ? '' : `  (${detail})`}`);
  if (!condition) {
    problems++;
  }
}

if (!fs.existsSync(modulePath)) {
  console.log(`FAIL check-neterror: ${path.relative(root, modulePath)} is missing — run \`npm run compile\` first.`);
  process.exit(1);
}
const { describeFetchError } = require(modulePath);

/** One error shaped the way a driver shapes it. */
function driverError(code, message, address, port) {
  const err = new Error(message);
  err.code = code;
  if (address !== undefined) {
    err.address = address;
  }
  if (port !== undefined) {
    err.port = port;
  }
  return err;
}

/** A failed `fetch`: the useless top layer, with `cause` underneath it. */
function failedFetch(cause) {
  const top = new TypeError('fetch failed');
  top.cause = cause;
  return top;
}

/** How many times `needle` occurs in `hay`. */
function count(hay, needle) {
  return hay.split(needle).length - 1;
}

/** True when the string carries an unpaired UTF-16 surrogate. */
function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** `describeFetchError`, bounded: a call that throws is a failure, not a crashed guard. */
function describe(error) {
  try {
    const out = describeFetchError(error);
    return typeof out === 'string' ? out : `«not a string: ${typeof out}»`;
  } catch (e) {
    return `«threw: ${e && e.message}»`;
  }
}

console.log('-- the message, and what is not said twice --');
{
  const bare = describe(failedFetch(undefined));
  ok('a bare `fetch failed` is still reported, not swallowed', bare === 'fetch failed', JSON.stringify(bare));

  const notAnError = describe('boom');
  ok('a thrown string is itself', notAnError === 'boom', JSON.stringify(notAnError));

  const nullish = describe(null);
  ok('a thrown nothing never crashes and still answers', typeof nullish === 'string' && nullish.length > 0, JSON.stringify(nullish));

  const symbol = describe(Symbol('nope'));
  ok('a thrown Symbol is coerced with String(), never implicitly', !symbol.startsWith('«threw'), JSON.stringify(symbol));

  const repeatsCode = describe(failedFetch(driverError('ECONNREFUSED', 'ECONNREFUSED')));
  ok('a message that only repeats its own code is dropped', count(repeatsCode, 'ECONNREFUSED') === 1, JSON.stringify(repeatsCode));

  const nested = describe(failedFetch(driverError('ENOTFOUND', 'getaddrinfo ENOTFOUND api.example.com', 'api.example.com', 443)));
  ok('the code, its message and the host all travel', nested.includes('ENOTFOUND') && nested.includes('getaddrinfo ENOTFOUND api.example.com'), JSON.stringify(nested));
  ok('  … and the address is said exactly once', count(nested, 'api.example.com') === 1, `${count(nested, 'api.example.com')} time(s)`);

  const refused = describe(failedFetch(driverError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:11434', '127.0.0.1', 11434)));
  ok('  … so `host:port` inside the message is not repeated either', count(refused, '127.0.0.1:11434') === 1, JSON.stringify(refused));
}

console.log('-- the port, which the message never carries --');
{
  // The shape the whole guard exists for: a timeout the driver reports with a code, a
  // generic message and the address it was talking to. The message names no host, so the
  // host phrase is added — with the port, which arrives as a number.
  const timedOut = describe(failedFetch(driverError('UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error', 'api.example.com', 443)));
  ok('a host the message does not name is added', timedOut.includes('api.example.com'), JSON.stringify(timedOut));
  ok('  … with its port, which arrived as a number', timedOut.includes('api.example.com:443'), JSON.stringify(timedOut));

  const portOnly = describe(failedFetch(driverError('UND_ERR_SOCKET', 'other side closed', undefined, 443)));
  ok('a port with no address is not rendered as a floating `:443`', !portOnly.includes(':443'), JSON.stringify(portOnly));

  const hostOnly = describe(failedFetch(driverError('UND_ERR_SOCKET', 'other side closed', 'api.example.com', undefined)));
  ok('an address with no port is rendered without a colon', hostOnly.includes('api.example.com') && !hostOnly.includes('api.example.com:'), JSON.stringify(hostOnly));
}

console.log('-- the cause tree: walked, not assumed --');
{
  const aggregate = Object.assign(new Error('fetch failed'), {
    errors: [
      driverError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:11434', '127.0.0.1', 11434),
      driverError('ENETUNREACH', 'connect ENETUNREACH 10.0.0.1:443', '10.0.0.1', 443),
    ],
  });
  const both = describe(failedFetch(aggregate));
  ok('an AggregateError\'s `errors` array is read, one layer down', both.includes('ECONNREFUSED') && both.includes('ENETUNREACH'), JSON.stringify(both));

  const deep = { code: 'E1', message: 'm1', cause: { code: 'E2', message: 'm2', cause: { code: 'E3', message: 'm3', cause: { code: 'E4', message: 'm4', cause: { code: 'E5', message: 'm5' } } } } };
  const bounded = describe(failedFetch(deep));
  ok('a deep chain is walked and then bounded', bounded.includes('E1') && bounded.length <= 200, `${bounded.length} char(s)`);

  const selfReferential = { code: 'LOOP', message: 'round and round' };
  selfReferential.cause = selfReferential;
  const looped = describe(failedFetch(selfReferential));
  ok('a self-referential `cause` returns instead of hanging', looped.includes('LOOP') && count(looped, 'LOOP') === 1, JSON.stringify(looped));
}

console.log('-- the clip: a network error never floods a bubble --');
{
  const huge = describe(failedFetch(driverError('EHOSTDOWN', 'x'.repeat(5000), 'api.example.com', 443)));
  ok('a 5000-character provider sentence is clipped', huge.length <= 200, `${huge.length} char(s)`);

  // The clip cuts through the middle of a 5000-character paint: an emoji pair straddling
  // the cut must be dropped whole, never left as one half (the 2026-09-24 HTTP 400).
  const painted = describe(failedFetch(driverError('EHOSTDOWN', 'a'.repeat(4999) + '\u{1F4CE}' + 'tail', undefined, undefined)));
  ok('  … and the clipped line carries no unpaired surrogate', !hasLoneSurrogate(painted), JSON.stringify(painted.slice(-12)));
  ok('  … and the JSON of it carries no lone-surrogate escape either', !/\\ud[89ab]/i.test(JSON.stringify(painted)), JSON.stringify(painted.slice(-12)));

  const family = ['\u{1F4CE}', '𐀋', '📎'];
  let loneFree = true;
  for (let n = 1; n <= 60; n++) {
    const s = describe(failedFetch(driverError('E' + 'x'.repeat(n), 'm'.repeat(n) + family[n % family.length], undefined, undefined)));
    if (hasLoneSurrogate(s)) {
      loneFree = false;
    }
  }
  ok('  … for a family of cuts, not one lucky case', loneFree, 'n = 1..60');
}

console.log('-- the dependency that keeps the import direction acyclic --');
{
  const source = fs.readFileSync(path.join(root, 'src', 'agent', 'netError.ts'), 'utf8');
  const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  ok('src/agent/netError.ts imports `../text` and nothing else', specifiers.length > 0 && specifiers.every((s) => s === '../text'), specifiers.join(', ') || '(none found)');
}

console.log('');
if (problems) {
  console.log(`FAIL check-neterror: ${problems} check(s) failed`);
  process.exit(1);
}
console.log('PASS check-neterror: a failed fetch names its cause (code, message, host and port), the cause tree is walked and bounded, a host is said once, every line is clipped surrogate-safe, and the module depends on `../text` alone');
process.exit(0);
