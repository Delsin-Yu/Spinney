// check-webview.js — fails the build when the chat webview's script cannot
// survive the messages the provider sends it.
//
// `media/main.js` is the only source file that neither `tsc` (it is plain JS) nor
// `check-models.js` looks at, and `node --check` only sees syntax. That leaves one
// nasty failure mode: the script referencing something that no longer exists. The
// throw then happens *inside* a message handler in the real webview, so nothing is
// logged and the UI silently keeps its previous/default values — that is exactly
// how the Thinking-effort dropdown got stuck on "none" after the chat-side model
// panel was deleted while the `config` handler still called into it.
//
// So this script loads `media/main.js` into an in-memory DOM (no browser, no VS
// Code), dispatches every message type `ChatViewProvider` posts, and asserts that
//   (a) no handler throws, and
//   (b) the UI follows the message — the effort dropdown, the model list, the
//       image affordances, the context readout, the wallet readout and the
//       composer's Send/Stop pair are checked explicitly, plus the P2 background
//       docks (each job has to end up in the card of the node that owns it) and the
//       three zones of a turn card, whose third zone is a *move* of the work log's
//       tail and never a copy (see the bottom of this file), and
//   (c) the diagnostics probes still speak — a `probe` / `nudge` the host sends comes
//       back as a `perfDiag` report (counters, a frame, and a `kind:'drop'` for a
//       routed message that found no card), so a tab that stopped painting can never
//       be mistaken for an idle one (the deferred check at the bottom of this file).
// The session-epoch shapes are checked the same way, each in its own block: the
// forest (`rootIds` — the roots side by side, every one of them a live checkout
// target, the composer on the checked-out node's tree), the host's context state
// (`context` / `contextPct` — the ▶ / ↻ / ⧉ variants, with `near` as the *suggestion*),
// the composer's two identities + the harness-drift fork hint (`setup`), and the rule
// that only `composerClear` empties the input (neither Send nor Enter may).
//
// The DOM stub resolves a plain `.class` selector against the element's own
// subtree, so "which card holds this dock" is answerable per card — and it gives a
// node exactly one parent (an append moves it), so "which zone holds the answer" is
// answerable too.
//
// It is deliberately *not* a rendering test: there is no CSS, no layout and no
// theme, so it cannot tell you the panel looks wrong. It answers one question —
// "does the webview still understand the provider?" — in under a second.
//
// Run by `npm run check:webview`, which `vsce package` executes through
// `vscode:prepublish` (after `check:models`), so this fails packaging, not the
// user's chat. When the provider starts posting a new message type, add it to
// `TURN_MESSAGES` below.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
// An explicit path is for checking the checker itself (mutate a copy and watch it
// fail); the build always tests the repo's own script.
const scriptPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'media', 'main.js');

const problems = [];
const notes = [];

/**
 * One message per type `ChatViewProvider.post()` sends, in the order a session
 * produces them: structural state first, then a simulated turn. Add new types
 * here when the provider gains one.
 */
const NODE_ID = 'smoke-node';
/**
 * A node id that no `tree` message in this file ever declares. The routed `delta`
 * below aims at it, which is the fixture for the drop counter: `routeTo` used to
 * return silently when it found no card for a node id, so the message vanished with
 * no trace anywhere. The deferred check at the bottom of this file asserts both
 * halves of the fix (the `kind:'drop'` report and the probe's own counter) against
 * this same string.
 */
const UNKNOWN_NODE_ID = 'unknown-node-for-drop-test';
const TURN_MESSAGES = [
  // A traced repaint: the host tags the burst of a session switch with the op id
  // the webview has to report back (see media/main.js's perf probes — the
  // deferred check at the bottom of this file waits for that report).
  { type: 'reset', traceId: 1 },
  { type: 'state', busy: false, status: '', sessionId: 'smoke-session' },
  // Structural preamble: one node, checked out and streamed into. The composer
  // assertions below need a real card, a real `treeActiveId` and a `viewId`.
  {
    type: 'tree',
    viewId: NODE_ID,
    activeId: null,
    rootId: NODE_ID,
    // A session is a forest (§3): `rootIds` is the list of tree roots and `rootId`
    // stays its first entry. The forest layout itself is checked in its own block
    // further down.
    rootIds: [NODE_ID],
    nodes: [
      {
        id: NODE_ID,
        parentId: null,
        children: [],
        title: 'smoke',
        status: 'running',
        createdAt: 0,
        preview: 'smoke',
        usage: null,
        size: null,
        // The context state is the host's judgement (never derived here, §4.3).
        context: 'ok',
      },
    ],
  },
  { type: 'path', ids: [NODE_ID], nodes: [{ id: NODE_ID, status: 'running', items: [] }] },
  // A sub-agent card carries no transcript in `tree` (only `itemCount`), so an
  // expanded one asks for it and renders the host's `agentItems` answer — the two
  // shapes are checked in the lazy-sidecar section at the bottom of this file.
  { type: 'agentItems', id: NODE_ID, items: [] },
  // The same answer shape for a **regular** node's items (`loadNodeItems` → `nodeItems`),
  // which a replica's card asks for when the `tree` it holds carried none — and which a
  // *summarised* card (`summary: true`, a finished node's row carries its first ask and its
  // last answer instead of the log) asks for on its first expansion. Both are checked in
  // the sections at the bottom of this file. The `path` above already rendered this node,
  // so the answer renders nothing here; what this entry pins is that the provider may post
  // the new type without the webview throwing.
  { type: 'nodeItems', id: NODE_ID, items: [] },
  {
    type: 'config',
    // One card per provider group: `card-text` is text-only, `card-vision`
    // accepts images, and the two have *different* thinking-level menus — the two
    // things the old `models` / `visionModels` arrays could not express.
    model: 'card-text',
    cards: [
      {
        id: 'card-text',
        name: 'smoke-model',
        providerId: 'smoke-provider',
        providerName: 'Smoke Provider',
        vision: false,
        efforts: ['none', 'low', 'medium', 'high'],
        defaultEffort: 'medium',
      },
      {
        id: 'card-vision',
        name: 'smoke-vision-model',
        providerId: 'smoke-provider',
        providerName: 'Smoke Provider',
        vision: true,
        efforts: ['low', 'high'],
        defaultEffort: 'low',
      },
    ],
    efforts: ['none', 'low', 'medium', 'high'],
    thinkingEffort: 'medium',
    foldToolCalls: true,
    foldThinking: true,
    // Zone 2's own fold default (`autoWorkFold`): the work log folds itself once the
    // answer is showing. Pinned explicitly so every `{ ...config }` fixture below says
    // what it means — see the work-log fold block at the bottom of this file.
    foldWork: true,
    // The checked-out node's frozen setup versus the live one (§4.2). No drift here:
    // a fresh session sends with exactly what a new node would freeze. The drifted
    // shapes are exercised in the composer-identities block further down.
    setup: {
      node: { cardId: 'card-text', cardLabel: 'smoke-model', effort: 'medium', language: 'English' },
      live: { cardId: 'card-text', cardLabel: 'smoke-model', effort: 'medium', language: 'English' },
      drift: false,
      reasons: [],
    },
  },
  { type: 'context', used: 524288, total: 1048576, model: 'smoke-model' },
  { type: 'sessionStats', stats: { totalTokens: 3, cacheHit: 0, cacheMiss: 3, cacheHitRate: 0, cacheKnown: true } },
  // The wallet, in the provider's own dialect: the message names the provider the
  // numbers belong to (the tooltip says so) and carries one entry per currency.
  {
    type: 'balance',
    providerId: 'smoke-provider',
    providerName: 'Smoke Provider',
    balance: { isAvailable: true, balances: [{ currency: 'CNY', total: 12.34, granted: 2, toppedUp: 10.34 }] },
  },
  { type: 'background', tasks: [] },
  // P2 shape: one flat list, every task tagged with its owning node. Each group
  // renders into the dock at the bottom of that node's own card (the detailed
  // per-node checks live at the bottom of this file).
  {
    type: 'backgrounds',
    tasks: [
      {
        id: 7,
        nodeId: NODE_ID,
        command: 'smoke',
        status: 'running',
        exitCode: null,
        killed: false,
        startedAt: Date.now() - 1000,
        finishedAt: null,
        truncated: false,
        outputTail: 'x',
        pendingDelivery: false,
      },
    ],
  },
  { type: 'backgroundNotice', nodeId: NODE_ID, item: { id: 'smoke-bg', name: 'smoke', doneText: 'done', content: 'x' } },
  { type: 'notice', kind: 'warning', text: 'smoke' },
  { type: 'status', text: 'smoke' },
  { type: 'user', text: 'smoke prompt', attachments: [] },
  { type: 'imagePicked', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', name: 'smoke.png' },
  { type: 'toolCallDelta', nodeId: NODE_ID, index: 0, id: 'smoke-tool', name: 'read_file', args: '{"path":"a"}' },
  // `startedAt` / `ms` are the two numbers the elapsed chips are built from (the
  // webview ticks the first locally and freezes at the second).
  { type: 'toolStart', nodeId: NODE_ID, index: 0, id: 'smoke-tool', name: 'read_file', args: '{"path":"a"}', startedAt: Date.now() - 250 },
  { type: 'toolEnd', nodeId: NODE_ID, id: 'smoke-tool', content: 'ok', ms: 420 },
  { type: 'delta', nodeId: NODE_ID, text: 'smoke answer' },
  // The drop counter's fixture, next to the routed streaming messages it belongs
  // with: this `delta` names a node id no `tree` ever declared, so there is no card
  // to route it to. That used to be a silent early return — the message simply
  // ceased to exist, in the webview and in the log — and the `kind:'drop'` report it
  // has to post now is asserted at the bottom of this file ("a message thrown away
  // for a missing card can never be silent again").
  { type: 'delta', nodeId: UNKNOWN_NODE_ID, text: 'x' },
  { type: 'thinkingDelta', nodeId: NODE_ID, text: 'smoke thought' },
  { type: 'usage', nodeId: NODE_ID, usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  { type: 'agentStart', id: 'smoke-agent', name: 'smoke agent', instruction: 'smoke', model: 'smoke-model', startedAt: Date.now() - 1500 },
  { type: 'agentDone', id: 'smoke-agent', status: 'done', summary: 'smoke summary', elapsedMs: 1500 },
  { type: 'nodeUpdate', id: NODE_ID, status: 'done', title: 'smoke', usage: null, context: 'ok' },
  { type: 'panTo', id: NODE_ID },
  // An in-place continue writes an inline harness block into that node's own
  // transcript (see the ▶ section below).
  { type: 'harnessNote', nodeId: NODE_ID, text: 'Continue from where you stopped.' },
  // The host took the message: this is the *only* message that empties the composer
  // (§4.4 — `send()` never does, so a modal answered with No cannot eat the text).
  { type: 'composerClear' },
  // End-of-run messages carry the node that finished, so the webview finalizes
  // *that* card and only releases the scroll lock when it is the focused one.
  { type: 'done', nodeId: NODE_ID },
  { type: 'interrupted', nodeId: NODE_ID },
  { type: 'error', nodeId: NODE_ID, message: 'smoke error' },
  // The legacy (nodeId-less) shape must keep working for a host that predates P1.
  { type: 'done' },
  { type: 'interrupted' },
  { type: 'error', message: 'smoke error' },
  // The two host -> webview stall probes, last so they see the whole run above: a
  // `probe` asks the tab for its counters *now* (messages seen, drops, frames, the
  // canvas/window readout) and a `nudge` asks it to prove it can still take a frame.
  // Both answer with a `perfDiag` report — the whole point of replaying them, since
  // the host has nothing else to read a stuck tab through. The reports are asserted
  // in the deferred step at the bottom of this file.
  // `viewState` is the other half of the same question: whether the *editor tab* is on
  // screen, which the page itself cannot see (`document.hidden` is about the window) and
  // the frame sampler needs before it may call a gap a stall. Both directions are
  // replayed — off screen and back on — so the transition that resets the frame clock
  // and restarts the sampler is exercised too, and the run ends with the tab on screen.
  { type: 'viewState', visible: false, active: false },
  { type: 'viewState', visible: true, active: true },
  { type: 'probe', id: 1 },
  { type: 'nudge', id: 2, reason: 'visible', force: true },
];

// --- a DOM just big enough to let the script run ------------------------------

const listeners = {};
const elements = new Map();
/** Every message the webview posts to the host, so a button's wiring can be checked. */
const posted = [];
/**
 * Every `perfDiag` report the probes posted. Those arrive on a later task (the
 * burst flush waits for a frame), so they are collected here and checked in the
 * deferred step at the bottom of this file.
 */
const diagnostics = [];

/**
 * Does `element` carry the class `name`? The webview writes `className` as a
 * space-separated string (`el(tag, 'bg-item running')`) and mutates classes
 * through `classList`; the stub keeps the two in step (see `makeElement`), so
 * reading `className` sees every mutation.
 */
function hasClass(element, name) {
  return String((element && element.className) || '').split(/\s+/).indexOf(name) >= 0;
}

/** Depth-first search for a plain class inside one element's own subtree. */
function findByClass(root, name) {
  for (const child of (root && root.children) || []) {
    if (hasClass(child, name)) return child;
    const nested = findByClass(child, name);
    if (nested) return nested;
  }
  return null;
}

/**
 * Take `child` out of whatever parent currently holds it: the stub's DOM, like a
 * browser's, gives a node exactly one parent, so `appendChild` / `insertBefore`
 * move an attached node instead of copying it. Text nodes (see
 * `document.createTextNode`) carry no `children` of their own — only the link back
 * — so this is safe for them too.
 */
function detachNode(child) {
  if (!child || typeof child !== 'object') return;
  const parent = child.parentElement;
  if (parent && Array.isArray(parent.children)) {
    const at = parent.children.indexOf(child);
    if (at >= 0) parent.children.splice(at, 1);
  }
  child.parentElement = null;
}

function makeElement(id) {
  const element = {
    id,
    children: [],
    options: [],
    dataset: {},
    value: '',
    textContent: '',
    disabled: false,
    checked: false,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    clientWidth: 0,
    offsetWidth: 0,
    offsetHeight: 0,
    parentElement: null,
    firstChild: null,
    lastChild: null,
    // The streaming path asks the container what it appended last (the tail of the
    // turn: which message a delta belongs to). Resolving it for real keeps every
    // check below on the same code path the webview takes.
    get lastElementChild() {
      return this.children.length > 0 ? this.children[this.children.length - 1] : null;
    },
    get firstElementChild() {
      return this.children.length > 0 ? this.children[0] : null;
    },
    classList: {
      _set: new Set(),
      toggle(name, force) {
        const on = force === undefined ? !this._set.has(name) : force === true;
        if (on) this._set.add(name);
        else this._set.delete(name);
        syncClassName();
        return on;
      },
      add: (name) => { element.classList._set.add(name); syncClassName(); },
      remove: (name) => { element.classList._set.delete(name); syncClassName(); },
      contains: (name) => element.classList._set.has(name),
    },
    style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
    // A node has exactly ONE parent, as in a browser: appending or inserting a
    // node that is already attached detaches it from its old parent first. This is
    // load-bearing for the answer zone — `promoteAnswer` / `demoteAnswer` *move* a
    // run between `.node-work` and `.node-answer`, so a stub that copied (the old
    // behaviour) left every promoted answer in zone 2 as well and observed nothing.
    appendChild(child) {
      detachNode(child);
      this.children.push(child);
      if (child && typeof child === 'object') child.parentElement = this;
      return child;
    },
    prepend(child) {
      detachNode(child);
      this.children.unshift(child);
      if (child && typeof child === 'object') child.parentElement = this;
      return child;
    },
    // `insertBefore(node, ref)`: before `ref`, or appended when `ref` is null /
    // not a child of this element (the browser's own fallback). The card head
    // badges (SUB, Delivered, CTX, kill) are inserted before `.node-status`, so
    // the position has to be real.
    insertBefore(child, ref) {
      detachNode(child);
      const at = ref ? this.children.indexOf(ref) : -1;
      if (at < 0) this.children.push(child);
      else this.children.splice(at, 0, child);
      if (child && typeof child === 'object') child.parentElement = this;
      return child;
    },
    removeChild(child) {
      const at = this.children.indexOf(child);
      if (at >= 0) this.children.splice(at, 1);
      if (child && typeof child === 'object') child.parentElement = null;
      return child;
    },
    // `remove()` has to unlink for real: the dock keeps its own list of `.bg-item`s
    // and drops the ones whose job left the snapshot, and the check below has to
    // see that happen.
    remove() {
      detachNode(this);
    },
    replaceChildren() {},
    setAttribute() {},
    getAttribute: () => null,
    removeAttribute() {},
    hasAttribute: () => false,
    // `_listeners` keeps the last handler registered for a type — what every check
    // below reads, and enough for every surface they touch (a button has one `click`).
    // `_allListeners` records all of them, for the one case that has to replay a real
    // browser event: a pointer stream after a finger lands reaches *every* listener the
    // element registered, and a check that only saw the last one could not tell a pan
    // that stood down from a pan that never started (the touch-gesture block at the
    // bottom of this file is that case).
    addEventListener(type, handler) {
      ((this._allListeners ??= {})[type] ??= []).push(handler);
      (this._listeners ??= {})[type] = handler;
    },
    removeEventListener() {},
    // A plain `.class` selector resolves against *this* element's own subtree, so
    // two node cards can no longer share one stub for `.node-bg` / `.node-work`
    // (the dock lives in a specific card — see the P2 checks below). Anything
    // compound (`[data-id="x"]`, `a > b`) and every miss keeps the old behaviour:
    // a stable shared stub, so the script sees the forgiving DOM it always saw.
    querySelector(selector) {
      if (typeof selector === 'string' && /^\.[\w-]+$/.test(selector)) {
        const found = findByClass(element, selector.slice(1));
        if (found) return found;
      }
      return selectorStub(`${id} ${selector}`);
    },
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => false,
    matches: () => false,
    focus() {},
    blur() {},
    select() {},
    scrollIntoView() {},
    attachShadow: () => makeElement(`${id}-shadow`),
    animate: () => ({ cancel() {}, finished: Promise.resolve() }),
    insertAdjacentElement(_position, node) {
      detachNode(node);
      this.children.push(node);
      if (node && typeof node === 'object') node.parentElement = this;
      return node;
    },
    insertAdjacentHTML() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture: () => false,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }),
    getContext: () => ({}),
    cloneNode() {
      return makeElement(id);
    },
    getRootNode: () => document,
  };
  // `className` and `classList` must agree: `el()` assigns the former while the
  // webview mutates through the latter, and the checks below read `className`.
  function syncClassName() {
    element.className = Array.from(element.classList._set).join(' ');
  }
  let className = String(element.className || '');
  element.classList._set = new Set(className.split(/\s+/).filter(Boolean));
  Object.defineProperty(element, 'className', {
    get: () => className,
    set(value) {
      className = String(value == null ? '' : value);
      element.classList._set = new Set(className.split(/\s+/).filter(Boolean));
    },
    configurable: true,
  });
  // `innerHTML = ''` really does clear the subtree in a browser, and the webview
  // relies on that to rebuild the two dropdowns from scratch — so the stub must
  // clear `children` too, or a rebuilt `<select>` would accumulate options.
  let innerHtml = '';
  Object.defineProperty(element, 'innerHTML', {
    get: () => innerHtml,
    set(value) {
      innerHtml = String(value == null ? '' : value);
      if (innerHtml === '') {
        // Clearing really detaches in a browser: a removed child's `parentNode`
        // is null, and the stub's `remove()` reads that back.
        const removed = element.children.slice();
        element.children.length = 0;
        for (const child of removed) {
          if (child && typeof child === 'object') child.parentElement = null;
        }
      }
    },
    configurable: true,
  });
  return element;
}

/** Elements "found" by a selector: real enough to read/write, stable per selector. */
const selectorElements = new Map();
function selectorStub(selector) {
  if (!selectorElements.has(selector)) {
    selectorElements.set(selector, makeElement(selector));
  }
  return selectorElements.get(selector);
}

// The standalone background panel is gone from the webview shell, so these ids no
// longer exist in the real DOM and `getElementById` must return null for them.
// Anything left over from it then throws inside the `backgrounds` handler — the
// "UI silently keeps its previous values" failure mode this checker exists for.
const REMOVED_IDS = new Set(['bg-panel', 'bg-list', 'bg-count', 'bg-head']);

function elementById(id) {
  if (REMOVED_IDS.has(id)) return null;
  if (!elements.has(id)) {
    elements.set(id, makeElement(id));
  }
  return elements.get(id);
}

const document = {
  getElementById: elementById,
  createElement: (tag) => makeElement(tag),
  createDocumentFragment: () => makeElement('fragment'),
  // The streaming path writes into a live text node (`appendData`) rather than
  // replacing `textContent`, so the stub carries the real text-node surface.
  createTextNode: (text) => ({
    textContent: String(text ?? ''),
    nodeValue: String(text ?? ''),
    appendData(data) {
      this.nodeValue += data;
      this.textContent = this.nodeValue;
    },
  }),
  addEventListener(type, handler) {
    (listeners[type] ??= []).push(handler);
  },
  removeEventListener() {},
  querySelector: (selector) => selectorStub(selector),
  querySelectorAll: () => [],
  body: makeElement('body'),
  documentElement: makeElement('html'),
  activeElement: null,
  hidden: false,
  // Two real DOM properties this stub used to leave `undefined`, both read by the
  // stall probes: the `probe` report carries `document.readyState` as one of its four
  // strings (asserted non-empty at the bottom of this file), and the visibility probe
  // keys off `document.visibilityState` (arithmetic on an `undefined` one would post
  // `NaN` — a sandbox limitation masquerading as a broken probe). Both values are the
  // honest ones for a sandbox that is loaded once and never hidden.
  readyState: 'complete',
  visibilityState: 'visible',
  execCommand() {},
};

const window = {
  addEventListener(type, handler) {
    (listeners[type] ??= []).push(handler);
  },
  removeEventListener() {},
  requestAnimationFrame: (handler) => setTimeout(handler, 0),
  cancelAnimationFrame() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  innerWidth: 1280,
  innerHeight: 800,
  devicePixelRatio: 1,
};

const sandbox = {
  document,
  window,
  acquireVsCodeApi: () => ({
    postMessage: (message) => {
      posted.push(message);
      if (message && message.type === 'perfDiag') diagnostics.push(message);
    },
    getState: () => undefined,
    setState() {},
  }),
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  requestAnimationFrame: window.requestAnimationFrame,
  cancelAnimationFrame: window.cancelAnimationFrame,
  performance,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  IntersectionObserver: class {
    constructor(callback) {
      this.callback = callback;
    }
    // There is no layout here, so an observed element counts as on screen — the
    // honest reading, and what the agent-items queue needs to promote a card.
    observe(target) {
      this.callback([{ target, isIntersecting: true }], this);
    }
    unobserve() {}
    disconnect() {}
  },
  history: { pushState() {}, replaceState() {} },
  location: { href: '', search: '', hash: '' },
  navigator: { clipboard: { writeText: async () => {} }, platform: 'win32', userAgent: 'node' },
  fetch: async () => ({ ok: true, json: async () => ({}), text: async () => '' }),
  CSS: { escape: (value) => value },
  crypto: { randomUUID: () => 'smoke-uuid' },
  TextEncoder,
  TextDecoder,
  URL,
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

// --- run it ------------------------------------------------------------------

if (!fs.existsSync(scriptPath)) {
  console.error(`check-webview: ${path.relative(root, scriptPath)} is missing.`);
  process.exit(1);
}

try {
  vm.createContext(sandbox);
  // The webview's other scripts, in the order the HTML shell loads them: the
  // pinned layout engine (it attaches itself to `window`) and `media/tree.js`
  // (`window.treeLayout`). Without them a `tree`/`path` message throws inside
  // real layout code — exactly the class of failure this checker exists to catch.
  for (const file of [
    path.join(root, 'media', 'vendor', 'non-layered-tidy-tree-layout', 'dist', 'non-layered-tidy-tree-layout.js'),
    path.join(root, 'media', 'tree.js'),
  ]) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: path.relative(root, file) });
  }
  vm.runInContext(fs.readFileSync(scriptPath, 'utf8'), sandbox, { filename: 'media/main.js' });
} catch (err) {
  console.error(`check-webview: media/main.js failed to load — ${err && err.message}`);
  process.exit(1);
}

const handlers = listeners.message ?? [];
if (handlers.length === 0) {
  console.error('check-webview: media/main.js registered no "message" listener; the webview would ignore the provider.');
  process.exit(1);
}
notes.push(`${handlers.length} message listener(s)`);

function dispatch(message) {
  let failed = false;
  for (const handler of handlers) {
    try {
      handler({ data: message });
    } catch (err) {
      failed = true;
      problems.push(
        `"${message.type}" threw ${err && err.message} — the UI keeps its previous values silently; ` +
          'a handler is probably calling something that no longer exists',
      );
    }
  }
  return failed;
}

for (const message of TURN_MESSAGES) {
  dispatch(message);
}

// --- did the UI follow? ------------------------------------------------------

/** Option values of a `<select>`, flattening the per-provider `<optgroup>`s. */
function optionValues(select) {
  const out = [];
  for (const child of select.children) {
    if (Array.isArray(child.children) && child.children.length > 0) {
      for (const option of child.children) {
        out.push(option.value);
      }
    } else {
      out.push(child.value);
    }
  }
  return out;
}

/** The selected option values of a `<select>` (optgroups flattened). */
function selectedValues(select) {
  const out = [];
  for (const child of select.children) {
    const list = Array.isArray(child.children) && child.children.length > 0 ? child.children : [child];
    for (const option of list) {
      if (option.selected) {
        out.push(option.value);
      }
    }
  }
  return out;
}

const effortSelected = selectedValues(elementById('effort-select'));
if (effortSelected.join(',') !== 'medium') {
  problems.push(
    `the thinking-level dropdown shows ${JSON.stringify(effortSelected)} after a config carrying "medium"`,
  );
}
notes.push(`thinking levels: ${optionValues(elementById('effort-select')).join(', ') || '(empty)'}`);

const modelSelect = elementById('model-select');
const modelOptions = optionValues(modelSelect);
// The values are **card ids**, the labels are the cards' names: a dropdown that
// shows the id (or nothing) means the card list did not arrive.
if (modelOptions.join(',') !== 'card-text,card-vision') {
  problems.push(`the model dropdown lists ${JSON.stringify(modelOptions)} after a config carrying two cards`);
}
const modelLabels = modelSelect.children.flatMap((child) =>
  Array.isArray(child.children) && child.children.length > 0
    ? child.children.map((option) => option.textContent)
    : [child.textContent],
);
if (!modelLabels.includes('smoke-vision-model')) {
  problems.push('the model dropdown shows ids instead of the cards\u2019 names');
}
notes.push(`model dropdown: ${modelLabels.join(', ') || '(empty)'}`);

// Switching the card must switch that card's own level menu (the second card
// offers `low`/`high` only) — this is what replaced the four static options.
{
  const visionConfig = TURN_MESSAGES.find((m) => m.type === 'config');
  dispatch({
    ...visionConfig,
    model: 'card-vision',
    efforts: ['low', 'high'],
    thinkingEffort: 'low',
  });
  const levels = optionValues(elementById('effort-select'));
  if (levels.join(',') !== 'low,high') {
    problems.push(`the thinking-level menu did not follow the card (showed ${JSON.stringify(levels)})`);
  }
  dispatch(visionConfig);
}

const contextLabel = elementById('context-label').textContent;
if (contextLabel !== 'ctx 50%') {
  problems.push(`the context readout shows ${JSON.stringify(contextLabel)} for 524288/1048576 (expected "ctx 50%")`);
}

// The wallet readout, from the host's *whole* `balance` message: the provider the
// number belongs to (the tooltip names it, in the dialect's own shape) and an empty
// `balances` list, which is the host saying "there is no number to show" — a
// provider whose wallet dialect is `none`, or a refresh that failed. The empty list
// must *clear* the readout: leaving the previous provider's number up is the one
// failure a user cannot see coming, and neither failure throws.
{
  const readout = () => elementById('stat-balance').textContent;
  const tooltip = () => elementById('meter-row-readout').title;

  // (a) A DeepSeek-shaped entry: the total behind the currency symbol.
  dispatch({
    type: 'balance',
    providerId: 'smoke-provider',
    providerName: 'Smoke Provider',
    balance: { isAvailable: true, balances: [{ currency: 'CNY', total: 12.34, granted: 2, toppedUp: 10.34 }] },
  });
  if (readout() !== 'bal ¥12.34') {
    problems.push(`the wallet readout shows ${JSON.stringify(readout())} for a ¥12.34 wallet (expected "bal ¥12.34")`);
  }
  // (b) …and the tooltip names the provider and the granted / topped-up split.
  const wantWallet = 'wallet Smoke Provider: ¥12.34 (granted ¥2.00 + topped up ¥10.34)';
  if (!tooltip().includes(wantWallet)) {
    problems.push(
      `the wallet tooltip is ${JSON.stringify(tooltip())}, expected it to carry ${JSON.stringify(wantWallet)}`,
    );
  }

  // The other dialects: one reports spend instead of a split, and a message that
  // names no provider at all (neither name nor id) falls back to the name-less key.
  dispatch({
    type: 'balance',
    providerId: 'smoke-provider',
    providerName: 'Smoke Provider',
    balance: { isAvailable: true, balances: [{ currency: 'USD', total: 3.5, used: 1.25 }] },
  });
  if (!tooltip().includes('wallet Smoke Provider: $3.50 (spent $1.25)')) {
    problems.push(
      `a spend-reporting dialect's wallet tooltip is ${JSON.stringify(tooltip())} (expected the "{0} (spent {1})" form)`,
    );
  }
  dispatch({
    type: 'balance',
    balance: { isAvailable: true, balances: [{ currency: 'CNY', total: 1, granted: 0, toppedUp: 1 }] },
  });
  if (!tooltip().includes('wallet ¥1.00 (granted ¥0.00 + topped up ¥1.00)')) {
    problems.push(
      `a balance message naming no provider produced ${JSON.stringify(tooltip())} (expected the "wallet {0}" form)`,
    );
  }

  // (c) The empty list: back to "there is nothing to show", wallet part and all.
  dispatch({
    type: 'balance',
    providerId: 'smoke-provider',
    providerName: 'Smoke Provider',
    balance: { isAvailable: false, balances: [] },
  });
  if (readout() !== 'bal –') {
    problems.push(
      `the wallet readout shows ${JSON.stringify(readout())} after an empty balances list (expected "bal –")`,
    );
  }
  if (tooltip().includes('wallet')) {
    problems.push(`the wallet tooltip survived an empty balances list: ${JSON.stringify(tooltip())}`);
  }
  notes.push('wallet readout: provider-named, cleared on an empty list');
}

// Image affordances follow the vision flag of the *card* the dropdown is on.
{
  const treeCanvas = elementById('tree-canvas');
  const base = TURN_MESSAGES.find((m) => m.type === 'config');
  const withVision = { ...base, model: 'card-vision', efforts: ['low', 'high'], thinkingEffort: 'low' };
  const withoutVision = { ...base, model: 'card-text' };
  dispatch(withVision);
  const visibleWithVision = !treeCanvas.classList.contains('hide-images');
  dispatch(withoutVision);
  const hiddenWithoutVision = treeCanvas.classList.contains('hide-images');
  if (!visibleWithVision || !hiddenWithoutVision) {
    problems.push(
      'the image affordances do not follow the card\u2019s `vision` flag (thumbnails should show for an image-capable card and hide otherwise)',
    );
  }
}

// The gear beside the model dropdown is the page's other entry point: clicking it
// must ask the host to open the Model Card Tree (the webview never creates a tab
// itself).
{
  const gear = elementById('models-btn');
  const click = gear && gear._listeners && gear._listeners.click;
  if (typeof click !== 'function') {
    problems.push('the model-cards gear button has no click handler');
  } else {
    click();
    if (!posted.some((message) => message && message.type === 'openModelTree')) {
      problems.push('the model-cards gear button did not ask the host to open the page');
    }
  }
}

// The composer's snippet button: the menu is built from the host's list (the
// webview owns no copy), choosing a name fills the input box, and the click itself
// never sends — a snippet is the *user's* turn, editable before it goes out.
{
  const button = elementById('snippets-btn');
  const input = elementById('input');
  const base = TURN_MESSAGES.find((m) => m.type === 'config');
  const hidden = () => button.classList.contains('hidden');
  const menus = () => document.body.children.filter((child) => child.classList.contains('snippet-menu'));
  const click = button._listeners && button._listeners.click;

  // A host that predates the feature sends no `snippets`: the button stays out of
  // the way rather than opening an empty menu.
  dispatch(base);
  if (!hidden()) {
    problems.push('the snippet button shows up for a config that carries no snippets');
  }
  if (typeof click !== 'function') {
    problems.push('the snippet button has no click handler');
  }

  const snippets = [
    { name: 'Plan', text: 'This is a planning task.' },
    { name: 'Implement Parallel', text: 'Start implementing; parallelize.' },
  ];
  dispatch({ ...base, snippets });
  if (hidden()) {
    problems.push('the snippet button stays hidden although the config carries snippets');
  }

  if (typeof click === 'function') {
    posted.length = 0;
    input.value = '';
    click();
    const menu = menus()[0];
    if (!menu) {
      problems.push('the snippet button opened no menu');
    } else {
      const names = menu.children.map((item) => item.textContent);
      if (names.join(',') !== 'Plan,Implement Parallel') {
        problems.push(`the snippet menu lists ${JSON.stringify(names)} after a config carrying two snippets`);
      }
      notes.push(`prompt snippets: ${names.join(', ') || '(empty)'}`);
      const item = menu.children[0];
      const itemClick = item && item._listeners && item._listeners.click;
      if (typeof itemClick !== 'function') {
        problems.push('a snippet menu item has no click handler');
      } else {
        itemClick({ stopPropagation() {} });
        if (!String(input.value).includes('This is a planning task.')) {
          problems.push(`choosing a snippet did not put its text in the input (${JSON.stringify(input.value)})`);
        }
        if (posted.some((message) => message && message.type === 'userMessage')) {
          problems.push('choosing a snippet sent a message (it must only fill the input box)');
        }
        if (menus().length !== 0) {
          problems.push('the snippet menu stays open after a snippet was chosen');
        }
      }
    }

    // The button toggles: while its menu is up a second click closes it.
    input.value = '';
    click();
    const open = menus().length === 1;
    click();
    if (!open || menus().length !== 0) {
      problems.push('the snippet button does not toggle its own menu');
    }

    // An insertion joins existing text on a line of its own instead of gluing the
    // two sentences together.
    input.value = 'hello';
    click();
    const first = menus()[0] && menus()[0].children[1];
    const secondClick = first && first._listeners && first._listeners.click;
    if (typeof secondClick === 'function') {
      secondClick({ stopPropagation() {} });
    }
    if (String(input.value) !== 'hello\nStart implementing; parallelize.') {
      problems.push(`a snippet inserted into a non-empty input produced ${JSON.stringify(input.value)}`);
    }
    input.value = '';
  }
}

// The composer's Send/Stop pair follows the *view focus* node, not the session:
// you cannot send into a node that is streaming, but a run on another branch must
// leave this composer fully usable (spec §1 — "sending a new prompt when another
// branch is active").
{
  const stop = elementById('stop-btn');
  const send = elementById('send-btn');
  const hidden = (element) => element.classList.contains('hidden');
  // The view focus is only observable through the DOM here (main.js keeps its own
  // `treeActiveId`): the card the webview marked active is the one it docks the
  // composer on, and it must be the `viewId` the tree carried — not `activeId`.
  const treeCanvas = elementById('tree-canvas');
  const activeCard = treeCanvas.children.find((child) => child.classList.contains('active'));
  const viewFocus = activeCard ? activeCard.dataset.id : null;
  if (viewFocus !== NODE_ID) {
    problems.push(`the composer is docked on ${viewFocus} after a tree carrying viewId=${NODE_ID}`);
  }
  const expectComposer = (label, nodes) => {
    dispatch({ type: 'state', busy: nodes.length > 0, status: '', sessionId: 'smoke-session', runningNodes: nodes });
    const wantStop = nodes.includes(NODE_ID);
    if (hidden(stop) !== !wantStop || hidden(send) !== wantStop) {
      problems.push(
        `the composer shows ${hidden(stop) ? 'Send' : 'Stop'} ${label} (runningNodes=${JSON.stringify(nodes)})`,
      );
    }
  };
  expectComposer('while the focused node is streaming', [NODE_ID]);
  expectComposer('while the live run belongs to another branch', ['another-node']);
  expectComposer('once nothing is running', []);
}

// A window that does not own this workspace's sessions is read-only: the host refuses
// every turn there, so the composer says so instead of letting a send fail. The flag
// arrives with `state` (one owner window per workspace), and `send()` checks it again so
// a click never depends on a repaint having happened.
{
  const input = elementById('input');
  const send = elementById('send-btn');
  const stop = elementById('stop-btn');
  const hidden = (element) => element.classList.contains('hidden');
  const state = (readOnly) =>
    dispatch({ type: 'state', busy: false, status: '', sessionId: 'smoke-session', runningNodes: [], lockedNodes: [], readOnly });

  state(true);
  if (hidden(send) || !hidden(stop)) {
    problems.push('a read-only window hides Send and shows Stop (it must offer neither a stop nor a silent send)');
  }
  if (!send.disabled) {
    problems.push('a read-only window leaves the Send button enabled');
  }
  if (!/read-only/.test(String(send.title || ''))) {
    problems.push(`the read-only Send button carries no reason: ${JSON.stringify(send.title)}`);
  }
  // A click must not send anything, even if the flag arrives between a repaint and the click.
  const before = posted.length;
  input.value = 'this must not reach the host';
  if (typeof send._listeners?.click === 'function') {
    send._listeners.click({ preventDefault() {}, stopPropagation() {} });
  }
  if (posted.length !== before) {
    problems.push('a read-only window sent a message anyway');
  }
  input.value = '';

  // The flag clears when the state says so: the same window may own the sessions later.
  state(false);
  if (send.disabled) {
    problems.push('the Send button stayed disabled after the read-only flag cleared');
  }
  if (hidden(send)) {
    problems.push('Send stayed hidden after the read-only flag cleared');
  }
}

// A node that is *not* streaming but still owns unfinished work (a running
// background terminal / async sub-agent batch, or a completion notice about to be
// injected into it) is "doing something", so the composer offers **Stop** there too —
// one button, one meaning ("stop what this node is doing"), which the host turns into
// a union kill. No banner: the button says it. The input stays usable exactly as it
// does while a turn streams.
{
  const input = elementById('input');
  const send = elementById('send-btn');
  const stop = elementById('stop-btn');
  const attach = elementById('attach-btn');
  const banner = elementById('branch-banner');
  const hidden = (element) => element.classList.contains('hidden');
  const locked = (ids) =>
    dispatch({ type: 'state', busy: false, status: '', sessionId: 'smoke-session', runningNodes: [], lockedNodes: ids });
  locked([NODE_ID]);
  if (hidden(stop) || !hidden(send)) {
    problems.push(
      `a node that still owns unfinished work shows ${hidden(stop) ? 'Send' : 'Stop'} (it must offer Stop — the union kill)`,
    );
  }
  if (!stop.title) {
    problems.push('the Stop button of a node that owns unfinished work carries no tooltip (it kills more than a turn)');
  }
  if (input.disabled || attach.disabled) {
    problems.push('a node that owes unfinished work greys out its input / attach (only the button should change)');
  }
  if (banner && !banner.classList.contains('hidden')) {
    problems.push('a node that owes unfinished work shows an extra banner (Stop is the explanation)');
  }
  locked([]);
  if (hidden(send) || !hidden(stop)) {
    problems.push('the composer does not go back to Send once the node reported no unfinished work');
  }
  if (input.disabled || attach.disabled) {
    problems.push('the composer stays disabled after the node reported no unfinished work');
  }
}

// --- The composer's two identities, the Send gate and `composerClear` (§4.2/§4.4)
// A setup change never rewrites already-sent bytes: the composer shows *both*
// identities — what this send uses (the checked-out node's frozen setup) and what a
// new node would freeze — and drift only decides how Send behaves. Three things are
// checked here that a plain replay cannot show:
//   (a) an absent `setup` (an old replay shape) hints nothing and never disables Send;
//   (b) `drift: 'user'` draws the two lines, marks Send with `drift` and leaves it
//       *enabled* (the host asks with a modal, the button is not the gate), while
//       `drift: 'harness'` leaves the button alone and shows the extra fork hint;
//   (c) the composer empties only on `composerClear` — neither the Send button nor
//       Enter clears it, so a modal answered with No cannot eat the user's text.
{
  const R = 'setup-root';
  const treeNode = { id: R, parentId: null, children: [], title: R, status: 'done', createdAt: 0, preview: R, usage: null, size: null };
  dispatch({ type: 'reset' });
  dispatch({ type: 'tree', viewId: R, activeId: null, rootId: R, rootIds: [R], nodes: [treeNode] });
  dispatch({ type: 'path', ids: [R], nodes: [{ id: R, status: 'done', items: [] }] });

  const base = { ...TURN_MESSAGES.find((m) => m.type === 'config'), model: 'card-text', thinkingEffort: 'medium' };
  const input = elementById('input');
  const sendBtn = elementById('send-btn');
  const controls = elementById('composer-controls');
  const composer = elementById('composer');
  const ident = () => findByClass(composer, 'composer-ident');
  const hintBtn = () => findByClass(controls, 'new-setup-btn');
  const lineText = (name) => {
    const box = ident();
    const line = box ? findByClass(box, name) : null;
    return String((line || {}).textContent || '');
  };
  const hidden = (element) => !!element && element.classList.contains('hidden');

  const nodeIdent = { cardId: 'card-text', cardLabel: 'smoke-model', effort: 'medium', language: 'English' };
  const liveIdent = { cardId: 'card-vision', cardLabel: 'smoke-vision-model', effort: 'low', language: 'Chinese' };

  // (a) No `setup` at all: the shape a host that predates the epochs still sends.
  dispatch({ ...base, setup: undefined });
  if (!hidden(ident()) && ident()) {
    problems.push('a config without `setup` still shows the two identities');
  }
  if (sendBtn.classList.contains('drift')) {
    problems.push('a config without `setup` leaves the Send button marked as drifted');
  }
  if (sendBtn.disabled) {
    problems.push('a config without `setup` disables Send');
  }

  // (b1) The user changed the model / effort: both identities, in two lines.
  dispatch({ ...base, setup: { node: nodeIdent, live: liveIdent, drift: 'user', reasons: ['card'] } });
  const box = ident();
  if (!box || hidden(box)) {
    problems.push('a `setup` with drift "user" shows no two-line identity block in the composer');
  } else {
    const wantSending = 'Sending with: smoke-model · medium · English';
    const wantLive = 'New setup: smoke-vision-model · low · Chinese';
    if (lineText('composer-ident-sending') !== wantSending) {
      problems.push(
        `the "Sending with" line reads ${JSON.stringify(lineText('composer-ident-sending'))}, expected ${JSON.stringify(wantSending)}`,
      );
    }
    if (lineText('composer-ident-live') !== wantLive) {
      problems.push(
        `the "New setup" line reads ${JSON.stringify(lineText('composer-ident-live'))}, expected ${JSON.stringify(wantLive)}`,
      );
    }
  }
  if (!sendBtn.classList.contains('drift')) {
    problems.push('the Send button carries no `drift` class after the user changed the setup');
  }
  if (sendBtn.disabled) {
    problems.push('the drifted Send button is disabled — it must stay usable (the host asks with a modal, §4.2)');
  }
  if (!sendBtn.title) {
    problems.push('the drifted Send button has no tooltip saying that it will ask first');
  }

  // The click still posts the same `userMessage` the Enter key does — and the box
  // keeps its text until the host says it took the message.
  input.value = 'drifted send';
  posted.length = 0;
  const sendClick = sendBtn._listeners && sendBtn._listeners.click;
  if (typeof sendClick !== 'function') {
    problems.push('the Send button has no click handler');
  } else {
    sendClick();
    const sentByButton = posted.find((m) => m && m.type === 'userMessage');
    if (!sentByButton || sentByButton.text !== 'drifted send') {
      problems.push(`clicking Send while drifted posted ${JSON.stringify(posted)}, expected a \`userMessage\``);
    }
    if (String(input.value) !== 'drifted send') {
      problems.push(`Send cleared the input itself (${JSON.stringify(input.value)}) — only \`composerClear\` may`);
    }
  }

  input.value = 'typed with enter';
  posted.length = 0;
  const enterKey = input._listeners && input._listeners.keydown;
  if (typeof enterKey !== 'function') {
    problems.push('the composer input has no keydown handler (Enter could not send at all)');
  } else {
    enterKey({ key: 'Enter', shiftKey: false, preventDefault() {} });
    const sentByEnter = posted.find((m) => m && m.type === 'userMessage');
    if (!sentByEnter || sentByEnter.text !== 'typed with enter') {
      problems.push(`Enter posted ${JSON.stringify(posted)}, expected the same \`userMessage\` the button posts`);
    }
    if (String(input.value) !== 'typed with enter') {
      problems.push('Enter cleared the input itself — only the host may, with `composerClear`');
    }
  }

  // `composerClear` is the one message that empties it.
  dispatch({ type: 'composerClear' });
  if (String(input.value) !== '') {
    problems.push(`\`composerClear\` left ${JSON.stringify(input.value)} in the input`);
  }

  // (b2) The harness drifted instead: no mark on Send, and the extra fork hint.
  dispatch({ ...base, setup: { node: nodeIdent, live: liveIdent, drift: 'harness', reasons: ['template'] } });
  if (!hidden(ident()) && ident()) {
    problems.push('a harness drift shows the user-drift identity block (only `drift: "user"` may)');
  }
  if (sendBtn.classList.contains('drift')) {
    problems.push('a harness drift marks the Send button (the user did not change anything)');
  }
  if (sendBtn.title) {
    problems.push(`a harness drift leaves the drifted tooltip on Send (${JSON.stringify(sendBtn.title)})`);
  }
  const hint = hintBtn();
  if (!hint) {
    problems.push('a harness drift shows no `#new-setup-btn` hint beside the snippets button');
  } else {
    if (hidden(hint)) {
      problems.push('the harness-drift hint button is hidden although the harness drifted');
    }
    if (!hint.title) {
      problems.push('the harness-drift hint button carries no tooltip explaining what its click does');
    }
    input.value = 'fork this';
    posted.length = 0;
    const hintClick = hint._listeners && hint._listeners.click;
    if (typeof hintClick !== 'function') {
      problems.push('the harness-drift hint button has no click handler');
    } else {
      hintClick({ stopPropagation() {} });
      const forked = posted.find((m) => m && m.type === 'forkTurn');
      if (!forked) {
        problems.push(`the harness-drift hint posted ${JSON.stringify(posted)}, expected \`{ type: 'forkTurn' }\``);
      } else {
        if (forked.text !== 'fork this') {
          problems.push(`the hint button forked with ${JSON.stringify(forked.text)}, expected the composer's text`);
        }
        if (!Array.isArray(forked.attachments)) {
          problems.push('the `forkTurn` message carries no attachments array');
        }
      }
      if (String(input.value) !== 'fork this') {
        problems.push('posting `forkTurn` cleared the input (the host clears it with `composerClear`)');
      }
    }
  }

  // Back to no drift: both affordances go away again (the hint is hidden, so it
  // cannot fork a tree for no reason).
  dispatch(base);
  if (!hidden(ident()) && ident()) {
    problems.push('the identity block stays visible after the setup stopped drifting');
  }
  if (hintBtn() && !hidden(hintBtn())) {
    problems.push('the harness-drift hint stays visible after the drift went away');
  }
  notes.push('composer identities: user drift (two lines, Send still enabled) + harness drift (fork hint)');
}

// --- The forest: several roots side by side (§3) -------------------------------
// A session is a forest of trees. Every root is laid out by the engine on its own and
// the trees are placed left to right with a visible gap, so two trees read as two
// parallel conversations; pan / zoom / fit span all of them, the composer stays on the
// checked-out node's tree — and a card of the *other* tree is still a live checkout
// target.
{
  const R1 = 'forest-root-1', A1 = 'forest-node-1a', B1 = 'forest-node-1b';
  const R2 = 'forest-root-2', A2 = 'forest-node-2a';
  const treeNode = (id, parentId, children) => ({
    id, parentId, children, title: id, status: 'done', createdAt: 0, preview: id, usage: null, size: null,
  });
  dispatch({ type: 'reset' });
  dispatch({
    type: 'tree',
    // The view focuses a node of the *second* tree: the layout order must follow
    // `rootIds`, not the focus.
    viewId: A2,
    activeId: null,
    // `rootId` is `rootIds[0]`, exactly as the host sends the pair.
    rootId: R1,
    rootIds: [R1, R2],
    nodes: [
      treeNode(R1, null, [A1]),
      treeNode(A1, R1, [B1]),
      treeNode(B1, A1, []),
      treeNode(R2, null, [A2]),
      treeNode(A2, R2, []),
    ],
  });
  dispatch({
    type: 'path',
    ids: [R2, A2],
    nodes: [{ id: R2, status: 'done', items: [] }, { id: A2, status: 'done', items: [] }],
  });

  const canvas = elementById('tree-canvas');
  const card = (id) => canvas.children.find((child) => child.dataset && child.dataset.id === id) || null;
  let missing = false;
  for (const id of [R1, A1, B1, R2, A2]) {
    if (!card(id)) {
      missing = true;
      problems.push(`no card was rendered for forest node ${id}`);
    }
  }
  if (!missing) {
    // The stub reports no card geometry, so the webview laid every card out at its
    // default width (`NODE_W`, 320px) — enough to ask where each tree sits.
    const left = (id) => parseFloat(card(id).style.left);
    const treeOneRight = Math.max(left(R1), left(A1), left(B1)) + 320;
    const treeTwoLeft = Math.min(left(R2), left(A2));
    if (!(treeTwoLeft - treeOneRight >= 64)) {
      problems.push(
        `the second root starts ${Math.round(treeTwoLeft - treeOneRight)}px right of the first tree, ` +
          'expected the visible gap a forest lays out between two trees',
      );
    }
    // Both roots start on the same line: they are parallel conversations, not a
    // vertical stack.
    if (Math.abs(parseFloat(card(R1).style.top) - parseFloat(card(R2).style.top)) > 1) {
      problems.push('the two roots are not laid out on the same top line (a forest is side by side, not stacked)');
    }
    // The composer is docked on the checked-out node's tree (tree 2), never on the
    // other root.
    if (elementById('composer').parentElement !== card(A2)) {
      problems.push('the composer is not docked on the checked-out node of the focused tree in a forest');
    }
    // …and the *unfocused* tree is still interactive: a click on its card checks it out.
    const head = { closest: (sel) => (sel === '.node' ? card(B1) : null) };
    const target = { closest: (sel) => (sel === '.node-head' ? head : null) };
    const canvasClick = canvas._listeners && canvas._listeners.click;
    if (typeof canvasClick !== 'function') {
      problems.push('the tree canvas has no click handler — no card could be checked out at all');
    } else {
      posted.length = 0;
      canvasClick({ target });
      const checkout = posted.find((m) => m && m.type === 'checkout');
      if (!checkout || checkout.id !== B1) {
        problems.push(
          `clicking a card of the unfocused tree posted ${JSON.stringify(posted)}, expected { type: 'checkout', id: '${B1}' }`,
        );
      }
    }
    // Fit spans the whole forest: the canvas covers both trees.
    const fit = elementById('fit-btn');
    if (typeof fit._listeners?.click !== 'function') {
      problems.push('the fit button has no click handler');
    } else {
      fit._listeners.click();
      if (!(parseFloat(canvas.style.width) > treeTwoLeft)) {
        problems.push('`fit` sees a canvas that does not reach the second tree — the forest is not laid out as a whole');
      }
    }
    // Follow still moves the camera to the checked-out node of the focused tree.
    const followBtn = elementById('follow-btn');
    if (typeof followBtn._listeners?.click === 'function') {
      followBtn._listeners.click();
      followBtn._listeners.click();
    }
    notes.push('forest: two roots side by side, both interactive, composer on the focused tree');
  }
}

// --- Sidecar cards: background job cards + the Delivered badge ----------------
// A background job now renders as its own `kind:'bg'` card in the owner's sidecar
// grid (the bottom dock is gone), and both sidecar kinds carry a `Delivered` badge
// once their completion signal reached the agent. The notification block is
// injected mid-turn, so it must land inside the owner's card without tearing down
// the answer that is streaming there.
{
  const A = 'bg-node-a';     // root, on the view path
  const B = 'bg-node-b';     // turn child, view focus
  const JOB = 'bg-node-job'; // `kind:'bg'` sidecar of A — running
  const SUB = 'bg-node-sub'; // `kind:'agent'` sidecar of A — delivered
  const JOB2 = 'bg-node-job2'; // `kind:'bg'` sidecar of B — finished + delivered
  const node = (id, parentId, children, extra) => Object.assign(
    {
      id,
      parentId,
      children,
      title: id,
      status: 'done',
      createdAt: 0,
      preview: id + ' preview',
      usage: null,
      size: null,
    },
    extra || {},
  );
  const task = (id, nodeId, cardNodeId, command, extra) => Object.assign(
    {
      id,
      nodeId,
      cardNodeId,
      command,
      status: 'running',
      exitCode: null,
      killed: false,
      startedAt: Date.now() - 1000,
      finishedAt: null,
      truncated: false,
      outputTail: command + ' output',
      pendingDelivery: false,
    },
    extra || {},
  );

  dispatch({
    type: 'tree',
    viewId: B,
    activeId: null,
    rootId: A,
    nodes: [
      node(A, null, [B, JOB, SUB]),
      node(B, A, [JOB2]),
      node(JOB, A, [], { kind: 'bg', bgTaskId: 7, bgCommand: 'smoke-job-a', status: 'running' }),
      node(SUB, A, [], { kind: 'agent', agentStatus: 'done', delivered: true, agentSummary: 'done' }),
      node(JOB2, B, [], {
        kind: 'bg',
        bgTaskId: 8,
        bgCommand: 'smoke-job-b',
        bgExitCode: 0,
        delivered: true,
        bgOutputTail: 'smoke-job-b output',
      }),
    ],
  });
  dispatch({ type: 'path', ids: [A, B], nodes: [{ id: A, status: 'done', items: [] }, { id: B, status: 'done', items: [] }] });

  const cards = new Map();
  for (const child of elementById('tree-canvas').children) {
    if (child.dataset && child.dataset.id) cards.set(child.dataset.id, child);
  }
  const cardOf = (id) => cards.get(id);
  const has = (element, name) => !!element && element.classList.contains(name);
  const textOf = (element, selector) => String((findByClass(element, selector) || {}).textContent || '');
  const deliveredBadge = (id) => {
    const card = cardOf(id);
    return card ? findByClass(card, 'node-delivered-badge') : null;
  };
  const killOf = (id) => {
    const card = cardOf(id);
    return card ? findByClass(card, 'bg-kill') : null;
  };

  // (a) The message must not throw: the webview has to understand the new shape.
  if (dispatch({ type: 'backgrounds', tasks: [task(7, A, JOB, 'smoke-job-a')] })) {
    problems.push("a `backgrounds` message threw — the webview no longer understands the provider's shape");
  }

  // (b) Every job card was rendered once, and the old bottom dock is gone.
  for (const id of [JOB, SUB, JOB2]) {
    if (!cardOf(id)) {
      problems.push(`no card was rendered for sidecar node ${id}`);
    }
  }
  for (const id of [A, B]) {
    if (findByClass(cardOf(id), 'node-bg')) {
      problems.push(`node ${id} still renders a .node-bg dock — the job moved to its own card`);
    }
  }

  // (c) A running job's card shows its command/status and offers a kill button; a
  // job that already left the snapshot falls back to its persisted terminal state
  // (the card is a record after delivery, D1) and is not killable.
  if (cardOf(JOB)) {
    const status = textOf(cardOf(JOB), 'bg-status');
    const cmd = textOf(cardOf(JOB), 'bg-card-cmd');
    if (status !== 'running' || cmd !== 'smoke-job-a') {
      problems.push(`the running job card shows ${JSON.stringify(status + ' / ' + cmd)}, expected "running / smoke-job-a"`);
    }
    if (!killOf(JOB)) {
      problems.push('a running job card has no kill button');
    }
  }
  if (cardOf(JOB2)) {
    const status = textOf(cardOf(JOB2), 'bg-status');
    if (status !== 'exit 0') {
      problems.push(`a delivered job card shows ${JSON.stringify(status)}, expected its persisted "exit 0"`);
    }
    if (killOf(JOB2)) {
      problems.push('a finished job card still offers a kill button');
    }
  }

  // (d) `Delivered` (D1) shows on both sidecar kinds once the signal reached the
  // agent, and not before.
  const badgeSub = deliveredBadge(SUB);
  const badgeJob = deliveredBadge(JOB2);
  if (!badgeSub || badgeSub.textContent !== 'Delivered') {
    problems.push('a delivered sub-agent card has no `Delivered` badge');
  }
  if (!badgeJob || badgeJob.textContent !== 'Delivered') {
    problems.push('a delivered background card has no `Delivered` badge');
  }
  if (deliveredBadge(JOB)) {
    problems.push('a job card that is still pending shows `Delivered`');
  }

  // (e) The notification block is injected at a tool boundary of a *running* turn,
  // so it lands inside the owner's card, after the answer streamed so far and
  // before whatever streams next — and it is not a user bubble.
  dispatch({ type: 'delta', nodeId: B, text: 'before the notice' });
  dispatch({
    type: 'backgroundNotice',
    nodeId: B,
    item: { kind: 'subagent', id: 'sub-notice', name: '子代理完成', doneText: '1 个子代理完成', content: 'child done' },
  });
  dispatch({ type: 'delta', nodeId: B, text: 'after the notice' });
  {
    const items = findByClass(cardOf(B), 'node-work');
    const kinds = (items ? items.children : []).map((child) => (child.dataset && child.dataset.kind) || '?');
    if (kinds.join(',') !== 'assistant,background,assistant') {
      problems.push(
        `a mid-turn notice produced ${JSON.stringify(kinds)} in node ${B}, expected an assistant / ` +
          'notification / assistant sequence',
      );
    }
    const notice = (items ? items.children : []).find((child) => (child.dataset && child.dataset.kind) === 'background');
    const badge = notice ? findByClass(notice, 'bgnotify-badge') : null;
    if (!badge || badge.textContent !== 'SUB') {
      problems.push('a sub-agent notification block is not badged `SUB` (it would read as a background terminal)');
    }
    if (has(notice, 'user')) {
      problems.push('the notification block was rendered as a user bubble');
    }
    if (cards.has('sub-notice')) {
      problems.push('the notification opened a card of its own — it must stay inside the owner node');
    }
  }
}

// --- Lazy sub-agent transcripts ----------------------------------------------
// A `tree` message used to carry every `kind:'agent'` node's whole transcript, which
// made one 8-node session 2.3 MB and 10 035 DOM elements. Such a node now carries
// `itemCount` and no `items`; a card that expands asks for them once
// (`loadAgentItems`) and renders the `agentItems` answer exactly once. That is a
// host⇄webview contract, so both halves are checked here.
{
  const ROOT = 'lazy-root';
  const SUB = 'lazy-sub';
  const node = (id, parentId, children, extra) => Object.assign(
    { id, parentId, children, title: id, status: 'done', createdAt: 0, preview: id, usage: null, size: null },
    extra || {},
  );
  const cardsOf = () => {
    const cards = new Map();
    for (const child of elementById('tree-canvas').children) {
      if (child.dataset && child.dataset.id) cards.set(child.dataset.id, child);
    }
    return cards;
  };

  // The sub-agent is a child of the view focus, so its card is expanded (see
  // `agentExpanded`) while it is NOT on the path — exactly the lazy case.
  dispatch({ type: 'reset' });
  posted.length = 0;
  dispatch({
    type: 'tree',
    viewId: ROOT,
    activeId: null,
    rootId: ROOT,
    nodes: [
      node(ROOT, null, [SUB]),
      node(SUB, ROOT, [], { kind: 'agent', agentStatus: 'done', itemCount: 3 }),
    ],
  });
  dispatch({ type: 'path', ids: [ROOT], nodes: [{ id: ROOT, status: 'done', items: [] }] });

  const sub = cardsOf().get(SUB);
  if (!sub) {
    problems.push('no card was rendered for the sub-agent node of the lazy-tree fixture');
  }
  const asked = posted.filter((m) => m && m.type === 'loadAgentItems');
  if (asked.length !== 1 || asked[0].id !== SUB) {
    problems.push(
      `an expanded sub-agent card posted ${JSON.stringify(asked)}, expected exactly one ` +
        `{ type: 'loadAgentItems', id: '${SUB}' }`,
    );
  }
  const subItems = sub ? findByClass(sub, 'node-work') : null;
  const subAnswer = sub ? findByClass(sub, 'node-answer') : null;
  if (!subItems || !subAnswer) {
    problems.push('an agent card has no `.node-work` / `.node-answer` container');
  } else {
    const rendered = () => subItems.children.length + subAnswer.children.length;
    const before = rendered();
    if (before !== 0) {
      problems.push(`a sub-agent card rendered ${before} item(s) before its transcript arrived (the tree carries only itemCount)`);
    }
    dispatch({ type: 'agentItems', id: SUB, items: [{ kind: 'assistant', text: '子代理答案' }] });
    const after = rendered();
    if (after !== 1) {
      problems.push(`an agentItems answer produced ${after} item(s) in the card, expected 1`);
    }
    // That one item is a lone assistant item — the tail of the log and therefore
    // the sub-agent's final answer, which is *moved* into zone 3 (not copied, not
    // left behind in the log).
    if (subItems.children.length !== 0 || subAnswer.children.length !== 1) {
      problems.push(
        `an agentItems answer left ${subItems.children.length} item(s) in .node-work and ` +
          `${subAnswer.children.length} in .node-answer, expected 0 / 1 (a lone assistant item is the answer)`,
      );
    }
    dispatch({ type: 'agentItems', id: SUB, items: [{ kind: 'assistant', text: '子代理答案' }] });
    if (rendered() !== after) {
      problems.push(
        `a second agentItems answer re-rendered the transcript (${after} → ${rendered()} items) — ` +
          'the card must render once',
      );
    }
    // An answer for a node the tree no longer has must be ignored, not thrown.
    dispatch({ type: 'agentItems', id: 'lazy-gone', items: [] });
  }

  // The lazy rule is about `tree` only: a `path` that carries items (a checked-out
  // sidecar, or any turn node) must still render immediately.
  dispatch({ type: 'reset' });
  dispatch({
    type: 'tree',
    viewId: SUB,
    activeId: null,
    rootId: ROOT,
    nodes: [node(ROOT, null, [SUB]), node(SUB, ROOT, [], { kind: 'agent' })],
  });
  dispatch({ type: 'path', ids: [SUB], nodes: [{ id: SUB, status: 'done', items: [{ kind: 'assistant', text: '内联' }] }] });
  const checkedOut = cardsOf().get(SUB);
  const inlineWork = checkedOut ? findByClass(checkedOut, 'node-work') : null;
  const inlineAnswer = checkedOut ? findByClass(checkedOut, 'node-answer') : null;
  // The item is a lone assistant item, so it is zone 3 by the same rule: what the
  // `path` items must render immediately is the answer.
  if (!inlineWork || !inlineAnswer || inlineAnswer.children.length !== 1 || inlineWork.children.length !== 0) {
    problems.push(
      'a `path` carrying items no longer renders them (a checked-out sidecar must render immediately, and its lone ' +
        'assistant item is the .node-answer)',
    );
  }
}

// --- A card whose items never arrived asks for them (the replica's fetch) -------
// A replica gets the structural `tree` and nothing else — `RemoteService.mirrorTree`
// answers an `attach` with `treeMessage()`, and no `path` ever reaches that surface — so a
// regular card's items are in *no* payload it holds. Measured on a real phone: three cards
// at `work:0 ans:0` next to a `preview` that promised a full session, indistinguishable
// from an empty, finished node. Such a card now says it is waiting and asks once
// `loadNodeItems` → `nodeItems`). The five cases are checked here as (a) waiting and one
// ask, (b) the answer rendering and clearing, (c) a re-expansion not re-asking, (d) the
// `pnode` trap in its own fixture — `pnode` used to win whenever it merely *existed*, so a
// `path` row carrying no items hid the real ones on the row next to it — and (e) a reply
// for an unknown id being ignored rather than thrown.
{
  const ROOT = 'fetch-root';
  const LAST = 'fetch-last'; // the second card of the same session, for the re-expansion
  const TRAP = 'fetch-trap'; // items on the tree row only, a `path` row without any
  const node = (id, parentId, children, extra) => Object.assign(
    { id, parentId, children, title: id, status: 'done', createdAt: 0, preview: id, usage: null, size: null },
    extra || {},
  );
  const cardOf = (id) => {
    for (const child of elementById('tree-canvas').children) {
      if (child.dataset && child.dataset.id === id) return child;
    }
    return null;
  };
  /** Rendered items of a card, or -1 when a zone is missing (so a miss is not a pass). */
  const itemsOf = (card) => {
    const work = card ? findByClass(card, 'node-work') : null;
    const answer = card ? findByClass(card, 'node-answer') : null;
    return (work ? work.children.length : -1) + (answer ? answer.children.length : -1);
  };
  const asked = () => posted.filter((m) => m && m.type === 'loadNodeItems');
  const askedOf = (id) => asked().filter((m) => m.id === id);

  // The replica's shape: one `tree`, its `viewId` card expanded, and no `path` message.
  dispatch({ type: 'reset' });
  posted.length = 0;
  dispatch({
    type: 'tree',
    viewId: ROOT,
    activeId: null,
    rootId: ROOT,
    rootIds: [ROOT, LAST],
    nodes: [node(ROOT, null, []), node(LAST, null, [])],
  });

  // (a) A card with no items waits, visibly, and asks exactly once.
  const root = cardOf(ROOT);
  if (!root) {
    problems.push('no card was rendered for the per-node fetch fixture');
  } else {
    if (!hasClass(root, 'items-loading')) {
      problems.push(
        'a card with no items does not show a loading state (`items-loading`) — a card that shows nothing is ' +
          'indistinguishable from an empty, finished node, which is the measured replica symptom (three cards, ' +
          '`work:0 ans:0`, a full published session)',
      );
    }
    const strip = findByClass(root, 'node-loading');
    if (!strip || String(strip.textContent || '').length === 0) {
      problems.push(
        'a waiting card has no `.node-loading` strip with a label: nothing on screen says the content is on its ' +
          'way (the one string this adds, written as a `tr()` literal so `check:l10n` can see it)',
      );
    }
    if (itemsOf(root) !== 0) {
      problems.push(`a card waiting for its items rendered ${itemsOf(root)} item(s) before they arrived`);
    }
  }
  const firstAsk = asked();
  if (firstAsk.length !== 1 || firstAsk[0].id !== ROOT) {
    problems.push(
      `an expanded card with no items posted ${JSON.stringify(firstAsk)}, expected exactly one ` +
        `{ type: 'loadNodeItems', id: '${ROOT}' }`,
    );
  }

  // (c) A second expansion — the reader collapses and reopens the card, or a repaint
  // re-expands it — must not ask again: the host would re-serialize the whole transcript
  // for a card that already asked (`_itemsRequested` is the one-shot contract).
  const treeAgain = (viewId) =>
    dispatch({
      type: 'tree',
      viewId,
      activeId: null,
      rootId: ROOT,
      rootIds: [ROOT, LAST],
      nodes: [node(ROOT, null, []), node(LAST, null, [])],
    });
  treeAgain(LAST); // the view moves: ROOT's card collapses
  treeAgain(ROOT); // …and comes back, still waiting (no answer yet)
  if (askedOf(ROOT).length !== 1) {
    problems.push(
      `a second expansion asked for ${ROOT} again (${askedOf(ROOT).length} request(s)) — collapsing and reopening ` +
        'a card, or a repaint that re-expands it, must not re-ask',
    );
  }
  const reopened = cardOf(ROOT);
  if (!reopened || !hasClass(reopened, 'items-loading')) {
    problems.push('a card re-expanded while it is still waiting no longer shows its loading state');
  }

  // (b) The answer: rendered into that card, once, and the waiting state goes with it.
  dispatch({ type: 'nodeItems', id: ROOT, items: [{ kind: 'assistant', text: '来自节点的答案' }] });
  const answered = cardOf(ROOT);
  if (itemsOf(answered) !== 1) {
    problems.push(
      `a nodeItems answer left ${itemsOf(answered)} item(s) in the card, expected its one answer item ` +
        '(the host answers with the same clipped `displayItems` a `path` would carry)',
    );
  }
  if (answered && hasClass(answered, 'items-loading')) {
    problems.push(
      'a nodeItems answer left the card in its loading state — the strip keeps claiming the content is on its way ' +
        'after it arrived',
    );
  }
  dispatch({ type: 'nodeItems', id: ROOT, items: [{ kind: 'assistant', text: '来自节点的答案' }] });
  if (itemsOf(cardOf(ROOT)) !== 1) {
    problems.push(
      `a second nodeItems answer re-rendered the card (${itemsOf(cardOf(ROOT))} item(s)) — the card must render once`,
    );
  }

  // (d) The `pnode` trap, on its own fixture: the tree row carries the items, the path row
  // for the same node carries none. `pnode` winning just by existing is what left a card
  // blank while the row next to it held the whole turn.
  dispatch({ type: 'reset' });
  posted.length = 0;
  dispatch({
    type: 'tree',
    viewId: ROOT,
    activeId: null,
    rootId: ROOT,
    nodes: [
      node(ROOT, null, [TRAP]),
      node(TRAP, ROOT, [], { items: [{ kind: 'assistant', text: '来自树行的答案' }] }),
    ],
  });
  dispatch({ type: 'path', ids: [TRAP], nodes: [{ id: TRAP, status: 'done' }] });
  const trap = cardOf(TRAP);
  if (itemsOf(trap) !== 1) {
    problems.push(
      `a card whose path row carried no items but whose tree row carried one rendered ${itemsOf(trap)} item(s) — ` +
        'the path row must not win over a source that has items just by existing',
    );
  }
  if (trap && hasClass(trap, 'items-loading')) {
    problems.push('a card filled from its tree row still claims its content is on its way');
  }

  // (e) An answer for a node the tree no longer has must be ignored, not thrown: a
  // webview callback that throws is silent in the real UI (`dispatch` reports it here).
  dispatch({ type: 'nodeItems', id: 'fetch-gone', items: [{ kind: 'assistant', text: '孤儿' }] });

  notes.push(
    `per-node fetch: a card with no items waits and asks once (${askedOf(ROOT).length} loadNodeItems for the ` +
      're-expanded card, the nodeItems answer rendered 1 item)',
  );
}

// --- A summarised card fetches its log on expansion, and only then -----------------
// A row describing a **finished** node no longer carries the whole transcript: it carries
// `items` = the turn's first `user` item and its last answer, `summary: true`, and the
// node's real `itemCount` (`SessionRuntime`, see `itemsSource` in media/main.js). The card
// renders that summary, knows it is not the log, and asks for the rest with the *same*
// on-demand pair the replica case above uses (`loadNodeItems` -> `nodeItems`) — there is no
// second mechanism and no second request shape. Eight facts are pinned here, each as its own
// fixture:
//  (a) a collapsed summarised card renders nothing and asks for nothing — the fetch is the
//      expansion's, never the arrival's;
//  (b) expanding it renders the summary, asks exactly once, and wears the loading strip
//      while the log is on its way;
//  (c) the `nodeItems` answer replaces the summary and clears the strip;
//  (d) collapsing and re-expanding does not ask again, and does not fall back to the
//      summary;
//  (e) a card whose row is **not** a summary never asks (the control);
//  (f) the local shape: the summary rides the `path`, which is not an answer to the
//      request the `tree` pass already posted, so the strip stays and the request stays one;
//  (g) a summary that summarises to nothing (`items: []` plus the flag) is still a summary:
//      the flag is what says the log is elsewhere;
//  (h) a *full* row landing next to a rendered summary is the log — rendering it beats a
//      round trip for items already in hand, whichever of the two rows carries it.
{
  const SUM = 'sum-root';    // finished, summarised tree row; collapsed in the first fixture
  const FULL = 'sum-full';   // finished, full tree row — the control: it must never ask
  const LOCAL = 'sum-local'; // the local shape: the summary arrives in the `path`
  const EMPTY = 'sum-empty'; // the summary that summarises to nothing (`items: []` + the flag)
  const UPG = 'sum-upgrade';   // the tree row summarises it, the `path` row carries the log
  const UPG2 = 'sum-upgrade2'; // the `path` summarises it, a later `tree` row carries the log
  const LIVE = 'sum-live';   // the turn streamed into its card, so the row's summary is not it
  const node = (id, parentId, children, extra) => Object.assign(
    { id, parentId, children, title: id, status: 'done', createdAt: 0, preview: id, usage: null, size: null },
    extra || {},
  );
  const cardOf = (id) => {
    for (const child of elementById('tree-canvas').children) {
      if (child.dataset && child.dataset.id === id) return child;
    }
    return null;
  };
  /** Rendered items of a card, or -1 when a zone is missing (so a miss is not a pass). */
  const itemsOf = (card) => {
    const work = card ? findByClass(card, 'node-work') : null;
    const answer = card ? findByClass(card, 'node-answer') : null;
    return (work ? work.children.length : -1) + (answer ? answer.children.length : -1);
  };
  const askedOf = (id) => posted.filter((m) => m && m.type === 'loadNodeItems' && m.id === id);
  /** The host's summary shape: the first ask of the turn, and its last answer. */
  const SUMMARY = [
    { kind: 'user', text: '概括的问题' },
    { kind: 'assistant', text: '概括的答案' },
  ];
  // What `loadNodeItems` answers with. Two trailing answers, so the number of rendered
  // items says *which* of the two the card shows: the summary lifts 1 item into zone 3,
  // the log lifts 2.
  const LOG = [
    { kind: 'user', text: '概括的问题' },
    { kind: 'assistant', text: '真正的答案一' },
    { kind: 'assistant', text: '真正的答案二' },
  ];
  const SUMMARY_ITEMS = 1;
  const LOG_ITEMS = 2;
  const frame = (viewId, nodes) =>
    dispatch({
      type: 'tree',
      viewId,
      activeId: null,
      rootId: nodes[0].id,
      rootIds: nodes.map((n) => n.id),
      nodes,
    });

  // (a) SUM is a sibling of the view focus, so its card is collapsed. A card nobody opened
  // must not ask for the log behind the summary: the single ask belongs to the first
  // expansion, and a fetch on arrival would ask for every finished card of a session at
  // once — the burst the queue above exists to bound.
  dispatch({ type: 'reset' });
  posted.length = 0;
  const summaryRow = (id) => node(id, null, [], { items: SUMMARY, summary: true, itemCount: LOG.length });
  frame(FULL, [summaryRow(SUM), node(FULL, null, [], { items: LOG })]);
  if (askedOf(SUM).length !== 0) {
    problems.push(
      `a collapsed card whose row carries a summary asked for its log (${askedOf(SUM).length} loadNodeItems) — the fetch ` +
        'belongs to the first expansion, not to the summary arriving',
    );
  }
  const collapsedSum = cardOf(SUM);
  if (itemsOf(collapsedSum) !== 0) {
    problems.push(
      `a collapsed summarised card rendered ${itemsOf(collapsedSum)} item(s) — a collapsed card is its head and its preview`,
    );
  }
  if (collapsedSum && hasClass(collapsedSum, 'items-loading')) {
    problems.push('a collapsed card that asked for nothing shows the loading strip, which is for an expanded card that waits');
  }

  // (e) The control: FULL's row is the log, its card is expanded, and it must behave exactly
  // as a card did before summaries existed — no request, ever.
  if (itemsOf(cardOf(FULL)) !== LOG_ITEMS) {
    problems.push(
      `a full (non-summary) row rendered ${itemsOf(cardOf(FULL))} item(s) in its expanded card, expected the log's ${LOG_ITEMS}`,
    );
  }
  if (askedOf(FULL).length !== 0) {
    problems.push(
      `a card whose row was not a summary asked for its log (${askedOf(FULL).length} loadNodeItems) — a card that already ` +
        'holds the log must never ask',
    );
  }

  // (b) Expanding it (the view focus moves onto it) renders the summary, asks once and waits
  // visibly: the same strip the replica case above uses, because "the first ask and the last
  // answer" must not read as "the whole turn".
  frame(SUM, [summaryRow(SUM), node(FULL, null, [], { items: LOG })]);
  const openedSum = cardOf(SUM);
  const sumAsks = askedOf(SUM).map((m) => `${m.type}:${m.id}`);
  if (sumAsks.length !== 1 || sumAsks[0] !== `loadNodeItems:${SUM}`) {
    problems.push(
      `expanding a summarised card posted ${JSON.stringify(sumAsks)}, expected exactly one loadNodeItems for ${SUM}`,
    );
  }
  if (itemsOf(openedSum) !== SUMMARY_ITEMS) {
    problems.push(
      `an expanded summarised card rendered ${itemsOf(openedSum)} item(s), expected its ${SUMMARY_ITEMS} summary item — the ` +
        'summary is what the card shows until the log lands',
    );
  }
  if (!openedSum || !hasClass(openedSum, 'items-loading')) {
    problems.push(
      'a summarised card waiting for its log does not show the loading state (`items-loading`) — the summary must not read ' +
        'as the whole turn',
    );
  }

  // (c) The answer replaces the summary (2 items, not 1: `renderNodeItems` clears both zones)
  // and takes the strip with it.
  dispatch({ type: 'nodeItems', id: SUM, items: LOG });
  const answeredSum = cardOf(SUM);
  if (itemsOf(answeredSum) !== LOG_ITEMS) {
    problems.push(
      `a nodeItems answer left ${itemsOf(answeredSum)} item(s) in a summarised card, expected the log's ${LOG_ITEMS} — the ` +
        'answer must replace the summary, not be dropped because the card already had content',
    );
  }
  if (answeredSum && hasClass(answeredSum, 'items-loading')) {
    problems.push('a nodeItems answer left a summarised card claiming its log is on its way');
  }

  // (d) Collapse and re-open: the one-shot ask was already spent, and the log stays — a
  // repaint of a card that has the log must not fall back to the summary it arrived with.
  frame(FULL, [summaryRow(SUM), node(FULL, null, [], { items: LOG })]);
  frame(SUM, [summaryRow(SUM), node(FULL, null, [], { items: LOG })]);
  if (askedOf(SUM).length !== 1) {
    problems.push(
      `re-expanding a fetched summarised card asked again (${askedOf(SUM).length} loadNodeItems) — the one-shot contract ` +
        '(`_itemsRequested`) is the same for a summary',
    );
  }
  if (itemsOf(cardOf(SUM)) !== LOG_ITEMS) {
    problems.push(
      `a repaint of a fetched summarised card left ${itemsOf(cardOf(SUM))} item(s), expected the log's ${LOG_ITEMS}`,
    );
  }
  // Read here, while this fixture's `posted` is still the one that answered it: the two
  // fixtures below reset it, and a note that reported 0 requests would be a note about the
  // reset rather than about the card.
  const sumRequests = askedOf(SUM).length;

  // (f) The local surface: the summary rides the `path` (a session switch renders from it)
  // and the `tree` row that arrives first carries no items at all, so the card already asked
  // (the replica case above). The `path` summary is *content*, not the answer to that
  // request: it renders, the strip stays on, and the request is not posted a second time.
  dispatch({ type: 'reset' });
  posted.length = 0;
  frame(LOCAL, [node(LOCAL, null, [])]);
  if (askedOf(LOCAL).length !== 1) {
    problems.push(
      `a view-focus card with no items row posted ${askedOf(LOCAL).length} loadNodeItems, expected 1 (this fixture needs ` +
        'that request out to see what the path summary does to it)',
    );
  }
  dispatch({ type: 'path', ids: [LOCAL], nodes: [{ id: LOCAL, status: 'done', items: SUMMARY, summary: true }] });
  const localCard = cardOf(LOCAL);
  if (itemsOf(localCard) !== SUMMARY_ITEMS) {
    problems.push(
      `a path row carrying a summary rendered ${itemsOf(localCard)} item(s), expected ${SUMMARY_ITEMS} — a summary is ` +
        'content and renders like any other row',
    );
  }
  if (!localCard || !hasClass(localCard, 'items-loading')) {
    problems.push(
      "a path summary cleared the card's loading state — the log it asked for is still on its way, and a summary is not " +
        'that answer',
    );
  }
  if (askedOf(LOCAL).length !== 1) {
    problems.push(
      `a path summary made the card ask again (${askedOf(LOCAL).length} loadNodeItems) — the request it already has out is ` +
        'the same one',
    );
  }
  dispatch({ type: 'nodeItems', id: LOCAL, items: LOG });
  if (itemsOf(cardOf(LOCAL)) !== LOG_ITEMS || hasClass(cardOf(LOCAL), 'items-loading')) {
    problems.push(
      `the local card did not take the log from its answer (${itemsOf(cardOf(LOCAL))} item(s), ` +
        `loading=${hasClass(cardOf(LOCAL), 'items-loading')})`,
    );
  }
  const localRequests = askedOf(LOCAL).length;

  // (g) A summary that summarises to nothing is still a summary: a whole turn of one `user` item
  // (the ask, which is zone 1 and not an item of the log) leaves `items: []`, and the flag
  // is then the only thing that says the rest is somewhere else. Rendering that empty log and
  // never asking is the "card with nothing in it" symptom of the replica case above.
  dispatch({ type: 'reset' });
  posted.length = 0;
  frame(EMPTY, [node(EMPTY, null, [], { items: [], summary: true, itemCount: LOG.length })]);
  if (askedOf(EMPTY).length !== 1) {
    problems.push(
      `a summarised card whose summary is empty posted ${askedOf(EMPTY).length} loadNodeItems, expected 1 — the flag says ` +
        'the log is elsewhere, and an empty log is not an answer',
    );
  }

  // (h) A *full* row landing next to a rendered summary is the log, and rendering it beats a
  // round trip for items already in hand: this is the one case where a summary is thrown
  // away rather than fetched. Both orders are pinned, because the two rows of one node are
  // built by different callers: the log in the `path` after a summarised `tree`, and the log
  // in the `tree` after a summarised `path` (that one needs `itemsSource` to prefer a real
  // row over the summary the `path` put on the card).
  dispatch({ type: 'reset' });
  posted.length = 0;
  frame(UPG, [node(UPG, null, [], { items: SUMMARY, summary: true, itemCount: LOG.length })]);
  dispatch({ type: 'path', ids: [UPG], nodes: [{ id: UPG, status: 'done', items: LOG }] });
  if (itemsOf(cardOf(UPG)) !== LOG_ITEMS) {
    problems.push(
      `a full path row left the tree row's summary on the card (${itemsOf(cardOf(UPG))} item(s), expected the log's ` +
        `${LOG_ITEMS}) — real items supersede a summary, or the card asks the host for what it already holds`,
    );
  }
  // The other order, on a card that has only ever seen the summary: the `path` summarised it
  // and a later `tree` row carries the log. Nothing but `itemsSource` can prefer that row.
  frame(UPG2, [node(UPG2, null, [], { items: SUMMARY, summary: true, itemCount: LOG.length })]);
  dispatch({ type: 'path', ids: [UPG2], nodes: [{ id: UPG2, status: 'done', items: SUMMARY, summary: true }] });
  if (!hasClass(cardOf(UPG2), 'items-loading')) {
    problems.push(
      'the path-summarised upgrade fixture has no waiting card, so it cannot see what a full tree row does to a summary',
    );
  }
  frame(UPG2, [node(UPG2, null, [], { items: LOG })]);
  if (itemsOf(cardOf(UPG2)) !== LOG_ITEMS) {
    problems.push(
      `a full tree row left the path row's summary on the card (${itemsOf(cardOf(UPG2))} item(s), expected the log's ` +
        `${LOG_ITEMS}) — the same rule from the other side, decided by ` +
        '`itemsSource` preferring a real row over a summary',
    );
  }

  // (i) The turn's own stream is the log. The card is created by the turn's `tree`, the
  // deltas are appended into it, and the next repaint describes the same node as finished and
  // summarised — which must not rebuild the card from the two-item summary nor ask the host
  // for items that are already on screen. The ask zone (zone 1, which only a rendered `user`
  // item fills) is what says whether a render happened at all.
  dispatch({ type: 'reset' });
  posted.length = 0;
  // The host marks the node as running while it streams (`setBusy(true)` posts `state`), and
  // that is the gate which keeps a live card from being asked for a snapshot of the items it is
  // still appending to.
  dispatch({ type: 'state', busy: true, status: '', runningNodes: [LIVE] });
  frame(LIVE, [node(LIVE, null, [], { status: 'running' })]);
  dispatch({ type: 'delta', nodeId: LIVE, text: '流式的一' });
  dispatch({ type: 'delta', nodeId: LIVE, text: '流式的二' });
  dispatch({ type: 'done', nodeId: LIVE });
  frame(LIVE, [summaryRow(LIVE)]);
  const liveCard = cardOf(LIVE);
  const liveAsk = liveCard ? findByClass(liveCard, 'node-ask') : null;
  if (askedOf(LIVE).length !== 0) {
    problems.push(
      `a card the turn streamed into asked for its log (${askedOf(LIVE).length} loadNodeItems) — its items are the ones the ` +
        'stream wrote, so a summary row must not send it after what it already has',
    );
  }
  if (!liveAsk || liveAsk.children.length !== 0) {
    problems.push(
      'a repaint rebuilt a streamed card from the row\'s summary (its `.node-ask` is not empty) — a repaint must not wipe a ' +
        'log the node\'s own stream wrote (`_itemsRendered` is set where that append lands)',
    );
  }
  if (liveCard && hasClass(liveCard, 'items-loading')) {
    problems.push('a streamed card claims its log is on its way after a summary row arrived — there is nothing left to fetch');
  }
  if (itemsOf(liveCard) !== 1) {
    problems.push(
      `a repaint left ${itemsOf(liveCard)} element(s) in a streamed card, expected the turn's one streamed answer — the ` +
        'summary must not stand in for it',
    );
  }

  notes.push(
    `summarised cards: collapsed = no ask, expanded = 1 loadNodeItems + the strip, the answer replaces the summary ` +
      `(${sumRequests} request(s) for the re-expanded card, ${localRequests} for the local path shape)`,
  );
}

// --- A repaint's sidecar burst is capped, and a long transcript is windowed -----
// A cold repaint re-expands every sidecar card of a session at once. Firing all of
// their `loadAgentItems` requests in the same burst asked one measured session for
// 15 transcripts at once (~5.35 M chars, 2692 DOM nodes, handlers stuck at 900 ms),
// so the requests are queued behind `ITEMS_CONCURRENCY` (one budget for every on-demand
// items request, see the per-node fetch block above) and an answer releases the next slot.
// And a *finished* card with a long transcript renders a window
// instead of every item — the tail is what a finished card opens on, so the newest
// items must be the rendered ones.
{
  const ROOT = 'burst-root';
  const SUBS = ['burst-a', 'burst-b', 'burst-c', 'burst-d'];
  const node = (id, parentId, children, extra) => Object.assign(
    { id, parentId, children, title: id, status: 'done', createdAt: 0, preview: id, usage: null, size: null },
    extra || {},
  );
  const cardOf = (id) => {
    for (const child of elementById('tree-canvas').children) {
      if (child.dataset && child.dataset.id === id) return child;
    }
    return null;
  };

  dispatch({ type: 'reset' });
  posted.length = 0;
  dispatch({
    type: 'tree',
    viewId: ROOT,
    activeId: null,
    rootId: ROOT,
    // Four sidecar children of the view focus: all four cards are expanded.
    nodes: [node(ROOT, null, SUBS), ...SUBS.map((id) => node(id, ROOT, [], { kind: 'agent', agentStatus: 'done', itemCount: 2 }))],
  });
  dispatch({ type: 'path', ids: [ROOT], nodes: [{ id: ROOT, status: 'done', items: [] }] });
  // The webview's cap, restated here on purpose: a change to it must be a deliberate
  // change to this guard, not a silent one. It counts **every** on-demand items request,
  // whichever type: `loadNodeItems` (a regular card whose items never arrived at all —
  // see the per-node fetch block above) shares the one in-flight budget with
  // `loadAgentItems`, because what the cap bounds is how many transcripts land in one
  // frame, not which kind they are. The view focus (`ROOT`) asks too in this fixture, and
  // that is the sandbox's doing: its `IntersectionObserver` answers `observe()`
  // synchronously, while a real window delivers the callback a frame later — by then the
  // `path` above has filled the card and the queue drops the request unposted.
  const ITEM_REQUESTS = ['loadAgentItems', 'loadNodeItems'];
  const burstAsked = posted.filter((m) => m && ITEM_REQUESTS.indexOf(m.type) >= 0);
  const CONCURRENCY = 3;
  if (burstAsked.length !== CONCURRENCY) {
    problems.push(
      `a repaint burst posted ${burstAsked.length} items request(s), expected ${CONCURRENCY} ` +
        '(the in-flight cap; the rest must queue)',
    );
  }
  if (burstAsked.some((m) => SUBS.indexOf(m.id) < 0 && m.id !== ROOT)) {
    problems.push(`a burst request named a node this fixture does not have: ${JSON.stringify(burstAsked)}`);
  }
  // One answer frees one slot: the queued card must be asked for right after it.
  const firstAgent = burstAsked.find((m) => m.type === 'loadAgentItems');
  if (!firstAgent) {
    problems.push(`a sidecar burst posted no loadAgentItems request at all: ${JSON.stringify(burstAsked)}`);
  } else {
    dispatch({ type: 'agentItems', id: firstAgent.id, items: [{ kind: 'assistant', text: 'ans' }] });
  }
  const afterAnswer = posted.filter((m) => m && ITEM_REQUESTS.indexOf(m.type) >= 0);
  if (afterAnswer.length !== CONCURRENCY + 1) {
    problems.push(
      `an agentItems answer left the burst at ${afterAnswer.length} request(s), expected ${CONCURRENCY + 1} ` +
        '(one slot released, the queued card promoted)',
    );
  }

  // A finished node with more than 60 *work* items renders a window whose items are
  // the newest ones (`_needsBottomScroll` opens a finished card at its newest
  // content). The window is the work list only: the trailing answer run is lifted
  // out into zone 3 and is never paginated, so the fixture needs work items that are
  // NOT answers — 61 tool calls, then the answer.
  const LONG = 'burst-long';
  const LONG_WORK = 61;
  const items = [];
  for (let i = 0; i < LONG_WORK; i++) {
    items.push({ kind: 'tool', name: 'read_file', args: '{"path":"long-' + i + '"}', id: 'long-tool-' + i });
  }
  items.push({ kind: 'assistant', text: 'the final answer' });
  dispatch({ type: 'reset' });
  dispatch({
    type: 'tree',
    viewId: LONG,
    activeId: LONG,
    rootId: LONG,
    nodes: [node(LONG, null, [])],
  });
  dispatch({ type: 'path', ids: [LONG], nodes: [{ id: LONG, status: 'done', items }] });
  const longCard = cardOf(LONG);
  const longItems = longCard ? findByClass(longCard, 'node-work') : null;
  const longAnswer = longCard ? findByClass(longCard, 'node-answer') : null;
  if (!longItems) {
    problems.push('the long-transcript fixture produced no `.node-work` container');
  } else {
    const rendered = longItems.children.length;
    // 24 rendered items + at most two spacers (above/below).
    if (rendered > 26) {
      problems.push(`a 61-item finished card rendered ${rendered} element(s) in one go — it must window the list`);
    }
    if (!findByClass(longCard, 'node-items-spacer')) {
      problems.push('a windowed transcript has no spacer standing in for the items outside the window');
    }
    // The numbers are read off the spacers rather than the item text: the sandbox
    // DOM does not aggregate `textContent`, and "how many items are above/below the
    // window" is exactly what says *which* slice was rendered. A finished card opens
    // at its newest content, so 61 work items must render the last 24 with 37 above
    // and nothing below.
    const spacers = Array.prototype.slice
      .call(longItems.children)
      .filter((child) => (child.className || '').indexOf('node-items-spacer') >= 0);
    const above = spacers.find((child) => (child.className || '').indexOf('above') >= 0);
    const below = spacers.find((child) => (child.className || '').indexOf('below') >= 0);
    const aboveCount = above && above.dataset ? Number(above.dataset.items) : null;
    if (aboveCount !== LONG_WORK - 24) {
      problems.push(
        `a windowed 61-item card reports ${aboveCount} item(s) above the window, expected 37 ` +
          '(the window must be the newest page, because a finished card opens at its newest content)',
      );
    }
    if (below) {
      problems.push('a windowed card shows a spacer below its newest page — there is nothing newer to stand in for');
    }

    // --- (j) the answer is promoted out of the window, and the dots --------------
    // A windowed fixture is also the one card whose lock-dot set is unambiguous (no
    // thinking block in it: those carry a dot of their own, on their own box).
    const dotsIn = (element) => {
      let n = 0;
      for (const child of (element && element.children) || []) {
        if (child.classList && child.classList.contains('scroll-lock-dot')) n++;
        n += dotsIn(child);
      }
      return n;
    };
    const answerKids = longAnswer ? longAnswer.children : [];
    if (answerKids.length !== 1 || (answerKids[0].dataset || {}).kind !== 'assistant') {
      problems.push(
        `the windowed fixture's final answer is ${answerKids.length} element(s) in .node-answer, expected the one ` +
          'assistant item (the tail of the log is zone 3, not a windowed page)',
      );
    }
    const assistantsInWork = longItems.children.filter((child) => (child.dataset || {}).kind === 'assistant');
    if (assistantsInWork.length !== 0) {
      problems.push(
        `the window covers ${assistantsInWork.length} answer element(s) — the answer run is never windowed ` +
          '(and it is moved out, not left behind)',
      );
    }
    if (dotsIn(longCard) !== 1) {
      problems.push(`a card showing an answer carries ${dotsIn(longCard)} green .scroll-lock-dot(s), expected exactly 1`);
    }
    if (dotsIn(findByClass(longCard, 'node-work-wrap')) !== 1) {
      problems.push('the green .scroll-lock-dot is not in .node-work-wrap (the log is the scroller that follows a turn)');
    }
    if (dotsIn(longAnswer) !== 0) {
      problems.push('zone 3 carries a green .scroll-lock-dot — it opens at the top and is read, not followed');
    }

    // --- (k) scrolling the window must not give the answer back -------------------
    // `paintItemsWindow` is the one repaint of zone 2 that does not go through
    // `renderNodeItems`, and it rebuilds every element it paints — the answer, moved
    // out of the log, has to survive it. A repaint is not an append. The window's own
    // scroll handler is rAF-throttled, so this check runs one task later (the same
    // reason the perf probes at the bottom of this file are deferred).
    const scroll = longItems._listeners && longItems._listeners.scroll;
    if (typeof scroll !== 'function') {
      problems.push('a windowed log has no scroll handler — the window could never extend');
    } else {
      longItems.scrollTop = 0; // at the top edge, so the window extends upward
      scroll();
      setTimeout(() => {
        const answer = findByClass(longCard, 'node-answer');
        const work = findByClass(longCard, 'node-work');
        // The repaint really happened: the window grew upward by one page, so the
        // spacer above it now stands in for 37 - 24 items.
        const topSpacer = work
          ? work.children.find((child) => (child.className || '').indexOf('node-items-spacer') >= 0)
          : null;
        const topCount = topSpacer && topSpacer.dataset ? Number(topSpacer.dataset.items) : null;
        if (topCount !== LONG_WORK - 24 - 24) {
          problems.push(
            `scrolling a windowed log left ${topCount} item(s) above the window, expected ${LONG_WORK - 24 - 24} ` +
              '(the window did not extend, so this check cannot see the repaint at all)',
          );
        }
        if (!answer || answer.children.length !== 1) {
          problems.push(
            'scrolling a windowed log demoted the promoted answer (zone 3 holds ' +
              `${answer ? answer.children.length : 'no'} element(s) after the repaint — a repaint is not an append)`,
          );
        }
        if (work && work.children.some((child) => (child.dataset || {}).kind === 'assistant')) {
          problems.push('scrolling a windowed log put the answer back into .node-work');
        }
        if (longCard && !longCard.classList.contains('has-answer')) {
          problems.push('scrolling a windowed log dropped the card\'s `has-answer`');
        }
      }, 30);
    }
  }
}

// --- The ▶ Continue / ↻ Retry / ⧉ rollover button -------------------------------
// A turn that ended without an answer — interrupted by the user, or failed on an
// API error that outlived the client's retries — offers a button that asks the
// harness to run a turn from that node with a message the harness writes itself,
// so the user never has to type "continue". It may only appear where continuing
// makes sense, and it must post the node it belongs to. One failure is special: a
// provider context-length error (the host ships `context: 'full'`, contract §3/§4) is
// not retryable, so the button is *replaced* by the rollover variant, which posts
// `rolloverTurn`. A window that is merely *near* full (>= 90%) is not a refusal,
// though: there the retry stays and the `⧉` entry stands *beside* it, on its own
// `.node-window` element, so an entry with no other way in is never hidden behind a
// repair. The same fixture carries a window-starting node, whose card wears
// the `CTX` badge and whose own connector — not its descendants' — is dashed.
{
  const R = 'cont-node-root';
  const A = 'cont-node-a';       // interrupted tip → ▶ Continue
  const B = 'cont-node-b';       // failed tip → ↻ Retry
  const C = 'cont-node-c';       // interrupted, but already continued → no button
  const D = 'cont-node-d';       // the continuation of C (done)
  const F = 'cont-node-f';       // failed on a full context window → ⧉ rollover
  const G = 'cont-node-g';       // interrupted *and* context 'full' → still ▶ Continue
  const NEAR = 'cont-node-near'; // interrupted at 93% → the ⧉ *suggestion* (node-near)
  const ERR_NEAR = 'cont-node-error-near'; // *failed* at 92% → ↻ Retry *and* the ⧉ beside it
  const DONE_NEAR = 'cont-node-done-near'; // *finished* at 91% → the suggestion too
  const DONE_OK = 'cont-node-done-ok';     // finished with room left → no button at all
  const DONE_FULL = 'cont-node-done-full'; // finished, state 'full' → still nothing (full needs an error)
  const SUB = 'cont-node-sub';   // `kind:'agent'` sidecar, interrupted → no button
  const WIN = 'cont-node-win';   // starts a context window → CTX badge + dashed edge
  const WIN2 = 'cont-node-win2'; // a descendant of WIN → neither of the two
  const node = (id, parentId, children, status, kind, extra) =>
    Object.assign(
      {
        id,
        parentId,
        children,
        title: id,
        status,
        createdAt: 0,
        preview: id,
        usage: null,
        size: null,
      },
      kind ? { kind } : {},
      extra || {},
    );
  const tree = (aStatus) => ({
    type: 'tree',
    viewId: B,
    activeId: null,
    rootId: R,
    rootIds: [R],
    nodes: [
      node(R, null, [A, B, C, F, G, NEAR, ERR_NEAR, DONE_NEAR, DONE_OK, DONE_FULL, SUB, WIN], 'done'),
      node(A, R, [], aStatus),
      node(B, R, [], 'error'),
      node(C, R, [D], 'interrupted'),
      node(D, C, [], 'done'),
      // `context` arrives on every node (the host computes it once, §4.3): only a
      // turn that died on the provider's context-length error carries `full`.
      node(F, R, [], 'error', undefined, { context: 'full' }),
      // The state alone must not roll anything over — `interrupted` keeps ▶ Continue.
      node(G, R, [], 'interrupted', undefined, { context: 'full' }),
      // At (or above) 90% the same ⧉ entry is offered as a *suggestion*: the label
      // is the rollover one, the class and the percentage-carrying tooltip are not.
      node(NEAR, R, [], 'interrupted', undefined, { context: 'near', contextPct: 93 }),
      // A *failed* tip at 92% is not a refusal either — nothing about the request was
      // rejected — so the repair stays and the `⧉` entry stands beside it instead of
      // replacing it (`.node-window`).
      node(ERR_NEAR, R, [], 'error', undefined, { context: 'near', contextPct: 92 }),
      // The suggestion does not depend on the status: a *finished* tip above 90% is
      // exactly the case it is for (the next send would hit the wall), so it shows
      // there too — while a finished tip with room left stays empty-handed.
      node(DONE_NEAR, R, [], 'done', undefined, { context: 'near', contextPct: 91 }),
      node(DONE_OK, R, [], 'done', undefined, { context: 'ok' }),
      // `full` is a *failure* mode (the provider refused the request), so it keeps
      // the error gate: the state alone, on a finished tip, is not an entry.
      node(DONE_FULL, R, [], 'done', undefined, { context: 'full' }),
      node(SUB, R, [], 'interrupted', 'agent'),
      // A window-starting node carries `contextBaseId` (equal to its own id, §2):
      // only *it* may be badged / joined by the dashed edge, its child may not.
      node(WIN, R, [WIN2], 'done', undefined, { contextBaseId: WIN }),
      node(WIN2, WIN, [], 'done'),
    ],
  });
  const cards = new Map();
  const refresh = () => {
    cards.clear();
    for (const child of elementById('tree-canvas').children) {
      if (child.dataset && child.dataset.id) cards.set(child.dataset.id, child);
    }
  };
  const buttonOf = (id) => {
    const card = cards.get(id);
    return card ? findByClass(card, 'node-continue') : null;
  };

  dispatch(tree('interrupted'));
  refresh();

  if (!buttonOf(A) || buttonOf(A).textContent !== '▶ Continue') {
    problems.push('an interrupted tip node shows no ▶ Continue button');
  }
  if (!buttonOf(B) || buttonOf(B).textContent !== '↻ Retry') {
    problems.push('a node whose turn failed shows no ↻ Retry button');
  }
  if (buttonOf(C)) {
    problems.push('a node that was already continued still shows a Continue button (the continuation owns it now)');
  }
  if (buttonOf(SUB)) {
    problems.push('a sub-agent sidecar card offers a Continue button (it has no conversation of its own here)');
  }
  // A run on the node hides it again.
  dispatch({ type: 'state', busy: true, status: '', sessionId: 'smoke-session', runningNodes: [A] });
  dispatch(tree('running'));
  refresh();
  if (buttonOf(A)) {
    problems.push('a node that is streaming again still shows a Continue button');
  }

  // A turn that ends *after* the tree was drawn arrives as `nodeUpdate` (that is
  // how `finishTurn` patches its card), so the button has to follow it too.
  dispatch({ type: 'state', busy: false, status: '', sessionId: 'smoke-session', runningNodes: [] });
  dispatch(tree('done'));
  refresh();
  if (buttonOf(A)) {
    problems.push('a finished turn node shows a Continue button');
  }
  dispatch({ type: 'nodeUpdate', id: A, status: 'error', title: A, usage: null });
  if (!buttonOf(A) || buttonOf(A).textContent !== '↻ Retry') {
    problems.push('a turn that failed after the tree was drawn shows no ↻ Retry button');
  }

  // The harness message is written into *that* node's transcript as an inline
  // block (never into the pinned prompt, and never as a bubble the user appears to
  // have typed) — an in-place continue must not move the view focus.
  dispatch({ type: 'harnessNote', nodeId: A, text: 'Continue from where you stopped.' });
  const harnessBlock = findByClass(cards.get(A), 'harness-note');
  if (!harnessBlock) {
    problems.push('a harness continue message is not rendered in the continued node');
  } else if (!findByClass(harnessBlock, 'harness-badge')) {
    problems.push('a harness continue message carries no HARNESS badge');
  }
  if (findByClass(cards.get(A), 'node-ask') && findByClass(findByClass(cards.get(A), 'node-ask'), 'harness-note')) {
    problems.push('a harness continue message overwrote the node\'s pinned user prompt (zone 1, .node-ask)');
  }
  if (findByClass(cards.get(B), 'harness-note')) {
    problems.push('a harness continue message for another node leaked into a different card');
  }

  // Clicking the button must ask the host to continue *that* node.
  const retry = buttonOf(B);
  const clickOf = retry && retry._listeners && retry._listeners.click;
  if (typeof clickOf !== 'function') {
    problems.push('the Retry button has no click handler');
  } else {
    posted.length = 0;
    clickOf({ stopPropagation() {} });
    const sent = posted.find((message) => message && message.type === 'continueTurn');
    if (!sent || sent.id !== B) {
      problems.push(
        `clicking Retry posted ${JSON.stringify(posted)}, expected { type: 'continueTurn', id: '${B}' }`,
      );
    }
  }

  // --- the rollover variant (contract §4) --------------------------------------
  // A turn that died because the provider refused an oversized request cannot be
  // retried: the *same* request is guaranteed to fail again. So the button is
  // replaced by the rollover one — the user's click is what opens the new window.
  const ROLLOVER_TOOLTIP =
    'Ask the harness to continue this turn in a new, empty context window (the current one is full)';
  dispatch(tree('interrupted'));
  refresh();

  const rollover = buttonOf(F);
  if (!rollover || rollover.textContent !== '⧉ Continue in a new window') {
    problems.push(
      'a node whose turn died on a full context window (error + context "full") shows no `⧉ Continue in a new window` button',
    );
  } else {
    if (!hasClass(rollover, 'node-rollover')) {
      problems.push('the rollover button does not carry the `node-rollover` class the styling and the guard read');
    }
    if (hasClass(rollover, 'node-near')) {
      problems.push('a *full* window is marked as the `near` suggestion — only the 90% entry carries `node-near`');
    }
    if (rollover.dataset.action !== 'rollover') {
      problems.push(
        `the rollover button carries data-action=${JSON.stringify(rollover.dataset.action)}, expected 'rollover'`,
      );
    }
    if (rollover.title !== ROLLOVER_TOOLTIP) {
      problems.push(
        `the rollover button's tooltip is ${JSON.stringify(rollover.title)}, expected ${JSON.stringify(ROLLOVER_TOOLTIP)}`,
      );
    }
  }
  // Retry is *replaced*, not offered beside it — and a plain failure is untouched.
  if (!buttonOf(B) || buttonOf(B).textContent !== '↻ Retry' || buttonOf(B).dataset.action !== 'retry') {
    problems.push('a node whose turn failed for any other reason no longer shows ↻ Retry (data-action="retry")');
  }

  const rolloverClick = rollover && rollover._listeners && rollover._listeners.click;
  if (typeof rolloverClick !== 'function') {
    problems.push('the rollover button has no click handler');
  } else {
    posted.length = 0;
    rolloverClick({ stopPropagation() {} });
    const sent = posted.find((message) => message && message.type === 'rolloverTurn');
    if (!sent || sent.id !== F) {
      problems.push(
        `clicking the rollover button posted ${JSON.stringify(posted)}, expected { type: 'rolloverTurn', id: '${F}' }`,
      );
    }
    if (posted.some((message) => message && message.type === 'continueTurn')) {
      problems.push('the rollover button also posted continueTurn — the retried request is the oversized one');
    }
  }

  // --- the `near` suggestion (contract §3) --------------------------------------
  // A window at (or above) 90% gets the same `⧉` entry, but as a *suggestion*: the
  // `node-near` class softens it and the tooltip carries the percentage the host
  // sent as `contextPct`. Nothing is forced — this node can still be continued in
  // place, it is the user who decides.
  const NEAR_TOOLTIP = 'Context is 93% full - continue in a new window';
  const near = buttonOf(NEAR);
  if (!near || near.textContent !== '⧉ Continue in a new window') {
    problems.push(
      'a node whose window is 93% full shows no `⧉ Continue in a new window` suggestion (context: "near")',
    );
  } else {
    if (!hasClass(near, 'node-near')) {
      problems.push('the near-full suggestion does not carry the `node-near` class');
    }
    if (near.dataset.action !== 'rollover') {
      problems.push(
        `the near-full suggestion carries data-action=${JSON.stringify(near.dataset.action)}, expected 'rollover'`,
      );
    }
    if (near.title !== NEAR_TOOLTIP) {
      problems.push(
        `the near-full suggestion's tooltip is ${JSON.stringify(near.title)}, expected ${JSON.stringify(NEAR_TOOLTIP)} ` +
          '(the host sends the percentage as `contextPct` and the title carries it)',
      );
    }
    const nearClick = near._listeners && near._listeners.click;
    if (typeof nearClick !== 'function') {
      problems.push('the near-full suggestion has no click handler');
    } else {
      posted.length = 0;
      nearClick({ stopPropagation() {} });
      const sent = posted.find((message) => message && message.type === 'rolloverTurn');
      if (!sent || sent.id !== NEAR) {
        problems.push(
          `clicking the suggestion posted ${JSON.stringify(posted)}, expected { type: 'rolloverTurn', id: '${NEAR}' }`,
        );
      }
    }
  }
  // The suggestion is the *only* thing the `near` state adds where nothing failed: a
  // plain interrupted tip keeps ▶ Continue, and such a tip keeps the single `⧉` entry
  // (only a *failed* tip at 90%+ puts a retry beside it).
  if (!buttonOf(A) || buttonOf(A).textContent !== '▶ Continue') {
    problems.push('a node with an `ok` window no longer shows ▶ Continue while a sibling is `near`');
  }

  // --- a failure at 90%+: the repair *and* the suggestion (contract §3/§4) -------
  // `near` is a size, not a refusal: the request was not rejected, so `↻ Retry` is a
  // real repair and stays — and because the `⧉` entry has no other way in, the retry
  // must not hide it either. Two elements, one meaning each.
  const altOf = (id) => {
    const card = cards.get(id);
    return card ? findByClass(card, 'node-window') : null;
  };
  const errNear = buttonOf(ERR_NEAR);
  if (!errNear || errNear.textContent !== '↻ Retry' || errNear.dataset.action !== 'retry') {
    problems.push(
      'a node whose turn failed at 92% shows no ↻ Retry (a near-full window is not a refusal, so the repair stays)',
    );
  } else {
    if (hasClass(errNear, 'node-rollover')) {
      problems.push('the ↻ Retry of a failed node at 92% carries the rollover class (it is the repair, not the rollover)');
    }
    if (hasClass(errNear, 'node-near')) {
      problems.push('the ↻ Retry of a failed node at 92% is marked as the `near` suggestion itself');
    }
  }
  const besideEntry = altOf(ERR_NEAR);
  if (!besideEntry || besideEntry.textContent !== '⧉ Continue in a new window') {
    problems.push('a failed node at 92% shows no second `⧉ Continue in a new window` entry beside ↻ Retry');
  } else {
    if (!hasClass(besideEntry, 'node-rollover')) {
      problems.push('the `⧉` entry beside a repair carries no `node-rollover` class (the styling and the guard read it)');
    }
    if (!hasClass(besideEntry, 'node-near')) {
      problems.push('the `⧉` entry beside a repair carries no `node-near` class (it is the 90% suggestion)');
    }
    if (besideEntry.dataset.action !== 'rollover') {
      problems.push(
        `the \`⧉\` entry beside a repair carries data-action=${JSON.stringify(besideEntry.dataset.action)}, expected 'rollover'`,
      );
    }
    if (besideEntry.title !== 'Context is 92% full - continue in a new window') {
      problems.push(
        `the \`⧉\` entry beside a repair has the tooltip ${JSON.stringify(besideEntry.title)}, expected its own percentage`,
      );
    }
    const besideClick = besideEntry._listeners && besideEntry._listeners.click;
    if (typeof besideClick !== 'function') {
      problems.push('the `⧉` entry beside a repair has no click handler');
    } else {
      posted.length = 0;
      besideClick({ stopPropagation() {} });
      const sent = posted.find((message) => message && message.type === 'rolloverTurn');
      if (!sent || sent.id !== ERR_NEAR) {
        problems.push(
          `clicking the beside entry posted ${JSON.stringify(posted)}, expected { type: 'rolloverTurn', id: '${ERR_NEAR}' }`,
        );
      }
      if (posted.some((message) => message && message.type === 'continueTurn')) {
        problems.push('the beside entry also posted continueTurn — the two entries must not share an action');
      }
    }
  }
  // The retry beside it still continues *that* node.
  const errNearClick = errNear && errNear._listeners && errNear._listeners.click;
  if (typeof errNearClick !== 'function') {
    problems.push('the ↻ Retry of a failed node at 92% has no click handler');
  } else {
    posted.length = 0;
    errNearClick({ stopPropagation() {} });
    const sent = posted.find((message) => message && message.type === 'continueTurn');
    if (!sent || sent.id !== ERR_NEAR) {
      problems.push(
        `clicking ↻ Retry at 92% posted ${JSON.stringify(posted)}, expected { type: 'continueTurn', id: '${ERR_NEAR}' }`,
      );
    }
  }
  // Only a *failure* at 90%+ carries two entries: a refusal (`full`), a failure with
  // room left, and a tip that did not fail each keep exactly one.
  for (const [entryId, why] of [
    [F, 'a `full` window (there the rollover replaces the retry)'],
    [B, 'a failure with room left'],
    [NEAR, 'a tip at 93% that did not fail'],
    [DONE_NEAR, 'a finished tip at 91%'],
  ]) {
    if (altOf(entryId)) {
      problems.push(`a second entry appeared for ${why} — only a *failure* at 90%+ carries two`);
    }
  }

  // --- the `near` suggestion on a *finished* tip -------------------------------
  // The entry is a suggestion about the *next* send, so it must not depend on the
  // status: the common case is a long conversation that just answered (>= 90%), where
  // the next message would hit the wall. A finished tip with room left stays empty,
  // and a finished tip whose window is `full` is not an entry either — a provider
  // refusal is an error, and that gate stays where it is.
  const doneNear = buttonOf(DONE_NEAR);
  if (!doneNear || doneNear.textContent !== '⧉ Continue in a new window') {
    problems.push(
      'a *finished* node at 91% shows no `⧉ Continue in a new window` suggestion ' +
        '(the 90% entry must not depend on the status: a done tip is the common case)',
    );
  } else {
    if (!hasClass(doneNear, 'node-near')) {
      problems.push('the finished node\'s near-full suggestion does not carry the `node-near` class');
    }
    if (doneNear.dataset.action !== 'rollover') {
      problems.push(
        `the finished node's suggestion carries data-action=${JSON.stringify(doneNear.dataset.action)}, expected 'rollover'`,
      );
    }
    if (doneNear.title !== 'Context is 91% full - continue in a new window') {
      problems.push(
        `the finished node's suggestion tooltip is ${JSON.stringify(doneNear.title)}, expected its own percentage`,
      );
    }
  }
  if (buttonOf(DONE_OK)) {
    problems.push('a finished node whose window has room left shows a Continue button (there is nothing to continue)');
  }
  if (buttonOf(DONE_FULL)) {
    problems.push(
      'a finished node carrying context "full" shows the ⧉ entry — `full` is a provider *refusal* (an error), ' +
        'so it keeps its error gate',
    );
  }
  notes.push('context states: full (hard ⧉, replaces retry), near (suggestion; beside ↻ Retry when the tip failed), ok (▶ / ↻, done = none)');

  // The judgement is made by the host and can arrive *after* the tree was drawn
  // (that is exactly how a turn dies on a context-length error), so a `nodeUpdate`
  // has to carry the state and re-sync the button on the card it already shows.
  dispatch({ type: 'nodeUpdate', id: B, status: 'error', title: B, context: 'full' });
  const switched = buttonOf(B);
  if (
    !switched ||
    switched.textContent !== '⧉ Continue in a new window' ||
    !hasClass(switched, 'node-rollover') ||
    hasClass(switched, 'node-near') ||
    switched.dataset.action !== 'rollover'
  ) {
    problems.push('a `nodeUpdate` carrying context: "full" did not switch a ↻ Retry card to the rollover button');
  } else {
    if (altOf(B)) {
      problems.push('a `full` window left the second entry on the card (there the rollover replaces the retry)');
    }
    posted.length = 0;
    if (typeof switched._listeners?.click === 'function') switched._listeners.click({ stopPropagation() {} });
    const sent = posted.find((message) => message && message.type === 'rolloverTurn');
    if (!sent || sent.id !== B) {
      problems.push(
        `after the state arrived by \`nodeUpdate\`, clicking posted ${JSON.stringify(posted)}, expected { type: 'rolloverTurn', id: '${B}' }`,
      );
    }
  }
  // A patch that carries a failure at 90%+ adds the *second* entry: the repair stays,
  // and the suggestion's tooltip has to carry the percentage the patch brought, or the
  // title would lie.
  dispatch({ type: 'nodeUpdate', id: B, status: 'error', title: B, context: 'near', contextPct: 95 });
  const suggested = buttonOf(B);
  if (
    !suggested ||
    suggested.textContent !== '↻ Retry' ||
    hasClass(suggested, 'node-rollover') ||
    hasClass(suggested, 'node-near') ||
    suggested.dataset.action !== 'retry'
  ) {
    problems.push(
      `a \`nodeUpdate\` carrying context: "near" and contextPct: 95 produced ` +
        `${JSON.stringify(suggested && { text: suggested.textContent, title: suggested.title })}`,
    );
  }
  const suggestedWindow = altOf(B);
  if (
    !suggestedWindow ||
    suggestedWindow.textContent !== '⧉ Continue in a new window' ||
    !hasClass(suggestedWindow, 'node-near') ||
    suggestedWindow.dataset.action !== 'rollover' ||
    suggestedWindow.title !== 'Context is 95% full - continue in a new window'
  ) {
    problems.push(
      'a `nodeUpdate` carrying context: "near" and contextPct: 95 did not add the second ' +
        `entry with the patch's percentage: ${JSON.stringify(suggestedWindow && { text: suggestedWindow.textContent, title: suggestedWindow.title })}`,
    );
  }
  // And the state is not sticky: a later patch that clears it goes back to Retry.
  dispatch({ type: 'nodeUpdate', id: B, status: 'error', title: B, context: 'ok' });
  const back = buttonOf(B);
  if (
    !back ||
    back.textContent !== '↻ Retry' ||
    hasClass(back, 'node-rollover') ||
    hasClass(back, 'node-near') ||
    back.dataset.action !== 'retry'
  ) {
    problems.push('a `nodeUpdate` with context: "ok" did not switch the card back to ↻ Retry');
  }
  if (altOf(B)) {
    problems.push('a `nodeUpdate` with context: "ok" left the second entry on the card');
  }

  // A full window is only a *failure* mode: an interrupted node keeps ▶ Continue
  // even when the host's state says the window is full (there is no refused request
  // to roll over — the 90% suggestion is the one that follows the state alone).
  const interruptedFlagged = buttonOf(G);
  if (!interruptedFlagged || interruptedFlagged.textContent !== '▶ Continue') {
    problems.push('an interrupted node carrying context: "full" no longer shows ▶ Continue (only a failed turn rolls over)');
  }

  // --- the CTX badge and the dashed edge (contract §5) --------------------------
  // The two marks of a window break: the badge on the node that *starts* a window,
  // and the dashed connector under it. Both belong to that node alone — a
  // descendant of a window-starting node is an ordinary turn again.
  const winCard = cards.get(WIN);
  const winBadge = winCard ? findByClass(winCard, 'node-ctx-badge') : null;
  if (!winBadge || winBadge.textContent !== 'CTX') {
    problems.push('a node carrying contextBaseId shows no CTX badge on its card');
  }
  if (cards.get(WIN2) && findByClass(cards.get(WIN2), 'node-ctx-badge')) {
    problems.push('a CTX badge appeared on a descendant of the window-starting node (only the node that starts a window is badged)');
  }
  // `drawEdges()` writes the SVG as one markup string (`treeEdges.innerHTML = …`),
  // so the paths are read back out of it instead of the stub holding elements. A
  // turn connector ends at its own child (`… C mx py, mx cy, childMidX cy`), which
  // is what ties a path to a node — and the stub reports no card width, so that
  // endpoint is the child card's own top-left corner.
  const edgeOf = (id) => {
    const card = cards.get(id);
    if (!card) return null;
    const endX = parseFloat(card.style.left);
    const endY = parseFloat(card.style.top);
    const markup = String(elementById('tree-edges').innerHTML || '');
    return (
      (markup.match(/<path[^>]*>/g) || []).find((tag) => {
        const end = /([-\d.]+) ([-\d.]+)"\s*\/>$/.exec(tag);
        return end && parseFloat(end[1]) === endX && parseFloat(end[2]) === endY;
      }) || null
    );
  };
  const winEdge = edgeOf(WIN);
  const win2Edge = edgeOf(WIN2);
  if (!winEdge) {
    problems.push('no connector path could be found for the window-starting node (the edges are not drawn at all)');
  } else if (!/\bclass="edge-context"/.test(winEdge)) {
    problems.push(`the window-starting node's connector is not dashed: ${winEdge}`);
  }
  if (!win2Edge) {
    problems.push('no connector path could be found for a descendant of the window-starting node');
  } else if (/edge-context/.test(win2Edge)) {
    problems.push(`a descendant of the window-starting node got a dashed connector too: ${win2Edge}`);
  }
}

// --- The node header's context menu (copy the node id) ------------------------
// The header is the one strip on a card whose own menu the host cannot draw
// (`user-select: none`, and webview content cannot add entries to VS Code's menu),
// so the webview draws it. What is checked here: RMB on the header opens the menu
// for *that* node, the entry posts the node's id to the host (the host owns the
// clipboard), the menu closes after the click, and it is gone once the tree is
// rebuilt for a different session (a menu that outlived its node would copy the id
// of a node the session no longer has).
{
  const NODE = 'menu-node';
  dispatch({ type: 'reset' });
  dispatch({
    type: 'tree',
    viewId: NODE,
    activeId: null,
    rootId: NODE,
    nodes: [
      {
        id: NODE,
        parentId: null,
        children: [],
        title: 'menu smoke',
        status: 'done',
        createdAt: 0,
        preview: 'menu smoke',
        usage: null,
        size: null,
      },
    ],
  });
  dispatch({ type: 'path', ids: [NODE], nodes: [{ id: NODE, status: 'done', items: [] }] });

  const card = Array.from(elementById('tree-canvas').children).find(
    (child) => child.dataset && child.dataset.id === NODE,
  );
  const head = card ? findByClass(card, 'node-head') : null;
  const rmb = head && head._listeners && head._listeners.contextmenu;
  if (typeof rmb !== 'function') {
    problems.push('a node header has no contextmenu handler — the node id cannot be copied from the card');
  } else {
    let prevented = false;
    rmb({ clientX: 40, clientY: 60, preventDefault: () => { prevented = true; }, stopPropagation() {} });
    if (!prevented) {
      problems.push("the header's contextmenu handler does not preventDefault — the host's own menu would win");
    }
    const menu = findByClass(document.body, 'node-menu');
    if (!menu) {
      problems.push('right-clicking a node header opened no menu');
    } else {
      if (menu.dataset.id !== NODE) {
        problems.push(`the node menu carries ${JSON.stringify(menu.dataset.id)}, expected the card's own id ${NODE}`);
      }
      const item = findByClass(menu, 'node-menu-item');
      if (!item) {
        problems.push('the node menu has no item');
      } else {
        posted.length = 0;
        const clickOf = item._listeners && item._listeners.click;
        if (typeof clickOf !== 'function') {
          problems.push('the node menu item has no click handler');
        } else {
          clickOf({ stopPropagation() {} });
          const sent = posted.find((message) => message && message.type === 'copyNodeId');
          if (!sent || sent.id !== NODE) {
            problems.push(
              `the node menu posted ${JSON.stringify(posted)}, expected { type: 'copyNodeId', id: '${NODE}' }`,
            );
          }
        }
      }
      // The menu is transient: after the click, and after the cards are rebuilt.
      if (findByClass(document.body, 'node-menu')) {
        problems.push('the node menu is still on screen after its item was clicked');
      }
      if (typeof rmb === 'function') {
        rmb({ clientX: 1, clientY: 2, preventDefault() {}, stopPropagation() {} });
        dispatch({ type: 'tree', viewId: NODE, activeId: null, rootId: NODE, nodes: [] });
        if (findByClass(document.body, 'node-menu')) {
          problems.push('the node menu survived a tree rebuild — it would copy the id of a node that is gone');
        }
      }
    }
  }
}

// --- The live block is always expanded ----------------------------------------
// `foldThinking` / `foldToolCalls` describe a block *at rest*: the block that is
// live right now — a thinking block receiving deltas, a tool call between its first
// delta and its end — is expanded whatever they say, and folds back the moment
// something else takes over. A stalled turn would otherwise reason behind a closed
// header, and a live tool card that never collapsed would grow the transcript
// without end. Checked here because both halves fail silently: the block still
// renders, nothing throws.
//
// A click on a block header is the user taking that one block over; the rule must
// then leave it exactly where they put it (the two halves of that contract are the
// hand-folded live block, below, and the fold-back it must *not* undo).
//
// One gap: `toolEnd` folds the card back through a `[data-id="…"]` lookup, which
// this DOM stub cannot resolve (compound selectors return a shared fake element), so
// the fold-back is covered through the turn ending instead — same rule, same
// container (`endRun` → `closeActive('tool')`).
{
  const NODE = 'fold-node';
  dispatch({ type: 'reset' });
  dispatch({
    type: 'tree',
    viewId: NODE,
    activeId: null,
    rootId: NODE,
    nodes: [
      {
        id: NODE,
        parentId: null,
        children: [],
        title: 'fold smoke',
        status: 'running',
        createdAt: 0,
        preview: 'fold smoke',
        usage: null,
        size: null,
      },
    ],
  });
  dispatch({ type: 'path', ids: [NODE], nodes: [{ id: NODE, status: 'running', items: [] }] });
  // All three fold defaults ON: the live block is the exception this section is about
  // (and the work log's own fold is only armed, never auto-folded here — this card
  // stays streaming for the rest of the section).
  dispatch({
    type: 'config',
    model: 'smoke-model',
    models: ['smoke-model'],
    visionModels: [],
    thinkingEffort: 'medium',
    foldToolCalls: true,
    foldThinking: true,
    foldWork: true,
  });
  dispatch({ type: 'state', busy: true, status: '', sessionId: 'fold-session', runningNodes: [NODE] });

  const cardOf = () =>
    Array.from(elementById('tree-canvas').children).find((child) => child.dataset && child.dataset.id === NODE);
  const msgsOf = () => {
    // Zone 2, the work log: this fixture's card is streaming (`runningNodes` holds
    // it for the whole section), so nothing is ever promoted out of it here.
    const items = cardOf() ? findByClass(cardOf(), 'node-work') : null;
    return items ? items.children : [];
  };
  const lastMsgOf = (kind) =>
    msgsOf()
      .filter((child) => child.dataset && child.dataset.kind === kind)
      .pop();
  /** Is that block's body hidden? `null` when the block is not on screen at all. */
  const foldedIn = (kind, cls) => {
    const message = lastMsgOf(kind);
    const body = message ? findByClass(message, cls) : null;
    return body ? body.classList.contains('hidden') : null;
  };
  const expectFold = (kind, cls, folded, what) => {
    const actual = foldedIn(kind, cls);
    if (actual === null) {
      problems.push(`${what} is not on screen — the card renders no .${cls}`);
    } else if (actual !== folded) {
      problems.push(`${what} is ${actual ? 'folded' : 'expanded'}, expected ${folded ? 'folded' : 'expanded'}`);
    }
  };
  const clickHeader = (kind, cls) => {
    const message = lastMsgOf(kind);
    const head = message ? findByClass(message, cls) : null;
    const handler = head && head._listeners && head._listeners.click;
    if (typeof handler !== 'function') {
      problems.push(`the .${cls} of a ${kind} block has no click handler — the block can no longer be folded by hand`);
      return false;
    }
    handler();
    return true;
  };

  // (a) Thinking streams in expanded, and folds back when the answer's text takes
  // over the same message.
  dispatch({ type: 'thinkingDelta', nodeId: NODE, text: 'reasoning' });
  expectFold('assistant', 'thinking-body', false, 'a thinking block receiving deltas');
  dispatch({ type: 'delta', nodeId: NODE, text: 'answer' });
  expectFold('assistant', 'thinking-body', true, "the thinking block of a message whose answer started");

  // (b) A tool call is expanded while its arguments stream and stays expanded while
  // it runs, then folds back when the turn ends under it (an interrupted call would
  // otherwise stay open, marked `running`, forever).
  dispatch({ type: 'toolCallDelta', nodeId: NODE, index: 0, id: 'fold-tool', name: 'read_file', args: '{"path":"a"}' });
  expectFold('tool', 'tool-body', false, 'a tool call streaming its arguments');
  dispatch({ type: 'toolStart', nodeId: NODE, index: 0, id: 'fold-tool', name: 'read_file', args: '{"path":"a"}' });
  expectFold('tool', 'tool-body', false, 'a tool call that started running');
  dispatch({ type: 'interrupted', nodeId: NODE });
  expectFold('tool', 'tool-body', true, 'a tool call the turn ended under');

  // (c) The user's own click wins: a live block they folded by hand is left folded —
  // the next delta must not re-open it.
  dispatch({ type: 'thinkingDelta', nodeId: NODE, text: 'reasoning again' });
  expectFold('assistant', 'thinking-body', false, 'a second thinking block, receiving deltas');
  if (clickHeader('assistant', 'thinking-head')) {
    expectFold('assistant', 'thinking-body', true, 'a thinking block the user just folded by hand');
    dispatch({ type: 'thinkingDelta', nodeId: NODE, text: 'still streaming' });
    expectFold('assistant', 'thinking-body', true, 'a hand-folded thinking block after another delta');
  }
}

// --- The three zones of a turn card: the answer is MOVED, never copied ---------
// A turn card is read as three zones (see `createNodeCard` / `renderNodeItems`):
//   .node-ask    — the pinned user ask (zone 1, Markdown, never overwritten);
//   .node-work   — the work log (zone 2): reasoning, tool cards, notices, HARNESS
//                  blocks and the text the turn went *through*. It is the one
//                  scroller that follows a live turn, so it is the one that owns the
//                  green `.scroll-lock-dot` (on `.node-work-wrap`, its wrapper);
//   .node-answer — the model's final answer (zone 3): a *pretty print* of the tail of
//                  zone 2, not a second copy of it. `promoteAnswer` moves the
//                  trailing answer run out of the log, `demoteAnswer` moves it back
//                  to the end of the log, and every append into the log is preceded
//                  by a demote (the choke points are `routeTo` — both branches — and
//                  the nodeId-less `case 'notice'`).
// Everything below rests on "a node has exactly one parent", which is why the DOM
// stub at the top of this file had to be taught to move a node out of its old parent:
// a copying stub shows no promotion, no demotion and no "which zone holds it".
//
// The cases are the contract, one rule each: (a) a finished pure-text turn, (b)
// streaming never promotes, (c) `done` promotes and the two choke points demote, (d)
// an error never promotes, (e) an interruption does, (f) a thinking-only item is not
// an answer, (g) an in-place continue demotes, (h) a live sub-agent card does not
// promote until `agentDone`, (i) a job card never has a zone 3. Cases (j) the single
// lock dot and (k) "scrolling the window is not an append" live with the windowed
// fixture above, the one finished card whose lock dots are unambiguous.
{
  const node = (id, parentId, children, extra) =>
    Object.assign(
      { id, parentId, children, title: id, status: 'done', createdAt: 0, preview: id, usage: null, size: null },
      extra || {},
    );
  const cardOf = (id) => {
    for (const child of elementById('tree-canvas').children) {
      if (child.dataset && child.dataset.id === id) return child;
    }
    return null;
  };
  const zoneOf = (card, cls) => (card ? findByClass(card, cls) : null);
  const kindsIn = (element) =>
    (element ? element.children : []).map((child) => (child && child.dataset && child.dataset.kind) || '?');
  const isHidden = (card, cls) => {
    const element = zoneOf(card, cls);
    return element ? element.classList.contains('hidden') : null;
  };
  /** A fresh card on the view path: one root node, rendered from its stored items. */
  const mount = (id, status, items) => {
    dispatch({ type: 'reset' });
    dispatch({ type: 'tree', viewId: id, activeId: null, rootId: id, nodes: [node(id, null, [], { status })] });
    dispatch({ type: 'path', ids: [id], nodes: [{ id, status, items }] });
    return cardOf(id);
  };
  const live = (id) =>
    dispatch({ type: 'state', busy: true, status: '', sessionId: 'zone-session', runningNodes: [id] });
  const idle = () =>
    dispatch({ type: 'state', busy: false, status: '', sessionId: 'zone-session', runningNodes: [] });

  /**
   * Zone 3 holds the answer and the log does not: a promotion is a move, so the
   * promoted element must have left `.node-work`, which keeps only what preceded it
   * (`logKinds`, for a card whose log already held something — a second turn).
   */
  const expectPromoted = (card, what, logKinds) => {
    const work = zoneOf(card, 'node-work');
    const answer = zoneOf(card, 'node-answer');
    if (!card || !work || !answer) {
      problems.push(`${what}: the card has no .node-work / .node-answer to look at`);
      return;
    }
    const promoted = answer.children[0];
    if (answer.children.length !== 1 || ((promoted && promoted.dataset) || {}).kind !== 'assistant') {
      problems.push(
        `${what}: zone 3 holds ${answer.children.length} element(s), expected the one promoted assistant item`,
      );
    }
    if (promoted && work.children.indexOf(promoted) >= 0) {
      problems.push(`${what}: the promoted answer is still a child of .node-work — a promotion is a move, not a copy`);
    }
    const kinds = kindsIn(work);
    const want = logKinds || [];
    if (kinds.join(',') !== want.join(',')) {
      problems.push(`${what}: .node-work holds ${JSON.stringify(kinds)}, expected ${JSON.stringify(want)}`);
    }
    if (!card.classList.contains('has-answer')) {
      problems.push(`${what}: the card does not carry \`has-answer\` while its answer is shown`);
    }
    if (isHidden(card, 'node-answer-wrap')) {
      problems.push(`${what}: .node-answer-wrap is hidden although zone 3 holds the answer`);
    }
  };

  /** Nothing was lifted out: zone 3 is empty, hidden, and the card claims no answer. */
  const expectNotPromoted = (card, what) => {
    const answer = zoneOf(card, 'node-answer');
    if (!card || !answer) {
      problems.push(`${what}: the card has no .node-answer to look at`);
      return;
    }
    if (answer.children.length !== 0) {
      problems.push(`${what}: ${answer.children.length} item(s) were promoted into .node-answer`);
    }
    if (card.classList.contains('has-answer')) {
      problems.push(`${what}: the card claims \`has-answer\` although nothing was promoted`);
    }
    if (!isHidden(card, 'node-answer-wrap')) {
      problems.push(`${what}: .node-answer-wrap is visible although zone 3 is empty`);
    }
  };

  // (a) A finished pure-text turn: the ask is zone 1, the whole tail is zone 3, and
  // the log that has nothing left in it hides (no empty box under the answer).
  {
    const card = mount('zone-text', 'done', [
      { kind: 'user', text: 'the ask' },
      { kind: 'assistant', text: 'the answer' },
    ]);
    expectPromoted(card, 'a finished pure-text turn');
    const ask = zoneOf(card, 'node-ask');
    const prompt = ask && ask.children.length ? ask.children[0] : null;
    if (!prompt || !hasClass(prompt, 'user') || !hasClass(prompt, 'prompt')) {
      problems.push('zone 1 (.node-ask) does not hold the pinned user prompt (.msg.user.prompt)');
    } else {
      const body = findByClass(prompt, 'answer');
      if (!body || !String(body.innerHTML || '').trim()) {
        problems.push('the pinned user prompt is not Markdown-rendered into its own `div.answer`');
      }
      if (findByClass(prompt, 'msg-text')) {
        problems.push('the pinned user prompt still renders a `span.msg-text` — zone 1 is Markdown now');
      }
    }
    if (!isHidden(card, 'node-work-wrap')) {
      problems.push('a pure-text turn leaves its empty .node-work-wrap on screen (zone 2 hides when it has no log)');
    }
    // A repaint of the same card must not give the answer back either: `expandedCard`
    // re-syncs a card whose zone 3 already holds something, and the promotion is still
    // the truth while nothing was appended after it (`_answerAnchor`).
    dispatch({
      type: 'tree',
      viewId: 'zone-text',
      activeId: null,
      rootId: 'zone-text',
      nodes: [node('zone-text', null, [], { status: 'done' })],
    });
    expectPromoted(card, 'a repaint of a card that already shows its answer', []);
  }

  // (b) A turn that is still streaming never promotes: its tail is still growing, and
  // the element the next delta continues is exactly that tail. Neither a `state` that
  // names the running node nor a bare `delta` lifts the answer out.
  // (c) `done` promotes it — and the two choke points that append into the log give it
  // back *before* they write, so what they write lands after the answer.
  {
    const id = 'zone-live';
    const card = mount(id, 'running', [{ kind: 'user', text: 'the ask' }]);
    live(id);
    dispatch({ type: 'delta', nodeId: id, text: 'partial answer' });
    expectNotPromoted(card, `a turn that is streaming (\`state{runningNodes:['${id}']}\`)`);
    const streamingKinds = kindsIn(zoneOf(card, 'node-work'));
    if (streamingKinds.join(',') !== 'assistant') {
      problems.push(
        `a streaming turn's log holds ${JSON.stringify(streamingKinds)}, expected its one (unpromoted) assistant item`,
      );
    }
    if (isHidden(card, 'node-work-wrap')) {
      problems.push('a streaming turn hides its .node-work-wrap');
    }
    idle();
    dispatch({ type: 'delta', nodeId: id, text: ' still streaming' });
    expectNotPromoted(card, 'a delta that arrives while nothing told the webview the run had ended');

    dispatch({ type: 'done', nodeId: id });
    expectPromoted(card, 'a `done` for a finished turn');

    // The choke point every routed append goes through (`routeTo`): a delivered
    // background notice is written into the log, so the answer comes out first.
    dispatch({
      type: 'backgroundNotice',
      nodeId: id,
      item: { kind: 'subagent', id: 'zone-notice', name: 'sub', doneText: 'done', content: 'x' },
    });
    expectNotPromoted(card, 'a background notice delivered after the answer was promoted');
    {
      const work = zoneOf(card, 'node-work');
      const kinds = kindsIn(work);
      if (kinds.join(',') !== 'assistant,background') {
        problems.push(
          `a notification after a promoted answer produced ${JSON.stringify(kinds)} in .node-work, expected the ` +
            'answer back first and the notification after it',
        );
      }
      const last = work && work.children.length ? work.children[work.children.length - 1] : null;
      if (!last || last.dataset.kind !== 'background') {
        problems.push('the notification did not land after the demoted answer in .node-work');
      }
    }

    // The other choke point: a `notice` carries no nodeId, so it demotes the
    // view-focus card itself (`case 'notice'`) before appending.
    dispatch({ type: 'delta', nodeId: id, text: 'second answer' });
    dispatch({ type: 'done', nodeId: id });
    expectPromoted(card, 'the second turn of the same card', ['assistant', 'background']);
    dispatch({ type: 'notice', kind: 'warning', text: 'heads up' });
    expectNotPromoted(card, 'a nodeId-less `notice` written into the view-focus card');
    {
      const kinds = kindsIn(zoneOf(card, 'node-work'));
      if (kinds.join(',') !== 'assistant,background,assistant,notice') {
        problems.push(
          `two turns, a notification and a warning produced ${JSON.stringify(kinds)} in .node-work, expected the ` +
            'demoted runs in order with the warning last',
        );
      }
    }
  }

  // (d) A failed turn never promotes: its tail is the `⚠️` error bubble, and an error
  // bubble is not an answer (`isAnswerEl`). That marker is what tells a failure apart
  // from an answer, so it stays in the log.
  {
    const id = 'zone-error';
    const card = mount(id, 'running', [{ kind: 'user', text: 'the ask' }]);
    live(id);
    dispatch({ type: 'delta', nodeId: id, text: 'before the error' });
    dispatch({ type: 'error', nodeId: id, message: 'boom' });
    expectNotPromoted(card, 'a turn that ended with an error');
    const work = zoneOf(card, 'node-work');
    const kinds = kindsIn(work);
    if (kinds.join(',') !== 'assistant,assistant') {
      problems.push(
        `an error turn produced ${JSON.stringify(kinds)} in .node-work, expected the partial answer and the error item`,
      );
    }
    const last = work && work.children.length ? work.children[work.children.length - 1] : null;
    if (!last || !hasClass(last, 'error')) {
      problems.push('the `⚠️` item of an error turn is not the tail of .node-work (it must not be promoted)');
    }
  }

  // (e) An interrupted run *does* promote: the user stopped it, but what streamed is
  // the turn's answer — nothing more will arrive, and it is finished.
  {
    const id = 'zone-stop';
    const card = mount(id, 'running', [{ kind: 'user', text: 'the ask' }]);
    live(id);
    dispatch({ type: 'delta', nodeId: id, text: 'partial text' });
    dispatch({ type: 'interrupted', nodeId: id });
    expectPromoted(card, 'an interrupted run');
    const promoted = zoneOf(card, 'node-answer').children[0];
    if (promoted && promoted._text !== 'partial text') {
      problems.push(`an interrupted run promoted ${JSON.stringify(promoted._text)}, expected the text it streamed`);
    }
  }

  // (f) A thinking-only assistant item has no text, so it is not an answer
  // (`isAnswerEl` reads `_text`, not the subtree): thinking block and all, it stays
  // in the log.
  {
    const id = 'zone-think';
    const card = mount(id, 'running', []);
    live(id);
    dispatch({ type: 'thinkingDelta', nodeId: id, text: 'reasoning' });
    dispatch({ type: 'done', nodeId: id });
    expectNotPromoted(card, 'a thinking-only assistant item (its text is empty)');
    if (!findByClass(zoneOf(card, 'node-work'), 'thinking-body')) {
      problems.push('the thinking-only item left .node-work — it is not an answer and must stay in the log');
    }
  }

  // (g) An in-place continue (`harnessNote`) is an append into the log of a *finished*
  // card — the card the view stays on — so the promoted answer has to come back for it.
  {
    const id = 'zone-harness';
    const card = mount(id, 'running', [{ kind: 'user', text: 'the ask' }]);
    live(id);
    dispatch({ type: 'delta', nodeId: id, text: 'answer one' });
    dispatch({ type: 'interrupted', nodeId: id });
    expectPromoted(card, 'the turn an in-place continue resumes');
    dispatch({ type: 'harnessNote', nodeId: id, text: 'Continue from where you stopped.' });
    expectNotPromoted(card, 'an in-place `harnessNote` on a card showing its answer');
    const work = zoneOf(card, 'node-work');
    const kinds = kindsIn(work);
    if (kinds.join(',') !== 'assistant,harness') {
      problems.push(
        `an in-place continue produced ${JSON.stringify(kinds)} in .node-work, expected the demoted answer and the ` +
          'HARNESS block after it',
      );
    }
    const last = work && work.children.length ? work.children[work.children.length - 1] : null;
    if (!last || last.dataset.kind !== 'harness') {
      problems.push('the HARNESS block did not land after the demoted answer in .node-work');
    }
  }

  // (h) A sub-agent card streams while *its own* run is live — `_agentLive`, set by
  // `agentStart` and cleared by `agentDone` — so it promotes on `agentDone` and not
  // before, whatever the tree's status says.
  {
    const R = 'zone-agent-root';
    const SUB = 'zone-agent-sub';
    dispatch({ type: 'reset' });
    dispatch({
      type: 'tree',
      viewId: R,
      activeId: null,
      rootId: R,
      nodes: [node(R, null, [SUB]), node(SUB, R, [], { kind: 'agent', status: 'running' })],
    });
    dispatch({ type: 'path', ids: [R], nodes: [{ id: R, status: 'done', items: [] }] });
    const card = cardOf(SUB);
    if (!card) {
      problems.push('no card was rendered for the sub-agent of the zone fixture');
    }
    dispatch({ type: 'agentStart', id: SUB, name: 'zone agent', instruction: 'x', model: 'm' });
    dispatch({ type: 'delta', nodeId: SUB, text: 'sub answer' });
    expectNotPromoted(card, 'a sub-agent card whose run is live (`agentStart`, before `agentDone`)');
    dispatch({ type: 'agentDone', id: SUB, status: 'done', summary: 'done' });
    expectPromoted(card, 'a sub-agent card after `agentDone`');
  }

  // (i) A `kind:'bg'` job card has no conversation at all (`isCardStreaming` is
  // unconditional for it): its log *is* its body, and its zone 3 stays empty for good.
  {
    const R = 'zone-bg-root';
    const JOB = 'zone-bg-job';
    dispatch({ type: 'reset' });
    dispatch({
      type: 'tree',
      viewId: R,
      activeId: null,
      rootId: R,
      nodes: [
        node(R, null, [JOB]),
        node(JOB, R, [], { kind: 'bg', status: 'done', bgTaskId: 5, bgCommand: 'sleep 1', bgExitCode: 0 }),
      ],
    });
    dispatch({ type: 'path', ids: [R], nodes: [{ id: R, status: 'done', items: [] }] });
    dispatch({
      type: 'backgrounds',
      tasks: [
        {
          id: 5,
          nodeId: R,
          cardNodeId: JOB,
          command: 'sleep 1',
          status: 'running',
          exitCode: null,
          killed: false,
          startedAt: Date.now() - 1000,
          finishedAt: null,
          truncated: false,
          outputTail: 'x',
          pendingDelivery: false,
        },
      ],
    });
    const card = cardOf(JOB);
    expectNotPromoted(card, 'a `kind:bg` job card');
    // Even the two messages that would promote any other card cannot promote this one.
    dispatch({ type: 'delta', nodeId: JOB, text: 'not a conversation' });
    dispatch({ type: 'done', nodeId: JOB });
    expectNotPromoted(card, 'a `kind:bg` job card after a delta and a `done`');
    const work = zoneOf(card, 'node-work');
    if (!work || work.children.length === 0) {
      problems.push('the job card no longer renders its body into .node-work');
    }
  }
}

// --- Zone 2's fold: the work log of a card that shows its answer ---------------
// The third round of the card. Zone 2 has a one-line header now (`.node-work-head`,
// inside `.node-work-wrap` and *before* `.node-work`) and the log folds itself to it
// as soon as zone 3 is showing, so the card reads ask → answer and the log is one
// click away. The rule is `autoWorkFold`: folded exactly while the card carries
// `has-answer`, unfolded otherwise; a card the user took — a header click, or a released
// follow light (`_workTouched`) — is theirs for good; and the setting that arms it
// (`spinney.foldWork`, `true` by default) rides the `config` message as `foldWork`, a
// *changed* value being re-run over every card already on screen.
//
// None of it throws when it breaks: the log still renders, the answer is still
// promoted, the card just lies about what it is showing — which is why it is pinned
// here. The cases are one rule each: (a) a promoted answer folds the log and a
// streaming turn does not, (b) a routed append unfolds again and the *next*
// promotion folds again, (c) a header click owns the card (`_workTouched` wins — the
// released light that claims it the same way has its own block further down),
// (d) `foldWork: false` keeps the log open without touching the promotion, (e) the
// header's label, (f) a job card's header is hidden, (g) one header per card, in its
// wrapper, before the log.
{
  const node = (id, parentId, children, extra) =>
    Object.assign(
      { id, parentId, children, title: id, status: 'done', createdAt: 0, preview: id, usage: null, size: null },
      extra || {},
    );
  const cardOf = (id) => {
    for (const child of elementById('tree-canvas').children) {
      if (child.dataset && child.dataset.id === id) return child;
    }
    return null;
  };
  /** A fresh card on the view path, rendered from its stored items (as in the zone block). */
  const mount = (id, status, items) => {
    dispatch({ type: 'reset' });
    dispatch({ type: 'tree', viewId: id, activeId: null, rootId: id, nodes: [node(id, null, [], { status })] });
    dispatch({ type: 'path', ids: [id], nodes: [{ id, status, items }] });
    return cardOf(id);
  };
  const live = (id) =>
    dispatch({ type: 'state', busy: true, status: '', sessionId: 'wf-session', runningNodes: [id] });
  const baseConfig = TURN_MESSAGES.find((message) => message.type === 'config');

  const headOf = (card) => findByClass(card, 'node-work-head');
  const labelOf = (card) => {
    const label = findByClass(headOf(card), 'node-work-label');
    return label ? String(label.textContent) : null;
  };
  const chevOpenOf = (card) => {
    const chev = findByClass(headOf(card), 'chev');
    return chev ? chev.classList.contains('open') : null;
  };
  /** Every descendant of `element` carrying `name` (the stub's `querySelectorAll` sees none). */
  const countClass = (element, name) => {
    let n = 0;
    for (const child of (element && element.children) || []) {
      if (child.classList && child.classList.contains(name)) n++;
      n += countClass(child, name);
    }
    return n;
  };
  /**
   * The card's fold state as one statement: the class the CSS keys off, the flag that
   * mirrors it, and the chevron (whose `open` is the same sense it has on a block
   * header). Three views of one state, so a card that lost its class but kept its
   * flag — or a chevron that stopped following the fold — is a failure, not a pass.
   */
  const expectFold = (card, folded, what) => {
    if (!card) {
      problems.push(`${what}: there is no card to look at`);
      return;
    }
    const hasFoldClass = card.classList.contains('work-folded');
    if (hasFoldClass !== folded) {
      problems.push(
        `${what}: the card is ${hasFoldClass ? 'folded' : 'unfolded'}, expected ${folded ? 'folded' : 'unfolded'}`,
      );
    }
    if (!!card._workFolded !== folded) {
      problems.push(`${what}: card._workFolded is ${JSON.stringify(card._workFolded)}, expected ${folded}`);
    }
    const open = chevOpenOf(card);
    if (open !== !folded) {
      problems.push(
        `${what}: the work-log chevron is ${open === null ? 'not on screen at all' : open ? 'open' : 'closed'}, ` +
          `expected ${folded ? 'closed' : 'open'}`,
      );
    }
  };
  /** What zone 3 and the card class claim — the promotion the fold is decided from. */
  const promotionOf = (card) => {
    const answer = findByClass(card, 'node-answer');
    const work = findByClass(card, 'node-work');
    return {
      promoted: answer ? answer.children.length : -1,
      hasAnswer: !!card && card.classList.contains('has-answer'),
      kinds: work ? work.children.map((child) => (child && child.dataset && child.dataset.kind) || '?') : [],
      work,
    };
  };
  /**
   * The promotion itself, without which the fold assertions above say nothing: a card
   * that stopped promoting would "stay unfolded" and look like a pass.
   */
  const expectPromoted = (card, what) => {
    const state = promotionOf(card);
    if (!state.hasAnswer || state.promoted !== 1) {
      problems.push(
        `${what}: the answer is ${state.promoted} element(s) in .node-answer and the card ` +
          `${state.hasAnswer ? 'carries' : 'does not carry'} \`has-answer\` — a promotion has to happen before this ` +
          'block can say anything about the fold',
      );
    }
  };
  /** (g) One header per card, inside the wrapper, before the log it folds. */
  const checkHeadStructure = (card, what) => {
    if (!card) {
      problems.push(`${what}: there is no card to look at`);
      return;
    }
    const heads = countClass(card, 'node-work-head');
    if (heads !== 1) {
      problems.push(`${what}: the card renders ${heads} .node-work-head element(s), expected exactly 1`);
    }
    const head = headOf(card);
    const wrap = findByClass(card, 'node-work-wrap');
    const work = findByClass(card, 'node-work');
    if (!head || !wrap || !work) {
      problems.push(`${what}: the card is missing its .node-work-head / .node-work-wrap / .node-work`);
      return;
    }
    if (head.parentElement !== wrap) {
      problems.push(`${what}: the header is not a child of .node-work-wrap — hiding the wrapper (an empty log) would leave it on screen`);
    }
    if (wrap.children.indexOf(head) >= wrap.children.indexOf(work)) {
      problems.push(`${what}: the header does not sit before .node-work inside .node-work-wrap`);
    }
  };

  // (a) A finished pure-text turn: the answer is promoted into zone 3 and the log it
  // left behind folds itself in the same step — the two are one card state, decided
  // together (`promoteAnswer` → `autoWorkFold`). A repaint decides it again from the
  // card's stored items, so the class has to follow that path too.
  {
    const card = mount('wf-done', 'done', [
      { kind: 'user', text: 'the ask' },
      { kind: 'assistant', text: 'the answer' },
    ]);
    expectPromoted(card, 'a repaint of a finished pure-text turn');
    expectFold(card, true, 'a repaint of a finished pure-text turn');
    checkHeadStructure(card, 'a repaint of a finished pure-text turn');

    // …while a turn that is still streaming keeps its log open: that log is the live
    // part of the card, and the next delta continues its tail.
    const id = 'wf-live';
    const streaming = mount(id, 'running', [{ kind: 'user', text: 'the ask' }]);
    live(id);
    dispatch({ type: 'delta', nodeId: id, text: 'streaming so far' });
    expectFold(streaming, false, 'a turn that is still streaming');
    checkHeadStructure(streaming, 'a turn that is still streaming');
    // `done` is what promotes it, and the same step folds the log.
    dispatch({ type: 'done', nodeId: id });
    expectPromoted(streaming, 'the turn `done` just finished');
    expectFold(streaming, true, 'the turn `done` just finished');

    // (b) A *routed append* on that card: the promotion comes out of zone 3 first
    // (see the zone block) and the fold follows it — a notice delivered into a log
    // that stayed folded would be invisible, which is the whole reason the demote
    // re-runs the rule.
    dispatch({
      type: 'backgroundNotice',
      nodeId: id,
      item: { kind: 'subagent', id: 'wf-notice', name: 'sub', doneText: 'done', content: 'x' },
    });
    expectFold(streaming, false, 'a card a background notice was just appended to');
    {
      const state = promotionOf(streaming);
      if (state.hasAnswer || state.promoted !== 0) {
        problems.push(
          `a notice appended to a folded card left the promotion standing (${state.promoted} element(s) in ` +
            `.node-answer, has-answer ${state.hasAnswer}) — the append has to land *after* the answer in the log`,
        );
      }
      if (state.kinds.join(',') !== 'assistant,background') {
        problems.push(
          `a notice appended to a folded card produced ${JSON.stringify(state.kinds)} in .node-work, expected the ` +
            'demoted answer with the notice after it',
        );
      }
      const notice = state.work && state.work.children[state.work.children.length - 1];
      if (!notice || !hasClass(notice, 'bgnotify')) {
        problems.push('the notice did not land at the end of .node-work');
      }
    }
    // The promotion machinery is intact: the next finished run promotes *and* folds
    // the card again — the notice was a step of the log, not the end of the card.
    dispatch({ type: 'delta', nodeId: id, text: 'more' });
    dispatch({ type: 'done', nodeId: id });
    expectPromoted(streaming, 'the turn after a notice was appended to the card');
    expectFold(streaming, true, 'the turn after a notice was appended to the card');
  }

  // (c) A click on the header hands the card to the user: the click toggles the fold
  // and `_workTouched` stops `autoWorkFold` from deciding that card ever again. Read
  // in the one direction where the two disagree — a card the user *unfolded* while
  // zone 3 is showing — because that is where an ignored `_workTouched` folds it
  // straight back, and the folded log is invisible in the card's classes otherwise.
  {
    const id = 'wf-click';
    const card = mount(id, 'running', [{ kind: 'user', text: 'the ask' }]);
    live(id);
    dispatch({ type: 'delta', nodeId: id, text: 'the answer' });
    dispatch({ type: 'done', nodeId: id });
    expectFold(card, true, 'the card before the user takes its fold over');
    const clickHead = () => {
      const head = headOf(card);
      const handler = head && head._listeners && head._listeners.click;
      if (typeof handler !== 'function') {
        problems.push('the work-log header has no click handler — the log can no longer be unfolded by hand');
        return false;
      }
      handler({ stopPropagation() {} });
      return true;
    };
    if (clickHead()) {
      expectFold(card, false, 'the card whose header the user just clicked (it was folded)');
      if (card._workTouched !== true) {
        problems.push(
          'a header click did not mark the card as user-owned (`_workTouched`) — the automatic rule would fold it back',
        );
      }
      // A later promotion must leave a user-owned card alone, whatever the default says.
      dispatch({ type: 'delta', nodeId: id, text: 'the second turn' });
      dispatch({ type: 'done', nodeId: id });
      expectPromoted(card, 'a user-unfolded card after a later promotion');
      expectFold(card, false, 'a user-unfolded card after a later promotion (`_workTouched` wins)');
      // …and the click still toggles the other way, so it is a toggle and not a
      // one-way "unfold".
      if (clickHead()) {
        expectFold(card, true, 'a second header click on the same card');
      }
    }
  }

  // (d) `spinney.foldWork: false`: the fold is off — and only the fold. The message
  // has to reach the cards already on screen (a settings change may not wait for the
  // next repaint) in both directions, and `done` still promotes the answer: the
  // setting says where zone 2 sits, never what zone 3 holds.
  {
    const id = 'wf-off';
    const card = mount(id, 'running', [{ kind: 'user', text: 'the ask' }]);
    live(id);
    dispatch({ type: 'delta', nodeId: id, text: 'the answer' });
    dispatch({ type: 'done', nodeId: id });
    expectFold(card, true, 'a card that finished while `foldWork` still defaulted to on');
    if (dispatch({ ...baseConfig, foldWork: false })) {
      problems.push('a `config` carrying foldWork: false threw — the setting has no handler');
    }
    expectFold(card, false, 'a card showing its answer when `foldWork` was switched off');
  }
  {
    const id = 'wf-off-new';
    const card = mount(id, 'running', [{ kind: 'user', text: 'the ask' }]);
    live(id);
    dispatch({ type: 'delta', nodeId: id, text: 'the answer' });
    dispatch({ type: 'done', nodeId: id });
    expectPromoted(card, 'a finished turn while `spinney.foldWork` is off');
    expectFold(card, false, 'a finished turn while `spinney.foldWork` is off');
    // Back on: the same card folds again, without a repaint.
    if (dispatch({ ...baseConfig, foldWork: true })) {
      problems.push('a `config` carrying foldWork: true threw — the setting has no handler');
    }
    expectFold(card, true, 'a card showing its answer when `foldWork` was switched back on');
  }

  // (e) The header's label: the log's step count, "Work log" while there is none.
  // The count itself is **not observable here**: `updateWorkHead` asks
  // `work.querySelectorAll('.msg.tool')`, a *compound* selector, and the stub's
  // `querySelectorAll` answers `[]` for every selector on purpose. So `n` reads 0
  // whatever the log holds and the "Work log · {0} steps" form cannot be reached
  // offline — the label's *shape* is asserted for the tool case instead (which still
  // fails on a header that lost its label or gained something else), and the `n === 0`
  // branch is asserted exactly.
  {
    const id = 'wf-label';
    const card = mount(id, 'running', [{ kind: 'user', text: 'the ask' }]);
    live(id);
    dispatch({ type: 'harnessNote', nodeId: id, text: 'Continue from where you stopped.' });
    const plain = labelOf(card);
    if (plain !== 'Work log') {
      problems.push(
        `the work-log header of a log holding no tool card reads ${JSON.stringify(plain)}, expected "Work log"`,
      );
    }
    dispatch({ type: 'toolCallDelta', nodeId: id, index: 0, id: 'wf-tool', name: 'read_file', args: '{"path":"a"}' });
    dispatch({ type: 'toolStart', nodeId: id, index: 0, id: 'wf-tool', name: 'read_file', args: '{"path":"a"}' });
    const withTool = labelOf(card);
    if (!/^Work log( · \d+ steps)?$/.test(String(withTool))) {
      problems.push(
        `the work-log header of a log holding a tool card reads ${JSON.stringify(withTool)}, expected the ` +
          '"Work log" / "Work log · N steps" form',
      );
    }
    checkHeadStructure(card, 'the card of the label fixture');
    notes.push('work-log header labelled ' + JSON.stringify(plain) + ' (tool count not observable offline)');
  }

  // (f) A job card's zone 2 is its whole body (a terminal mirror), so its header is
  // hidden and no promotion can fold it away (`setWorkFold` / `autoWorkFold` refuse a
  // `kind: 'bg'` card). The header still has to *exist* — hiding it is one class on a
  // real element — and it is the one card whose wrapper must never be hidden either.
  {
    const R = 'wf-bg-root';
    const JOB = 'wf-bg-job';
    dispatch({ type: 'reset' });
    dispatch({
      type: 'tree',
      viewId: R,
      activeId: null,
      rootId: R,
      nodes: [
        node(R, null, [JOB]),
        node(JOB, R, [], { kind: 'bg', status: 'done', bgTaskId: 11, bgCommand: 'sleep 1', bgExitCode: 0 }),
      ],
    });
    dispatch({ type: 'path', ids: [R], nodes: [{ id: R, status: 'done', items: [] }] });
    dispatch({
      type: 'backgrounds',
      tasks: [
        {
          id: 11,
          nodeId: R,
          cardNodeId: JOB,
          command: 'sleep 1',
          status: 'running',
          exitCode: null,
          killed: false,
          startedAt: Date.now() - 1000,
          finishedAt: null,
          truncated: false,
          outputTail: 'x',
          pendingDelivery: false,
        },
      ],
    });
    const job = cardOf(JOB);
    const head = headOf(job);
    if (!job || !head) {
      problems.push('a `kind:bg` job card has no .node-work-head — `renderBgBody` hides an element that has to exist');
    } else if (!head.classList.contains('hidden')) {
      problems.push('a `kind:bg` job card shows its work-log header (it must stay hidden — the log is the card body)');
    }
    // The other half of that pair: hiding the *wrapper* would hide the terminal the
    // card is entirely about.
    const jobWrap = job ? findByClass(job, 'node-work-wrap') : null;
    if (jobWrap && jobWrap.classList.contains('hidden')) {
      problems.push('a `kind:bg` job card hides .node-work-wrap — its log *is* its body and has to stay visible');
    }
    // Even the two messages that would fold any other card leave a job card alone.
    dispatch({ type: 'delta', nodeId: JOB, text: 'not a conversation' });
    dispatch({ type: 'done', nodeId: JOB });
    expectFold(job, false, 'a `kind:bg` job card after a delta and a `done`');
    checkHeadStructure(job, 'a `kind:bg` job card');
  }
}

// --- Elapsed chips: a live duration per card, frozen at the host's number -------
// A running job / sub-agent / tool call shows a duration that the *webview* ticks
// (one 250ms interval over `liveElapsed`), and the host's own value takes over the
// moment the run ends. Nothing has to be waited for here: a chip writes its value the
// instant it is created (`syncElapsed`), so a fixture can say what it must read — the
// contract being checked is the three fields that travel (`startedAt`, `ms` /
// `elapsedMs`, and the node meta a repaint rebuilds the chip from) plus the rule that
// a repaint reuses the card's one chip instead of stacking another.
{
  const node = (id, parentId, children, extra) =>
    Object.assign(
      { id, parentId, children, title: id, status: 'done', createdAt: 0, preview: id, usage: null, size: null },
      extra || {},
    );
  const cardOf = (id) => {
    for (const child of elementById('tree-canvas').children) {
      if (child.dataset && child.dataset.id === id) return child;
    }
    return null;
  };
  /** Every descendant of `element` carrying `name` (the stub's `querySelectorAll` sees none). */
  const countClass = (element, name) => {
    let n = 0;
    for (const child of (element && element.children) || []) {
      if (child.classList && child.classList.contains(name)) n++;
      n += countClass(child, name);
    }
    return n;
  };
  /** The chip's text, or null when the card has no chip at all. */
  const chipTextOf = (root, name) => {
    const chip = findByClass(root, name);
    return chip ? String(chip.textContent) : null;
  };
  /** Mount one fresh card on the view path, as the other blocks do. */
  const mount = (id, extra, status, items) => {
    dispatch({ type: 'reset' });
    dispatch({ type: 'tree', viewId: id, activeId: null, rootId: id, nodes: [node(id, null, [], extra)] });
    dispatch({ type: 'path', ids: [id], nodes: [{ id, status, items }] });
    return cardOf(id);
  };

  // (a) A tool call. Its chip appears when the call starts *running* (a card still
  // streaming the arguments has none — nothing has started), ticks the start clock the
  // host sent, and is frozen in place by `toolEnd`'s `ms` — the same chip, not a
  // second one next to a leftover live readout.
  {
    const id = 'el-tool-node';
    const card = mount(id, { status: 'running' }, 'running', []);
    const work = findByClass(card, 'node-work');
    dispatch({ type: 'toolCallDelta', nodeId: id, index: 0, id: 'el-tool', name: 'read_file', args: '{"path":"a"}' });
    const tool = findByClass(work, 'tool');
    if (!tool) {
      problems.push('no tool card was rendered for the elapsed-chip fixture');
    } else if (findByClass(tool, 'tool-elapsed')) {
      problems.push('a tool card that is still streaming its arguments already shows an elapsed chip');
    }
    dispatch({
      type: 'toolStart',
      nodeId: id,
      index: 0,
      id: 'el-tool',
      name: 'read_file',
      args: '{"path":"a"}',
      startedAt: Date.now() - 1200,
    });
    const chip = tool ? findByClass(tool, 'tool-elapsed') : null;
    const running = chipTextOf(tool, 'tool-elapsed');
    if (!/^1\.[0-9]s$/.test(String(running))) {
      problems.push(
        `a running tool card reads ${JSON.stringify(running)} in its elapsed chip, expected the running form "1.2s"`,
      );
    }
    dispatch({ type: 'toolEnd', nodeId: id, id: 'el-tool', content: 'ok', ms: 3400 });
    const frozen = chipTextOf(tool, 'tool-elapsed');
    if (frozen !== '3.4s') {
      problems.push(`a finished tool card reads ${JSON.stringify(frozen)} in its elapsed chip, expected the host's "3.4s"`);
    }
    if (tool && findByClass(tool, 'tool-elapsed') !== chip) {
      problems.push('`toolEnd` replaced the elapsed chip instead of freezing the live one in place');
    }
    if (countClass(tool, 'tool-elapsed') > 1) {
      problems.push('a tool card carries more than one elapsed chip');
    }
  }

  // (b) A job card whose snapshot has already finished: it freezes at `finishedAt`
  // (delivered but not yet taken out of the snapshot), which is the host's number and
  // not a local guess — and a record card restored after a restart has only
  // `bgElapsedMs`, checked through the same code path.
  {
    const R = 'el-bg-root';
    const JOB = 'el-bg-job';
    const startedAt = Date.now() - 75000;
    dispatch({ type: 'reset' });
    dispatch({
      type: 'tree',
      viewId: R,
      activeId: null,
      rootId: R,
      nodes: [
        node(R, null, [JOB], { status: 'running' }),
        node(JOB, R, [], { kind: 'bg', bgTaskId: 41, bgCommand: 'sleep 75', status: 'done' }),
      ],
    });
    dispatch({ type: 'path', ids: [R], nodes: [{ id: R, status: 'running', items: [] }] });
    dispatch({
      type: 'backgrounds',
      tasks: [
        {
          id: 41,
          nodeId: R,
          cardNodeId: JOB,
          command: 'sleep 75',
          status: 'finished',
          exitCode: 0,
          killed: false,
          startedAt,
          finishedAt: startedAt + 75000,
          truncated: false,
          outputTail: 'x',
          pendingDelivery: true,
        },
      ],
    });
    const text = chipTextOf(cardOf(JOB), 'bg-elapsed');
    if (text !== '1m 15s') {
      problems.push(`a finished job card reads ${JSON.stringify(text)} in its elapsed chip, expected "1m 15s"`);
    }
    // The persisted form of the same card (a record restored after a restart): there is
    // no live snapshot at all any more, so the duration can only come from the node
    // itself — one number, no start clock, and the same frozen chip.
    dispatch({ type: 'backgrounds', tasks: [] });
    dispatch({
      type: 'tree',
      viewId: R,
      activeId: null,
      rootId: R,
      nodes: [
        node(R, null, [JOB], { status: 'done' }),
        node(JOB, R, [], {
          kind: 'bg',
          bgTaskId: 41,
          bgCommand: 'sleep 75',
          status: 'done',
          bgExitCode: 0,
          bgElapsedMs: 75000,
        }),
      ],
    });
    const persisted = chipTextOf(cardOf(JOB), 'bg-elapsed');
    if (persisted !== '1m 15s') {
      problems.push(`a job record card reads ${JSON.stringify(persisted)} in its elapsed chip, expected the persisted "1m 15s"`);
    }
  }

  // (c) A sub-agent: the chip sits in the card head next to the SUB line and *before*
  // the delete button, ticks while its run is live, and `agentDone` freezes it at the
  // host's `elapsedMs`.
  {
    const R = 'el-agent-root';
    const SUB = 'el-agent-sub';
    dispatch({ type: 'reset' });
    dispatch({
      type: 'tree',
      viewId: R,
      activeId: null,
      rootId: R,
      nodes: [
        node(R, null, [SUB], { status: 'running' }),
        node(SUB, R, [], { kind: 'agent', status: 'running', agentStatus: 'running' }),
      ],
    });
    dispatch({ type: 'path', ids: [R], nodes: [{ id: R, status: 'running', items: [] }] });
    dispatch({
      type: 'agentStart',
      id: SUB,
      name: 'el agent',
      instruction: 'x',
      model: 'm',
      startedAt: Date.now() - 1000,
    });
    const card = cardOf(SUB);
    const head = findByClass(card, 'node-head');
    const live = chipTextOf(head, 'node-agent-elapsed');
    if (!/^1\.[0-9]s$/.test(String(live))) {
      problems.push(
        `a running sub-agent card reads ${JSON.stringify(live)} in its elapsed chip, expected the running form "1.0s"`,
      );
    }
    const chipAt = head ? head.children.indexOf(findByClass(head, 'node-agent-elapsed')) : -1;
    const delAt = head ? head.children.indexOf(findByClass(head, 'node-del')) : -1;
    if (chipAt < 0 || delAt < 0 || chipAt > delAt) {
      problems.push('a sub-agent card\'s elapsed chip is not in the head, before the delete button');
    }
    dispatch({ type: 'agentDone', id: SUB, status: 'done', summary: 'ok', elapsedMs: 192000 });
    const frozen = chipTextOf(head, 'node-agent-elapsed');
    if (frozen !== '3m 12s') {
      problems.push(
        `a finished sub-agent card reads ${JSON.stringify(frozen)} in its elapsed chip, expected the host's "3m 12s"`,
      );
    }
  }

  // (d) A repaint (`tree`). The host puts the run's start clock on the node itself, so
  // a card rebuilt from the session — a session switch, a branch checkout — comes back
  // with a *live* chip; and the repaint reuses that one chip rather than adding one per
  // pass (a session that repaints often would otherwise grow a row of readouts).
  {
    const R = 'el-repaint-root';
    const SUB = 'el-repaint-sub';
    const treeMsg = {
      type: 'tree',
      viewId: R,
      activeId: null,
      rootId: R,
      nodes: [
        node(R, null, [SUB], { status: 'running' }),
        node(SUB, R, [], {
          kind: 'agent',
          status: 'running',
          agentStatus: 'running',
          agentStartedAt: Date.now() - 5000,
        }),
      ],
    };
    dispatch({ type: 'reset' });
    dispatch(treeMsg);
    dispatch({ type: 'path', ids: [R], nodes: [{ id: R, status: 'running', items: [] }] });
    const text = chipTextOf(cardOf(SUB), 'node-agent-elapsed');
    if (!/^5(\.[0-9])?s$/.test(String(text))) {
      problems.push(`a sub-agent card repainted from the tree reads ${JSON.stringify(text)}, expected a live "5.0s"`);
    }
    dispatch(treeMsg);
    const chips = countClass(cardOf(SUB), 'node-agent-elapsed');
    if (chips !== 1) {
      problems.push(`a second \`tree\` for the same sub-agent left ${chips} elapsed chips (the repaint must reuse the one chip)`);
    }
  }

  // (e) A legacy tool item (the shape a host that predates the fields sends): neither
  // `startedAt` nor `ms`, so nothing is known about the run and the card renders with
  // no chip at all — and, more to the point, without throwing.
  {
    const id = 'el-legacy-node';
    const card = mount(
      id,
      { status: 'done' },
      'done',
      [
        { kind: 'user', text: 'the ask' },
        { kind: 'tool', name: 'read_file', args: '{"path":"a"}', content: 'ok', status: 'done' },
      ],
    );
    const tool = findByClass(card, 'tool');
    if (!tool) {
      problems.push('a legacy tool item no longer renders a tool card on a repaint');
    } else if (findByClass(tool, 'tool-elapsed')) {
      problems.push('a legacy tool item (no `startedAt`, no `ms`) renders an elapsed chip for a run nothing is known about');
    }
  }

  notes.push('elapsed chips: running, frozen (tool/job/agent), repainted and legacy');
}

// --- Scroll memory: a repaint never moves a reader (both zones remember) --------
// The two scrollers of a turn card — `.node-work` (the work log) and `.node-answer`
// (the answer band) — each remember where their reader was: the memory is attached
// once, when the card is built (`createNodeCard`), a `scroll` listener stores
// `container.scrollTop`, and the offset is handed back with a write at every point
// that can take it away — a routed append (`delta` / `toolStart` / `toolEnd` /
// `backgroundNotice`), a `tree` or `path` repaint (the full render path), unfolding
// the work log, and the split measurement inside `settleAnswerSplit`.
//
// Nothing here throws when it breaks, which is exactly why it is pinned: a repaint
// that forgot the memory still renders, still promotes the answer, and quietly moves
// the reader — the band jumps back to the first line of an answer they were half-way
// through, or the unlocked log jumps to the bottom. Only the person reading the card
// can see that happen, and this is the only place it can be seen without one.
//
// Two rules pull in opposite directions and are pinned together, so a fix for one
// cannot quietly break the other:
//  - zone 3 goes to its top ONCE per card (a flag on the card): the first render
//    opens the band at the first line, and *later* repaints must not;
//  - a LOCKED card (a node in `runningNodes`: the follow light on, `.scroll-locked`
//    on the container) is never handed an older offset — its log stays pinned to its
//    newest content, and the offset its memory holds loses to the light.
//
// The sandbox has no layout, so what it *can* observe is the writes: an offset the
// webview never writes stays exactly where this fixture put it. Every assertion below
// is that comparison — the value the reader handed the memory is the value the zone
// has to read back once the message has been handled.
//
// The fixture's log holds a handful of items on purpose: past 60 items a finished
// card's log is *windowed*, and the last `scroll` handler on `.node-work` is then the
// window's, not the memory's (that card is the one the windowed fixture above checks).
{
  const ID = 'mem-node';
  const node = (id, parentId, children, extra) =>
    Object.assign(
      { id, parentId, children, title: id, status: 'done', createdAt: 0, preview: id, usage: null, size: null },
      extra || {},
    );
  const cardOf = (id) => {
    for (const child of elementById('tree-canvas').children) {
      if (child.dataset && child.dataset.id === id) return child;
    }
    return null;
  };
  /**
   * The last `scroll` handler on a container. The stub keeps one handler per event
   * type, so on a log that is *not* windowed this is the memory itself (see the note
   * above) — and on the answer band it is the only one there is.
   */
  const scrollHandler = (element) =>
    element && element._listeners && typeof element._listeners.scroll === 'function' ? element._listeners.scroll : null;

  // A `user` item is the pinned ask (zone 1) and never a log item, so the log keeps
  // the tool card and the trailing assistant run is what gets promoted into zone 3.
  const items = [
    { kind: 'user', text: 'the ask' },
    { kind: 'tool', name: 'read_file', args: '{"path":"a"}', id: 'mem-tool', content: 'ok', status: 'done' },
    { kind: 'assistant', text: 'the answer' },
  ];
  const treeMsg = {
    type: 'tree',
    viewId: ID,
    // Checked out, so the `setBusy` path at the end of this block reaches this card
    // (`setActiveScrollLock` locks the *view focus* card).
    activeId: ID,
    rootId: ID,
    rootIds: [ID],
    nodes: [node(ID, null, [])],
  };
  const pathMsg = { type: 'path', ids: [ID], nodes: [{ id: ID, status: 'done', items }] };

  dispatch({ type: 'reset' });
  dispatch(treeMsg);
  dispatch(pathMsg);

  const card = cardOf(ID);
  const work = card ? findByClass(card, 'node-work') : null;
  const answer = card ? findByClass(card, 'node-answer') : null;
  if (!card || !work || !answer) {
    problems.push(
      `the scroll-memory fixture has no .node-work (${work ? 'yes' : 'no'}) / .node-answer (${answer ? 'yes' : 'no'}) — ` +
        'a finished, unlocked card with a handful of items was expected',
    );
  } else {
    // Geometry a laid-out card would have: both zones are taller than their boxes, so
    // every clamp below is a real comparison instead of `0 === 0`.
    work.scrollHeight = 1000;
    work.clientHeight = 400;
    answer.scrollHeight = 900;
    answer.clientHeight = 300;

    // (a) Zone 3 opens at the top of the answer — the one write its own rule makes,
    // and the reason it carries no green dot: an answer is read from its first line.
    if (answer.scrollTop !== 0) {
      problems.push(
        `zone 3 sits at ${answer.scrollTop} of a ${answer.scrollHeight}px answer — the band has to open at its top ` +
          '(its end is not what a reader wants first)',
      );
    }

    // A promoted answer folds the log (`autoWorkFold`), so the card is unfolded once
    // here. That first unfold is the card opening at its own newest content
    // (`_needsBottomScroll`), deliberately *not* asserted: it is not the memory. What
    // the checks below need is a plain unfolded card whose fold the reader owns.
    const head = findByClass(card, 'node-work-head');
    const headClick = () => {
      const handler = head && head._listeners && head._listeners.click;
      if (typeof handler !== 'function') return false;
      handler({ stopPropagation() {} });
      return true;
    };
    if (!headClick()) {
      problems.push('the work log has no clickable header — the fold/unfold steps below cannot run');
    }

    // (b) The memory itself: on a log that is not windowed the last handler is the
    // memory, and the band has its own. Both zones are told where their reader is
    // (300 / 120) — the state every assertion below compares against.
    const WORK_TOP = 300;
    const ANSWER_TOP = 120;
    for (const [zone, name] of [
      [work, 'the work log (.node-work)'],
      [answer, 'the answer band (.node-answer)'],
    ]) {
      if (!scrollHandler(zone)) {
        problems.push(
          `${name} carries no \`scroll\` listener — nothing remembers where its reader was, so a repaint has ` +
            'nothing to give back (the memory is attached once, where the card is built)',
        );
      }
    }
    /** Both zones still hold the offset their reader left — the whole point. */
    const expectOffsets = (what) => {
      if (work.scrollTop !== WORK_TOP) {
        problems.push(
          `${what} moved the work log from ${WORK_TOP} to ${work.scrollTop} — an unlocked reader's offset has to ` +
            'survive the message (the rebuild hands it back)',
        );
      }
      if (answer.scrollTop !== ANSWER_TOP) {
        problems.push(
          `${what} moved the answer band from ${ANSWER_TOP} to ${answer.scrollTop} — zone 3 is read where the ` +
            'reader left it; only its *first* render goes to the top',
        );
      }
    };

    /**
     * The reader takes the two zones to 300 / 120 and tells the memory, which is the
     * state every message below starts from. Re-armed before each step on purpose: a
     * step that loses an offset is then the step that lost it, and never merely the one
     * that inherited a position an earlier step had already thrown away.
     */
    const arm = () => {
      work.scrollTop = WORK_TOP;
      if (scrollHandler(work)) scrollHandler(work)();
      answer.scrollTop = ANSWER_TOP;
      if (scrollHandler(answer)) scrollHandler(answer)();
    };

    // (c) The routed appends an unlocked card sees: a `delta`, a tool call and a
    // delivered notice. Each one demotes the answer back into the log first, which is
    // a rebuild of zone 2 — and neither zone may move.
    arm();
    dispatch({ type: 'delta', nodeId: ID, text: 'x' });
    if (work.children.length < 2) {
      problems.push(
        'the routed `delta` did not land in the log — the offset assertion below would say nothing about an append',
      );
    }
    expectOffsets('a routed `delta` append');
    // The tool messages in the order the provider sends them: the argument deltas
    // open the live tool card, `toolStart` finalizes it in place and `toolEnd` closes
    // it (a `toolStart` with no live tool is not a shape the host produces).
    arm();
    dispatch({ type: 'toolCallDelta', nodeId: ID, index: 0, id: 'mem-tool-2', name: 'read_file', args: '{"path":"a"}' });
    dispatch({
      type: 'toolStart',
      nodeId: ID,
      index: 0,
      id: 'mem-tool-2',
      name: 'read_file',
      args: '{"path":"a"}',
      startedAt: Date.now() - 100,
    });
    dispatch({ type: 'toolEnd', nodeId: ID, id: 'mem-tool-2', content: 'ok', ms: 130 });
    expectOffsets('a routed `toolCallDelta` / `toolStart` / `toolEnd` append');
    arm();
    dispatch({
      type: 'backgroundNotice',
      nodeId: ID,
      item: { kind: 'subagent', id: 'mem-bg', name: 'sub', doneText: 'done', content: 'x' },
    });
    expectOffsets('a delivered `backgroundNotice`');

    // (d) A full repaint: `tree` rebuilds the view and `path` re-renders the view path
    // (the full render path for this card). These are the passes that used to take a
    // reader's position away, so they are checked as one rule, not as two.
    arm();
    dispatch(treeMsg);
    expectOffsets('a `tree` repaint');
    arm();
    dispatch(pathMsg);
    expectOffsets('a `path` re-render');

    // (e) The log's own fold — the one scroller that is also a control. Folding takes
    // the scroller away (a `scrollTop` written into a `display: none` box is thrown
    // away) and unfolding it is the moment the memory is applied (`setWorkFold`).
    if (card.classList.contains('work-folded')) {
      problems.push('the work log is folded before the fold/unfold step — the unfold restore cannot be seen');
    }
    arm();
    headClick();
    if (!card.classList.contains('work-folded')) {
      problems.push('clicking the work-log header did not fold the log — the unfold step below says nothing');
    }
    expectOffsets('folding the work log');
    arm();
    headClick();
    if (card.classList.contains('work-folded')) {
      problems.push('clicking the work-log header a second time did not unfold the log');
    }
    expectOffsets('unfolding the work log');

    // (f) A LOCKED card still owns its log. A `state` naming this node in
    // `runningNodes` (the `setBusy` path) engages the follow light; the append after
    // that has to pin the log to its newest content, and the 300 the memory holds must
    // lose. `clientHeight` is 0 for this step so "the bottom" is exactly the full
    // `scrollHeight`: the clamped write the follow path makes and a plain
    // `scrollTop = scrollHeight` are then the same number.
    dispatch({ type: 'state', busy: true, status: '', sessionId: 'mem-session', runningNodes: [ID] });
    const dot = findByClass(card, 'scroll-lock-dot');
    if (!work.classList.contains('scroll-locked') || !dot || !dot.classList.contains('locked')) {
      problems.push(
        "a `state` naming this node in `runningNodes` did not engage the card's follow light — the locked-log " +
          'check below cannot see the pin at all',
      );
    }
    work.clientHeight = 0;
    // The reader's older offset is the memory's 300 (armed above): the pin has to win.
    arm();
    dispatch({ type: 'delta', nodeId: ID, text: 'more' });
    if (work.scrollTop !== work.scrollHeight) {
      problems.push(
        `a locked card's work log sits at ${work.scrollTop} after an append, expected ${work.scrollHeight} — the ` +
          'follow light pins the log to its newest content, and the offset the memory holds must not win',
      );
    }
  }

  notes.push('scroll memory: both zones hold through append / repaint / re-render / unfold, a locked log still pins');
}

// --- The release light claims the card, exactly as the work-log header does -----
// The green dot under a card's work log is not only a scroll control. Releasing it
// (locked → unlocked) is the gesture that says *I am reading this card* — the same
// gesture as a click on `.node-work-head` — so it sets the same mark (`_workTouched`),
// and `autoWorkFold` stops deciding that card's fold for good: it may refresh the
// header label, never the fold. Re-engaging follow (unlocked → locked) is a scrolling
// gesture and no claim on the fold, so it must not set the mark either.
//
// Nothing throws when this breaks, which is why it is pinned here beside the fold rule
// it belongs to: the dot still toggles, the light still looks right, and the only thing
// that changes is that a card the reader just chose to look at quietly folds itself
// under them at the next `done` — the failure the header-click case above covers for
// the other way of claiming a card.
//
// The fixture is one tree with three nodes, all three on the path (so a single `config`
// toggle reaches every card at once):
//   lock-release — streams, its dot *released* by hand, then `done`;
//   lock-control — the same shape, its dot never touched: the `done` fold has to be
//                  visible on it, or "the released card did not fold" says nothing;
//   lock-engage  — created finished, so its dot starts unlocked and a click *engages*
//                  follow: that card has to stay automatically decidable.
// Every card's light comes from its own `status` at creation
// (`attachLock(work, workWrap, meta.status === 'running')`), so the `viewId` is the
// finished node and no `state` ever hands a live card its lock. `state` is replayed
// only for `runningNodes`: a streaming card promotes nothing, so both live cards keep
// their log unfolded until their own `done` — which is what makes the fold that `done`
// performs (or refuses) observable on each of them.
{
  const R = 'lock-root';
  const A = 'lock-release';
  const B = 'lock-control';
  const C = 'lock-engage';
  const node = (id, parentId, children, extra) =>
    Object.assign(
      { id, parentId, children, title: id, status: 'done', createdAt: 0, preview: id, usage: null, size: null },
      extra || {},
    );
  const cardOf = (id) => {
    for (const child of elementById('tree-canvas').children) {
      if (child.dataset && child.dataset.id === id) return child;
    }
    return null;
  };
  /** The card's fold as the CSS sees it (the flag that mirrors it is checked with it). */
  const isFolded = (card) => !!card && card.classList.contains('work-folded');
  /**
   * The promotion the fold is decided from. `autoWorkFold` folds a card *because* it
   * shows an answer (`has-answer`), so a card with no promotion can say nothing about
   * the rule: its log "not folding" is then the streaming default.
   */
  const expectHasAnswer = (card, what) => {
    if (!card || !card.classList.contains('has-answer')) {
      problems.push(
        `${what}: the card does not carry \`has-answer\` — nothing was promoted into zone 3, so its log's fold state ` +
          'is the streaming default and not the automatic rule at all',
      );
    }
  };
  const expectFold = (card, folded, what) => {
    if (!card) {
      problems.push(`${what}: there is no card to look at`);
      return;
    }
    if (isFolded(card) !== folded) {
      problems.push(
        `${what}: the log is ${isFolded(card) ? 'folded' : 'unfolded'}, expected ${folded ? 'folded' : 'unfolded'}`,
      );
    }
    if (!!card._workFolded !== folded) {
      problems.push(`${what}: card._workFolded is ${JSON.stringify(card._workFolded)}, expected ${folded}`);
    }
  };
  /**
   * The card's own green dot, clicked the way a reader clicks it — through the listener
   * the webview registered on the element (`_listeners.click`), never by poking its
   * classes: what the click *does* is the behaviour under test.
   */
  const clickDot = (card, what) => {
    const dot = card ? findByClass(card, 'scroll-lock-dot') : null;
    const handler = dot && dot._listeners && dot._listeners.click;
    if (!dot || typeof handler !== 'function') {
      problems.push(
        `${what}: the card has no clickable .scroll-lock-dot — the light can be neither released nor engaged`,
      );
      return null;
    }
    handler({ stopPropagation() {} });
    return dot;
  };

  // A `user` item is the pinned ask and a trailing `assistant` run is what every card
  // here promotes; the tool card is left behind in the log, so the log has something to
  // fold away and "it did not fold" is a statement about the rule.
  const items = [
    { kind: 'user', text: 'the ask' },
    { kind: 'tool', name: 'read_file', args: '{"path":"a"}', id: 'lock-tool', content: 'ok', status: 'done' },
    { kind: 'assistant', text: 'the answer' },
  ];

  dispatch({ type: 'reset' });
  dispatch({
    type: 'tree',
    // The view focus is the *finished* node, so neither live card is the focus and a
    // `state` can never engage their light: it is the one their own `status` gave them.
    viewId: C,
    activeId: null,
    rootId: R,
    rootIds: [R],
    nodes: [
      node(R, null, [A, B, C]),
      node(A, R, [], { status: 'running' }),
      node(B, R, [], { status: 'running' }),
      node(C, R, [], { status: 'done' }),
    ],
  });
  // Both live cards stream while their stored items render (`runningNodes`), which is
  // what keeps their logs open: the promotion — and with it the fold — waits for their
  // own `done` below.
  dispatch({ type: 'state', busy: true, status: '', sessionId: 'lock-session', runningNodes: [A, B] });
  dispatch({
    type: 'path',
    ids: [A, B, C],
    nodes: [
      { id: A, status: 'running', items },
      { id: B, status: 'running', items },
      { id: C, status: 'done', items },
    ],
  });

  const cardA = cardOf(A);
  const cardB = cardOf(B);
  const cardC = cardOf(C);
  if (!cardA || !cardB || !cardC) {
    problems.push(
      `the release-light fixture rendered ${[cardA, cardB, cardC].filter(Boolean).length} of its 3 cards — ` +
        'every assertion below needs all three of them',
    );
  } else {
    // (a) The release claims the card. A live turn starts with its light engaged (its log
    // follows its own output), so the click below is a real release — and releasing is the
    // gesture that says *this card is mine*, exactly as the header click does.
    const dotA = findByClass(cardA, 'scroll-lock-dot');
    if (!dotA || !dotA.classList.contains('locked')) {
      problems.push(
        'a card created from a `status: running` node did not start with its scroll light engaged — the release ' +
          'below would not be a release at all',
      );
    }
    expectFold(cardA, false, 'the released card while it is still streaming (no answer yet, so nothing to fold)');
    const clickedA = clickDot(cardA, 'the released card');
    if (!clickedA || clickedA.classList.contains('locked')) {
      problems.push(
        "clicking a locked card's green dot left the light engaged — the release click did nothing " +
          '(a `click` listener that is gone looks exactly like this)',
      );
    }
    // `done` ends the stream: the trailing answer is promoted into zone 3 and the
    // automatic rule gets its say — unless the release already claimed the card.
    dispatch({ type: 'done', nodeId: A });
    expectHasAnswer(cardA, 'the released card after `done`');
    if (cardA._workTouched !== true) {
      problems.push(
        "the release click did not mark the card as the reader's (`_workTouched`) — so the automatic fold rule would " +
          'fold the log under them at the next promotion',
      );
    }
    expectFold(cardA, false, 'the released card after `done` (the release claimed its fold)');

    // (b) The control, without which (a) says nothing: the same shape with a dot nobody
    // touched folds by itself the moment `done` promotes its answer.
    const dotB = findByClass(cardB, 'scroll-lock-dot');
    if (!dotB || !dotB.classList.contains('locked')) {
      problems.push("the control card's light did not start engaged — it is not the released card's twin");
    }
    dispatch({ type: 'done', nodeId: B });
    expectHasAnswer(cardB, 'the control card after `done`');
    expectFold(cardB, true, 'the control card after `done` (nobody released its light)');

    // (c) The direction matters. This card was created finished, so its dot starts
    // unlocked and the click *engages* follow — a scrolling gesture, not a claim: the card
    // has to stay automatically decidable. The probe is the `config` handler, which re-runs
    // `autoWorkFold` over every card on screen when `foldWork` *changes*: toggling it off
    // and on again decides both cards in the same pass — the engaged one folds while it
    // shows its answer, the released one does not.
    const dotC = findByClass(cardC, 'scroll-lock-dot');
    if (!dotC || dotC.classList.contains('locked')) {
      problems.push(
        'a card created from a `status: done` node did not start with its light released — the engage below would ' +
          'not be an engage',
      );
    }
    // Settled before the click: the finished card promoted its answer on the way in, and a
    // live (unclaimed) fold rule has folded it already. That is the state the `config`
    // toggle has to move — a card wrongly marked as the reader's would sit unchanged in
    // *both* directions, which is exactly what the two assertions below catch.
    expectHasAnswer(cardC, 'the engaged card before its light was clicked');
    expectFold(cardC, true, 'the engaged card before its light was clicked (the automatic rule folded it)');
    const clickedC = clickDot(cardC, 'the engaged card');
    if (!clickedC || !clickedC.classList.contains('locked')) {
      problems.push("clicking a released card's green dot did not engage follow — the light cannot be turned back on");
    }
    if (cardC._workTouched === true) {
      problems.push(
        "re-engaging follow marked the card as the reader's (`_workTouched`) — that gesture is a scroll control, not " +
          'a claim on the fold, and a card wrongly marked this way never folds or unfolds again',
      );
    }
    const baseConfig = TURN_MESSAGES.find((message) => message.type === 'config');
    if (dispatch({ ...baseConfig, foldWork: false })) {
      problems.push('a `config` carrying foldWork: false threw — the setting has no handler');
    }
    // The engaged card unfolds while its answer is showing: proof that the automatic rule
    // still decides it (a marked card would have kept its fold).
    expectFold(cardC, false, 'the engaged card when `foldWork` was switched off (it is still auto-decidable)');
    expectFold(cardA, false, 'the released card when `foldWork` was switched off');
    if (dispatch({ ...baseConfig, foldWork: true })) {
      problems.push('a `config` carrying foldWork: true threw — the setting has no handler');
    }
    // …and folds again, while the released card — same message, same pass, an answer of its
    // own on screen (`has-answer` re-asserted right here) — stays where its reader left it.
    expectHasAnswer(cardA, 'the released card at the end of the `foldWork` toggle');
    expectFold(cardC, true, 'the engaged card once `foldWork` was switched back on');
    expectFold(cardA, false, 'the released card once `foldWork` was switched back on (the release owns its fold)');
  }

  notes.push(
    'release light: a released dot claims the card (no fold after `done`), its untouched twin folds, re-engaging ' +
      'follow stays auto-decidable',
  );
}

// --- Touch navigation: a finger pans the tree, two fingers pinch it -----------
// The phone's session view is this same renderer inside an Android WebView, and there
// the pan and the zoom above it are both unreachable: `touch-action` is `auto` on the
// whole subtree, so the browser classifies a one-finger drag as *its* pan and cancels
// the pointer stream (`pointercancel`, which the pan handler honours), and a pinch
// produces no `wheel` at all. What the touch layer near the end of `media/main.js` has
// to do instead is read both gestures off the touch stream, driving the same camera.
//
// Every assertion below is stated as the *thing that would be broken* without it, because
// re-running a handler proves nothing on its own: a `touchmove` listener that pans to a
// wrong place, twice, or into a log zone would satisfy "the handler ran" just as well.
//   (a) a one-finger drag moves the canvas by exactly the finger's travel, once — the
//       finger reaches the camera, and the compatibility pointer stream is *not* panning
//       on top of it (that would show as twice the travel);
//   (b) the same drag starting on a *card* pans too — the mouse rule up there leaves a
//       card to the checkout click, and a phone has no empty background to copy it from;
//   (c) a tap, and a wobble under the slop, are not `defaultPrevented` and move nothing —
//       that is what leaves the browser free to synthesise the `click` the checkout needs;
//   (d) a claimed drag *is* `defaultPrevented` — the cancellation that stops the browser's
//       own pan from fighting ours for the same finger;
//   (e) a drag out of `.node-work` / the other native scroll zones neither pans nor
//       cancels: those zones keep their own touch scrolling. `.node-resize` is not one of
//       them — a corner is not a scroller, and the finger on it belongs to the card's own
//       resize (case (h));
//   (f) a two-finger spread scales the canvas by the *capped* per-event factor, around the
//       fingers' midpoint — the world point under the pinch does not move;
//   (g) a `pointerdown` from a finger starts no pointer drag, while the identical event
//       with a mouse pointer type still does: the two layers can never pan at once, and
//       the desktop mouse path is untouched;
//   (h) a finger on `.node-resize` resizes the card — a wireframe follows the drag, the
//       `touchmove` is cancelled and the tree does not pan, the lift writes the dragged
//       size on the card and posts it — while a tap, a `touchcancel` and a second finger
//       commit nothing, and the *same* finger's `pointerdown` resizes nothing at all
//       (that path is the mouse's, and one press must not resize twice).
{
  const wrap = elementById('tree-wrap');
  const canvas = elementById('tree-canvas');
  const follow = elementById('follow-btn');
  /** The camera as the canvas carries it — the numbers inside `applyTransform()`'s string. */
  const camera = () => {
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\((-?[\d.]+)\)/.exec(String(canvas.style.transform || ''));
    return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]), zoom: parseFloat(m[3]) } : null;
  };
  /** One decimal, so a failure message reads like the gesture that caused it. */
  const round = (value) => Math.round(value * 10) / 10;
  const touch = (x, y) => ({ clientX: x, clientY: y });
  /**
   * A touch target as the browser hands one over. Only the class / id form of `closest`
   * is emulated — that is all the touch layer asks about — and an element carrying one of
   * `names` (what "the finger landed inside .node-work" means) answers for the whole
   * selector list, exactly as `closest` would.
   */
  const targetIn = (...names) => ({
    names,
    closest(selector) {
      for (const part of String(selector).split(',')) {
        const name = part.trim().replace(/^[.#]/, '');
        if (name && names.indexOf(name) >= 0) return this;
      }
      return null;
    },
  });
  /**
   * The corner as a finger hands it over: the card's *real* `.node-resize`, because a
   * resize writes into the card the renderer built and into that node's own size record
   * — a stand-in would prove nothing about either. What it is missing is the stub's
   * `closest()`, which answers every selector with null, so the two the touch layer asks
   * about are taught here (the same emulation `targetIn` does for the zones).
   */
  const resizeCorner = (card) => {
    const handle = card ? findByClass(card, 'node-resize') : null;
    if (handle) {
      handle.closest = (selector) =>
        selector === '.node-resize' ? handle : selector === '.node' ? card : null;
    }
    return handle;
  };
  const gestureEvent = (type, touches, target) => ({
    type,
    touches,
    target,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  });
  const start = wrap._listeners.touchstart;
  const move = wrap._listeners.touchmove;
  const end = wrap._listeners.touchend;
  const cancel = wrap._listeners.touchcancel;
  if ([start, move, end, cancel].some((handler) => typeof handler !== 'function')) {
    problems.push(
      'the tree wrapper registered no touch gesture (missing `touchstart` / `touchmove` / `touchend` / `touchcancel` ' +
        'on #tree-wrap) — on a phone the browser takes a one-finger drag as its own pan, so with no touch layer ' +
        'a finger cannot move the tree at all and two fingers cannot zoom it',
    );
  } else {
    // (a) + (b) One finger pans — 1:1, once, and from a card. Follow is engaged first so
    // that "the finger dropped it" is a statement about the pan and not about whatever the
    // block above left behind; `camera()` is read after that click, because engaging
    // follow can move the camera itself.
    if (typeof follow._listeners?.click === 'function') {
      follow._listeners.click();
      if (!follow.classList.contains('active')) follow._listeners.click();
    }
    const followWasOn = follow.classList.contains('active');
    const before = camera();
    const cardTarget = targetIn('node', 'node-head');
    const dragStart = gestureEvent('touchstart', [touch(300, 400)], cardTarget);
    start(dragStart);
    const dragMove = gestureEvent('touchmove', [touch(360, 350)], cardTarget);
    move(dragMove);
    end(gestureEvent('touchend', [], cardTarget));
    if (!before) {
      problems.push('the tree canvas carried no `transform` before the touch step — `applyTransform()` never ran');
    } else {
      const after = camera();
      if (!after) {
        problems.push('a one-finger drag left #tree-canvas without a `transform`');
      } else {
        const dx = after.x - before.x;
        const dy = after.y - before.y;
        if (Math.abs(dx - 60) > 0.51 || Math.abs(dy + 50) > 0.51) {
          problems.push(
            `a one-finger drag of (60, -50) out of a card moved the tree by (${round(dx)}, ${round(dy)}) — expected ` +
              'exactly the finger\'s own travel: a finger has to pan the tree (it is a card, and a phone has no empty ' +
              'background to grab instead), and twice that means the compatibility pointer stream panned on top of ' +
              'the finger',
          );
        }
        if (Math.abs(after.zoom - before.zoom) > 1e-6) {
          problems.push('a one-finger drag changed the scale — a pan must not zoom');
        }
        if (followWasOn && follow.classList.contains('active')) {
          problems.push(
            'a touch pan left the follow light engaged — a streaming turn\'s auto-pan would then fight the finger ' +
              'for the camera, frame by frame',
          );
        }
      }
    }
    if (!dragMove.defaultPrevented) {
      problems.push(
        'the touchmove of a drag worth 78px was not `defaultPrevented` — the browser keeps its own pan for that ' +
          'finger and cancels the rest of the gesture, which is the `pointercancel` that made this dead on a phone',
      );
    }

    // (c) A tap is still a tap. The checkout is a `click`, and a cancelled touch event is
    // a `click` the browser never synthesises; a thumb is never perfectly still either, so
    // the wobble below matters as much as the dead-still tap.
    const tapBefore = camera();
    const tapStart = gestureEvent('touchstart', [touch(300, 400)], cardTarget);
    start(tapStart);
    const tapEnd = gestureEvent('touchend', [], cardTarget);
    end(tapEnd);
    const wobbleStart = gestureEvent('touchstart', [touch(300, 400)], cardTarget);
    start(wobbleStart);
    const wobbleMove = gestureEvent('touchmove', [touch(302, 401)], cardTarget);
    move(wobbleMove);
    end(gestureEvent('touchend', [], cardTarget));
    const cancelled = [tapStart, tapEnd, wobbleStart, wobbleMove].filter((event) => event.defaultPrevented);
    if (cancelled.length > 0) {
      problems.push(
        `${cancelled.length} of the 4 events of a tap (touchstart / touchend with no travel, plus a 2px wobble) were ` +
          '`defaultPrevented` — the browser drops the compatibility `click` behind a cancelled touch, so a tap could ' +
          'never check a node out',
      );
    }
    const tapAfter = camera();
    if (tapBefore && tapAfter && (Math.abs(tapAfter.x - tapBefore.x) > 0.01 || Math.abs(tapAfter.y - tapBefore.y) > 0.01)) {
      problems.push('a tap (and a 2px wobble) moved the tree — the pan started before the drag slop was passed');
    }

    // (e) The zones that scroll themselves keep doing it. `.node-work` is the log,
    // `.node-answer` the promoted answer, `.node-ask` the pinned ask, `.thinking-body` the
    // folded thinking, and `#composer` its own pane — five zones whose scrolling is the
    // browser's own, so a finger that landed in one may be neither cancelled (that is what
    // switches the browser's touch scrolling off) nor panned by this layer. `.node-resize`
    // is deliberately not among them: a corner is not a scroller, and the finger on it
    // belongs to the card's resize (case (h)).
    const zoneBefore = camera();
    for (const zone of ['node-work', 'node-answer', 'node-ask', 'thinking-body', 'composer']) {
      const zoneTarget = targetIn(zone);
      start(gestureEvent('touchstart', [touch(300, 400)], zoneTarget));
      const zoneMove = gestureEvent('touchmove', [touch(200, 500)], zoneTarget);
      move(zoneMove);
      end(gestureEvent('touchend', [], zoneTarget));
      if (zoneMove.defaultPrevented) {
        problems.push(
          `a drag out of .${zone} cancelled its touchmove — the browser's own touch scrolling inside that zone is ` +
            'switched off, so the log / answer / ask / composer cannot be scrolled on a phone',
        );
      }
      const zoneAfter = camera();
      if (
        zoneBefore &&
        zoneAfter &&
        (Math.abs(zoneAfter.x - zoneBefore.x) > 0.01 || Math.abs(zoneAfter.y - zoneBefore.y) > 0.01)
      ) {
        problems.push(`a drag out of .${zone} panned the tree — that zone owns the finger, the camera does not move`);
      }
    }

    // (f) Two fingers pinch. The frame below spreads the fingers 100px → 150px, i.e. a 1.5×
    // frame: the scale has to follow by the *per-event cap* (1.25×, clamped again by
    // `zoomAt()`'s own 0.4 … 1.5), not by 1.5 — the cap is what stops a jittery frame from
    // jumping the zoom, and a check that merely saw the scale change could not tell them
    // apart. The anchor is asserted as the camera's own invariant: the point of the canvas
    // under the midpoint (350, 400) has to sit under the midpoint after the frame too, so a
    // pinch anchored anywhere else (the canvas corner, the window origin) fails here.
    const pinchBefore = camera();
    const pinchMid = touch(350, 400);
    const pinchTarget = targetIn('node', 'node-head');
    start(gestureEvent('touchstart', [touch(300, 400), touch(400, 400)], pinchTarget));
    const spread = gestureEvent('touchmove', [touch(275, 400), touch(425, 400)], pinchTarget);
    move(spread);
    end(gestureEvent('touchend', [], pinchTarget));
    if (!pinchBefore) {
      problems.push('the tree canvas carried no `transform` before the pinch — the scale cannot be read');
    } else {
      const pinchAfter = camera();
      if (!pinchAfter) {
        problems.push('a two-finger spread left #tree-canvas without a `transform`');
      } else {
        const expected = Math.min(1.5, Math.max(0.4, pinchBefore.zoom * 1.25));
        if (Math.abs(pinchAfter.zoom - expected) > 1e-6) {
          problems.push(
            `a two-finger spread from 100px to 150px left the scale at ${pinchAfter.zoom}, expected ${expected} ` +
              `(the previous scale × the 1.25 per-event cap, clamped by zoomAt) — two fingers have to zoom the tree, ` +
              'and one frame may move it by no more than the cap',
          );
        }
        const worldOf = (cam) => ({ x: (pinchMid.clientX - cam.x) / cam.zoom, y: (pinchMid.clientY - cam.y) / cam.zoom });
        const worldBefore = worldOf(pinchBefore);
        const worldAfter = worldOf(pinchAfter);
        if (Math.abs(worldAfter.x - worldBefore.x) > 0.51 || Math.abs(worldAfter.y - worldBefore.y) > 0.51) {
          problems.push(
            `the pinch moved the point under the fingers by (${round(worldAfter.x - worldBefore.x)}, ` +
              `${round(worldAfter.y - worldBefore.y)}) canvas px — the fingers' midpoint is the anchor zoomAt() has ` +
              'to be handed, so the content under them stays under them',
          );
        }
      }
    }
    if (!spread.defaultPrevented) {
      problems.push(
        'a two-finger pinch was not `defaultPrevented` — the browser keeps its own gesture for those fingers, on top ' +
          'of the zoom we already applied',
      );
    }

    // (g) The two layers must not pan at once, and the mouse must keep panning. The same
    // pointer event is replayed twice — through *every* `pointerdown` `#tree-wrap`
    // registered, then a `pointermove` through every window listener the browser would
    // reach — and only `pointerType` differs. A touch `pointerdown` is dispatched before
    // its own `touchstart`, so this is the one moment a finger could start a pointer pan
    // too, and the one thing the touch layer's flag cannot have set yet.
    const pointerDown = (pointerType) => {
      const event = {
        pointerType,
        button: 0,
        pointerId: 1,
        clientX: 300,
        clientY: 400,
        target: targetIn(),
        currentTarget: wrap,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      for (const handler of (wrap._allListeners && wrap._allListeners.pointerdown) || []) handler(event);
      return event;
    };
    const pointerMoveTo = (x, y) => {
      for (const handler of listeners.pointermove || []) handler({ clientX: x, clientY: y, target: wrap });
    };
    const pointerUp = () => {
      for (const handler of listeners.pointerup || []) handler({});
    };
    const controlsBefore = camera();
    pointerDown('touch');
    pointerMoveTo(340, 360);
    const fingerAfter = camera();
    if (
      controlsBefore &&
      fingerAfter &&
      (Math.abs(fingerAfter.x - controlsBefore.x) > 0.01 || Math.abs(fingerAfter.y - controlsBefore.y) > 0.01)
    ) {
      problems.push(
        'a `pointerdown` from a finger started a pointer pan — that is a second pan running under the touch layer, ' +
          'so one finger moves the tree twice as far as it is dragged',
      );
    }
    // The control: the identical replay with a mouse pointer must pan, or "the finger did
    // not pan" would be satisfied by a pointer pan that is broken outright — and the
    // desktop drag is the behaviour this whole layer was added around, not instead of.
    pointerDown('mouse');
    pointerMoveTo(340, 360);
    const mouseAfter = camera();
    if (
      !controlsBefore ||
      !mouseAfter ||
      Math.abs(mouseAfter.x - controlsBefore.x - 40) > 0.01 ||
      Math.abs(mouseAfter.y - controlsBefore.y + 40) > 0.01
    ) {
      problems.push(
        'a mouse `pointerdown` + `pointermove` of (40, -40) moved the tree by ' +
          `(${round(mouseAfter ? mouseAfter.x - controlsBefore.x : NaN)}, ` +
          `${round(mouseAfter ? mouseAfter.y - controlsBefore.y : NaN)}) — the desktop drag has to keep working`,
      );
    }
    pointerUp();

    // (h) A finger on the resize corner drags the card. The corner used to be left to the
    // pointer path, and that is the bug this case exists for: the browser claims a touch
    // drag as a gesture of its own a few pixels in, so the drag ended in `pointercancel`
    // — which the window handler reads as "the resize was abandoned": the wireframe was
    // torn down mid-drag and the lift committed nothing. The corner is therefore the one
    // *card* gesture the touch layer claims, driving the very `beginResize` /
    // `onResizeMove` / `endResize(true)` a mouse drives. A tap and a `touchcancel` still
    // commit nothing, a second finger cancels the drag, and the pointer path has to leave
    // a finger's press alone: its `pointerdown` and the `touchstart` of the same press are
    // one corner, and two resizes would race for the card.
    //
    // The fixture is the card's box as a browser would report it (this stub has no layout
    // at all, so the numbers are handed over) and both are picked far from every clamp the
    // drag applies — `MIN_W` / `MAX_W`, the card's own floor and the drag's ceiling — so
    // what the assertions below read is the finger's travel converted through the camera
    // scale, and not a clamp. The pinch above left that scale at 1.25 (its own assertion
    // pins the number), so a drag of (80, -50) screen px is 64 × -40 canvas px: a
    // 600 × 500 card becomes 664 × 460, and the mouse's (60, -20) becomes 648 × 484.
    const cornerCard =
      canvas.children.find((child) => child.dataset && child.dataset.id && findByClass(child, 'node-resize')) || null;
    const cornerHandle = resizeCorner(cornerCard);
    const cornerId = cornerCard ? cornerCard.dataset.id : null;
    /** The card's box as the CSS carries it — both `NaN` when it carries no size at all. */
    const cornerBox = () =>
      `${round(parseFloat(cornerCard.style.width))} × ${round(parseFloat(cornerCard.style.maxHeight))}`;
    /** Is the card exactly (w, h)? A style with no size in it (`NaN`) is no size at all. */
    const cornerHeldAt = (w, h) =>
      Math.abs(parseFloat(cornerCard.style.width) - w) < 1e-6 &&
      Math.abs(parseFloat(cornerCard.style.maxHeight) - h) < 1e-6;
    if (!cornerCard || !cornerHandle) {
      problems.push(
        'the touch resize case found no card carrying a .node-resize corner in #tree-canvas — every card is built ' +
          'with one, so with none there a finger has no corner to drag and this whole case says nothing',
      );
    } else {
      // The box the browser would have given the card: a drag's start size, and the
      // ceiling it is clamped against, are both read off the element.
      cornerCard.offsetWidth = 600;
      cornerCard.offsetHeight = 500;
      posted.length = 0;
      const cornerPanBefore = camera();
      start(gestureEvent('touchstart', [touch(300, 400)], cornerHandle));
      const cornerMove = gestureEvent('touchmove', [touch(380, 350)], cornerHandle);
      move(cornerMove);
      // The wireframe has to be up *during* the drag — that is the whole point of it. The
      // bug being pinned here is precisely this element vanishing a few pixels in, which
      // left the user dragging a size nobody could see.
      const wireframe = findByClass(canvas, 'resize-preview');
      const wireframeLabel = wireframe ? findByClass(wireframe, 'resize-label') : null;
      if (!wireframe || !wireframeLabel || !String(wireframeLabel.textContent || '').trim()) {
        problems.push(
          'a touch drag well past the slop on .node-resize left no .resize-preview wireframe (with its ' +
            '.resize-label) in #tree-canvas — a corner drag with no preview is the reported bug, where the ' +
            "browser's own `pointercancel` tore the wireframe down mid-drag",
        );
      }
      if (!cornerMove.defaultPrevented) {
        problems.push(
          'the touchmove of a drag out of .node-resize was not `defaultPrevented` — the browser keeps its own touch ' +
            'gesture for that finger, and the `pointercancel` it sends a few pixels later is what abandoned the resize',
        );
      }
      const cornerPanAfter = camera();
      if (
        cornerPanBefore &&
        cornerPanAfter &&
        (Math.abs(cornerPanAfter.x - cornerPanBefore.x) > 0.01 ||
          Math.abs(cornerPanAfter.y - cornerPanBefore.y) > 0.01)
      ) {
        problems.push(
          `a touch drag out of .node-resize panned the tree by (${round(cornerPanAfter.x - cornerPanBefore.x)}, ` +
            `${round(cornerPanAfter.y - cornerPanBefore.y)}) — the corner owns the finger: a card that resizes and ` +
            'drags its own tree at the same time is not a resize',
        );
      }
      end(gestureEvent('touchend', [], cornerHandle));
      if (findByClass(canvas, 'resize-preview')) {
        problems.push(
          'the wireframe of a committed touch resize is still in #tree-canvas after the finger lifted — the lift ends ' +
            'the drag, and a preview left behind over a card that is already at its new size is not a preview',
        );
      }
      if (!cornerHeldAt(664, 460)) {
        problems.push(
          `a touch drag of (80, -50) on .node-resize left the card at ${cornerBox()}, expected 664 × 460 (600 × 500 ` +
            'plus the finger\'s own 64 × -40 canvas px, at the 1.25 scale the pinch above left) — the finger has to ' +
            'reach the same `onResizeMove` the mouse drives, and the lift has to write that size on the card',
        );
      }
      const cornerPosted = posted.filter((message) => message && message.type === 'setNodeSize');
      if (cornerPosted.length !== 1) {
        problems.push(
          `the lift of a touch resize posted ${JSON.stringify(cornerPosted)}, expected exactly one \`setNodeSize\` ` +
            `for ${JSON.stringify(cornerId)} with the dragged 664 × 460 — the host is what persists the size, and a ` +
            'card the host never hears about comes back at its old size on the next repaint',
        );
      } else if (cornerPosted[0].id !== cornerId || cornerPosted[0].w !== 664 || cornerPosted[0].h !== 460) {
        problems.push(
          `the lift of a touch resize posted ${JSON.stringify(cornerPosted[0])}, expected { type: 'setNodeSize', id: ` +
            `${JSON.stringify(cornerId)}, w: 664, h: 460 } — the size the wireframe advertised and the size the host ` +
            'is told have to be the same number, for the same card',
        );
      }

      // A tap on the corner is a tap. The mouse path has no such rule — it resizes from
      // the first pixel — which is why the slop is this layer's own: without it, every tap
      // meant for the corner (and that ends as a `click`) would leave a wireframe behind.
      posted.length = 0;
      start(gestureEvent('touchstart', [touch(300, 400)], cornerHandle));
      end(gestureEvent('touchend', [], cornerHandle));
      if (findByClass(canvas, 'resize-preview')) {
        problems.push(
          'a tap on .node-resize left its wireframe in #tree-canvas — a finger that never passed the slop has to leave ' +
            'the card exactly as it found it',
        );
      }
      if (!cornerHeldAt(664, 460)) {
        problems.push(
          `a tap on .node-resize (no travel past the slop) left the card at ${cornerBox()}, expected the 664 × 460 it ` +
            'already had — the corner may not resize on a lift that never became a drag',
        );
      }
      if (posted.some((message) => message && message.type === 'setNodeSize')) {
        problems.push(
          `a tap on .node-resize posted ${JSON.stringify(posted.filter((m) => m && m.type === 'setNodeSize'))} — the ` +
            'host must not be told about a size nobody dragged to',
        );
      }

      // A `touchcancel` mid-drag is the browser taking the gesture back (a system gesture,
      // the tab going away): the resize is abandoned and nothing may be written. This drag
      // ends on a *different* size on purpose — a cancel that committed anyway would
      // otherwise land on the number the committed drag above already left there.
      posted.length = 0;
      start(gestureEvent('touchstart', [touch(300, 400)], cornerHandle));
      const cancelMove = gestureEvent('touchmove', [touch(420, 300)], cornerHandle);
      move(cancelMove);
      cancel(gestureEvent('touchcancel', [], cornerHandle));
      if (findByClass(canvas, 'resize-preview')) {
        problems.push(
          'a cancelled touch resize left its wireframe in #tree-canvas — a `touchcancel` is the browser withdrawing ' +
            'the gesture, and the card is not being sized any more',
        );
      }
      if (!cornerHeldAt(664, 460)) {
        problems.push(
          `a touchcancel in the middle of a resize (a drag that would have reached 696 × 420) left the card at ` +
            `${cornerBox()}, expected the 664 × 460 it had — an abandoned drag is not a size change`,
        );
      }
      if (posted.some((message) => message && message.type === 'setNodeSize')) {
        problems.push(
          `a touchcancel in the middle of a resize posted ` +
            `${JSON.stringify(posted.filter((m) => m && m.type === 'setNodeSize'))} — nothing was lifted, so nothing ` +
            'may be persisted',
        );
      }

      // The two layers must not both see one finger, and this is the corner's half of the
      // (g) case above: the very same pointer event replayed twice, only `pointerType`
      // differing. A finger's `pointerdown` is dispatched *before* its own `touchstart`, so
      // it is the one moment a touch could start a pointer resize too — and one press that
      // resized twice would leave the two of them fighting over the card on the lift.
      const cornerPointer = (pointerType) => {
        const event = {
          pointerType,
          button: 0,
          pointerId: 1,
          clientX: 300,
          clientY: 400,
          target: cornerHandle,
          currentTarget: canvas,
          defaultPrevented: false,
          preventDefault() {
            this.defaultPrevented = true;
          },
          stopPropagation() {
            this.stopped = true;
          },
        };
        for (const handler of (canvas._allListeners && canvas._allListeners.pointerdown) || []) handler(event);
        return event;
      };
      posted.length = 0;
      cornerPointer('touch');
      pointerMoveTo(360, 380);
      if (findByClass(canvas, 'resize-preview')) {
        problems.push(
          'a touch `pointerdown` + `pointermove` on .node-resize started a pointer resize — that press is the one the ' +
            "touch layer's own corner gesture is for, so the same finger would resize the card twice",
        );
      }
      pointerUp();
      if (!cornerHeldAt(664, 460) || posted.some((message) => message && message.type === 'setNodeSize')) {
        problems.push(
          `a touch pointer stream on .node-resize resized the card behind the finger: it is now at ${cornerBox()} ` +
            `and posted ${JSON.stringify(posted.filter((m) => m && m.type === 'setNodeSize'))}, expected 664 × 460 ` +
            'and nothing posted',
        );
      }
      // The control: the identical replay with a mouse pointer has to resize. "A finger did
      // not" would otherwise be satisfied by a corner that stopped working outright, and
      // the desktop drag is the behaviour this layer was added around, not instead of.
      cornerPointer('mouse');
      if (!findByClass(canvas, 'resize-preview')) {
        problems.push(
          'a mouse `pointerdown` on .node-resize started no resize — the desktop corner has to keep working, and with ' +
            'none up a wireframe the mouse drag would commit a size nobody saw',
        );
      }
      pointerMoveTo(360, 380);
      pointerUp();
      if (!cornerHeldAt(648, 484)) {
        problems.push(
          `a mouse drag of (60, -20) on .node-resize left the card at ${cornerBox()}, expected 648 × 484 (600 × 500 ` +
            "plus the pointer's 48 × -16 canvas px) — the mouse entry point and the finger's have to be the same " +
            'gesture, or the two inputs drift apart and only the phone notices',
        );
      }

      // A second finger is not a resize: the wireframe belongs to a corner, and the corner
      // is not where the pinch is. The drag is cancelled where it stands (nothing
      // committed) and the two fingers become the pinch this layer already knows.
      posted.length = 0;
      const twoFingerW = parseFloat(cornerCard.style.width);
      const twoFingerH = parseFloat(cornerCard.style.maxHeight);
      start(gestureEvent('touchstart', [touch(300, 400)], cornerHandle));
      move(gestureEvent('touchmove', [touch(360, 350)], cornerHandle));
      start(gestureEvent('touchstart', [touch(300, 400), touch(400, 400)], cornerHandle));
      if (findByClass(canvas, 'resize-preview')) {
        problems.push(
          'a second finger landing during a resize left the wireframe up — the drag is over the moment the gesture is ' +
            'a pinch, and a preview kept over a card nobody is dragging is the same lie as one torn down mid-drag',
        );
      }
      end(gestureEvent('touchend', [], cornerHandle));
      if (!cornerHeldAt(twoFingerW, twoFingerH)) {
        problems.push(
          `a second finger landing mid-resize left the card at ${cornerBox()}, expected the ${round(twoFingerW)} × ` +
            `${round(twoFingerH)} it had — the fingers that replaced the drag may not commit it`,
        );
      }
      if (posted.some((message) => message && message.type === 'setNodeSize')) {
        problems.push(
          `a second finger landing mid-resize posted ` +
            `${JSON.stringify(posted.filter((m) => m && m.type === 'setNodeSize'))} — a cancelled drag is not a size`,
        );
      }
    }

    notes.push(
      'touch: one finger pans a card 1:1 (and only once), a tap and a 2px wobble stay uncancelled, the five ' +
        'native-scroll zones neither pan nor cancel, a finger on the resize corner drags a wireframe and commits ' +
        'that size (a tap, a touchcancel and a second finger commit nothing), a 1.5× pinch frame scales by the 1.25 ' +
        'cap around the fingers\' midpoint, and a touch pointerdown starts neither a pointer drag nor a pointer ' +
        'resize while a mouse one still does both',
    );
  }
}

// --- report ------------------------------------------------------------------

/**
 * The perf probes publish on a later task: the traced burst is flushed once it has
 * been quiet for a moment (so a burst of `reset`/`tree`/`path` collapses into one
 * report) and the report itself waits for a frame. Give them that task before
 * deciding — a probe is diagnostics, but a probe that silently stopped reporting is
 * still a broken webview, and this is the only place it can be seen without a live
 * host. The delay has to outlast the webview's own coalescing window
 * (`media/main.js` `BURST_QUIET_MS`, 50 ms), and it is what the stall probes' frame
 * answers need too: `probe` / `nudge` report from a `requestAnimationFrame`
 * callback (the sandbox runs one on a timer), so those reports are due here.
 */
setTimeout(() => {
  /** `paint`, `probe#1`, `drop` … — what the probes did post, for the messages below. */
  const seen = diagnostics.map(
    (report) => String(report.kind || '?') + (report.id === undefined ? '' : '#' + report.id),
  );
  /** The reports of one kind, and of one probe id when the shape carries one. */
  const reportOf = (kind, id) =>
    diagnostics.find((report) => report.kind === kind && (id === undefined || report.id === id));

  const paint = diagnostics.find((report) => report.kind === 'paint' && report.traceId === 1);
  if (!paint) {
    problems.push(
      'the perf probes reported nothing for the traced repaint (a `reset` carrying `traceId`) — ' +
        `posted ${JSON.stringify(diagnostics)}`,
    );
  } else if (typeof paint.since !== 'number' || typeof paint.cards !== 'number') {
    problems.push(`the traced repaint reported ${JSON.stringify(paint)}, expected numeric timings`);
  }

  // --- the stall probes ("the tab stopped painting") --------------------------
  // The host has two questions for a tab that went quiet — `probe` ("what have you
  // counted?") and `nudge` ("can you still take a frame?") — and the answers are the
  // only thing that tells a painted-but-frozen tab from an idle one; without them a
  // dead webview reads as "nothing happened". They are diagnostics, so they are
  // allowed to be narrow — but not to stop, which is the one failure nothing else
  // here sees. Every probe of the pair is asserted separately, so a missing handler
  // cannot hide behind the paint report above.
  {
    const probe = reportOf('probe', 1);
    if (!probe) {
      problems.push(
        'a `probe` message posted no `kind: "probe"` report with id 1 — the host reads the tab through it, and a ' +
          `tab that stopped answering would look idle; posted ${JSON.stringify(diagnostics)}`,
      );
    } else {
      const numbers = ['msgs', 'drops', 'frames', 'lastFrame', 'dom', 'cards', 'hiddenMs'];
      const notNumbers = numbers.filter((field) => typeof probe[field] !== 'number');
      if (notNumbers.length > 0) {
        problems.push(`the probe report's ${notNumbers.join(', ')} (id 1) is not numeric: ${JSON.stringify(probe)}`);
      }
      // The four strings are the readout the probe exists for: where the canvas and
      // its wrapper sit, how large the window is, what document state the tab is in.
      // All four *are* producible in this sandbox — `readyState` / `visibilityState`
      // were added to the DOM stub for exactly this (see `document` above) — so an
      // empty one is a broken probe, not a sandbox limitation being papered over.
      const strings = ['canvas', 'wrap', 'inner', 'readyState'];
      const notStrings = strings.filter((field) => typeof probe[field] !== 'string' || probe[field].length === 0);
      if (notStrings.length > 0) {
        problems.push(
          `the probe report's ${notStrings.join(', ')} (id 1) is not a non-empty string: ${JSON.stringify(probe)}`,
        );
      }
      // This run routed one message to a node id no `tree` declared, and the probe
      // was sent after it: a counter that stayed at 0 would still be "numeric" (the
      // sentence above) while saying nothing at all.
      if (typeof probe.drops === 'number' && probe.drops < 1) {
        problems.push(
          `the probe report counted ${probe.drops} drop(s) although a message routed to ${UNKNOWN_NODE_ID} was ` +
            'discarded — the probe counter is not wired to the drop path',
        );
      }
    }

    // The frame half of each probe. Neither can be missed for the sandbox's sake:
    // `requestAnimationFrame` here is a `setTimeout`, so a probe that asks for a
    // frame *always* gets one — a missing report means the probe stopped asking.
    for (const [kind, id, cause] of [
      ['probe-frame', 1, 'the `probe` message'],
      ['nudge-frame', 2, 'the `nudge` message'],
    ]) {
      const frame = reportOf(kind, id);
      if (!frame) {
        problems.push(
          `${cause} posted no \`kind: "${kind}"\` report with id ${id} — the probe never reached a ` +
            `requestAnimationFrame callback; posted ${JSON.stringify(diagnostics)}`,
        );
      } else if (typeof frame.ms !== 'number') {
        problems.push(`the ${kind} report (id ${id}) carries no numeric \`ms\`: ${JSON.stringify(frame)}`);
      }
    }

    // The drop counter's other half, and the assertion this whole fixture exists for:
    // the *report* a routed message leaves behind when it finds no card. Before it,
    // "routeTo found no card for this node" was a silent early return, so the message
    // could not be traced anywhere — not in the UI, not in the diagnostics log.
    const drop = diagnostics.find((report) => report.kind === 'drop' && report.node === UNKNOWN_NODE_ID);
    if (!drop) {
      problems.push(
        `no \`kind: "drop"\` report for ${UNKNOWN_NODE_ID} — a routed message with no card to land in was ` +
          `discarded silently; posted ${JSON.stringify(diagnostics)}`,
      );
    } else if (typeof drop.n !== 'number') {
      problems.push(`the drop report for ${UNKNOWN_NODE_ID} carries no numeric \`n\`: ${JSON.stringify(drop)}`);
    }
  }

  notes.push(`perf probes: ${diagnostics.length} report(s): ${seen.join(', ') || 'none'}`);

  if (problems.length > 0) {
    console.error('check-webview: the chat webview does not survive the provider\n');
    for (const problem of new Set(problems)) {
      console.error('  ' + problem);
    }
    console.error(
      '\nDispatched messages: ' +
        TURN_MESSAGES.map((message) => message.type).join(', ') +
        '\nAdd any new provider message type to TURN_MESSAGES in tools/check-webview.js.',
    );
    process.exit(1);
  }

  console.log(`check-webview: OK — ${TURN_MESSAGES.length} messages, ${notes.join(', ')}.`);
  // Exit explicitly, the same way the failure path above does: the webview's own
  // token meter is a `setInterval` (media/main.js `tpsTimer`) and the frame watch
  // keeps a frame loop alive, so a green run otherwise leaves timers pending
  // forever — the process would hang after printing OK (which reads as "the
  // checker is slow/stuck" to whoever ran it from a shell).
  process.exit(0);
}, 150);
