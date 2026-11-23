(function () {
  const vscode = acquireVsCodeApi();

  /**
   * Translate one UI string into the VS Code display language.
   *
   * `message` is the English source string, and it doubles as the key in the
   * host's catalog (`l10n/bundle.l10n.<locale>.json`). A webview has no
   * `vscode.l10n`, so the host injects the whole catalog as `window.__spinneyL10n`
   * in the HTML shell and this looks the string up in it. An English window — and
   * any string the catalog does not carry (a stale bundle, a brand-new string) —
   * falls back to `message` itself, so the UI never shows a raw key, and
   * `check-webview.js`, which loads this file with no dictionary at all, still
   * works.
   *
   * `{0}`, `{1}`, … are the placeholders, exactly like `vscode.l10n.t`, so a
   * translation is free to reorder the sentence around its arguments.
   */
  function tr(message, ...args) {
    const dict = window.__spinneyL10n;
    let text = (dict && dict[message]) || message;
    for (let i = 0; i < args.length; i++) {
      text = text.split('{' + i + '}').join(String(args[i]));
    }
    return text;
  }

  const treeWrap = document.getElementById('tree-wrap');
  const treeCanvas = document.getElementById('tree-canvas');
  const treeEdges = document.getElementById('tree-edges');
  const fitBtn = document.getElementById('fit-btn');
  const followBtn = document.getElementById('follow-btn');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send-btn');
  const stopBtn = document.getElementById('stop-btn');
  // The composer's **new-window** entry (`#compress-btn`, immediately left of Send): the
  // visible, always-available "move this conversation into a new context window" button. It
  // opens the harness's two questions (Simple / Agentic, then which setup), so compression has
  // a button of its own instead of living behind the drift-driven one. Its label, visibility and
  // disabled state are owned by `updateComposerButtons` below.
  const compressBtn = document.getElementById('compress-btn');
  // The **setup** entry (`#new-context-btn`): only when the live setup differs from the frozen
  // one, and it means "continue under the new setup", which forks the tree (the old tree keeps
  // its bytes). Two buttons because they are two questions; the fork one is hidden whenever it
  // would have nothing to say.
  const newContextBtn = document.getElementById('new-context-btn');
  // The row the buttons live in: it takes a line of its own only while more than one of them
  // is on screen (`updateComposerButtons`), so a lone Send stays where it always was.
  const actionsEl = document.getElementById('actions');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const attachmentsEl = document.getElementById('attachments');
  const attachBtn = document.getElementById('attach-btn');
  const snippetsBtn = document.getElementById('snippets-btn');
  const contextLabel = document.getElementById('context-label');
  const modelSelect = document.getElementById('model-select');
  const modelsBtn = document.getElementById('models-btn');
  const effortSelect = document.getElementById('effort-select');
  const tpsMeter = document.getElementById('tps-meter');
  const tpsValue = document.getElementById('tps-value');
  const statBalanceEl = document.getElementById('stat-balance');
  // Background terminals have no panel of their own any more: each node's jobs
  // render into a dock at the bottom of *that node's* card (see renderBackgrounds).
  const branchBanner = document.getElementById('branch-banner');
  const composerEl = document.getElementById('composer');
  // Find (`plans/conversation-search.md`): the bar and its list are fixed overlays, and
  // the corpus lives on the host — a card far off screen has no content in the DOM and a
  // long log is windowed, so a find over this document could not search a conversation.
  const findBar = document.getElementById('find-bar');
  const findInput = document.getElementById('find-input');
  const findCountEl = document.getElementById('find-count');
  const findCaseBtn = document.getElementById('find-case');
  const findWordBtn = document.getElementById('find-word');
  const findRegexBtn = document.getElementById('find-regex');
  const findPrevBtn = document.getElementById('find-prev');
  const findNextBtn = document.getElementById('find-next');
  const findListBtn = document.getElementById('find-list');
  const findCloseBtn = document.getElementById('find-close');
  const findResultsEl = document.getElementById('find-results');
  const findResultsTitleEl = document.getElementById('find-results-title');
  const findResultsCountEl = document.getElementById('find-results-count');
  const findResultsListEl = document.getElementById('find-results-list');

  // Session-level: any run in this session is live (status dot, tps meter, the
  // model/effort selects). It says nothing about the *view focus* node.
  let busy = false;
  // Per-node: the nodes that currently have a live run (spec §3.1 `state`). The
  // Send/Stop pair is a property of the view focus node, not of the session, so
  // this — and never `busy` — decides which of the two buttons is on screen.
  let runningNodes = new Set();
  // Per-node: the nodes that own unfinished work of their own (a running background
  // terminal / async sub-agent batch, or a completion notice about to be injected
  // into them). They are deliberately not in `runningNodes` (no turn is streaming),
  // but they are *doing something*, so the composer offers Stop for them exactly as
  // it does for a streaming node — pressing it is the host's union kill.
  let lockedNodes = new Set();
  let pendingAttachments = [];
  // The selected **model card id** (`config.model`) and its thinking level. Both
  // are empty until the first `config` message arrives; nothing here invents a
  // model name.
  let currentModel = '';
  let currentEffort = '';
  // Session currently rendered, mirrored into vscode.setState so a reloaded
  // window restores this tab bound to the same conversation.
  let persistedSessionId = '';
  // The character / row appear animation — `streamAnimation` in the host's `config`
  // message (`spinney.streamAnimation`). `true` until a `config` says otherwise: a
  // replay shape (and every fixture in `tools/check-webview.js`) may not carry the
  // field, and the setting's own default is on.
  let streamAnimation = true;
  // The live find: the newest answer this tab will accept (`requestId`) and what that
  // answer rendered. `hits` is the host's list (`src/chat/find.ts`), one row per card.
  const findState = {
    active: false,
    scope: 'session',        // 'session' (Ctrl+F) | 'all' (Ctrl+Shift+F)
    query: '',
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    requestId: 0,
    hits: [],
    index: -1,
    invalid: '',
    timedOut: false,
    capped: false,
    scanned: 0,
    listOpen: false,
    // A jump's own card: the hit a seeded open makes current (see `findOpen`).
    focusNode: '',
  };
  let findTimer = null;
  let findMarkRaf = null;
  // A hit this tab cannot show yet (another conversation, or a card not built yet): the
  // host opens that tab and checks the card out, and the next `tree` / `path` applies it.
  let findPending = null;
  // The result rows, in hit order, so the current one can be marked and scrolled into
  // view without rebuilding the list (a rebuild drops its scroll position).
  let findRowEls = [];

  const NODE_W = 320;
  const H_GAP = 48;
  const V_GAP = 72;
  // The gap between two roots of the forest (§3). Each root is laid out by the
  // engine on its own and the trees are placed left to right, so the gap is what
  // makes two trees read as two parallel conversations instead of one wide tree.
  // (The engine's own layout pads the right edge by 40px, so the visible channel
  // between the two rightmost/leftmost cards is this plus 40.)
  const ROOT_GAP = 64;
  // Sub-agent sidecar FOREST (see media/tree.js): a node's windows are grouped into depth
  // bands — depth 1 is its own windows, depth 2 theirs — each band a lattice of columns
  // holding at most AGENT_MAX_ROWS cards, and every card is AGENT_MONITOR_H tall (a
  // "monitor": head + status + the live tail of its work log) except the one window the user
  // has open, which is as tall as it measures. The block's height is therefore bounded by the
  // row cap, and a window that spawned windows costs a column band instead of pushing the
  // conversation below the node down. AGENT_MONITOR_H must match `.node.monitor`'s height in
  // media/style.css — the layout weighs what the webview measures.
  const AGENT_GAP = 80;
  const AGENT_VGAP = 24;
  const AGENT_COL_GAP = 48;
  const AGENT_MAX_ROWS = 3;
  const AGENT_MONITOR_H = 200;
  const AGENT_TOP_PAD = 16;

  // The transcript is a pannable tree. `messagesEl` points at the currently
  // checked-out node's items container — every append / stream lands there.
  let messagesEl = null;
  const nodeEls = Object.create(null);   // id -> card element
  let treeNodes = Object.create(null);   // id -> { id, parentId, children, title, status, preview }
  // A session is a FOREST (§3): one entry per tree, in the order the host sends
  // them. `treeRootId` stays the first one (the focused tree's root in practice),
  // which is all a single-root host ever needs.
  let treeRootIds = [];
  let treeRootId = null;
  let treeActiveId = null;
  let activePathSet = new Set();
  let pathNodes = Object.create(null);   // id -> { status, items }
  // Agent-child connector routing table from the last layout (media/tree.js
  // `cells`): id -> { col, row, busX, chanX, corrY, ... }. drawEdges() routes each
  // parent → sub-agent connector through those card-free corridors.
  let layoutCells = Object.create(null);
  let pan = { x: 0, y: 0 };
  let zoom = 1;
  let follow = true;
  // Set while routing a sub-agent's streaming deltas into its own card, so the
  // main tree's camera/relayout is not driven by every sub-agent token.
  let routingSubAgent = false;
  // Set while a long transcript's history window is being (re)painted: rendering a
  // page of *finished* history into a card must not pan the tree to the active node.
  let suppressFollow = false;
  // The node a routed streaming call is currently writing into (null while writing
  // into the view focus container). Keeps each node's live tool cards separate.
  let routingNodeId = null;

  // ---- Performance probes (diagnostics only) -------------------------------
  // The host traces one user-visible operation at a time — a session switch, a
  // node checkout — and tags the repaint messages it sends with that operation's
  // id (`reset` / `tree` / `path` carry `traceId`). Half of the cost of a switch
  // happens *here* (DOM, markdown, layout), so this side measures the burst and
  // reports it back as a `perfDiag` message, which closes the trace in the
  // **Spinney** output channel (the host logs it under the same op id).
  // Two smaller probes ride along:
  //
  //  - a message handler that blocks this thread for >= SLOW_HANDLER_MS is
  //    reported by name (the webview cannot tell anyone it was stuck);
  //  - frames are watched while a switch paints or a turn streams, and the worst
  //    gap of the burst is reported once — a stutter *is* a long frame.
  //
  // All of it is optional diagnostics and must never affect the UI, so the
  // reporting path swallows its own errors (but never the handler's).
  const SLOW_HANDLER_MS = 40;
  const STALL_MS = 80;
  const FRAME_WATCH_MS = 2000;
  const STREAM_WATCH_MS = 1000;
  // How long the burst has to stay quiet to count as over. The repaint messages of
  // one op are posted back to back but arrive as separate tasks, and each one
  // resets this timer: `setTimeout(0)` would lose the race with the next message
  // and split one switch into four reports.
  const BURST_QUIET_MS = 50;
  // Messages that mean "a turn is streaming": frames are watched while they arrive.
  const STREAM_MESSAGE_TYPES = new Set([
    'delta', 'thinkingDelta', 'toolCallDelta', 'toolEnd', 'agentStart', 'backgroundNotice',
  ]);

  // ---- The tab that stopped painting ------------------------------------------
  // A webview can be *alive* — taking messages, appending to its DOM, ticking its own
  // clocks — while the compositor stops producing frames: the tab then shows a
  // picture that no longer follows the conversation. None of the probes above can say
  // so: `paint` is only posted right after a traced burst, the frame watch only runs
  // while a switch or a stream is in flight, and `webview-handler` proves the *script*
  // is running, which is precisely the state that looks healthy from the host while
  // the user stares at a frozen screen. So the question that separates "frozen" from
  // "idle" is answered here, and it is answered about a VISIBLE tab only: is this
  // document still producing frames? Three seconds without one is the only honest
  // definition of "the screen is frozen".
  //
  // Cost, and why this cannot keep the window from idling: one frame per second — a
  // single `requestAnimationFrame` callback per tick, never a continuous loop — and
  // only while the document is visible. Hiding the tab clears the interval outright
  // and nothing at all is reported while it is hidden (a hidden tab is *supposed* to
  // stop painting, and the browser throttles it to ~1 fps). A healthy visible tab
  // posts nothing either: a `stall` only goes out after STALE_MS without a frame.
  const FRAME_SAMPLE_MS = 1000;
  /** No frame for this long in a visible tab is a stall: the screen is frozen. */
  const STALE_MS = 3000;
  /** While a stall lasts, remind the host at most this often — a frozen tab keeps saying so. */
  const STALE_REPEAT_MS = 10000;
  /**
   * A gap of at least this much is a suspend, not a stutter: the machine slept, the
   * window was suspended, the display went off. It is counted separately, in the
   * `suspend=` field of the frames report (`armFrameWatch`), because an overnight
   * sleep otherwise reports `worst=30431785` and reads like an eight-hour freeze.
   */
  const SUSPEND_MS = 30000;
  /** At most one `resize` report per this window, however fast the wrap is dragged. */
  const RESIZE_REPORT_MS = 500;

  let perfPending = null;   // the traced repaint burst currently being measured
  let perfMarkdown = { ms: 0, calls: 0 };
  let perfLayoutMs = 0;
  let frameWatch = null;

  // The stall sampler's own state: what it has seen, when it last saw a frame, and the
  // stall episode in flight (all read by the `probe` reply and the `stall` reports).
  let perfMessages = 0;              // host messages handled since this document loaded
  let frameCount = 0;                // frames the sampler observed
  let lastFrameAt = perfNow();       // when the last frame was observed
  let frameTimer = null;             // the 1 Hz sampler's interval; null while hidden
  let staleSince = null;             // when the stall in flight began (the last frame seen)
  let staleReportedAt = 0;           // when the last `stale` report went out (0 = none yet)
  let staleVia = null;               // 'probe' / 'nudge' seen during that stall, else null
  let hiddenSince = null;            // set while the document is hidden
  let hiddenMs = 0;                  // hidden time already accumulated
  let visibilitySince = perfNow();   // when the current visibility state began
  // The **tab's** visibility, which the page itself cannot see: `document.hidden` is about
  // the window, and a VS Code editor tab in the background is not a hidden document — yet
  // Chromium stops its frames (and, after minutes of it, freezes the script outright). A
  // sampler that only knew the page reported "the screen is frozen" every time the user
  // switched away, and the one moment that matters — coming back to a tab whose surface was
  // never repainted — looked exactly like that noise. The host owns the fact (`panel.visible`)
  // and pushes it as the `viewState` message.
  let tabVisible = true;             // on screen until the host says otherwise
  let tabHiddenSince = null;         // set while the tab is not on screen
  let tabHiddenMs = 0;               // off-screen time already accumulated
  // The **window's** own focus, the third fact "is anybody looking at this tab" needs, and
  // the one the first two cannot see: a window that is not in front is painted on a
  // different clock (Windows marks it occluded and the engine stops producing frames), so a
  // sampler that only knew the page and the tab called every stretch spent in another
  // application a frozen screen — and the ladder (probe → nudge) ran for a screen nobody
  // could see. Measured on a real re-report: 26 of 27 `stale` episodes sat inside an
  // unfocused window, and the one that did not lasted exactly the 3 s threshold.
  //
  // The host owns the fact (`vscode.window.state.focused`) and pushes it inside `viewState`,
  // so this stays a report, never a guess. Leaving the window is handled like the page going
  // hidden; *coming back* is the moment the diagnostic exists for, and it now sends the
  // snapshot that was missing — what the surface looked like while nobody was watching
  // (see `applyWindowFocus`).
  let winFocused = true;             // focused until the host says otherwise
  let winBlurSince = null;           // set while the window is not focused
  let winBlurMs = 0;                 // unfocused time already accumulated

  function perfNow() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }

  /** Post one diagnostics report; a probe must never break the UI. */
  function perfPost(kind, fields) {
    try {
      vscode.postMessage(Object.assign({ type: 'perfDiag', kind }, fields));
    } catch (err) {
      /* ignore */
    }
  }

  /** How many elements the tree canvas holds — the DOM cost of a repaint. */
  function perfDomCount() {
    try {
      return treeCanvas.querySelectorAll('*').length;
    } catch (err) {
      return 0;
    }
  }

  /** Time `relayout()` for the burst report: the tidy-tree engine on a big session. */
  function perfRelayout() {
    const t0 = perfNow();
    relayout();
    perfLayoutMs += perfNow() - t0;
  }

  /** A traced repaint message: join (or start) the burst it belongs to. */
  function perfTraceMessage(msg, ms) {
    // A different op started while this one was still open: report what we have
    // instead of dropping it on the floor.
    if (perfPending && perfPending.traceId !== msg.traceId) {
      perfTraceFlush();
    }
    if (!perfPending) {
      perfMarkdown = { ms: 0, calls: 0 };
      perfLayoutMs = 0;
      perfPending = { traceId: msg.traceId, t0: perfNow(), ms: Object.create(null), timer: null };
    }
    perfPending.ms[msg.type] = (perfPending.ms[msg.type] || 0) + ms;
    if (perfPending.timer) clearTimeout(perfPending.timer);
    perfPending.timer = setTimeout(perfTraceFlush, BURST_QUIET_MS);
    armFrameWatch('switch', FRAME_WATCH_MS);
  }

  /** Report the traced burst, once the browser has had a chance to paint it. */
  function perfTraceFlush() {
    const pending = perfPending;
    perfPending = null;
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    // This runs detached (a timer, then a frame), so a probe bug must die here.
    try {
      const steps = Object.keys(pending.ms)
        .map((type) => type + '=' + Math.round(pending.ms[type]))
        .join(',');
      let items = 0;
      for (const id of Object.keys(pathNodes)) items += (pathNodes[id].items || []).length;
      requestAnimationFrame(() => {
        perfPost('paint', {
          traceId: pending.traceId,
          since: Math.round(perfNow() - pending.t0),
          steps,
          markdown: Math.round(perfMarkdown.ms) + '/' + perfMarkdown.calls,
          layout: Math.round(perfLayoutMs),
          cards: Object.keys(nodeEls).length,
          items,
          dom: perfDomCount(),
        });
      });
    } catch (err) {
      /* diagnostics must never break the UI */
    }
  }

  /** Watch frames for `ms` and report the worst gap of the burst. */
  function armFrameWatch(phase, ms) {
    if (frameWatch) {
      frameWatch.until = Math.max(frameWatch.until, perfNow() + ms);
      return;
    }
    const watch = { phase, until: perfNow() + ms, worst: 0, frames: 0, suspend: 0, last: perfNow() };
    frameWatch = watch;
    const step = () => {
      if (frameWatch !== watch) return;
      const now = perfNow();
      const gap = now - watch.last;
      watch.last = now;
      watch.frames++;
      // A hidden window is throttled to ~1 fps, which is not a stutter anyone sees.
      const hidden = typeof document !== 'undefined' && document.hidden;
      if (gap >= STALL_MS && !hidden) {
        // Half a minute is not a stutter, it is the tab going away (sleep, suspend,
        // display off): folding it into `worst` is what made a slept machine report
        // `worst=30431785` and read as an eight-hour freeze. It is kept, separately,
        // because it also explains a burst that reported no frames at all.
        if (gap >= SUSPEND_MS) watch.suspend += gap;
        else watch.worst = Math.max(watch.worst, gap);
      }
      if (now >= watch.until) {
        frameWatch = null;
        if (watch.worst > 0 || watch.suspend > 0) {
          perfPost('frames', {
            phase: watch.phase,
            worst: Math.round(watch.worst),
            frames: watch.frames,
            suspend: Math.round(watch.suspend),
          });
        }
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** Measure one message the host sent; called from the single message listener. */
  function perfAfterMessage(msg, ms) {
    // Counted before anything else, and whatever the message looks like: this counter
    // is what tells a stalled tab's *messages* apart from its frames ("alive but not
    // painting" is exactly messages arriving with `lastFrame` growing), so it must not
    // depend on the shape of the message that arrived.
    perfMessages++;
    if (!msg || typeof msg !== 'object') return;
    try {
      // A host message that arrives mid-gesture is the third suspect, next to a slow
      // frame and a slow handler: a tree/path repaint landing under a finger or a caret.
      perfGestureHost(typeof msg.type === 'string' ? msg.type : '');
      if (msg.traceId !== undefined && msg.traceId !== null) {
        perfTraceMessage(msg, ms);
      } else if (ms >= SLOW_HANDLER_MS) {
        perfPost('handler', { message: String(msg.type || '?'), ms: Math.round(ms) });
      }
      if (STREAM_MESSAGE_TYPES.has(msg.type)) armFrameWatch('stream', STREAM_WATCH_MS);
    } catch (err) {
      /* a probe must never break the UI */
    }
  }

  // ---- Gesture probes (pan / typing) ------------------------------------------
  // The two interactions a reader judges the UI by, and the two the lines above cannot
  // describe: `webview-handler` only measures *host messages*, and a pan handler is three
  // assignments — so a slow gesture cannot be the handler, and what is left is the
  // engine (layout, raster, a repaint that lands under the finger). Each gesture is
  // therefore measured as a whole: the handler itself, the wait from an event to the next
  // frame, the frames, the engine's own long tasks, and whatever the tree did meanwhile.
  // One line per gesture (`webview-gesture`), bounded by how many gestures a person makes.
  const TYPING_IDLE_MS = 500;  // keystrokes closer than this are one burst
  const LONG_TASK_MS = 50;     // Chromium's own definition of a blocking task
  let perfPan = null;          // the pan gesture in flight
  let perfTyping = null;       // the typing burst in flight
  let perfTypingTimer = null;
  let perfWheelTimer = null;   // ends a wheel-driven pan after the wheel goes quiet
  let perfFrameLoop = false;

  /** The surface a gesture runs on: what a slow frame would have to repaint. */
  function perfGestureSurface() {
    let canvas = '0x0';
    let canvasDev = '0x0';
    let z = 1;
    let dpr = 1;
    try {
      const w = Math.round(treeCanvas.offsetWidth);
      const h = Math.round(treeCanvas.offsetHeight);
      canvas = w + 'x' + h;
      z = Math.round(zoom * 100) / 100;
      dpr = Math.round((window.devicePixelRatio || 1) * 100) / 100;
      canvasDev = Math.round(w * z * dpr) + 'x' + Math.round(h * z * dpr);
    } catch (err) {
      /* a booting document has no canvas yet */
    }
    let cards = 0;
    let skip = 0;
    let nodes = 0;
    let expanded = 0;
    try {
      cards = Object.keys(nodeEls).length;
      skip = cvSkipped.size;
      nodes = Object.keys(treeNodes).length;
      for (const id in nodeEls) {
        if (nodeEls[id] && nodeEls[id].classList.contains('expanded')) expanded++;
      }
    } catch (err) {
      /* not built yet */
    }
    return {
      dom: perfDomCount(),
      cards,
      skip,
      nodes,
      expanded,
      canvas,
      canvasDev,
      zoom: z,
      dpr,
    };
  }

  /**
   * One frame per animation frame while a gesture runs: the gaps between frames (a
   * stutter *is* a long frame) and the wait an event served by that frame paid. The loop
   * exists only while a gesture does, so it can never keep an idle window from idling.
   */
  function perfGestureTick() {
    const g = perfPan || perfTyping;
    if (!g) {
      perfFrameLoop = false;
      return;
    }
    g.raf = requestAnimationFrame(() => {
      if (perfPan !== g && perfTyping !== g) {
        perfGestureTick();
        return;
      }
      const now = perfNow();
      const gap = now - g.last;
      g.last = now;
      g.frames++;
      if (gap > g.worst) g.worst = gap;
      if (g.pendingAt != null) {
        const latency = now - g.pendingAt;
        g.pendingAt = null;
        g.latencyN++;
        g.latencySum += latency;
        if (latency > g.latencyMax) g.latencyMax = latency;
      }
      perfGestureTick();
    });
  }

  /** Open a gesture record, with the two observers this kind of lag needs. */
  function perfGestureOpen(kind) {
    const g = {
      kind,
      t0: perfNow(),
      last: perfNow(),
      events: 0,
      handlerSum: 0,
      handlerMax: 0,
      autoGrowMs: 0,
      buttonsMs: 0,
      latencySum: 0,
      latencyMax: 0,
      latencyN: 0,
      pendingAt: null,
      frames: 0,
      worst: 0,
      longTasks: 0,
      longTaskMs: 0,
      mutations: 0,
      host: Object.create(null),
      mutationObserver: null,
      longObserver: null,
      loaf: null,
      loafObserver: null,
    };
    // What the *tree* did while the gesture ran: a repaint under a finger is a different
    // defect from a slow frame, and only this counter can tell the two apart.
    try {
      if (typeof MutationObserver === 'function') {
        g.mutationObserver = new MutationObserver((records) => {
          g.mutations += records.length;
        });
        g.mutationObserver.observe(treeCanvas, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      }
    } catch (err) {
      /* diagnostics only */
    }
    // Chromium's own long-task entries: the one reading that says the main thread was
    // *blocked* rather than merely slow, and it costs nothing while nothing is long.
    try {
      if (typeof PerformanceObserver === 'function') {
        g.longObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            g.longTasks++;
            g.longTaskMs += entry.duration;
          }
        });
        g.longObserver.observe({ entryTypes: ['longtask'] });
      }
    } catch (err) {
      /* not every engine exposes longtask */
    }
    // A long task says *that* a frame was blocked; a long animation frame says *where* it
    // went, split into script, style/layout and render, with the script that was running.
    // That split is the whole question here: the gesture handlers measure ~0 ms, so a
    // 280 ms entry is either the engine's own layout or something neither of our handlers
    // owns, and nothing else in this document can tell those apart.
    try {
      if (typeof PerformanceObserver === 'function') {
        const types = PerformanceObserver.supportedEntryTypes;
        if (Array.isArray(types) && types.indexOf('long-animation-frame') >= 0) {
          g.loafObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (!g.loaf || entry.duration > g.loaf.duration) g.loaf = entry;
            }
          });
          g.loafObserver.observe({ entryTypes: ['long-animation-frame'] });
        }
      }
    } catch (err) {
      /* an older engine has no long animation frames */
    }
    if (!perfFrameLoop) {
      perfFrameLoop = true;
      // The caller assigns the record to `perfPan` / `perfTyping` *after* this returns, so
      // the first tick has to be a frame later: a synchronous one would find no gesture and
      // stop the loop before it ever counted a frame.
      requestAnimationFrame(perfGestureTick);
    }
    return g;
  }

  /** Count one measured event of the gesture (`handlerMs` is the work it did). */
  function perfGestureEvent(g, handlerMs) {
    if (!g) return;
    const ms = handlerMs || 0;
    g.events++;
    g.handlerSum += ms;
    if (ms > g.handlerMax) g.handlerMax = ms;
    // The oldest event still waiting is the one the next frame answers, and that wait is
    // what the user feels. A `requestAnimationFrame` per event would measure the same
    // thing while adding frames of its own to the burst being measured.
    if (g.pendingAt == null) g.pendingAt = perfNow();
  }

  /** One host message that arrived while a gesture was in flight, counted by type. */
  function perfGestureHost(type) {
    const g = perfPan || perfTyping;
    if (!g || !type || type === 'perfDiag') return;
    g.host[type] = (g.host[type] || 0) + 1;
  }

  /**
   * The worst long animation frame of a gesture, split the way the engine measures it:
   * script (before rendering began), style/layout (after it did), and the blocking part.
   * `loafTop` names the one script that held the frame longest, when there is one.
   */
  function perfLoafFields(g) {
    let worst = g.loaf;
    try {
      if (g.loafObserver) {
        for (const entry of g.loafObserver.takeRecords()) {
          if (!worst || entry.duration > worst.duration) worst = entry;
        }
        g.loafObserver.disconnect();
      }
    } catch (err) {
      /* diagnostics only */
    }
    if (!worst) return {};
    let top = '';
    try {
      let best = 0;
      for (const script of worst.scripts || []) {
        if (script.duration > best) {
          best = script.duration;
          top =
            (script.sourceFunctionName || script.invoker || '?') + ':' + Math.round(script.duration);
        }
      }
    } catch (err) {
      /* no scripts at all means the engine itself held the frame */
    }
    return {
      loafMs: Math.round(worst.duration),
      loafScript: Math.round(
        worst.renderStart ? worst.renderStart - worst.startTime : worst.duration,
      ),
      loafLayout: Math.round(
        worst.styleAndLayoutStart
          ? worst.startTime + worst.duration - worst.styleAndLayoutStart
          : 0,
      ),
      loafBlock: Math.round(worst.blockingDuration || 0),
      loafTop: top,
    };
  }

  /** Close the gesture: one line, its observers disconnected. */
  function perfGestureClose(g, extra) {
    if (!g) return;
    const loaf = perfLoafFields(g);
    try {
      if (g.mutationObserver) {
        g.mutations += g.mutationObserver.takeRecords().length;
        g.mutationObserver.disconnect();
      }
    } catch (err) {
      /* diagnostics only */
    }
    try {
      if (g.longObserver) {
        for (const entry of g.longObserver.takeRecords()) {
          g.longTasks++;
          g.longTaskMs += entry.duration;
        }
        g.longObserver.disconnect();
      }
    } catch (err) {
      /* diagnostics only */
    }
    const host = Object.keys(g.host)
      .map((type) => type + ':' + g.host[type])
      .join(',');
    perfPost(
      'gesture',
      Object.assign(
        {
          gesture: g.kind,
          ms: Math.round(perfNow() - g.t0),
          events: g.events,
          handler: Math.round(g.handlerSum) + '/' + Math.round(g.handlerMax),
          latency:
            (g.latencyN ? Math.round(g.latencySum / g.latencyN) : 0) + '/' + Math.round(g.latencyMax),
          frames: g.frames,
          worstFrame: Math.round(g.worst),
          longTasks: g.longTasks,
          longTaskMs: Math.round(g.longTaskMs),
          mutations: g.mutations,
          host,
        },
        loaf,
        perfGestureSurface(),
        extra || {},
      ),
    );
  }

  /** End the pan gesture (pointer release, cancellation, or the autoscroll stop). */
  function perfPanEnd() {
    if (perfWheelTimer != null) {
      clearTimeout(perfWheelTimer);
      perfWheelTimer = null;
    }
    if (!perfPan) return;
    const g = perfPan;
    perfPan = null;
    perfGestureClose(g);
    // A release postponed for the gesture can run now (see `flushCv`, `pumpUnloads`).
    flushCv();
    flushLayout();
    pumpUnloads();
  }

  /** A wheel-driven camera move: counted as a gesture, ended after a quarter second of quiet. */
  function perfWheelMove() {
    // Only an input-driven camera move holds the expensive work; a camera move the app makes
    // itself (the initial pan to the active card, a follow step) must not.
    noteViewMove();
    if (!perfPan) perfPan = perfGestureOpen('wheel');
    perfGestureEvent(perfPan, 0);
    if (perfWheelTimer != null) clearTimeout(perfWheelTimer);
    perfWheelTimer = setTimeout(() => {
      perfWheelTimer = null;
      perfPanEnd();
    }, VIEW_MOVE_MS);
  }

  /** End a typing burst: the keystrokes have been quiet for `TYPING_IDLE_MS`. */
  function perfTypingEnd() {
    perfTypingTimer = null;
    const g = perfTyping;
    perfTyping = null;
    if (!g) {
      pumpUnloads();
      return;
    }
    perfGestureClose(g, {
      autoGrow: Math.round(g.autoGrowMs),
      buttons: Math.round(g.buttonsMs),
    });
    pumpUnloads();
  }

  // ---- The document's own record (surface, long frames, lifetime) --------------
  // A reload destroys the renderer that had the problem, and every measurement used to die
  // with it: each line was tied to an operation (a switch, a gesture), so a document that
  // had been degrading for hours wrote nothing while it degraded — and the natural fix,
  // reloading, erased exactly the state that made it slow. These reports are the other
  // half: a surface sample on a timer, a long frame as it happens, and one final line on
  // the way out. The slow run then leaves a curve of its own, and a reload is only the
  // boundary between two documents rather than the loss of the evidence.
  const SURFACE_SAMPLE_MS = 30000;    // one sample per half minute, on screen only
  const LONG_FRAME_MS = 250;          // a frame this long is what a reader feels as a stutter
  const LONG_FRAME_REPEAT_MS = 5000;  // keep a busy document from flooding the log
  const docStartedAt = perfNow();
  let surfaceTimer = null;
  let surfaceSamples = 0;
  let docLoaf = null;        // the worst long animation frame since this document loaded
  let docLoafAge = -1;       // when it happened, as an offset from that document's start
  let docLoafCount = 0;
  let intervalLoafN = 0;
  let intervalLoafMs = 0;
  let longFrameReportedAt = 0;
  let fatCache = '';         // the last sample's per-card element counts, reused by a report
  let lifetimePosted = false;

  /** The one script that held a long animation frame longest, as `name:ms`. */
  function perfTopScript(entry) {
    try {
      let best = 0;
      let top = '';
      for (const script of entry.scripts || []) {
        if (script.duration > best) {
          best = script.duration;
          top =
            (script.sourceFunctionName || script.invoker || '?') + ':' + Math.round(script.duration);
        }
      }
      return top;
    } catch (err) {
      return '';
    }
  }

  /** Heap in MiB, when the engine reports it (a bucketed value is still a curve). */
  function perfHeapMb() {
    try {
      const memory = performance.memory;
      if (!memory || typeof memory.usedJSHeapSize !== 'number') return undefined;
      return Math.round(memory.usedJSHeapSize / (1024 * 1024));
    } catch (err) {
      return undefined;
    }
  }

  /** The three cards holding the most elements, as `id:n,id:n,id:n`. */
  function perfFatCards() {
    try {
      const fat = [];
      for (const id in nodeEls) {
        const card = nodeEls[id];
        if (!card) continue;
        fat.push([id, card.getElementsByTagName('*').length]);
      }
      fat.sort((a, b) => b[1] - a[1]);
      return fat
        .slice(0, 3)
        .map((row) => row[0] + ':' + row[1])
        .join(',');
    } catch (err) {
      return '';
    }
  }

  /** Judge one long animation frame: keep the worst, and report a real stutter at once. */
  function perfNoteLongFrame(entry) {
    docLoafCount++;
    intervalLoafN++;
    intervalLoafMs += entry.duration;
    if (!docLoaf || entry.duration > docLoaf.duration) {
      docLoaf = entry;
      docLoafAge = Math.round(perfNow() - docStartedAt);
    }
    if (entry.duration < LONG_FRAME_MS || !perfOnScreen()) return;
    const now = perfNow();
    if (now - longFrameReportedAt < LONG_FRAME_REPEAT_MS) return;
    longFrameReportedAt = now;
    // The stutter itself, with no gesture to end and nothing asked of the user: the split
    // says whether script, layout or render held the frame, `top` names the script, and
    // `fat` says which cards the DOM cost is concentrated in.
    perfPost(
      'longframe',
      Object.assign(
        {
          ms: Math.round(entry.duration),
          block: Math.round(entry.blockingDuration || 0),
          script: Math.round(
            entry.renderStart ? entry.renderStart - entry.startTime : entry.duration,
          ),
          layout: Math.round(
            entry.styleAndLayoutStart
              ? entry.startTime + entry.duration - entry.styleAndLayoutStart
              : 0,
          ),
          top: perfTopScript(entry),
          fat: fatCache,
        },
        { heap: perfHeapMb() },
        perfGestureSurface(),
      ),
    );
  }

  /** One sample of the document: what grows, and the long frames since the previous one. */
  function perfSampleSurface() {
    try {
      if (!perfOnScreen()) return;
      surfaceSamples++;
      // The one expensive read in this file: it walks every card's elements. It runs here,
      // once per sample, and every report that is not a sample reuses the cached answer —
      // a report must never add the very hitch it is describing.
      fatCache = perfFatCards();
      const worst = docLoaf
        ? {
            docLoafMs: Math.round(docLoaf.duration),
            docLoafAt: docLoafAge,
            docLoafTop: perfTopScript(docLoaf),
          }
        : {};
      perfPost(
        'surface',
        Object.assign(
          {
            life: Math.round(perfNow() - docStartedAt),
            samples: surfaceSamples,
            frames: frameCount,
            loafN: intervalLoafN,
            loafMs: Math.round(intervalLoafMs),
            docLoafN: docLoafCount,
            fat: fatCache,
          },
          { heap: perfHeapMb() },
          worst,
          perfGestureSurface(),
        ),
      );
      intervalLoafN = 0;
      intervalLoafMs = 0;
    } catch (err) {
      /* a sample must never break the UI */
    }
  }

  function perfStartSurfaceSampler() {
    if (surfaceTimer != null || !perfOnScreen()) return;
    surfaceTimer = setInterval(perfSampleSurface, SURFACE_SAMPLE_MS);
  }

  function perfStopSurfaceSampler() {
    if (surfaceTimer == null) return;
    clearInterval(surfaceTimer);
    surfaceTimer = null;
  }

  /**
   * The document is going away (a window reload, a `Reload Chat Webview`, a closed tab):
   * one last line, best effort. The post may be dropped with the document — which is why
   * the timer above exists as well — but when it lands, it is the degraded renderer's own
   * account of itself, dated, at the reload boundary.
   */
  function perfPostLifetime(reason) {
    // `pagehide` and `beforeunload` can both fire for one teardown: one document is one
    // lifetime, so only the first one writes the line.
    if (lifetimePosted) return;
    lifetimePosted = true;
    try {
      perfPost(
        'lifetime',
        Object.assign(
          {
            reason,
            life: Math.round(perfNow() - docStartedAt),
            samples: surfaceSamples,
            frames: frameCount,
            docLoafN: docLoafCount,
            docLoafMs: docLoaf ? Math.round(docLoaf.duration) : 0,
            docLoafAt: docLoafAge,
          },
          { heap: perfHeapMb() },
          perfGestureSurface(),
        ),
      );
    } catch (err) {
      /* the document is leaving; nothing here may throw on the way out */
    }
  }

  /** Arm the document-level record: the long-frame observer and the surface sampler. */
  function perfStartDocumentRecord() {
    try {
      if (typeof PerformanceObserver === 'function') {
        const types = PerformanceObserver.supportedEntryTypes;
        if (Array.isArray(types) && types.indexOf('long-animation-frame') >= 0) {
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) perfNoteLongFrame(entry);
          });
          observer.observe({ entryTypes: ['long-animation-frame'] });
        }
      }
    } catch (err) {
      /* an older engine has no long animation frames */
    }
    perfStartSurfaceSampler();
    try {
      // `pagehide` is the one a torn-down webview still gets; `beforeunload` is the belt
      // behind it, and neither is allowed to be required for the line to exist.
      window.addEventListener('pagehide', () => perfPostLifetime('pagehide'));
      window.addEventListener('beforeunload', () => perfPostLifetime('beforeunload'));
    } catch (err) {
      /* no window to listen to */
    }
    // The fresh baseline: the line a reload's first sample is compared against.
    perfPost('boot', Object.assign({ life: 0, samples: 0 }, { heap: perfHeapMb() }, perfGestureSurface()));
  }

  // ---- The frame sampler (the probe behind `stall`) ----------------------------
  /** Is the document hidden? `visibilityState` when the host has it, else `hidden`. */
  function perfHidden() {
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc) return false;
    if (typeof doc.visibilityState === 'string') return doc.visibilityState !== 'visible';
    return doc.hidden === true;
  }

  /**
   * Is this tab on screen at all — the page visible, **the editor tab in front**, and the
   * window itself focused? The sampler runs only then, and a `stall` can only be reported
   * then. A tab nobody is looking at is allowed to stop drawing (that is the engine
   * throttling it, not a defect), so a gap measured there is not evidence of anything the
   * user saw — and reporting it was drowning the real case in false alarms. The window's
   * focus is the third fact of that question and the one the first two never had: a window
   * that is not in front stops producing frames without the page ever going hidden.
   */
  function perfOnScreen() {
    return !perfHidden() && tabVisible && winFocused;
  }

  /** Milliseconds this tab has spent off screen, the stretch in progress included. */
  function perfTabHiddenMs() {
    return Math.round(tabHiddenMs + (tabHiddenSince != null ? perfNow() - tabHiddenSince : 0));
  }

  /** Milliseconds the window has spent unfocused, the stretch in progress included. */
  function perfWinBlurMs() {
    return Math.round(winBlurMs + (winBlurSince != null ? perfNow() - winBlurSince : 0));
  }

  /**
   * Milliseconds this document has spent hidden, the stretch in progress included: a
   * probe is read *while* a tab is hidden, and reporting only the finished stretches
   * would freeze the number exactly then.
   */
  function perfHiddenMs() {
    return Math.round(hiddenMs + (hiddenSince != null ? perfNow() - hiddenSince : 0));
  }

  /**
   * One 1 Hz sample of the visible tab: ask for a frame, then judge the gap. The
   * callback is what proves the compositor still produces frames; the gap is what
   * proves it does not — a callback of an earlier tick that never arrived *is* the
   * missing frame, so the judgement is made here, not in the callback.
   */
  function perfSampleFrame() {
    if (!perfOnScreen()) return;   // never stale off screen (the sampler is stopped there anyway)
    requestAnimationFrame(perfMarkFrame);
    const gap = perfNow() - lastFrameAt;
    if (gap < STALE_MS) return;
    // The stall began at the last frame we saw, not at this tick: that timestamp is
    // what the episode's total length is measured from on recovery.
    if (staleSince == null) {
      staleSince = lastFrameAt;
      staleReportedAt = 0;
    }
    if (staleReportedAt > 0 && perfNow() - staleReportedAt < STALE_REPEAT_MS) return;
    staleReportedAt = perfNow();
    // `canvas` and `dom` ride along because the surface is what is in doubt here: a stall
    // in a tab that is on screen, with the tree's own size next to it, is the difference
    // between a busy renderer and a layer that is too big to be repainted. `tab=` says the
    // webview's own belief (a report is only written while it is on screen, so a `hidden`
    // here is a view-state message that arrived late).
    perfPost('stall', {
      state: 'stale',
      ms: Math.round(gap),
      frames: frameCount,
      hiddenMs: perfHiddenMs(),
      tab: tabVisible ? 'visible' : 'hidden',
      tabHiddenMs: perfTabHiddenMs(),
      canvas: perfCanvasBox(),
      dom: perfDomCount(),
      // `doc=` and `zoom=` ride along for the *other* shape a frozen picture takes: a
      // document that kept laying out at its old size (the whole page in a small rectangle
      // in the top-left corner) shows up here as a `doc=` that disagrees with the window's
      // own size, and `zoom` is what turns `canvas=` into the device pixels a layer limit is
      // measured against. The full surface readout — `vis=`, `canvasDev=`, `canvasRect=` — is
      // what the probe reply carries, and the host asks for it within the same 3 s.
      doc: perfDocBox(),
      zoom: perfZoom(),
    });
  }

  /** One observed frame: count it, and close a stall episode when there was one. */
  function perfMarkFrame() {
    if (!perfOnScreen()) return;
    frameCount++;
    const now = perfNow();
    lastFrameAt = now;
    if (staleSince == null) return;
    // Frames are back, so the episode is over — and this is the only place it can be
    // reported. `via` says whether one of the host's probes was what brought them
    // back: the probe/nudge pair is a cure only if a `recovered via=nudge` line says so.
    perfPost('stall', {
      state: 'recovered',
      ms: Math.round(now - staleSince),
      frames: frameCount,
      hiddenMs: perfHiddenMs(),
      tab: tabVisible ? 'visible' : 'hidden',
      tabHiddenMs: perfTabHiddenMs(),
      via: staleVia || 'self',
    });
    staleSince = null;
    staleReportedAt = 0;
    staleVia = null;
  }

  function perfStartSampler() {
    if (frameTimer != null || !perfOnScreen()) return;
    frameTimer = setInterval(perfSampleFrame, FRAME_SAMPLE_MS);
    perfStartSurfaceSampler();
  }

  function perfStopSampler() {
    if (frameTimer != null) {
      clearInterval(frameTimer);
      frameTimer = null;
    }
    perfStopSurfaceSampler();
  }

  /**
   * The document's visibility changed: report how long the *previous* state lasted,
   * then move the sampler with it. The hidden stretch is accumulated (`hiddenMs`) for
   * the probe reply, and the period itself is never staleness: the compositor is
   * supposed to stop there, and a stall that spanned it would report a gap nobody
   * could have painted through.
   */
  function perfNoteVisibility() {
    try {
      const hidden = perfHidden();
      const now = perfNow();
      perfPost('visibility', { state: hidden ? 'hidden' : 'visible', ms: Math.round(now - visibilitySince) });
      visibilitySince = now;
      if (hidden) {
        perfStopSampler();
        if (hiddenSince == null) hiddenSince = now;
        // The episode in flight ends here *without* a `recovered`: frames did not come
        // back, the tab went away, and calling that a recovery would be a lie that
        // leaves via= on the next episode's report.
        lastFrameAt = now;
        staleSince = null;
        staleReportedAt = 0;
        staleVia = null;
        return;
      }
      hiddenMs += hiddenSince != null ? now - hiddenSince : 0;
      hiddenSince = null;
      lastFrameAt = now;
      // Three frames, not one: a resumed document needs more than a single callback
      // before it is really painting again. If none of the three ever arrives, the gap
      // rule catches it within STALE_MS — which is exactly the case of a resume that
      // stays frozen.
      requestAnimationFrame(perfMarkFrame);
      requestAnimationFrame(perfMarkFrame);
      requestAnimationFrame(perfMarkFrame);
      perfStartSampler();
    } catch (err) {
      /* a probe must never break the UI */
    }
  }

  /**
   * The host said whether this tab is on screen (`viewState`) — and, in the same message,
   * whether the *window* is focused.
   *
   * Going off screen is the same situation as the page being hidden — frames are supposed to
   * stop, so the episode in flight ends without a `recovered` and the clock for the gap is
   * reset — with one addition: the time is accumulated in `tabHiddenMs` and reported, which is
   * what tells a reader of the log that a gap was the user looking elsewhere rather than a
   * screen that froze on them.
   *
   * Coming back is the moment the whole diagnostic exists for. Resetting the frame clock here
   * is what keeps a return from being reported as a stall of frames that stopped for a reason
   * nobody should report, and the three frames it asks for are the evidence that drawing
   * resumed at all.
   */
  function perfOnViewState(msg) {
    try {
      // The window's focus is handled first and on its own: it changes without the tab's
      // visibility changing at all, which is exactly the case that used to read as a freeze.
      if (typeof msg.focused === 'boolean') applyWindowFocus(msg.focused);
      const visible = msg.visible !== false;
      if (visible === tabVisible) return;
      const now = perfNow();
      tabVisible = visible;
      if (!visible) {
        perfStopSampler();
        if (tabHiddenSince == null) tabHiddenSince = now;
        lastFrameAt = now;
        staleSince = null;
        staleReportedAt = 0;
        staleVia = null;
        return;
      }
      tabHiddenMs += tabHiddenSince != null ? now - tabHiddenSince : 0;
      tabHiddenSince = null;
      lastFrameAt = now;
      requestAnimationFrame(perfMarkFrame);
      requestAnimationFrame(perfMarkFrame);
      requestAnimationFrame(perfMarkFrame);
      perfStartSampler();
    } catch (err) {
      /* a probe must never break the UI */
    }
  }

  /**
   * The window's own focus changed (`viewState.focused`).
   *
   * Going away is handled exactly like the page going hidden: frames are supposed to stop for
   * a window that is not in front, so the episode in flight ends **without** a `recovered`,
   * the frame clock is reset, and the time is accumulated in `winBlurMs` — which is what lets
   * a later report say "this gap was the user being in another application" instead of "the
   * screen froze on them".
   *
   * Coming back is the moment this whole diagnostic exists for, and the snapshot it sends is
   * the report it never had: the surface is whatever was left on screen while nobody was
   * watching. So the return posts the surface *before* asking for the three frames that prove
   * drawing resumed — a document that kept laying out at its old size (the entire page in a
   * small rectangle in the top-left corner) or a canvas whose box the wrapper outgrew is
   * visible in `doc=` / `vis=` / `canvasRect=` on that line, and it may well be repaired
   * again by the time the first frame of the return arrives.
   */
  function applyWindowFocus(focused) {
    if (focused === winFocused) return;
    const now = perfNow();
    winFocused = focused;
    if (!focused) {
      // A window that goes away with the caret in the dock is the user's intent to come
      // back to it, and it is recorded here as well as in the input's `focusout`: whether
      // the platform fires that event before or after the host's message is not something
      // this side can assume, and a flag lost to the ordering is a caret lost for good.
      // No `focus()` happens here — this only remembers where the user was.
      if (composerHasFocus()) composerHadFocus = true;
      perfStopSampler();
      if (winBlurSince == null) winBlurSince = now;
      lastFrameAt = now;
      staleSince = null;
      staleReportedAt = 0;
      staleVia = null;
      return;
    }
    let away = 0;
    if (winBlurSince != null) {
      away = now - winBlurSince;
      winBlurMs += away;
      winBlurSince = null;
    }
    perfPost(
      'focus',
      Object.assign(
        {
          state: 'return',
          // The stretch that just ended, not the running total: next to a snapshot of the
          // surface, "how long nobody was looking at it" is the number that explains it.
          awayMs: Math.round(away),
        },
        perfSurface(),
      ),
    );
    lastFrameAt = now;
    requestAnimationFrame(perfMarkFrame);
    requestAnimationFrame(perfMarkFrame);
    requestAnimationFrame(perfMarkFrame);
    perfStartSampler();
    // The caret, inside the document the return just reactivated. The platform's own
    // `WebviewEditor.focus()` follows this message by a throttled ~50 ms and focuses the
    // webview's *frame*, not the element in it — so this re-asserts the caret on the next
    // frame and again for a second afterwards (see the composer focus block, `restoreComposerFocus`).
    // It refuses on its own when the user has clicked somewhere else, the dock is hidden or
    // the input is read-only.
    restoreComposerFocus('window');
  }

  /**
   * `probe`: answer with this document's counters *now*, then with the frame that
   * follows them. The two answers are what tell the three ways a quiet tab can fail
   * apart — the script is dead (neither arrives), the script runs but nothing reaches
   * the screen (`probe-frame` is the one that never comes), or both are fine and the
   * freeze is elsewhere. The counters go out immediately, before the frame is asked
   * for, because they are the half the host can still use from a tab that will never
   * paint again.
   *
   * The reply carries the whole surface (`perfSurface()`, merged last so the field names
   * are the ones every other report uses) plus the two facts about *looking*: the window's
   * own focus and how long it has been away. Together with `hiddenMs` / `tabHiddenMs` that
   * is every reason a frame may legitimately have stopped.
   */
  function perfOnProbe(msg) {
    try {
      const t0 = perfNow();
      perfNoteEpisode('probe');
      perfPost(
        'probe',
        Object.assign(
          {
            id: msg.id,
            msgs: perfMessages,
            drops: perfDrops,
            frames: frameCount,
            lastFrame: Math.round(perfNow() - lastFrameAt),
            dom: perfDomCount(),
            cards: Object.keys(nodeEls).length,
            hiddenMs: perfHiddenMs(),
            tabHiddenMs: perfTabHiddenMs(),
            focused: winFocused,
            winBlurMs: perfWinBlurMs(),
            readyState: document.readyState,
          },
          perfSurface(),
        ),
      );
      requestAnimationFrame(() => {
        try {
          perfPost('probe-frame', { id: msg.id, ms: Math.round(perfNow() - t0) });
        } catch (err) {
          /* a probe must never break the UI */
        }
      });
    } catch (err) {
      /* a probe must never break the UI */
    }
  }

  /**
   * `nudge`: the host's one cheap, non-destructive repair attempt — re-apply the
   * canvas transform and re-run the layout, i.e. hand the compositor the same picture
   * with its styles invalidated. It deliberately does nothing else: no camera move
   * (`keepActiveInView` / `panToNode`), no scroll, no card repaint — on a healthy tab
   * the user cannot tell it happened, which is what makes it safe to send
   * automatically. The frame that follows is the answer to "did that cure it"; when it
   * never arrives the host reports that and stops escalating.
   */
  function perfOnNudge(msg) {
    try {
      const t0 = perfNow();
      perfNoteEpisode('nudge');
      applyTransform();
      relayout();
      if (msg.force) {
        // The stronger invalidation, for a tab that has just come back to the front with a
        // surface that was never repainted while it was away: dropping the canvas' own layer
        // and taking it again is what a stale raster answers to, where re-applying the
        // transform it already had can be a no-op. Nothing moves on screen (the transform is
        // re-applied with the same values), which is what keeps it safe to send unasked.
        treeCanvas.style.willChange = 'transform';
        requestAnimationFrame(() => {
          try {
            treeCanvas.style.willChange = '';
            applyTransform();
          } catch (err) {
            /* diagnostics must never break the UI */
          }
        });
      }
      requestAnimationFrame(() => {
        try {
          perfPost('nudge-frame', { id: msg.id, ms: Math.round(perfNow() - t0) });
        } catch (err) {
          /* a probe must never break the UI */
        }
      });
    } catch (err) {
      /* a probe must never break the UI */
    }
  }

  /** Note which of the host's probes was seen while a stall was in flight (`via`). */
  function perfNoteEpisode(how) {
    if (staleSince == null) return;
    // A nudge outranks a probe whatever the order was: the nudge is the one that is
    // *meant* to bring the frames back, so "recovered via nudge" is the answer that
    // says the cure worked.
    if (how === 'nudge') staleVia = 'nudge';
    else if (!staleVia) staleVia = 'probe';
  }

  /** `"800px"` -> `800`; anything unparsable (a canvas never sized) -> `0`. */
  function perfPx(value) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * The tree canvas' own box, read from its *style* rather than from the DOM: a canvas
   * whose style still says 800x600 while its wrapper measures 1200x900 is exactly the
   * stale-layout evidence the probe is after, and the measured box would hide it.
   */
  function perfCanvasBox() {
    try {
      return perfPx(treeCanvas.style.width) + 'x' + perfPx(treeCanvas.style.height);
    } catch (err) {
      return '0x0';
    }
  }

  /** One element's measured box as `<w>x<h>`, for a report that must never throw. */
  function perfBox(el) {
    try {
      const rect = el.getBoundingClientRect();
      return Math.round(rect.width) + 'x' + Math.round(rect.height);
    } catch (err) {
      return '0x0';
    }
  }

  /** The window's own box — what the document thinks it was given to paint in. */
  function perfInnerBox() {
    try {
      return Math.round(window.innerWidth) + 'x' + Math.round(window.innerHeight);
    } catch (err) {
      return '0x0';
    }
  }

  function perfDpr() {
    return Number(window.devicePixelRatio) || 0;
  }

  /** The tree's zoom factor, rounded: the multiplier between the canvas and the screen. */
  function perfZoom() {
    return Math.round((Number(zoom) || 1) * 100) / 100;
  }

  /**
   * The document's own initial containing block — what the *layout engine* believes it was
   * given. This is the box that goes stale when a resize never reaches the document: the
   * page then lays out at the old, smaller size and paints into the top-left corner while
   * the window around it is already large, which is what "the whole Spinney page became a
   * small rectangle in the corner" looks like from outside. `documentElement`, not `body`:
   * a document with no height set on its root is exactly the case this reads.
   */
  function perfDocBox() {
    try {
      const el = document.documentElement;
      return Math.round(el.clientWidth) + 'x' + Math.round(el.clientHeight);
    } catch (err) {
      return '0x0';
    }
  }

  /**
   * The visual viewport, when the engine has one: the size the compositor is actually
   * showing, which is *not* the same question as the layout viewport above. A `doc=` that
   * disagrees with this one is the stale-layout-viewport defect, stated as two numbers.
   */
  function perfVisualBox() {
    try {
      const vv = window.visualViewport;
      if (!vv) return 'n/a';
      return Math.round(vv.width) + 'x' + Math.round(vv.height);
    } catch (err) {
      return 'n/a';
    }
  }

  /**
   * The canvas in **device pixels**: `style × zoom × dpr`, i.e. the pixels the compositor
   * has to raster for this one layer. It is the number a layer/texture limit is measured
   * against, and until now no line carried it — nor the `zoom` that turns the readout the
   * stall line already had (`canvas=`, in CSS pixels) into this one.
   */
  function perfCanvasDeviceBox() {
    try {
      const scale = perfZoom() * (perfDpr() || 1);
      const w = Math.round(perfPx(treeCanvas.style.width) * scale);
      const h = Math.round(perfCanvasStyleHeight() * scale);
      return w + 'x' + h;
    } catch (err) {
      return '0x0';
    }
  }

  /** The canvas style height in CSS pixels (`perfPx` on the style, never the measured box). */
  function perfCanvasStyleHeight() {
    try {
      return perfPx(treeCanvas.style.height);
    } catch (err) {
      return 0;
    }
  }

  /**
   * Where the canvas was actually laid out, relative to the wrapper: `WxH@x,y`. A canvas
   * whose measured box disagrees with the wrapper it lives in is "the canvas kept its old
   * box while the tree area grew" — the other half of the resize report, as a number
   * instead of an inference.
   */
  function perfCanvasRect() {
    try {
      const r = treeCanvas.getBoundingClientRect();
      return (
        Math.round(r.width) + 'x' + Math.round(r.height) +
        '@' + Math.round(r.left) + ',' + Math.round(r.top)
      );
    } catch (err) {
      return '0x0@0,0';
    }
  }

  /**
   * The whole surface this document is painting into, on **one** template, for every report
   * that has to answer that question: the `probe` reply, the `focus` snapshot of a return,
   * the `resize` report, and the `doc=` / `zoom=` half of a `stall`.
   *
   * WHY THESE FIELDS AND NOT A SCREENSHOT. A frozen picture has two shapes and they are
   * told apart by comparing boxes, not by looking:
   *
   *  - **the viewport went stale** — the document kept laying out at its old size, so the
   *    page paints into a small rectangle in the top-left corner: `doc=` (the ICB) falls
   *    behind `inner=` / `vis=` (the window and the visual viewport), and `wrap=` — which is
   *    measured *through* the layout — stays at the old size too;
   *  - **the canvas is too big to repaint** — `canvasDev=` is the raster the compositor owes
   *    for one layer, and `canvasRect=` says whether the canvas was ever re-measured against
   *    its wrapper.
   *
   * Every field is a string except the two numbers, and every one of them is producible on a
   * real engine *and* in the offline sandbox (`tools/check-webview.js` stubs the DOM; a
   * missing `visualViewport` answers `n/a` rather than throwing).
   */
  function perfSurface() {
    return {
      doc: perfDocBox(),
      vis: perfVisualBox(),
      inner: perfInnerBox(),
      wrap: perfBox(treeWrap),
      canvas: perfCanvasBox(),
      canvasDev: perfCanvasDeviceBox(),
      canvasRect: perfCanvasRect(),
      dpr: perfDpr(),
      zoom: perfZoom(),
    };
  }

  // ---- Messages thrown away for a node with no card ----------------------------
  // `routeTo` cannot write a routed message into a node the tree does not have, and
  // the message then disappears: no card, no error, nothing in the log. That is the
  // same silence the probe above exists to break — a host streaming into a node this
  // webview never created looks exactly like a host that stopped sending — so every
  // such message is counted, and the FIRST one per node is reported. One broken node
  // must not flood the channel with a report per delta of a whole turn; the running
  // total is what the probe reply carries as `drops`.
  const perfDropSeen = Object.create(null);   // node id -> its first drop was reported
  let perfDrops = 0;                          // messages thrown away, in total

  /**
   * Count one message that had no card to land in. `kind` names the message that was
   * lost — the streaming call sites pass their own type, everything else stays
   * `append` — and it is also the *node* of a drop that has no node id at all: the
   * legacy anonymous bucket, where the kind of the message is the only name the loss
   * can be reported under. (It cannot ride along as a field called `kind`: `perfPost`
   * merges its fields *over* `{ type, kind }`, so that name would become the report's
   * kind and turn the drop into a `webview-delta` line.)
   */
  function perfCountDrop(node, kind) {
    const key = node || kind || 'append';
    perfDrops++;
    if (perfDropSeen[key]) return;
    perfDropSeen[key] = true;
    perfPost('drop', { node: key, n: 1 });
  }

  // ---- The surface's own size (the `resize` report) ----------------------------
  // A wrapper that is resized while the canvas keeps its old box is one shape a frozen
  // picture takes: the canvas is what the pan/zoom transform moves, so a wrap the layout
  // never re-measured leaves the tree parked where it was. The observer that drives
  // `relayout()` reports the change here; the report is throttled, so a dragged window
  // writes one line per half second and a settled one writes none.
  //
  // WHY THE OBSERVER ALONE WAS NOT ENOUGH — the hole this rewrite closes. The report used
  // to fire only when the wrapper's *own box* changed, and that box is exactly the one a
  // stale layout viewport does not move: when the panel grows but the document keeps laying
  // out at its old size, `treeWrap` measures the same as before and the one report written
  // for this defect can never fire. Measured on the re-report it should have caught: zero
  // `webview-resize` lines in 3 h 20 m, through a session whose complaint was "the whole
  // page became a small rectangle in the corner after I resized the panel". So the window's
  // and the visual viewport's own resize events drive it as well (`via=window` / `via=vv`);
  // those fire whether or not the layout followed. The report now carries the whole surface
  // (`perfSurface()`) and `was=`, the pair it replaced — so a document that did not follow
  // its window states that in one line, as `doc=` / `wrap=` behind `inner=` / `vis=`.
  let resizeReportAt = 0;
  let resizeReportedSurface = '';  // the whole stamp of the last report ('' = no baseline yet)
  let resizeReportedWas = '';      // its `WxH@inner`, which the next report prints as `was=`

  /** The stamp one report is compared against the previous one by, as a whole. */
  function perfResizeStamp(w, h, surface) {
    return w + 'x' + h + '@' + surface.inner + '/' + surface.vis + '/' + surface.doc;
  }

  /**
   * Report the surface. `via` names what asked: the wrapper's `ResizeObserver` (which also
   * drives the re-layout), the window's own `resize`, or the visual viewport's.
   */
  function perfReportResize(via) {
    try {
      const rect = treeWrap.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      const surface = perfSurface();
      const stamp = perfResizeStamp(w, h, surface);
      // The first measurement of a document is the baseline, not a change: there is
      // nothing to compare it with, and the probe reply already carries it.
      if (resizeReportedSurface === '') {
        resizeReportedSurface = stamp;
        resizeReportedWas = w + 'x' + h + '@' + surface.inner;
        return;
      }
      // A window/viewport event is allowed through with the wrapper's box unchanged — that
      // is precisely the stale-layout-viewport case, and the throttle below is what bounds
      // it. An observer callback with nothing new to say writes nothing.
      if (via === 'observer' && stamp === resizeReportedSurface) return;
      const now = perfNow();
      if (now - resizeReportAt < RESIZE_REPORT_MS) return;
      const was = resizeReportedWas;
      resizeReportAt = now;
      resizeReportedSurface = stamp;
      resizeReportedWas = w + 'x' + h + '@' + surface.inner;
      perfPost('resize', Object.assign({ via, was }, surface));
      // A re-layout — and, on a tree this size, the re-raster of one enormous layer — is a
      // legitimate reason for frames to stop, so the frame clock starts again here. An
      // episode already in flight is left alone: a stall that began before this line is not
      // made untrue by it, and clearing it would hide the very thing this file reports.
      if (staleSince == null) lastFrameAt = perfNow();
    } catch (err) {
      /* a probe must never break the UI */
    }
  }

  // The sampler is started by the document itself, not by a message: a tab that froze
  // before anyone could ask it anything is exactly the case this exists for. A document
  // that loads hidden (a restored background tab) samples nothing until it is shown —
  // but the hidden stretch it starts in is already hidden time, so the clock for it
  // starts here rather than at the first `visibilitychange`.
  if (perfHidden()) hiddenSince = perfNow();
  perfStartSampler();
  document.addEventListener('visibilitychange', perfNoteVisibility);

  // The active node's pinned user prompt (sticky at the top of an expanded card).
  let promptEl = null;
  // Drag-to-resize a card: bounds for the custom size + a live wireframe preview.
  const MIN_W = 320;
  const MAX_W = 1600;
  // Cards host the composer dock at their bottom, so a very short card would
  // clip the input — keep the resizable minimum above it.
  const MIN_H = 260;
  const MAX_H = 1200;
  let resizing = null;       // { id, startX, startY, startW, startH, target }
  let resizePreview = null;  // wireframe element
  let resizeRaf = null;

  // ---- Element helpers ----
  /** True for the display-only sidecars: sub-agent windows and job cards. */
  function isSidecarKind(kind) {
    return kind === 'agent' || kind === 'bg';
  }

  /**
   * Depth-first lookup of a plain class inside one element's own subtree. Used
   * where "absent" must be observable (`querySelector` is forgiving in the offline
   * webview checker's stub DOM, so a miss there is not a miss).
   */
  function byClass(root, name) {
    for (const child of (root && root.children) || []) {
      if (child.classList && child.classList.contains(name)) return child;
      const nested = byClass(child, name);
      if (nested) return nested;
    }
    return null;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  // ---- Elapsed readouts: a local ticker over a registry of live chips ----
  // While a job / sub-agent / tool call runs, its card carries a live duration, and
  // it is the *webview* that makes it tick: the host sends only the start clock and,
  // when the run ends, its authoritative duration. Host and webview share one machine
  // clock (`Date.now()`), so nothing has to travel for 4 ticks a second — and the
  // number on screen is honest even while the panel is flooded with messages.
  //
  // The ticker walks a registry, never the DOM: there is no cheap "which chips are
  // live" query in the webview (a `querySelectorAll` per tick would cost real work in
  // a 40-card session), and the offline webview checker's stub answers `[]` for every
  // `querySelectorAll`, so a DOM scan would be untestable there — which is exactly the
  // kind of silent breakage that checker exists to catch.

  /**
   * `1250` -> `1.2s`, `3400` -> `3.4s`, `192000` -> `3m 12s`.
   *
   * The host's `src/duration.ts` in miniature: this readout is a locale-free token
   * (no unit words, no `Intl`, no punctuation of its own) that is dropped straight
   * into a chip, so the webview mirrors the host's shapes instead of inventing a
   * second dialect — and, being a token, it needs no `tr()` key. The shape coarsens
   * with magnitude on purpose: milliseconds stay exact, a few seconds keep one
   * decimal, past ten seconds the tenth is noise, past a minute the seconds are
   * context.
   */
  function formatDuration(ms) {
    // NaN / Infinity / negative all mean "no duration measured": clamp rather than
    // print "NaNms" or "-1s" into a user-facing chip.
    const t = Number.isFinite(ms) && ms > 0 ? ms : 0;
    if (t < 1000) {
      return Math.round(t) + 'ms';
    }
    // Round to the tenth *first*, then test: 9950 becomes 10.0 and must fall through
    // to the whole-second shape rather than print "10.0s".
    const secs = Math.round(t / 100) / 10;
    if (secs < 10) {
      return secs.toFixed(1) + 's';
    }
    // Below a minute the seconds are rounded — 59600ms reads "1m 0s", never the
    // nonsensical "60s". From a minute up they are truncated, exactly as
    // `src/duration.ts` does it: the chip on a card and a duration quoted in a tool
    // result describe the same run, and a one-second disagreement between the two
    // readouts would be a lie. So 3599999ms is "59m 59s", and only a full 3600000ms
    // is "1h 0m".
    const sec = Math.round(t / 1000);
    if (t < 60000) {
      return sec < 60 ? sec + 's' : '1m 0s';
    }
    const whole = Math.floor(t / 1000);
    const min = Math.floor(whole / 60);
    if (t < 3600000) {
      return min + 'm ' + (whole - min * 60) + 's';
    }
    return Math.floor(min / 60) + 'h ' + (min % 60) + 'm';
  }

  /** Chips whose value is still moving; the frozen ones are never in here. */
  const liveElapsed = [];
  let elapsedTimer = null;

  /**
   * One 250ms interval for the whole session, started the first time a chip goes
   * live. Four ticks a second is what a "1.2s" readout needs to look alive; a card
   * that is merely *rendered* twice does not pay for it.
   */
  function startElapsedTicker() {
    if (elapsedTimer != null) return;
    elapsedTimer = setInterval(tickElapsed, 250);
  }

  /**
   * Recompute every live chip. A chip whose element left the tree (its body was
   * rebuilt, or its card was dropped) is forgotten here - the registry must not
   * grow with the session.
   */
  function tickElapsed() {
    for (let i = liveElapsed.length - 1; i >= 0; i--) {
      const chip = liveElapsed[i];
      if (!chip.parentElement || chip.isConnected === false) { liveElapsed.splice(i, 1); continue; }
      const text = formatDuration(Date.now() - chip._start);
      if (chip.textContent !== text) chip.textContent = text;   // write only on change
    }
  }

  /**
   * Show, refresh or drop one card's elapsed chip.
   *   start != null -> live: it ticks until it is frozen
   *   ms != null    -> frozen value from the host
   *   neither       -> no chip (nothing is known about this run)
   *
   * The chip is found with `byClass`, not `querySelector`: "there is no chip yet" has
   * to be *observable* — the offline checker's stub answers a plain query with a
   * forgiving dummy element, so a lookup that missed would read as a hit and the real
   * chip would never be created. `beforeEl` keeps the chip where the head's design
   * wants it (a chip appended after the delete button would sit at the wrong end of
   * the row).
   */
  function syncElapsed(parent, cls, start, ms, beforeEl) {
    if (!parent) return null;
    let chip = byClass(parent, cls);
    // Created lazily, in one place: a live and a frozen chip differ only in what
    // their text is set to below, so both take the same position in the row.
    const ensure = () => {
      if (!chip) {
        chip = el('span', cls, '');
        // Only an anchor that really is a child of `parent` may be used: inserting
        // before a foreign element would move the chip into the wrong subtree.
        if (beforeEl && beforeEl.parentElement === parent) parent.insertBefore(chip, beforeEl);
        else parent.appendChild(chip);
      }
      return chip;
    };
    if (start != null) {
      chip = ensure();
      chip._start = start;
      // A repaint that re-registers the same chip must not grow the registry (the
      // ticker would then format the same element twice per tick, forever).
      if (liveElapsed.indexOf(chip) < 0) liveElapsed.push(chip);
      // Write the value now, not 250ms from now: the first paint of a card that was
      // restored from the tree must not show an empty chip.
      chip.textContent = formatDuration(Date.now() - start);
      startElapsedTicker();
      return chip;
    }
    if (ms != null) {
      // The host's own number wins, and this chip stops moving: leaving it in the
      // registry would let a later tick overwrite the authoritative value.
      const at = liveElapsed.indexOf(chip);
      if (at >= 0) liveElapsed.splice(at, 1);
      chip = ensure();
      chip.textContent = formatDuration(ms);
      return chip;
    }
    // Nothing is known about this run any more: no chip at all beats a stale one.
    if (chip) chip.remove();
    return null;
  }

  /**
   * The line diff of a file-modifying call, as one chip in the row's head: `+12` in the
   * success colour, `-3` in the error colour, in the same 10px monospace the elapsed chip
   * uses (both are numbers about a call, not words about it).
   *
   * A side that is zero is not drawn at all — a pure append is `+40`, never `+40 -0` — and
   * a call that changed no line draws no chip: `+0 -0` would be a claim about nothing. The
   * numbers come from the host (`DisplayItem.diff`, read out of the call's own result), so
   * a repaint and the live turn draw the same chip, and `beforeEl` keeps it left of the
   * elapsed chip wherever both exist.
   */
  function syncDiff(parent, diff, beforeEl) {
    if (!parent) return null;
    const add = diff ? Math.max(0, Number(diff.add) || 0) : 0;
    const del = diff ? Math.max(0, Number(diff.del) || 0) : 0;
    let chip = byClass(parent, 'tool-diff');
    if (!add && !del) {
      if (chip) chip.remove();
      return null;
    }
    if (!chip) {
      chip = el('span', 'tool-diff', '');
      // Only an anchor that really is a child of `parent` may be used: inserting before
      // a foreign element would move the chip into the wrong subtree.
      if (beforeEl && beforeEl.parentElement === parent) parent.insertBefore(chip, beforeEl);
      else parent.appendChild(chip);
    }
    chip.textContent = '';
    if (add) chip.appendChild(el('span', 'tool-diff-add', '+' + add));
    if (del) chip.appendChild(el('span', 'tool-diff-del', '-' + del));
    return chip;
  }

  /**
   * The tools whose result carries the remaining **exchange budget**, i.e. the two that
   * send something into another session. `wait_for_session_idle` and `interrupt_session`
   * spend nothing, so they never grow this chip.
   */
  const ROUNDS_CHIP_TOOLS = new Set(['send_session_prompt', 'create_session']);

  /**
   * The JSON receipt `send_session_prompt` answers with, or null when the answer is a
   * sentence (the other three session tools). A receipt is read into facts and never
   * printed: `{"state":"delivered",…}` in a card is a debug trace, not an answer.
   */
  function sessionReceipt(content) {
    const text = String(content || '').trim();
    if (text.charAt(0) !== '{') return null;
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * `3` for `…"rounds_left":3` (a receipt) or for `…3 rounds left…` (a sentence), null when
   * the answer names no budget. Both shapes are real: `create_session` says it in words.
   */
  function roundsLeftOf(content, receipt) {
    if (receipt && typeof receipt.rounds_left === 'number') return receipt.rounds_left;
    const m = /(\d+) rounds? left/.exec(String(content || ''));
    return m ? Number(m[1]) : null;
  }

  /** The session a `create_session` made, out of `Started session <id> "<title>"`. */
  function createdSessionId(content) {
    const m = /Started session (\S+)/.exec(String(content || ''));
    return m ? m[1] : '';
  }

  /**
   * The remaining exchange budget of a session prompt, as one chip in the row's head: the
   * one number that says whether this line can still answer. It lives only in the result,
   * so a folded row would otherwise say nothing about it, and the receipt it comes from is
   * a click away. `beforeEl` keeps it left of the elapsed chip, exactly as `syncDiff` does.
   */
  function syncSessionRounds(parent, name, content, beforeEl) {
    if (!parent) return null;
    let chip = byClass(parent, 'tool-rounds');
    const rounds = ROUNDS_CHIP_TOOLS.has(name) ? roundsLeftOf(content, sessionReceipt(content)) : null;
    if (rounds === null) {
      if (chip) chip.remove();
      return null;
    }
    if (!chip) {
      chip = el('span', 'tool-rounds', '');
      // Only an anchor that really is a child of `parent` may be used (see `syncDiff`).
      if (beforeEl && beforeEl.parentElement === parent) parent.insertBefore(chip, beforeEl);
      else parent.appendChild(chip);
    }
    chip.textContent = rounds === 1 ? tr('1 round left') : tr('{0} rounds left', String(rounds));
    chip.title = tr('The exchange budget this line has left');
    return chip;
  }

  // ---- Code colouring ----
  // The colouring itself happens in the **host**: a TextMate engine on top of wasm, which
  // this webview cannot compile under its own CSP (`script-src` has no
  // `'wasm-unsafe-eval'`), and whose grammar loads are asynchronous while `renderMarkdown`
  // is not. What lives here is a cache and a request cycle: a fence renders plain, is
  // remembered, and is asked for once. The answer arrives as escaped HTML keyed the same
  // way on both sides, and every `<code>` already on screen that matches is upgraded in
  // place, so no answer is ever re-rendered just to gain colour.
  const hlCache = new Map(); // key -> html
  const hlAsked = new Set(); // keys already sent to the host
  const hlPending = new Map(); // key -> { lang, text }
  let hlTimer = 0;
  // The host refuses past the same size; asking is pointless and the payload is large.
  const HL_MAX_CHARS = 200000;

  /**
   * The key the host computes too: FNV-1a over the language and the code, plus the
   * length. `crypto.subtle` is asynchronous, and keying by the code itself would put a
   * second copy of every block in every payload.
   */
  function hlKey(lang, text) {
    const all = String(lang || '').toLowerCase() + '\u0000' + text;
    let h = 0x811c9dc5;
    for (let i = 0; i < all.length; i++) {
      h = Math.imul(h ^ all.charCodeAt(i), 0x01000193) >>> 0;
    }
    return h.toString(16) + ':' + all.length;
  }

  /**
   * One `hl` request per tick, not one per fence: a long answer can hold several blocks
   * and a repaint can render several answers at once.
   */
  function flushHighlightRequests() {
    hlTimer = 0;
    if (!hlPending.size) return;
    const items = [];
    for (const [key, item] of hlPending) {
      hlAsked.add(key);
      items.push(item);
    }
    hlPending.clear();
    vscode.postMessage({ type: 'hl', items });
  }

  function requestHighlight(lang, key, text) {
    if (hlAsked.has(key) || hlPending.has(key)) return;
    hlPending.set(key, { lang, text });
    if (!hlTimer) hlTimer = setTimeout(flushHighlightRequests, 40);
  }

  /**
   * markdown-it's `highlight` option. Returning `''` leaves the block exactly as it was
   * (markdown-it escapes the code itself and keeps its `language-*` class), which is what
   * an uncoloured, an unknown and a not-yet-answered fence all get.
   */
  function highlightFence(text, lang) {
    const name = String(lang || '').trim().toLowerCase();
    // `js {1,3}` and `ts title="a.ts"` reach us as the attrs argument, so `lang` is the
    // bare word already; a fence with no info string is never coloured.
    if (!name) return '';
    const key = hlKey(name, text);
    const hit = hlCache.get(key);
    if (hit !== undefined) return hit;
    if (text.length <= HL_MAX_CHARS) requestHighlight(name, key, text);
    return '';
  }

  /** Store what the host answered and upgrade every matching block already on screen. */
  function applyHighlights(entries) {
    if (!entries) return;
    for (const key of Object.keys(entries)) hlCache.set(key, entries[key]);
    const blocks = document.querySelectorAll('code[class*="language-"]');
    for (const code of blocks) {
      const match = /language-([^\s]+)/.exec(code.className || '');
      if (!match) continue;
      const key = hlKey(match[1], code.textContent || '');
      const html = hlCache.get(key);
      if (html === undefined || code._hlKey === key) continue;
      code.innerHTML = html;
      code._hlKey = key;
    }
  }

  // ---- Markdown ----
  // `linkify` is OFF: it turned a bare `AGENTS.md` (and any `file.ext`, version number or
  // dotted identifier) into a web link, which is wrong far more often than it is right in a
  // coding conversation. Explicit `[text](url)` links still work, and so do the result URLs
  // the web-search viewer builds itself; a real autolink is a separate, later question.
  const md = window.markdownit
    ? window.markdownit({
        html: false,
        breaks: true,
        linkify: false,
        typographer: false,
        highlight: highlightFence,
      })
    : null;

  // The **inline** renderer of the find bar's result rows (`findSnippetEl`). A separate
  // instance, not `md.disable([...])`: `disable` mutates the ruler, and switching links off
  // for the result list must not switch them off in the cards. A row is one line cut out of
  // an answer, so blocks cannot apply, and both links and images must not: the row is a
  // `<button>` (an `<a>` inside it is invalid HTML and would take the click from the jump),
  // and an `<img>` from a conversation would make the webview fetch an arbitrary URL.
  const mdInline = window.markdownit
    ? window.markdownit({ html: false, breaks: true, linkify: false, typographer: false }).disable([
        'link',
        'image',
        'autolink',
      ])
    : null;

  function escapeHtml(text) {
    return String(text || '').replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        default: return '&#39;';
      }
    });
  }

  function renderMarkdown(text) {
    // Markdown is the single most expensive thing a repaint does (a long session
    // re-renders hundreds of items), so the burst report counts it separately.
    const t0 = perfNow();
    try {
      return md ? md.render(text || '') : escapeHtml(text);
    } finally {
      perfMarkdown.ms += perfNow() - t0;
      perfMarkdown.calls++;
    }
  }

  /**
   * A find row's one line, as inline markdown — or `null` when this document has no
   * markdown-it at all (the build-time stub of `check:webview` loads `media/main.js`
   * alone), and the caller then shows the raw text.
   *
   * Deliberately `renderInline`: the snippet is a ±60-character window of a card's answer,
   * so every block construct starts outside it and would render as a fragment.
   */
  function renderFindSnippet(text) {
    if (!mdInline) {
      return null;
    }
    try {
      return mdInline.renderInline(text || '');
    } catch (err) {
      return null;
    }
  }

  // ---- The follow light (the green dot) ----
  // A green dot is the only follow control a scroller has, and what it means is one
  // thing: **follow the newest content**. It is not a lock on the scrollbar — the reader
  // may scroll while the light is on, and the light goes out by itself the moment they do.
  // The rule is the *direction* of the move:
  //
  //  - a `scroll` that lands at the bottom (`top + clientHeight >= scrollHeight - 2`)
  //    engages follow again, so the dot is green exactly while the newest content is on
  //    screen — including after the reader scrolled back down;
  //  - a `scroll` above the bottom whose offset moved **up** since the last one releases
  //    it (the dot dims), and the log then keeps the offset the reader left.
  //
  // Nothing else may release it. A programmatic pin (`scrollToBottom` / `pinToBottom`) and
  // plain content growth both move the offset *towards* the bottom — or leave it where it
  // is — so neither can be mistaken for a reader's gesture. That is the difference from
  // the old heuristic ("not at the bottom any more, so the user scrolled"), which unlocked
  // a card under its own output on every heavy stream. The one ordering that could still
  // fight a drag is a delta landing between the move and its `scroll`: the follow pin
  // therefore stands down while the box sits above the offset the controller last wrote,
  // and the event that arrives next releases the light.
  //
  // `locked` is the initial state: a live turn starts following, a finished node starts
  // released — and is still positioned at its newest content once, by `pinToBottom`.
  /** The controller's own hook on its container, so a memory restore is not a gesture. */
  const FOLLOW = '_follow';

  function createScrollController(container, onChange, locked) {
    // `lastTop` is the offset the controller last knows about: written before a programmatic
    // pin, and updated from every `scroll` the engine reports.
    const state = { locked: locked !== false, lastTop: container.scrollTop || 0 };

    /** The offset of the newest content — what a pin writes. */
    function bottom() {
      return Math.max(0, (container.scrollHeight || 0) - (container.clientHeight || 0));
    }

    /** Is the box showing its newest content? The 2px slack absorbs sub-pixel rows. */
    function atBottom() {
      const top = container.scrollTop || 0;
      return top + (container.clientHeight || 0) >= (container.scrollHeight || 0) - 2;
    }

    /**
     * Write an offset the controller itself chose. The tracked offset moves with it
     * *before* the engine can report it back as a `scroll`, so a pin is never read as the
     * reader's move — that is what keeps a following log following its own stream. The
     * tracked value is read back off the box, because the engine may clamp or round the
     * write (a fractional `scrollHeight`), and the echo then has to match exactly.
     */
    function writeOffset(top) {
      if ((container.scrollTop || 0) !== top) container.scrollTop = top;
      state.lastTop = container.scrollTop || 0;
    }

    function scrollToBottom() {
      if (!state.locked) return;
      // The box sits above where the controller last left it: that is a reader's move whose
      // `scroll` has not been dispatched yet, so the pin stands down rather than revert it
      // before the event can release the light. (A generation's growth only ever raises the
      // offset, so this is never the stream's own doing.)
      if ((container.scrollTop || 0) < state.lastTop) return;
      writeOffset(bottom());
    }

    function setLocked(value) {
      const changed = state.locked !== value;
      state.locked = value;
      if (changed) {
        container.classList.toggle('scroll-locked', value);
        if (onChange) onChange(value);
      }
      // Engaging follow puts the reader at the newest content immediately: the green light
      // is a promise about where they are, not only about where the next token goes. It is
      // a forced pin — the reader asked for it, so nothing stands down for a stale event.
      if (value) writeOffset(bottom());
    }

    /**
     * The engine reporting a scroll. Only two things here are a reader's move: landing at
     * the bottom (follow again) and going **up** (release). A pin or an append changes the
     * offset towards the bottom, and an event that reports an offset the controller already
     * wrote is its own echo — neither touches the light.
     */
    function handleScroll() {
      const top = container.scrollTop || 0;
      if (top === state.lastTop) return;
      // A box with nothing to scroll over has no offset worth reading as a gesture: an
      // emptied container mid-rebuild, or a log the fold just shrank below its box, reports
      // the engine's clamp to 0 and nothing else — that is not the reader scrolling up.
      if ((container.scrollHeight || 0) <= (container.clientHeight || 0)) {
        state.lastTop = top;
        return;
      }
      const movedUp = top < state.lastTop;
      state.lastTop = top;
      if (atBottom()) {
        if (!state.locked) setLocked(true);
      } else if (movedUp && state.locked) {
        setLocked(false);
      }
    }
    container.addEventListener('scroll', handleScroll, { passive: true });

    container.classList.toggle('scroll-locked', state.locked);

    const api = {
      get locked() { return state.locked; },
      scrollToBottom,
      /**
       * Position at the newest content **without** engaging follow: the once-per-card
       * "opens at its newest content" (`_needsBottomScroll`). It goes through the same
       * tracked offset as a pin, so the move cannot be read as the reader scrolling down.
       */
      pinToBottom() {
        writeOffset(bottom());
      },
      /**
       * The offset is now `top` and that move is not the reader's (a memory restore after a
       * repaint): the light neither engages nor releases because of it.
       */
      syncOffset(top) {
        state.lastTop = top || 0;
      },
      lock() { setLocked(true); },
      unlock() { setLocked(false); },
      toggle() { setLocked(!state.locked); },
    };
    // `restoreScroll` hands the offset it is about to write back to the controller (see
    // `syncOffset`): a repaint is not a gesture in either direction.
    container[FOLLOW] = api;
    return api;
  }

  const LOCK_TITLE_ON = tr('Auto-scroll on — click to release');
  const LOCK_TITLE_OFF = tr('Auto-scroll off — click to follow again');

  /**
   * The `right` that puts the light's centre on the centre of its scrollbar, or `null` when
   * there is nothing to measure.
   *
   * The scroller keeps a gutter down its own right edge (`scrollbar-gutter: stable`), so its
   * bar sits in a strip that is inside the box while the dot is positioned against the
   * **host's** padding box — a fixed `right` is therefore half a gutter off the bar. Both
   * numbers are read, never guessed: the gutter is `offsetWidth - clientWidth`, and the
   * host's own right padding is what is left of its width beyond the scroller's left edge and
   * the scroller itself. A box that has no layout yet (a card is appended a few lines after
   * its dot is created, and the offline guard's DOM has no geometry at all) measures no
   * gutter, and then nothing is written at all: the stylesheet's fixed offset stands, which
   * is the fallback `tools/check-webview.js` pins. Nothing is ever cleared either — a box
   * that loses its gutter (a hidden log) keeps the offset it had.
   */
  function lockDotRight(container, host, dot) {
    const gutter = (container.offsetWidth || 0) - (container.clientWidth || 0);
    if (gutter <= 0) return null;
    const pad = Math.max(0, (host.clientWidth || 0) - (container.offsetLeft || 0) - (container.offsetWidth || 0));
    const right = Math.max(0, (gutter - (dot.offsetWidth || 0)) / 2 + pad);
    return right + 'px';
  }

  /** Write one measured offset onto its dot. A `null` value changes nothing. */
  function applyLockDot(dot, value) {
    if (!value || !dot || !dot.style || dot.style.right === value) return;
    dot.style.right = value;
  }

  /**
   * Measure and apply in one step, for a single dot outside a layout pass. It also answers
   * the one question the card's **bottom strip** depends on: a log that fits its box has
   * nothing to scroll, so the room reserved under it for the light is dead space — the host
   * drops it and the light goes with it (`.node-work-wrap.fits` in `media/style.css`).
   */
  function syncLockDot(container, host, dot) {
    const value = lockDotRight(container, host, dot);
    applyLockDot(dot, value);
    const fits = (container.scrollHeight || 0) <= (container.clientHeight || 0) + 1;
    if (host && host.classList) host.classList.toggle('fits', fits);
    return value !== null;
  }

  // The green dot lives on the host of a scrollable container, in the strip reserved below
  // it (the container keeps a bottom margin so the dot sits just under the scrollbar).
  // Live turns start following (the dot is green); finished nodes start released. A click
  // toggles it — engaging follow scrolls to the newest content immediately, releasing it
  // hands the bottom to the reader. A scroll is the other way in and out (see the
  // direction rule above): it releases nothing but an upward move, and it re-engages only
  // at the bottom, so a card cannot unlock itself under its own stream.
  //
  // The log is a card's only scroller, so it carries the only light a card has — except
  // the open form of a thinking row, which is a 240px scroller of its own
  // (`attachRowLock`, below). Both lights are positioned by measurement (`syncLockDot`), so
  // the vertical offset is the stylesheet's and the horizontal one is the gutter's own.
  function attachLock(container, host, locked) {
    const dot = el('div', 'scroll-lock-dot' + (locked === false ? '' : ' locked'));
    const ctrl = createScrollController(container, (isLocked) => {
      dot.classList.toggle('locked', isLocked);
      dot.title = isLocked ? LOCK_TITLE_ON : LOCK_TITLE_OFF;
    }, locked);
    dot.title = ctrl.locked ? LOCK_TITLE_ON : LOCK_TITLE_OFF;
    dot.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // Toggling is the reader's own move in both directions: engaging pins the log to the
      // newest content, releasing leaves `scrollToBottom` a no-op and the log's memory is
      // what puts them back after a repaint.
      ctrl.toggle();
    });
    host.appendChild(dot);
    // The dot's offset is the log's own scroll gutter (see `lockDotRight`). It is measured
    // again on every layout pass (`relayout`), because this call happens before the card is
    // appended and so measures nothing.
    ctrl.syncDot = () => syncLockDot(container, host, dot);
    ctrl.syncDot();
    return ctrl;
  }

  /**
   * Engage / release a card's one scroller (`.node-work`). The card has exactly one, so
   * there is nothing else to walk: the tool rows scroll *with* it. The open form of a
   * thinking row is the one row that scrolls inside itself, and it carries its own light
   * (`attachRowLock`).
   */
  function setCardScrollLock(card, locked) {
    if (!card) return;
    if (card._itemScroll) (locked ? card._itemScroll.lock() : card._itemScroll.unlock());
  }

  /**
   * The light of a container that is not a card's log: the open reasoning box. The dot
   * belongs to the row (which is its positioning context) and lives in the DOM only while
   * the row is open — a closed row is one ellipsised line with nothing to follow — so the
   * caller appends it on open and removes it on close. Its click toggles this box alone and
   * must not reach the row, whose click opens and closes the whole row.
   */
  function attachRowLock(row, container) {
    const dot = el('div', 'scroll-lock-dot row-lock locked');
    const ctrl = createScrollController(container, (isLocked) => {
      dot.classList.toggle('locked', isLocked);
      dot.title = isLocked ? LOCK_TITLE_ON : LOCK_TITLE_OFF;
    }, true);
    dot.title = ctrl.locked ? LOCK_TITLE_ON : LOCK_TITLE_OFF;
    dot.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ctrl.toggle();
    });
    row._lockDot = dot;
    // Same measured offset as the log's light (`lockDotRight`): the row is built a task before
    // it is appended and it only has a scroller while it is open, so `setThinkingOpen`
    // measures again on the transition that puts the dot in the row.
    ctrl.syncDot = () => syncLockDot(container, row, dot);
    return ctrl;
  }

  // ---- Remembering where a reader was ------------------------------------------
  // **A repaint never moves a scroller.** A rebuild or a window extension can each take
  // a container's position away, and none of them puts it back: `innerHTML = ''` resets
  // it. The one thing that survives all of them is the offset the reader last scrolled
  // to, so the log keeps it and hands it back. A locked card is never restored: its
  // follow light owns the bottom, and the caller pins it there (`scrollToBottom`).
  const SCROLL_MEMORY = '_scrollMemory';

  /**
   * Start remembering this container's offset. Attached once, when the card that owns
   * the container is built; a container with no scrollable geometry at all (the
   * offline webview checker has no layout) never records anything, and a host without
   * that geometry simply never restores.
   */
  function rememberScroll(container) {
    if (!container || container[SCROLL_MEMORY]) return container;
    const memory = { top: 0, seen: false };
    container[SCROLL_MEMORY] = memory;
    container.addEventListener(
      'scroll',
      () => {
        // A container with nothing to scroll over — an empty zone mid-rebuild, or one
        // the split measurement has briefly stretched to its own content height — has
        // no offset worth keeping. Those are exactly the transitions this memory
        // exists to survive, and the 0 they leave behind would *delete* the reader's
        // position instead of saving it, so it is not recorded.
        const top = container.scrollTop || 0;
        const scrollable = (container.scrollHeight || 0) > (container.clientHeight || 0);
        if (top === 0 && !scrollable) return;
        memory.top = top;
        memory.seen = true;
      },
      { passive: true },
    );
    return container;
  }

  /** The offset this container was last scrolled to, or `null` if it never was. */
  function scrollMemory(container) {
    const memory = container && container[SCROLL_MEMORY];
    return memory && memory.seen ? memory.top : null;
  }

  /**
   * Put a remembered offset back. The engine clamps it to the box it now has. The write is
   * the memory's, not the reader's, so the controller is told the offset it now holds — a
   * repaint must neither release the follow light nor re-engage it, not even when the
   * remembered offset is the bottom.
   */
  function restoreScroll(container, top) {
    if (!container || top == null) return;
    if (container.scrollTop !== top) container.scrollTop = top;
    if (container[FOLLOW]) container[FOLLOW].syncOffset(container.scrollTop || top);
  }

  // ---- The two rows of the log: a thinking line and a tool line ----------------
  // A turn reads as one essay, so the log holds *rows*, not nested blocks:
  //
  //  - a **thinking row** (`.msg.thinking-row`, `data-kind="thinking"`): the tag
  //    `Thinking` and the text of the thinking. While its turn is live it is open — the
  //    tag on its own line, the whole text under it, upright and dimmed. When the turn
  //    ends it collapses to one ellipsised line (the tag, then the start of the text),
  //    and a click toggles it: the open form is the whole text plus the turn's usage
  //    line. There is no chevron, so the row is the control.
  //  - a **tool row** (`.msg.tool`, one line): a status dot, the bold localized
  //    verb, the label (`DisplayItem.title`, else `toolBrief()`) and the elapsed
  //    chip. It is folded at rest whatever it is doing (the row already says what
  //    the step is), and a click expands it in place: the `> command` line, the
  //    result, an error, the usage line. A second click folds it again.
  //
  // Two marks per row carry the state, and both live on the element (the DOM is
  // rebuilt by a repaint, which re-derives the same state from the items):
  //   `_open`        — the row is open right now;
  //   `_userTouched` — a click (or a follow light the reader released: `readerHoldsRow`)
  //                    handed the row to the user: the live rule below leaves it
  //                    exactly where they put it.
  // The live rows are tracked on the container (`messagesEl`), which `routeTo`
  // swaps per node, so two nodes streaming at once never see each other's rows.

  /** Is this row open? One reading, for every caller and for the guard. */
  function isRowOpen(row) {
    return !!(row && row._open);
  }

  /**
   * Open or close a thinking row. `open` is the paragraph plus the usage line; the
   * closed form is one line of the same text, ellipsised in CSS.
   *
   * The open form is a 240 px scroller of its own, so it also carries its own follow
   * light — the dot is in the row only while the row is open (a closed row is one line
   * with nothing to follow), and opening it engages that light and scrolls to the end of
   * the reasoning. The light is not touched on later deltas: `setActiveRow` calls this on
   * every delta of a live row, and re-engaging there would take back a reader who scrolled
   * up inside the box. Only a real open → close → open transition engages it again.
   */
  function setThinkingOpen(row, open) {
    if (!row) return;
    const wasOpen = !!row._open;
    row._open = !!open;
    row.classList.toggle('open', row._open);
    if (!row._scroll || !row._lockDot) return;
    if (row._open && !wasOpen) {
      // The light belongs to the open form: it goes into the row as the box opens, and
      // opening puts the reader back at the end of the reasoning, following it.
      row.appendChild(row._lockDot);
      // …and this is the one moment the box has a gutter to measure: the dot's offset is the
      // scrollbar's own strip, not a fixed number (`lockDotRight`).
      if (row._scroll.syncDot) row._scroll.syncDot();
      row._scroll.lock();
    } else if (!row._open && row._lockDot.parentElement === row) {
      // A closed row is one ellipsised line: no scroller, no light.
      row.removeChild(row._lockDot);
    }
  }

  /**
   * Open or close a tool row's detail. The detail is `hidden` (not removed), so a
   * folded row still holds its result — one click away, and a repaint that opens it
   * has nothing to fetch.
   */
  function setToolOpen(row, open) {
    if (!row) return;
    row._open = !!open;
    row.classList.toggle('open', row._open);
    const detail = byClass(row, 'tool-detail');
    if (detail) {
      detail.classList.toggle('hidden', !row._open);
      // A virtualised viewer paints from its own measured height, which only exists
      // once the detail is on screen — so opening is where it gets asked again.
      if (row._open && detail._paint) detail._paint();
      // A path is fitted to a width, and a folded detail has none: opening is the moment
      // its paths get one (`refitPathsIn` forgets the widths the last pass recorded).
      if (row._open) refitPathsIn(detail);
    }
  }

  /** A click on either row hands it to the user: the live rule below stops here. */
  function markRowTouched(row) {
    if (row) row._userTouched = true;
  }

  /**
   * Is the reader reading this row? A click is not the only hand-over: releasing the
   * row's own follow light — scrolling its box up, or clicking its dot — says the reader
   * is inside that reasoning and has taken the box from the stream. The turn ending then
   * must not fold it under them, so the same evidence that keeps a live delta from
   * pinning the box also keeps `clearActiveRow` from closing the row.
   *
   * Only the **row's own** light counts: the card log's dot is the whole turn's follow
   * state, so a reader who scrolled the turn up has not thereby opened its reasoning.
   */
  function readerHoldsRow(row) {
    if (!row) return false;
    if (row._userTouched) return true;
    return !!(row._scroll && row._scroll.locked === false);
  }

  /**
   * This row is live: a thinking row opens (that is what the active turn is doing),
   * a tool row is left folded. A row the user clicked is theirs and never moves.
   */
  function setActiveRow(row) {
    if (!row) return;
    row._active = true;
    // The class is the one thing the stylesheet can see: a live row's verb carries the
    // wave and its highlight (`makeThinkingRow` builds the tag out of one span per
    // character, the same way a tool row's verb is built).
    if (row.classList) row.classList.add('live');
    if (messagesEl) {
      const list = messagesEl._activeRows || (messagesEl._activeRows = []);
      if (list.indexOf(row) < 0) list.push(row);
    }
    if (row._userTouched) return;
    if (row.classList.contains('thinking-row')) setThinkingOpen(row, true);
  }

  /** This row is not live any more: give it back the resting state of its kind. */
  function clearActiveRow(row) {
    if (!row) return;
    row._active = false;
    if (row.classList) row.classList.remove('live');
    const list = messagesEl ? messagesEl._activeRows : null;
    if (list) {
      const at = list.indexOf(row);
      if (at >= 0) list.splice(at, 1);
    }
    if (row._userTouched) return;
    // A finished thinking row is one line; a tool row folds back to its one line. The
    // exception is a reasoning row the reader unlocked by scrolling its own box: they are
    // reading it, so the turn ending leaves it open — and it is marked as theirs, or a
    // later pass (`settleRowsFinished`, a repaint) would fold it after all.
    if (row.classList.contains('thinking-row')) {
      // A row that **is** the turn's output (`_noAnswer`) is not a step to fold away: the
      // banner above it promises the text below it, so the turn ending leaves it open.
      if (row._noAnswer) return;
      if (readerHoldsRow(row)) {
        row._userTouched = true;
        return;
      }
      setThinkingOpen(row, false);
    } else {
      setToolOpen(row, false);
    }
  }

  /**
   * The card a log container belongs to, or `null` (a row appended into nothing).
   */
  function cardOfLog(container) {
    let node = container;
    while (node) {
      if (node.classList && node.classList.contains('node')) return node;
      node = node.parentElement || null;
    }
    return null;
  }

  /**
   * The card whose log `messagesEl` currently is.
   */
  function logCard() {
    return cardOfLog(messagesEl);
  }

  /** The open steps group of the card a log container belongs to, if it has one. */
  function openGroupOf(container) {
    const card = cardOfLog(container);
    return (card && card._openGroup) || null;
  }

  /** Is `node` inside `root`'s subtree? (A parent walk, not `contains`.) */
  function inSubtree(root, node) {
    let cur = node;
    while (cur) {
      if (cur === root) return true;
      cur = cur.parentElement || null;
    }
    return false;
  }

  /**
   * The group rows are being appended to right now, or `null` when the flow itself
   * (`.node-work`) is the target. It is the live half of the card's own state
   * (`card._openGroup`): every row builder asks `logTail()` at append time, so
   * whatever rebinds `messagesEl` (a routed append, the view focus) rebinds this with
   * it, and the two paths that render a card from nothing reset it.
   */
  let openSteps = null;

  /** Is a group's **body** being built right now (`paintStepsBody`)? Its rows then
   * belong to that body, and no new group may open around them. */
  let paintingStepsBody = false;

  /** Where the next row of the flow belongs: the open group's body, or the log itself. */
  function logTail() {
    return openSteps ? openSteps._body : messagesEl;
  }

  /**
   * The header's count: one step is a call, and the header says so in one line. A
   * folded group has no rows to count — its items are still `_lazy` — so it carries
   * its own number until the click that builds the body (`paintStepsBody`).
   */
  function updateStepsHead(group) {
    if (!group) return;
    let n = 0;
    if (group._lazy) {
      n = group._count || 0;
    } else {
      for (const child of group._body.children || []) {
        // A thought is a step of the turn, so it counts exactly like a tool call does.
        if (child.dataset && (child.dataset.kind === 'tool' || child.dataset.kind === 'thinking')) n++;
      }
    }
    const label = group._head && group._head.querySelector('.steps-label');
    // A thought **is** a step of the turn: the header counts the rows that carry the turn's
    // process, which is its tool calls and its reasoning. A turn that only thought before it
    // answered still has one step, and that step is the thought.
    if (label) label.textContent = n === 1 ? tr('Ran 1 step') : tr('Ran {0} steps', n);
  }

  /**
   * Paint the body of a folded group the first time it is opened. A finished card's
   * steps are not read while they are tucked away, so a cold card builds each group's
   * header, the flow around it and the answer; a group's own rows are built here,
   * once, on the click that asks for them (`group._lazy`).
   */
  function paintStepsBody(group) {
    if (!group || !group._lazy) return;
    const items = group._lazy;
    group._lazy = null;
    const prevMsg = messagesEl;
    const prevOpen = openSteps;
    const prevPainting = paintingStepsBody;
    messagesEl = group._body;
    openSteps = null;
    paintingStepsBody = true;
    try {
      for (const item of items) renderItemInto(item);
    } finally {
      paintingStepsBody = prevPainting;
      openSteps = prevOpen;
      messagesEl = prevMsg;
    }
    updateStepsHead(group);
  }

  /** Fold one steps group to its header, or open it. Each group has its own state. */
  function setStepsFold(group, folded) {
    if (!group) return;
    group._folded = !!folded;
    group.classList.toggle('steps-folded', group._folded);
    const chev = group._head && group._head.querySelector('.chev');
    if (chev) chev.classList.toggle('open', !group._folded);
  }

  /**
   * One **new** group: `.steps` with `data-kind="steps"`, its own `Ran N steps` header,
   * its own `.steps-body` and its own fold state. It is born at the first tool row of a
   * run and it is open while that run's turn is live; the header click folds it, and a
   * click always wins for that one group (`_userTouched`).
   */
  function newStepsGroup() {
    const group = el('div', 'steps');
    group.dataset.kind = 'steps';
    const head = el('div', 'steps-head');
    head.appendChild(el('span', 'chev open', '▶'));
    head.appendChild(el('span', 'steps-label'));
    const body = el('div', 'steps-body');
    group.appendChild(head);
    group.appendChild(body);
    group._head = head;
    group._body = body;
    head.addEventListener('click', () => {
      group._userTouched = true;
      if (group._folded) paintStepsBody(group);
      setStepsFold(group, !group._folded);
    });
    messagesEl.appendChild(group);
    const card = logCard();
    if (card) {
      (card._groups || (card._groups = [])).push(group);
      card._openGroup = group;
    }
    updateStepsHead(group);
    setStepsFold(group, false);
    return group;
  }

  /**
   * A tool row opens a group when none is open, and extends the one that is: one group
   * per **contiguous run** of tool rows. A text row ends the run (`closeStepsGroup`), so
   * the next tool row opens a second group instead of reaching back into the first.
   */
  function ensureStepsGroup() {
    if (paintingStepsBody || !messagesEl) return null;
    if (openSteps) return openSteps;
    openSteps = newStepsGroup();
    return openSteps;
  }

  /**
   * An assistant **text** row closes the current run: the prose stays in the flow
   * (`.node-work`), never inside a group's body, so the next tool row opens a new group
   * instead of extending this one. Nothing is moved anywhere: a text row is never in a
   * group, so the turn's final answer is simply the flow's last block.
   */
  function closeStepsGroup() {
    if (!openSteps) return;
    const card = logCard();
    if (card && card._openGroup === openSteps) card._openGroup = null;
    openSteps = null;
  }

  /**
   * Does this group's body hold a row the reader is reading (`readerHoldsRow`)? A
   * group folds behind its own header at the end of the turn, but never over a
   * reasoning row the reader unlocked — folding the group would take that row off
   * screen, which is worse than folding the row itself.
   */
  function groupHoldsReaderRow(group) {
    const body = group && group._body;
    for (const row of (body && body.children) || []) {
      if (row && row.dataset && row.dataset.kind === 'thinking' && readerHoldsRow(row)) return true;
    }
    return false;
  }

  /**
   * The turn is over: **every** group of the card tucks itself behind its own header —
   * a group the user opened or closed by hand (`_userTouched`), or one holding a row the
   * reader unlocked, stays exactly where it is — and the others do not move it. No answer
   * leaves a group here, because no answer ever entered one.
   */
  function settleSteps(card) {
    if (!card) return;
    card._openGroup = null;
    if (openSteps && inSubtree(card, openSteps)) openSteps = null;
    for (const group of card._groups || []) {
      if (group._userTouched) continue;
      if (groupHoldsReaderRow(group)) continue;
      setStepsFold(group, true);
    }
  }

  /**
   * The turn is over: every row of the card takes its resting state — a thinking row
   * collapses to its one line, a tool row folds — except a row the reader holds: one they
   * opened by hand (`_userTouched`) or one whose own follow light they released, which
   * stays exactly where it is (`readerHoldsRow`). Read off the card's own DOM rather than a
   * list, so a card restored from a repaint settles like a live one.
   */
  function settleRowsFinished(card) {
    if (!card) return;
    for (const row of card.querySelectorAll('.msg')) {
      const kind = row.dataset ? row.dataset.kind : '';
      if (kind === 'thinking' || kind === 'tool') clearActiveRow(row);
    }
    settleSteps(card);
  }

  /**
   * Close every live row of the current container, or — with `kind` — only the
   * thinking (`'thinking'`) or the tool (`'tool'`) ones: the answer took over, or
   * the turn is over. A row of the other kind stays live, and a reasoning row the
   * reader is reading stays open even here — `clearActiveRow` owns that rule, so the
   * answer taking over cannot fold a box its reader unlocked.
   */
  function closeActiveRows(kind) {
    const list = messagesEl ? messagesEl._activeRows : null;
    if (!list || list.length === 0) return;
    for (const row of list.slice()) {
      const isThinking = row.classList.contains('thinking-row');
      if (kind === 'thinking' && !isThinking) continue;
      if (kind === 'tool' && isThinking) continue;
      clearActiveRow(row);
    }
  }

  // ---- The appear animation -------------------------------------------------
  // **The text is complete in the DOM the moment a delta arrives; only its appearance
  // is animated, one word at a time.** A delta's new words each go into a transient
  // `<span class="word-in">` (a 200 ms fade, CSS), and a span's text is
  // moved into the host's own persistent `Text` node when **its own** animation ends —
  // so the streaming surface is still one `Text` node that settles text by
  // `appendData`, and nothing on this path reads layout.
  //
  // **A queue, and merges go in order.** A delta that arrives while earlier words are
  // still rising opens its spans after them, and only the oldest settled word may be
  // merged: the `Text` node holds the settled *prefix* of the host's text, so a merge
  // out of order would put text in the wrong place. `_settled` counts the characters
  // already in that node and `_wordChars` counts the ones still in spans, which is what
  // makes the delta slice exact mid-animation.
  //
  // **A word split across deltas stays one span.** The stream ends mid-word often, so
  // when the next delta continues the same Latin word its last token is extended in
  // place instead of a second fragment opening right after it. A CJK character is
  // always its own token (a Chinese sentence has no spaces, and one token per sentence
  // would animate as one block).
  //
  // **The stagger is capped, and so is the queue.** Words of one delta fade in order on
  // 6 ms steps up to 36 ms (`.d1`…`.d6` in `media/style.css`), so a long burst never
  // queues a visible backlog; past `MAX_PENDING_WORDS` the oldest word is merged at
  // once, which shows its text immediately instead of making the reveal fall behind.
  /** An engine that never fires `animationend` (the offline guard's stub) still settles. */
  const ANIMATION_FALLBACK_MS = 400;

  /** The most words one host may hold unsettled before the oldest are merged at once. */
  const MAX_PENDING_WORDS = 24;

  /** The stagger's last step: `.d1`…`.d6` are 25 ms each (150 ms at the cap). */
  const MAX_STAGGER_STEP = 6;

  // The hosts with words in flight, so `reset` / a `tree` repaint can settle them
  // without walking the DOM (on a 40-card session that walk would be the cost).
  const pendingChunks = new Set();

  /**
   * Is the appear animation on? **One switch: the setting** (`spinney.streamAnimation`,
   * sent in the `config` message). The browser's `prefers-reduced-motion` wish is
   * deliberately not consulted: the OS toggle behind it also drives every other
   * animation on the machine, so a reader who keeps the system's animation effects off
   * and still wants this one would have no way to say so. This setting is explicit and
   * per window, and it is the whole decision — `media/style.css` carries no
   * reduced-motion block for the same reason.
   */
  function animationsOn() {
    return streamAnimation;
  }

  /** A token's span leaves the document (its text has been merged back, or is moot). */
  function removeWordSpan(span) {
    if (!span) return;
    if (typeof span.remove === 'function') span.remove();
    else if (span.parentElement) span.parentElement.removeChild(span);
  }

  // One delta's tokens: a run of Latin text, or one CJK character, or one whitespace run.
  const WORD_TOKEN_RE =
    /[\s\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]|[^\s\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g;

  /**
   * The tokens of `text`, in document order. Whitespace never travels on its own: it is
   * glued to the token before it, because only a token's own text may be appended to the
   * settled prefix, and the queue's order has to be the document's order.
   */
  function wordTokens(text) {
    const parts = String(text).match(WORD_TOKEN_RE) || [];
    const out = [];
    for (const part of parts) {
      if (/^\s+$/.test(part) && out.length > 0) out[out.length - 1] += part;
      else out.push(part);
    }
    return out;
  }

  /** Is `ch` part of a Latin word (so a word the stream split across deltas can resume)? */
  function isWordChar(ch) {
    return !!ch && !/\s/.test(ch) && !/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(ch);
  }

  /** The word queue of a host, created on first use. */
  function wordQueue(host) {
    if (!host._words) host._words = [];
    return host._words;
  }

  /**
   * Forget a host's pending words **without** merging them: their characters are already
   * in the host's own source text (`node._text` / the thinking row's own text), so
   * whatever renders next takes them from there.
   */
  function dropChunk(host) {
    if (!host) return;
    const queue = host._words;
    host._words = [];
    host._wordChars = 0;
    host._wordTn = null;
    pendingChunks.delete(host);
    if (!queue) return;
    for (const entry of queue) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      removeWordSpan(entry.span);
    }
  }

  /**
   * Move one word's text into the host's `Text` node and drop its span. **Idempotent**
   * (`merged` is set before anything else), and safe when the span was already removed by
   * a repaint or a finalize: what is merged is the entry's *text*, into the host's
   * current node.
   */
  function mergeWord(host, entry) {
    if (!entry || entry.merged) return;
    entry.merged = true;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    const tn = host._wordTn;
    if (tn && entry.text) {
      tn.appendData(entry.text);
      if (typeof host._settled === 'number') host._settled += entry.text.length;
    }
    host._wordChars = Math.max(0, (host._wordChars || 0) - entry.text.length);
    removeWordSpan(entry.span);
  }

  /**
   * Merge from the head of the queue while the head has finished rising. Never out of
   * order: the `Text` node holds the settled prefix of the host's text, so a later word
   * may merge only after every earlier one has.
   */
  function drainWords(host) {
    const queue = host._words;
    if (!queue) return;
    while (queue.length > 0 && queue[0].ended) mergeWord(host, queue.shift());
    if (queue.length === 0) pendingChunks.delete(host);
  }

  /**
   * Merge **every** pending word, in order, whether its rise ended or not — the one way a
   * stream ends. A `reset`, a `tree` repaint, a finalize and the setting turned off all
   * need the text back in the `Text` node before the DOM it lives in goes away.
   */
  function mergeChunk(host) {
    if (!host) return;
    const queue = host._words || [];
    host._words = [];
    for (const entry of queue) mergeWord(host, entry);
    host._wordChars = 0;
    host._wordTn = null;
    pendingChunks.delete(host);
  }

  /**
   * Open the spans of one delta on `host`, whose settled text lives in `tn`. A token
   * carries its own whitespace, so appending the tokens in order builds the delta
   * exactly, and the token's index within the delta is its stagger step.
   */
  function enqueueWords(host, tn, text) {
    if (!host || !text) return;
    const queue = wordQueue(host);
    host._wordTn = tn;
    let rest = String(text);
    // The previous delta may have ended mid-word: extend that token in place, so a word
    // is never typed in fragments. A token that was already merged cannot be extended
    // (its text is settled), so the continuation opens its own token then.
    const last = queue.length > 0 ? queue[queue.length - 1] : null;
    if (last && !last.merged && isWordChar(rest[0]) && isWordChar(last.text[last.text.length - 1])) {
      const head = rest.match(/^[^\s]+/);
      if (head) {
        last.text += head[0];
        host._wordChars = (host._wordChars || 0) + head[0].length;
        if (last.span) last.span.textContent = last.text;
        rest = rest.slice(head[0].length);
        if (!rest) return;
      }
    }
    wordTokens(rest).forEach((token, index) => {
      const step = Math.min(index, MAX_STAGGER_STEP);
      const span = el('span', 'word-in' + (step > 0 ? ' d' + step : ''), token);
      const entry = { span, text: token, ended: false, merged: false, timer: null };
      queue.push(entry);
      host._wordChars = (host._wordChars || 0) + token.length;
      pendingChunks.add(host);
      // The fade is CSS; the merge back is this one event, with a timer behind it for an
      // engine that never fires it — the merge must never depend on being told.
      span.addEventListener('animationend', () => {
        entry.ended = true;
        drainWords(host);
      });
      entry.timer = setTimeout(() => {
        entry.ended = true;
        drainWords(host);
      }, ANIMATION_FALLBACK_MS);
      host.appendChild(span);
    });
    // A burst never queues an unbounded backlog: past the cap the oldest word is shown at
    // once, which is the one place the reveal deliberately gives up its order.
    while (queue.length > MAX_PENDING_WORDS) mergeWord(host, queue.shift());
  }

  /**
   * Settle everything in flight. A `reset` or a `tree` repaint is about to replace the
   * cards those words live in, so their text goes back into their `Text` node first.
   */
  function flushChunks() {
    for (const host of Array.from(pendingChunks)) mergeChunk(host);
  }

  /**
   * A row that has just been appended arrives on one 120 ms fade (`.row-in`).
   * The class is removed on `animationend` — or by the fallback timer — so no row keeps
   * a running animation (or a compositing layer) alive after it has arrived.
   */
  function animateRow(row) {
    if (!row || !row.classList || !animationsOn()) return;
    row.classList.add('row-in');
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      row.classList.remove('row-in');
    };
    row.addEventListener('animationend', (event) => {
      // A nested fade (the `.word-in` span inside an answer) bubbles up here: only the
      // row's own animation ends the row's.
      if (event && event.target && event.target !== row) return;
      settle();
    });
    setTimeout(settle, ANIMATION_FALLBACK_MS);
  }

  // ---- Message rendering into a container (defaults to the active node) ----
  // Zone 1 of a card: the pinned user ask (`.node-ask`, top of an expanded card).
  // It does not scroll with the work log and does not trigger tree panning, and it
  // is Markdown now — a fenced snippet or a list in the ask reads like it does in
  // the answer.
  function addUserPrompt(text, attachments) {
    if (!promptEl) return;
    promptEl.innerHTML = '';
    // The card's own prompt is remembered here (`_askText` / `_askAtts`), together
    // with the ask it just rendered: the ask body is *Markdown*, so it is not the text
    // an editor can be pre-filled with, and a cancel has to put the same ask back
    // (`beginAskEdit` / `renderAsk`). The ask element survives a repaint (only its
    // children are replaced), but the card is where the two live, so any card-level
    // pass can read them back.
    const card = askCardOf(promptEl);
    if (card) {
      card._askText = typeof text === 'string' ? text : '';
      card._askAtts = attachments || [];
    }
    // A render of the ask is the end of any edit that was open on it, whatever the
    // reason for the render: a repaint must never leave a stale textarea behind.
    promptEl._askEditing = false;
    const node = el('div', 'msg user prompt');
    node.dataset.kind = 'user';
    if (attachments && attachments.length) {
      const imgWrap = document.createElement('div');
      imgWrap.className = 'msg-imgs';
      for (const att of attachments) {
        const img = document.createElement('img');
        img.className = 'msg-img';
        img.src = att.dataUrl;
        img.title = att.name || tr('image');
        imgWrap.appendChild(img);
      }
      node.appendChild(imgWrap);
    }
    if (text) {
      // Zone 1 is Markdown now: the ask is rendered exactly like an answer body
      // (fenced code, lists, links). It is a `div.answer` so the two share one
      // style — the pinned prompt is not a lesser kind of text than the reply.
      const body = el('div', 'answer');
      body.innerHTML = renderMarkdown(text);
      node.appendChild(body);
    }
    promptEl.appendChild(node);
    // The pencil lives in the bubble just built, so it is put back here — a render that
    // wiped the ask's children took the chip with them.
    syncAskEdit(card);
    return node;
  }

  // ---- Editing a card's own prompt (the pencil on the pinned ask) --------------
  // A turn's prompt is the user's own text, and re-reading a card often reveals a typo
  // or a missing detail. The pencil on the ask (`syncAskEdit`) swaps the rendered ask
  // for a plain editor; pressing Enter asks the host to start a **new turn** from the
  // edited node's parent with the edited text (`editUserMessage`), which is what makes
  // the old wording stay in the tree as an ordinary sibling branch. The composer is
  // not involved anywhere here: this edits *this card's* prompt, it does not compose a
  // new message, so the composer's text and attachments stay untouched.

  /**
   * The card an ask belongs to: `.node-ask` is created directly inside the card
   * (`createNodeCard`) and is a child of it for the card's whole life, so the parent
   * is the card — and `_nodeId` is what says so, rather than trusting any element.
   */
  function askCardOf(ask) {
    const card = ask && ask.parentElement;
    return card && card._nodeId ? card : null;
  }

  /**
   * One button, two modes — and it is never in two places at once. On a rendered ask it is
   * the `✎` that opens the editor, at the bubble's top-right corner; inside the open editor
   * it is the `✕` that cancels it, at the same corner of the box. Every path that moves it
   * (a repaint putting it back into the bubble, `beginAskEdit` taking it into the box) goes
   * through here, so a cancelled edit can never leave a `✕` on a card that is no longer
   * being edited.
   */
  function setAskEditMode(btn, editing) {
    if (!btn) return;
    btn.textContent = editing ? '✕' : '✎';
    btn.dataset.role = editing ? 'ask-edit-cancel' : 'ask-edit';
    btn.title = editing
      ? tr('Cancel the edit — Escape puts the question back')
      : tr('Edit this prompt — the answer starts a new branch from the same point');
  }

  /**
   * The pencil on a card's pinned ask, created lazily and kept on the card
   * (`_askEditBtn`) so a repaint puts the **same** element back instead of stacking a
   * second one. It is offered wherever editing can go through: a non-sidecar card that has
   * a prompt. **A running turn is not in the way** — the edit branches from the edited
   * node's own parent and leaves the streaming node untouched (`editUserMessage` in
   * `ChatViewProvider`), so a reader fixing a typo never has to wait a turn out. The ask's
   * own `hidden` class is what keeps it out of sight on a collapsed card or a monitor
   * window; there is nothing to edit without a prompt.
   *
   * It lives **inside the ask's bubble** (`div.msg.user.prompt`), not on the ask strip:
   * the chip floats over the bubble's top-right corner (CSS `.node-ask-edit`), so the
   * message keeps the strip's full width — the ask reserves no gutter for it — and the
   * bubble's own hover is what reveals it. A repaint of the ask wipes the bubble's
   * children, which is why this puts the same chip back every time it runs.
   */
  function syncAskEdit(card) {
    if (!card || !card.querySelector) return;
    const id = card._nodeId;
    const meta = id ? treeNodes[id] : null;
    const ask = card.querySelector('.node-ask');
    if (!ask) return;
    const want = !!id && !!card._askText && !isSidecarKind(meta && meta.kind);
    const btn = card._askEditBtn;
    if (!want) {
      if (btn) {
        btn.remove();
        card._askEditBtn = null;
      }
      return;
    }
    // The bubble is the chip's home. `byClass` rather than a compound `querySelector`:
    // a miss has to be observably a miss (the offline checker's stub DOM answers any
    // selector with a shared stub).
    const bubble = byClass(ask, 'prompt');
    if (!bubble) return;
    // While the editor is open the ask's body **is** the editor and the button lives in
    // it as the `✕` cancel (`beginAskEdit`): there is no bubble to put a second one back
    // into, and no second way to cancel the same edit.
    if (ask._askEditing) return;
    if (btn) {
      setAskEditMode(btn, false);
      bubble.appendChild(btn);
      return;
    }
    const button = el('button', 'node-ask-edit');
    button.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // One button, two meanings. Cancelling takes the same path Esc takes, so the two
      // ways out of an edit can never diverge.
      const open = card.querySelector('.node-ask');
      if (open && open._askEditing) renderAsk(card);
      else beginAskEdit(card);
    });
    card._askEditBtn = button;
    setAskEditMode(button, false);
    bubble.appendChild(button);
  }

  /**
   * Swap the rendered ask for an editor: a textarea pre-filled with the node's **full**
   * prompt text — the stored text, never the Markdown the ask body shows, because the
   * editor must not render Markdown — plus one hint line. Esc restores the rendered ask,
   * and so does the `✕` the pencil becomes in this state;
   * Enter asks the host to branch with the edited text and leaves the editor open until
   * the host answers (a repaint closes it, a refusal does not eat the typing);
   * Shift+Enter is the textarea's own newline.
   */
  function beginAskEdit(card) {
    const id = card && card._nodeId;
    const ask = card && card.querySelector ? card.querySelector('.node-ask') : null;
    if (!id || !ask || ask._askEditing) return;
    ask._askEditing = true;
    ask.innerHTML = '';
    const box = el('div', 'ask-edit');
    const input = el('textarea', 'ask-edit-input');
    input.value = typeof card._askText === 'string' ? card._askText : '';
    const hint = el('div', 'ask-edit-hint', tr('Enter sends, Shift+Enter adds a newline, Esc or ✕ cancels'));
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        renderAsk(card);
        return;
      }
      // Shift+Enter is left to the textarea: it inserts a newline and posts nothing.
      if (ev.key !== 'Enter' || ev.shiftKey) return;
      ev.preventDefault();
      const edited = String(input.value || '').trim();
      // An empty edit is nothing to send; the host refuses it too.
      if (!edited) return;
      vscode.postMessage({ type: 'editUserMessage', nodeId: id, text: edited });
    });
    box.appendChild(input);
    box.appendChild(hint);
    // The pencil becomes the cancel: the same element, moved into the editor's own corner
    // because the wipe above took it off the bubble. CSS keeps it visible there — the
    // bubble's hover rule can never reach a bubble that does not exist, and an `opacity:
    // 0` button would be a cancel nobody can click.
    if (card._askEditBtn) {
      setAskEditMode(card._askEditBtn, true);
      box.appendChild(card._askEditBtn);
    }
    ask.appendChild(box);
    // The caret goes where the user is about to type. A card that is not on screen
    // (a hidden ask) cannot take it, and that is fine — the editor is still open.
    if (typeof input.focus === 'function') input.focus();
  }

  /**
   * Put the rendered ask back: the way out of the editor, for Esc, for the `✕` and for a
   * repaint.
   * It renders from the card's stored prompt, so what comes back is exactly what was
   * there before the edit — Markdown, image attachments and the pencil included.
   */
  function renderAsk(card) {
    const ask = card && card.querySelector ? card.querySelector('.node-ask') : null;
    if (!ask) return;
    // A focused editor is going away with the ask's body: hand the caret back first, so
    // nothing keeps the focus on an element that no longer exists.
    const open = byClass(ask, 'ask-edit-input');
    if (open && typeof open.blur === 'function') open.blur();
    const prevPrompt = promptEl;
    promptEl = ask;
    try {
      addUserPrompt(card._askText, card._askAtts);
    } finally {
      promptEl = prevPrompt;
    }
  }

  /**
   * A repaint never leaves a stale editor behind: a card that is (re)described with its
   * ask already rendered does not go through `addUserPrompt`, so the open editor — a
   * textarea nobody asked to keep — is closed here first. Cheap when nothing was open.
   */
  function cancelAskEdit(card) {
    const ask = card && card.querySelector ? card.querySelector('.node-ask') : null;
    if (!ask || !ask._askEditing) return false;
    renderAsk(card);
    return true;
  }

  function addNotice(kind, text) {
    if (!messagesEl) return;
    const node = el('div', 'notice ' + (kind || 'info'), text);
    node.dataset.kind = 'notice';
    logTail().appendChild(node);
    animateRow(node);
    followActive();
    return node;
  }

  /**
   * The updating form of `addNotice`: a node-scoped notice the host keeps sending as
   * its state advances (the silent-retry marker). A `noticeId` names the block, so a
   * later message carrying the same id rewrites that element's text instead of
   * appending a second one — one marker per run, however many attempts it takes.
   * Without an id it is a plain `addNotice`.
   */
  function upsertNotice(kind, text, noticeId) {
    if (noticeId) {
      const kids = messagesEl ? messagesEl.children : [];
      for (let i = kids.length - 1; i >= 0; i--) {
        const node = kids[i];
        if (node.dataset && node.dataset.noticeId === noticeId) {
          node.textContent = text;
          followActive();
          return node;
        }
      }
    }
    const node = addNotice(kind, text);
    if (node && noticeId) node.dataset.noticeId = noticeId;
    return node;
  }

  // ---- A HARNESS block is one row ----------------------------------------------
  // The harness's own message to the model, and the two a compression writes are tens of
  // thousands of characters of it. It reads as a **step**, not as a panel: one line with a
  // label and the start of the text in italic, and a click opens the whole message in a
  // small scroller (`.harness-body`, `docs/agents/invariants/compress-node.md` §6).
  //
  // The label comes from the harness text's own title line. Those titles are constants the
  // host writes and `detectPriorHandoffSummary` already depends on, so matching their
  // prefix is the same contract, not a guess; the label itself is localized.
  // Each entry asks `tr()` for its label, at load, so the shipped catalogues carry all of
  // them (a table of plain strings would be invisible to `npm run check:l10n`).
  const HARNESS_LABELS = [
    ['[Harness: compression turn]', tr('Compression instruction')],
    ['[Harness: context window reset — handoff summary]', tr('Handoff summary')],
    ['[Harness: context window reset', tr('Context handoff')],
    ['[Harness]', tr('Harness note')],
  ];

  /** The row's label and the title line it replaces, for one harness text. */
  function harnessLabelOf(text) {
    const value = String(text || '');
    for (const [prefix, label] of HARNESS_LABELS) {
      if (value.startsWith(prefix)) return { label, title: prefix };
    }
    return { label: tr('Harness note'), title: '' };
  }

  /**
   * The line that stands for the block while it is closed: the first text the block actually
   * carries, with its title line removed (the label already says it), blank lines skipped and
   * the markdown markers taken off — `## Objective` reads as `Objective` on the row, and the
   * formatted heading is one click away.
   */
  function harnessPreviewOf(text, title) {
    const rest = title ? String(text || '').slice(title.length) : String(text || '');
    for (const line of rest.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) {
        return trimmed
          .replace(/^#{1,6}\s+/, '')
          .replace(/^[-*+]\s+/, '')
          .replace(/^\d+\.\s+/, '')
          .replace(/^>\s+/, '')
          .replace(/`([^`]*)`/g, '$1')
          .replace(/\*\*([^*]+)\*\*/g, '$1')
          .trim();
      }
    }
    return '';
  }

  /**
   * A message the *harness* wrote inside this node's own transcript — the ▶ Continue turn,
   * which resumes the node in place instead of growing a new card
   * (`SessionRuntime.continueFrom`), and the two blocks of a compression
   * (`docs/agents/invariants/compress-node.md`). It is a row, not a user bubble (the user
   * did not type it) and not the pinned prompt (that still holds what the user asked for).
   *
   * The body is **markdown** and it is rendered on the first open, never at creation: the two
   * compression blocks are tens of thousands of characters, and a repaint must not pay for
   * rendering text nobody has asked to read.
   */
  function addHarnessNote(text) {
    if (!messagesEl) return;
    const node = el('div', 'msg harness-note');
    node.dataset.kind = 'harness';
    const { label, title } = harnessLabelOf(text);
    const head = el('div', 'harness-head');
    const chev = el('span', 'chev', '▶');
    head.appendChild(chev);
    head.appendChild(el('span', 'harness-badge', label));
    head.appendChild(el('span', 'harness-preview', harnessPreviewOf(text, title)));
    const body = el('div', 'harness-body');
    // The box shows the message **without its own title line**: the row's label is that line,
    // translated. The stored bytes keep it — `detectPriorHandoffSummary`
    // (`src/agent/compaction.ts`) reads that first line to know a window already starts from a
    // handoff — so this is a display rule, never a rewrite of what the model received.
    const bodyText = title ? String(text).slice(title.length).replace(/^\s+/, '') : String(text);
    let filled = false;
    const fillBody = () => {
      if (filled) return;
      filled = true;
      const rendered = el('div', 'answer harness-text');
      rendered.innerHTML = renderMarkdown(bodyText);
      body.appendChild(rendered);
    };
    node.appendChild(head);
    node.appendChild(body);
    node.title = tr('Click to read the whole message the harness wrote');
    const setOpen = (open) => {
      if (open) fillBody();
      node.classList.toggle('open', open);
      chev.classList.toggle('open', open);
    };
    head.addEventListener('click', () => {
      markRowTouched(node);
      setOpen(!node.classList.contains('open'));
    });
    logTail().appendChild(node);
    followActive();
    return node;
  }

  /**
   * One thinking row: the turn's thinking, as a single element in the flow.
   *
   * It is shaped like a tool row — a bold italic verb in the reader's language, the text
   * after it — because the thinking is the agent's process, not its answer, and the two
   * rows are read the same way. `thinking` is the text the item already holds (a repaint)
   * or `''` (the live path, which appends into `_textEl` as the deltas arrive). There is
   * no chevron: the whole row is the control.
   *
   * The tag is a `<b>` and the text a `<div>` on purpose: closed, the row is a flex line
   * (the tag, then the ellipsised start of the text); open, the row becomes a block and
   * the text's own block element puts the whole thinking on the line under the tag.
   */
  function makeThinkingRow(thinking) {
    const row = el('div', 'msg thinking-row');
    row.dataset.kind = 'thinking';
    // The tag is built like a step's verb, one span per character: a live row's tag is
    // where the wave and its highlight are (`body.anim .msg.thinking-row.live`).
    const tag = el('b', 'thinking-verb');
    setVerbText(tag, tr('Thinking'));
    row.appendChild(tag);
    const text = el('div', 'thinking-text');
    if (thinking) text.textContent = thinking;
    row.appendChild(text);
    // The turn's usage is not the row's tail any more: it is the card's docked bar
    // (`setCardUsage`), which is one place per card instead of one per open fold. The row
    // keeps only its reasoning text, so its open form is exactly the thoughts.
    row._textEl = text;
    row._open = false;
    // The open form scrolls inside itself, so it follows (and can be released) on its own:
    // `attachRowLock` gives the row its own green dot, which `setThinkingOpen` puts in the
    // row only while the box is open, and a controller on the box itself.
    row._scroll = attachRowLock(row, text);
    row.addEventListener('click', () => {
      markRowTouched(row);
      setThinkingOpen(row, !isRowOpen(row));
    });
    return row;
  }

  /** A thinking row appended to the log's flow — the history path's one entry. */
  function addThinkingRow(text) {
    const row = makeThinkingRow(text);
    logTail().appendChild(row);
    animateRow(row);
    return row;
  }

  /**
   * The live path's row: the log's last element when it already is a thinking row
   * (the deltas of one item arrive together), else a fresh one appended to the flow.
   * A row is never reused across items — `addThinkingRow` is the history path and
   * always adds a new one.
   */
  function ensureThinkingRow() {
    const last = messagesEl ? logTail().lastElementChild : null;
    if (last && last.dataset && last.dataset.kind === 'thinking') return last;
    // Every thought is a step of the turn, so a thought that opens a run opens its fold —
    // a reasoning row is never loose in the flow, not even when the run has no tool call at
    // all (a turn that only thought before it answered still folds that thought away).
    ensureStepsGroup();
    return addThinkingRow('');
  }

  // ---- A turn whose model answered only with its reasoning ----------------------
  // The one exception to "no reasoning row is ever loose in the flow", and the one case a
  // thought is not a step. The model can write its entire reply on the reasoning channel
  // and send no answer text at all; the harness then mirrors that reasoning into the
  // message's `content` so the history stays API-valid (a message with neither content nor
  // tool_calls is refused, and thinking mode demands the reasoning be passed back). The
  // mirror is bookkeeping, not an answer: the card says what actually happened — a banner,
  // then the thinking itself — instead of filing the text as a step the reader has to open
  // to discover, and instead of dressing it as an answer the turn never got.

  /** The banner of that turn, in the flow, right above the thinking it introduces. */
  function addNoAnswerBanner() {
    return addNotice('warning', tr('The model returned no answer text this turn. What follows is its last thinking.'));
  }

  /**
   * The block, built from the item (the repaint path): the banner, then the thinking, in
   * the flow. The row is opened and marked `_noAnswer`, which is what keeps a later pass
   * (`clearActiveRow` / `settleRowsFinished`) from folding away the text the banner
   * promises.
   */
  function addNoAnswerBlock(thinking) {
    closeStepsGroup();
    addNoAnswerBanner();
    const row = addThinkingRow(thinking);
    row._noAnswer = true;
    setThinkingOpen(row, true);
    followActive();
    return row;
  }

  /**
   * The same block on the **live** path, where the text is already on screen: the row its
   * deltas opened is lifted out of the run instead of rebuilt (rebuilding it would throw
   * away the `Text` node the word animation is still merging into), and the banner takes
   * the place above it. A run the row leaves empty is dropped — a `Ran 0 steps` header
   * would be a fold around nothing.
   */
  function liftNoAnswerRow() {
    const group = openSteps;
    const body = group && group._body ? group._body : null;
    let row = null;
    if (body) {
      for (let i = (body.children || []).length - 1; i >= 0; i--) {
        const kid = body.children[i];
        if (kid.dataset && kid.dataset.kind === 'thinking') {
          row = kid;
          break;
        }
      }
    }
    // Nothing to lift (this tab never streamed the turn): the item on the node already
    // carries `noAnswer`, so the next repaint draws the block.
    if (!row) return null;
    if (row.parentElement) row.parentElement.removeChild(row);
    closeStepsGroup();
    addNoAnswerBanner();
    row._noAnswer = true;
    // Not live any more, and — by the `_noAnswer` rule — not folded either.
    clearActiveRow(row);
    messagesEl.appendChild(row);
    setThinkingOpen(row, true);
    if (body) {
      if (!body.children.length) dropStepsGroup(group);
      else updateStepsHead(group);
    }
    followActive();
    return row;
  }

  /** A steps group that owns no row any more: its header would invite a click that paints
   * nothing, and the card's fold bookkeeping has to forget it. */
  function dropStepsGroup(group) {
    const card = logCard();
    if (card && card._groups) {
      const at = card._groups.indexOf(group);
      if (at >= 0) card._groups.splice(at, 1);
    }
    if (card && card._openGroup === group) card._openGroup = null;
    if (group.parentElement) group.parentElement.removeChild(group);
  }

  /**
   * One assistant item. Its reasoning, when it has any, is a **sibling row above the
   * bubble** rather than a box inside it: the essay's lines are the assistant's own
   * text and its reasoning, and only the text is a bubble. An item that is *only* its
   * reasoning (the shape a live thinking delta makes) is therefore just its row — an
   * empty rounded box under every reasoning paragraph is what this avoids.
   */
  function addAssistant(text, error, thinking) {
    if (!messagesEl) return;
    // The reasoning of this item is placed **first**, before the run above it is closed:
    // it belongs where the reasoning of that run went — inside the open group's body
    // when there is one, which is exactly where the live turn put it (`appendThinking`),
    // and in the flow only when no run is open. Closing the run first would lift the row
    // out of the group on a repaint while the live turn had left it in the body, so one
    // card read two different ways depending on whether it had been repainted.
    const onlyRow = !String(text || '').length && !error && !!thinking;
    const row = thinking ? addThinkingRow(thinking) : null;
    if (onlyRow && row) {
      followActive();
      return row;
    }
    // The text itself always lives in the flow: it closes the run of steps above it.
    closeStepsGroup();
    const node = el('div', 'msg assistant' + (error ? ' error' : ''));
    node.dataset.kind = 'assistant';
    const answer = el('div', 'answer');
    node.appendChild(answer);
    node._text = text || '';
    node._answerEl = answer;
    node._streaming = false;
    // The row this answer's reasoning lives in. The turn's usage is not tied to either of
    // them any more: it is the card's docked bar (`setCardUsage`).
    node._thinkingRow = row;
    renderAnswer(node, true);
    messagesEl.appendChild(node);
    animateRow(node);
    followActive();
    return node;
  }

  function appendAssistant(text) {
    if (!messagesEl) return;
    // The answer's text takes the message over, so its thinking row is no longer the
    // live one: it collapses to its one line (see `closeActiveRows`).
    closeActiveRows('thinking');
    // A text row closes the run of steps above it: the prose is appended to the log
    // itself, never into a group's body, and the next tool row opens a new group.
    closeStepsGroup();
    const last = messagesEl.lastElementChild;
    if (last && last.dataset.kind === 'assistant' && !last.classList.contains('error')) {
      last._text = (last._text || '') + (text || '');
      renderAnswer(last, false);
      followActive();
      return last;
    }
    // A row with no bubble under it yet: the bubble that follows belongs to it, and
    // takes its usage line back with it (`_thinkingRow`). The row may already be **inside
    // the run above** (a thought is tucked into the group its first tool call opened), so
    // the lookup looks one fold deeper when the flow's last element is that group.
    const prev = last;
    const node = addAssistant('', false);
    if (node && prev) {
      const above =
        prev.dataset && prev.dataset.kind === 'steps' && prev._body ? prev._body.lastElementChild : prev;
      if (above && above.dataset && above.dataset.kind === 'thinking') node._thinkingRow = above;
    }
    node._text = text || '';
    renderAnswer(node, false);
    return node;
  }

  function ensureStreamText(answer) {
    if (answer._streamText) return answer._streamText;
    // A rebuild starts from the authoritative text (`node._text`), so a chunk still in
    // flight is dropped, never merged into a node that is about to go away.
    dropChunk(answer);
    answer.textContent = '';
    const tn = document.createTextNode('');
    answer.appendChild(tn);
    answer._streamText = tn;
    return tn;
  }

  function renderAnswer(node, finalize) {
    const answer = node._answerEl || node.querySelector('.answer') || node;
    node._answerEl = answer;
    // The answer bubble is only there when the message has text (a reasoning-only
    // item is its row alone), so its visibility follows the text on every write.
    if (answer.classList) answer.classList.toggle('hidden', !String(node._text || '').length && !node.classList.contains('error'));
    if (node.classList.contains('error')) {
      dropChunk(answer);
      answer._streamText = null;
      answer._settled = 0;
      answer.textContent = node._text || '';
      return;
    }
    if (finalize) {
      node._streaming = false;
      // **Merge before the render.** The newest characters of the stream exist only in
      // the pending span, and `innerHTML` is about to replace the subtree it lives in.
      mergeChunk(answer);
      answer._streamText = null;
      answer._settled = 0;
      answer.innerHTML = renderMarkdown(node._text || '');
      return;
    }
    const full = node._text || '';
    if (!node._streaming) {
      node._streaming = true;
      answer._settled = 0;
      dropChunk(answer);
      // `appendData` and not `nodeValue`: it is the streaming surface's one write (and it
      // is what the offline guard's `Text` stub keeps its `textContent` in step with).
      // The node `ensureStreamText` hands back here is always a fresh, empty one.
      ensureStreamText(answer).appendData(full);
      answer._settled = full.length;
      return;
    }
    // The delta's new characters: settled characters plus whatever the pending spans
    // still hold is the prefix already on screen, so the slice is exact even when a
    // delta arrives mid-rise.
    const have = (answer._settled || 0) + (answer._wordChars || 0);
    if (have >= full.length) return;
    if (!animationsOn()) {
      // Exactly the old rendering, with the setting off: one `appendData`, no span.
      mergeChunk(answer);
      ensureStreamText(answer).appendData(full.slice(answer._settled || 0));
      answer._settled = full.length;
      return;
    }
    enqueueWords(answer, ensureStreamText(answer), full.slice(have));
  }

  function finalizeStreamingAnswer() {
    if (!messagesEl) return;
    // Everything that is still fading is part of the message: settle it before anything
    // is rendered or moved, so no character is left behind in a span.
    flushChunks();
    // The message is complete: nothing in it is streaming any more, so its thinking
    // row collapses back to its one line.
    closeActiveRows('thinking');
    // A streaming answer is a text row, and a text row always lives in the flow — the
    // log's own last child is the one that can still be mid-stream.
    const last = messagesEl.lastElementChild;
    if (last && last.dataset.kind === 'assistant' && !last.classList.contains('error')) {
      renderAnswer(last, true);
      followActive();
      relayout();
    }
  }

  /**
   * The live `Text` node of an element whose text is appended token by token. Kept
   * on the element (a subtree query per token is not free) and created from whatever
   * the element already shows, so a row a repaint filled keeps its text.
   */
  function textNodeOf(element) {
    if (!element._textNode) {
      const existing = element.textContent || '';
      element.textContent = '';
      element._textNode = document.createTextNode(existing);
      element.appendChild(element._textNode);
    }
    return element._textNode;
  }

  /**
   * One thinking delta into the row's own text, appended to the text node it already owns.
   *
   * The thinking is shown **verbatim**, never as Markdown: it is not a document. The model
   * writes its own layout with indentation and blank lines, and Markdown reinterprets
   * exactly that (four spaces become a code block, a leading `-` becomes a list, a blank
   * line becomes a paragraph gap), so the rendered text reads taller than the text the model
   * emitted and no longer says what it said. The one thing Markdown would buy here, links,
   * is what it gets most wrong: a bare `AGENTS.md` is turned into a URL.
   */
  function pushThinkingText(row, text) {
    if (!row || !row._textEl) return;
    // The reasoning gets the same treatment as an answer's text: the delta's words are in
    // the row immediately and each one is folded back into the row's own `Text` node when
    // its rise ends (`enqueueWords`, the same queue an answer uses).
    const tn = textNodeOf(row._textEl);
    if (animationsOn()) {
      enqueueWords(row._textEl, tn, text);
    } else {
      mergeChunk(row._textEl);
      tn.appendData(text);
    }
    // A thought is a step, so a delta that lands in an open run changes that run's count:
    // the header has to be refreshed here, or it keeps the number it had before the thought.
    if (openSteps) updateStepsHead(openSteps);
  }

  function appendThinking(text) {
    if (!messagesEl) return;
    // **One message, one row and one block.** A provider may interleave the reasoning
    // and the text of the same message, so a `thinkingDelta` can arrive *after* the
    // answer has started. The bubble is then the log's last child, and appending a new
    // row past it would put the reasoning after the text — and the next `delta`, finding
    // that row last, would open a second text block after *that*: one message rendered
    // as text / thinking / text. The host already carries both halves on one item, so
    // the reasoning of a message whose text dominates belongs to that message's own row:
    // a row above the bubble, appended to in place and never re-opened (the answer owns
    // the focus — `appendAssistant` closed the row when the text took over).
    const bubble = messagesEl.lastElementChild;
    if (bubble && bubble.dataset && bubble.dataset.kind === 'assistant' && !bubble.classList.contains('error')) {
      let row = bubble._thinkingRow;
      if (!row) {
        // A bubble built *before* any reasoning arrived (the message's text came first):
        // its row is the one the renderer would have put above it, so it is created
        // there — never appended past the text, which is where the second row came from.
        row = makeThinkingRow('');
        // Reasoning that trails a run of steps belongs to that run: it joins the
        // group's own body, the same place a repaint of the item puts it
        // (`paintFinishedItem` queues the row into the body). Only a message with no run
        // above it keeps its row directly above the bubble, in the flow.
        const prev = bubble.previousElementSibling;
        if (prev && prev.dataset && prev.dataset.kind === 'steps' && !prev._lazy) {
          prev._body.appendChild(row);
        } else {
          messagesEl.insertBefore(row, bubble);
        }
        bubble._thinkingRow = row;
      }
      pushThinkingText(row, text);
      // No `setActiveRow` / `setThinkingOpen(row, true)` here: a delta that joins a row
      // the answer already took over must not take the reading back to the reasoning.
      followActive();
      return row;
    }
    const row = ensureThinkingRow();
    pushThinkingText(row, text);
    // The row receiving the deltas is the live one: expanded, and it collapses on its
    // own the moment something else takes over (see `clearActiveRow`).
    setActiveRow(row);
    // The open form has a height cap, so the newest reasoning is kept in view the same way
    // the log is: the row's own follow light pins the box, and it is a no-op once the
    // reader scrolled the box up (`setThinkingOpen` re-engages it only on the open).
    if (row._open && row._scroll) row._scroll.scrollToBottom();
    followActive();
    return row;
  }

  /**
   * Nullish coalescing: the fallback unless the value is `undefined` or `null`.
   */
  function orElse(value, fallback) {
    return value === undefined || value === null ? fallback : value;
  }

  /**
   * The one usage line of a step: `Prompt: … / Completion: …, Cache Hit: … / Miss: …`. It is
   * the card's docked bar (`setCardUsage`), below the log. Every number comes from the
   * provider verbatim; the two cache fields read `0` when a provider reports none.
   */
  function formatUsage(usage) {
    const hit = orElse(usage.prompt_cache_hit_tokens, 0);
    const miss = orElse(usage.prompt_cache_miss_tokens, 0);
    return tr(
      'Prompt: {0} / Completion: {1}, Cache Hit: {2} / Miss: {3}',
      usage.prompt_tokens,
      usage.completion_tokens,
      hit,
      miss,
    );
  }

  /**
   * Write a usage line into `host`. When the **card** has a prompt-cache rate (the same
   * number its outline is painted from, `meta.cachePct`), the rate follows the bracket as a
   * segment of its own, coloured with the card's `--cache-color` (`media/style.css`,
   * `.usage-rate`); the hit and miss counts inside the bracket stay the one request's, the
   * rate is the card's requests combined. No rate, no segment: an unknown one is not shown.
   */
  function usageLineInto(host, usage, pct) {
    host._usage = usage;
    host._cachePct = pct;
    // Clear the bar explicitly instead of leaning on `textContent =` doing it: the previous
    // write may have been the `~` placeholder (or an older rate segment), and a node list left
    // behind would stack a second segment on the next write.
    if (host.children) {
      for (const child of Array.from(host.children)) {
        host.removeChild(child);
      }
    }
    host.textContent = formatUsage(usage);
    if (typeof pct === 'number') {
      const rate = el('span', 'usage-rate');
      rate.textContent = tr('Cache Hit Rate: {0}%', pct.toFixed(1));
      host.appendChild(rate);
    }
    return host;
  }

  /**
   * The live `usage` message: the card's docked bar is written straight away, so a turn
   * still in progress shows its token line as soon as the provider reports one. The host
   * carries the card's rate **after that request** on the same message (`cachePct`), which
   * is what makes the bar live rather than end-of-turn; a `null` there is a known answer
   * ("this provider reports no cache fields"), and a missing one means "use the card's own".
   */
  function appendUsage(usage, cachePct) {
    setCardUsage(logCard(), usage, cachePct);
    followActive();
  }

  function describeArgs(args) {
    if (!args || args === '{}') return '';
    try {
      return JSON.stringify(JSON.parse(args), null, 2);
    } catch {
      // Not strict JSON — try to summarize a verbatim frame.
    }
    if (args.indexOf('<<<RAW:') === -1) return args;
    const out = [];
    const header = args.split('<<<RAW:')[0].trim();
    if (header) {
      try {
        out.push(JSON.stringify(JSON.parse(header)));
      } catch {
        out.push(header);
      }
    }
    const tokenRe = /<<<RAW:([A-Za-z0-9_]+)>>>|<<<END_RAW:([A-Za-z0-9_]+)>>>/g;
    const stack = [];
    let m;
    while ((m = tokenRe.exec(args))) {
      if (m[1]) {
        let contentStart = tokenRe.lastIndex;
        if (args[contentStart] === '\r' && args[contentStart + 1] === '\n') contentStart += 2;
        else if (args[contentStart] === '\n') contentStart += 1;
        stack.push({ label: m[1], start: contentStart });
      } else if (m[2]) {
        const open = stack.pop();
        if (open && open.label === m[2]) {
          out.push(tr('[raw {0}: {1} chars]', open.label, m.index - open.start));
        }
      }
    }
    return out.join('\n');
  }

  // ---- The tool row: one bold verb and a label -------------------------------
  // A tool call is one line in the essay: `**Read** src/chat/tree.ts`. The verb is
  // the tool's *kind* of action in the reader's language (`tr()`-localized, one phrase
  // per kind of action: the three tools that change a file say `Edited`, because the
  // reader only has to know the file changed); the label is the model's own `title`
  // for the step when it gave one, else the argument that identifies the step (the
  // path, the command, the pattern).
  // The label is monospace for a command or a pattern and plain for everything else,
  // because a shell line and a path read best in the two different shapes.
  // Each entry asks `tr()` for its verb, at load, so the shipped catalogues carry all of
  // them (a table of plain strings would be invisible to `npm run check:l10n`).
  const TOOL_VERBS = {
    read_file: tr('Read'),
    read_image: tr('Viewed'),
    write_file: tr('Edited'),
    replace_in_file: tr('Edited'),
    append_file: tr('Edited'),
    list_dir: tr('Viewed folder'),
    list_nodes: tr('Viewed nodes'),
    search_files: tr('Searched files'),
    web_search: tr('Searched web'),
    search_transcripts: tr('Searched chats'),
    exec_command: tr('Ran'),
    check_command: tr('Checked'),
    wait_for_command: tr('Waited'),
    kill_command: tr('Killed'),
    web_fetch: tr('Fetched'),
    spawn_agents: tr('Spawned task agents'),
    spawn_readonly_agents: tr('Spawned research agents'),
    send_agent_message: tr('Sent task instructions'),
    send_readonly_agent_message: tr('Sent research instructions'),
    create_session: tr('Started a session'),
    send_session_prompt: tr('Prompted a session'),
    wait_for_session_idle: tr('Waited for a session'),
    interrupt_session: tr('Interrupted a session'),
    list_sessions: tr('Listed sessions'),
    rename_session: tr('Renamed session'),
  };
  /** The tools whose label is a command line or a pattern, i.e. set in monospace. */
  const MONO_LABEL_TOOLS = new Set([
    'exec_command',
    'check_command',
    'wait_for_command',
    'kill_command',
    'search_files',
    'search_transcripts',
    'web_search',
    'web_fetch',
  ]);

  /**
   * The tools whose label is the **file path** they acted on. Such a label is fitted the
   * way the path above a viewer is (`registerPathFit`): the file name stays whole and the
   * directories give way, because the name is the one part of the line that says what the
   * step was about. A `title` replaces the label with prose, and prose is never fitted.
   */
  const PATH_LABEL_TOOLS = new Set([
    'read_file',
    'write_file',
    'replace_in_file',
    'append_file',
    'read_image',
    'list_dir',
  ]);

  /**
   * The argument that names what a **session** tool acted on, because such a tool has no
   * path and no command: it has a conversation. Its row's label is that value —
   * `#sessionId` for everything that addresses an existing session, the quoted title for
   * the two that name one by hand — so a row never reads `Prompted a session` and then
   * nothing, which says nothing about which conversation moved.
   */
  const SESSION_ARG_KEYS = {
    create_session: 'session_name',
    send_session_prompt: 'session_id',
    wait_for_session_idle: 'session_id',
    interrupt_session: 'session_id',
    list_sessions: 'query',
    list_nodes: 'session_id',
    rename_session: 'title',
  };

  /**
   * The bold verb of a tool row. A name no verb knows keeps its own name rather than
   * borrowing another tool's word: an unknown tool is a fact about this build, and a
   * wrong verb would hide it.
   */
  function toolVerb(name) {
    const verb = TOOL_VERBS[name];
    return verb ? tr(verb) : String(name || '');
  }

  /**
   * The argument that identifies this step, in one line: the path for a file tool,
   * the command for `exec_command`, the pattern/query for a search, the session for a
   * session tool, else whatever of `path` / `command` / `cwd` / `url` / `query` the call
   * carries. Unparsable arguments still yield the path or command a regex can find,
   * because a card is more useful with a label than with none.
   */
  function toolBrief(name, args) {
    if (!args || args === '{}') return '';
    let value = '';
    try {
      const obj = JSON.parse(args);
      if (obj && typeof obj === 'object') {
        const sessionKey = SESSION_ARG_KEYS[name];
        if (sessionKey) {
          const raw = obj[sessionKey];
          value = raw === undefined || raw === null || raw === '' ? '' : sessionKey === 'session_id' ? '#' + raw : '"' + raw + '"';
        } else {
          const key = ['read_file', 'write_file', 'replace_in_file', 'read_image', 'list_dir'].includes(name)
            ? 'path'
            : name === 'exec_command'
              ? 'command'
              : ['search_files', 'search_transcripts'].includes(name)
                ? 'pattern'
                : name === 'web_search'
                  ? 'query'
                  : name === 'web_fetch'
                    ? 'url'
                    : obj.path ? 'path'
                      : obj.command ? 'command'
                        : obj.pattern ? 'pattern'
                          : obj.query ? 'query'
                            : obj.url ? 'url' : 'cwd';
          value = obj[key] || obj.path || obj.command || '';
        }
      }
    } catch {
      const m = String(args).match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"|"command"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      value = m ? (m[1] || m[2] || '') : '';
    }
    value = String(value).replace(/\s+/g, ' ').trim();
    // A path is never cut here: it is what `registerPathFit` shortens, from the width the
    // row leaves it, and it can only do that if the whole path arrives. A cut string has
    // no separators left to shorten and no file name to keep whole. A command or a
    // pattern keeps the 60-character cap: it is quoted text that no fit can improve, and
    // a row is more useful with its beginning than with a wall of it.
    if (PATH_LABEL_TOOLS.has(name)) return value;
    return value.slice(0, 60);
  }

  /**
   * The label a row shows: the model's `DisplayItem.title` (the host reads it out of
   * the arguments and stores it with the item, so a clipped argument string can never
   * lose it), else the derived brief. `title` wins outright — it is the one thing that
   * can say what a step was *for* — and an empty label is no label at all.
   */
  function toolLabel(name, args, title) {
    const given = typeof title === 'string' ? title.trim() : '';
    return given || toolBrief(name, args);
  }

  /**
   * Whether a row's label is the **file path** the call acted on — the one label a row
   * reads from its end, so it is shortened differently from a command or a pattern. A
   * `title` means the model named the step, so the label is its prose, not a path.
   */
  function labelIsPath(name, title) {
    return !title && PATH_LABEL_TOOLS.has(name);
  }

  /**
   * Keep a row's label fitted as a path, or stop doing so. One row is a draft with a prose
   * label first, then a path once its arguments settle — and a `title` can replace that
   * path with prose — so this runs on every relabel rather than once at build time.
   */
  function syncPathLabel(name, labelEl, label, title) {
    if (!labelEl) return;
    const row = labelEl.parentElement || labelEl;
    if (label && labelIsPath(name, title)) registerPathFit(labelEl, label, row, { mono: false, spare: LABEL_GAP });
    else clearPathFit(labelEl);
  }

  // ---- The detail: one presentation per kind of tool --------------------------
  // A row's detail used to be the raw arguments and the raw result, so a card read like
  // a debug trace: `> {"path":"a.ts","startLine":1}` and then a wall of text. It is now
  // one **viewer per kind of tool**, built from the same two strings the host already
  // stores (`DisplayItem.args` and `.content`). No payload is added anywhere: the
  // renderers read the tool's own result text, which is why `check-webview` pins one
  // real sample per kind — a rewording must fail the guard instead of quietly emptying
  // the card.
  //
  // The other half is `TOOL_ARG_SUMMARY`: one human line per tool in place of the JSON.
  // A tool this build does not know still gets its scalar pairs, never braces.

  /** A tool's argument object, or null while unparsable (streaming) / absent. */
  function argsOf(args) {
    if (!args || args === '{}') return null;
    try {
      const parsed = JSON.parse(args);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** `lines 3-40`, `from line 3`, `to line 40`, or '' — the range half of a summary. */
  function lineRangeLabel(a) {
    const from = Number(a && a.startLine) || 0;
    const to = Number(a && a.endLine) || 0;
    if (!from && !to) return '';
    if (from && to) return `lines ${from}-${to}`;
    return from ? `from line ${from}` : `to line ${to}`;
  }

  /** `12 lines` for a string that is about to be written, or '' when there is none. */
  function lineCountLabel(text) {
    const s = String(text === undefined || text === null ? '' : text);
    if (!s) return '';
    return `${s.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').length} lines`;
  }

  /** `3 agents` for a spawn, however the model spelled the array. */
  function agentCountLabel(a) {
    const list = Array.isArray(a && a.agents) ? a.agents : null;
    if (!list) return '';
    return `${list.length} agent${list.length === 1 ? '' : 's'}`;
  }

  /**
   * The first line of a piece of prose a call sent — a session prompt, a new session's
   * opening message — quoted and clipped. It is what the row says while the call runs,
   * before any result exists to read a fact out of.
   */
  function firstLineLabel(text) {
    const s = String(text === undefined || text === null ? '' : text).trim();
    if (!s) return '';
    const line = s.split(/\r?\n/)[0].trim();
    return '"' + (line.length > 60 ? line.slice(0, 60) : line) + '"';
  }

  /**
   * One line of plain words per tool, the replacement for `> {json}`. A field the call
   * did not carry contributes nothing, so no line is ever `undefined` or `null`.
   */
  const TOOL_ARG_SUMMARY = {
    read_file: (a) => [a.path, lineRangeLabel(a)],
    read_image: (a) => [a.path, a.rect ? 'a region' : ''],
    write_file: (a) => [a.path, lineCountLabel(a.content)],
    replace_in_file: (a) => [a.path],
    append_file: (a) => [a.path, lineCountLabel(a.content)],
    list_dir: (a) => [a.path, a.glob ? `glob ${a.glob}` : '', a.recursive ? 'recursive' : ''],
    search_files: (a) => [
      a.pattern ? `pattern "${a.pattern}"` : '',
      a.path || '',
      a.glob ? `glob ${a.glob}` : '',
      a.caseSensitive ? 'case sensitive' : '',
      a.context ? `${a.context} lines of context` : '',
    ],
    search_transcripts: (a) => [a.pattern ? `pattern "${a.pattern}"` : '', a.kind || '', a.sessionId || ''],
    web_search: (a) => [a.query ? `"${a.query}"` : ''],
    web_fetch: (a) => [a.url],
    exec_command: (a) => [a.command],
    check_command: (a) => [a.pid !== undefined ? `#${a.pid}` : ''],
    wait_for_command: (a) => [a.pid !== undefined ? `#${a.pid}` : '', a.seconds ? `${a.seconds}s` : ''],
    kill_command: (a) => [a.pid !== undefined ? `#${a.pid}` : ''],
    spawn_agents: (a) => [agentCountLabel(a)],
    spawn_readonly_agents: (a) => [agentCountLabel(a), 'read-only'],
    send_agent_message: (a) => [a.id ? `#${a.id}` : ''],
    send_readonly_agent_message: (a) => [a.id ? `#${a.id}` : ''],
    create_session: (a) => [a.session_name ? '"' + a.session_name + '"' : '', firstLineLabel(a.session_initial_prompt)],
    send_session_prompt: (a) => [
      a.session_id ? '#' + a.session_id : '',
      a.max_rounds ? a.max_rounds + ' rounds' : '',
      firstLineLabel(a.prompt),
    ],
    wait_for_session_idle: (a) => [
      a.session_id ? '#' + a.session_id : '',
      a.seconds ? a.seconds + 's' : '',
    ],
    interrupt_session: (a) => [a.session_id ? '#' + a.session_id : ''],
    list_sessions: (a) => [a.query ? '"' + a.query + '"' : ''],
    list_nodes: (a) => [a.session_id ? '#' + a.session_id : '', a.query ? '"' + a.query + '"' : ''],
    rename_session: (a) => [a.title ? `"${a.title}"` : ''],
  };

  /** The scalar pairs of an unknown tool's arguments: keys and values, never JSON. */
  function scalarSummary(a) {
    if (!a) return [];
    const out = [];
    for (const key of Object.keys(a)) {
      const value = a[key];
      if (value === null || value === undefined || value === '' || value === false) continue;
      if (typeof value === 'object') continue;
      out.push(`${key} ${value}`);
    }
    return out;
  }

  /**
   * The tool row's one-line argument summary, or '' when there is nothing worth saying
   * (a call whose arguments are still streaming has none yet).
   */
  function toolArgsLine(name, args) {
    const a = argsOf(args);
    if (!a) return '';
    const make = TOOL_ARG_SUMMARY[name];
    const parts = (make ? make(a) : scalarSummary(a)).map((p) => String(p || '').trim()).filter(Boolean);
    return parts.join('  ·  ');
  }

  /** Which viewer a tool's result opens in. No entry means the plain `<pre>` fallback. */
  const TOOL_KIND = {
    read_file: 'code',
    write_file: 'code',
    replace_in_file: 'diff',
    append_file: 'diff',
    exec_command: 'terminal',
    check_command: 'terminal',
    wait_for_command: 'terminal',
    kill_command: 'terminal',
    list_dir: 'entries',
    read_image: 'image',
    list_nodes: 'count',
    search_files: 'hits',
    search_transcripts: 'hits',
    web_search: 'results',
    web_fetch: 'document',
    spawn_agents: 'agents',
    spawn_readonly_agents: 'agents',
    send_agent_message: 'agents',
    send_readonly_agent_message: 'agents',
    create_session: 'session',
    send_session_prompt: 'session',
    wait_for_session_idle: 'session',
    interrupt_session: 'session',
    list_sessions: 'count',
    rename_session: 'note',
  };

  /**
   * The kinds whose viewer already says what the arguments were (a code surface names
   * the file, a terminal shows the command, an entry listing the directory): showing the
   * summary line above them would say it twice.
   */
  const KIND_HIDES_ARGS = new Set(['code', 'diff', 'terminal', 'entries', 'image', 'count', 'note', 'session', 'results', 'document', 'agents']);

  /**
   * The reasoning that immediately precedes a run's **first** tool row belongs inside that
   * run: it is the thought that led to the call, not a paragraph floating above it. Called
   * once per group, right after it opens — an empty body is the only one it fills — and from
   * both the live path and the repaint path, which is what keeps the two the same shape.
   *
   * Only the row directly above the group moves, and only a thinking row, so an answer or a
   * notice between the reasoning and the run stops the move: those are boundaries.
   */
  function tuckReasoningIntoRun(group) {
    if (!group || !group._body || group._body.firstChild) return;
    const prev = group.previousElementSibling;
    if (prev && prev.dataset && prev.dataset.kind === 'thinking') group._body.appendChild(prev);
  }

  /**
   * One tool card by its message id, walked depth-first.
   *
   * `updateTool` / `setToolStatus` used to ask `root.querySelector('[data-id="…"]')`,
   * a *compound* selector: the offline webview checker's stub answers those with a
   * shared dummy element, so the card the freeze writes into could not be observed
   * there (the assertions would pass on a dummy and miss a real regression). Walking
   * `root.children` keeps both the browser and the checker on the card itself, the
   * same reason `byClass` exists.
   */
  function toolNodeById(root, id) {
    for (const child of (root && root.children) || []) {
      if (
        child.classList &&
        child.classList.contains('msg') &&
        child.classList.contains('tool') &&
        child.dataset &&
        child.dataset.id === id
      ) {
        return child;
      }
      const nested = toolNodeById(child, id);
      if (nested) return nested;
    }
    return null;
  }

  /**
   * The verb's text, one `<span class="w">` per character. Godot's `[wave]` does the same
   * thing per glyph: every character rides a sine and the phase advances with its place in
   * the run, so the wave travels along the word. Each span carries its own index (`--i`),
   * which `media/style.css` turns into the phase.
   *
   * The spans are plain **inline** boxes, so the word's shaping — its kerning, its
   * ligatures — is exactly the one a `Text` node had; only the paint offset differs while
   * the row runs. They are built whether the setting is on or off, so a `config` that
   * flips at runtime never has to rebuild a row it already drew: the animation is the only
   * thing gated, and it is gated in CSS.
   */
  function setVerbText(verbEl, text) {
    if (!verbEl) return;
    // `textContent = ''` empties a real element, but the guard's DOM stub keeps its own
    // `children` list, so the children are removed one by one: both then agree, and a
    // rewritten verb never accumulates the characters of the name it used to have.
    while (verbEl.children && verbEl.children.length > 0) verbEl.removeChild(verbEl.children[0]);
    verbEl.textContent = '';
    const word = String(text || '');
    for (let i = 0; i < word.length; i++) {
      const ch = el('span', 'w', word[i]);
      if (ch.style && typeof ch.style.setProperty === 'function') ch.style.setProperty('--i', String(i));
      verbEl.appendChild(ch);
    }
  }

  /**
   * The row's one line: the bold verb, the label and the elapsed chip. It is built once
   * per row and rewritten in place (a live call's label grows with its arguments), which
   * is why it is its own small builder. The verb is written through `setVerbText`, which is
   * where the wave lives; the ticking chip is the row's clock, and its `running` / `done`
   * class still carries the state for anything that reads it.
   */
  function toolRowHead(name, label, mono, asPath) {
    const head = el('div', 'tool-row');
    const verb = el('b', 'tool-verb');
    setVerbText(verb, toolVerb(name));
    head.appendChild(verb);
    if (label) {
      const labelEl = el('span', 'tool-label' + (mono ? ' mono' : ''), label);
      head.appendChild(labelEl);
      // A path label is fitted to the width the row leaves it. That width is read from the
      // **row**, minus the parts that are not text (the verb, the chips): a label sized by
      // its own content would make every fit read its own last answer, and the row grows a
      // little shorter each pass.
      if (asPath) registerPathFit(labelEl, label, head, { mono: false, spare: LABEL_GAP });
    }
    return head;
  }

  // ---- Fitting a path to the width it is given ------------------------------
  // A path is read from its end: the file name says what the card is showing, and the
  // directories above it only say where. So a path that does not fit keeps its file name
  // whole and gives up its directory names first — each one cut to its own beginning
  // (`Attachments` -> `Att…`), and then dropped from the left, which is the shape
  // `…\Att…\BulletEndAttachments.cs`. CSS can only cut the **end** of a line
  // (`text-overflow`), or its start with `direction: rtl`, which scrambles the punctuation
  // of what it keeps — so the string is computed here, from the width the element was
  // actually given, and recomputed when that width changes.

  /** What a shortened path element ends with. One cell in a monospace font. */
  const PATH_MARK = '…';
  /** A directory name keeps at least this many characters before `PATH_MARK`. */
  const PATH_MIN_SEG = 3;
  /**
   * The cell width assumed when the font cannot be measured at all — the offline webview
   * checker's DOM stub, and a window the platform has hidden. A window that can measure
   * never sees this number.
   */
  const PATH_FALLBACK_CELL = 6;
  /**
   * The most of a hit row its path may take. A hit is a path, a line number **and** the
   * matched text, so the path is the one of the three that gives way.
   */
  const HITS_PATH_SHARE = 0.45;
  /** `.tool-row`'s `gap`: what separates a row's label from the verb and the chips. */
  const LABEL_GAP = 6;

  /** The separator a path is written with: the one it uses most, `\` winning a tie. */
  function pathSeparator(text) {
    const back = (text.match(/\\/g) || []).length;
    return back > 0 && back >= (text.match(/\//g) || []).length ? '\\' : '/';
  }

  /** The end of `text` that `budget` characters can hold, marked with `PATH_MARK`. */
  function pathTail(text, budget) {
    if (budget >= text.length) return text;
    if (budget <= 1) return PATH_MARK;
    return PATH_MARK + pathSliceTail(text, budget - 1);
  }

  /** `text` cut to its first `n` units, never through a surrogate pair (an emoji in a name). */
  function pathSliceHead(text, n) {
    if (n >= text.length) return text;
    if (n <= 0) return '';
    const code = text.charCodeAt(n - 1);
    return text.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
  }

  /** `text` cut to its last `n` units, never through a surrogate pair. */
  function pathSliceTail(text, n) {
    if (n >= text.length) return text;
    if (n <= 0) return '';
    const start = text.length - n;
    const code = text.charCodeAt(start);
    return text.slice(code >= 0xdc00 && code <= 0xdfff ? start + 1 : start);
  }

  /** One directory name at its shortest: its beginning, then the mark. */
  function pathSegment(name) {
    return name.length <= PATH_MIN_SEG ? name : pathSliceHead(name, PATH_MIN_SEG) + PATH_MARK;
  }

  /** One character more of a directory name (`Att…` -> `Atta…` -> … -> `Attachments`). */
  function pathGrow(shown, name) {
    if (shown === name) return shown;
    const kept = shown.endsWith(PATH_MARK) ? shown.length - 1 : shown.length;
    const next = pathSliceHead(name, kept + 1);
    return next.length >= name.length ? name : next + PATH_MARK;
  }

  /**
   * The path in at most `budget` characters, read from its own end: the file name whole,
   * the directory names shortened and then dropped from the left, and — for a budget too
   * small even for the name — the name's own end, which is where its extension is.
   * Deterministic: one path and one budget always give the same string.
   */
  function fitPathText(full, budget) {
    const text = String(full === undefined || full === null ? '' : full);
    if (!text || budget <= 0 || text.length <= budget) return text;
    const sep = pathSeparator(text);
    const lead = /^[\\/]+/.exec(text);
    const trail = /[\\/]+$/.exec(text);
    const names = text.split(/[\\/]+/).filter(Boolean);
    const tail = trail ? trail[0] : '';
    if (names.length < 2) return pathTail(text, budget);
    const last = names[names.length - 1];
    const dirs = names.slice(0, -1);
    // The file name comes first: a budget that cannot hold it keeps its end instead.
    if (PATH_MARK.length + sep.length + last.length + tail.length > budget) {
      return pathTail(last, budget) + tail;
    }
    // The shortest form that still names every directory: each one at `PATH_MIN_SEG`, then
    // the leftmost ones dropped for a single leading mark. `from` is the index of the first
    // directory name still shown.
    let from = 0;
    let kept = dirs.map(pathSegment);
    const render = (pieces, start) => {
      const head = start > 0 ? PATH_MARK + sep : lead ? lead[0] : '';
      return head + pieces.map((piece) => piece + sep).join('') + last + tail;
    };
    while (kept.length && render(kept, from).length > budget) {
      kept = kept.slice(1);
      from++;
    }
    // What is left over goes back into the names one character at a time each, and then
    // into the names that were dropped (the one nearest the file first): a wider card shows
    // the whole of what it can rather than one name in full and the rest gone.
    for (let grew = true; grew; ) {
      grew = false;
      for (let i = 0; i < kept.length; i++) {
        const before = kept[i];
        const grown = pathGrow(before, dirs[from + i]);
        if (grown === before) continue;
        kept[i] = grown;
        if (render(kept, from).length <= budget) grew = true;
        else kept[i] = before;
      }
      if (from > 0) {
        const restored = [pathSegment(dirs[from - 1])].concat(kept);
        if (render(restored, from - 1).length <= budget) {
          kept = restored;
          from--;
          grew = true;
        }
      }
    }
    return render(kept, from);
  }

  /** A 2d context for measuring text, or null when the platform has none. */
  let textMeasureCtx;
  function measureContext() {
    if (textMeasureCtx !== undefined) return textMeasureCtx;
    textMeasureCtx = null;
    try {
      const ctx = document.createElement('canvas').getContext('2d');
      if (ctx && typeof ctx.measureText === 'function') textMeasureCtx = ctx;
    } catch {
      textMeasureCtx = null;
    }
    return textMeasureCtx;
  }

  /** The hidden span a font is measured with when the canvas will not say (`probeWidthPx`). */
  let textProbe = null;

  /**
   * How wide `text` is in the font `reference` is drawn with, in px; 0 when unmeasurable.
   * The canvas is the cheap answer and the usual one; a hidden span wearing the same font
   * is the answer of last resort, because a canvas that refuses a font string reports
   * widths for the *wrong* font without saying so, and a fitted path a few characters too
   * wide is cut by the label's own CSS ellipsis, which eats the file name.
   */
  function textWidthPx(reference, text) {
    const value = String(text === undefined || text === null ? '' : text);
    if (!value) return 0;
    return canvasWidthPx(reference, value) || probeWidthPx(reference, value);
  }

  function canvasWidthPx(reference, text) {
    const ctx = measureContext();
    if (!ctx || typeof getComputedStyle !== 'function') return 0;
    try {
      const style = getComputedStyle(reference) || {};
      const font = [
        style.fontStyle || 'normal',
        style.fontWeight || '400',
        style.fontSize || '12px',
        style.fontFamily || 'monospace',
      ].join(' ');
      // A refused font string leaves the previous one in place: assigning a known font
      // first is what turns that silence into a 0 the caller can see.
      ctx.font = '10px monospace';
      ctx.font = font;
      if (ctx.font === '10px monospace') return 0;
      const measured = ctx.measureText(text).width;
      return measured > 0 ? measured : 0;
    } catch {
      return 0;
    }
  }

  function probeWidthPx(reference, text) {
    try {
      if (typeof getComputedStyle !== 'function') return 0;
      const style = getComputedStyle(reference) || {};
      if (!textProbe) {
        textProbe = el('span');
        textProbe.style.position = 'absolute';
        textProbe.style.left = '0';
        textProbe.style.top = '-1000px';
        textProbe.style.visibility = 'hidden';
        textProbe.style.pointerEvents = 'none';
        textProbe.style.whiteSpace = 'pre';
        if (document.body && document.body.appendChild) document.body.appendChild(textProbe);
      }
      textProbe.style.fontFamily = style.fontFamily || '';
      textProbe.style.fontSize = style.fontSize || '';
      textProbe.style.fontStyle = style.fontStyle || '';
      textProbe.style.fontWeight = style.fontWeight || '';
      textProbe.style.letterSpacing = style.letterSpacing || '';
      textProbe.textContent = text;
      const rect = textProbe.getBoundingClientRect ? textProbe.getBoundingClientRect() : null;
      const width = rect && rect.width ? rect.width : textProbe.offsetWidth || 0;
      return width > 0 ? width : 0;
    } catch {
      return 0;
    }
  }

  /**
   * The paths waiting to be fitted. `span` carries the text, `full` is the whole path, and
   * `target` is the element the flex layout sizes on its own — the point of the three is
   * that a re-fit never reads its own last answer, which would make a path shrink a little
   * on every pass. One `ResizeObserver` re-fits them: a card is dragged wider and narrower
   * and a path that was cut has to grow back.
   */
  const pathFits = new Set();
  let pathFitObserver = null;
  let pathFitFrame = 0;

  function schedulePathFit() {
    if (pathFitFrame) return;
    pathFitFrame = requestAnimationFrame(fitPaths);
  }

  /**
   * One path, fitted to `avail` px: the whole string kept when it fits, else the file name
   * whole and the directories shortened, else the file name's own end.
   */
  function paintPathFit(entry, avail) {
    const span = entry.span;
    const full = entry.full;
    if (entry.share < 1) span.style.maxWidth = avail + 'px';
    // A monospace cell is everything the arithmetic needs (every character is the same
    // width), so one division gives the budget, and there is nothing left to check.
    if (entry.mono) {
      const cell = textWidthPx(span, '0123456789') / 10;
      const text = fitPathText(full, Math.max(1, Math.floor(avail / (cell || PATH_FALLBACK_CELL))));
      if (span.textContent !== text) span.textContent = text;
      return;
    }
    // A proportional font has no such thing as a cell: the kept capitals of a file name are
    // wider than the lower case of the directories a fit drops, so an average is wrong in
    // both directions — too wide and the label's CSS ellipsis eats the **file name**, too
    // narrow and the row leaves width unused. The budget is bisected against the fitted
    // string's own width, and then the span's own box has the last word: a string still
    // wider than it is the one CSS cuts.
    //
    // One pixel is held back from the box on purpose: a string that lands exactly on the
    // edge is one subpixel of layout away from the ellipsis, and the CSS cut takes the last
    // characters of the file name (`.cs`) with it.
    const room = Math.max(1, avail - 1);
    let text = fitPathToWidth(span, full, room);
    span.textContent = text;
    for (let guard = 0; guard < 6 && text.length > 1; guard++) {
      // The **fractional** width against the box: `scrollWidth` is integer-rounded, so a
      // string that overflows by half a pixel reports "equal" there while the label's CSS
      // ellipsis still fires and eats the end of the file name.
      const want = textWidthPx(span, text) || 0;
      const box = span.clientWidth || 0;
      if (!want || !box || want <= box - 1) break;
      const over = want - box + 1;
      const cell = want / Math.max(1, text.length);
      text = fitPathText(full, Math.max(1, text.length - Math.max(1, Math.ceil(over / (cell || 6)))));
      span.textContent = text;
    }
    if (span.textContent !== text) span.textContent = text;
  }

  /**
   * The most of `full` that is at most `avail` px wide in `span`'s own font, found by
   * bisection: a fitted path only ever grows with its budget (a name gains characters, a
   * dropped one comes back), so the widest string that fits is the largest budget that
   * fits. No measurement to be had (the offline checker's DOM stub, a hidden window) falls
   * back to the nominal cell, exactly as the monospace half does.
   */
  function fitPathToWidth(span, full, avail) {
    const whole = fitPathText(full, full.length);
    const wholeWidth = textWidthPx(span, whole);
    if (!wholeWidth) return fitPathText(full, Math.max(1, Math.floor(avail / PATH_FALLBACK_CELL)));
    if (wholeWidth <= avail) return whole;
    let low = 1;
    let high = full.length;
    let best = fitPathText(full, 1);
    while (low <= high) {
      const mid = (low + high) >> 1;
      const candidate = fitPathText(full, mid);
      if ((textWidthPx(span, candidate) || 0) <= avail) {
        best = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return best;
  }

  function fitPaths() {
    pathFitFrame = 0;
    const ready = [];
    for (const entry of pathFits) {
      const span = entry.span;
      if (!span || span.isConnected === false) {
        pathFits.delete(entry);
        continue;
      }
      const avail = pathFitWidth(entry);
      if (avail <= 0 || avail === entry.width) continue;
      entry.width = avail;
      ready.push([entry, avail]);
    }
    // Every width is read before the first text is written: a list of hit rows would
    // otherwise force one layout per row.
    for (const [entry, avail] of ready) paintPathFit(entry, avail);
  }

  /**
   * The px one entry may use: a share of its target's width (a hit row), or the target's
   * width minus the parts that are not this text (a label's verb and chips, at
   * `entry.spare` per seam). The label's own box is the floor, so a build that reports no
   * sibling widths still fits it against what it was given.
   */
  function pathFitWidth(entry) {
    const target = entry.target;
    const share = Math.floor((target.clientWidth || 0) * entry.share);
    if (!entry.spare) return share;
    let used = 0;
    let seams = 0;
    for (const child of target.children || []) {
      if (child === entry.span) continue;
      used += child.offsetWidth || 0;
      seams++;
    }
    const room = Math.floor((target.clientWidth || 0) - used - entry.spare * seams);
    // The row's own arithmetic is the target, never the label's box: a box that follows its
    // text would make every fit read its own last answer. The box is only the fallback for a
    // build that reports no sibling width.
    return room > 0 ? room : Math.floor(entry.span.clientWidth || 0);
  }

  /**
   * Register one path element: fitted now, or as soon as it has a width, and again every
   * time its box changes size. The full path stays on the element as its `title`, so the
   * hover of a shortened path still says where the file is.
   */
  function registerPathFit(span, full, target, opts) {
    if (!span) return;
    // One entry per element: a row is re-labelled in place, and two entries for the same
    // span would paint it twice and leak the one nothing points at.
    const previous = span._pathFit;
    if (previous) pathFits.delete(previous);
    const entry = {
      span,
      full: String(full === undefined || full === null ? '' : full),
      target: target || span,
      share: opts && opts.share ? opts.share : 1,
      spare: (opts && opts.spare) || 0,
      mono: !!(opts && opts.mono),
      width: 0,
    };
    span._pathFit = entry;
    span.title = entry.full;
    pathFits.add(entry);
    if (!pathFitObserver && typeof ResizeObserver !== 'undefined') {
      pathFitObserver = new ResizeObserver(schedulePathFit);
    }
    if (pathFitObserver) {
      try {
        if (previous && previous.target && previous.target !== entry.target) pathFitObserver.unobserve(previous.target);
        pathFitObserver.observe(entry.target);
      } catch {
        /* a target this build cannot observe is fitted once, and never again */
      }
    }
    schedulePathFit();
  }

  /** Stop fitting an element — its text is prose now, not a path. */
  function clearPathFit(span) {
    if (!span || !span._pathFit) return;
    const entry = span._pathFit;
    pathFits.delete(entry);
    delete span._pathFit;
    span.title = '';
    if (pathFitObserver) {
      try {
        pathFitObserver.unobserve(entry.target || span);
      } catch {
        /* an observer that has nothing to forget is not a problem */
      }
    }
  }

  /**
   * Forget the recorded widths under `root`, so the next pass fits them again: a folded
   * detail has no width at all, and the row that has just been opened has one for the
   * first time.
   */
  function refitPathsIn(root) {
    let any = false;
    const walk = (node) => {
      for (const child of (node && node.children) || []) {
        if (child._pathFit) {
          child._pathFit.width = 0;
          any = true;
        }
        walk(child);
      }
    };
    walk(root);
    if (any) schedulePathFit();
  }

  // ---- The viewers -----------------------------------------------------------
  // Each one takes the tool's own result text and nothing else. They are deliberately
  // small and boring: the point is that a card shows a file, a terminal, a listing or a
  // sentence, never a JSON blob or an undifferentiated wall of text.

  /** The code surface's row height. Fixed: the list is virtualised, so a row that grew
   * with its text would break every offset arithmetic below. */
  const CODE_LINE_H = 16;
  /** Rows rendered above and below the window, so a fast scroll never shows a hole. */
  const CODE_OVERSCAN = 20;
  /** How tall the code surface is before it scrolls inside itself. */
  const CODE_VIEW_H = 320;

  /** `read_file`'s result: `File: <path> (<range>)` then the body. */
  function readFileView(content) {
    const text = String(content || '');
    const nl = text.indexOf('\n');
    const header = nl < 0 ? text : text.slice(0, nl);
    const body = nl < 0 ? '' : text.slice(nl + 1);
    const parsed = /^File: (.*) \((.*)\)$/.exec(header);
    if (!parsed) return { text, path: '', startLine: 1, numbers: false, note: '' };
    const [, path, range] = parsed;
    // A TRUNCATED answer has a hole in the middle, so it keeps the raw text: a gutter
    // with invented numbers would be a lie about where each line sits.
    if (/^\[TRUNCATED/.test(body)) return { text: body, path, startLine: 1, numbers: false, note: tr('truncated excerpt') };
    const whole = /^(\d+) lines, /.exec(range);
    if (whole) return { text: body, path, startLine: 1, numbers: true, note: '' };
    const part = /^lines (\d+)-(\d+) of \d+, /.exec(range);
    if (part) {
      // A ranged read prefixes every line with `N: `, which the gutter replaces.
      const stripped = body.replace(/^\d+: ?/gm, '');
      return { text: stripped, path, startLine: Number(part[1]), numbers: true, note: '' };
    }
    return { text: body, path, startLine: 1, numbers: false, note: '' };
  }

  /**
   * One code surface: a header line (the path, a note, the count) over a virtualised
   * list of fixed-height rows. Only the visible window is in the DOM, so a 20k-line
   * answer costs the same as a 40-line one. Rows never wrap (the reader scrolls
   * sideways) which is what keeps every row exactly `CODE_LINE_H` tall, and the line
   * numbers stay pinned to the left edge while the text slides under them.
   */
  function codeViewer(opts) {
    const lines = String(opts.text === undefined || opts.text === null ? '' : opts.text).split('\n');
    // A trailing newline is not a line of its own.
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const view = el('div', 'code-view');
    const head = el('div', 'code-head');
    if (opts.path) {
      // A jump: the card is showing a file, so its path opens that file. The path travels
      // as the call wrote it (usually workspace-relative) and the **host** resolves it — the
      // webview has no root to resolve against. No line: a read carries no "that line".
      // The box is what the flex layout sizes, so a fitted path cannot feed its own width
      // back in; the span inside it carries the text and is the jump.
      const box = el('span', 'path-fit');
      const pathEl = el('span', 'code-path jump', opts.path);
      pathEl.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: opts.path }));
      box.appendChild(pathEl);
      head.appendChild(box);
      registerPathFit(pathEl, opts.path, box, { mono: true });
    }
    if (opts.note) head.appendChild(el('span', 'code-note', opts.note));
    head.appendChild(el('span', 'code-count', lines.length === 1 ? tr('1 line') : tr('{0} lines', lines.length)));
    view.appendChild(head);

    const scroller = el('div', 'code-scroll');
    const spacer = el('div', 'code-spacer');
    const windowEl = el('div', 'code-window');
    spacer.appendChild(windowEl);
    scroller.appendChild(spacer);
    view.appendChild(scroller);
    if (lines.length <= 0) {
      view.appendChild(el('div', 'code-empty', tr('(empty)')));
      return view;
    }
    spacer.style.height = lines.length * CODE_LINE_H + 'px';

    const paint = () => {
      const total = lines.length;
      const viewport = scroller.clientHeight || CODE_VIEW_H;
      const scrolled = scroller.scrollTop || 0;
      let first = Math.floor(scrolled / CODE_LINE_H) - CODE_OVERSCAN;
      if (first < 0) first = 0;
      let count = Math.ceil(viewport / CODE_LINE_H) + CODE_OVERSCAN * 2;
      if (first + count > total) count = total - first;
      windowEl.textContent = '';
      windowEl.style.top = first * CODE_LINE_H + 'px';
      for (let i = 0; i < count; i++) {
        const row = el('div', 'code-line');
        // The gutter keeps its slot even when numbers are not known, so the text starts
        // at the same x whether or not a range was read.
        row.appendChild(
          el('span', 'code-no', opts.numbers ? String((opts.startLine || 1) + first + i) : ''),
        );
        row.appendChild(el('span', 'code-text', lines[first + i]));
        windowEl.appendChild(row);
      }
    };
    view._paint = paint;
    scroller.addEventListener('scroll', paint);
    paint();
    return view;
  }

  /**
   * One terminal: the command that ran, the status line the tool put in brackets, and
   * the output. The status line is the one thing coloured: a non-zero exit, a failed
   * start or a truncated dump is the error colour, everything else stays dim.
   */
  function terminalViewer(content, command) {
    const text = String(content || '');
    const view = el('div', 'term-view');
    if (command) view.appendChild(el('div', 'term-cmd', '$ ' + command));
    const head = /^\[([^\]]*)\]\n?/.exec(text);
    if (head) {
      const status = el('div', 'term-status', head[1]);
      if (/exited with (?!code 0\b).*code|could not start|failed to start|exceeded|truncated/i.test(head[1])) {
        status.classList.add('bad');
      }
      view.appendChild(status);
      view.appendChild(el('pre', 'term-out', text.slice(head[0].length)));
    } else {
      view.appendChild(el('pre', 'term-out', text));
    }
    return view;
  }

  /**
   * One directory listing: the path and its count, then a row per entry. A **file** row is
   * a jump — the listing names files, so the click opens one (the directory is joined back
   * on, because the entries are relative to it). A directory row is not: opening a folder
   * would open a second window, which is not what a click on a line of text means here.
   */
  function entriesViewer(content) {
    const text = String(content || '');
    const nl = text.indexOf('\n');
    const header = nl < 0 ? text : text.slice(0, nl);
    const body = nl < 0 ? '' : text.slice(nl + 1);
    const parsed = /^Directory: (.*)$/.exec(header);
    // The tool prints `<resolved dir>` plus ` (recursive)` for a walk; the mark is part of
    // the head the reader sees, but it is not part of the path anything is joined to.
    const dir = parsed ? parsed[1].replace(/\s+\(recursive\)$/, '') : '';
    const view = el('div', 'entries-view');
    const head = el('div', 'entries-head');
    if (parsed) {
      // The head shows the directory it listed. `(recursive)` is a mark on that listing,
      // not part of the path, so it stands beside the fitted path instead of inside it: a
      // shortened directory must never spend its width on it, and the mark must stay
      // glued to the path it marks (the count takes the rest of the head, right-aligned).
      const line = el('span', 'entries-head-path');
      const box = el('span', 'path-fit');
      const pathEl = el('span', 'entries-path', dir);
      box.appendChild(pathEl);
      line.appendChild(box);
      if (parsed[1] !== dir) line.appendChild(el('span', 'entries-mark', parsed[1].slice(dir.length)));
      head.appendChild(line);
      registerPathFit(pathEl, dir, box, { mono: true });
    }
    // The count is filled in once the rows are known, so the element is kept rather than
    // read back off the head (a `lastChild` lookup is a second guess at what was appended).
    const countEl = el('span', 'entries-count', '');
    head.appendChild(countEl);
    view.appendChild(head);
    const rows = body.split('\n').filter((line) => line && line !== '(empty)');
    let capped = '';
    if (rows.length && /^…\[listing stopped at/.test(rows[rows.length - 1])) capped = rows.pop();
    countEl.textContent = rows.length === 1 ? tr('1 entry') : tr('{0} entries', rows.length);
    if (!rows.length) view.appendChild(el('div', 'entries-empty', tr('(empty)')));
    const list = el('div', 'entries-list');
    for (const entry of rows) {
      const isDir = entry.endsWith('/');
      const row = el('div', 'entries-row' + (isDir ? ' dir' : ''));
      row.appendChild(el('span', 'entries-name', entry));
      if (dir && !isDir) {
        // The entries are slash-separated and relative to the header, so one separator is
        // all that is missing (a header that already ends in one keeps it as it is).
        const target = /[\\/]$/.test(dir) ? dir + entry : `${dir}/${entry}`;
        row.classList.add('jump');
        row.title = target;
        row.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: target }));
      }
      list.appendChild(row);
    }
    if (rows.length) view.appendChild(list);
    if (capped) view.appendChild(el('div', 'entries-note', capped.replace(/^…\[|\]$/g, '')));
    return view;
  }

  // ---- The line differ -------------------------------------------------------
  // Two strings in, one flat array of rows out. The webview bundles nothing from
  // node_modules, and one readable screen of JS is cheaper to trust than a diff library
  // plus its tree. The row model is flat and **pre-numbered**: a hunk is not an object
  // here, it is a run of rows with no `gap` inside, so the painter walks the array once
  // and never looks ahead to decide whether to draw an ellipsis.
  //
  // Invariants the painter relies on: `add`/`del` equal the number of `add`/`del` rows;
  // a `ctx`/`del` row carries a 1-based old number and a `ctx`/`add` row a 1-based new
  // one, the other side being null; identical content yields no rows at all.

  /** Split a text into lines: CRLF and a lone CR are both line ends, and a trailing
   * newline terminates the last line instead of opening an empty one. */
  function diffLines(text) {
    const s = text === null || text === undefined ? '' : String(text);
    const normalized = s.replace(/\r\n?/g, '\n');
    if (normalized === '') return [];
    const lines = normalized.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  /**
   * The whole edit script: an LCS length table filled bottom-up, then walked top-down into
   * rows. Ties go to `del` first, so a replaced line always reads `- old` then `+ new`
   * rather than interleaving, and the same two texts always give the same rows.
   */
  function diffEditScript(a, b) {
    const n = a.length;
    const m = b.length;
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      const row = i * w;
      const next = row + w;
      for (let j = m - 1; j >= 0; j--) {
        dp[row + j] =
          a[i] === b[j] ? dp[next + j + 1] + 1 : dp[next + j] >= dp[row + j + 1] ? dp[next + j] : dp[row + j + 1];
      }
    }
    const rows = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        rows.push({ type: 'ctx', old: i + 1, new: j + 1, text: a[i] });
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
        rows.push({ type: 'del', old: i + 1, new: null, text: a[i] });
        i++;
      } else {
        rows.push({ type: 'add', old: null, new: j + 1, text: b[j] });
        j++;
      }
    }
    while (i < n) rows.push({ type: 'del', old: i + 1, new: null, text: a[i++] });
    while (j < m) rows.push({ type: 'add', old: null, new: j + 1, text: b[j++] });
    return rows;
  }

  /**
   * Which slices of the edit script are worth showing: each change keeps `ctx` lines of
   * air, and two changes share a hunk exactly when their windows touch or overlap (that is
   * when nothing would be elided). A single dropped line justifies a `gap` row: showing
   * fewer context lines than asked for, without saying so, would misrepresent the file.
   */
  function diffHunkSpans(rows, ctx) {
    const changes = [];
    for (let k = 0; k < rows.length; k++) if (rows[k].type !== 'ctx') changes.push(k);
    if (!changes.length) return [];
    const last = rows.length - 1;
    const spans = [];
    let start = Math.max(0, changes[0] - ctx);
    let end = Math.min(last, changes[0] + ctx);
    for (let c = 1; c < changes.length; c++) {
      const k = changes[c];
      const s = Math.max(0, k - ctx);
      const e = Math.min(last, k + ctx);
      if (s <= end + 1) {
        end = Math.max(end, e);
      } else {
        spans.push([start, end]);
        start = s;
        end = e;
      }
    }
    spans.push([start, end]);
    return spans;
  }

  /** Cells of the LCS table above which the middle is not diffed line by line. */
  const DIFF_MAX_CELLS = 4000000;

  function diffRows(oldText, newText) {
    const a = diffLines(oldText);
    const b = diffLines(newText);
    // Equal lines mean "no change" even when the bytes differ (CRLF vs LF, a trailing
    // newline appearing): a file re-saved by another OS must not read as changed.
    if (a.length === b.length && a.every((line, i) => line === b[i])) return { rows: [], add: 0, del: 0 };
    // Past the ceiling the LCS is refused outright: a slow wrong answer is worse than a
    // fast honest one, so the whole old side is removed and the whole new side added.
    if ((a.length + 1) * (b.length + 1) > DIFF_MAX_CELLS) {
      const rows = [];
      for (let i = 0; i < a.length; i++) rows.push({ type: 'del', old: i + 1, new: null, text: a[i] });
      for (let j = 0; j < b.length; j++) rows.push({ type: 'add', old: null, new: j + 1, text: b[j] });
      return { rows, add: b.length, del: a.length };
    }
    const all = diffEditScript(a, b);
    let add = 0;
    let del = 0;
    for (const row of all) {
      if (row.type === 'add') add++;
      else if (row.type === 'del') del++;
    }
    const spans = diffHunkSpans(all, 3);
    const rows = [];
    for (let s = 0; s < spans.length; s++) {
      if (s > 0) rows.push({ type: 'gap' });
      for (let k = spans[s][0]; k <= spans[s][1]; k++) rows.push(all[k]);
    }
    return { rows, add, del };
  }

  /**
   * A diff surface: the same fixed-row, virtualised list the code viewer uses (both are
   * read the same way), with two gutters and a full-width tint per row. The gutters hold
   * the old and the new line number; when the change's position in the file is not known
   * (an edit anchored on text, not on a line) the numbers are simply absent rather than
   * invented, and the `gap` row stands in for git's "⋯".
   */
  function diffViewer(opts) {
    const rows = opts.rows || [];
    const view = el('div', 'diff-view');
    const head = el('div', 'diff-head');
    if (opts.path) {
      // A jump, like the code surface: the change is in this file, so its path opens it.
      // Fitted the same way, and for the same reason (`registerPathFit`).
      const box = el('span', 'path-fit');
      const pathEl = el('span', 'diff-path jump', opts.path);
      pathEl.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: opts.path }));
      box.appendChild(pathEl);
      head.appendChild(box);
      registerPathFit(pathEl, opts.path, box, { mono: true });
    }
    if (opts.note) head.appendChild(el('span', 'diff-note', opts.note));
    head.appendChild(el('span', 'diff-count-add', '+' + (opts.add || 0)));
    head.appendChild(el('span', 'diff-count-del', '-' + (opts.del || 0)));
    view.appendChild(head);
    if (!rows.length) {
      view.appendChild(el('div', 'diff-empty', tr('no line changed')));
      return view;
    }
    const scroller = el('div', 'diff-scroll');
    const spacer = el('div', 'diff-spacer');
    const windowEl = el('div', 'diff-window');
    spacer.appendChild(windowEl);
    scroller.appendChild(spacer);
    view.appendChild(scroller);
    spacer.style.height = rows.length * CODE_LINE_H + 'px';
    const paint = () => {
      const total = rows.length;
      const viewport = scroller.clientHeight || CODE_VIEW_H;
      const scrolled = scroller.scrollTop || 0;
      let first = Math.floor(scrolled / CODE_LINE_H) - CODE_OVERSCAN;
      if (first < 0) first = 0;
      let count = Math.ceil(viewport / CODE_LINE_H) + CODE_OVERSCAN * 2;
      if (first + count > total) count = total - first;
      windowEl.textContent = '';
      windowEl.style.top = first * CODE_LINE_H + 'px';
      for (let i = 0; i < count; i++) {
        const row = rows[first + i];
        if (row.type === 'gap') {
          windowEl.appendChild(el('div', 'diff-row gap', '⋯'));
          continue;
        }
        const line = el('div', 'diff-row ' + row.type);
        line.appendChild(el('span', 'diff-old', row.old === null || !opts.numbers ? '' : String(row.old)));
        line.appendChild(el('span', 'diff-new', row.new === null || !opts.numbers ? '' : String(row.new)));
        line.appendChild(el('span', 'diff-mark', row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '));
        line.appendChild(el('span', 'diff-text', row.text));
        windowEl.appendChild(line);
      }
    };
    view._paint = paint;
    scroller.addEventListener('scroll', paint);
    paint();
    return view;
  }

  /**
   * `append_file`'s change is a pure addition at the end of the file, so there is nothing to
   * compute: the numbers come from the tool's own "M lines added, N lines total" sentence,
   * which is the one thing the result text already knows and the arguments do not.
   */
  function appendRows(content, argsContent) {
    const added = diffLines(argsContent);
    const stats = /^Appended to .*\((\d+) lines added, (\d+) lines total\)/.exec(String(content || ''));
    const total = stats ? Number(stats[2]) : 0;
    const start = total ? total - added.length + 1 : 1;
    return added.map((text, i) => ({ type: 'add', old: null, new: start + i, text }));
  }

  // ---- The text viewers: hits, web results, a fetched page, a sub-agent batch ----
  // Each parses the tool's own result text (the shapes are pinned in `check-webview`).
  // A line the parser does not recognise is kept rather than dropped: a card that loses
  // a line silently is worse than one that shows a line it could not classify.

  /** `src/a.ts:12: text` and `src/a.ts-12- text` (a context line), as search prints them. */
  const HIT_LINE = /^(.+?)([:-])(\d{1,9})\2 (.*)$/;

  /**
   * The hits of `search_files` / `search_transcripts`: the path, the line and the text,
   * with the cap note and the scope echo the tool appends kept underneath. Without hit
   * lines (no matches, a timeout, a spilled answer) the text is shown as it came.
   *
   * A row is a jump: a click asks the host to open that file **at that line**
   * (`openFile { path, line }`), because the line number is the whole reason to click a
   * hit. The path travels as the tool printed it — workspace-relative for `search_files`,
   * absolute for a transcript dump — and the host resolves it. A context line (`-12-`) is
   * a row like any other: the reader clicked it because it is near what they want.
   */
  function hitsViewer(content) {
    const text = String(content || '');
    const view = el('div', 'hits-view');
    const head = el('div', 'hits-head');
    const hits = [];
    const notes = [];
    let plain = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      const hit = HIT_LINE.exec(line);
      if (hit) {
        hits.push({ path: hit[1], ctx: hit[2] === '-', line: hit[3], text: hit[4] });
        continue;
      }
      plain++;
      notes.push(line);
    }
    if (!hits.length) {
      // Nothing hit-shaped: the result is prose (no matches, a timeout, a spill pointer),
      // so it is shown whole rather than rendered as an empty list.
      return el('div', 'note-view', text);
    }
    head.appendChild(el('span', 'hits-count', tr('{0} hits', hits.length)));
    for (const note of notes) head.appendChild(el('span', 'hits-note', note));
    view.appendChild(head);
    const list = el('div', 'hits-list');
    for (const hit of hits) {
      const row = el('div', 'hits-row' + (hit.ctx ? ' ctx' : ''));
      const path = el('span', 'hits-path', hit.path);
      row.appendChild(path);
      row.appendChild(el('span', 'hits-line', hit.line));
      row.appendChild(el('span', 'hits-text', hit.text));
      row.addEventListener('click', () => {
        vscode.postMessage({ type: 'openFile', path: hit.path, line: Number(hit.line) });
      });
      // The row is what is watched: a hit's path is one of three parts that share the row,
      // so its own width depends on the other two and a fit read back from it would chase
      // itself. The row's width is the layout's, and the path takes at most `HITS_PATH_SHARE`
      // of it.
      registerPathFit(path, hit.path, row, { mono: true, share: HITS_PATH_SHARE });
      list.appendChild(row);
    }
    view.appendChild(list);
    return view;
  }

  /** One web result block: `1. title`, then three-space-indented url and snippet lines. */
  function resultsViewer(content) {
    const text = String(content || '');
    const lines = text.split('\n');
    const view = el('div', 'results-view');
    const head = el('div', 'results-head');
    let cursor = 0;
    const header = lines.length ? /^web_search "(.*?)" — (.*)$/.exec(lines[0]) : null;
    if (header) {
      head.appendChild(el('span', 'results-query', header[1]));
      head.appendChild(el('span', 'results-meta', header[2]));
      cursor = 1;
      if (/^attempts: /.test(lines[cursor] || '')) {
        const attempts = el('div', 'results-attempts', lines[cursor].slice('attempts: '.length));
        view.appendChild(head);
        view.appendChild(attempts);
        cursor++;
        head._after = true;
      }
    }
    if (!head._after) view.appendChild(head);
    const body = el('div', 'results-body');
    let item = null;
    const flush = () => {
      if (!item) return;
      const row = el('div', 'results-item');
      row.appendChild(el('span', 'results-index', item.index));
      const title = el('a', 'results-title', item.title);
      title.href = item.url || '#';
      title.title = item.url || '';
      row.appendChild(title);
      if (item.url) row.appendChild(el('span', 'results-url', item.url));
      if (item.meta) row.appendChild(el('span', 'results-snippet', item.meta));
      body.appendChild(row);
      item = null;
    };
    for (; cursor < lines.length; cursor++) {
      const line = lines[cursor];
      if (!line) {
        flush();
        continue;
      }
      const numbered = /^(\d+)\. (.*)$/.exec(line);
      if (numbered) {
        flush();
        item = { index: numbered[1], title: numbered[2], url: '', meta: '' };
        continue;
      }
      if (item && /^ {3}/.test(line)) {
        const value = line.trim();
        if (!item.url && /^https?:\/\//.test(value)) item.url = value;
        else item.meta = item.meta ? `${item.meta} ${value}` : value;
        continue;
      }
      if (!item) {
        // Prose between the blocks (a note, the untrusted-data sentence). Its first line
        // is enough: the rest is addressed to the model, not to the reader.
        if (!body._prose) body.appendChild(el('div', 'results-prose', line));
        body._prose = true;
        continue;
      }
      item.meta = item.meta ? `${item.meta} ${line.trim()}` : line.trim();
    }
    flush();
    view.appendChild(body);
    return view;
  }

  /** A fetched page: the URL and the HTTP facts, then the text as it was extracted. */
  function documentViewer(content) {
    const text = String(content || '');
    if (/^(Error: |web_fetch refused)/.test(text)) return el('div', 'note-view', text);
    const split = text.indexOf('\n\n');
    const header = split < 0 ? text : text.slice(0, split);
    const body = split < 0 ? '' : text.slice(split + 2);
    const view = el('div', 'doc-view');
    const head = el('div', 'doc-head');
    const view_ = head;
    for (const line of header.split('\n')) {
      if (!line) continue;
      if (/^web_fetch /.test(line)) {
        const url = el('span', 'doc-url', line.slice('web_fetch '.length));
        view_.appendChild(url);
      } else if (/^Untrusted web content/.test(line)) {
        view_.appendChild(el('span', 'doc-tag', tr('web content')));
      } else if (/^HTTP /.test(line) || /^via the provider/.test(line)) {
        view_.appendChild(el('span', 'doc-status', line));
      } else {
        view_.appendChild(el('span', 'doc-note', line));
      }
    }
    view.appendChild(head);
    if (body) view.appendChild(el('pre', 'doc-body', body));
    return view;
  }

  /** The short id a card's row uses for a sub-agent. */
  function shortNodeId(id) {
    return String(id || '').slice(-6);
  }

  /**
   * A sub-agent batch. Its result is a single-line JSON document (the runtime builds it),
   * so it is parsed rather than regexed: `results[]` for a sync batch, `spawned`/`ids` for
   * an async one, `resumed`/`id` for a follow-up. A non-JSON answer (an error sentence)
   * is shown as it came.
   */
  function agentsViewer(content) {
    const text = String(content || '');
    if (/^Error: /.test(text)) return el('div', 'note-view', text);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return el('div', 'note-view', text);
    }
    const rows = [];
    if (Array.isArray(data.results)) {
      for (const item of data.results) {
        rows.push({
          id: shortNodeId(item.agentNodeId),
          ok: item.ok !== false,
          model: item.modelName || item.model || '',
          ms: item.durationMs,
          summary: item.summary || '',
        });
      }
    } else if (typeof data.resumed === 'string' || typeof data.id === 'string') {
      rows.push({
        id: shortNodeId(data.id),
        ok: data.ok !== false,
        model: data.modelName || data.model || '',
        ms: data.durationMs,
        summary: data.summary || (data.async ? tr('still running') : ''),
      });
    } else if (Array.isArray(data.ids)) {
      for (const id of data.ids) {
        const done = Array.isArray(data.done) && data.done.indexOf(id) >= 0;
        const running = Array.isArray(data.running) && data.running.indexOf(id) >= 0;
        rows.push({
          id: shortNodeId(id),
          ok: true,
          model: '',
          ms: undefined,
          summary: running ? tr('still running') : done ? tr('finished') : '',
        });
      }
    }
    const view = el('div', 'agents-view');
    if (!rows.length) return el('div', 'note-view', text);
    const head = el('div', 'agents-head');
    head.appendChild(el('span', 'agents-count', rows.length === 1 ? tr('1 agent') : tr('{0} agents', rows.length)));
    view.appendChild(head);
    for (const row of rows) view.appendChild(agentRow(row));
    return view;
  }

  /**
   * Markdown into an element, when there is a renderer; the plain text when there is not.
   * The offline checker loads this script with no markdown-it (by design), so the fallback
   * is what keeps a rendered block's text observable to a guard.
   */
  function markdownInto(element, text) {
    if (!element) return;
    if (md) {
      element.innerHTML = renderMarkdown(text || '');
      element.classList.add('md-body');
    } else {
      element.textContent = text || '';
    }
  }

  /** One sub-agent block: its short id and duration on the top line, its report below. */
  function agentRow(entry) {
    const row = el('div', 'agents-row' + (entry.ok ? '' : ' failed'));
    row.appendChild(el('span', 'agents-id', '#' + entry.id));
    if (entry.model) row.appendChild(el('span', 'agents-model', entry.model));
    if (entry.ms !== undefined && entry.ms !== null) row.appendChild(el('span', 'agents-ms', formatDuration(entry.ms)));
    if (entry.summary) {
      // The summary **is** the sub-agent's final answer, Markdown and all (a report with
      // tables and lists is the normal case), so it is rendered rather than flattened.
      const body = el('div', 'agents-summary');
      markdownInto(body, entry.summary);
      row.appendChild(body);
    }
    return row;
  }

  /**
   * One line per finished sub-agent, as the runtime writes them into a batch notice:
   * `Sub-agent #abc123 finished in 9.1s: <summary>`, where the summary may run over many
   * lines (it is the agent's whole final answer). A line that is neither is kept as prose,
   * because a batch body the viewer does not recognise must not lose its text.
   */
  const BATCH_LINE = /^Sub-agent #(\S+) (finished|failed|killed|stopped)\b(.*)$/;
  const BATCH_TIME = /([\d.]+)\s*(ms|s|m|h)\b/;

  /**
   * A finished sub-agent batch: the same rows the `spawn_agents` viewer draws, built from
   * the notice's prose instead of from a tool result (the runtime writes the batch body as
   * text). Everything after an agent's own line belongs to that agent's answer, so the rows
   * are rebuilt by walking the body once.
   */
  function batchViewer(content) {
    const text = String(content || '');
    const entries = [];
    const prose = [];
    for (const line of text.split('\n')) {
      const head = BATCH_LINE.exec(line.trim());
      if (head) {
        const time = BATCH_TIME.exec(head[3] || '');
        const rest = (head[3] || '').replace(/^[\s\S]*?:/, '');
        entries.push({
          id: head[1],
          ok: head[2] === 'finished',
          ms: time ? parseDurationLabel(`${time[1]}${time[2]}`) : undefined,
          summary: rest.trim(),
        });
        continue;
      }
      if (entries.length) entries[entries.length - 1].summary += '\n' + line;
      else prose.push(line);
    }
    if (!entries.length) return el('pre', 'tool-result', text);
    const view = el('div', 'agents-view');
    const head = el('div', 'agents-head');
    head.appendChild(el('span', 'agents-count', entries.length === 1 ? tr('1 agent') : tr('{0} agents', entries.length)));
    view.appendChild(head);
    for (const entry of entries) view.appendChild(agentRow(entry));
    for (const line of prose) view.appendChild(el('div', 'agents-prose', line));
    return view;
  }

  /** `9.1s` / `1.2m` / `340ms` → milliseconds, for the batch's own duration labels. */
  function parseDurationLabel(label) {
    const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/.exec(String(label || '').trim());
    if (!match) return undefined;
    const value = Number(match[1]);
    const unit = { ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2]];
    return Math.round(value * unit);
  }

  /**
   * `list_nodes`'s result is a whole tree, and a reader does not want the tree in a card:
   * the size of the session is the fact. `handleListNodes` already leads with it
   * (`session <id> "<title>" — <N> nodes, checked out: …`), so the header is the viewer.
   */
  function countViewer(content) {
    const text = String(content || '');
    const header = /(?:^|\n)session (\S+) "(.*)" — (\d+) nodes/.exec(text);
    if (!header) return el('div', 'note-view', text);
    return el('div', 'note-view', tr('Checked {0} nodes in {1} ({2})', header[3], header[2], header[1]));
  }

  /**
   * The viewer for the four **session** tools (`create_session`, `send_session_prompt`,
   * `wait_for_session_idle`, `interrupt_session`).
   *
   * They are the only tools whose answer is about another conversation, and the facts a
   * reader wants are split across the two strings the host stores: *which* session and
   * *what was sent* are in the arguments, while the outcome and the budget left are in the
   * result. So the head states the target and the rounds left, the body is the text that
   * was sent, and the tool's own words stay — unless they are the JSON receipt of a
   * prompt, which is read into the head's facts and never printed.
   */
  function sessionViewer(a, content) {
    const text = String(content || '');
    const receipt = sessionReceipt(text);
    const target = String(
      a.session_id ||
        (receipt && receipt.target && receipt.target.session_id) ||
        createdSessionId(text) ||
        '',
    ).trim();
    const head = el('div', 'session-head');
    if (a.session_name) head.appendChild(el('span', 'session-title', '"' + a.session_name + '"'));
    if (target) {
      const targetEl = el('span', 'session-target', '#' + target);
      targetEl.title = target;
      head.appendChild(targetEl);
    }
    const rounds = roundsLeftOf(text, receipt);
    if (rounds !== null) {
      head.appendChild(
        el('span', 'session-rounds', rounds === 1 ? tr('1 round left') : tr('{0} rounds left', String(rounds))),
      );
    }
    const view = el('div', 'session-view');
    if (head.children.length > 0) view.appendChild(head);
    const body = el('div', 'session-body');
    // What the call sent: the prompt itself. A prompt is prose, so it wraps.
    const sent = a.prompt || a.session_initial_prompt || '';
    if (sent) body.appendChild(el('div', 'session-prompt', String(sent)));
    // A receipt has already been turned into the head's facts; a sentence is the answer.
    if (!receipt && text.trim()) body.appendChild(el('div', 'note-view', text));
    if (body.children.length > 0) view.appendChild(body);
    return view;
  }

  /** Pending `imageUrl` requests, keyed by the id the host echoes back. */
  const imageRequests = new Map();
  let imageRequestSeq = 0;

  /** Ask the host for one image's bytes, once, when its row is expanded. */
  function requestImageUrl(path, done) {
    if (!path) {
      done(null);
      return;
    }
    const id = 'img' + ++imageRequestSeq;
    imageRequests.set(id, done);
    vscode.postMessage({ type: 'imageUrl', requestId: id, path });
  }

  /**
   * One image, as the **model** was shown it.
   *
   * The viewer is about that call's image: the box clips to the call's own `rect`, which is
   * exactly the region that was uploaded, and the downscale the harness applies is invisible
   * at display size. The pixels come from the file, because a webview cannot read one, and
   * the host answers with the file's mtime beside them: a file rewritten after the call is
   * flagged, since the pixels below are then the current file and not what the model saw.
   * A single click opens the source file in an editor.
   */
  function imageViewer(a, content, since) {
    const view = el('div', 'image-view');
    const head = el('div', 'image-head');
    if (a.path) {
      const box = el('span', 'path-fit');
      const pathEl = el('span', 'image-path', a.path);
      box.appendChild(pathEl);
      head.appendChild(box);
      registerPathFit(pathEl, a.path, box, { mono: true });
    }
    // The transform's own sentence (`1920x1080, rect 10,20 200x150 -> 200x150`) carries the
    // size that was actually sent, which is the one fact worth repeating.
    const facts = /-> (\d+x\d+)/.exec(String(content || ''));
    if (facts) head.appendChild(el('span', 'image-size', facts[1]));
    const warn = el('span', 'image-note hidden');
    head.appendChild(warn);
    view.appendChild(head);
    const box = el('div', 'image-box');
    box.title = tr('open the file in the editor');
    const img = el('img', 'image-el');
    img.alt = a.path || tr('image');
    box.appendChild(img);
    view.appendChild(box);
    box.addEventListener('click', () => {
      if (a.path) vscode.postMessage({ type: 'openFile', path: a.path });
    });
    const rect = a.rect && typeof a.rect === 'object' ? a.rect : null;
    // The whole image is centred in its box; a **clipped** one never is, because there the box
    // is the crop and the picture is offset by the region's own origin (see `fit`).
    if (!rect) box.classList.add('plain');
    /** Clip the box to `rect` and scale the picture so that region fits it. */
    const fit = () => {
      const natural = { w: img.naturalWidth || 0, h: img.naturalHeight || 0 };
      if (!rect || !natural.w || !natural.h) {
        img.style.maxWidth = '100%';
        img.style.maxHeight = '240px';
        return;
      }
      const scale = Math.min(1, 240 / Math.max(1, Number(rect.h) || 1), 420 / Math.max(1, Number(rect.w) || 1));
      box.style.width = Math.round((Number(rect.w) || 0) * scale) + 'px';
      box.style.height = Math.round((Number(rect.h) || 0) * scale) + 'px';
      img.style.maxWidth = 'none';
      img.style.maxHeight = 'none';
      img.style.width = Math.round(natural.w * scale) + 'px';
      img.style.height = Math.round(natural.h * scale) + 'px';
      img.style.marginLeft = -Math.round((Number(rect.x) || 0) * scale) + 'px';
      img.style.marginTop = -Math.round((Number(rect.y) || 0) * scale) + 'px';
    };
    img.addEventListener('load', fit);
    requestImageUrl(String(a.path || ''), (answer) => {
      if (!answer || !answer.url) {
        warn.classList.remove('hidden');
        warn.textContent =
          answer && answer.error === 'too large'
            ? tr('the image is too large to show here')
            : tr('the file could not be read');
        return;
      }
      img.src = answer.url;
      if (since && answer.mtime && answer.mtime > since) {
        warn.classList.remove('hidden');
        warn.textContent = tr('the file changed after this call');
      }
      fit();
    });
    return view;
  }

  /**
   * The viewer for one tool result, or the plain `<pre>` when this build has no viewer
   * for that kind (an unknown tool, or a kind that is not built yet). The fallback is a
   * compatibility path, not the normal one.
   */
  function buildToolViewer(kind, name, args, content, since) {
    const a = argsOf(args) || {};
    if (kind === 'image') return imageViewer(a, content, since);
    if (kind === 'diff') {
      const clipped = /…\[truncated \d+ chars for UI\]/.test(String(args || ''));
      if (clipped) {
        // The two halves of the change did not survive the display clip, so no diff can be
        // reconstructed. Saying so beats drawing a change that is not the one that ran.
        return el('div', 'diff-empty', tr('the call arguments were truncated for display, so this change cannot be shown'));
      }
      if (name === 'append_file') {
        const rows = appendRows(content, a.content);
        return diffViewer({ path: a.path, rows, add: rows.length, del: 0, numbers: true, note: '' });
      }
      const result = diffRows(String(a.oldText || ''), String(a.newText || ''));
      return diffViewer({
        path: a.path,
        rows: result.rows,
        add: result.add,
        del: result.del,
        // An edit anchored on text has no line of its own in the file, so the gutters stay
        // empty rather than showing numbers relative to a block nobody can locate.
        numbers: false,
        note: '',
      });
    }
    if (kind === 'code') {
      if (name === 'write_file') {
        // `write_file` overwrites, so its result carries no body: the content written is
        // the argument. The args are clipped for display, and the surface says so rather
        // than pretending the file ends where the clip does.
        const clipped = /…\[truncated \d+ chars for UI\]/.test(String(args || ''));
        return codeViewer({
          text: a.content,
          path: a.path,
          startLine: 1,
          numbers: true,
          note: clipped ? tr('arguments truncated for display') : '',
        });
      }
      const parsed = readFileView(content);
      return codeViewer({ ...parsed });
    }
    if (kind === 'terminal') return terminalViewer(content, a.command);
    if (kind === 'entries') return entriesViewer(content);
    if (kind === 'hits') return hitsViewer(content);
    if (kind === 'results') return resultsViewer(content);
    if (kind === 'document') return documentViewer(content);
    if (kind === 'agents') return agentsViewer(content);
    if (kind === 'count') return countViewer(content);
    if (kind === 'session') return sessionViewer(a, content);
    if (kind === 'note') return el('div', 'note-view', content);
    return el('pre', 'tool-result', content);
  }

  /**
   * Paint a row's detail. It is rebuilt whole rather than patched, because every part
   * of it (the summary line, the viewer, the error, the usage line) is decided by the
   * payload, and a live row changes shape exactly twice: when the arguments settle and
   * when the result arrives. The usage line is the assistant message's, not the call's,
   * so it is passed through untouched.
   */
  function paintToolDetail(detail, opts) {
    if (!detail) return;
    const name = opts.name || '';
    const kind = TOOL_KIND[name] || '';
    detail.textContent = '';
    // A viewer that names the file / shows the command / lists the directory already
    // says what the arguments were; only a kind that does not (a search, a spawn, a
    // rename) gets the summary line above it. A row that has no result yet keeps the
    // summary whatever its kind, so an opened live row is never blank.
    const viewerSaysArgs = !!kind && !!opts.content && KIND_HIDES_ARGS.has(kind);
    if (opts.args && !viewerSaysArgs) {
      const line = toolArgsLine(name, opts.args);
      if (line) detail.appendChild(el('div', 'tool-args-line', line));
    }
    detail.classList.toggle('has-viewer', !!opts.content && !!kind);
    if (opts.content) detail.appendChild(buildToolViewer(kind, name, opts.args, opts.content, opts.since));
    if (opts.error) detail.appendChild(el('div', 'tool-error', opts.error));
    detail._paint = () => {
      for (const child of detail.children || []) {
        if (child._paint) child._paint();
      }
    };
  }

  /**
   * One tool row, live or replayed. `opts` is the whole state a row has:
   *   `{ name, args, id, title, usage, status, start, ms, content, error }`
   * where `start` is the host clock of a call still running and `ms` its frozen
   * duration once it is over. The detail (the `> args` line, the result, an error and
   * the usage line) is built folded and holds everything from the first paint — a
   * row that is expanded shows the same DOM the live path would have shown, which is
   * what keeps `renderItemInto` and the streaming path from disagreeing.
   */
  function addTool(opts) {
    if (!messagesEl) return;
    const name = opts.name;
    const args = opts.args;
    const id = opts.id;
    const node = el('div', 'msg tool ' + (opts.status === 'running' ? 'running' : 'done'));
    node.dataset.id = id;
    node.dataset.kind = 'tool';
    const mono = !opts.title && MONO_LABEL_TOOLS.has(name);
    const head = toolRowHead(name, toolLabel(name, args, opts.title), mono, labelIsPath(name, opts.title));
    // The line diff of a file-modifying call, before the elapsed chip (the head reads
    // verb, label, `+12 -3`, time).
    syncDiff(head, opts.diff);
    // The call's own duration: `start` for a call that is running, `ms` for one that is
    // already over (a repaint of history). Neither is passed while a call is still
    // streaming its arguments — nothing has started yet, so the row deliberately shows
    // no chip.
    syncElapsed(head, 'tool-elapsed', opts.start, opts.ms);
    // A session prompt's remaining budget, from the receipt: left of the time, like the diff.
    syncSessionRounds(head, name, opts.content, byClass(head, 'tool-elapsed'));
    node.appendChild(head);
    const detail = el('div', 'tool-detail hidden');
    paintToolDetail(detail, {
      name,
      args,
      content: opts.content,
      error: opts.error,
      usage: opts.usage,
      // The call's own end, when both halves are known: an image row compares the file's
      // mtime against it to say whether the pixels below are still the ones it was sent.
      since: opts.start != null && opts.ms != null ? opts.start + opts.ms : null,
    });
    node.appendChild(detail);
    head.addEventListener('click', () => {
      markRowTouched(node);
      setToolOpen(node, !isRowOpen(node));
    });
    node._rowEl = head;
    node._detailEl = detail;
    node._name = name;
    node._args = args;
    node._label = toolLabel(name, args, opts.title);
    node._title = opts.title;
    const group = ensureStepsGroup();
    logTail().appendChild(node);
    updateStepsHead(group);
    animateRow(node);
    followActive();
    return node;
  }

  // Live (still-streaming) tool cards, bucketed per owning node. Each bucket maps
  // a tool *index* to its card — a node's tool stream is index-scoped — so two
  // nodes streaming at once cannot collide on index 0. The '' bucket is the view
  // focus container, i.e. the legacy stream that carries no nodeId.
  const liveTools = Object.create(null);

  /**
   * What a tool row says while the model is still writing the call. The call's arguments
   * are half a JSON blob by then and the row has no room to lie about them, so the draft
   * says the one thing that is true for the whole of it — that a call is being written —
   * and keeps the verb of the tool it is going to be. `finalizeLiveTool` turns the element
   * into the ordinary row the moment the call settles.
   */
  const LIVE_TOOL_LABEL = tr('Writing tool call...');

  /**
   * Bucket key for `owner`: an explicit node id, or — when `owner` is undefined —
   * the node the current routed call writes into, else the view focus node (a
   * legacy, unrouted call writes into that node's card too). '' is the
   * unattributed container (no node at all).
   */
  function liveOwnerKey(owner) {
    if (owner !== undefined) return owner || '';
    return routingNodeId || treeActiveId || '';
  }

  function liveBucket(owner, create) {
    const key = liveOwnerKey(owner);
    let bucket = liveTools[key];
    if (!bucket && create) bucket = liveTools[key] = Object.create(null);
    return bucket;
  }

  /**
   * A tool call whose name (and arguments) are still streaming: **one row with one fixed
   * label**. The verb is the tool the first name delta named — a name that arrives in
   * pieces says what it says until it is whole — and the label is `Writing tool call...`
   * until the call settles, because the arguments are half a JSON blob and a row that
   * showed them would be a row a reader has to un-read. There is no elapsed chip (nothing
   * has started yet) and the detail stays empty until `finalizeLiveTool` paints it from
   * the settled arguments.
   */
  function addLiveTool(index, id, name) {
    if (!messagesEl) return;
    const node = el('div', 'msg tool live running');
    node.dataset.index = String(index);
    node.dataset.kind = 'tool';
    if (id) node.dataset.id = id;

    // A prose label, so never monospace: monospace is the *derived* command or pattern,
    // and a draft has none — `finalizeLiveTool` re-derives it from the settled arguments.
    const head = toolRowHead(name || '', LIVE_TOOL_LABEL, false);
    node.appendChild(head);

    // The detail is painted when the arguments settle (`finalizeLiveTool`): a half-streamed
    // JSON blob is not something to put in front of a reader, and the row is folded while
    // it composes anyway.
    const detail = el('div', 'tool-detail hidden');
    node.appendChild(detail);

    head.addEventListener('click', () => {
      markRowTouched(node);
      setToolOpen(node, !isRowOpen(node));
    });

    node._rowEl = head;
    node._detailEl = detail;
    node._verbEl = byClass(head, 'tool-verb');
    node._labelEl = byClass(head, 'tool-label');
    node._toolName = name || '';

    const group = ensureStepsGroup();
    tuckReasoningIntoRun(group);
    logTail().appendChild(node);
    updateStepsHead(group);
    animateRow(node);
    liveBucket(undefined, true)[index] = node;
    followActive();
    return node;
  }

  /**
   * One streaming delta of a call: the pieces of its **name** are the only thing this path
   * can still change, and they change the row's verb in place (a rebuild per delta would
   * throw away the row the reader may have just opened). Nothing here grows a label or an
   * argument string: the fixed draft label is what keeps a composing call from rewriting
   * its own text — and reading its own layout — on every delta it announces.
   */
  function appendLiveTool(index, id, nameDelta) {
    const bucket = liveBucket(undefined, true);
    let node = bucket[index];
    if (!node) {
      node = addLiveTool(index, id, nameDelta || '');
    } else if (nameDelta) {
      node._toolName = (node._toolName || '') + nameDelta;
      if (node._verbEl) setVerbText(node._verbEl, toolVerb(node._toolName));
    }
    if (id) node.dataset.id = id;
    followActive();
    return node;
  }

  /**
   * The call's arguments are complete: the row becomes the running one it will be for
   * the rest of the call. Its verb and label are rewritten from the settled arguments
   * (a streamed name can arrive in pieces), the elapsed chip is born here — a call
   * that is still composing its arguments deliberately has none — and the detail is
   * rebuilt in the shape `addTool` builds, so a row that was live and a row that was
   * replayed from history are the same element.
   */
  function finalizeLiveTool(index, id, name, args, start, ms, title) {
    if (!messagesEl) return;
    const bucket = liveBucket(undefined, false);
    const indexed = index !== undefined && index !== null;
    let node = indexed && bucket ? bucket[index] : null;
    if (!node && id) {
      node = toolNodeById(messagesEl, id);
    }
    if (!node) {
      return addTool({ name, args, id, title, start, ms, status: 'running' });
    }
    if (indexed && bucket) delete bucket[index];
    if (id) node.dataset.id = id;
    delete node.dataset.index;
    node.classList.remove('live');
    node.classList.add('running');
    node._title = title;
    if (name && node._rowEl) {
      const verb = byClass(node._rowEl, 'tool-verb');
      if (verb) setVerbText(verb, toolVerb(name));
    }
    const label = toolLabel(name, args, title);
    node._label = label;
    // A `title` reads as normal text: monospace is only for the derived command or
    // pattern, i.e. when the model gave the step no name of its own.
    const mono = !title && MONO_LABEL_TOOLS.has(name);
    if (node._rowEl) {
      let labelEl = byClass(node._rowEl, 'tool-label');
      if (!labelEl && label) {
        labelEl = el('span', 'tool-label' + (mono ? ' mono' : ''), label);
        node._rowEl.appendChild(labelEl);
      } else if (labelEl) {
        labelEl.textContent = label;
        labelEl.classList.toggle('mono', mono);
      }
      // The draft's prose label has just become the path the call acts on (or a `title`
      // has replaced it with prose): the label is fitted, or stops being fitted, here.
      syncPathLabel(name, labelEl, label, title);
      // The arguments are settled, so the call is *running* now: that is the moment
      // its elapsed chip is born.
      syncElapsed(node._rowEl, 'tool-elapsed', start, ms);
    }
    // The arguments are settled: this is the first moment the detail has anything to
    // say, so it is painted from here on (and repainted whole when the result arrives).
    node._name = name;
    node._args = args;
    node._start = start;
    paintToolDetail(node._detailEl, { name, args });
    followActive();
    return node;
  }

  /**
   * Drop live tool rows. With no owner (the legacy shape: the message carried no
   * nodeId) every live row goes, exactly as before; with one, only that node's rows
   * are cleared so a run finishing on another node keeps its own.
   */
  function clearLiveTools(owner) {
    const keys = owner === undefined ? Object.keys(liveTools) : [liveOwnerKey(owner)];
    for (const key of keys) {
      const bucket = liveTools[key];
      if (!bucket) continue;
      for (const index in bucket) {
        const node = bucket[index];
        if (node && node.parentNode) node.parentNode.removeChild(node);
      }
      delete liveTools[key];
    }
  }

  /**
   * The call reported its result: the row is done, its chip freezes at the host's own
   * number, and the result lands in the detail it already owns. A host that predates
   * the `ms` field sends none, and then the chip goes rather than ticking on forever
   * over a call that has already answered. The row is *not* opened by this: a finished
   * step is one line, and the result is one click away.
   */
  function updateTool(id, content, ms, diff) {
    if (!messagesEl) return;
    const node = toolNodeById(messagesEl, id);
    if (!node) return;
    node.classList.remove('running', 'live');
    node.classList.add('done');
    const head = node._rowEl || byClass(node, 'tool-row');
    if (head) syncElapsed(head, 'tool-elapsed', null, ms);
    // Left of the frozen time chip, where the head's design keeps it.
    if (head) syncDiff(head, diff, byClass(head, 'tool-elapsed'));
    // The result is the only place a session prompt's remaining budget exists.
    if (head) syncSessionRounds(head, node._name, content, byClass(head, 'tool-elapsed'));
    const detail = node._detailEl || byClass(node, 'tool-detail');
    // The result arrives: the row's detail is painted whole from the settled arguments
    // and the result, exactly as a repaint of the same item would paint it.
    if (detail && content) {
      paintToolDetail(detail, {
        name: node._name,
        args: node._args,
        content,
        since: node._start != null && ms != null ? node._start + ms : null,
      });
      if (detail._paint) detail._paint();
    }
    clearActiveRow(node);
    followActive();
  }

  /**
   * The host's own status for a row (a repaint of history): `running` keeps the chip
   * ticking, `done` freezes it. The classes are what the dot and the CSS read.
   */
  function setToolStatus(id, status) {
    if (!messagesEl) return;
    const node = toolNodeById(messagesEl, id);
    if (!node) return;
    node.classList.toggle('running', status !== 'done');
    node.classList.toggle('done', status === 'done');
  }

  /**
   * A completion notice: a background terminal or a sub-agent batch finished.
   *
   * It wears the tool row's clothes on purpose — the producer tag (`BG` / `SUB`) sits where a
   * step's verb sits, the job's id and command are the label, the outcome is the chip, and
   * the output is folded one click away. A notice is the same kind of line as a step:
   * something the turn did, finished. It used to be a bordered block with its output always
   * open, which dropped a wall of text into the middle of the essay every time a job ended.
   */
  /**
 * A message another session sent, shown as plain text: it is neither a terminal (no
 * command, no output stream) nor a batch (no rows), so it gets no viewer of its own.
 */
function sessionMessageBody(content) {
  const body = el('div', 'session-msg-body');
  body.textContent = String(content || '');
  return body;
}

function addBackgroundNotice(item) {
    if (!messagesEl) return;
    // A notice that **opens the next round** is a boundary, not a step: it ends the run
    // above it and then stands alone in the flow as one dim line, with the batch summary
    // folded behind it (a click opens it; it is collapsed at rest, so the boundary still
    // reads as one line). The round it starts gets its own `Ran N steps`, so a node that
    // async work resumed reads as answer / notice / steps / answer instead of one run that
    // swallows two.
    if (item.round) {
      closeStepsGroup();
      const producer = item.producer || item.kind;
      const isSub = producer === 'subagent';
      const isSession = producer === 'session';
      // The line reads like a step's own line: a **title** in the verb's slot and a short
      // human sentence beside it, both italic, all of it in the accent colour because this
      // is the one row in the log that is an *event* rather than work or words.
      const done = String(item.doneText || '');
      // The runtime's `doneText` is prose for the model, not for the reader, so only its two
      // facts are taken: how many, and how long.
      const duration = (/\(([^)]+)\)\s*$/.exec(done) || [])[1] || '';
      const count = (/^(\d+)/.exec(done) || [])[1] || '';
      const subject = isSub ? (count ? tr('{0} agents', count) : '') : String(item.name || '');
      const context = [subject, duration].filter(Boolean).join(' · ');
      const line = el('div', 'msg notice-line');
      line.dataset.kind = 'background';
      line.dataset.round = '1';
      const text = el('div', 'notice-text');
      text.appendChild(
        el(
          'b',
          'notice-title',
          isSession ? tr('Session message') : isSub ? tr('Sub-agent finished') : tr('Background job finished'),
        ),
      );
      if (context) {
        text.appendChild(document.createTextNode(' '));
        text.appendChild(el('i', 'notice-context', context));
      }
      line.appendChild(text);
      if (item.content || item.id != null) {
        // Nothing to fold means no fold: a notice with no body and no id stays a plain line
        // and is not a click target (the handler is only attached when there is something
        // to open).
        const detail = el('div', 'tool-detail hidden');
        if (item.id != null && item.id !== '') detail.appendChild(el('div', 'notice-id', '#' + item.id));
        if (item.content) {
          detail.appendChild(
            isSession ? sessionMessageBody(item.content) : isSub ? batchViewer(item.content) : terminalViewer(item.content, ''),
          );
        }
        line.appendChild(detail);
        text.addEventListener('click', () => {
          markRowTouched(line);
          setToolOpen(line, !isRowOpen(line));
        });
        line._detailEl = detail;
      }
      line._rowEl = text;
      messagesEl.appendChild(line);
      followActive();
      return line;
    }
    const node = el('div', 'msg tool done bgnotify');
    node.dataset.kind = 'background';
    // The tag names the producer, so a background terminal and a sub-agent batch are told
    // apart at a glance (they used to share the same "BG").
    const producer = item.producer || item.kind;
    const isSub = producer === 'subagent';
    const isSession = producer === 'session';
    const head = el('div', 'tool-row');
    // The tag is a word, not a code: `BG`/`SUB` were three letters a reader had to learn,
    // and all of them are localized like every other verb in the log.
    head.appendChild(
      el(
        'b',
        'tool-verb bgnotify-badge ' + (isSession ? 'session' : isSub ? 'sub' : 'bg'),
        isSession ? tr('Session message') : isSub ? tr('Sub-agent finished') : tr('Background job finished'),
      ),
    );
    const command = isSub ? '' : item.name || item.cmd || '';
    const id = item.id != null && item.id !== '' ? '#' + item.id : '';
    const label = [id, command].filter(Boolean).join(' ');
    if (label) head.appendChild(el('span', 'tool-label mono', label));
    if (item.doneText) head.appendChild(el('span', 'bgnotify-status', item.doneText));
    node.appendChild(head);
    const detail = el('div', 'tool-detail hidden');
    // A batch notice is the same rows the `spawn_agents` viewer draws (its body is prose,
    // not JSON, so it is parsed); a job notice is a terminal, command and output; a
    // session message is the text another conversation sent.
    if (item.content) {
      detail.appendChild(
        isSession ? sessionMessageBody(item.content) : isSub ? batchViewer(item.content) : terminalViewer(item.content, command),
      );
    }
    node.appendChild(detail);
    head.addEventListener('click', () => {
      markRowTouched(node);
      setToolOpen(node, !isRowOpen(node));
    });
    node._rowEl = head;
    node._detailEl = detail;
    logTail().appendChild(node);
    followActive();
    return node;
  }

  /**
   * One item of a **finished** card, split by the same rule the live path follows — but
   * with every group's body left lazy: a tool item opens a group (or extends the open
   * one) and its item joins that group's `_lazy` list; a text item closes the run and is
   * painted in the flow (never inside a group); a reasoning row — or a notice, a
   * `HARNESS` block — that arrives while a run is open rides that group's body, and one
   * that arrives with no run open is the flow's own line.
   */
  function paintFinishedItem(item) {
    // A turn whose model answered **only with its reasoning** (`noAnswer`, set from the
    // `noAnswerText` event): the banner and the thinking itself, both in the flow. The text
    // is not an answer and the row is not a step, so neither the bubble branch below nor
    // the "only reasoning" one may take it.
    if (item.kind === 'assistant' && item.noAnswer && !item.error && String(item.thinking || '').length) {
      addNoAnswerBlock(item.thinking);
      return;
    }
    // The text of a turn always lives in the flow, and it closes the run of steps above
    // it: `addAssistant` renders the reasoning row that travels with the item where the
    // live path put it (inside the open group) and then closes the run before the prose
    // is appended to the log.
    if (item.kind === 'assistant' && (String(item.text || '').length > 0 || !!item.error)) {
      // The reasoning travels with the text but belongs to the run above it, and this
      // group's body is still empty (`_lazy` holds its rows until the click that builds
      // it). The row joins that queue, so it lands in the body in its original order
      // instead of being appended before the tool rows the body receives later. It counts
      // as a step, exactly like a live thought does.
      if (openSteps && openSteps._lazy && item.thinking) {
        openSteps._lazy.push({ kind: 'assistant', thinking: item.thinking });
        openSteps._count = (openSteps._count || 0) + 1;
        updateStepsHead(openSteps);
        renderItemInto({ ...item, thinking: undefined });
        return;
      }
      renderItemInto(item);
      return;
    }
    // A message that is **only** reasoning opens the fold it belongs to, the same way the
    // live path does: a thought is a step, so it is never loose in the flow.
    if (item.kind === 'assistant' && !String(item.text || '').length && !item.error && item.thinking) {
      const group = ensureStepsGroup();
      if (group) {
        if (!group._lazy) group._lazy = [];
        group._lazy.push({ kind: 'assistant', thinking: item.thinking });
        group._count = (group._count || 0) + 1;
        updateStepsHead(group);
        if (!group._userTouched) setStepsFold(group, true);
        return;
      }
    }
    if (item.kind === 'background' && item.round) {
      // The same boundary the live path draws: the run above ends, the notice is the flow's
      // own line, and the next round's steps open a group of their own.
      closeStepsGroup();
      renderItemInto(item);
      return;
    }
    if (item.kind === 'tool') {
      const group = ensureStepsGroup();
      if (group) {
        tuckReasoningIntoRun(group);
        if (!group._lazy) group._lazy = [];
        group._lazy.push(item);
        group._count = (group._count || 0) + 1;
        updateStepsHead(group);
        // A finished card's groups are folded: its rows come with the click.
        if (!group._userTouched) setStepsFold(group, true);
        return;
      }
    }
    if (openSteps) {
      (openSteps._lazy || (openSteps._lazy = [])).push(item);
      return;
    }
    renderItemInto(item);
  }

  /**
   * Render a node's stored items into its card: the first `user` item to the pinned
   * ask (`.node-ask`), everything else into the log (`.node-work`) **in order**, so
   * the model's final answer is simply the last markdown block of the one flow. There
   * is no second place an answer could live, so there is nothing for a repaint and a
   * live turn to disagree about.
   *
   * Derives its own containers from `card` and sets messagesEl/promptEl to them for
   * the duration: every `add*` helper writes into those two globals, and they must be
   * the node's own containers while its items are painted (a repaint of one node is
   * not allowed to append into another node's transcript).
   *
   * `virtual` is the caller's "this node is finished" answer (a running node's items
   * are appended in place as they arrive, and the streaming path reads the
   * container's last child back to continue it, so it must never be re-rendered from a
   * slice): a finished node with more than `VIRTUAL_ITEM_THRESHOLD` items renders the
   * window around its newest content instead of the whole log.
   */
  function renderNodeItems(card, items, virtual) {
    const workEl = card.querySelector('.node-work');
    const askEl = card.querySelector('.node-ask');
    if (!workEl || !askEl) return;
    // What this card now holds, for the unload decision (`virtMayUnload`), and the fact
    // that it no longer needs a reload — a summary render counts, because something is on
    // screen again.
    card._itemCount = (items || []).length;
    card._itemsUnloaded = false;
    // Its content is being replaced: a skipped card's remembered box is the old content.
    cvWakeForMeasure(card);
    // The settle stamp of this render (see `virtMayUnload`), and the decay of a hold the
    // card has outlived: escalation is a brake on a ping-pong, not a permanent sentence.
    card._virtFilledAt = perfNow();
    if (card._virtReloads && perfNow() - (card._virtReloadedAt || 0) > VIRT_RELOAD_HOLD_MAX_MS) {
      card._virtReloads = 0;
    }
    // A full render clears the log, which is the one way a position can be thrown away
    // with nothing to be said for it: keep what the log remembers and hand it back once
    // the items are in. On a card's *first* render there is nothing to hand back
    // (`rememberScroll` has not seen a scroll yet) and `_needsBottomScroll` is the
    // positioning that render wants, so both cases fall through untouched.
    const keepWork = scrollMemory(workEl);
    workEl.innerHTML = '';
    askEl.innerHTML = '';
    // A full render replaces the log, and its steps groups with it: the next render that
    // has steps builds fresh ones (`ensureStepsGroup`), and the old list must not point
    // at elements the wipe above detached.
    card._openGroup = null;
    card._groups = [];
    openSteps = null;
    // A window belongs to the list it was painted from; a full render replaces it.
    workEl._virt = null;
    const prevMsg = messagesEl;
    const prevPrompt = promptEl;
    messagesEl = workEl;
    promptEl = askEl;
    const work = [];
    let promptSet = false;
    for (const item of items || []) {
      if (item.kind === 'user') {
        if (!promptSet) {
          addUserPrompt(item.text, item.attachments);
          promptSet = true;
        }
        continue;
      }
      work.push(item);
    }
    if (virtual && !work.some((item) => item.kind === 'tool') && work.length > VIRTUAL_ITEM_THRESHOLD) {
      if (!workEl._virtScroll) {
        const container = workEl;
        workEl._virtScroll = () => onItemsWindowScroll(container);
        workEl.addEventListener('scroll', workEl._virtScroll);
      }
      paintItemsWindow(workEl, {
        items: work,
        promptEl: askEl,
        // A finished card opens at its newest content (`_needsBottomScroll`), so the
        // first window is the *tail* of the log; scrolling up extends it.
        start: Math.max(0, work.length - VIRTUAL_WINDOW),
        end: work.length,
        px: VIRTUAL_ITEM_PX,
        painted: [],
        top: null,
        bottom: null,
        raf: null,
      });
    } else {
      const hasSteps = work.some((item) => item.kind === 'tool');
      // A finished card splits its items with the same rule the live path uses — one
      // group per contiguous run of tool rows, the text always in the flow — but it
      // leaves each group's **body** lazy (`paintStepsBody`), because a folded log is
      // not read. A card still streaming is never re-rendered from a slice: the live
      // path appends into it and opens each group as its tool rows arrive.
      const lazyGroups = hasSteps && !!virtual && !runningNodes.has(card.dataset ? card.dataset.id : '');
      for (const item of work) {
        if (lazyGroups) paintFinishedItem(item);
        else renderItemInto(item);
      }
      // The render is over: nothing is open any more, so the next routed append (a
      // notice, a continued turn) starts in the flow.
      closeStepsGroup();
    }
    messagesEl = prevMsg;
    promptEl = prevPrompt;
    // The flow's own open group belongs to the card this container belongs to.
    openSteps = openGroupOf(prevMsg);
    // The log shows when it holds anything — and it holds the answer of a pure-text turn
    // too, because the answer is the flow's last block. A card with no items at all
    // (a row the `tree` described and no `path` has filled yet) hides the empty box
    // instead of leaving a padded strip under the question; un-hiding is left to the
    // first append, which is `routeTo`.
    const workWrap = card.querySelector('.node-work-wrap');
    if (workWrap) workWrap.classList.toggle('hidden', workEl.children.length === 0);
    // Now that the rows are painted, a reader who was here before gets their offset
    // back. A locked card is pinned to its newest content by its caller, and
    // `_needsBottomScroll` is still the card opening at its newest content.
    if (!(card._itemScroll && card._itemScroll.locked) && !card._needsBottomScroll) {
      restoreScroll(workEl, keepWork);
    }
    // A re-render threw the old `<mark>`s away with the rows: put them back (once per
    // frame, and only while a find is open).
    if (findState.active) findScheduleMarks();
  }

  // ---- How the card's body is laid out -----------------------------------------
  // The card is a flex column: the head, the pinned ask, then the body, whose one
  // flexible child is the log (`.node-work`, the card's only scroller). A long turn
  // therefore scrolls *inside* the log and the card's own height stays within its cap
  // (`--node-max-h`, or the size the user dragged) — which is the whole reason no
  // zone has to be measured, pinned or settled any more: there is nothing competing
  // for the body, and the answer is the last block of the log like everything else.
  /**
   * The floor the card's flexible body may not be squeezed below. A card may not be
   * shrunk out of `header + prompt + composer + this`: the drag's own floor (`MIN_H`)
   * is a flat 260px, which a long prompt and the input pane already eat on their own,
   * and a log squeezed past that point could not be scrolled at all.
   */
  const SPLIT_FLOOR_PX = 220;

  /** Everything in the card except the log: head, the pinned ask, the composer, border. */
  function cardFixedHeight(card) {
    const head = card.querySelector('.node-head');
    const ask = card.querySelector('.node-ask');
    const composer = composerEl && composerEl.parentElement === card ? composerEl : null;
    return (
      (head ? head.offsetHeight || 0 : 0) +
      (ask ? ask.offsetHeight || 0 : 0) +
      (composer ? composer.offsetHeight || 0 : 0) +
      2 // the card's own top and bottom border
    );
  }

  // ---- Long transcripts: render the window the user is looking at --------------
  // A finished node with a long transcript used to render every one of its items in
  // one go — 150 items of markdown, tool cards and answers for a single sub-agent
  // card, every one of them built again on a cold repaint (2692 DOM nodes
  // measured). Past `VIRTUAL_ITEM_THRESHOLD` items a *finished* node renders only a
  // window: the items near the scroll position are real, the items above/below it
  // are a spacer element whose height stands in for them, and scrolling the
  // container extends the window one page at a time (rAF-throttled).
  //
  // A node that is still `running` is never windowed: its transcript is filled
  // incrementally as deltas arrive (`appendAssistant` writes into the live
  // container and reads its last child back to continue), so re-rendering it from
  // a slice would break the stream.
  const VIRTUAL_ITEM_THRESHOLD = 60; // items above which a finished node windows
  const VIRTUAL_WINDOW = 24; // items rendered at once
  const VIRTUAL_ITEM_PX = 72; // estimated height of one unrendered item
  const VIRTUAL_EXTEND_PX = 320; // extend when the viewport is this near an edge

  /**
   * A spacer standing in for `count` unrendered items above or below the window.
   * The size is inline because `.node-work` is a flex column: a spacer has no
   * content of its own and would otherwise shrink away to nothing.
   */
  function itemsSpacer(where, count, px) {
    const gap = el('div', 'node-items-spacer ' + where);
    gap.style.flex = '0 0 auto';
    gap.style.height = count * px + 'px';
    gap.dataset.items = String(count);
    return gap;
  }

  /**
   * Paint `state.start … state.end` of a long transcript into `container`: those
   * items are real DOM, everything outside the window is a spacer whose height
   * stands in for it, so the scrollbar still describes the whole transcript.
   *
   * Anything appended to the container *after* the window — a continued turn
   * streams into this very `.node-work` — is kept and put back at the end: a
   * scroll must never throw away the answer that is arriving right now.
   */
  function paintItemsWindow(container, state) {
    // Set before the first render: a scroll during the paint must find the state.
    container._virt = state;
    const items = state.items;
    const children = Array.prototype.slice.call(container.children);
    const keep = [];
    for (const child of children) {
      if (state.painted.indexOf(child) < 0 && child !== state.top && child !== state.bottom) keep.push(child);
    }
    for (const child of keep) container.removeChild(child);
    const above = state.start;
    const below = items.length - state.end;
    const prevMsg = messagesEl;
    const prevPrompt = promptEl;
    const prevOpen = openSteps;
    // A page of finished history is not the live turn: nothing here may pan the tree.
    suppressFollow = true;
    messagesEl = container;
    promptEl = state.promptEl;
    openSteps = null;
    state.top = null;
    state.bottom = null;
    try {
      container.innerHTML = '';
      if (above > 0) {
        state.top = itemsSpacer('above', above, state.px);
        container.appendChild(state.top);
      }
      for (let i = state.start; i < state.end; i++) renderItemInto(items[i]);
      if (below > 0) {
        state.bottom = itemsSpacer('below', below, state.px);
        container.appendChild(state.bottom);
      }
      for (const child of keep) container.appendChild(child);
    } finally {
      suppressFollow = false;
      openSteps = prevOpen;
      messagesEl = prevMsg;
      promptEl = prevPrompt;
    }
    state.painted = Array.prototype.slice.call(container.children);
    // Refine the estimate from what the window actually measures: a page of long
    // tool results is far taller than one of one-line answers, and the spacers are
    // what keeps the scrollbar honest at this size.
    let height = 0;
    let count = 0;
    for (const child of state.painted) {
      if (child === state.top || child === state.bottom) continue;
      const h = child.offsetHeight || 0;
      if (h > 0) {
        height += h;
        count++;
      }
    }
    if (count > 0 && height / count > 4) state.px = height / count;
    if (state.top) state.top.style.height = above * state.px + 'px';
    if (state.bottom) state.bottom.style.height = below * state.px + 'px';
  }

  /** rAF-throttled `scroll`: at most one window extension per frame. */
  function onItemsWindowScroll(container) {
    const state = container._virt;
    if (!state || state.raf != null) return;
    state.raf = requestAnimationFrame(() => {
      state.raf = null;
      if (container._virt === state) extendItemsWindow(container, state);
    });
  }

  /**
   * Extend the window towards the end the user reached, and keep the scroll position
   * on the text they are reading: the window that grew above the viewport added
   * exactly that much to the scroll height, and the window that grew below it added
   * nothing above — the same correction, read off the container itself, covers both.
   * (It used to be applied to the upward direction only.)
   */
  function extendItemsWindow(container, state) {
    const atTop = state.start > 0 && container.scrollTop <= VIRTUAL_EXTEND_PX;
    const atBottom =
      state.end < state.items.length &&
      container.scrollTop + container.clientHeight >= container.scrollHeight - VIRTUAL_EXTEND_PX;
    if (!atTop && !atBottom) return;
    const heightBefore = container.scrollHeight;
    const topBefore = container.scrollTop;
    if (atTop) state.start = Math.max(0, state.start - VIRTUAL_WINDOW);
    if (atBottom) state.end = Math.min(state.items.length, state.end + VIRTUAL_WINDOW);
    paintItemsWindow(container, state);
    container.scrollTop = Math.max(0, topBefore + (container.scrollHeight - heightBefore));
  }

  /**
   * Render one stored `DisplayItem` into the current target container
   * (`messagesEl`). **This is the same rendering the live path produces**, item by
   * item: a tool item goes through the one `addTool`, a thinking row through the one
   * `makeThinkingRow`, an answer through the one `addAssistant` — so a repaint of a
   * finished turn and the live turn that produced it cannot disagree about the DOM,
   * the labels, the verbs, the statuses or the usage lines. Nothing here re-derives
   * what to show: `title`, `status`, `ms`, `startedAt` and `usage` all travel on the
   * item, and the item's own fields are what the row shows.
   */
  function renderItemInto(item) {
    if (item.kind === 'user') {
      addUserPrompt(item.text, item.attachments);
    } else if (item.kind === 'harness') {
      addHarnessNote(item.text);
    } else if (item.kind === 'assistant') {
      // The usage of the turn is not painted per item any more: it is the card's docked
      // bar, written once from the node's own last usage (`syncUsageBar`).
      addAssistant(item.text, item.error, item.thinking);
    } else if (item.kind === 'notice') {
      // A notice the host keeps updating in place carries its identity with it, so a
      // repaint re-tags the element and the next message with that id rewrites this
      // block instead of appending a second one (the silent-retry marker).
      const notice = addNotice(item.noticeKind, item.text);
      if (notice && item.noticeId) notice.dataset.noticeId = item.noticeId;
    } else if (item.kind === 'background') {
      addBackgroundNotice(item);
    } else if (item.kind === 'tool') {
      const running = item.status === 'running';
      addTool({
        name: item.name,
        args: item.args,
        id: item.id || 'history-' + item.name + '-' + (item.status || ''),
        // The model's own label for the step, stored with the item on the host: it
        // survives the 8 KiB argument clip and every repaint.
        title: item.title,
        usage: item.usage,
        status: running ? 'running' : 'done',
        // The stored duration travels with the item: a repainted call that is still
        // running ticks again, a finished one shows the host's frozen value.
        start: running ? item.startedAt : null,
        ms: item.ms,
        content: !running ? item.content : undefined,
        // The line diff the host read out of the call's own result: the chip a repaint
        // draws is the one the live turn drew.
        diff: item.diff,
        // A done call still remembers when it ended, so an image row can say whether the
        // file was rewritten after it (the chip reads `start` only while running).
        since: !running && item.ms != null && item.startedAt != null ? item.startedAt + item.ms : null,
      });
    }
  }

  // ---- Background terminals: a flying job card, right of the owning node ----
  // A job belongs to the node whose turn spawned it, so it renders as its own
  // `kind: 'bg'` card in that node's sidecar grid (the same lattice the sub-agents
  // use). There is no dock at the bottom of the card any more (D4): one job, one
  // home. The host creates the card (a normal tree node) and drives it with the
  // flat `backgrounds` snapshot; the card survives delivery as a `Delivered`
  // record, so its terminal state is also persisted on the node itself.
  function shortCommand(cmd) {
    const s = String(cmd || '');
    return s.length > 60 ? s.slice(0, 60) + '…' : s;
  }

  /** task.id -> BackgroundInfo of the last snapshot (live jobs only). */
  /**
   * The session's live job snapshot, keyed by the **card** the host says mirrors each job
   * (`cardNodeId`). A `kind:'bg'` card resolves its job through this, never through its id: the
   * id is session-local and a card keeps its own in the store across a reload, so an id is not
   * an identity (`BackgroundHub.seedCounter` is the host's half of the same rule).
   */
  let bgTaskByCard = new Map();

  function killBackgroundButton(id) {
    const kill = el('button', 'bg-kill', tr('kill'));
    kill.title = tr('Kill background terminal {0}', id);
    kill.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // The id is session-local; the host resolves it inside this panel's session.
      vscode.postMessage({ type: 'killBackground', id });
    });
    return kill;
  }

  /**
   * One **turn status** as a card's pill shows it. `TurnStatus` is a `src/chat/tree.ts`
   * value (`pending` / `running` / `done` / `interrupted` / `error`), so the pill keeps it
   * in `data-status` — the CSS colours itself from that attribute — and only the *text*
   * goes through `tr()`. Writing the raw value was the one place a Chinese window still
   * read English on every card (`docs/agents/invariants/i18n.md`, "Protocol values that
   * are also UI strings"). The table asks `tr()` at load, so `check:l10n` sees every key.
   */
  const STATUS_LABELS = {
    pending: tr('pending'),
    running: tr('running'),
    done: tr('done'),
    interrupted: tr('interrupted'),
    error: tr('error'),
  };

  /** The pill's text for a turn status; an unknown value keeps its own word. */
  function statusLabel(status) {
    const label = STATUS_LABELS[status];
    return label ? label : String(status || '');
  }

  function statusTextFor(task, meta) {
    if (task && task.status === 'running') return tr('running');
    if (task && task.pendingDelivery) return tr('pending delivery');
    if (task && task.killed) return tr('killed');
    if (task) return tr('exit {0}', task.exitCode != null ? task.exitCode : '?');
    // No live snapshot: the job is over (its card is a record now).
    if (meta && meta.bgKilled) return tr('killed');
    if (meta && meta.bgExitCode != null) return tr('exit {0}', meta.bgExitCode);
    return meta && meta.status ? statusLabel(meta.status) : tr('finished');
  }

  /** Output tail: the live snapshot when the job runs, else the stored terminal one. */
  function outputTailFor(task, meta) {
    if (task && task.outputTail) return task.outputTail;
    return (meta && meta.bgOutputTail) || '';
  }

  /**
   * One job as the **body** every job view renders, from either source: the owning
   * node's meta + the session snapshot (a `kind:'bg'` card) or one `backgroundsGlobal`
   * row (the dock). Both shapes name the same facts, so this normalisation is what lets
   * the two views share one builder instead of growing a second copy of the status row,
   * the command and the output tail.
   *
   * `startedAt` is live-only and `elapsedMs` frozen-only: the chip ticks from the host
   * clock while the job runs and stops at the host's own number when it ends.
   */
  function bgJobOf(meta, task) {
    const running = !!(task && task.status === 'running');
    const id = task ? Number(task.id) : meta && meta.bgTaskId != null ? Number(meta.bgTaskId) : null;
    let elapsedMs = null;
    if (!running) {
      if (task && typeof task.finishedAt === 'number') elapsedMs = task.finishedAt - task.startedAt;
      else if (meta && typeof meta.bgElapsedMs === 'number') elapsedMs = meta.bgElapsedMs;
    }
    return {
      id,
      running,
      command: (meta && meta.bgCommand) || (task && task.command) || '',
      pending: !!(task && task.pendingDelivery),
      statusText: statusTextFor(task, meta),
      startedAt: running && task ? task.startedAt : null,
      elapsedMs,
      tail: outputTailFor(task, meta),
    };
  }

  /**
   * **The one job body**: the status row (`#<id>`, the status word and the elapsed
   * chip), the command line and the output tail — the three parts of a background
   * terminal that the owning node's `kind:'bg'` card and the window-global dock row
   * both render, so the two can never describe one job differently.
   *
   * Returns the elements; the caller decides where they go (the card's work zone, a
   * dock row's body) and adds whatever only it can say (the card's head button, the
   * dock's session title).
   */
  function buildBgBody(job) {
    const row = el('div', 'bg-card-status');
    row.appendChild(el('span', 'bg-card-id', '#' + (job.id != null ? job.id : '')));
    row.appendChild(el('span', 'bg-status' + (job.pending ? ' pending' : ''), job.statusText));
    syncElapsed(row, 'bg-elapsed', job.startedAt, job.elapsedMs);
    const parts = [row, el('div', 'bg-card-cmd', job.command)];
    if (job.tail) {
      parts.push(el('pre', 'bg-output', job.tail));
    }
    return parts;
  }

  /**
   * (Re)build one job card's body from the tree node + the latest snapshot. The
   * card's head is created once by `createNodeCard`; the body is small enough to
   * rebuild on every snapshot (the host coalesces them to ~5/s at most).
   */
  function renderBgBody(card, meta) {
    if (!card) return;
    // The `shared` badge is a property of the *job* (detached or not), so it is synced
    // wherever a job card is rendered — the snapshot, a `tree`, a `path` — and not only
    // while the job is in the snapshot (see `syncSharedBadge`).
    syncSharedBadge(card, meta);
    const task = meta && meta.id != null ? bgTaskByCard.get(String(meta.id)) ?? null : null;
    const itemsEl = card.querySelector('.node-work');
    if (!itemsEl) return;
    // A job card's body is a terminal mirror, not a conversation: the log *is* the
    // body (status row, command, output tail), so it must stay visible even before the
    // first snapshot has anything to show.
    const workWrap = card.querySelector('.node-work-wrap');
    if (workWrap) workWrap.classList.remove('hidden');
    itemsEl.innerHTML = '';
    const job = bgJobOf(meta, task);
    const running = job.running;
    card.classList.toggle('bg-running', running);
    card.classList.toggle('bg-done', !running);

    const statusEl = card.querySelector('.node-status');
    if (statusEl) statusEl.textContent = job.statusText;

    // The body itself — status row, command, output tail — is the **shared** job body
    // (`buildBgBody`), the same one the window-global dock renders on every tab.
    for (const part of buildBgBody(job)) {
      itemsEl.appendChild(part);
    }

    // Only a live job can be killed.
    const existing = byClass(card, 'bg-kill');
    if (running && !existing) {
      const head = card.querySelector('.node-head');
      const kill = killBackgroundButton(meta.bgTaskId);
      const del = head.querySelector('.node-del');
      if (del) head.insertBefore(kill, del); else head.appendChild(kill);
    } else if (!running && existing) {
      existing.remove();
    }
  }

  /**
   * `backgrounds`: one flat snapshot of the session's live jobs, each tagged with
   * the node that owns it and with the card that mirrors it. Patch every job card
   * in place; jobs the snapshot no longer lists keep their persisted terminal state.
   */
  function renderBackgrounds(tasks, legacy) {
    bgTaskByCard = new Map();
    for (const task of tasks || []) {
      if (!task || task.id == null) continue;
      // Legacy shape (an older host): no owner is named, so the jobs belong to the
      // focused node — the only node a one-run host could have spawned them from.
      if (legacy && !task.nodeId) task.nodeId = treeActiveId;
      // The host says **which card mirrors this job**, and that pair, not the id, is what a
      // card is. Ids are session-local, and a reused one (`BackgroundHub.seedCounter` keeps
      // that from happening) must never make a card adopt a job it does not own.
      if (task.cardNodeId) bgTaskByCard.set(String(task.cardNodeId), task);
    }
    let touched = false;
    for (const id in treeNodes) {
      const meta = treeNodes[id];
      if (!meta || meta.kind !== 'bg') continue;
      renderBgBody(nodeEls[id], meta);
      touched = true;
    }
    // The card's height feeds the layout, so re-place the tree when a job changed
    // (debounced: the host coalesces snapshots).
    if (touched) scheduleLayout();
  }

  // ---- The window-global terminal dock -----------------------------------------
  // Every background command of the **window** — every session, whatever tab is in
  // front — is one fixed list at the top-right of every chat tab (`#term-dock`). It is
  // not a second notion of a job: a row renders the **same** body the owning node's
  // `kind:'bg'` card renders (`buildBgBody`), plus the session it came from, and the
  // host is the one that decides what the list holds (a removed job never arrives).
  // Nothing in this path re-lays out the tree: the dock is fixed and outside the canvas,
  // so a job that prints cannot move it.
  const termDockEl = document.getElementById('term-dock');
  const termDockHeadEl = document.getElementById('term-dock-head');
  const termDockLabelEl = document.getElementById('term-dock-label');
  const termDockClearEl = document.getElementById('term-dock-clear');
  const termDockListEl = document.getElementById('term-dock-list');
  /** Collapsed? A local preference: the dock's height is the reader's, not the host's. */
  let termDockCollapsed = false;
  /** rowKey -> { el, sig }: a row is rebuilt only when its own facts changed. */
  const termDockRows = new Map();

  /** A job's identity in the window: task ids are session-local, so the pair is the key. */
  function termDockKey(job) {
    return String(job.sessionId || '') + '\u0000' + String(job.id);
  }

  /** Everything one row renders, as one comparable string (an unchanged row is not touched). */
  function termDockSignature(job) {
    return JSON.stringify([
      job.sessionTitle,
      job.command,
      job.status,
      job.exitCode,
      job.killed === true,
      job.detached === true,
      job.startedAt,
      job.finishedAt,
      job.outputTail,
      job.delivered === true,
      job.cardNodeId,
    ]);
  }

  /**
   * A `backgroundsGlobal` row as the shared body's job view. The row is the host's
   * **composed** record of a job, so its status word comes from the same
   * `statusTextFor` the card uses (fed a task-shaped object): `running`, `pending
   * delivery`, `killed` and `exit {0}` mean the same thing in both places, because it
   * is the same function that says them.
   */
  function bgJobOfDockRow(job) {
    const running = job.status === 'running';
    const finishedAt = typeof job.finishedAt === 'number' ? job.finishedAt : null;
    const task = {
      status: running ? 'running' : 'finished',
      // A finished job whose notice has not reached its reader yet: on the card this is
      // the live task's `pendingDelivery`, and the host ships the same fact as `delivered`.
      pendingDelivery: !running && job.delivered !== true,
      killed: job.killed === true,
      exitCode: job.exitCode != null ? job.exitCode : null,
    };
    return {
      id: job.id,
      running,
      command: job.command || '',
      pending: task.pendingDelivery,
      statusText: statusTextFor(task, null),
      startedAt: running ? job.startedAt : null,
      elapsedMs: running ? null : finishedAt != null ? finishedAt - job.startedAt : null,
      tail: job.outputTail || '',
    };
  }

  /** One dock row: where it came from, its badges, its action, and the shared job body. */
  function paintTermDockRow(entry, job) {
    const row = entry.el;
    row.innerHTML = '';
    row.className = 'term-dock-row' + (job.status === 'running' ? ' running' : '');
    const head = el('div', 'term-dock-row-head');
    head.appendChild(el('span', 'term-dock-session', job.sessionTitle || ''));
    if (job.detached === true) {
      // The same translated `Global job` badge the card wears, with the same sentence: it
      // says the job's lifecycle is bound to this window, not to a node.
      const badge = el('span', 'node-shared-badge', tr('Global job'));
      badge.title = globalJobTitle();
      head.appendChild(badge);
    }
    if (job.delivered === true) {
      head.appendChild(el('span', 'node-delivered-badge', tr('Delivered')));
    }
    const actions = el('div', 'term-dock-actions');
    if (job.status === 'running') {
      const kill = el('button', 'bg-kill', tr('kill'));
      kill.title = tr('Kill background terminal {0}', job.id);
      kill.addEventListener('click', (ev) => {
        ev.stopPropagation();
        // Task ids are session-local, so the session travels with the id: the dock can
        // kill a job of a session that is not the one this tab shows.
        vscode.postMessage({ type: 'killBackground', sessionId: job.sessionId, id: job.id });
      });
      actions.appendChild(kill);
    } else if (job.cardNodeId) {
      const dismiss = el('button', 'term-dock-dismiss', '✕');
      dismiss.title = tr('Stop listing this terminal (the record stays)');
      dismiss.addEventListener('click', (ev) => {
        ev.stopPropagation();
        vscode.postMessage({
          type: 'dismissBackground',
          sessionId: job.sessionId,
          cardNodeId: job.cardNodeId,
        });
      });
      actions.appendChild(dismiss);
    }
    head.appendChild(actions);
    row.appendChild(head);
    const body = el('div', 'term-dock-body');
    for (const part of buildBgBody(bgJobOfDockRow(job))) {
      body.appendChild(part);
    }
    row.appendChild(body);
  }

  /**
   * `backgroundsGlobal`: the whole window's jobs, on every tab.
   *
   * A row whose signature did not move is left alone (a job that prints rebuilds only
   * its own row), a row that left the list is dropped, and the header says how many jobs
   * run. Order is the host's (running first, newest first), so the client only moves the
   * rows that are out of place. The dock hides itself when it holds nothing: an empty
   * frame at the top of every tab would be noise, not a feature.
   */
  function renderTerminalDock(jobs) {
    if (!termDockEl || !termDockListEl) return null;
    const rows = [];
    const seen = new Set();
    for (const job of jobs || []) {
      if (!job || job.id == null) continue;
      // A dismissed job belongs to no dock. The host already leaves them out; the check
      // here is what makes a host that sends one unable to resurrect a removed row.
      if (job.dismissed === true) continue;
      const key = termDockKey(job);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(job);
    }
    for (const [key, entry] of [...termDockRows]) {
      if (!seen.has(key)) {
        entry.el.remove();
        termDockRows.delete(key);
      }
    }
    for (const job of rows) {
      const key = termDockKey(job);
      const sig = termDockSignature(job);
      let entry = termDockRows.get(key);
      if (!entry) {
        entry = { el: el('div', 'term-dock-row'), sig: '' };
        termDockRows.set(key, entry);
        termDockListEl.appendChild(entry.el);
      }
      if (entry.sig !== sig) {
        entry.sig = sig;
        paintTermDockRow(entry, job);
      }
    }
    // Put the rows in the host's order, touching only what is out of place.
    const wanted = [];
    for (const job of rows) {
      const entry = termDockRows.get(termDockKey(job));
      if (entry) wanted.push(entry.el);
    }
    for (let i = 0; i < wanted.length; i++) {
      const current = termDockListEl.children[i];
      if (current !== wanted[i]) {
        termDockListEl.insertBefore(wanted[i], current || null);
      }
    }
    const running = rows.filter((job) => job.status === 'running').length;
    if (termDockLabelEl) {
      const text = tr('Terminals · {0} running', running);
      if (termDockLabelEl.textContent !== text) termDockLabelEl.textContent = text;
    }
    termDockEl.classList.toggle('hidden', rows.length === 0);
    if (termDockClearEl) {
      termDockClearEl.classList.toggle('hidden', rows.length - running === 0);
    }
    return { rows: rows.length, running };
  }

  /** Collapse or expand the dock body (a local preference; the header keeps the count). */
  function setTermDockCollapsed(collapsed) {
    termDockCollapsed = collapsed === true;
    if (!termDockEl) return;
    termDockEl.classList.toggle('collapsed', termDockCollapsed);
    if (termDockHeadEl) {
      termDockHeadEl.setAttribute('aria-expanded', termDockCollapsed ? 'false' : 'true');
    }
  }

  /**
   * The dock's two controls: the header folds it (a long list must not cover the tree),
   * and `Clear finished` removes every finished job of the window from it — the cards
   * themselves stay, and a running job is never removed.
   */
  function wireTerminalDock() {
    if (termDockHeadEl) {
      termDockHeadEl.addEventListener('click', () => setTermDockCollapsed(!termDockCollapsed));
    }
    if (termDockClearEl) {
      termDockClearEl.addEventListener('click', (ev) => {
        ev.stopPropagation();
        vscode.postMessage({ type: 'clearFinishedBackgrounds' });
      });
    }
    setTermDockCollapsed(false);
  }

  // ---- Tree rendering ----
  /**
   * A sidecar that has handed its result over shows a `Delivered` badge (D1): the
   * agent already saw this completion (a background notice was injected, a
   * sub-agent's summary came back as a tool result). Created/removed lazily so a
   * tree repaint never accumulates badges.
   */
  function applyDeliveredBadge(card, meta) {
    if (!card) return;
    const wanted = !!(meta && meta.delivered && isSidecarKind(meta.kind));
    let badge = byClass(card, 'node-delivered-badge');
    if (wanted && !badge) {
      badge = el('span', 'node-delivered-badge', tr('Delivered'));
      const head = card.querySelector('.node-head');
      const status = head.querySelector('.node-status');
      if (status) head.insertBefore(badge, status); else head.appendChild(badge);
    } else if (!wanted && badge) {
      badge.remove();
    }
    card.classList.toggle('delivered', wanted);
  }

  /**
   * The `Global job` badge: this job is **detached** — fire-and-forget, bound to this
   * **VS Code window** rather than to the node that started it. The card is still owned by
   * the node that started it and keeps updating (it is the only place the job is visible
   * at all), but the job locks no node (no Stop in the composer) and never notifies: no
   * completion notice will ever reach the agent, which reads the outcome with
   * `check_command` or `wait_for_command` if it wants it.
   *
   * Both the word and the sentence are translated — a badge is a word a reader has to act
   * on, not a Latin initial (`docs/agents/invariants/i18n.md`). Placed just before the
   * status chip and created/removed lazily, so a repaint can never stack two of them. The
   * badge is a property of the *job*, so it is synced wherever a job card is rendered —
   * the snapshot, a `tree`, a `path` — and not only while the job is in the snapshot.
   * (It used to say `global`, which described nothing the reader could place.)
   *
   * `meta.bgDetached` is the host's judgement (`treeMessage` reads it off the live
   * task), never re-derived here — and it is absent for a card restored after a
   * restart, because that card has no live job to be detached from.
   */
  function syncSharedBadge(card, meta) {
    if (!card) return;
    const wanted = !!(meta && meta.kind === 'bg' && meta.bgDetached === true);
    let badge = byClass(card, 'node-shared-badge');
    if (wanted && !badge) {
      badge = el('span', 'node-shared-badge', tr('Global job'));
      badge.title = globalJobTitle();
      const head = card.querySelector('.node-head');
      const status = head.querySelector('.node-status');
      if (status) head.insertBefore(badge, status); else head.appendChild(badge);
    } else if (!wanted && badge) {
      badge.remove();
    }
  }

  /**
   * The one sentence the `Global job` badge wears, whichever view renders it: the card
   * head and the window dock used to say it two slightly different ways, and one of them
   * forgot `wait_for_command`.
   */
  function globalJobTitle() {
    return tr('This job is bound to this VS Code window: it does not block the composer and will not notify the agent; read its result with check_command or wait_for_command.');
  }

  /**
   * The sub-agent badge: `Sub-agent` for a worker that may write, `Research sub-agent`
   * for the read-only one. Both are translated — a 9px pill of Latin initials said
   * nothing to a reader of Chinese — and the two kinds are deliberately different words,
   * because "it can change my files" is the one fact a reader wants off this head.
   *
   * The badge is derived from the node (`kind: 'agent'` + `agentWrite`), not from a live
   * event, so a card restored from a stored tree wears it too; a card created for a run
   * that just started carries the flag in the event, and `syncAgentBadge` is the one
   * place either shape lands.
   */
  function syncAgentBadge(card, meta) {
    if (!card || !meta || meta.kind !== 'agent') return;
    const head = card.querySelector('.node-head');
    if (!head) return;
    const write = meta.agentWrite === true;
    const label = write ? tr('Sub-agent') : tr('Research sub-agent');
    let badge = byClass(card, 'node-agent-badge');
    if (!badge) {
      badge = el('span', 'node-agent-badge', label);
      const status = head.querySelector('.node-status');
      if (status) head.insertBefore(badge, status); else head.appendChild(badge);
    } else if (badge.textContent !== label) {
      badge.textContent = label;
    }
    badge.title = write
      ? tr('Sub-agent: it runs its own conversation in parallel and can change files')
      : tr('Research sub-agent: it runs its own conversation in parallel and only reads');
  }

  /**
   * The context badge on a card head: `New context` for a node that *starts* a context
   * window, `Context compression` for a **compression node** (which starts a window of its
   * own too, but is a turn whose whole job is the handoff) — and the dashed edge above it
   * is the rest of the story (`docs/agents/invariants/context-rollover.md`,
   * `docs/agents/invariants/compress-node.md` §5). Both words are translated: neither the
   * rollover nor the compression has a shorthand a Chinese reader already knows, and
   * `CTX` / `CMP` were two more Latin initials on a card that is otherwise in Chinese.
   * Created lazily, like every other head badge, so a repaint never accumulates them, and
   * placed the way `SUB` / `Delivered` are: just before the status chip.
   */
  function syncCtxBadge(card, meta) {
    if (!card) return;
    // Self-equality is the contract's own validity test (`tree.ts contextBase()`): a
    // stored marker that does not name this node opens no window at all, so the card
    // must not claim one either.
    const windowStart = !!(meta && meta.contextBaseId && meta.contextBaseId === meta.id);
    const compress = !!meta && meta.role === 'compress';
    const label = compress ? tr('Context compression') : tr('New context');
    let badge = byClass(card, 'node-ctx-badge');
    if (windowStart && !badge) {
      badge = el('span', 'node-ctx-badge', label);
      badge.title = compress
        ? tr('This node compresses the window above it; the window below it starts from the handoff it writes')
        : tr('This node starts a new context window; the branch above it is not sent to the model any more');
      const head = card.querySelector('.node-head');
      const status = head.querySelector('.node-status');
      if (status) head.insertBefore(badge, status); else head.appendChild(badge);
    } else if (!windowStart && badge) {
      badge.remove();
    } else if (badge && badge.textContent !== label) {
      // A card is created once, but the label is derived from the node's role: keep them in
      // step in case the badge arrived before the role did.
      badge.textContent = label;
    }
  }

  /** A compression card that already carries its handoff: green, and it hosts the composer. */
  function syncHandoffCard(card, meta) {
    if (!card) return;
    card.classList.toggle('handoff-ready', !!(meta && meta.role === 'compress' && meta.handoffReady));
  }

  /**
   * The **prompt-cache** colour of one card: `#4daafc` when every token of its requests came
   * out of the provider's cache, `#fc4d5f` when none did, and `#f14dfc` halfway — a red →
   * purple → blue two-stop ramp over the whole range, because a direct red → blue lerp
   * passes through grey in the middle and a grey outline says nothing.
   *
   * The stop positions are the specified ones: 100 % blue, 50 % purple, 0 % red. The
   * percentage itself is the **host's** number (`nodeCacheRate`, shipped as `cachePct`, all of
   * the card's own requests combined); this function only paints it. `null` is not a colour: a
   * card whose provider reports no cache fields keeps the theme's accent, because an unknown
   * rate must not be drawn as a bad one.
   */
  const CACHE_BLUE = [0x4d, 0xaa, 0xfc];
  const CACHE_PURPLE = [0xf1, 0x4d, 0xfc];
  const CACHE_RED = [0xfc, 0x4d, 0x5f];
  function cacheColor(pct) {
    const t = Math.max(0, Math.min(1, pct / 100));
    // Above the midpoint the ramp is purple → blue, below it red → purple; both halves are
    // a plain channel lerp in the 0-255 space, which is what the hex stops above describe.
    const [from, to, k] = t >= 0.5 ? [CACHE_PURPLE, CACHE_BLUE, (t - 0.5) / 0.5] : [CACHE_RED, CACHE_PURPLE, t / 0.5];
    const channel = (i) =>
      Math.round(from[i] + (to[i] - from[i]) * k)
        .toString(16)
        .padStart(2, '0');
    return '#' + channel(0) + channel(1) + channel(2);
  }

  /**
   * Paint the colour a card's **meta** says. A render, a reload and a `nodeUpdate` all come
   * through here; a live `usage` message paints the property directly from the rate it
   * carries (`setCardUsage`), so the two write the same one value.
   */
  function syncCacheColor(card, meta) {
    paintCacheColor(card, meta && typeof meta.cachePct === 'number' ? meta.cachePct : undefined);
  }

  /**
   * Write the colour onto the card itself. It is one property (`--cache-color`) that both the
   * checked-out card's outline (`.node.active`) and its docked usage bar's rate segment
   * (`.usage-rate`) read, and it is painted from whatever rate is current: a live `usage`
   * message repaints it mid-turn as well (`setCardUsage`), so the ring and the segment are the
   * right colour **while the turn runs**, not only once the `nodeUpdate` ending it has arrived.
   * No property at all when the rate is unknown — the outline falls back to the accent and the
   * bar shows no segment.
   */
  function paintCacheColor(card, pct) {
    if (!card || !card.style || !card.style.setProperty) return;
    if (typeof pct !== 'number') {
      if (card.style.removeProperty) card.style.removeProperty('--cache-color');
      return;
    }
    card.style.setProperty('--cache-color', cacheColor(pct));
  }

  /**
   * The card's **docked usage bar**: the token line of the turn that concluded the card,
   * pinned between the log and the composer rather than scrolling away inside the log. It is
   * written from the node's own last usage (`meta.usage`, the same number the host ships), so
   * a reload, a summarised render and a live turn all end up with the same bar; the rate
   * segment comes from the card's `cachePct`, or from the rate a live `usage` message carries
   * — and that live rate is painted onto the card too, so the segment is coloured the moment
   * the request is counted.
   */
  function setCardUsage(card, usage, pct) {
    if (!card) return null;
    const bar = byClass(card, 'node-usage');
    if (!bar) return null;
    if (!usage) {
      bar._usage = undefined;
      bar.textContent = '';
      bar.classList.add('hidden');
      return bar;
    }
    const id = card.dataset ? card.dataset.id : '';
    const meta = id ? treeNodes[id] : null;
    // A live `usage` message carries the rate after that request; a render reads it from the
    // card's own meta. `undefined` means "not given", `null` means "the provider reports none".
    const rate = pct === undefined ? (meta && typeof meta.cachePct === 'number' ? meta.cachePct : undefined) : pct;
    const known = typeof rate === 'number' ? rate : undefined;
    // The one property both the outline and the segment read, from the rate that is current
    // right now: mid-turn this is the live one, on a render it is the card's own.
    paintCacheColor(card, known);
    bar.classList.remove('hidden');
    usageLineInto(bar, usage, known);
    return bar;
  }

  /**
   * What the bar reads **before the first request of a turn is counted**: every number is
   * `~`, because the provider has not said anything yet, and the rate has no colour to take.
   * It is shown while the card's turn runs (`syncUsageBar`), so the dock is there from the
   * first thinking row onwards instead of appearing out of nowhere when the usage lands.
   */
  function showUsagePlaceholder(card) {
    const bar = card && byClass(card, 'node-usage');
    if (!bar) return null;
    bar._usage = undefined;
    bar.classList.remove('hidden');
    bar.textContent = tr('Prompt: {0} / Completion: {1}, Cache Hit: {2} / Miss: {3}', '~', '~', '~', '~');
    const rate = el('span', 'usage-rate');
    rate.textContent = tr('Cache Hit Rate: ~');
    bar.appendChild(rate);
    // Nothing is known, so the ring and the segment keep the neutral colour.
    paintCacheColor(card, undefined);
    return bar;
  }

  /** Put the card's own totals in its bar, or its `~` placeholder, or take the bar away. */
  function syncUsageBar(card, meta) {
    if (!card) return;
    const usage = meta && meta.usage;
    if (usage) {
      setCardUsage(card, usage);
      return;
    }
    if (meta && meta.status === 'running') {
      showUsagePlaceholder(card);
      return;
    }
    setCardUsage(card, undefined);
  }

  function pathIdsFromTree(nodes, activeId) {
    const out = [];
    const seen = new Set();
    let cur = activeId;
    while (cur && !seen.has(cur) && nodes[cur]) {
      seen.add(cur);
      out.push(cur);
      cur = nodes[cur].parentId;
    }
    return out.reverse();
  }

  function createNodeCard(id, meta) {
    const card = el('div', 'node');
    card.dataset.id = id;
    // A persisted custom size (from a previous drag-resize) wins over the CSS default.
    if (meta.size && meta.size.w && meta.size.h) {
      card.style.width = meta.size.w + 'px';
      card.style.maxHeight = meta.size.h + 'px';
    }
    const head = el('div', 'node-head');
    const title = el('span', 'node-title', meta.title || tr('(no title)'));
    const status = el('span', 'node-status', statusLabel(meta.status));
    status.dataset.role = 'status';
    head.appendChild(title);
    head.appendChild(status);
    // RMB on the header opens *our* menu (copy this node's id) instead of VS
    // Code's: the header is `user-select: none` (style.css), so the host menu has
    // nothing to offer there, while the transcript below keeps it -- see
    // `openNodeMenu` and the capture-phase `contextmenu` listener that suppresses
    // the host menu over `.node-head`.
    head.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openNodeMenu(ev.clientX, ev.clientY, id);
    });
    // Delete-branch button: hover-revealed (see .node-del), so a destructive
    // action is not one stray click away. The host asks for a modal confirmation
    // before it removes anything (history + transcript dumps).
    //
    // A **resume** window has none: its branch is the compression chain's, and the host
    // refuses to delete it on its own (`docs/agents/invariants/compress-node.md` §5). The
    // compression node above it keeps its 🗑, and deleting it takes this window with it.
    if (!meta || meta.role !== 'resume') {
      const del = el('button', 'node-del', '🗑');
      del.title = tr('Delete this branch — this turn and everything below it');
      del.addEventListener('click', (ev) => {
        ev.stopPropagation();
        vscode.postMessage({ type: 'deleteBranch', id });
      });
      head.appendChild(del);
    }
    card.appendChild(head);
    // A window-starting node carries its context marker from the moment its card
    // exists (it is created once, here, and never rebuilt), and so does a sub-agent
    // card its `Sub-agent` / `Research sub-agent` badge — a card restored from a
    // stored tree must wear the same head a live one does. A compression card whose
    // handoff is already in starts green for the same reason.
    syncCtxBadge(card, meta);
    syncHandoffCard(card, meta);
    syncCacheColor(card, meta);
    syncUsageBar(card, meta);
    syncAgentBadge(card, meta);

    // The pinned user ask (sticky at the top of an expanded card).
    const ask = el('div', 'node-ask');
    card.appendChild(ask);

    const body = el('div', 'node-body');
    // The work log: **the card's one scroller**, and the whole of the turn inside it —
    // the thinking rows, the tool rows, the notices, the `HARNESS` blocks and the
    // final markdown answer, in the order they happened. Its wrapper (not the scroller
    // itself) carries the `hidden` class an empty log wears and hosts the green
    // scroll-lock dot: the dot marks the strip under the log (the container it locks),
    // which is where a live turn follows its own output.
    const workWrap = el('div', 'node-work-wrap');
    const work = el('div', 'node-work');
    // A compression node's answer **is** the handoff — a full execution brief, and it can run
    // to tens of thousands of characters. That card (and only that card) boxes its answer in a
    // scroller of its own, so the log still reads as a log instead of one wall between the
    // steps and the next turn (`docs/agents/invariants/compress-node.md` §6).
    if (meta && meta.role === 'compress') {
      work.classList.add('compress-answer');
    }
    workWrap.appendChild(work);
    const excerpt = el('div', 'node-excerpt');
    excerpt.textContent = meta.preview || meta.title || '';
    // The **docked usage bar** (see `setCardUsage`): the token line of the turn that
    // concluded this card, pinned between the log and the composer so it never scrolls out of
    // sight with the log. It carries `.usage-line` for the type and the colour dot, and keeps
    // its own name because it is placed differently from the footnotes it grew out of.
    const usageBar = el('div', 'usage-line node-usage hidden');
    // The "its content is on its way" strip (see `setCardLoading`): the one place a
    // card says it is waiting rather than done. It is created with the card and never
    // rebuilt, its label is the one user-visible string this adds, and the CSS shows it
    // only on an *expanded* card that is loading — a collapsed card is its preview.
    const loading = el('div', 'node-loading');
    // The same per-character wave a running step's verb uses (see `.node-loading .w` in
    // the stylesheet): the wait reads as work in progress rather than as a dead screen.
    setVerbText(loading, tr('Loading…'));
    // Order matters: loading, log, the docked bar, the collapsed preview — the preview is
    // what a collapsed card shows *instead* of the log and the bar.
    body.appendChild(loading);
    body.appendChild(workWrap);
    body.appendChild(usageBar);
    body.appendChild(excerpt);
    card.appendChild(body);
    // The bar is written from the node's own last usage, the same number the host ships.
    syncUsageBar(card, meta);

    // Drag handle to resize the card (bottom-right).
    const handle = el('div', 'node-resize');
    handle.title = tr('Drag to resize');
    card.appendChild(handle);

    // The log's scroll + green lock dot. A live turn follows its own output (locked); a
    // finished node starts unlocked so it scrolls freely.
    card._itemScroll = attachLock(work, workWrap, meta.status === 'running');

    // The log remembers where its reader is (`rememberScroll`): a repaint or a window
    // extension puts them back — see the memory block at the top.
    rememberScroll(work);

    nodeEls[id] = card;
    // The node id on the element itself: the off-screen-skip observer (`cvObserver`) and the
    // "wake this card before writing into it" hook both hold an element and need its id.
    card._nodeId = id;
    treeCanvas.appendChild(card);
    if (cvObserver) cvObserver.observe(card);
  // The unload/watch pair (see `virtObserver`): a card far off screen gives its content
  // back and asks for it again on the way in.
  if (virtLoadObserver) virtLoadObserver.observe(card);
  if (virtUnloadObserver) virtUnloadObserver.observe(card);
    // Every card is watched by the one card observer as well (see `cardResizeObserver`):
    // any card that grows after the last layout pass leaves the tree with stale boxes,
    // whatever grew it. Observed after `_nodeId` is set, because the observer reads a
    // card's id back off its element.
    cardObserve(card);
    return card;
  }

  // ---- Lazy items: only a few requests in flight at once ----------------------
  // An expanded card whose content is not in hand asks for it once — `_itemsRequested`
  // is the one-shot contract, and this queue changes only *when* that one request is
  // posted. Three kinds of card can be left without their log:
  //
  //  - a `kind: 'agent'` node ships no transcript in the `tree` / `path` payload (only
  //    `itemCount`), so its card fetches it with `loadAgentItems`;
  //  - a **regular** node's items normally ride in the `path`, and a session switch posts
  //    the `tree` a task earlier: a card built from that `tree` alone holds no items at
  //    all, and used to stay `work:0 ans:0` next to a `preview` that promised a full
  //    session — a card with nothing in it is indistinguishable from an empty, finished
  //    node. That card now asks with `loadNodeItems` and the host answers `nodeItems` (the
  //    same clipped `displayItems` the `path` would have carried,
  //    `SessionRuntime.postItems`).
  //  - a **finished regular** node's row carries a *summary* of its log instead of the log
  //    (`summary: true`, see `itemsSource`): the card renders what it has, and asks for
  //    the rest with that same `loadNodeItems` the first time it is expanded. So
  //    `_itemsRendered` no longer means "the real items are here" on its own —
  //    `_itemsSummary` is the other half of that pair, and it is what `itemsWanted` reads
  //    to keep this request from being dropped as redundant.
  //    A card the turn's own stream wrote into is not one of these: `_itemsRendered` is set
  //    where that append lands (`routeTo`), so the summary of a finished row never replaces
  //    a log that is already on screen, and there is nothing to ask for.
  //
  // A burst is what the cap is for. A cold repaint re-expands every sidecar card of a
  // session at once, and that used to fire every request in the same burst: one measured
  // session (15 sub-agent cards) asked for 152 items each — ~5.35 M chars of answers and
  // 2692 DOM nodes in one frame, with the webview's handlers stuck at 900–999 ms while
  // they landed. A local session switch has the same shape for regular cards (`tree`
  // first, the `path` that describes them a task later), so all of it is queued: at most
  // `ITEMS_CONCURRENCY` are in flight, and an answer releases the next one. A summarised
  // card goes through the same queue: the `path` that lands after the `tree` renders its
  // summary, which is *not* an answer to the request, so the queue must keep it (see
  // `itemsWanted`) and post it — while a plain card's request is still dropped unposted
  // the moment a `path` really fills it.
  //
  // Two rules keep the burst honest:
  //  - a repaint that needs exactly one *agent* transcript is not a burst: that request
  //    still goes out immediately (the contract the sidecar section of
  //    `tools/check-webview.js` pins);
  //  - where there *is* a layout (`IntersectionObserver`) only a card the user can see
  //    is worth a multi-hundred-KB answer: a card that enters the viewport is promoted
  //    ahead of the queue, and a card that is off-screen is never asked for —
  //    panning/zooming to it is what makes it ask. A regular card always goes through
  //    the queue, which is what also lets the `path` of a session switch fill it before
  //    the request is posted (`itemsWanted` drops it unasked).
  //
  // `itemsInFlight` counts every posted request, immediate ones included, so every
  // answer releases a slot. `reset` (a new session) drops the queue: those cards are
  // gone with the old tree.
  const ITEMS_CONCURRENCY = 3;

  // ---- The view is moving: nothing expensive happens under the gesture ---------
  // A free-spinning wheel (a G502's turbo scroll with alt) sends dozens of events a second,
  // and every card that crosses the viewport used to turn into a fetch *and* a synchronous
  // render: a transcript laid out, the tree re-placed, then the next answer. That is the
  // stutter the wheel produces, and none of it is needed while the reader is still moving —
  // a card flying past is not being read. So the camera records when it last moved, and
  // while it moves the answers are held (the card keeps its loading strip) and the unloads
  // wait; one timer, a quarter second after the last movement, lets everything resume.
  const VIEW_MOVE_MS = 250;
  const DEFERRED_RENDER_BATCH = 3;
  /** How long the composited-layer hint outlives the last camera move (see `body.panning`). */
  const PAN_SETTLE_MS = 200;
  let lastViewMoveAt = -1e9;
  let viewIdleTimer = null;
  let deferredItemsTimer = null;
  let panClassTimer = null;

  /** Is the camera still settling from a move? */
  function viewMoving() {
    return perfNow() - lastViewMoveAt < VIEW_MOVE_MS;
  }

  /** The camera moved (drag, wheel, autoscroll or pinch): hold the expensive work. */
  function noteViewMove() {
    lastViewMoveAt = perfNow();
    // The composited layer exists for the gesture only (see `body.panning` in the
    // stylesheet): smooth while moving, repainted at the real scale when the view settles.
    try {
      document.body.classList.add('panning');
      if (panClassTimer != null) clearTimeout(panClassTimer);
      panClassTimer = setTimeout(() => {
        panClassTimer = null;
        document.body.classList.remove('panning');
      }, PAN_SETTLE_MS);
    } catch (err) {
      /* a class that cannot be set costs a frame, never the pan */
    }
    if (viewIdleTimer != null) clearTimeout(viewIdleTimer);
    viewIdleTimer = setTimeout(() => {
      viewIdleTimer = null;
      // The moment the camera is quiet: the work the move postponed, in one batch. The
      // skip/wake transitions come first — they change card heights, and the layout pass
      // that follows is what puts the tree back in place around them.
      flushCv();
      flushLayout();
      pumpItems();
      flushDeferredItems();
      pumpUnloads();
    }, VIEW_MOVE_MS + 50);
  }

  // ---- A card's finished size, so a load never moves the tree -------------------
  // A waiting card's box is nothing like the one it ends up with, and when the answer
  // lands the whole tree re-places and the view under the reader jumps. A card's finished
  // height is stable (it is the same transcript every time), so it is remembered by node
  // id, kept in `localStorage` across a window reload, and pinned on the card while it
  // waits (`setCardLoading`). The waiting card is then exactly as tall as the card it is
  // about to become.
  const CARD_SIZE_KEY = 'spinney.cardSizes';
  const CARD_SIZE_LIMIT = 4000;
  const cardSizes = (() => {
    try {
      const raw = window.localStorage.getItem(CARD_SIZE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      const map = new Map();
      for (const [id, h] of Object.entries(parsed || {})) {
        if (typeof h === 'number' && h >= 20 && h <= 20000) map.set(id, h);
      }
      return map;
    } catch (err) {
      return new Map();
    }
  })();
  let cardSizesDirty = false;
  let cardSizesTimer = null;

  /** Write the table out, keeping the newest `CARD_SIZE_LIMIT` entries. */
  function persistCardSizes() {
    cardSizesTimer = null;
    if (!cardSizesDirty) return;
    cardSizesDirty = false;
    try {
      const out = Object.create(null);
      let drop = cardSizes.size - CARD_SIZE_LIMIT;
      for (const [id, height] of cardSizes) {
        if (drop-- > 0) continue;
        out[id] = height;
      }
      window.localStorage.setItem(CARD_SIZE_KEY, JSON.stringify(out));
    } catch (err) {
      /* a full or disabled store costs the placeholder, never the card */
    }
  }

  /** Remember a card's finished height, rounded, and only when it actually moved. */
  function rememberCardSize(id, height) {
    if (!id || !(height >= 20)) return;
    const next = Math.round(height);
    if (cardSizes.get(id) === next) return;
    cardSizes.set(id, next);
    cardSizesDirty = true;
    if (cardSizesTimer == null) cardSizesTimer = setTimeout(persistCardSizes, 1500);
  }

  /** Pin a waiting card to the height it finished at last time. */
  function applyLoadingSize(card) {
    if (!card || card._loadingHeight != null) return;
    const height = card._nodeId ? cardSizes.get(card._nodeId) : undefined;
    if (!height) return;
    card._loadingHeight = height;
    card.style.height = height + 'px';
  }

  /** Let the content decide the height again. */
  function clearLoadingSize(card) {
    if (!card || card._loadingHeight == null) return;
    card._loadingHeight = null;
    card.style.height = '';
  }

  try {
    window.addEventListener('pagehide', persistCardSizes);
  } catch (err) {
    /* no window to listen to */
  }

  let itemsQueue = [];
  let itemsInFlight = 0;
  /** Cards queued *and* on screen — the ones the queue promotes. */
  const itemsVisible = new Set();
  const itemsObserver =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(onItemsVisible, { root: null, rootMargin: '200px', threshold: 0 })
      : null;

  // How long a waiting card may claim its content is on its way (see `setCardLoading`).
  // It is the only end a *refused* request gets, as well as one nobody answers: nothing
  // about a refused or dropped `loadNodeItems` comes back to this webview — "answered" and
  // "answered with nothing" are the same silence here. There is no measurement behind the
  // number: it has to cover a host round trip plus the serialization of a long transcript,
  // and be short enough that a card nobody is going to fill stops claiming it — a card
  // that showed nothing *was* the symptom this state exists to avoid, and a spinner with
  // no end is that same lie with more motion. The
  // timeout does not cancel anything: a late answer still renders (`applyFetchedItems` only
  // asks whether the log is already in hand — a summary on screen is not).
  const ITEMS_WAIT_MS = 5000;

  /**
   * The "its content is on its way" state of one card: `items-loading` is what the
   * `.node-loading` strip (`createNodeCard`) is displayed for — an *expanded*,
   * still-waiting card and nothing else — and `aria-busy` is the same fact for a screen
   * reader. Both go on when the request is queued and off when the **log** renders — a
   * summary on screen is not the log (`_itemsSummary`), so it does not end the wait — or
   * when the wait above is up.
   */
  function setCardLoading(card, on) {
    if (!card) return;
    if (card._itemsTimer) {
      clearTimeout(card._itemsTimer);
      card._itemsTimer = null;
    }
    card.classList.toggle('items-loading', !!on);
    if (!on) {
      card.removeAttribute('aria-busy');
      // The content is here (or the wait is over): it decides the height again.
      clearLoadingSize(card);
      return;
    }
    card.setAttribute('aria-busy', 'true');
    // Hold the box the card had when it finished last time, so the tree does not re-place
    // itself when this load lands.
    applyLoadingSize(card);
    card._itemsTimer = setTimeout(() => {
      card._itemsTimer = null;
      card.classList.remove('items-loading');
      card.removeAttribute('aria-busy');
      clearLoadingSize(card);
      // An unloaded card whose answer never came must not stay invisible: give its box
      // back (it is empty, but it is there) instead of keeping a placeholder forever.
      if (card._itemsUnloaded) {
        card._itemsUnloaded = false;
        cvWake(card);
      }
    }, ITEMS_WAIT_MS);
  }

  // ---- Off-screen cards: the same tree, less to raster ------------------------
  // `#tree-canvas` is one layer sized to the WHOLE tree — measured in a real session at
  // `canvas=7928x8278` and `5749x11194`, against a viewport of a few hundred thousand pixels —
  // and every card in it used to be laid out and rastered whether or not anyone could see it.
  // That is what a background tab pays for when it comes back to the front (the surface it was
  // never repainting is exactly the shape a stale corner takes), so a card that is far outside
  // the viewport is skipped by the engine.
  //
  // Two rules keep it honest:
  //  - the box the card last measured is written into `contain-intrinsic-size` BEFORE it is
  //    skipped, because `relayout()` reads `offsetHeight` and a skipped card would otherwise
  //    report a placeholder height into the tidy-tree layout;
  //  - a card that is live (running), focused, or being dragged is never skipped, and
  //    `cvWake` un-skips one that is written into.
  // The margin is deliberately much larger than the viewport so the un-skip happens well
  // before a card becomes visible: the engine then has the frames it needs to render it.
  const CV_ROOT_MARGIN = '1000px';
  const cvObserver =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(onCardVisibility, { root: null, rootMargin: CV_ROOT_MARGIN, threshold: 0 })
      : null;
  const cvSkipped = new Set();

  function cvMaySkip(card) {
    const id = card._nodeId;
    if (!id) return false;
    if (runningNodes.has(id) || treeActiveId === id) return false;
    // A card the user is dragging has to keep measuring itself (the wireframe preview and
    // the commit both read its box).
    if (resizing && resizing.id === id) return false;
    return true;
  }

  /**
   * The state a card should be in once the camera is quiet. Waking a card lays it out and
   * paints it, and skipping one measures it — both are main-thread work that must not happen
   * under a moving camera: with a G502's free-spinning wheel this is what the 100 to 170 ms
   * frames were made of (14 long tasks in a 10 s wheel, no host message, no item render and
   * no slow layout pass: just cards crossing the skip margin).
   */
  const cvPending = new Set();

  /** Render this card again, whatever the observer last decided (see `cvObserver`). */
  function cvWake(card) {
    try {
      if (!card || !cvSkipped.has(card)) return;
      // An unloaded card is still skipped on purpose: its placeholder height IS its box
      // until the content is back. Waking it early would collapse a card the reader has
      // not reached yet, and the layout would re-place the tree around a hole.
      if (card._itemsUnloaded) return;
      // The card is 1,000 px away while the camera moves: it can wait for the settle, and
      // the layout it would cost then lands on a still screen.
      if (viewMoving() && treeActiveId !== card._nodeId) {
        card._cvWant = 'wake';
        cvPending.add(card);
        return;
      }
      cvWakeNow(card);
    } catch (err) {
      /* a layout aid must never break the UI */
    }
  }

  /** Wake immediately: the camera is quiet, or the card is the one the reader is in. */
  function cvWakeNow(card) {
    try {
      if (!card || !cvSkipped.has(card)) return;
      if (card._itemsUnloaded) return;
      cvSkipped.delete(card);
      card.classList.remove('cv-skip');
      card.style.containIntrinsicSize = '';
      // `relayout()` measures the new box and hands it back, so the engine may skip this
      // card again instead of leaving a card of a big tree fully laid out for good.
      card._cvFresh = true;
    } catch (err) {
      /* a layout aid must never break the UI */
    }
  }

  function onCardVisibility(entries) {
    try {
      for (const entry of entries) {
        const card = entry.target;
        if (entry.isIntersecting) {
          cvWake(card);
          continue;
        }
        if (!cvMaySkip(card)) continue;
        // Measuring a card forces a layout, so the skip waits for the settle too.
        if (viewMoving()) {
          card._cvWant = 'skip';
          cvPending.add(card);
          continue;
        }
        cvSkipNow(card);
      }
    } catch (err) {
      /* a layout aid must never break the UI */
    }
  }

  /** Measure this card while it still has a box, then let the engine skip it. */
  function cvSkipNow(card) {
    try {
      if (!card || cvSkipped.has(card) || !cvMaySkip(card)) return;
      const w = card.offsetWidth || 0;
      const h = card.offsetHeight || 0;
      if (!w || !h) return;
      card.style.containIntrinsicSize = w + 'px ' + h + 'px';
      card.classList.add('cv-skip');
      cvSkipped.add(card);
    } catch (err) {
      /* a layout aid must never break the UI */
    }
  }

  /** Apply the skip/wake transitions a moving camera postponed, in one pass. */
  function flushCv() {
    if (cvPending.size === 0 || viewMoving()) return;
    const cards = [...cvPending];
    cvPending.clear();
    for (const card of cards) {
      if (!card || !card._nodeId) continue;
      const want = card._cvWant;
      card._cvWant = null;
      if (want === 'wake') cvWakeNow(card);
      else if (want === 'skip') cvSkipNow(card);
    }
  }

  /**
   * The card's own size just changed, so the box the engine is **pretending** it has is a
   * lie: `relayout()` reads `offsetHeight`, and a skipped card reports its
   * `contain-intrinsic-size` instead of its content. Woken here, immediately, so the very
   * next `relayout()` (a checkout runs one right after the cards are re-folded) measures the
   * real thing.
   *
   * Without it, a tall card folded by a checkout keeps its unfolded height in the layout —
   * and takes every card below it with it, which is the "it folds but stays where it was"
   * misplacement. It is called at the four places where a card's structure or content
   * changes, and it deliberately wakes an **unloaded** card too: the placeholder is its box
   * only until its structure changes, and a fold is a structural change. The engine
   * re-skips the card (with the new box) the next time it leaves the viewport.
   */
  function cvWakeForMeasure(card) {
    try {
      if (!card || !cvSkipped || !cvSkipped.has(card)) return;
      cvSkipped.delete(card);
      card.classList.remove('cv-skip');
      card.style.containIntrinsicSize = '';
    } catch (err) {
      /* a layout aid must never break the UI */
    }
  }

  // ---- Cards far off screen: their content is unloaded (card virtualization) ---
  // The skip above stops the engine from *rastering* a far card; this one gives the card's
  // content back to the browser entirely. Measured in a real session: visiting five
  // sub-agent cards took the document from 8,660 elements to 57,455, and every pan frame
  // from ~30 ms to ~300 ms — because a lazy load was a one-way door. `loadNodeItems` /
  // `loadAgentItems` fetched a transcript when a card came near, and nothing ever released
  // it, so a reader who browsed the tree kept every transcript they had looked at for the
  // life of the document, and a reload (which empties the DOM) was the only cure.
  //
  // The card's **element** stays: its head, its box, its connector edge and its place in
  // the tidy-tree layout are unchanged. Only its ask and its log go, and the height it had
  // is kept as a placeholder so the layout does not re-place itself for content nobody can
  // see.
  //
  // **Two margins, not one, and a dwell.** A single boundary is an oscillator: a reader who
  // stops right on it (or pans back and forth across it) makes a card load and unload on
  // every frame of the gesture, which is more work than never unloading at all (measured:
  // the same transcripts arriving four and five times in half a minute). So coming back and
  // going away are two different distances — 2,000 px to ask again, 6,000 px to hand the
  // content back — and a card must stay beyond the far one for a moment before it is
  // released. A fast pan across a card therefore costs nothing, and a card flicked away and
  // back is never reloaded. Releases are batched too: a zoom-out can put a hundred cards
  // beyond the margin at once, and tearing a hundred subtrees down in one callback would be
  // a stutter of its own.
  const VIRT_LOAD_MARGIN = '2000px';
  const VIRT_UNLOAD_MARGIN = '6000px';
  const VIRT_UNLOAD_DWELL_MS = 900;
  const VIRT_UNLOAD_BATCH = 4;
  const VIRT_UNLOAD_TICK_MS = 200;
  /** A card keeps whatever a render just gave it for this long, whoever asked for the render. */
  const VIRT_SETTLE_MS = 5000;
  /** The hold a reloaded card earns before it may be released again, doubling per reload. */
  const VIRT_RELOAD_HOLD_MS = 15000;
  const VIRT_RELOAD_HOLD_MAX_MS = 120000;
  /** A card holding fewer rows than this costs less than the round trip to get them back. */
  const VIRT_UNLOAD_MIN_ITEMS = 24;
  const virtLoadObserver =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(onCardNear, { root: null, rootMargin: VIRT_LOAD_MARGIN, threshold: 0 })
      : null;
  const virtUnloadObserver =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(onCardFar, { root: null, rootMargin: VIRT_UNLOAD_MARGIN, threshold: 0 })
      : null;
  /** Cards that left the far margin and have not come back: the release queue. */
  const unloadQueue = [];
  let unloadTimer = null;

  /**
   * The hold this card has earned: 15 s after its first reload, then doubling for a card
   * that keeps coming back, capped at two minutes. Distance margins cannot stop a reader
   * who keeps turning around inside the dead band; time can.
   */
  function virtHoldMs(card) {
    const reloads = card._virtReloads || 0;
    if (reloads <= 0) return 0;
    const hold = VIRT_RELOAD_HOLD_MS * Math.pow(2, Math.min(reloads - 1, 3));
    return Math.min(VIRT_RELOAD_HOLD_MAX_MS, hold);
  }

  /**
   * May this card's content be handed back? Everything a reader could be interacting with
   * answers no: the checked-out card, a running turn, the card the composer lives in, the
   * card being resized, and any card holding the document's focus or a selection.
   */
  function virtMayUnload(card) {
    const id = card && card._nodeId;
    if (!id) return false;
    // Only a real log is worth a round trip: a summary or an empty card is already cheap,
    // and unloading it would put a loading strip on a card that shows nothing anyway.
    if (!card._itemsRendered || card._itemsSummary) return false;
    if ((card._itemCount || 0) < VIRT_UNLOAD_MIN_ITEMS) return false;
    const now = perfNow();
    // Time, not distance: a card a render just filled keeps its content for a moment, and a
    // card that has already been asked for again is held far longer, so a reader moving
    // back and forth settles on whichever cards they are actually using.
    if (now - (card._virtFilledAt || 0) < VIRT_SETTLE_MS) return false;
    if (now - (card._virtReloadedAt || 0) < virtHoldMs(card)) return false;
    if (treeActiveId === id) return false;
    if (runningNodes.has(id)) return false;
    if (composerHost === card) return false;
    if (resizing && resizing.id === id) return false;
    try {
      if (document.activeElement && card.contains(document.activeElement)) return false;
      const selection = typeof window.getSelection === 'function' ? window.getSelection() : null;
      if (selection && selection.anchorNode && card.contains(selection.anchorNode)) return false;
    } catch (err) {
      /* no selection API: the other guards still hold */
    }
    return true;
  }

  /** Hand one card's ask and log back to the browser, keeping its box. */
  function unloadCardItems(card) {
    // Measured before the content goes: this is the height the layout will keep reading.
    try {
      const w = card.offsetWidth || 0;
      const h = card.offsetHeight || 0;
      if (w && h) {
        card.style.containIntrinsicSize = w + 'px ' + h + 'px';
        card.classList.add('cv-skip');
        cvSkipped.add(card);
        rememberCardSize(card._nodeId, h);
      }
    } catch (err) {
      /* a layout aid must never break the UI */
    }
    renderNodeItems(card, [], false);
    card._itemsRendered = false;
    card._itemsSummary = false;
    card._itemsRequested = false;
    // An answer that arrived while the view was moving, and was still waiting when the card
    // left the margin, goes with the content it was going to replace.
    card._itemsDeferred = null;
    card._itemCount = 0;
    card._itemsUnloaded = true;
    setCardLoading(card, false);
    if (itemsObserver && card) itemsObserver.unobserve(card);
    scheduleLayout();
  }

  /**
   * Ask for an unloaded card's content again, from the same message type it came from.
   * The request is queued as if the card were visible: it is 2,000 px away at the moment it
   * comes near again, which is close enough that waiting for the viewport observer would let
   * the reader arrive before the answer did.
   */
  function reloadCardItems(card) {
    const id = card._nodeId;
    if (!id || !card._itemsUnloaded || card._itemsRequested) return;
    card._itemsRequested = true;
    // The hold this reload earns (see `virtHoldMs`), and the count that doubles it.
    card._virtReloads = (card._virtReloads || 0) + 1;
    card._virtReloadedAt = perfNow();
    if (!card._itemsMessage) {
      const meta = treeNodes[id] || {};
      card._itemsMessage = meta.kind === 'agent' ? 'loadAgentItems' : 'loadNodeItems';
    }
    setCardLoading(card, true);
    if (itemsObserver) {
      itemsQueue.push(id);
      itemsVisible.add(id);
      itemsObserver.observe(card);
      pumpItems();
      return;
    }
    postItems(id, card);
  }

  /** A card came back inside the load margin: it is near again, so it must not be released. */
  function onCardNear(entries) {
    try {
      for (const entry of entries) {
        const card = entry.target;
        if (!entry.isIntersecting) continue;
        cancelUnload(card);
        if (card._itemsUnloaded) reloadCardItems(card);
      }
    } catch (err) {
      /* a memory bound must never break the UI */
    }
  }

  /** A card crossed the far margin: start (or cancel) its dwell before it is released. */
  function onCardFar(entries) {
    try {
      for (const entry of entries) {
        const card = entry.target;
        if (entry.isIntersecting) {
          cancelUnload(card);
          continue;
        }
        scheduleUnload(card);
      }
    } catch (err) {
      /* a memory bound must never break the UI */
    }
  }

  /** The card is back near: forget the pending release, wherever it had got to. */
  function cancelUnload(card) {
    card._virtFar = false;
    if (card._unloadTimer) {
      clearTimeout(card._unloadTimer);
      card._unloadTimer = null;
    }
    const at = unloadQueue.indexOf(card);
    if (at >= 0) unloadQueue.splice(at, 1);
  }

  /** It went far away: release it only if it is still there after the dwell. */
  function scheduleUnload(card) {
    card._virtFar = true;
    if (card._unloadTimer) return;
    card._unloadTimer = setTimeout(() => {
      card._unloadTimer = null;
      if (!card._virtFar || !virtMayUnload(card)) return;
      if (unloadQueue.indexOf(card) < 0) unloadQueue.push(card);
      pumpUnloads();
    }, VIRT_UNLOAD_DWELL_MS);
  }

  /**
   * Release the queue a few cards per tick, and never while the reader is dragging or
   * typing: the teardown of a long transcript is real main-thread work, and it must not
   * land in the middle of a gesture (it runs the moment the gesture ends).
   */
  function pumpUnloads() {
    if (unloadTimer != null || unloadQueue.length === 0) return;
    // The reader is dragging, typing or wheel-scrolling: the teardown of a long transcript
    // is real main-thread work and must not land in the middle of that. It resumes on its
    // own tick once the view is quiet.
    if (perfPan || perfTyping || viewMoving()) {
      unloadTimer = setTimeout(() => {
        unloadTimer = null;
        pumpUnloads();
      }, VIRT_UNLOAD_TICK_MS);
      return;
    }
    unloadTimer = setTimeout(() => {
      unloadTimer = null;
      let done = 0;
      while (unloadQueue.length > 0 && done < VIRT_UNLOAD_BATCH) {
        const card = unloadQueue.shift();
        done++;
        if (!card || !card._nodeId || !card._virtFar) continue;
        if (!virtMayUnload(card)) continue;
        unloadCardItems(card);
      }
      if (unloadQueue.length > 0) pumpUnloads();
    }, VIRT_UNLOAD_TICK_MS);
  }

  /** Does this card still want (and may still receive) its items? */
  function itemsWanted(id) {
    const card = nodeEls[id];
    // A summarised card is still waiting: it has content on screen (`_itemsRendered`),
    // but that content is the summary, and the request it posted must not be dropped by
    // this queue's own hygiene check as if the items had arrived.
    return !!(card && card._itemsRequested && (!card._itemsRendered || card._itemsSummary));
  }

  /**
   * How many expanded cards of *this* repaint still need an *agent* transcript — the
   * "is this a burst?" question `requestAgentItems` asks. It counts the card asking
   * right now (`_itemsRequested` is already set for it, its items are not in yet)
   * and uses the same expansion predicate the repaint loops use, so it answers
   * with the sidecar cards that are actually on screen in the tree.
   *
   * A regular card does not ask this question: it always goes through the queue (see
   * `requestNodeItems`), because what it is waiting for is a `tree` that a `path` may
   * follow in the same burst.
   */
  function pendingAgentCards() {
    let n = 0;
    for (const id in treeNodes) {
      const meta = treeNodes[id];
      const count = meta && (meta.itemCount || (pathNodes[id] && pathNodes[id].itemCount));
      if (!count || meta.kind !== 'agent') continue;
      const card = nodeEls[id];
      // A summarised agent card counts too: it has its summary rendered and has not been
      // answered, so the burst rule must see it exactly like a card with nothing at all.
      if (!card || (card._itemsRendered && !card._itemsSummary)) continue;
      if (!activePathSet.has(id) && !agentExpanded(id)) continue;
      n++;
    }
    return n;
  }

  /** Post one on-demand items request; every posted request holds one slot. */
  function postItems(id, card) {
    itemsInFlight++;
    if (itemsObserver && card) itemsObserver.unobserve(card);
    // Which of the two requests goes out follows the node's own kind, recorded on the
    // card by the caller: the host keeps the answers apart (`onAgentItems` refuses a
    // node that is not a sub-agent, `onNodeItems` answers any node of the session), so a
    // card must not ask for the wrong one — and the lookup is on the *card* because a
    // live sub-agent's card can exist before the `tree` describes its node.
    vscode.postMessage({ type: (card && card._itemsMessage) || 'loadNodeItems', id });
  }

  /** Drop a queued card (its node is gone, or its items arrived elsewhere). */
  function forgetItems(id) {
    const at = itemsQueue.indexOf(id);
    if (at >= 0) itemsQueue.splice(at, 1);
    itemsVisible.delete(id);
    const card = nodeEls[id];
    if (itemsObserver && card) itemsObserver.unobserve(card);
  }

  /** Fill the free slots, the cards in the viewport first; stop when none is. */
  function pumpItems() {
    // The camera is moving: ask for nothing new until it settles (see `viewMoving`). The
    // queue keeps its place and the idle timer pumps it again.
    if (viewMoving()) return;
    for (let i = 0; i < itemsQueue.length; i++) {
      if (!itemsWanted(itemsQueue[i])) forgetItems(itemsQueue[i--]);
    }
    while (itemsInFlight < ITEMS_CONCURRENCY && itemsQueue.length > 0) {
      const at = itemsQueue.findIndex((id) => itemsVisible.has(id));
      // Nothing on screen: the queue waits for the viewport to come to it (the
      // observer promotes the card when it does).
      if (at < 0) return;
      const id = itemsQueue.splice(at, 1)[0];
      itemsVisible.delete(id);
      postItems(id, nodeEls[id]);
    }
  }

  /** A card entered or left the viewport: promote what the user is looking at. */
  function onItemsVisible(entries) {
    let arrived = false;
    for (const entry of entries || []) {
      const id = entry && entry.target && entry.target.dataset ? entry.target.dataset.id : '';
      if (!id) continue;
      if (entry.isIntersecting) {
        itemsVisible.add(id);
        arrived = true;
      } else {
        itemsVisible.delete(id);
      }
    }
    if (arrived) pumpItems();
  }

  /**
   * Ask the host for one agent card's transcript — the *one* request `expandedCard`
   * documents (see `_itemsRequested`). A lone request goes out right away; a
   * repaint that re-expands many sidecar cards queues them behind the cap. The card
   * says it is waiting while it does (`setCardLoading`): a sub-agent's transcript is as
   * absent from the `tree` as a regular card's items are, and "nothing yet" must not read
   * as "nothing there".
   */
  function requestAgentItems(id, card) {
    card._itemsRequested = true;
    card._itemsMessage = 'loadAgentItems';
    setCardLoading(card, true);
    if (itemsObserver && pendingAgentCards() > 1) {
      itemsQueue.push(id);
      itemsObserver.observe(card);
      pumpItems();
      return;
    }
    postItems(id, card);
  }

  /**
   * Ask the host for one **regular** card's items (`loadNodeItems`) — the same one-shot
   * contract, for the card whose items never arrived at all: a `tree`-first card holds
   * the structural node and no items (see the block above), and a card with no items in
   * hand is a card that shows nothing. Unlike the agent half this always goes through the
   * queue, which is what keeps it cheap in the local case it is not for: a session switch
   * posts the `tree` before the `path`, a `tree`-only card asks, and the `path` that lands
   * a task later fills it before the observer has had a frame to promote it — the queue's
   * own `itemsWanted` check drops the request unposted. An off-screen card stays queued
   * until it is panned to, exactly like a sidecar's transcript.
   */
  function requestNodeItems(id, card) {
    card._itemsRequested = true;
    card._itemsMessage = 'loadNodeItems';
    setCardLoading(card, true);
    if (itemsObserver) {
      itemsQueue.push(id);
      itemsObserver.observe(card);
      pumpItems();
      return;
    }
    postItems(id, card);
  }

  /** A new session: the queued cards are gone with the old tree. */
  function resetItems() {
    for (const id of itemsQueue) {
      const card = nodeEls[id];
      if (itemsObserver && card) itemsObserver.unobserve(card);
    }
    itemsQueue = [];
    itemsVisible.clear();
    itemsInFlight = 0;
    // The waiting flags go with those cards: `reset` removes every card right after this,
    // and a timer left behind would hold one for its whole 5 s wait with nothing to show
    // for it (`setCardLoading`).
    for (const id in nodeEls) setCardLoading(nodeEls[id], false);
  }

  /** An `agentItems` / `nodeItems` answer frees its slot for the next queued card. */
  function releaseItems() {
    if (itemsInFlight > 0) itemsInFlight--;
    pumpItems();
  }

  /**
   * One on-demand items answer rendered into the card it was asked for. Both wire types
   * land here on purpose: the host builds `agentItems` and `nodeItems` in one place
   * (`SessionRuntime.postItems`, the same clipped `displayItems` and the same `id`), so
   * a difference between them here would be a difference the host cannot make.
   */
  function applyFetchedItems(id, items) {
    const card = nodeEls[id];
    // The answer is also what frees a slot for the next queued request, so that happens
    // *first*: an answer for a card the tree has dropped (the `return` below) releases it
    // just the same.
    releaseItems();
    // A summarised card is the one card an answer is still *for* while `_itemsRendered`
    // is already true: it rendered its summary (so a repaint will not touch it) and the
    // fetch it posted on expansion is what this message is. The early return that
    // protects a `path`-filled card must not swallow the log here.
    if (!card || (card._itemsRendered && !card._itemsSummary)) {
      // A `path` (or an earlier answer) already filled this card: the wait is over, so
      // the strip must not keep claiming the content is on its way.
      if (card) setCardLoading(card, false);
      return;
    }
    // The camera is still moving: hold the answer and render it when the view settles. The
    // card keeps its loading strip, which is the honest state — its content really is on
    // its way, and the wait now has a visible reason instead of being a stutter.
    if (viewMoving()) {
      card._itemsDeferred = items || [];
      if (deferredItemsTimer == null) {
        deferredItemsTimer = setTimeout(flushDeferredItems, VIEW_MOVE_MS + 50);
      }
      return;
    }
    renderFetchedItems(card, items || []);
  }

  /**
   * Render the items one answer brought, and re-place the tree around the new box. The
   * tail of `applyFetchedItems`, split out so a deferred answer can run later through
   * exactly the same path.
   */
  function renderFetchedItems(card, items) {
    const id = card._nodeId;
    // The work log is the scroller this path opens at its end; the answer zone
    // is filled — and opened at its top — by `renderNodeItems` itself.
    const itemsEl = card.querySelector('.node-work');
    const finished = (treeNodes[id] || {}).status !== 'running';
    renderNodeItems(card, items || [], finished);
    card._itemsRendered = true;
    // The log is here and this card is no longer a summary of anything. Both halves are
    // written together because every render gate reads them as a pair: leaving this set
    // would make the next repaint fetch the same node all over again.
    card._itemsSummary = false;
    // An unloaded card kept its box as a placeholder: the content is back, so wake it
    // now (`cvWake` drops the placeholder) rather than waiting for the skip observer.
    cvWake(card);
    setCardLoading(card, false);
    // Same finished-node default as in `expandedCard` / `renderPath`.
    if (finished) {
      setCardScrollLock(card, false);
      card._needsBottomScroll = true;
    }
    // Open the just-filled card at its newest content (a following card is pinned there
    // anyway, a released one takes the flag `expandedCard` would — without engaging follow).
    if (card._itemScroll && card._itemScroll.locked) {
      card._itemScroll.scrollToBottom();
      card._needsBottomScroll = false;
    } else if (card._needsBottomScroll && itemsEl && card._itemScroll) {
      card._itemScroll.pinToBottom();
      card._needsBottomScroll = false;
    }
    // The items are what gives this card its height, and the card's height
    // feeds the layout, so re-place the tree like any other card that changed
    // size (debounced, so a burst of answers coalesces into one relayout).
    scheduleLayout();
  }

  /**
   * Render the answers that arrived while the view was moving, a few per tick: a burst of
   * them must not turn one frame into the layout of ten transcripts. Anything still held
   * comes back on the next tick, and the queue is pumped once the view is quiet.
   */
  function flushDeferredItems() {
    deferredItemsTimer = null;
    if (viewMoving()) {
      deferredItemsTimer = setTimeout(flushDeferredItems, VIEW_MOVE_MS);
      return;
    }
    let done = 0;
    let more = false;
    for (const id in nodeEls) {
      const card = nodeEls[id];
      if (!card || !card._itemsDeferred) continue;
      if (done >= DEFERRED_RENDER_BATCH) {
        more = true;
        break;
      }
      const items = card._itemsDeferred;
      card._itemsDeferred = null;
      done++;
      // The card may have been answered elsewhere, filled by a repaint or unloaded while
      // the answer waited: the same gates `applyFetchedItems` uses decide again.
      if (card._itemsRendered && !card._itemsSummary) {
        setCardLoading(card, false);
        continue;
      }
      if (card._itemsUnloaded) continue;
      renderFetchedItems(card, items);
    }
    if (more) deferredItemsTimer = setTimeout(flushDeferredItems, 16);
    pumpItems();
  }

  /**
   * Which of a card's two sources to render from, and whether what it holds is a
   * **summary** rather than the log. `pnode` used to win whenever it merely *existed*, and
   * that hid real items: a `path` / `tree` node carrying `items: []` (or no `items` at all)
   * beat the row next to it that had them.
   * So a source that *has* items beats one that does not, a real transcript beats a
   * summary of the same node (a repaint can hold both — the `tree` row and the `path`
   * row of one node are built by different callers), and when neither has any the old
   * precedence stands: `[]` keeps marking `_itemsRendered`, because a *running* node is
   * filled incrementally by its own stream and that flag is what stops the next repaint
   * from wiping it.
   *
   * A row describing a **finished** node now carries `items` = its first `user` item and
   * its last answer, `summary: true`, and the node's real `itemCount` — the full log is
   * what the `tree` used to ship for every card, and it is the cost the lazy-sidecar
   * contract exists to avoid. The flag rides *with* the items because the card has to
   * know that what it rendered is not everything (that pair is `_itemsRendered` +
   * `_itemsSummary`), and because how much of a node is worth sending is the host's call,
   * never a count this side re-derives.
   */
  function itemsSource(pnode, meta) {
    // A row that carries the summary flag is a source even when its `items` is empty: a whole
    // turn of one `user` item summarises to nothing at all, and the flag is then the only
    // thing that says the log is somewhere else. Without it the card would render an empty
    // log and never ask — the "card with nothing in it" symptom this file has fought before.
    const isSource = (row) => !!row && !!((row.items && row.items.length) || row.summary);
    const candidates = [pnode, meta].filter(isSource);
    const chosen = candidates.find((row) => !row.summary) || candidates[0];
    if (chosen) return { items: chosen.items, summary: !!chosen.summary };
    return { items: pnode ? pnode.items : meta && meta.items, summary: false };
  }

  /**
   * A **sidecar** card (a sub-agent window, or a job card) that is not the focused node
   * renders as a *monitor*: the fixed 200px window of `.node.monitor` in style.css,
   * showing its head, the live tail of its own work log — the same `.node-work` scroller
   * the expanded card uses, so the stream fills it and follows it exactly as it does
   * there — and its one-line preview. Every sidecar gets a cell of its own from the
   * layout (media/tree.js); a card whose size followed its content would push the
   * conversation's spine down and grow its parent's cell instead of sending its own
   * sub-windows to the next depth band. The one sidecar that *is* the focused node
   * renders as the ordinary expanded card — see the decision in the `tree` / `path`
   * passes.
   *
   * The parts are the expanded card's, re-aimed: the pinned ask is hidden (a monitor is a
   * window onto work, not a card being read) and the log is shown whether or not it holds
   * anything yet — the strip is what "where is this sub-agent" looks like while its items
   * are still on their way.
   */
  function monitorCard(id, meta, pnode) {
    const card = nodeEls[id];
    // A monitor is a fixed 200px window: never the box a previous skip remembered.
    if (!card.classList.contains('monitor')) cvWakeForMeasure(card);
    card.classList.add('monitor');
    card.classList.remove('expanded', 'active');
    // A size a previous drag put on the card is parked first: an inline `max-height`
    // (from `createNodeCard`'s `meta.size`, or `endResize`) beats every stylesheet rule,
    // so the class alone could not hold a resized sidecar to its 200px. The focused card
    // gets it back (see `expandedCard`) — it is the card the user sized.
    if (card.style.maxHeight) {
      card._monitorCap = card.style.maxHeight;
      card.style.maxHeight = '';
    }
    const askEl = card.querySelector('.node-ask');
    const workEl = card.querySelector('.node-work');
    const workWrap = card.querySelector('.node-work-wrap');
    const excerptEl = card.querySelector('.node-excerpt');
    // The fill path is `expandedCard`'s, for the same reason it is there: a sidecar ships
    // no transcript in the `tree` / `path` payload (only `itemCount`), and a monitor needs
    // its tail — so the one-shot ask has to be made from here too. A card that only ever
    // asked from an expansion would never ask now that a sidecar is usually a monitor, and
    // the window would stay empty.
    const src = itemsSource(pnode, meta);
    const source = src.items;
    const supersedesSummary = card._itemsRendered && card._itemsSummary && !src.summary;
    if (source && (!card._itemsRendered || supersedesSummary)) {
      renderNodeItems(card, source, meta.status !== 'running');
      card._itemsRendered = true;
      card._itemsSummary = !!src.summary;
      if (!src.summary || !card._itemsRequested) setCardLoading(card, false);
      if (meta.status !== 'running') {
        setCardScrollLock(card, false);
        card._needsBottomScroll = true;
      }
    }
    const pendingItems = (pnode && pnode.itemCount) || meta.itemCount || 0;
    const pendingKind = (pnode && pnode.kind) || meta.kind;
    const wantsLog = !card._itemsRendered || card._itemsSummary;
    if (wantsLog && !card._itemsRequested) {
      if (pendingItems > 0 && pendingKind === 'agent') {
        requestAgentItems(id, card);
      } else if (!isSidecarKind(pendingKind) && !runningNodes.has(id) && (!source || card._itemsSummary)) {
        requestNodeItems(id, card);
      }
    }
    askEl.classList.add('hidden');
    workWrap.classList.remove('hidden');
    excerptEl.textContent = meta.preview || meta.title || '';
    excerptEl.classList.remove('hidden');
    // The tail is the point, so a monitor opens at its newest content — once, like
    // `expandedCard`'s own case, so a reader who scrolled a window is not yanked back to
    // the bottom by every repaint — and a *live* one follows its stream through
    // `_itemScroll`, which `routeTo` pins after each append.
    if (card._itemScroll && card._itemScroll.locked) {
      card._itemScroll.scrollToBottom();
      card._needsBottomScroll = false;
    } else if (card._needsBottomScroll && workEl && card._itemScroll) {
      card._itemScroll.pinToBottom();
      card._needsBottomScroll = false;
    }
  }

  function expandedCard(id, meta, pnode) {
    const card = nodeEls[id];
    // The card is about to grow (and may take the composer): never the box it was skipped
    // with, unless it was already expanded.
    if (!card.classList.contains('expanded') || card.classList.contains('monitor')) cvWakeForMeasure(card);
    card.classList.add('expanded');
    // The focused node is the one card that renders as a full card: the monitor window
    // (and the class it is spelled with) comes off here, and a size the card carried
    // before it was a monitor — parked by `monitorCard`, because an inline `max-height`
    // would win against the 200px rule — goes back on. A turn card has neither.
    card.classList.remove('monitor');
    if (card._monitorCap != null) {
      card.style.maxHeight = card._monitorCap;
      card._monitorCap = null;
    }
    card.classList.toggle('active', id === treeActiveId);
    const askEl = card.querySelector('.node-ask');
    const workEl = card.querySelector('.node-work');
    const workWrap = card.querySelector('.node-work-wrap');
    const excerptEl = card.querySelector('.node-excerpt');
    // Populate from the path items, or (agent nodes) their own transcript; a
    // freshly-streamed node is filled incrementally, so never wipe it here. A source
    // that is a *summary* renders exactly like the log and is recorded as one
    // (`_itemsSummary`): the card then knows the rest is missing, and the ask below is
    // what brings it. Real items supersede a summary — a repaint can hold both (the
    // `tree` row summarised and the `path` row of the same node full, or the reverse) —
    // and re-rendering there costs less than a round trip for items already in hand.
    const src = itemsSource(pnode, meta);
    const source = src.items;
    const supersedesSummary = card._itemsRendered && card._itemsSummary && !src.summary;
    if (source && (!card._itemsRendered || supersedesSummary)) {
      // A finished card with a long transcript renders a window of it (see
      // `renderNodeItems`); a running node keeps the full render, because its
      // items are appended in place as they arrive.
      renderNodeItems(card, source, meta.status !== 'running');
      card._itemsRendered = true;
      card._itemsSummary = !!src.summary;
      // Whatever was waited for is here now — unless what arrived is a *summary*: that is
      // not an answer to the request this card may already have out (the ask below posts
      // one, and a previous pass may have posted it), so the strip must keep saying the
      // content is on its way.
      if (!src.summary || !card._itemsRequested) setCardLoading(card, false);
      // Thinking blocks only exist once the items are rendered, so apply the
      // finished-node default here (once, so a manual lock is not clobbered by
      // later re-renders).
      if (meta.status !== 'running') {
        setCardScrollLock(card, false);
        card._needsBottomScroll = true;
      }
    }
    // An agent node's transcript no longer rides in the `tree` / `path` payload
    // (it was most of a big session's message): the host ships only `itemCount`,
    // and the card fetches the items on its first expansion. `_itemsRequested`
    // sticks to the card, so collapsing and reopening it — or a repaint that
    // re-expands it — asks the host once, not once per expand. *When* that one
    // request is posted is `requestAgentItems`'s call: a cold repaint that
    // re-expands a whole sidecar grid queues them instead of firing them all.
    //
    // A summarised card is the same one-shot ask for the other half of the same
    // contract, and this is the *only* trigger for it — a card that is never expanded
    // never asks, so a cold repaint pays for what the reader actually opened. The ask
    // is here rather than at render time because "expanded" and "the items arrived" are
    // different moments for every card that is not on the view path.
    const pendingItems = (pnode && pnode.itemCount) || meta.itemCount || 0;
    const pendingKind = (pnode && pnode.kind) || meta.kind;
    const wantsLog = !card._itemsRendered || card._itemsSummary;
    if (wantsLog && !card._itemsRequested) {
      if (pendingItems > 0 && pendingKind === 'agent') {
        requestAgentItems(id, card);
      } else if (!isSidecarKind(pendingKind) && !runningNodes.has(id) && (!source || card._itemsSummary)) {
        // The same one-shot ask for a **regular** card whose log is not in hand: either
        // it has no items at all — a `tree`-first card holds the structural node and no
        // items (see the block above), so this is the only way such a card is ever filled
        // — or what it holds is a summary the host sent (`summary: true`). The gates are
        // the card's: no log to render (the `pnode` trap — an empty `items` on the path
        // used to win over real ones, and `itemsSource` has already preferred whichever
        // has any), not a sidecar (`agent` has its own request, `bg` its own body), and
        // not *running* — a live card is being filled by its own stream, and rendering a
        // snapshot under it would rebuild the log the next delta is still appending to.
        requestNodeItems(id, card);
      }
    }
    askEl.classList.remove('hidden');
    // The log shows when it has something in it. Un-hiding it unconditionally would
    // bring back the empty padded box of a pure-text turn (the whole turn is the
    // answer, so the log *is* empty) on every repaint — and hiding an empty log here is
    // safe, because the first append un-hides it (see `routeTo`).
    workWrap.classList.toggle('hidden', workEl.children.length === 0);
    excerptEl.classList.add('hidden');
    if (card._itemScroll && card._itemScroll.locked) {
      // Following a live turn: pin to the newest content.
      card._itemScroll.scrollToBottom();
      card._needsBottomScroll = false;
    } else if (card._needsBottomScroll && workEl && card._itemScroll) {
      // Released (finished) card: open at its newest content, then scroll freely — the pin
      // does not engage the light, so the dot stays dim and the reader owns the log.
      card._itemScroll.pinToBottom();
      card._needsBottomScroll = false;
    }
  }

  function collapsedCard(id, meta) {
    const card = nodeEls[id];
    // The card is about to shrink **if it was open**; an already-collapsed card keeps the
    // box it was skipped with.
    if (card.classList.contains('expanded') || card.classList.contains('monitor')) cvWakeForMeasure(card);
    card.classList.remove('expanded', 'active');
    const askEl = card.querySelector('.node-ask');
    const workWrap = card.querySelector('.node-work-wrap');
    const excerptEl = card.querySelector('.node-excerpt');
    excerptEl.textContent = meta.preview || meta.title || '';
    // Both go: a collapsed card is its head plus the one-line preview.
    askEl.classList.add('hidden');
    workWrap.classList.add('hidden');
    excerptEl.classList.remove('hidden');
  }

  function setActiveLeaf(id) {
    const card = id ? nodeEls[id] : null;
    // The routed transcript is the card's log — the one scroller, which is where every
    // row (and the final answer) lives.
    messagesEl = card ? card.querySelector('.node-work') : null;
    // The run of steps a card had open is that card's own state, so the flow's open
    // group follows the log it is bound to.
    openSteps = (card && card._openGroup) || null;
    promptEl = card ? card.querySelector('.node-ask') : null;
    // The send pane lives at the bottom of the checked-out node's card, and only
    // there: a sub-agent branch is read-only (driven by the main agent through
    // spawn_agents / send_agent_message), and a session with no active node has
    // no card to inline it in — in both cases the pane is hidden entirely.
    const node = id ? treeNodes[id] : null;
    // A sidecar (sub-agent window / background job card) never hosts the composer:
    // it is driven by the agent, and a job card has no conversation at all. A
    // **compression node** hosts it exactly when it is *ready*: while its turn runs it
    // has no input box (its one request was written by the harness, and its own ⏹ Stop
    // is the way to stop it), and once its handoff exists the card is an ordinary card
    // to continue from (`docs/agents/invariants/compress-node.md` §2).
    const compressing = !!(node && node.role === 'compress' && !node.handoffReady);
    const hostCard = card && !(node && isSidecarKind(node.kind)) && !compressing ? card : null;
    // Un-hide before mounting so autoGrow() measures a rendered input.
    setComposerVisible(!!hostCard);
    mountComposer(hostCard);
    if (card && card._itemScroll) card._itemScroll.scrollToBottom();
  }

  // Patch a single card's status (turn finished) without re-rendering the tree.
  function applyNodeUpdate(msg) {
    const card = nodeEls[msg.id];
    if (card) {
      const statusEl = card.querySelector('.node-status');
      if (statusEl && msg.status) {
        statusEl.textContent = statusLabel(msg.status);
        statusEl.dataset.status = msg.status;
      }
    }
    if (treeNodes[msg.id]) {
      if (msg.status) treeNodes[msg.id].status = msg.status;
      if (msg.title) treeNodes[msg.id].title = msg.title;
      // Which variant of the button `syncContinueButton` below has to show depends
      // on the context state, and a turn that dies on a provider context-length
      // error ends *after* the tree was drawn — so the patch has to carry the
      // host's judgement with it, or the card would keep offering `↻ Retry` for an
      // oversized request. The state is never derived here (§4.3); the percentage
      // only feeds the `near` variant's tooltip.
      if (typeof msg.context === 'string') treeNodes[msg.id].context = msg.context;
      if (typeof msg.contextPct === 'number') treeNodes[msg.id].contextPct = msg.contextPct;
      // A compression node's handoff appears when its turn finally writes it, and the
      // card's whole behaviour turns on that fact: it hosts the composer from then on
      // (`setActiveLeaf`) and wears the green ready border.
      if (typeof msg.handoffReady === 'boolean') treeNodes[msg.id].handoffReady = msg.handoffReady;
      // The prompt-cache rate of the card's own requests: the host recomputes it from the
      // items it now holds (a turn that just ended is what changes it), and the checked-out
      // card paints it on its outline. `null` is a known answer too — it means the provider
      // reported no cache fields, and the outline must go back to the accent.
      if (typeof msg.cachePct === 'number' || msg.cachePct === null) treeNodes[msg.id].cachePct = msg.cachePct;
      // The turn's last usage is what the docked bar shows; it arrives with the same patch
      // that ends the turn (`nodeStatePatch.usage`).
      if (msg.usage !== undefined) treeNodes[msg.id].usage = msg.usage;
    }
    if (card) {
      syncHandoffCard(card, treeNodes[msg.id]);
      syncCacheColor(card, treeNodes[msg.id]);
      syncUsageBar(card, treeNodes[msg.id]);
      syncContinueButton(card, treeNodes[msg.id] || { id: msg.id, status: msg.status, children: [] });
    }
    // The pencil on the ask is offered by the render (`syncAskEdit`), and nothing a `node`
    // patch carries can take it away: a turn starting or ending is not a reason to stop
    // offering an edit that branches beside it.
    if (card) syncAskEdit(card);
    // A checked-out compression card gains (or loses) its input box with the handoff, so
    // re-run the focus rather than waiting for the next full tree — `updateComposerButtons`
    // below then answers for the pane that was just mounted or unmounted.
    if (typeof msg.handoffReady === 'boolean' && msg.id === treeActiveId) setActiveLeaf(treeActiveId);
    // The context state is half of what the composer's own two buttons read (a refused
    // request disables Send and offers the new-epoch entry), and it can arrive *after*
    // the tree was drawn — exactly how a turn dies on a context-length error.
    updateComposerButtons();
  }

  /**
   * The ▶ Continue / ↻ Retry / ⏹ Stop entries on a card:
   *
   *  - `error` (any failure) → `↻ Retry`, in place;
   *  - `interrupted` → `▶ Continue`, in place;
   *  - a **running** compression node → `⏹ Stop`, because that card has no composer and
   *    therefore no other way to end its turn (a compression that reads too much would
   *    otherwise be uncancellable). One element, one meaning: it posts the same `stop` a
   *    composer's Stop does, and the host's union kill is what answers it.
   *
   * A new *context window* is not offered here: every new-epoch transition is the composer's
   * single `#new-context-btn` (`updateNewContextButton`), so a card never carries a second,
   * differently-worded entry for the same act.
   *
   * Shown only where it makes sense: a conversational turn node (never a sidecar — a
   * sub-agent window or job card has no conversation of its own here), and for ▶/↻ also a
   * *tip* of its branch (a node that already has a turn child has been continued; the new
   * failure, if any, shows on that child). A **compression node that already delivered its
   * window** shows neither: it is sealed, and ▶ would open a second window claiming to
   * continue the same one (`docs/agents/invariants/compress-node.md` §4).
   */
  function syncContinueButton(card, meta) {
    const id = meta && meta.id;
    // `byClass`, not `querySelector`: a miss must be observable (the offline
    // webview checker's DOM stub answers a plain-class miss with a shared stub).
    const btn = byClass(card, 'node-continue');
    const stop = byClass(card, 'node-stop');
    const positionButton = (button) => {
      const head = byClass(card, 'node-head');
      // Keep the delete button at the far right of the head.
      const del = head ? byClass(head, 'node-del') : null;
      if (!head) {
        card.appendChild(button);
      } else if (del && head.insertBefore) {
        head.insertBefore(button, del);
      } else {
        head.appendChild(button);
      }
    };
    const isCompress = !!meta && meta.role === 'compress';
    const terminal = !!meta && (meta.status === 'interrupted' || meta.status === 'error');
    const hasTurnChild = !!meta && (meta.children || []).some((c) => {
      const child = treeNodes[c];
      return child && !isSidecarKind(child.kind);
    });
    // A compression node's turn is over the moment the window below it exists: the answer
    // has been delivered, and a second ▶ would produce a second window for the same source.
    const delivered = isCompress && (meta.children || []).some((c) => {
      const child = treeNodes[c];
      return child && child.role === 'resume';
    });
    // ⏹ Stop: only a compression node, and only while it streams — every other card's Stop
    // is its composer's (this card has none).
    const wantStop = isCompress && runningNodes.has(id);
    if (wantStop) {
      if (!stop) {
        const button = el('button', 'node-stop', '⏹');
        button.title = tr('Stop this compression turn');
        button.addEventListener('click', (ev) => {
          ev.stopPropagation();
          setStatus(tr('Stopping…'));
          vscode.postMessage({ type: 'stop', nodeId: id });
        });
        positionButton(button);
      }
    } else if (stop) {
      stop.remove();
    }
    const failed = !!meta && meta.status === 'error';
    const label = failed ? tr('↻ Retry') : tr('▶ Continue');
    const title = failed
      ? tr('Ask the harness to retry this turn (it sends the message for you)')
      : tr('Ask the harness to continue from here (it sends the message for you)');
    const action = failed ? 'retry' : 'continue';
    const show = !!id && terminal && !hasTurnChild && !delivered && !isSidecarKind(meta.kind) && !runningNodes.has(id);
    if (!show) {
      if (btn) btn.remove();
      return;
    }
    // Created on demand, into the head and before the delete button (the far right
    // is the delete button's). The action is read at *click* time: the same element
    // is reused as the node's status changes (Retry ⇄ Continue), so a captured action
    // would go stale and post the wrong request.
    if (btn) {
      btn.textContent = label;
      btn.title = title;
      btn.dataset.action = action;
      return;
    }
    const button = el('button', 'node-continue', label);
    button.title = title;
    button.dataset.action = action;
    button.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // The action is read at click time: the same element is reused as the node's
      // status changes, so a captured action would post the wrong request.
      vscode.postMessage({ type: 'continueTurn', id });
    });
    positionButton(button);
  }

  // Composer banner + readonly: when the checked-out node already has children,
  // sending creates a branch; when it is a read-only sub-agent node the composer is
  // disabled (only the main agent may drive a sub-agent via spawn/send). A node that
  // still owns unfinished work needs no banner: the bottom-right button is Stop there
  // (`updateComposerButtons`), which says what happens without a second explanation.
  function updateBranchBanner() {
    if (!branchBanner) return;
    const node = treeNodes[treeActiveId];
    const isAgent = !!(node && isSidecarKind(node.kind));
    // Sidecar cards are display-only, not conversational branches — only a *turn*
    // child makes the next message a branch.
    const hasTurnChildren = !!(
      node && node.children && node.children.some((c) => treeNodes[c] && !isSidecarKind(treeNodes[c].kind))
    );
    if (isAgent) {
      branchBanner.textContent = tr('Sub-agent branch (read-only) — driven by the main agent through spawn_agents / send_agent_message');
      branchBanner.classList.remove('hidden');
    } else if (hasTurnChildren) {
      branchBanner.textContent = tr('⤷ branching from {0} — your reply starts a new branch', node.title || tr('(no title)'));
      branchBanner.classList.remove('hidden');
    } else {
      branchBanner.classList.add('hidden');
    }
    // Read-only when the checked-out node is a sub-agent branch (the host additionally
    // refuses a send into a node that still owns work — Stop is the way out there), or when
    // this window does not own the workspace's sessions at all (`readOnly`, set from
    // `state`): the composer must agree with the host in both cases. The Send / new-epoch
    // buttons are not touched here — `updateComposerButtons` owns both, and it is called
    // right after this one by every entry point.
    const readonly = isAgent || readOnly;
    inputEl.disabled = readonly;
    attachBtn.disabled = readonly;
    snippetsBtn.disabled = readonly;
  }

  // An agent (sub-agent) branch is expanded when it is the checked-out node, when
  // its parent is the active node, or when a parent AGENT is expanded — so the
  // sub-agents a turn just spawned stream beside it, and a depth-2 sub-agent of an
  // (expanded) depth-1 sub-agent stays open with it. Those on a branch you
  // navigated away from collapse.
  function agentExpanded(id) {
    let n = treeNodes[id];
    while (n && isSidecarKind(n.kind)) {
      if (n.id === treeActiveId || n.parentId === treeActiveId) return true;
      n = treeNodes[n.parentId];
    }
    return false;
  }

  // rAF-throttled relayout for ANY card whose own box changed (see
  // `cardResizeObserver`, its main caller). It began as the sub-agent case and that is
  // still the loudest one: a streaming card's transcript grows while `followActive`
  // (which schedules the main layout) is suppressed as `routingSubAgent`, so cards could
  // overlap until agentDone. A card that grows outside a repaint — a log unfolded, an
  // image that landed, a window that re-wrapped — is the same event, so the throttle is
  // the shared one. One relayout per frame is what it exists for: `relayout()` measures
  // every card and re-runs the whole tidy-tree pass, so a burst of card resizes has to
  // coalesce into a single pass per frame or a fast stream repositions siblings on
  // every tick.
  let cardRelayoutRaf = null;
  function scheduleCardRelayout() {
    // The camera is moving: a card that changed its own box (one crossing the skip margin,
    // a log unfolding, an image that landed) must not re-place the whole tree under the
    // gesture. This is the path that made a free-spinning wheel stutter: every frame the
    // skip observer changed a card's size, the ResizeObserver asked for a pass, and
    // `relayout()` rebuilt the edges SVG and measured every card on each animation frame.
    // The pass runs once, when the view settles (`flushLayout`).
    if (viewMoving()) {
      layoutWanted = true;
      return;
    }
    if (cardRelayoutRaf != null) return;
    cardRelayoutRaf = requestAnimationFrame(() => {
      cardRelayoutRaf = null;
      measuredRelayout();
    });
  }

  // The name the streaming path reads by (`routeTo`): one case of the throttle above,
  // kept as its own name so that call site and its comment stay true.
  const scheduleSubAgentRelayout = scheduleCardRelayout;

  /**
   * Un-hide the card's log, the one place that decides it. Every append goes through
   * `routeTo`, so this is called there rather than at each `add*` helper — and a card
   * whose log is hidden only because it holds nothing (a pure-text turn) gets its box
   * back the moment something is written into it.
   */
  function showWorkLog(card) {
    const wrap = card && card.querySelector('.node-work-wrap');
    if (wrap) wrap.classList.remove('hidden');
  }

  // Route a streaming callback to a specific node's log: every streaming message
  // carries the `nodeId` it belongs to (spec §2.1), so the target is explicit and never
  // inferred from the view — a node that streams while the view sits elsewhere still
  // gets its deltas in its own (collapsed) card. A *missing* nodeId is the legacy shape
  // (the main agent's turn before P1): the callback then writes into the current
  // view-focus container, exactly as it always did. Either way the card's log is
  // un-hidden first (a card whose whole content is its answer starts with an empty log)
  // and after writing the card's transcript follows to the bottom (respects that card's
  // scroll lock).
  //
  // `kind` names the message being routed (`delta`, `thinkingDelta`, `usage`,
  // `toolCallDelta`, `toolStart`, `toolEnd`, else `append`) and exists for one
  // reason: a message that finds no card is thrown away here, and the report of that
  // loss has to say what was lost — see `perfCountDrop`.
  function routeTo(nodeId, fn, kind) {
    if (!nodeId) {
      // Legacy shape: the callback writes into the view-focus card's zone 2 (that
      // is what `messagesEl` points at), so that card's answer zone has to give its
      // run back before the append lands — same rule as the routed branch below.
      const focus = treeActiveId ? nodeEls[treeActiveId] : null;
      // No focus card either: the append lands in `messagesEl === null` and every
      // `add*` helper returns on its first line — the same silent loss the routed
      // branch counts below, in its one node-less form.
      if (!focus) perfCountDrop('', kind);
      if (focus) showWorkLog(focus);
      fn();
      return;
    }
    const card = nodeEls[nodeId];
    const itemsEl = card ? card.querySelector('.node-work') : null;
    if (!itemsEl) {
      // A node the tree does not have (the host streamed into a card this webview
      // never created): counted, and reported once per node.
      perfCountDrop(nodeId, kind);
      return;
    }
    // A card that was skipped while it was off screen is rendered again before anything is
    // appended into it: its own content is about to change, and it must change inside a
    // subtree the engine is measuring (see `cvObserver`).
    cvWake(card);
    // The one choke point every routed append goes through, and the one place the log
    // is un-hidden: the append is about to land in it.
    showWorkLog(card);
    const prevMsg = messagesEl;
    const prevPrompt = promptEl;
    const prevRouting = routingSubAgent;
    const prevNode = routingNodeId;
    const prevOpen = openSteps;
    messagesEl = itemsEl;
    promptEl = card.querySelector('.node-ask');
    // The routed append continues the run that card already has open — two nodes can
    // stream at once, so the group is per card and follows the log it is bound to.
    openSteps = card._openGroup || null;
    routingSubAgent = true;
    routingNodeId = nodeId;
    // Does this append add an item of its own to the card's log? Then the card owns this
    // node's items: they are the ones the turn's own stream wrote, and `_itemsRendered` is
    // the flag every render gate reads as "this DOM is the node's items, do not rebuild it"
    // (see the `[]` case in `itemsSource`). Counted before the callback because a summary
    // row now rides every finished node's `tree` / `path` entry (`itemsSource`): without
    // this, the repaint that follows a turn would replace the log the turn just streamed
    // with the two-item summary and ask the host for what is already on screen — the one
    // card the contract says must behave exactly as it did before summaries existed.
    const itemsBefore = itemsEl.children.length;
    try {
      fn();
    } finally {
      messagesEl = prevMsg;
      promptEl = prevPrompt;
      openSteps = prevOpen;
      routingSubAgent = prevRouting;
      routingNodeId = prevNode;
    }
    if (itemsEl.children.length > itemsBefore) card._itemsRendered = true;
    if (card && card._itemScroll) card._itemScroll.scrollToBottom();
    scheduleSubAgentRelayout();
  }

  // A sub-agent branch begins streaming: ensure its card, label it, add a Kill
  // button, and expand it so the live run is visible.
  function onAgentStart(msg) {
    if (!nodeEls[msg.id]) {
      createNodeCard(msg.id, treeNodes[msg.id] || { title: tr('Sub-agent'), status: 'running', kind: 'agent' });
    }
    const card = nodeEls[msg.id];
    if (!card) return;
    // A live sub-agent card is a *streaming* card: the log is the truth while it runs,
    // so its rows stay live (the thinking row open, the follow light on).
    card.classList.add('agent');
    card.classList.add('expanded');
    card.querySelector('.node-work-wrap').classList.remove('hidden');
    showWorkLog(card);
    setCardScrollLock(card, true);
    const head = card.querySelector('.node-head');
    syncAgentBadge(card, { kind: 'agent', agentWrite: msg.write });
    let info = card.querySelector('.node-agent-info');
    if (!info) {
      info = el('span', 'node-agent-info', '');
      // Keep the delete button at the far right of the head.
      const del = head.querySelector('.node-del');
      if (del) head.insertBefore(info, del); else head.appendChild(info);
    }
    // The caption names the model the way a human does — `modelName` is the display form
    // the host resolved (`cardDisplayName`), while `model` is the card's **id**, an opaque
    // GUID that is also twice as long. The head is a 320px row, so the id belongs in the
    // tooltip: the same id/display split the transcripts and the control plane use.
    info.textContent = tr('d{0} · {1} · {2}', msg.depth || 1, msg.modelName || msg.model || '', msg.write ? tr('write') : tr('ro'));
    info.title = tr('d{0} · {1} · {2}', msg.depth || 1, msg.model || '', msg.write ? tr('write') : tr('ro'));
    // The run's duration, next to the SUB line and left of the delete button: the
    // host hands over the start clock, the chip ticks it locally.
    syncElapsed(head, 'node-agent-elapsed', msg.startedAt, null, head.querySelector('.node-del'));
    if (treeNodes[msg.id]) {
      treeNodes[msg.id].agentStartedAt = msg.startedAt;
      treeNodes[msg.id].agentElapsedMs = undefined;
      treeNodes[msg.id].agentStatus = 'running';
    }
    if (!card.querySelector('.node-kill')) {
      const kill = el('button', 'node-kill', '✕');
      kill.title = tr('Kill this sub-agent');
      kill.addEventListener('click', (ev) => {
        ev.stopPropagation();
        vscode.postMessage({ type: 'killAgent', id: msg.id });
      });
      const del = head.querySelector('.node-del');
      if (del) head.insertBefore(kill, del); else head.appendChild(kill);
    }
    relayout();
  }

  // A sub-agent finished (done / killed / error): finalize its answer, patch the
  // card status/summary, drop the Kill button, and colour its connector edge.
  function onAgentDone(msg) {
    const card = nodeEls[msg.id];
    if (card) {
      // Its run is over: the finalize settles the rows (the thinking row to its one
      // line, the follow light released below).
      routeTo(msg.id, () => finalizeStreamingAnswer());
      const statusEl = card.querySelector('.node-status');
      if (statusEl) {
        // A run that was neither clean nor an error (`killed`) reads as interrupted,
        // exactly as it did before the label went through `statusLabel`.
        const shown = msg.status === 'done' || msg.status === 'error' ? msg.status : 'interrupted';
        statusEl.textContent = statusLabel(shown);
        statusEl.dataset.status = shown;
      }
      const kill = card.querySelector('.node-kill');
      if (kill) kill.remove();
      // Its response finished: release the follow light so it can be read.
      setCardScrollLock(card, false);
      card.classList.toggle('agent-done', msg.status === 'done');
      card.classList.toggle('agent-error', msg.status === 'error');
      if (treeNodes[msg.id]) {
        treeNodes[msg.id].agentStatus = msg.status;
        treeNodes[msg.id].agentSummary = msg.summary || '';
        treeNodes[msg.id].agentElapsedMs = msg.elapsedMs;
        treeNodes[msg.id].agentStartedAt = undefined;
      }
      // The run is over, so the chip stops where the host says it stopped — the
      // local tick would otherwise keep counting into a card that reads `done`.
      syncElapsed(card.querySelector('.node-head'), 'node-agent-elapsed', null, msg.elapsedMs, card.querySelector('.node-del'));
      if (msg.summary) {
        // Sub-agent cards get a one-line result footer (the card footer no
        // longer carries token/cache counts — the transcript's usage line does).
        let summaryEl = card.querySelector('.node-summary');
        if (!summaryEl) {
          summaryEl = el('div', 'node-summary');
          // Keep the footer above the composer when this card hosts it.
          card.insertBefore(summaryEl, composerEl.parentElement === card ? composerEl : null);
        }
        summaryEl.textContent = msg.summary.slice(0, 120);
      }
    }
    const edge = treeEdges.querySelector('[data-agent="' + msg.id + '"]');
    if (edge) {
      edge.classList.toggle('edge-done', msg.status === 'done');
      edge.classList.toggle('edge-error', msg.status === 'error');
    }
    relayout();
  }

  /**
 * `relayout()` with one diagnostic: a pass that takes 40 ms or more says so, and whether the
 * camera was moving when it ran (see `scheduleLayout`). The wheel stutter is a question of
 * *which* main-thread work a long frame is made of, and the tidy-tree layout of a large
 * session is the natural suspect.
 */
function measuredRelayout() {
  const t0 = perfNow();
  relayout();
  const ms = perfNow() - t0;
  if (ms >= 40) {
    perfPost('phase', {
      phase: 'layout',
      ms: Math.round(ms),
      moving: viewMoving() ? 1 : 0,
      cards: Object.keys(nodeEls).length,
    });
  }
}

function relayout() {
    // Nothing has to be cleared before the measurement any more: the layout writes no
    // inline size onto a card (media/tree.js hands out no rendered height), so every
    // pass already measures the cards' own, natural heights.
    // No-node mode: the placeholder card is the entire tree.
    if (composerCard) {
      layoutCells = Object.create(null);
      composerCard.style.left = '0px';
      composerCard.style.top = '0px';
      treeCanvas.style.width = composerCard.offsetWidth + 'px';
      treeCanvas.style.height = composerCard.offsetHeight + 'px';
      if (centerComposerCard) {
        centerComposerCard = false;
        zoom = 1;
        const wrap = treeWrap.getBoundingClientRect();
        pan.x = (wrap.width - composerCard.offsetWidth) / 2;
        pan.y = (wrap.height - composerCard.offsetHeight) / 2;
        applyTransform();
      }
      drawEdges();
      return;
    }
    // Measure the cards' own, natural heights: the layout is given these and hands out
    // no rendered height of its own, so what is measured here is what gets drawn.
    const heights = {};
    const widths = {};
    for (const id in nodeEls) {
      const card = nodeEls[id];
      if (!card) continue;
      heights[id] = card.offsetHeight || 120;
      widths[id] = card.offsetWidth || NODE_W;
      // A card woken because its own size changed gets its **new** box remembered here, so
      // `content-visibility` can skip it again: the placeholder must describe the card the
      // layout is using, never the one it was before the fold.
      if (card._cvFresh) {
        card._cvFresh = false;
        if (cvMaySkip(card)) {
          card.style.containIntrinsicSize = widths[id] + 'px ' + heights[id] + 'px';
          card.classList.add('cv-skip');
          cvSkipped.add(card);
        }
      }
      // A card that is showing its whole log is the size it will be next time: remember
      // that box for the waiting card of a later load (`applyLoadingSize`). A summary, an
      // unloaded card and a waiting one are all *not* that size.
      if (
        card._itemsRendered &&
        !card._itemsSummary &&
        !card._itemsUnloaded &&
        !card.classList.contains('items-loading')
      ) {
        rememberCardSize(id, heights[id]);
      }
      // …and the log's follow light is placed from the boxes this pass just laid out: its
      // `right` is the scroll gutter's own centre, never a fixed offset (`lockDotRight`).
      // The write is a style-only change on an absolutely positioned 8px box, so it changes
      // no number read here — and a box with no gutter yet (a hidden log) writes nothing.
      if (card._itemScroll && card._itemScroll.syncDot) card._itemScroll.syncDot();
    }
    // The session is a FOREST (§3): the engine lays out one tree at a time, so each
    // root gets its own pass and the results are placed left to right, in `rootIds`
    // order, separated by `ROOT_GAP`. Two trees therefore read as two parallel
    // conversations — each keeps its own tidy-tree geometry, sidecar grids and
    // connectors, and every card (focused tree or not) stays interactive: the canvas
    // click handler turns a click on any card's head into a `checkout`.
    const roots = treeRootIds.filter((id) => treeNodes[id]);
    // Neither `rootIds` nor a usable `rootId` (an empty session, or a payload that
    // names none): fall back to the engine's own answer for a missing root, which is
    // the degenerate empty canvas this function has always produced.
    const placed = roots.length > 0 ? roots : [treeRootId];
    const layoutOpts = {
      nodeW: NODE_W,
      hGap: H_GAP,
      vGap: V_GAP,
      widths,
      agentGap: AGENT_GAP,
      agentVGap: AGENT_VGAP,
      agentColGap: AGENT_COL_GAP,
      agentMaxRows: AGENT_MAX_ROWS,
      agentMonitorH: AGENT_MONITOR_H,
      agentTopPad: AGENT_TOP_PAD,
    };
    const pos = Object.create(null);
    const cells = Object.create(null);
    let rootX = 0;
    let canvasW = 0;
    let canvasH = 0;
    for (const root of placed) {
      const result = window.treeLayout.layoutTree(treeNodes, root, heights, layoutOpts);
      // One root's own coordinate space starts at (0, 0); every root sits on the
      // same top line, so `y` is never shifted and only the trees' horizontal
      // extents decide the gap between them.
      for (const id in result.pos) {
        pos[id] = { x: result.pos[id].x + rootX, y: result.pos[id].y };
      }
      for (const id in result.cells) {
        const c = result.cells[id];
        cells[id] = {
          x: c.x + rootX, y: c.y, w: c.w, h: c.h,
          col: c.col, row: c.row, index: c.index, count: c.count,
          busX: c.busX + rootX, chanX: c.chanX + rootX, corrY: c.corrY,
        };
      }
      canvasW = Math.max(canvasW, rootX + result.width);
      canvasH = Math.max(canvasH, result.height);
      // `result.width` is the tree's own extent plus the engine's right pad, and the
      // trailing constant is the gap the next root starts after.
      rootX += result.width + ROOT_GAP;
    }
    layoutCells = cells;
    treeCanvas.style.width = canvasW + 'px';
    treeCanvas.style.height = canvasH + 'px';
    for (const id in pos) {
      const card = nodeEls[id];
      if (card) {
        card.style.left = pos[id].x + 'px';
        card.style.top = pos[id].y + 'px';
      }
    }
    drawEdges();
    scheduleDiag();
  }

  // ---- Layout diagnostics: report overlapping cards + the tree's connections ----
  let diagTimer = null;
  function collectLayout() {
    const nodes = [];
    const boxes = [];
    for (const id in nodeEls) {
      const card = nodeEls[id];
      const n = treeNodes[id] || {};
      const b = {
        id,
        kind: n.kind || 'turn',
        parent: n.parentId || '',
        title: String(n.title || '').slice(0, 40),
        x: Math.round(parseFloat(card.style.left) || 0),
        y: Math.round(parseFloat(card.style.top) || 0),
        w: card.offsetWidth || 0,
        h: card.offsetHeight || 0,
      };
      nodes.push(b);
      boxes.push(b);
    }
    const overlaps = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ix > 0 && iy > 0) {
          overlaps.push({ a: a.id, b: b.id, ta: a.title, tb: b.title, over: Math.round(ix * iy) });
        }
      }
    }
    return { nodes, overlaps };
  }

  function collectConnections() {
    return Object.keys(treeNodes || {}).map((id) => ({
      parent: treeNodes[id].parentId || '',
      child: id,
    }));
  }

  function manualDiag() {
    const { nodes, overlaps } = collectLayout();
    vscode.postMessage({ type: 'layoutDiagnostic', nodes, overlaps, connections: collectConnections(), force: true });
  }

  // Auto-report only when a layout actually has overlapping cards (so a clean
  // layout stays silent), throttled.
  function scheduleDiag() {
    if (diagTimer != null) return;
    diagTimer = setTimeout(() => {
      diagTimer = null;
      const { nodes, overlaps } = collectLayout();
      if (overlaps.length) {
        vscode.postMessage({ type: 'layoutDiagnostic', nodes, overlaps, connections: collectConnections(), force: false });
      }
    }, 400);
  }

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault();
      manualDiag();
    }
  });

  // Rounded-corner orthogonal path from a list of axis-aligned waypoints.
  // Duplicate and collinear points are dropped first, so a simple L keeps its L.
  function elbowPath(waypoints, radius) {
    const f = (n) => Math.round(n * 100) / 100;
    const pts = [];
    for (const p of waypoints) {
      const last = pts[pts.length - 1];
      if (last && Math.abs(last.x - p.x) < 0.5 && Math.abs(last.y - p.y) < 0.5) continue;
      pts.push(p);
    }
    if (pts.length < 2) return '';
    const clean = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const c = pts[i + 1];
      if (a && c && Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) < 0.25) continue;
      clean.push(b);
    }
    let d = 'M ' + f(clean[0].x) + ' ' + f(clean[0].y);
    for (let i = 1; i < clean.length - 1; i++) {
      const prev = clean[i - 1];
      const cur = clean[i];
      const next = clean[i + 1];
      const lenIn = Math.hypot(cur.x - prev.x, cur.y - prev.y);
      const lenOut = Math.hypot(next.x - cur.x, next.y - cur.y);
      const r = Math.min(radius, lenIn / 2, lenOut / 2);
      if (r < 0.5) {
        d += ' L ' + f(cur.x) + ' ' + f(cur.y);
        continue;
      }
      const inX = cur.x + ((prev.x - cur.x) / lenIn) * r;
      const inY = cur.y + ((prev.y - cur.y) / lenIn) * r;
      const outX = cur.x + ((next.x - cur.x) / lenOut) * r;
      const outY = cur.y + ((next.y - cur.y) / lenOut) * r;
      d += ' L ' + f(inX) + ' ' + f(inY) + ' Q ' + f(cur.x) + ' ' + f(cur.y) + ' ' + f(outX) + ' ' + f(outY);
    }
    const end = clean[clean.length - 1];
    return d + ' L ' + f(end.x) + ' ' + f(end.y);
  }

  function drawEdges() {
    if (!treeEdges) return;
    treeEdges.setAttribute('width', treeCanvas.style.width || '0');
    treeEdges.setAttribute('height', treeCanvas.style.height || '0');
    const parts = [];
    for (const id in nodeEls) {
      const meta = treeNodes[id];
      if (!meta || !meta.parentId) continue;
      const child = nodeEls[id];
      const parent = nodeEls[meta.parentId];
      if (!child || !parent) continue;
      const isAgent = isSidecarKind(meta.kind);
      const edgeCls = meta.kind === 'bg'
        ? (meta.bgKilled ? ' edge-error' : (meta.delivered ? ' edge-done' : ''))
        : (meta.agentStatus === 'done' ? ' edge-done' : meta.agentStatus === 'error' ? ' edge-error' : '');
      const px = parseFloat(parent.style.left);
      const py = parseFloat(parent.style.top);
      const pw = parent.offsetWidth;
      const ph = parent.offsetHeight;
      const cx = parseFloat(child.style.left);
      const cy = parseFloat(child.style.top);
      const cw = child.offsetWidth;
      const ch = child.offsetHeight;
      if (isAgent) {
        // Orthogonal elbow through the corridors the layout reserved for this
        // window (media/tree.js `cells`): parent right edge → the channel between
        // the card and the grid → the gap above this window's row → the gap left
        // of its column → into the window's left edge. Every segment runs in a
        // card-free corridor, so the connector crosses no card at all (the
        // previous spline cut across the nearer columns' windows).
        const cls = edgeCls;
        const route = layoutCells[id];
        const pr = px + pw;
        let d = '';
        if (route) {
          // Exits are spread over the card's right edge instead of all leaving
          // from its middle, so a wide fan-out stays readable.
          const exitY = py + (ph * (route.index + 1)) / (route.count + 1);
          const midY = cy + ch / 2;
          const pts = [{ x: pr, y: exitY }, { x: route.busX, y: exitY }];
          if (route.col > 0) pts.push({ x: route.busX, y: route.corrY }, { x: route.chanX, y: route.corrY });
          pts.push({ x: route.chanX, y: midY }, { x: cx, y: midY });
          d = elbowPath(pts, 6);
        }
        if (!d) {
          // Fallback (no routing table yet): the old spline.
          const pyMid = py + ph / 2;
          const cyMid = cy + ch / 2;
          const mx = (pr + cx) / 2;
          d = 'M ' + pr + ' ' + pyMid + ' C ' + mx + ' ' + pyMid + ', ' + mx + ' ' + cyMid + ', ' + cx + ' ' + cyMid;
        }
        parts.push('<path data-agent="' + id + '" class="edge-agent' + cls + '" d="' + d + '" />');
      } else {
        const childMidX = cx + cw / 2;
        const parentBottomX = px + pw / 2;
        const parentBottomY = py + ph;
        const mx = (parentBottomX + childMidX) / 2;
        // A dashed connector is the visual mark of a context-window boundary, and
        // it belongs to the window-starting node's *own* connector: only the child
        // carrying `contextBaseId` is dashed, its descendants are ordinary turn
        // edges again. The compression chain gets **dots**: both halves of it (the
        // compression node under the window it reads, and the window it produces
        // under itself) are a different kind of break than a plain window start, and
        // the dotted edge is what makes a P -> C -> R run readable at a glance.
        const dotted = meta.role === 'compress' || meta.role === 'resume';
        const cls = dotted
          ? ' class="edge-compress"'
          : meta.contextBaseId && meta.contextBaseId === meta.id
            ? ' class="edge-context"'
            : '';
        parts.push('<path' + cls + ' d="M ' + parentBottomX + ' ' + parentBottomY + ' C ' + mx + ' ' + parentBottomY + ', ' + mx + ' ' + cy + ', ' + childMidX + ' ' + cy + '" />');
      }
    }
    treeEdges.innerHTML = parts.join('');
  }

  function applyTransform() {
    treeCanvas.style.transform = 'translate(' + pan.x + 'px, ' + pan.y + 'px) scale(' + zoom + ')';
  }

  /**
   * The roots of the forest a `tree` payload describes, in render order.
   *
   * `rootIds` is the shape a forest host sends (§3); `rootId` — always its first
   * entry — is kept for replay shapes that predate the forest and for a payload
   * that carries only one tree. A payload that names neither still gets a usable
   * view: every node without a parent *in this payload* is a root, which is exactly
   * what the single-tree shapes meant.
   */
  function rootIdsOf(tree, nodes) {
    const ids = [];
    if (Array.isArray(tree.rootIds)) {
      for (const id of tree.rootIds) {
        if (typeof id === 'string' && nodes[id]) ids.push(id);
      }
    }
    if (ids.length === 0 && tree.rootId && nodes[tree.rootId]) ids.push(tree.rootId);
    if (ids.length === 0) {
      for (const id in nodes) {
        const n = nodes[id];
        if (n && (n.parentId == null || !nodes[n.parentId])) ids.push(id);
      }
    }
    return ids;
  }

  function renderTree(tree) {
    // The cards this menu was opened on are about to be rebuilt / removed, so a
    // menu that stayed up would point at a node the session no longer has.
    closeNodeMenu();
    treeNodes = Object.create(null);
    for (const n of tree.nodes || []) treeNodes[n.id] = n;
    treeRootIds = rootIdsOf(tree, treeNodes);
    treeRootId = treeRootIds.length > 0 ? treeRootIds[0] : null;
    // The view focus is independent of the stream target (spec §2.2): the tree
    // expands / docks on `viewId`, while `activeId` (the node currently streaming)
    // is only there for hosts that predate the split.
    treeActiveId = orElse(orElse(tree.viewId, tree.activeId), null);
    activePathSet = new Set(pathIdsFromTree(treeNodes, treeActiveId));

    for (const id in treeNodes) {
      if (!nodeEls[id]) createNodeCard(id, treeNodes[id]);
      const card = nodeEls[id];
      const n = treeNodes[id];
      if (card) {
        const statusEl = card.querySelector('.node-status');
        if (statusEl) statusEl.textContent = statusLabel(n.status);
        syncContinueButton(card, n);
        // A repaint never leaves an editor (or a stale textarea) behind, and the
        // pencil's own gates — running / locked — come from this same description.
        cancelAskEdit(card);
        syncAskEdit(card);
        // A card `renderPath` created from a node the `tree` had not described yet
        // still has to pick its context marker and its sub-agent badge up here (never
        // in a streaming patch: the head exists once).
        syncCtxBadge(card, n);
        syncHandoffCard(card, n);
        syncCacheColor(card, n);
        syncUsageBar(card, n);
        syncAgentBadge(card, n);
      }
    }
    for (const id in nodeEls) {
      if (!treeNodes[id]) {
        // The card is going, so items still queued for it can never arrive: it leaves
        // the queue (and the viewport watcher) with the card.
        forgetItems(id);
        // A waiting card's timer goes with it: a card removed while its 5 s wait is still
        // ticking would otherwise be held (and re-classed) after the tree dropped it.
        setCardLoading(nodeEls[id], false);
        // A card that leaves the tree is unobserved with it: the one card observer holding
        // a detached element would keep a dead card (and its id) alive between sessions.
        cardUnobserve(nodeEls[id]);
        nodeEls[id].remove();
        delete nodeEls[id];
      }
    }

    for (const id in nodeEls) {
      const meta = treeNodes[id] || { title: '', status: 'done', preview: '' };
      const onPath = activePathSet.has(id) || agentExpanded(id);
      // A **sidecar** card — a sub-agent window or a job card — is a monitor unless it
      // *is* the focused node: only that one renders as the ordinary expanded card (it is
      // on the active path, so the branch below would expand it anyway), and every other
      // sidecar is the fixed 200px window. That is the "at most one full card per window
      // group" rule, and the sidecar branch has to come first: `agentExpanded` keeps a
      // sub-agent of an expanded parent open, and open now means a monitor. A turn node
      // keeps the rule it had.
      const monitor = isSidecarKind(meta.kind) && id !== treeActiveId;
      if (monitor) {
        monitorCard(id, meta, pathNodes[id]);
      } else if (onPath) {
        expandedCard(id, meta, pathNodes[id]);
      } else {
        collapsedCard(id, meta);
      }
      applyDeliveredBadge(nodeEls[id], meta);
      // Same reason as in `renderTree`: the context marker and the sub-agent badge
      // belong to the card's whole life, not to one repaint, and this pass may have
      // created the card before the node's own `tree` entry described it.
      syncCtxBadge(nodeEls[id], meta);
      syncAgentBadge(nodeEls[id], meta);
      // A job card has no conversation: its body mirrors the live job.
      if (meta.kind === 'bg') {
        renderBgBody(nodeEls[id], meta);
      }
      // A sub-agent head outlives the transcript rebuilds below it, so its elapsed
      // chip is derived from the node's own meta on every pass: still ticking while
      // the run is live (`agentStartedAt` + `agentStatus`), frozen at the host's
      // `agentElapsedMs` once it ended, and absent when neither is known. The
      // registry lookup inside `syncElapsed` is what keeps a repaint from stacking
      // one chip per pass.
      if (meta.kind === 'agent' || meta.agentStartedAt != null || meta.agentElapsedMs != null) {
        const agentLive = meta.agentStatus === 'running' && typeof meta.agentStartedAt === 'number';
        syncElapsed(
          nodeEls[id].querySelector('.node-head'),
          'node-agent-elapsed',
          agentLive ? meta.agentStartedAt : null,
          !agentLive && typeof meta.agentElapsedMs === 'number' ? meta.agentElapsedMs : null,
          nodeEls[id].querySelector('.node-del'),
        );
      }
    }
    setActiveLeaf(treeActiveId);
    if (Object.keys(nodeEls).length === 0) {
      showComposerCard();
    } else {
      hideComposerCard();
    }
    perfRelayout();
    if (follow) keepActiveInView();
    updateFollowButton();
    updateBranchBanner();
    updateComposerButtons();
    // A reveal waiting for its card consumes this repaint, and a card the repaint rebuilt
    // has no marks on it any more (see `findAfterRender`).
    findAfterRender();
  }

  // The active path's items (checkout / session switch / panel reopen). This is
  // self-sufficient: it derives the active id + path from `path.ids` and only
  // updates/collapses existing cards, so a checkout never tears the tree down.
  function renderPath(path) {
    pathNodes = Object.create(null);
    for (const n of path.nodes || []) pathNodes[n.id] = n;
    // The path is the *view* path (spec §2.2): its last id is the view focus, i.e.
    // the node the composer docks in — not necessarily the node that is streaming.
    treeActiveId = path.ids && path.ids.length ? path.ids[path.ids.length - 1] : null;
    activePathSet = new Set(path.ids || []);
    for (const id of path.ids || []) {
      if (!nodeEls[id]) {
        createNodeCard(id, treeNodes[id] || { title: '', status: 'done' });
      }
    }
    // Only populate nodes that were never rendered — a turn's items are immutable
    // once its turn ends, so nodes already on the path keep their DOM (this made
    // checkout of an already-rendered branch near-free instead of re-markdown-ing
    // every message).
    for (const id of path.ids || []) {
      const pnode = pathNodes[id];
      if (!pnode) continue;
      const card = nodeEls[id];
      // A card whose items did not ride the `path` (`itemCount`-only sidecars, and a
      // regular node for a surface that never got a `path` at all) is filled by its own
      // fetch: `agentItems` / `nodeItems` land in `applyFetchedItems` after
      // `expandedCard` below asks for them, so there is nothing to render here.
      //
      // A `path` row that is a *summary* (`summary: true`, a finished node) still renders
      // here: it is content, and `_itemsSummary` records that the log behind it is missing —
      // which is what makes `expandedCard` below post the one `loadNodeItems`. A *full* row
      // landing on a card that already rendered a summary is not rendered here either: the
      // second loop below calls `expandedCard` for every id of this same message, and the
      // one place that prefers a real row over a summary is `itemsSource`.
      const pathSummary = !!pnode.summary;
      if (pnode.items && !card._itemsRendered) {
        renderNodeItems(
          card,
          pnode.items,
          (treeNodes[id] || {}).status !== 'running',
        );
        card._itemsRendered = true;
        card._itemsSummary = pathSummary;
        // The path answered the card before any fetch could: stop claiming otherwise.
        // A *summary* is not that answer — if the card has a request out (the `tree` pass
        // posted the same one-shot ask), it is still unanswered and `itemsWanted` keeps
        // it, so clearing the strip here would say the log had arrived.
        if (!pathSummary) setCardLoading(card, false);
        // Same finished-node default as in expandedCard: the thinking blocks only
        // exist now, and this path skips expandedCard's render branch.
        if ((treeNodes[id] || {}).status !== 'running') {
          setCardScrollLock(card, false);
          card._needsBottomScroll = true;
        }
      }
      if (card._itemScroll) card._itemScroll.scrollToBottom();
    }
    for (const id in nodeEls) {
      const meta = treeNodes[id] || { title: '', status: 'done', preview: '' };
      // A repaint never leaves an editor (or a stale textarea) behind: the rendered ask
      // goes back **before** this pass re-describes the card, and the pencil is re-read
      // after it (its gates are the node's status and the two sets `state` fills). Same
      // rule as the first pass in `renderTree`.
      cancelAskEdit(nodeEls[id]);
      const onPath = activePathSet.has(id) || agentExpanded(id);
      // Same rule as in `renderTree`: a sidecar is a monitor unless it is the focused
      // node, which is the one card that still renders as the ordinary expanded card.
      const monitor = isSidecarKind(meta.kind) && id !== treeActiveId;
      if (monitor) {
        monitorCard(id, meta, pathNodes[id]);
      } else if (onPath) {
        expandedCard(id, meta, pathNodes[id]);
      } else {
        collapsedCard(id, meta);
      }
      applyDeliveredBadge(nodeEls[id], meta);
      // Same story as in `renderTree`: the context marker and the sub-agent badge
      // belong to the card, not to one repaint — and this pass can be the one that
      // creates the card.
      syncCtxBadge(nodeEls[id], meta);
      syncAgentBadge(nodeEls[id], meta);
      syncAskEdit(nodeEls[id]);
      // A job card has no conversation: its body mirrors the live job.
      if (meta.kind === 'bg') {
        renderBgBody(nodeEls[id], meta);
      }
      // Same rule as the identical pass in `renderTree`: this loop can be the one
      // that creates a card, and a sub-agent's head chip is derived from the node's
      // own meta — leaving it out here would show a live run with no clock until the
      // next `tree` arrived.
      if (meta.kind === 'agent' || meta.agentStartedAt != null || meta.agentElapsedMs != null) {
        const agentLive = meta.agentStatus === 'running' && typeof meta.agentStartedAt === 'number';
        syncElapsed(
          nodeEls[id].querySelector('.node-head'),
          'node-agent-elapsed',
          agentLive ? meta.agentStartedAt : null,
          !agentLive && typeof meta.agentElapsedMs === 'number' ? meta.agentElapsedMs : null,
          nodeEls[id].querySelector('.node-del'),
        );
      }
    }
    setActiveLeaf(treeActiveId);
    if (Object.keys(nodeEls).length === 0) {
      showComposerCard();
    } else {
      hideComposerCard();
    }
    perfRelayout();
    if (follow) keepActiveInView();
    updateBranchBanner();
    updateComposerButtons();
    // The checkout a find jump asked for lands here: its card is now expanded, so the
    // pending reveal can centre it and mark the hit inside it.
    findAfterRender();
  }

  // ---- No-node mode: a bare node card that holds only the input ----
  // With no node yet there is nothing to host the send pane, so a placeholder
  // card (head + input, no prompt/transcript) is the only card in the tree
  // canvas — it pans and zooms with the view like any node. It is dropped as
  // soon as the first node exists.
  let composerCard = null;
  let centerComposerCard = false;   // centre the view on it once, on creation

  function showComposerCard() {
    if (!composerCard) {
      composerCard = el('div', 'node expanded active composer-node');
      const head = el('div', 'node-head');
      head.appendChild(el('span', 'node-title', tr('New session')));
      head.addEventListener('click', () => inputEl.focus());
      composerCard.appendChild(head);
      treeCanvas.appendChild(composerCard);
      // The placeholder is a card like any other for the layout — it grows and shrinks
      // with the composition area — so the one card observer watches it too (see
      // `cardResizeObserver`).
      cardObserve(composerCard);
      centerComposerCard = true;
    }
    setComposerVisible(true);   // before mounting: autoGrow() needs a rendered input
    mountComposer(composerCard);
  }

  function hideComposerCard() {
    if (!composerCard) return;
    // It leaves the tree here, so the observer lets go of it in the same breath: an
    // observed card that is detached from the canvas is one record about a card that no
    // longer exists (see `cardResizeObserver`).
    cardUnobserve(composerCard);
    composerCard.remove();
    composerCard = null;
  }

  function panToNode(id) {
    const card = nodeEls[id];
    if (!card) return;
    const wrap = treeWrap.getBoundingClientRect();
    const cx = parseFloat(card.style.left) + card.offsetWidth / 2;
    const cy = parseFloat(card.style.top) + card.offsetHeight / 2;
    pan.x = wrap.width / 2 - cx * zoom;
    pan.y = wrap.height / 2 - cy * zoom;
    applyTransform();
  }

  function keepActiveInView() {
    if (follow && treeActiveId) panToNode(treeActiveId);
  }

  // rAF-throttled so a fast stream can never drive more than one pan/layout per
  // frame, and suppressed entirely while routing a sub-agent's deltas.
  let followRaf = null;
  function followActive() {
    // Suppressed while routing a sub-agent's deltas, and while a finished card's
    // history window is painted — scrolling a transcript the user is reading must
    // never move the camera.
    if (routingSubAgent || suppressFollow) return;
    if (followRaf != null) return;
    followRaf = requestAnimationFrame(() => {
      followRaf = null;
      keepActiveInView();
      const card = treeActiveId ? nodeEls[treeActiveId] : null;
      if (card && card._itemScroll) card._itemScroll.scrollToBottom();
      // The debounced layout is scheduled for EVERY turn whose content changed, whichever
      // card grew. This used to be gated on the focused node having children, which is the
      // case that was missed: the focused card's own height is what the placement has to
      // follow, and a focused node with no children grows its card exactly like any other
      // — nothing scheduled a pass for it, so it kept its old box and painted over the
      // expanded card above it (the case `cardResizeObserver` now also covers from the other
      // end — the card's own resize).
      scheduleLayout();
    });
  }

  // Follow a live turn without guessing from scroll position: a card's green
  // light is engaged when its response starts and released when it finishes, so
  // the user can read the finished result without touching the light.
  function setActiveScrollLock(locked) {
    setCardScrollLock(treeActiveId ? nodeEls[treeActiveId] : null, locked);
  }

  let layoutDebounce = null;
  let layoutWanted = false;

  function scheduleLayout() {
    // The camera is moving: re-placing the whole tree is exactly what must not happen under
    // a gesture. A card that grew during the scroll keeps its old box for the moment; one
    // pass runs when the view settles (`flushLayout`), which is what removes the relayout
    // churn the wheel used to cause (a card crossing the skip margin changes its box, the
    // `ResizeObserver` fires, and the old code re-placed the tree every 150 ms throughout).
    if (viewMoving()) {
      layoutWanted = true;
      return;
    }
    if (layoutDebounce != null) return;
    layoutDebounce = setTimeout(() => {
      layoutDebounce = null;
      measuredRelayout();
    }, 150);
  }

  /** Run the pass a moving camera postponed, once it is quiet. */
  function flushLayout() {
    if (!layoutWanted || viewMoving()) return;
    layoutWanted = false;
    if (layoutDebounce != null) {
      clearTimeout(layoutDebounce);
      layoutDebounce = null;
    }
    measuredRelayout();
  }

  // ---- One ResizeObserver, every card ----------------------------------------
  // The canvas places its cards absolutely from the heights `relayout()` measured, so a
  // card that grows AFTER a pass keeps its old box and paints over its neighbours: the
  // focused card (`.node.active`, z-index 3) then covers an expanded card above it —
  // exactly 163px of spacing under a 317px sidecar card, reported as `OVERLAP` on the
  // channel. Every re-layout today is scheduled site by site (a repaint, a routed append,
  // an agent starting or finishing, a fold, a drag commit), and each of those sites names
  // the card it expects to change. One observer over the cards themselves closes that gap
  // at the source: a card is re-placed because *its own box* changed, whatever changed it.
  //
  // It only SCHEDULES (`scheduleCardRelayout`, one layout per frame). Running
  // `relayout()` here would measure cards and write inline heights while the browser is
  // still delivering resize records, which is the one place a layout pass may not run.
  //
  // Feature-guarded: a real browser always has `ResizeObserver`, and the offline webview
  // checker's DOM stub has a no-op one. A platform that has none must still run this file,
  // so both entry points below do nothing at all when the observer is absent — nothing
  // here may throw. There is exactly ONE instance for the whole webview, never one per
  // card: an observer per card would report the same growth through N callbacks and hold
  // N objects alive.
  const cardResizeObserver =
    typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onCardResize) : null;

  /** Watch this card's box (see `cardResizeObserver`). */
  function cardObserve(card) {
    if (cardResizeObserver && card) cardResizeObserver.observe(card);
  }

  /** Stop watching a card that leaves the tree (removed, or the session reset). */
  function cardUnobserve(card) {
    if (cardResizeObserver && card) cardResizeObserver.unobserve(card);
    if (card) {
      cancelUnload(card);
      card._itemsDeferred = null;
      if (virtLoadObserver) virtLoadObserver.unobserve(card);
      if (virtUnloadObserver) virtUnloadObserver.unobserve(card);
    }
  }

  /**
   * A card's own box changed (see `cardResizeObserver`). One entry is ignored:
   *
   *  - a height of 0 — a card that is hidden, not measured yet, or skipped by the engine
   *    with no remembered box to size it by. There is no size there for a layout to use,
   *    and the skipping itself is `cvObserver`'s business, not this one's.
   *
   * Anything else is a real change of size, and the answer to one is a *scheduled*
   * re-layout — never a `relayout()` in here. The layout writes no inline size onto a
   * card any more (media/tree.js hands out no rendered height), so there is no
   * self-inflicted resize left to filter out: what grows a card is its own content, a
   * user's drag, or the answer split.
   */
  function onCardResize(entries) {
    try {
      for (const entry of entries) {
        const card = entry.target;
        // `offsetHeight`, not the entry's content box: it is the measure `relayout()`
        // reads, and a card's padding and border are part of its size here.
        const h = card.offsetHeight || 0;
        if (!h) continue;
        scheduleCardRelayout();
        return;
      }
    } catch (err) {
      /* a layout aid must never break the UI */
    }
  }

  function fitToView() {
    const wrap = treeWrap.getBoundingClientRect();
    const w = parseFloat(treeCanvas.style.width) || 800;
    const h = parseFloat(treeCanvas.style.height) || 600;
    const pad = 48;
    const scale = Math.min(1.5, Math.max(0.25, Math.min((wrap.width - pad * 2) / w, (wrap.height - pad * 2) / h)) || 1);
    zoom = scale;
    pan.x = (wrap.width - w * zoom) / 2;
    pan.y = (wrap.height - h * zoom) / 2;
    applyTransform();
  }

  function updateFollowButton() {
    if (followBtn) {
      followBtn.classList.toggle('active', follow);
      followBtn.title = follow ? tr('Following the active node') : tr('Follow the active node');
    }
  }

  function setFollow(value) {
    follow = !!value;
    updateFollowButton();
    if (follow) keepActiveInView();
  }

  // ---- Card resize: wireframe preview while dragging; layout on mouse-up ----
  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function startResize(id, card, e) {
    e.preventDefault();
    e.stopPropagation();
    try { e.target.setPointerCapture(e.pointerId); } catch { /* noop */ }
    beginResize(id, card, e.clientX, e.clientY);
  }

  /**
   * The resize gesture's state and its wireframe, from a **point** rather than from an event.
   *
   * WHY IT TAKES COORDINATES. A mouse drags `.node-resize` through `pointerdown`, and a finger
   * goes through the touch layer (`touchGesture.kind === 'resize'`). The pointer path alone is
   * not enough on a touch screen: the browser claims the drag as its own gesture and answers the
   * page with `pointercancel`, and the window's handler above reads that as "the resize was
   * abandoned" — the wireframe vanished a few pixels into every finger drag and nothing was ever
   * committed. One state machine with two entry points is what keeps the two inputs from drifting
   * apart; only the parts that are genuinely pointer-specific (the capture, the default action of
   * a mouse event) stay with the caller.
   */
  function beginResize(id, card, clientX, clientY) {
    const meta = treeNodes[id];
    const draggedH = meta && meta.size && meta.size.h ? meta.size.h : 0;
    resizing = {
      id,
      startX: clientX,
      startY: clientY,
      startW: card.offsetWidth,
      startH: card.offsetHeight,
      // The drag's own ceiling. `MAX_H` is the base, but a card can legitimately be
      // taller than it: a `size.h` the user dragged earlier is a height they asked
      // for, and the card's content may have grown past it since. Clamping to `MAX_H`
      // alone would snap such a card — and the preview with it — down to 1200 the
      // moment the handle is touched, and store that 1200 as the card's size. So the
      // ceiling is the largest of the three: the base, the height the card has right
      // now, and the drag height it remembers. One number for both the wireframe and
      // the commit (see `onResizeMove` / `endResize`).
      ceilH: Math.max(MAX_H, card.offsetHeight, draggedH),
      // The floor is not a flat `MIN_H` either: a card has to keep room for the log
      // under its own header, prompt and input pane, or the log is squeezed to zero and
      // has nothing to scroll.
      floorH: Math.max(MIN_H, cardFixedHeight(card) + SPLIT_FLOOR_PX),
      target: { w: card.offsetWidth, h: card.offsetHeight },
    };
    resizePreview = el('div', 'resize-preview');
    resizePreview.appendChild(el('span', 'resize-label', card.offsetWidth + ' × ' + card.offsetHeight));
    resizePreview.style.left = card.style.left;
    resizePreview.style.top = card.style.top;
    resizePreview.style.width = card.offsetWidth + 'px';
    resizePreview.style.height = card.offsetHeight + 'px';
    treeCanvas.appendChild(resizePreview);
  }

  function onResizeMove(e) {
    if (!resizing) return;
    // Cursor delta is in screen pixels; the card size is in canvas units, so at
    // zoom != 1 dividing keeps the edge tracking 1:1 under the cursor.
    const dw = (e.clientX - resizing.startX) / zoom;
    const dh = (e.clientY - resizing.startY) / zoom;
    const w = clamp(resizing.startW + dw, MIN_W, MAX_W);
    // `startH + dh` is clamped at `resizing.ceilH` (see `beginResize`), so the wireframe
    // can never advertise a height the commit would not store — and at the card's own
    // `floorH`, which keeps the log usable.
    const h = clamp(resizing.startH + dh, resizing.floorH || MIN_H, resizing.ceilH);
    resizing.target = { w, h };
    // Throttle to one paint per frame; only the wireframe moves.
    if (resizeRaf != null) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = null;
      if (resizePreview && resizing) {
        resizePreview.style.width = resizing.target.w + 'px';
        resizePreview.style.height = resizing.target.h + 'px';
        const label = resizePreview.querySelector('.resize-label');
        if (label) label.textContent = resizing.target.w + ' × ' + resizing.target.h;
      }
    });
  }

  function endResize(commit) {
    if (!resizing) return;
    const { id, target } = resizing;
    resizing = null;
    if (resizePreview) { resizePreview.remove(); resizePreview = null; }
    if (resizeRaf != null) { cancelAnimationFrame(resizeRaf); resizeRaf = null; }
    if (!commit || !target) return;
    const card = nodeEls[id];
    if (!card) return;
    card.style.width = target.w + 'px';
    card.style.maxHeight = target.h + 'px';
    if (treeNodes[id]) treeNodes[id].size = { w: target.w, h: target.h };
    // Collision resolution runs once, on mouse-up.
    relayout();
    if (card._itemScroll) card._itemScroll.scrollToBottom();
    vscode.postMessage({ type: 'setNodeSize', id, w: target.w, h: target.h });
  }

  treeCanvas.addEventListener('pointerdown', (e) => {
    // Resizing is a left-button gesture: RMB belongs to autoscroll, and MMB to
    // pan, so neither must grab the handle.
    if (e.button !== 0) return;
    // A finger does not resize through this path. The browser claims a touch drag as
    // its own gesture and answers with `pointercancel` a few pixels in — which the
    // window handler below reads as "the resize was abandoned", tearing the wireframe
    // down mid-drag and never committing it. Touch resizes through the touch layer's
    // `resize` gesture instead (same `beginResize`, same outcome), so the two entry
    // points must not both fire for one finger.
    if (e.pointerType === 'touch') return;
    const handle = e.target.closest('.node-resize');
    if (!handle) return;
    const card = handle.closest('.node');
    const id = card && card.dataset.id;
    if (!id) return;
    startResize(id, card, e);
  });

  // ---- Pan / zoom ----
  // The camera's gestures: LMB/MMB drag pans by offset, RMB-hold autoscroll-pans
  // towards the cursor, ctrl/cmd + wheel zooms around the pointer, alt + wheel pans
  // vertically from anywhere (cards, thinking blocks and the composer included),
  // shift + wheel pans horizontally, and a plain wheel zooms — except over a native
  // scroll zone, which keeps its own. The touch layer below adds one-finger pan and
  // two-finger pinch.
  let dragging = null;
  // The touch layer's live gesture (see "Touch" below) or null. It lives up here
  // because the pointer pan below has to stand down while a finger owns the camera.
  let touchGesture = null;
  treeWrap.addEventListener('pointerdown', (e) => {
    // A finger never pans through the pointer path: its `pointerdown` is dispatched
    // *before* its `touchstart`, so the touch layer's flag cannot be set yet — the
    // pointer type is the only thing known this early. Belt and braces, because the
    // same guard has to hold for every later event of that gesture too: the flag
    // catches a compatibility pointer stream that arrives once a touch gesture is
    // already running, which is the stream the touch layer's `preventDefault()`
    // silences (that cancellation, not this line, is what keeps the browser from
    // synthesising the mouse events behind the finger).
    if (e.pointerType === 'touch' || touchGesture) return;
    const isMmb = e.button === 1;
    if (!isMmb && e.target.closest('.node')) {
      // Left-click on a card is handled by the checkout click handler; do not pan.
      return;
    }
    if (e.button === 0 || isMmb) {
      dragging = { startX: e.clientX, startY: e.clientY, px: pan.x, py: pan.y };
      e.preventDefault();
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ }
      // A wheel-driven camera move may still be open (its idle timer has not fired): close
      // it before this drag owns the pan slot, or its record would never be reported.
      perfPanEnd();
      perfPan = perfGestureOpen('pan');
    }
  });
  window.addEventListener('pointermove', (e) => {
    if (resizing) { onResizeMove(e); return; }
    if (!dragging) return;
    const perfT0 = perfPan ? perfNow() : 0;
    pan.x = dragging.px + (e.clientX - dragging.startX);
    pan.y = dragging.py + (e.clientY - dragging.startY);
    applyTransform();
    setFollow(false);
    noteViewMove();
    if (perfT0) perfGestureEvent(perfPan, perfNow() - perfT0);
  });
  window.addEventListener('pointerup', () => {
    if (resizing) { endResize(true); return; }
    dragging = null;
    perfPanEnd();
  });
  window.addEventListener('pointercancel', () => {
    if (resizing) { endResize(false); return; }
    dragging = null;
    perfPanEnd();
  });
  // Safety: if the pointer capture is released without a clean pointerup (e.g. the
  // cursor left the webview mid-drag), end the gesture so it never gets stuck.
  window.addEventListener('lostpointercapture', () => {
    if (resizing) { endResize(false); return; }
    dragging = null;
    perfPanEnd();
  });
  window.addEventListener('auxclick', (e) => {
    if (e.button === 1) e.preventDefault();
  });

  // ---- Right-button autoscroll pan (the browser's middle-click autoscroll) ----
  // The press point becomes an origin and the view keeps travelling towards the
  // cursor, at a speed proportional to how far the cursor is from that origin.
  // Unlike the drag-pan above, the pan continues while the cursor sits still —
  // that is the whole point of the mode.
  //
  // Cursor: there is no diagonal *pan* cursor to use. CSS has exactly two
  // bidirectional diagonal glyphs (`nesw-resize` / `nwse-resize`) and both are
  // resize cursors that would read as "resize this card" on a tree of cards, so
  // the gesture uses `all-scroll` — the 4-way glyph Chrome itself shows for its
  // middle-click autoscroll — and the origin marker carries the "any direction"
  // meaning instead.
  const AUTOSCROLL_DEAD_PX = 10;     // slack around the origin before it moves
  const AUTOSCROLL_RAMP_PX = 600;    // cursor offset at which the curve saturates
  const AUTOSCROLL_MAX_PX_S = 2400;  // speed the curve converges to (2400 px/s)
  let autoscroll = null;                // { originX, originY, x, y, last, raf }
  let autoscrollEl = null;              // origin marker (pinned to the viewport)
  // Whether the RMB gesture in flight started somewhere a context menu is
  // actually useful: node content (copy the selected text) or the composer
  // (paste). A press on the canvas background is a pan request, never a menu
  // request — see the `contextmenu` listener below for why that matters.
  let rmbPressWantsMenu = true;

  // easeOutExpo, right-way-round: `t` is the cursor offset normalised by
  // AUTOSCROLL_RAMP_PX, and the curve returns the *fraction of max speed*.
  // Steep out of the origin (a 30px nudge is already ~30% of max) and then one
  // long flat tail, so the far end can never outrun what the eye can track and a
  // wider panel does not need a bigger cap — only a bigger AUTOSCROLL_RAMP_PX.
  // The `t >= 1` case is the textbook 1 - 2^-10t guard: at t = 1 the formula
  // gives 0.999, not 1.
  function autoscrollEase(t) {
    return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
  }

  function autoscrollSpeed(dist) {
    const t = clamp((dist - AUTOSCROLL_DEAD_PX) / AUTOSCROLL_RAMP_PX, 0, 1);
    return AUTOSCROLL_MAX_PX_S * autoscrollEase(t);
  }

  function startAutoscroll(e) {
    autoscroll = {
      originX: e.clientX,
      originY: e.clientY,
      x: e.clientX,
      y: e.clientY,
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
    autoscrollEl.style.left = e.clientX + 'px';
    autoscrollEl.style.top = e.clientY + 'px';
    document.body.appendChild(autoscrollEl);
    treeWrap.classList.add('autoscrolling');
    // The camera belongs to the user now: drop follow, or a streaming turn's
    // auto-pan fights the gesture frame by frame.
    setFollow(false);
    try { treeWrap.setPointerCapture(e.pointerId); } catch { /* noop */ }
    perfPanEnd();
    perfPan = perfGestureOpen('autoscroll');
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
    // The *view* travels towards the cursor (browser semantics: the content
    // moves against it), so the canvas offset moves the opposite way.
    pan.x -= (dx / dist) * speed * dt;
    pan.y -= (dy / dist) * speed * dt;
    applyTransform();
    noteViewMove();
  }

  function stopAutoscroll() {
    if (!autoscroll) return;
    if (autoscroll.raf != null) cancelAnimationFrame(autoscroll.raf);
    autoscroll = null;
    perfPanEnd();
    if (autoscrollEl) { autoscrollEl.remove(); autoscrollEl = null; }
    treeWrap.classList.remove('autoscrolling');
  }

  treeWrap.addEventListener('pointerdown', (e) => {
    if (e.button === 2) {
      // RMB is a pan gesture on the *canvas* only. Over a card it stays a plain
      // right-click: the content there is text-selectable, and the menu is how
      // you copy it (the tree canvas is a canvas, not a scroll container, so
      // there is no "pan the card's text" gesture to preserve).
      if (e.target.closest('.node')) return;
      e.preventDefault();
      startAutoscroll(e);
      return;
    }
    // Any other button ends the gesture, exactly like the browser cancels
    // autoscroll on the next click.
    stopAutoscroll();
  });

  window.addEventListener('pointermove', (e) => {
    if (!autoscroll) return;
    autoscroll.x = e.clientX;
    autoscroll.y = e.clientY;
  });
  // Pointerup / -cancel / blur / Esc all end it: the pan must never outlive the
  // gesture that started it (the canvas has no scroll bounds to stop it either).
  window.addEventListener('pointerup', stopAutoscroll);
  window.addEventListener('pointercancel', stopAutoscroll);
  window.addEventListener('blur', stopAutoscroll);
  window.addEventListener('keydown', (e) => {
    if (autoscroll && e.key === 'Escape') stopAutoscroll();
  });

  // Which surface the RMB gesture started on decides whether it may end in a menu.
  window.addEventListener('pointerdown', (e) => {
    if (e.button !== 2) return;
    rmbPressWantsMenu = !treeWrap.contains(e.target) || !!e.target.closest('.node');
  }, true);

  // VS Code's webview host shows its own context menu for any `contextmenu` that
  // reaches it un-prevented — it listens on the inner iframe's window
  // (webview/browser/pre/index.html) and bails out early on `defaultPrevented`.
  // That window listener is the last hop, so a `preventDefault` anywhere in our
  // own document still beats it, and vetoing is the only way a pan gesture can be
  // kept from ending in that menu.
  //
  // The decision reads the *press* target, not a timer: the previous version
  // suppressed for one second after the press, so a hold longer than that fell
  // out of the window and the release opened the menu (which then swallowed the
  // next RMB press instead of panning). Capture phase so no inner handler can
  // stopPropagation() past it; the target is already known here.
  document.addEventListener('contextmenu', (e) => {
    const target = e.target;
    if (target && target.closest && target.closest('.node-head')) {
      // A node header: the menu is ours (see `openNodeMenu`). Suppressed here, in
      // the same place the pan gesture suppresses it, so the two cases cannot drift
      // apart; the card's own listener then opens the menu.
      e.preventDefault();
      return;
    }
    if (rmbPressWantsMenu && !autoscroll) return;
    e.preventDefault();
  }, true);

  // ---- Node header menu (RMB) ----
  // The header's one useful action is the node id: it names the node in
  // `list_nodes`, in the transcript dumps (`<root>/<sessionId>/<nodeId>.jsonl`) and
  // in every `[node <id>]` line of the Spinney output channel, so it has to
  // be reachable from the card itself and not only by opening a dump file.
  //
  // VS Code's webview host shows *its* menu for any `contextmenu` that reaches it
  // un-prevented, and webview content cannot contribute entries to that menu, so
  // the header gets a menu of our own. It is a floating element (not a child of the
  // card): the canvas under it is transformed, and a menu inside the transform
  // would scale with the zoom and be clipped by the card's `overflow: hidden`.
  let nodeMenuEl = null;

  function closeNodeMenu() {
    if (nodeMenuEl) {
      nodeMenuEl.remove();
      nodeMenuEl = null;
    }
  }

  /** Open the node menu for `id` at a viewport position (`clientX` / `clientY`). */
  function openNodeMenu(clientX, clientY, id) {
    closeNodeMenu();
    const menu = el('div', 'node-menu');
    menu.dataset.id = id;
    const item = el('button', 'node-menu-item', tr('Copy node ID'));
    // The id is the whole payload, so it is also the tooltip: the header's title is
    // a derived sentence, and pasting *it* is never what the menu is for.
    item.title = id;
    item.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeNodeMenu();
      // The host owns the clipboard (`vscode.env.clipboard`), exactly like the
      // sidebar's Copy Session ID — and it can confirm with a status-bar message,
      // which a webview cannot show.
      vscode.postMessage({ type: 'copyNodeId', id });
    });
    menu.appendChild(item);
    document.body.appendChild(menu);
    // Fixed positioning in viewport coordinates: the menu is not part of the
    // transformed canvas, so panning / zooming under it cannot drag it along.
    // Measured only now that it is in the DOM, and clamped, so a header near an edge
    // still gets a fully visible menu.
    const w = menu.offsetWidth || 150;
    const h = menu.offsetHeight || 26;
    menu.style.left = clamp(clientX, 0, Math.max(0, window.innerWidth - w)) + 'px';
    menu.style.top = clamp(clientY, 0, Math.max(0, window.innerHeight - h)) + 'px';
    nodeMenuEl = menu;
  }

  // Anything that is not a press inside the menu closes it — including a second
  // right-click, which then reopens it on the header under the cursor. Capture
  // phase, so a pan that starts while the menu is up cannot leave it hanging over
  // cards that have moved away from it. The composer's snippet menu is the same
  // surface with the same rule, so both are closed here.
  document.addEventListener('pointerdown', (e) => {
    if (nodeMenuEl && !(nodeMenuEl.contains && nodeMenuEl.contains(e.target))) closeNodeMenu();
    // The snippet button is the one place a press must *not* close its own menu:
    // the `click` that follows decides (open ↔ close), so closing here would make
    // every second click a reopen.
    if (snippetMenuEl && e.target !== snippetsBtn && !(snippetMenuEl.contains && snippetMenuEl.contains(e.target))) {
      closeSnippetMenu();
    }
    // The `@` menu is the same surface with the same rule, with two exceptions: a press
    // inside the dock is a caret move (the token under it decides, through the `click`
    // listener), and a press on a row is a `mousedown` this capture-phase handler must
    // not pre-empt — accepting a row closes the menu itself.
    if (mentionMenu) {
      const target = e ? e.target : null;
      const inMenu = mentionMenu.el && mentionMenu.el.contains && mentionMenu.el.contains(target);
      const inComposer = target && (target === inputEl || (composerEl.contains && composerEl.contains(target)));
      if (!inMenu && !inComposer) mentionClose();
    }
  }, true);
  // Zooming / panning moves the cards out from under a viewport-anchored menu, and
  // so does losing the window.
  window.addEventListener('wheel', (e) => {
    // Scrolling the `@` menu's own rows is not a pan of the canvas.
    if (mentionMenu && !(mentionMenu.el.contains && mentionMenu.el.contains(e && e.target))) mentionClose();
    closeNodeMenu();
    closeSnippetMenu();
  }, { passive: true });
  window.addEventListener('blur', () => { closeNodeMenu(); closeSnippetMenu(); mentionClose(); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeNodeMenu(); closeSnippetMenu(); mentionDismiss(); }
  });

  // Zoom around a screen-space cursor position.
  function zoomAt(clientX, clientY, factor) {
    const rect = treeWrap.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    // Relaxed lower bound so a large tree can be panned as one small overview.
    const nz = Math.min(1.5, Math.max(0.4, zoom * factor));
    const cx = (mx - pan.x) / zoom;
    const cy = (my - pan.y) / zoom;
    zoom = nz;
    pan.x = mx - cx * nz;
    pan.y = my - cy * nz;
    applyTransform();
  }

  // The zones that own their own native scrolling, shared by the wheel delegate below
  // and the touch layer after it: `.node-work` (the card's one scroller, which holds
  // every row of the turn) / `.node-ask` (the pinned ask) / `.tool-detail` (an expanded
  // step's own box, so a long result does not become the card's scroll position), and
  // the composer, which lives inside a card and owns its own wheel.
  const NATIVE_SCROLL_ZONES = '.node-work, .node-ask, .tool-detail, #composer';

  treeWrap.addEventListener('wheel', (e) => {
    // Never zoom/scroll while a pan or resize gesture is in progress — an
    // accidental mouse scroll must not fling the view around.
    if (dragging || resizing) {
      return;
    }
    // A wheel is the browser's way out of autoscroll; the zoom below still runs.
    stopAutoscroll();
    // ctrl/cmd + wheel always scales the viewport, even when the pointer is over
    // a node (so zooming stays possible while hovering content).
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      perfWheelMove();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 0.9);
      setFollow(false);
      return;
    }
    // alt + wheel pans the whole tree vertically and shift + wheel pans it
    // horizontally, and both do so *whatever* is under the pointer — that is why the
    // pair sits before the native-scroll-zone check below: a card, its work log / ask,
    // a thinking block, an expanded step and the composer all pan the camera instead of
    // scrolling themselves. Shift belongs here rather than with the plain wheel for a
    // second reason: those zones have no horizontal scroll at all, so a shift branch
    // behind their `return` is a gesture that can only be swallowed. Both are the way
    // to move the tree from inside a scroller, where a plain wheel is the zone's own.
    if (e.altKey) {
      e.preventDefault();
      perfWheelMove();
      pan.y -= e.deltaY;
      applyTransform();
      setFollow(false);
      return;
    }
    if (e.shiftKey) {
      e.preventDefault();
      perfWheelMove();
      pan.x -= e.deltaY;
      applyTransform();
      setFollow(false);
      return;
    }
    // Requirement: wheeling on top of a node scrolls that node's content natively
    // (see NATIVE_SCROLL_ZONES above).
    const scrollable = e.target && e.target.closest ? e.target.closest(NATIVE_SCROLL_ZONES) : null;
    if (scrollable) {
      return; // native scroll
    }
    e.preventDefault();
    perfWheelMove();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 0.9);
    setFollow(false);
  }, { passive: false });

  // ---- Touch: one finger pans, two fingers pinch ----
  // Neither gesture above can reach a finger. The pan is pointer-based, and the browser
  // classifies a one-finger drag as *its* pan first: `touch-action` is `auto` throughout
  // this subtree, so the compositor claims the drag and fires `pointercancel` — and the
  // handler above faithfully stops the drag it was told to stop, which is why nothing
  // ever moves. The zoom only ever hears `wheel`, and a pinch is not a wheel. So
  // both are read off the touch stream here, driving the same camera the mouse drives —
  // `pan`, `applyTransform()`, `setFollow(false)` and, for the pinch, `zoomAt()`.
  //
  // Deliberately NOT `#tree-wrap { touch-action: none }`, which is the recipe that would
  // be wrong here: `touch-action` is resolved as the intersection along the *whole*
  // ancestor chain — a descendant can only ever be more restrictive than its ancestor,
  // never more permissive — so a `none` on this wrapper switches off touch scrolling
  // inside every card's log and answer, and no rule on those elements can take it back.
  // What keeps the browser's own pan out of the way instead is `preventDefault()` on the
  // `touchmove` of a gesture we have claimed (below); that cancellation is also what
  // suppresses the compatibility mouse events for the rest of the gesture, so a pan can
  // never end as a `click` on the card the finger started on.
  const TOUCH_SLOP_PX = 6;      // travel that separates a tap from a drag
  const PINCH_STEP_MAX = 1.25;  // per-event cap on a pinch's scale factor

  /** Midpoint of two touches, in viewport coordinates: the pinch's anchor. */
  function touchMid(a, b) {
    return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
  }

  /** Distance between two touches, in viewport pixels: the pinch's scale input. */
  function touchSpan(a, b) {
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  treeWrap.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      const target = e.target;
      const t = e.touches[0];
      // The corner resizes the card. It is the one gesture the touch layer *takes over* rather
      // than leaving to the pointer path: a finger drag on the handle would be claimed by the
      // browser a few pixels in (`pointercancel`), and the window handler reads that as
      // "abandoned" — the wireframe disappeared mid-drag and the lift committed nothing. The
      // same `beginResize` the mouse uses is entered here instead.
      const resizeHandle = target && target.closest ? target.closest('.node-resize') : null;
      if (resizeHandle) {
        // The corner owns the finger whether or not a resize can actually start: a handle
        // whose card carries no id is a card this renderer cannot size, and falling through
        // to the pan below would move the camera under a finger that meant to drag a corner.
        touchGesture = null;
        const card = resizeHandle.closest('.node');
        const id = card && card.dataset.id;
        if (id) {
          beginResize(id, card, t.clientX, t.clientY);
          touchGesture = { kind: 'resize', x0: t.clientX, y0: t.clientY, claimed: false };
        }
        return;
      }
      // The scroll zones belong to themselves: a finger there scrolls the log/answer/ask
      // natively, never the camera. A *card* is fair game, unlike the mouse rule above which
      // leaves cards to the checkout click — on a touch screen the tree fills the screen and
      // there is no empty background left to grab, and the tap-vs-drag threshold below is
      // what still keeps a tap a tap.
      if (target && target.closest && target.closest(NATIVE_SCROLL_ZONES)) {
        touchGesture = null;
        return;
      }
      touchGesture = { kind: 'pan', x0: t.clientX, y0: t.clientY, px: pan.x, py: pan.y, claimed: false };
      return;
    }
    if (e.touches.length === 2) {
      // A second finger promotes a pan to a pinch, but it *cancels* a resize: the wireframe
      // belongs to a corner, and the corner is not where the pinch is happening.
      if (touchGesture && touchGesture.kind === 'resize') {
        endResize(false);
      }
      // The pan's origin says nothing about a pinch, and `zoomAt()` anchors on the midpoint it
      // is handed, so the anchor is read fresh from the two touches that are down right now.
      touchGesture = { kind: 'pinch', span: touchSpan(e.touches[0], e.touches[1]), claimed: false };
      return;
    }
    // Three fingers are not a gesture we read: drop whatever was running rather than
    // let it keep tracking a finger that has already left the screen.
    if (touchGesture && touchGesture.kind === 'resize') {
      endResize(false);
    }
    touchGesture = null;
  }, { passive: false });

  treeWrap.addEventListener('touchmove', (e) => {
    const g = touchGesture;
    if (!g) return;
    if (g.kind === 'resize') {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      if (!g.claimed) {
        // The same slop as the pan: a tap on the corner is a tap, not a one-pixel resize, and
        // until the finger has travelled the event stays uncancelled.
        if (Math.hypot(t.clientX - g.x0, t.clientY - g.y0) < TOUCH_SLOP_PX) return;
        g.claimed = true;
      }
      e.preventDefault();
      // The same motion handler the mouse drives: it owns the clamp, the ceiling the commit
      // will use, and the one-paint-per-frame wireframe.
      onResizeMove({ clientX: t.clientX, clientY: t.clientY });
      return;
    }
    if (g.kind === 'pan') {
      if (e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - g.x0;
      const dy = e.touches[0].clientY - g.y0;
      if (!g.claimed) {
        // Under the slop this is still a tap: leave the event uncancelled, or the
        // browser drops the compatibility `click` that checks a node out.
        if (Math.hypot(dx, dy) < TOUCH_SLOP_PX) return;
        g.claimed = true;
      }
      e.preventDefault();
      // The whole travel from the origin, not just the part past the slop: the pan
      // must not lose its first pixels to the threshold.
      pan.x = g.px + dx;
      pan.y = g.py + dy;
      applyTransform();
      setFollow(false);
      return;
    }
    if (e.touches.length < 2) return;
    const span = touchSpan(e.touches[0], e.touches[1]);
    if (!g.span || span <= 0) {
      g.span = span;
      return;
    }
    if (!g.claimed) {
      // The same slop, measured on the span: two fingers resting on the screen are a
      // tap, not a zoom, and until they spread the event stays uncancelled so the
      // browser keeps its own options.
      if (Math.abs(span - g.span) < TOUCH_SLOP_PX) return;
      g.claimed = true;
    }
    e.preventDefault();
    // The change *since the last event*, never since the pinch started: `zoomAt()` is
    // multiplicative and anchored on the current midpoint, so each frame only has to
    // carry the fingers' own delta — and capping that delta is what stops one jittery
    // frame from jumping the zoom.
    const factor = clamp(span / g.span, 1 / PINCH_STEP_MAX, PINCH_STEP_MAX);
    g.span = span;
    const mid = touchMid(e.touches[0], e.touches[1]);
    zoomAt(mid.x, mid.y, factor);
    setFollow(false);
  }, { passive: false });

  function endTouchGesture(e) {
    // Never `preventDefault()` here: a cancelled `touchend` is a tap that never
    // reaches the `click` handler (the checkout), and a gesture that travelled has
    // already cancelled its own `touchmove`s, which is what silences the
    // compatibility mouse events behind it.
    //
    // A resize is the one gesture with something to finish: a travelled drag commits (the same
    // `endResize(true)` the mouse's `pointerup` calls), an untouched corner and a cancelled
    // gesture commit nothing. Its wireframe is torn down either way.
    if (touchGesture && touchGesture.kind === 'resize') {
      endResize(touchGesture.claimed === true && (!e || e.type !== 'touchcancel'));
    }
    touchGesture = null;
  }
  // Any finger leaving ends the gesture. A pinch that lost an anchor cannot become a
  // pan — that finger is mid-flight — and the pan's next frame would come from a
  // finger that is already gone, so a fresh gesture needs a fresh `touchstart`.
  treeWrap.addEventListener('touchend', endTouchGesture);
  treeWrap.addEventListener('touchcancel', endTouchGesture);

  if (fitBtn) fitBtn.addEventListener('click', () => fitToView());
  if (followBtn) followBtn.addEventListener('click', () => setFollow(!follow));

  // Click a node's title or (collapsed) preview to check it out; clicking inside
  // an expanded node's transcript never changes the branch.
  treeCanvas.addEventListener('click', (e) => {
    if (e.target.closest('button, a, .tool-row, .thinking-row, .bgnotify-head, .node-summary')) return;
    const head = e.target.closest('.node-head');
    const excerpt = e.target.closest('.node-excerpt');
    const card = head ? head.closest('.node') : excerpt ? excerpt.closest('.node') : null;
    if (!card) return;
    const id = card.dataset.id;
    if (id && id !== treeActiveId) {
      vscode.postMessage({ type: 'checkout', id });
    }
  });

  // Reposition on resize so a long chain stays coherent — and report the surface to the
  // host (throttled, only on a real change): a wrapper that changed while the canvas did
  // not is one of the shapes a frozen picture takes, and a window that changed while the
  // *document* did not is the other one (see `perfReportResize` — the observer alone can
  // never see it, which is why it reported nothing at all in the session that complained
  // about exactly that).
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => { relayout(); ensureNodeInView(); perfReportResize('observer'); }).observe(treeWrap);
  }
  // The window and the visual viewport: these fire whether or not the layout followed, so
  // they are the only events that arrive on the defect the report exists for.
  window.addEventListener('resize', () => perfReportResize('window'));
  if (window.visualViewport && typeof window.visualViewport.addEventListener === 'function') {
    window.visualViewport.addEventListener('resize', () => perfReportResize('vv'));
  }

  let nodeInViewRaf = null;
  function ensureNodeInView() {
    if (nodeInViewRaf != null) return;
    nodeInViewRaf = requestAnimationFrame(() => {
      nodeInViewRaf = null;
      if (follow) keepActiveInView();
    });
  }

  // ---- State ----
  // Session-level only: the status dot, the tps meter and the model/effort selects
  // belong to the session (they say "something is streaming somewhere in this
  // tab"). The Send/Stop pair does not — see updateComposerButtons().
  function setBusy(value) {
    busy = value;
    modelSelect.disabled = value;
    effortSelect.disabled = value;
    if (value) {
      // A response is starting on the node the user is looking at: re-engage the
      // follow light for it. A run that starts on *another* node must not touch
      // this card's lock (the user may be reading a finished branch there).
      if (focusIsRunning()) setActiveScrollLock(true);
      startTps();
      statusDot.className = 'dot busy';
    } else {
      stopTps();
      statusDot.className = 'dot idle';
    }
    updateComposerButtons();
  }

  /**
   * Whether the *view focus* node has a live run. You cannot send into a node that
   * is already streaming (no queueing), while a run on another node/branch leaves
   * this composer fully usable (spec §1).
   */
  function focusIsRunning() {
    return !!treeActiveId && runningNodes.has(treeActiveId);
  }

  /**
   * Whether the *view focus* node owns unfinished work of its own (a running
   * background job / async sub-agent batch, or a notice about to be injected into
   * it). It is not streaming, so the composer shows Stop — the same button as for a
   * streaming node: stop what this node is doing (the host turns it into a union
   * kill: turn + background tasks + sub-agents, and nothing continues).
   */
  function focusIsLocked() {
    return !!treeActiveId && lockedNodes.has(treeActiveId);
  }

  /** Whether the composer holds something to send: text, or at least one attachment. */
  function hasComposerContent() {
    return !!String(inputEl.value || '').trim() || pendingAttachments.length > 0;
  }

  /** Whether the *view focus* node is a sidecar card (a sub-agent window / job card). */
  function focusIsAgent() {
    const node = treeNodes[treeActiveId];
    return !!(node && isSidecarKind(node.kind));
  }

  /**
   * The host's context state of the *view focus* node: `'ok' | 'near' | 'full'`, or
   * `undefined` before the tree arrived. It is shipped data (`tree` / `nodeUpdate`,
   * §4.3) and is never derived here — the webview holds no copy of a provider fact.
   */
  function focusContext() {
    const node = treeNodes[treeActiveId];
    return node ? node.context : undefined;
  }

  /**
   * Whether the host says a **new epoch** is available for this composer: the
   * checked-out chain's setup drifted from the live one (`config.setup.drift` — the
   * user moved a dropdown, or the prompt / AGENTS.md / tool set / endpoint moved), or
   * its context window is near or past full. Those are the three situations the
   * composer's one entry exists for; the two facts come from the host, never from a
   * computation of this side.
   */
  function newEpochAvailable() {
    const drift = !!(SETUP && SETUP.drift);
    const context = focusContext();
    return drift || context === 'near' || context === 'full';
  }
  /** Why the new-epoch entry cannot be used right now (`''` = it can). */
  function newContextBlockedReason() {
    if (readOnly) return READ_ONLY_TITLE;
    if (focusIsAgent()) return tr('A sub-agent branch cannot start a new context window');
    return '';
  }

  /**
   * The composer's **new-window** entry (`#compress-btn`, immediately left of Send). Always on
   * screen while the composer is — unless the checked-out node is the **first** one of its tree,
   * where a window would have nothing to hand over — because "move this conversation into a new
   * context window" is a normal thing to want at any fill level. The two answers are the
   * compression node (`Agentic`) and the free pointer (`Simple`), and the harness asks which. It
   * is hidden while Stop shows (one owner of the row), on a **compression card** (there is nothing
   * there to compress) and disabled where no window can start, with the reason in its tooltip;
   * the host re-checks every precondition and answers a stale click with a notice. The label
   * follows the box: with text in it the button both compresses *and* carries that text into the
   * new window, without text it only moves the conversation.
   */
  function updateCompressButton() {
    const reason = newContextBlockedReason();
    const node = treeActiveId ? treeNodes[treeActiveId] : null;
    // A first card has no conversation to hand over: the window would be one turn long, so
    // the button does not appear there at all.
    const hasSomethingToCarry = !!node && !!node.parentId;
    const isCompress = !!(node && node.role === 'compress');
    const show = hasSomethingToCarry && !isCompress && !focusIsRunning() && !focusIsLocked();
    const hasContent = hasComposerContent();
    compressBtn.textContent = hasContent ? tr('Compress and send') : tr('Compress');
    compressBtn.classList.toggle('hidden', !show);
    compressBtn.disabled = !!reason;
    compressBtn.title = reason
      ? reason
      : hasContent
        ? tr('Compress this conversation and send this message into the new context window (the harness asks first)')
        : tr(
            'Move this conversation into a new context window: a pointer (Simple) or a compression turn (Agentic). The harness asks which, and which setup the new window uses.',
          );
  }

  /**
   * The **setup** entry (`#new-context-btn`): shown only when the live setup and the frozen one
   * disagree, because with no drift the answer is the setup the conversation already runs on.
   * Its one meaning is "continue under the setup the composer shows now", which forks the tree —
   * a window is the other button's job, and an empty box is a valid fork.
   */
  function updateNewContextButton() {
    const drift = !!(SETUP && SETUP.drift);
    const reason = newContextBlockedReason();
    const node = treeActiveId ? treeNodes[treeActiveId] : null;
    newContextBtn.textContent = tr('Continue with new context');
    newContextBtn.classList.toggle(
      'hidden',
      !drift || focusIsRunning() || focusIsLocked() || !!(node && node.role === 'compress'),
    );
    newContextBtn.disabled = !!reason;
    newContextBtn.title = reason
      ? reason
      : tr(
          'Continue this conversation under the setup the composer shows now. The tree forks, so the old one keeps its own bytes.',
        );
  }

  /**
   * The composer shows Stop and hides Send while the view focus node is *doing
   * something* — streaming a turn, or still owning unfinished work (`lockedNodes`) —
   * and Send otherwise. One button, one meaning: stop what this node is doing.
   * Driven by the per-node sets, never by the session-level `busy` flag. Called
   * whenever `state`, the tree, the focused path, either set, the input or the pending
   * attachments change — and it owns the new-epoch entry too.
   *
   * Send is **disabled** where it cannot act instead of silently doing nothing: an
   * empty box, a full context window (the request would be refused), a read-only window
   * and a sub-agent branch. Enter goes through the same button, so a disabled Send
   * means Enter does nothing as well.
   */
  function updateComposerButtons() {
    const hasContent = hasComposerContent();
    const context = focusContext();
    if (readOnly) {
      // One owner window per workspace: this one may read the sessions, nothing more.
      stopBtn.classList.add('hidden');
      sendBtn.classList.remove('hidden');
      sendBtn.disabled = true;
      sendBtn.title = READ_ONLY_TITLE;
    } else if (focusIsRunning() || focusIsLocked()) {
      stopBtn.classList.remove('hidden');
      sendBtn.classList.add('hidden');
      // The same button has two scopes, so say which one applies: a node that owns
      // background work is union-killed (and the model is told nothing), a plain
      // streaming node only has its turn cancelled.
      stopBtn.title = focusIsLocked()
        ? tr('Stop this node: kill its background tasks and sub-agents (nothing is sent to the model)')
        : tr('Stop this turn');
    } else {
      stopBtn.classList.add('hidden');
      sendBtn.classList.remove('hidden');
      sendBtn.disabled = !hasContent || context === 'full' || focusIsAgent();
      sendBtn.title = !hasContent
        ? tr('Type a message or attach an image to send')
        : context === 'full'
          ? tr('The context window is full; continue in a new one first')
          : focusIsAgent()
            ? tr('A sub-agent branch is read-only')
            : '';
    }
    updateNewContextButton();
    updateCompressButton();
    updateActionRow();
  }

  /**
   * How the buttons share the composer's width: **three or more** buttons take a right-aligned
   * line of their own (`#composer-controls #actions.stacked`); one or two stay at the end of
   * the controls row, which is where they always were. `Compress` + `Send` are two short words
   * and cost the model dropdown nothing worth a second row — only the drift case (Compress,
   * Continue with new context and Send together) does.
   */
  function updateActionRow() {
    if (!actionsEl) return;
    const buttons = [stopBtn, newContextBtn, compressBtn, sendBtn];
    const shown = buttons.filter((button) => button && !button.classList.contains('hidden')).length;
    actionsEl.classList.toggle('stacked', shown > 2);
  }

  /**
   * True while another window owns this workspace's sessions. Held here so the composer can
   * show it, and checked again in `send()` — a click must never depend on a repaint having
   * happened.
   */
  let readOnly = false;
  /**
   * The read-only sentence. Deliberately byte-identical to the host's
   * `ChatViewProvider.readOnlyNotice()` literal, so the two share one catalogue entry
   * (`npm run check:l10n` extracts both and would report a near-duplicate as missing).
   */
  const READ_ONLY_TITLE = tr(
    'Another window owns this workspace’s sessions, so this window is read-only. Close that window (or use it) to continue here.',
  );

  // Filled from the provider's `config` message: every **model card** the user
  // configured, its provider's name, and the thinking levels that card offers.
  // There is no catalog copy here, and no hardcoded model name anywhere.
  let CARDS = [];
  let EFFORTS = [];
  // Also from `config`: the composer's prompt snippets (`{ name, text }`, the
  // shipped rows first). The host resolves them from `spinney.promptSections`, so
  // this is a copy of nothing the webview owns — editing the setting repaints it.
  let SNIPPETS = [];

  /** The card object the dropdown is currently on (undefined before the first config). */
  function currentCard() {
    return CARDS.find((c) => c.id === currentModel);
  }

  function cardLabel(card) {
    return card.name || card.id;
  }

  function renderModelSelect(model) {
    currentModel = model;
    modelSelect.innerHTML = '';
    if (CARDS.length === 0) {
      // Before the first config message: show whatever the host named so the
      // header is never empty (the dropdown is disabled while a turn runs anyway).
      if (model) {
        const opt = document.createElement('option');
        opt.value = model;
        opt.textContent = model;
        opt.selected = true;
        modelSelect.appendChild(opt);
      }
      return;
    }
    // One group per provider, so two cards with the same wire model on different
    // endpoints stay tellable apart.
    const groups = new Map();
    for (const card of CARDS) {
      const key = card.providerName || card.providerId || '';
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(card);
    }
    for (const [providerName, list] of groups) {
      const group = providerName ? document.createElement('optgroup') : modelSelect;
      if (providerName) {
        group.label = providerName;
      }
      for (const card of list) {
        const opt = document.createElement('option');
        opt.value = card.id;
        opt.textContent = cardLabel(card);
        opt.selected = card.id === model;
        group.appendChild(opt);
      }
      if (providerName) {
        modelSelect.appendChild(group);
      }
    }
  }

  /** True when the card the composer is on accepts images. */
  function hasVisionModel() {
    const card = currentCard();
    return !!card && card.vision === true;
  }

  function updateImageVisibility() {
    const hasVision = hasVisionModel();
    treeCanvas.classList.toggle('hide-images', !hasVision);
    attachmentsEl.classList.toggle('hide-images', !hasVision);
  }

  /** The names of the cards that accept images, for the "switch to …" hint. */
  function visionCardNames() {
    return CARDS.filter((c) => c.vision === true).map((c) => cardLabel(c));
  }

  function showAttachHint(text) {
    attachmentsEl.innerHTML = '';
    attachmentsEl.appendChild(el('div', 'attach-hint', text));
    attachmentsEl.classList.remove('hidden');
    setTimeout(() => {
      attachmentsEl.innerHTML = '';
      attachmentsEl.classList.add('hidden');
    }, 3000);
  }

  /**
   * The thinking levels of the card that is selected. The list is the card's own
   * (`config.efforts`), so a card with only two levels shows two — and a
   * free-form level is displayed exactly as the user typed it.
   */
  function renderEffortSelect(effort) {
    currentEffort = effort;
    effortSelect.innerHTML = '';
    const levels = EFFORTS.length > 0 ? EFFORTS : effort ? [effort] : [];
    for (const level of levels) {
      const opt = document.createElement('option');
      opt.value = level;
      opt.textContent = level;
      opt.selected = level === effort;
      effortSelect.appendChild(opt);
    }
    // A level the dropdown does not list (the host clamped it to something odd)
    // must still be visible rather than silently mismatched.
    if (effort && !levels.includes(effort)) {
      const opt = document.createElement('option');
      opt.value = effort;
      opt.textContent = effort;
      opt.selected = true;
      effortSelect.appendChild(opt);
    }
  }

  function setStatus(text) {
    if (statusText) statusText.textContent = text || '';
  }

  function setContext(used, total) {
    const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
    contextLabel.textContent = 'ctx ' + (total > 0 ? Math.round(pct) : 0) + '%';
    const elCtx = document.getElementById('context');
    if (elCtx) elCtx.title = tr('Context: {0} / {1} tokens ({2}%)', used, total, pct.toFixed(1));
  }

  let statsCacheData = null;
  let statsBalanceData = null;
  /**
   * The display name of the provider whose wallet the readout shows (`''` when the
   * host named none). Kept beside `statsBalanceData` so the tooltip can say which
   * provider the number belongs to — and cleared with it, so a wallet is never
   * named after another provider.
   */
  let statsBalanceWho = '';

  function currencySymbol(currency) {
    switch (currency) {
      case 'CNY': return '¥';
      case 'USD': return '$';
      case 'EUR': return '€';
      default: return currency + ' ';
    }
  }

  /**
   * One wallet entry as the tooltip shows it: the money, plus the split the
   * provider reports. DeepSeek reports the granted / topped-up pair (both fields or
   * neither), the spend-reporting dialects report `used` instead, and a dialect
   * that reports neither is just its total.
   */
  function balanceEntryText(entry) {
    const sym = currencySymbol(entry.currency);
    const money = sym + entry.total.toFixed(2);
    if (typeof entry.granted === 'number' && typeof entry.toppedUp === 'number') {
      return tr('{0} (granted {1} + topped up {2})',
        money, sym + entry.granted.toFixed(2), sym + entry.toppedUp.toFixed(2));
    }
    if (typeof entry.used === 'number') {
      return tr('{0} (spent {1})', money, sym + entry.used.toFixed(2));
    }
    return money;
  }

  function renderStatsTitle() {
    const elStats = document.getElementById('meter-row-readout');
    if (!elStats) return;
    const parts = [];
    if (statsCacheData) {
      const totalCache = statsCacheData.cacheHit + statsCacheData.cacheMiss;
      if (totalCache > 0) {
        parts.push(
          tr('prompt-cache hit {0} / {1} ({2}%)', statsCacheData.cacheHit, totalCache,
            statsCacheData.cacheHitRate.toFixed(1)),
        );
      }
    }
    if (statsBalanceData && statsBalanceData.balances && statsBalanceData.balances.length) {
      const entries = statsBalanceData.balances.map(balanceEntryText);
      parts.push(
        statsBalanceWho
          ? tr('wallet {0}: {1}', statsBalanceWho, entries.join(' · '))
          : tr('wallet {0}', entries.join(' · ')),
      );
    }
    elStats.title = parts.length ? tr('Session: {0}', parts.join(' · ')) : '';
  }

  function setSessionStats(stats) {
    if (!stats) return;
    statsCacheData = stats;
    renderStatsTitle();
  }

  /**
   * The wallet readout, from the host's whole `balance` message: the provider that
   * answered (`providerName`, falling back to its id) and its entries. An empty
   * `balances` means "there is no number to show" — a provider whose wallet dialect
   * is `none`, or a refresh that failed — so the readout and the tooltip are
   * dropped instead of keeping the previous provider's number.
   */
  function setBalance(msg) {
    const balances = (msg && msg.balance && msg.balance.balances) || [];
    if (balances.length === 0) {
      statBalanceEl.textContent = 'bal –';
      statsBalanceData = null;
      statsBalanceWho = '';
      renderStatsTitle();
      return;
    }
    const active = balances.filter((b) => b.total > 0);
    if (active.length === 0) {
      statBalanceEl.textContent = 'bal 0';
    } else {
      const parts = active.map((b) => currencySymbol(b.currency) + b.total.toFixed(2));
      statBalanceEl.textContent = 'bal ' + parts.join(' ');
    }
    statsBalanceData = msg.balance;
    statsBalanceWho = msg.providerName || msg.providerId || '';
    renderStatsTitle();
  }

  // ---- Real-time tokens/sec meter ----
  const TPS_WINDOW_MS = 1500;
  let tpsSamples = [];
  let tpsTimer = null;

  function estimateTokens(text) {
    if (!text) return 0;
    let tokens = 0;
    for (const ch of text) {
      const code = ch.codePointAt(0);
      if (
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0x3400 && code <= 0x4dbf) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0x3000 && code <= 0x303f) ||
        (code >= 0x3040 && code <= 0x30ff) ||
        (code >= 0xac00 && code <= 0xd7af) ||
        (code >= 0xff00 && code <= 0xffef)
      ) {
        tokens += 1;
      } else {
        tokens += 0.25;
      }
    }
    return tokens;
  }

  function formatTps(rate) {
    if (rate <= 0) return '0';
    if (rate >= 100) return String(Math.round(rate));
    return rate.toFixed(1);
  }

  function computeTps() {
    const now = performance.now();
    tpsSamples = tpsSamples.filter((s) => now - s.t <= TPS_WINDOW_MS);
    if (tpsSamples.length === 0) return 0;
    let total = 0;
    for (const s of tpsSamples) total += s.tokens;
    return total / (TPS_WINDOW_MS / 1000);
  }

  function renderTps() {
    tpsValue.textContent = formatTps(computeTps());
  }

  function startTps() {
    tpsSamples = [];
    tpsValue.textContent = '0';
    tpsMeter.classList.add('active');
    if (tpsTimer == null) {
      tpsTimer = setInterval(renderTps, 250);
    }
  }

  function stopTps() {
    if (tpsTimer != null) {
      clearInterval(tpsTimer);
      tpsTimer = null;
    }
    tpsSamples = [];
    tpsValue.textContent = '0';
    tpsMeter.classList.remove('active');
  }

  function addTpsTokens(text) {
    const now = performance.now();
    tpsSamples.push({ t: now, tokens: estimateTokens(text) });
    tpsMeter.classList.add('active');
    if (tpsTimer == null) {
      tpsTimer = setInterval(renderTps, 250);
    }
    renderTps();
  }

  // ---- Pending attachments ----
  function addPendingAttachment(dataUrl, name) {
    if (!hasVisionModel()) {
      const vision = visionCardNames();
      showAttachHint(
        vision.length > 0
          ? tr('Switch to an image-capable model ({0}) to attach an image.', vision.join(' / '))
          : tr('No image-capable model is configured — add vision to a model card to attach an image.'),
      );
      return;
    }
    pendingAttachments.push({ dataUrl, name });
    renderPendingAttachments();
  }

  function renderPendingAttachments() {
    attachmentsEl.innerHTML = '';
    for (let i = 0; i < pendingAttachments.length; i++) {
      const att = pendingAttachments[i];
      const item = document.createElement('div');
      item.className = 'pending-att';
      const img = document.createElement('img');
      img.src = att.dataUrl;
      img.title = att.name || tr('image');
      const rm = document.createElement('button');
      rm.className = 'remove-att';
      rm.textContent = '×';
      rm.title = tr('Remove');
      rm.addEventListener('click', () => {
        pendingAttachments.splice(i, 1);
        renderPendingAttachments();
      });
      item.appendChild(img);
      item.appendChild(rm);
      attachmentsEl.appendChild(item);
    }
    attachmentsEl.classList.toggle('hidden', pendingAttachments.length === 0);
    // The pending list is half of "has content", so both composer buttons follow it.
    updateComposerButtons();
  }

  function handlePaste(event) {
    const items = event.clipboardData && event.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          addPendingAttachment(reader.result, file.name || 'pasted-image.png');
        };
        reader.readAsDataURL(file);
        event.preventDefault();
        return;
      }
    }
  }

  // ---- The composer's two identities (§4.2) --------------------------------
  // What a send actually uses is the checked-out node's frozen setup (`setup.node`);
  // what a *new* node would freeze is the live one (`setup.live`). The host compares
  // them and says which kind of drift it found — `'user'` (the dropdowns moved) or
  // `'harness'` (the template / AGENTS.md / tool schemas / provider moved). This side
  // only shows the two identities; it never computes drift itself. Acting on a drift is
  // the composer's one new-epoch button (`updateNewContextButton`), which reads
  // `setup.drift` and nothing else.
  let SETUP = null;
  // The two-line identity block, created lazily: it exists only while the user has
  // drifted, so an untouched session carries no extra DOM.
  let composerIdent = null;   // { box, sending, live }

  /**
   * One identity as a single line: the card, then its effort and reply language.
   * The three values are the host's data (a card label is the user's own name for a
   * card), so only the shape around them is translated.
   */
  function setupIdentityText(ident) {
    if (!ident || typeof ident !== 'object') return '';
    const label = ident.cardLabel || ident.cardId || '';
    const effort = ident.effort || '';
    const language = ident.language || '';
    if (label && effort && language) return tr('{0} · {1} · {2}', label, effort, language);
    if (label && (effort || language)) return tr('{0} · {1}', label, effort || language);
    return label;
  }

  /** The identity block, built on first use and left in the composer afterwards. */
  function ensureComposerIdent() {
    if (composerIdent) return composerIdent;
    const box = el('div', 'composer-ident hidden');
    box.id = 'composer-ident';
    const sending = el('div', 'composer-ident-line composer-ident-sending', '');
    const live = el('div', 'composer-ident-line composer-ident-live', '');
    box.appendChild(sending);
    box.appendChild(live);
    // Above the input row — banner, attachments, identities, row — and inside the
    // pane, so it pans/zooms with the node the pane is docked on.
    const row = document.getElementById('composer-row');
    if (composerEl) {
      if (row && row.parentElement === composerEl) composerEl.insertBefore(box, row);
      else composerEl.appendChild(box);
    }
    composerIdent = { box, sending, live };
    return composerIdent;
  }

  /**
   * Show what the composer is about to send *with*, while the two setups disagree:
   * the node's frozen setup (`Sending with:`) and what a new node would freeze
   * (`New setup:`, shown when the user moved a dropdown, §4.2). The block states a
   * fact and nothing else — the *entry point* for acting on a disagreement is the
   * composer's one new-epoch button (`updateNewContextButton`), whatever caused it,
   * and a plain send still keeps the frozen setup silently.
   */
  function renderSetupIdentity() {
    const setup = SETUP || {};
    const drift = setup.drift;
    const userDrift = drift === 'user' && !!setup.node && !!setup.live;
    if (userDrift) {
      const ident = ensureComposerIdent();
      ident.sending.textContent = tr('Sending with: {0}', setupIdentityText(setup.node));
      ident.live.textContent = tr('New setup: {0}', setupIdentityText(setup.live));
      ident.box.classList.remove('hidden');
    } else if (composerIdent) {
      composerIdent.box.classList.add('hidden');
    }
    // Any drift — the user's or the harness's — is the setup entry's business, so the two
    // buttons' visibility and disabled state are re-read here.
    updateNewContextButton();
    updateCompressButton();
    updateActionRow();
  }

  /**
   * The new-epoch click (`#new-context-btn`): the composer's text and attachments
   * travel with it, exactly like a Send's. The host decides the backend (a new context
   * window, or a fork under the live setup), asks one modal question and re-validates
   * the trigger, so a stale click is answered with a notice. The input is *not* cleared
   * here — only the host knows whether it took the turn, and it says so with
   * `composerClear`.
   */
  /**
   * The **new-window** entry's click: the same message a Send carries, plus which entry asked —
   * the host picks the backend from `mode` (`compression`, or a fork for the setup entry) and
   * re-asks its own questions.
   */
  function newContextTurn(mode) {
    const btn = mode === 'fork' ? newContextBtn : compressBtn;
    if (btn.disabled) return;
    setFollow(true);
    vscode.postMessage({
      type: 'newContextTurn',
      text: inputEl.value.trim(),
      attachments: pendingAttachments,
      mode,
    });
  }

  // ---- Messaging ----
  function send() {
    const text = inputEl.value.trim();
    // Enter and the button are one path: a disabled Send does nothing at all (§4.2).
    // Sending targets the view focus node, so only *that* node being live blocks it
    // (it shows Stop then, and Send is hidden anyway); a run elsewhere in the session
    // is exactly the "start a new concurrent run here" case (spec §1).
    if (sendBtn.disabled || readOnly || focusIsRunning() || focusIsLocked()) return;
    if (!text && pendingAttachments.length === 0) return;
    setFollow(true);
    vscode.postMessage({ type: 'userMessage', text, attachments: pendingAttachments });
    // The composer is *not* cleared here (§4.4): a send that the host refuses must not
    // have eaten the user's text. The host clears the box — attachments and all — with
    // `composerClear` once it really took the message.
  }

  // The input never scales with anything, so its height cap is a constant.
  const INPUT_MAX_H = 160;

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, INPUT_MAX_H) + 'px';
  }

  /**
   * Everything the composer owes after its **value** changed. Typing gets this from the
   * `input` listener, but a write the script makes itself — a prompt snippet landing in
   * the box, the host's `composerClear` emptying it — fires no `input` event at all.
   * Both composer buttons read "has content" (`updateComposerButtons`), so without this
   * one shared refresh a snippet leaves Send disabled (and the new-epoch label stale)
   * until the user types a character; `composerClear` leaves Send enabled on an empty
   * box. One helper, one path: the `input` listener, `insertSnippet` and `composerClear`
   * call the same thing.
   */
  function afterComposerWrite() {
    // The split exists for the typing probe: `autoGrow()` forces a synchronous layout (it
    // writes the height, then reads `scrollHeight`) and `updateComposerButtons()` touches
    // two buttons. Which of the two a keystroke pays for is exactly what "typing is laggy"
    // has to be attributed to, and it costs two `perfNow()` calls only during a burst.
    const probe = perfTyping;
    const t0 = probe ? perfNow() : 0;
    autoGrow();
    const t1 = probe ? perfNow() : 0;
    updateComposerButtons();
    if (probe) {
      probe.autoGrowMs += t1 - t0;
      probe.buttonsMs += perfNow() - t1;
    }
  }

  // ---- Composer prompt snippets ----
  // A snippet is **the user's own turn**: the menu places its text in the input box,
  // and the user may edit it before sending. Nothing is sent by the menu itself, so
  // a snippet can never turn into a turn the user did not ask for. The list is the
  // host's (`SNIPPETS`, from `config`); the names are data, not translated strings —
  // a name is what the user called it in `spinney.promptSections`.
  let snippetMenuEl = null;

  function closeSnippetMenu() {
    if (snippetMenuEl) {
      snippetMenuEl.remove();
      snippetMenuEl = null;
    }
  }

  /** Insert a snippet's text at the caret, keeping whatever is already typed. */
  function insertSnippet(text) {
    if (!text || inputEl.disabled) {
      return;
    }
    const value = inputEl.value;
    const start = typeof inputEl.selectionStart === 'number' ? inputEl.selectionStart : value.length;
    const end = typeof inputEl.selectionEnd === 'number' ? inputEl.selectionEnd : start;
    const before = value.slice(0, start);
    const after = value.slice(end);
    // A snippet is a block of its own: never glue it onto the end of a sentence
    // (or the start of one) without a line break.
    const lead = before && !before.endsWith('\n') ? '\n' : '';
    const tail = after && !after.startsWith('\n') ? '\n' : '';
    const inserted = lead + text + tail;
    inputEl.value = before + inserted + after;
    const caret = before.length + inserted.length;
    if (inputEl.setSelectionRange) {
      inputEl.setSelectionRange(caret, caret);
    }
    // A programmatic write fires no `input` event, so the composer refreshes here: the
    // snippet is *content*, and Send must be able to take it at once.
    afterComposerWrite();
    if (inputEl.focus) {
      inputEl.focus();
    }
  }

  /** Show the snippet menu above its button (the composer sits at the tab's bottom). */
  function openSnippetMenu() {
    closeSnippetMenu();
    if (SNIPPETS.length === 0) {
      return;
    }
    const menu = el('div', 'snippet-menu');
    for (const snippet of SNIPPETS) {
      if (!snippet || typeof snippet.text !== 'string') continue;
      const item = el('button', 'snippet-menu-item', String(snippet.name || ''));
      // The name says what it does; the tooltip is the text that will land in the
      // box, so a long snippet can be told apart from a similarly named one.
      item.title = snippet.text;
      item.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeSnippetMenu();
        insertSnippet(snippet.text);
      });
      menu.appendChild(item);
    }
    document.body.appendChild(menu);
    // Measured only now that it is in the DOM, then clamped: the button sits at the
    // bottom edge, so the menu opens upwards and stays fully visible.
    const rect = snippetsBtn.getBoundingClientRect ? snippetsBtn.getBoundingClientRect() : { left: 0, top: 0 };
    const w = menu.offsetWidth || 160;
    const h = menu.offsetHeight || 26;
    menu.style.left = clamp(rect.left, 0, Math.max(0, window.innerWidth - w)) + 'px';
    menu.style.top = clamp(rect.top - h - 4, 0, Math.max(0, window.innerHeight - h)) + 'px';
    snippetMenuEl = menu;
  }

  /** The button is hidden until a `config` names at least one snippet. */
  function updateSnippetsButton() {
    if (!snippetsBtn) return;
    snippetsBtn.classList.toggle('hidden', SNIPPETS.length === 0);
  }

  // ---- `@` references: the composer's file picker ---------------------------
  // Typing `@` at the start of a token opens a caret-anchored list of files. The
  // *syntax* — where a token starts and ends, and the wash that replaces it — is
  // `media/mention.js`, a script of its own because a Node guard has to run the same
  // bytes (`tools/check-mention.js`, the `vm` + `window = ctx` pattern of
  // `tools/check-tree-grid.js`). This half is the popup, and the host does the matching
  // (three engines, one comparator): the webview posts the raw query and paints the rows
  // it gets back.
  //
  // Three rules live here and nowhere else:
  //   * A STALE ANSWER IS DROPPED. `mentionSeq` is bumped by every query posted *and* by
  //     every token that disappears, so an answer can only ever paint its own query — a
  //     slow reply for `@src` can never land on a menu that has moved on to `@docs`.
  //   * THE `@` IS NEVER SENT. Accepting a row washes the whole token out, so what the
  //     model reads is what the user would have typed by hand (plan §3).
  //   * A COMPOSING IME OWNS THE BOX. A Chinese word arrives as composition text, and a
  //     list opening under the caret mid-composition would sit inside the IME's own
  //     candidate window. No menu is opened or updated until the composition commits.
  const MENTION_DEBOUNCE_MS = 100;   // trailing: one query per pause in typing
  const MENTION_RECENT_MAX = 20;     // this tab's own picks, memory only (never persisted)
  const MENTION_MAX_H = 240;         // the menu scrolls past this
  const MENTION_MIN_W = 280;
  const MENTION_MAX_W = 560;
  const MENTION_GAP = 4;             // between the caret's line and the menu
  const MENTION_EDGE = 8;            // the viewport margin the menu never crosses
  const MENTION_PAGE = 5;            // PageUp / PageDown rows
  // The gap between the two columns of a row: the flex `gap` plus the detail's own left padding
  // (`media/style.css`). The path fitter subtracts it from the width the directory column gets.
  const MENTION_COLUMN_SPARE = 20;
  // The keys that move the caret without firing `input`: the token under it can be another
  // one, or none, so it is read again after the key's own default action has run.
  const MENTION_CARET_KEYS = new Set([
    'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown',
  ]);

  let mentionSeq = 0;                // the newest requestId issued (posted or voided)
  let mentionRecent = [];            // paths this tab inserted, most recent first
  let mentionToken = null;           // the token the menu belongs to (null: no token)
  let mentionMenu = null;            // { el, rows: [{ item, el }], index } or null
  let mentionMirror = null;          // the hidden div the caret is measured with
  let mentionQueryTimer = null;      // the pending debounce tick
  let mentionComposing = false;      // between compositionstart and compositionend
  let mentionDismissedAt = -1;       // the `@` whose menu Esc closed (§3: keep the text)

  /** The syntax module, or null when its script is not in the shell (a stale bundle). */
  function mentionSyntax() {
    const api = window.mentionSyntax;
    return api && typeof api.token === 'function' && typeof api.wash === 'function' ? api : null;
  }

  /** The textarea's value and its selection, defensively (no layout, no caret assumed). */
  function mentionCaret() {
    const value = typeof inputEl.value === 'string' ? inputEl.value : '';
    const start = typeof inputEl.selectionStart === 'number' ? inputEl.selectionStart : value.length;
    const stop = typeof inputEl.selectionEnd === 'number' ? inputEl.selectionEnd : start;
    const caret = Math.max(0, Math.min(start, value.length));
    const end = Math.max(caret, Math.min(stop, value.length));
    return { value, caret, end };
  }

  /** The `@` token under the caret, or null. */
  function mentionTokenAtCaret() {
    const api = mentionSyntax();
    if (!api) return null;
    const { value, caret } = mentionCaret();
    return api.token(value, caret);
  }

  /**
   * A viewport rect, or an empty one. Every measurement below is defensive: the offline
   * guard's DOM stub answers `getBoundingClientRect()` with zeros and has no `offsetLeft`
   * / `offsetTop` at all, so a caret handler must still place *something* instead of
   * throwing inside a keystroke.
   */
  function mentionRect(node) {
    if (node && typeof node.getBoundingClientRect === 'function') {
      try {
        const rect = node.getBoundingClientRect();
        if (rect) return rect;
      } catch (err) {
        /* a detached node: the empty rect below is the honest answer */
      }
    }
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }

  /** The computed style of one node, or `{}` when the platform has none to give. */
  function mentionStyle(node) {
    const read = window.getComputedStyle;
    if (typeof read !== 'function') return {};
    try {
      return read(node) || {};
    } catch (err) {
      return {};
    }
  }

  function mentionPx(value) {
    const parsed = parseFloat(value);
    return isFinite(parsed) ? parsed : 0;
  }

  // The properties the mirror shares with the textarea: the ones that decide where a glyph
  // lands and where a line breaks (plan §5). Anything else (colour, borders' style) cannot
  // move a caret.
  const MENTION_MIRROR_STYLES = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'boxSizing',
  ];

  /** The one reusable mirror div: created on first use, kept for the tab's life. */
  function mentionEnsureMirror() {
    if (mentionMirror) return mentionMirror;
    const mirror = el('div', 'mention-mirror');
    // The layout-critical properties are inline as well as in `media/style.css`: a caret
    // measured with the wrong `white-space` is a popup a line away from the caret, and
    // that must not depend on which stylesheet happened to load.
    mirror.style.position = 'fixed';
    mirror.style.left = '0';
    mirror.style.top = '0';
    mirror.style.visibility = 'hidden';
    mirror.style.pointerEvents = 'none';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordWrap = 'break-word';
    mirror.style.overflow = 'hidden';
    if (document.body && document.body.appendChild) document.body.appendChild(mirror);
    mentionMirror = mirror;
    return mirror;
  }

  /**
   * Where the caret is, in viewport coordinates — `{ left, top, bottom, lineHeight }` —
   * or null when it cannot be measured at all.
   *
   * A `<textarea>` reports no caret geometry, so the position comes from the mirror: the
   * text up to the caret, then one empty marker span, and the marker's own rect relative
   * to the mirror's (plan §5). The deltas are taken between the two *client* rects, so the
   * padding and border-width copied from the textarea are already in the answer; all that
   * is left is `scrollTop` (the box scrolls internally past `INPUT_MAX_H`) — and the
   * composer's place on the zoomed canvas, which the rect-to-`clientWidth` ratio gives
   * without reading the canvas transform.
   */
  function mentionCaretPoint() {
    const mirror = mentionEnsureMirror();
    if (!mirror || !mirror.parentElement) return null;
    const width = typeof inputEl.clientWidth === 'number' ? inputEl.clientWidth : 0;
    // A hidden (or not yet laid out) textarea has no line breaking to copy, and a mirror
    // sized 0 would put the marker on a line the box never draws.
    if (width <= 0) return null;
    const style = mentionStyle(inputEl);
    for (const prop of MENTION_MIRROR_STYLES) {
      const value = style[prop];
      if (typeof value === 'string' && value) mirror.style[prop] = value;
    }
    mirror.style.width = width + 'px';
    const { value, caret } = mentionCaret();
    // `textContent` replaces the previous pass's marker as well: one marker, every time.
    mirror.textContent = value.slice(0, caret);
    const marker = el('span');
    mirror.appendChild(marker);
    const box = mentionRect(mirror);
    const point = mentionRect(marker);
    const base = mentionRect(inputEl);
    // The composer lives inside the pannable/zoomable canvas, so its client rect is the
    // scaled one; the mirror is not scaled. The ratio puts the caret back on screen.
    const scale = base.width > 0 && width > 0 ? base.width / width : 1;
    const scrollTop = typeof inputEl.scrollTop === 'number' ? inputEl.scrollTop : 0;
    const lineHeight = (point.height > 0 ? point.height : mentionPx(style.lineHeight) || 18) * scale;
    const left = base.left + (point.left - box.left) * scale;
    const top = base.top + (point.top - box.top) * scale - scrollTop * scale;
    if (!isFinite(left) || !isFinite(top) || !isFinite(lineHeight)) return null;
    return { left, top, bottom: top + lineHeight, lineHeight };
  }

  /**
   * Put the open menu at the caret (plan §5): `x` on the caret, `y` under the caret's
   * line and flipped above it when the viewport below is the tighter half. Idempotent and
   * cheap, because it is also the answer to a `scroll`, a `resize` and a moved composer.
   */
  function mentionPosition() {
    if (!mentionMenu) return;
    const menu = mentionMenu.el;
    // Measured, then clamped to the bounds `media/style.css` gives the surface: the
    // placement must hold even if a stale stylesheet leaves it unsized.
    const width = clamp(menu.offsetWidth || MENTION_MIN_W, MENTION_MIN_W, MENTION_MAX_W);
    const height = clamp(menu.offsetHeight || MENTION_MAX_H, 0, MENTION_MAX_H);
    const innerW = window.innerWidth > 0 ? window.innerWidth : 1280;
    const innerH = window.innerHeight > 0 ? window.innerHeight : 800;
    let x = 0;
    let anchorTop = 0;
    let anchorBottom = 0;
    const point = mentionCaretPoint();
    if (point) {
      x = point.left;
      anchorTop = point.top;
      anchorBottom = point.bottom;
    } else {
      // No caret geometry to trust (a hidden box, or the guard's layoutless DOM): the
      // composer's own rect is the anchor, and it is never null.
      const rect = mentionRect(composerEl);
      x = rect.left + 10;
      anchorTop = rect.top;
      anchorBottom = rect.bottom;
    }
    const below = innerH - anchorBottom;
    const above = anchorTop;
    const flip = below < height + MENTION_GAP && above > below;
    let y = flip ? anchorTop - MENTION_GAP - height : anchorBottom + MENTION_GAP;
    y = clamp(y, MENTION_EDGE, Math.max(MENTION_EDGE, innerH - height - MENTION_EDGE));
    x = clamp(x, MENTION_EDGE, Math.max(MENTION_EDGE, innerW - width - MENTION_EDGE));
    menu.style.left = Math.round(x) + 'px';
    menu.style.top = Math.round(y) + 'px';
  }

  /** Close the menu and stop querying. The *typed text* is never touched here (§3). */
  function mentionClose() {
    if (mentionQueryTimer != null) {
      clearTimeout(mentionQueryTimer);
      mentionQueryTimer = null;
    }
    if (mentionMenu) {
      mentionMenu.el.remove();
      mentionMenu = null;
    }
    mentionToken = null;
    // Every answer still in flight belongs to a menu that no longer exists.
    mentionSeq += 1;
  }

  /** `Esc`: the menu goes, the typed text stays, and this `@` stays closed until it ends. */
  function mentionDismiss() {
    if (mentionToken) mentionDismissedAt = mentionToken.at;
    mentionClose();
  }

  /**
   * Read the caret's token and bring the menu in step. This is the single entry point
   * every trigger calls (`input`, the caret keys, a click, the IME's commit), so "a token
   * appeared" and "the token is gone" cannot disagree between handlers.
   */
  function mentionSync() {
    if (readOnly || inputEl.disabled) {
      mentionDismissedAt = -1;
      mentionClose();
      return;
    }
    // An IME owns the box: no menu is opened or updated while it composes (§3).
    if (mentionComposing) return;
    const token = mentionTokenAtCaret();
    if (!token) {
      // The token is gone: the menu closes, the pending query is cancelled, and an
      // earlier `Esc` is forgotten — the next `@` is a new one.
      mentionDismissedAt = -1;
      mentionClose();
      return;
    }
    // `Esc` dismissed this very token: it stays closed while the query is edited, and
    // reopens only once the `@` itself is gone (§3, JetBrains behaviour).
    if (token.at === mentionDismissedAt) return;
    mentionToken = token;
    if (mentionQueryTimer != null) clearTimeout(mentionQueryTimer);
    mentionQueryTimer = setTimeout(mentionPostQuery, MENTION_DEBOUNCE_MS);
    if (mentionMenu) {
      // Rows from the previous query are still on screen while this one is in flight.
      mentionPosition();
    }
  }

  /** One debounce tick: ask the host for the token's rows. */
  function mentionPostQuery() {
    mentionQueryTimer = null;
    if (!mentionToken) return;
    mentionSeq += 1;
    vscode.postMessage({
      type: 'mentionQuery',
      requestId: mentionSeq,
      query: mentionToken.query,
      recent: mentionRecent.slice(0, MENTION_RECENT_MAX),
    });
  }

  /**
   * One row's label with the host's highlight indices wrapped in `<b class="mention-hit">`.
   * The indices are in the coordinate space of `label` — for a pinyin hit they are whole
   * Chinese characters (§6.5) — so this side paints exactly what it was told to paint.
   */
  function mentionLabel(label, matches) {
    const span = el('span', 'mention-label');
    const text = typeof label === 'string' ? label : '';
    const hit = new Set();
    const marks = Array.isArray(matches) ? matches : [];
    for (const index of marks) {
      if (typeof index === 'number' && index >= 0 && index < text.length) hit.add(index);
    }
    let run = '';
    let runHit = false;
    const flush = () => {
      if (!run) return;
      if (runHit) span.appendChild(el('b', 'mention-hit', run));
      else span.appendChild(document.createTextNode(run));
      run = '';
    };
    for (let i = 0; i < text.length; i++) {
      const on = hit.has(i);
      if (on !== runHit) {
        flush();
        runHit = on;
      }
      run += text.charAt(i);
    }
    flush();
    return span;
  }

  /** The highlighted row, or null (a menu of notes only has nothing to accept). */
  function mentionActiveRow() {
    if (!mentionMenu || mentionMenu.index < 0) return null;
    return mentionMenu.rows[mentionMenu.index] || null;
  }

  /** Paint the highlight and keep it in view without scrolling the transcript (§5). */
  function mentionPaintActive() {
    if (!mentionMenu) return;
    const rows = mentionMenu.rows;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] && rows[i].el;
      if (!row || !row.classList) continue;
      row.classList.toggle('active', i === mentionMenu.index);
    }
    const active = mentionActiveRow();
    if (!active || !active.el || typeof active.el.scrollIntoView !== 'function') return;
    try {
      active.el.scrollIntoView({ block: 'nearest' });
    } catch (err) {
      /* an older renderer takes no options object; the row is on screen regardless */
    }
  }

  /**
   * Paint the host's answer. A stale one is dropped: only the newest `requestId` may
   * paint, because its rows were computed from a query the user may already have typed
   * past. Zero matches close the menu and leave the buffer exactly as typed (§3).
   */
  function applyMentionResult(msg) {
    if (!msg || msg.requestId !== mentionSeq) return;
    if (!mentionToken) return;
    if (readOnly || inputEl.disabled) return;
    const items = Array.isArray(msg.items) ? msg.items : [];
    if (items.length === 0) {
      mentionClose();
      return;
    }
    openMentionMenu(items, msg);
  }

  /** Build the popup from the host's rows: `{ kind, label, detail, insert, matches }`. */
  function openMentionMenu(items, msg) {
    const menu = el('div', 'mention-menu');
    const rows = [];
    for (const item of items) {
      if (!item || typeof item.label !== 'string') continue;
      // A `note` row is the host talking (the index source, a `readdir` failure, the
      // scope): it is information, never something to pick.
      if (item.kind === 'note') {
        menu.appendChild(el('div', 'mention-note', item.label));
        continue;
      }
      if (typeof item.insert !== 'string') continue;
      const row = el('div', 'mention-row');
      row.appendChild(mentionLabel(item.label, item.matches));
      const detail = typeof item.detail === 'string' && item.detail ? el('span', 'mention-detail', item.detail) : null;
      if (detail) row.appendChild(detail);
      // The tooltip is the string that will land in the box, so a row can be inspected
      // without accepting it.
      row.title = item.insert;
      const entry = { item, el: row, detail };
      row.addEventListener('mousedown', (event) => {
        // `mousedown`, not `click`, and `preventDefault()`: the caret must stay in the
        // textarea, so the composer's focus-restore ladder is never involved (§5). A click takes
        // the row as it stands, exactly like `Enter`; walking INTO a directory is `Tab` (§3.1).
        mentionPrevent(event);
        if (event && event.stopPropagation) event.stopPropagation();
        if (!mentionMenu) return;
        mentionAccept(entry);
      });
      rows.push(entry);
      menu.appendChild(row);
    }
    // The dialog row, pinned last and outside the highlight ring: it opens a chooser, it
    // does not insert anything the user has already seen named.
    const browse = el('div', 'mention-row mention-browse');
    browse.appendChild(el('span', 'mention-label', tr('Browse…')));
    browse.addEventListener('mousedown', (event) => {
      mentionPrevent(event);
      if (event && event.stopPropagation) event.stopPropagation();
      mentionClose();
      vscode.postMessage({ type: 'mentionBrowse' });
    });
    menu.appendChild(browse);
    if (typeof msg.note === 'string' && msg.note) {
      menu.appendChild(el('div', 'mention-note', msg.note));
    } else if (msg.truncated === true) {
      // The host capped its answer (the 50-row list, the 50k-path index): say so, in the
      // one place the user is already looking.
      menu.appendChild(el('div', 'mention-note', tr('Showing the first matches only — keep typing to narrow the list.')));
    }
    if (mentionMenu) mentionMenu.el.remove();
    if (document.body && document.body.appendChild) document.body.appendChild(menu);
    mentionMenu = { el: menu, rows, index: rows.length > 0 ? 0 : -1 };
    // The directory column is FITTED, not clipped: `fitPathText` keeps the segments nearest the
    // file and drops the far end of the path, so a narrow menu still says where the file is
    // instead of showing the head of a path whose tail is the useful part. The label (the file
    // name) is never fitted — it is the thing being chosen.
    for (const entry of rows) {
      if (!entry.detail || !entry.item || typeof entry.item.detail !== 'string') continue;
      registerPathFit(entry.detail, entry.item.detail, entry.el, { spare: MENTION_COLUMN_SPARE });
    }
    // Re-measured after the rows are in the DOM: the width the placement clamps against
    // is the rendered one (`max-content` up to 560px, per `media/style.css`).
    mentionPaintActive();
    mentionPosition();
  }

  /** `preventDefault()` where the event really has one (a synthetic one may not). */
  function mentionPrevent(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
  }

  /** Move the highlight by `delta` rows, stopping at either end. */
  function mentionMoveActive(delta) {
    if (!mentionMenu) return;
    const count = mentionMenu.rows.length;
    if (count === 0) return;
    mentionMenu.index = Math.max(0, Math.min(count - 1, mentionMenu.index + delta));
    mentionPaintActive();
  }

  /**
   * The menu's own keys (§5). Returns true when it consumed the key — the composer then
   * leaves it alone, which is exactly what keeps `Enter`-to-send untouched while the menu
   * is closed.
   */
  function mentionHandleKey(event) {
    if (!mentionMenu || !event) return false;
    const key = event.key;
    if (key === 'Escape') {
      mentionPrevent(event);
      mentionDismiss();
      return true;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'PageDown' || key === 'PageUp') {
      mentionPrevent(event);
      const back = key === 'ArrowUp' || key === 'PageUp';
      const step = key === 'PageDown' || key === 'PageUp' ? MENTION_PAGE : 1;
      mentionMoveActive(back ? -step : step);
      return true;
    }
    if (key === 'Enter' || key === 'Tab') {
      // Shift+Enter is the composer's newline even while the menu is up: it ends the
      // token, and the menu closes by itself on the `input` that follows.
      if (event.shiftKey) return false;
      const active = mentionActiveRow();
      // Nothing to accept (a scope note, or a failed `readdir`): the key stays the
      // composer's, so a send is never swallowed by an empty menu.
      if (!active) return false;
      mentionPrevent(event);
      // `Tab` walks INTO a directory; `Enter` takes the row as it stands (§3.1). That is the pair
      // that lets a folder be referenced on its own (`Enter` on `chat/` gives `src/chat`) while the
      // same row still works as one step of a long path (`Tab`).
      mentionAccept(active, key === 'Tab');
      return true;
    }
    return false;
  }

  /** One accepted path is remembered for the empty query (§8: memory only, max 20). */
  function mentionRemember(path) {
    if (typeof path !== 'string' || path === '') return;
    mentionRecent = [path].concat(mentionRecent.filter((seen) => seen !== path)).slice(0, MENTION_RECENT_MAX);
  }

  /**
   * The one write both entry points share: the value, the caret, and the composer's own refresh —
   * a programmatic write fires no `input` event, so `autoGrow` and the buttons would otherwise be
   * stale (§3 step 5).
   */
  function mentionWriteValue(result) {
    if (!result || typeof result.value !== 'string') return;
    mentionDismissedAt = -1;
    inputEl.value = result.value;
    const caret = typeof result.caret === 'number' ? result.caret : result.value.length;
    if (inputEl.setSelectionRange) inputEl.setSelectionRange(caret, caret);
    afterComposerWrite();
    if (inputEl.focus) inputEl.focus();
  }

  /** A finished pick: the write, then the menu goes. */
  function mentionApplyInsert(result) {
    mentionWriteValue(result);
    mentionClose();
  }

  /**
   * Take a row (§3.2).
   *
   * With `drill` (the `Tab` key) a **directory** row walks INTO it: the `@` stays, the text after
   * it becomes the directory plus its separator, and the menu answers for that directory, so a long
   * path is built one `Tab` at a time.
   *
   * Otherwise the row is the answer: the whole `@token` is washed out and the row's path takes its
   * place. On a directory that is how a whole folder is referenced (`Enter` on `chat/` gives
   * `src/chat`), and on a file it is how the reference is finished.
   */
  function mentionAccept(entry, drill) {
    if (!entry || !entry.item) return;
    // The token is re-read here and never trusted from the answer: the rows may describe a query
    // that is already a beat old.
    const token = mentionTokenAtCaret() || mentionToken;
    if (!token) return;
    if (drill && entry.item.kind === 'dir') {
      mentionDrill(entry, token);
      return;
    }
    const path = entry.item.insert;
    if (typeof path !== 'string') return;
    const api = mentionSyntax();
    if (!api) return;
    const { value } = mentionCaret();
    mentionRemember(path);
    mentionApplyInsert(api.wash(value, token, api.quotePath(path)));
  }

  /**
   * One step down a path (§3.1), the `Tab` half of taking a directory row: only the text between the
   * token's own `@` and the token's end is rewritten, so the `@` — and with it the menu's anchor —
   * survives the step. The query for the new directory is asked for here because a programmatic
   * write fires no `input` event.
   */
  function mentionDrill(entry, token) {
    const insert = entry && entry.item && entry.item.insert;
    if (typeof insert !== 'string' || insert === '') return;
    if (readOnly || inputEl.disabled) return;
    // The separator the path already uses: a drive path grows `\`, a workspace path grows `/`.
    const separator = insert.indexOf('\\') >= 0 ? '\\' : '/';
    const next = insert.replace(/[\\/]+$/, '') + separator;
    const { value } = mentionCaret();
    const head = value.slice(0, token.at + 1);
    const tail = value.slice(token.end);
    mentionWriteValue({ value: head + next + tail, caret: head.length + next.length });
    mentionSync();
  }

  /**
   * The path at the caret, quoted when it must be, and separated from whatever is already on
   * either side of it — the shape the attach dialog's answer inserts.
   */
  function mentionResultAtCaret(api, path) {
    const { value, caret, end } = mentionCaret();
    const insert = api.quotePath(path);
    const before = value.slice(0, caret);
    const after = value.slice(end);
    const lead = before !== '' && !/\s$/.test(before) ? ' ' : '';
    const trail = after !== '' && !/^\s/.test(after) ? ' ' : '';
    return {
      value: before + lead + insert + trail + after,
      caret: before.length + lead.length + insert.length + trail.length,
    };
  }

  /**
   * `mentionPicked` (§9): the attach dialog's answer, inserted by the same rules as a finished
   * row. There is no `@` token to wash here — the path lands at the caret, quoted when it has
   * to be, and separated from the text on either side.
   */
  function insertMentionPath(path) {
    const api = mentionSyntax();
    if (!api || typeof path !== 'string' || path === '') return;
    if (readOnly || inputEl.disabled) return;
    mentionRemember(path);
    mentionApplyInsert(mentionResultAtCaret(api, path));
  }

  /**
   * Remember which session this webview shows. VS Code persists the state set
   * here across window reloads and hands it to the host's webview panel
   * serializer, so the restored chat tab is bound to the same conversation.
   */
  function rememberSession(sessionId) {
    if (!sessionId || sessionId === persistedSessionId) return;
    persistedSessionId = sessionId;
    vscode.setState({ ...(vscode.getState() || {}), sessionId });
  }

  /**
   * A run ended (`done` / `interrupted` / `error`). In the P1 shape the message
   * names the node it belongs to, so:
   *   - the finalize (and, for an error, the error message) is routed into *that*
   *     node's card — a run finishing on another branch must not write into the
   *     transcript on screen;
   *   - that node's live tool cards go (another node's stay);
   *   - the follow light is released only when the node the user is looking at is
   *     the one that finished, so a background branch finishing never yanks the
   *     scroll of the focused node;
   *   - and the node's thinking rows collapse to their one line, *after* it left
   *     `runningNodes` (see `closeActiveRows` at the very end of the function).
   * Without a nodeId the legacy shape is replayed verbatim: the view focus
   * container, all live tool cards, and the session-level busy flag.
   */
  function endRun(msg, extra) {
    const nodeId = msg.nodeId;
    if (nodeId) {
      // The turn is over: nothing in that node is live any more, so the thinking
      // rows (via the finalize) and any tool row that never reported its end — the
      // turn was interrupted mid-call — fold back to their resting state.
      routeTo(nodeId, () => { finalizeStreamingAnswer(); closeActiveRows('tool'); });
      clearLiveTools(nodeId);
      if (extra) routeTo(nodeId, extra);
      runningNodes.delete(nodeId);
      // The session is only idle once *every* run is gone; a fresh `state` from the
      // host follows and stays authoritative.
      if (runningNodes.size === 0) setBusy(false);
    } else {
      finalizeStreamingAnswer();
      closeActiveRows('tool');
      clearLiveTools();
      if (extra) extra();
      setBusy(false);
    }
    updateComposerButtons();
    if (!nodeId || nodeId === treeActiveId) setActiveScrollLock(false);
    // The very last step of a finished turn, and only now: `runningNodes` no longer has
    // this node, so every thinking row of the turn becomes one line and every tool row
    // freezes. Both branches land on a card here: the routed one on its own node, the
    // legacy one on the view focus, which is the card the turn was written into.
    settleRowsFinished(nodeId ? nodeEls[nodeId] : (treeActiveId ? nodeEls[treeActiveId] : null));
  }

  /**
   * One message from the host. It is called from the listener below, which times
   * every message — a handler that blocks this thread is the one kind of stutter
   * the webview cannot report about itself from inside the handler.
   */
  // ---- Find: the bar, the result list, the card marks, the jump ----------------------
  // `plans/conversation-search.md`. The **corpus and the matcher are the host's**
  // (`src/chat/find.ts`): a card far off screen has no content in the DOM, a long log is
  // windowed and a step group is folded, so a find over this document would miss most of
  // a conversation and every other conversation. What this half owns is the bar, the
  // list, the marks and the jump.
  // ------------------------------------------------------------------------------------

  /** Is the bar up? (The list follows it: one surface, two panels.) */
  function findIsOpen() {
    return !!(findBar && !findBar.classList.contains('hidden'));
  }

  /** The hit the counter and the card outline call "current", or null. */
  function findCurrentHit() {
    return findState.index >= 0 && findState.hits[findState.index] ? findState.hits[findState.index] : null;
  }

  /**
   * Open the bar — and for the `all` scope its list too. A scope change is a new query
   * under a new id, so an answer still on its way for the old scope is dropped; the same
   * scope with text in the box re-runs, because the conversation may have grown since.
   *
   * `seed` is a jump's own query (`findJump` into another conversation): the tab that
   * opens shows the same bar and the same hit instead of dropping the search, and
   * `focusNode` makes that card the current one rather than the conversation's first hit.
   */
  function findOpen(scope, seed) {
    if (!findBar) return;
    const next = scope === 'all' ? 'all' : 'session';
    findBar.classList.remove('hidden');
    findState.active = true;
    if (findState.scope !== next) {
      findState.scope = next;
      findState.hits = [];
      findState.index = -1;
      findState.invalid = '';
      findState.requestId++;
    }
    if (seed && typeof seed.query === 'string') {
      findState.caseSensitive = seed.caseSensitive === true;
      findState.wholeWord = seed.wholeWord === true;
      findState.regex = seed.regex === true;
      findState.focusNode = typeof seed.nodeId === 'string' ? seed.nodeId : '';
      if (findInput) findInput.value = seed.query;
    }
    if (next === 'all') findState.listOpen = true;
    findSyncToggles();
    findRenderCount();
    findRenderResults();
    findApplyMarks();
    if (findInput && findInput.value.trim()) findQueryNow();
    if (findInput) {
      findInput.focus();
      if (findInput.value && typeof findInput.select === 'function') findInput.select();
    }
  }

  /** Close the bar and its list, drop the marks, and give the focus back to the composer. */
  function findClose() {
    if (!findBar) return;
    findBar.classList.add('hidden');
    findBar.classList.remove('invalid');
    if (findResultsEl) findResultsEl.classList.add('hidden');
    findState.active = false;
    findState.listOpen = false;
    findState.hits = [];
    findState.index = -1;
    findState.invalid = '';
    findState.requestId++;   // nothing on its way may paint after the close
    findPending = null;
    findClearMarks();
    if (findResultsListEl) findResultsListEl.innerHTML = '';
    if (inputEl) inputEl.focus();
  }

  function findSetListOpen(open) {
    findState.listOpen = !!open;
    findRenderResults();
  }

  /** The three toggles' own state, including the rule that whole word yields to regex. */
  function findSyncToggles() {
    const press = (btn, on) => {
      if (!btn) return;
      btn.classList.toggle('active', on);
      if (btn.setAttribute) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    };
    press(findCaseBtn, findState.caseSensitive);
    press(findWordBtn, findState.wholeWord);
    press(findRegexBtn, findState.regex);
    if (findWordBtn) findWordBtn.disabled = findState.regex;
  }

  /** Typing is debounced; a whole-profile scan per keystroke is not what a keystroke means. */
  function findSchedule() {
    if (findTimer != null) clearTimeout(findTimer);
    findTimer = setTimeout(() => {
      findTimer = null;
      findQueryNow();
    }, 120);
  }

  /** Ask the host. The id is the only thing that says which answer is still wanted. */
  function findQueryNow() {
    if (!findInput) return;
    if (findTimer != null) {
      clearTimeout(findTimer);
      findTimer = null;
    }
    const query = findInput.value;
    findState.query = query;
    findState.requestId++;
    if (!query.trim()) {
      findState.hits = [];
      findState.index = -1;
      findState.invalid = '';
      findRenderCount();
      findRenderResults();
      findApplyMarks();
      return;
    }
    vscode.postMessage({
      type: 'find',
      requestId: findState.requestId,
      scope: findState.scope,
      query,
      caseSensitive: findState.caseSensitive,
      wholeWord: findState.wholeWord,
      regex: findState.regex,
      limit: 200,
    });
  }

  function findToggle(which) {
    if (which === 'case') findState.caseSensitive = !findState.caseSensitive;
    else if (which === 'word') {
      if (findState.regex) return;   // the toggle is disabled, and this is its guarantee
      findState.wholeWord = !findState.wholeWord;
    } else if (which === 'regex') findState.regex = !findState.regex;
    findSyncToggles();
    findQueryNow();
  }

  /**
   * The query as the same pattern the host compiled (`src/chat/find.ts`), so a mark can
   * never disagree with a hit. `null` while the box is empty or the pattern does not
   * parse — the host says why in `#find-count`.
   */
  function findMatcher() {
    const query = findState.query;
    if (!query) return null;
    const flags = findState.caseSensitive ? 'g' : 'gi';
    try {
      if (findState.regex) return new RegExp(query, flags);
      const literal = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(findState.wholeWord ? '\\b' + literal + '\\b' : literal, flags);
    } catch (err) {
      return null;
    }
  }

  /** Take every `mark.find-match` out of `root`, giving its text nodes back. */
  function findUnmarkText(root) {
    if (!root || !root.querySelectorAll) return;
    const marks = root.querySelectorAll('mark.find-match');
    for (const mark of marks) {
      const parent = mark.parentNode;
      if (!parent) continue;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      if (parent.normalize) parent.normalize();
    }
  }

  /**
   * Mark the query inside one card's rendered text (its pinned ask and its log). Only
   * text nodes are touched: `textarea` / `input` / `script` / `style` are skipped, and a
   * zero-width regex match draws nothing rather than an empty `<mark>`.
   *
   * The sandbox `check:webview` loads this file into has no `createTreeWalker`, so the
   * marking is skipped there instead of throwing — the guard asserts the message paths,
   * not the paint.
   */
  function findMarkText(card) {
    if (!card) return;
    findMarkZone(card.querySelector && card.querySelector('.node-ask'));
    findMarkZone(card.querySelector && card.querySelector('.node-work'));
  }

  /**
   * Mark the query inside **one element's** rendered text, in the real document only.
   *
   * The text nodes are what gets marked, so the mark is found again on what is actually on
   * screen: that is what makes it work over a snippet rendered from markdown (whose source
   * markers are gone) as well as over a card's rendered rows. `false` means this document
   * has no `createTreeWalker` (the build-time stub of `check:webview`), so the caller can
   * fall back to plain text instead of showing an unmarked shell.
   */
  function findMarkZone(zone) {
    const re = findMatcher();
    if (!re || !zone || typeof document.createTreeWalker !== 'function') return false;
    findUnmarkText(zone);
    const doc = zone.ownerDocument || document;
    // 4 === NodeFilter.SHOW_TEXT. The filter itself is a plain check in the loop: it
    // keeps this file free of the `NodeFilter` global, which the guard's DOM lacks.
    const walker = doc.createTreeWalker(zone, 4);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    for (const node of textNodes) {
      const text = node.nodeValue;
      const parent = node.parentNode;
      if (!text || !text.trim() || !parent) continue;
      const tag = parent.nodeName;
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'MARK' || tag === 'SCRIPT' || tag === 'STYLE') continue;
      re.lastIndex = 0;
      let match;
      let last = 0;
      let frag = null;
      while ((match = re.exec(text))) {
        if (match[0] === '') {
          re.lastIndex++;   // a zero-width match has nothing to paint
          continue;
        }
        const at = match.index;
        if (!frag) frag = doc.createDocumentFragment();
        if (at > last) frag.appendChild(doc.createTextNode(text.slice(last, at)));
        const mark = doc.createElement('mark');
        mark.className = 'find-match';
        mark.textContent = match[0];
        frag.appendChild(mark);
        last = at + match[0].length;
        if (last >= text.length) break;
      }
      if (!frag) continue;
      if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
      parent.replaceChild(frag, node);
    }
    return true;
  }

  function findClearMarks() {
    for (const id in nodeEls) {
      const card = nodeEls[id];
      if (!card) continue;
      card.classList.remove('find-hit', 'find-current');
      findUnmarkText(card);
    }
  }

  /**
   * The two card classes: every card with a hit, and the current one. Cheap (a class
   * toggle per card), unlike the text marks below.
   */
  function findApplyMarks() {
    if (!findBar) return;
    const hitIds = Object.create(null);
    for (const hit of findState.hits) hitIds[hit.nodeId] = true;
    const current = findCurrentHit();
    for (const id in nodeEls) {
      const card = nodeEls[id];
      if (!card) continue;
      card.classList.toggle('find-hit', !!hitIds[id]);
      card.classList.toggle('find-current', !!current && current.nodeId === id);
    }
    findScheduleMarks();
  }

  /**
   * Text marks are applied lazily, once per frame, and only to cards the reader can see:
   * the checked-out path plus the current hit. A 200-row result never walks 200 cards,
   * and a hit card off the path is marked when a jump checks it out.
   */
  function findScheduleMarks() {
    if (!findState.active || findState.hits.length === 0 || findMarkRaf != null) return;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
    findMarkRaf = raf(() => {
      findMarkRaf = null;
      if (!findState.active) return;
      const ids = Object.create(null);
      for (const id in activePathSet) ids[id] = true;
      const current = findCurrentHit();
      if (current) ids[current.nodeId] = true;
      for (const hit of findState.hits) {
        if (!ids[hit.nodeId]) continue;
        const card = nodeEls[hit.nodeId];
        if (card) findMarkText(card);
      }
    });
  }

  /** Re-mark after a turn ended: a grown answer is new text nobody has marked yet. */
  function findRefreshMarks() {
    if (!findState.active) return;
    findScheduleMarks();
  }

  /** The counter: the current position, or why there is none. */
  function findRenderCount() {
    if (!findCountEl) return;
    if (findBar) findBar.classList.toggle('invalid', !!findState.invalid);
    findCountEl.classList.toggle('error', !!findState.invalid);
    if (findState.invalid) {
      findCountEl.textContent = tr('Invalid regular expression: {0}', findState.invalid);
      findCountEl.title = findCountEl.textContent;
      return;
    }
    findCountEl.title = '';
    if (!findState.query.trim()) {
      findCountEl.textContent = '';
      return;
    }
    if (findState.hits.length === 0) {
      findCountEl.textContent = tr('No matches in {0} cards', findState.scanned);
      return;
    }
    // `+` is the cap: the list was cut, not the history (see `FindResult.capped`).
    findCountEl.textContent = `${findState.index + 1}/${findState.hits.length}${findState.capped ? '+' : ''}`;
  }

  /**
   * One row's snippet: the line rendered as **inline** markdown, with the match marked.
   *
   * Only inline markdown can mean anything in a ±60-character window of an answer: every
   * block construct starts outside it, so `renderInline` is the right renderer and `mdInline`
   * (the cards' instance minus links and images) is the right one — a row is a `<button>`,
   * so an `<a>` inside it is invalid HTML that would also take the click from the jump, and
   * an `<img>` would make the webview fetch whatever URL a conversation happens to hold.
   *
   * With no renderer at all the raw line is shown instead, marked by hand: that is the
   * build-time stub of `check:webview`, which loads `media/main.js` alone.
   */
  function findSnippetEl(text) {
    const span = el('span', 'find-row-snippet');
    const html = renderFindSnippet(text);
    if (html == null) {
      return findSnippetPlainEl(span, text);
    }
    span.innerHTML = html;
    // The host's offsets describe the markdown source, and rendering removed its markers
    // (`**`, backticks), so the offsets no longer point at the query: it is located again
    // in the rendered text, the same walk a card's mark uses.
    findMarkZone(span);
    return span;
  }

  /** The fallback row: the raw line, with the match wrapped by hand. */
  function findSnippetPlainEl(span, text) {
    const re = findMatcher();
    if (!re || typeof document.createTextNode !== 'function') {
      span.textContent = text;
      return span;
    }
    re.lastIndex = 0;
    const match = re.exec(text);
    if (!match || match[0] === '') {
      span.textContent = text;
      return span;
    }
    const at = match.index;
    const end = at + match[0].length;
    if (at > 0) span.appendChild(document.createTextNode(text.slice(0, at)));
    const mark = el('mark', 'find-match', match[0]);
    span.appendChild(mark);
    if (end < text.length) span.appendChild(document.createTextNode(text.slice(end)));
    return span;
  }

  /** The result list: one row per hit, grouped by conversation in the `all` scope. */
  function findRenderResults() {
    if (!findResultsEl || !findResultsListEl) return;
    const open = findState.active && findState.listOpen;
    findResultsEl.classList.toggle('hidden', !open);
    if (!open) return;
    // Emptying the list drops its scroll position, so the reader's place is read first and
    // handed back below. A `Next` press never comes through here (see `findMarkRows`).
    const keepScroll = findResultsListEl.scrollTop || 0;
    findResultsListEl.innerHTML = '';
    findRowEls = [];
    if (findResultsTitleEl) findResultsTitleEl.textContent = tr('Find results');
    if (findResultsCountEl) {
      findResultsCountEl.textContent = findState.hits.length > 0 ? tr('{0} matches', findState.hits.length) : '';
    }
    if (findState.invalid) {
      findResultsListEl.appendChild(el('div', 'find-note error', tr('Invalid regular expression: {0}', findState.invalid)));
      return;
    }
    if (findState.timedOut) {
      // A page that stopped mid-scan must never read as the end of the history.
      findResultsListEl.appendChild(el('div', 'find-note', tr('Search stopped early. Narrow the query.')));
    }
    let lastSession = null;
    findState.hits.forEach((hit, index) => {
      if (findState.scope === 'all' && hit.sessionId !== lastSession) {
        lastSession = hit.sessionId;
        findResultsListEl.appendChild(el('div', 'find-group', hit.sessionTitle || hit.sessionId));
      }
      const row = el('button', 'find-row');
      row.type = 'button';
      // A single click only **selects** the row (the current hit, its card outline and the
      // counter); it is the double-click that goes there. Opening a card is a checkout,
      // which moves the composer and can switch the whole tab, so a stray click in a list
      // of 200 rows must not do it.
      row.title = tr('Double-click to open the card');
      if (index === findState.index) row.classList.add('current');
      const title = el('span', 'find-row-title', hit.nodeTitle || hit.nodeId);
      const chip = el('span', 'find-chip', hit.field === 'answer' ? tr('Answer') : tr('Question'));
      title.appendChild(chip);
      row.appendChild(title);
      row.appendChild(findSnippetEl(hit.snippet || ''));
      row.addEventListener('click', () => findSelect(index, false));
      row.addEventListener('dblclick', () => findSelect(index, true));
      findResultsListEl.appendChild(row);
      findRowEls.push(row);
    });
    if (findState.hits.length === 0 && !findState.invalid) {
      findResultsListEl.appendChild(el('div', 'find-note', tr('No matches in {0} cards', findState.scanned)));
    }
    findResultsListEl.scrollTop = keepScroll;
    // …and the current row is the one the reader must be able to see: a jump into another
    // conversation re-renders this list in the tab that just opened, where the position the
    // reader left behind does not exist.
    findScrollCurrentIntoView();
  }

  /**
   * The current row, inside the list's own scroller.
   *
   * Deliberately arithmetic on this list's own box, never `scrollIntoView`: that scrolls
   * **every** scrollable ancestor, and the one thing this panel must not do is move the
   * document or the canvas underneath it. `#find-results-list` is `position: relative` in
   * the stylesheet, so `offsetTop` is measured from the scroller's own content box.
   */
  function findScrollCurrentIntoView() {
    if (!findResultsListEl || findState.index < 0) return;
    const row = findRowEls[findState.index];
    if (!row || typeof row.offsetTop !== 'number') return;
    const height = typeof row.offsetHeight === 'number' ? row.offsetHeight : 0;
    const viewTop = findResultsListEl.scrollTop || 0;
    const viewHeight = findResultsListEl.clientHeight || 0;
    const viewBottom = viewTop + viewHeight;
    if (row.offsetTop < viewTop) findResultsListEl.scrollTop = row.offsetTop;
    else if (row.offsetTop + height > viewBottom) findResultsListEl.scrollTop = row.offsetTop + height - viewHeight;
  }

  /**
   * Move the `current` marker between the rows already on screen.
   *
   * A rebuild is what `findRenderResults` is for, and it costs the list its scroll position:
   * a `Next` press (or a click on a row) that rebuilt the list would throw the reader's place
   * away every time. The rows themselves never change between two hits of one answer.
   */
  function findMarkRows() {
    findRowEls.forEach((row, index) => {
      if (row) row.classList.toggle('current', index === findState.index);
    });
  }

  /** Move the current hit — Next / Previous wrap at both ends, as a find box does. */
  function findSelect(index, reveal) {
    if (findState.hits.length === 0) return;
    const n = findState.hits.length;
    findState.index = ((index % n) + n) % n;
    findRenderCount();
    findMarkRows();
    findScrollCurrentIntoView();
    findApplyMarks();
    if (reveal) findReveal(findState.hits[findState.index]);
  }

  /**
   * Go to one hit. Only the **checked-out** card is expanded, so a jump is a checkout:
   * the host moves the view focus (which is what renders the answer the hit lives in)
   * and opens the hit's conversation when it belongs to another one. The reveal is
   * applied by `findAfterRender`, because the card may not exist yet.
   */
  function findReveal(hit) {
    if (!hit) return;
    const sameTab = !persistedSessionId || hit.sessionId === persistedSessionId;
    const card = sameTab ? nodeEls[hit.nodeId] : null;
    if (card && hit.nodeId === treeActiveId) {
      panToNode(hit.nodeId);
      findMarkText(card);
      return;
    }
    findPending = { sessionId: hit.sessionId, nodeId: hit.nodeId };
    vscode.postMessage({
      type: 'findJump',
      sessionId: hit.sessionId,
      nodeId: hit.nodeId,
      field: hit.field,
      // The query travels with the jump: the host opens that conversation's tab, and the bar
      // there re-runs this search with this card as the current hit instead of an empty box.
      scope: findState.scope,
      query: findState.query,
      caseSensitive: findState.caseSensitive,
      wholeWord: findState.wholeWord,
      regex: findState.regex,
    });
    if (card) panToNode(hit.nodeId);   // instant feedback while the checkout lands
  }

  /** One answer from the host. A stale `requestId` is dropped, never painted. */
  function findOnResults(msg) {
    if (!findState.active) return;
    if (msg.requestId !== findState.requestId) return;
    findState.invalid = typeof msg.invalid === 'string' ? msg.invalid : '';
    findState.hits = Array.isArray(msg.hits) ? msg.hits : [];
    findState.timedOut = msg.timedOut === true;
    findState.capped = msg.capped === true;
    findState.scanned = typeof msg.scannedNodes === 'number' ? msg.scannedNodes : 0;
    // The current hit starts on this conversation's first row, so Enter walks the list
    // from where the reader is looking; another conversation's rows are click targets.
    let first = -1;
    for (let i = 0; i < findState.hits.length; i++) {
      if (findState.hits[i].sessionId === persistedSessionId) {
        first = i;
        break;
      }
    }
    findState.index = findState.hits.length === 0 ? -1 : first >= 0 ? first : 0;
    // A seeded open (a jump's own query) names the card the reader clicked: it is the
    // current hit, not whichever one happens to be first in this conversation.
    if (findState.focusNode) {
      const wanted = findState.hits.findIndex((hit) => hit.nodeId === findState.focusNode);
      if (wanted >= 0) findState.index = wanted;
      findState.focusNode = '';
    }
    findRenderCount();
    findRenderResults();
    findApplyMarks();
    const current = findCurrentHit();
    // The camera never moves on its own. Typing only *selects* a hit (the row, its counter
    // and the card's outline); going to a card is an explicit act — a double-click on a row,
    // `Enter` / `F3`, the arrows, or the seeded jump of a double-clicked row in another
    // conversation. An answer arrives asynchronously, so re-centring here is exactly the
    // "magnet" that makes a drag feel like it will not let go: it is gone.
    if (current) {
      const card = nodeEls[current.nodeId];
      if (card) findMarkText(card);
    }
  }

  /** After every repaint: apply a pending reveal, and keep the marks on the cards. */
  function findAfterRender() {
    if (!findState.active) return;
    if (findPending && (!persistedSessionId || findPending.sessionId === persistedSessionId)) {
      const card = nodeEls[findPending.nodeId];
      if (card) {
        const pending = findPending;
        findPending = null;
        panToNode(pending.nodeId);
        findMarkText(card);
      }
    }
    if (findState.hits.length > 0) findApplyMarks();
  }

  // The two shortcuts and the bar's own keys. Capture phase: the composer's textarea
  // takes Enter and the mention menu takes Esc, and neither may win while the bar has
  // the focus. `isComposing` first, so an IME never loses a keystroke to a shortcut.
  window.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = (e.key || '').toLowerCase();
    if (mod && !e.altKey && key === 'f') {
      // Ctrl+F this conversation, Ctrl+Shift+F every conversation. A key pressed inside
      // a webview never reaches the workbench, which is what makes the second ours.
      e.preventDefault();
      e.stopPropagation();
      findOpen(e.shiftKey ? 'all' : 'session');
      return;
    }
    if (!findState.active) return;
    const inBar = !!findBar && ((findBar.contains && findBar.contains(e.target)) || e.target === findInput);
    if (inBar && e.altKey && !mod) {
      if (key === 'c') {
        e.preventDefault();
        findToggle('case');
        return;
      }
      if (key === 'w') {
        e.preventDefault();
        findToggle('word');
        return;
      }
      if (key === 'r') {
        e.preventDefault();
        findToggle('regex');
        return;
      }
    }
    if (e.key === 'F3') {
      e.preventDefault();
      findSelect(findState.index + (e.shiftKey ? -1 : 1), true);
      return;
    }
    if (!inBar) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      findClose();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      findSelect(findState.index + (e.shiftKey ? -1 : 1), true);
    }
  }, true);

  if (findInput) {
    findInput.addEventListener('input', () => {
      findState.invalid = '';
      findSchedule();
    });
    findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        findSelect(findState.index + (e.shiftKey ? -1 : 1), true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        findClose();
      }
    });
  }
  if (findCaseBtn) findCaseBtn.addEventListener('click', () => findToggle('case'));
  if (findWordBtn) findWordBtn.addEventListener('click', () => findToggle('word'));
  if (findRegexBtn) findRegexBtn.addEventListener('click', () => findToggle('regex'));
  if (findPrevBtn) findPrevBtn.addEventListener('click', () => findSelect(findState.index - 1, true));
  if (findNextBtn) findNextBtn.addEventListener('click', () => findSelect(findState.index + 1, true));
  if (findListBtn) findListBtn.addEventListener('click', () => findSetListOpen(!findState.listOpen));
  if (findCloseBtn) findCloseBtn.addEventListener('click', () => findClose());

  function handleMessage(msg) {
    switch (msg.type) {
      case 'tree':
        // A repaint replaces the cards any fading answer lives in: settle those chunks
        // into their `Text` nodes first, so the newest characters are never left in a
        // span the repaint throws away.
        flushChunks();
        renderTree(msg);
        break;
      case 'path':
        renderPath(msg);
        break;
      case 'nodeUpdate':
        applyNodeUpdate(msg);
        break;
      case 'agentItems':
      case 'nodeItems':
        // The host's answer to `loadAgentItems` / `loadNodeItems`: one node's items,
        // which the `tree` / `path` payload did not carry — a sub-agent's transcript
        // (`itemCount` only, see `SessionRuntime.postTree`) or a regular card's items for
        // a `tree`-first card that asked for them (see `requestNodeItems`). Both are one
        // shape and one code path (`applyFetchedItems`): a second answer for a card that
        // already has its items — or one for a node a tree rebuild has dropped — is
        // ignored, never thrown (a webview callback that throws is silent in the real UI)
        // and renders nothing twice.
        applyFetchedItems(msg.id, msg.items);
        break;
      case 'panTo':
        panToNode(String(orElse(msg.id, '')));
        break;
      case 'findResults':
        // The host's answer to a `find` (`src/chat/find.ts` compiled it). A stale answer
        // is dropped inside `findOnResults` by its `requestId`.
        findOnResults(msg);
        break;
      case 'findOpen':
        // The Command Palette entries (`Find in Conversation` / `Find in All Sessions`) and a
        // jump into another conversation: the tab opens the bar itself, so the shortcut, the
        // palette and the jump all do the same thing. A jump carries its query (`msg`) as the
        // seed, so the tab that opens marks the hit the reader clicked.
        findOpen(msg.scope === 'all' ? 'all' : 'session', msg);
        break;
      case 'config': {
        // The card list is authoritative and complete on every `config`: a card the
        // user deleted must disappear from the dropdown, so an empty list is a real
        // answer (the host never sends one — it always has a fallback card).
        CARDS = Array.isArray(msg.cards) ? msg.cards : [];
        EFFORTS = Array.isArray(msg.efforts) ? msg.efforts : [];
        SNIPPETS = Array.isArray(msg.snippets) ? msg.snippets : [];
        updateSnippetsButton();
        renderModelSelect(msg.model);
        renderEffortSelect(msg.thinkingEffort);
        updateImageVisibility();
        // The two identities of the checked-out node (`setup`, §4.2). Absent on a
        // replay shape that predates it — then there is no drift to show, which is
        // exactly the old behaviour.
        SETUP = msg.setup && typeof msg.setup === 'object' ? msg.setup : null;
        renderSetupIdentity();
        // The word / row appear animation (`spinney.streamAnimation`). A replay shape
        // that predates the field sends nothing — then it is on, which is the setting's
        // own default and what every fixture in `tools/check-webview.js` gets.
        streamAnimation = msg.streamAnimation !== false;
        // The CSS half of the one switch: the running verb's glimmer is a stylesheet
        // animation, so `body.anim` is how the setting reaches it.
        if (document.body && document.body.classList) {
          document.body.classList.toggle('anim', streamAnimation);
        }
        break;
      }
      case 'state':
        // `runningNodes` is authoritative for the Send/Stop pair; `busy` only
        // drives the session chrome (dot, tps, selects). A host that predates the
        // per-node shape sends no `runningNodes`: derive it from `busy` + the view
        // focus, which reproduces the old one-run-at-a-time behaviour exactly.
        runningNodes = Array.isArray(msg.runningNodes)
          ? new Set(msg.runningNodes)
          : msg.busy ? new Set([treeActiveId]) : new Set();
        // A host that predates the lock sends no `lockedNodes`: nothing is locked,
        // which reproduces the old behaviour exactly.
        lockedNodes = Array.isArray(msg.lockedNodes) ? new Set(msg.lockedNodes) : new Set();
        // A window that does not own this workspace's sessions is read-only: the host
        // refuses every turn there, so the composer says so up front instead of letting a
        // send fail. A host that predates the flag sends nothing: not read-only.
        readOnly = msg.readOnly === true;
        updateComposerButtons();
        setBusy(msg.busy);
        setStatus(msg.status);
        rememberSession(msg.sessionId);
        // The lock is a property of the view focus node, so a `state` that changes it
        // must re-run the composer rules — the tree did not change.
        updateBranchBanner();
        break;
      case 'background':
        // Legacy shape (an older host sends an untagged list): no owner is named,
        // so those jobs render into the view focus node's dock.
        renderBackgrounds(msg.tasks, true);
        break;
      // P2 shape: one flat list, every task tagged with its owning node. Each
      // group renders into the dock at the bottom of that node's own card.
      case 'backgrounds':
        renderBackgrounds(msg.tasks, false);
        break;
      case 'backgroundsGlobal':
        // The window-global terminal dock: every session's jobs, on **this** tab too.
        // Independent of `reset` (a session switch moves no job) and of the tree: the
        // dock is fixed, and a job that prints repaints its own row.
        renderTerminalDock(msg.jobs);
        break;
      case 'context':
        setContext(msg.used, msg.total);
        break;
      case 'sessionStats':
        setSessionStats(msg.stats);
        break;
      case 'balance':
        setBalance(msg);
        break;
      case 'status':
        setStatus(msg.text);
        break;
      case 'user':
        addUserPrompt(msg.text, msg.attachments);
        break;
      case 'composerClear':
        // The host really took the message: only now does the box (and the pending
        // attachments) go. This is the *only* place the composer empties itself —
        // `send()` never does, so a modal answered with No cannot eat the text.
        inputEl.value = '';
        pendingAttachments = [];
        renderPendingAttachments();
        // The same refresh the `input` event does: an emptied box must disable Send
        // again, not keep the previous value's verdict.
        afterComposerWrite();
        // An emptied box has no `@` token left: the picker goes with it.
        mentionSync();
        break;
      case 'harnessNote':
        // An in-place continue (`SessionRuntime.continueFrom`): the block belongs in
        // the transcript of *that* node, so it is routed explicitly (the view focus
        // does not move for an injected turn).
        routeTo(msg.nodeId, () => addHarnessNote(msg.text));
        break;
      case 'backgroundNotice':
        // Delivered at a tool boundary of a *running* turn, so the block lands in
        // the middle of the transcript: close out the answer that was streaming
        // above it first, or that answer would never be finalized (it stays a raw
        // text node and its markdown is never rendered).
        routeTo(msg.nodeId, () => {
          finalizeStreamingAnswer();
          addBackgroundNotice(msg.item);
        });
        break;
      case 'imagePicked':
        addPendingAttachment(msg.dataUrl, msg.name);
        break;
      case 'mentionResult':
        // The answer to one `mentionQuery`; a stale one is dropped inside (§8).
        applyMentionResult(msg);
        break;
      case 'mentionPicked':
        // The attach dialog's answer: the path lands at the caret (§9).
        insertMentionPath(msg.path);
        break;
      case 'delta':
        addTpsTokens(msg.text);
        routeTo(msg.nodeId, () => appendAssistant(msg.text), 'delta');
        break;
      case 'thinkingDelta':
        addTpsTokens(msg.text);
        routeTo(msg.nodeId, () => appendThinking(msg.text), 'thinkingDelta');
        break;
      case 'usage':
        routeTo(msg.nodeId, () => appendUsage(msg.usage, msg.cachePct), 'usage');
        break;
      case 'toolCallDelta':
        // The host sends the call's index, id and name and **not its arguments** (see
        // `queueToolCallDelta`): the draft row is one fixed line (`addLiveTool`), so the
        // argument bytes are a payload nothing renders. The tok/s readout still counts the
        // name it did get.
        addTpsTokens(msg.name || '');
        routeTo(msg.nodeId, () => appendLiveTool(msg.index, msg.id, msg.name), 'toolCallDelta');
        break;
      case 'toolStart':
        routeTo(msg.nodeId, () => { finalizeStreamingAnswer(); finalizeLiveTool(msg.index, msg.id, msg.name, msg.args, msg.startedAt, null, msg.title); }, 'toolStart');
        break;
      case 'hlEntries':
        // The host's answer to one `hl` request (see `applyHighlights`): blocks that
        // match an entry are upgraded in place, so nothing is re-rendered for colour.
        applyHighlights(msg.entries);
        break;
      case 'imageUrlAnswer': {
        // The host's answer to one `imageUrl` request: a data URL, or the reason there is
        // none. The wait is per request, so a row that was folded again simply drops it.
        const done = imageRequests.get(msg.requestId);
        if (done) {
          imageRequests.delete(msg.requestId);
          done(msg);
        }
        return;
      }
      case 'toolEnd':
        routeTo(msg.nodeId, () => updateTool(msg.id, msg.content, msg.ms, msg.diff), 'toolEnd');
        break;
      case 'noAnswerText':
        // The round wrote nothing but its reasoning: the host's item now carries
        // `noAnswer`, and the text this card already streamed becomes the block that says
        // so — the banner, then the thinking itself in the flow (`liftNoAnswerRow`). The
        // repaint path builds the same block from the item (`paintFinishedItem`).
        routeTo(msg.nodeId, () => liftNoAnswerRow(), 'noAnswerText');
        break;
      case 'agentStart':
        onAgentStart(msg);
        break;
      case 'agentDone':
        onAgentDone(msg);
        break;
      case 'done':
        endRun(msg);
        // The answer just grew, and the text nobody has marked yet is the new part.
        findRefreshMarks();
        break;
      case 'interrupted':
        endRun(msg);
        setStatus(tr('Interrupted'));
        break;
      case 'error':
        endRun(msg, () => addAssistant(tr('⚠️ {0}', msg.message), true));
        setStatus(tr('Error'));
        break;
      case 'notice':
        // A notice may now be **node-scoped**: the silent-retry marker has to land in
        // the log of the card that is retrying, which need not be the view focus, so
        // a `nodeId` routes it exactly like the harness note above. Its `noticeId`
        // names the block: the host keeps sending the same id as the attempts advance,
        // and each message rewrites that element's text rather than appending another.
        if (msg.nodeId) {
          routeTo(msg.nodeId, () => upsertNotice(msg.kind, msg.text, msg.noticeId));
          break;
        }
        // A notice with no nodeId carries no explicit target: it belongs to the card
        // the view focuses, whose log is what `messagesEl` points at. It is appended
        // *into* that log, so the log is un-hidden first — the same rule `routeTo`
        // enforces for every routed append.
        {
          const id = treeActiveId;
          const c = id ? nodeEls[id] : null;
          if (c) showWorkLog(c);
          addNotice(msg.kind, msg.text);
        }
        break;
      // The stall probes ("the tab stopped painting", see that block at the top): the
      // host asks a quiet tab what it has counted (`probe`) and then asks it to prove
      // it can still take a frame (`nudge`). Both are diagnostics: they answer with a
      // `perfDiag` report and change nothing the user can see.
      case 'probe':
        perfOnProbe(msg);
        break;
      case 'nudge':
        perfOnNudge(msg);
        break;
      // The host saying whether this tab is on screen — the half of visibility the page
      // itself cannot see (see the sampler block at the top). Diagnostics only.
      case 'viewState':
        perfOnViewState(msg);
        break;
      case 'reset':
        // The cards (and the fading chunks inside them) are all going: settle first,
        // the same way a `tree` repaint does.
        flushChunks();
        clearLiveTools();
        resetItems();
        for (const id in nodeEls) {
          // A new session's cards are all going: the one card observer lets go of each
          // before it is detached (same rule as in `renderTree`), or the dead elements
          // would stay observed across sessions.
          cardUnobserve(nodeEls[id]);
          nodeEls[id].remove();
        }
        for (const id in nodeEls) delete nodeEls[id];
        pathNodes = Object.create(null);
        treeNodes = Object.create(null);
        treeRootIds = [];
        treeRootId = null;
        treeActiveId = null;
        activePathSet = new Set();
        runningNodes = new Set();
        lockedNodes = new Set();
        messagesEl = null;
        openSteps = null;
        // A new session has no checked-out node, so it has no frozen setup to drift
        // from either: the identities (and the fork hint) go with the tree.
        SETUP = null;
        renderSetupIdentity();
        renderTree({ nodes: [], rootId: null, activeId: null });
        break;
      default:
        break;
    }
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    const t0 = perfNow();
    try {
      handleMessage(msg);
    } finally {
      // `finally`, not `catch`: a handler that throws must still reach whoever is
      // watching for it (the extension host's console, `tools/check-webview.js`),
      // while the measurement itself never gets in the way.
      perfAfterMessage(msg, perfNow() - t0);
    }
  });

  // ---- Composer dock ----
  // The send pane is the active node's input dock: it is moved into the active
  // node's card, at its bottom, so it pans/zooms with the tree and is visibly
  // attached to the node it sends into. It is NEVER docked anywhere else — when
  // there is no host card (empty session uses the placeholder card, a focused
  // sub-agent branch is read-only) the pane is hidden / kept out of the DOM.
  // The pane keeps one fixed size: neither the host card's width nor the panel's
  // size scales its controls or fonts.
  // `undefined` until the first mount, so the first mountComposer always relocates.
  let composerHost;                     // the card the pane is currently mounted in

  // ---- Composer focus: the caret survives the platform, not just the webview ----
  // A webview document is **retained** while its tab is in the background, so `#input` is
  // still there when the window comes back — but VS Code's own `WebviewEditor.focus()` runs
  // on that reactivation (after a ~50 ms throttle) and focuses the webview's *frame*
  // element, not the element inside this document. The platform therefore resets the DOM
  // focus of the retained document: the caret blinks for a few milliseconds and is gone,
  // which is the stable repro (caret in the composer → another OS window → click the
  // composer again). VS Code closed "restore focus inside a retained webview" as out of
  // scope for extensions, so the rule is ours and lives here:
  //
  //   * `composerHadFocus` is the user's *intent*, tracked with `focusin` / `focusout` —
  //     never `document.activeElement` read at mount time, which is already gone by then
  //     (`renderTree` / `reset` remove the old card *before* `mountComposer` runs, which is
  //     why the old `composerEl.contains(activeElement)` restore never fired at all);
  //   * the caret is restored only for a sequence the **platform** started — a window
  //     return (`viewState.focused`), a window-level `focusout`, a dock move or a re-show —
  //     and only when `shouldRestoreComposerFocus` agrees: never when the click landed
  //     elsewhere, when the dock is hidden, or when the input is disabled / read-only;
  //   * the restore is a ladder, not one call: the next animation frame, then every ~60 ms
  //     for up to a second, because the platform's focus lands *after* ours;
  //   * every sequence posts one `perfDiag` line (`kind: 'composer-focus'`), so a caret
  //     that did not come back is evidence in the Spinney output channel and in the
  //     diagnostics log instead of an anecdote (`invariants/streaming-perf.md`).
  /** How often the restore ladder re-asserts the caret. */
  const COMPOSER_FOCUS_TICK_MS = 60;
  /**
   * How long a restore sequence keeps trying. The platform's frame focus is throttled to
   * ~50 ms, so the second or third tick is the one that sticks; the rest of the second is
   * the margin for a window that came back while the renderer was still catching up.
   */
  const COMPOSER_FOCUS_DEADLINE_MS = 1000;
  let composerHadFocus = false;         // the user's caret was in `#input`
  let composerSel = null;               // the last caret, `{ start, end }`, for a restore
  let composerBlurAt = 0;               // `perfNow()` of the last `focusout` (0 = never)
  let composerLadder = null;            // the restore sequence in flight, if any

  /**
   * The restore policy, in one place and deliberately DOM-free: the caret goes back only
   * when the **user** had it here (`hadFocus`), the dock is on screen and taking input
   * (`visible`), and the input is not `readOnly` / `disabled`. Anything else would be a
   * steal — a caret jumping out of the card the user just clicked.
   */
  function shouldRestoreComposerFocus(state) {
    if (!state || typeof state !== 'object') return false;
    return state.hadFocus === true && state.visible === true && state.readOnly !== true;
  }

  /** What the policy needs, read from the live DOM (`visible` = docked and not `.hidden`). */
  function composerFocusState() {
    let visible = false;
    try {
      visible = !!composerEl.parentElement && !composerEl.classList.contains('hidden');
    } catch (err) {
      visible = false;
    }
    return { hadFocus: composerHadFocus, visible, readOnly: !!(inputEl.disabled || inputEl.readOnly) };
  }

  /** An element as one log-safe word — its id, or the tag plus two classes. Never its text. */
  function describeFocusTarget(target) {
    if (!target) return 'none';
    if (target === document.body) return 'body';
    try {
      if (target.id) return String(target.id);
      const tag = String(target.tagName || 'node').toLowerCase();
      const classes = String(target.className || '').split(/\s+/).filter(Boolean).slice(0, 2);
      return classes.length > 0 ? tag + '.' + classes.join('.') : tag;
    } catch (err) {
      return 'node';
    }
  }

  /** Is the caret in the dock right now? */
  function composerHasFocus() {
    try {
      if (document.activeElement === inputEl) return true;
      return !!(composerEl.contains && composerEl.contains(document.activeElement));
    } catch (err) {
      return false;
    }
  }

  /** The caret, as the input reports it, or `null` where the element has no selection. */
  function composerSelection() {
    try {
      const start = inputEl.selectionStart;
      const end = inputEl.selectionEnd;
      if (typeof start !== 'number' || typeof end !== 'number') return null;
      return { start, end };
    } catch (err) {
      return null;
    }
  }

  /** One line of the focus trace (`webview-composer-focus` in the diagnostics log). */
  function postComposerFocusDiag(state, extra) {
    perfPost(
      'composer-focus',
      Object.assign(
        {
          state,
          hasFocus: typeof document.hasFocus === 'function' ? !!document.hasFocus() : true,
          active: describeFocusTarget(document.activeElement),
          relatedTarget: 'none',
          // `-1` is "the caret was never lost in this document": a real 0 would claim a
          // sequence that began in the same millisecond, which no timer here produces.
          msSinceBlur: composerBlurAt > 0 ? Math.round(perfNow() - composerBlurAt) : -1,
          retries: 0,
        },
        extra || {},
      ),
    );
  }

  /** Put the caret — and the selection it had — back; `true` when the input has the focus. */
  function focusComposerInput(sel) {
    try {
      inputEl.focus({ preventScroll: true });
    } catch (err) {
      try {
        inputEl.focus();
      } catch (err2) {
        /* a detached or disabled input cannot take the focus, and this must not throw */
      }
    }
    if (document.activeElement !== inputEl) return false;
    const range = sel || composerSel;
    if (range && typeof inputEl.setSelectionRange === 'function') {
      try {
        const length = typeof inputEl.value === 'string' ? inputEl.value.length : range.end;
        const start = Math.max(0, Math.min(range.start, length));
        const end = Math.max(start, Math.min(range.end, length));
        inputEl.setSelectionRange(start, end);
      } catch (err) {
        /* the caret position is a nicety; the focus is the point */
      }
    }
    return true;
  }

  /** Drop the sequence in flight, if any (its `clearTimeout` is all that holds it). */
  function stopComposerFocusRestore() {
    const ladder = composerLadder;
    composerLadder = null;
    if (ladder && ladder.timer != null) {
      try {
        clearTimeout(ladder.timer);
      } catch (err) {
        /* ignore */
      }
      ladder.timer = null;
    }
    return ladder;
  }

  /**
   * Re-assert the caret inside the document the platform just focused. Called from the
   * window return, from a window-level `focusout`, from a dock mount and from a re-show.
   *
   * `reason` only names the sequence in the trace (`window`, `blur`, `mount`, `show`).
   * Returns whether a sequence was started — a refusal is the policy working, not a bug.
   */
  function restoreComposerFocus(reason) {
    const state = composerFocusState();
    if (!shouldRestoreComposerFocus(state)) {
      // Nothing to restore: the user left, the dock is hidden, or the input is read-only.
      // Focusing here would steal the caret from what the user chose.
      if (state.hadFocus) postComposerFocusDiag('skip', { reason: reason || 'n/a' });
      return false;
    }
    stopComposerFocusRestore();
    const ladder = {
      reason: reason || 'n/a',
      retries: 0,
      deadline: perfNow() + COMPOSER_FOCUS_DEADLINE_MS,
      timer: null,
    };
    composerLadder = ladder;
    postComposerFocusDiag('restore', { reason: ladder.reason });
    const attempt = () => {
      if (composerLadder !== ladder) return;
      if (ladder.timer != null) {
        // Whichever woke this attempt (the frame or the tick), the other one is now wrong.
        try {
          clearTimeout(ladder.timer);
        } catch (err) {
          /* ignore */
        }
        ladder.timer = null;
      }
      const live = composerFocusState();
      if (!shouldRestoreComposerFocus(live)) {
        // The dock went away (hidden / read-only) mid-sequence: the sequence is over.
        composerLadder = null;
        postComposerFocusDiag('skip', {
          reason: ladder.reason + (live.visible ? '/readonly' : '/hidden'),
          retries: ladder.retries,
        });
        return;
      }
      if (!composerHasFocus()) {
        ladder.retries++;
        focusComposerInput();
      }
      if (perfNow() >= ladder.deadline) {
        composerLadder = null;
        postComposerFocusDiag(composerHasFocus() ? 'restored' : 'lost', {
          reason: ladder.reason,
          retries: ladder.retries,
        });
        return;
      }
      ladder.timer = setTimeout(attempt, COMPOSER_FOCUS_TICK_MS);
    };
    // The next frame first — that is where the caret goes back the instant the window
    // returns — then the ticks, which are what catch the platform's own focus a throttle
    // later. The tick is armed next to the frame because a renderer that is still catching
    // up may not deliver a frame at all, and this ladder must not die on that: whichever
    // arrives first clears the other. A `focusin` anywhere else (see `onComposerFocusIn`)
    // ends it early.
    try {
      requestAnimationFrame(attempt);
    } catch (err) {
      /* the tick below is the fallback */
    }
    ladder.timer = setTimeout(attempt, COMPOSER_FOCUS_TICK_MS);
    return true;
  }

  /**
   * The caret entered `target`. Only `#input` counts as "the user is in the composer": a
   * press on one of the dock's own controls (the model dropdown) is a different intent, and
   * so is a press anywhere outside it.
   */
  function onComposerFocusIn(event) {
    const target = event ? event.target : null;
    if (target === inputEl) {
      composerHadFocus = true;
      composerSel = composerSelection();
      return;
    }
    composerHadFocus = false;
    if (composerLadder) {
      stopComposerFocusRestore();
      postComposerFocusDiag('skip', { reason: 'focus-elsewhere' });
    }
  }

  /**
   * The caret left `#input`. Two different events wear the same name:
   *
   *   * `document.hasFocus()` is true — the user clicked inside this document, so the caret
   *     stays where it landed and the intent is over;
   *   * it is false — the **window** went away, or the platform's frame focus reset this
   *     document. The user did nothing, so the intent stands and the ladder is armed: if
   *     the document gets its focus back within a second, the caret goes back.
   */
  function onComposerFocusOut(event) {
    const target = event ? event.target : null;
    if (target !== inputEl) return;
    composerSel = composerSelection();
    composerBlurAt = perfNow();
    const hasFocus = typeof document.hasFocus === 'function' ? !!document.hasFocus() : true;
    if (hasFocus) {
      // The user clicked inside this document: the caret stays where it landed. Nothing
      // happened that needs a line — a dock a user clicks in and out of all day would
      // otherwise be the noisiest thing in the log.
      composerHadFocus = false;
      return;
    }
    postComposerFocusDiag('blur', { relatedTarget: describeFocusTarget(event && event.relatedTarget) });
    restoreComposerFocus('blur');
  }

  /**
   * Inline the pane at the bottom of `card`, or take it out of the DOM entirely
   * when there is no host card (there is no floating/docked fallback).
   */
  function mountComposer(card) {
    // The composer must never land inside a card the engine is skipping (a subtree with
    // `content-visibility: auto` is not measured or rendered), so the host card is woken
    // before the pane is moved into it.
    cvWake(card);
    if (composerHost === card) {
      autoGrow();
      return;
    }
    // Moving a focused subtree drops the DOM focus, so the user's intent is read **before**
    // the move — and from the flag, not from `document.activeElement`: `renderTree` /
    // `reset` removed the old card before this is called, so `activeElement` is already
    // gone and the `contains(activeElement)` check this line replaced could never be true.
    const hadFocus = composerHadFocus;
    const sel = hadFocus ? composerSelection() : null;
    composerHost = card;
    if (card) {
      card.appendChild(composerEl);   // last child = the card's bottom
    } else {
      composerEl.remove();
      // The box is out of the document, so there is no caret to anchor a popup to.
      mentionClose();
    }
    autoGrow();
    // The pane may have moved into another card, and another place on screen: the `@`
    // popup is anchored to the caret, so it is measured again rather than left behind.
    mentionPosition();
    if (hadFocus && card) {
      // The caret goes back where it was, selection included (see `restoreComposerFocus`).
      if (sel) composerSel = sel;
      restoreComposerFocus('mount');
    }
  }

  /**
   * Hide/show the whole send pane. A sub-agent branch is read-only, so it must
   * not offer an input at all — the pane is removed from view (not merely
   * disabled) while such a node is checked out.
   *
   * Hiding the dock is **not** leaving it, so there is no `blur()` here: the intent lives
   * in `composerHadFocus`, and the platform blur that followed a hidden dock is one way the
   * caret used to be lost for good. Showing the dock again is what restores it — and only
   * when the flag says the user was in it.
   */
  function setComposerVisible(visible) {
    composerEl.classList.toggle('hidden', !visible);
    if (visible && composerHadFocus) restoreComposerFocus('show');
  }

  // ---- Input handlers ----
  sendBtn.addEventListener('click', send);
  newContextBtn.addEventListener('click', () => newContextTurn('fork'));
  compressBtn.addEventListener('click', () => newContextTurn('compression'));
  stopBtn.addEventListener('click', () => {
    setStatus(tr('Stopping…'));
    // Stop only the view focus node's run (spec §3.2): other nodes stay running.
    // A null focus (no node) means "stop everything in this session".
    vscode.postMessage({ type: 'stop', nodeId: treeActiveId });
  });
  attachBtn.addEventListener('click', () => {
    // One button, one dialog: the host routes the chosen file by extension — an image
    // becomes an attachment (`imagePicked`), anything else a reference (`mentionPicked`).
    vscode.postMessage({ type: 'pickAttachment' });
  });
  modelSelect.addEventListener('change', () => {
    if (busy) {
      renderModelSelect(currentModel);
      return;
    }
    // Switching the card also switches its thinking levels: the host answers with
    // a fresh `config`, which re-renders both dropdowns from that card.
    vscode.postMessage({ type: 'setModel', model: modelSelect.value });
  });
  modelsBtn.addEventListener('click', () => {
    // The page itself is a host-owned tab (one per window), so the webview only
    // asks for it — the host creates or focuses it.
    vscode.postMessage({ type: 'openModelTree' });
  });
  snippetsBtn.addEventListener('click', () => {
    // Toggle: a second click on the button closes the menu it opened (a press
    // anywhere else closes it through the capture-phase listener above).
    if (snippetMenuEl) closeSnippetMenu();
    else openSnippetMenu();
  });
  effortSelect.addEventListener('change', () => {
    if (busy) {
      renderEffortSelect(currentEffort);
      return;
    }
    vscode.postMessage({ type: 'setThinkingEffort', effort: effortSelect.value });
  });
  inputEl.addEventListener('paste', handlePaste);

  inputEl.addEventListener('keydown', (event) => {
    // The open `@` menu owns its keys; while it is closed this returns false and the
    // composer's own Enter-to-send below is exactly what it always was. Before the Enter
    // branch, so Enter/Tab accept a row instead of sending the half-typed query.
    if (mentionHandleKey(event)) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      // Enter is the Send button's other face: a disabled Send means Enter does
      // nothing too, instead of sending something the button refuses to.
      if (!sendBtn.disabled) send();
    }
    // A caret move fires no `input`: the token under the caret after the key's own
    // default action may be another one, or none at all.
    if (MENTION_CARET_KEYS.has(event.key)) setTimeout(mentionSync, 0);
  });

  inputEl.addEventListener('input', () => {
    // Typing changes "has content", which both composer buttons read — the same
    // refresh a programmatic write (a snippet, `composerClear`) makes for itself.
    const t0 = perfNow();
    if (!perfTyping) perfTyping = perfGestureOpen('typing');
    afterComposerWrite();
    perfGestureEvent(perfTyping, perfNow() - t0);
    if (perfTypingTimer != null) clearTimeout(perfTypingTimer);
    perfTypingTimer = setTimeout(perfTypingEnd, TYPING_IDLE_MS);
    // Deliberately *after* the typing probe: the `@` picker is a feature of its own (one
    // scan of the value, then a debounced post), and charging it to "typing is laggy"
    // would blame the wrong thing.
    mentionSync();
  });

  // ---- `@` reference triggers ----
  // Every way a caret can reach or leave a token: the typed character (`input` above), a
  // navigation key (the keydown tail above), a click, and the IME's commit. The trailing
  // debounce means a burst of them costs one query.
  inputEl.addEventListener('click', () => mentionSync());
  inputEl.addEventListener('select', () => mentionSync());
  inputEl.addEventListener('compositionstart', () => {
    // An IME owns the box now: no menu is opened or moved until it commits (§3).
    mentionComposing = true;
    mentionClose();
  });
  inputEl.addEventListener('compositionend', () => {
    mentionComposing = false;
    mentionSync();
  });
  // Past `INPUT_MAX_H` the box scrolls inside itself, so the caret moves with no `input`
  // and no `keydown` at all: the popup follows it here or it drifts (§5).
  inputEl.addEventListener('scroll', () => mentionPosition());
  window.addEventListener('resize', () => mentionPosition());

  // The caret's own intent, tracked where it happens (see the composer focus block):
  // `#composer` as a whole so a press on one of the dock's controls clears it too, and
  // `#input` because that is the element the platform's frame focus resets.
  inputEl.addEventListener('focusin', onComposerFocusIn);
  inputEl.addEventListener('focusout', onComposerFocusOut);
  composerEl.addEventListener('focusin', onComposerFocusIn);
  composerEl.addEventListener('focusout', onComposerFocusOut);

  // A press anywhere outside the dock while a restore is in flight is the user choosing a
  // new caret: the sequence ends at the press, not at a `focusin` a card head (which is not
  // focusable at all) would never produce. Capture phase, so no handler of its own can
  // swallow the press first, and it only ever runs while a sequence is armed.
  document.addEventListener(
    'mousedown',
    (event) => {
      if (!composerLadder) return;
      const target = event ? event.target : null;
      if (target && (target === composerEl || (composerEl.contains && composerEl.contains(target)))) return;
      stopComposerFocusRestore();
      postComposerFocusDiag('skip', { reason: 'pointer-elsewhere' });
    },
    true,
  );

  /**
   * Split a `spinney:` file link into the path and the line range it names.
   *
   * The shape is `spinney:<path>#L12` or `spinney:<path>#L12-L30`, with no fragment at
   * all for a file whose lines were not named. The path is kept exactly as written
   * (only percent-decoded, because Markdown encodes a space in a link target) and is
   * resolved against the harness root by the host — the webview has no root to resolve
   * against. A malformed fragment (`#Lx`) names no line rather than a wrong one.
   */
  function parseFileLink(href) {
    const rest = href.slice('spinney:'.length);
    const hash = rest.indexOf('#');
    const raw = hash >= 0 ? rest.slice(0, hash) : rest;
    let filePath = raw;
    try {
      filePath = decodeURIComponent(raw);
    } catch (err) {
      /* not percent-encoded: keep the path as written */
    }
    if (!filePath) return null;
    const ref = { path: filePath, line: undefined, endLine: undefined };
    const match = hash >= 0 ? rest.slice(hash + 1).match(/^L(\d+)(?:-L(\d+))?$/) : null;
    if (match) {
      ref.line = Number(match[1]) || undefined;
      const end = Number(match[2]) || 0;
      if (end > (ref.line || 0)) ref.endLine = end;
    }
    return ref;
  }

  document.addEventListener('click', (event) => {
    const target = event.target;
    const anchor = target && target.closest ? target.closest('a[href]') : null;
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute('href') || '';
    // A `[src/a.ts:12-30](spinney:src/a.ts#L12-L30)` link is the chat's own file
    // reference: the host opens the file in an editor tab on those lines instead of
    // handing it to the system browser.
    if (href.indexOf('spinney:') === 0) {
      const ref = parseFileLink(href);
      if (ref) {
        vscode.postMessage({ type: 'openFile', path: ref.path, line: ref.line, endLine: ref.endLine });
      }
      return;
    }
    let url;
    try {
      url = new URL(href, window.location.href);
    } catch {
      return;
    }
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') {
      vscode.postMessage({ type: 'openExternal', url: url.href });
    }
  });

  // Initial handshake.
  vscode.postMessage({ type: 'ready' });
  renderTree({ nodes: [], rootId: null, activeId: null });
  wireTerminalDock();
  setStatus(tr('Ready'));
  updateImageVisibility();
  updateFollowButton();
  // No `config` yet means no snippet list: the button stays out of the way until
  // one arrives (it always does, and it always carries at least the shipped rows).
  updateSnippetsButton();
  // The document's own record starts with the shell in place: its first line is the
  // baseline a degraded document is compared against after a reload.
  perfStartDocumentRecord();
})();
