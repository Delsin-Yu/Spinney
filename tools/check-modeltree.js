// check-modeltree.js — fails the build when the Model Card Tree page stops
// understanding the host.
//
// `media/modeltree.js` is plain JS: neither `tsc` (it is not TypeScript) nor
// `check-models.js` (it looks for model ids) reads it, and `node --check` only sees
// syntax. That leaves the failure mode `tools/check-webview.js` exists for: a
// handler that references something that no longer exists throws *inside* the
// webview, where nothing is logged and the page silently keeps its previous
// values — and on this page "silently keeps its previous values" means a settings
// edit that looks applied and never was.
//
// So this script loads `media/modeltree.js` into an in-memory DOM (no browser, no
// VS Code), plus the vendored layout engine the HTML shell loads before it, and
// checks the protocol end to end:
//
//   (a) the page posts `ready` exactly once at boot and registered a message
//       listener (without it the host's snapshot would be ignored),
//   (b) the ids the script fetches are exactly the ids the HTML shell declares
//       (`src/chat/ModelPanel.ts` is read as text for that), so a container that was
//       renamed or dropped shows up here instead of as a null dereference at boot,
//   (c) a `modelTree` snapshot becomes one card per provider/card on the canvas,
//       placed by the layout engine, and the connector layer has a real viewport:
//       `#mt-canvas` and the `<svg>` carry the same positive size, there is exactly
//       one `<path>` per model card that has a provider, and each path starts on its
//       provider's bottom edge and lands on its card's top edge,
//   (d) the *selected* card element is the form: it holds every field (name in its
//       head, the read-only id, the request preview), while an unselected card holds
//       none — there is no docked inspector any more,
//   (e) a keystroke inside a field moves nothing and rebuilds nothing (the tree's
//       boxes, the connector layer's size and the card element itself are unchanged
//       afterwards) but flips Save on, and the save payload carries the edit; a
//       re-layout happens when the *shape* changes
//       instead — adding an effort level re-measures the card taller, removing it puts
//       the height back (the two-pass layout),
//   (f) a `modelTreeSaveResult` with `ok: false` neither throws nor clears the
//       dirty draft, and the host's reason reaches the banner,
//   (g) a full add-card → save round trip posts the whole desired payload — the
//       new card with a locally generated v4 UUID, trimmed fields, and neither
//       `hasKey` nor `isBuiltin`,
//   (h) an invalid draft is blocked client-side before anything is posted, a card
//       whose provider no longer exists is not drawn at all (no card, no connector),
//       and a draft with no nodes shows the empty state instead of a blank page,
//   (i) moving a card to another provider re-parents it: its connector now leaves the
//       new provider (`data-from`), the new provider's card count badge says so, and
//       the card sits under the new branch,
//   (j) the view: `zoomAt` keeps the canvas point under the cursor fixed and stops at
//       the chat tree's bounds, **the wheel scales** anchored on the pointer (plain
//       and with ctrl/cmd alike — this page has no wheel-pan; the request preview's
//       own wheel is left to it), a drag pans without selecting, and a later snapshot
//       never moves the camera the user has taken (the one automatic fit happens on
//       the first snapshot only),
//   (k) the right-button autoscroll starts (marker element + the `autoscrolling`
//       cursor class) and stops (marker gone, class gone),
//   (l) a fresh snapshot rebuilds the tree,
//   (m) the **reset buttons**: exactly one `↺` per resettable property (`baseUrl`,
//       `balance`, `concurrency`, `contextWindow`, the vision toggle, the transport,
//       the level list, the default level) and none for `id` / `name` / `oaiModel` /
//       `providerId`, all of them the same glyph and the same sentence, disabled while
//       the property already holds its default and live the moment it does not, one
//       click writing only that property into the draft (the card is not rebuilt — its
//       element identity survives, the tree does not move) with the level list the one
//       exception (it re-renders and is re-measured, because its row count can change),
//       and every target read out of `snapshot.defaults` — the built-in rows from
//       `builtin`, the rest from `fresh`, proven by a second snapshot whose values are
//       different from the real host's, plus a snapshot with no `defaults` at all that
//       must not throw. The built-in rows' delete buttons are disabled while a card
//       that merely *is* the default keeps an enabled one,
//   (n) the provider's **wallet line**: a `<select>` of exactly the four dialects
//       `src/agent/balance.ts` knows (`none`, `deepseek`, `openrouter`, `moonshot`), in
//       that frozen order and labelled with the vendor, showing the provider's own
//       dialect (`deepseek` for the built-in row, `none` for a fresh one and for a
//       dialect this build does not know), with a `↺` that restores *that row's*
//       factory dialect and rides the same non-shape path as every other select — and,
//       unlike a keystroke, a save carries the dialect it shows in the payload,
//   (o) the draft's **unsaved marker**: an edit posts exactly one
//       `{ type: 'dirty', dirty: true }` — never one per keystroke — and switches the
//       docked status strip at the top of the view to its unsaved sentence, a save the
//       host accepts reports `dirty: false` and switches it back, a snapshot reports the
//       draft clean (that message is the only thing a snapshot may post besides
//       rendering), and the strip is **never hidden**: it starts in its clean state, one
//       line tall in both. That flag is what the host turns into the tab's `*`
//       (`ModelTreeController.applyDirty`).
//
// The page's *strings* are checked elsewhere (tools/check-l10n.js extracts every
// `tr()` call whose argument is one literal), and its look is not checked anywhere:
// the stub has no CSS, and its "layout" is a row counter, not a text engine. This
// answers one question — "does the page still understand the host, and is anything
// it draws actually drawn?" — in under a second.
//
// Run directly: `node tools/check-modeltree.js`.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
// An explicit path is for checking the checker itself (mutate a copy and watch it
// fail); the build always tests the repo's own script.
const scriptPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'media', 'modeltree.js');
const shellPath = path.join(root, 'src', 'chat', 'ModelPanel.ts');

const problems = [];
const notes = [];

// --- a DOM just big enough to let the script run ------------------------------
//
// Modelled on `tools/check-webview.js`'s `makeElement`, with only the surface this
// page touches: it builds cards and form fields, mutates classes, writes inline
// styles and measures. The chat stub's selector/layout machinery (querySelector
// against a subtree, ResizeObserver, canvas contexts) is deliberately absent — the
// page does not use it, and a stub that grows silently is a stub that lies.

const listeners = {};
/** Every element handed out by id, so a rebuild is observable afterwards. */
const elements = new Map();
/** Every message the page posted, so its wiring can be checked. */
const posted = [];
/** Seed of the stub's `crypto.getRandomValues`: deterministic, but fresh per call. */
let uuidSeed = 0;

/**
 * The ids `src/chat/ModelPanel.ts`'s HTML shell really declares — checked against
 * that file below, because the page fetches every one of them by id at boot and a
 * drift there is a null dereference in the webview. `getElementById` returns null for
 * anything else, so a typo in the script fails loudly at load instead of quietly
 * working against a stub that never exists in the real document.
 */
const SHELL_IDS = new Set([
  'mt-dirty', 'mt-toolbar', 'mt-spacer', 'mt-add-provider', 'mt-fit', 'mt-revert', 'mt-save',
  'mt-settings', 'mt-banner', 'mt-main', 'mt-wrap', 'mt-canvas',
  'mt-edges', 'mt-nodes', 'mt-empty',
]);

/**
 * How the shell nests those ids. The page only ever *fills* the containers it
 * fetches, so the guard has to nest them the way the document does: a card appended
 * to `#mt-nodes` has to be reachable from `#mt-canvas`, exactly as it is in the
 * webview.
 */
const SHELL_TREE = [
  ['mt-toolbar', ['mt-add-provider', 'mt-spacer', 'mt-fit', 'mt-revert', 'mt-save', 'mt-settings']],
  ['mt-main', ['mt-wrap']],
  ['mt-wrap', ['mt-canvas', 'mt-empty']],
  ['mt-canvas', ['mt-edges', 'mt-nodes']],
];

/** One line of text / one control, in the stub's pretend layout. */
const ROW_H = 20;

function hasClass(element, name) {
  return String((element && element.className) || '').split(/\s+/).indexOf(name) >= 0;
}

/** An inline `"12px"` style, as a number (0 when it is not a px length). */
function pxOf(value) {
  const match = /^\s*(-?\d+(?:\.\d+)?)px\s*$/.exec(String(value == null ? '' : value));
  return match ? parseFloat(match[1]) : 0;
}

/**
 * What the stub "measures". There is no text engine here, so the rule is structural
 * and monotone: an element with an explicit height keeps it, a leaf is one row, and a
 * container is the sum of its children plus a gap each. That is enough for the one
 * thing the guard has to prove — that a taller form (one more effort level) reaches
 * the layout engine as a taller box.
 */
function measuredHeight(element) {
  const explicit = pxOf(element.style.height);
  if (explicit > 0) return explicit;
  const kids = element.children || [];
  if (kids.length === 0) {
    if (element.tagName === 'INPUT' || element.tagName === 'SELECT' || element.tagName === 'BUTTON') return ROW_H;
    return String(element.textContent || '').trim() ? ROW_H : 0;
  }
  let sum = kids.length * 4;
  for (const kid of kids) sum += measuredHeight(kid);
  return sum;
}

/**
 * The stub's own measure rule applied to the *current* content, ignoring the explicit
 * height the layout may have painted on the element (its "natural" box).
 */
function naturalHeight(element) {
  const kids = element.children || [];
  if (kids.length === 0) {
    if (element.tagName === 'INPUT' || element.tagName === 'SELECT' || element.tagName === 'BUTTON') return ROW_H;
    return String(element.textContent || '').trim() ? ROW_H : 0;
  }
  let sum = kids.length * 4;
  for (const kid of kids) sum += measuredHeight(kid);
  return sum;
}

function makeElement(tag) {
  const element = {
    tagName: String(tag || 'div').toUpperCase(),
    id: '',
    className: '',
    children: [],
    dataset: {},
    value: '',
    checked: false,
    selected: false,
    disabled: false,
    readOnly: false,
    textContent: '',
    innerHTML: '',
    title: '',
    type: '',
    name: '',
    min: '',
    step: '',
    placeholder: '',
    clientWidth: 0,
    clientHeight: 0,
    parentElement: null,
    // The page writes positions and the pan/zoom transform here; a plain object is
    // exactly what `read back what the script set` needs.
    style: {},
    /** What the page put on the element with `setAttribute` (`#mt-edges`' width, …). */
    attributes: {},
    appendChild(child) {
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
    remove() {
      const parent = this.parentElement;
      if (parent && Array.isArray(parent.children)) {
        const at = parent.children.indexOf(this);
        if (at >= 0) parent.children.splice(at, 1);
      }
      this.parentElement = null;
    },
    addEventListener(type, handler) {
      (this._listeners || (this._listeners = {}))[type] = handler;
    },
    removeEventListener() {},
    setAttribute(name, value) {
      this.attributes[String(name)] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    },
    /** Enough selector support for the page's `closest('.mt-form')` / `.mt-preview`. */
    closest(selector) {
      const names = String(selector).split(',').map((part) => part.trim().replace(/^\./, ''));
      let node = this;
      while (node) {
        for (const name of names) {
          if (hasClass(node, name)) return node;
        }
        node = node.parentElement;
      }
      return null;
    },
    contains(other) {
      let node = other;
      while (node) {
        if (node === this) return true;
        node = node.parentElement;
      }
      return false;
    },
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }),
  };
  Object.defineProperty(element, 'offsetWidth', { get() { return pxOf(this.style.width); }, configurable: true });
  Object.defineProperty(element, 'offsetHeight', { get() { return measuredHeight(this); }, configurable: true });
  // `className` and `classList` must agree: the script assigns the former while
  // mutating through the latter, and every check below reads `className`.
  let className = '';
  element.classList = {
    _set: new Set(),
    add(name) {
      this._set.add(name);
      className = Array.from(this._set).join(' ');
    },
    remove(name) {
      this._set.delete(name);
      className = Array.from(this._set).join(' ');
    },
    contains: (name) => element.classList._set.has(name),
    toggle(name, force) {
      const on = force === undefined ? !element.classList._set.has(name) : force === true;
      if (on) element.classList.add(name);
      else element.classList.remove(name);
      return on;
    },
  };
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

function elementById(id) {
  if (!SHELL_IDS.has(id)) return null;
  if (!elements.has(id)) elements.set(id, makeElement('div'));
  return elements.get(id);
}

const document = {
  getElementById: elementById,
  createElement: (tag) => makeElement(tag),
  addEventListener(type, handler) {
    (listeners[type] || (listeners[type] = [])).push(handler);
  },
  removeEventListener() {},
  body: makeElement('body'),
  documentElement: makeElement('html'),
};

// Nest the shell exactly like the HTML in src/chat/ModelPanel.ts does.
{
  document.body.appendChild(elementById('mt-toolbar'));
  document.body.appendChild(elementById('mt-banner'));
  document.body.appendChild(elementById('mt-main'));
  for (const [parentId, childIds] of SHELL_TREE) {
    const parent = elementById(parentId);
    for (const childId of childIds) parent.appendChild(elementById(childId));
  }
}

const window = {
  addEventListener(type, handler) {
    (listeners[type] || (listeners[type] = [])).push(handler);
  },
  removeEventListener() {},
  // A v4 UUID is generated locally (`crypto.randomUUID` is not relied on): the bytes
  // are a deterministic sequence here, so the guard can read the id shape back out of
  // the payload while two nodes still get two different ids.
  crypto: {
    getRandomValues(bytes) {
      uuidSeed += 1;
      for (let i = 0; i < bytes.length; i++) bytes[i] = (uuidSeed * 16 + i) & 0xff;
      return bytes;
    },
  },
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
  requestAnimationFrame: (handler) => setTimeout(handler, 0),
  cancelAnimationFrame() {},
  performance,
  // No `window.__spinneyL10n`: the script must tolerate a missing dictionary and
  // fall back to the English source strings, exactly like media/main.js does.
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

// --- the shell and the script have to agree on the ids ------------------------

{
  if (!fs.existsSync(shellPath)) {
    console.error(`check-modeltree: ${path.relative(root, shellPath)} is missing — the page's shell is where its ids come from.`);
    process.exit(1);
  }
  const shellText = fs.readFileSync(shellPath, 'utf8');
  const declared = new Set([...shellText.matchAll(/id="(mt-[^"]+)"/g)].map((match) => match[1]));
  for (const id of declared) {
    if (!SHELL_IDS.has(id)) {
      problems.push(`the shell declares #${id} but this stub does not model it (add it here and check what the page does with it)`);
    }
  }
  for (const id of SHELL_IDS) {
    if (!declared.has(id)) {
      problems.push(`this stub models #${id}, which the shell no longer declares — the page would fetch null`);
    }
  }
  notes.push(`${declared.size} shell id(s) match`);
}

// --- run it ------------------------------------------------------------------

if (!fs.existsSync(scriptPath)) {
  console.error(`check-modeltree: ${path.relative(root, scriptPath)} is missing.`);
  process.exit(1);
}

try {
  vm.createContext(sandbox);
  // The webview's other script, in the order the HTML shell loads it: the pinned
  // layout engine (it attaches itself to `window`). Without it the first snapshot
  // would throw inside real layout code — exactly the class of failure this
  // checker exists to catch.
  for (const file of [
    path.join(root, 'media', 'vendor', 'non-layered-tidy-tree-layout', 'dist', 'non-layered-tidy-tree-layout.js'),
  ]) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: path.relative(root, file) });
  }
  vm.runInContext(fs.readFileSync(scriptPath, 'utf8'), sandbox, { filename: 'media/modeltree.js' });
} catch (err) {
  console.error(`check-modeltree: media/modeltree.js failed to load — ${err && err.message}`);
  console.error(
    '\nThe script fetches only the ids the HTML shell declares ' +
      `(${Array.from(SHELL_IDS).join(', ')}); anything else resolves to null.`,
  );
  process.exit(1);
}

// --- helpers -----------------------------------------------------------------

function dispatch(message) {
  let failed = false;
  for (const handler of listeners.message || []) {
    try {
      handler({ data: message });
    } catch (err) {
      failed = true;
      problems.push(
        `"${message.type}" threw ${err && err.message} — the page keeps its previous values silently; ` +
          'a handler is probably calling something that no longer exists',
      );
    }
  }
  return failed;
}

/** Fire the one handler the stub kept for an element (`_listeners[type]`). */
function fire(element, type, event) {
  const handler = element && element._listeners && element._listeners[type];
  if (typeof handler !== 'function') {
    problems.push(`${element && element.id ? '#' + element.id : 'an element'} has no ${type} listener to drive`);
    return false;
  }
  try {
    handler(event || {});
  } catch (err) {
    problems.push(`the ${type} handler of ${element.id || element.tagName} threw ${err && err.message}`);
    return false;
  }
  return true;
}

/** Fire every window/document-level listener of one type (they are not elements). */
function fireWindow(type, event) {
  let fired = 0;
  for (const handler of listeners[type] || []) {
    fired++;
    try {
      handler(event || {});
    } catch (err) {
      problems.push(`a window "${type}" listener threw ${err && err.message}`);
    }
  }
  return fired;
}

function mouseEvent(button, clientX, clientY, target) {
  return {
    button,
    clientX,
    clientY,
    target,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
  };
}

function keyEvent(key) {
  return { key: key, preventDefault() {}, stopPropagation() {} };
}

function wheelEvent(fields, target) {
  return Object.assign({
    deltaX: 0,
    deltaY: 0,
    clientX: 0,
    clientY: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    target: target,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
  }, fields || {});
}

function findAllByClass(rootEl, name) {
  const found = [];
  (function walk(node) {
    for (const child of node.children || []) {
      if (hasClass(child, name)) found.push(child);
      walk(child);
    }
  })(rootEl || makeElement('div'));
  return found;
}

/** Is `node` inside `root` (or `root` itself)? The stub has no `contains()`. */
function contains(root, node) {
  if (!root || !node) return false;
  if (root === node) return true;
  return (root.children || []).some((child) => contains(child, node));
}

/** The form row whose `data-field` is `field` (fields are built per selected card). */
function findField(rootEl, field) {
  let found = null;
  (function walk(node) {
    for (const child of node.children || []) {
      if (found) return;
      if (child.dataset && child.dataset.field === field) {
        found = child;
        return;
      }
      walk(child);
    }
  })(rootEl || makeElement('div'));
  return found;
}

/** Every input inside a node, in document order (a row's radio comes first). */
function inputsOf(node) {
  const out = [];
  (function walk(current) {
    for (const child of current.children || []) {
      if (child.tagName === 'INPUT') out.push(child);
      walk(child);
    }
  })(node || makeElement('div'));
  return out;
}

function firstInput(node) {
  return inputsOf(node)[0] || null;
}

function firstSelect(node) {
  let found = null;
  (function walk(current) {
    for (const child of current.children || []) {
      if (found) return;
      if (child.tagName === 'SELECT') {
        found = child;
        return;
      }
      walk(child);
    }
  })(node || makeElement('div'));
  return found;
}

/** The button whose visible text is exactly `label` (the guard runs without a catalog). */
function findButton(node, label) {
  let found = null;
  (function walk(current) {
    for (const child of current.children || []) {
      if (found) return;
      if (child.tagName === 'BUTTON' && String(child.textContent) === label) {
        found = child;
        return;
      }
      walk(child);
    }
  })(node || makeElement('div'));
  return found;
}

/** Every reset button inside a node, in document order (they pair with their field). */
function resetsOf(node) {
  return findAllByClass(node, 'mt-reset-btn');
}

const canvas = () => elementById('mt-canvas');
const cardsOf = () => findAllByClass(canvas(), 'mt-card');
const cardById = (id) => cardsOf().find((card) => card.dataset.id === id) || null;
const saveBtn = () => elementById('mt-save');

/** The inline box the page painted on a card (`style.left/top/width/height`). */
function boxOf(element) {
  return {
    x: pxOf(element.style.left),
    y: pxOf(element.style.top),
    w: pxOf(element.style.width),
    h: pxOf(element.style.height),
  };
}

function near(a, b, tolerance) {
  return Math.abs(a - b) <= (tolerance == null ? 0.01 : tolerance);
}

const PATH_RE = /<path\b([^>]*?)\/?>/g;
const PATH_ATTR_RE = /([\w-]+)="([^"]*)"/g;
const PATH_D_RE = /^M\s+(-?[\d.]+)\s+(-?[\d.]+)\s+C\s+(-?[\d.]+)\s+(-?[\d.]+)\s*,\s*(-?[\d.]+)\s+(-?[\d.]+)\s*,\s*(-?[\d.]+)\s+(-?[\d.]+)$/;

/** Parse the connector layer's markup: one entry per `<path>`, with its endpoints. */
function pathsOf(html) {
  const out = [];
  let match;
  PATH_RE.lastIndex = 0;
  while ((match = PATH_RE.exec(String(html))) !== null) {
    const attrs = {};
    let entry;
    PATH_ATTR_RE.lastIndex = 0;
    while ((entry = PATH_ATTR_RE.exec(match[1])) !== null) attrs[entry[1]] = entry[2];
    const d = String(attrs.d || '').trim();
    const numbers = PATH_D_RE.exec(d);
    out.push({
      from: attrs['data-from'] || '',
      to: attrs['data-to'] || '',
      d: d,
      points: numbers
        ? {
            x0: parseFloat(numbers[1]), y0: parseFloat(numbers[2]),
            c1x: parseFloat(numbers[3]), c1y: parseFloat(numbers[4]),
            c2x: parseFloat(numbers[5]), c2y: parseFloat(numbers[6]),
            x1: parseFloat(numbers[7]), y1: parseFloat(numbers[8]),
          }
        : null,
    });
  }
  return out;
}

/** The pan / zoom the page actually applied, parsed from the canvas' inline record. */
function transformOf() {
  const record = String(canvas().style.transform || '');
  const match = /^translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)$/.exec(record);
  if (!match) return null;
  return { record: record, x: parseFloat(match[1]), y: parseFloat(match[2]), zoom: parseFloat(match[3]) };
}

// --- 1. boot ------------------------------------------------------------------

const handlers = listeners.message || [];
if (handlers.length === 0) {
  console.error(
    'check-modeltree: media/modeltree.js registered no "message" listener; the host\'s snapshot would be ignored.',
  );
  process.exit(1);
}
notes.push(`${handlers.length} message listener(s)`);

const seam = window.__modeltreeTest;
const SEAM_MEMBERS = ['selectCard', 'selectProvider', 'addCard', 'addProvider', 'save', 'state', 'layout', 'canvasSize', 'zoomAt', 'fitToView'];
if (!seam) {
  console.error('check-modeltree: the page exposes no window.__modeltreeTest seam (tools/check-modeltree.js drives it).');
  process.exit(1);
}
for (const member of SEAM_MEMBERS) {
  if (typeof seam[member] !== 'function') {
    console.error(`check-modeltree: window.__modeltreeTest.${member} is missing — this checker drives it.`);
    process.exit(1);
  }
}

{
  const ready = posted.filter((message) => message && message.type === 'ready');
  if (ready.length !== 1) {
    problems.push(`the page posted ${ready.length} "ready" message(s) at boot, expected exactly one (see ModelPanel.post)`);
  }
}

const bootTransform = transformOf();
if (!bootTransform) {
  problems.push(`the page's canvas carries no transform at boot: ${JSON.stringify(canvas().style.transform)}`);
}

// --- 2. a snapshot becomes a tree in a real viewport ---------------------------

const SNAPSHOT = {
  providers: [
    {
      id: 'provider-a',
      name: 'Smoke provider',
      baseUrl: 'https://provider.invalid/v1',
      // The built-in row points at DeepSeek, so its wallet line is `deepseek` — the
      // dialect `defaults.builtin.provider` restores, and the one the select shows.
      balance: 'deepseek',
      concurrency: 0,
      hasKey: true,
      isBuiltin: true,
    },
  ],
  cards: [
    {
      id: 'card-a',
      name: 'Smoke card',
      providerId: 'provider-a',
      oaiModel: 'smoke-model-a',
      contextWindow: 65536,
      concurrency: 0,
      vision: { enabled: true, transport: 'deepseek' },
      efforts: ['none', 'low'],
      defaultEffort: 'low',
      isBuiltin: true,
    },
    {
      id: 'card-b',
      name: 'Smoke card two',
      providerId: 'provider-a',
      oaiModel: 'smoke-model-b',
      contextWindow: 131072,
      concurrency: 3,
      vision: { enabled: false, transport: 'openai' },
      efforts: ['high'],
      defaultEffort: 'high',
      isBuiltin: false,
    },
  ],
  defaultCardId: 'card-a',
  errors: [],
  // What every reset button restores, exactly what the host posts
  // (`ModelTreeSnapshot.defaults` → `BUILTIN_*` / `FRESH_*` in src/agent/models.ts).
  // The values the protocol pins are the real ones — the built-in card really does
  // ship with a 2500 concurrency cap and with images on `deepseek`, a fresh card with
  // 0 and `openai`, both providers with the DeepSeek URL and the built-in one with the
  // `deepseek` wallet line — so a page that copied them instead of reading them would
  // look right here; section 22's *second* snapshot is what rules that out.
  defaults: {
    builtin: {
      provider: { baseUrl: 'https://api.deepseek.com', concurrency: 0, balance: 'deepseek' },
      card: {
        contextWindow: 1048576,
        concurrency: 2500,
        vision: { enabled: true, transport: 'deepseek' },
        efforts: ['none', 'low', 'medium', 'high'],
        defaultEffort: 'medium',
      },
    },
    fresh: {
      provider: { baseUrl: 'https://api.deepseek.com', concurrency: 0, balance: 'none' },
      card: {
        contextWindow: 1048576,
        concurrency: 0,
        vision: { enabled: false, transport: 'openai' },
        efforts: ['none', 'low', 'medium', 'high'],
        defaultEffort: 'medium',
      },
    },
  },
};

const postedBeforeSnapshot = posted.length;
if (dispatch({ type: 'modelTree', snapshot: SNAPSHOT })) {
  problems.push('a `modelTree` snapshot threw — the page no longer understands the host');
}
// A snapshot is the stored truth, so it may do exactly one thing besides rendering:
// report the draft as clean (`dirty: false` — the unsaved marker on the tab's title).
// Anything else it posts would be a message about a draft it just replaced.
const afterSnapshot = posted.slice(postedBeforeSnapshot);
if (afterSnapshot.some((message) => !message || message.type !== 'dirty')) {
  problems.push(`a snapshot made the page post ${JSON.stringify(afterSnapshot)} — it must only render (plus the dirty report)`);
}
if (afterSnapshot.some((message) => message.dirty !== false)) {
  problems.push(`a snapshot reported the draft as ${JSON.stringify(afterSnapshot.map((m) => m && m.dirty))} — a snapshot *is* the stored state`);
}
// The strip is **docked**: never hidden, one line tall in either state (the CSS carries
// the second half of that promise — the stub has no text engine), and it says which
// state it is in. A page that is still booting has no unsaved edits.
{
  const strip = elementById('mt-dirty');
  if (strip.classList.contains('hidden') || strip.classList.contains('mt-dirty-on')) {
    problems.push(`the status strip starts as ${JSON.stringify(strip.className)} — a clean page must show the clean state, never nothing`);
  }
  if (String(strip.textContent || '').indexOf('No unsaved changes') < 0) {
    problems.push(`the clean status strip shows ${JSON.stringify(strip.textContent)}`);
  }
}

/**
 * What the last draw must satisfy, after any trigger: the viewport is real, every box
 * is the box its own content needs, and the connectors join exactly the cards that have
 * a provider. Called after every step that redraws, because each one can break a
 * different half of it.
 */
function assertDraw() {
  const layout = seam.layout();
  const size = seam.canvasSize();
  if (!(size.w > 0) || !(size.h > 0)) {
    problems.push(`#mt-canvas carries no positive size (${size.w} × ${size.h}): the SVG viewport is degenerate and every connector is invisible`);
  }
  if (!(size.svgW > 0) || !(size.svgH > 0)) {
    problems.push(`#mt-edges carries no positive width/height (${size.svgW} × ${size.svgH}): the strokes land in a 0×0 viewport`);
  }
  if (!near(size.w, size.svgW) || !near(size.h, size.svgH)) {
    problems.push(`the connector layer is ${size.svgW} × ${size.svgH} but the canvas box is ${size.w} × ${size.h} — they must be the same box`);
  }
  if (!near(size.w, layout.w) || !near(size.h, layout.h)) {
    problems.push(`the laid-out box is ${layout.w} × ${layout.h} but the canvas got ${size.w} × ${size.h}`);
  }

  // The engine's box has to be the *measured* one: a card whose content grew after it
  // was measured (a form filled in after the fact, say) is laid out too small and the
  // card would clip its own fields.
  for (const node of layout.nodes) {
    const element = cardById(node.id);
    if (!element) continue;
    const natural = naturalHeight(element);
    if (!near(node.h, natural)) {
      problems.push(`${node.id} was laid out ${node.h}px tall but its content needs ${natural}px — the measure pass ran before the content existed`);
    }
  }

  const drawn = layout.nodes.filter((node) => node.kind === 'card');
  const paths = pathsOf(elementById('mt-edges').innerHTML);
  if (paths.length !== drawn.length) {
    problems.push(`the SVG layer drew ${paths.length} connector(s) for ${drawn.length} model card(s) that have a provider`);
  }
  const seen = new Set();
  for (const entry of paths) {
    const to = drawn.find((node) => node.id === entry.to);
    const from = layout.nodes.find((node) => node.kind === 'provider' && node.id === entry.from);
    if (!to || !from) {
      problems.push(`a connector names ${JSON.stringify(entry.from)} → ${JSON.stringify(entry.to)}, which is not a drawn provider → card pair`);
      continue;
    }
    if (to.parentId !== entry.from) {
      problems.push(`${entry.to} is drawn under ${JSON.stringify(to.parentId || '(nothing)')} but its connector leaves ${entry.from}`);
    }
    if (seen.has(entry.to)) {
      problems.push(`${entry.to} is joined to its provider more than once`);
    }
    seen.add(entry.to);
    if (!entry.points) {
      problems.push(`a connector carries no parsable "M x y C …" path: ${JSON.stringify(entry.d)}`);
      continue;
    }
    const expectedX0 = from.x + from.w / 2;
    const expectedY0 = from.y + from.h;
    const expectedX1 = to.x + to.w / 2;
    const expectedY1 = to.y;
    const p = entry.points;
    if (!near(p.x0, expectedX0) || !near(p.y0, expectedY0)) {
      problems.push(`a connector starts at ${p.x0},${p.y0} instead of the provider's bottom edge centre ${expectedX0},${expectedY0}`);
    }
    if (!near(p.x1, expectedX1) || !near(p.y1, expectedY1)) {
      problems.push(`a connector ends at ${p.x1},${p.y1} instead of the card's top edge centre ${expectedX1},${expectedY1}`);
    }
    // Both ends have to sit between the two boxes: a wire between two boxes may never
    // leave the space they occupy together.
    const leftX = Math.min(from.x, to.x);
    const rightX = Math.max(from.x + from.w, to.x + to.w);
    const topY = Math.min(from.y, to.y);
    const bottomY = Math.max(from.y + from.h, to.y + to.h);
    for (const [px, py] of [[p.x0, p.y0], [p.x1, p.y1]]) {
      if (px < leftX - 0.01 || px > rightX + 0.01 || py < topY - 0.01 || py > bottomY + 0.01) {
        problems.push(`a connector point ${px},${py} lies outside the provider/card boxes (${leftX},${topY} – ${rightX},${bottomY})`);
      }
    }
    if (!(p.y0 <= p.c1y && p.c1y <= p.y1) || !(p.y0 <= p.c2y && p.c2y <= p.y1)) {
      problems.push('a connector\'s elbow leaves the vertical span between the two boxes');
    }
  }
  for (const drawnCard of drawn) {
    if (!seen.has(drawnCard.id)) {
      problems.push(`the card ${drawnCard.id} has a provider but no connector at all`);
    }
  }
  return paths;
}

{
  const cards = cardsOf();
  if (cards.length !== 3) {
    problems.push(`a snapshot of 1 provider + 2 model cards drew ${cards.length} card(s), expected 3`);
  }
  for (const id of ['provider-a', 'card-a', 'card-b']) {
    if (!cardById(id)) problems.push(`no card element was created for ${id}`);
  }
  const providerCard = cardById('provider-a');
  if (providerCard && (providerCard.dataset.kind !== 'provider' || !hasClass(providerCard, 'mt-card-provider'))) {
    problems.push('a provider card is not tagged as one (data-kind="provider" + .mt-card-provider)');
  }
  const modelCard = cardById('card-b');
  if (modelCard && (modelCard.dataset.kind !== 'card' || !hasClass(modelCard, 'mt-card-card'))) {
    problems.push('a model card is not tagged as one (data-kind="card" + .mt-card-card)');
  }
  // The vendored engine is what places them: without it every card sits at 0,0, and the
  // inline box is also what the connector geometry above is derived from.
  const layout = seam.layout();
  for (const node of layout.nodes) {
    const element = cardById(node.id);
    if (!element) continue;
    const painted = boxOf(element);
    if (!near(painted.x, node.x) || !near(painted.y, node.y) || !near(painted.w, node.w) || !near(painted.h, node.h)) {
      problems.push(
        `${node.id} is painted at ${painted.x},${painted.y} ${painted.w}×${painted.h} but was laid out at ` +
          `${node.x},${node.y} ${node.w}×${node.h}`,
      );
    }
  }
  const paths = assertDraw();
  notes.push(`${paths.length} connector(s) across a ${seam.canvasSize().w}×${seam.canvasSize().h} viewport`);

  // The first snapshot is the first real tree: the camera is fitted once (the initial
  // pan is 0,0, which leaves half the tree off-screen).
  const afterFit = transformOf();
  if (afterFit && bootTransform && afterFit.record === bootTransform.record) {
    problems.push('the first snapshot did not fit the view — the tree stays where the initial 0,0 pan put it');
  }
  if (!elementById('mt-empty').classList.contains('hidden')) {
    problems.push('the empty-state hint is still showing although the draft has nodes');
  }
}

// --- 3. the selected card *is* the form; an unselected card is compact ---------

{
  if (seam.state().selected !== 'provider:provider-a') {
    problems.push(`a fresh snapshot selected ${JSON.stringify(seam.state().selected)}, expected the first provider`);
  }
  const providerCard = cardById('provider-a');
  if (!providerCard || !hasClass(providerCard, 'selected')) {
    problems.push('the selected provider card is not marked .selected');
  }
  const form = providerCard ? findAllByClass(providerCard, 'mt-form') : [];
  if (form.length !== 1) {
    problems.push(`the selected provider card holds ${form.length} form(s), expected exactly one (the card *is* the form)`);
  }
  for (const field of ['name', 'baseUrl', 'balance', 'concurrency', 'apiKey', 'id']) {
    if (providerCard && !findField(providerCard, field)) {
      problems.push(`the selected provider card has no "${field}" field`);
    }
  }
  const urlInput = providerCard ? firstInput(findField(providerCard, 'baseUrl')) : null;
  if (!urlInput || urlInput.value !== 'https://provider.invalid/v1') {
    problems.push(`the provider card's base-URL field shows ${JSON.stringify(urlInput && urlInput.value)}, expected the provider's own`);
  }
  const nameInput = providerCard ? firstInput(findField(providerCard, 'name')) : null;
  if (!nameInput || nameInput.value !== 'Smoke provider') {
    problems.push('the name is not edited in the card\'s own head row');
  }
  for (const label of ['Add model card', 'Delete provider', 'Save key', 'Clear key']) {
    if (providerCard && !findButton(providerCard, label)) {
      problems.push(`the selected provider card has no "${label}" button`);
    }
  }
  const countBadge = providerCard ? findAllByClass(providerCard, 'mt-badge-count')[0] : null;
  if (!countBadge || String(countBadge.textContent) !== '2 cards') {
    problems.push(`a provider card shows ${JSON.stringify(countBadge && countBadge.textContent)} as its card count, expected "2 cards"`);
  }

  const compact = cardById('card-a');
  if (!compact) {
    problems.push('the unselected card has no element at all');
  } else {
    if (findAllByClass(compact, 'mt-form').length !== 0) {
      problems.push('an unselected card carries a form — only the selected one expands');
    }
    for (const field of ['name', 'oaiModel', 'id', 'preview']) {
      if (findField(compact, field)) {
        problems.push(`an unselected card carries a "${field}" field`);
      }
    }
    if (inputsOf(compact).length !== 0) {
      problems.push('an unselected card carries input elements');
    }
  }

  // The two width rules: a form needs more room than a compact box.
  const layout = seam.layout();
  const providerBox = layout.nodes.find((node) => node.id === 'provider-a');
  const cardBox = layout.nodes.find((node) => node.id === 'card-a');
  if (!providerBox || !cardBox) {
    problems.push('the layout has no box for provider-a and card-a');
  } else if (!(providerBox.w > cardBox.w)) {
    problems.push(`the selected provider card (${providerBox.w}px) is not wider than a compact model card (${cardBox.w}px)`);
  }
}

// --- 4. selecting a card moves the form onto it --------------------------------

{
  seam.selectCard('card-b');
  const element = cardById('card-b');
  if (!element || !hasClass(element, 'selected')) {
    problems.push('selecting a model card did not mark its card as .selected');
  }
  if (cardById('provider-a') && findAllByClass(cardById('provider-a'), 'mt-form').length !== 0) {
    problems.push('the provider card kept its form after another node was selected');
  }
  const modelField = element ? findField(element, 'oaiModel') : null;
  const modelInput = modelField ? firstInput(modelField) : null;
  if (!modelInput) {
    problems.push('the selected card renders no field for its own model id');
  } else if (modelInput.value !== 'smoke-model-b') {
    problems.push(`the card's model-id field shows ${JSON.stringify(modelInput.value)}, expected the selected card's own`);
  }

  const idField = element ? findField(element, 'id') : null;
  const idInput = idField ? firstInput(idField) : null;
  if (!idInput) {
    problems.push('the selected card renders no id field — the generated id would be invisible');
  } else if (!idInput.readOnly || idInput.value !== 'card-b') {
    problems.push(`the id field is ${idInput.readOnly ? '' : 'editable and '}showing ${JSON.stringify(idInput.value)}; it must be read-only and carry the card's id`);
  }

  const providerSelect = element ? firstSelect(findField(element, 'providerId')) : null;
  if (!providerSelect || providerSelect.value !== 'provider-a') {
    problems.push('the card has no provider <select> set to the selected card\'s provider');
  } else {
    const values = providerSelect.children.map((option) => option.value);
    if (values.join(',') !== 'provider-a') {
      problems.push(`the provider <select> offers ${JSON.stringify(values)}, expected the snapshot's providers`);
    }
  }

  const transportSelect = element ? firstSelect(findField(element, 'visionTransport')) : null;
  if (!transportSelect || transportSelect.value !== 'openai') {
    problems.push('the card has no image-transport <select> set to its own transport');
  } else {
    // The two dialects, in the order the page declares them: `openai` first (the
    // standard shape, and the default for a new card), `deepseek` second — and each
    // option labelled with the vendor name the user picks between, never with the
    // mechanism (the request preview below the form states that).
    const options = transportSelect.children.map((option) => option.value + '=' + option.textContent);
    if (options.join(',') !== 'openai=OpenAI,deepseek=DeepSeek') {
      problems.push(`the image-transport <select> offers ${JSON.stringify(options)}, expected openai=OpenAI then deepseek=DeepSeek`);
    }
    // The transport shares the vision toggle's line (it is that toggle's companion,
    // so it belongs next to the checkbox rather than in a row of its own) …
    const visionRow = findField(element, 'visionEnabled');
    const transportField = findField(element, 'visionTransport');
    if (!visionRow || !transportField || !contains(visionRow, transportField)) {
      problems.push("the image transport is not on the vision toggle's own line");
    }
    // … and its enabled/disabled state follows the vision toggle: asserted in the
    // section that selects each card by name (this one renders the text-only card).
  }

  const effortRows = element ? findAllByClass(element, 'mt-effort-row') : [];
  if (effortRows.length !== 1) {
    problems.push(`the card rendered ${effortRows.length} effort-level row(s) for a card with 1 level`);
  } else {
    const inputs = inputsOf(effortRows[0]);
    const levelInput = inputs.find((input) => input.type === 'text');
    const radio = inputs.find((input) => input.type === 'radio');
    if (!levelInput || levelInput.value !== 'high') {
      problems.push(`the effort row shows ${JSON.stringify(levelInput && levelInput.value)}, expected the card's own level`);
    }
    if (!radio || !radio.checked) {
      problems.push('the card\'s default effort is not marked as the default in the level list');
    }
  }

  const preview = element ? findField(element, 'preview') : null;
  const previewText = String((preview && preview.textContent) || '');
  if (!preview) {
    problems.push('the selected card has no request preview of its own');
  } else if (previewText.indexOf('https://provider.invalid/v1/chat/completions') < 0 || previewText.indexOf('smoke-model-b') < 0) {
    problems.push(`the request preview does not show the endpoint and the model: ${JSON.stringify(previewText)}`);
  } else if (previewText.indexOf('reasoning_effort') < 0) {
    problems.push(`the request preview shows no reasoning_effort line for a card whose level is not "none": ${JSON.stringify(previewText)}`);
  }
  const boxes = seam.layout().nodes;
  const selectedBox = boxes.find((node) => node.id === 'card-b');
  const compactBox = boxes.find((node) => node.id === 'card-a');
  if (!selectedBox || !compactBox) {
    problems.push('the layout has no box for both model cards');
  } else if (!(selectedBox.w > compactBox.w)) {
    problems.push(`the selected model card (${selectedBox.w}px) is not wider than a compact one (${compactBox.w}px)`);
  }
}

// --- 5. a keystroke moves nothing, flips Save, and reaches the payload ---------

{
  const before = JSON.stringify(seam.layout());
  const beforeCanvas = JSON.stringify(seam.canvasSize());
  const element = cardById('card-b');
  const nameInput = element ? firstInput(findField(element, 'name')) : null;
  const preview = element ? findField(element, 'preview') : null;
  // The draft's flag is *reported*, not merely rendered: the `*` on the tab's title
  // comes from it (`ModelTreeController.applyDirty`) and so does the strip at the top of
  // the view. It is a transition, never a keystroke — typing a word must not post a
  // message per character.
  const dirtyPosts = (value) =>
    posted.filter((message) => message && message.type === 'dirty' && message.dirty === value).length;
  const dirtyBefore = dirtyPosts(true);
  if (!nameInput || typeof (nameInput._listeners || {}).input !== 'function') {
    problems.push('the selected card\'s name field has no input handler — typing in it would not reach the draft');
  } else {
    nameInput.value = 'Renamed card';
    fire(nameInput, 'input');
    const renamed = seam.state().cards.find((entry) => entry.id === 'card-b');
    if (!renamed || renamed.name !== 'Renamed card') {
      problems.push('typing in the card did not reach the draft');
    }
    if (!renamed || renamed.id !== 'card-b') {
      problems.push('editing a name changed the card\'s id — it must never change once assigned');
    }
    if (!seam.state().dirty || saveBtn().disabled) {
      problems.push('an edit in the card left the draft clean (Save would stay disabled)');
    }
    if (JSON.stringify(seam.canvasSize()) !== beforeCanvas || JSON.stringify(seam.layout()) !== before) {
      problems.push('a keystroke re-laid the tree out — nothing on screen may move while the user types');
    }
    if (cardById('card-b') !== element || findField(cardById('card-b'), 'preview') !== preview) {
      problems.push('a keystroke rebuilt the card — the field would lose the caret mid-word');
    }
    if (!preview || String(preview.textContent).indexOf('smoke-model-b') < 0) {
      problems.push('a keystroke did not refresh the card\'s request preview');
    }
    if (dirtyPosts(true) !== dirtyBefore + 1) {
      problems.push(`an edit posted ${dirtyPosts(true) - dirtyBefore} "dirty: true" message(s), expected exactly one (the tab's unsaved marker)`);
    }
    const strip = elementById('mt-dirty');
    if (strip.classList.contains('mt-dirty-off') || strip.classList.contains('hidden')) {
      problems.push(`an edit left the status strip at ${JSON.stringify(strip.className)} — it must switch to the unsaved state`);
    }
    if (String(strip.textContent || '').indexOf('unsaved changes') < 0) {
      problems.push(`the unsaved status strip shows ${JSON.stringify(strip.textContent)}, expected the unsaved-changes sentence`);
    }
    // The same value typed again: still dirty, so nothing new is posted.
    fire(nameInput, 'input');
    if (dirtyPosts(true) !== dirtyBefore + 1) {
      problems.push('a second keystroke posted another "dirty" message — the flag is a transition, not a keystroke');
    }
  }

  posted.length = 0;
  const errors = seam.save();
  if (errors.length > 0) {
    problems.push(`save() refused a complete draft: ${JSON.stringify(errors)}`);
  }
  const sent = posted.find((message) => message && message.type === 'save');
  const saved = sent && sent.payload && sent.payload.cards.find((card) => card.id === 'card-b');
  if (!saved || saved.name !== 'Renamed card') {
    problems.push(`the saved payload does not carry the edit made in the card: ${JSON.stringify(saved && saved.name)}`);
  }
}

// --- 5b. a new card follows the *posted* fresh defaults, not a page literal ----
//
// The section above pins the seeded values against the fixture's own defaults, which a
// page that hardcoded those very numbers would also satisfy. So the snapshot is
// re-posted with deliberately odd fresh values: a new card must follow those.

{
  const odd = JSON.parse(JSON.stringify(SNAPSHOT));
  odd.defaults.fresh.card = {
    contextWindow: 4242,
    concurrency: 7,
    vision: { enabled: true, transport: 'deepseek' },
    efforts: ['alpha', 'beta'],
    defaultEffort: 'beta',
  };
  dispatch({ type: 'modelTree', snapshot: odd });
  const seeded = seam.addCard();
  if (!seeded) {
    problems.push('addCard() returned nothing under a snapshot of its own');
  } else {
    const mismatches = [];
    if (seeded.contextWindow !== 4242) mismatches.push('contextWindow=' + seeded.contextWindow);
    if (seeded.concurrency !== 7) mismatches.push('concurrency=' + seeded.concurrency);
    if (seeded.efforts.join(',') !== 'alpha,beta') mismatches.push('efforts=' + JSON.stringify(seeded.efforts));
    if (seeded.defaultEffort !== 'beta') mismatches.push('defaultEffort=' + JSON.stringify(seeded.defaultEffort));
    if (!seeded.vision || seeded.vision.enabled !== true || seeded.vision.transport !== 'deepseek') mismatches.push('vision=' + JSON.stringify(seeded.vision));
    if (mismatches.length > 0) {
      problems.push('a new card carries ' + mismatches.join(' ') + ' — the seeded values must come from the posted fresh defaults, never from a literal in the page');
    }
  }
  // Leave the page as the following sections expect it: the fixture's own tree with
  // card-b selected (the re-dispatch above drops the probe card and its selection).
  dispatch({ type: 'modelTree', snapshot: SNAPSHOT });
  seam.selectCard('card-b');
}
// --- 6. an effort level is a shape change: the form is re-measured -------------

{
  const height = () => pxOf(cardById('card-b').style.height);
  const before = height();
  const add = findButton(cardById('card-b'), 'Add level');
  if (!add) {
    problems.push('the card has no "Add level" button');
  } else {
    fire(add, 'click');
    const rows = findAllByClass(cardById('card-b'), 'mt-effort-row');
    if (rows.length !== 2) {
      problems.push(`"Add level" left ${rows.length} effort row(s), expected 2`);
    }
    if (!(height() > before)) {
      problems.push(`adding a level left the card ${height()}px high (was ${before}px) — the form was not re-measured`);
    }
    const size = seam.canvasSize();
    if (!(size.svgW > 0) || !(size.svgH > 0) || !near(size.svgW, size.w) || !near(size.svgH, size.h)) {
      problems.push('a re-layout left the connector layer without a positive, matching size');
    }
    // And back: the measurement follows the content, it is not just growing.
    const remove = findAllByClass(rows[1], 'mt-icon-btn')[0];
    if (!remove) {
      problems.push('an effort row has no remove button');
    } else {
      fire(remove, 'click');
      if (findAllByClass(cardById('card-b'), 'mt-effort-row').length !== 1) {
        problems.push('removing an effort level left the wrong number of rows');
      }
      if (!near(height(), before)) {
        problems.push(`removing the level left the card ${height()}px high, expected the original ${before}px`);
      }
    }
  }
  assertDraw();
}

// --- 7. a failed save keeps the draft ----------------------------------------

{
  const added = seam.addCard();
  if (!added) {
    problems.push('addCard() returned nothing — the Save button would have nothing to add');
  }
  // A new card is **invalid in exactly one way** — the wire model name, the one field
  // nothing may invent — and comes prefilled with everything else from the fresh-row
  // defaults the host posted. Each value is asserted against the *fixture's* defaults
  // (not against a literal), so hardcoding them in the page fails here.
  const fresh = SNAPSHOT.defaults.fresh.card;
  if (added) {
    if (added.oaiModel !== '') {
      problems.push(`a new card invents the wire model name ${JSON.stringify(added.oaiModel)} — that field is the user's`);
    }
    if (added.name !== 'New Model') {
      problems.push(`a new card is called ${JSON.stringify(added.name)}, expected the placeholder 'New Model'`);
    }
    if (added.contextWindow !== fresh.contextWindow || added.concurrency !== fresh.concurrency) {
      problems.push(`a new card starts at contextWindow/concurrency ${added.contextWindow}/${added.concurrency}, expected the fresh defaults ${fresh.contextWindow}/${fresh.concurrency}`);
    }
    if (added.efforts.join(',') !== fresh.efforts.join(',') || added.defaultEffort !== fresh.defaultEffort) {
      problems.push(`a new card starts at ${JSON.stringify(added.efforts)}/${JSON.stringify(added.defaultEffort)}, expected the fresh defaults ${JSON.stringify(fresh.efforts)}/${JSON.stringify(fresh.defaultEffort)}`);
    }
    if (!added.vision || added.vision.enabled !== fresh.vision.enabled || added.vision.transport !== fresh.vision.transport) {
      problems.push(`a new card starts at vision ${JSON.stringify(added.vision)}, expected the fresh defaults ${JSON.stringify(fresh.vision)}`);
    }
    if (added.providerId !== 'provider-a') {
      problems.push(`a new card did not hang off the selected provider: ${JSON.stringify(added.providerId)}`);
    }
  }
  // … and the save is refused, with the model name as the *only* reason: the other
  // fields really are complete.
  {
    posted.length = 0;
    const refused = seam.save();
    if (refused.length !== 1 || !/model id/i.test(refused[0])) {
      problems.push(`saving an unnamed new card reported ${JSON.stringify(refused)}, expected exactly the missing model name`);
    }
    if (posted.some((message) => message && message.type === 'save')) {
      problems.push('an unnamed new card was posted to the host anyway');
    }
    // Name it: now it is complete, and the rest of this section can go on.
    added.oaiModel = 'smoke-model-c';
  }
  if (seam.state().dirty !== true) {
    problems.push('adding a card left the draft clean (the Save button would stay disabled)');
  }
  if (dispatch({ type: 'modelTreeSaveResult', ok: false, errors: ['the host said no'], savedAt: 1 })) {
    problems.push('a `modelTreeSaveResult` with ok:false threw');
  }
  if (seam.state().dirty !== true) {
    problems.push('a failed save cleared the dirty state — the user\'s edits would look saved');
  }
  const banner = elementById('mt-banner');
  if (banner.classList.contains('hidden')) {
    problems.push('a failed save showed no banner');
  } else if (String(banner.textContent || '').indexOf('the host said no') < 0) {
    problems.push(`the banner does not carry the host's reason: ${JSON.stringify(banner.textContent)}`);
  }
}

// --- 8. add-card → save posts the whole desired state -------------------------

{
  posted.length = 0;
  const draft = seam.state();
  const card = draft.cards[draft.cards.length - 1];
  card.name = '  Padded card  ';
  card.oaiModel = '  smoke-model-c  ';
  card.contextWindow = 8192;
  card.concurrency = 2;
  card.efforts = ['none', 'low'];
  card.defaultEffort = 'none';
  card.vision = { enabled: true, transport: 'openai' };

  const errors = seam.save();
  if (errors.length > 0) {
    problems.push(`save() refused a complete draft: ${JSON.stringify(errors)}`);
  }
  const sent = posted.find((message) => message && message.type === 'save');
  if (!sent) {
    problems.push(`Save posted ${JSON.stringify(posted)}, expected { type: 'save', payload }`);
  } else {
    const payload = sent.payload || {};
    if (!Array.isArray(payload.providers) || !Array.isArray(payload.cards) ||
        !Array.isArray(payload.apiKeys) || !Array.isArray(payload.clearedKeys) ||
        typeof payload.defaultCardId !== 'string') {
      problems.push(`the save payload is not a ModelTreeSave: ${JSON.stringify(Object.keys(payload))}`);
    } else {
      if (payload.cards.length !== 3) {
        problems.push(`the payload carries ${payload.cards.length} model card(s), expected the whole desired state (3)`);
      }
      const last = payload.cards[payload.cards.length - 1];
      if (last.id !== card.id) {
        problems.push('the saved card is not the one that was added');
      }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(last.id))) {
        problems.push(`a new card got the id ${JSON.stringify(last.id)}, expected a locally generated v4 UUID`);
      }
      if (last.name !== 'Padded card' || last.oaiModel !== 'smoke-model-c') {
        problems.push(`the payload carries ${JSON.stringify(last.name)} / ${JSON.stringify(last.oaiModel)}, expected trimmed values`);
      }
      if (last.providerId !== 'provider-a' || last.contextWindow !== 8192 || last.concurrency !== 2) {
        problems.push(`the payload lost the card's own fields: ${JSON.stringify(last)}`);
      }
      if (!last.vision || last.vision.enabled !== true || last.vision.transport !== 'openai') {
        problems.push(`the payload lost the card's vision settings: ${JSON.stringify(last.vision)}`);
      }
      if (last.efforts.join(',') !== 'none,low' || last.defaultEffort !== 'none') {
        problems.push(`the payload lost the effort levels: ${JSON.stringify(last.efforts)} / ${JSON.stringify(last.defaultEffort)}`);
      }
      if (payload.providers[0] && ('hasKey' in payload.providers[0] || 'isBuiltin' in payload.providers[0])) {
        problems.push('a saved provider carries hasKey/isBuiltin — those are the host\'s, not the user\'s');
      }
      if (payload.cards[0] && 'isBuiltin' in payload.cards[0]) {
        problems.push('a saved card carries isBuiltin — it is not a user-editable field');
      }
      if (payload.defaultCardId !== 'card-a') {
        problems.push(`the payload changed the default card to ${JSON.stringify(payload.defaultCardId)} without being asked`);
      }
      notes.push(`save payload: ${payload.providers.length} provider(s), ${payload.cards.length} card(s)`);
    }
  }
  assertDraw();
}

// --- 9. a successful save cleans the draft ------------------------------------

if (dispatch({ type: 'modelTreeSaveResult', ok: true, errors: [], savedAt: 2 })) {
  problems.push('a `modelTreeSaveResult` with ok:true threw');
}
if (seam.state().dirty) {
  problems.push('a successful save left the draft dirty — the user could not tell it went through');
}
if (!saveBtn().disabled) {
  problems.push('the Save button is not disabled once the draft is clean');
}
if (!elementById('mt-dirty').classList.contains('mt-dirty-off')) {
  problems.push('a successful save left the status strip in the unsaved state');
}
if (!posted.some((message) => message && message.type === 'dirty' && message.dirty === false)) {
  problems.push('a save the host accepted never reported the draft as clean — the tab would keep its "*"');
}

// --- 10. an invalid draft never reaches the host -------------------------------

{
  posted.length = 0;
  const state = seam.state();
  state.cards[0].name = '   ';
  const blocked = seam.save();
  if (blocked.length === 0) {
    problems.push('save() accepted a card with a blank name');
  }
  if (posted.some((message) => message && message.type === 'save')) {
    problems.push('an invalid draft was posted anyway — the host would have to say no');
  }
  const banner = elementById('mt-banner');
  if (banner.classList.contains('hidden') || String(banner.textContent || '').indexOf('needs a name') < 0) {
    problems.push(`a blocked save shows no reason in the banner: ${JSON.stringify(banner.textContent)}`);
  }

  state.cards[0].name = 'Smoke card';
  state.cards[0].providerId = 'provider-gone';
  if (seam.save().length === 0) {
    problems.push('save() accepted a card pointing at a provider that does not exist');
  }
  // A card without a provider is not drawn at all — no card, no connector. It is how
  // the page says "this card is unreachable", and validation is what blocks the save.
  if (cardById('card-a')) {
    problems.push('a card whose provider is gone is still drawn on the canvas');
  }
  if (pathsOf(elementById('mt-edges').innerHTML).some((entry) => entry.to === 'card-a')) {
    problems.push('a card whose provider is gone still has a connector');
  }
  state.cards[0].providerId = 'provider-a';
  state.cards[0].efforts = ['low', 'LOW'];
  state.cards[0].defaultEffort = 'low';
  if (seam.save().length === 0) {
    problems.push('save() accepted an effort list with two levels that differ only in case');
  }
  state.cards[0].efforts = ['none', 'low'];
  seam.save();
}

// --- 11. moving a card to another provider re-parents it -----------------------

{
  const provider = seam.addProvider();
  if (!provider) {
    problems.push('addProvider() returned nothing');
  }
  const before = pathsOf(elementById('mt-edges').innerHTML);
  if (!before.some((entry) => entry.to === 'card-b' && entry.from === 'provider-a')) {
    problems.push('card-b was not connected to provider-a before the move');
  }
  seam.selectCard('card-b');
  const select = firstSelect(findField(cardById('card-b'), 'providerId'));
  if (!select) {
    problems.push('the selected card has no provider <select> to move it with');
  } else {
    const values = select.children.map((option) => option.value);
    if (values.indexOf(provider.id) < 0) {
      problems.push(`the provider <select> does not offer the new provider: ${JSON.stringify(values)}`);
    }
    select.value = provider.id;
    fire(select, 'change');

    const after = pathsOf(elementById('mt-edges').innerHTML);
    if (!after.some((entry) => entry.to === 'card-b' && entry.from === provider.id)) {
      problems.push(`no connector leaves the new provider for card-b after the move: ${JSON.stringify(after.map((entry) => entry.from + '→' + entry.to))}`);
    }
    if (after.some((entry) => entry.to === 'card-b' && entry.from === 'provider-a')) {
      problems.push('card-b is still connected to its old provider');
    }
    const moved = seam.layout().nodes.find((node) => node.id === 'card-b');
    const newParent = seam.layout().nodes.find((node) => node.id === provider.id);
    if (!moved || !newParent || !(moved.y > newParent.y)) {
      problems.push('the moved card is not placed below its new provider');
    }
    const counts = cardsOf()
      .filter((element) => element.dataset.kind === 'provider')
      .map((element) => {
        const badgeNode = findAllByClass(element, 'mt-badge-count')[0];
        return element.dataset.id + '=' + String(badgeNode && badgeNode.textContent);
      });
    // card-a and the card added in step 8 still hang off provider-a; card-b moved.
    const expected = 'provider-a=2 cards,' + provider.id + '=1 card';
    if (counts.join(',') !== expected) {
      problems.push(`the card-count badges after the move are ${JSON.stringify(counts)}, expected ${JSON.stringify(expected)}`);
    }
  }
  assertDraw();
}

// --- 12. zoomAt anchors the point under the cursor -----------------------------

{
  const anchors = [
    { x: 200, y: 150, factor: 1.1 },
    { x: 40, y: 620, factor: 0.9 },
  ];
  for (const anchor of anchors) {
    const before = transformOf();
    if (!before) {
      problems.push('the canvas carries no parsable transform to zoom from');
      break;
    }
    const worldX = (anchor.x - before.x) / before.zoom;
    const worldY = (anchor.y - before.y) / before.zoom;
    seam.zoomAt(anchor.x, anchor.y, anchor.factor);
    const after = transformOf();
    if (!after) {
      problems.push('zoomAt left the canvas without a parsable transform');
      continue;
    }
    const expectedZoom = Math.min(1.5, Math.max(0.4, before.zoom * anchor.factor));
    if (!near(after.zoom, expectedZoom, 1e-9)) {
      problems.push(`zoomAt(${anchor.factor}) produced scale ${after.zoom}, expected ${expectedZoom} (the chat tree's bounds are 0.4 … 1.5)`);
    }
    const landedX = after.x + worldX * after.zoom;
    const landedY = after.y + worldY * after.zoom;
    if (Math.abs(landedX - anchor.x) > 0.001 || Math.abs(landedY - anchor.y) > 0.001) {
      problems.push(
        `zoomAt moved the point under the cursor: ${anchor.x},${anchor.y} is now at ${landedX.toFixed(3)},${landedY.toFixed(3)} ` +
          `(transform ${JSON.stringify(after.record)})`,
      );
    }
  }
  // The bounds hold in both directions however many wheel notches arrive.
  for (let i = 0; i < 40; i++) seam.zoomAt(300, 300, 1.1);
  if (!near(transformOf().zoom, 1.5, 1e-9)) {
    problems.push(`zooming in 40 times reached ${transformOf().zoom}, expected the 1.5 ceiling`);
  }
  for (let i = 0; i < 40; i++) seam.zoomAt(300, 300, 0.9);
  if (!near(transformOf().zoom, 0.4, 1e-9)) {
    problems.push(`zooming out 40 times reached ${transformOf().zoom}, expected the 0.4 floor`);
  }
}

// --- 13. the wheel, a drag that never selects, and a camera the user owns ------

{
  const wrap = elementById('mt-wrap');

  /**
   * One wheel notch at a screen point must zoom towards that point: the canvas
   * point under the cursor stays put, on the plain wheel exactly as on ctrl/cmd +
   * wheel (this page has no wheel-pan).
   */
  const wheelZoomsAtThePointer = (label, fields) => {
    const before = transformOf();
    const clientX = fields.clientX;
    const clientY = fields.clientY;
    const anchorX = (clientX - before.x) / before.zoom;
    const anchorY = (clientY - before.y) / before.zoom;
    fire(wrap, 'wheel', wheelEvent(fields, wrap));
    const after = transformOf();
    if (!(after.zoom > before.zoom)) {
      problems.push(`${label} did not zoom in: ${before.zoom} → ${after.zoom}`);
      return;
    }
    if (Math.abs(after.x + anchorX * after.zoom - clientX) > 0.001 || Math.abs(after.y + anchorY * after.zoom - clientY) > 0.001) {
      problems.push(`${label} moved the point under the cursor — the wheel must go through the anchored zoomAt`);
    }
  };

  // A plain wheel zooms (it must NOT pan: this is the change that made the page's
  // wheel behave like an editor zoom instead of a scroll).
  const beforePlain = transformOf();
  wheelZoomsAtThePointer('a plain wheel', { deltaY: -1, clientX: 140, clientY: 120 });
  const afterPlain = transformOf();
  if (near(afterPlain.x, beforePlain.x) && near(afterPlain.y, beforePlain.y)) {
    problems.push('a plain wheel left the pan untouched and the zoom unchanged — it did nothing');
  }
  // … and it zooms *in* on a negative delta, out on a positive one.
  {
    const beforeOut = transformOf();
    fire(wrap, 'wheel', wheelEvent({ deltaY: 1, clientX: 140, clientY: 120 }, wrap));
    const afterOut = transformOf();
    if (!(afterOut.zoom < beforeOut.zoom)) {
      problems.push(`a wheel with a positive delta must zoom out: ${beforeOut.zoom} → ${afterOut.zoom}`);
    }
  }
  // … ctrl/cmd + wheel still works, through the very same path.
  wheelZoomsAtThePointer('ctrl + wheel', { deltaY: -1, ctrlKey: true, clientX: 110, clientY: 90 });

  // The preview's own wheel belongs to the preview (it scrolls sideways; it must
  // not wrap, because its fixed line count is what keeps the measured card height
  // stable while the fields around it are edited).
  {
    seam.selectCard('card-a');
    const preview = findAllByClass(elementById('mt-nodes'), 'mt-preview')[0] || null;
    if (!preview) {
      problems.push('the selected card carries no request preview (expected a .mt-preview element)');
    } else {
      const beforePreview = transformOf();
      fire(wrap, 'wheel', wheelEvent({ deltaY: -1, clientX: 120, clientY: 100 }, preview));
      const afterPreview = transformOf();
      if (!near(afterPreview.zoom, beforePreview.zoom)) {
        problems.push('a wheel over the request preview zoomed the tree instead of leaving the preview to scroll');
      }
    }
  }

  seam.selectCard('card-a');
  const target = cardById('card-b');
  const before = transformOf();
  fire(elementById('mt-wrap'), 'mousedown', mouseEvent(0, 100, 100, target));
  fire(elementById('mt-wrap'), 'mousemove', mouseEvent(0, 160, 140, target));
  fire(elementById('mt-wrap'), 'mouseup', mouseEvent(0, 160, 140, target));
  const panned = transformOf();
  if (!near(panned.x, before.x + 60) || !near(panned.y, before.y + 40)) {
    problems.push(`a 60×40 drag panned to ${panned.x},${panned.y}, expected ${before.x + 60},${before.y + 40}`);
  }
  // The click that ends a pan lands on whatever is under the pointer: it must not
  // change the selection.
  fire(target, 'click', mouseEvent(0, 160, 140, target));
  if (seam.state().selected !== 'card:card-a') {
    problems.push(`the click that ended a drag selected ${JSON.stringify(seam.state().selected)} — a drag must never select`);
  }
  // One automatic fit, on the first snapshot only: from here on the camera is the
  // user's, so a fresh snapshot must not move it.
  const camera = transformOf().record;
  const second = Object.assign({}, SNAPSHOT);
  if (dispatch({ type: 'modelTree', snapshot: second })) {
    problems.push('a second `modelTree` snapshot threw');
  }
  if (transformOf().record !== camera) {
    problems.push(`a snapshot after the user panned moved the camera: ${camera} → ${transformOf().record}`);
  }
}

// --- 14. a fresh snapshot rebuilds the tree ------------------------------------

{
  if (cardsOf().length !== 3) {
    problems.push(`a fresh snapshot left ${cardsOf().length} card(s) on the canvas, expected 3`);
  }
  if (!saveBtn().disabled) {
    problems.push('a fresh snapshot left the Save button enabled (a snapshot clears the dirty draft)');
  }
  assertDraw();

  const added = seam.addProvider();
  const providers = findAllByClass(canvas(), 'mt-card-provider');
  if (providers.length !== 2) {
    problems.push(`addProvider() left ${providers.length} provider card(s) on the canvas, expected 2`);
  }
  if (!added || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(added.id))) {
    problems.push(`a new provider got the id ${JSON.stringify(added && added.id)}, expected a locally generated v4 UUID`);
  }
  const newCard = cardById(added.id);
  const countBadge = newCard ? findAllByClass(newCard, 'mt-badge-count')[0] : null;
  if (!countBadge || String(countBadge.textContent) !== '0 cards') {
    problems.push(`a provider with no cards shows ${JSON.stringify(countBadge && countBadge.textContent)}, expected "0 cards"`);
  }
  if (!hasClass(newCard, 'selected')) {
    problems.push('adding a provider did not select it (its form is nowhere)');
  }
}

// --- 15. an empty draft shows the empty state ---------------------------------

{
  const before = posted.length;
  const empty = { providers: [], cards: [], defaultCardId: '', errors: [] };
  if (dispatch({ type: 'modelTree', snapshot: empty })) {
    problems.push('an empty `modelTree` snapshot threw');
  }
  if (elementById('mt-empty').classList.contains('hidden')) {
    problems.push('a draft with no cards at all shows no hint — the page would be a blank rectangle');
  }
  if (cardsOf().length !== 0) {
    problems.push(`an empty snapshot left ${cardsOf().length} card(s) on the canvas`);
  }
  if (posted.slice(before).some((message) => message && message.type === 'save')) {
    problems.push('an empty draft posted a save');
  }
  // And a node makes the hint go away again.
  seam.addProvider();
  if (!elementById('mt-empty').classList.contains('hidden')) {
    problems.push('the empty-state hint stayed up after a provider was added');
  }
}

// --- 16. the right-button autoscroll starts and stops --------------------------

// --- 21. the vision toggle owns its transport line ----------------------------
//
// The transport select shares the toggle's line and is *disabled* — not hidden —
// while the card takes no images: the line keeps its size, so the measured card
// height cannot change with the toggle. This section starts from the snapshot,
// because an earlier one may have left the page showing the empty state.

{
  dispatch({ type: 'modelTree', snapshot: SNAPSHOT });

  // The card that accepts images: the select is live, and it is on the toggle's line.
  seam.selectCard('card-a');
  const cardA = cardById('card-a');
  const rowA = findField(cardA, 'visionEnabled');
  const fieldA = findField(cardA, 'visionTransport');
  const selectA = fieldA ? firstSelect(fieldA) : null;
  if (!selectA) {
    problems.push('the image-capable card rendered no image-transport <select>');
  } else if (selectA.disabled) {
    problems.push('a card that accepts images has its image-transport <select> disabled');
  }
  if (!rowA || !fieldA || !contains(rowA, fieldA)) {
    problems.push("the image transport is not on the vision toggle's own line");
  }

  // The text-only card: the same row, greyed out.
  seam.selectCard('card-b');
  const textOnly = cardById('card-b');
  const textOnlySelect = textOnly ? firstSelect(findField(textOnly, 'visionTransport')) : null;
  if (!textOnlySelect) {
    problems.push('the text-only card rendered no image-transport <select>');
  } else if (textOnlySelect.disabled !== true) {
    problems.push('a card that accepts no images still offers an enabled image-transport <select>');
  }
  if (!findField(textOnly, 'visionEnabled')) {
    problems.push('the text-only card has no vision toggle');
  }

  // Toggling the checkbox flips the select's state, marks the draft dirty, and does
  // not rebuild the card (the element identity survives it).
  seam.selectCard('card-a');
  const cardA2 = cardById('card-a');
  const row = findField(cardA2, 'visionEnabled');
  const checkbox = row ? inputsOf(row).find((input) => input.type === 'checkbox') : null;
  const select = cardA2 ? firstSelect(findField(cardA2, 'visionTransport')) : null;
  if (!checkbox || !select) {
    problems.push('the vision row has no checkbox to toggle');
  } else {
    const before = !!select.disabled;
    checkbox.checked = !checkbox.checked;
    fire(checkbox, 'change', { target: checkbox });
    if (!!select.disabled === before) {
      problems.push(`toggling the vision checkbox left the transport ${select.disabled ? 'disabled' : 'enabled'}`);
    }
    if (cardById('card-a') !== cardA2) {
      problems.push('toggling the vision checkbox rebuilt the card — its field would lose focus');
    }
    if (!seam.state().dirty) {
      problems.push('toggling the vision checkbox did not mark the draft dirty');
    }
    // Put the draft back the way the snapshot has it, and leave the page clean.
    checkbox.checked = !checkbox.checked;
    fire(checkbox, 'change', { target: checkbox });
  }
  dispatch({ type: 'modelTree', snapshot: SNAPSHOT });
  if (seam.state().dirty) {
    problems.push('re-applying a snapshot left the draft dirty');
  }
}
// --- 22. one ↺ per resettable property, restoring the snapshot's default --------
//
// Every **resettable** property — a provider's `baseUrl`, `concurrency` and `balance`,
// a card's `contextWindow`, `concurrency`, `vision.enabled`, `vision.transport`,
// `efforts` and `defaultEffort` — carries exactly one reset button, and the fields that
// have no factory value carry none (`id`, `name` and a card's `providerId` are not
// resettable; `oaiModel` stays hand-authored). Each button restores the value **its own
// row was created with**: the built-in provider and the vendored card to
// `snapshot.defaults.builtin.*`, every other row to `snapshot.defaults.fresh.*` —
// read out of the snapshot, never a literal in the page (the second snapshot at the
// end of this section is what rules a literal out, because the fixture's own values
// are the real host's). It is disabled while the property already holds its default
// (the level list compared element-wise), a click sets only that property, marks the
// draft dirty and does **not** rebuild the card (the element identity survives it) —
// except the level list, which can add or remove rows: that one re-renders and is
// re-measured like "Add level" is. The built-in rows' *delete* buttons are disabled
// while a card that merely happens to be the default keeps an enabled one.

{
  const BUILTIN = SNAPSHOT.defaults.builtin;
  const FRESH = SNAPSHOT.defaults.fresh;
  const draftCard = (id) => seam.state().cards.find((entry) => entry.id === id);
  const draftProvider = (id) => seam.state().providers.find((entry) => entry.id === id);

  // --- every ↺ looks the same, and says the same thing ------------------------
  dispatch({ type: 'modelTree', snapshot: SNAPSHOT });
  seam.selectCard('card-a');
  {
    const all = resetsOf(canvas());
    if (all.length !== 6) {
      problems.push(
        `the selected model card renders ${all.length} reset button(s), expected exactly 6 ` +
          '(context window, concurrency, the vision toggle, the transport, the level list, the default level)',
      );
    }
    notes.push(`${all.length} reset button(s) on the selected model card`);
    for (const node of all) {
      if (String(node.textContent) !== '↺') {
        problems.push(`a reset button is labelled ${JSON.stringify(node.textContent)}, expected the shared dot-free "↺"`);
      }
      if (node.title !== 'Reset this property to its default' || node.getAttribute('aria-label') !== node.title) {
        problems.push(
          `a reset button carries ${JSON.stringify(node.title)} / ${JSON.stringify(node.getAttribute('aria-label'))} — ` +
            'every one of them shares the same sentence, as tooltip and as accessible name',
        );
      }
    }
  }

  // --- the provider: three resettable properties, and nothing else ------------
  dispatch({ type: 'modelTree', snapshot: SNAPSHOT });
  seam.selectProvider('provider-a');
  const providerCard = cardById('provider-a');
  if (resetsOf(providerCard).length !== 3) {
    problems.push(`the provider form renders ${resetsOf(providerCard).length} reset button(s), expected exactly 3 (base URL, concurrency and the wallet line)`);
  }
  for (const field of ['baseUrl', 'concurrency', 'balance']) {
    const count = resetsOf(findField(providerCard, field)).length;
    if (count !== 1) {
      problems.push(`the provider's "${field}" field renders ${count} reset button(s), expected exactly one`);
    }
  }
  for (const field of ['id', 'name', 'apiKey']) {
    const count = resetsOf(findField(providerCard, field)).length;
    if (count !== 0) {
      problems.push(`the provider's "${field}" field carries a reset button — it has no factory value to restore`);
    }
  }

  // The base URL is this provider's own (`https://provider.invalid/v1`) while the
  // concurrency already *is* the built-in default (0): one ↺ is live, one is not.
  const baseUrlReset = resetsOf(findField(providerCard, 'baseUrl'))[0];
  const providerConcurrencyReset = resetsOf(findField(providerCard, 'concurrency'))[0];
  if (!baseUrlReset || baseUrlReset.disabled) {
    problems.push("the provider's base URL differs from its default, so its reset must be enabled");
  }
  if (!providerConcurrencyReset || !providerConcurrencyReset.disabled) {
    problems.push("the provider's concurrency already holds the built-in default (0) and its reset must be disabled");
  }
  if (seam.state().dirty) {
    problems.push('a fresh snapshot left the draft dirty — the reset section cannot tell a click from an earlier edit');
  }
  if (baseUrlReset) {
    const layoutBefore = JSON.stringify(seam.layout());
    const canvasBefore = JSON.stringify(seam.canvasSize());
    fire(baseUrlReset, 'click');
    const provider = draftProvider('provider-a');
    if (!provider || provider.baseUrl !== BUILTIN.provider.baseUrl) {
      problems.push(
        `the provider's base-URL reset restored ${JSON.stringify(provider && provider.baseUrl)}, ` +
          `expected the built-in ${JSON.stringify(BUILTIN.provider.baseUrl)}`,
      );
    }
    const box = firstInput(findField(cardById('provider-a'), 'baseUrl'));
    if (!box || box.value !== BUILTIN.provider.baseUrl) {
      problems.push(`after a reset the base-URL box still shows ${JSON.stringify(box && box.value)} — the control follows the draft`);
    }
    if (cardById('provider-a') !== providerCard) {
      problems.push('a reset rebuilt the card — a fixed-height property must go through edit(), not render()');
    }
    if (JSON.stringify(seam.layout()) !== layoutBefore || JSON.stringify(seam.canvasSize()) !== canvasBefore) {
      problems.push('a reset re-laid the tree out — the card must not move under the cursor');
    }
    if (!seam.state().dirty) {
      problems.push('clicking a reset left the draft clean — Save would stay disabled');
    }
    if (baseUrlReset.disabled !== true) {
      problems.push('after its click a reset button stayed enabled although the property now holds its default');
    }
  }

  // --- a card: the six resettable properties, and no others -------------------
  dispatch({ type: 'modelTree', snapshot: SNAPSHOT });
  seam.selectCard('card-a');
  const cardA = cardById('card-a');
  for (const field of ['contextWindow', 'concurrency']) {
    const count = resetsOf(findField(cardA, field)).length;
    if (count !== 1) {
      problems.push(`the card's "${field}" field renders ${count} reset button(s), expected exactly one`);
    }
  }
  for (const field of ['id', 'name', 'oaiModel', 'providerId']) {
    const count = resetsOf(findField(cardA, field)).length;
    if (count !== 0) {
      problems.push(`the card's "${field}" field carries a reset button — it has no factory value to restore`);
    }
  }
  // The level list carries exactly two ↺ (the list itself, then its default level);
  // the vision row carries exactly two as well, at the *end* of its one line.
  if (resetsOf(findField(cardA, 'efforts')).length !== 2) {
    problems.push(`the effort-level section renders ${resetsOf(findField(cardA, 'efforts')).length} reset button(s), expected 2 (the level list and the default level)`);
  }
  const visionRow = findField(cardA, 'visionEnabled');
  const visionLine = findAllByClass(visionRow, 'mt-toggle-row')[0];
  const lineResets = resetsOf(visionRow);
  if (!visionLine) {
    problems.push('the vision row has no .mt-toggle-row line to carry the toggle, the transport and their two resets');
  } else if (lineResets.length !== 2) {
    problems.push(`the vision row carries ${lineResets.length} reset button(s), expected 2 — the toggle's and the transport's, on the one line`);
  } else {
    const tail = visionLine.children.slice(-2);
    if (!hasClass(tail[0], 'mt-reset-btn') || !hasClass(tail[1], 'mt-reset-btn')) {
      problems.push("the vision line's two resets are not the last two things on it — the toggle and its transport stay on that one line with them");
    }
  }

  // Both vision properties already hold the *built-in* card's own values (images on,
  // `deepseek`): both resets are disabled, and each one is proven to be the one its
  // own property owns by changing that property and watching which value comes back.
  const checkbox = visionRow ? inputsOf(visionRow).find((input) => input.type === 'checkbox') : null;
  const transportSelect = firstSelect(findField(cardA, 'visionTransport'));
  const toggleReset = lineResets[0];
  const transportReset = lineResets[1];
  if (!checkbox || !transportSelect || !toggleReset || !transportReset) {
    problems.push('the vision line is missing one of its four controls (the toggle, the transport, the toggle\'s reset, the transport\'s reset)');
  } else {
    if (!toggleReset.disabled || !transportReset.disabled) {
      problems.push('a card whose vision settings already match the built-in ones must have both of its vision resets disabled');
    }
    checkbox.checked = false;
    fire(checkbox, 'change', { target: checkbox });
    transportSelect.value = 'openai';
    fire(transportSelect, 'change', { target: transportSelect });
    if (toggleReset.disabled !== false || transportReset.disabled !== false) {
      problems.push('changing the vision toggle and the transport left their resets disabled — they must mean "this one was changed"');
    }
    fire(toggleReset, 'click');
    if (!checkbox.checked || draftCard('card-a').vision.enabled !== true) {
      problems.push(`the vision toggle's reset restored ${JSON.stringify(draftCard('card-a').vision.enabled)}, expected the built-in ${BUILTIN.card.vision.enabled}`);
    }
    if (transportSelect.disabled) {
      problems.push('restoring "accepts images" left the transport <select> disabled');
    }
    fire(transportReset, 'click');
    const transport = draftCard('card-a').vision.transport;
    if (transport !== BUILTIN.card.vision.transport || transportSelect.value !== BUILTIN.card.vision.transport) {
      problems.push(
        `the built-in card's transport reset restored ${JSON.stringify(transport)} (box: ${JSON.stringify(transportSelect.value)}), ` +
          `expected the built-in ${JSON.stringify(BUILTIN.card.vision.transport)}`,
      );
    }
    if (cardById('card-a') !== cardA) {
      problems.push('a vision reset rebuilt the card — the toggle line is one fixed-height row and must go through edit()');
    }
  }

  // The concurrency reset of the same card targets the **built-in** value (2500), not
  // a fresh row's 0.
  const cardAConcurrencyReset = resetsOf(findField(cardById('card-a'), 'concurrency'))[0];
  if (!cardAConcurrencyReset || cardAConcurrencyReset.disabled) {
    problems.push(`the built-in card's concurrency (0) differs from its own ${BUILTIN.card.concurrency}, so its reset must be enabled`);
  } else {
    fire(cardAConcurrencyReset, 'click');
    const value = draftCard('card-a').concurrency;
    if (value !== BUILTIN.card.concurrency) {
      problems.push(`the built-in card's concurrency reset restored ${JSON.stringify(value)}, expected the built-in ${BUILTIN.card.concurrency}`);
    }
  }

  // --- a user card: the same properties, targeting the fresh values ------------
  dispatch({ type: 'modelTree', snapshot: SNAPSHOT });
  seam.selectCard('card-b');
  const cardB = cardById('card-b');
  const cardBConcurrencyReset = resetsOf(findField(cardB, 'concurrency'))[0];
  if (!cardBConcurrencyReset || cardBConcurrencyReset.disabled) {
    problems.push("a user card's concurrency (3) differs from a fresh row's 0, so its reset must be enabled");
  } else {
    const layoutBefore = JSON.stringify(seam.layout());
    fire(cardBConcurrencyReset, 'click');
    const value = draftCard('card-b').concurrency;
    if (value !== FRESH.card.concurrency) {
      problems.push(`a user card's concurrency reset restored ${JSON.stringify(value)}, expected the fresh ${FRESH.card.concurrency}`);
    }
    const box = firstInput(findField(cardById('card-b'), 'concurrency'));
    if (!box || box.value !== String(FRESH.card.concurrency)) {
      problems.push(`after a reset the user card's concurrency box shows ${JSON.stringify(box && box.value)}, expected ${FRESH.card.concurrency}`);
    }
    if (cardById('card-b') !== cardB) {
      problems.push('a reset on a user card rebuilt it — a fixed-height property must go through edit(), not render()');
    }
    if (JSON.stringify(seam.layout()) !== layoutBefore) {
      problems.push('a reset on a user card re-laid the tree out');
    }
    if (!seam.state().dirty) {
      problems.push('clicking a reset on a user card left the draft clean');
    }
  }

  // The text-only card already holds the **fresh** transport, so that one ↺ is
  // disabled — and it is the way back once the transport is changed.
  const textOnlyLine = resetsOf(findField(cardById('card-b'), 'visionEnabled'));
  const textOnlySelect = firstSelect(findField(cardById('card-b'), 'visionTransport'));
  if (textOnlyLine.length !== 2) {
    problems.push(`the text-only card's vision row carries ${textOnlyLine.length} reset button(s), expected 2`);
  }
  if (!textOnlyLine[0] || !textOnlyLine[0].disabled) {
    problems.push('the text-only card already accepts what a fresh row accepts, so its vision-toggle reset must be disabled');
  }
  if (!textOnlyLine[1] || !textOnlyLine[1].disabled) {
    problems.push('the text-only card already carries the fresh transport, so its transport reset must be disabled');
  }
  if (textOnlyLine[1] && textOnlySelect) {
    textOnlySelect.value = 'deepseek';
    fire(textOnlySelect, 'change', { target: textOnlySelect });
    if (textOnlyLine[1].disabled !== false) {
      problems.push('changing a user card\'s transport left its reset disabled');
    }
    fire(textOnlyLine[1], 'click');
    const transport = draftCard('card-b').vision.transport;
    if (transport !== FRESH.card.vision.transport || textOnlySelect.value !== FRESH.card.vision.transport) {
      problems.push(
        `a user card's transport reset restored ${JSON.stringify(transport)} (box: ${JSON.stringify(textOnlySelect.value)}), ` +
          `expected the fresh ${JSON.stringify(FRESH.card.vision.transport)}`,
      );
    }
  }

  // --- the level list: the one reset that is a shape change -------------------
  seam.selectCard('card-b');
  const listCard = cardById('card-b');
  const rowsBefore = findAllByClass(listCard, 'mt-effort-row').length;
  const heightBefore = pxOf(listCard.style.height);
  const listResets = resetsOf(findField(listCard, 'efforts'));
  if (rowsBefore !== 1 || listResets.length !== 2) {
    problems.push(`the user card starts with ${rowsBefore} level row(s) and ${listResets.length} reset button(s), expected 1 and 2`);
  }
  if (listResets[0]) {
    fire(listResets[0], 'click');
    const rebuilt = cardById('card-b');
    if (rebuilt === listCard) {
      problems.push('the level-list reset left the card element untouched — the row count can change, so it must re-render');
    }
    const rowsAfter = findAllByClass(rebuilt, 'mt-effort-row').length;
    if (rowsAfter !== FRESH.card.efforts.length) {
      problems.push(`the level-list reset left ${rowsAfter} level row(s), expected the fresh list of ${FRESH.card.efforts.length}`);
    }
    if (!(pxOf(rebuilt.style.height) > heightBefore)) {
      problems.push(`the level-list reset left the card ${pxOf(rebuilt.style.height)}px high (was ${heightBefore}px) — a shape change must be re-measured`);
    }
    const measured = seam.layout().nodes.find((node) => node.id === 'card-b');
    if (!measured || !near(measured.h, pxOf(rebuilt.style.height))) {
      problems.push('the re-measured level list never reached the layout engine (its box is not the form\'s height)');
    }
    if (seam.layout().nodes.filter((node) => node.kind === 'card').length !== 2) {
      problems.push('the level-list reset re-render lost a card from the canvas');
    }
  }

  // The default level's ↺ is *not* a shape change: the radio group moves with the
  // draft and the card is not rebuilt.
  const defaultCard = cardById('card-b');
  const defaultReset = resetsOf(findField(defaultCard, 'efforts'))[1];
  if (!defaultReset || defaultReset.disabled) {
    problems.push(`the card's default level (high) differs from the fresh ${JSON.stringify(FRESH.card.defaultEffort)}, so its reset must be enabled`);
  } else {
    fire(defaultReset, 'click');
    const value = draftCard('card-b').defaultEffort;
    if (value !== FRESH.card.defaultEffort) {
      problems.push(`the default-level reset restored ${JSON.stringify(value)}, expected the fresh ${JSON.stringify(FRESH.card.defaultEffort)}`);
    }
    if (cardById('card-b') !== defaultCard) {
      problems.push('the default-level reset rebuilt the card — the radio group is not a shape change');
    }
    const checked = findAllByClass(cardById('card-b'), 'mt-effort-row')
      .map((row) => {
        const level = inputsOf(row).find((input) => input.type === 'text');
        const radio = inputsOf(row).find((input) => input.type === 'radio');
        return radio && radio.checked ? String(level && level.value) : '';
      })
      .filter((level) => level !== '');
    if (checked.length !== 1 || checked[0] !== FRESH.card.defaultEffort) {
      problems.push(
        `the radio group did not follow the restored default level (checked: ${JSON.stringify(checked)}), ` +
          `expected exactly ${JSON.stringify(FRESH.card.defaultEffort)}`,
      );
    }
  }

  // --- the built-in rows cannot be deleted; merely being the default is not builtin
  dispatch({ type: 'modelTree', snapshot: SNAPSHOT });
  seam.selectProvider('provider-a');
  const providerDelete = findButton(cardById('provider-a'), 'Delete provider');
  if (!providerDelete || !providerDelete.disabled) {
    problems.push("the built-in provider's delete button is enabled — the host refuses that deletion anyway");
  }
  seam.selectCard('card-a');
  const builtinDelete = findButton(cardById('card-a'), 'Delete model card');
  if (!builtinDelete || !builtinDelete.disabled) {
    problems.push("the vendored card's delete button is enabled — `isBuiltin` is what locks it");
  }
  seam.selectCard('card-b');
  const userDelete = findButton(cardById('card-b'), 'Delete model card');
  if (!userDelete || userDelete.disabled) {
    problems.push('a user card\'s delete button is disabled — only the built-in rows are locked');
  }
  const setDefault = findButton(cardById('card-b'), 'Set as default');
  if (!setDefault) {
    problems.push('the card form has no "Set as default" button to make a plain card the default with');
  } else {
    fire(setDefault, 'click');
    if (seam.state().defaultCardId !== 'card-b') {
      problems.push(`"Set as default" left the default card at ${JSON.stringify(seam.state().defaultCardId)}`);
    }
    const nowDefault = findButton(cardById('card-b'), 'Delete model card');
    if (!nowDefault || nowDefault.disabled) {
      problems.push('the card that is merely the default has a disabled delete button — being the default is a pointer, not an identity');
    }
    seam.selectCard('card-a');
    const stillLocked = findButton(cardById('card-a'), 'Delete model card');
    if (!stillLocked || !stillLocked.disabled) {
      problems.push("the built-in card's delete button was unlocked when another card became the default");
    }
  }

  // --- the targets come out of the *snapshot*, never out of the page ----------
  //
  // The fixture above carries the host's real values, so a page that hardcoded them
  // would pass every check so far. This snapshot is the same tree with every value the
  // resets can restore replaced: anything that still lands on the pinned numbers is
  // not reading `snapshot.defaults` at all.
  const ALTERNATE = {
    builtin: {
      provider: { baseUrl: 'https://builtin.invalid/v1', concurrency: 42, balance: 'moonshot' },
      card: {
        contextWindow: 111,
        concurrency: 222,
        vision: { enabled: false, transport: 'openai' },
        efforts: ['none'],
        defaultEffort: 'none',
      },
    },
    fresh: {
      provider: { baseUrl: 'https://fresh.invalid/v1', concurrency: 7, balance: 'openrouter' },
      card: {
        contextWindow: 333,
        concurrency: 444,
        vision: { enabled: true, transport: 'deepseek' },
        efforts: ['none', 'low'],
        defaultEffort: 'low',
      },
    },
  };
  dispatch({ type: 'modelTree', snapshot: Object.assign({}, SNAPSHOT, { defaults: ALTERNATE }) });

  seam.selectProvider('provider-a');
  if (resetsOf(findField(cardById('provider-a'), 'baseUrl'))[0]) {
    fire(resetsOf(findField(cardById('provider-a'), 'baseUrl'))[0], 'click');
    const provider = draftProvider('provider-a');
    if (!provider || provider.baseUrl !== ALTERNATE.builtin.provider.baseUrl) {
      problems.push(
        `the built-in provider's reset restored ${JSON.stringify(provider && provider.baseUrl)}, expected the snapshot's ` +
          `${JSON.stringify(ALTERNATE.builtin.provider.baseUrl)} — the target must be read from snapshot.defaults, never written into the page`,
      );
    }
  }
  const freshProvider = seam.addProvider();
  if (!freshProvider) {
    problems.push('addProvider() returned nothing while checking where a user provider\'s reset points');
  } else {
    const reset = resetsOf(findField(cardById(freshProvider.id), 'baseUrl'))[0];
    if (!reset) {
      problems.push('a user provider renders no base-URL reset button');
    } else {
      fire(reset, 'click');
      const provider = draftProvider(freshProvider.id);
      if (!provider || provider.baseUrl !== ALTERNATE.fresh.provider.baseUrl) {
        problems.push(
          `a user provider's reset restored ${JSON.stringify(provider && provider.baseUrl)}, expected the snapshot's fresh ` +
            `${JSON.stringify(ALTERNATE.fresh.provider.baseUrl)}`,
        );
      }
    }
    // A provider created under *this* snapshot is seeded from its fresh wallet line,
    // and its ↺ is already disabled because of that — the value came out of
    // `snapshot.defaults`, exactly like the base URL above.
    const freshWalletField = findField(cardById(freshProvider.id), 'balance');
    const freshWalletSelect = freshWalletField ? firstSelect(freshWalletField) : null;
    const freshWalletReset = resetsOf(freshWalletField)[0];
    if (!freshWalletSelect || freshWalletSelect.value !== ALTERNATE.fresh.provider.balance) {
      problems.push(
        `a new provider's wallet line shows ${JSON.stringify(freshWalletSelect && freshWalletSelect.value)}, expected the snapshot's ` +
          `fresh ${JSON.stringify(ALTERNATE.fresh.provider.balance)}`,
      );
    }
    if (!freshWalletReset || !freshWalletReset.disabled) {
      problems.push('a new provider already carries the snapshot\'s fresh wallet line, so its reset must be disabled');
    }
  }

  // The built-in provider's wallet line is read from the snapshot too: it holds the
  // fixture's `deepseek`, this snapshot says `moonshot`, so the ↺ is live and lands on
  // the snapshot's value, never on the page's own copy of `BUILTIN_PROVIDER_DEFAULTS`.
  seam.selectProvider('provider-a');
  const altWalletReset = resetsOf(findField(cardById('provider-a'), 'balance'))[0];
  if (!altWalletReset || altWalletReset.disabled) {
    problems.push(
      `the snapshot's built-in wallet line (${JSON.stringify(ALTERNATE.builtin.provider.balance)}) differs from the draft's, so its reset must be enabled`,
    );
  } else {
    fire(altWalletReset, 'click');
    const provider = draftProvider('provider-a');
    if (!provider || provider.balance !== ALTERNATE.builtin.provider.balance) {
      problems.push(
        `the built-in provider's wallet-line reset restored ${JSON.stringify(provider && provider.balance)}, expected the snapshot's ` +
          `${JSON.stringify(ALTERNATE.builtin.provider.balance)} — the target is taken from snapshot.defaults.builtin`,
      );
    }
  }

  seam.selectCard('card-a');
  fire(resetsOf(findField(cardById('card-a'), 'concurrency'))[0], 'click');
  const altBuiltinCard = draftCard('card-a');
  if (!altBuiltinCard || altBuiltinCard.concurrency !== ALTERNATE.builtin.card.concurrency) {
    problems.push(
      `the built-in card's concurrency reset restored ${JSON.stringify(altBuiltinCard && altBuiltinCard.concurrency)}, expected the ` +
        `snapshot's ${ALTERNATE.builtin.card.concurrency} — the target is taken from snapshot.defaults.builtin`,
    );
  }
  seam.selectCard('card-b');
  fire(resetsOf(findField(cardById('card-b'), 'concurrency'))[0], 'click');
  const altUserCard = draftCard('card-b');
  if (!altUserCard || altUserCard.concurrency !== ALTERNATE.fresh.card.concurrency) {
    problems.push(
      `a user card's concurrency reset restored ${JSON.stringify(altUserCard && altUserCard.concurrency)}, expected the snapshot's ` +
        `fresh ${ALTERNATE.fresh.card.concurrency} — the target is taken from snapshot.defaults.fresh`,
    );
  }

  // And a snapshot with no `defaults` at all (an older host) must not throw: the page
  // falls back to a minimal set of its own and keeps working.
  const noDefaults = { providers: SNAPSHOT.providers, cards: SNAPSHOT.cards, defaultCardId: 'card-a', errors: [] };
  if (dispatch({ type: 'modelTree', snapshot: noDefaults })) {
    problems.push('a `modelTree` snapshot with no `defaults` threw — an older host must still be able to drive the page');
  }
  if (cardsOf().length !== 3 || resetsOf(canvas()).length === 0) {
    problems.push('a snapshot with no `defaults` left the page without its cards or without any reset button');
  }

  // The guard leaves the page on the snapshot the autoscroll section expects.
  dispatch({ type: 'modelTree', snapshot: SNAPSHOT });
  if (seam.state().dirty) {
    problems.push('re-applying a snapshot at the end of the reset section left the draft dirty');
  }
}

// --- 23. the provider's wallet line: four dialects, one ↺, one round trip ------
//
// A provider *declares* how its wallet is read (`ProviderSpec.balance`) — the same
// shape of decision as a card's image transport, never a probe. The form offers
// exactly the four names `src/agent/balance.ts` knows, in that frozen order and
// labelled with the vendor whose response shape it is; `none` leads because it is
// what a new row carries. The current value is the provider's own dialect, the ↺
// restores *that row's* factory dialect — `deepseek` for the built-in row, `none` for
// a user row — and is disabled while the value already is that dialect. Changing the
// select is **not** a shape change: it goes through `edit()`, like the vision
// transport, so nothing on screen moves (the counterpart is the level-list ↺ in
// section 22, the one reset that can add or remove rows and therefore re-renders and
// is re-measured).

{
  // The four labels are one string per dialect: `none` says what it is rather than
  // naming a vendor, and the other three are the vendor's own name.
  const DIALECT_OPTIONS = 'none=No wallet line,deepseek=DeepSeek,openrouter=OpenRouter,moonshot=Moonshot';
  const draftProvider = (id) => seam.state().providers.find((entry) => entry.id === id);

  // --- the four dialects, in the frozen order, showing the row's own ----------
  dispatch({ type: 'modelTree', snapshot: SNAPSHOT });
  seam.selectProvider('provider-a');
  const providerCard = cardById('provider-a');
  const balanceField = providerCard ? findField(providerCard, 'balance') : null;
  const formSelect = balanceField ? firstSelect(balanceField) : null;
  if (!formSelect) {
    problems.push('the selected provider card has no wallet-line <select>');
  } else {
    const options = formSelect.children.map((option) => option.value + '=' + option.textContent);
    if (options.join(',') !== DIALECT_OPTIONS) {
      problems.push(`the wallet-line <select> offers ${JSON.stringify(options)}, expected ${JSON.stringify(DIALECT_OPTIONS)}`);
    }
    // … and it shows the provider's own dialect: this row points at DeepSeek's
    // endpoint, so its wallet line is `deepseek`.
    if (formSelect.value !== 'deepseek') {
      problems.push(`the built-in provider's wallet line shows ${JSON.stringify(formSelect.value)}, expected its own "deepseek"`);
    }
    notes.push(`${formSelect.children.length} wallet dialect(s) in the provider form`);
  }

  // A provider that declares another dialect shows it: this is the row's data, not a
  // page-side default.
  const declared = JSON.parse(JSON.stringify(SNAPSHOT));
  declared.providers.push({
    id: 'provider-b',
    name: 'Wallet provider',
    baseUrl: 'https://api.moonshot.cn/v1',
    balance: 'moonshot',
    concurrency: 0,
    hasKey: false,
    isBuiltin: false,
  });
  dispatch({ type: 'modelTree', snapshot: declared });
  seam.selectProvider('provider-b');
  const declaredSelect = firstSelect(findField(cardById('provider-b'), 'balance'));
  if (!declaredSelect || declaredSelect.value !== 'moonshot') {
    problems.push(
      `a provider declaring the moonshot wallet line shows ${JSON.stringify(declaredSelect && declaredSelect.value)}, expected "moonshot"`,
    );
  }

  // A dialect this build does **not** know — a hand-edited settings row — reads as
  // "no wallet line": the select can never show a fifth option, and the page can never
  // post a name the host would refuse (it refuses an unknown dialect outright, see
  // tools/modeltree-acceptance.js).
  const bogus = JSON.parse(JSON.stringify(SNAPSHOT));
  bogus.providers[0].balance = 'plaid';
  dispatch({ type: 'modelTree', snapshot: bogus });
  seam.selectProvider('provider-a');
  const bogusSelect = firstSelect(findField(cardById('provider-a'), 'balance'));
  if (!bogusSelect || bogusSelect.value !== 'none') {
    problems.push(
      `a provider declaring the unknown wallet line "plaid" shows ` +
        `${JSON.stringify(bogusSelect && bogusSelect.value)}, expected the fallback "none"`,
    );
  }

  // --- the built-in row: its ↺ restores `deepseek` ----------------------------
  dispatch({ type: 'modelTree', snapshot: SNAPSHOT });
  seam.selectProvider('provider-a');
  const builtinCard = cardById('provider-a');
  const builtinField = builtinCard ? findField(builtinCard, 'balance') : null;
  const builtinSelect = builtinField ? firstSelect(builtinField) : null;
  const builtinReset = resetsOf(builtinField)[0];
  if (!builtinSelect || !builtinReset) {
    problems.push('the built-in provider renders no wallet-line reset button');
  } else {
    if (!builtinReset.disabled) {
      problems.push('the built-in provider already carries its own "deepseek", so its wallet-line reset must be disabled');
    }
    builtinSelect.value = 'openrouter';
    fire(builtinSelect, 'change', { target: builtinSelect });
    if (draftProvider('provider-a').balance !== 'openrouter') {
      problems.push(`choosing OpenRouter left the draft at ${JSON.stringify(draftProvider('provider-a').balance)}`);
    }
    if (builtinReset.disabled !== false) {
      problems.push("changing a provider's wallet line left its reset disabled");
    }
    // The select is a fixed-height field: `edit()`, never `render()`.
    if (cardById('provider-a') !== builtinCard) {
      problems.push('changing the wallet line rebuilt the card — a fixed-height select must go through edit(), not render()');
    }
    fire(builtinReset, 'click');
    const restored = draftProvider('provider-a').balance;
    if (restored !== SNAPSHOT.defaults.builtin.provider.balance || builtinSelect.value !== SNAPSHOT.defaults.builtin.provider.balance) {
      problems.push(
        `the built-in provider's wallet-line reset restored ${JSON.stringify(restored)} (box: ${JSON.stringify(builtinSelect.value)}), ` +
          `expected the built-in ${JSON.stringify(SNAPSHOT.defaults.builtin.provider.balance)}`,
      );
    }
    if (builtinReset.disabled !== true) {
      problems.push('after its click a wallet-line reset stayed enabled although the property now holds its default');
    }
  }

  // --- a user row: it starts on `none`, and its ↺ goes back to `none` ---------
  dispatch({ type: 'modelTree', snapshot: SNAPSHOT });
  const freshProvider = seam.addProvider();
  if (!freshProvider) {
    problems.push('addProvider() returned nothing while checking the wallet line');
  } else {
    const freshField = findField(cardById(freshProvider.id), 'balance');
    const freshSelect = freshField ? firstSelect(freshField) : null;
    const freshReset = resetsOf(freshField)[0];
    if (!freshSelect || freshSelect.value !== 'none') {
      problems.push(`a fresh provider's wallet line shows ${JSON.stringify(freshSelect && freshSelect.value)}, expected the fresh "none"`);
    }
    if (!freshReset || !freshReset.disabled) {
      problems.push('a fresh provider already carries the fresh wallet line (none), so its reset must be disabled');
    }
    if (freshSelect && freshReset) {
      const layoutBefore = JSON.stringify(seam.layout());
      const canvasBefore = JSON.stringify(seam.canvasSize());
      freshSelect.value = 'openrouter';
      fire(freshSelect, 'change', { target: freshSelect });
      if (draftProvider(freshProvider.id).balance !== 'openrouter') {
        problems.push(`choosing OpenRouter on a user row left the draft at ${JSON.stringify(draftProvider(freshProvider.id).balance)}`);
      }
      if (freshReset.disabled !== false) {
        problems.push("changing a user provider's wallet line left its reset disabled");
      }
      // Not a shape change: no re-layout, no rebuild (the level-list ↺ is the one
      // reset that moves the tree, section 22).
      if (JSON.stringify(seam.layout()) !== layoutBefore || JSON.stringify(seam.canvasSize()) !== canvasBefore) {
        problems.push('changing the wallet line re-laid the tree out — the select is not a shape change');
      }
      fire(freshReset, 'click');
      const restored = draftProvider(freshProvider.id).balance;
      if (restored !== 'none' || freshSelect.value !== 'none') {
        problems.push(
          `a user provider's wallet-line reset restored ${JSON.stringify(restored)} (box: ${JSON.stringify(freshSelect.value)}), ` +
            'expected the fresh "none"',
        );
      }
    }
  }
  assertDraw();

  // --- the round trip: pick OpenRouter, save, and the payload carries it ------
  dispatch({ type: 'modelTree', snapshot: SNAPSHOT });
  seam.selectProvider('provider-a');
  const roundTripSelect = firstSelect(findField(cardById('provider-a'), 'balance'));
  if (!roundTripSelect) {
    problems.push('the provider form lost its wallet-line <select> before the round trip');
  } else {
    roundTripSelect.value = 'openrouter';
    fire(roundTripSelect, 'change', { target: roundTripSelect });
    posted.length = 0;
    const refused = seam.save();
    if (refused.length > 0) {
      problems.push(`save() refused a complete draft after a wallet-line edit: ${JSON.stringify(refused)}`);
    }
    const sent = posted.find((message) => message && message.type === 'save');
    const sentProvider = sent && sent.payload && sent.payload.providers.find((entry) => entry.id === 'provider-a');
    if (!sentProvider || sentProvider.balance !== 'openrouter') {
      problems.push(
        `the save payload carries ${JSON.stringify(sentProvider && sentProvider.balance)} as the provider's wallet line, expected "openrouter"`,
      );
    }
  }
  // Leave the page clean for the autoscroll section.
  dispatch({ type: 'modelTree', snapshot: SNAPSHOT });
  if (seam.state().dirty) {
    problems.push('re-applying a snapshot at the end of the wallet-line section left the draft dirty');
  }
}

function report() {
  if (problems.length > 0) {
    console.error('FAIL check-modeltree: the Model Card Tree page does not match the host protocol\n');
    for (const problem of new Set(problems)) {
      console.error('  ' + problem);
    }
    console.error(
      '\nThe protocol is frozen in src/chat/ModelPanel.ts: if the host really changed, ' +
        'update media/modeltree.js and this checker together.',
    );
    process.exit(1);
  }

  console.log(`PASS check-modeltree: ${notes.join('; ')}.`);
  process.exit(0);
}

{
  const wrap = elementById('mt-wrap');
  const marker = () => (document.body.children || []).find((child) => hasClass(child, 'autoscroll-origin')) || null;

  const press = mouseEvent(2, 300, 200, wrap);
  fire(wrap, 'mousedown', press);
  if (!marker()) {
    problems.push('an RMB press on the canvas started no autoscroll (no .autoscroll-origin marker)');
  }
  if (!wrap.classList.contains('autoscrolling')) {
    problems.push('the autoscroll did not put the wrap into its all-scroll cursor state (.autoscrolling)');
  }
  if (!press.defaultPrevented) {
    problems.push('the RMB press was not prevented — the host\'s own menu would take the gesture');
  }

  // The pan keeps travelling towards the cursor while it sits still, so give the frame
  // loop a cursor far from the origin and a real stretch of time.
  fireWindow('mousemove', mouseEvent(0, 900, 700, wrap));
  const before = transformOf();
  setTimeout(() => {
    const moved = transformOf();
    if (moved.x === before.x && moved.y === before.y) {
      problems.push('the autoscroll frame loop never moved the view towards the cursor');
    }
    fireWindow('mouseup', mouseEvent(0, 900, 700, wrap));
    if (marker()) {
      problems.push('mouseup left the autoscroll origin marker on screen');
    }
    if (wrap.classList.contains('autoscrolling')) {
      problems.push('mouseup left the wrap in its all-scroll cursor state');
    }
    // And the pan really stopped: the transform must not move again.
    const stopped = transformOf();
    setTimeout(() => {
      if (transformOf().record !== stopped.record) {
        problems.push('the autoscroll kept panning after the gesture was released');
      }
      // Escape and blur are the other two release paths.
      fire(wrap, 'mousedown', mouseEvent(2, 120, 120, wrap));
      if (!marker()) {
        problems.push('a second RMB press did not start a new autoscroll');
      }
      fireWindow('keydown', keyEvent('Escape'));
      if (marker() || wrap.classList.contains('autoscrolling')) {
        problems.push('Escape did not end the autoscroll');
      }
      fire(wrap, 'mousedown', mouseEvent(2, 120, 120, wrap));
      fireWindow('blur', mouseEvent(0, 120, 120, wrap));
      if (marker() || wrap.classList.contains('autoscrolling')) {
        problems.push('blur did not end the autoscroll');
      }
      report();
    }, 30);
  }, 40);
}
