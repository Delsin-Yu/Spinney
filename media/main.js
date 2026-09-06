(function () {
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send-btn');
  const stopBtn = document.getElementById('stop-btn');
  const clearBtn = document.getElementById('clear-btn');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const attachmentsEl = document.getElementById('attachments');
  const attachBtn = document.getElementById('attach-btn');
  const contextFill = document.getElementById('context-fill');
  const contextLabel = document.getElementById('context-label');
  const sessionSelect = document.getElementById('session-select');
  const newSessionBtn = document.getElementById('new-session-btn');
  const deleteSessionBtn = document.getElementById('delete-session-btn');

  let busy = false;
  let pendingAttachments = [];

  // ---- Element helpers (textContent only; no unsanitized HTML) ----
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
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

  function addAssistant(text, error) {
    const node = el('div', 'msg assistant' + (error ? ' error' : ''), text);
    node.dataset.kind = 'assistant';
    messagesEl.appendChild(node);
    scrollToBottom();
    return node;
  }

  function appendAssistant(text) {
    const last = messagesEl.lastElementChild;
    if (last && last.dataset.kind === 'assistant' && !last.classList.contains('error')) {
      last.textContent += text;
      scrollToBottom();
      return last;
    }
    return addAssistant(text, false);
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
    let target = messagesEl.lastElementChild;
    if (!target || target.dataset.kind !== 'assistant') {
      target = addAssistant('', false);
    }
    target.appendChild(el('div', 'usage-line', formatUsage(usage)));
    scrollToBottom();
  }

  function addTool(name, args, id) {
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
      try {
        const parsed = JSON.stringify(JSON.parse(args), null, 2);
        body.appendChild(el('pre', 'tool-args', parsed));
      } catch (e) {
        body.appendChild(el('pre', 'tool-args', args));
      }
    }

    head.addEventListener('click', () => {
      body.classList.toggle('hidden');
      chev.classList.toggle('open');
    });

    node.appendChild(body);

    const statusEl = status;
    statusEl.dataset.role = 'status';
    // keep a stable reference via closure
    node._statusEl = statusEl;
    node._bodyEl = body;

    messagesEl.appendChild(node);
    scrollToBottom();
    return node;
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
    messagesEl.innerHTML = '';
    if (!items || items.length === 0) {
      messagesEl.appendChild(
        el('div', 'empty', 'Welcome. Ask the agent to read or write files, or run a command.'),
      );
      return;
    }
    for (const item of items) {
      if (item.kind === 'user') {
        addUser(item.text, item.attachments);
      } else if (item.kind === 'assistant') {
        addAssistant(item.text, item.error);
        if (item.usage) {
          const node = messagesEl.lastElementChild;
          if (node) node.appendChild(el('div', 'usage-line', formatUsage(item.usage)));
        }
      } else if (item.kind === 'tool') {
        const toolId = item.id || 'history-' + item.name + '-' + (item.status || '');
        const node = addTool(item.name, item.args, toolId);
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

  function showEmptyIfNeeded() {
    if (messagesEl.children.length === 0) {
      messagesEl.appendChild(
        el('div', 'empty', 'Welcome. Ask the agent to read or write files, or run a command.'),
      );
    }
  }

  // ---- State ----
  function setBusy(value) {
    busy = value;
    sessionSelect.disabled = value;
    newSessionBtn.disabled = value;
    deleteSessionBtn.disabled = value;
    if (value) {
      stopBtn.classList.remove('hidden');
      sendBtn.classList.add('hidden');
      statusDot.className = 'dot busy';
    } else {
      stopBtn.classList.add('hidden');
      sendBtn.classList.remove('hidden');
      statusDot.className = 'dot idle';
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
    statusText.textContent = text || '';
  }

  function formatCompact(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
  }

  function setContext(used, total) {
    const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
    contextFill.style.width = pct.toFixed(1) + '%';
    contextFill.style.background =
      pct >= 95 ? 'var(--error-text)' : pct >= 80 ? 'var(--warn)' : 'var(--accent)';
    contextLabel.textContent = 'ctx ' + formatCompact(used) + ' / ' + formatCompact(total);
    const elCtx = document.getElementById('context');
    if (elCtx) elCtx.title = 'Context: ' + used + ' / ' + total + ' tokens';
  }

  // ---- Pending attachments (composer previews) ----
  function addPendingAttachment(dataUrl, name) {
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
      case 'sessions':
        renderSessions(msg.sessions, msg.activeId);
        break;
      case 'state':
        setBusy(msg.busy);
        setStatus(msg.status);
        break;
      case 'context':
        setContext(msg.used, msg.total);
        break;
      case 'status':
        setStatus(msg.text);
        break;
      case 'user':
        addUser(msg.text, msg.attachments);
        break;
      case 'imagePicked':
        addPendingAttachment(msg.dataUrl, msg.name);
        break;
      case 'delta':
        appendAssistant(msg.text);
        break;
      case 'usage':
        appendUsage(msg.usage);
        break;
      case 'toolStart':
        addTool(msg.name, msg.args, msg.id);
        break;
      case 'toolEnd':
        updateTool(msg.id, msg.content);
        break;
      case 'done':
        // The provider sends the final status text right before this event.
        setBusy(false);
        showEmptyIfNeeded();
        break;
      case 'interrupted':
        setBusy(false);
        setStatus('Interrupted');
        break;
      case 'error':
        addAssistant('⚠️ ' + msg.message, true);
        setBusy(false);
        setStatus('Error');
        break;
      case 'reset':
        messagesEl.innerHTML = '';
        showEmptyIfNeeded();
        break;
      default:
        break;
    }
  });

  // ---- Input handlers ----
  sendBtn.addEventListener('click', send);
  clearBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'clear' });
  });
  stopBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'stop' });
  });
  attachBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'pickImage' });
  });
  sessionSelect.addEventListener('change', () => {
    vscode.postMessage({ type: 'switchSession', id: sessionSelect.value });
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

  // Initial handshake.
  vscode.postMessage({ type: 'ready' });
  showEmptyIfNeeded();
  setStatus('Ready');
})();
