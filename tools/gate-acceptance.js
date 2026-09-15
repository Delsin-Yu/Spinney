/*
 * gate-acceptance — the request gate, as a dev-only acceptance run (not a build
 * guard, and not shipped in the `.vsix`).
 *
 * `src/agent/requestGate.ts` is new, load-bearing (`ClientRegistry` puts one in
 * front of every provider and every card) and mostly about *waiting*, which is the
 * kind of code that looks right and deadlocks in practice. This drives it
 * directly — FIFO order, the `0 = unlimited` case, an abort while queued, a limit
 * that drops below what is already running, and waking a queue by raising the cap
 * — and then through `ClientRegistry.stream`, to prove the slot is really held for
 * a whole stream (and given back even when the caller breaks out early).
 *
 * Needs `out/` (run `npm run compile` first); no window, no network:
 *   node tools/gate-acceptance.js
 */
const path = require('path');

const ROOT = process.argv[2] || 'd:/Repos/MinimalHost';
const problems = [];
const ok = (label, cond, detail) => {
  console.log(`  [${cond ? 'ok  ' : 'FAIL'}] ${label}${detail ? '  (' + detail + ')' : ''}`);
  if (!cond) problems.push(label);
};

const { RequestGate } = require(path.join(ROOT, 'out', 'agent', 'requestGate.js'));
const M = require(path.join(ROOT, 'out', 'agent', 'models.js'));
const { ClientRegistry } = require(path.join(ROOT, 'out', 'agent', 'clients.js'));
const { ApiClient } = require(path.join(ROOT, 'out', 'agent', 'apiClient.js'));

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// A script that ends while an `await` is still pending exits 0 with no output at
// all — which is exactly how a deadlock would look. Refuse to pass quietly.
let finished = false;
process.on('exit', (code) => {
  if (!finished && code === 0) {
    console.log('\nFAIL gate-acceptance: the run ended early — something never resolved (a deadlock looks exactly like this)');
    process.exitCode = 1;
  }
});

(async () => {
  console.log('-- 0 means unlimited, and the gate still counts --');
  {
    const gate = new RequestGate(0);
    await gate.acquire();
    await gate.acquire();
    ok('both requests were granted', gate.stats.running === 2, JSON.stringify(gate.stats));
    ok('  … and neither queued', gate.stats.queued === 0);
    gate.release();
    ok('a release is counted', gate.stats.running === 1);
  }

  console.log('-- a cap queues, and a release hands the slot over --');
  {
    const gate = new RequestGate(2);
    await gate.acquire();
    await gate.acquire();
    ok('the cap is reached', gate.stats.running === 2);
    let third = false;
    const waiting = gate.acquire().then(() => {
      third = true;
    });
    await tick();
    ok('a third request waits', third === false && gate.stats.queued === 1, JSON.stringify(gate.stats));
    gate.release();
    await waiting;
    ok('  … and starts when a slot is freed', third === true);
    ok('  … without the running count drifting', gate.stats.running === 2, JSON.stringify(gate.stats));
  }

  console.log('-- FIFO, and only a real wait calls onWait --');
  {
    const gate = new RequestGate(1);
    await gate.acquire();
    let waits = 0;
    const order = [];
    const p1 = gate.acquire(undefined, () => waits++).then(() => order.push('a'));
    const p2 = gate.acquire(undefined, () => waits++).then(() => order.push('b'));
    await tick(5);
    ok('both waited, in arrival order', waits === 2 && order.length === 0, `waits=${waits}`);
    gate.release();
    await tick(5);
    ok('the first waiter goes first', order.join(',') === 'a', order.join(','));
    gate.release();
    await Promise.all([p1, p2]);
    ok('the second follows', order.join(',') === 'a,b', order.join(','));
    // The last grant is still holding the single slot; give it back before asking
    // for another one (this is what hung the first version of this file).
    gate.release();
    // A request that is granted straight away must not have reported a wait.
    const before = waits;
    await gate.acquire();
    ok('an immediate grant reports no wait', waits === before);
  }

  console.log('-- Stop works on a request that is only waiting --');
  {
    const gate = new RequestGate(1);
    await gate.acquire();
    const controller = new AbortController();
    const queued = gate.acquire(controller.signal);
    await tick(5);
    ok('the request is queued', gate.stats.queued === 1);
    controller.abort();
    let message = '';
    try {
      await queued;
      message = '(resolved!)';
    } catch (err) {
      message = err.message;
    }
    ok('aborting it rejects instead of hanging', message.includes('aborted'), message);
    ok('  … and it leaves the queue', gate.stats.queued === 0, JSON.stringify(gate.stats));
    ok('  … without taking the slot it never got', gate.stats.running === 1);
    gate.release();
    ok('the gate is usable afterwards', gate.stats.running === 0);

    const already = new AbortController();
    already.abort();
    let immediate = '';
    try {
      await gate.acquire(already.signal);
      immediate = '(granted!)';
    } catch (err) {
      immediate = err.message;
    }
    ok('an already-aborted request never queues', immediate.includes('aborted'), immediate);
  }

  console.log('-- raising the cap wakes the queue; lowering it never kills a request --');
  {
    const gate = new RequestGate(1);
    await gate.acquire();
    let woken = 0;
    const waiters = [gate.acquire().then(() => woken++), gate.acquire().then(() => woken++)];
    await tick(5);
    ok('two requests are waiting', gate.stats.queued === 2, JSON.stringify(gate.stats));
    gate.setLimit(0);
    await Promise.all(waiters);
    ok('unlimited wakes them all', woken === 2, String(woken));
    ok('  … and they are all counted as running', gate.stats.running === 3, JSON.stringify(gate.stats));

    // Now drop back to 1 while three requests are in flight: nothing is killed.
    gate.setLimit(1);
    ok('a lowered cap does not kill what is running', gate.stats.running === 3, JSON.stringify(gate.stats));
    let late = false;
    const queuedLate = gate.acquire().then(() => {
      late = true;
    });
    await tick(5);
    ok('  … but new requests queue behind it', late === false && gate.stats.queued === 1);
    gate.release();
    gate.release();
    await tick(5);
    ok('  … until the count falls under it', late === false || gate.stats.queued === 0);
    gate.release();
    await queuedLate;
    ok('  … and then it starts', late === true, JSON.stringify(gate.stats));
  }

  console.log('-- the registry holds a slot for a whole stream --');
  {
    M.setCatalog(
      [{ id: 'gate-provider', name: 'gate', baseUrl: 'http://127.0.0.1:1', concurrency: 1 }],
      [
        {
          id: 'gate-card',
          name: 'gate card',
          providerId: 'gate-provider',
          oaiModel: 'gate-wire',
          contextWindow: 1000,
          vision: { enabled: false, transport: 'deepseek' },
          efforts: ['none'],
          defaultEffort: 'none',
          concurrency: 1,
        },
      ],
    );
    let live = 0;
    let maxLive = 0;
    let sentModel = '';
    ApiClient.prototype.stream = async function* (request) {
      live++;
      maxLive = Math.max(maxLive, live);
      sentModel = request.model;
      await tick(30);
      yield { choices: [{ delta: { content: 'x' } }] };
      await tick(30);
      live--;
    };
    ApiClient.prototype.complete = async function () {
      return { text: 'title' };
    };

    const registry = new ClientRegistry({ apiKeyFor: async () => 'k' });
    registry.applyCatalog();
    const card = M.cards()[0];
    const drain = async (generator) => {
      let chunks = 0;
      for await (const _chunk of generator) {
        chunks++;
      }
      return chunks;
    };

    const both = await Promise.all([
      drain(registry.stream(card, { messages: [] })),
      drain(registry.stream(card, { messages: [] })),
    ]);
    ok('two concurrent streams never exceeded the card cap', maxLive === 1, `maxLive=${maxLive}`);
    ok('both streams finished', both.join(',') === '1,1', both.join(','));
    ok('the card\u2019s wire name was sent, not the card id', sentModel === 'gate-wire', sentModel);

    const waiting = registry.stream(card, { messages: [] });
    const iterator = waiting[Symbol.asyncIterator]();
    const first = iterator.next();
    await tick(5);
    await first;
    // Break out early: the slot must still come back. Proven behaviourally — if it
    // leaked, this next one-slot stream would never start (and the watchdog at the
    // top of this file would fail the run instead of exiting 0).
    await iterator.return?.();
    const afterBreak = await drain(registry.stream(card, { messages: [] }));
    ok('breaking out of a stream releases the slot', afterBreak === 1, String(afterBreak));

    console.log('-- a completion takes no slot (titles must not starve chat) --');
    {
      const held = registry.stream(card, { messages: [] });
      const iterator2 = held[Symbol.asyncIterator]();
      const pending = iterator2.next();
      await tick(5);
      const title = await registry.complete(card, { messages: [] });
      ok('a title request answers while the only slot is busy', title.text === 'title', JSON.stringify(title));
      await pending;
      await iterator2.return?.();
      const last = await drain(registry.stream(card, { messages: [] }));
      ok('  … and the slot came back afterwards', last === 1, String(last));
    }
  }

  console.log('');
  finished = true;
  if (problems.length) {
    console.log(`FAIL gate-acceptance: ${problems.length} check(s) failed`);
    process.exit(1);
  }
  console.log('PASS gate-acceptance: the gate queues FIFO, aborts a queued request, survives a lowered cap, and the registry holds a slot for a whole stream (never for a title)');
})();
