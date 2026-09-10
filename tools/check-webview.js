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
//       image affordances and the context readout are checked explicitly.
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
  { type: 'tree', nodes: [], edges: [] },
  { type: 'path', items: [] },
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
  { type: 'backgroundNotice', item: { id: 'smoke-bg', name: 'smoke', doneText: 'done', content: 'x' } },
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
  { type: 'done' },
  { type: 'interrupted' },
  { type: 'error', message: 'smoke error' },
];

// --- a DOM just big enough to let the script run ------------------------------

const listeners = {};
const elements = new Map();

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
        return on;
      },
      add: (name) => element.classList._set.add(name),
      remove: (name) => element.classList._set.delete(name),
      contains: (name) => element.classList._set.has(name),
    },
    style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    prepend(child) {
      this.children.unshift(child);
      return child;
    },
    insertBefore(child) {
      this.children.push(child);
      return child;
    },
    removeChild() {},
    remove() {},
    replaceChildren() {},
    setAttribute() {},
    getAttribute: () => null,
    removeAttribute() {},
    hasAttribute: () => false,
    addEventListener(type, handler) {
      (this._listeners ??= {})[type] = handler;
    },
    removeEventListener() {},
    querySelector: (selector) => selectorStub(`${id} ${selector}`),
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

function elementById(id) {
  if (!elements.has(id)) {
    elements.set(id, makeElement(id));
  }
  return elements.get(id);
}

const document = {
  getElementById: elementById,
  createElement: (tag) => makeElement(tag),
  createDocumentFragment: () => makeElement('fragment'),
  createTextNode: (text) => ({ textContent: text }),
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
