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
  acquireVsCodeApi: () => ({ postMessage() {}, getState: () => undefined, setState() {} }),
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

// --- P2: the background dock lives in the owning node's card ------------------
// `backgrounds` is one flat snapshot whose tasks are tagged with the node that
// owns them. Every task must land in *its own* node's dock (never in another
// card's), a collapsed card must keep only the compact one-line summary, and a
// node that owns nothing must keep a hidden dock.
{
  const A = 'dock-node-a';   // root, on the view path (expanded)
  const B = 'dock-node-b';   // child, view focus (expanded)
  const C = 'dock-node-c';   // child, off the path (collapsed) — owns a job
  const D = 'dock-node-d';   // child, off the path — owns nothing
  const node = (id, parentId, children) => ({
    id,
    parentId,
    children,
    title: id,
    status: 'done',
    createdAt: 0,
    preview: id + ' preview',
    usage: null,
    size: null,
  });
  const task = (id, nodeId, command, extra) => ({
    id,
    nodeId,
    command,
    status: 'running',
    exitCode: null,
    killed: false,
    elapsed: 1,
    truncated: false,
    outputTail: command + ' output',
    pendingDelivery: false,
    ...(extra || {}),
  });

  dispatch({ type: 'tree', viewId: B, activeId: null, rootId: A, nodes: [node(A, null, [B, C, D]), node(B, A, []), node(C, A, []), node(D, A, [])] });
  dispatch({ type: 'path', ids: [A, B], nodes: [{ id: A, status: 'done', items: [] }, { id: B, status: 'done', items: [] }] });

  const cards = new Map();
  for (const child of elementById('tree-canvas').children) {
    if (child.dataset && child.dataset.id) cards.set(child.dataset.id, child);
  }
  const cardOf = (id) => cards.get(id);
  // A dock only counts when it really is a child of that card: `querySelector`
  // falls back to a shared stub on a miss, which must not read as "there".
  const dockOf = (id) => {
    const card = cardOf(id);
    if (!card) return null;
    const dock = card.querySelector('.node-bg');
    return dock && card.children.indexOf(dock) >= 0 ? dock : null;
  };
  const itemsOf = (dock) => ((dock && dock.querySelector('.bg-dock-list')) || { children: [] }).children
    .filter((child) => hasClass(child, 'bg-item'));

  // (a) The message must not throw: a `backgrounds` handler that touches the
  // deleted standalone panel would fail silently in the real webview.
  if (dispatch({ type: 'backgrounds', tasks: [task(7, A, 'smoke-a'), task(8, B, 'smoke-b'), task(9, C, 'smoke-c')] })) {
    problems.push('a `backgrounds` message threw — the webview no longer understands the provider\'s shape');
  }

  // (b) Each node's card has its own dock holding exactly its own task.
  const expectDock = (id, taskId, command) => {
    const card = cardOf(id);
    if (!card) {
      problems.push(`no card was rendered for node ${id}`);
      return;
    }
    const dock = dockOf(id);
    if (!dock) {
      problems.push(`node ${id} has no .node-bg dock inside its card`);
      return;
    }
    if (hasClass(dock, 'hidden')) {
      problems.push(`node ${id} owns a background task but its dock is hidden`);
      return;
    }
    const items = itemsOf(dock);
    if (items.length !== 1) {
      problems.push(`node ${id}'s dock holds ${items.length} background items, expected exactly 1`);
      return;
    }
    const idText = String((items[0].querySelector('.bg-id') || {}).textContent);
    const cmdText = String((items[0].querySelector('.bg-cmd') || {}).textContent);
    if (idText !== '#' + taskId || cmdText !== command) {
      problems.push(
        `node ${id}'s dock shows ${JSON.stringify(idText + ' ' + cmdText)}, expected just its own task ` +
          `#${taskId} (${command}) — the tasks were not grouped by nodeId`,
      );
    }
    if (!findByClass(items[0], 'bg-kill')) {
      problems.push(`the running task in node ${id}'s dock has no kill button`);
    }
  };
  expectDock(A, 7, 'smoke-a');
  expectDock(B, 8, 'smoke-b');
  expectDock(C, 9, 'smoke-c');

  // A collapsed card keeps the dock, but as the compact one-line summary only
  // (the per-task rows stay in the DOM and come back when it is re-expanded).
  {
    const dockC = dockOf(C);
    if (!hasClass(cardOf(C), 'expanded')) {
      const summary = String((dockC.querySelector('.bg-dock-count') || {}).textContent);
      if (!hasClass(dockC, 'collapsed') || summary !== '1 background task · 1 running') {
        problems.push(
          `a collapsed card's dock shows ${JSON.stringify(summary)} (collapsed=${hasClass(dockC, 'collapsed')}), ` +
            'expected the compact "1 background task · 1 running" summary',
        );
      }
      const kills = findByClass(dockC, 'bg-dock-kills');
      if (!kills || kills.children.length === 0) {
        problems.push("the collapsed card's dock has no kill button for its running task");
      }
    } else {
      problems.push(`node ${C} was expected to be collapsed but its card is expanded`);
    }
  }

  // (c) A node with no tasks keeps a dock that is hidden.
  {
    const dockD = dockOf(D);
    if (!dockD) {
      problems.push(`node ${D} owns nothing but has no dock element at all`);
    } else if (!hasClass(dockD, 'hidden') || itemsOf(dockD).length !== 0) {
      problems.push(`node ${D} owns no background task but its dock is visible / not empty`);
    }
  }

  // (d) A snapshot that no longer lists a node's job removes the row and hides
  // that node's dock again (a delivered job must not leave a stale row behind).
  dispatch({ type: 'backgrounds', tasks: [task(7, A, 'smoke-a'), task(8, B, 'smoke-b')] });
  {
    const dockC = dockOf(C);
    const left = itemsOf(dockC).length;
    if (!hasClass(dockC, 'hidden') || left !== 0) {
      problems.push(`node ${C}'s dock kept ${left} item(s) after its job left the snapshot (expected a hidden dock)`);
    }
    if (itemsOf(dockOf(A)).length !== 1) {
      problems.push(`node ${A}'s dock changed when another node's job left the snapshot`);
    }
  }

  // The legacy nodeId-less shape renders into the view focus node's dock.
  dispatch({ type: 'background', tasks: [task(11, undefined, 'smoke-legacy')] });
  {
    const legacyDock = dockOf(B);
    const ids = itemsOf(legacyDock).map((item) => String((item.querySelector('.bg-id') || {}).textContent));
    if (ids.indexOf('#11') < 0) {
      problems.push(
        `a legacy (nodeId-less) \`background\` message did not render into the view focus node's dock ` +
          `(node ${B} shows ${JSON.stringify(ids)})`,
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
