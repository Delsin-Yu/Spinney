/*
 * Model Card Tree — the webview script of the "Model Card Tree" page
 * (`src/chat/ModelPanel.ts` hosts it; the protocol is frozen there).
 *
 * The page browses and edits the *stored model configuration*: one card per
 * provider node, that provider's model cards branching below it. Nothing here
 * writes settings. The page keeps a local DRAFT, edits it in place — on the
 * selected node's own card, which expands into its form — and posts the whole
 * desired state at once when the user presses Save, so a deletion is simply an id
 * that is no longer in the list, and a failed save leaves the draft exactly as the
 * user left it.
 *
 *   host → page   { type: 'modelTree', snapshot }
 *                 { type: 'modelTreeSaveResult', ok, errors, savedAt }
 *   page → host   { type: 'ready' }  (once, at boot)
 *                 { type: 'save', payload }
 *                 { type: 'openSettingsJson' }
 *
 * There is no side panel: `#mt-main` holds the tree and nothing else, and the
 * *selected* node's card expands in place into its own form — every field the
 * docked inspector used to hold, the read-only id and the request preview included.
 * The other cards stay compact (title / subtitle / badges) so the tree stays
 * readable, and a click selects while a drag pans and must never select. Only a
 * change of *shape* may move anything: select / deselect, add or remove a node, add
 * or remove an effort level, change the vision transport, change a card's provider,
 * revert or apply a snapshot. A keystroke inside a field only redraws the save state
 * and the preview — and because a single-line input (and the preview, which never
 * wraps) keeps a fixed height, typing cannot change what was measured.
 *
 * Every *resettable* property carries a small `↺` that restores that one property to
 * the value **its own row was created with**: the built-in provider and the vendored
 * card to their factory state, every other row to what a brand-new row carries. Both
 * halves come from the snapshot (`snapshot.defaults`, `ModelTreeDefaults` in
 * `src/chat/ModelPanel.ts`) — the page holds no copy of those numbers of its own. The
 * button is disabled while the property already holds its default, so an enabled ↺
 * means "this one was changed"; a click marks the draft dirty and goes through
 * `edit()`, never `render()`, for every property whose row count cannot change (a
 * reset must not rebuild the card under the user's cursor). The effort *list* is the
 * one exception: restoring it can add or remove level rows, which is a shape change,
 * so it re-renders and re-measures like "Add level" does.
 *
 * Geometry is the same vendored engine the chat tree draws with
 * (`window.nonLayeredTidyTreeLayout`, loaded by the HTML shell before this file):
 * a synthetic, invisible root hangs every provider off it, and each provider's
 * model cards are its engine children. The layout is **two-pass**, because the
 * selected card *is* a form and its height depends on how many effort rows it has:
 * the DOM is built first, measured (`offsetWidth` / `offsetHeight` — a browser
 * cannot tell us the height of a form it has not rendered) and only the measured box
 * is handed to the engine. The drawing is the chat tree's technique —
 * absolutely-positioned rounded divs plus one SVG layer of elbow connectors
 * (`media/main.js`) — not `media/tree.js`, whose sidecar/`cells` rules are about
 * sub-agent windows in a conversation.
 *
 * The gestures are the chat tree's set (`media/main.js`) with one deliberate
 * difference: **the wheel scales**, anchored on the pointer, with or without
 * ctrl/cmd. The chat tree pans on a plain wheel and zooms on ctrl/cmd + wheel; this
 * page is a handful of cards, so the wheel is its zoom. Everything else is the same:
 * LMB/MMB drag pan, RMB-hold autoscroll towards the cursor, fit to view (plus one
 * automatic fit when the first snapshot arrives), and a drag that never selects.
 *
 * Every string the user can see goes through `tr()` with the English source as one
 * literal (tools/check-l10n.js extracts exactly that shape), and no model id is
 * ever written here: the names come from the snapshot.
 */
(function () {
  const vscode = acquireVsCodeApi();

  /**
   * Translate one UI string into the VS Code display language.
   *
   * Copied verbatim from `media/main.js` — a webview cannot import anything, and
   * there is no export surface anywhere in media/. `message` is the English
   * source string and doubles as the key of the host's catalog; the host injects
   * the whole catalog as `window.__spinneyL10n`. An English window, a stale
   * bundle, or (as in `tools/check-modeltree.js`) no dictionary at all falls back
   * to `message` itself, so the page never shows a raw key.
   */
  function tr(message, ...args) {
    const dict = window.__spinneyL10n;
    let text = (dict && dict[message]) || message;
    for (let i = 0; i < args.length; i++) {
      text = text.split('{' + i + '}').join(String(args[i]));
    }
    return text;
  }

  /*
   * Testing seam — tools/check-modeltree.js loads this file in a stub DOM and
   * drives *these* functions, the very ones the buttons call, so it can assert a
   * full add-card → save round trip ends in the right message. `state()` hands out
   * the live draft on purpose: a guard has to name a brand-new card (the one field a
   * new card does not come with) before `save()` has anything to post.
   *
   * `layout()` and `canvasSize()` expose what the drawing produced — the placed node
   * boxes and the size the `<svg>` layer was given — because a connector drawn into a
   * 0×0 viewport is invisible while every string check still passes, and `zoomAt` /
   * `fitToView` are the view's, so the guard can prove a zoom keeps the point under
   * the cursor still. Nothing in the page itself reads this object.
   */
  window.__modeltreeTest = {
    selectCard: selectCard,
    selectProvider: selectProvider,
    addCard: addCard,
    addProvider: addProvider,
    save: save,
    state: state,
    layout: layoutInfo,
    canvasSize: canvasSize,
    zoomAt: zoomAt,
    fitToView: fitToView,
  };

  // --- the HTML shell's fixed elements ---------------------------------------

  const wrapEl = document.getElementById('mt-wrap');
  const canvasEl = document.getElementById('mt-canvas');
  const edgesEl = document.getElementById('mt-edges');
  const nodesEl = document.getElementById('mt-nodes');
  const emptyEl = document.getElementById('mt-empty');
  const bannerEl = document.getElementById('mt-banner');
  const fitBtn = document.getElementById('mt-fit');
  const saveBtn = document.getElementById('mt-save');
  const revertBtn = document.getElementById('mt-revert');
  const settingsBtn = document.getElementById('mt-settings');
  const addProviderBtn = document.getElementById('mt-add-provider');

  // --- geometry --------------------------------------------------------------

  /** The compact card: title / subtitle / badges, today's size. */
  const PROVIDER_W = 236;
  const PROVIDER_H = 68;
  const CARD_W = 224;
  const CARD_H = 64;
  /** The selected card is a form: wider, and as tall as the measured form. */
  const SELECTED_PROVIDER_W = 320;
  const SELECTED_CARD_W = 380;
  /** The measured height is the real one; these are only the fallback for a document
   *  that cannot be measured at all (a hidden panel, a stub DOM). */
  const SELECTED_PROVIDER_H = 320;
  const SELECTED_CARD_H = 420;
  const H_GAP = 36;
  const V_GAP = 64;
  const PAD = 24;
  /** Engine id of the invisible root every provider hangs off. */
  const ROOT_KEY = '#root';
  /** The chat tree's zoom bounds (`media/main.js`): a large tree can be panned as one
   *  small overview, and nothing is gained by magnifying past 150%. */
  const ZOOM_MIN = 0.4;
  const ZOOM_MAX = 1.5;

  // --- state -----------------------------------------------------------------

  /** The last snapshot the host posted (the page's "as stored" world). */
  let snapshot = emptySnapshot();
  /** The edited copy of it: what the tree, the card forms and Save work on. */
  let draft = draftFromSnapshot(snapshot);
  /**
   * What every `↺` restores, straight out of the snapshot: `builtin` is the built-in
   * provider / vendored card's **own** factory state, `fresh` is what a brand-new row
   * carries (`ModelTreeDefaults`, src/chat/ModelPanel.ts). The page never writes one
   * of these values itself — they live in `src/agent/models.ts` and the host posts
   * them in every snapshot; see `readDefaults` for what a host that posts none leaves
   * behind (a minimal set, never a throw).
   */
  let defaults = readDefaults(null);
  /** `{ kind: 'provider' | 'card', id }` or null. */
  let selection = null;
  /** Has the draft drifted from `snapshot`? Save is disabled while it has not. */
  let dirty = false;
  /** Validation problems, or the host's `errors` after a failed save. */
  let saveErrors = [];
  let pan = { x: 0, y: 0 };
  let zoom = 1;
  /** The measured, laid-out box of the last draw — what "fit to view" fits. */
  let box = { w: 1, h: 1 };
  /** The same draw, as boxes: what `layout()` hands the guard. */
  let lastLayout = { w: 1, h: 1, nodes: [] };
  /** The `<pre>` of the selected model card's form, when there is one. */
  let previewEl = null;
  /**
   * The live `↺` buttons of the form on screen (rebuilt with it, see `renderTree`).
   * Their enabled state is a property of the draft, so it has to be re-evaluated
   * whenever a field changes — including from the field's own control, not only from
   * a click on the button itself.
   */
  let resetButtons = [];
  let drag = null;
  let dragMoved = false;
  /** One automatic fit per page load, and only while the camera is still ours. */
  let autoFitDone = false;
  let viewTouched = false;

  // --- tiny DOM helpers ------------------------------------------------------

  function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function clear(node) {
    while (node.children && node.children.length > 0) {
      node.removeChild(node.children[0]);
    }
    node.innerHTML = '';
  }

  function setHidden(node, hidden) {
    if (hidden) node.classList.add('hidden');
    else node.classList.remove('hidden');
  }

  function setText(node, text) {
    node.textContent = text;
    return node;
  }

  function badge(text, extraClass) {
    return setText(el('span', extraClass ? 'mt-badge ' + extraClass : 'mt-badge'), text);
  }

  function button(text, className, onClick, disabled) {
    const node = el('button', className);
    node.textContent = text;
    node.disabled = !!disabled;
    node.addEventListener('click', onClick);
    return node;
  }

  function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
  }

  /** An id interpolated into the connector layer's markup (`data-from`/`data-to`). */
  function attr(value) {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  // --- ids -------------------------------------------------------------------

  /**
   * A v4 UUID, built here on purpose: `crypto.randomUUID` does not exist in every
   * webview host, and the id is *stored data* (it never changes once assigned), so
   * it must be generated locally. `Math.random` is the fallback for a host without
   * `crypto.getRandomValues` — a new node's id only has to be unique in this file.
   */
  function uuidV4() {
    const source = (window.crypto && typeof window.crypto.getRandomValues === 'function')
      ? window.crypto
      : (typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function' ? crypto : null);
    const bytes = new Uint8Array(16);
    if (source) {
      source.getRandomValues(bytes);
    } else {
      for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;   // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80;   // RFC 4122 variant
    const hex = [];
    for (let i = 0; i < 16; i++) hex.push((bytes[i] + 0x100).toString(16).slice(1));
    return (
      hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' + hex.slice(6, 8).join('') +
      '-' + hex.slice(8, 10).join('') + '-' + hex.slice(10, 16).join('')
    );
  }

  // --- the draft -------------------------------------------------------------

  function emptySnapshot() {
    return { providers: [], cards: [], defaultCardId: '', errors: [] };
  }

  function text(value) {
    return typeof value === 'string' ? value : '';
  }

  /**
   * A whole number from an input's value, or NaN — the fields are `<input
   * type=number>` but an emptied box must not silently become 0 (an empty
   * concurrency means "unset", and validation says so).
   */
  function toInt(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!/^-?\d+$/.test(raw)) return NaN;
    return parseInt(raw, 10);
  }

  function isCount(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
  }

  /**
   * The card's image transport, in the two names the page works in: `deepseek`
   * (upload to `POST /files`, then reference the id — DeepSeek's own extension) and
   * `openai` (a `data:` URL inside an `image_url` part — the OpenAI-compatible
   * shape). The two are the only values the field ever holds: the host parses them
   * that way and this page writes them that way.
   *
   * A **missing** value reads as `openai`, the default for a new card, so a
   * snapshot the host did not fill in fully still draws a usable select instead of
   * throwing; anything that is not `deepseek` is that same default.
   */
  function normalizeTransport(value) {
    const raw = String(value == null ? '' : value).trim().toLowerCase();
    return raw === 'deepseek' ? 'deepseek' : 'openai';
  }

  /**
   * The reset targets of a snapshot (`ModelTreeDefaults`), as the page reads them:
   * every field coerced to the type the draft uses, so a host that sends a string
   * where a number belongs cannot put one into a form. Nothing here throws, and
   * nothing here guesses.
   *
   * A message with no `defaults` at all — an older host — leaves the page on the
   * **minimal** set: an empty base URL, a zero, no level, the standard transport. That
   * is deliberately *not* a copy of the built-in values: the numbers live in
   * `src/agent/models.ts` and the host is the one that posts them, so the page has no
   * opinion about what a row was created with. A property that already holds one of
   * these values simply has a disabled `↺`, which is the honest answer, and the page
   * keeps working either way.
   */
  function readProviderDefaults(raw) {
    const fields = raw && typeof raw === 'object' ? raw : {};
    return {
      baseUrl: text(fields.baseUrl),
      concurrency: isCount(fields.concurrency) ? fields.concurrency : 0,
    };
  }

  function readCardDefaults(raw) {
    const fields = raw && typeof raw === 'object' ? raw : {};
    const vision = fields.vision && typeof fields.vision === 'object' ? fields.vision : {};
    return {
      contextWindow: isCount(fields.contextWindow) ? fields.contextWindow : 0,
      concurrency: isCount(fields.concurrency) ? fields.concurrency : 0,
      vision: { enabled: !!vision.enabled, transport: normalizeTransport(vision.transport) },
      // A fresh array on every read: a reset *assigns* it to the draft, and the
      // draft's own list is edited in place (a keystroke in a level box).
      efforts: Array.isArray(fields.efforts) ? fields.efforts.map(text) : [],
      defaultEffort: text(fields.defaultEffort),
    };
  }

  function readDefaults(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const half = (value) => {
      const fields = value && typeof value === 'object' ? value : {};
      return { provider: readProviderDefaults(fields.provider), card: readCardDefaults(fields.card) };
    };
    return { builtin: half(source.builtin), fresh: half(source.fresh) };
  }

  /**
   * The factory values of the row a form belongs to: the **built-in** pair for the
   * built-in provider and the vendored card, the **fresh** pair for every other row.
   * `isBuiltin` comes from the host — the page knows neither id — and the lookup runs
   * on every call rather than capturing a value, so a `↺` always restores what the
   * snapshot in hand says.
   */
  function providerDefaults(provider) {
    return provider.isBuiltin ? defaults.builtin.provider : defaults.fresh.provider;
  }

  function cardDefaults(card) {
    return card.isBuiltin ? defaults.builtin.card : defaults.fresh.card;
  }

  /**
   * Are two effort lists the same list? Element-wise, because "already holds its
   * default" is a deep compare of an array and `===` would only compare references —
   * which are never the same object.
   */
  function sameLevels(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (String(a[i]) !== String(b[i])) return false;
    }
    return true;
  }

  function draftFromSnapshot(source) {
    return {
      providers: (source.providers || [])
        .filter((provider) => provider && text(provider.id))
        .map((provider) => ({
          id: provider.id,
          name: text(provider.name),
          baseUrl: text(provider.baseUrl),
          concurrency: toInt(provider.concurrency),
          hasKey: !!provider.hasKey,
          isBuiltin: !!provider.isBuiltin,
        })),
      cards: (source.cards || [])
        .filter((card) => card && text(card.id))
        .map((card) => ({
          id: card.id,
          name: text(card.name),
          providerId: text(card.providerId),
          oaiModel: text(card.oaiModel),
          contextWindow: toInt(card.contextWindow),
          concurrency: toInt(card.concurrency),
          vision: {
            enabled: !!(card.vision && card.vision.enabled),
            transport: normalizeTransport(card.vision && card.vision.transport),
          },
          efforts: Array.isArray(card.efforts) ? card.efforts.map(text) : [],
          defaultEffort: text(card.defaultEffort),
          isBuiltin: !!card.isBuiltin,
        })),
      defaultCardId: text(source.defaultCardId),
      // A key the page has never seen: the value is only ever filled by typing.
      apiKeys: {},
      clearedKeys: [],
    };
  }

  function providerById(id) {
    for (const provider of draft.providers) {
      if (provider.id === id) return provider;
    }
    return null;
  }

  function cardById(id) {
    for (const card of draft.cards) {
      if (card.id === id) return card;
    }
    return null;
  }

  function selectedProvider() {
    return selection && selection.kind === 'provider' ? providerById(selection.id) : null;
  }

  function selectedCard() {
    return selection && selection.kind === 'card' ? cardById(selection.id) : null;
  }

  function isSelected(kind, id) {
    return !!selection && selection.kind === kind && selection.id === id;
  }

  /** Keep a live selection across a rebuild; fall back to the first node there is. */
  function ensureSelection() {
    if (selection) {
      const alive = selection.kind === 'provider' ? !!providerById(selection.id) : !!cardById(selection.id);
      if (alive) return;
      selection = null;
    }
    if (draft.providers.length > 0) {
      selection = { kind: 'provider', id: draft.providers[0].id };
    } else if (draft.cards.length > 0) {
      selection = { kind: 'card', id: draft.cards[0].id };
    }
  }

  // --- validation ------------------------------------------------------------

  /** The trimmed level list of a card: blank rows are not levels, they are noise. */
  function levelsOf(card) {
    return card.efforts.map((level) => String(level).trim()).filter((level) => level.length > 0);
  }

  /**
   * Everything that would make the draft unsaveable, as user-facing messages. Run
   * before anything is posted, so a bad edit is answered by the page (and shown in
   * the banner) instead of by the host.
   */
  function validate() {
    const problems = [];
    if (draft.providers.length === 0) problems.push(tr('Add at least one provider.'));
    if (draft.cards.length === 0) problems.push(tr('Add at least one model card.'));

    draft.providers.forEach((provider, index) => {
      const name = provider.name.trim();
      const label = name || tr('Provider {0}', index + 1);
      if (!name) problems.push(tr('Provider {0} needs a name.', index + 1));
      if (!provider.baseUrl.trim()) problems.push(tr('{0} needs a base URL.', label));
      else if (/\s/.test(provider.baseUrl.trim())) problems.push(tr('{0}: the base URL must not contain spaces.', label));
      if (!isCount(provider.concurrency)) {
        problems.push(tr('{0}: concurrency must be a whole number of 0 or more.', label));
      }
    });

    const providerIds = new Set(draft.providers.map((provider) => provider.id));
    draft.cards.forEach((card, index) => {
      const name = card.name.trim();
      const label = name || tr('Model card {0}', index + 1);
      if (!name) problems.push(tr('Model card {0} needs a name.', index + 1));
      if (!card.oaiModel.trim()) problems.push(tr('{0} needs a model id.', label));
      if (!providerIds.has(card.providerId)) {
        problems.push(tr('{0} points at a provider that no longer exists.', label));
      }
      if (!isCount(card.contextWindow) || card.contextWindow < 1) {
        problems.push(tr('{0}: the context window must be a whole number of at least 1.', label));
      }
      if (!isCount(card.concurrency)) {
        problems.push(tr('{0}: concurrency must be a whole number of 0 or more.', label));
      }
      const levels = levelsOf(card);
      if (levels.length === 0) problems.push(tr('{0}: add at least one effort level.', label));
      const seen = new Set();
      for (const level of levels) {
        const key = level.toLowerCase();
        if (seen.has(key)) {
          problems.push(tr('{0}: the effort level "{1}" is listed twice.', label, level));
          break;
        }
        seen.add(key);
      }
      if (levels.indexOf(card.defaultEffort.trim()) < 0) {
        problems.push(tr('{0}: the default effort must be one of the levels.', label));
      }
    });

    return problems;
  }

  /** Whitespace is the user's, not the settings': trim on the way out. */
  function trimDraft() {
    for (const provider of draft.providers) {
      provider.name = provider.name.trim();
      provider.baseUrl = provider.baseUrl.trim();
    }
    for (const card of draft.cards) {
      card.name = card.name.trim();
      card.providerId = card.providerId.trim();
      card.oaiModel = card.oaiModel.trim();
      card.efforts = levelsOf(card);
      card.defaultEffort = card.defaultEffort.trim();
    }
  }

  /**
   * The whole desired state. Deletions are implicit: an id that is not in these
   * lists is gone. `hasKey`/`isBuiltin` stay behind — they are the host's to know.
   */
  function buildPayload() {
    const payload = {
      providers: draft.providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        concurrency: provider.concurrency,
      })),
      cards: draft.cards.map((card) => ({
        id: card.id,
        name: card.name,
        providerId: card.providerId,
        oaiModel: card.oaiModel,
        contextWindow: card.contextWindow,
        concurrency: card.concurrency,
        vision: { enabled: !!card.vision.enabled, transport: normalizeTransport(card.vision.transport) },
        efforts: card.efforts,
        defaultEffort: card.defaultEffort,
      })),
      defaultCardId: draft.defaultCardId,
      apiKeys: Object.keys(draft.apiKeys).map((providerId) => ({ providerId: providerId, key: draft.apiKeys[providerId] })),
      clearedKeys: draft.clearedKeys.slice(),
    };
    return payload;
  }

  // --- save / revert ---------------------------------------------------------

  /**
   * One keystroke in a field: the draft changed, the save state and the request
   * preview follow, and *nothing else on screen moves*. This is the whole point of
   * the two-pass layout: a field is a fixed-height row, so typing cannot change the
   * box the engine was given, and a re-layout here would make the tree jump under
   * the cursor while the user types.
   *
   * It is also the one place every *non-shape* change goes through — a keystroke, the
   * vision toggle, a select, a reset button that cannot add or remove rows — so it is
   * where the reset buttons re-evaluate whether their property still differs from its
   * default.
   */
  function edit() {
    dirty = true;
    renderToolbar();
    renderPreview();
    refreshResetButtons();
  }

  /** Re-evaluate every `↺` of the form on screen, in place (nothing is redrawn). */
  function refreshResetButtons() {
    for (const refresh of resetButtons) refresh();
  }

  /**
   * The Save button. Validates first (a bad edit never leaves the page), then posts
   * the whole draft. Returns the problems — an empty list means it was posted.
   *
   * A save is a click, not a keystroke: the trim can rewrite what is on screen (a
   * padded name, a blank level row that is not a level), and a dropped level row is a
   * *shape* change, so the tree is redrawn from the trimmed draft the payload was
   * built from.
   */
  function save() {
    trimDraft();
    const problems = validate();
    saveErrors = problems;
    render();
    if (problems.length > 0) return problems;
    vscode.postMessage({ type: 'save', payload: buildPayload() });
    return problems;
  }

  /** Throw the edits away and go back to what the host last posted. */
  function revert() {
    draft = draftFromSnapshot(snapshot);
    saveErrors = [];
    dirty = false;
    ensureSelection();
    render();
  }

  // --- the tree --------------------------------------------------------------

  function engine() {
    const api = window.nonLayeredTidyTreeLayout;
    if (!api || typeof api.Layout !== 'function' || typeof api.BoundingBox !== 'function') {
      throw new Error('vendored layout engine missing: non-layered-tidy-tree-layout');
    }
    return api;
  }

  /** One drawn card: its draft row, the engine box, its element. */
  function nodeFor(kind, data, title, subtitle, badgeText) {
    return {
      key: kind + ':' + data.id,
      kind: kind,
      id: data.id,
      data: data,
      title: title,
      subtitle: subtitle,
      badgeText: badgeText,
      children: [],
      parent: null,
      el: null,
      w: 0,
      h: 0,
      x: 0,
      y: 0,
    };
  }

  /**
   * The draw plan: one record per node that will be drawn, with the *initial* box
   * (the compact one, or the selected card's width and its fallback height). A card
   * whose provider is gone is not drawn at all — validation says so before a save,
   * and the absence is what tells the user which cards are unreachable.
   */
  function buildNodes() {
    const byKey = new Map();
    const nodes = [];
    const roots = [];
    for (const provider of draft.providers) {
      const selected = isSelected('provider', provider.id);
      const node = nodeFor(
        'provider', provider,
        provider.name.trim() || tr('Untitled provider'),
        provider.baseUrl.trim() || tr('No base URL'),
        provider.isBuiltin ? tr('Built-in') : '',
      );
      node.w = selected ? SELECTED_PROVIDER_W : PROVIDER_W;
      node.h = selected ? SELECTED_PROVIDER_H : PROVIDER_H;
      byKey.set(node.key, node);
      nodes.push(node);
      roots.push(node);
    }
    for (const card of draft.cards) {
      const parent = byKey.get('provider:' + card.providerId);
      if (!parent) continue;
      const selected = isSelected('card', card.id);
      const node = nodeFor(
        'card', card,
        card.name.trim() || tr('Untitled card'),
        card.oaiModel.trim() || tr('No model id'),
        card.id === draft.defaultCardId ? tr('Default') : card.isBuiltin ? tr('Built-in') : '',
      );
      node.w = selected ? SELECTED_CARD_W : CARD_W;
      node.h = selected ? SELECTED_CARD_H : CARD_H;
      node.parent = parent;
      parent.children.push(node);
      byKey.set(node.key, node);
      nodes.push(node);
    }
    return { nodes: nodes, roots: roots, byKey: byKey };
  }

  /**
   * Lay the planned nodes out with the vendored engine, normalize them into the
   * canvas and derive the connectors. Nothing here measures anything: the boxes are
   * the ones the measure pass produced.
   */
  function layoutNodes(plan) {
    const api = engine();
    const toEngine = (node) => ({
      id: node.key,
      width: node.w,
      height: node.h,
      children: node.children.map(toEngine),
    });
    const root = { id: ROOT_KEY, width: 1, height: 1, children: plan.roots.map(toEngine) };
    const laid = new api.Layout(new api.BoundingBox(H_GAP, V_GAP)).layout(root).result;

    const placed = [];
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    (function walk(engineNode) {
      const node = plan.byKey.get(engineNode.id);
      if (node) {
        node.x = engineNode.x;
        node.y = engineNode.y;
        placed.push(node);
        left = Math.min(left, node.x);
        top = Math.min(top, node.y);
        right = Math.max(right, node.x + node.w);
        bottom = Math.max(bottom, node.y + node.h);
      }
      for (const child of engineNode.children) walk(child);
    })(laid);

    if (placed.length === 0) return { nodes: [], edges: '', w: 1, h: 1 };
    for (const node of placed) {
      node.x = node.x - left + PAD;
      node.y = node.y - top + PAD;
    }

    // Elbow connectors, in the same shape as the chat tree's (`media/main.js`): a
    // cubic that leaves the provider's bottom edge and lands on the card's top. The
    // card's own `providerId` is what decides the parent, so an id that changes
    // re-routes the wire on the next draw — `data-from`/`data-to` are what makes
    // that assertable (tools/check-modeltree.js).
    const edges = [];
    for (const node of placed) {
      const parent = node.parent;
      if (!parent) continue;
      const x0 = parent.x + parent.w / 2;
      const y0 = parent.y + parent.h;
      const x1 = node.x + node.w / 2;
      const y1 = node.y;
      const mid = (y0 + y1) / 2;
      edges.push(
        '<path class="mt-edge" data-from="' + attr(parent.id) + '" data-to="' + attr(node.id) + '" d="M ' + x0 + ' ' + y0 +
        ' C ' + x0 + ' ' + mid + ', ' + x1 + ' ' + mid + ', ' + x1 + ' ' + y1 + '" />',
      );
    }
    return { nodes: placed, edges: edges.join(''), w: right - left + PAD * 2, h: bottom - top + PAD * 2 };
  }

  /**
   * Draw the whole tree in two passes.
   *
   * Pass one builds every element — the selected card as its form, all of it from the
   * draft, never read back out of the DOM — at its target *width* and its natural
   * height. Pass two measures precisely those boxes and hands them to the engine;
   * only then are the positions applied. A frame of layout work is cheap here (the
   * tree is a handful of cards) and it is the only way a form whose height depends on
   * its own content can be laid out at all.
   */
  function renderTree() {
    const plan = buildNodes();
    clear(nodesEl);
    previewEl = null;
    // The form is about to be built again, so the live reset buttons of the previous
    // one go with it (each new one registers itself in `resetButton`).
    resetButtons = [];
    for (const node of plan.nodes) {
      node.el = buildCard(node);
      node.el.style.left = '0px';
      node.el.style.top = '0px';
      node.el.style.width = node.w + 'px';
      node.el.style.height = '';   // natural height: this is the thing being measured
      nodesEl.appendChild(node.el);
    }
    // Write every width first, then read every height: one reflow instead of one per
    // node. `0` means "this document cannot be measured" (a hidden panel, a stub DOM)
    // and keeps the constant above, which is a fallback and never a value.
    for (const node of plan.nodes) {
      node.w = node.el.offsetWidth || node.w;
      node.h = node.el.offsetHeight || node.h;
    }

    const layout = layoutNodes(plan);
    lastLayout = {
      w: layout.w,
      h: layout.h,
      nodes: layout.nodes.map((node) => ({
        kind: node.kind, id: node.id, x: node.x, y: node.y, w: node.w, h: node.h,
        parentId: node.parent ? node.parent.id : '',
      })),
    };
    box = { w: layout.w, h: layout.h };

    for (const node of layout.nodes) {
      node.el.style.left = node.x + 'px';
      node.el.style.top = node.y + 'px';
      node.el.style.width = node.w + 'px';
      node.el.style.height = node.h + 'px';
    }
    edgesEl.innerHTML = layout.edges;
    // The connector layer is an `<svg>` sized `width/height: 100%` of `#mt-canvas`, and
    // the canvas has no other source of size — the script only ever sets its transform.
    // Without these two lines the SVG viewport stays 0×0 and every stroke lands in a
    // degenerate viewport: the connectors *are* computed and written, they are simply
    // invisible. `media/main.js` does exactly the same before it draws its edges, and
    // the numbers are the laid-out box in px, 1:1 with the path coordinates, so no
    // `viewBox` is involved.
    canvasEl.style.width = layout.w + 'px';
    canvasEl.style.height = layout.h + 'px';
    edgesEl.setAttribute('width', String(layout.w));
    edgesEl.setAttribute('height', String(layout.h));
    renderEmpty();
  }

  function buildCard(node) {
    const selected = isSelected(node.kind, node.id);
    const element = el('div', 'mt-card mt-card-' + node.kind + (selected ? ' selected' : ''));
    element.dataset.id = node.id;
    element.dataset.kind = node.kind;
    element.appendChild(selected ? buildForm(node) : buildSummary(node));
    element.addEventListener('click', () => {
      // A pan ends with a click on whatever is under the pointer: a drag must not
      // change the selection.
      if (dragMoved) return;
      select(node.kind, node.id);
    });
    return element;
  }

  /** An unselected card: title / subtitle / badges and nothing else. */
  function buildSummary(node) {
    const summary = el('div', 'mt-card-summary');
    summary.appendChild(setText(el('div', 'mt-card-title'), node.title));
    summary.appendChild(setText(el('div', 'mt-card-sub'), node.subtitle));
    if (node.kind === 'provider') summary.appendChild(cardCountBadge(node.id));
    if (node.badgeText) summary.appendChild(badge(node.badgeText));
    return summary;
  }

  /** How many model cards hang off this provider — the number the tree's shape says. */
  function cardCountBadge(providerId) {
    const count = draft.cards.filter((card) => card.providerId === providerId).length;
    return badge(count === 1 ? tr('{0} card', count) : tr('{0} cards', count), 'mt-badge-count');
  }

  // --- the selected card's form ----------------------------------------------

  // --- the reset buttons -----------------------------------------------------

  /**
   * One property's `↺`.
   *
   * `spec.current()` reads the live value out of the draft, `spec.target()` the value
   * the row was **created** with — its own factory state, which the snapshot carries
   * (see `providerDefaults` / `cardDefaults`) — `spec.equals` compares the two (`===`,
   * or `sameLevels` for the level list), `spec.assign(value)` writes the draft, and
   * `sync(value)` writes the same value back into the *control*, because a reset is
   * not a re-render and the input the user is looking at has to follow the draft it
   * edits. `spec.shapeChange` marks the one property whose rows can appear or
   * disappear.
   *
   * The button is **disabled while the property already holds its default**, so an
   * enabled `↺` means "this one was changed". The test runs when the form is built and
   * again, in place, on every change of that property — a keystroke, the toggle, the
   * select, or a click on the button itself (`refreshResetButtons` is what `edit()`
   * calls).
   *
   * A click sets exactly *one* property — never a second one on the way past — and
   * marks the draft dirty. Whether it re-renders is the whole point of this function:
   * the effort *list* can gain or lose rows, which is a shape change, so it renders and
   * the card is re-measured; **every other property is a fixed-height field**, so it
   * goes through `edit()` — the save state and the request preview repaint and every
   * box stays exactly where it was measured. A reset that re-rendered would rebuild the
   * card under the user's cursor for nothing.
   */
  function resetButton(spec, sync) {
    const equals = spec.equals || ((a, b) => a === b);
    const isDefault = () => equals(spec.current(), spec.target());
    const node = button('↺', 'mt-reset-btn', () => {
      const value = spec.target();
      spec.assign(value);
      if (sync) sync(value);
      dirty = true;
      // `edit()` refreshes every button's state (below), so the one that was just
      // clicked disables itself there; `render()` rebuilds them all.
      if (spec.shapeChange) render();
      else edit();
    }, isDefault());
    // The button is on screen and its state is a property of the draft: register it so
    // a *later* change of the same field (a keystroke, the toggle, the select) can
    // re-evaluate it — see `refreshResetButtons`. The registry is rebuilt with the form.
    resetButtons.push(() => {
      node.disabled = isDefault();
    });
    // One string for all of them (tools/check-l10n.js extracts this literal), used as
    // the tooltip *and* the accessible name: the glyph says which affordance it is,
    // this sentence says what it does.
    node.title = tr('Reset this property to its default');
    node.setAttribute('aria-label', tr('Reset this property to its default'));
    return node;
  }

  /**
   * Put a field's control in its row: on its own, or — when the property has a reset
   * — on one line beside its `↺`. The line is a single fixed-height flex row (see
   * `.mt-field-line`), so the button cannot change the height the card was measured at.
   */
  function appendControl(row, control, reset, sync) {
    if (!reset) {
      row.appendChild(control);
      return;
    }
    const line = el('div', 'mt-field-line');
    line.appendChild(control);
    line.appendChild(resetButton(reset, sync));
    row.appendChild(line);
  }

  function fieldRow(field, labelText) {
    const row = el('div', 'mt-field');
    row.dataset.field = field;
    row.appendChild(setText(el('label', 'mt-label'), labelText));
    return row;
  }

  function textField(parent, field, labelText, value, onChange, reset) {
    const row = fieldRow(field, labelText);
    const input = el('input', 'mt-input');
    input.type = 'text';
    input.value = value == null ? '' : String(value);
    input.addEventListener('input', () => onChange(input.value));
    appendControl(row, input, reset, (next) => {
      input.value = next == null ? '' : String(next);
    });
    parent.appendChild(row);
    return input;
  }

  function readOnlyField(parent, field, labelText, value) {
    const row = fieldRow(field, labelText);
    const input = el('input', 'mt-input mt-readonly');
    input.type = 'text';
    input.value = value;
    // The id is stored data: it is shown so it can be copied, and never edits.
    input.readOnly = true;
    row.appendChild(input);
    parent.appendChild(row);
    return input;
  }

  function numberField(parent, field, labelText, value, onChange, min, reset) {
    const row = fieldRow(field, labelText);
    const input = el('input', 'mt-input');
    input.type = 'number';
    input.min = String(min == null ? 0 : min);
    input.step = '1';
    input.value = Number.isFinite(value) ? String(value) : '';
    input.addEventListener('input', () => onChange(input.value));
    appendControl(row, input, reset, (next) => {
      input.value = Number.isFinite(next) ? String(next) : '';
    });
    parent.appendChild(row);
    return input;
  }

  function selectField(parent, field, labelText, options, value, onChange) {
    const row = fieldRow(field, labelText);
    const select = el('select', 'mt-input');
    for (const option of options) {
      const node = el('option');
      node.value = option.value;
      node.textContent = option.text;
      if (option.value === value) node.selected = true;
      select.appendChild(node);
    }
    select.value = value;
    select.addEventListener('change', () => onChange(select.value));
    row.appendChild(select);
    parent.appendChild(row);
    return select;
  }

  /**
   * The form of a selected card: the head carries the editable name (the title row
   * of the inspector, which also said which kind of node this is), then the fields in
   * the order the docked inspector had them.
   */
  function buildForm(node) {
    const form = el('div', 'mt-form');
    form.appendChild(buildFormHead(node));
    if (node.kind === 'provider') buildProviderFields(form, node.data);
    else buildCardFields(form, node.data);
    return form;
  }

  function buildFormHead(node) {
    const head = el('div', 'mt-card-head');
    // The guard finds the name field by this: the name *is* the title row now.
    head.dataset.field = 'name';
    const input = el('input', 'mt-input mt-name-input');
    input.type = 'text';
    input.value = node.data.name;
    input.placeholder = tr('Name');
    input.title = tr('Name');
    input.addEventListener('input', () => {
      node.data.name = input.value;
      edit();
    });
    head.appendChild(input);
    head.appendChild(badge(node.kind === 'provider' ? tr('Provider') : tr('Model card'), 'mt-badge-kind'));
    if (node.kind === 'provider') head.appendChild(cardCountBadge(node.id));
    if (node.kind === 'card' && node.id === draft.defaultCardId) head.appendChild(badge(tr('Default card'), 'mt-badge-accent'));
    if (node.data.isBuiltin) head.appendChild(badge(tr('Built-in')));
    return head;
  }

  function buildProviderFields(form, provider) {
    textField(form, 'baseUrl', tr('Base URL'), provider.baseUrl, (value) => {
      provider.baseUrl = value;
      edit();
    }, {
      current: () => provider.baseUrl,
      target: () => providerDefaults(provider).baseUrl,
      assign: (value) => {
        provider.baseUrl = value;
      },
    });
    numberField(form, 'concurrency', tr('Concurrency'), provider.concurrency, (value) => {
      provider.concurrency = toInt(value);
      edit();
    }, 0, {
      current: () => provider.concurrency,
      target: () => providerDefaults(provider).concurrency,
      assign: (value) => {
        provider.concurrency = value;
      },
    });
    buildKeyFields(form, provider);

    const actions = el('div', 'mt-actions');
    actions.appendChild(button(tr('Add model card'), 'mt-btn', () => addCard(provider.id)));
    actions.appendChild(button(tr('Delete provider'), 'mt-btn mt-danger', () => deleteProvider(provider.id), provider.isBuiltin));
    form.appendChild(actions);
    readOnlyField(form, 'id', tr('Id'), provider.id);
  }

  function buildKeyFields(form, provider) {
    const row = fieldRow('apiKey', tr('API key'));
    row.appendChild(badge(provider.hasKey ? tr('Key set') : tr('No key'), provider.hasKey ? 'mt-badge-ok' : ''));

    const input = el('input', 'mt-input');
    input.type = 'password';
    input.value = '';   // a stored key never travels back: the host only says `hasKey`
    input.placeholder = tr('Paste the key');
    row.appendChild(input);

    const actions = el('div', 'mt-actions');
    actions.appendChild(button(tr('Save key'), 'mt-btn', () => {
      const value = input.value.trim();
      if (!value) return;
      draft.apiKeys[provider.id] = value;
      draft.clearedKeys = draft.clearedKeys.filter((id) => id !== provider.id);
      provider.hasKey = true;
      dirty = true;
      render();   // the badge and the hint line below it change the form's height
    }));
    actions.appendChild(button(tr('Clear key'), 'mt-btn mt-danger', () => {
      delete draft.apiKeys[provider.id];
      if (draft.clearedKeys.indexOf(provider.id) < 0) draft.clearedKeys.push(provider.id);
      provider.hasKey = false;
      dirty = true;
      render();
    }));
    row.appendChild(actions);
    form.appendChild(row);

    if (draft.apiKeys[provider.id]) {
      const hint = el('div', 'mt-hint');
      hint.textContent = tr('The new key is written with the next save.');
      form.appendChild(hint);
    } else if (draft.clearedKeys.indexOf(provider.id) >= 0) {
      const hint = el('div', 'mt-hint');
      hint.textContent = tr('The key is removed with the next save.');
      form.appendChild(hint);
    }
  }

  function buildCardFields(form, card) {
    selectField(
      form, 'providerId', tr('Provider'),
      draft.providers.map((provider) => ({
        value: provider.id,
        text: provider.name.trim() || tr('Unnamed provider'),
      })),
      card.providerId,
      (value) => {
        // The card changes branch: both the engine's boxes and the connectors are
        // derived from `providerId`, so this is a *shape* change — the whole tree is
        // redrawn (and the card re-parents) instead of just its own form.
        card.providerId = value;
        dirty = true;
        render();
      },
    );
    textField(form, 'oaiModel', tr('Model id'), card.oaiModel, (value) => {
      card.oaiModel = value;
      edit();
    });
    numberField(form, 'contextWindow', tr('Context window'), card.contextWindow, (value) => {
      card.contextWindow = toInt(value);
      edit();
    }, 1, {
      current: () => card.contextWindow,
      target: () => cardDefaults(card).contextWindow,
      assign: (value) => {
        card.contextWindow = value;
      },
    });
    numberField(form, 'concurrency', tr('Concurrency'), card.concurrency, (value) => {
      card.concurrency = toInt(value);
      edit();
    }, 0, {
      current: () => card.concurrency,
      target: () => cardDefaults(card).concurrency,
      assign: (value) => {
        card.concurrency = value;
      },
    });
    buildVisionFields(form, card);
    buildEffortFields(form, card);

    const actions = el('div', 'mt-actions');
    actions.appendChild(button(tr('Set as default'), 'mt-btn', () => setDefaultCard(card.id), card.id === draft.defaultCardId));
    actions.appendChild(button(tr('Delete model card'), 'mt-btn mt-danger', () => deleteCard(card.id), card.isBuiltin));
    form.appendChild(actions);
    readOnlyField(form, 'id', tr('Id'), card.id);

    // The request preview belongs to *this* card, so it lives in this card's form —
    // and it is filled *before* the measure pass, because its four lines are part of
    // the box the engine is about to be given (`white-space: pre` keeps them four).
    const preview = el('pre', 'mt-preview');
    preview.dataset.field = 'preview';
    preview.textContent = previewText(card);
    form.appendChild(preview);
    previewEl = preview;
  }

  function buildVisionFields(form, card) {
    const row = fieldRow('visionEnabled', tr('Accepts images'));
    // The toggle and the dialect live on **one line**: the transport only matters
    // when images are accepted at all, so it is the toggle's own companion — and it
    // is disabled (not hidden) while the toggle is off, which keeps the row's size
    // stable and therefore keeps the measured card height stable too.
    const line = el('div', 'mt-toggle-row');

    const label = el('label', 'mt-toggle');
    const checkbox = el('input', 'mt-checkbox');
    checkbox.type = 'checkbox';
    checkbox.checked = !!card.vision.enabled;

    const transport = el('div', 'mt-transport');
    // The field name the save payload and the guard look up stays on the container,
    // nested inside the vision row: `visionTransport` inside `visionEnabled`.
    transport.dataset.field = 'visionTransport';
    const select = el('select', 'mt-input mt-transport-select');
    for (const option of [
      // Named after the vendor dialect, because that is what the user chooses
      // between; *how* it travels (an upload, or the bytes in the body) is what the
      // request preview at the bottom of this same form spells out. `openai` is
      // first because it is the standard shape and the default for a new card.
      { value: 'openai', text: tr('OpenAI') },
      { value: 'deepseek', text: tr('DeepSeek') },
    ]) {
      const node = el('option');
      node.value = option.value;
      node.textContent = option.text;
      if (option.value === normalizeTransport(card.vision.transport)) node.selected = true;
      select.appendChild(node);
    }
    select.value = normalizeTransport(card.vision.transport);
    // The row label is gone (the controls share one line), so the field's meaning
    // lives on the control itself as its tooltip.
    select.title = tr('Image transport');
    select.setAttribute('aria-label', tr('Image transport'));
    select.disabled = !card.vision.enabled;
    select.addEventListener('change', () => {
      card.vision.transport = select.value === 'deepseek' ? 'deepseek' : 'openai';
      // A `<select>` shows the *widest* option's text, but its own width is fixed by
      // the row's layout and a control never wraps: the card's measured height cannot
      // change, so this only has to repaint the preview and the toolbar.
      dirty = true;
      edit();
    });
    transport.appendChild(select);

    checkbox.addEventListener('change', () => {
      // A checkbox is a fixed-height row and only the preview text follows it: no
      // re-measure, no re-layout. The transport follows it by *state*, not by size.
      card.vision.enabled = !!checkbox.checked;
      select.disabled = !card.vision.enabled;
      edit();
    });

    label.appendChild(checkbox);
    label.appendChild(setText(el('span', 'mt-toggle-text'), tr('Send images to this model')));
    line.appendChild(label);
    line.appendChild(transport);
    // The line's two resets, in the order of the two properties they restore (the
    // checkbox first, then the select). They go *at the end of the same line*, never
    // in a row of their own: the line is one fixed-height flex row, so adding them
    // cannot change what the card was measured at, and the row stays the one line the
    // toggle and its transport are.
    line.appendChild(resetButton({
      current: () => !!card.vision.enabled,
      target: () => !!cardDefaults(card).vision.enabled,
      assign: (value) => {
        card.vision.enabled = !!value;
        // The transport follows the toggle by *state*, exactly as the checkbox does.
        select.disabled = !card.vision.enabled;
      },
    }, (value) => {
      checkbox.checked = !!value;
    }));
    line.appendChild(resetButton({
      current: () => normalizeTransport(card.vision.transport),
      target: () => normalizeTransport(cardDefaults(card).vision.transport),
      assign: (value) => {
        card.vision.transport = normalizeTransport(value);
      },
    }, (value) => {
      select.value = normalizeTransport(value);
    }));
    row.appendChild(line);
    form.appendChild(row);
  }

  /**
   * The level list of a card. One row per level: the level string, the "default"
   * radio (exactly one level is the default) and a remove button. The literal
   * level `none` is not special *here* — it is a level like any other, and the
   * request preview is what knows it means "no `reasoning_effort` at all".
   */
  function buildEffortFields(form, card) {
    const section = el('div', 'mt-efforts');
    section.dataset.field = 'efforts';
    section.appendChild(setText(el('div', 'mt-label'), tr('Effort levels')));
    /** Each row's radio, in row order: restoring `defaultEffort` has to move the group. */
    const radios = [];
    for (let index = 0; index < card.efforts.length; index++) {
      const row = buildEffortRow(card, index);
      section.appendChild(row);
      radios.push(rowRadioOf(row));
    }
    const actions = el('div', 'mt-actions');
    actions.appendChild(button(tr('Add level'), 'mt-btn', () => {
      card.efforts.push('');
      dirty = true;
      render();   // one more row is a shape change: the form is taller now
    }));
    // The level *list*'s own reset, beside "Add level" — that is the row that speaks
    // for the whole list. It is the one reset that is a shape change (the factory list
    // can be longer or shorter than the one on screen), so it is the one that renders
    // — and therefore re-measures — instead of going through `edit()`.
    //
    // Only `efforts` is written. A `defaultEffort` the restored list no longer carries
    // is left exactly where it is: it is a property of its own with its own ↺, and
    // validation names the problem instead of the page quietly picking a level.
    actions.appendChild(resetButton({
      current: () => card.efforts,
      target: () => cardDefaults(card).efforts,
      equals: sameLevels,
      assign: (value) => {
        card.efforts = value;
      },
      shapeChange: true,
    }));
    // …and the default level's reset sits beside it in the same action row: the two are
    // the list's own properties, and the action row is the better read — *and* the only
    // anchor that is always there (an empty list has no last row to follow), while
    // being one fixed row, so it keeps the form's height independent of the level count.
    actions.appendChild(resetButton({
      current: () => card.defaultEffort,
      target: () => cardDefaults(card).defaultEffort,
      assign: (value) => {
        card.defaultEffort = value;
      },
    }, () => syncEffortRadios(card, radios)));
    section.appendChild(actions);
    form.appendChild(section);
  }

  /** The "default" radio of one effort row (the first control in it). */
  function rowRadioOf(row) {
    for (const child of row.children || []) {
      if (child.tagName === 'INPUT' && child.type === 'radio') return child;
      if (child.children && child.children.length > 0) {
        const deeper = rowRadioOf(child);
        if (deeper) return deeper;
      }
    }
    return null;
  }

  /**
   * Move the "default" radio onto the level the draft now names. `checked` is DOM
   * state, not draft state, so a reset that changes `defaultEffort` has to write it
   * back itself — nothing was re-rendered (see `resetButton`).
   */
  function syncEffortRadios(card, radios) {
    for (let index = 0; index < radios.length; index++) {
      if (radios[index]) radios[index].checked = card.efforts[index] === card.defaultEffort;
    }
  }

  function buildEffortRow(card, index) {
    const row = el('div', 'mt-effort-row');
    row.dataset.field = 'effort';

    const radio = el('input', 'mt-radio');
    radio.type = 'radio';
    radio.name = 'mt-default-effort';
    radio.title = tr('Make this level the default');
    radio.checked = card.efforts[index] === card.defaultEffort;
    radio.addEventListener('change', () => {
      card.defaultEffort = card.efforts[index];
      // Which row is the default changes no size, so it does not re-layout.
      edit();
    });
    const label = el('label', 'mt-radio-label');
    label.appendChild(radio);
    label.appendChild(setText(el('span', 'mt-radio-text'), tr('Default')));
    row.appendChild(label);

    const input = el('input', 'mt-input mt-effort-input');
    input.type = 'text';
    input.value = card.efforts[index] == null ? '' : String(card.efforts[index]);
    input.placeholder = tr('Level name');
    input.addEventListener('input', () => {
      const previous = card.efforts[index];
      card.efforts[index] = input.value;
      // Renaming the level that *is* the default keeps it the default: the same
      // row stays the default, which is what the radio is telling the user.
      if (card.defaultEffort === previous) card.defaultEffort = input.value;
      edit();
    });
    row.appendChild(input);

    const remove = button('✕', 'mt-icon-btn', () => {
      const removed = card.efforts[index];
      card.efforts.splice(index, 1);
      if (card.defaultEffort === removed) {
        card.defaultEffort = card.efforts.length > 0 ? card.efforts[0] : '';
      }
      dirty = true;
      render();
    });
    remove.title = tr('Remove level');
    row.appendChild(remove);

    return row;
  }

  // --- the request preview ---------------------------------------------------

  /**
   * What the selected card would put on the wire, in the shape the settings use:
   * the endpoint, the model field, the `reasoning_effort` line (gone for the level
   * `none`, which is exactly what that level means) and how an image would travel.
   * A provider card has no request, so it has no preview at all.
   *
   * It is four lines whatever the values are (`white-space: pre` in the stylesheet,
   * no wrapping), which is what lets the preview live inside the card's form without
   * its height depending on what the user types.
   */
  function previewText(card) {
    const provider = providerById(card.providerId);
    const baseUrl = provider ? provider.baseUrl.trim().replace(/\/+$/, '') : '';
    const model = card.oaiModel.trim();
    const effort = card.defaultEffort.trim();
    const lines = [
      tr('POST {0}/chat/completions', baseUrl || tr('(no base URL)')),
      tr('"model": "{0}"', model || tr('(no model id)')),
      effort === 'none'
        ? tr('no "reasoning_effort": the level none sends the model\'s own default')
        : tr('"reasoning_effort": "{0}"', effort || tr('(no default level)')),
    ];
    if (!card.vision.enabled) {
      lines.push(tr('Image: not sent, this card takes no images'));
    } else if (normalizeTransport(card.vision.transport) === 'openai') {
      lines.push(tr('Image: sent inline as a data URL'));
    } else {
      lines.push(tr('Image: uploaded to /files, then referenced by id'));
    }
    return lines.join('\n');
  }

  /** Refresh the selected card's preview in place — never a re-render, never a move. */
  function renderPreview() {
    const card = selectedCard();
    if (!previewEl || !card) return;
    setText(previewEl, previewText(card));
  }

  // --- banner, the empty state, toolbar --------------------------------------

  function renderBanner() {
    const problems = saveErrors.length > 0 ? saveErrors : snapshot.errors;
    if (problems.length === 0) {
      setHidden(bannerEl, true);
      setText(bannerEl, '');
      return;
    }
    setHidden(bannerEl, false);
    setText(bannerEl, problems.join('\n'));
  }

  /** With no cards at all there is nothing to select, so nothing can host a form. */
  function renderEmpty() {
    const empty = draft.providers.length === 0 && draft.cards.length === 0;
    setHidden(emptyEl, !empty);
    setText(emptyEl, empty ? tr('Add a provider to start.') : '');
  }

  function renderToolbar() {
    saveBtn.disabled = !dirty;
    revertBtn.disabled = !dirty;
  }

  function render() {
    renderToolbar();
    renderBanner();
    renderTree();
    renderPreview();
  }

  // --- mutations -------------------------------------------------------------

  /** The provider a new card belongs to: the selection's, else the first there is. */
  function targetProvider(providerId) {
    if (providerId) return providerById(providerId);
    const card = selectedCard();
    if (card) {
      const owner = providerById(card.providerId);
      if (owner) return owner;
    }
    const provider = selectedProvider();
    if (provider) return provider;
    return draft.providers.length > 0 ? draft.providers[0] : null;
  }

  function addProvider() {
    const provider = {
      id: uuidV4(),
      name: tr('New provider'),
      baseUrl: '',
      concurrency: 0,
      hasKey: false,
      isBuiltin: false,
    };
    draft.providers.push(provider);
    selection = { kind: 'provider', id: provider.id };
    dirty = true;
    render();
    return provider;
  }

  /**
   * A brand-new card is still deliberately *invalid* — but only in the one place that
   * cannot be defaulted: the **wire model name**, which is the user's own business and
   * which nothing here may invent (a card quietly pointing at a placeholder would send
   * requests to a model nobody chose). Everything else is prefilled from the fresh-row
   * defaults the host posts (`snapshot.defaults.fresh.card`, i.e. `FRESH_CARD_DEFAULTS`
   * in `src/agent/models.ts`): a 1M context window, the four built-in thinking levels
   * with `medium` as the default, images off, no concurrency cap. So the card is
   * usable the moment it is named, and validation still refuses it until it is.
   */
  function addCard(providerId) {
    const provider = targetProvider(providerId);
    if (!provider) {
      saveErrors = [tr('Add at least one provider.')];
      renderBanner();
      return null;
    }
    const seed = cardDefaults({ isBuiltin: false });
    const card = {
      id: uuidV4(),
      name: tr('New Model'),
      providerId: provider.id,
      oaiModel: '',
      contextWindow: seed.contextWindow,
      concurrency: seed.concurrency,
      vision: { enabled: !!seed.vision.enabled, transport: normalizeTransport(seed.vision.transport) },
      efforts: seed.efforts.slice(),
      defaultEffort: seed.defaultEffort,
      isBuiltin: false,
    };
    draft.cards.push(card);
    selection = { kind: 'card', id: card.id };
    dirty = true;
    render();
    return card;
  }

  function deleteProvider(id) {
    draft.providers = draft.providers.filter((provider) => provider.id !== id);
    // A card without its provider cannot be saved anyway; removing the provider
    // removes what hung off it (the absence *is* the deletion on the host side).
    draft.cards = draft.cards.filter((card) => card.providerId !== id);
    delete draft.apiKeys[id];
    draft.clearedKeys = draft.clearedKeys.filter((providerId) => providerId !== id);
    if (draft.defaultCardId && !cardById(draft.defaultCardId)) {
      draft.defaultCardId = draft.cards.length > 0 ? draft.cards[0].id : '';
    }
    if (isSelected('provider', id)) selection = null;
    dirty = true;
    ensureSelection();
    render();
  }

  function deleteCard(id) {
    draft.cards = draft.cards.filter((card) => card.id !== id);
    if (draft.defaultCardId === id) {
      draft.defaultCardId = draft.cards.length > 0 ? draft.cards[0].id : '';
    }
    if (isSelected('card', id)) selection = null;
    dirty = true;
    ensureSelection();
    render();
  }

  function setDefaultCard(id) {
    if (draft.defaultCardId === id) return;
    draft.defaultCardId = id;
    dirty = true;
    render();
  }

  /**
   * The selection is the whole interaction: it decides which card is a form and which
   * are compact boxes. Selecting the node that is already selected does nothing at all
   * — a click inside the form (a caret, a button) must not rebuild it under the user.
   */
  function select(kind, id) {
    if (isSelected(kind, id)) return;
    selection = { kind: kind, id: id };
    render();
  }

  function selectCard(id) {
    if (!cardById(id)) return;
    select('card', id);
  }

  function selectProvider(id) {
    if (!providerById(id)) return;
    select('provider', id);
  }

  // --- pan / zoom ------------------------------------------------------------

  function applyTransform() {
    canvasEl.style.transform = 'translate(' + pan.x + 'px, ' + pan.y + 'px) scale(' + zoom + ')';
  }

  /** The camera belongs to the user now: no automatic fit may move it again. */
  function touchedView() {
    viewTouched = true;
  }

  /**
   * Zoom around a screen-space cursor position: the canvas point under the cursor
   * does not move. The bounds are the chat tree's (`media/main.js`) so both trees
   * stop at the same scale.
   */
  function zoomAt(clientX, clientY, factor) {
    const rect = wrapEl.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const next = clamp(zoom * factor, ZOOM_MIN, ZOOM_MAX);
    const cx = (mx - pan.x) / zoom;
    const cy = (my - pan.y) / zoom;
    zoom = next;
    pan.x = mx - cx * next;
    pan.y = my - cy * next;
    touchedView();
    applyTransform();
  }

  /** Fit the *measured* box into the viewport and centre it. */
  function fitToView() {
    const rect = wrapEl.getBoundingClientRect();
    const width = rect.width || wrapEl.clientWidth || box.w;
    const height = rect.height || wrapEl.clientHeight || box.h;
    const scale = Math.min((width - PAD * 2) / (box.w || 1), (height - PAD * 2) / (box.h || 1));
    zoom = clamp(Number.isFinite(scale) ? scale : 1, ZOOM_MIN, ZOOM_MAX);
    pan.x = (width - box.w * zoom) / 2;
    pan.y = (height - box.h * zoom) / 2;
    touchedView();
    applyTransform();
  }

  // --- the host protocol -----------------------------------------------------

  function applySnapshot(next) {
    const source = next && typeof next === 'object' ? next : {};
    snapshot = {
      providers: Array.isArray(source.providers) ? source.providers : [],
      cards: Array.isArray(source.cards) ? source.cards : [],
      defaultCardId: text(source.defaultCardId),
      errors: Array.isArray(source.errors) ? source.errors.map(String) : [],
      // What every ↺ restores. Read from the message — the host is the only place
      // these numbers exist (`defaultsForProvider` / `defaultsForCard`) — and
      // tolerated when it is missing (see `readDefaults`).
      defaults: readDefaults(source.defaults),
    };
    // The ↺ targets live beside the draft they belong to: a snapshot is the truth as
    // stored, and what every reset restores comes with it.
    defaults = snapshot.defaults;
    draft = draftFromSnapshot(snapshot);
    // A snapshot is the truth as stored: whatever was dirty is either saved or gone.
    dirty = false;
    saveErrors = [];
    ensureSelection();
    render();
    // The first snapshot is the first real tree. Until it arrives the pan is 0,0 and
    // the tree hangs half off-screen, so the camera is fitted once — and exactly once:
    // from here on the camera is the user's, and a later snapshot must not yank it back.
    if (!autoFitDone) {
      autoFitDone = true;
      if (!viewTouched) fitToView();
    }
  }

  /**
   * The host's answer to a save. On success the draft is clean and the snapshot the
   * host posts right after this replaces it wholesale; on failure the edits stay
   * exactly where they were (dirty, still on screen) and the host's reasons go to
   * the banner — a failed save must never look like a successful one.
   */
  function applySaveResult(message) {
    if (message.ok) {
      dirty = false;
      saveErrors = [];
      render();
      return;
    }
    saveErrors = Array.isArray(message.errors) ? message.errors.map(String) : [];
    if (saveErrors.length === 0) saveErrors = [tr('The host refused the save.')];
    renderToolbar();
    renderBanner();
  }

  function onMessage(event) {
    const message = event && event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'modelTree') {
      applySnapshot(message.snapshot);
    } else if (message.type === 'modelTreeSaveResult') {
      applySaveResult(message);
    }
  }

  /** The seam's view of the draft — see the comment on `window.__modeltreeTest`. */
  function state() {
    return {
      providers: draft.providers,
      cards: draft.cards,
      defaultCardId: draft.defaultCardId,
      selected: selection ? selection.kind + ':' + selection.id : '',
      dirty: dirty,
      errors: saveErrors.slice(),
    };
  }

  /** The seam's view of the last draw: the canvas box and the placed node boxes. */
  function layoutInfo() {
    return {
      w: lastLayout.w,
      h: lastLayout.h,
      nodes: lastLayout.nodes.map((node) => ({
        kind: node.kind, id: node.id, x: node.x, y: node.y, w: node.w, h: node.h, parentId: node.parentId,
      })),
    };
  }

  /**
   * What the connector layer was given: the px `#mt-canvas` carries and the `<svg>`'s
   * own width/height. Zero here means the connectors are drawn into nothing.
   */
  function canvasSize() {
    return {
      w: parseFloat(canvasEl.style.width) || 0,
      h: parseFloat(canvasEl.style.height) || 0,
      svgW: parseFloat(edgesEl.getAttribute('width')) || 0,
      svgH: parseFloat(edgesEl.getAttribute('height')) || 0,
    };
  }

  // --- the gestures (the chat tree's set; see media/main.js) -----------------

  /** A press inside the editor (a form field, the name row) belongs to the editor. */
  function ownsPress(target) {
    return !!(target && target.closest && target.closest('.mt-form'));
  }

  // Right-button autoscroll: the press point becomes an origin and the view keeps
  // travelling towards the cursor, at a speed proportional to how far the cursor is
  // from that origin. The pan continues while the cursor sits still — that is the
  // whole point of the mode.
  const AUTOSCROLL_DEAD_PX = 10;     // slack around the origin before it moves
  const AUTOSCROLL_RAMP_PX = 600;    // cursor offset at which the curve saturates
  const AUTOSCROLL_MAX_PX_S = 2400;  // speed the curve converges to (2400 px/s)
  let autoscroll = null;             // { originX, originY, x, y, last, raf }
  let autoscrollEl = null;           // origin marker (pinned to the viewport)
  /** Did the press that is in flight start somewhere a context menu is useful? */
  let rmbPressWantsMenu = false;

  // easeOutExpo, right-way-round: `t` is the cursor offset normalised by
  // AUTOSCROLL_RAMP_PX, and the curve returns the *fraction of max speed*. The
  // `t >= 1` case is the textbook 1 - 2^-10t guard: at t = 1 the formula gives
  // 0.999, not 1.
  function autoscrollEase(t) {
    return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
  }

  function autoscrollSpeed(dist) {
    return AUTOSCROLL_MAX_PX_S * autoscrollEase(clamp((dist - AUTOSCROLL_DEAD_PX) / AUTOSCROLL_RAMP_PX, 0, 1));
  }

  function startAutoscroll(event) {
    autoscroll = {
      originX: event.clientX,
      originY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      last: performance.now(),
      raf: null,
    };
    autoscrollEl = el('div', 'autoscroll-origin');
    // Inline SVG (CSP-safe, no external asset): four arrows around a centre dot,
    // i.e. the same affordance the browser draws at its autoscroll origin.
    autoscrollEl.innerHTML =
      '<svg viewBox="0 0 32 32" aria-hidden="true">' +
      '<path d="M16 3 12 9h8z"/><path d="M16 29 20 23h-8z"/>' +
      '<path d="M3 16 9 12v8z"/><path d="M29 16 23 20v-8z"/>' +
      '<circle cx="16" cy="16" r="3"/>' +
      '</svg>';
    autoscrollEl.style.left = event.clientX + 'px';
    autoscrollEl.style.top = event.clientY + 'px';
    document.body.appendChild(autoscrollEl);
    wrapEl.classList.add('autoscrolling');
    touchedView();
    autoscroll.raf = requestAnimationFrame(autoscrollStep);
  }

  function autoscrollStep() {
    if (!autoscroll) return;
    autoscroll.raf = requestAnimationFrame(autoscrollStep);
    const now = performance.now();
    // Clamp dt: a backgrounded window must not teleport the view on return.
    const dt = Math.min(0.05, (now - autoscroll.last) / 1000);
    autoscroll.last = now;
    const dx = autoscroll.x - autoscroll.originX;
    const dy = autoscroll.y - autoscroll.originY;
    const dist = Math.hypot(dx, dy);
    if (dist <= AUTOSCROLL_DEAD_PX) return;
    const speed = autoscrollSpeed(dist);
    // The *view* travels towards the cursor (browser semantics: the content moves
    // against it), so the canvas offset moves the opposite way.
    pan.x -= (dx / dist) * speed * dt;
    pan.y -= (dy / dist) * speed * dt;
    applyTransform();
  }

  function stopAutoscroll() {
    if (!autoscroll) return;
    if (autoscroll.raf != null) cancelAnimationFrame(autoscroll.raf);
    autoscroll = null;
    if (autoscrollEl) {
      autoscrollEl.remove();
      autoscrollEl = null;
    }
    wrapEl.classList.remove('autoscrolling');
  }

  // --- boot ------------------------------------------------------------------

  wrapEl.addEventListener('mousedown', (event) => {
    if (event.button === 2) {
      // RMB is the autoscroll pan on the canvas. Inside a form it stays a plain
      // right-click: the paste / select menu is exactly what a field is for.
      if (ownsPress(event.target)) return;
      event.preventDefault();
      startAutoscroll(event);
      return;
    }
    // Any other button ends the gesture, exactly like the browser cancels its own
    // autoscroll on the next click.
    stopAutoscroll();
    if (event.button !== 0 && event.button !== 1) return;
    // LMB inside the editor is the editor's (a caret, a text selection, a button).
    if (event.button === 0 && ownsPress(event.target)) return;
    drag = { x: event.clientX, y: event.clientY, pan: { x: pan.x, y: pan.y } };
    dragMoved = false;
    // MMB would otherwise start the browser's own middle-click autoscroll on top.
    if (event.button === 1) event.preventDefault();
  });

  wrapEl.addEventListener('mousemove', (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!dragMoved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    dragMoved = true;
    pan = { x: drag.pan.x + dx, y: drag.pan.y + dy };
    touchedView();
    applyTransform();
  });

  wrapEl.addEventListener('mouseup', () => {
    drag = null;
  });
  wrapEl.addEventListener('mouseleave', () => {
    drag = null;
  });

  // The autoscroll keeps travelling while the cursor sits still, so it reads the
  // cursor and its release paths at the window, not at the wrap: mouseup, blur, a
  // wheel (below) and Escape all end it, and the pan must never outlive the gesture
  // that started it.
  //
  // The capture below is what makes the *release* reliable: without it a button
  // released after the cursor left the webview is a mouseup this document never sees,
  // and the pan would keep drifting. Compatibility mouse events follow the capture, so
  // the gesture is retargeted to the wrap and still bubbles to the window listener.
  wrapEl.addEventListener('pointerdown', (event) => {
    if (event.button !== 2 || ownsPress(event.target)) return;
    try {
      wrapEl.setPointerCapture(event.pointerId);
    } catch {
      /* noop: a host without pointer capture keeps the mouse-event behaviour */
    }
  });

  window.addEventListener('mousemove', (event) => {
    if (!autoscroll) return;
    autoscroll.x = event.clientX;
    autoscroll.y = event.clientY;
  });
  window.addEventListener('mouseup', stopAutoscroll);
  window.addEventListener('blur', stopAutoscroll);
  window.addEventListener('keydown', (event) => {
    if (autoscroll && event.key === 'Escape') stopAutoscroll();
  });

  // Which surface the press started on decides whether a right-click may end in a
  // menu. VS Code's webview host shows its own menu for any `contextmenu` that
  // reaches it un-prevented, and webview content cannot contribute to it — so a
  // press on the canvas (a pan request) has to veto it, while a press in a form
  // field is a menu request and is left alone.
  window.addEventListener('mousedown', (event) => {
    if (event.button !== 2) return;
    rmbPressWantsMenu = ownsPress(event.target);
  }, true);

  document.addEventListener('contextmenu', (event) => {
    if (!wrapEl.contains || !wrapEl.contains(event.target || null)) return;
    if (rmbPressWantsMenu && !autoscroll) return;
    event.preventDefault();
  }, true);

  wrapEl.addEventListener('wheel', (event) => {
    // Never zoom while a pan is in progress: an accidental mouse scroll must not
    // fling the view around.
    if (drag) return;
    // A wheel is the browser's way out of autoscroll; the zoom below still runs.
    stopAutoscroll();
    // The request preview may scroll sideways (ids are long, and it must not wrap:
    // its fixed line count is what keeps the measured card height stable while the
    // user edits the fields around it): leave that one wheel alone.
    if (event.target && event.target.closest && event.target.closest('.mt-preview')) return;
    // The wheel **scales**, anchored on the pointer, with or without ctrl/cmd. This
    // is the page's one deliberate difference from the chat tree (`media/main.js`
    // pans on a plain wheel and zooms on ctrl/cmd + wheel): this tree is a handful
    // of cards, the wheel is how it is zoomed, and a wheel that scrolled instead
    // was the gesture that felt wrong. The factor and the bounds are the chat
    // tree's, so both trees stop at the same scale.
    event.preventDefault();
    zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? 1.1 : 0.9);
  }, { passive: false });

  fitBtn.addEventListener('click', fitToView);
  saveBtn.addEventListener('click', () => {
    save();
  });
  revertBtn.addEventListener('click', revert);
  settingsBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'openSettingsJson' });
  });
  addProviderBtn.addEventListener('click', () => {
    addProvider();
  });

  window.addEventListener('message', onMessage);
  applyTransform();
  render();
  // One `ready`, at boot: before it the host holds its messages, so this is what
  // makes the snapshot arrive (see the `ready` case in src/chat/ModelPanel.ts).
  vscode.postMessage({ type: 'ready' });
})();
