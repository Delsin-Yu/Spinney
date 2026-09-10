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
//       image affordances, the context readout and the composer's Send/Stop pair
//       are checked explicitly, plus the P2 background docks (each job has to end
//       up in the card of the node that owns it — see the bottom of this file).
//
// The DOM stub resolves a plain `.class` selector against the element's own
// subtree, so "which card holds this dock" is answerable per card.
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
const TURN_MESSAGES = [
  { type: 'reset' },
  { type: 'state', busy: false, status: '', sessionId: 'smoke-session' },
  // Structural preamble: one node, checked out and streamed into. The composer
  // assertions below need a real card, a real `treeActiveId` and a `viewId`.
  {
    type: 'tree',
    viewId: NODE_ID,
    activeId: null,
    rootId: NODE_ID,
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
      },
    ],
  },
  { type: 'path', ids: [NODE_ID], nodes: [{ id: NODE_ID, status: 'running', items: [] }] },
  {
    type: 'config',
    model: 'smoke-model',
    models: ['smoke-model', 'smoke-vision-model'],
    visionModels: ['smoke-vision-model'],
    thinkingEffort: 'medium',
    foldToolCalls: true,
    foldThinking: true,
  },
  { type: 'context', used: 524288, total: 1048576, model: 'smoke-model' },
  { type: 'sessionStats', stats: { totalTokens: 3, cacheHit: 0, cacheMiss: 3, cacheHitRate: 0, cacheKnown: true } },
  { type: 'balance', balance: { isAvailable: true, balances: [] } },
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
        elapsed: 1,
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
  { type: 'toolStart', nodeId: NODE_ID, index: 0, id: 'smoke-tool', name: 'read_file', args: '{"path":"a"}' },
  { type: 'toolEnd', nodeId: NODE_ID, id: 'smoke-tool', content: 'ok' },
  { type: 'delta', nodeId: NODE_ID, text: 'smoke answer' },
  { type: 'thinkingDelta', nodeId: NODE_ID, text: 'smoke thought' },
  { type: 'usage', nodeId: NODE_ID, usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  { type: 'agentStart', id: 'smoke-agent', name: 'smoke agent', instruction: 'smoke', model: 'smoke-model' },
  { type: 'agentDone', id: 'smoke-agent', status: 'done', summary: 'smoke summary' },
  { type: 'nodeUpdate', id: NODE_ID, status: 'done', title: 'smoke', usage: null },
  { type: 'panTo', id: NODE_ID },
  // An in-place continue writes an inline harness block into that node's own
  // transcript (see the ▶ section below).
  { type: 'harnessNote', nodeId: NODE_ID, text: 'Continue from where you stopped.' },
  // End-of-run messages carry the node that finished, so the webview finalizes
  // *that* card and only releases the scroll lock when it is the focused one.
  { type: 'done', nodeId: NODE_ID },
  { type: 'interrupted', nodeId: NODE_ID },
  { type: 'error', nodeId: NODE_ID, message: 'smoke error' },
  // The legacy (nodeId-less) shape must keep working for a host that predates P1.
  { type: 'done' },
  { type: 'interrupted' },
  { type: 'error', message: 'smoke error' },
];

// --- a DOM just big enough to let the script run ------------------------------

const listeners = {};
const elements = new Map();
/** Every message the webview posts to the host, so a button's wiring can be checked. */
const posted = [];

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

function makeElement(id) {
  const element = {
    id,
    children: [],
    options: [],
    dataset: {},
    value: '',
    textContent: '',
    innerHTML: '',
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
    appendChild(child) {
      this.children.push(child);
      if (child && typeof child === 'object') child.parentElement = this;
      return child;
    },
    prepend(child) {
      this.children.unshift(child);
      if (child && typeof child === 'object') child.parentElement = this;
      return child;
    },
    insertBefore(child) {
      this.children.push(child);
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
      const parent = this.parentElement;
      if (parent && Array.isArray(parent.children)) {
        const at = parent.children.indexOf(this);
        if (at >= 0) parent.children.splice(at, 1);
      }
      this.parentElement = null;
    },
    replaceChildren() {},
    setAttribute() {},
    getAttribute: () => null,
    removeAttribute() {},
    hasAttribute: () => false,
    addEventListener(type, handler) {
      (this._listeners ??= {})[type] = handler;
    },
    removeEventListener() {},
    // A plain `.class` selector resolves against *this* element's own subtree, so
    // two node cards can no longer share one stub for `.node-bg` / `.node-items`
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
      this.children.push(node);
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
  if (id === 'effort-select') {
    element.options = ['none', 'low', 'medium', 'high'].map((value) => ({ value, selected: false }));
  }
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
    postMessage: (message) => posted.push(message),
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
    observe() {}
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

const effortSelected = elementById('effort-select')
  .options.filter((option) => option.selected)
  .map((option) => option.value);
if (effortSelected.join(',') !== 'medium') {
  problems.push(
    `the thinking-effort dropdown shows ${JSON.stringify(effortSelected)} after a config carrying "medium"`,
  );
}

const modelOptions = elementById('model-select').children.map((child) => child.value);
if (modelOptions.length === 0) {
  problems.push('the model dropdown is empty after a config carrying `models`');
}
notes.push(`model dropdown: ${modelOptions.join(', ') || '(empty)'}`);

const contextLabel = elementById('context-label').textContent;
if (contextLabel !== 'ctx 50%') {
  problems.push(`the context readout shows ${JSON.stringify(contextLabel)} for 524288/1048576 (expected "ctx 50%")`);
}

// Image affordances follow the vision list the provider posts.
{
  const treeCanvas = elementById('tree-canvas');
  const withVision = { ...TURN_MESSAGES.find((m) => m.type === 'config'), model: 'smoke-vision-model' };
  const withoutVision = { ...withVision, model: 'smoke-model' };
  dispatch(withVision);
  const visibleWithVision = !treeCanvas.classList.contains('hide-images');
  dispatch(withoutVision);
  const hiddenWithoutVision = treeCanvas.classList.contains('hide-images');
  if (!visibleWithVision || !hiddenWithoutVision) {
    problems.push(
      'the image affordances do not follow `visionModels` (thumbnails should show for a vision model and hide otherwise)',
    );
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
      elapsed: 1,
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
    const items = findByClass(cardOf(B), 'node-items');
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

// --- The ▶ Continue / ↻ Retry button ------------------------------------------
// A turn that ended without an answer — interrupted by the user, or failed on an
// API error that outlived the client's retries — offers a button that asks the
// harness to run a turn from that node with a message the harness writes itself,
// so the user never has to type "continue". It may only appear where continuing
// makes sense, and it must post the node it belongs to.
{
  const R = 'cont-node-root';
  const A = 'cont-node-a';       // interrupted tip → ▶ Continue
  const B = 'cont-node-b';       // failed tip → ↻ Retry
  const C = 'cont-node-c';       // interrupted, but already continued → no button
  const D = 'cont-node-d';       // the continuation of C (done)
  const SUB = 'cont-node-sub';   // `kind:'agent'` sidecar, interrupted → no button
  const node = (id, parentId, children, status, kind) =>
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
    );
  const tree = (aStatus) => ({
    type: 'tree',
    viewId: B,
    activeId: null,
    rootId: R,
    nodes: [
      node(R, null, [A, B, C, SUB], 'done'),
      node(A, R, [], aStatus),
      node(B, R, [], 'error'),
      node(C, R, [D], 'interrupted'),
      node(D, C, [], 'done'),
      node(SUB, R, [], 'interrupted', 'agent'),
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
  if (findByClass(cards.get(A), 'node-prompt') && findByClass(findByClass(cards.get(A), 'node-prompt'), 'harness-note')) {
    problems.push('a harness continue message overwrote the node\'s pinned user prompt');
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
}

// --- report ------------------------------------------------------------------

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
// token meter is a `setInterval` (media/main.js `tpsTimer`), and a green run
// otherwise leaves it pending forever — the process would hang after printing OK
// (which reads as "the checker is slow/stuck" to whoever ran it from a shell).
process.exit(0);
