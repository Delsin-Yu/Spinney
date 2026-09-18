/*
 * session-store-acceptance — the file-backed session store's guarantees, driven directly
 * against the COMPILED module (dev-only; not a build guard, and never shipped).
 *
 * Why it exists: session content moved out of the single Memento row (17.2 M chars,
 * rewritten in full on every write, and keyed by the extension id — a rename once made
 * every conversation undiscoverable). The replacement is only safe when these hold, and each
 * one is invisible until the day it matters:
 *
 *   1. **A loss is survivable.** The index is a cache; the files are the truth. Delete
 *      `index.json`, corrupt one node, leave a `.tmp` behind — the rest must still load.
 *   2. **A write cannot destroy the previous one.** `tmp` → `.bak` → rename, so a reader
 *      always sees a complete generation.
 *   3. **Only what changed is written.** v2 is one file per **node** (the session header is
 *      separate and small), and the digest that decides "changed" must not miss a field —
 *      that is the one property whose failure is silent, so it is perturbed field by field.
 *   4. **A deletion is recoverable and final in the right order.** It moves the whole session
 *      folder to `.trash` and it beats a write still in the queue.
 *   5. **A rename is a non-event**, and the **v1 layout** (one file per session) is converted
 *      without losing anything.
 *
 *   npx tsc -p ./ && node tools/session-store-acceptance.js [<outDir>]
 *
 * No window, no provider, no tokens; everything happens under `.spinney/` (gitignored).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(
  process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(ROOT, 'out'),
);
const {
  SessionStore,
  STORE_PRODUCER,
  LOCK_STALE_MS,
  defaultDataRoot,
  looksLikeStoreRoot,
  workspaceKeyFor,
} = require(path.join(OUT, 'chat', 'sessionStore.js'));
const { nodeDigest, sessionHeaderDigest } = require(path.join(OUT, 'chat', 'persistDigest.js'));

const problems = [];
const check = (label, ok, detail) => {
  console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) problems.push(label);
};

const SANDBOX = path.join(ROOT, '.spinney', 'session-store');
const summary = (id, over) => ({
  id,
  title: `session ${id}`,
  createdAt: 1000,
  updatedAt: 2000,
  nodeCount: 1,
  activeNodeId: `${id}-n1`,
  ...over,
});
/** A session with **one realistic node** (every persisted field the digest must cover). */
const node = (id, marker, over) => ({
  id,
  parentId: null,
  children: [],
  kind: 'turn',
  title: `node ${marker}`,
  status: 'done',
  prompt: `do ${marker}`,
  model: 'sim-model',
  effort: 'medium',
  createdAt: 10,
  updatedAt: 20,
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  displayItems: [
    { kind: 'assistant', text: `answer ${marker}` },
    { kind: 'tool', name: 'search_files', args: '{"pattern":"x"}', content: 'file.ts:1: x' },
  ],
  messages: [
    { role: 'user', content: `do ${marker}` },
    { role: 'assistant', content: `answer ${marker}`, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_files', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'file.ts:1: x' },
  ],
  ...(over || {}),
});
const body = (id, marker, over) => ({
  id,
  rootId: `${id}-n1`,
  activeNodeId: `${id}-n1`,
  nodes: { [`${id}-n1`]: node(`${id}-n1`, marker) },
  notes: marker,
  ...(over || {}),
});

(async () => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  const rootA = path.join(SANDBOX, 'root-a');
  const rootB = path.join(SANDBOX, 'root-b');
  const key = workspaceKeyFor('file:///w/alpha');
  const store = new SessionStore({ root: rootA, workspaceKey: key });

  console.log('== the root is ours, and its name does not come from the extension id ==');
  const manifest = await store.ensureRoot();
  check('a manifest is written with producer + data version', manifest.producer === STORE_PRODUCER && manifest.dataVersion === 2, JSON.stringify(manifest));
  check('the root is recognisable as ours', looksLikeStoreRoot(rootA));
  check('an unrelated folder is not', !looksLikeStoreRoot(path.join(SANDBOX, 'nope')));
  check('the same workspace uri always hashes to the same key', workspaceKeyFor('file:///w/alpha') === key);
  check('a different workspace uri gets its own key', workspaceKeyFor('file:///w/beta') !== key);
  check('no folder open is its own key', workspaceKeyFor(null) === 'no-workspace');
  check('the dataDir override wins over the default', defaultDataRoot('C:\\gs', 'D:\\mine') === path.resolve('D:\\mine'), defaultDataRoot('C:\\gs', 'D:\\mine'));
  check('the default is a fixed name under global storage', defaultDataRoot('C:\\gs').endsWith(path.join('gs', 'spinney')));
  check('the default does NOT contain the publisher/extension identity', !/de-yu|publisher|\.spinney$/.test(defaultDataRoot('C:\\gs')));

  console.log('\n== v2 layout: a folder per session, one atomic file per node ==');
  store.writeSession('s1', body('s1', 'first'), summary('s1'), null);
  check('a queued session counts as present', store.hasPending('s1'));
  await store.flush();
  check('the session is a folder, not a file', fs.statSync(store.sessionDir('s1')).isDirectory());
  check('  … with a header', fs.existsSync(store.headerFile('s1')));
  check('  … and one file per node', fs.existsSync(store.nodeFile('s1', 's1-n1')));
  const header = JSON.parse(fs.readFileSync(store.headerFile('s1'), 'utf8'));
  check('the header is self-describing and lists its nodes', header.version === 2 && header.kind === 'session' && header.sessionId === 's1' && header.nodeIds.includes('s1-n1'));
  check('  … and does NOT carry the nodes themselves', !('nodes' in (header.session || {})), Object.keys(header.session || {}).slice(0, 4).join(','));
  const nodeFile = JSON.parse(fs.readFileSync(store.nodeFile('s1', 's1-n1'), 'utf8'));
  check('a node file is self-describing too', nodeFile.kind === 'node' && nodeFile.nodeId === 's1-n1' && nodeFile.node.messages.length === 3);
  check('no `.tmp` is left behind', !fs.existsSync(`${store.nodeFile('s1', 's1-n1')}.tmp`));

  console.log('\n== only what changed is written (the v2 win) ==');
  const before = fs.statSync(store.nodeFile('s1', 's1-n1')).mtimeMs;
  // A write that names **no** dirty node still refreshes the header, and leaves the untouched
  // node file exactly as it was (that is what a turn end does for the other 68 nodes).
  store.writeSession('s1', body('s1', 'first'), summary('s1', { title: 'retitled' }), []);
  await store.flush();
  check('an untouched node keeps its file', fs.statSync(store.nodeFile('s1', 's1-n1')).mtimeMs === before);
  check('  … and the header did change', JSON.parse(fs.readFileSync(store.headerFile('s1'), 'utf8')).summary.title === 'retitled');
  // Now change just one node: its file is rewritten, its sibling's is not.
  const two = body('s1', 'first', { nodes: { 's1-n1': node('s1-n1', 'first'), 's1-n2': node('s1-n2', 'second') } });
  two.nodeIds = ['s1-n1', 's1-n2'];
  store.writeSession('s1', two, summary('s1'), ['s1-n2']);
  await store.flush();
  check('a newly dirty node gets its own file', fs.existsSync(store.nodeFile('s1', 's1-n2')));
  check('  … and the untouched one still has its old mtime', fs.statSync(store.nodeFile('s1', 's1-n1')).mtimeMs === before);
  check('the header now lists both nodes', JSON.parse(fs.readFileSync(store.headerFile('s1'), 'utf8')).nodeIds.length === 2);
  // A node that disappears must lose its file, or a deleted branch would come back.
  store.writeSession('s1', body('s1', 'first'), summary('s1'), null);
  await store.flush();
  check('a node the session no longer has loses its file', !fs.existsSync(store.nodeFile('s1', 's1-n2')));

  console.log('\n== the index is a cache: losing it costs nothing ==');
  store.writeSession('s2', body('s2', 'second'), summary('s2', { updatedAt: 2500 }), null);
  await store.flush();
  const listed = await store.listSessions();
  check('the listing has both sessions, newest first', listed.length === 2 && listed[0].id === 's2' && listed[1].id === 's1', listed.map((s) => s.id).join(','));
  fs.rmSync(store.indexFile, { force: true });
  const fresh = new SessionStore({ root: rootA, workspaceKey: key });
  const rebuilt = await fresh.listSessions();
  check('a missing index is rebuilt from the folders alone', rebuilt.length === 2 && rebuilt.some((s) => s.id === 's2'), `rebuilt ${rebuilt.length}`);
  check('  … and the rebuild is cached in the index again', fs.existsSync(fresh.indexFile));

  console.log('\n== a corrupt node costs one node; a corrupt header costs one session ==');
  fs.writeFileSync(store.nodeFile('s1', 's1-n1'), '{"version":2,"kind":"node",');
  const withCorrupt = new SessionStore({ root: rootA, workspaceKey: key });
  const damaged = withCorrupt.readSessionSync('s1');
  check('the session still loads', Boolean(damaged && damaged.session));
  check('  … without the corrupt node', damaged && !('s1-n1' in damaged.session.nodes));
  fs.writeFileSync(store.headerFile('s2'), 'not json at all');
  const survivors = await new SessionStore({ root: rootA, workspaceKey: key }).rebuildIndex();
  check('a corrupt header drops that session and reports it', survivors.skipped === 1, `skipped=${survivors.skipped}`);
  check('the healthy session survives', survivors.sessions.some((s) => s.id === 's1'));

  console.log('\n== the digest that decides "changed" must not miss a field ==');
  const base = node('dig', 'x');
  const digestOf = JSON.stringify(base);
  const mutations = {
    'a short string by value': (n) => { n.title = 'node y'; },
    'a string of the same length': (n) => { n.prompt = n.prompt.replace(/.$/, n.prompt.endsWith('x') ? 'y' : 'x'); },
    'a long string by length': (n) => { n.messages[1].content += ' more'; },
    'a number': (n) => { n.displayItems.length = n.displayItems.length; n.createdAt += 1; },
    'a boolean': (n) => { n.delivered = true; },
    'a nested object field': (n) => { n.usage.completion_tokens += 1; },
    'an array element': (n) => { n.children.push('child-1'); },
    'an array length': (n) => { n.messages.push({ role: 'user', content: 'again' }); },
    'a new field': (n) => { n.extra = 1; },
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    const copy = JSON.parse(digestOf);
    mutate(copy);
    check(`a change to ${label} moves the digest`, nodeDigest(copy) !== nodeDigest(base));
  }
  check('an identical node digests identically', nodeDigest(JSON.parse(digestOf)) === nodeDigest(base));
  check('key order does not matter', nodeDigest({ b: 1, a: 2 }) === nodeDigest({ a: 2, b: 1 }));
  check('the header digest ignores the nodes (they have their own)', (() => {
    const a = { id: 's', title: 't', nodes: { n1: { x: 1 } } };
    const b = { id: 's', title: 't', nodes: { n1: { x: 2 } } };
    return sessionHeaderDigest(a) === sessionHeaderDigest(b) && sessionHeaderDigest(a) !== sessionHeaderDigest({ id: 's', title: 'u', nodes: {} });
  })());

  console.log('\n== deletion: the whole folder moves to trash, ahead of a queued write ==');
  const trashed = await store.deleteSession('s2');
  check('the deletion reports success', trashed === true);
  check('the session folder left the workspace', !fs.existsSync(store.sessionDir('s2')));
  const inTrash = [];
  for (const dir of fs.readdirSync(store.trashDir)) {
    for (const entry of fs.readdirSync(path.join(store.trashDir, dir))) inTrash.push(entry);
  }
  check('  … and it is in `.trash` (nothing was unlinked)', inTrash.includes('s2'), inTrash.join(','));
  store.writeSession('s6', body('s6', 'doomed'), summary('s6'), null);
  const cancelled = await store.deleteSession('s6');
  await store.flush();
  check('a session deleted in the same tick as its write is gone', cancelled === true && !fs.existsSync(store.sessionDir('s6')));

  console.log('\n== v1 (one file per session) still reads, and converts without losing anything ==');
  const legacyRoot = path.join(SANDBOX, 'root-legacy');
  const legacy = new SessionStore({ root: legacyRoot, workspaceKey: key });
  await legacy.ensureRoot();
  // An *old* root: its manifest says v1 (the layout version that wrote one file per session).
  fs.writeFileSync(path.join(legacyRoot, 'manifest.json'), JSON.stringify({ producer: 'spinney', dataVersion: 1, writtenAt: 1 }));
  const legacyBody = body('old1', 'legacy');
  fs.writeFileSync(
    legacy.sessionFile('old1'),
    `${JSON.stringify({ version: 1, kind: 'session', sessionId: 'old1', updatedAt: 111, summary: summary('old1'), session: legacyBody })}\n`,
  );
  check('a v1 file reads through the same API', legacy.readSessionSync('old1')?.session?.notes === 'legacy');
  check('  … and lists as a session', (await legacy.listIds()).includes('old1'));
  const converted = await legacy.migrateLegacyLayout();
  check('the migration converts it', converted === 1, `converted=${converted}`);
  check('  … into the v2 folder layout', fs.existsSync(legacy.headerFile('old1')) && fs.existsSync(legacy.nodeFile('old1', 'old1-n1')));
  check('  … keeping the v1 file, renamed (never discarded)', fs.existsSync(`${legacy.sessionFile('old1')}.v1`));
  check('  … and the content survived', legacy.readSessionSync('old1')?.session?.notes === 'legacy');
  check('  … and a second run is a no-op', (await legacy.migrateLegacyLayout()) === 0);

  console.log('\n== one lock per workspace: live refused, stale taken over ==');
  let clock = 1_000_000;
  const timed = (keyName) => new SessionStore({ root: rootA, workspaceKey: keyName, now: () => clock });
  const locked = timed('lock-key');
  const first = await locked.acquireLock('window-a');
  check('the first window takes the lock', first.acquired === true && first.tookOver === false);
  const second = await locked.acquireLock('window-b');
  check('a second window is refused while the holder is live', second.acquired === false && second.holder.owner === 'window-a');
  clock += LOCK_STALE_MS + 1;
  const third = await locked.acquireLock('window-b');
  check('a stale heartbeat is taken over', third.acquired === true && third.tookOver === true);
  check('  … and the heartbeat belongs to the new owner', (await locked.heartbeat('window-b')) === true);
  check('  … and the old owner cannot refresh it any more', (await locked.heartbeat('window-a')) === false);
  check('a release by the old owner is ignored', await (async () => {
    await locked.releaseLock('window-a');
    return (await locked.lockHolder())?.owner === 'window-b';
  })());
  await locked.releaseLock('window-b');
  check('the real owner can release it', (await locked.lockHolder()) === null);
  check('a lock whose pid is gone is taken over', await (async () => {
    const other = timed('lock-key-2');
    await fs.promises.writeFile(other.lockFile, JSON.stringify({ owner: 'dead-window', pid: 999999, heartbeat: clock, startedAt: clock }));
    const got = await other.acquireLock('window-c');
    return got.acquired === true && got.tookOver === true;
  })());

  console.log('\n== a rename (or a moved profile) is a non-event: adopt another root ==');
  const otherStore = new SessionStore({ root: rootB, workspaceKey: key });
  await otherStore.ensureRoot();
  otherStore.writeSession('old1', body('old1', 'from the old id'), summary('old1', { title: 'old conversation' }), null);
  await otherStore.flush();
  const adopter = new SessionStore({ root: rootA, workspaceKey: key });
  const adopted = await adopter.adoptFrom(rootB);
  check('every session of the other root is adopted', adopted.adopted === 1, JSON.stringify(adopted));
  check('  … and the content comes with it, readable', (await adopter.readSession('old1'))?.session.notes === 'from the old id');
  check('  … and the source root is untouched', fs.existsSync(otherStore.headerFile('old1')));
  check('  … and a second adopt is a no-op (no duplicates)', (await new SessionStore({ root: rootA, workspaceKey: key }).adoptFrom(rootB)).adopted === 0);
  check('discovery finds the newest root first', await (async () => {
    const found = await SessionStore.discover([rootB, rootA, path.join(SANDBOX, 'nonexistent')]);
    return found.length === 2 && found[0] === rootA;
  })());

  console.log('\n== two workspaces never see each other ==');
  const beta = new SessionStore({ root: rootA, workspaceKey: workspaceKeyFor('file:///w/beta') });
  await beta.ensureRoot();
  beta.writeSession('b1', body('b1', 'beta'), summary('b1'), null);
  await beta.flush();
  check('the second workspace has only its own session', (await beta.listSessions()).length === 1);
  check('the first workspace does not see it', !(await adopter.listSessions()).some((s) => s.id === 'b1'));

  fs.rmSync(SANDBOX, { recursive: true, force: true });
  console.log('');
  if (problems.length) {
    console.log(`FAIL session-store-acceptance: ${problems.length} check(s) failed\n - ${problems.join('\n - ')}`);
    process.exit(1);
  }
  console.log(
    'PASS session-store-acceptance: v2 folders with one atomic file per node (only what changed is written), ' +
      'a digest that answers "changed" without missing a field, a rebuildable index, trash instead of unlink, ' +
      'a deletion that beats a queued write, one live lock per workspace, adoption from another root, ' +
      'the v1 layout converted without loss, and no cross-talk between workspaces',
  );
})().catch((err) => {
  console.error(`session-store-acceptance: ${err && err.stack ? err.stack : String(err)}`);
  process.exit(2);
});
