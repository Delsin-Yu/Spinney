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
  // A sub-agent card carries no transcript in `tree` (only `itemCount`), so an
  // expanded one asks for it and renders the host's `agentItems` answer — the two
  // shapes are checked in the lazy-sidecar section at the bottom of this file.
  { type: 'agentItems', id: NODE_ID, items: [] },
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
        element.children.length = 0;
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
  const subItems = sub ? findByClass(sub, 'node-items') : null;
  if (!subItems) {
    problems.push('an agent card has no `.node-items` container');
  } else {
    const before = subItems.children.length;
    if (before !== 0) {
      problems.push(`a sub-agent card rendered ${before} item(s) before its transcript arrived (the tree carries only itemCount)`);
    }
    dispatch({ type: 'agentItems', id: SUB, items: [{ kind: 'assistant', text: '子代理答案' }] });
    const after = subItems.children.length;
    if (after !== 1) {
      problems.push(`an agentItems answer produced ${after} item(s) in the card, expected 1`);
    }
    dispatch({ type: 'agentItems', id: SUB, items: [{ kind: 'assistant', text: '子代理答案' }] });
    if (subItems.children.length !== after) {
      problems.push(
        `a second agentItems answer re-rendered the transcript (${after} → ${subItems.children.length} items) — ` +
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
  const inlineItems = checkedOut ? findByClass(checkedOut, 'node-items') : null;
  if (!inlineItems || inlineItems.children.length === 0) {
    problems.push('a `path` carrying items no longer renders them (a checked-out sidecar must render immediately)');
  }
}

// --- The ▶ Continue / ↻ Retry / ⧉ rollover button -------------------------------
// A turn that ended without an answer — interrupted by the user, or failed on an
// API error that outlived the client's retries — offers a button that asks the
// harness to run a turn from that node with a message the harness writes itself,
// so the user never has to type "continue". It may only appear where continuing
// makes sense, and it must post the node it belongs to. One failure is special: a
// provider context-length error (the host ships `contextFull`, contract §3/§4) is
// not retryable, so the button is *replaced* by the rollover variant, which posts
// `rolloverTurn`. The same fixture carries a window-starting node, whose card wears
// the `CTX` badge and whose own connector — not its descendants' — is dashed.
{
  const R = 'cont-node-root';
  const A = 'cont-node-a';       // interrupted tip → ▶ Continue
  const B = 'cont-node-b';       // failed tip → ↻ Retry
  const C = 'cont-node-c';       // interrupted, but already continued → no button
  const D = 'cont-node-d';       // the continuation of C (done)
  const F = 'cont-node-f';       // failed on a full context window → ⧉ rollover
  const G = 'cont-node-g';       // interrupted *and* contextFull → still ▶ Continue
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
    nodes: [
      node(R, null, [A, B, C, F, G, SUB, WIN], 'done'),
      node(A, R, [], aStatus),
      node(B, R, [], 'error'),
      node(C, R, [D], 'interrupted'),
      node(D, C, [], 'done'),
      // `contextFull` arrives on every node (the host computes it once, §3): only a
      // turn that died on the provider's context-length error carries `true`.
      node(F, R, [], 'error', undefined, { contextFull: true }),
      // The flag alone must not roll anything over — `interrupted` keeps ▶ Continue.
      node(G, R, [], 'interrupted', undefined, { contextFull: true }),
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
      'a node whose turn died on a full context window (error + contextFull) shows no `⧉ Continue in a new window` button',
    );
  } else {
    if (!hasClass(rollover, 'node-rollover')) {
      problems.push('the rollover button does not carry the `node-rollover` class the styling and the guard read');
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

  // The judgement is made by the host and can arrive *after* the tree was drawn
  // (that is exactly how a turn dies on a context-length error), so a `nodeUpdate`
  // has to carry the flag and re-sync the button on the card it already shows.
  dispatch({ type: 'nodeUpdate', id: B, status: 'error', title: B, contextFull: true });
  const switched = buttonOf(B);
  if (
    !switched ||
    switched.textContent !== '⧉ Continue in a new window' ||
    !hasClass(switched, 'node-rollover') ||
    switched.dataset.action !== 'rollover'
  ) {
    problems.push('a `nodeUpdate` carrying contextFull: true did not switch a ↻ Retry card to the rollover button');
  } else {
    posted.length = 0;
    if (typeof switched._listeners?.click === 'function') switched._listeners.click({ stopPropagation() {} });
    const sent = posted.find((message) => message && message.type === 'rolloverTurn');
    if (!sent || sent.id !== B) {
      problems.push(
        `after the flag arrived by \`nodeUpdate\`, clicking posted ${JSON.stringify(posted)}, expected { type: 'rolloverTurn', id: '${B}' }`,
      );
    }
  }
  // And the flag is not sticky: a later patch that clears it goes back to Retry.
  dispatch({ type: 'nodeUpdate', id: B, status: 'error', title: B, contextFull: false });
  const back = buttonOf(B);
  if (!back || back.textContent !== '↻ Retry' || hasClass(back, 'node-rollover') || back.dataset.action !== 'retry') {
    problems.push('a `nodeUpdate` with contextFull: false did not switch the card back to ↻ Retry');
  }

  // A full window is only a *failure* mode: an interrupted node keeps ▶ Continue
  // even when the host's flag is set (there is no refused request to roll over).
  const interruptedFlagged = buttonOf(G);
  if (!interruptedFlagged || interruptedFlagged.textContent !== '▶ Continue') {
    problems.push('an interrupted node carrying contextFull: true no longer shows ▶ Continue (only a failed turn rolls over)');
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
  // Both fold defaults ON: the live block is the exception this section is about.
  dispatch({
    type: 'config',
    model: 'smoke-model',
    models: ['smoke-model'],
    visionModels: [],
    thinkingEffort: 'medium',
    foldToolCalls: true,
    foldThinking: true,
  });
  dispatch({ type: 'state', busy: true, status: '', sessionId: 'fold-session', runningNodes: [NODE] });

  const cardOf = () =>
    Array.from(elementById('tree-canvas').children).find((child) => child.dataset && child.dataset.id === NODE);
  const msgsOf = () => {
    const items = cardOf() ? findByClass(cardOf(), 'node-items') : null;
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

// --- report ------------------------------------------------------------------

/**
 * The perf probes publish on a later task: the traced burst is flushed once it has
 * been quiet for a moment (so a burst of `reset`/`tree`/`path` collapses into one
 * report) and the report itself waits for a frame. Give them that task before
 * deciding — a probe is diagnostics, but a probe that silently stopped reporting is
 * still a broken webview, and this is the only place it can be seen without a live
 * host. The delay has to outlast the webview's own coalescing window
 * (`media/main.js` `BURST_QUIET_MS`, 50 ms).
 */
setTimeout(() => {
  const paint = diagnostics.find((report) => report.kind === 'paint' && report.traceId === 1);
  if (!paint) {
    problems.push(
      'the perf probes reported nothing for the traced repaint (a `reset` carrying `traceId`) — ' +
        `posted ${JSON.stringify(diagnostics)}`,
    );
  } else if (typeof paint.since !== 'number' || typeof paint.cards !== 'number') {
    problems.push(`the traced repaint reported ${JSON.stringify(paint)}, expected numeric timings`);
  } else {
    notes.push(`perf probes: ${diagnostics.length} report(s)`);
  }

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
