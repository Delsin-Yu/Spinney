(function () {
  const vscode = acquireVsCodeApi();

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
  const contextLabel = document.getElementById('context-label');
  const modelSelect = document.getElementById('model-select');
  const effortSelect = document.getElementById('effort-select');
  const tpsMeter = document.getElementById('tps-meter');
  const tpsValue = document.getElementById('tps-value');
  const statBalanceEl = document.getElementById('stat-balance');
  const bgPanel = document.getElementById('bg-panel');
  const bgList = document.getElementById('bg-list');
  const bgCount = document.getElementById('bg-count');
  const branchBanner = document.getElementById('branch-banner');
  const composerEl = document.getElementById('composer');

  let busy = false;
  let pendingAttachments = [];
  let currentModel = 'deepseek-chat';
  let currentEffort = 'medium';
  // Session currently rendered, mirrored into vscode.setState so a reloaded
  // window restores this tab bound to the same conversation.
  let persistedSessionId = '';

  const NODE_W = 320;
  const H_GAP = 48;
  const V_GAP = 72;

  // The transcript is a pannable tree. `messagesEl` points at the currently
  // checked-out node's items container — every append / stream lands there.
  let messagesEl = null;
  const nodeEls = Object.create(null);   // id -> card element
  let treeNodes = Object.create(null);   // id -> { id, parentId, children, title, status, preview }
  let treeRootId = null;
  let treeActiveId = null;
  let activePathSet = new Set();
  let pathNodes = Object.create(null);   // id -> { status, items }
  let pan = { x: 0, y: 0 };
  let zoom = 1;
  let follow = true;
  // Set while routing a sub-agent's streaming deltas into its own card, so the
  // main tree's camera/relayout is not driven by every sub-agent token.
  let routingSubAgent = false;
  // User-configurable folding (set via the `config` message).
  let foldToolCalls = true;
  let foldThinking = true;

  /**
   * Apply a changed fold default to the cards already on screen — a settings
   * change must not wait for the next repaint. Card bodies are the only state
   * that matters (the chevron and the `.open` marker follow it), so a later
   * click on the header still toggles that single card as usual.
   */
  function applyFoldDefault(bodySelector, folded) {
    if (!messagesEl) return;
    for (const body of messagesEl.querySelectorAll(bodySelector)) {
      body.classList.toggle('hidden', folded);
      const parent = body.parentElement;
      if (!parent) continue;
      const chev = parent.querySelector('.chev');
      if (chev) chev.classList.toggle('open', !folded);
      if (parent.classList.contains('thinking')) parent.classList.toggle('open', !folded);
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
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
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
    if (md) {
      return md.render(text || '');
    }
    return escapeHtml(text);
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

  const LOCK_TITLE_ON = 'Auto-scroll on — click to release';
  const LOCK_TITLE_OFF = 'Auto-scroll off — click to follow again';

  // A green lock dot lives on the host of a scrollable container, in the strip
  // reserved below it (the container keeps a bottom margin so the dot sits just
  // under the scrollbar). Live turns start locked (following); finished nodes
  // start unlocked. Click to toggle manual follow.
  function attachLock(container, host, locked) {
    const dot = el('div', 'scroll-lock-dot' + (locked === false ? '' : ' locked'));
    const ctrl = createScrollController(container, (isLocked) => {
      dot.classList.toggle('locked', isLocked);
      dot.title = isLocked ? LOCK_TITLE_ON : LOCK_TITLE_OFF;
    }, locked);
    dot.title = ctrl.locked ? LOCK_TITLE_ON : LOCK_TITLE_OFF;
    dot.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ctrl.toggle();
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

  // ---- Message rendering into a container (defaults to the active node) ----
  // The pinned user prompt of the active node (top of an expanded card). It does
  // not scroll with the transcript and does not trigger tree panning.
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
        img.title = att.name || 'image';
        imgWrap.appendChild(img);
      }
      node.appendChild(imgWrap);
    }
    if (text) {
      node.appendChild(el('span', 'msg-text', text));
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
    body._scroll = attachLock(body, box);
    head.addEventListener('click', () => {
      body.classList.toggle('hidden');
      chev.classList.toggle('open');
      box.classList.toggle('open', !body.classList.contains('hidden'));
      if (body._scroll && !body.classList.contains('hidden')) body._scroll.scrollToBottom();
    });
    if (!foldThinking) {
      body.classList.remove('hidden');
      chev.classList.add('open');
      box.classList.add('open');
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
    let box = last.querySelector('.thinking');
    if (!box) {
      box = makeThinkingBlock('');
      const answer = last.querySelector('.answer');
      if (answer) last.insertBefore(box, answer);
      else last.appendChild(box);
    }
    const body = box.querySelector('.thinking-body');
    thinkingTextNode(body).appendData(text);
    // Folded-by-default means we don't force it open while streaming.
    if (!foldThinking) {
      body.classList.remove('hidden');
      const chev = box.querySelector('.chev');
      if (chev) chev.classList.add('open');
      box.classList.add('open');
    }
    if (body._scroll) body._scroll.scrollToBottom();
    followActive();
    return last;
  }

  function formatUsage(usage) {
    const hit = usage.prompt_cache_hit_tokens ?? 0;
    const miss = usage.prompt_cache_miss_tokens ?? 0;
    return 'tokens ' + usage.total_tokens +
      ' (prompt ' + usage.prompt_tokens + ' + completion ' + usage.completion_tokens + ')' +
      ' · cache hit ' + hit + ' / miss ' + miss;
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
          out.push('[raw ' + open.label + ': ' + (m.index - open.start) + ' chars]');
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

  function addTool(name, args, id, usage) {
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

  const liveTools = Object.create(null);

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
    followActive();
    return node;
  }

  function appendLiveTool(index, id, nameDelta, argsDelta) {
    let node = liveTools[index];
    if (!node) {
      node = addLiveTool(index, id, '', '');
    }
    if (id) node.dataset.id = id;
    if (argsDelta && node._argsText) node._argsText.appendData(argsDelta);
    if (argsDelta) node._argsEl.textContent = (node._argsEl.textContent || '') + argsDelta;
    node._bodyEl.classList.remove('hidden');
    if (node._chevEl) node._chevEl.classList.add('open');
    followActive();
    return node;
  }

  function finalizeLiveTool(index, id, name, args) {
    if (!messagesEl) return;
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

    node._bodyEl.innerHTML = '';
    if (args && args !== '{}') {
      node._bodyEl.appendChild(el('pre', 'tool-args', describeArgs(args)));
    }
    node._bodyEl.classList.remove('hidden');
    if (node._chevEl) node._chevEl.classList.add('open');
    followActive();
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
    if (!messagesEl) return;
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
    followActive();
  }

  function setToolStatus(id, status) {
    if (!messagesEl) return;
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

  function addBackgroundNotice(item) {
    if (!messagesEl) return;
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
    followActive();
    return node;
  }

  // Render a node's stored items: the user prompt goes to the pinned prompt area,
  // everything else into the scrollable transcript. Sets messagesEl/promptEl to the
  // node's containers for the duration.
  function renderNodeItems(itemsEl, promptElCard, items) {
    itemsEl.innerHTML = '';
    promptElCard.innerHTML = '';
    const prevMsg = messagesEl;
    const prevPrompt = promptEl;
    messagesEl = itemsEl;
    promptEl = promptElCard;
    let promptSet = false;
    for (const item of items) {
      if (item.kind === 'user') {
        if (!promptSet) {
          addUserPrompt(item.text, item.attachments);
          promptSet = true;
        }
      } else {
        renderItemInto(item);
      }
    }
    messagesEl = prevMsg;
    promptEl = prevPrompt;
  }

  // Render a stored DisplayItem into the current target container (messagesEl).
  function renderItemInto(item) {
    if (item.kind === 'user') {
      addUserPrompt(item.text, item.attachments);
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
      addTool(item.name, item.args, toolId, item.usage);
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

  // ---- Tree rendering ----
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
    const title = el('span', 'node-title', meta.title || '(no title)');
    const status = el('span', 'node-status', meta.status || '');
    status.dataset.role = 'status';
    head.appendChild(title);
    head.appendChild(status);
    // Delete-branch button: hover-revealed (see .node-del), so a destructive
    // action is not one stray click away. The host asks for a modal confirmation
    // before it removes anything (history + transcript dumps).
    const del = el('button', 'node-del', '🗑');
    del.title = 'Delete this branch — this turn and everything below it';
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      vscode.postMessage({ type: 'deleteBranch', id });
    });
    head.appendChild(del);
    card.appendChild(head);

    // Pinned user prompt (sticky at the top of an expanded card).
    const prompt = el('div', 'node-prompt');
    card.appendChild(prompt);

    const body = el('div', 'node-body');
    const items = el('div', 'node-items');
    const excerpt = el('div', 'node-excerpt');
    excerpt.textContent = meta.preview || meta.title || '';
    body.appendChild(items);
    body.appendChild(excerpt);
    card.appendChild(body);

    // Drag handle to resize the card (bottom-right).
    const handle = el('div', 'node-resize');
    handle.title = 'Drag to resize';
    card.appendChild(handle);

    // Internal transcript scroll + green lock dot. A live turn follows its own
    // output (locked); a finished node starts unlocked so it scrolls freely.
    card._itemScroll = attachLock(items, body, meta.status === 'running');

    nodeEls[id] = card;
    treeCanvas.appendChild(card);
    return card;
  }

  function expandedCard(id, meta, pnode) {
    const card = nodeEls[id];
    card.classList.add('expanded');
    card.classList.toggle('active', id === treeActiveId);
    const itemsEl = card.querySelector('.node-items');
    const promptElCard = card.querySelector('.node-prompt');
    const excerptEl = card.querySelector('.node-excerpt');
    // Populate from the path items, or (agent nodes) their own transcript; a
    // freshly-streamed node is filled incrementally, so never wipe it here.
    const source = pnode ? pnode.items : meta.items;
    if (source && !card._itemsRendered) {
      renderNodeItems(itemsEl, promptElCard, source);
      card._itemsRendered = true;
      // Thinking blocks only exist once the items are rendered, so apply the
      // finished-node default here (once, so a manual lock is not clobbered by
      // later re-renders).
      if (meta.status !== 'running') {
        setCardScrollLock(card, false);
        card._needsBottomScroll = true;
      }
    }
    promptElCard.classList.remove('hidden');
    itemsEl.classList.remove('hidden');
    excerptEl.classList.add('hidden');
    if (card._itemScroll && card._itemScroll.locked) {
      // Following a live turn: pin to the newest content.
      card._itemScroll.scrollToBottom();
    } else if (card._needsBottomScroll) {
      // Unlocked (finished) card: open at the newest content, then scroll freely.
      itemsEl.scrollTop = itemsEl.scrollHeight;
    }
    card._needsBottomScroll = false;
  }

  function collapsedCard(id, meta) {
    const card = nodeEls[id];
    card.classList.remove('expanded', 'active');
    const itemsEl = card.querySelector('.node-items');
    const promptElCard = card.querySelector('.node-prompt');
    const excerptEl = card.querySelector('.node-excerpt');
    excerptEl.textContent = meta.preview || meta.title || '';
    promptElCard.classList.add('hidden');
    itemsEl.classList.add('hidden');
    excerptEl.classList.remove('hidden');
  }

  function setActiveLeaf(id) {
    const card = id ? nodeEls[id] : null;
    messagesEl = card ? card.querySelector('.node-items') : null;
    promptEl = card ? card.querySelector('.node-prompt') : null;
    // The send pane lives at the bottom of the checked-out node's card, and only
    // there: a sub-agent branch is read-only (driven by the main agent through
    // spawn_agents / send_agent_message), and a session with no active node has
    // no card to inline it in — in both cases the pane is hidden entirely.
    const node = id ? treeNodes[id] : null;
    const hostCard = card && !(node && node.kind === 'agent') ? card : null;
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
    }
  }

  // Composer banner + readonly: when the checked-out node already has children,
  // sending creates a branch; when it is a read-only sub-agent node, the composer
  // is disabled (only the main agent may drive a sub-agent via spawn/send).
  function updateBranchBanner() {
    if (!branchBanner) return;
    const node = treeNodes[treeActiveId];
    const isAgent = !!(node && node.kind === 'agent');
    // Sub-agent nodes are display sidecars, not conversational branches — only a
    // *turn* child makes the next message a branch.
    const hasTurnChildren = !!(node && node.children && node.children.some((c) => treeNodes[c] && treeNodes[c].kind !== 'agent'));
    if (isAgent) {
      branchBanner.textContent = '子代理分支（只读）—— 由主 agent 通过 spawn_agents / send_agent_message 驱动';
      branchBanner.classList.remove('hidden');
    } else if (hasTurnChildren) {
      branchBanner.textContent = '⤷ branching from ' + (node.title || '(no title)') + ' — your reply starts a new branch';
      branchBanner.classList.remove('hidden');
    } else {
      branchBanner.classList.add('hidden');
    }
    // Read-only when the checked-out node is a sub-agent branch.
    const readonly = isAgent;
    inputEl.disabled = readonly;
    sendBtn.disabled = readonly;
    attachBtn.disabled = readonly;
  }

  // An agent (sub-agent) branch is expanded when it is the checked-out node, when
  // its parent is the active node, or when a parent AGENT is expanded — so the
  // sub-agents a turn just spawned stream beside it, and a depth-2 sub-agent of an
  // (expanded) depth-1 sub-agent stays open with it. Those on a branch you
  // navigated away from collapse.
  function agentExpanded(id) {
    let n = treeNodes[id];
    while (n && n.kind === 'agent') {
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

  // Route a streaming callback to a specific node's items container (sub-agents
  // stream in parallel, so deltas must target their own card). A missing nodeId
  // means the MAIN agent's turn → uses the current active-node container. After
  // writing, the target card's transcript follows to the bottom (respects lock).
  function routeTo(nodeId, fn) {
    if (!nodeId) {
      fn();
      return;
    }
    const card = nodeEls[nodeId];
    const el = card ? card.querySelector('.node-items') : null;
    if (!el) return;
    const prevMsg = messagesEl;
    const prevPrompt = promptEl;
    const prevRouting = routingSubAgent;
    messagesEl = el;
    promptEl = card.querySelector('.node-prompt');
    routingSubAgent = true;
    try {
      fn();
    } finally {
      messagesEl = prevMsg;
      promptEl = prevPrompt;
      routingSubAgent = prevRouting;
    }
    if (card && card._itemScroll) card._itemScroll.scrollToBottom();
    scheduleSubAgentRelayout();
  }

  // A sub-agent branch begins streaming: ensure its card, label it, add a Kill
  // button, and expand it so the live run is visible.
  function onAgentStart(msg) {
    if (!nodeEls[msg.id]) {
      createNodeCard(msg.id, treeNodes[msg.id] || { title: '子代理', status: 'running', kind: 'agent' });
    }
    const card = nodeEls[msg.id];
    if (!card) return;
    card.classList.add('agent');
    card.classList.add('expanded');
    card.querySelector('.node-items').classList.remove('hidden');
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
    info.textContent = `d${msg.depth || 1} · ${msg.model || ''}${msg.write ? ' · write' : ' · ro'}`;
    if (!card.querySelector('.node-kill')) {
      const kill = el('button', 'node-kill', '✕');
      kill.title = 'Kill this sub-agent';
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
      routeTo(msg.id, () => finalizeStreamingAnswer());
      const statusEl = card.querySelector('.node-status');
      if (statusEl) {
        statusEl.textContent = msg.status === 'done' ? 'done' : msg.status === 'error' ? 'error' : 'interrupted';
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
      }
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
    // No-node mode: the placeholder card is the entire tree.
    if (composerCard) {
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
    const heights = {};
    const widths = {};
    for (const id in nodeEls) {
      heights[id] = nodeEls[id].offsetHeight || 120;
      widths[id] = nodeEls[id].offsetWidth || NODE_W;
    }
    const result = window.treeLayout.layoutTree(treeNodes, treeRootId, heights, {
      nodeW: NODE_W,
      hGap: H_GAP,
      vGap: V_GAP,
      widths,
      agentGap: 80,
      agentVGap: 24,
    });
    treeCanvas.style.width = result.width + 'px';
    treeCanvas.style.height = result.height + 'px';
    for (const id in result.pos) {
      const card = nodeEls[id];
      if (card) {
        card.style.left = result.pos[id].x + 'px';
        card.style.top = result.pos[id].y + 'px';
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
      const isAgent = meta.kind === 'agent';
      const px = parseFloat(parent.style.left);
      const py = parseFloat(parent.style.top);
      const pw = parent.offsetWidth;
      const ph = parent.offsetHeight;
      const cx = parseFloat(child.style.left);
      const cy = parseFloat(child.style.top);
      const cw = child.offsetWidth;
      const ch = child.offsetHeight;
      if (isAgent) {
        // One spline: parent RIGHT edge → agent window LEFT edge; the edge turns
        // green when the sub-agent completes (red on error).
        const pr = px + pw;
        const pyMid = py + ph / 2;
        const cyMid = cy + ch / 2;
        const mx = (pr + cx) / 2;
        const cls = meta.agentStatus === 'done' ? ' edge-done' : meta.agentStatus === 'error' ? ' edge-error' : '';
        parts.push(
          '<path data-agent="' + id + '" class="edge-agent' + cls + '" d="M ' + pr + ' ' + pyMid + ' C ' + mx + ' ' + pyMid + ', ' + mx + ' ' + cyMid + ', ' + cx + ' ' + cyMid + '" />',
        );
      } else {
        const childMidX = cx + cw / 2;
        const parentBottomX = px + pw / 2;
        const parentBottomY = py + ph;
        const mx = (parentBottomX + childMidX) / 2;
        parts.push('<path d="M ' + parentBottomX + ' ' + parentBottomY + ' C ' + mx + ' ' + parentBottomY + ', ' + mx + ' ' + cy + ', ' + childMidX + ' ' + cy + '" />');
      }
    }
    treeEdges.innerHTML = parts.join('');
  }

  function applyTransform() {
    treeCanvas.style.transform = 'translate(' + pan.x + 'px, ' + pan.y + 'px) scale(' + zoom + ')';
  }

  function renderTree(tree) {
    treeNodes = Object.create(null);
    for (const n of tree.nodes || []) treeNodes[n.id] = n;
    treeRootId = tree.rootId ?? null;
    treeActiveId = tree.activeId ?? null;
    activePathSet = new Set(pathIdsFromTree(treeNodes, treeActiveId));

    for (const id in treeNodes) {
      if (!nodeEls[id]) createNodeCard(id, treeNodes[id]);
      const card = nodeEls[id];
      const n = treeNodes[id];
      if (card) {
        const statusEl = card.querySelector('.node-status');
        if (statusEl) statusEl.textContent = n.status || '';
      }
    }
    for (const id in nodeEls) {
      if (!treeNodes[id]) { nodeEls[id].remove(); delete nodeEls[id]; }
    }

    for (const id in nodeEls) {
      const onPath = activePathSet.has(id) || agentExpanded(id);
      if (onPath) {
        expandedCard(id, treeNodes[id], pathNodes[id]);
      } else {
        collapsedCard(id, treeNodes[id]);
      }
    }
    setActiveLeaf(treeActiveId);
    if (Object.keys(nodeEls).length === 0) {
      showComposerCard();
    } else {
      hideComposerCard();
    }
    relayout();
    if (follow) keepActiveInView();
    updateFollowButton();
    updateBranchBanner();
  }

  // The active path's items (checkout / session switch / panel reopen). This is
  // self-sufficient: it derives the active id + path from `path.ids` and only
  // updates/collapses existing cards, so a checkout never tears the tree down.
  function renderPath(path) {
    pathNodes = Object.create(null);
    for (const n of path.nodes || []) pathNodes[n.id] = n;
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
      if (!card._itemsRendered) {
        renderNodeItems(card.querySelector('.node-items'), card.querySelector('.node-prompt'), pnode.items);
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
      const onPath = activePathSet.has(id) || agentExpanded(id);
      if (onPath) {
        expandedCard(id, treeNodes[id] || { title: '', status: 'done', preview: '' }, pathNodes[id]);
      } else {
        collapsedCard(id, treeNodes[id] || { title: '', preview: '' });
      }
    }
    setActiveLeaf(treeActiveId);
    if (Object.keys(nodeEls).length === 0) {
      showComposerCard();
    } else {
      hideComposerCard();
    }
    relayout();
    if (follow) keepActiveInView();
    updateBranchBanner();
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
      head.appendChild(el('span', 'node-title', 'New session'));
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
    if (routingSubAgent) return;
    if (followRaf != null) return;
    followRaf = requestAnimationFrame(() => {
      followRaf = null;
      keepActiveInView();
      const card = treeActiveId ? nodeEls[treeActiveId] : null;
      if (card && card._itemScroll) card._itemScroll.scrollToBottom();
      if (treeActiveId && treeNodes[treeActiveId]?.children?.length) scheduleLayout();
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
      followBtn.title = follow ? 'Following the active node' : 'Follow the active node';
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
    resizing = {
      id,
      startX: e.clientX,
      startY: e.clientY,
      startW: card.offsetWidth,
      startH: card.offsetHeight,
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
    const h = clamp(resizing.startH + dh, MIN_H, MAX_H);
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
    // The pane scales with its host card's width.
    if (composerHost === card) syncComposerScale();
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
    if (rmbPressWantsMenu && !autoscroll) return;
    e.preventDefault();
  }, true);

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
    // .node-items / .thinking-body handles it natively. The composer is excluded
    // too — it lives inside a card now and owns its own wheel.
    const scrollable = e.target && e.target.closest ? e.target.closest('.node-items, .thinking-body, #composer') : null;
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

  // Reposition on resize so a long chain stays coherent.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => { relayout(); ensureNodeInView(); }).observe(treeWrap);
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
  function setBusy(value) {
    busy = value;
    modelSelect.disabled = value;
    effortSelect.disabled = value;
    if (value) {
      // A response is starting: re-engage the follow light for the live turn.
      setActiveScrollLock(true);
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

  // Filled from the provider's `config` message: the vendored model plus every
  // model the user declared in `agentHarness.modelTable`. No catalog copy here.
  let MODELS = [];
  let VISION_MODELS = [];

  function renderModelSelect(model) {
    currentModel = model;
    modelSelect.innerHTML = '';
    if (MODELS.length === 0) {
      // Before the first config message: show the current model so the header is
      // never empty (the dropdown is disabled while a turn runs anyway).
      if (model) {
        MODELS = [model];
      }
    }
    for (const m of MODELS) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      opt.selected = m === model;
      modelSelect.appendChild(opt);
    }
  }

  function hasVisionModel() {
    return VISION_MODELS.includes(currentModel);
  }

  function updateImageVisibility() {
    const hasVision = hasVisionModel();
    treeCanvas.classList.toggle('hide-images', !hasVision);
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

  function setStatus(text) {
    if (statusText) statusText.textContent = text || '';
  }

  function setContext(used, total) {
    const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
    contextLabel.textContent = 'ctx ' + (total > 0 ? Math.round(pct) : 0) + '%';
    const elCtx = document.getElementById('context');
    if (elCtx) elCtx.title = 'Context: ' + used + ' / ' + total + ' tokens (' + pct.toFixed(1) + '%)';
  }

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
      showAttachHint(
        VISION_MODELS.length > 0
          ? 'Switch to a vision model (' + VISION_MODELS.join(' / ') + ') to attach an image.'
          : 'No image-capable model is configured — declare one in agentHarness.modelTable to attach an image.',
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
    setFollow(true);
    vscode.postMessage({ type: 'userMessage', text, attachments: pendingAttachments });
    pendingAttachments = [];
    renderPendingAttachments();
    inputEl.value = '';
    autoGrow();
  }

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, Math.round(160 * composerScale)) + 'px';
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

  window.addEventListener('message', (event) => {
    const msg = event.data;
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
      case 'panTo':
        panToNode(String(msg.id ?? ''));
        break;
      case 'config': {
        const prevFoldToolCalls = foldToolCalls;
        const prevFoldThinking = foldThinking;
        if (Array.isArray(msg.models) && msg.models.length > 0) {
          MODELS = msg.models;
        }
        VISION_MODELS = Array.isArray(msg.visionModels) ? msg.visionModels : [];
        renderModelSelect(msg.model);
        renderEffortSelect(msg.thinkingEffort);
        foldToolCalls = msg.foldToolCalls !== false;
        foldThinking = msg.foldThinking !== false;
        // A changed fold default must apply to the cards already on screen too,
        // not only to the ones rendered after it (clicking a header still
        // toggles that single card afterwards).
        if (foldToolCalls !== prevFoldToolCalls) {
          applyFoldDefault('.tool-body', foldToolCalls);
        }
        if (foldThinking !== prevFoldThinking) {
          applyFoldDefault('.thinking-body', foldThinking);
        }
        updateImageVisibility();
        break;
      }
      case 'state':
        setBusy(msg.busy);
        setStatus(msg.status);
        rememberSession(msg.sessionId);
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
        addUserPrompt(msg.text, msg.attachments);
        break;
      case 'backgroundNotice':
        addBackgroundNotice(msg.item);
        break;
      case 'imagePicked':
        addPendingAttachment(msg.dataUrl, msg.name);
        break;
      case 'delta':
        addTpsTokens(msg.text);
        routeTo(msg.nodeId, () => appendAssistant(msg.text));
        break;
      case 'thinkingDelta':
        addTpsTokens(msg.text);
        routeTo(msg.nodeId, () => appendThinking(msg.text));
        break;
      case 'usage':
        routeTo(msg.nodeId, () => appendUsage(msg.usage));
        break;
      case 'toolCallDelta':
        addTpsTokens((msg.name || '') + (msg.args || ''));
        routeTo(msg.nodeId, () => appendLiveTool(msg.index, msg.id, msg.name, msg.args));
        break;
      case 'toolStart':
        routeTo(msg.nodeId, () => { finalizeStreamingAnswer(); finalizeLiveTool(msg.index, msg.id, msg.name, msg.args); });
        break;
      case 'toolEnd':
        routeTo(msg.nodeId, () => updateTool(msg.id, msg.content));
        break;
      case 'agentStart':
        onAgentStart(msg);
        break;
      case 'agentDone':
        onAgentDone(msg);
        break;
      case 'done':
        finalizeStreamingAnswer();
        clearLiveTools();
        setBusy(false);
        setActiveScrollLock(false);
        break;
      case 'interrupted':
        finalizeStreamingAnswer();
        clearLiveTools();
        setBusy(false);
        setStatus('Interrupted');
        setActiveScrollLock(false);
        break;
      case 'error':
        finalizeStreamingAnswer();
        clearLiveTools();
        addAssistant('⚠️ ' + msg.message, true);
        setBusy(false);
        setStatus('Error');
        setActiveScrollLock(false);
        break;
      case 'notice':
        addNotice(msg.kind, msg.text);
        break;
      case 'reset':
        clearLiveTools();
        for (const id in nodeEls) { nodeEls[id].remove(); }
        for (const id in nodeEls) delete nodeEls[id];
        pathNodes = Object.create(null);
        treeNodes = Object.create(null);
        treeRootId = null;
        treeActiveId = null;
        activePathSet = new Set();
        messagesEl = null;
        renderTree({ nodes: [], rootId: null, activeId: null });
        break;
      default:
        break;
    }
  });

  // ---- Composer dock ----
  // The send pane is the active node's input dock: it is moved into the active
  // node's card, at its bottom, so it pans/zooms with the tree and is visibly
  // attached to the node it sends into. It is NEVER docked anywhere else — when
  // there is no host card (empty session uses the placeholder card, a focused
  // sub-agent branch is read-only) the pane is hidden / kept out of the DOM.
  // `--cs` scales every control and font in the pane and follows the host card's
  // width, so dragging the card's resize handle scales the pane with the card.
  const COMPOSER_BASE_W = 560;          // .node.expanded's default width
  const MIN_COMPOSER_SCALE = 0.8;
  const MAX_COMPOSER_SCALE = 1.6;

  let composerScale = 1;
  // `undefined` until the first mount, so the initial call always applies.
  let composerHost;                     // the card the pane is currently mounted in

  function composerScaleFor(width) {
    return Math.max(MIN_COMPOSER_SCALE, Math.min(MAX_COMPOSER_SCALE, width / COMPOSER_BASE_W));
  }

  /** Re-derive `--cs` from the host card's width (or the panel when there is none). */
  function syncComposerScale() {
    const width = composerHost ? composerHost.offsetWidth : window.innerWidth;
    composerScale = composerScaleFor(width);
    composerEl.style.setProperty('--cs', String(composerScale));
    autoGrow();
  }

  /**
   * Inline the pane at the bottom of `card`, or take it out of the DOM entirely
   * when there is no host card (there is no floating/docked fallback).
   */
  function mountComposer(card) {
    if (composerHost === card) {
      syncComposerScale();
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
    syncComposerScale();
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

  // The panel is the reference width when the pane has no host card, so
  // re-derive the scale when the panel is resized.
  window.addEventListener('resize', syncComposerScale);

  // ---- Input handlers ----
  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', () => {
    setStatus('Stopping…');
    vscode.postMessage({ type: 'stop' });
  });
  attachBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'pickImage' });
  });
  modelSelect.addEventListener('change', () => {
    if (busy) {
      renderModelSelect(currentModel);
      return;
    }
    vscode.postMessage({ type: 'setModel', model: modelSelect.value });
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
  setStatus('Ready');
  updateImageVisibility();
  updateFollowButton();
})();
