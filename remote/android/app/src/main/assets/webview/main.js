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
  // Sub-agent sidecar grid (see media/tree.js): windows are packed into a
  // column-major lattice right of the parent card, at most AGENT_MAX_ROWS rows
  // per column; every further window opens a column to the right.
  const AGENT_GAP = 80;
  const AGENT_VGAP = 24;
  const AGENT_COL_GAP = 48;
  const AGENT_MAX_ROWS = 4;
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
  // Sidecar cards the last layout pass stretched (media/tree.js `stretch`): id ->
  // the height in canvas px `relayout()` forced onto that card. It is the record of
  // what has to be undone before the next measurement — see `clearStretchHeights()`
  // and `relayout()`.
  let layoutStretch = Object.create(null);
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
  // User-configurable folding (set via the `config` message). These are the *at
  // rest* defaults: the block that is live right now is always expanded (see
  // `setActive` below).
  let foldToolCalls = true;
  let foldThinking = true;
  // Zone 2's own fold default (see `autoWorkFold`): the work log of a turn *with*
  // an answer is folded down to its one-line header. Not a block default like the
  // two above — it is re-decided per card by the promotion/demotion hooks, and a
  // header the user clicked owns its card from then on.
  let foldWork = true;

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
   * Is this tab on screen at all — the page visible **and** the editor tab in front? The
   * sampler runs only then, and a `stall` can only be reported then. A tab nobody is looking
   * at is allowed to stop drawing (that is the engine throttling it, not a defect), so a gap
   * measured there is not evidence of anything the user saw — and reporting it was drowning
   * the real case in false alarms.
   */
  function perfOnScreen() {
    return !perfHidden() && tabVisible;
  }

  /** Milliseconds this tab has spent off screen, the stretch in progress included. */
  function perfTabHiddenMs() {
    return Math.round(tabHiddenMs + (tabHiddenSince != null ? perfNow() - tabHiddenSince : 0));
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
   * The host said whether this tab is on screen (`viewState`).
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
   * `probe`: answer with this document's counters *now*, then with the frame that
   * follows them. The two answers are what tell the three ways a quiet tab can fail
   * apart — the script is dead (neither arrives), the script runs but nothing reaches
   * the screen (`probe-frame` is the one that never comes), or both are fine and the
   * freeze is elsewhere. The counters go out immediately, before the frame is asked
   * for, because they are the half the host can still use from a tab that will never
   * paint again.
   */
  function perfOnProbe(msg) {
    try {
      const t0 = perfNow();
      perfNoteEpisode('probe');
      perfPost('probe', {
        id: msg.id,
        msgs: perfMessages,
        drops: perfDrops,
        frames: frameCount,
        lastFrame: Math.round(perfNow() - lastFrameAt),
        dom: perfDomCount(),
        cards: Object.keys(nodeEls).length,
        canvas: perfCanvasBox(),
        wrap: perfBox(treeWrap),
        inner: perfInnerBox(),
        dpr: perfDpr(),
        hiddenMs: perfHiddenMs(),
        tabHiddenMs: perfTabHiddenMs(),
        readyState: document.readyState,
      });
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

  // ---- The tree area's own size (the `resize` report) --------------------------
  // A wrapper that is resized while the canvas keeps its old box is the second shape a
  // frozen picture takes: the canvas is what the pan/zoom transform moves, so a wrap
  // the layout never re-measured leaves the tree parked where it was. The observer
  // that drives `relayout()` reports the change here; the report is throttled and only
  // ever sent for a real change, so a dragged window writes one line per half second
  // and a settled one writes none.
  let resizeReportAt = 0;
  let resizeReportedBox = '';   // the last box a report was sent for ('' = no baseline yet)

  function perfReportResize() {
    try {
      const rect = treeWrap.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      const box = w + 'x' + h;
      // The first measurement of a document is the baseline, not a change: there is
      // nothing to compare it with, and `wrap=` in the probe reply already carries it.
      if (resizeReportedBox === '') {
        resizeReportedBox = box;
        return;
      }
      if (box === resizeReportedBox) return;
      const now = perfNow();
      if (now - resizeReportAt < RESIZE_REPORT_MS) return;
      resizeReportAt = now;
      resizeReportedBox = box;
      perfPost('resize', { w, h, dpr: perfDpr(), canvas: perfCanvasBox() });
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

  /**
   * Apply a changed fold default to the cards already on screen — a settings
   * change must not wait for the next repaint. Card bodies are the only state
   * that matters (the chevron and the `.open` marker follow it), so a later
   * click on the header still toggles that single card as usual. The one body a
   * settings change never reaches is the live one (see `setActive`).
   */
  function applyFoldDefault(bodySelector, folded) {
    if (!messagesEl) return;
    for (const body of messagesEl.querySelectorAll(bodySelector)) {
      // The live block stays expanded whatever the default says (see `setActive`);
      // the new default reaches it when it goes idle.
      if (body._active) continue;
      setBlockOpen(body, !folded);
    }
  }
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
  // `card` is the log's own dot (a thinking block passes none). Releasing the light
  // is the gesture that says *I am reading this card*: it hands the card to the
  // reader exactly as a click on the work-log header does (`_workTouched`), so the
  // automatic fold can never hide — or unfold — the log somebody just chose to look
  // at, and the offsets the zones remember are what put them back where they were.
  // Re-engaging follow is a scrolling gesture, not a claim on the fold, so it
  // neither sets the mark nor clears it.
  function attachLock(container, host, locked, card) {
    const dot = el('div', 'scroll-lock-dot' + (locked === false ? '' : ' locked'));
    const ctrl = createScrollController(container, (isLocked) => {
      dot.classList.toggle('locked', isLocked);
      dot.title = isLocked ? LOCK_TITLE_ON : LOCK_TITLE_OFF;
    }, locked);
    dot.title = ctrl.locked ? LOCK_TITLE_ON : LOCK_TITLE_OFF;
    dot.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ctrl.toggle();
      if (!ctrl.locked && card) card._workTouched = true;
    });
    host.appendChild(dot);
    return ctrl;
  }

  /** Lock / unlock every scroll area of a card (its transcript + thinking blocks). */
  function setCardScrollLock(card, locked) {
    if (!card) return;
    if (card._itemScroll) (locked ? card._itemScroll.lock() : card._itemScroll.unlock());
    for (const body of card.querySelectorAll('.thinking-body')) {
      if (body._scroll) (locked ? body._scroll.lock() : body._scroll.unlock());
    }
  }

  // ---- Remembering where a reader was ------------------------------------------
  // **A repaint never moves a scroller.** A rebuild, a measurement or a fold can each
  // take a container's position away, and none of them puts it back: `innerHTML = ''`
  // resets it, and a scroll container that is briefly given the height of its own
  // content has nothing to scroll over at all, so the engine clamps its `scrollTop` to
  // 0 (that is what the split measurement used to do to the work log — see the
  // `split-measure` rule in style.css). The one thing that survives all of them is the
  // offset the reader last scrolled to, so each zone keeps it and hands it back.
  // A locked card is never restored: its follow light owns the bottom, and the caller
  // pins it there (`scrollToBottom`).
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

  /** One computed length off an element; `0` when there is no layout to ask. */
  function cssPx(node, prop) {
    if (!node || typeof window.getComputedStyle !== 'function') return 0;
    const cs = window.getComputedStyle(node);
    return cs ? parseFloat(cs[prop]) || 0 : 0;
  }

  // ---- Active blocks: the block that is live right now is always expanded ----
  // A thinking block receiving deltas, and a tool call between its first delta and
  // its end, are *active*: they are expanded whatever `foldThinking` /
  // `foldToolCalls` say, and they fold back to that default the moment they stop
  // being active — the answer's text takes over, the call reports its result, or
  // the turn ends (`done` / `interrupted` / `error`). So at rest the fold defaults
  // describe what is on screen, and only the live block is open.
  //
  // Three marks per block body carry the state:
  //   `_active`      — the block is live right now (also what `applyFoldDefault`
  //                    skips, so a settings change cannot fold the live block);
  //   `_autoOpen`    — *this* rule opened it, so only this rule may close it again
  //                    (a body that is open because the fold default is off is
  //                    never touched);
  //   `_userTouched` — set by a click on the block's header: from then on the user
  //                    owns that block and the rule leaves it exactly as they left it.
  // The list of live bodies lives on the container (`messagesEl`), which `routeTo`
  // swaps per node, so two nodes streaming at once never see each other's blocks.
  /**
   * Open or close one collapsible block. The body owns the state (`hidden`); the
   * chevron and — for a thinking block — its `.open` box marker follow it (the
   * scroll-lock light keys off that marker, see `.thinking:not(.open)`).
   */
  function setBlockOpen(body, open) {
    if (!body) return;
    body.classList.toggle('hidden', !open);
    const block = body.parentElement;
    if (!block) return;
    const chev = block.querySelector('.chev');
    if (chev) chev.classList.toggle('open', open);
    if (block.classList.contains('thinking')) block.classList.toggle('open', open);
    // A block inside the work log just changed the log's *content* height: the live
    // reasoning block folding away as the answer takes over, a click on any block header,
    // a settings change. The split's numbers are measured, so it has to be told — without
    // this the log kept the box it had while the block was open, and a short log showed a
    // band of blank space under it until the next settle happened along (the promotion at
    // the end of the turn, which is why it looked like it "shrinks back" only then).
    settleAnswerSplit(owningCard(body));
  }

  /** A click on a block header hands that block to the user: the rule stops here. */
  function markUserTouched(body) {
    if (body) body._userTouched = true;
  }

  /** This block is the live one: expand it, and remember it may be closed again. */
  function setActive(body) {
    if (!body) return;
    body._active = true;
    if (messagesEl) {
      const list = messagesEl._activeBodies || (messagesEl._activeBodies = []);
      if (list.indexOf(body) < 0) list.push(body);
    }
    if (body._userTouched) return;
    if (body.classList.contains('hidden')) {
      setBlockOpen(body, true);
      body._autoOpen = true;
    }
  }

  /** This block is not live any more: give it back to the fold default. */
  function clearActive(body) {
    if (!body) return;
    body._active = false;
    const list = messagesEl ? messagesEl._activeBodies : null;
    if (list) {
      const at = list.indexOf(body);
      if (at >= 0) list.splice(at, 1);
    }
    if (body._userTouched || !body._autoOpen) return;
    setBlockOpen(body, false);
    body._autoOpen = false;
  }

  /**
   * The card an element inside one of its zones belongs to. Walked by `parentElement`
   * rather than `closest`: the offline webview checker's stub DOM has no `closest`, and
   * this runs on a fold (see `setBlockOpen`), so it must not throw there.
   */
  function owningCard(el) {
    let node = el;
    while (node) {
      if (node.classList && node.classList.contains('node') && node.dataset && node.dataset.id) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  /**
   * Close every live block of the current container, or — with `kind` — only the
   * thinking (`'thinking'`) or the tool (`'tool'`) ones: the answer took over, or
   * the turn is over. Another block of the other kind stays live.
   */
  function closeActive(kind) {
    const list = messagesEl ? messagesEl._activeBodies : null;
    if (!list || list.length === 0) return;
    for (const body of list.slice()) {
      const isThinking = body.classList.contains('thinking-body');
      if (kind === 'thinking' && !isThinking) continue;
      if (kind === 'tool' && isThinking) continue;
      clearActive(body);
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
    messagesEl.appendChild(node);
    followActive();
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
    messagesEl.appendChild(node);
    followActive();
    return node;
  }

  function makeThinkingBlock(thinking) {
    const box = el('div', 'thinking');
    const head = el('div', 'thinking-head');
    const chev = el('span', 'chev', '▶');
    head.appendChild(chev);
    head.appendChild(el('span', 'thinking-label', tr('Thinking')));
    box.appendChild(head);
    const body = el('div', 'thinking-body hidden');
    if (thinking) body.textContent = thinking;
    box.appendChild(body);
    // The body hangs off the box (the tool cards do the same with `_bodyEl`): the
    // streaming path reads it back on every delta, and a subtree query per token is
    // not free.
    box._bodyEl = body;
    body._scroll = attachLock(body, box);
    head.addEventListener('click', () => {
      markUserTouched(body);
      setBlockOpen(body, body.classList.contains('hidden'));
      if (body._scroll && !body.classList.contains('hidden')) body._scroll.scrollToBottom();
    });
    if (!foldThinking) {
      setBlockOpen(body, true);
    }
    return box;
  }

  function addAssistant(text, error, thinking) {
    if (!messagesEl) return;
    const node = el('div', 'msg assistant' + (error ? ' error' : ''));
    node.dataset.kind = 'assistant';
    if (thinking) {
      node.appendChild(makeThinkingBlock(thinking));
    }
    const answer = el('div', 'answer');
    node.appendChild(answer);
    node._text = text || '';
    node._answerEl = answer;
    node._streaming = false;
    renderAnswer(node, true);
    messagesEl.appendChild(node);
    followActive();
    return node;
  }

  function appendAssistant(text) {
    if (!messagesEl) return;
    // The answer's text takes the message over, so its thinking block is no longer
    // the live one (it folds back to the default — see `closeActive`).
    closeActive('thinking');
    const last = messagesEl.lastElementChild;
    if (last && last.dataset.kind === 'assistant' && !last.classList.contains('error')) {
      last._text = (last._text || '') + (text || '');
      renderAnswer(last, false);
      followActive();
      return last;
    }
    const node = addAssistant('', false);
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
    // block goes back to the fold default.
    closeActive('thinking');
    const last = messagesEl.lastElementChild;
    if (last && last.dataset.kind === 'assistant' && !last.classList.contains('error')) {
      renderAnswer(last, true);
      followActive();
      relayout();
    }
  }

  function thinkingTextNode(body) {
    if (!body._textNode) {
      const existing = body.textContent || '';
      body.textContent = '';
      body._textNode = document.createTextNode(existing);
      body.appendChild(body._textNode);
    }
    return body._textNode;
  }

  function appendThinking(text) {
    if (!messagesEl) return;
    let last = messagesEl.lastElementChild;
    if (!last || last.dataset.kind !== 'assistant' || last.classList.contains('error')) {
      last = addAssistant('', false);
    }
    let box = last._thinkingBox;
    if (!box) {
      box = makeThinkingBlock('');
      last._thinkingBox = box;
      const answer = last.querySelector('.answer');
      if (answer) last.insertBefore(box, answer);
      else last.appendChild(box);
    }
    const body = box._bodyEl;
    thinkingTextNode(body).appendData(text);
    // The block receiving the deltas is the live one: always expanded, and it folds
    // back on its own the moment something else takes over (see `setActive`).
    setActive(body);
    if (body._scroll) body._scroll.scrollToBottom();
    followActive();
    return last;
  }

  /**
   * Nullish coalescing, for an engine that may not have it.
   *
   * This file is rendered twice: by the desktop's Electron Chromium, and inside the Android
   * app's WebView, which can be far older — API 28 ships Chromium 69, and the two-question-mark
   * operator needs Chromium 80. There the whole script fails to PARSE, so nothing renders: the
   * shell's static HTML is still on screen while every card is missing. The syntax floor is
   * therefore the older of the two engines, and a guard fails packaging when a modern-syntax
   * operator returns (tools/check-remote-assets.js).
   */
  function orElse(value, fallback) {
    return value === undefined || value === null ? fallback : value;
  }

  function formatUsage(usage) {
    const hit = orElse(usage.prompt_cache_hit_tokens, 0);
    const miss = orElse(usage.prompt_cache_miss_tokens, 0);
    return tr(
      'tokens {0} (prompt {1} + completion {2}) · cache hit {3} / miss {4}',
      usage.total_tokens,
      usage.prompt_tokens,
      usage.completion_tokens,
      hit,
      miss,
    );
  }

  function appendUsage(usage) {
    if (!messagesEl) return;
    let target = messagesEl.lastElementChild;
    while (target) {
      const kind = target.dataset.kind;
      if (kind === 'tool' || (kind === 'assistant' && !target.classList.contains('error'))) break;
      target = target.previousElementSibling;
    }
    if (!target) {
      target = addAssistant('', false);
    }
    target.appendChild(el('div', 'usage-line', formatUsage(usage)));
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

  // One-line summary for a collapsed tool card, e.g. `write_file src/a.ts`.
  function toolBrief(name, args) {
    if (!args || args === '{}') return name;
    let value = '';
    try {
      const obj = JSON.parse(args);
      if (obj && typeof obj === 'object') {
        const key = ['read_file', 'write_file', 'replace_in_file', 'read_image', 'list_dir'].includes(name)
          ? 'path'
          : name === 'exec_command'
            ? 'command'
            : obj.path ? 'path' : obj.command ? 'command' : 'cwd';
        value = obj[key] || '';
      }
    } catch {
      const m = String(args).match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"|"command"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      value = m ? (m[1] || m[2] || '') : '';
    }
    value = String(value).replace(/\s+/g, ' ').trim();
    return name + (value ? ' ' + value.slice(0, 60) : '');
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

  function addTool(name, args, id, usage, start, ms) {
    if (!messagesEl) return;
    const node = el('div', 'msg tool');
    node.dataset.id = id;
    node.dataset.kind = 'tool';

    const head = el('div', 'tool-head');
    const chev = el('span', 'chev', '▶');
    head.appendChild(chev);
    head.appendChild(el('span', 'tool-name', name));
    // A brief (e.g. the path/command) so the collapsed card is still informative.
    head.appendChild(el('span', 'tool-brief', toolBrief(name, args)));
    const status = el('span', 'tool-status running', tr('running'));
    status.dataset.role = 'status';
    head.appendChild(status);
    // The call's own duration, right after its status: `start` for a call that is
    // running, `ms` for one that is already over (a repaint of history). Neither is
    // passed while a call is still streaming its arguments — nothing has started yet,
    // so the card deliberately shows no chip.
    syncElapsed(head, 'tool-elapsed', start, ms);
    node.appendChild(head);

    const body = el('div', 'tool-body hidden');
    if (args && args !== '{}') {
      body.appendChild(el('pre', 'tool-args', describeArgs(args)));
    }

    head.addEventListener('click', () => {
      markUserTouched(body);
      setBlockOpen(body, body.classList.contains('hidden'));
    });

    node.appendChild(body);

    if (usage) {
      node.appendChild(el('div', 'usage-line', formatUsage(usage)));
    }

    node._statusEl = status;
    node._bodyEl = body;

    // Optional eager expand; folded by default.
    if (!foldToolCalls) {
      body.classList.remove('hidden');
      chev.classList.add('open');
    }

    messagesEl.appendChild(node);
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

  function addLiveTool(index, id, name, args) {
    if (!messagesEl) return;
    const node = el('div', 'msg tool live');
    node.dataset.index = String(index);
    node.dataset.kind = 'tool';
    if (id) node.dataset.id = id;

    const head = el('div', 'tool-head');
    const chev = el('span', 'chev', '▶');
    head.appendChild(chev);
    const nameEl = el('span', 'tool-name', name || '');
    head.appendChild(nameEl);
    const status = el('span', 'tool-status streaming', tr('streaming'));
    status.dataset.role = 'status';
    head.appendChild(status);
    node.appendChild(head);

    const body = el('div', 'tool-body hidden');
    const argsEl = el('pre', 'tool-args');
    const argsText = document.createTextNode(args || '');
    argsEl.appendChild(argsText);
    body.appendChild(argsEl);
    node.appendChild(body);

    head.addEventListener('click', () => {
      markUserTouched(body);
      setBlockOpen(body, body.classList.contains('hidden'));
    });

    node._nameEl = nameEl;
    node._statusEl = status;
    node._bodyEl = body;
    node._argsText = argsText;
    node._argsEl = argsEl;

    messagesEl.appendChild(node);
    liveBucket(undefined, true)[index] = node;
    followActive();
    return node;
  }

  function appendLiveTool(index, id, nameDelta, argsDelta) {
    const bucket = liveBucket(undefined, true);
    let node = bucket[index];
    if (!node) {
      node = addLiveTool(index, id, '', '');
    }
    if (id) node.dataset.id = id;
    if (argsDelta && node._argsText) node._argsText.appendData(argsDelta);
    if (argsDelta) node._argsEl.textContent = (node._argsEl.textContent || '') + argsDelta;
    // Still streaming its arguments: the call is the live block.
    setActive(node._bodyEl);
    followActive();
    return node;
  }

  function finalizeLiveTool(index, id, name, args, start, ms) {
    if (!messagesEl) return;
    const bucket = liveBucket(undefined, false);
    const indexed = index !== undefined && index !== null;
    let node = indexed && bucket ? bucket[index] : null;
    if (!node && id) {
      node = messagesEl.querySelector('.msg.tool.live[data-id="' + id + '"]');
    }
    if (!node) {
      return addTool(name, args, id, undefined, start, ms);
    }
    if (indexed && bucket) delete bucket[index];
    if (id) node.dataset.id = id;
    delete node.dataset.index;
    node.classList.remove('live');

    if (name) node._nameEl.textContent = name;
    node._statusEl.className = 'tool-status running';
    node._statusEl.textContent = tr('running');
    // The arguments are settled, so the call is *running* now: that is the moment its
    // elapsed chip is born (a card that is still streaming args deliberately has none).
    const head = byClass(node, 'tool-head');
    if (head) syncElapsed(head, 'tool-elapsed', start, ms);

    node._bodyEl.innerHTML = '';
    if (args && args !== '{}') {
      node._bodyEl.appendChild(el('pre', 'tool-args', describeArgs(args)));
    }
    // The arguments are settled but the call is still running, so it stays live.
    setActive(node._bodyEl);
    followActive();
    return node;
  }

  /**
   * Drop live tool cards. With no owner (the legacy shape: the message carried no
   * nodeId) every live card goes, exactly as before; with one, only that node's
   * cards are cleared so a run finishing on another node keeps its own.
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

  function updateTool(id, content, ms) {
    if (!messagesEl) return;
    const node = toolNodeById(messagesEl, id);
    if (!node) return;
    const statusEl = node.querySelector('.tool-status');
    if (statusEl) {
      statusEl.className = 'tool-status done';
      statusEl.textContent = tr('done');
    }
    // The call is over: freeze the chip at the host's own duration. A host that
    // predates the field sends none, and then the chip goes rather than ticking on
    // forever over a call that has already reported its result.
    const head = byClass(node, 'tool-head');
    if (head) syncElapsed(head, 'tool-elapsed', null, ms);
    const body = node.querySelector('.tool-body');
    if (body) {
      body.appendChild(el('pre', 'tool-result', content));
      // The call reported its result, so it is not the live block any more: it takes
      // the fold default back. The result is in the body either way — one click away.
      clearActive(body);
    }
    followActive();
  }

  function setToolStatus(id, status) {
    if (!messagesEl) return;
    const node = toolNodeById(messagesEl, id);
    if (!node) return;
    const statusEl = node.querySelector('.tool-status');
    if (statusEl) {
      if (status === 'done') {
        statusEl.className = 'tool-status done';
        statusEl.textContent = tr('done');
      } else {
        statusEl.className = 'tool-status running';
        statusEl.textContent = tr('running');
      }
    }
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
    messagesEl.appendChild(node);
    followActive();
    return node;
  }

  /**
   * Render a node's stored items into its card, zone by zone: the user ask to
   * `.node-ask` (zone 1), everything else to `.node-work` (zone 2), and — as the
   * very last step — the trailing answer run to `.node-answer` (zone 3) through
   * `syncAnswerZone`, the *same* promotion the live path uses. There is no second
   * "render the answer" code path, so a repaint and a live turn cannot disagree
   * about where the answer lives.
   *
   * Derives its own containers from `card` (the caller no longer passes them) and
   * still sets messagesEl/promptEl to them for the duration: every `add*` helper
   * writes into those two globals, and they must be the node's own containers while
   * its items are painted (a repaint of one node is not allowed to append into
   * another node's transcript).
   *
   * `virtual` is the caller's "this node is finished" answer (a running node's items
   * are appended in place as they arrive, and the streaming path reads the
   * container's last child back to continue it, so it must never be re-rendered
   * from a slice): a finished node with more than `VIRTUAL_ITEM_THRESHOLD` work items
   * renders the window around its newest content instead of the whole log. The
   * window is the work list only — the answer run is never windowed (see below).
   */
  function renderNodeItems(card, items, virtual) {
    const workEl = card.querySelector('.node-work');
    const askEl = card.querySelector('.node-ask');
    const answerEl = card.querySelector('.node-answer');
    const answerWrap = card.querySelector('.node-answer-wrap');
    if (!workEl || !askEl) return;
    // A full render clears both zones, which is the one way a position can be thrown
    // away with nothing to be said for it: keep what each zone remembers and hand it
    // back once the items are in. On a card's *first* render there is nothing to hand
    // back (`rememberScroll` has not seen a scroll yet) and `_needsBottomScroll` is
    // the positioning that render wants, so both cases fall through untouched.
    const keepWork = scrollMemory(workEl);
    const keepAnswer = scrollMemory(answerEl);
    workEl.innerHTML = '';
    if (answerEl) answerEl.innerHTML = '';
    askEl.innerHTML = '';
    // A window belongs to the list it was painted from; a full render replaces it.
    workEl._virt = null;
    // Whatever zone 3 held is gone with the clear above, so nothing anchors a
    // promotion any more and the "answer shown" state starts from scratch.
    card._answerAnchor = null;
    if (answerWrap) answerWrap.classList.add('hidden');
    card.classList.remove('has-answer');
    const prevMsg = messagesEl;
    const prevPrompt = promptEl;
    messagesEl = workEl;
    promptEl = askEl;
    // Split the items: the first `user` item is the pinned ask (a later one is
    // neither pinned nor rendered as an item — a continued turn re-sends nothing),
    // and the trailing run of real answers is zone 3.
    const work = [];
    const answer = [];
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
    // Only a *finished* card lifts its answer out: while the turn streams, the tail
    // is still growing (the next delta belongs after it), so the run stays in the
    // log and `endRun` promotes it once the turn is really over.
    if (!isCardStreaming(card)) {
      let at = work.length;
      while (at > 0 && isAnswerItem(work[at - 1])) at--;
      if (at < work.length) {
        for (let i = at; i < work.length; i++) answer.push(work[i]);
        work.length = at;
      }
    }
    if (virtual && work.length > VIRTUAL_ITEM_THRESHOLD) {
      if (!workEl._virtScroll) {
        const container = workEl;
        workEl._virtScroll = () => onItemsWindowScroll(container);
        workEl.addEventListener('scroll', workEl._virtScroll);
      }
      paintItemsWindow(workEl, {
        items: work,
        promptEl: askEl,
        // The card being repainted (`paintItemsWindow` re-anchors a promotion it
        // invalidates by rebuilding the elements it paints — see there).
        card,
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
      for (const item of work) renderItemInto(item);
    }
    // The answer run is rendered into zone 2 like any other item — after the window,
    // in plain order, never windowed (a run of answers is what the model *ended*
    // with, and it is the one part of the transcript nobody wants paginated).
    for (const item of answer) renderItemInto(item);
    messagesEl = prevMsg;
    promptEl = prevPrompt;
    syncAnswerZone(card);
    // Settle the log's visibility *after* the sync: zone 3 has taken its run by now,
    // so "the log has nothing in it" is the final answer (a pure-text turn hides the
    // wrapper and leaves no empty box). Before the sync the run is still in the log,
    // which is exactly why this cannot be decided up there — and a card whose log is
    // already hidden when its items arrive (an expansion that preceded them) would
    // otherwise stay hidden with a full log inside.
    const workWrap = card.querySelector('.node-work-wrap');
    if (workWrap) workWrap.classList.toggle('hidden', workEl.children.length === 0);
    // Last, because the fold depends on everything above: a repaint can have
    // promoted the run (`syncAnswerZone`) and can have hidden the log — both are
    // settled by now, and a header click the user made earlier is preserved
    // (`_workTouched`).
    autoWorkFold(card);
    // Now that the zones are painted and folded, a reader who was here before gets
    // their offset back (a folded log has nothing to scroll, so it keeps the offset
    // for the unfold — see `setWorkFold`). Follow owns a locked card, and
    // `_needsBottomScroll` is still the card opening at its newest content.
    if (!(card._itemScroll && card._itemScroll.locked) && !card._needsBottomScroll && !card.classList.contains('work-folded')) {
      restoreScroll(workEl, keepWork);
      restoreScroll(answerEl, keepAnswer);
    }
  }

  // ---- The three zones of a turn card ------------------------------------------
  // A turn card is read as three zones (see `createNodeCard`):
  //   1. `.node-ask`    — what the user asked for (pinned, Markdown);
  //   2. `.node-work`   — the work log: reasoning blocks, tool cards, notices,
  //                       background notices, HARNESS blocks and the assistant text
  //                       the turn went *through*;
  //   3. `.node-answer` — the model's final answer.
  // Zone 3 is not a second copy of the text: it is a *pretty print* of the trailing
  // answer run of zone 2, moved — `appendChild` — out of the log once the turn is
  // over, and moved back the moment anything is appended after it. So every element
  // lives in exactly one place in the DOM at any time, and there is no "which one is
  // the real answer" (a copy would be re-markdowned on every repaint, and a delta
  // would have to be written twice).
  //
  // Two rules make that safe:
  //  - a *streaming* turn never promotes (`isCardStreaming`): its tail is still
  //    growing, and the element the next delta continues is that tail;
  //  - anything appended into zone 2 demotes first, so an append lands *after* the
  //    answer rather than inside it. The choke point is `routeTo` (see there), plus
  //    `case 'notice'` for the one message shape that carries no nodeId.
  //
  // `card._answerAnchor` is the element that was zone 2's last child when the run
  // was promoted. While it is still the last child, nothing was appended after the
  // promotion, so the run is still the tail and the promotion is still the truth —
  // that is the whole test `syncAnswerZone` needs. It is `null` on a fresh card
  // (never promoted, and `undefined` reads as "no anchor" too) and after a demote.

  /**
   * Is this card's turn still streaming? Not a `meta.status` question: the tree's
   * status is a label, while a run that is live *now* is what decides whether the
   * tail of the log can be lifted out (it cannot — the next delta continues it).
   */
  function isCardStreaming(card) {
    const id = card.dataset.id;
    const meta = treeNodes[id];
    // A job card has no conversation at all (its body mirrors a background
    // terminal): it never finishes a turn and never gets a zone 3.
    if (meta && meta.kind === 'bg') return true;
    // A sub-agent card streams while *its own* run is live. The tree status lags
    // (`agentDone` is what ends it), and `_agentLive` is the flag `onAgentStart` /
    // `onAgentDone` set — the exact pair a promotion has to wait for.
    if (meta && meta.kind === 'agent') return card._agentLive === true;
    return runningNodes.has(id);
  }

  /**
   * The DisplayItem half of `isAnswerEl`: a stored answer is an assistant item that
   * is not an error bubble and carries text (a thinking-only item has neither
   * `text` nor anything to promote).
   */
  function isAnswerItem(item) {
    return !!item && item.kind === 'assistant' && !item.error && String(item.text || '').trim() !== '';
  }

  /**
   * Is this rendered element a promotable answer? The assistant message element
   * keeps its text on `_text` (see `addAssistant`) — reading the DOM back would be
   * wrong for a thinking-only message, whose `_text` is empty while its subtree is
   * not.
   */
  function isAnswerEl(node) {
    return !!node && node.dataset.kind === 'assistant' && !node.classList.contains('error') && String(node._text || '').trim() !== '';
  }

  /**
   * The maximal contiguous run of answer elements at the END of `workEl` — read off
   * the child list by index (not `previousElementSibling`): the run is a statement
   * about the log's children, and walking the list is also the one form the offline
   * webview checker's DOM stub can replay.
   */
  function trailingAnswerEls(workEl) {
    const run = [];
    const kids = workEl ? workEl.children : null;
    if (!kids) return run;
    for (let i = kids.length - 1; i >= 0; i--) {
      if (!isAnswerEl(kids[i])) break;
      run.unshift(kids[i]);
    }
    return run;
  }

  /**
   * Zone 3 gives its content back to the END of the log. `appendChild` per child, in
   * order, so the run keeps its order and lands after whatever the log ends with —
   * which is exactly what an append after the answer would have looked like had the
   * answer never been lifted out.
   *
   * Idempotent, and deliberately still doing its class bookkeeping when zone 3 is
   * already empty: the callers (every routed append) rely on the invariants it
   * restores, not on there having been something to move.
   */
  function demoteAnswer(card) {
    if (!card) return;
    const workEl = card.querySelector('.node-work');
    const answerEl = card.querySelector('.node-answer');
    if (workEl && answerEl) {
      // A snapshot of the live child list: `appendChild` moves a child out of it
      // while we iterate.
      for (const node of Array.prototype.slice.call(answerEl.children)) workEl.appendChild(node);
    }
    card._answerAnchor = null;
    const answerWrap = card.querySelector('.node-answer-wrap');
    if (answerWrap) answerWrap.classList.add('hidden');
    card.classList.remove('has-answer');
    const workWrap = card.querySelector('.node-work-wrap');
    // An *append* is what a demote precedes, so zone 2 has to be visible when this
    // returns — that is why this un-hides unconditionally instead of asking whether
    // the log has children right now (it usually has none yet: this runs immediately
    // before the very first delta of a turn is written). The empty log of a card
    // whose *whole* content is its answer is hidden by `promoteAnswer`, not here.
    if (workWrap) workWrap.classList.remove('hidden');
    // The answer is gone: the log is the card again, so it unfolds (unless the user
    // folded it by hand) — the same moment `has-answer` comes off.
    autoWorkFold(card);
  }

  /**
   * Lift the trailing answer run of the log out into zone 3: the model's final
   * answer, at its own scroll position, without the reasoning and tool noise above
   * it. Nothing outside this function decides what an answer is — it is the run
   * `trailingAnswerEls` finds, and the run is moved, never copied.
   */
  function promoteAnswer(card) {
    const workEl = card.querySelector('.node-work');
    const answerEl = card.querySelector('.node-answer');
    if (!workEl || !answerEl) return;
    for (const node of trailingAnswerEls(workEl)) answerEl.appendChild(node);
    // What the log was left with: the anchor of this promotion. `null` when the log
    // is empty now — and `syncAnswerZone`'s guard still holds for that (an empty log
    // has a `null` last child).
    card._answerAnchor = workEl.lastElementChild;
    const answerWrap = card.querySelector('.node-answer-wrap');
    if (answerWrap) answerWrap.classList.remove('hidden');
    card.classList.add('has-answer');
    if (workEl.children.length === 0) {
      const workWrap = card.querySelector('.node-work-wrap');
      if (workWrap) workWrap.classList.add('hidden');
    }
    // The answer is what the card is about now: fold the log away (unless the user
    // owns this card's fold — see `autoWorkFold`).
    autoWorkFold(card);
  }

  /**
   * Bring a finished card's zone 3 in line with its log, in one place: promote the
   * trailing answer run when there is one, demote when there is not. Called at every
   * point where the log can have gained or lost its tail (a repaint, the end of a
   * run, the end of a sub-agent run) — never from the streaming path itself, which
   * is why a delta cannot move the answer zone out from under itself.
   */
  function syncAnswerZone(card) {
    if (!card) return;
    if (isCardStreaming(card)) { demoteAnswer(card); return; }
    const workEl = card.querySelector('.node-work');
    const answerEl = card.querySelector('.node-answer');
    if (!workEl || !answerEl) return;
    // Nothing newer than the promotion happened: it is still the tail.
    if (answerEl.children.length > 0 && workEl.lastElementChild === card._answerAnchor) return;
    if (trailingAnswerEls(workEl).length > 0) promoteAnswer(card);
    else demoteAnswer(card);
  }

  // ---- Zone 2's fold: the work log as a one-line header -------------------------
  // Round two of the three-zone card. The log used to be a capped scroller (see
  // `.node.has-answer .node-work` in style.css) sitting under the answer: a long
  // turn still pushed the answer down. Now zone 2 folds *to its header* whenever
  // zone 3 is showing — the card reads ask → answer, and the log is one click away.
  //
  // The state lives on the card, exactly like the block-level `_userTouched`:
  //   `_workFolded`  — the log is folded right now (mirrored by the card class
  //                    `work-folded`, which the CSS keys off);
  //   `_workTouched` — this card was handed to the user for good: a click on the
  //                    header, or a released follow light (`attachLock` — the one
  //                    gesture that says "I am reading this"), and from then on
  //                    `autoWorkFold` refreshes the label but never the state.
  // The automatic rule is not a settings default: it is re-evaluated every time a
  // promotion can have flipped `has-answer` (the four hooks below), because the
  // same turn can go answer → more work → answer again.
  /** The tree kind of the node a card renders; `turn` for the ordinary ones. */
  function kindOf(card) {
    const meta = card && treeNodes[card.dataset.id];
    return (meta && meta.kind) || 'turn';
  }

  /**
   * Refresh one card's work-log header: the chevron from the fold state, the label
   * from the live step count. Idempotent and cheap (`_workFolded` plus one
   * `querySelectorAll`), so every path that can change either — a fold, a tool call
   * that just started, a whole repaint — may simply call it.
   */
  function updateWorkHead(card) {
    if (!card) return;
    const workEl = card.querySelector('.node-work');
    const n = workEl ? workEl.querySelectorAll('.msg.tool').length : 0;
    const head = card.querySelector('.node-work-head');
    if (!head) return;
    const chev = byClass(head, 'chev');
    // `open` means the log is showing, the same sense it has on a block header.
    if (chev) chev.classList.toggle('open', !card._workFolded);
    const label = byClass(head, 'node-work-label');
    if (label) label.textContent = n === 0 ? tr('Work log') : tr('Work log · {0} steps', n);
  }

  /**
   * Fold or unfold one card's work log. A job card's zone 2 is a terminal mirror,
   * not a conversation (it has no answer to make room for), so this never touches
   * one — its header is display-hidden anyway (see `renderBgBody`).
   */
  function setWorkFold(card, folded) {
    if (!card || kindOf(card) === 'bg') return;
    card._workFolded = !!folded;
    card.classList.toggle('work-folded', card._workFolded);
    const head = card.querySelector('.node-work-head');
    if (head) {
      const chev = byClass(head, 'chev');
      if (chev) chev.classList.toggle('open', !card._workFolded);
    }
    updateWorkHead(card);
    // The fold is also the moment the 1:2 rule starts or stops applying, so the
    // body's definite height is settled with it (see `settleAnswerSplit`).
    settleAnswerSplit(card);
    // Unfolding is the moment the log is a scroller again, so it is also the moment
    // the two things this card remembers can be applied — and it is the *only* moment
    // for a card that opened with its log folded: the promotion that lifts the answer
    // into zone 3 folds the log in the same pass, and a `scrollTop` written into a
    // `display: none` scroller is thrown away, so `_needsBottomScroll` waits here.
    if (card._workFolded) return;
    const work = card.querySelector('.node-work');
    if (!work) return;
    if (card._needsBottomScroll) {
      work.scrollTop = work.scrollHeight;
      card._needsBottomScroll = false;
      return;
    }
    // Everything else is the reader's: give back the offset they had (nothing to give
    // while follow owns the card — `settleAnswerSplit` above already skipped it).
    if (card._itemScroll && card._itemScroll.locked) return;
    restoreScroll(work, scrollMemory(work));
  }

  /**
   * The automatic rule: the log is folded exactly while the answer is showing
   * (`has-answer`), and unfolded when it is not — a streaming turn, or a turn whose
   * whole content stayed in the log. Called from every point where a promotion can
   * have flipped that class (`promoteAnswer` / `demoteAnswer` / `renderNodeItems`)
   * and from `config` when the default itself changed. A card the user clicked on
   * is theirs (`_workTouched`): only its header text is refreshed here.
   */
  function autoWorkFold(card) {
    if (!card) return;
    if (kindOf(card) === 'bg') return;
    if (card._workTouched) { updateWorkHead(card); settleAnswerSplit(card); return; }
    setWorkFold(card, foldWork && card.classList.contains('has-answer'));
  }

  // ---- How the two zones share the card -----------------------------------------
  // The share is a **priority, not a ratio** (a hard 1:2 lock was tried and was wrong:
  // it divided the card even when neither zone needed its half, so a short answer sat
  // above a block of blank space while the log scrolled inside a third of the card —
  // see the `flex-basis: 0` note in the CSS). The answer comes first; the log takes
  // the answer's own height — and nothing else — grows the card. The log is a strip that
  // scrolls: a conversation that grows in zone 2 must not stretch the card, and a height
  // the user dragged is a budget they asked for (its leftover belongs to the log, the
  // answer taking only what it needs). The measurement below is what makes that possible:
  // with the split suspended (`SPLIT_MEASURE`) both zones report their natural height, and
  // only then can either be given "what it needs" instead of a guessed share.
  const SPLIT_MEASURE = 'split-measure';
  /**
   * The one case where the log's own wrapper may hug its content during that read: the
   * log is already showing everything it holds, so it has no offset to lose (see
   * `settleAnswerSplit`, and the matching rule in style.css).
   */
  const SPLIT_MEASURE_LOG = 'split-measure-log';
  /**
   * The log's own strip: what it shows while scrolling, by default. It is the one number
   * that decides how much of the process stays visible under an answer, and dragging the
   * card taller gives the log the leftover of that height — so a user who wants more room
   * asks for it, and the card does not grow behind their back.
   */
  const LOG_FLOOR_PX = 360;
  /**
   * The floor the two zones share when an answer is showing. A card may not be shrunk
   * out of `header + prompt + composer + this` — the drag's own floor (`MIN_H`) is a
   * flat 260px, which a long prompt and the input pane already eat on their own, and
   * the zones were squeezed to zero: a log with no height cannot be unfolded again.
   */
  const SPLIT_FLOOR_PX = 220;

  /** Everything in the card except the body: head, the pinned ask, the composer, border. */
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

  /**
   * The height this card may reach: what the user dragged, else the stylesheet's cap.
   * Deliberately NOT `card.style.maxHeight`: the tree layout writes its stretch target
   * there (`height` + a matching `max-height`, only ever growing a card), so reading the
   * inline style back would treat the *folded* card's height as a hard cap — unfolding a
   * log then divided those few pixels and the log came back with no height at all, with
   * the max-height pinning the card so it could not grow out of it.
   */
  function cardHeightCap(card) {
    const meta = treeNodes[card.dataset.id];
    const dragged = meta && meta.size && meta.size.h ? meta.size.h : 0;
    if (dragged > 0) return dragged;
    return stylesheetCap();
  }

  /** The card's own cap from the stylesheet (`--node-max-h`), for a host with styles. */
  function stylesheetCap() {
    const root = typeof document !== 'undefined' && document.documentElement;
    const cs =
      root && typeof window !== 'undefined' && window.getComputedStyle
        ? window.getComputedStyle(root)
        : null;
    const value = cs && cs.getPropertyValue ? parseFloat(cs.getPropertyValue('--node-max-h')) : NaN;
    // The stylesheet's own number, for a host that reports nothing at all.
    return value > 0 ? value : 1200;
  }

  /**
   * Settle how the answer and the log share this card. One state (`answer-split`): the
   * answer is pinned to the share measured for it and the log fills the rest of the body.
   * An answer is not required — while a turn runs there is no zone 3 yet, and this is what
   * keeps the card from stretching with every tool call. Nothing is written when the rule
   * does not apply (a folded log, a collapsed card) or when the host has no layout at all:
   * the offline webview checker measures 0, and a height written on a guess — or a split
   * class with no measurement behind it — would be worse than none.
   *
   * This function runs on every routed append and on every repaint, and it is the one
   * step that can move a reader: the answer zone is *measured* by letting it hug its
   * content, and the log's own measurement used to do the same to the one scroller in
   * the card (see the tail of this function and the `split-measure` rule in style.css).
   */
  function settleAnswerSplit(card) {
    if (!card || kindOf(card) === 'bg') return;
    const body = card.querySelector('.node-body');
    const workWrap = card.querySelector('.node-work-wrap');
    const answerWrap = card.querySelector('.node-answer-wrap');
    if (!body || !workWrap || !answerWrap) return;
    // Where the two zones were before this pass touches anything, and whether follow
    // owns the card: a locked card is pinned to its newest content by its caller, and
    // must never be handed back to an older offset. A zone the reader never scrolled
    // has no offset to give back (`null`), so a fresh card still opens where its own
    // rules put it.
    const workEl = card.querySelector('.node-work');
    const answerEl = card.querySelector('.node-answer');
    const keepWork = scrollMemory(workEl);
    const keepAnswer = scrollMemory(answerEl);
    const following = !!(card._itemScroll && card._itemScroll.locked);
    const wanted = card.classList.contains('expanded') && !card.classList.contains('work-folded');
    let bodyH = 0;
    let answerH = '';
    let split = false;
    let lifted = false;
    if (wanted) {
      // One read with the split suspended (see the CSS): what the two zones would be
      // if nothing divided them. The answer's inline height from the *previous* pass is
      // cleared for the read: `flex-basis: auto` takes a set height as the basis, so the
      // measurement would read the old share instead of the content — and once a pass
      // squeezed the answer it measured small and was given small forever after (the
      // answer could never grow back, however far the card was scaled up). The writes at
      // the end of this function re-apply whatever this pass decides.
      answerWrap.style.height = '';
      card.classList.add(SPLIT_MEASURE);
      const work = workEl;
      // The log reserves a strip under itself for its scroll-lock dot (a margin) —
      // without it the log would still miss those pixels and scroll by them.
      const strip = cssPx(work, 'marginBottom');
      // Two ways to read the log's natural height, and choosing between them is the
      // whole point of this measurement. A log that is *already showing everything it
      // holds* has no offset a reader could lose (`0` is the only representable one),
      // so it may be let onto a content basis for one read and measured the way every
      // card used to be: the wrapper's own `offsetHeight`. A log that DOES overflow is
      // read off its own `scrollHeight` — the number the stretched wrapper stood in for
      // — and its box is left alone, because stretching a scroller to the height of its
      // own content leaves it with nothing to scroll over and the engine clamps its
      // `scrollTop` to 0. That is how a card the reader had unlocked to inspect an older
      // tool call was thrown back to the top of its log by every token the agent
      // emitted, and a locked card hid it by re-pinning itself to the bottom right
      // after. `scrollHeight` is floored at the box height, which is exactly why the
      // no-overflow case cannot use it and hugs instead. The strip is counted twice,
      // as the wrapper read counted it: this number is a floor comparison, and no
      // card's share may move with this change.
      const overflows = !!work && (work.scrollHeight || 0) > (work.clientHeight || 0);
      if (!overflows) card.classList.add(SPLIT_MEASURE_LOG);
      const head = card.querySelector('.node-work-head');
      const logChrome =
        cssPx(workWrap, 'paddingTop') +
        cssPx(workWrap, 'paddingBottom') +
        (head ? head.offsetHeight || 0 : 0) +
        cssPx(head, 'marginBottom') +
        strip;
      const logH = overflows
        ? (work.scrollHeight || 0) + logChrome + strip
        : (workWrap.offsetHeight || 0) + strip;
      const answerNatural = answerWrap.offsetHeight || 0;
      if (!overflows) card.classList.remove(SPLIT_MEASURE_LOG);
      card.classList.remove(SPLIT_MEASURE);
      if (logH + answerNatural > 0) {
        const others = cardFixedHeight(card);
        // Two things can leave the card unable to *give* the split the room it computes:
        // a stored size the user dragged smaller than the parts need, and an inline
        // `max-height` the tree layout left behind — its stretch target is measured from
        // the card as it *was*, so a card unfolded later carries a stale, smaller one.
        // Either way the card is clipped and the zones are squeezed instead of divided
        // (the log ended up with no height at all and could not be unfolded). So the cap
        // is never below the usable minimum, and the card's own inline limit is lifted to
        // it — in the card's style and in the layout's copy of the size, so a relayout
        // restores the lift rather than the squeeze. (A relayout re-derives the stretch
        // from the card's new height anyway, and the stretch only ever grows a card.)
        const cap = Math.max(cardHeightCap(card), others + SPLIT_FLOOR_PX);
        const inlineMax = parseFloat(card.style.maxHeight);
        if (inlineMax > 0 && inlineMax < cap) {
          card.style.maxHeight = cap + 'px';
          lifted = true;
        }
        // The stretch writes `height` *and* `max-height`: raising only the cap leaves the
        // card at the stretched height (an inline `height` is not a cap), and the body —
        // with the log, the one zone that has no height of its own — is squeezed to
        // nothing while the pinned answer keeps showing. Dropping a too-small inline
        // height is safe: the next relayout re-derives the stretch from the card's own
        // height, and a stretch only ever grows a card.
        const inlineH = parseFloat(card.style.height);
        if (inlineH > 0 && inlineH < cap) {
          card.style.height = '';
          lifted = true;
        }
        const meta = treeNodes[card.dataset.id];
        if (meta && meta.size && meta.size.h < cap) {
          meta.size.h = cap;
          card.style.maxHeight = cap + 'px';
          lifted = true;
        }
        const room = Math.max(0, cap - others);
        // The log shows a strip: `LOG_FLOOR_PX` at most, its whole content when that is
        // shorter (nothing blank when a turn is short). Its *growth* is not the card's
        // business — a longer conversation scrolls in the strip.
        const floor = Math.min(LOG_FLOOR_PX, room * 0.5);
        // The answer comes first, and it is what grows the card.
        const answerShare = Math.min(answerNatural, Math.max(0, room - floor));
        let logShare = Math.min(logH, floor);
        const dragged = meta && meta.size && meta.size.h ? meta.size.h : 0;
        if (dragged > 0) {
          // An explicit card height is a budget the user asked for: the answer already
          // takes only what it needs, so the leftover of that height is the log's.
          logShare = Math.max(logShare, Math.min(logH, room - answerShare));
        }
        bodyH = Math.min(room, answerShare + logShare);
        answerH = answerShare;
        split = true;
      }
    }
    // One state, not two: the split is either settled — with measurements behind it — or
    // it is not, and then the base CSS keeps both zones content-sized.
    card.classList.toggle('answer-split', split);
    const setH = (el, value) => {
      if (el.style.height === value) return false;
      el.style.height = value;
      return true;
    };
    // Both writes report whether they changed anything: a style write costs a layout,
    // and the relayout below is only worth it when something really moved — the card's
    // own limits being lifted counts, because the card's size just changed.
    // `bodyH` is a number, and a unitless one is silently dropped by the CSSOM (`style
    // .height = 762.3` is not a length) — the `px` here is not decoration: without it the
    // body kept its content height, the log (the zone with a zero basis) lost everything
    // and only the answer — which has a height of its own — kept showing.
    const movedBody = setH(body, bodyH ? bodyH + 'px' : '');
    const movedAnswer = setH(answerWrap, answerH ? answerH + 'px' : '');
    if (movedBody || movedAnswer || lifted) {
      // The card's size just changed and the tree places cards by measured height:
      // hand it a relayout (debounced) instead of leaving a neighbour overlapping.
      scheduleLayout();
    }
    // The measurement is over and the real heights are written back, so the offsets
    // the reader had can go home. Never while follow owns the card (a locked card is
    // pinned to its newest content by the caller) and never while `_needsBottomScroll`
    // is pending: that flag *is* the card opening at its newest content, which is not
    // where the reader was.
    if (!following && !card._needsBottomScroll) {
      restoreScroll(workEl, keepWork);
      restoreScroll(answerEl, keepAnswer);
    }
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
    // A paint rebuilds every element it renders, so the card's promotion anchor —
    // a reference to the element that was the container's last child when the run
    // left — dangles once that element is re-created. A dangling anchor reads as
    // "the log grew after the promotion", and the next `syncAnswerZone` would demote
    // a finished card's answer back into the log for no reason: a repaint is not an
    // append, so the anchor is re-recorded as the last child it now has. This is the
    // one repaint of zone 2 that does not go through `renderNodeItems`.
    if (state.card && state.card._answerAnchor) state.card._answerAnchor = container.lastElementChild;
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

  // Render a stored DisplayItem into the current target container (messagesEl).
  function renderItemInto(item) {
    if (item.kind === 'user') {
      addUserPrompt(item.text, item.attachments);
    } else if (item.kind === 'harness') {
      addHarnessNote(item.text);
    } else if (item.kind === 'assistant') {
      addAssistant(item.text, item.error, item.thinking);
      if (item.usage) {
        const last = messagesEl.lastElementChild;
        if (last) last.appendChild(el('div', 'usage-line', formatUsage(item.usage)));
      }
    } else if (item.kind === 'notice') {
      addNotice(item.noticeKind, item.text);
    } else if (item.kind === 'background') {
      addBackgroundNotice(item);
    } else if (item.kind === 'tool') {
      const toolId = item.id || 'history-' + item.name + '-' + (item.status || '');
      // The stored duration travels with the item: a repainted call that is still
      // running ticks again, a finished one shows the host's frozen value.
      addTool(item.name, item.args, toolId, item.usage, item.status === 'running' ? item.startedAt : null, item.ms);
      if (item.status === 'done' && item.content) {
        setToolStatus(toolId, 'done');
        const node = messagesEl.querySelector('[data-id="' + toolId + '"]');
        if (node) {
          const body = node.querySelector('.tool-body');
          if (body) {
            body.appendChild(el('pre', 'tool-result', item.content));
            // Folded by default; the result is there but hidden until expanded.
            if (!foldToolCalls) body.classList.remove('hidden');
          }
        }
      }
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
    // A job card's body is a terminal mirror, not a conversation: there is nothing
    // to fold, so its work-log header stays out of the way (and `setWorkFold` /
    // `autoWorkFold` refuse a `kind:'bg'` card anyway).
    const workHeadEl = card.querySelector('.node-work-head');
    if (workHeadEl) workHeadEl.classList.add('hidden');
    // A job card's zone 2 *is* its body, and a job card can never be promoted (it
    // has no conversation — see `isCardStreaming`), so the log must stay visible
    // even though the card starts out with nothing to show.
    const workWrap = card.querySelector('.node-work-wrap');
    if (workWrap) workWrap.classList.remove('hidden');
    itemsEl.innerHTML = '';
    const running = !!(task && task.status === 'running');
    card.classList.toggle('bg-running', running);
    card.classList.toggle('bg-done', !running);

    const statusEl = card.querySelector('.node-status');
    if (statusEl) statusEl.textContent = statusTextFor(task, meta);

    const row = el('div', 'bg-card-status');
    row.appendChild(el('span', 'bg-card-id', '#' + (meta && meta.bgTaskId != null ? meta.bgTaskId : '')));
    const status = el('span', 'bg-status' + (task && task.pendingDelivery ? ' pending' : ''), statusTextFor(task, meta));
    row.appendChild(status);
    // The chip is shown whenever a duration is known — a running job ticks, and a
    // finished one freezes: at its own `finishedAt` while the snapshot still carries
    // it (a finished-but-undelivered job), else at the duration persisted on the
    // node, which is all a record card restored after a restart has left.
    syncElapsed(
      row,
      'bg-elapsed',
      running && task ? task.startedAt : null,
      running
        ? null
        : task && typeof task.finishedAt === 'number'
          ? task.finishedAt - task.startedAt
          : typeof meta.bgElapsedMs === 'number'
            ? meta.bgElapsedMs
            : null,
    );
    itemsEl.appendChild(row);

    const cmd = el('div', 'bg-card-cmd', (meta && meta.bgCommand) || (task && task.command) || '');
    itemsEl.appendChild(cmd);

    const tail = outputTailFor(task, meta);
    if (tail) {
      itemsEl.appendChild(el('pre', 'bg-output', tail));
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
   * reads the outcome with `check_background_terminal` if it wants it.
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
        'This job does not block the composer and will not notify the agent; read its result with check_background_terminal.';
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

  /**
   * The **remote-origin badge**: this turn was started by a peer in a room, and the badge
   * names the device it came from (`docs/agents/plans/remote-control.md` §13). Source marking
   * is deliberately node metadata and never message text — the bytes sent to the provider do
   * not change, and the model is not told it is being driven from elsewhere — so the mark is
   * *rendered* here and nowhere else.
   *
   * Created/removed lazily and placed like every other head badge (just before the status
   * chip), so a repaint can never stack two of them, and a node that has no origin — every
   * ordinary local turn — carries no badge at all. `origin` arrives on each `tree` row (the
   * host reads it from the node) and survives a reload because the node persists it.
   */
  function syncOriginBadge(card, meta) {
    if (!card) return;
    const origin = meta && meta.origin;
    // A mark with no device and no peer id would be a badge saying nothing: the host's own
    // reader (`nodeOrigin`) drops those, and this does the same for a hand-made payload.
    const wanted = !!(origin && (origin.deviceName || origin.peerId));
    let badge = byClass(card, 'node-origin-badge');
    if (wanted && !badge) {
      const device = origin.deviceName || origin.peerId;
      badge = el('span', 'node-origin-badge', tr('Remote: {0}', device));
      badge.title = tr('This turn was started from another window in the room.');
      const head = card.querySelector('.node-head');
      const status = head.querySelector('.node-status');
      if (status) head.insertBefore(badge, status); else head.appendChild(badge);
      card.classList.add('remote-origin');
    } else if (!wanted && badge) {
      badge.remove();
      card.classList.remove('remote-origin');
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
    // The remote-origin badge has the same life: created with the card from the node's
    // own meta, so a repaint never has to add it later (and never adds a second one).
    syncOriginBadge(card, meta);

    // Zone 1: the pinned user ask (sticky at the top of an expanded card).
    const ask = el('div', 'node-ask');
    card.appendChild(ask);

    const body = el('div', 'node-body');
    // Zone 2: the work log. Its wrapper (not the scroller itself) is what gets the
    // `hidden` class, and it is the host of the green scroll-lock dot: the dot marks
    // the strip under the *log* (the container it locks), which is where a live turn
    // follows its own output. Zone 3 has no dot — it opens at the top and is read,
    // not followed.
    const workWrap = el('div', 'node-work-wrap');
    // Zone 2's one-line header (the fold control, see `setWorkFold`): it lives in
    // the wrapper — *before* the log — so hiding the wrapper (an empty log) hides
    // the header with it, and so the scroll-lock dot's host is untouched. The
    // chevron starts `open` because a fresh card's log is showing (the same sense
    // `open` has on a block header, and what `autoWorkFold` re-decides later); the
    // label is the live step count, written by `updateWorkHead` below.
    const workHead = el('div', 'node-work-head');
    workHead.appendChild(el('span', 'chev open', '▶'));
    workHead.appendChild(el('span', 'node-work-label'));
    workHead.addEventListener('click', (ev) => {
      // Stop the click at the header, as every other in-card control does (the card
      // is a checkout target) — and hand this card's fold to the user, so the
      // automatic rule never folds it back (see `autoWorkFold`).
      ev.stopPropagation();
      card._workTouched = true;
      setWorkFold(card, !card._workFolded);
    });
    const work = el('div', 'node-work');
    workWrap.appendChild(workHead);
    workWrap.appendChild(work);
    // Zone 3: the final answer, promoted out of the log (see `syncAnswerZone`).
    const answerWrap = el('div', 'node-answer-wrap hidden');
    const answer = el('div', 'node-answer');
    answerWrap.appendChild(answer);
    const excerpt = el('div', 'node-excerpt');
    excerpt.textContent = meta.preview || meta.title || '';
    // Order matters: log, answer, collapsed preview — the preview is what a
    // collapsed card shows *instead* of the two scrollers above it.
    body.appendChild(workWrap);
    body.appendChild(answerWrap);
    body.appendChild(excerpt);
    card.appendChild(body);

    // Drag handle to resize the card (bottom-right).
    const handle = el('div', 'node-resize');
    handle.title = tr('Drag to resize');
    card.appendChild(handle);

    // Internal transcript scroll + green lock dot. A live turn follows its own
    // output (locked); a finished node starts unlocked so it scrolls freely. The
    // card goes with it: releasing that light marks the card as the reader's
    // (`_workTouched`, see `attachLock`), so nothing folds the log under them.
    card._itemScroll = attachLock(work, workWrap, meta.status === 'running', card);

    // Both zones remember where their reader is (`rememberScroll`): a repaint, the
    // split measurement or a fold/unfold puts them back there — see the memory block
    // at the top — and this is the one place a card's zones are built.
    rememberScroll(work);
    rememberScroll(answer);

    // The header exists from here on and is never rebuilt, so its label is written
    // once at creation; every later change goes through the fold hooks.
    updateWorkHead(card);

    nodeEls[id] = card;
    // The node id on the element itself: the off-screen-skip observer (`cvObserver`) and the
    // "wake this card before writing into it" hook both hold an element and need its id.
    card._nodeId = id;
    treeCanvas.appendChild(card);
    if (cvObserver) cvObserver.observe(card);
    return card;
  }

  // ---- Lazy sidecar transcripts: only a few requests in flight at once --------
  // A `kind: 'agent'` node carries no transcript in the `tree` / `path` payload
  // (only `itemCount`), so each expanded card asks for it once — `_itemsRequested`
  // is the one-shot contract, and this queue changes only *when* that one request
  // is posted. A cold repaint re-expands every sidecar card of a session at once,
  // and that used to fire every request in the same burst: one measured session
  // (15 sub-agent cards) asked for 152 items each — ~5.35 M chars of answers and
  // 2692 DOM nodes in one frame, with the webview's handlers stuck at 900–999 ms
  // while they landed. So the requests are queued: at most
  // `AGENT_ITEMS_CONCURRENCY` are in flight, and an `agentItems` answer releases
  // the next one.
  //
  // Two rules keep the burst honest:
  //  - a repaint that needs exactly one transcript is not a burst: that request
  //    still goes out immediately (the contract the sidecar section of
  //    `tools/check-webview.js` pins);
  //  - where there *is* a layout (`IntersectionObserver`) only a card the user can
  //    see is worth a multi-hundred-KB answer: a card that enters the viewport is
  //    promoted ahead of the queue, and a card that is off-screen is never asked
  //    for — panning/zooming to it is what makes it ask.
  //
  // `agentItemsInFlight` counts every posted request, immediate ones included, so
  // every answer releases a slot. `reset` (a new session) drops the queue: those
  // cards are gone with the old tree.
  const AGENT_ITEMS_CONCURRENCY = 3;

  let agentItemsQueue = [];
  let agentItemsInFlight = 0;
  /** Cards queued *and* on screen — the ones the queue promotes. */
  const agentItemsVisible = new Set();
  const agentItemsObserver =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(onAgentItemsVisible, { root: null, rootMargin: '200px', threshold: 0 })
      : null;

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

  /** Does this card still want (and may still receive) its transcript? */
  function agentItemsWanted(id) {
    const card = nodeEls[id];
    return !!(card && card._itemsRequested && !card._itemsRendered);
  }

  /**
   * How many expanded cards of *this* repaint still need a transcript — the "is
   * this a burst?" question `requestAgentItems` asks. It counts the card asking
   * right now (`_itemsRequested` is already set for it, `_itemsRendered` is not)
   * and uses the same expansion predicate the repaint loops use, so it answers
   * with the sidecar cards that are actually on screen in the tree.
   */
  function pendingAgentCards() {
    let n = 0;
    for (const id in treeNodes) {
      const meta = treeNodes[id];
      const count = meta && (meta.itemCount || (pathNodes[id] && pathNodes[id].itemCount));
      if (!count || meta.kind !== 'agent') continue;
      const card = nodeEls[id];
      if (!card || card._itemsRendered) continue;
      if (!activePathSet.has(id) && !agentExpanded(id)) continue;
      n++;
    }
    return n;
  }

  /** Post one `loadAgentItems`; every posted request holds one in-flight slot. */
  function postAgentItems(id, card) {
    agentItemsInFlight++;
    if (agentItemsObserver && card) agentItemsObserver.unobserve(card);
    vscode.postMessage({ type: 'loadAgentItems', id });
  }

  /** Drop a queued card (its node is gone, or its transcript arrived elsewhere). */
  function forgetAgentItems(id) {
    const at = agentItemsQueue.indexOf(id);
    if (at >= 0) agentItemsQueue.splice(at, 1);
    agentItemsVisible.delete(id);
    const card = nodeEls[id];
    if (agentItemsObserver && card) agentItemsObserver.unobserve(card);
  }

  /** Fill the free slots, the cards in the viewport first; stop when none is. */
  function pumpAgentItems() {
    for (let i = 0; i < agentItemsQueue.length; i++) {
      if (!agentItemsWanted(agentItemsQueue[i])) forgetAgentItems(agentItemsQueue[i--]);
    }
    while (agentItemsInFlight < AGENT_ITEMS_CONCURRENCY && agentItemsQueue.length > 0) {
      const at = agentItemsQueue.findIndex((id) => agentItemsVisible.has(id));
      // Nothing on screen: the queue waits for the viewport to come to it (the
      // observer promotes the card when it does).
      if (at < 0) return;
      const id = agentItemsQueue.splice(at, 1)[0];
      agentItemsVisible.delete(id);
      postAgentItems(id, nodeEls[id]);
    }
  }

  /** A card entered or left the viewport: promote what the user is looking at. */
  function onAgentItemsVisible(entries) {
    let arrived = false;
    for (const entry of entries || []) {
      const id = entry && entry.target && entry.target.dataset ? entry.target.dataset.id : '';
      if (!id) continue;
      if (entry.isIntersecting) {
        agentItemsVisible.add(id);
        arrived = true;
      } else {
        agentItemsVisible.delete(id);
      }
    }
    if (arrived) pumpAgentItems();
  }

  /**
   * Ask the host for one card's transcript — the *one* request `expandedCard`
   * documents (see `_itemsRequested`). A lone request goes out right away; a
   * repaint that re-expands many sidecar cards queues them behind the cap.
   */
  function requestAgentItems(id, card) {
    card._itemsRequested = true;
    if (agentItemsObserver && pendingAgentCards() > 1) {
      agentItemsQueue.push(id);
      agentItemsObserver.observe(card);
      pumpAgentItems();
      return;
    }
    postAgentItems(id);
  }

  /** A new session: the queued cards are gone with the old tree. */
  function resetAgentItems() {
    for (const id of agentItemsQueue) {
      const card = nodeEls[id];
      if (agentItemsObserver && card) agentItemsObserver.unobserve(card);
    }
    agentItemsQueue = [];
    agentItemsVisible.clear();
    agentItemsInFlight = 0;
  }

  /** An `agentItems` answer (or a card the tree dropped) frees its slot. */
  function releaseAgentItems() {
    if (agentItemsInFlight > 0) agentItemsInFlight--;
    pumpAgentItems();
  }

  function expandedCard(id, meta, pnode) {
    const card = nodeEls[id];
    card.classList.add('expanded');
    card.classList.toggle('active', id === treeActiveId);
    const askEl = card.querySelector('.node-ask');
    const workEl = card.querySelector('.node-work');
    const workWrap = card.querySelector('.node-work-wrap');
    const answerWrap = card.querySelector('.node-answer-wrap');
    const answerEl = card.querySelector('.node-answer');
    const excerptEl = card.querySelector('.node-excerpt');
    // Populate from the path items, or (agent nodes) their own transcript; a
    // freshly-streamed node is filled incrementally, so never wipe it here.
    const source = pnode ? pnode.items : meta.items;
    if (source && !card._itemsRendered) {
      // A finished card with a long transcript renders a window of it (see
      // `renderNodeItems`); a running node keeps the full render, because its
      // items are appended in place as they arrive.
      renderNodeItems(card, source, meta.status !== 'running');
      card._itemsRendered = true;
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
    const pendingItems = (pnode && pnode.itemCount) || meta.itemCount || 0;
    const pendingKind = (pnode && pnode.kind) || meta.kind;
    if (pendingItems > 0 && pendingKind === 'agent' && !card._itemsRendered && !card._itemsRequested) {
      requestAgentItems(id, card);
    }
    askEl.classList.remove('hidden');
    // Zone 2 shows when it has a log to show. Un-hiding it unconditionally would
    // bring back the empty padded box of a pure-text turn (the whole turn is the
    // answer, so the log *is* empty) on every repaint — and hiding an empty log here
    // is safe, because every append into zone 2 is preceded by `demoteAnswer`, which
    // un-hides it again (a running card with nothing rendered yet is exactly that
    // case: the first delta un-hides it).
    workWrap.classList.toggle('hidden', workEl.children.length === 0);
    // Zone 3 is only un-hidden when it actually holds an answer: an empty answer
    // zone would be a blank strip under the log (and the card would claim
    // `has-answer`, which caps the log — see the CSS).
    if (answerEl && answerEl.children.length > 0) {
      answerWrap.classList.remove('hidden');
      // Belt and braces: the promotion that filled zone 3 may be stale (a repaint
      // can leave it pointing at a log that has grown since — see `_answerAnchor`).
      // Runs *before* the scroll positioning below, so the zone it may empty is not
      // the one just measured.
      syncAnswerZone(card);
    }
    // Not a follow target (no lock dot): zone 3 opens at the top, where an answer
    // starts — the end of an answer is not what a reader wants to see first. Once per
    // card, though: a repaint must give the band back where the reader left it (that
    // restore lives in `settleAnswerSplit`), and this write used to undo it on every
    // `tree` / `path` — the answer jumped back to its first line under the reader.
    if (answerEl && !card._answerOpened) {
      answerEl.scrollTop = 0;
      card._answerOpened = true;
    }
    excerptEl.classList.add('hidden');
    // The zones are on screen now, so the state that wants the 1:2 split can be
    // settled (a repaint re-measures; a hidden card cannot be measured at all).
    settleAnswerSplit(card);
    if (card._itemScroll && card._itemScroll.locked) {
      // Following a live turn: pin to the newest content.
      card._itemScroll.scrollToBottom();
      card._needsBottomScroll = false;
    } else if (card._needsBottomScroll && workEl && !card.classList.contains('work-folded')) {
      // Unlocked (finished) card: open at the newest content, then scroll freely —
      // but only once the log is really showing. A finished card usually opens with
      // its log folded (the promotion above hides it the moment there is an answer),
      // and a `scrollTop` written into a `display: none` scroller is thrown away, so
      // the flag stays pending and `setWorkFold` consumes it when the reader unfolds
      // the log — which is the moment this card's newest content first becomes
      // visible.
      workEl.scrollTop = workEl.scrollHeight;
      card._needsBottomScroll = false;
    }
  }

  function collapsedCard(id, meta) {
    const card = nodeEls[id];
    card.classList.remove('expanded', 'active');
    const askEl = card.querySelector('.node-ask');
    const workWrap = card.querySelector('.node-work-wrap');
    const answerWrap = card.querySelector('.node-answer-wrap');
    const excerptEl = card.querySelector('.node-excerpt');
    excerptEl.textContent = meta.preview || meta.title || '';
    // All three zones go: a collapsed card is its head plus the one-line preview.
    askEl.classList.add('hidden');
    workWrap.classList.add('hidden');
    if (answerWrap) answerWrap.classList.add('hidden');
    excerptEl.classList.remove('hidden');
  }

  function setActiveLeaf(id) {
    const card = id ? nodeEls[id] : null;
    // The routed transcript is zone 2. Zone 3 only ever holds elements moved out of
    // it (never the ones a stream appends), so nothing writes into it directly.
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
  }

  /**
   * The ▶ Continue (or ↻ Retry, or ⧉ Continue in a new window) button on a card
   * whose turn ended without an answer: interrupted by the user, or failed — an
   * API error that outlived the client's transparent retries. Clicking it asks the
   * harness to run a turn from that node with a message the harness writes itself,
   * so the user never has to type "continue".
   *
   * One button, one meaning at a time — the *variant* follows the node's state:
   *  - `error` + context `full` → rollover: the turn died because the provider
   *    refused an oversized request, which retrying cannot fix, so the harness
   *    opens a new, empty context window and continues there (`rolloverTurn`).
   *  - context `near` (>= 90% of the card's window) → the same `⧉` entry, but as a
   *    *suggestion*: the `node-near` class softens it and the tooltip carries the
   *    percentage, because this one is the user's call, not a failure to repair.
   *  - `error` (any other failure) → `↻ Retry`, in place.
   *  - `interrupted` → `▶ Continue`, in place.
   * The context state itself is the host's judgement and is never derived here.
   * The element is created once and only its text used to change; a sync now also
   * fixes its class list and `dataset.action`, so a card that goes Retry → rollover
   * (or back) is correct, and the click handler reads the action at click time.
   *
   * Shown only where continuing makes sense: a conversational turn node (never a
   * sidecar — a sub-agent window or job card has no conversation of its own here),
   * not currently running, and a *tip* of its branch (a node that already has a
   * turn child has been continued; the new failure, if any, shows on that child).
   * A `full` window is a *failure* mode, so it keeps the old gate — it only ever
   * arrives on an `error`. The `near` suggestion does not: a long conversation that
   * just *finished* above 90% is exactly the case it is for, so it shows on a `done`
   * tip as well.
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
    // The host's context state (§4.3): `full` — the provider refused an oversized
    // request; `near` — the latest prompt usage is at least 90% of the card's
    // window; `ok` — otherwise. `contextPct` only ever reaches the tooltip.
    const context = meta ? meta.context : undefined;
    const rollover = !!meta && meta.status === 'error' && context === 'full';
    // A suggestion, not a repair: it hangs off the context state alone, never off
    // the status, so a finished tip gets the entry too.
    const near = !rollover && context === 'near';
    const pct = meta && typeof meta.contextPct === 'number' ? Math.round(meta.contextPct) : 0;
    const label = rollover || near
      ? tr('⧉ Continue in a new window')
      : meta && meta.status === 'error'
        ? tr('↻ Retry')
        : tr('▶ Continue');
    const title = rollover
      ? tr('Ask the harness to continue this turn in a new, empty context window (the current one is full)')
      : near
        ? tr('Context is {0}% full - continue in a new window', pct)
        : meta && meta.status === 'error'
          ? tr('Ask the harness to retry this turn (it sends the message for you)')
          : tr('Ask the harness to continue from here (it sends the message for you)');
    const action = rollover || near ? 'rollover' : meta && meta.status === 'error' ? 'retry' : 'continue';
    const show = !!id && (terminal || near) && !hasTurnChild && !isSidecarKind(meta.kind) && !runningNodes.has(id);
    if (!show) {
      if (btn) btn.remove();
      return;
    }
    if (btn) {
      btn.textContent = label;
      btn.title = title;
      btn.classList.toggle('node-rollover', rollover || near);
      btn.classList.toggle('node-near', near);
      btn.dataset.action = action;
      return;
    }
    const button = el('button', 'node-continue' + (rollover || near ? ' node-rollover' : '') + (near ? ' node-near' : ''), label);
    button.title = title;
    button.dataset.action = action;
    button.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // Read the variant *now*: this one element is reused as the node's state
      // changes (Retry ⇄ rollover), so a captured action would go stale and post
      // the wrong request.
      const kind = button.dataset.action;
      vscode.postMessage(kind === 'rollover' ? { type: 'rolloverTurn', id } : { type: 'continueTurn', id });
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
    // `state`): the composer must agree with the host in both cases.
    const readonly = isAgent || readOnly;
    inputEl.disabled = readonly;
    sendBtn.disabled = readonly;
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

  // rAF-throttled relayout for a growing sub-agent card: its transcript grows as
  // it streams but followActive (which schedules the main layout) is suppressed
  // while routingSubAgent, so cards could overlap until agentDone. Throttle to
  // one relayout per frame so a fast stream repositions siblings without jank.
  let subAgentRelayoutRaf = null;
  function scheduleSubAgentRelayout() {
    if (subAgentRelayoutRaf != null) return;
    subAgentRelayoutRaf = requestAnimationFrame(() => {
      subAgentRelayoutRaf = null;
      relayout();
    });
  }

  // Route a streaming callback to a specific node's work log (its zone 2): every
  // streaming message carries the `nodeId` it belongs to (spec §2.1), so the
  // target is explicit and never inferred from the view — a node that streams
  // while the view sits elsewhere still gets its deltas in its own (collapsed)
  // card. A *missing* nodeId is the legacy shape (the main agent's turn before
  // P1): the callback then writes into the current view-focus container, exactly
  // as it always did. Either way the target card is demoted first (its answer zone
  // gives its run back), and after writing the card's transcript follows to the
  // bottom (respects that card's scroll lock).
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
      if (focus) demoteAnswer(focus);
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
    // The one choke point every routed append goes through: a card that is showing
    // its answer in zone 3 takes that answer back into the log *first*, so what the
    // callback appends lands after the answer and the run is no longer the tail
    // (which is what `syncAnswerZone` reads to decide the promotion is over).
    demoteAnswer(card);
    const prevMsg = messagesEl;
    const prevPrompt = promptEl;
    const prevRouting = routingSubAgent;
    const prevNode = routingNodeId;
    messagesEl = itemsEl;
    promptEl = card.querySelector('.node-ask');
    routingSubAgent = true;
    routingNodeId = nodeId;
    try {
      fn();
    } finally {
      messagesEl = prevMsg;
      promptEl = prevPrompt;
      routingSubAgent = prevRouting;
      routingNodeId = prevNode;
    }
    if (card && card._itemScroll) card._itemScroll.scrollToBottom();
    // The append this routed may have been a tool call: the header's step count is
    // the one piece of the log that lives *outside* it, so it is refreshed here —
    // right where the card's own scroll was just caught up.
    updateWorkHead(card);
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
    // A live sub-agent card is a *streaming* card (see `isCardStreaming`): the log is
    // the truth while it runs, so a previous run's answer comes out of zone 3 before
    // this one appends anything. The flag is set before that, or the demote below
    // would be undone by the very next `syncAnswerZone`.
    card._agentLive = true;
    card.classList.add('agent');
    card.classList.add('expanded');
    card.querySelector('.node-work-wrap').classList.remove('hidden');
    demoteAnswer(card);
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
    info.textContent = tr('d{0} · {1} · {2}', msg.depth || 1, msg.model || '', msg.write ? tr('write') : tr('ro'));
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
      // Its run is over: the card stops being a streaming card here, and only now
      // may its tail be promoted (`isCardStreaming`) — set *before* the finalize
      // below, which routes through the demote that every routed append does.
      card._agentLive = false;
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
      // Its own run is over and its finalize went in: the tail of the log is the
      // sub-agent's answer now. The promotion happens here and not in the summary
      // branch above — a card that already showed zone 3 keeps it (the anchor still
      // ends the log), and one that grew since promotes again.
      syncAnswerZone(card);
    }
    const edge = treeEdges.querySelector('[data-agent="' + msg.id + '"]');
    if (edge) {
      edge.classList.toggle('edge-done', msg.status === 'done');
      edge.classList.toggle('edge-error', msg.status === 'error');
    }
    relayout();
  }

  /**
   * Undo the stretch the previous layout pass applied, before anything is measured.
   *
   * A stretched card carries an inline `height` **and** a matching `max-height`
   * (`.node` caps every card at 1200px, so `height` alone would be clipped). Both
   * have to be gone before `relayout()` reads `offsetHeight`: an inline height is
   * what the browser would report back as the card's height, so measuring it as the
   * *natural* height and then stretching that card again would add the grid's free
   * space a second time — the layout would creep taller on every frame.
   *
   * `max-height` is restored from `treeNodes[id].size.h` when it exists: that value
   * is a *manual* resize the user owns (set by `createNodeCard` and committed by
   * `endResize`, which persists it as `setNodeSize`), not something a layout pass
   * may wipe. Everything else falls back to the CSS default ('').
   */
  function clearStretchHeights() {
    for (const id of Object.keys(layoutStretch)) {
      const card = nodeEls[id];
      if (card) {
        const meta = treeNodes[id];
        card.style.height = '';
        card.style.maxHeight = meta && meta.size && meta.size.h ? meta.size.h + 'px' : '';
      }
      delete layoutStretch[id];
    }
  }

  function relayout() {
    // Clear first (see `clearStretchHeights`): every pass measures the cards'
    // NATURAL heights, so no card may still carry the previous pass's stretch when
    // the measurement below runs.
    clearStretchHeights();
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
    // Measure the cards' own, natural heights (the clear above took every inline
    // height off): these are what the layout stretches from, and the baseline a
    // `stretch` entry has to beat to be applied below.
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
      agentTopPad: AGENT_TOP_PAD,
    };
    const pos = Object.create(null);
    const cells = Object.create(null);
    // Stretch the sidecar cells to the heights the layout reserved for them. This
    // can only run *after* `layoutTree` (the heights are the layout's answer) and it
    // must run *after* the measurement above (only a card the layout wants taller
    // than it measured may be stretched). `height` alone is not enough: `.node` caps
    // every card at 1200px, and a clipped card would leave the grid's column short
    // again — the inline `max-height` is what lifts that cap for this one card.
    const stretch = Object.create(null);
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
      for (const id in result.stretch) stretch[id] = result.stretch[id];
      canvasW = Math.max(canvasW, rootX + result.width);
      canvasH = Math.max(canvasH, result.height);
      // `result.width` is the tree's own extent plus the engine's right pad, and the
      // trailing constant is the gap the next root starts after.
      rootX += result.width + ROOT_GAP;
    }
    layoutCells = cells;
    for (const id in stretch) {
      const card = nodeEls[id];
      if (!card) continue;
      const target = stretch[id];
      // Absent ids and targets at (or below) the card's natural height are left
      // exactly as they are: the layout only ever grows a card, and a sub-pixel
      // difference is measurement noise, not a stretch.
      if (!(target > (heights[id] || 0) + 0.5)) continue;
      card.style.height = target + 'px';
      card.style.maxHeight = target + 'px';
      layoutStretch[id] = target;
    }
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
        syncOriginBadge(card, n);
      }
    }
    for (const id in nodeEls) {
      if (!treeNodes[id]) {
        // The card is going, so a transcript still queued for it can never arrive:
        // it leaves the queue (and the viewport watcher) with the card.
        forgetAgentItems(id);
        nodeEls[id].remove();
        delete nodeEls[id];
        // The card is gone, so its stretch record has nothing to restore — and a
        // record left behind would only keep a dead id alive between passes.
        delete layoutStretch[id];
      }
    }

    for (const id in nodeEls) {
      const meta = treeNodes[id] || { title: '', status: 'done', preview: '' };
      const onPath = activePathSet.has(id) || agentExpanded(id);
      if (onPath) {
        expandedCard(id, meta, pathNodes[id]);
      } else {
        collapsedCard(id, meta);
      }
      applyDeliveredBadge(nodeEls[id], meta);
      // Same reason as in `renderTree`: the `CTX` marker belongs to the card's
      // whole life, not to one repaint, and this pass may have created the card
      // before the node's own `tree` entry described it.
      syncCtxBadge(nodeEls[id], meta);
      // A node's remote-origin badge is derived from the same meta, and this pass can be
      // the one that created the card (a `path` render of a node the tree has not drawn).
      syncOriginBadge(nodeEls[id], meta);
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
      // An agent node carries no `items` any more (only `itemCount`): its
      // transcript arrives via `agentItems` after `expandedCard` below asks for
      // it, so there is nothing to render from the path.
      if (pnode.items && !card._itemsRendered) {
        renderNodeItems(
          card,
          pnode.items,
          (treeNodes[id] || {}).status !== 'running',
        );
        card._itemsRendered = true;
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
      if (onPath) {
        expandedCard(id, meta, pathNodes[id]);
      } else {
        collapsedCard(id, meta);
      }
      applyDeliveredBadge(nodeEls[id], meta);
      // Same story as in `renderTree`: the `CTX` marker belongs to the card, not to
      // one repaint — and this pass can be the one that creates the card.
      syncCtxBadge(nodeEls[id], meta);
      // A node's remote-origin badge is derived from the same meta, and this pass can be
      // the one that created the card (a `path` render of a node the tree has not drawn).
      syncOriginBadge(nodeEls[id], meta);
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
      centerComposerCard = true;
    }
    setComposerVisible(true);   // before mounting: autoGrow() needs a rendered input
    mountComposer(composerCard);
  }

  function hideComposerCard() {
    if (!composerCard) return;
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
      const active = treeActiveId ? treeNodes[treeActiveId] : null;
      if (active && active.children && active.children.length) scheduleLayout();
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
    const meta = treeNodes[id];
    const draggedH = meta && meta.size && meta.size.h ? meta.size.h : 0;
    resizing = {
      id,
      startX: e.clientX,
      startY: e.clientY,
      startW: card.offsetWidth,
      startH: card.offsetHeight,
      // The drag's own ceiling. `MAX_H` is the base, but a card can legitimately be
      // taller than it: the layout stretches a sidecar card to its grid cell
      // (tree.js `stretch`, set as an inline `max-height`), and a `size.h` the user
      // dragged earlier is a height they asked for. Clamping to `MAX_H` alone would
      // snap such a card — and the preview with it — down to 1200 the moment the
      // handle is touched, and store that 1200 as the card's size. So the ceiling is
      // the largest of the three: the base, the height the card has right now, and
      // the drag height it remembers. One number for both the wireframe and the
      // commit (see `onResizeMove` / `endResize`).
      ceilH: Math.max(MAX_H, card.offsetHeight, draggedH),
      // The floor is not a flat `MIN_H` either: a card has to keep room for the two
      // zones under its own header, prompt and input pane, or the log is squeezed to
      // zero and cannot be unfolded again. (A size stored before this rule is lifted
      // back up by `settleAnswerSplit`, so a drag never keeps one.)
      floorH: Math.max(MIN_H, cardFixedHeight(card) + SPLIT_FLOOR_PX),
      target: { w: card.offsetWidth, h: card.offsetHeight },
    };
    try { e.target.setPointerCapture(e.pointerId); } catch { /* noop */ }
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
    // `startH + dh` is clamped at `resizing.ceilH` (see `startResize`), so the
    // wireframe can never advertise a height the commit would not store — and at the
    // card's own `floorH`, which keeps the two zones usable.
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
    // The drag moved the cap the split divides, so settle it *before* the relayout
    // below measures the card (a stretched card's own height is what the ratio uses).
    settleAnswerSplit(card);
    // Collision resolution runs once, on mouse-up.
    relayout();
    if (card._itemScroll) card._itemScroll.scrollToBottom();
    vscode.postMessage({ type: 'setNodeSize', id, w: target.w, h: target.h });
  }

  treeCanvas.addEventListener('pointerdown', (e) => {
    // Resizing is a left-button gesture: RMB belongs to autoscroll, and MMB to
    // pan, so neither must grab the handle.
    if (e.button !== 0) return;
    const handle = e.target.closest('.node-resize');
    if (!handle) return;
    const card = handle.closest('.node');
    const id = card && card.dataset.id;
    if (!id) return;
    startResize(id, card, e);
  });

  // ---- Pan / zoom ----
  let dragging = null;
  treeWrap.addEventListener('pointerdown', (e) => {
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
    // Requirement: wheeling on top of a node scrolls that node's content; the
    // .node-work (the log) / .node-answer (the final answer) / .node-ask (the
    // pinned ask) / .thinking-body handle it natively — all three zones have their
    // own scrollbar. The composer is excluded too — it lives inside a card now and
    // owns its own wheel.
    const scrollable = e.target && e.target.closest ? e.target.closest('.node-work, .node-answer, .node-ask, .thinking-body, #composer') : null;
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

  if (fitBtn) fitBtn.addEventListener('click', () => fitToView());
  if (followBtn) followBtn.addEventListener('click', () => setFollow(!follow));

  // Click a node's title or (collapsed) preview to check it out; clicking inside
  // an expanded node's transcript never changes the branch.
  treeCanvas.addEventListener('click', (e) => {
    if (e.target.closest('button, a, .tool-head, .thinking-head, .thinking-body, .tool-body, .bgnotify-head, .node-summary')) return;
    const head = e.target.closest('.node-head');
    const excerpt = e.target.closest('.node-excerpt');
    const card = head ? head.closest('.node') : excerpt ? excerpt.closest('.node') : null;
    if (!card) return;
    const id = card.dataset.id;
    if (id && id !== treeActiveId) {
      vscode.postMessage({ type: 'checkout', id });
    }
  });

  // Reposition on resize so a long chain stays coherent — and report the new size of
  // the tree area to the host (throttled, only on a real change), because a wrapper
  // that changed while the canvas did not is one of the shapes a frozen picture takes.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => { relayout(); ensureNodeInView(); perfReportResize(); }).observe(treeWrap);
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

  /**
   * The composer shows Stop and hides Send while the view focus node is *doing
   * something* — streaming a turn, or still owning unfinished work (`lockedNodes`) —
   * and Send otherwise. One button, one meaning: stop what this node is doing.
   * Driven by the per-node sets, never by the session-level `busy` flag. Called
   * whenever `state`, the tree, the focused path or either set changes.
   */
  function updateComposerButtons() {
    if (readOnly) {
      // One owner window per workspace: this one may read the sessions, nothing more.
      stopBtn.classList.add('hidden');
      sendBtn.classList.remove('hidden');
      sendBtn.disabled = true;
      sendBtn.title = READ_ONLY_TITLE;
      return;
    }
    sendBtn.disabled = false;
    sendBtn.title = '';
    if (focusIsRunning() || focusIsLocked()) {
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
    }
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
  // only shows the two identities and, for harness drift, the one entry point that
  // drift needs; it never computes drift itself.
  let SETUP = null;
  // The two-line identity block, created lazily: it exists only while the user has
  // drifted, so an untouched session carries no extra DOM.
  let composerIdent = null;   // { box, sending, live }
  // The harness-drift entry point, created lazily next to the snippets button.
  let newSetupBtn = null;

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
   * The harness-drift hint: one extra icon button beside the snippets button. Its
   * click is the user's own "continue with the latest setup" — the host forks the
   * current tree, freezes the live setup on the new root and sends the composer's
   * content there (`forkTurn`), so the old tree (and its prompt cache) is untouched.
   * Built lazily: a session with no harness drift never grows the button.
   */
  function ensureNewSetupButton() {
    if (newSetupBtn) return newSetupBtn;
    const btn = el('button', 'icon-btn new-setup-btn');
    btn.id = 'new-setup-btn';
    btn.type = 'button';
    // The same `⧉` glyph the card's rollover entry uses, and just as deliberately
    // untranslated as `CTX` / `×`: a symbol, not a word. The tooltip carries the
    // explanation and *is* translated.
    btn.textContent = '⧉';
    const title = tr('Continue with the latest setup (forks this tree and sends there)');
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.addEventListener('click', forkTurn);
    const controls = document.getElementById('composer-controls');
    if (controls) {
      if (snippetsBtn && snippetsBtn.parentElement === controls) controls.insertBefore(btn, snippetsBtn);
      else controls.insertBefore(btn, controls.firstChild);
    }
    newSetupBtn = btn;
    return btn;
  }

  /**
   * Show what the composer is about to send *with*: both identities while the user's
   * dropdowns have drifted from the checked-out node's frozen setup, and the fork
   * entry point while the *harness* moved instead (§4.2).
   *
   * Send is deliberately never disabled here: a default send keeps the node's setup,
   * and asking first is the host's modal — the `drift` class only says "this click
   * will ask".
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
    if (sendBtn) {
      sendBtn.classList.toggle('drift', userDrift);
      sendBtn.title = userDrift
        ? tr('Send will ask before using the old setup (the one this node froze)')
        : '';
    }
    if (drift === 'harness') {
      ensureNewSetupButton().classList.remove('hidden');
    } else if (newSetupBtn) {
      newSetupBtn.classList.add('hidden');
    }
  }

  /**
   * Fork the current tree under the live setup and send the composer's content there
   * (`#new-setup-btn`, §4.2). The message carries the very same text and attachments
   * a Send would, and the input is *not* cleared: only the host knows whether it took
   * the turn, and it says so with `composerClear`.
   */
  function forkTurn() {
    vscode.postMessage({
      type: 'forkTurn',
      text: inputEl.value.trim(),
      attachments: pendingAttachments,
    });
  }

  // ---- Messaging ----
  function send() {
    const text = inputEl.value.trim();
    // Sending targets the view focus node, so only *that* node being live blocks it
    // (the button is hidden in that case anyway); a run elsewhere in the session is
    // exactly the "start a new concurrent run here" case (spec §1). A node that still
    // owns unfinished work shows Stop instead, so there is no Send to press — the host
    // refuses it too in case a message arrives anyway (`lockedNodes`).
    if (readOnly || (!text && pendingAttachments.length === 0) || focusIsRunning() || focusIsLocked()) return;
    setFollow(true);
    vscode.postMessage({ type: 'userMessage', text, attachments: pendingAttachments });
    // The composer is *not* cleared here (§4.4): Send may open the "which setup?"
    // modal, and a modal answered with No must not have eaten the user's text. The
    // host clears the box — attachments and all — with `composerClear` once it really
    // took the message.
  }

  // The input never scales with anything, so its height cap is a constant.
  const INPUT_MAX_H = 160;

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, INPUT_MAX_H) + 'px';
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
    autoGrow();
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
   *   - and the node's answer is promoted into zone 3, *after* it left
   *     `runningNodes` (see `syncAnswerZone` at the very end of the function).
   * Without a nodeId the legacy shape is replayed verbatim: the view focus
   * container, all live tool cards, and the session-level busy flag.
   */
  function endRun(msg, extra) {
    const nodeId = msg.nodeId;
    if (nodeId) {
      // The turn is over: nothing in that node is live any more, so the thinking
      // block (via the finalize) and any tool call that never reported its end —
      // the turn was interrupted mid-call — fold back to the default.
      routeTo(nodeId, () => { finalizeStreamingAnswer(); closeActive('tool'); });
      clearLiveTools(nodeId);
      if (extra) routeTo(nodeId, extra);
      runningNodes.delete(nodeId);
      // The session is only idle once *every* run is gone; a fresh `state` from the
      // host follows and stays authoritative.
      if (runningNodes.size === 0) setBusy(false);
    } else {
      finalizeStreamingAnswer();
      closeActive('tool');
      clearLiveTools();
      if (extra) extra();
      setBusy(false);
    }
    updateComposerButtons();
    if (!nodeId || nodeId === treeActiveId) setActiveScrollLock(false);
    // The very last step of a finished turn, and only now: `runningNodes` no longer
    // has this node (a card that is still in it counts as streaming — see
    // `isCardStreaming`), so its tail is a final answer and may be promoted into
    // zone 3. Both branches land on a card here: the routed one on its own node, the
    // legacy one on the view focus, which is the card the turn was written into.
    syncAnswerZone(nodeId ? nodeEls[nodeId] : (treeActiveId ? nodeEls[treeActiveId] : null));
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
      case 'agentItems': {
        // The host's answer to `loadAgentItems`: an agent node's transcript, which
        // the `tree` / `path` payload no longer carries (only its `itemCount`).
        // It renders exactly like the full-render path in `expandedCard`, once: a
        // second answer for a card that already has its items — or one for a node
        // a tree rebuild has dropped — is ignored (rendering twice would duplicate
        // the whole transcript).
        const card = nodeEls[msg.id];
        // The answer is also what frees a slot for the next queued request, so that
        // happens *first*: an answer for a card the tree has dropped (the `break`
        // below) releases it just the same.
        releaseAgentItems();
        if (!card || card._itemsRendered) break;
        // The work log is the scroller this path opens at its end; the answer zone
        // is filled — and opened at its top — by `renderNodeItems` itself.
        const itemsEl = card.querySelector('.node-work');
        const finished = (treeNodes[msg.id] || {}).status !== 'running';
        renderNodeItems(card, msg.items || [], finished);
        card._itemsRendered = true;
        // Same finished-node default as in `expandedCard` / `renderPath`: the
        // thinking blocks only exist now, and this path skips their render branch.
        if (finished) {
          setCardScrollLock(card, false);
          card._needsBottomScroll = true;
        }
        // Open the just-filled card at its newest content (a locked card is pinned
        // there anyway, an unlocked one takes the flag `expandedCard` would) — but
        // only while the log is really showing: a folded log has nothing to scroll,
        // and the flag waits for `setWorkFold` to unfold it (same rule as there).
        if (card._itemScroll && card._itemScroll.locked) {
          card._itemScroll.scrollToBottom();
          card._needsBottomScroll = false;
        } else if (card._needsBottomScroll && itemsEl && !card.classList.contains('work-folded')) {
          itemsEl.scrollTop = itemsEl.scrollHeight;
          card._needsBottomScroll = false;
        }
        // The items are what gives this card its height, and the card's height
        // feeds the layout, so re-place the tree like any other card that changed
        // size (debounced, so a burst of answers coalesces into one relayout).
        scheduleLayout();
        break;
      }
      case 'panTo':
        panToNode(String(orElse(msg.id, '')));
        break;
      case 'config': {
        const prevFoldToolCalls = foldToolCalls;
        const prevFoldThinking = foldThinking;
        const prevFoldWork = foldWork;
        // The card list is authoritative and complete on every `config`: a card the
        // user deleted must disappear from the dropdown, so an empty list is a real
        // answer (the host never sends one — it always has a fallback card).
        CARDS = Array.isArray(msg.cards) ? msg.cards : [];
        EFFORTS = Array.isArray(msg.efforts) ? msg.efforts : [];
        SNIPPETS = Array.isArray(msg.snippets) ? msg.snippets : [];
        updateSnippetsButton();
        renderModelSelect(msg.model);
        renderEffortSelect(msg.thinkingEffort);
        foldToolCalls = msg.foldToolCalls !== false;
        foldThinking = msg.foldThinking !== false;
        foldWork = msg.foldWork !== false;
        // A changed fold default must apply to the cards already on screen too,
        // not only to the ones rendered after it (clicking a header still
        // toggles that single card afterwards).
        if (foldToolCalls !== prevFoldToolCalls) {
          applyFoldDefault('.tool-body', foldToolCalls);
        }
        if (foldThinking !== prevFoldThinking) {
          applyFoldDefault('.thinking-body', foldThinking);
        }
        // Zone 2's fold is not a body default (it depends on the card's own
        // `has-answer`, and a header the user clicked owns its card), so the new
        // value is handed to the cards themselves — same reasoning: a settings
        // change must not wait for the next repaint.
        if (foldWork !== prevFoldWork) {
          for (const id in nodeEls) autoWorkFold(nodeEls[id]);
        }
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
        autoGrow();
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
        routeTo(msg.nodeId, () => { finalizeStreamingAnswer(); finalizeLiveTool(msg.index, msg.id, msg.name, msg.args, msg.startedAt, null); }, 'toolStart');
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
        // A notice carries no nodeId: it belongs to the card the view focuses, whose
        // zone 2 is what `messagesEl` points at. It is appended *into* that log, so
        // the answer zone has to give its run back first — the same rule `routeTo`
        // enforces for every routed append.
        {
          const id = treeActiveId;
          const c = id ? nodeEls[id] : null;
          if (c) demoteAnswer(c);
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
        resetAgentItems();
        for (const id in nodeEls) { nodeEls[id].remove(); }
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
    // Relocating a focused subtree drops focus; put it back on the input.
    const hadFocus = composerEl.contains(document.activeElement);
    composerHost = card;
    if (card) {
      card.appendChild(composerEl);   // last child = the card's bottom
    } else {
      composerEl.remove();
    }
    autoGrow();
    if (hadFocus && card) inputEl.focus();
  }

  /**
   * Hide/show the whole send pane. A sub-agent branch is read-only, so it must
   * not offer an input at all — the pane is removed from view (not merely
   * disabled) while such a node is checked out.
   */
  function setComposerVisible(visible) {
    composerEl.classList.toggle('hidden', !visible);
    if (!visible && composerEl.contains(document.activeElement)) inputEl.blur();
  }

  // ---- Input handlers ----
  sendBtn.addEventListener('click', send);
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
      send();
    }
  });

  inputEl.addEventListener('input', autoGrow);

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
  setStatus(tr('Ready'));
  updateImageVisibility();
  updateFollowButton();
  // No `config` yet means no snippet list: the button stays out of the way until
  // one arrives (it always does, and it always carries at least the shipped rows).
  updateSnippetsButton();
})();
