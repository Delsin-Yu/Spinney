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
  // The composer's ONE new-epoch entry (`Continue with new context`): the button that
  // replaces the per-card `⧉`, the drift `⧉` hint and the ask-on-send modal. Its label,
  // visibility and disabled state are owned by `updateComposerButtons` below.
  const newContextBtn = document.getElementById('new-context-btn');
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
  // The colour a sidecar's connector runs in: id -> { h, s, l, level, idx } (see
  // `applySubColor`). Kept beside the layout so `drawEdges` can tint an edge like its card.
  const subColors = Object.create(null);
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
  }

  function perfStopSampler() {
    if (frameTimer == null) return;
    clearInterval(frameTimer);
    frameTimer = null;
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

  // ---- Markdown ----
  const md = window.markdownit
    ? window.markdownit({ html: false, breaks: true, linkify: true, typographer: false })
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

  // ---- Manual scroll lock (the green light) ----
  // The light is the only follow control. While it is on the container is pinned
  // to its newest content and its scrollbar is disabled (`scroll-locked` hides
  // the bar and blocks manual scrolling); clicking the light turns follow off and
  // hands scrolling back to the user. There is deliberately no auto re-engage on
  // scroll — the state changes only when the light is clicked.
  // `locked` is the initial state: a live turn starts pinned, a finished node
  // starts free so its transcript can be scrolled immediately.
  function createScrollController(container, onChange, locked) {
    const state = { locked: locked !== false };

    function setLocked(value) {
      if (state.locked === value) return;
      state.locked = value;
      container.classList.toggle('scroll-locked', value);
      if (onChange) onChange(value);
      if (value) scrollToBottom();
    }

    function scrollToBottom() {
      if (!state.locked) return;
      const max = Math.max(0, container.scrollHeight - container.clientHeight);
      if (container.scrollTop !== max) {
        container.scrollTop = max;
      }
    }

    container.classList.toggle('scroll-locked', state.locked);

    return {
      get locked() { return state.locked; },
      scrollToBottom,
      lock() { setLocked(true); },
      unlock() { setLocked(false); },
      toggle() { setLocked(!state.locked); },
    };
  }

  const LOCK_TITLE_ON = tr('Auto-scroll on — click to release');
  const LOCK_TITLE_OFF = tr('Auto-scroll off — click to follow again');

  // A green lock dot lives on the host of a scrollable container, in the strip
  // reserved below it (the container keeps a bottom margin so the dot sits just
  // under the scrollbar). Live turns start locked (following); finished nodes
  // start unlocked. Click to toggle manual follow.
  //
  // There is exactly one scroller in a card, so there is exactly one light: the rows
  // inside the log carry none of their own. Releasing it is the reader's move (the log
  // then keeps their offset instead of pinning itself), and re-engaging it is a
  // scrolling gesture and nothing more.
  function attachLock(container, host, locked) {
    const dot = el('div', 'scroll-lock-dot' + (locked === false ? '' : ' locked'));
    const ctrl = createScrollController(container, (isLocked) => {
      dot.classList.toggle('locked', isLocked);
      dot.title = isLocked ? LOCK_TITLE_ON : LOCK_TITLE_OFF;
    }, locked);
    dot.title = ctrl.locked ? LOCK_TITLE_ON : LOCK_TITLE_OFF;
    dot.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // The one gesture that hands the bottom to the reader: `scrollToBottom` stops
      // writing (it is a no-op while the light is off) and the log's own memory is what
      // puts them back after a repaint.
      ctrl.toggle();
    });
    host.appendChild(dot);
    return ctrl;
  }

  /**
   * Lock / unlock a card's one scroller (`.node-work`). The card has exactly one, so
   * there is nothing else to walk: the thinking rows and the tool rows scroll *with*
   * it, never inside themselves.
   */
  function setCardScrollLock(card, locked) {
    if (!card) return;
    if (card._itemScroll) (locked ? card._itemScroll.lock() : card._itemScroll.unlock());
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

  /** Put a remembered offset back. The engine clamps it to the box it now has. */
  function restoreScroll(container, top) {
    if (!container || top == null) return;
    if (container.scrollTop !== top) container.scrollTop = top;
  }

  // ---- The two rows of the log: a thinking line and a tool line ----------------
  // A turn reads as one essay, so the log holds *rows*, not nested blocks:
  //
  //  - a **thinking row** (`.msg.thinking-row`, `data-kind="thinking"`): while its
  //    turn is live it is open — a dimmed italic paragraph. When the turn ends it
  //    collapses to a single ellipsised line with no label (the text itself is the
  //    label), and a click toggles it: the open form is the whole text plus the
  //    turn's usage line. There is no header and no chevron, so the row is the
  //    control.
  //  - a **tool row** (`.msg.tool`, one line): a status dot, the bold localized
  //    verb, the label (`DisplayItem.title`, else `toolBrief()`) and the elapsed
  //    chip. It is folded at rest whatever it is doing (the row already says what
  //    the step is), and a click expands it in place: the `> command` line, the
  //    result, an error, the usage line. A second click folds it again.
  //
  // Two marks per row carry the state, and both live on the element (the DOM is
  // rebuilt by a repaint, which re-derives the same state from the items):
  //   `_open`        — the row is open right now;
  //   `_userTouched` — a click handed the row to the user: the live rule below
  //                    leaves it exactly where they put it.
  // The live rows are tracked on the container (`messagesEl`), which `routeTo`
  // swaps per node, so two nodes streaming at once never see each other's rows.

  /** Is this row open? One reading, for every caller and for the guard. */
  function isRowOpen(row) {
    return !!(row && row._open);
  }

  /**
   * Open or close a thinking row. `open` is the paragraph plus the usage line; the
   * closed form is one line of the same text, ellipsised in CSS.
   */
  function setThinkingOpen(row, open) {
    if (!row) return;
    row._open = !!open;
    row.classList.toggle('open', row._open);
    const usage = row.querySelector('.usage-line');
    if (usage) usage.classList.toggle('hidden', !row._open);
    // Opening puts the reader back at the end of the reasoning.
    if (row._open && row._textEl) {
      row._textEl._userScrolled = false;
      row._textEl.scrollTop = row._textEl.scrollHeight;
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
    if (detail) detail.classList.toggle('hidden', !row._open);
  }

  /** A click on either row hands it to the user: the live rule below stops here. */
  function markRowTouched(row) {
    if (row) row._userTouched = true;
  }

  /**
   * This row is live: a thinking row opens (that is what the active turn is doing),
   * a tool row is left folded. A row the user clicked is theirs and never moves.
   */
  function setActiveRow(row) {
    if (!row) return;
    row._active = true;
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
    const list = messagesEl ? messagesEl._activeRows : null;
    if (list) {
      const at = list.indexOf(row);
      if (at >= 0) list.splice(at, 1);
    }
    if (row._userTouched) return;
    // A finished thinking row is one line; a tool row folds back to its one line.
    if (row.classList.contains('thinking-row')) setThinkingOpen(row, false);
    else setToolOpen(row, false);
  }

  /**
   * The card whose log `messagesEl` currently is.
   */
  function logCard() {
    let node = messagesEl;
    while (node) {
      if (node.classList && node.classList.contains('node')) return node;
      node = node.parentElement || null;
    }
    return null;
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

  /** The card's steps group, when it has one. */
  function stepsGroup(card) {
    const owner = card || logCard();
    return (owner && owner._steps) || null;
  }

  /** Where the next process row belongs: the steps group's body, or the log itself. */
  function logTail() {
    const group = stepsGroup();
    return group ? group._body : messagesEl;
  }

  /**
   * The header's count: one step is a call, and the header says so in one line.
   */
  function updateStepsHead(group) {
    if (!group) return;
    let n = 0;
    for (const child of group._body.children || []) {
      if (child.dataset && child.dataset.kind === 'tool') n++;
    }
    if (group._lazy) n = group._count || 0;
    const label = group._head && group._head.querySelector('.steps-label');
    if (label) label.textContent = n === 1 ? tr('Ran 1 step') : tr('Ran {0} steps', n);
  }

  /**
   * Paint the body of a folded group the first time it is opened. A finished card's
   * steps are not read while they are tucked away, so a cold card builds the run-up,
   * the header and the answer; the rows are built here, once, on the click that asks
   * for them.
   */
  function paintStepsBody(group) {
    if (!group || !group._lazy) return;
    const items = group._lazy;
    group._lazy = null;
    const prevMsg = messagesEl;
    messagesEl = group._body;
    try {
      for (const item of items) renderItemInto(item);
    } finally {
      messagesEl = prevMsg;
    }
    updateStepsHead(group);
  }

  /** The last assistant message in a log's subtree (the turn's final answer). */
  function lastAssistantRow(log) {
    let found = null;
    const visit = (parent) => {
      for (const child of (parent && parent.children) || []) {
        if (child.dataset && child.dataset.kind === 'assistant') found = child;
        visit(child);
      }
    };
    visit(log);
    return found;
  }

  /** Move the card's last assistant message out of the group, below its header. */
  function moveAnswerOut(card, group) {
    const owner = card || logCard();
    const g = group || stepsGroup(owner);
    if (!g || !owner) return;
    const log = owner.querySelector('.node-work');
    const last = lastAssistantRow(log);
    if (last && inSubtree(g._body, last) && g.parentElement) {
      g.parentElement.appendChild(last);
    }
  }

  /** Fold the steps group to its header, or open it. */
  function setStepsFold(group, folded) {
    if (!group) return;
    group._folded = !!folded;
    group.classList.toggle('steps-folded', group._folded);
    const chev = group._head && group._head.querySelector('.chev');
    if (chev) chev.classList.toggle('open', !group._folded);
  }

  /**
   * The turn's process, under one foldable header. Every row that is not the final
   * answer belongs inside the body: the reasoning, the tool steps, the prose between
   * them and the harness notes. The group is born at the **first tool row** — a turn
   * with no tools has no steps to tuck, so its reasoning and text stay in the flow —
   * and it is open while the turn runs.
   */
  function ensureStepsGroup() {
    const card = logCard();
    if (!card || !messagesEl) return null;
    const existing = stepsGroup(card);
    if (existing) return existing;
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
    card._steps = group;
    updateStepsHead(group);
    setStepsFold(group, false);
    return group;
  }

  /**
   * The turn is over: the **final answer** leaves the group (it is the last assistant
   * message of the card), and the steps tuck themselves behind the header — unless the
   * user opened or closed the group by hand, which always wins.
   */
  function settleSteps(card) {
    const owner = card || logCard();
    const group = stepsGroup(owner);
    if (!group) return;
    moveAnswerOut(owner, group);
    if (!group._userTouched) setStepsFold(group, true);
  }

  /**
   * The turn is over: every row of the card takes its resting state — a thinking row
   * collapses to its one line, a tool row folds — except the ones the user opened by
   * hand (`_userTouched`), which stay exactly where they were put. Read off the card's
   * own DOM rather than a list, so a card restored from a repaint settles like a live
   * one.
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
   * the turn is over. A row of the other kind stays live.
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

  // ---- Message rendering into a container (defaults to the active node) ----
  // Zone 1 of a card: the pinned user ask (`.node-ask`, top of an expanded card).
  // It does not scroll with the work log and does not trigger tree panning, and it
  // is Markdown now — a fenced snippet or a list in the ask reads like it does in
  // the answer.
  function addUserPrompt(text, attachments) {
    if (!promptEl) return;
    promptEl.innerHTML = '';
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
    return node;
  }

  function addNotice(kind, text) {
    if (!messagesEl) return;
    const node = el('div', 'notice ' + (kind || 'info'), text);
    node.dataset.kind = 'notice';
    logTail().appendChild(node);
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

  /**
   * A message the *harness* wrote inside this node's own transcript — currently the
   * ▶ Continue turn, which resumes the node in place instead of growing a new card
   * (`SessionRuntime.continueFrom`). It is an inline block, not a user bubble (the
   * user did not type it) and not the pinned prompt (that still holds what the user
   * asked for); it shows the exact text the model received.
   */
  function addHarnessNote(text) {
    if (!messagesEl) return;
    const node = el('div', 'msg harness-note');
    node.dataset.kind = 'harness';
    node.appendChild(el('span', 'harness-badge', tr('HARNESS')));
    node.appendChild(el('span', 'harness-text', text));
    logTail().appendChild(node);
    followActive();
    return node;
  }

  /**
   * One thinking row: the turn's reasoning, as a single element in the flow.
   *
   * `thinking` is the text the item already holds (a repaint) or `''` (the live
   * path, which appends into `_textEl` as the deltas arrive). There is no header and
   * no chevron on purpose — a row with a "Thinking" label above a one-line
   * ellipsised paragraph spends two lines saying one thing. The whole row is the
   * control.
   */
  function makeThinkingRow(thinking) {
    const row = el('div', 'msg thinking-row');
    row.dataset.kind = 'thinking';
    const text = el('div', 'thinking-text');
    if (thinking) text.textContent = thinking;
    row.appendChild(text);
    // The usage line is the row's own tail, shown only in the open form (the closed
    // form is one line of text, and a usage line under it would be a second line).
    const usage = el('div', 'usage-line hidden');
    row.appendChild(usage);
    row._textEl = text;
    row._usageEl = usage;
    row._open = false;
    // While the row is open, the deltas keep the box at its newest line — unless the
    // reader scrolled up inside it, which is a claim the stream does not take back.
    text.addEventListener('scroll', () => {
      text._userScrolled = !(text.scrollTop + text.clientHeight >= text.scrollHeight - 8);
    });
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
    return addThinkingRow('');
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
    const row = thinking ? addThinkingRow(thinking) : null;
    if (!String(text || '').length && !error && row) {
      followActive();
      return row;
    }
    const node = el('div', 'msg assistant' + (error ? ' error' : ''));
    node.dataset.kind = 'assistant';
    const answer = el('div', 'answer');
    node.appendChild(answer);
    node._text = text || '';
    node._answerEl = answer;
    node._streaming = false;
    // The usage line of this item lives in the row's open form (`usageHostOf`), so the
    // bubble keeps the row it belongs to.
    node._thinkingRow = row;
    renderAnswer(node, true);
    logTail().appendChild(node);
    followActive();
    return node;
  }

  function appendAssistant(text) {
    if (!messagesEl) return;
    // The answer's text takes the message over, so its thinking row is no longer the
    // live one: it collapses to its one line (see `closeActiveRows`).
    closeActiveRows('thinking');
    const last = logTail().lastElementChild;
    if (last && last.dataset.kind === 'assistant' && !last.classList.contains('error')) {
      last._text = (last._text || '') + (text || '');
      renderAnswer(last, false);
      followActive();
      return last;
    }
    // A row with no bubble under it yet: the bubble that follows belongs to it, and
    // takes its usage line back with it (`_thinkingRow`).
    const prev = last;
    const node = addAssistant('', false);
    if (node && prev && prev.dataset && prev.dataset.kind === 'thinking') node._thinkingRow = prev;
    node._text = text || '';
    renderAnswer(node, false);
    return node;
  }

  function ensureStreamText(answer) {
    if (answer._streamText) return answer._streamText;
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
      answer._streamText = null;
      answer.textContent = node._text || '';
      return;
    }
    if (finalize) {
      node._streaming = false;
      answer._streamText = null;
      answer.innerHTML = renderMarkdown(node._text || '');
      return;
    }
    if (!node._streaming) {
      node._streaming = true;
      ensureStreamText(answer).nodeValue = node._text || '';
      return;
    }
    const tn = ensureStreamText(answer);
    const full = node._text || '';
    const have = tn.nodeValue.length;
    if (have < full.length) tn.appendData(full.slice(have));
  }

  function finalizeStreamingAnswer() {
    if (!messagesEl) return;
    // The message is complete: nothing in it is streaming any more, so its thinking
    // row collapses back to its one line.
    closeActiveRows('thinking');
    const last = logTail().lastElementChild;
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

  function appendThinking(text) {
    if (!messagesEl) return;
    const row = ensureThinkingRow();
    textNodeOf(row._textEl).appendData(text);
    // The row receiving the deltas is the live one: expanded, and it collapses on its
    // own the moment something else takes over (see `clearActiveRow`).
    setActiveRow(row);
    // The open form has a height cap, so the newest reasoning is kept in view the same
    // way the log is: follow the end unless the reader scrolled the box by hand.
    if (row._open && !row._textEl._userScrolled) row._textEl.scrollTop = row._textEl.scrollHeight;
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
   * The one usage line of a step: `[Prompt: … + Completion: …, Cache Hit: …,
   * Cache Miss: …]`. It is a bracket, because it is a footnote on the line above it
   * (a thinking row's open form, a tool row's detail, an answer's last line), not a
   * readout of its own. Every number comes from the provider verbatim; the two cache
   * fields read `0` when a provider reports none.
   */
  function formatUsage(usage) {
    const hit = orElse(usage.prompt_cache_hit_tokens, 0);
    const miss = orElse(usage.prompt_cache_miss_tokens, 0);
    return tr(
      '[Prompt: {0} + Completion: {1}, Cache Hit: {2}, Cache Miss: {3}]',
      usage.prompt_tokens,
      usage.completion_tokens,
      hit,
      miss,
    );
  }

  /**
   * Where a step's usage line lives: the message that concluded the turn. The host
   * attaches usage to the last tool or assistant item, so this finds that item's
   * element and writes the line *inside* its own fold — a thinking row's open form
   * or a tool row's detail — rather than appending a line to the flow (which was a
   * third kind of block in a card that is meant to be one essay). A message with
   * neither (plain text, no reasoning) keeps the line under its answer.
   */
  function usageHostOf(message) {
    if (!message) return null;
    // A reasoning row owns its own usage line (part of its open form).
    if (message._usageEl) return message._usageEl;
    if (message._thinkingRow) return message._thinkingRow._usageEl;
    if (message.classList && message.classList.contains('tool')) {
      const detail = byClass(message, 'tool-detail');
      if (detail) return byClass(detail, 'usage-line') || detail.appendChild(el('div', 'usage-line'));
    }
    return byClass(message, 'usage-line');
  }

  /**
   * Write one step's usage line where that step keeps it. A reasoning row's line is
   * part of its *open* form, so only the row decides whether it shows; every other host
   * shows it whenever its own fold is open (a tool row's detail, an answer's tail).
   */
  function paintUsage(message, usage) {
    if (!message) return null;
    let host = usageHostOf(message);
    if (!host) {
      host = el('div', 'usage-line');
      message.appendChild(host);
    }
    host.textContent = formatUsage(usage);
    const row = message._usageEl ? message : message._thinkingRow;
    if (row) setThinkingOpen(row, isRowOpen(row));
    else host.classList.remove('hidden');
    return host;
  }

  /**
   * The live `usage` message: the host attaches the turn's usage to the item that
   * concluded it (the last assistant or tool item), so this finds that item's element
   * and writes the line inside its own fold — a reasoning row's open form or a tool
   * row's detail — rather than appending a line to the flow (which was a third kind of
   * block in a card that is meant to be one essay). A turn whose only item is its
   * reasoning writes into that row.
   */
  function appendUsage(usage) {
    if (!messagesEl) return;
    let target = logTail().lastElementChild;
    let row = null;
    while (target) {
      const kind = target.dataset.kind;
      if (kind === 'thinking') {
        row = target;
        target = target.previousElementSibling;
        continue;
      }
      if (kind === 'tool' || (kind === 'assistant' && !target.classList.contains('error'))) break;
      target = target.previousElementSibling;
    }
    if (!target) {
      if (row) {
        paintUsage(row, usage);
        followActive();
        return;
      }
      target = addAssistant('', false);
    }
    paintUsage(target, usage);
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
  // the tool's *kind* of action in the reader's language (`tr()`-localized, one word
  // per tool); the label is the model's own `title` for the step when it gave one,
  // else the argument that identifies the step (the path, the command, the pattern).
  // The label is monospace for a command or a pattern and plain for everything else,
  // because a shell line and a path read best in the two different shapes.
  // Each entry asks `tr()` for its verb, at load, so the shipped catalogues carry all of
  // them (a table of plain strings would be invisible to `npm run check:l10n`).
  const TOOL_VERBS = {
    read_file: tr('Read'),
    read_image: tr('Viewed'),
    write_file: tr('Wrote'),
    replace_in_file: tr('Edited'),
    append_file: tr('Appended'),
    list_dir: tr('Listed'),
    list_nodes: tr('Listed'),
    search_files: tr('Searched'),
    web_search: tr('Searched'),
    search_transcripts: tr('Recalled'),
    exec_command: tr('Ran'),
    check_command: tr('Checked'),
    wait_for_command: tr('Waited'),
    kill_command: tr('Killed'),
    web_fetch: tr('Fetched'),
    spawn_agents: tr('Spawned'),
    spawn_readonly_agents: tr('Spawned'),
    send_agent_message: tr('Spawned'),
    send_readonly_agent_message: tr('Spawned'),
    hop_session: tr('Hopped'),
    finish_hop: tr('Finished'),
    rename_session: tr('Renamed'),
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
   * the command for `exec_command`, the pattern/query for a search, else whatever of
   * `path` / `command` / `cwd` / `url` / `query` the call carries. Unparsable
   * arguments still yield the path or command a regex can find, because a card is
   * more useful with a label than with none.
   */
  function toolBrief(name, args) {
    if (!args || args === '{}') return '';
    let value = '';
    try {
      const obj = JSON.parse(args);
      if (obj && typeof obj === 'object') {
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
    } catch {
      const m = String(args).match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"|"command"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      value = m ? (m[1] || m[2] || '') : '';
    }
    value = String(value).replace(/\s+/g, ' ').trim();
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
   * The row's one line: the status dot, the bold verb, the label and the elapsed
   * chip. It is built once per row and rewritten in place (a live call's label grows
   * with its arguments), which is why it is its own small builder.
   */
  function toolRowHead(name, label, mono) {
    const head = el('div', 'tool-row');
    // The dot is the status, in the smallest form that can say it: filled and pulsing
    // while the call runs, a plain filled dot once it is done. It is not a control.
    head.appendChild(el('span', 'tool-dot'));
    head.appendChild(el('b', 'tool-verb', toolVerb(name)));
    if (label) head.appendChild(el('span', 'tool-label' + (mono ? ' mono' : ''), label));
    return head;
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
    const mono = MONO_LABEL_TOOLS.has(name);
    const head = toolRowHead(name, toolLabel(name, args, opts.title), mono);
    // The call's own duration: `start` for a call that is running, `ms` for one that is
    // already over (a repaint of history). Neither is passed while a call is still
    // streaming its arguments — nothing has started yet, so the row deliberately shows
    // no chip.
    syncElapsed(head, 'tool-elapsed', opts.start, opts.ms);
    node.appendChild(head);
    const detail = el('div', 'tool-detail hidden');
    if (args && args !== '{}') {
      detail.appendChild(el('div', 'tool-args-line', '> ' + describeArgs(args).replace(/\n+/g, ' ')));
    }
    if (opts.content) detail.appendChild(el('pre', 'tool-result', opts.content));
    if (opts.error) detail.appendChild(el('div', 'tool-error', opts.error));
    if (opts.usage) detail.appendChild(el('div', 'usage-line', formatUsage(opts.usage)));
    node.appendChild(detail);
    head.addEventListener('click', () => {
      markRowTouched(node);
      setToolOpen(node, !isRowOpen(node));
    });
    node._rowEl = head;
    node._detailEl = detail;
    node._label = toolLabel(name, args, opts.title);
    node._title = opts.title;
    ensureStepsGroup();
    logTail().appendChild(node);
    updateStepsHead(stepsGroup());
    followActive();
    return node;
  }

  // Live (still-streaming) tool cards, bucketed per owning node. Each bucket maps
  // a tool *index* to its card — a node's tool stream is index-scoped — so two
  // nodes streaming at once cannot collide on index 0. The '' bucket is the view
  // focus container, i.e. the legacy stream that carries no nodeId.
  const liveTools = Object.create(null);

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
   * A tool call whose arguments are still streaming: the same row as `addTool`, with
   * an empty label that grows with the deltas and no elapsed chip yet (the call has
   * not started). It is folded like every other row, and a click opens its detail —
   * which is where the partial arguments show, so what the model is composing is
   * still readable while it composes it.
   */
  function addLiveTool(index, id, name, args) {
    if (!messagesEl) return;
    const node = el('div', 'msg tool live running');
    node.dataset.index = String(index);
    node.dataset.kind = 'tool';
    if (id) node.dataset.id = id;

    const head = toolRowHead(name || '', args ? toolBrief(name, args) : '', MONO_LABEL_TOOLS.has(name));
    node.appendChild(head);

    const detail = el('div', 'tool-detail hidden');
    const argsEl = el('pre', 'tool-args');
    const argsText = document.createTextNode(args || '');
    argsEl.appendChild(argsText);
    detail.appendChild(argsEl);
    node.appendChild(detail);

    head.addEventListener('click', () => {
      markRowTouched(node);
      setToolOpen(node, !isRowOpen(node));
    });

    node._rowEl = head;
    node._detailEl = detail;
    node._verbEl = byClass(head, 'tool-verb');
    node._labelEl = byClass(head, 'tool-label');
    node._argsText = argsText;
    node._argsEl = argsEl;

    ensureStepsGroup();
    logTail().appendChild(node);
    updateStepsHead(stepsGroup());
    liveBucket(undefined, true)[index] = node;
    followActive();
    return node;
  }

  /** One streaming delta of a call's arguments: the row's label and detail follow it. */
  function appendLiveTool(index, id, nameDelta, argsDelta) {
    const bucket = liveBucket(undefined, true);
    let node = bucket[index];
    if (!node) {
      node = addLiveTool(index, id, '', '');
    }
    if (id) node.dataset.id = id;
    if (argsDelta && node._argsText) {
      node._argsText.appendData(argsDelta);
      // The label is derived from the arguments as they arrive, in place (a rebuild
      // per delta would throw away the row the reader may have just opened).
      const name = node._verbEl ? node._verbEl.textContent : '';
      const label = toolLabel(name, node._argsEl.textContent || '');
      if (node._labelEl) {
        node._labelEl.textContent = label;
      } else if (label && node._rowEl) {
        node._labelEl = el('span', 'tool-label' + (MONO_LABEL_TOOLS.has(name) ? ' mono' : ''), label);
        node._rowEl.appendChild(node._labelEl);
      }
    }
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
      if (verb) verb.textContent = toolVerb(name);
    }
    const label = toolLabel(name, args, title);
    node._label = label;
    if (node._rowEl) {
      let labelEl = byClass(node._rowEl, 'tool-label');
      if (!labelEl && label) {
        labelEl = el('span', 'tool-label' + (MONO_LABEL_TOOLS.has(name) ? ' mono' : ''), label);
        node._rowEl.appendChild(labelEl);
      } else if (labelEl) {
        labelEl.textContent = label;
        labelEl.classList.toggle('mono', MONO_LABEL_TOOLS.has(name));
      }
      // The arguments are settled, so the call is *running* now: that is the moment
      // its elapsed chip is born.
      syncElapsed(node._rowEl, 'tool-elapsed', start, ms);
    }
    // The detail is rebuilt from the same three parts `addTool` writes (args line,
    // result, usage), so the folded row holds exactly what a repaint would fill it with.
    if (node._detailEl) {
      node._detailEl.innerHTML = '';
      if (args && args !== '{}') {
        node._detailEl.appendChild(el('div', 'tool-args-line', '> ' + describeArgs(args).replace(/\n+/g, ' ')));
      }
    }
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
  function updateTool(id, content, ms) {
    if (!messagesEl) return;
    const node = toolNodeById(messagesEl, id);
    if (!node) return;
    node.classList.remove('running', 'live');
    node.classList.add('done');
    const head = node._rowEl || byClass(node, 'tool-row');
    if (head) syncElapsed(head, 'tool-elapsed', null, ms);
    const detail = node._detailEl || byClass(node, 'tool-detail');
    if (detail && content) detail.appendChild(el('pre', 'tool-result', content));
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

  function addBackgroundNotice(item) {
    if (!messagesEl) return;
    const node = el('div', 'msg bgnotify');
    node.dataset.kind = 'background';
    const head = el('div', 'bgnotify-head');
    // The badge names the producer, so a background terminal and a sub-agent batch
    // are told apart at a glance (they used to share the same "BG").
    head.appendChild(el('span', 'bgnotify-badge ' + (item.kind === 'subagent' ? 'sub' : 'bg'), item.kind === 'subagent' ? 'SUB' : 'BG'));
    head.appendChild(el('span', 'bgnotify-id', '#' + (item.id != null ? item.id : '')));
    head.appendChild(el('span', 'bgnotify-status', item.doneText || tr('finished')));
    node.appendChild(head);
    if (item.name || item.cmd) {
      node.appendChild(el('div', 'bgnotify-cmd', item.name || item.cmd));
    }
    if (item.content) {
      node.appendChild(el('pre', 'bgnotify-output', item.content));
    }
    logTail().appendChild(node);
    followActive();
    return node;
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
    // A full render clears the log, which is the one way a position can be thrown away
    // with nothing to be said for it: keep what the log remembers and hand it back once
    // the items are in. On a card's *first* render there is nothing to hand back
    // (`rememberScroll` has not seen a scroll yet) and `_needsBottomScroll` is the
    // positioning that render wants, so both cases fall through untouched.
    const keepWork = scrollMemory(workEl);
    workEl.innerHTML = '';
    askEl.innerHTML = '';
    // A full render replaces the log, and its steps group with it: the next render that
    // has steps builds a fresh one (`ensureStepsGroup`).
    card._steps = null;
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
      const toolAt = work.findIndex((item) => item.kind === 'tool');
      // A finished card that has steps paints its run-up, the header and the answer;
      // the body is built on the click that opens the group (`paintStepsBody`), because
      // a folded log is not read. A card still streaming is never re-rendered from a
      // slice — the live path appends into it — so it takes the plain path and settles
      // when its turn ends.
      if (toolAt >= 0 && !runningNodes.has(card.dataset ? card.dataset.id : '')) {
        for (let i = 0; i < toolAt; i++) renderItemInto(work[i]);
        const group = ensureStepsGroup();
        const rest = work.slice(toolAt);
        const answerItem = rest.length && rest[rest.length - 1].kind === 'assistant' ? rest.pop() : null;
        group._lazy = rest;
        group._count = rest.filter((item) => item.kind === 'tool').length;
        updateStepsHead(group);
        if (answerItem) {
          renderItemInto(answerItem);
          moveAnswerOut(card, group);
        }
        if (!group._userTouched) setStepsFold(group, true);
      } else {
        for (const item of work) renderItemInto(item);
      }
    }
    messagesEl = prevMsg;
    promptEl = prevPrompt;
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
    // A page of finished history is not the live turn: nothing here may pan the tree.
    suppressFollow = true;
    messagesEl = container;
    promptEl = state.promptEl;
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
      const message = addAssistant(item.text, item.error, item.thinking);
      // The same writer the live `usage` message uses: one item, one usage line, in the
      // same place.
      if (item.usage) paintUsage(message, item.usage);
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
  let bgTasks = new Map();

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

  function statusTextFor(task, meta) {
    if (task && task.status === 'running') return tr('running');
    if (task && task.pendingDelivery) return tr('pending delivery');
    if (task && task.killed) return tr('killed');
    if (task) return tr('exit {0}', task.exitCode != null ? task.exitCode : '?');
    // No live snapshot: the job is over (its card is a record now).
    if (meta && meta.bgKilled) return tr('killed');
    if (meta && meta.bgExitCode != null) return tr('exit {0}', meta.bgExitCode);
    return meta && meta.status ? meta.status : tr('finished');
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
    const task = meta && meta.bgTaskId != null ? bgTasks.get(Number(meta.bgTaskId)) : null;
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
    bgTasks = new Map();
    for (const task of tasks || []) {
      if (!task || task.id == null) continue;
      // Legacy shape (an older host): no owner is named, so the jobs belong to the
      // focused node — the only node a one-run host could have spawned them from.
      if (legacy && !task.nodeId) task.nodeId = treeActiveId;
      bgTasks.set(Number(task.id), task);
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
      // The same untranslated `shared` token the card wears, with the same sentence.
      const shared = el('span', 'node-shared-badge', 'shared');
      shared.title =
        'This job does not block the composer and will not notify the agent; read its result with check_background_terminal.';
      head.appendChild(shared);
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
   * The `shared` badge: this job is **detached** — fire-and-forget. The card is still
   * owned by the node that started it and keeps updating (it is the only place the job
   * is visible at all), but the job locks no node and never notifies: the composer never
   * turns into Stop for it, and no completion notice will ever reach the agent, which
   * reads the outcome with `check_command` or `wait_for_command` if it wants it.
   *
   * A compact 9px dock token like `CTX` / `SUB` / `BG`, placed the way they are (just
   * before the status chip) and created/removed lazily, so a repaint can never stack
   * two of them. Both the token and the tooltip are English literals on purpose: a new
   * `tr()` key would leave every shipped catalog without an entry and fail
   * `npm run check:l10n`, and the sentence names a model-facing tool, not a UI concept.
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
      badge = el('span', 'node-shared-badge', 'shared');
      badge.title =
        'This job does not block the composer and will not notify the agent; read its result with check_command or wait_for_command.';
      const head = card.querySelector('.node-head');
      const status = head.querySelector('.node-status');
      if (status) head.insertBefore(badge, status); else head.appendChild(badge);
    } else if (!wanted && badge) {
      badge.remove();
    }
  }

  /**
   * The `CTX` badge on a card head: this node *starts* a new context window — it
   * and the dashed edge above it are the whole visual story of a context rollover
   * (`docs/agents/invariants/context-rollover.md`). A compact dock token,
   * deliberately untranslated like `SUB` / `BG`; the explanation is the tooltip,
   * and that one *is* translated. Created lazily, like every other head badge, so
   * a repaint never accumulates them, and placed the way `SUB` / `Delivered` are:
   * just before the status chip.
   */
  function syncCtxBadge(card, meta) {
    if (!card) return;
    // Self-equality is the contract's own validity test (`tree.ts contextBase()`): a
    // stored marker that does not name this node opens no window at all, so the card
    // must not claim one either.
    const wanted = !!(meta && meta.contextBaseId && meta.contextBaseId === meta.id);
    let badge = byClass(card, 'node-ctx-badge');
    if (wanted && !badge) {
      badge = el('span', 'node-ctx-badge', 'CTX');
      badge.title = tr('This node starts a new context window; the branch above it is not sent to the model any more');
      const head = card.querySelector('.node-head');
      const status = head.querySelector('.node-status');
      if (status) head.insertBefore(badge, status); else head.appendChild(badge);
    } else if (!wanted && badge) {
      badge.remove();
    }
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
    const status = el('span', 'node-status', meta.status || '');
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
    const del = el('button', 'node-del', '🗑');
    del.title = tr('Delete this branch — this turn and everything below it');
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      vscode.postMessage({ type: 'deleteBranch', id });
    });
    head.appendChild(del);
    card.appendChild(head);
    // A window-starting node carries the `CTX` marker from the moment its card
    // exists (it is created once, here, and never rebuilt).
    syncCtxBadge(card, meta);

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
    workWrap.appendChild(work);
    const excerpt = el('div', 'node-excerpt');
    excerpt.textContent = meta.preview || meta.title || '';
    // The "its content is on its way" strip (see `setCardLoading`): the one place a
    // card says it is waiting rather than done. It is created with the card and never
    // rebuilt, its label is the one user-visible string this adds, and the CSS shows it
    // only on an *expanded* card that is loading — a collapsed card is its preview.
    const loading = el('div', 'node-loading', tr('Loading…'));
    // Order matters: loading, log, collapsed preview — the preview is what a collapsed
    // card shows *instead* of the log.
    body.appendChild(loading);
    body.appendChild(workWrap);
    body.appendChild(excerpt);
    card.appendChild(body);

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
      return;
    }
    card.setAttribute('aria-busy', 'true');
    card._itemsTimer = setTimeout(() => {
      card._itemsTimer = null;
      card.classList.remove('items-loading');
      card.removeAttribute('aria-busy');
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

  /** Render this card again, whatever the observer last decided (see `cvObserver`). */
  function cvWake(card) {
    try {
      if (!card || !cvSkipped.has(card)) return;
      cvSkipped.delete(card);
      card.classList.remove('cv-skip');
      card.style.containIntrinsicSize = '';
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
        // Measured while it is still rendered — this is the height the layout will read back.
        const w = card.offsetWidth || 0;
        const h = card.offsetHeight || 0;
        if (!w || !h) continue;
        card.style.containIntrinsicSize = w + 'px ' + h + 'px';
        card.classList.add('cv-skip');
        cvSkipped.add(card);
      }
    } catch (err) {
      /* a layout aid must never break the UI */
    }
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
    setCardLoading(card, false);
    // Same finished-node default as in `expandedCard` / `renderPath`.
    if (finished) {
      setCardScrollLock(card, false);
      card._needsBottomScroll = true;
    }
    // Open the just-filled card at its newest content (a locked card is pinned there
    // anyway, an unlocked one takes the flag `expandedCard` would).
    if (card._itemScroll && card._itemScroll.locked) {
      card._itemScroll.scrollToBottom();
      card._needsBottomScroll = false;
    } else if (card._needsBottomScroll && itemsEl) {
      itemsEl.scrollTop = itemsEl.scrollHeight;
      card._needsBottomScroll = false;
    }
    // The items are what gives this card its height, and the card's height
    // feeds the layout, so re-place the tree like any other card that changed
    // size (debounced, so a burst of answers coalesces into one relayout).
    scheduleLayout();
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

  // ---- Sub-agent family colours --------------------------------------------------------
  //
  // A sub-agent window's colour says WHICH family it belongs to and HOW DEEP it is. The family
  // is the level-1 window it descends from; the hue comes from a fixed-seed sequence indexed by
  // that window's order among its node's windows, and every level down raises the saturation
  // and lowers the lightness — so a level-2 window reads as "the same family, one step deeper"
  // rather than as an unrelated card. The sequence is a pure function of the index, so a family
  // keeps its colour across repaints, reloads and sessions, and it never runs out.
  const FAMILY_SEED = 0x5EED5EED;
  const familyJitters = [];
  let familyState = FAMILY_SEED | 0;
  // Two arcs of the wheel, one per KIND of sidecar: a sub-agent window is warm (red → orange →
  // yellow), a background job card is cold (cyan → blue → violet). The two classes can therefore
  // never share a hue, which is what a glance at the tree needs most; keeping them apart matters
  // more than spreading every family evenly over the whole wheel.
  const WARM = { from: 330, span: 100 };
  const COLD = { from: 170, span: 120 };
  /**
   * The jitter for family `i`: a fixed-seed mulberry32 STREAM off `FAMILY_SEED`, one value per
   * index, kept within ±9 degrees so it only softens the ramp below. Cached, so it is a pure
   * function of the index.
   */
  function familyJitter(i) {
    while (familyJitters.length <= i) {
      familyState = (familyState + 0x6D2B79F5) | 0;
      let t = Math.imul(familyState ^ (familyState >>> 15), 1 | familyState);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      familyJitters.push((((t ^ (t >>> 14)) >>> 0) % 19) - 9);
    }
    return familyJitters[i];
  }
  /**
   * The hue of family `i` inside its arc. The STEP is the arc's own golden section
   * (`span * 0.618`), so consecutive families land far apart WITHIN the arc instead of marching
   * along it (a plain fixed-seed stream measured badly here: the first families came out 144, 144,
   * 146, 131 — the same colour four times in a row). Pure and endless: a family keeps its colour
   * across repaints, reloads and sessions.
   */
  function familyHue(i, arc) {
    const step = arc.span * 0.6180339887;
    return Math.round((((arc.from + ((i * step) % arc.span) + familyJitter(i)) % 360) + 360) % 360);
  }
  /** A sidecar's family index and level, from the tree the webview already holds. */
  function subColorOf(id) {
    const chain = [];
    let n = treeNodes[id];
    while (n && isSidecarKind(n.kind)) { chain.unshift(n); n = treeNodes[n.parentId]; }
    if (!chain.length) return null;
    const top = chain[0];                 // the level-1 window: the whole family wears its hue
    const sibs = n ? (n.children || []).filter((c) => treeNodes[c] && isSidecarKind(treeNodes[c].kind)) : [top.id];
    const idx = Math.max(0, sibs.indexOf(top.id));
    const level = chain.length;           // 1 for a top-level window, 2 for its windows, …
    return {
      idx,
      level,
      // A job card walks the cold arc, a sub-agent window the warm one.
      h: familyHue(idx, top.kind === 'bg' ? COLD : WARM),
      s: Math.min(92, 44 + (level - 1) * 16),   // deeper = more saturated
      l: Math.max(28, 64 - (level - 1) * 13),   // deeper = darker
    };
  }
  /** Paint a sidecar card, and remember the colour its connector runs in. */
  function applySubColor(id) {
    const c = subColorOf(id);
    const card = nodeEls[id];
    if (!c || !card) return;
    // ONE property is the card's colour. Everything that shows it — the left stripe, the focused
    // card's outline, and (computed separately for the SVG, which cannot read a card's custom
    // property) its connector — reads this one value instead of reassembling a
    // hue/saturation/lightness triple.
    if (card.style && card.style.setProperty) {
      card.style.setProperty('--sub-color', 'hsl(' + c.h + ', ' + c.s + '%, ' + c.l + '%)');
    }
    card.dataset.subHue = String(c.h);
    card.dataset.subLevel = String(c.level);
    subColors[id] = c;
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
    card.classList.add('monitor');
    card.classList.remove('expanded', 'active');
    applySubColor(id);
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
    } else if (card._needsBottomScroll && workEl) {
      workEl.scrollTop = workEl.scrollHeight;
      card._needsBottomScroll = false;
    }
  }

  function expandedCard(id, meta, pnode) {
    const card = nodeEls[id];
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
    if (isSidecarKind(meta.kind)) applySubColor(id);
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
    } else if (card._needsBottomScroll && workEl) {
      // Unlocked (finished) card: open at its newest content, then scroll freely.
      workEl.scrollTop = workEl.scrollHeight;
      card._needsBottomScroll = false;
    }
  }

  function collapsedCard(id, meta) {
    const card = nodeEls[id];
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
    promptEl = card ? card.querySelector('.node-ask') : null;
    // The send pane lives at the bottom of the checked-out node's card, and only
    // there: a sub-agent branch is read-only (driven by the main agent through
    // spawn_agents / send_agent_message), and a session with no active node has
    // no card to inline it in — in both cases the pane is hidden entirely.
    const node = id ? treeNodes[id] : null;
    // A sidecar (sub-agent window / background job card) never hosts the composer:
    // it is driven by the agent, and a job card has no conversation at all.
    const hostCard = card && !(node && isSidecarKind(node.kind)) ? card : null;
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
        statusEl.textContent = msg.status;
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
    }
    if (card) syncContinueButton(card, treeNodes[msg.id] || { id: msg.id, status: msg.status, children: [] });
    // The context state is half of what the composer's own two buttons read (a refused
    // request disables Send and offers the new-epoch entry), and it can arrive *after*
    // the tree was drawn — exactly how a turn dies on a context-length error.
    updateComposerButtons();
  }

  /**
   * The ▶ Continue / ↻ Retry entries on a card whose turn ended without an answer:
   * interrupted by the user, or failed — an API error that outlived the client's
   * transparent retries. Clicking one asks the harness to run a turn from that node
   * with a message the harness writes itself, so the user never has to type
   * "continue".
   *
   * One element, one meaning, and the *variant* follows the node's status:
   *  - `error` (any failure) → `↻ Retry`, in place;
   *  - `interrupted` → `▶ Continue`, in place.
   * A new *context window* is not offered here any more: every new-epoch transition —
   * a full window, a near-full one, and a setup that moved away from the frozen one —
   * is the composer's single `#new-context-btn` (`updateNewContextButton`), so a card
   * never carries a second, differently-worded entry for the same act.
   *
   * Shown only where continuing makes sense: a conversational turn node (never a
   * sidecar — a sub-agent window or job card has no conversation of its own here),
   * not currently running, and a *tip* of its branch (a node that already has a
   * turn child has been continued; the new failure, if any, shows on that child).
   * The element is created once; a sync fixes its text, title and `dataset.action`,
   * and the click handler reads the action at click time.
   */
  function syncContinueButton(card, meta) {
    const id = meta && meta.id;
    // `byClass`, not `querySelector`: a miss must be observable (the offline
    // webview checker's DOM stub answers a plain-class miss with a shared stub).
    const btn = byClass(card, 'node-continue');
    const terminal = !!meta && (meta.status === 'interrupted' || meta.status === 'error');
    const hasTurnChild = !!meta && (meta.children || []).some((c) => {
      const child = treeNodes[c];
      return child && !isSidecarKind(child.kind);
    });
    const failed = !!meta && meta.status === 'error';
    const label = failed ? tr('↻ Retry') : tr('▶ Continue');
    const title = failed
      ? tr('Ask the harness to retry this turn (it sends the message for you)')
      : tr('Ask the harness to continue from here (it sends the message for you)');
    const action = failed ? 'retry' : 'continue';
    const show = !!id && terminal && !hasTurnChild && !isSidecarKind(meta.kind) && !runningNodes.has(id);
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
    if (cardRelayoutRaf != null) return;
    cardRelayoutRaf = requestAnimationFrame(() => {
      cardRelayoutRaf = null;
      relayout();
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
    messagesEl = itemsEl;
    promptEl = card.querySelector('.node-ask');
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
    let badge = card.querySelector('.node-agent-badge');
    if (!badge) {
      badge = el('span', 'node-agent-badge', 'SUB');
      head.insertBefore(badge, head.querySelector('.node-status'));
    }
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
        statusEl.textContent = msg.status === 'done' ? tr('done') : msg.status === 'error' ? tr('error') : tr('interrupted');
        statusEl.dataset.status = msg.status === 'done' ? 'done' : msg.status === 'error' ? 'error' : 'interrupted';
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
        const sc = subColors[id];
        const tint = sc && !cls ? ' stroke="hsl(' + sc.h + ' ' + Math.min(85, sc.s + 12) + '% ' + Math.min(72, sc.l + 16) + '%)"' : '';
        parts.push('<path data-agent="' + id + '" class="edge-agent' + cls + '"' + tint + ' d="' + d + '" />');
      } else {
        const childMidX = cx + cw / 2;
        const parentBottomX = px + pw / 2;
        const parentBottomY = py + ph;
        const mx = (parentBottomX + childMidX) / 2;
        // A dashed connector is the visual mark of a context-window boundary, and
        // it belongs to the window-starting node's *own* connector: only the child
        // carrying `contextBaseId` is dashed, its descendants are ordinary turn
        // edges again.
        const cls = meta.contextBaseId && meta.contextBaseId === meta.id ? ' class="edge-context"' : '';
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
        if (statusEl) statusEl.textContent = n.status || '';
        syncContinueButton(card, n);
        // A card `renderPath` created from a node the `tree` had not described yet
        // still has to pick the `CTX` marker up here (never in a streaming patch:
        // the head exists once).
        syncCtxBadge(card, n);
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
      // Same reason as in `renderTree`: the `CTX` marker belongs to the card's
      // whole life, not to one repaint, and this pass may have created the card
      // before the node's own `tree` entry described it.
      syncCtxBadge(nodeEls[id], meta);
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
      // Same story as in `renderTree`: the `CTX` marker belongs to the card, not to
      // one repaint — and this pass can be the one that creates the card.
      syncCtxBadge(nodeEls[id], meta);
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
  function scheduleLayout() {
    if (layoutDebounce != null) return;
    layoutDebounce = setTimeout(() => {
      layoutDebounce = null;
      relayout();
    }, 150);
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
    }
  });
  window.addEventListener('pointermove', (e) => {
    if (resizing) { onResizeMove(e); return; }
    if (!dragging) return;
    pan.x = dragging.px + (e.clientX - dragging.startX);
    pan.y = dragging.py + (e.clientY - dragging.startY);
    applyTransform();
    setFollow(false);
  });
  window.addEventListener('pointerup', () => {
    if (resizing) { endResize(true); return; }
    dragging = null;
  });
  window.addEventListener('pointercancel', () => {
    if (resizing) { endResize(false); return; }
    dragging = null;
  });
  // Safety: if the pointer capture is released without a clean pointerup (e.g. the
  // cursor left the webview mid-drag), end the gesture so it never gets stuck.
  window.addEventListener('lostpointercapture', () => {
    if (resizing) { endResize(false); return; }
    dragging = null;
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
  }

  function stopAutoscroll() {
    if (!autoscroll) return;
    if (autoscroll.raf != null) cancelAnimationFrame(autoscroll.raf);
    autoscroll = null;
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
  }, true);
  // Zooming / panning moves the cards out from under a viewport-anchored menu, and
  // so does losing the window.
  window.addEventListener('wheel', () => { closeNodeMenu(); closeSnippetMenu(); }, { passive: true });
  window.addEventListener('blur', () => { closeNodeMenu(); closeSnippetMenu(); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeNodeMenu(); closeSnippetMenu(); }
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
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 0.9);
      setFollow(false);
      return;
    }
    // alt + wheel pans the whole tree vertically, and it does so *whatever* is under
    // the pointer — that is why it sits before the native-scroll-zone check below: a
    // card, its work log / answer / ask, a thinking block and the composer all pan the
    // camera instead of scrolling themselves. It is the vertical twin of the shift +
    // wheel pan further down, and the one gesture that moves the tree from inside a
    // scroller (where a plain wheel is the zone's own).
    if (e.altKey) {
      e.preventDefault();
      pan.y -= e.deltaY;
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
    if (e.shiftKey) {
      // Shift + wheel pans horizontally (kept as a pan escape hatch).
      pan.x -= e.deltaY;
      applyTransform();
      setFollow(false);
      return;
    }
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
   * The composer's **one** new-epoch entry (`#new-context-btn`, beside Send): the
   * single way to move a conversation into a new epoch, whether the reason is a setup
   * that moved away from the frozen one or a context window that is near or past full.
   * It replaces the three entries that used to disagree — the per-card `⧉ Continue in a
   * new window`, the harness-drift `⧉` hint and the modal a plain send raised.
   *
   * The label follows the box: with something to send the click carries that text into
   * the new epoch, with an empty box it is the compaction entry. It is shown only while
   * the host says a new epoch is available, and never while the focused node is doing
   * something (Stop owns the row then, and both other buttons hide). It stays enabled
   * with an empty box — the compaction entry is exactly the click for a window that is
   * full and a box that is empty — and is disabled, with a tooltip that says why, only in
   * a read-only window or on a sub-agent branch; the host re-checks all of it and answers
   * with a notice when a stale click arrives.
   */
  function updateNewContextButton() {
    const hasContent = hasComposerContent();
    newContextBtn.textContent = hasContent ? tr('Continue with new context') : tr('Compact and Continue');
    const reason = newContextBlockedReason();
    const show = newEpochAvailable() && !focusIsRunning() && !focusIsLocked();
    newContextBtn.classList.toggle('hidden', !show);
    newContextBtn.disabled = !!reason;
    newContextBtn.title = reason
      ? reason
      : hasContent
        ? tr('Send this message in a new context window or under the new setup (the harness asks first)')
        : tr('Compact this conversation and continue in a new context window (the harness asks first)');
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
    // Any drift — the user's or the harness's — is the new-epoch entry's business, so
    // the button's visibility and disabled state are re-read here.
    updateNewContextButton();
  }

  /**
   * The new-epoch click (`#new-context-btn`): the composer's text and attachments
   * travel with it, exactly like a Send's. The host decides the backend (a new context
   * window, or a fork under the live setup), asks one modal question and re-validates
   * the trigger, so a stale click is answered with a notice. The input is *not* cleared
   * here — only the host knows whether it took the turn, and it says so with
   * `composerClear`.
   */
  function newContextTurn() {
    if (newContextBtn.disabled) return;
    setFollow(true);
    vscode.postMessage({
      type: 'newContextTurn',
      text: inputEl.value.trim(),
      attachments: pendingAttachments,
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
    autoGrow();
    updateComposerButtons();
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
  function handleMessage(msg) {
    switch (msg.type) {
      case 'tree':
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
      case 'delta':
        addTpsTokens(msg.text);
        routeTo(msg.nodeId, () => appendAssistant(msg.text), 'delta');
        break;
      case 'thinkingDelta':
        addTpsTokens(msg.text);
        routeTo(msg.nodeId, () => appendThinking(msg.text), 'thinkingDelta');
        break;
      case 'usage':
        routeTo(msg.nodeId, () => appendUsage(msg.usage), 'usage');
        break;
      case 'toolCallDelta':
        addTpsTokens((msg.name || '') + (msg.args || ''));
        routeTo(msg.nodeId, () => appendLiveTool(msg.index, msg.id, msg.name, msg.args), 'toolCallDelta');
        break;
      case 'toolStart':
        routeTo(msg.nodeId, () => { finalizeStreamingAnswer(); finalizeLiveTool(msg.index, msg.id, msg.name, msg.args, msg.startedAt, null, msg.title); }, 'toolStart');
        break;
      case 'toolEnd':
        routeTo(msg.nodeId, () => updateTool(msg.id, msg.content, msg.ms), 'toolEnd');
        break;
      case 'agentStart':
        onAgentStart(msg);
        break;
      case 'agentDone':
        onAgentDone(msg);
        break;
      case 'done':
        endRun(msg);
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
    }
    autoGrow();
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
  newContextBtn.addEventListener('click', newContextTurn);
  stopBtn.addEventListener('click', () => {
    setStatus(tr('Stopping…'));
    // Stop only the view focus node's run (spec §3.2): other nodes stay running.
    // A null focus (no node) means "stop everything in this session".
    vscode.postMessage({ type: 'stop', nodeId: treeActiveId });
  });
  attachBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'pickImage' });
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
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      // Enter is the Send button's other face: a disabled Send means Enter does
      // nothing too, instead of sending something the button refuses to.
      if (!sendBtn.disabled) send();
    }
  });

  inputEl.addEventListener('input', () => {
    // Typing changes "has content", which both composer buttons read — the same
    // refresh a programmatic write (a snippet, `composerClear`) makes for itself.
    afterComposerWrite();
  });

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

  document.addEventListener('click', (event) => {
    const target = event.target;
    const anchor = target && target.closest ? target.closest('a[href]') : null;
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute('href') || '';
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
})();
