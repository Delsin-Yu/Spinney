(function () {
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send-btn');
  const stopBtn = document.getElementById('stop-btn');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const attachmentsEl = document.getElementById('attachments');
  const attachBtn = document.getElementById('attach-btn');
  const contextLabel = document.getElementById('context-label');
  const sessionSelect = document.getElementById('session-select');
  const newSessionBtn = document.getElementById('new-session-btn');
  const deleteSessionBtn = document.getElementById('delete-session-btn');
  const modelSelect = document.getElementById('model-select');
  const effortSelect = document.getElementById('effort-select');
  const tpsMeter = document.getElementById('tps-meter');
  const tpsValue = document.getElementById('tps-value');
  const statCacheEl = document.getElementById('stat-cache');
  const statBalanceEl = document.getElementById('stat-balance');
  const bgPanel = document.getElementById('bg-panel');
  const bgList = document.getElementById('bg-list');
  const bgCount = document.getElementById('bg-count');
  const scrollLockEl = document.getElementById('scroll-lock');

  let busy = false;
  let sessionLocked = false;
  let pendingAttachments = [];
  let currentModel = 'deepseek-chat';
  let currentEffort = 'none';

  // ---- Element helpers (textContent only; no unsanitized HTML) ----
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  /**
   * Auto-scroll controller. A scroll container defaults to "locked" (stuck to
   * the bottom). It unlocks when the user scrolls up and re-locks when they
   * scroll back down to the bottom. Appends only auto-scroll while locked, so
   * the user can read older content without being yanked to the newest.
   *
   * A scroll event cannot tell a user scroll from our own. A programmatic
   * `scrollTop = max` still fires one, and by the time it is delivered the
   * stream may have grown the content again, so `isNearBottom()` is false even
   * though the user never scrolled. That used to unlock the view mid-stream and
   * silently stop auto-scrolling. Two guards fix it:
   *  - `programmaticTop` remembers the bottom we last aimed at, so events that
   *    land on or below it are recognised as ours and ignored;
   *  - while the user is actively scrolling (`interacting`) we stop snapping
   *    and trust the events, so an intentional scroll up still wins.
   */
  function createScrollController(el, onChange) {
    const state = { locked: true };
    const NEAR_BOTTOM_PX = 2;
    let programmaticTop = null;
    let interacting = false;
    let interactTimer = null;

    function isNearBottom() {
      return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    }

    function setLocked(value) {
      if (state.locked === value) {
        return;
      }
      state.locked = value;
      if (onChange) onChange(value);
    }

    function scrollToBottom() {
      if (!state.locked || interacting) {
        return;
      }
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      programmaticTop = max;
      if (el.scrollTop !== max) {
        el.scrollTop = max;
      }
    }

    function lock() {
      setLocked(true);
      scrollToBottom();
    }

    function noteInteraction() {
      interacting = true;
      if (interactTimer) clearTimeout(interactTimer);
      interactTimer = setTimeout(() => {
        interacting = false;
      }, 150);
    }

    el.addEventListener('scroll', () => {
      const top = el.scrollTop;
      if (!interacting && state.locked && programmaticTop !== null && top >= programmaticTop) {
        // Our own scroll (content may have grown since we set it).
        return;
      }
      programmaticTop = top;
      setLocked(isNearBottom());
    });
    // Any of these means the user is driving the scroll, not us.
    el.addEventListener('wheel', noteInteraction, { passive: true });
    el.addEventListener('touchmove', noteInteraction, { passive: true });
    el.addEventListener('pointerdown', noteInteraction, { passive: true });
    el.addEventListener('keydown', noteInteraction, { passive: true });

    if (onChange) onChange(state.locked);

    return {
      get locked() {
        return state.locked;
      },
      isNearBottom,
      scrollToBottom,
      lock,
    };
  }

  // Green light at the bottom of the scrollbar: lit while auto-scroll is locked
  // to the newest output, dim when the view is free to stay where the user left it.
  function renderScrollLock(locked) {
    if (!scrollLockEl) return;
    scrollLockEl.classList.toggle('locked', !!locked);
    scrollLockEl.title = locked
      ? 'Auto-scroll locked to the newest output'
      : 'Auto-scroll unlocked — scroll to the bottom to re-lock';
  }

  const messagesScroll = createScrollController(messagesEl, renderScrollLock);

  // Scrolling the message panel (stays pinned to the bottom while locked).
  // Coalesce to one layout per frame — streaming used to force layout on every token.
  let scrollRaf = null;
  function scrollToBottom() {
    if (scrollRaf != null) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = null;
      messagesScroll.scrollToBottom();
      updateScrollLockVisibility();
    });
  }

  // Nothing to scroll (empty or short conversation) — the lock light would just
  // be a stray dot, so hide it until the transcript overflows.
  function updateScrollLockVisibility() {
    if (!scrollLockEl) return;
    scrollLockEl.classList.toggle(
      'hidden',
      messagesEl.scrollHeight - messagesEl.clientHeight <= 1,
    );
  }

  // A container resize (sidebar resize, composer growing) moves the bottom
  // without firing a scroll event, which used to leave a locked view stranded.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      updateScrollLockVisibility();
      scrollToBottom();
    }).observe(messagesEl);
  }
  updateScrollLockVisibility();

  // ---- Markdown rendering ----
  // The model replies in Markdown. This webview runs in a sandboxed iframe and
  // cannot import the markdown-it instance bundled inside VS Code's own
  // renderer, so we load the *same* library VS Code and its forks use
  // (markdown-it, vendored in media/) and render client-side. We keep raw HTML
  // escaped (html:false) and rely on markdown-it's default validateLink to
  // reject javascript:/data: URLs, so model output can't inject scripts.
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
    if (md) {
      return md.render(text || '');
    }
    return escapeHtml(text);
  }

  // ---- Message rendering ----
  function addUser(text, attachments) {
    const node = document.createElement('div');
    node.className = 'msg user';
    node.dataset.kind = 'user';
    if (attachments && attachments.length) {
      const imgWrap = document.createElement('div');
      imgWrap.className = 'msg-imgs';
      for (const att of attachments) {
        const img = document.createElement('img');
        img.className = 'msg-img';
        img.src = att.dataUrl;
        img.title = att.name || 'image';
        imgWrap.appendChild(img);
      }
      node.appendChild(imgWrap);
    }
    if (text) {
      node.appendChild(el('span', 'msg-text', text));
    }
    messagesEl.appendChild(node);
    scrollToBottom();
    return node;
  }

  function addNotice(kind, text) {
    const node = el('div', 'notice ' + (kind || 'info'), text);
    node.dataset.kind = 'notice';
    messagesEl.appendChild(node);
    scrollToBottom();
    return node;
  }

  function makeThinkingBlock(thinking) {
    const box = el('div', 'thinking');
    const head = el('div', 'thinking-head');
    const chev = el('span', 'chev', '▶');
    head.appendChild(chev);
    head.appendChild(el('span', 'thinking-label', 'Thinking'));
    box.appendChild(head);
    const body = el('div', 'thinking-body hidden');
    if (thinking) body.textContent = thinking;
    box.appendChild(body);
    // The thinking body scrolls independently with the same lock/unlock behavior.
    body._scroll = createScrollController(body);
    head.addEventListener('click', () => {
      body.classList.toggle('hidden');
      chev.classList.toggle('open');
    });
    return box;
  }

  function addAssistant(text, error, thinking) {
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
    scrollToBottom();
    return node;
  }

  function appendAssistant(text) {
    const last = messagesEl.lastElementChild;
    if (last && last.dataset.kind === 'assistant' && !last.classList.contains('error')) {
      last._text = (last._text || '') + (text || '');
      renderAnswer(last, false);
      scrollToBottom();
      return last;
    }
    const node = addAssistant('', false);
    node._text = text || '';
    renderAnswer(node, false);
    return node;
  }

  // While a reply is still streaming, paint plain text via a Text node
  // (appendData is O(chunk)). markdown-it runs only on finalize — re-parsing
  // the whole answer on every SSE token was quadratic and froze the webview
  // after a long session.
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
    const last = messagesEl.lastElementChild;
    if (last && last.dataset.kind === 'assistant' && !last.classList.contains('error')) {
      renderAnswer(last, true);
      // The markdown re-render changes the height (code blocks, lists, images),
      // so re-pin instead of leaving the tail off-screen.
      scrollToBottom();
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
    let last = messagesEl.lastElementChild;
    if (!last || last.dataset.kind !== 'assistant' || last.classList.contains('error')) {
      last = addAssistant('', false);
    }
    let box = last.querySelector('.thinking');
    if (!box) {
      box = makeThinkingBlock('');
      const answer = last.querySelector('.answer');
      if (answer) last.insertBefore(box, answer);
      else last.appendChild(box);
    }
    const body = box.querySelector('.thinking-body');
    thinkingTextNode(body).appendData(text);
    body.classList.remove('hidden');
    const chev = box.querySelector('.chev');
    if (chev) chev.classList.add('open');
    if (body._scroll) body._scroll.scrollToBottom();
    scrollToBottom();
    return last;
  }

  function formatUsage(usage) {
    const hit = usage.prompt_cache_hit_tokens ?? 0;
    const miss = usage.prompt_cache_miss_tokens ?? 0;
    return (
      'tokens ' + usage.total_tokens +
      ' (prompt ' + usage.prompt_tokens + ' + completion ' + usage.completion_tokens + ')' +
      ' · cache hit ' + hit + ' / miss ' + miss
    );
  }

  function appendUsage(usage) {
    // Attach the turn's token count to the window that concluded it: the last
    // assistant message bubble, or the last tool call card when the turn produced
    // tool calls. Search backwards past any intermediate elements (e.g. notices)
    // so we never hoist an empty message bubble just to hold the usage line.
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
    scrollToBottom();
  }

  function describeArgs(args) {
    if (!args || args === '{}') {
      return '';
    }
    try {
      return JSON.stringify(JSON.parse(args), null, 2);
    } catch {
      // Not strict JSON — try to summarize a verbatim frame.
    }
    if (args.indexOf('<<<RAW:') === -1) {
      return args;
    }
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
          out.push('[raw ' + open.label + ': ' + (m.index - open.start) + ' chars]');
        }
      }
    }
    return out.join('\n');
  }

  function addTool(name, args, id, usage) {
    const node = el('div', 'msg tool');
    node.dataset.id = id;
    node.dataset.kind = 'tool';

    const head = el('div', 'tool-head');
    const chev = el('span', 'chev', '▶');
    head.appendChild(chev);
    head.appendChild(el('span', 'tool-name', name));
    const status = el('span', 'tool-status running', 'running');
    status.dataset.role = 'status';
    head.appendChild(status);
    node.appendChild(head);

    const body = el('div', 'tool-body hidden');
    if (args && args !== '{}') {
      body.appendChild(el('pre', 'tool-args', describeArgs(args)));
    }

    head.addEventListener('click', () => {
      body.classList.toggle('hidden');
      chev.classList.toggle('open');
    });

    node.appendChild(body);

    // The tool-call window carries its own token-count control (usage line), so
    // a tool call's token count is shown in place rather than hoisted into a
    // separate, empty message bubble.
    if (usage) {
      node.appendChild(el('div', 'usage-line', formatUsage(usage)));
    }

    const statusEl = status;
    statusEl.dataset.role = 'status';
    // keep a stable reference via closure
    node._statusEl = statusEl;
    node._bodyEl = body;

    messagesEl.appendChild(node);
    scrollToBottom();
    return node;
  }

  // ---- Live (streaming) tool-call drafting ----
  // While the model assembles a tool call, its name and JSON arguments arrive
  // incrementally. We render a single "draft" card that grows in place (like the
  // Thinking block), then finalize it into a normal tool card at toolStart.
  const liveTools = Object.create(null);

  function addLiveTool(index, id, name, args) {
    const node = el('div', 'msg tool live');
    node.dataset.index = String(index);
    node.dataset.kind = 'tool';
    if (id) node.dataset.id = id;

    const head = el('div', 'tool-head');
    const chev = el('span', 'chev', '▶');
    head.appendChild(chev);
    // Name grows via incremental fragments; start empty (no '…' placeholder,
    // otherwise the first fragment would be appended after the placeholder).
    const nameEl = el('span', 'tool-name', name || '');
    head.appendChild(nameEl);
    const status = el('span', 'tool-status streaming', 'streaming');
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
      body.classList.toggle('hidden');
      chev.classList.toggle('open');
    });

    node._nameEl = nameEl;
    node._statusEl = status;
    node._bodyEl = body;
    node._argsText = argsText;
    node._argsEl = argsEl;
    node._chevEl = chev;

    messagesEl.appendChild(node);
    liveTools[index] = node;
    scrollToBottom();
    return node;
  }

  function appendLiveTool(index, id, nameDelta, argsDelta) {
    let node = liveTools[index];
    if (!node) {
      node = addLiveTool(index, id, '', '');
    }
    if (id) node.dataset.id = idappend(nameDelta);
    if (argsDelta && node._argsText) node._argsText.appendData(argsDelta);
    if (argsDelta) node._argsEl.textContent = (node._argsEl.textContent || '') + argsDelta;
    // Auto-expand so the growth is visible, mirroring appendThinking.
    node._bodyEl.classList.remove('hidden');
    if (node._chevEl) node._chevEl.classList.add('open');
    scrollToBottom();
    return node;
  }

  function finalizeLiveTool(index, id, name, args) {
    // Prefer the live card keyed by stream index; fall back to by-id lookup,
    // then to a brand-new finalized card (e.g. non-streaming / history restore).
    let node = index !== undefined && index !== null ? liveTools[index] : null;
    if (!node && id) {
      node = messagesEl.querySelector('.msg.tool.live[data-id="' + id + '"]');
    }
    if (!node) {
      return addTool(name, args, id);
    }
    if (index !== undefined && index !== null) delete liveTools[index];
    if (id) node.dataset.id = id;
    delete node.dataset.index;
    node.classList.remove('live');

    if (name) node._nameEl.textContent = name;
    node._statusEl.className = 'tool-status running';
    node._statusEl.textContent = 'running';

    // Replace the raw streamed fragment with the pretty-printed summary.
    node._bodyEl.innerHTML = '';
    if (args && args !== '{}') {
      node._bodyEl.appendChild(el('pre', 'tool-args', describeArgs(args)));
    }
    node._bodyEl.classList.remove('hidden');
    if (node._chevEl) node._chevEl.classList.add('open');
    scrollToBottom();
    return node;
  }

  function clearLiveTools() {
    for (const key in liveTools) {
      const node = liveTools[key];
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }
    for (const k in liveTools) delete liveTools[k];
  }

  function updateTool(id, content) {
    const node = messagesEl.querySelector('[data-id="' + id + '"]');
    if (!node) return;
    const statusEl = node.querySelector('.tool-status');
    if (statusEl) {
      statusEl.className = 'tool-status done';
      statusEl.textContent = 'done';
    }
    const body = node.querySelector('.tool-body');
    if (body) {
      body.appendChild(el('pre', 'tool-result', content));
      body.classList.remove('hidden');
    }
    scrollToBottom();
  }

  function setToolStatus(id, status) {
    const node = messagesEl.querySelector('[data-id="' + id + '"]');
    if (!node) return;
    const statusEl = node.querySelector('.tool-status');
    if (statusEl) {
      if (status === 'done') {
        statusEl.className = 'tool-status done';
        statusEl.textContent = 'done';
      } else {
        statusEl.className = 'tool-status running';
        statusEl.textContent = 'running';
      }
    }
  }

  function renderHistory(items) {
    clearLiveTools();
    messagesScroll.lock();
    messagesEl.innerHTML = '';
    if (!items || items.length === 0) {
      messagesEl.appendChild(
        el('div', 'empty', 'Welcome. Ask the agent to read or write files, or run a command.'),
      );
      updateScrollLockVisibility();
      return;
    }
    for (const item of items) {
      if (item.kind === 'user') {
        addUser(item.text, item.attachments);
      } else if (item.kind === 'assistant') {
        addAssistant(item.text, item.error, item.thinking);
        if (item.usage) {
          const node = messagesEl.lastElementChild;
          if (node) node.appendChild(el('div', 'usage-line', formatUsage(item.usage)));
        }
      } else if (item.kind === 'notice') {
        addNotice(item.noticeKind, item.text);
      } else if (item.kind === 'background') {
        addBackgroundNotice(item);
      } else if (item.kind === 'tool') {
        const toolId = item.id || 'history-' + item.name + '-' + (item.status || '');
        const node = addTool(item.name, item.args, toolId, item.usage);
        if (item.status === 'done' && item.content) {
          setToolStatus(node.dataset.id, 'done');
          const body = node.querySelector('.tool-body');
          body.appendChild(el('pre', 'tool-result', item.content));
          body.classList.remove('hidden');
        }
      }
    }
    scrollToBottom();
  }

  // ---- Background completion card ----
  // A dedicated card for a background job finishing/killed, instead of rendering
  // it as a user bubble. Shows the task id, the status phrase, the command and
  // the (truncated) output tail.
  function addBackgroundNotice(item) {
    const node = el('div', 'msg bgnotify');
    node.dataset.kind = 'background';
    const head = el('div', 'bgnotify-head');
    head.appendChild(el('span', 'bgnotify-badge', 'BG'));
    head.appendChild(el('span', 'bgnotify-id', '#' + (item.id != null ? item.id : '')));
    head.appendChild(el('span', 'bgnotify-status', item.doneText || 'finished'));
    node.appendChild(head);
    if (item.name || item.cmd) {
      node.appendChild(el('div', 'bgnotify-cmd', item.name || item.cmd));
    }
    if (item.content) {
      node.appendChild(el('pre', 'bgnotify-output', item.content));
    }
    messagesEl.appendChild(node);
    scrollToBottom();
    return node;
  }

  // ---- Background terminals panel ----
  function shortCommand(cmd) {
    const s = String(cmd || '');
    return s.length > 60 ? s.slice(0, 60) + '…' : s;
  }

  function renderBackgrounds(tasks) {
    if (!bgPanel || !bgList || !bgCount) return;
    bgList.innerHTML = '';
    const list = tasks || [];
    bgPanel.classList.toggle('hidden', list.length === 0);
    if (list.length === 0) {
      bgCount.textContent = '';
      bgPanel.classList.add('hidden');
      return;
    }
    for (const t of list) {
      const item = el('div', 'bg-item ' + (t.status === 'running' ? 'running' : 'finished'));
      const head = el('div', 'bg-item-head');
      head.appendChild(el('span', 'bg-id', '#' + t.id));
      head.appendChild(el('span', 'bg-cmd', shortCommand(t.command)));
      const pending = t.status === 'finished' && t.pendingDelivery;
      const statusText =
        t.status === 'running'
          ? 'running'
          : t.pendingDelivery
            ? 'pending delivery'
            : t.killed
              ? 'killed'
              : 'exit ' + (t.exitCode ?? '?');
      head.appendChild(el('span', 'bg-status' + (pending ? ' pending' : ''), statusText));
      const chev = el('span', 'chev', '▶');
      head.appendChild(chev);
      item.appendChild(head);

      const body = el('div', 'bg-body hidden');
      if (t.outputTail) body.appendChild(el('pre', 'bg-output', t.outputTail));
      head.addEventListener('click', () => {
        body.classList.toggle('hidden');
        chev.classList.toggle('open');
      });
      item.appendChild(body);

      // Only running terminals can be killed from the panel.
      if (t.status === 'running') {
        const killBtn = el('button', 'bg-kill', 'kill');
        killBtn.title = 'Kill background terminal ' + t.id;
        killBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          vscode.postMessage({ type: 'killBackground', id: t.id });
        });
        head.appendChild(killBtn);
      }
      bgList.appendChild(item);
    }
    bgCount.textContent = list.length + ' task' + (list.length === 1 ? '' : 's');
  }

  function showEmptyIfNeeded() {
    if (messagesEl.children.length === 0) {
      messagesEl.appendChild(
        el('div', 'empty', 'Welcome. Ask the agent to read or write files, or run a command.'),
      );
    }
  }

  // ---- State ----
  function updateSessionControls() {
    // Session switching/new/delete is locked while the agent is busy OR any
    // background terminal is still running (so a session with a running job is
    // never left behind). Model/effort stay enabled with background tasks.
    const disabled = busy || sessionLocked;
    sessionSelect.disabled = disabled;
    newSessionBtn.disabled = disabled;
    deleteSessionBtn.disabled = disabled;
  }

  function setBusy(value) {
    busy = value;
    updateSessionControls();
    modelSelect.disabled = value;
    effortSelect.disabled = value;
    if (value) {
      startTps();
      stopBtn.classList.remove('hidden');
      sendBtn.classList.add('hidden');
      statusDot.className = 'dot busy';
    } else {
      stopTps();
      stopBtn.classList.add('hidden');
      sendBtn.classList.remove('hidden');
      statusDot.className = 'dot idle';
    }
  }

  function setSessionLocked(value) {
    sessionLocked = !!value;
    updateSessionControls();
  }

  const MODELS = [
    'deepseek-chat',
    'deepseek-reasoner',
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'deepseek-v4-flash-vision-exp',
    'deepseek-v4.1-flash-expires-on-0910',
  ];

  function renderModelSelect(model) {
    currentModel = model;
    modelSelect.innerHTML = '';
    for (const m of MODELS) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      opt.selected = m === model;
      modelSelect.appendChild(opt);
    }
  }

  // Hide image thumbnails (history + composer preview) when the active model is
  // not a vision model. The conversation keeps its image data; it reappears when
  // a vision model is selected again.
  const VISION_MODELS = ['deepseek-v4-flash-vision-exp', 'deepseek-v4.1-flash-expires-on-0910'];
  function hasVisionModel() {
    return VISION_MODELS.includes(currentModel);
  }
  function updateImageVisibility() {
    const hasVision = hasVisionModel();
    messagesEl.classList.toggle('hide-images', !hasVision);
    attachmentsEl.classList.toggle('hide-images', !hasVision);
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

  function renderEffortSelect(effort) {
    currentEffort = effort;
    for (const opt of effortSelect.options) {
      opt.selected = opt.value === effort;
    }
  }

  function renderSessions(sessions, activeId) {
    sessionSelect.innerHTML = '';
    for (const s of sessions) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.title;
      opt.selected = s.id === activeId;
      sessionSelect.appendChild(opt);
    }
  }

  function setStatus(text) {
    if (statusText) statusText.textContent = text || '';
  }

  function setContext(used, total) {
    const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
    contextLabel.textContent = 'ctx ' + (total > 0 ? Math.round(pct) : 0) + '%';
    const elCtx = document.getElementById('context');
    if (elCtx) elCtx.title = 'Context: ' + used + ' / ' + total + ' tokens (' + pct.toFixed(1) + '%)';
  }

  // ---- Session-stats chip (consumed tokens + prompt-cache hit rate + wallet) ----
  let statsCacheData = null;
  let statsBalanceData = null;

  function currencySymbol(currency) {
    switch (currency) {
      case 'CNY': return '¥';
      case 'USD': return '$';
      case 'EUR': return '€';
      default: return currency + ' ';
    }
  }

  function renderStatsTitle() {
    const elStats = document.getElementById('meter-row-readout');
    if (!elStats) return;
    const parts = [];
    if (statsCacheData) {
      const totalCache = statsCacheData.cacheHit + statsCacheData.cacheMiss;
      if (totalCache > 0) {
        parts.push(
          'prompt-cache hit ' + statsCacheData.cacheHit + ' / ' + totalCache +
          ' (' + statsCacheData.cacheHitRate.toFixed(1) + '%)',
        );
      }
    }
    if (statsBalanceData && statsBalanceData.balances && statsBalanceData.balances.length) {
      const wallet = statsBalanceData.balances.map((b) => {
        const sym = currencySymbol(b.currency);
        return sym + b.totalBalance.toFixed(2) +
          ' (granted ' + sym + b.grantedBalance.toFixed(2) +
          ' + topped up ' + sym + b.toppedUpBalance.toFixed(2) + ')';
      });
      parts.push('wallet ' + wallet.join(' · '));
    }
    elStats.title = parts.length ? 'Session: ' + parts.join(' · ') : '';
  }

  function setSessionStats(stats) {
    if (!stats) return;
    const known = !!stats.cacheKnown;
    statCacheEl.textContent = 'cache ' + (known ? stats.cacheHitRate.toFixed(0) + '%' : '–');
    statsCacheData = stats;
    renderStatsTitle();
  }

  function setBalance(balance) {
    if (!balance || !balance.balances || balance.balances.length === 0) {
      statBalanceEl.textContent = 'bal –';
      statsBalanceData = null;
      renderStatsTitle();
      return;
    }
    // Only show non-zero currencies so an empty USD balance does not clutter the
    // chip with "$0.00". Full wallet detail stays in the title (renderStatsTitle).
    const active = balance.balances.filter((b) => b.totalBalance > 0);
    if (active.length === 0) {
      statBalanceEl.textContent = 'bal 0';
    } else {
      const parts = active.map((b) => currencySymbol(b.currency) + b.totalBalance.toFixed(2));
      statBalanceEl.textContent = 'bal ' + parts.join(' ');
    }
    statsBalanceData = balance;
    renderStatsTitle();
  }

  // ---- Real-time tokens/sec meter ----
  // The model streams decoded text, not token boundaries, so we estimate the
  // token count from the characters themselves. CJK/wide glyphs contribute ~1
  // token each; continuous Latin/code text approximates ~4 chars per token.
  const TPS_WINDOW_MS = 1500;
  let tpsSamples = [];
  let tpsTimer = null;

  function estimateTokens(text) {
    if (!text) return 0;
    let tokens = 0;
    for (const ch of text) {
      const code = ch.codePointAt(0);
      if (
        (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
        (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
        (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
        (code >= 0x3000 && code <= 0x303f) || // CJK Symbols & Punctuation
        (code >= 0x3040 && code <= 0x30ff) || // Hiragana / Katakana
        (code >= 0xac00 && code <= 0xd7af) || // Hangul Syllables
        (code >= 0xff00 && code <= 0xffef) // Fullwidth Forms
      ) {
        tokens += 1;
      } else {
        tokens += 0.25; // ~4 chars per token
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

  // ---- Pending attachments (composer previews) ----
  function addPendingAttachment(dataUrl, name) {
    if (!hasVisionModel()) {
      // The active model is text-only; an image could not be sent, so do not add
      // it to the composer (which would leave an invisible, unremovable item).
      showAttachHint('Switch to a vision model (deepseek-v4-flash-vision-exp or deepseek-v4.1-flash-expires-on-0910) to attach an image.');
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
      img.title = att.name || 'image';
      const rm = document.createElement('button');
      rm.className = 'remove-att';
      rm.textContent = '×';
      rm.title = 'Remove';
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

  // ---- Messaging ----
  function send() {
    const text = inputEl.value.trim();
    if ((!text && pendingAttachments.length === 0) || busy) return;
    // Sending a new message returns the conversation to the latest message.
    messagesScroll.lock();
    vscode.postMessage({ type: 'userMessage', text, attachments: pendingAttachments });
    pendingAttachments = [];
    renderPendingAttachments();
    inputEl.value = '';
    autoGrow();
  }

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'history':
        renderHistory(msg.items);
        break;
      case 'config':
        renderModelSelect(msg.model);
        renderEffortSelect(msg.thinkingEffort);
        updateImageVisibility();
        break;
      case 'sessions':
        renderSessions(msg.sessions, msg.activeId);
        break;
      case 'state':
        setBusy(msg.busy);
        setSessionLocked(msg.sessionLocked);
        setStatus(msg.status);
        break;
      case 'background':
        renderBackgrounds(msg.tasks);
        break;
      case 'context':
        setContext(msg.used, msg.total);
        break;
      case 'sessionStats':
        setSessionStats(msg.stats);
        break;
      case 'balance':
        setBalance(msg.balance);
        break;
      case 'status':
        setStatus(msg.text);
        break;
      case 'user':
        addUser(msg.text, msg.attachments);
        break;
      case 'backgroundNotice':
        addBackgroundNotice(msg.item);
        break;
      case 'imagePicked':
        addPendingAttachment(msg.dataUrl, msg.name);
        break;
      case 'delta':
        addTpsTokens(msg.text);
        appendAssistant(msg.text);
        break;
      case 'thinkingDelta':
        addTpsTokens(msg.text);
        appendThinking(msg.text);
        break;
      case 'usage':
        appendUsage(msg.usage);
        break;
      case 'toolCallDelta':
        // Tool-call drafting is token generation too, so meter it along with
        // text/reasoning deltas. Combine the incremental name + args fragments.
        addTpsTokens((msg.name || '') + (msg.args || ''));
        appendLiveTool(msg.index, msg.id, msg.name, msg.args);
        break;
      case 'toolStart':
        // A tool call ends the streaming answer (if any); paint markdown now.
        finalizeStreamingAnswer();
        // Finalize the live draft card (grow-in-place), or create one if the
        // streamed deltas were missed (e.g. a single-chunk tool call).
        finalizeLiveTool(msg.index, msg.id, msg.name, msg.args);
        break;
      case 'toolEnd':
        updateTool(msg.id, msg.content);
        break;
      case 'done':
        // The provider sends the final status text right before this event.
        finalizeStreamingAnswer();
        clearLiveTools();
        setBusy(false);
        showEmptyIfNeeded();
        break;
      case 'interrupted':
        finalizeStreamingAnswer();
        clearLiveTools();
        setBusy(false);
        setStatus('Interrupted');
        break;
      case 'error':
        finalizeStreamingAnswer();
        clearLiveTools();
        addAssistant('⚠️ ' + msg.message, true);
        setBusy(false);
        setStatus('Error');
        break;
      case 'notice':
        addNotice(msg.kind, msg.text);
        break;
      case 'reset':
        messagesScroll.lock();
        clearLiveTools();
        messagesEl.innerHTML = '';
        showEmptyIfNeeded();
        updateScrollLockVisibility();
        break;
      default:
        break;
    }
  });

  // ---- Input handlers ----
  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', () => {
    // Immediate feedback: the underlying stream abort lands very quickly, but
    // reflect the click right away so the user sees Stop was honoured.
    setStatus('Stopping…');
    vscode.postMessage({ type: 'stop' });
  });
  attachBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'pickImage' });
  });
  sessionSelect.addEventListener('change', () => {
    vscode.postMessage({ type: 'switchSession', id: sessionSelect.value });
  });
  modelSelect.addEventListener('change', () => {
    if (busy) {
      // reset the control if the provider rejects the change while busy
      renderModelSelect(currentModel);
      return;
    }
    vscode.postMessage({ type: 'setModel', model: modelSelect.value });
  });
  effortSelect.addEventListener('change', () => {
    if (busy) {
      // reset the control if the provider rejects the change while busy
      renderEffortSelect(currentEffort);
      return;
    }
    vscode.postMessage({ type: 'setThinkingEffort', effort: effortSelect.value });
  });
  newSessionBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'newSession' });
  });
  deleteSessionBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'deleteSession', id: sessionSelect.value });
  });
  inputEl.addEventListener('paste', handlePaste);

  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });

  inputEl.addEventListener('input', autoGrow);

  // Open Markdown links in the system browser instead of navigating the webview.
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
  showEmptyIfNeeded();
  setStatus('Ready');
  updateImageVisibility();
})();
