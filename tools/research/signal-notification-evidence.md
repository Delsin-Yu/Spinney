# 证据：只读子代理调研报告（原始全文）

来源：会话 `mtw30amf0p2w4u` 派出的 3 个**只读**子代理（`spawn_agents`, `write:false`）。
以下是各自 transcript 里全部 assistant 正文的原文拼接（含它们之间的补充说明段），未做编辑。
三个子代理均未修改仓库；行号对应基线 commit `26e0493`（分支 `ui/polish`）。

| # | 子代理 node id | transcript | 主题 |
| --- | --- | --- | --- |
| 1 | `mtw3b8lw40izlj` | `<globalStorage>/transcripts/mtw30amf0p2w4u/mtw3b8lw40izlj.jsonl` | 后台终端 / 异步子代理扩展侧投递管线、isHeld、持久化 |
| 2 | `mtw3b8lws9cy7j` | `<globalStorage>/transcripts/mtw30amf0p2w4u/mtw3b8lws9cy7j.jsonl` | agent 回合循环与消息合法性（注入点可行性） |
| 3 | `mtw3b8lw09dak7` | `<globalStorage>/transcripts/mtw30amf0p2w4u/mtw3b8lw09dak7.jsonl` | webview 侧：卡片渲染、dock、backgroundNotice、tree.js 侧车布局、流式路由 |

本文件是 `tools/research/signal-notification-plan.md` 的原始证据（dev-only，不进 `.vsix`）。

---


============================ mtw3b8lw40izlj — 后台终端 / 异步子代理扩展侧投递管线、isHeld、持久化 ============================
I'll start by locating the key files and getting an overview of the chat module.

---
# 后台终端 / 异步子代理 完成通知投递管线（只读调研报告）

调研范围：`src/chat/backgroundHub.ts`、`src/chat/runtime.ts`、`src/chat/SubAgentPool.ts`，并交叉核对 `src/tools/background.ts`、`src/tools/backgroundTools.ts`、`src/chat/ChatViewProvider.ts`、`src/chat/tree.ts`、`src/agent/agent.ts`、`src/http/controlServer.ts`、`media/main.js`。所有行号已逐条打开确认。

---

## 0. 总览：两条管线、两个队列、一个共用的投递闸门

| 维度 | 后台终端管线 | 子代理(async)管线 |
|---|---|---|
| 队列 | `backgroundNotifQueue: BackgroundNotice[]` (`runtime.ts:301`) | `subAgentNoticeQueue[]` (`runtime.ts:295`) + `subAgentChildNotices: Map` (`:297`) |
| 合并计时器 | `backgroundDrainTimer` (`:303`, 75ms) | `lastSubAgentDrain` (`:298`, 75ms) |
| 投递入口 | `onBackgroundFinished` (`:2373`) → `drainBackgroundQueue` (`:2529`) → `injectBackgroundNotices` (`:2442`) | `onAsyncBatchDone` (`:2164`) / `deliverResumeAsync` (`:1746`) → `scheduleSubAgentDrain` (`:2183`) → `drainSubAgentNotices` (`:2197`) |
| 建 node？ | **是**（`beginTurn`,新 node,`:2482`） | **否**（`beginInjectedTurn`,复用父 node,`:2226`） |
| 共用 | `busy` 闸门、`heldBackoff()`、`setBusy`、`Agent.sendUserMessage`、`nodeWorkers`、`handleAgentEventForNode` 里同一批调用点 | 同左 |

`SubAgentPool.ts` 是**纯并发槽池**（`withSlot`/`acquire`/`release`，79 行），完全不参与通知逻辑——通知全在 `runtime.ts`。

---

## 1. 后台 job 完成：`onBackgroundFinished` 做什么 + notice 文本 + 队列

### 1.1 触发链（数据从进程 exit 一路到 runtime）

1. `src/tools/background.ts:195-196`：
```ts
    handle.child.on('close', (code) => this.complete(task, code));
    handle.child.on('error', () => this.complete(task, null));
```
2. `background.ts:208-220` `complete()` —— 幂等收尾，捕获 `exitCode`、`truncated`，唤醒 joiners，最后：
```ts
    for (const w of task.waiters.splice(0)) {
      w(task);
    }
    this.onFinish?.(task);
    this.onUpdated?.();
```
（`kill()` 也在 `:271` 直接同步调 `complete(task, null)`，所以被杀的任务立即算 finished。）
3. `src/chat/backgroundHub.ts:73-80` `registryFor()` 在懒建 registry 时把 hooks 读时绑定，把 `owner` 闭包进去：
```ts
      registry.setOnUpdated(() => this.hooks.onUpdated?.(owner));
      registry.setOnFinish((task) => this.hooks.onFinish?.(owner, task));
```
4. `src/chat/ChatViewProvider.ts:228-231`（`init` 里一次装好）：
```ts
    this.backgroundHub.setHooks({
      onUpdated: (owner) => this.runtimes.get(owner.sessionId)?.refreshBackgrounds(),
      onFinish: (owner, task) => this.runtimes.get(owner.sessionId)?.onBackgroundFinished(owner, task),
    });
```
注意：**session 没有活 runtime 时回调直接丢弃**（未加载的会话不 repaint、不投递）。

### 1.2 `onBackgroundFinished`（`runtime.ts:2373-2387`，原样）

```ts
  onBackgroundFinished(owner: BackgroundOwner, task: BackgroundTask): void {
    if (this.dead) {
      return;
    }
    if (task.notifyAgent !== true) {
      // Tool-initiated kill/join already informed the agent via the tool result, so
      // the task is considered delivered and leaves the pending dock state.
      task.delivered = true;
      this.postBackgrounds();
      return;
    }
    const notice = this.buildBackgroundNotice(owner, task);
    this.backgroundNotifQueue.push(notice);
    this.scheduleBackgroundDrain();
  }
```
- `notifyAgent === false` 的三种来源：工具内 kill（`backgroundTools.ts:87`）、`join_background`（`:127` 置 false，`:131` 被中断时再置回 true）、`BackgroundRegistry.kill(..., {notifyAgent:false})`（`background.ts:263-265`）。
- `dead` = `disposed || host.disposed`（`:504-506`）。

### 1.3 notice 文本拼装（`runtime.ts:2408-2420`，原样）

```ts
  private buildBackgroundNotice(owner: BackgroundOwner, task: BackgroundTask): BackgroundNotice {
    const cmd = this.truncateField(task.command, 100);
    const doneText = task.killed
      ? 'was killed by the user'
      : `finished with exit code ${task.exitCode ?? 'unknown'}`;
    const output = this.truncateField(task.handle.getOutput().trim(), 1200);
    const text = `Background command \`${cmd}\` (id ${task.id}) ${doneText}.${output ? `\nOutput:\n${output}` : ''}`;
    return { text, taskId: task.id, nodeId: owner.nodeId, id: task.id, cmd, doneText, output };
  }

  private truncateField(value: string, limit: number): string {
    return value.length > limit ? value.slice(0, limit) + '…' : value;
  }
```

多 notice 合并成一条 agent 消息（`:2423-2429`，原样）：

```ts
  private combineNotices(notices: BackgroundNotice[]): string {
    if (notices.length === 1) {
      return notices[0].text;
    }
    const lines = notices.map((n) => `- ${n.text}`);
    return `[Background terminal notice] ${notices.length} background tasks finished:\n${lines.join('\n')}`;
  }
```

### 1.4 队列数据结构（`runtime.ts:154-166`，原样）

```ts
/** A queued background-completion notification waiting for the agent to go idle. */
interface BackgroundNotice {
  text: string;
  /** The background-terminal id, used to drop a notice the agent already handled via join/kill. */
  taskId: number;
  /** The node the job belongs to: the notice turn is based on it, never on the view. */
  nodeId: string;
  /** Card fields: task id, command, status phrase, and output tail. */
  id: number;
  cmd: string;
  doneText: string;
  output: string;
}
```
字段声明：`private backgroundNotifQueue: BackgroundNotice[] = [];`（`:301`），`private backgroundDrainTimer` (`:303`)。

`BackgroundTask` 形状见 `src/tools/background.ts:124-151`（`id/command/cwd/startedAt/status/exitCode/killed/truncated/handle/notifyAgent/delivered/waiters`）；`BackgroundOwner = { sessionId, nodeId }`（`backgroundHub.ts:20`）；hook 签名 `BackgroundHubHooks.onFinish?: (owner, task) => void`（`backgroundHub.ts:36-37`）。

---

## 2. 调用点与 "now if idle else end of turn" 判定

### 2.1 `drainBackgroundQueue` 的全部调用点

| 位置 | 谁 / 时机 |
|---|---|
| `runtime.ts:355` | `SessionRuntime` 构造函数末尾（runtime 被创建时，把上次遗留的队列投出去） |
| `runtime.ts:1443` | `handleAgentEventForNode` 的 `case 'done'`，在 `finishTurn` + `syncBusy()` 之后 |
| `runtime.ts:1457` | `case 'interrupted'` 同上 |
| `runtime.ts:1472` | `case 'error'` 同上 |
| `runtime.ts:2402-2405` | `scheduleBackgroundDrain` 的 75ms 计时器回调 |
| `runtime.ts:2363` | `heldBackoff` 的重试（500ms 后再 `scheduleBackgroundDrain`） |

```ts
// runtime.ts:1439-1445
        if (run) this.finishTurn(run, 'done');
        // P3: `busy` clears only once the *last* run of the session is gone.
        this.syncBusy();
        void this.refreshBalance();
        this.drainBackgroundQueue();
        this.drainSubAgentNotices();
```

### 2.2 "now if idle else end of turn" 的三处具体条件

```ts
// runtime.ts:2395-2406  —— 决定是否设 75ms 计时器（即"现在投")
  private scheduleBackgroundDrain(): void {
    if (this.busy) {
      return;
    }
    if (this.backgroundDrainTimer != null) {
      return;
    }
    this.backgroundDrainTimer = setTimeout(() => {
      this.backgroundDrainTimer = null;
      this.drainBackgroundQueue();
    }, 75);
  }
```
```ts
// runtime.ts:2529-2535  —— drain 入口
  drainBackgroundQueue(): void {
    if (this.busy) {
      return;
    }
    if (this.heldBackoff(() => this.scheduleBackgroundDrain())) {
      return;
    }
```
```ts
// runtime.ts:2449-2452  —— 真正投递前再确认一次
    if (this.busy) {
      this.backgroundNotifQueue.push(...notices);
      return;
    }
```

- `busy` 的语义：`syncBusy()` = `setBusy(this.uploadController != null || this.runs.size > 0)`（`:975-977`），即"本 session 还有 live run / 上传"。
- 所以逻辑是：**idle 时** 走 `scheduleBackgroundDrain` 的 75ms 合并窗 → 立刻成一条 turn；**busy 时** `scheduleBackgroundDrain` 直接返回、notice 只留在队列，等 turn 结束的 `handleAgentEvent`（`:1443/1457/1472`）再 drain。
- 最终投递再延一个 tick，避开 turn 的 `finally` 尚未复位 `agent.running`：

```ts
// runtime.ts:2536-2564（节选）
    const real: BackgroundNotice[] = [];
    let i = 0;
    while (i < queue.length) {
      const q = queue[i];
      if (this.taskAlreadyHandled(q)) {
        this.markDelivered(q.taskId);
        queue.splice(i, 1);
        continue;
      }
      real.push(queue.splice(i, 1)[0]);
    }
    if (real.length === 0) { this.postBackgrounds(); return; }
    setTimeout(() => {
      if (this.busy) { this.backgroundNotifQueue.push(...real); return; }
      this.injectBackgroundNotices(real);
    }, 0);
```

`taskAlreadyHandled`（`:2510-2521`）：task 已从 hub 消失 / 所属 node 已被删 / `notifyAgent !== true` → 视为陈旧，丢弃并 `markDelivered`。

### 2.3 一次 drain 只投一组

`injectBackgroundNotices` 按 `nodeId` 分组（`:2453-2461`），只取第一个 node 仍存在的组投递（`:2462`），其余回队（`:2472-2475`）；所有 owner node 都没了就全部丢弃（`:2463-2470`）。

---

## 3. 投递 notice 时是否创建新 node？`beginTurn` 语义与焦点影响

**是：后台终端 notice 会创建一个新 node。**

```ts
// runtime.ts:2476-2503（原样）
    // The notice turn is a new node *under the owning node*, so the card and the
    // agent's reply land in their own block of the branch that spawned the job.
    const title =
      batch.length === 1
        ? `Background #${batch[0].id}: ${batch[0].cmd}`
        : `Background: ${batch.length} tasks finished`;
    const run = this.beginTurn(titleFromPrompt(title), { parentId: ownerNodeId, pan: false });
    if (!run) {
      this.backgroundNotifQueue.push(...batch);
      return;
    }
    for (const n of batch) {
      // The notice is now reaching the agent, so the task leaves the pending dock.
      this.markDelivered(n.taskId);
      run.items.push({ kind: 'background', id: String(n.id), name: n.cmd, doneText: n.doneText, content: n.output });
      this.post({
        type: 'backgroundNotice',
        nodeId: run.nodeId,
        item: { id: n.id, name: n.cmd, doneText: n.doneText, content: n.output },
      });
    }
```

### 3.1 `beginTurn` 签名与语义（`runtime.ts:996-1052`）

```ts
  private beginTurn(title: string, opts?: { parentId?: string | null; pan?: boolean }): TurnRun | null {
    const session = this.session;
    if (this.host.isHeld()) {
      ...
      return null;
    }
    const parentId = opts?.parentId !== undefined ? opts.parentId : session.activeNodeId;
    // P3: only the basis node must be free. `parentId` null (the session's first
    // turn) can never be running, so it is never refused.
    if (parentId != null && this.runs.has(parentId)) {
      this.postNotice('warning', 'A turn is already running in this session. …');
      return null;
    }
    const node = createNode(newId(), parentId, title, 'running');
    attachNode(session, node);
    const worker = this.workerFor(node);
    … // transferInterruptTo / resetInterruptState, setMessages(buildPath), runs.set, postTree
    if (opts?.pan !== false) {
      this.post({ type: 'panTo', id: node.id });
    }
    return run;
  }
```

- `parentId`：**basis node**（这个 turn 从哪个 node 继续）。默认 `session.activeNodeId`；notice 路径显式传 `ownerNodeId` = 拥有该 job 的 node（`:2415` 的 `nodeId: owner.nodeId`，来自 `BackgroundOwner`）。故新 node 的 `parentId` **就是 spawn 这个 job 的那个 node**，与当前视图焦点无关。
- `pan`：`true`（默认）时发 `panTo`（`:1048-1050`，UI 镜头移动）；notice 传 `pan: false`，**不移动镜头**。
- `title`：`titleFromPrompt(title)` 截首行 80 字符（`tree.ts:151-154`）。
- 拒绝条件：`host.isHeld()`（`:998`）或 basis node 已有 live run（`:1009`）→ 返回 `null`，调用方回队。

### 3.2 焦点 / checkout：**checkout 确实会变，pan 不会**

- `attachNode` 末尾有 `session.activeNodeId = node.id;`（`tree.ts:257`），即新 notice node 会被 check out。
- `beginTurn` 紧接着 `this.postTree()`（`:1047`），而 `postTree` 发的 `viewId` 就是 `session.activeNodeId`（`:770-796`），`media/main.js:1477-1485` 里 `treeActiveId = tree.viewId` —— 视图焦点（tree 高亮/展开）会跟到新的 notice node。
- 因此严格说：**"不 pan、不抢镜头"** 成立（没有 `panTo`，也不改用户当前正在看的 path 之外的东西），但 `activeNodeId`（checkout）**是会被改写的**。注释里 "lands in X without moving anything"（`:2436-2440`）指的是基于 owner node 而不是 view focus 建 node、且不 pan；不是"不动 activeNodeId"。

> 对比：子代理 notice 走 `beginInjectedTurn`（`:1054-1089`），注释明确 "does not create a node and does not move the view focus"（`:1055-1057`），代码里也确实没有 `attachNode`/`activeNodeId` 赋值。

---

## 4. 子代理异步完成的 notice 产生与投递

`SubAgentPool.ts` 无任何通知代码。全部在 `runtime.ts`。

### 4.1 触发源 A：`spawn_agents` `mode:'async'`

```ts
// runtime.ts:1845-1867（节选）
    if (mode === 'async') {
      const mainParent = parent.kind !== 'agent';
      const tasks = jobs.map((job) => {
        const run = () => this.runSubAgent(job, signal);
        return (childDepth === 1 ? this.subAgentPool.withSlot(run) : run()).then((result) => ({ job, result }));
      });
      void Promise.allSettled(tasks).then((settled) => {
        const list = settled.map((s, i) =>
          s.status === 'fulfilled' ? s.value : { job: jobs[i], result: { ok: false, summary: 'cancelled' } },
        );
        this.onAsyncBatchDone(mainParent, parent, list.map((l) => ({ ...l.result, node: l.job.node })));
      });
      return JSON.stringify({ spawned: jobs.length, async: true, ids: …, transcriptDir: … });
    }
```
（子代理节点创建在 `:1826-1836`；视图焦点在 `:1840-1842` 被恢复，子代理卡片永不抢焦点。）

```ts
// runtime.ts:2164-2181（原样）
  private onAsyncBatchDone(mainParent: boolean, parent: TreeNode, results: Array<{ ok: boolean; summary: string; node: TreeNode }>): void {
    if (!mainParent) {
      this.queueSubAgentChildNotice(parent, results);
      return;
    }
    const lines = results.map((r) => `子代理 #${r.node.id.slice(-6)} ${r.ok ? '完成' : '失败'}: ${r.summary || '(no summary)'}${this.transcriptNote(r.node)}`);
    const cardText = lines.join('\n');
    const doneText = `${results.length} 个子代理完成`;
    parent.displayItems.push({ kind: 'background', id: `sub-aware-${parent.id}`, name: '子代理完成', content: cardText, doneText });
    this.post({ type: 'backgroundNotice', nodeId: parent.id, item: { id: `sub-${parent.id}`, name: '子代理完成', doneText, content: cardText } });
    this.subAgentNoticeQueue.push({ nodeId: parent.id, summary: cardText, status: 'done', count: results.length });
    this.scheduleSubAgentDrain();
    this.host.persist();
  }
```

### 4.2 触发源 B：`send_agent_message` `mode:'async'`

`runtime.ts:1727-1730` 起异步，回调走 `deliverResumeAsync`：

```ts
// runtime.ts:1746-1774（节选）
  private deliverResumeAsync(node: TreeNode, result: { ok: boolean; summary: string; model?: string }): void {
    const parent = this.session.nodes[node.parentId ?? ''] ?? null;
    if (!parent) return;
    const cardText = `子代理 #${node.id.slice(-6)} ${result.ok ? '完成' : '失败'}: ${result.summary || '(no summary)'}${this.transcriptNote(node)}`;
    parent.displayItems.push({ kind: 'background', id: `sub-msg-${node.id}`, name: '子代理完成', content: cardText, doneText: '子代理完成' });
    this.post({ type: 'backgroundNotice', nodeId: parent.id, item: { id: `sub-msg-${node.id}`, … } });
    if (parent.kind === 'agent') {
      this.queueSubAgentChildNotice(parent, [{ ok: result.ok, summary: result.summary, node }]);
    } else {
      this.subAgentNoticeQueue.push({ nodeId: parent.id, summary: cardText, status: 'done', count: 1 });
      this.scheduleSubAgentDrain();
    }
    this.host.persist();
  }
```

### 4.3 `queueSubAgentChildNotice` / `flushSubAgentChildNotices`

```ts
// runtime.ts:1976-1994（原样，notice 文本来源）
  private queueSubAgentChildNotice(parent: TreeNode, results: Array<{ ok: boolean; summary: string; node: TreeNode }>): void {
    const lines = results.map(
      (r) => `子代理 #${r.node.id.slice(-6)} ${r.ok ? '完成' : '失败'}: ${r.summary || '(no summary)'}${this.transcriptNote(r.node)}`,
    );
    const notice = `[子代理批次] ${results.length} 个子代理完成\n${lines.join('\n')}`;
    if (this.runningSubAgents.has(parent.id)) {
      const q = this.subAgentChildNotices.get(parent.id) ?? [];
      q.push({ message: notice });
      this.subAgentChildNotices.set(parent.id, q);
      return;
    }
    const abort = new AbortController();
    void this.runSubAgent(
      { node: parent, spec: { instruction: notice, write: parent.agentWrite ?? false, model: undefined }, resume: true, sessionId: this.sessionId },
      abort.signal,
    );
  }
```
- 语义："父是**子代理**（depth-1）时的通知通道"。父还在跑 → 存 `subAgentChildNotices`（Map, `:297`）；父已结束 → 直接以 `resume:true` 重跑该子代理（新 user 卡 `:1959-1962`）。

```ts
// runtime.ts:1997-2015（原样，触发点）
  private flushSubAgentChildNotices(node: TreeNode): void {
    const queued = this.subAgentChildNotices.get(node.id);
    if (!queued || queued.length === 0) return;
    const notice = queued.shift()!;
    if (queued.length === 0) this.subAgentChildNotices.delete(node.id);
    if (this.runningSubAgents.has(node.id)) return; // 新 run 已接手，留给它
    const abort = new AbortController();
    void this.runSubAgent({ node, spec: { instruction: notice.message, write: node.agentWrite ?? false, model: undefined }, resume: true, sessionId: this.sessionId }, abort.signal);
  }
```
唯一调用点：`runSubAgent` 的 `finish()` 内 `runtime.ts:1920`——即**每个子代理收尾时**。另在分支删除时清理（`:2646-2648`）。

### 4.4 `drainSubAgentNotices`（`:2197-2250`）

触发点：`handleAgentEventForNode` 的 `done/interrupted/error`（`:1444`、`:1458`、`:1473`）+ `scheduleSubAgentDrain` 75ms（`:2190-2193`）。关键片段：

```ts
    if (this.dead || this.busy) return;
    if (this.heldBackoff(() => this.scheduleSubAgentDrain())) return;
    const firstId = this.subAgentNoticeQueue.find((n) => this.session.nodes[n.nodeId] !== undefined)?.nodeId;
    const targetAgent = firstId ? this.nodeWorkers.get(firstId)?.agent : undefined;
    if (targetAgent && targetAgent.running) { setTimeout(() => this.drainSubAgentNotices(), 0); return; }
    const notices = this.subAgentNoticeQueue.splice(0).filter((n) => this.session.nodes[n.nodeId] !== undefined);
    if (notices.length === 0) return;
    const parentId = notices[0].nodeId;
    const parent = this.session.nodes[parentId];
    const run = parent ? this.beginInjectedTurn(parent) : null;
    if (!parent || !run) { this.subAgentNoticeQueue.push(...notices); this.scheduleSubAgentDrain(); return; }
    this.lastStatus = '子代理完成';
    this.setBusy(true);
    this.post({ type: 'status', text: this.lastStatus });
    this.postPath();
    const parts = notices.map((n) => {
      const count = n.count ?? 1;
      const head = n.status === 'done' ? `${count} 个子代理完成` : `${count} 个子代理完成（含失败/中断）`;
      return `[子代理批次] ${head}\n${n.summary || '(no summary)'}`;
    });
    run.agent.sendUserMessage(`子代理通知：\n${parts.join('\n\n')}`);
```

### 4.5 两条管线是否共用通道？

**不共用。** 队列、计时器、drain、投递函数完全分开：
- 后台：`backgroundNotifQueue` + `backgroundDrainTimer` + `drainBackgroundQueue` + `injectBackgroundNotices`（建新 node）。
- 子代理：`subAgentNoticeQueue` + `lastSubAgentDrain` + `drainSubAgentNotices`（复用父 node，`beginInjectedTurn`）+ 独立的 `subAgentChildNotices`。

**共用的是外层机制**：`busy` 状态与 `syncBusy()`、`heldBackoff()`、`setBusy`、`Agent.sendUserMessage`、`nodeWorkers` 的 per-node worker，以及 `handleAgentEventForNode` 里那三对成对出现的调用点。两条管线的消息**文本形状也不同**（`Background command …` vs `[子代理批次] …` / `子代理通知：…`）。

---

## 5. `host.isHeld()`：定义、设置者、拦截什么、与投递的交互

**声明**（RuntimeHost 契约）`runtime.ts:235-241`：
```ts
  /**
   * True while an external controller is reloading the window (`/wait-for-finish`
   * with a hold). Every turn start — including an injected notice turn — must
   * check it: `/reload-window` refuses to run while a turn does.
   */
  isHeld(): boolean;
```

**实现** `ChatViewProvider.ts:2121-2128`：
```ts
  isHeld(): boolean {
    return Date.now() < this.controlHoldUntil;
  }
```

**谁设置**：`ChatViewProvider.ts:159`（`private controlHoldUntil = 0;`）→ `:1906-1909` 在 `controlWaitForFinish()` 里设置：
```ts
    const holdMs = Number.isFinite(opts.holdMs) ? Math.max(0, Math.min(opts.holdMs ?? 0, 600000)) : 0;
    if (holdMs > 0) {
      this.controlHoldUntil = Date.now() + holdMs;
    }
```
`holdMs` 来自 HTTP 控制面 `POST /wait-for-finish`（`src/http/controlServer.ts:272-281`，`holdMs` 默认 0，上限 600s）。目的是：外部 supervisor（hvsc）等 idle → 拿 hold → 杀进程/重启窗口；`controlReloadWindow` 在 `:2096-2098` 会因为 "sub-agents or background terminals are still running" 或 busy 而拒绝。

**拦什么（4 处）**：
| 位置 | 语义 |
|---|---|
| `runtime.ts:998` `beginTurn` | 任何**新 node** turn（用户 turn + 后台 notice turn）被拒 → 返回 `null` |
| `runtime.ts:1062` `beginInjectedTurn` | 任何**注入 turn**（子代理 notice）被拒 → 返回 `null` |
| `runtime.ts:1165` `onUserMessage` | 用户发消息直接 `postNotice('warning', 'An external controller is rebooting the window; please wait a moment.')` 并 return |
| `ChatViewProvider.ts:2114` `dispatchUserMessage` | webview 来源的用户消息同上（provider 级唯一 gate） |

**与 notice 投递的交互点（精确行号）**：
1. `runtime.ts:2359-2365` `heldBackoff`：
```ts
  private heldBackoff(reschedule: () => void): boolean {
    if (!this.host.isHeld()) {
      return false;
    }
    setTimeout(reschedule, 500);
    return true;
  }
```
2. 被两个 drain 调用：`drainBackgroundQueue` → `:2533`；`drainSubAgentNotices` → `:2201`。**注意：held 时 notice 不丢**，500ms 后重新 `scheduleBackgroundDrain`/`scheduleSubAgentDrain`。
3. `beginTurn` 返回 `null` 时后台管线回队：`:2483-2486`（`this.backgroundNotifQueue.push(...batch); return;`）。
4. `beginInjectedTurn` 返回 `null` 时子代理管线回队：`:2227-2234`（`this.subAgentNoticeQueue.push(...notices); this.scheduleSubAgentDrain();`）。
5. 注释里点明这曾是真事故：`runtime.ts:999-1003` "including the injected ones (background and sub-agent notices), which is exactly the race that killed two reboots."

---

## 6. 持久化：notice 最终以什么 role/内容写进哪个 node

**结论：notice 文本作为一条 `role: 'user'` 消息写进"目标 node"自己的 `agent.messages`，再由 `finishTurn` 落到该 node 的 `messages`。**

1. 投递动作是 `sendUserMessage`，`src/agent/agent.ts:518-553`：
```ts
    this.messages.push({ role: 'user', content });   // agent.ts:549
    const turnStartIndex = this.messages.length;
    void this.runTurn(signal, turnStartIndex);
```
（`content` 对各条管线分别是 `combineNotices(batch)` 的 `Background command …` 文本，或 `` `子代理通知：\n${parts.join('\n\n')}` ``，或子代理 parent 的 `[子代理批次] …` 文本；`agent.ts:543` 还可能在前面插一条 interrupt notice，同为 `role:'user'`。）

2. 归属 node（写哪个 node）：
   - **后台**：`beginTurn` 新建的 node，`parentId = ownerNodeId`；`run.fresh === true`。
   - **子代理**：`beginInjectedTurn(parent)` 复用的**父 node**（`notices[0].nodeId`，即主 agent 的 turn node 或那个子代理 node）；`run.fresh === false`。

3. `finishTurn` 的写入规则，`runtime.ts:1102-1138`：
```ts
      if (intact) {
        const added = messages.slice(start);
        // An injected (sub-agent notice / hop answer) turn continues a node that
        // already holds the turn that spawned it — appending keeps both; a user
        // turn owns the node `beginTurn` just created for it, so it assigns.
        node.messages = run.fresh ? added : [...node.messages, ...added];
      }
      …
      node.status = status;
      session.updatedAt = Date.now();
      this.host.dumpSessionTranscript(node, session, status);
      …
    this.host.persist();
```
   - 后台：`node.messages = added`（第一条即 `{role:'user', content: '<Background command …>'}`）。
   - 子代理：追加到父 node 已有 `messages` 之后。

4. 落盘：`host.persist()` → `ChatViewProvider.ts:550-569`，节点 `messages` 经 `clipMessageForStorage` 存入 `STORAGE_KEY` 的 extension storage；`displayItems` 经 `clipDisplayItem` 同时存。子代理自身的会话另存于 node.messages（`runSubAgent` 的 `finish()` `runtime.ts:1912`）+ `host.writeSubAgentTranscript`（`:1915`）。

5. **卡片不是 message**：视觉卡片进 `displayItems`，不进 `messages`：
   - 后台：`run.items.push({ kind: 'background', id, name, doneText, content })`（`:2490`），`run.items` 即 `node.displayItems`。
   - 子代理：`parent.displayItems.push({ kind: 'background', … })`（`:2175`、`:1752`）。
   - 即时 UI 消息 `{ type: 'backgroundNotice', nodeId, item }`（`:2491-2495`、`:2176`、`:1759-1763`）只是 webview 通知，刷新后由 `displayItems`/`postPath`/`renderTree` 重建。

6. 清理：`clearConversation` 清 `backgroundNotifQueue` / `subAgentNoticeQueue` / `subAgentChildNotices` 与 timer（`:2613-2619`）；`afterBranchDetach` 清被删分支对应的 `subAgentChildNotices`（`:2646-2648`）与 hub 里的 job；`dispose()` 清 `backgroundDrainTimer`（`:477-480`）并把 `dead` 置 true，之后 `onBackgroundFinished`/两个 drain 全部直接 return。

---

## 7. 一图流（消息形状速查）

```
[进程 close] background.ts:195 → complete() :218 onFinish?.(task)
   → hub registryFor 的 hooks.onFinish(owner, task)  (backgroundHub.ts:80)
   → ChatViewProvider.ts:230 runtimes[owner.sessionId].onBackgroundFinished(owner, task)
   → runtime.ts:2373: notifyAgent!==true ? task.delivered=true + postBackgrounds : 
        buildBackgroundNotice (:2408) → backgroundNotifQueue.push (:2385) → scheduleBackgroundDrain (:2395, busy?return:75ms)
   → drainBackgroundQueue (:2529) :busy→return | held→500ms 重试 | 剥掉 taskAlreadyHandled | setTimeout(0)
   → injectBackgroundNotices (:2442) :busy→回队 | 按 nodeId 分组取第一组 | beginTurn(title, {parentId: ownerNodeId, pan:false})  ← 新 node
   → markDelivered + run.items.push(kind:'background') + post backgroundNotice + sendUserMessage(combineNotices(batch))  ← role:'user'
   → finishTurn (:1102) → node.messages = added (fresh) → dumpSessionTranscript + persist

[子代理 async 批次结束] spawnChildren:1855 Promise.allSettled → onAsyncBatchDone (:2164)
   → mainParent: displayItems.push + post backgroundNotice + subAgentNoticeQueue.push({…, count}) + scheduleSubAgentDrain(:2183)
   → !mainParent : queueSubAgentChildNotice (:1976) → runningSubAgents 有父 ? subAgentChildNotices.push : runSubAgent(resume)
   → scheduleSubAgentDrain 75ms → drainSubAgentNotices (:2197) :dead|busy→return | held→500ms | agent.running→0ms 重试
   → beginInjectedTurn(parent) (:1061) ← 不建 node、不改焦点
   → postPath + sendUserMessage(`子代理通知：\n…`)  ← role:'user'，追加进父 node.messages (fresh=false)
```

## 8. 几个容易踩的点（供后续核对）

1. **后台 notice 会改 checkout**：`attachNode` 的 `session.activeNodeId = node.id`（`tree.ts:257`）+ `postTree` 的 `viewId`（`runtime.ts:792-793`）→ 视图焦点跳到新 notice node；只有 `panTo` 被 `pan:false` 抑制（`:1048-1050`）。注释 "does not pan the view" 只保证不移动镜头。
2. **两条管线不共用队列**，只共用 `busy` / `heldBackoff` / `nodeWorkers` / `handleAgentEvent` 的调用点。二者合并计时器都是 75ms 但彼此独立。
3. **`subAgentNoticeQueue` 只服务主 agent 的 parent**；父是子代理走 `subAgentChildNotices` + `flushSubAgentChildNotices`（由 `runSubAgent.finish()` `:1920` 驱动）。
4. `unit`：`notifyAgent === false`（工具内 kill/join）走的是"直接标 delivered、不进队列"，与 notice 投递是互斥路径（`:2377-2383`）。
5. `dead`（`:504-506`）与 session 未加载（`ChatViewProvider.ts:230` 上 `runtimes.get()` 为 undefined）都会静默丢弃通知。

（本次调研未修改任何文件；结论均以 `read_file` 逐行核对，未采信二手摘要。）

---
Both sub-agent reports are in. Let me verify three claims they made that I hadn't confirmed myself (dead-code `onSubAgentDone`, `afterBranchDetach` queue filtering, and node `kind` defaults for a notice node under a sub-agent).

---
两份子代理报告已回收，与我的一手核对一致（除一处措辞）。下面给出**合并后的最终报告**，并标注三处新增确认与一处需要澄清的点。

---

# 后台终端 / 异步子代理 完成通知投递管线（最终报告）

## 0. 总览

| 维度 | 后台终端管线 | 子代理(async)管线 |
|---|---|---|
| 队列 | `backgroundNotifQueue: BackgroundNotice[]` (`runtime.ts:301`) | `subAgentNoticeQueue[]` (`:295`) + `subAgentChildNotices: Map` (`:297`) |
| 合并计时器 | `backgroundDrainTimer`（`:303`，75ms） | `lastSubAgentDrain`（`:298`，75ms） |
| 产生 | `onBackgroundFinished` (`:2373`) | `runSubAgent().finish()` (`:1900`) → `onAsyncBatchDone` (`:2164`) / `deliverResumeAsync` (`:1746`) |
| 投递 | `drainBackgroundQueue` (`:2529`) → `injectBackgroundNotices` (`:2442`) | `scheduleSubAgentDrain` (`:2183`) → `drainSubAgentNotices` (`:2197`) |
| 建 node？ | **是**（`beginTurn`, `:2482`） | **否**（`beginInjectedTurn`, `:2226`） |
| 合并文本 | `combineNotices` (`:2423`)，按 job 数 | `drainSubAgentNotices` `:2244`，按 `count` |

`SubAgentPool.ts` 全文 79 行、**零 import**、无 `notice/notify/callback/onFinish/mode` 任何字样（已核）——纯并发槽池，不进通知链路。它在链路上的唯一痕迹是 `withSlot`（`runtime.ts:1852` / `:1871`）决定了子代理**何时开跑**，从而间接影响完成时刻的先后。

---

## 1. job 完成时 `onBackgroundFinished` 做什么 / notice 文本 / 队列结构

### 1.1 触发链

```
background.ts:195-196  handle.child.on('close'|'error') → this.complete(task, code|null)
background.ts:208-220  complete(): status='finished'; exitCode=code; truncated=handle.isTruncated();
                       waiters.splice(0).forEach(w=>w(task)); this.onFinish?.(task); this.onUpdated?.()
backgroundHub.ts:79-80 registry.setOnUpdated(() => hooks.onUpdated?.(owner))
                       registry.setOnFinish((task) => hooks.onFinish?.(owner, task))   ← owner 是闭包捕获的
ChatViewProvider.ts:228-231  onUpdated → refreshBackgrounds(); onFinish → runtimes.get(sid)?.onBackgroundFinished(owner, task)
runtime.ts:2373              onBackgroundFinished(owner, task)
```

三个结束路径都汇入 `complete`：正常/异常 exit（`:195-196`）、`kill()`（`background.ts:255`，同步调 `:271`）、`killAll()`。**后台任务无自动超时**。

**`owner` 从哪来**：不是从 task 反查，而是**建 registry 时闭包捕获的 `owner` 参数**（`backgroundHub.ts:80`）。它由 `hub.register(owner, …)` 传入，上游是工具侧的 `BackgroundAccess.currentOwner()`，在 runtime 里为每个 node worker 恒定绑定：

```ts
// runtime.ts:376-379
      tools.setBackgroundAccess({
        currentOwner: () => ({ sessionId: this.sessionId, nodeId: node.id }),
        hub: this.hub,
      });
```

即 **owner.nodeId = 发起该 job 的那次 turn 所在节点**，与视图焦点无关（契约注释 `backgroundHub.ts:44-47` 说"running turn 的 node，否则 view-focus node"，但实现上每个 worker 恒返回自己的 node，只有 `null` 兜底）。

### 1.2 `onBackgroundFinished`（`runtime.ts:2373-2387`，原样）

```ts
  onBackgroundFinished(owner: BackgroundOwner, task: BackgroundTask): void {
    if (this.dead) {
      return;
    }
    if (task.notifyAgent !== true) {
      // Tool-initiated kill/join already informed the agent via the tool result, so
      // the task is considered delivered and leaves the pending dock state.
      task.delivered = true;
      this.postBackgrounds();
      return;
    }
    const notice = this.buildBackgroundNotice(owner, task);
    this.backgroundNotifQueue.push(notice);
    this.scheduleBackgroundDrain();
  }
```
`notifyAgent === false` 的来源：工具内 kill（`backgroundTools.ts:87`）、`join_background`（`:127` 置 false，`:131` 被中断时置回 true）、`BackgroundRegistry.kill(..., {notifyAgent:false})`（`background.ts:263-265`）。`dead` = `disposed || host.disposed`（`:504-506`）。

### 1.3 notice 文本拼装（`runtime.ts:2408-2420`，原样）

```ts
  private buildBackgroundNotice(owner: BackgroundOwner, task: BackgroundTask): BackgroundNotice {
    const cmd = this.truncateField(task.command, 100);
    const doneText = task.killed
      ? 'was killed by the user'
      : `finished with exit code ${task.exitCode ?? 'unknown'}`;
    const output = this.truncateField(task.handle.getOutput().trim(), 1200);
    const text = `Background command \`${cmd}\` (id ${task.id}) ${doneText}.${output ? `\nOutput:\n${output}` : ''}`;
    return { text, taskId: task.id, nodeId: owner.nodeId, id: task.id, cmd, doneText, output };
  }

  private truncateField(value: string, limit: number): string {
    return value.length > limit ? value.slice(0, limit) + '…' : value;
  }
```

单条 = `text`；多条合并成一条 agent 消息（`:2423-2429`，原样）：

```ts
  private combineNotices(notices: BackgroundNotice[]): string {
    if (notices.length === 1) {
      return notices[0].text;
    }
    const lines = notices.map((n) => `- ${n.text}`);
    return `[Background terminal notice] ${notices.length} background tasks finished:\n${lines.join('\n')}`;
  }
```

> 注意：输出**不在 task 上**，闭包持在 `CommandHandle.getOutput()`（累计上限 `OUTPUT_CAP = 16 MiB`，`background.ts:6`）；`complete` 只用 `handle.isTruncated()` 刷新 `task.truncated`。**耗时也不落字段**，只存 `task.startedAt`，读时算 `elapsed`（`runtime.ts:2305`）。

### 1.4 队列数据结构（`runtime.ts:154-166`，原样）

```ts
/** A queued background-completion notification waiting for the agent to go idle. */
interface BackgroundNotice {
  text: string;
  /** The background-terminal id, used to drop a notice the agent already handled via join/kill. */
  taskId: number;
  /** The node the job belongs to: the notice turn is based on it, never on the view. */
  nodeId: string;
  /** Card fields: task id, command, status phrase, and output tail. */
  id: number;
  cmd: string;
  doneText: string;
  output: string;
}
```
声明：`private backgroundNotifQueue: BackgroundNotice[] = [];`（`:301`）、`private backgroundDrainTimer`（`:303`）。

相关类型：`BackgroundOwner {sessionId, nodeId}`（`backgroundHub.ts:20-23`）、`BackgroundTask`（`tools/background.ts:124-151`：`id/command/cwd/startedAt/status/exitCode/killed/truncated/handle/notifyAgent/delivered/waiters`）、`BackgroundHubHooks.onFinish?: (owner, task) => void`（`backgroundHub.ts:36-42`）、webview 投影 `BackgroundInfo`（`runtime.ts:139-152`，含 `pendingDelivery`）。

`backgroundHub.ts` 的导出：`BackgroundOwner`/`BackgroundHit`/`BackgroundHubHooks`/`BackgroundAccess`/`class BackgroundHub`（`:20/:26/:36/:44/:55`）；它**不 re-export** tools 层类型（`:13` 仅 import）。

---

## 2. `drainBackgroundQueue` / `injectBackgroundNotices` 的调用点与 idle 判定

| 调用点 | 谁 / 时机 |
|---|---|
| `runtime.ts:355` | `SessionRuntime` 构造函数末尾（runtime 被创建时投出遗留队列） |
| `runtime.ts:1443` | `handleAgentEventForNode` `case 'done'`，在 `finishTurn` + `syncBusy()` 之后 |
| `runtime.ts:1457` | `case 'interrupted'` |
| `runtime.ts:1472` | `case 'error'` |
| `runtime.ts:2402-2405` | `scheduleBackgroundDrain` 的 75ms timer |
| `runtime.ts:2363` | `heldBackoff` 的 500ms 重试 |

```ts
// runtime.ts:1439-1445
        if (run) this.finishTurn(run, 'done');
        // P3: `busy` clears only once the *last* run of the session is gone.
        this.syncBusy();
        void this.refreshBalance();
        this.drainBackgroundQueue();
        this.drainSubAgentNotices();
```

**"now if idle else end of turn" 的三处具体条件：**

```ts
// runtime.ts:2395-2406  —— 是否设 75ms 计时器（决定"现在投")
  private scheduleBackgroundDrain(): void {
    if (this.busy) {
      return;
    }
    if (this.backgroundDrainTimer != null) {
      return;
    }
    this.backgroundDrainTimer = setTimeout(() => {
      this.backgroundDrainTimer = null;
      this.drainBackgroundQueue();
    }, 75);
  }
```
```ts
// runtime.ts:2529-2535  —— drain 入口
  drainBackgroundQueue(): void {
    if (this.busy) {
      return;
    }
    if (this.heldBackoff(() => this.scheduleBackgroundDrain())) {
      return;
    }
```
```ts
// runtime.ts:2449-2452  —— 投递前再确认
    if (this.busy) {
      this.backgroundNotifQueue.push(...notices);
      return;
    }
```

`busy` 语义：`syncBusy()` = `setBusy(uploadController != null || runs.size > 0)`（`:975-977`）。
→ **idle**：75ms 合并窗后立刻起一条 turn；**busy**：`scheduleBackgroundDrain` 直接返回，notice 留队，等 turn 结束的 `:1443/1457/1472` 再 drain。
→ 最后再延一个 tick 避开 turn 的 `finally` 未复位 `agent.running`：

```ts
// runtime.ts:2536-2564（节选）
    const real: BackgroundNotice[] = [];
    let i = 0;
    while (i < queue.length) {
      const q = queue[i];
      if (this.taskAlreadyHandled(q)) {       // :2510-2521
        this.markDelivered(q.taskId);
        queue.splice(i, 1);
        continue;
      }
      real.push(queue.splice(i, 1)[0]);
    }
    if (real.length === 0) { this.postBackgrounds(); return; }
    setTimeout(() => {
      if (this.busy) { this.backgroundNotifQueue.push(...real); return; }
      this.injectBackgroundNotices(real);
    }, 0);
```
`taskAlreadyHandled`（`:2510-2521`）：task 已从 hub 消失 / owner node 已被删 / `notifyAgent !== true` → 视为陈旧，丢弃 + `markDelivered`。

一次 drain 只投一组：`injectBackgroundNotices` 按 `nodeId` 分组（`:2453-2461`），只投第一个 node 仍存在的组（`:2462`），其余回队（`:2472-2475`），全没了就整体丢弃（`:2463-2470`）。

---

## 3. 是否创建新 node？`beginTurn` 签名/语义/parentId/焦点

**是：后台 notice 一定创建新 node。**

```ts
// runtime.ts:2476-2503（原样）
    // The notice turn is a new node *under the owning node*, so the card and the
    // agent's reply land in their own block of the branch that spawned the job.
    const title =
      batch.length === 1
        ? `Background #${batch[0].id}: ${batch[0].cmd}`
        : `Background: ${batch.length} tasks finished`;
    const run = this.beginTurn(titleFromPrompt(title), { parentId: ownerNodeId, pan: false });
    if (!run) {
      this.backgroundNotifQueue.push(...batch);
      return;
    }
    for (const n of batch) {
      // The notice is now reaching the agent, so the task leaves the pending dock.
      this.markDelivered(n.taskId);
      run.items.push({ kind: 'background', id: String(n.id), name: n.cmd, doneText: n.doneText, content: n.output });
      this.post({
        type: 'backgroundNotice',
        nodeId: run.nodeId,
        item: { id: n.id, name: n.cmd, doneText: n.doneText, content: n.output },
      });
    }
```

### `beginTurn` 签名与语义（`runtime.ts:996-1052`）

```ts
  private beginTurn(title: string, opts?: { parentId?: string | null; pan?: boolean }): TurnRun | null {
    const session = this.session;
    if (this.host.isHeld()) {
      ...
      return null;                                  // 998-1005
    }
    const parentId = opts?.parentId !== undefined ? opts.parentId : session.activeNodeId;
    if (parentId != null && this.runs.has(parentId)) {
      this.postNotice('warning', 'A turn is already running in this session. …');
      return null;                                  // 1009-1015
    }
    const node = createNode(newId(), parentId, title, 'running');
    attachNode(session, node);                      // 1016-1017
    const worker = this.workerFor(node);
    … // transferInterruptTo/resetInterruptState, setMessages(buildPath), runs.set, postTree(:1047)
    if (opts?.pan !== false) {
      this.post({ type: 'panTo', id: node.id });     // 1048-1050
    }
    return run;
  }
```

- **title**：`titleFromPrompt(title)` 取首行截 80 字符（`tree.ts:151-154`）→ `Background #12: npm test` / `Background: 3 tasks finished`。
- **parentId**：notice 路径显式传 `ownerNodeId`（`BackgroundNotice.nodeId` = `BackgroundOwner.nodeId`，`runtime.ts:2415`）→ **新 node 的 parentId 就是 spawn 该 job 的那个 node**，与视图焦点无关。默认值是 `session.activeNodeId`（仅用户 turn 走）。
- **pan**：`true` 时发 `panTo`（移动镜头）；notice 传 `false` → **不移动镜头**。
- **拒绝**：`isHeld()`（`:998`）或 basis node 已有 live run（`:1009`）→ `null`，调用方回队（`:2483-2486`）。

### ⚠️ 焦点 / checkout：**checkout 会变，镜头不会**（需澄清子代理 A 的措辞）

- `attachNode` 末尾 `session.activeNodeId = node.id;`（`tree.ts:257`）。
- `beginTurn` 随后 `this.postTree()`（`:1047`），`postTree` 发的 `viewId` 就是 `session.activeNodeId`（`:792-793`）；`media/main.js:1477-1485` 里 `treeActiveId = tree.viewId`。
- 所以：**不 pan、不抢镜头**成立（无 `panTo`）；但 **`activeNodeId` / 视图焦点确实被改写成新 notice node**。注释 `:2436-2440` 的 "without moving anything" 指"基于 owner node 而不是 view focus 建 node、且不 pan"，不是"不动 activeNodeId"。

**新增确认（子代理报告的边缘情形）**：`beginTurn` 用 `createNode(newId(), parentId, title, 'running')`（`:1016`），而 `createNode`（`tree.ts:204-220`）**不设 `kind`** → notice node 的 `kind === undefined`，不是 `'agent'`。因此：
- `attachNode` 走 `node.kind === 'agent'` 的 else 分支（`tree.ts:235-241`），插在 agent 兄弟之前（"main-chain spine"）；
- `postTree` 的 `items` 只对 `kind === 'agent'` 下发（`:788`）→ notice node 的内容靠 `path`/`displayItems` 走 `postPath`；
- **写权限子代理自己 spawn 的后台 job**（`exec_command` 在写工具集里，owner = 该子代理节点）完成时，会在**子代理节点下**再开一个 `kind` 为 undefined 的 turn 子节点，由新 worker 作答——这是两套管线唯一的"交叉"形态（队列仍各自独立）。

对比：子代理 notice 走 `beginInjectedTurn`（`:1054-1089`），注释明确 "does not create a node and does not move the view focus"，代码里确实无 `attachNode`/`activeNodeId` 赋值。

---

## 4. 子代理异步完成：notice 的产生与投递

### 4.1 触发源 A：`spawn_agents` `mode:'async'`

调用链：`agent.ts:751`（拦截）→ `spawnHandler`（`runtime.ts:385` 注册）→ `handleSpawnAgents`（`:1625`）/ `handleSubAgentSpawn`（`:1634`）→ `spawnChildren`（`:1782`）→ `:1845` async 分支。

```ts
// runtime.ts:1845-1867（节选）
    if (mode === 'async') {
      const mainParent = parent.kind !== 'agent';
      const tasks = jobs.map((job) => {
        const run = () => this.runSubAgent(job, signal);
        return (childDepth === 1 ? this.subAgentPool.withSlot(run) : run()).then((result) => ({ job, result }));
      });
      void Promise.allSettled(tasks).then((settled) => {
        const list = settled.map((s, i) =>
          s.status === 'fulfilled' ? s.value : { job: jobs[i], result: { ok: false, summary: 'cancelled' } },
        );
        this.onAsyncBatchDone(mainParent, parent, list.map((l) => ({ ...l.result, node: l.job.node })));
      });
      return JSON.stringify({ spawned: jobs.length, async: true, ids: …, transcriptDir: … });
    }
```
（子代理节点创建 `:1826-1836`；视图焦点在 `:1840-1842` 恢复，子代理卡片永不抢焦点。）

```ts
// runtime.ts:2164-2181（原样）
  private onAsyncBatchDone(mainParent: boolean, parent: TreeNode, results: Array<{ ok: boolean; summary: string; node: TreeNode }>): void {
    if (!mainParent) {
      this.queueSubAgentChildNotice(parent, results);
      return;
    }
    const lines = results.map((r) => `子代理 #${r.node.id.slice(-6)} ${r.ok ? '完成' : '失败'}: ${r.summary || '(no summary)'}${this.transcriptNote(r.node)}`);
    const cardText = lines.join('\n');
    const doneText = `${results.length} 个子代理完成`;
    parent.displayItems.push({ kind: 'background', id: `sub-aware-${parent.id}`, name: '子代理完成', content: cardText, doneText });
    this.post({ type: 'backgroundNotice', nodeId: parent.id, item: { id: `sub-${parent.id}`, name: '子代理完成', doneText, content: cardText } });
    this.subAgentNoticeQueue.push({ nodeId: parent.id, summary: cardText, status: 'done', count: results.length });
    this.scheduleSubAgentDrain();
    this.host.persist();
  }
```

### 4.2 触发源 B：`send_agent_message` `mode:'async'`（**零池参与**）

`agent.ts:786` → `sendMessageHandler`（`runtime.ts:387`）→ `handleSendAgentMessage`（`:1642`）→ `resumeSubAgent`（`:1698`）→ `:1727-1730`：

```ts
    if (mode === 'async') {
      void this.runSubAgent(job, signal).then((r) => this.deliverResumeAsync(node, r), () => {});
      return Promise.resolve(JSON.stringify({ resumed: true, id: node.id, async: true }));
    }
```

```ts
// runtime.ts:1746-1774（节选）
  private deliverResumeAsync(node: TreeNode, result: { ok: boolean; summary: string; model?: string }): void {
    const parent = this.session.nodes[node.parentId ?? ''] ?? null;
    if (!parent) return;
    const cardText = `子代理 #${node.id.slice(-6)} ${result.ok ? '完成' : '失败'}: ${result.summary || '(no summary)'}${this.transcriptNote(node)}`;
    parent.displayItems.push({ kind: 'background', id: `sub-msg-${node.id}`, name: '子代理完成', content: cardText, doneText: '子代理完成' });
    this.post({ type: 'backgroundNotice', nodeId: parent.id, item: { id: `sub-msg-${node.id}`, … } });
    if (parent.kind === 'agent') {
      this.queueSubAgentChildNotice(parent, [{ ok: result.ok, summary: result.summary, node }]);
    } else {
      this.subAgentNoticeQueue.push({ nodeId: parent.id, summary: cardText, status: 'done', count: 1 });
      this.scheduleSubAgentDrain();
    }
    this.host.persist();
  }
```

**两条 async 路径的不对称**（重要）：
- `spawn` async：受池限（仅 `childDepth === 1`），**整批 settle 才发一条**（`:1855`），`count = results.length`（`:2178`）。
- `send_agent_message` async：**不经池**（`:1728` 直接 `runSubAgent`），**每个 resume 各发一条**，`count = 1`（`:1770`）。

### 4.3 `queueSubAgentChildNotice` / `flushSubAgentChildNotices`

```ts
// runtime.ts:1976-1994（原样）
  private queueSubAgentChildNotice(parent: TreeNode, results: Array<{ ok: boolean; summary: string; node: TreeNode }>): void {
    const lines = results.map(
      (r) => `子代理 #${r.node.id.slice(-6)} ${r.ok ? '完成' : '失败'}: ${r.summary || '(no summary)'}${this.transcriptNote(r.node)}`,
    );
    const notice = `[子代理批次] ${results.length} 个子代理完成\n${lines.join('\n')}`;
    if (this.runningSubAgents.has(parent.id)) {
      const q = this.subAgentChildNotices.get(parent.id) ?? [];
      q.push({ message: notice });
      this.subAgentChildNotices.set(parent.id, q);
      return;
    }
    const abort = new AbortController();
    void this.runSubAgent(
      { node: parent, spec: { instruction: notice, write: parent.agentWrite ?? false, model: undefined }, resume: true, sessionId: this.sessionId },
      abort.signal,
    );
  }
```
语义：**父是子代理（depth-1）时的通知通道**。父在跑 → 存 `subAgentChildNotices`（`:297`）；父已结束 → 以 `resume:true` 重跑它（新 user 卡 `:1959-1962`）。

```ts
// runtime.ts:1997-2015（原样）
  private flushSubAgentChildNotices(node: TreeNode): void {
    const queued = this.subAgentChildNotices.get(node.id);
    if (!queued || queued.length === 0) return;
    const notice = queued.shift()!;
    if (queued.length === 0) this.subAgentChildNotices.delete(node.id);
    if (this.runningSubAgents.has(node.id)) return; // 新 run 已接手
    const abort = new AbortController();
    void this.runSubAgent({ node, spec: { instruction: notice.message, write: node.agentWrite ?? false, model: undefined }, resume: true, sessionId: this.sessionId }, abort.signal);
  }
```
唯一调用点：`runSubAgent` 的 `finish()` 内 `runtime.ts:1920`——即**每个子代理收尾时**；分支删除时清理（`:2646-2648`）。

### 4.4 `drainSubAgentNotices`（`:2197-2250`）

触发：`handleAgentEventForNode` 的 `done/interrupted/error`（`:1444`/`:1458`/`:1473`）+ `scheduleSubAgentDrain` 75ms（`:2190-2193`）+ 自旋重试。

```ts
    if (this.dead || this.busy) return;
    if (this.heldBackoff(() => this.scheduleSubAgentDrain())) return;
    const firstId = this.subAgentNoticeQueue.find((n) => this.session.nodes[n.nodeId] !== undefined)?.nodeId;
    const targetAgent = firstId ? this.nodeWorkers.get(firstId)?.agent : undefined;
    if (targetAgent && targetAgent.running) { setTimeout(() => this.drainSubAgentNotices(), 0); return; }
    const notices = this.subAgentNoticeQueue.splice(0).filter((n) => this.session.nodes[n.nodeId] !== undefined);
    if (notices.length === 0) return;
    const parentId = notices[0].nodeId;
    const parent = this.session.nodes[parentId];
    const run = parent ? this.beginInjectedTurn(parent) : null;
    if (!parent || !run) { this.subAgentNoticeQueue.push(...notices); this.scheduleSubAgentDrain(); return; }
    this.lastStatus = '子代理完成';
    this.setBusy(true);
    this.post({ type: 'status', text: this.lastStatus });
    this.postPath();
    const parts = notices.map((n) => {
      const count = n.count ?? 1;
      const head = n.status === 'done' ? `${count} 个子代理完成` : `${count} 个子代理完成（含失败/中断）`;
      return `[子代理批次] ${head}\n${n.summary || '(no summary)'}`;
    });
    run.agent.sendUserMessage(`子代理通知：\n${parts.join('\n\n')}`);
```
合并边界：一个 turn 内可合并多条，但**只针对 `notices[0].nodeId` 这一个父节点**；绑定节点不存在的直接丢弃（`:2215`）。

### 4.5 两条管线是否共用通道？

**不共用队列/计时器/drain/投递函数**；**共用**外层机制：

| 项 | 是否共享 |
|---|---|
| `SessionRuntime` 实例、`hub`、`nodeWorkers`、`runs` | 共享 |
| `busy` / `setBusy` / `syncBusy`（两条 drain 都被它 gate） | 共享 |
| `heldBackoff()` / `host.isHeld()` | 共享 |
| `Agent.sendUserMessage`（两条最终都走它） | 共享 |
| 队列 | **不共享**：`backgroundNotifQueue`(`${:301}`) vs `subAgentNoticeQueue`(`${:295}`)+`subAgentChildNotices`(`${:297}`) |
| 合并逻辑 | **不共享、不互相合并**：`combineNotices`（按 job 数）vs `:2244`（按 `count`） |
| turn 结束调用顺序 | 相邻但串行：`:1443→:1444`、`:1457→:1458`、`:1472→:1473`，**恒为 background 先、sub-agent 后** |
| 清理 | `:495-497` 先 `hub.removeSession(kill:true)` 再 `cleanupSubAgents()`；`:2613-2615` 两队列 + childNotices 一起清空 |

**新增确认**：分支删除路径除删 `subAgentChildNotices`（`:2646-2648`）外，还会过滤后台队列：

```ts
// runtime.ts:2649-2655
    // Background jobs are owned by nodes: dropping a branch kills the jobs it
    // spawned (the provider confirmed that with the user) and drops its notices.
    for (const id of ids) {
      this.hub.removeNode(this.sessionId, id, { kill: true });
    }
    this.backgroundNotifQueue = this.backgroundNotifQueue.filter((n) => !ids.includes(n.nodeId));
    this.postBackgrounds();
```

**新增确认**：`onSubAgentDone`（`runtime.ts:2118-2126`，"Clean up a finished/killed sub-agent"）**全仓无调用点，是死代码**——不要误当成结束回调；真正的收尾是 `runSubAgent` 内的闭包 `finish`（`:1900-1922`），由 `new Agent(..., (event) => this.handleSubAgentEvent(job.node, event, finish), ...)`（`:1924`）驱动，`handleSubAgentEvent` 的 `done/interrupted/error` 三支（`:2044-2052`）触发它。

---

## 5. `host.isHeld()`

**声明**（RuntimeHost 契约）`runtime.ts:235-241`：
```ts
  /**
   * True while an external controller is reloading the window (`/wait-for-finish`
   * with a hold). Every turn start — including an injected notice turn — must
   * check it: `/reload-window` refuses to run while a turn does.
   */
  isHeld(): boolean;
```

**实现** `ChatViewProvider.ts:2121-2128`：
```ts
  isHeld(): boolean {
    return Date.now() < this.controlHoldUntil;
  }
```

**谁设置（全仓唯一赋值点）**：`ChatViewProvider.ts:158-159`（`private controlHoldUntil = 0;`）→ `:1906-1909`，在 `controlWaitForFinish()` 里：
```ts
    const holdMs = Number.isFinite(opts.holdMs) ? Math.max(0, Math.min(opts.holdMs ?? 0, 600000)) : 0;
    if (holdMs > 0) {
      this.controlHoldUntil = Date.now() + holdMs;
    }
```
`holdMs` 来自 HTTP 控制面 `POST /wait-for-finish`（`src/http/controlServer.ts:272-281`）。目的是：外部 supervisor（hvsc）等 idle → 拿 hold → 杀进程/重启窗口；`controlReloadWindow` 在 `:2096-2098` 会因 "sub-agents or background terminals are still running" 或 busy 而拒绝。**后台任务完成不会设置 `isHeld`**——hold 只由这次重载置位。

**拦什么（4 处）**：

| 位置 | 方法 | 语义 |
|---|---|---|
| `runtime.ts:998` | `beginTurn` | 新 node turn（用户 + 后台 notice）→ `return null` |
| `runtime.ts:1062` | `beginInjectedTurn` | 注入 turn（子代理 notice）→ `return null`（否则 reload 会因 busy 被拒） |
| `runtime.ts:1165` | `onUserMessage` | `postNotice('warning','An external controller is rebooting the window; please wait a moment.')` + return |
| `ChatViewProvider.ts:2114` | `dispatchUserMessage`（`:2113`，webview 用户消息入口） | 同上 warning + return，不进 `onUserMessage` |

**与 notice 投递的交互点（精确行号）**：
1. `runtime.ts:2359-2365` `heldBackoff`：
```ts
  private heldBackoff(reschedule: () => void): boolean {
    if (!this.host.isHeld()) {
      return false;
    }
    setTimeout(reschedule, 500);
    return true;
  }
```
2. 被两个 drain 调用：`drainBackgroundQueue` → `:2533`；`drainSubAgentNotices` → `:2201`。**held 时 notice 不丢**，500ms 后重排。
3. `beginTurn` 返回 `null` → 后台回队 `:2483-2486`（`this.backgroundNotifQueue.push(...batch); return;`）。
4. `beginInjectedTurn` 返回 `null` → 子代理回队 `:2227-2234`（`this.subAgentNoticeQueue.push(...notices); this.scheduleSubAgentDrain();`）。
5. 注释点明这是真事故：`runtime.ts:999-1003` "including the injected ones (background and sub-agent notices), which is exactly the race that killed two reboots."

---

## 6. 持久化：notice 以什么 role/内容写进哪个 node 的 messages

**结论：notice 文本作为一条 `role: 'user'` 消息写进"目标 node"自己的 `agent.messages`，再由 `finishTurn` 落到该 node 的 `messages`。**

1. 投递动作是 `sendUserMessage`，`src/agent/agent.ts:518-553`：
```ts
    this.messages.push({ role: 'user', content });   // agent.ts:549
    const turnStartIndex = this.messages.length;
    void this.runTurn(signal, turnStartIndex);
```
`content` 分别为：`` `${cmd} …` 的 `combineNotices(batch)` ``（后台）、`` `子代理通知：\n${parts.join('\n\n')}` ``（主 agent 的子代理 notice）、`` `[子代理批次] N 个子代理完成\n…` ``（子代理父的 resume instruction，`runSubAgent` 用 `setMessages` 再走后 `:1965 sub.sendUserMessage(job.spec.instruction)`）。`agent.ts:543` 还可能在其前插一条 interrupt notice（同为 `role:'user'`）。

2. **归属 node**：
   - 后台：`beginTurn` 新建的 node，`parentId = ownerNodeId`，`run.fresh === true`。
   - 子代理：`beginInjectedTurn(parent)` 复用的**父 node**（`notices[0].nodeId`），`run.fresh === false`。
   - 子代理父的 childNotice：写进**那个子代理节点自己的** `messages`（`resume:true` → `:1954` 先 prepend 已存对话）。

3. `finishTurn` 写入规则（`runtime.ts:1102-1138`）：
```ts
      if (intact) {
        const added = messages.slice(start);
        // An injected (sub-agent notice / hop answer) turn continues a node that
        // already holds the turn that spawned it — appending keeps both; a user
        // turn owns the node `beginTurn` just created for it, so it assigns.
        node.messages = run.fresh ? added : [...node.messages, ...added];
      }
      node.status = status;
      session.updatedAt = Date.now();
      this.host.dumpSessionTranscript(node, session, status);
      …
    this.host.persist();
```
切片前有 `intact` 校验（`:1114`：`start > 0 && start <= len && messages[start-1] === run.prefixTail`），不 intact 就只打日志、不写（避免把祖先历史写进 node）。
→ 后台：`node.messages = added`（第一条即 `{role:'user', content:'<Background command …>'}`）；子代理：追加到父 node 已有 `messages` 之后。

4. 落盘：`host.persist()` → `ChatViewProvider.ts:550-569`，节点 `messages` 经 `clipMessageForStorage` 存入 `STORAGE_KEY`；`displayItems` 经 `clipDisplayItem` 同时存。子代理自身会话另存于 node.messages（`runtime.ts:1912`）+ `host.writeSubAgentTranscript`（`:1915`，JSONL）。

5. **卡片不是 message**：视觉卡片进 `displayItems`，不进 `messages`：
   - 后台：`run.items.push({ kind: 'background', id, name, doneText, content })`（`:2490`），`run.items` 即 `node.displayItems`。
   - 子代理：`parent.displayItems.push({ kind: 'background', … })`（`:2175`、`:1752`）。
   - 即时 UI 消息 `{ type: 'backgroundNotice', nodeId, item }`（`:2491-2495`、`:2176`、`:1759-1763`）只是 webview 通知，刷新后由 `displayItems` + `postPath`/`renderTree` 重建。

  - 后台 dock 的"待投递"态：`pendingDelivery: task.status === 'finished' && !task.delivered`（`:2308`），`postBackgroundsNow` 只列 running + 未投递的 finished（`:2336-2339`）；投递即 `markDelivered`（`:2346-2351`）使其从 dock 消失。

6. 清理：`clearConversation` 清 `backgroundNotifQueue` / `subAgentNoticeQueue` / `subAgentChildNotices` + timer（`:2613-2619`）；`afterBranchDetach` 清被删分支的 childNotices（`:2646-2648`）、`hub.removeNode(kill:true)`（`:2651-2653`）、过滤 `backgroundNotifQueue`（`:2654`）；`dispose()` 清 `backgroundDrainTimer`（`:477-480`）并置 `dead`，之后 `onBackgroundFinished` 与两个 drain 全部直接 return。

---

## 7. 一图流

```
[后台进程 close] background.ts:195 → complete():218 onFinish?.(task)
   → hub registryFor 的闭包补 owner (backgroundHub.ts:80)
   → ChatViewProvider.ts:230 runtimes[sid].onBackgroundFinished(owner, task)
   → runtime.ts:2373  notifyAgent!==true ? delivered=true+postBackgrounds
                      : buildBackgroundNotice(:2408) → backgroundNotifQueue.push(:2385) → scheduleBackgroundDrain(:2395)
   → drainBackgroundQueue(:2529) : busy→return | held→500ms | 剥掉 taskAlreadyHandled | setTimeout(0)
   → injectBackgroundNotices(:2442) : 按 nodeId 分组取第一组 | beginTurn(title,{parentId:ownerNodeId,pan:false})  ← 新 node
   → markDelivered + run.items.push(kind:'background') + post backgroundNotice + sendUserMessage(combineNotices)  ← role:'user'
   → finishTurn(:1102) → node.messages = added (fresh=true) → dumpSessionTranscript + persist

[子代理 async 批次结束] spawnChildren:1855 Promise.allSettled → onAsyncBatchDone(:2164)
   → mainParent : displayItems.push + post backgroundNotice + subAgentNoticeQueue.push({count}) + scheduleSubAgentDrain(:2183)
   → !mainParent : queueSubAgentChildNotice(:1976) → 父在跑 ? subAgentChildNotices.push : runSubAgent(resume)
   → scheduleSubAgentDrain 75ms → drainSubAgentNotices(:2197) : dead|busy→return | agent.running→0ms 自旋
   → beginInjectedTurn(parent)(:1061) ← 不建 node、不改焦点
   → postPath + sendUserMessage(`子代理通知：…`)  ← role:'user'，追加进父 node.messages (fresh=false)

[turn 结束统一钩子] handleAgentEventForNode :1443/1444, :1457/1458, :1472/1473 —— background 先、sub-agent 后
```

---

## 8. 易踩点清单

1. ⚠️ **后台 notice 会改 checkout**：`attachNode` 的 `session.activeNodeId = node.id`（`tree.ts:257`）+ `postTree` 的 `viewId`（`runtime.ts:792-793`）→ 视图焦点跳到新 notice node；只有 `panTo` 被 `pan:false` 抑制（`:1048-1050`）。"不移动视图" 仅指镜头。
2. **两条管线不共用队列**，只共用 `busy`/`heldBackoff`/`nodeWorkers`/`sendUserMessage` 和 `handleAgentEvent` 的调用点；合并计时器都是 75ms 但彼此独立、**不会互相合并**。
3. `subAgentNoticeQueue` **只服务主 agent 的 parent**；父是子代理走 `subAgentChildNotices` + `flushSubAgentChildNotices`（由 `runSubAgent.finish()` `:1920` 驱动）。
4. **两条 async 路径不对称**：spawn 受池限且整批一条（`count=N`）；`send_agent_message` async 不经池、逐条（`count=1`）。
5. `notifyAgent === false`（工具内 kill/join）走"直接标 delivered、不进队列"的互斥路径（`:2377-2383`）。
6. `onSubAgentDone`（`runtime.ts:2118-2126`）是**死代码**，无调用点。
7. `dead`（`:504-506`）或 session 未加载（`ChatViewProvider.ts:230` 的 `runtimes.get()` 为 undefined）→ 通知静默丢弃。
8. 写权限子代理的后台 job 归它自己的 node（`runtime.ts:376-379` + `execCommand.ts:167`），其 notice 会在**子代理节点下**新建一个 `kind` 为 undefined 的 turn 子节点（`createNode` 不设 kind，`tree.ts:204-220`）；`postTree` 的 `items` 只对 `kind==='agent'` 下发（`:788`）。

（本次调研未修改、未创建任何文件；结论均以 `read_file` 逐行核对，两份并行只读子代理的结论已与本人一手核对合并，冲突处已按代码澄清。）

---


============================ mtw3b8lws9cy7j — agent 回合循环与消息合法性（注入点可行性） ============================
# 只读调研报告：agent 回合循环与消息合法性约束

调研范围：`src/agent/agent.ts`、`src/agent/types.ts`、`src/agent/deepseek.ts`、`src/agent/prompt.ts`，并交叉核对 `src/chat/runtime.ts`、`src/chat/tree.ts`、`src/chat/ChatViewProvider.ts` 与 `docs/agents/invariants/*`。未修改任何文件。

---

## 1) 一次 turn 的主循环

**入口与主循环**：`Agent.sendUserMessage`（`src/agent/agent.ts:518`）→ `runTurn`（`src/agent/agent.ts:555`），循环体是 `while (true)`（`src/agent/agent.ts:558`）。

`src/agent/agent.ts:518-553`（回合起点，逐字）：

```ts
  sendUserMessage(content: string | ContentPart[]): void {
    if (this.isRunning) {
      return;
    }
    ...
    this.isRunning = true;
    this.cancelled = false;
    this.pendingImageFiles = [];
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    if (this.lastTurnInterrupted) {
      this.messages.push({ role: 'user', content: buildInterruptNotice(this.lastInterruptedTools) });
      this.lastTurnInterrupted = false;
      this.lastInterruptedTools = [];
    }

    // Everything appended during this turn; roll back on failure.
    this.messages.push({ role: 'user', content });
    const turnStartIndex = this.messages.length;

    void this.runTurn(signal, turnStartIndex);
  }
```

**消息累积**：只有一个数组 `private messages: ChatMessage[]`（`src/agent/agent.ts:230`）。回合内所有 push 点共 6 处（见 §3）。**发送**：`requestAssistantMessage`（`src/agent/agent.ts:907`）把 `messagesForCurrentModel()` + `getTools()` 传给 `client.stream`：

```ts
      for await (const chunk of this.client.stream({
        messages: this.messagesForCurrentModel(),
        tools: this.getTools(),
        signal,
        model: this.model || undefined,
        thinkingEffort: this.thinkingEffort,
      })) {
```
（`src/agent/agent.ts:915-921`；协议细节见 `src/agent/deepseek.ts:200-230`，`messages` 原样进 body）

**tool_calls → tool 响应配对**：靠循环内的**顺序纪律**，不靠校验。`src/agent/agent.ts:572-602`：

```ts
        const iterationStart = this.messages.length;
        // Never retain an assistant message the API would reject: a turn must
        // carry content or tool_calls. ...
        const hasToolCalls = !!(assistant.tool_calls && assistant.tool_calls.length > 0);
        const hasContent = typeof assistant.content === 'string' && assistant.content.trim().length > 0;
        if (hasToolCalls || hasContent) {
          this.messages.push(assistant);
        }

        if (assistant.tool_calls && assistant.tool_calls.length > 0) {
          toolTurnCount++;
          if (toolTurnCount > this.maxTurns) {
            this.messages.splice(iterationStart);
            ...
            return;
          }

          for (let i = 0; i < assistant.tool_calls.length; i++) {
            if (this.isStopped(signal)) {
              throw new Error('interrupted');
            }
            await this.executeToolCall(assistant.tool_calls[i], signal, indices[i]);
          }
```

保证机制（4 条）：
1. 带 `tool_calls` 的 assistant **先** push（:579），随后**同一次迭代内**按顺序对每个 call 调 `executeToolCall`（:601）。
2. `executeToolCall` **无条件** push 对应 tool 消息（`src/agent/agent.ts:830`，`read_image` 专用路径 `:858`）——工具失败也返回字符串结果，不抛异常：
   ```ts
    this.onEvent({ type: 'toolEnd', id: call.id, name: call.function.name, content: result });
    this.messages.push({ role: 'tool', tool_call_id: call.id, content: result });
   ```
   （`src/agent/agent.ts:829-830`）
3. 只有整批 tool 响应 push 完之后才 `continue`（:625）进入下一次请求；中途任何 `throw` 都会走 catch 回滚（:636-657），不会留下半截窗口。
4. maxTurns 超限时用 `splice(iterationStart)` 把刚 push 的 assistant（含未响应的 tool_calls）整段撤掉（:588），持久化历史始终合法。

---

## 2) `sanitizeMessages` 完整逻辑（原样引用）

`src/agent/agent.ts:163-228`（≤25 行拆两段）：

```ts
  /**
   * Ensure the message history is API-valid: every assistant message with
   * `tool_calls` must be immediately followed by a `tool` response for each
   * `tool_call_id`. Drops dangling tool_calls blocks and orphan tool messages
   * that would otherwise cause a 400 error when a session is resumed.
   */
  static sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
    const result: ChatMessage[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === 'tool') {
        const prev = result[result.length - 1];
        const valid = prev && prev.role === 'assistant' && prev.tool_calls && prev.tool_calls.length > 0;
        if (!valid) {
          continue; // drop orphan tool message
        }
        result.push(msg);
        continue;
      }
```

```ts
      // Heal an assistant message that the API would reject: it must carry
      // content or tool_calls. ...
      let out = msg;
      if (msg.role === 'assistant' && !msg.content && (!msg.tool_calls || msg.tool_calls.length === 0)) {
        if (msg.reasoning_content) {
          out = { ...msg, content: msg.reasoning_content, reasoning_content: undefined };
        } else {
          continue;
        }
      }

      result.push(out);

      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const ids = new Set(msg.tool_calls.map((tc) => tc.id));
        let j = i + 1;
        while (j < messages.length && ids.size > 0) {
          const next = messages[j];
          if (next.role === 'tool' && next.tool_call_id && ids.has(next.tool_call_id)) {
            ids.delete(next.tool_call_id);
            result.push(next);
            j++;
          } else {
            break;
          }
        }
        if (ids.size > 0) {
          // Incomplete: remove any tool responses we appended, then the
          // assistant message carrying the unresolved tool_calls.
          while (result.length > 0 && result[result.length - 1].role === 'tool') {
            result.pop();
          }
          result.pop();
        } else {
          i = j - 1; // continue after the tool responses
        }
      }
    }
    return result;
  }
```

行为归纳：
- **孤立 tool 消息**：只检查「结果数组里上一条是不是带 tool_calls 的 assistant」，不是就丢（:174-182）。注意它**不校验** `tool_call_id` 是否属于那条 assistant（那一步在后面的窗口扫描里做）。
- **孤儿/不完整 assistant tool_calls**：从 assistant 往后线性收集属于它的 tool 响应（遇非 tool/不匹配即 `break`）；若 `ids` 未清空 → 把已收的 tool 全 pop、再 pop 掉这条 assistant（:215-221）。即「窗口内插入任何非 tool 消息 ⇒ 整块 assistant+tool 被删」。
- **assistant 既无 content 又无 tool_calls**：仅 reasoners 会把 `reasoning_content` 镜像进 content（返回**副本**，不写回节点对象），否则丢弃（:191-198）。
- **「以 user 消息开头的约束」**：`sanitizeMessages` 里**完全没有**对 `user` 角色的判断或强制；任何 user 消息都走 `result.push(out)`（:200）原样保留。

调用点只有 3 处（grep 确认）：
- `src/chat/runtime.ts:709`（`buildPath`，每次开回合重建历史时）：
  ```ts
    // sanitizeMessages returns a derived copy; it is never written back into the
    // nodes, so the stored history keeps its original shape.
    return Agent.sanitizeMessages([system, ...pathMessages(session, nodeId)]);
  ```
- `src/chat/runtime.ts:1952-1956`（子代理 resume 时重建历史）。
- 文档提及「`loadSessions` 时应用」（`docs/agents/invariants/conversation-validity.md:3-5`），实际加载路径靠 `pruneSession`（`src/chat/tree.ts:385`，只剔除 system 消息 + 丢弃空节点），并非直接调 sanitize；真正生效点是 `buildPath`。

**关键后果**：`this.messages` 在回合内**从不经过 sanitize**。合法性只靠循环自身的 push 顺序；下一次 `buildPath`（新回合 / 分支重建）才会 sanitize，一旦那时发现「assistant(tool_calls) 与 tool 之间夹了别的消息」，那整块会被删掉。

---

## 3) loop 中途是否已有插入新消息的先例

**有，且只有一处：`read_image` 的图片 user 块**。`src/agent/agent.ts:597-626`：

```ts
          for (let i = 0; i < assistant.tool_calls.length; i++) {
            if (this.isStopped(signal)) {
              throw new Error('interrupted');
            }
            await this.executeToolCall(assistant.tool_calls[i], signal, indices[i]);
          }
          // Any read_image uploads now become a user content block so the model
          // can actually see them. Image content blocks are only valid in a user
          // message (a tool message cannot carry one), and they must follow the
          // tool responses so the assistant(tool_calls) -> tool(...) ordering
          // stays valid. The model's next turn then sees the image(s).
          if (this.pendingImageFiles.length > 0) {
            this.messages.push({
              role: 'user',
              content: [
                { type: 'text', text: 'Image(s) requested via read_image:' },
                ...this.pendingImageFiles.map((f) => ({ type: 'file' as const, file_id: f.file_id })),
              ],
            });
            this.pendingImageFiles.length = 0;
          }
          ...
          if (usage) {
            this.onEvent({ type: 'usage', usage });
          }
          continue;
        }
```

- **插入点**：紧跟该 assistant 消息**全部** tool 响应之后（:602 循环结束 → :608），`continue` 之前。
- **插完立刻继续请求**：是。`continue`（:625）回到 `while (true)` 顶部，下一轮 `requestAssistantMessage` 立刻带上这条 user 消息。
- 数据来源是 `executeReadImage`/`tryReadImage` 塞进 `pendingImageFiles`（`src/agent/agent.ts:236-237`、`:858`、`:891`）。

其他 push 点都**不在中途**（`agent.ts` 内全部 push 点）：
| 行 | 角色 | 时机 |
|---|---|---|
| :543 | user | 中断通知，`sendUserMessage` 开头（本回合第一个请求之前） |
| :549 | user | 用户真实输入，回合开始 |
| :579 | assistant | 循环内（模型响应） |
| :609 | **user** | **循环中途，紧跟 tool 结果（唯一先例）** |
| :704 | assistant | `preservePartialTurn`，catch 里、循环已结束 |
| :830 / :858 | tool | 循环中途（tool 结果本身） |

外部注入路径**进不来**中途：`sendUserMessage` 在 `isRunning` 时直接 return（`src/agent/agent.ts:519-521`）；`POST /continue` 走的是 `controlContinueFrom`（`ChatViewProvider.ts:1931`）→ 新建子回合。后台/子代理通知也都有空闲门控：`runtime.ts` 的 `injectBackgroundNotices` 检查 `this.busy`、`drainSubAgentNotices`（`runtime.ts:2197`）检查 `busy` + 目标 node worker 的 `agent.running`，且都走 `beginTurn`/`beginInjectedTurn` → `setMessages` + 独立 `sendUserMessage`（`runtime.ts:996`、`1061`、`1032`、`1073`）。

---

## 4) Stop / interrupt-rollback 在循环里的处理点

| 位置 | 作用 |
|---|---|
| `agent.ts:504-507` `isStopped(signal)` | `signal.aborted \|\| this.cancelled` |
| `agent.ts:509-512` `cancel()` | `cancelled = true; abortController?.abort()` |
| `agent.ts:559-561` | 每轮循环开头检查 → `throw new Error('interrupted')` |
| `agent.ts:598-600` | 每个 tool call 之前检查 |
| `agent.ts:921-922, 934-935, 941-942, 978-979` | 流式读取中逐 chunk / 逐 SSE 行 / EOF 后检查 |
| `agent.ts:985-992` | catch 把「我们自己的 interrupted」与「stream 抛出的网络级 abort」统一成 `InterruptedError`（携带部分 `content`/`reasoning`/正在起草的 tool_calls） |
| `agent.ts:636-651` | 回合 catch：`interrupted` 分支 |
| `agent.ts:653-657` | 非中断错误分支：`this.messages.splice(turnStartIndex)` 整回合回滚 |
| `agent.ts:658-661` | `finally` 复位 `isRunning = false` / `abortController = null` |
| `runtime.ts:1280` `stop(nodeId)`、`runtime.ts:1304` `onStop()` | UI/控制面的 Stop，按 node 或整会话 `agent.cancel()` |
| `runtime.ts:1446` `case 'interrupted'` | `interruptedNodes.set(run.nodeId, run.agent)` + `finishTurn(run, 'interrupted')` |

回滚语义（`src/agent/agent.ts:641-650`）：

```ts
      const interrupted = this.isStopped(signal) || err instanceof InterruptedError;
      if (interrupted) {
        // Remember the tool call(s) that were in progress ...
        this.markInterrupted(this.captureInterruptedToolCalls(err));
        // Preserve any partial output/reasoning streamed up to the interruption
        // as a checkpoint ...
        this.preservePartialTurn(turnStartIndex, err instanceof InterruptedError ? err : undefined);
        this.onEvent({ type: 'interrupted' });
        return;
      }
```

`preservePartialTurn`（`agent.ts:674-717`）先 `splice(turnStartIndex)` 把本回合新增的全部消息取出，只回填**一条** assistant「checkpoint」（无 `tool_calls`，content 为空时把 reasoning 镜像进 content）。因此「已完成的 tool 迭代」在中断时被丢弃，只有部分文本/推理以合法 assistant 形式留下。对应的文档：`docs/agents/invariants/interrupt-rollback.md`。

---

## 5) 回合结束的 finish 路径与写回

**4 条结束路径（都在 agent 侧先发事件）**：

| 结束方式 | agent 侧 | 发出事件 | runtime 侧 |
|---|---|---|---|
| 正常（无 tool_calls） | `agent.ts:628-634` | `status 'Done'` + `done` | `runtime.ts:1430` → `finishTurn(run,'done')` |
| loop 上限 | `agent.ts:584-595`（先 `splice(iterationStart)`） | `status`（loop limit）+ `done` | 同上 → `'done'` |
| 中断/Stop | `agent.ts:641-650` | `interrupted` | `runtime.ts:1446` → `finishTurn(run,'interrupted')` |
| 非中断错误 | `agent.ts:653-657`（`splice(turnStartIndex)` 后） | `error` + message | `runtime.ts:1460` → 追加 `⚠️` card + `finishTurn(run,'error')` |

**写回 node**：`SessionRuntime.finishTurn`（`src/chat/runtime.ts:1102`），核心是「按 run 自己的 basis 切片 + 身份校验」：

```ts
      const messages = run.agent.getMessages();
      const start = run.prefixLen;
      const intact = start > 0 && start <= messages.length && messages[start - 1] === run.prefixTail;
      if (intact) {
        const added = messages.slice(start);
        node.messages = run.fresh ? added : [...node.messages, ...added];
      } else {
        this.host.output.appendLine(
          `[slice] ${node.id}: skipped storing this turn's messages — the agent history was ` +
            `replaced mid-turn (...)`);
      }
      node.status = status;
      session.updatedAt = Date.now();
      this.host.dumpSessionTranscript(node, session, status);
```
（`src/chat/runtime.ts:1122-1136`，随后 `requestAutoTitle`（非 interrupted）、`persist()`、`post nodeUpdate`、`queueHopReturn`）

**写 transcript**：`finishTurn` → `ChatViewProvider.dumpSessionTranscript`（`src/chat/ChatViewProvider.ts:1015-1047`）→ `writeSessionTranscript`，落到 `<transcriptRoot>/<sessionId>/<nodeId>.jsonl`；gated by `saveSessionTranscripts`，`kind==='agent'` 跳过；同一步还取 `messages[0]` 作为 dump 的 `prompt`：

```ts
    const messages = node.messages;
    if (messages.length === 0) {
      return;
    }
    const first = messages[0];
    const prompt = first.role === 'user' ? messageText(first.content) : node.title;
```
（`src/chat/ChatViewProvider.ts:1019-1024`）

---

## 6) system prompt 的合成时机与「node 历史以 user 开头」不变量

**system prompt 从不入库**，两个时刻合成：
1. **每次开回合重建历史**：`SessionRuntime.buildPath`（`src/chat/runtime.ts:700-710`）新建 `{role:'system', content: this.systemPromptText()}` 再拼 `pathMessages` → `sanitizeMessages` → `agent.setMessages`。
2. **原地重写 `messages[0]`**：`refreshSystemIdentity`（`src/agent/agent.ts:352-356`），由 `setModel` / `setThinkingEffort` 触发：
   ```ts
     private refreshSystemIdentity(): void {
       if (this.messages[0]?.role === 'system') {
         this.messages[0].content = prompt.systemPrompt(this.model, this.thinkingEffort);
       }
     }
   ```
   初值来自 `Agent.initialMessages`（`agent.ts:154-157`）。渲染实现在 `prompt.systemPrompt`（`src/agent/prompt.ts:196-210`），`AGENTS.md` 快照由 `prompt.setAgentsMd`（`prompt.ts:178-180`）在会话开始时固定一次。加载时若节点里混进 system 消息会被剔除：`pruneSession`（`src/chat/tree.ts:393-397`）。

**「节点历史以 user 消息开头」**（不变量声明见 `AGENTS.md:23`）：
- 声明：`src/chat/tree.ts:11-15`
  ```
   * Invariants (also documented in AGENTS.md):
   *  - a non-empty `node.messages` starts with a `user` message;
   *  - a node's `messages` are written once, when its turn ends;
   *  - the assembled path must go through `Agent.sanitizeMessages` before use, and
   *    the sanitized copy must never be written back into the nodes.
  ```
  以及字段注释 `src/chat/tree.ts:51`：`/** API messages this turn contributed. Non-empty ⇒ starts with a user message. */`。
- **代码中的体现仅为「依赖」，没有强制校验**：
  - 迁移时按 user 消息切分历史（`src/chat/tree.ts:532-546`，注释：「A slice always starts with a user message; anything before the first one … is dropped」）；
  - transcript dump 用 `messages[0].role === 'user'` 判断 prompt，否则退回 `node.title`（`ChatViewProvider.ts:1023-1024` 与 `:1110-1111`）；
  - `pathMessages` 只是无脑拼接（`src/chat/tree.ts:281-290`）；`sanitizeMessages` 里**没有**任何 user-first 检查。

---

## 结论：对「在回合中途、紧跟某 tool 结果之后注入一条 user 通知」的可行性事实

支持性事实：
1. **协议层面合法且已有先例**：`assistant(tool_calls) → tool(...) → user` 是该 harness 已经在跑的形态 —— `read_image` 的图片块注入（`agent.ts:608-617`）就是「tool 结果之后、`continue` 之前」插一条 user 消息，随后**立即**发起下一次请求（:625）。
2. **请求体不经过 sanitize**，`this.messages` 原样送（`agent.ts:915-917`）；因此中途插入不会被预处理吞掉。
3. **持久化可容纳**：`finishTurn` 切的是 `messages.slice(prefixLen)`，中途插入的 user 消息会随本回合一起写回 `node.messages`（只要 `prefixTail` 身份校验通过，`runtime.ts:1122-1136`），`messages[0]` 仍是本回合的原始 user 提示，不破坏 node 首条消息的不变量。

必须遵守的约束（否则会 400 / 静默丢历史）：
1. **插入位置必须是该 assistant 的整批 tool 响应之后**。`sanitizeMessages` 的窗口扫描遇到不匹配消息就 `break`（`agent.ts:211-213`），随后 `ids.size > 0` → pop 掉已收 tool + pop 掉 assistant（:215-221）。若把 user 通知插在 assistant(tool_calls) 与其 tool 响应之间，下一次 `buildPath`（`runtime.ts:709`）会把整块删掉。
2. **不能从外部触发**：`sendUserMessage` 在 `isRunning` 时静默 return（`agent.ts:519-521`）；后台通知、子代理通知、hop 回执都走 idle 门控 + `beginTurn`/`beginInjectedTurn`（`runtime.ts:996/1061/2197/2529`），不会进入 live loop。
3. **实现点唯一且明确**：循环内可用的注入位就是 `agent.ts:602` 之后、`:625` 的 `continue` 之前（与 `pendingImageFiles` 完全同构），且需自己维护 pending 队列（现有 `pendingImageFiles` 就是一个现成范式：入队于 `executeToolCall`/`tryReadImage`，出队并清空于循环内）。
4. **未中断回合的其它消息不变量**：tool 消息必须由 `executeToolCall` 无条件 push（`agent.ts:830/858`）；assistant 必须 content 或 tool_calls 二者有其一（`agent.ts:576-580`；`requestAssistantMessage` 的 `effectiveContent` 兜底在 `agent.ts:1025-1039`）。

---


============================ mtw3b8lw09dak7 — webview 侧：卡片渲染、dock、backgroundNotice、tree.js 侧车布局、流式路由 ============================
I'll start by exploring the repository structure and reading the key webview files.

---
Now let me read the key sections of main.js in parallel.

---
Let me spawn a parallel agent for the host side while I examine the CSS and remaining webview code.

---
以下是 webview 侧的只读调研报告（所有结论均附 `文件:行号` 与原样片段，未改动仓库）。

---

# MinimalHost webview 侧调研报告

## 1) 节点卡片与 user 消息的渲染

### 节点卡片的唯一渲染函数

所有卡片（turn 与 agent）都由同一个 `createNodeCard` 生成：

`media/main.js:951`
```js
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
```
（后续 `media/main.js:977-996`：`.node-prompt` → `.node-body`(`.node-items` + `.node-excerpt`) → `.node-resize`。）

**DOM 结构**（一个展开的节点卡片）：

```
div.node[data-id]
├─ div.node-head        > span.node-title + span.node-status[data-role=status] + button.node-del
├─ div.node-prompt      （钉住的 user 提示；展开时才显示）
├─ div.node-body
│   ├─ div.node-items   （可滚动转录：assistant / tool / notice / bgnotify…）
│   └─ div.node-excerpt （折叠时的 2 行摘要）
├─ div.node-resize
├─ div.node-bg          （可选：后台任务 dock，见 §2）
├─ div.node-summary     （可选：agent 结果脚注）
└─ #composer            （仅当焦点节点时可挂载）
```

主要 CSS：`.node`（`media/style.css:1089`）、`.node.expanded`(1109)、`.node.active`(1117)、`.node-head`(1130)、`.node-title`(1140)、`.node-status`(1150)、`.node-body`(1165)、`.node-items`(1172)、`.node-excerpt`(1196)、`.node-prompt`(1239)。

### 一条 user 消息长什么样

user 消息**只**渲染进 `.node-prompt`（不是 `.node-items`），函数是 `addUserPrompt`：

`media/main.js:213`
```js
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
```

即 DOM：`div.node-prompt > div.msg.user.prompt[data-kind=user] > (div.msg-imgs > img.msg-img)* + span.msg-text`。

CSS 选择器：
- 基样式 `.msg`（`media/style.css:325`）、`.msg.user`（334，右对齐气泡 `--user-bg`）、`.msg.user a`（341）；
- 钉住处专属 `.node-prompt .msg.user.prompt`（`media/style.css:1254`）；
- 图片隐藏 `#tree-canvas.hide-images .node-items .msg.user .msg-imgs`（1228）。

> 注意：`.node-items .msg.user`（`media/style.css:1189`）与 1228 的 hide-images 选择器其实作用在 `.node-items`，但 user 卡实际挂在 `.node-prompt`，属历史遗留选择器。

### “注入的机器人生成 user 消息” vs “真实用户输入”

**渲染上完全没有区分。** 两者都走 `addUserPrompt`，产出同一 DOM/class；host 也没有任何 `injected/synthetic` 标记字段：
- 真实用户：`runtime.ts:1267` `run.items.push({ kind: 'user', text: userText, attachments })`（turn 节点）。
- 机器生成：`runtime.ts:1833`（子代理 spawn 指令）、`runtime.ts:1961`（resume 续跑指令）都 push `{ kind: 'user', text: instruction }`，**且只挂在 `kind==='agent'` 的节点上**。
- 反例：会话跳转回执是机器生成，但走真实用户路径 `onUserMessage`，数据上与真实输入同形、无标记（只能靠文本前缀辨认）。

另一个关键点：`renderNodeItems` 只把**第一条** `kind==='user'` 项渲染进钉住区，其余 user 项被直接跳过（不进入转录）：

`media/main.js:698`
```js
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
```
→ 一个 agent 节点若有多条注入的 user 指令（spawn + resume），历史重渲染时只会显示第一条。渲染区分注入/真实目前**做不到**，要区分必须先在 host 侧给 DisplayItem 加标记字段并在 `addUserPrompt`/`renderItemInto` 里读它。

---

## 2) `backgrounds` 消息的分组与渲染

消费点（消息分发）：`media/main.js:2446`
```js
      // P2 shape: one flat list, every task tagged with its owning node. Each
      // group renders into the dock at the bottom of that node's own card.
      case 'backgrounds':
        renderBackgrounds(msg.tasks, false);
        break;
```
（旧 `background` 形状 `media/main.js:2439` → `renderBackgrounds(msg.tasks, true)`。）

分组逻辑——按 `task.nodeId` 归组，每个节点渲染进自己卡片的 dock：

`media/main.js:918`
```js
function renderBackgrounds(tasks, legacy) {
  const byNode = new Map();
  for (const task of tasks || []) {
    if (!dockedTask(task)) continue;
    const nodeId = task.nodeId || (legacy ? treeActiveId : null);
    if (!nodeId) continue;
    if (!byNode.has(nodeId)) byNode.set(nodeId, []);
    byNode.get(nodeId).push(task);
  }
  let touched = false;
  for (const id in nodeEls) {
    renderNodeDock(nodeEls[id], byNode.get(id) || []);
    touched = true;
  }
  // The dock is part of the card's height, so the tree must re-place the cards
  // — the same way a growing `.node-items` does (debounced: the host coalesces
  // snapshots, so a burst must not relayout per message).
  if (touched) scheduleLayout();
}
```
过滤 `dockedTask`（`media/main.js:763`）：只保留 running 或 finished+pendingDelivery 的任务。

dock 的 DOM 建立于 `ensureDock`（`media/main.js:836`）：`div.node-bg.hidden > div.bg-dock-head(span.bg-dock-count + span.bg-dock-kills)` 与 `div.bg-dock-list`；单项 `createBgItem`（`media/main.js:787`）→ `div.bg-item > div.bg-item-head(span.bg-id + span.bg-cmd + span.bg-status + span.chev) + div.bg-body > pre.bg-output`；增量更新在 `updateBgItem`（808），就地 patch（`renderNodeDock` 869，用 `dock._items` Map 复用节点）。

CSS：`.node-bg`（`media/style.css:684`）、`.node-bg.hidden`(694)、`.bg-dock-head`(698)、`.bg-dock-count`(704)、`.bg-dock-kills`(716)、`.bg-dock-list`(724)、`.node-bg.collapsed .bg-dock-list`(737)、`.bg-item`(745)、`.bg-item.running/.finished`(752/756)、`.bg-item-head`(760)、`.bg-id/.bg-cmd/.bg-status`(769/776/787)、`.bg-body`(812)、`.bg-output`(826)。

**`#bg-panel` 已删除**：`docs/agents/invariants/background-terminals.md:32`、`docs/agents/where-to-change.md:38`，且 `tools/check-webview.js:305` 把它列入 `REMOVED_IDS`。

---

## 3) `backgroundNotice` 的处理——存在

webview 确实处理该类型：`media/main.js:2464`
```js
      case 'backgroundNotice':
        routeTo(msg.nodeId, () => addBackgroundNotice(msg.item));
        break;
```
渲染函数 `addBackgroundNotice`（`media/main.js:675`）：
```js
function addBackgroundNotice(item) {
  if (!messagesEl) return;
  const node = el('div', 'msg bgnotify');
  node.dataset.kind = 'background';
  const head = el('div', 'bgnotify-head');
  head.appendChild(el('span', 'bgnotify-badge', 'BG'));
  head.appendChild(el('span', 'bgnotify-id', '#' + (item.id != null ? item.id : '')));
  head.appendChild(el('span', 'bgnotify-status', item.doneText || 'finished'));
  node.appendChild(head);
  if (item.name || item.cmd) node.appendChild(el('div', 'bgnotify-cmd', item.name || item.cmd));
  if (item.content) node.appendChild(el('pre', 'bgnotify-output', item.content));
  messagesEl.appendChild(node);
  followActive();
  return node;
}
```
DOM：`div.msg.bgnotify[data-kind=background] > .bgnotify-head(.bgnotify-badge/.bgnotify-id/.bgnotify-status) + .bgnotify-cmd + pre.bgnotify-output`。CSS `media/style.css:619-675`。历史重放也走同一函数：`renderItemInto` 的 `item.kind === 'background'`（`media/main.js:732` → `addBackgroundNotice(item)`）。

**host 侧发什么**（由子代理核实，均为 `this.post(...)`）：
- payload 恒为 `{ type:'backgroundNotice', nodeId, item }`，`item = { id, name, doneText, content }`；
- 发送点 3 处：`src/chat/runtime.ts:1759`（单个子代理完成）、`2176`（子代理批次完成）、`2491`（后台终端完成注入的 turn）；
- `ChatViewProvider.ts` 本身**不**发这些类型（grep 无命中），它只把消息转交给 `SessionRuntime` 再 `post` 给 webview；
- 文档描述见 `docs/agents/invariants/background-terminals.md:28`、`docs/agents/multi-session.md:127`。

---

## 4) 子代理「飞行节点」在 tree.js 的布局

tree.js 是纯函数（无 DOM）。飞行节点通过 `kind==='agent'` 被识别为“侧车（sidecar）子节点”：

`media/tree.js:91`
```js
    const isAgent = (id) => !!nodesById[id] && nodesById[id].kind === 'agent';
    const turnKids = (id) => kidsOf(id).filter((c) => !!nodesById[c] && !isAgent(c));
    const agentKids = (id) => kidsOf(id).filter((c) => !!nodesById[c] && isAgent(c));
```
`layoutSub`（递归布局，含侧车块）：`media/tree.js:121`
```js
    function layoutSub(id) {
      if (memo.has(id)) return memo.get(id);
      // Sidecar grid of one node: each agent subtree laid out recursively with
      // this same algorithm, then packed column-major (R rows per column) into an
      // aligned lattice. Rows share a y band across columns; columns share an x
      // band across rows.
      const blockOf = (nid) => {
        const list = agentKids(nid).map(layoutSub);
        if (!list.length) return { list: [], cells: [], colX: [], rowY: [], w: 0, h: 0 };
        const R = Math.max(1, o.agentMaxRows | 0);
        const nCols = Math.ceil(list.length / R);
```
`build`（把侧车块尺寸**膨胀**进节点盒子）——`agentGap + blockW` 与 `max(cardH, blockH)`：`media/tree.js:163`
```js
      const build = (nid) => {
        const blk = blockOf(nid);
        return {
          id: nid,
          width: size(nid).w + (blk.w ? o.agentGap + blk.w : 0),
          height: Math.max(size(nid).h, blk.h),
          children: turnKids(nid).map(build),
        };
      };
```
侧车网格的实际落位 + 连接器路由表（`cells`）：`media/tree.js:186`
```js
        const blk = blockOf(n.id);
        if (blk.list.length) {
          const cardW = size(n.id).w;
          const bx = n.x + cardW + o.agentGap;
          const by = n.y + o.agentTopPad;
          const busX = n.x + cardW + o.agentGap / 2;
          for (let i = 0; i < blk.cells.length; i++) {
            const cell = blk.cells[i];
            const s = cell.s;
            const dx = bx + cell.x - s.box.left;
            const dy = by + cell.y - s.box.top;
            for (const sid in s.pos) pos[sid] = { x: s.pos[sid].x + dx, y: s.pos[sid].y + dy };
            ...
```
路由记录写于 `media/tree.js:216`：
```js
            cells[s.rootId] = {
              x: bx + cell.x, y: by + cell.y, w: s.w, h: s.h,
              col: cell.col, row: cell.row, index: i, count: blk.cells.length,
              busX,
              chanX: cell.col === 0 ? busX : colLeft - o.agentColGap / 2,
              corrY: cell.row === 0 ? n.y + o.agentTopPad / 2 : by + blk.rowY[cell.row] - o.agentVGap / 2,
            };
```
注释里的不变量与设计说明：`media/tree.js:26-45`（`width = cardW + (blockW ? agentGap + blockW : 0)` / `height = max(cardH, blockH)`）。

**`agentExpanded`** 不在 tree.js，而在 webview `media/main.js:1116`（决定画布上哪些 agent 卡展开）：
```js
function agentExpanded(id) {
  let n = treeNodes[id];
  while (n && n.kind === 'agent') {
    if (n.id === treeActiveId || n.parentId === treeActiveId) return true;
    n = treeNodes[n.parentId];
  }
  return false;
}
```

### 卡片 DOM 是否共用渲染函数？agent 与普通卡的差异

**共用**：都走 `createNodeCard`（`media/main.js:951`）。差异是 `onAgentStart` 在同一个 `.node` 卡上追加：

`media/main.js:1176`
```js
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
  ...
```
差异汇总：
- class：加 `.agent`（CSS 重声明表面色 `media/style.css:1395`）、完成/错误时 `.agent-done`/`.agent-error`(1464/1465)；
- head 多出 `span.node-agent-badge`(SUB) + `span.node-agent-info` + `button.node-kill`（`media/main.js:1189-1208`）；
- 完成时加 `div.node-summary`（`onAgentDone`，`media/main.js:1234-1244`）；
- 焦点是 agent 节点时 composer 隐藏且只读（`setActiveLeaf` `media/main.js:1062`、`updateBranchBanner` 1116 附近）；
- 连接线：agent 边用 `cells` 逐段正交 elbow，普通边用贝塞尔（`drawEdges`，`media/main.js:1433-1468`）。

---

## 5) 若要“后台终端 job 也渲染成父节点右侧飞行节点”，tree 入口数据需要哪些扩展

### 现在 tree.js 的入口数据结构

`window.treeLayout.layoutTree(nodesById, rootId, heights, opts)`（`media/tree.js:83`）：
- `nodesById`：`id -> { id, children: string[], kind?: 'turn'|'agent' }`（`media/tree.js:82` 下方注释与 `isAgent`/`kidsOf` 用法）；
- `heights`/`widths`：`id -> 像素高/宽`（由 DOM 量得）。

调用点 `media/main.js:1254`（`relayout`）：
```js
    const heights = {};
    const widths = {};
    for (const id in nodeEls) {
      heights[id] = nodeEls[id].offsetHeight || 120;
      widths[id] = nodeEls[id].offsetWidth || NODE_W;
    }
    const result = window.treeLayout.layoutTree(treeNodes, treeRootId, heights, {
      nodeW: NODE_W, hGap: H_GAP, vGap: V_GAP, widths,
      agentGap: AGENT_GAP, agentVGap: AGENT_VGAP, agentColGap: AGENT_COL_GAP,
      agentMaxRows: AGENT_MAX_ROWS, agentTopPad: AGENT_TOP_PAD,
    });
```
`treeNodes` 来自 `tree` 消息（`renderTree` `media/main.js:1477`）：`for (const n of tree.nodes || []) treeNodes[n.id] = n;`。每个节点字段（host `runtime.ts:770`）：
```ts
    const nodes = Object.values(session.nodes).map((node) => ({
      id: node.id, parentId: node.parentId, children: node.children.slice(),
      title: node.title, status: node.status, createdAt: node.createdAt,
      preview: this.nodePreview(node), usage: nodeUsage(node),
      size: node.customSize ?? null, kind: node.kind,
      agentDepth: node.agentDepth, agentStatus: node.agentStatus,
      agentModel: node.agentModel, agentWrite: node.agentWrite,
      items: node.kind === 'agent' ? node.displayItems.map(clipDisplayItem) : undefined,
    }));
```
即 `{ id, parentId, children[], title, status, createdAt, preview, usage, size, kind, agentDepth, agentStatus, agentModel, agentWrite, items? }`。

### 需要哪些扩展

1. **数据里要有 job 节点**：目前后台任务**根本不进** `treeNodes`（只走 `backgrounds` 进 dock）。要让它们成为飞行节点，host 必须在 `postTree` 的 `nodes` 里为每个 running/pending job 生成一个节点，并把它挂进 owner 节点的 `children`（或新增一个 `jobs[]` 侧车字段）。节点需带 `id`、`kind`（新 kinds，如 `'job'` 或复用 `'agent'`）、`title/status`、以及供渲染的 `item`（command/outputTail/exitCode…）。
2. **让 tree.js 把 job 当侧车子节点**：`isAgent`（`media/tree.js:91`）目前只认 `kind==='agent'`。要么给 job 节点也标 `kind:'agent'`，要么把 `isAgent`/`agentKids` 泛化为“sidecar 谓词”（如 `isSidecar = kind==='agent' || kind==='job'`），否则 job 会被当成 turn 子节点挂到下方。
3. **必须有对应的 DOM 卡**：布局用 `nodeEls[id].offsetHeight/offsetWidth` 量尺寸（`media/main.js:1273-1278`），`drawEdges` 也按 `nodeEls[id]` 取矩形（`media/main.js:1418-1421`）。所以 job 飞行节点需要真实 DOM 卡（可用 `createNodeCard` 的简化版/新 kind 分支）注册进 `nodeEls`，否则量不到尺寸、画不出连线。
4. **连接器路由**：agent 边依赖 `layoutCells[id]`（`media/main.js:1441`，来自 tree.js `cells`）。job 飞行节点会自动获得 `cells` 条目（因为 `cells` 按侧车子 id 键控，`media/tree.js:216`），`drawEdges` 的 `isAgent` 分支需改为“有 cells 就走 elbow”。
5. **父子关系语义**：`children` 里混入 job 会污染 `pathIdsFromTree`（`media/main.js:939`）、`agentExpanded`（1116）、`updateBranchBanner` 的 `hasTurnChildren`（`media/main.js:1094`）与 `renderTree`/`renderPath` 的展开判断——需显式排除 sidecar 节点。

**tree 数据由谁发**：`src/chat/runtime.ts:770 postTree()`（payload 见上），`type:'tree'`，`{ activeId, viewId, rootId, nodes }`；调用点 `runtime.ts:912/1047/1843/2627/2658`（由子代理核实）。`ChatViewProvider.ts` 不直接发 tree，只做转发。

---

## 6) 流式渲染：nodeId 路由与增量/全量

### 路由函数

`routeTo(nodeId, fn)`（`media/main.js:1146`）——把写入临时切到目标节点的容器：

```js
function routeTo(nodeId, fn) {
  if (!nodeId) { fn(); return; }
  const card = nodeEls[nodeId];
  const itemsEl = card ? card.querySelector('.node-items') : null;
  if (!itemsEl) return;              // 节点还没卡：静默丢弃
  const prevMsg = messagesEl;
  const prevPrompt = promptEl;
  const prevRouting = routingSubAgent;
  const prevNode = routingNodeId;
  messagesEl = itemsEl;
  promptEl = card.querySelector('.node-prompt');
  routingSubAgent = true;
  routingNodeId = nodeId;
  try { fn(); }
  finally {
    messagesEl = prevMsg; promptEl = prevPrompt;
    routingSubAgent = prevRouting; routingNodeId = prevNode;
  }
  if (card && card._itemScroll) card._itemScroll.scrollToBottom();
  scheduleSubAgentRelayout();
}
```

分发处（`media/main.js:2389` 的消息 switch）逐条 `routeTo(msg.nodeId, …)`：
- `delta` → `appendAssistant`（`media/main.js:2470-2472`）
- `thinkingDelta` → `appendThinking`（2474-2476）
- `usage` → `appendUsage`（2478-2479）
- `toolCallDelta`/`toolStart`/`toolEnd` → `appendLiveTool`/`finalizeLiveTool`/`updateTool`（2481-2489）
- `backgroundNotice` → `addBackgroundNotice`（2464-2465）
- `done`/`interrupted`/`error` → `endRun(msg, extra)`（`media/main.js:2369`，内部同样 `routeTo(nodeId, …)`）

### 增量 vs 全量

- **流式转录是增量**：`appendAssistant`（`media/main.js:289`）把文本追加到一个 text node（`renderAnswer` 尾部 append，304-336）；`appendThinking`(358)、`appendLiveTool`(579) 都是纯 append，不重渲染整卡。
- **树的“结构”是全量快照**：`tree`/`path` 消息会整体替换 `treeNodes`/`pathNodes`（`renderTree` 1477、`renderPath` 1524），但**复用**已有卡片 DOM——`renderTree` 只删已消失的 id（`media/main.js:1496-1498`），`renderPath` 只填充 `!_itemsRendered` 的新卡（1540-1553），所以不是整棵重画。转录内容本身仍保留在 DOM 上。

### 中途往某节点追加通知需要什么

webview 已有现成机制，**不需要新的重渲染通道**：任何“带 `nodeId` 的消息 + 一个 case 调 `routeTo(msg.nodeId, () => renderXxx(...))`”即可增量追加。`backgroundNotice` 就是范例（`media/main.js:2464`）。若要通用化，可加一个如：

```js
case 'nodeItem':
  routeTo(msg.nodeId, () => renderItemInto(msg.item));   // renderItemInto 见 media/main.js:721
  break;
```

**前置条件/注意**：
- `routeTo` 要求 `nodeEls[nodeId]` 已存在（`media/main.js:1151-1153`），否则静默丢弃——目标节点必须先由一次 `tree` 消息建好卡；
- 追加后卡片高度变化不会自动重排，需像 `routeTo` 那样在末尾触发 `scheduleSubAgentRelayout()`/`relayout()`（`routeTo` 已内置）；
- 若追加的是 user 消息，注意 §1 的坑：`renderItemInto` 对 `kind==='user'` 会调 `addUserPrompt` 覆盖钉住区（`promptEl.innerHTML=''`），且 `renderNodeItems` 只渲染第一条 user 项。

---

### 关键位置速查

| 主题 | 位置 |
|---|---|
| 卡片创建 | `media/main.js:951` |
| user 消息 | `media/main.js:213`（addUserPrompt）/ `media/style.css:334,1254` |
| 转录填充 | `media/main.js:698`（renderNodeItems）/ `721`（renderItemInto）|
| backgrounds 消费 | `media/main.js:2446` → `918`（renderBackgrounds）→ `869`（renderNodeDock）→ `836`（ensureDock）/ `787`（createBgItem）|
| backgroundNotice | webview `media/main.js:2464`, `675`；host `src/chat/runtime.ts:1759,2176,2492` |
| 飞行节点布局 | `media/tree.js:91,92,93,121,128,163,186,216` |
| 布局调用 | `media/main.js:1254`（relayout）/ `1477`（renderTree）|
| 流式路由 | `media/main.js:1146`（routeTo）/ `2389-2527`（switch）|
| tree 发送 | `src/chat/runtime.ts:770`（postTree）/ `800`（postPath）；`backgrounds` `2329` |

---
