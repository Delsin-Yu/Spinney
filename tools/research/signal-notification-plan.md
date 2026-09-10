# Plan — 完成信号作为「节点内通知块」+ 后台终端的飞行节点

Status: **implemented & verified in place — `0b6f52d`, merged into `ui/polish`（2026-09-11）**；
落地与验收记录见 §0.1。原始行号取自基线 commit `26e0493`（分支 `ui/polish`），
行号对当时的 `src/**`、`media/**` 有效。姊妹文档：`tools/research/bench/agent-grid-plan.md`
（同一时刻进行中的子代理网格改版，见 §5 协调）。全部行号事实的**原始证据**（3 份只读子代理
报告的全文、含各自 transcript 路径）在 `tools/research/signal-notification-evidence.md`。

Owner files: `src/agent/agent.ts`（注入点）、`src/chat/runtime.ts`（队列/投递/生命周期）、
`src/chat/tree.ts`（节点 kind）、`src/chat/backgroundHub.ts`（注册 hook）、
`media/main.js`（卡片与通知块渲染）、`media/tree.js`（飞行节点布局）、
`tools/check-webview.js` + `tools/harness-test.mjs`（验收）。

---

## 0. 结论摘要

三个期望对应的设计决定：

| 期望 | 决定 |
|---|---|
| 1. 后台终端与子代理都用「飞行节点」（挂在主节点右侧） | 新增节点 kind `'bg'`：一个后台 job = 一个 sidecar 卡片，**与子代理共用同一套右侧网格布局**（`media/tree.js` 的 `agentKids`/`agentMaxRows` 那套）。底部的 dock 被删除。**卡片投递后保留**（D1 已定）：子代理节点（含 depth-2）与后台终端卡片都在投递完成后显示 `Delivered`。 |
| 2. 完成时「紧跟下一个 tool call」发出信号 | 在 `Agent.runTurn` 的 tool 批次之后、`continue` 之前加一个**同步 hook**，把该节点的待投递信号作为一条 `role:'user'` 消息推进 `messages`——与现有 `read_image` 图片块的注入点完全同构。模型的**下一次请求**就带上它，不中断当前回合、不等回合结束。主 agent 与子代理**同一套**（D3 已定）。 |
| 3. 信号虽是 user 消息，仍留在同一节点、渲染成通知块 | 投递目标从「owner 节点下**新建**一个节点」改成 `beginInjectedTurn(owner)`（**同节点**，`fresh:false`，不动视图焦点）；UI 侧一律 push `DisplayItem.kind:'background'`（`.msg.bgnotify` 块），**永不** push `kind:'user'` 显示项。API 历史里它仍是 user 消息。 |

净效果：一条完成信号不再产生新的树节点、不再造出一轮「看起来像用户提问」的回合；
它像 tool 卡片一样出现在**正在说话的那个节点**的转录里，而它代表的工作以右侧飞行节点的形式可见，
投递完成后那张卡片留在原地并标上 `Delivered`（工作记录，与子代理卡片的生命周期一致）。

---

## 0.1 落地与验收记录（2026-09-11）

提交 `0b6f52d`（`feat: signals (background terminal / async sub-agent) delivered in-node at the
next tool boundary`），fast-forward 合并进 `ui/polish`（`91f1844` → `0b6f52d`）。
main 里那批与本工作无关的未提交改动已 `git stash`（`stash@{0}`）备份，未丢弃。

| 阶段 | 状态 | 证据 |
|---|---|---|
| P0 同节点投递（G3） | ✅ | `signals` 套件：`the delivery did not add a node to the session (nodes 2 → 2)` + owner 节点仍在（`POST /navigate` 200） |
| P1 中途注入 hook（G2） | ✅ | `signals` 套件：`the notice sits at an injection point … (preceded by a "tool" message — tool boundary (mid-turn hook))` |
| P2 `kind:'bg'` 飞行节点 + `Delivered`（G1 / D1） | ✅ | 本会话 `list_nodes`（下）；`tree.ts` 的 `isSidecar`、`pruneSession` 归一化、`serialize` 均已落地 |
| P3 文档 / 死代码 | ✅ | `media/` 里 `node-bg` / `bg-dock` / `bg-item` / `ensureDock` / `renderNodeDock` 已无残留；`docs/agents/{file-map,where-to-change}.md` 与 `invariants/{background-terminals,sub-agents,multi-session,conversation-validity}.md` 已更新 |

闸门（全部在 main 上跑）：

```
npm run compile       干净
npm run check:models  OK — 1 models, 1 accepting images (deepseek-flash)
npm run check:webview OK — 31 messages
npm run check:signals PASS signal-persist: the bg card + delivered flag survive a restart
                      (新增常驻闸门 tools/check-signal-persist.js，已接入 vscode:prepublish；
                       见 docs/agents/testing.md 的三道 build-time guard)
node tools/harness-test.mjs signals background branch
                      PASS 3  FAIL 0  SKIP 0   (107.2s)
node tools/harness-test.mjs health sessions concurrency navigation selftest
                      PASS 4  FAIL 0  SKIP 1   (36.0s；SKIP 是既有 phase gate，非失败)
```

现场证据（手动 reload 后的新构建，本会话 `list_nodes`）：

```
- mtw56npo7kp88v  [turn, running, checked out]  And your last tempt still didn't properly reload …
  - mtw5717gl6xls7  [bg, delivered, done]  echo "mid-turn injection probe @ …"; sleep 25; …
  - mtw571l39z95rg  [bg, delivered, done]  node tools/harness-test.mjs signals background branch 2>&1
```

两个后台任务成为 owner 右侧的 `bg` 卡片、都显示 `delivered`、**没有新建 turn 节点**；
两条通知都是在**回合中途**作为 user 消息进入 agent 上下文的（D2 合并成一条；dock 已按 D4 删除）。
对比 §1.4 的旧行为——同一个动作过去会新建一个标题为 `Background #1: …` 的 turn 节点。

**视觉验收**（`computer-use` 截图，`.agent-harness/screenshots/`，用户同一窗口的新构建）：

- 飞行节点：我的 turn 卡片右侧排着三张 `kind:'bg'` 卡片，标题 = 命令，头部是
  **绿色 `Delivered`** + 灰色 `Exit 0` 角标，卡片体内是 `#id exit …` 与该任务的输出；底部 dock 已不存在。
- 通知块：另开一个可控会话（`/session/start` → 起 8 秒后台任务 → 立刻结束回合 → 任务在回合之后完成，
  走空闲注入路径；`/state` 该会话 `nodes: 2`）——卡片内依次是
  **`.bgnotify` 块（`BG` + `#1 finished with exit code 0` + 命令）** → `Thinking` → 模型的回答
  「已收到通知。后台任务 sleep 8 (id 1) 已结束，退出码 0。」，右侧是同一任务的飞行节点。
  即 C3 成立：同节点、卡片内、机器信号专用块，而不是用户气泡、也不新开卡片。
- 中途注入不破坏流式渲染：该回合仍在流式时插入过通知块，卡片正常（Thinking 块、tool 卡片、composer
  都在原位；没有卡在纯文本或错位的 answer）。

**持久化**：`npm run check:signals`（`tools/check-signal-persist.js`，已接入 `vscode:prepublish`）——
把一份会话 fixture 走一遍 `migrateState`（`loadSessions` 的同一条路径）后断言：`kind:'bg'` 卡片在重启后
仍在、`delivered` 仍为真、终态快照（`bgTaskId`/`bgExitCode`/`bgElapsedMs`/`bgOutputTail`）完好、
宿主消失时仍在跑的卡片不再自称 running、两类 sidecar 都不进 `pathMessages` 与 `leafOf`。12/12 通过。

**跨 reload 实测**：07:19 的一次真实窗口 reload 之后（扩展宿主换成新实例 `pid-46892`），
`list_nodes` 仍列出三张 `[bg, delivered, done]` 卡片
（`mtw5717gl6xls7` / `mtw571l39z95rg` / `mtw59t92q7zbsn`）——即 bg 卡片、`delivered` 标志与终态快照
都从磁盘正确重建，`list_nodes` 的 `bg` 标记也来自 `serialize`/`pruneSession` 的新字段。

### 遗留问题（本次未修）

1. **卡住的子代理会永久阻塞窗口 reload，且控制面无法杀掉子代理**：`/reload-window` 在有子代理
   运行时拒绝（`ChatViewProvider.ts:2098`），而 `POST /stop` 只够得着 turn（`runtime.stop(nodeId)`
   只查 `runs` 与 `nodeWorkers`，子代理的 `Agent` 注册在 `runningSubAgents`），
   `POST /wait-for-finish {interrupt:true}` 也只停 turn。建议补一条
   `POST /agent/kill {sessionId, nodeId}` → 现成的 `runtime.onKillAgent(id)`。
2. 上面那次卡住的**根因**：子代理的 `npm run check:webview` 子进程链挂死（进程表里同时有 5 条
   `bash → npm → node tools/check-webview.js`），子代理一直等它们返回。杀掉进程链后它立刻收尾。
   `check:webview` 在什么状态下不退出值得单独查一次（可能是 stub DOM 里的定时器/rAF）。
3. `signals` 套件有两条 SKIP（`sessions[].bgNodes`、`sessions[].cardDelivered`）：`/state` 不暴露
   id 级节点表与 `delivered` 标志，所以「bg 卡片存在」「Delivered 已翻转」只能靠
   **节点数不变 + owner id + 本会话 `list_nodes`** 间接证明。要做到端到端断言，给 `/state`
   加一个 `sessions[].nodeKinds`（按 kind 计数）或 per-node 摘要即可。
4. `hvsc reboot --current` 的续跑 job 在窗口 reload 之后会盯住**旧的** harness instance id，
   因而静默失败（本次由用户手动 reload 才算数）。hvsc 值得在 reload 后重解析 instance 或重试。

---

## 1. 现状（事实，带行号）

### 1.1 后台终端完成（`src/chat/runtime.ts`）

```
background.ts:208 complete()          进程 exit/error/kill → registry.onFinish
  → backgroundHub.ts:80               registry 的 onFinish 闭包补上 owner
  → ChatViewProvider.ts:230           hooks.onFinish → runtimes.get(sessionId).onBackgroundFinished
  → runtime.ts:2373                   buildBackgroundNotice → backgroundNotifQueue.push
  → runtime.ts:2395 scheduleBackgroundDrain()   75ms 去抖；this.busy 时**不排期**
  → runtime.ts:2529 drainBackgroundQueue()      回合结束时调用（:1443 / :1457 / :1472，ctor :355）
  → runtime.ts:2442 injectBackgroundNotices()
      runtime.ts:2482  const run = this.beginTurn(title, { parentId: ownerNodeId, pan: false })
      runtime.ts:2490  run.items.push({ kind: 'background', … })
      runtime.ts:2491  post({ type: 'backgroundNotice', nodeId: run.nodeId, item })
      runtime.ts:2502  run.agent.sendUserMessage(this.combineNotices(batch))
```

- `beginTurn`（`:996-1052`）在 `:1016` **新建节点**（`createNode(newId(), parentId, …)`），
  所以后台通知落在一个 **owner 的子节点**里：标题是 `Background #3: <cmd>`，API 历史以
  `combineNotices()`（`:2423-2429`）拼出的原文作为第一条 user 消息。
- 而且这个新节点会被 `attachNode` **checkout**（`tree.ts:257` `session.activeNodeId = node.id`），
  `postTree` 的 `viewId` 随之改变（`:792-793`）——`pan:false` 只抑制了镜头移动，
  「notice lands in X without moving anything」的注释（`:2436-2440`）并不覆盖 `activeNodeId`。
  即：今天一条后台完成通知**会抢走视图焦点**。
- 运行中/已结束未投递的 job 由 `backgrounds` 快照（`:2329-2343`，`BackgroundInfo` `:139-152`）
  驱动 webview 的**卡片底部 dock**（`media/main.js:752-936`）。

### 1.2 异步子代理完成（`src/chat/runtime.ts`）

```
runtime.ts:1855 Promise.allSettled → :2164 onAsyncBatchDone
  :2175  parent.displayItems.push({ kind: 'background', … })   ← 已经 push 在父节点上
  :2176  post({ type: 'backgroundNotice', nodeId: parent.id })
  :2178  subAgentNoticeQueue.push({ nodeId: parent.id, … })
  :2183 scheduleSubAgentDrain()   同样 75ms + busy 门控
  :2197 drainSubAgentNotices()
      :2226  const run = this.beginInjectedTurn(parent)   ← 同一个节点，fresh=false
      :2242  postPath()
      :2249  run.agent.sendUserMessage(`子代理通知：…`)
```

resume 变体 `deliverResumeAsync`（`:1746-1773`）走同一终点；子代理父节点的子代理完成走
`queueSubAgentChildNotice` / `flushSubAgentChildNotices`（`:1976-2010`）。

**结论：子代理这条路已经是「同节点 + 通知块」**（差距只在时序与视觉），后台终端这条不是。

### 1.3 三条差距

| # | 差距 | 证据 |
|---|---|---|
| G1 视觉 | 后台 job = 卡片底部 dock；子代理 = 右侧飞行节点。两套语言 | `main.js:752-936` vs `main.js:1176-1211` |
| G2 时序 | 两条路都在**回合结束**才投递：`this.busy` 时 `scheduleBackgroundDrain` 直接不排期（`:2396-2398`），`drainSubAgentNotices` 同样 `busy` 即返回（`:2198`）。整个回合（可能十几轮 tool）跑完之前，模型看不到信号 | `runtime.ts:2395-2406`、`:2197-2200` |
| G3 形状 | 后台信号**新建一个节点**：卡片里出现的是一轮「用户提问 → 回答」，标题像用户输入；且 `beginTurn` 走的是 `beginTurn` 的节点创建路径，让树多一块，并把视图焦点（`activeNodeId`）抢到那个新节点上 | `runtime.ts:2482`、`:1016`、`tree.ts:257` |

**附带缺口**：`backgroundNotice` 的 `item` 没有 kind 字段，后台与子代理的通知块都渲染同一个
`BG` badge（`main.js:680`），无法一眼分辨是谁完成的——这正是「no clear UI indication」的一部分。

### 1.4 现场验证（2026-09-11，本调研会话实测）

在本会话里 `exec_command(sleep 15 × 6, start_in_background)` 起了一个 job，`list_nodes` 的结果
把 G1/G3 两条都证实了：

```
- mtw3qxxivdlweh  [turn, done]  D1: Keep, but make it show Delivered …
  - mtw3t3h0urxjf8  [turn, running]  Background #1: for i in 1 2 3 4 5 6; do echo …
```

- **G3 实测**：job 完成的通知**新建了一个 turn 节点**（`mtw3t3h0urxjf8`），标题就是
  `Background #1: <命令>`，并且**这个回合本身跑在新节点里**——用户发起那个后台命令的节点
  `mtw3qxxivdlweh` 里什么都没有留下。模型看到的就是一条普通 user 消息
  （`Background command …（id 1） finished with exit code 0.` + 输出），树里没有任何「这是机器信号」的标记。
- **G1 实测**：同一时间段里，这个 job 在 owner 卡片**底部 dock** 里显示，投递后 dock 那一行消失、
  而树里多出一块 —— 同一个 job 出现在两处，且消失/新增的时机互不相同。
- **顺带的证据**：同一棵树里还有 **depth-2 子代理节点**（如 `mtw3bdbvjlhrfm`、`mtw3bdbvl4u3gj`
  挂在 `mtw3b8lw40izlj` 下，`mtw3bid6fikf7f` 挂在 `mtw3b8lw09dak7` 下）——D1 里「Delivered 也要覆盖
  子子代理」是一个真实可达的状态，不是理论情形。

---

## 2. 目标契约（可验收行为）

1. **C1**：`exec_command` 以 `start_in_background` / `move_to_background` 起来的 job，
   在 owner 节点右侧的飞行节点里可见（命令、状态、输出尾、kill 按钮），与子代理节点同一套网格排布；
   job 结束后卡片保留，并随信号投递从 `pending delivery` 翻到 **`Delivered`**（D1）。
2. **C2**：job/子代理批次完成时，若 owner 节点**正在跑回合**，信号在该回合**下一个 tool 批次结束后**
   立即注入（模型的下一跳就能看到），不新建回合、不打断流；若 owner 空闲，则立即以
   **injected turn** 投递到同一节点。子代理自己作为 owner 时同理（D3）。
3. **C3**：信号在 UI 上是 owner 节点卡片内的一个通知块（`.bgnotify`），不是用户气泡、不新开卡片、
   不移动视图焦点；重启后从 `displayItems` 重新渲染出同一个块。
4. **C4**：`Delivered` 状态对两类飞行节点一致：子代理节点（含 depth-2 子子代理）与后台终端卡片
   都显示；同步 `spawn_agents`/`send_agent_message` 的结果是工具返回值，因此在其 finish 时即算已投递。
5. **C5**：不被破坏的东西见 §3.7（hub 归属、task id、join/kill 去重、删除确认、`backgroundNodes` 上报）。

---

## 3. 设计

### 3.1 一条按节点索引的队列

`runtime.ts` 现有两条独立队列（`backgroundNotifQueue:301`、`subAgentNoticeQueue:295`）合并为：

```ts
/** 一条待投递的完成信号。`nodeId` 恒为**发起**该工作的节点，永不随视图焦点变化。 */
interface SignalNotice {
  nodeId: string;
  kind: 'background' | 'subagent';
  /** 产出这条信号的飞行节点（D1：投递后把它翻成 Delivered）。 */
  sourceNodeId?: string;
  /** 注入给模型的 user 消息正文（多条可合并成一条）。 */
  text: string;
  /** 通知块的卡片字段（webview 的 `backgroundNotice.item`）。 */
  card: { kind: 'background' | 'subagent'; id: string | number; name: string; doneText: string; content: string };
  /** 仅后台：用于 join/kill 后的陈旧性判定（保留 taskAlreadyHandled 语义）。 */
  taskId?: number;
}

private readonly signals = new Map<string, SignalNotice[]>();   // nodeId → 待投递
```

- 入队点：`onBackgroundFinished`（`:2373`，替换 `backgroundNotifQueue`）、`onAsyncBatchDone`（`:2178`）、
  `deliverResumeAsync`（`:1770`）、`queueSubAgentChildNotice`（`:1976`）。
- `queueSubAgentChildNotice` 的「父节点已结束就 auto-resume」语义**保留**（`:1980-1995`）；
  父节点**正在跑**的分支改为由 §3.2 的 hook 投递（原先要等它下一次 finish），这是一次有意的行为升级，见 §7-D3。
- 去重/陈旧：后台沿用 `taskAlreadyHandled`（`:2510-2521`）；`notifyAgent=false` 的 join/kill
  仍在 `onBackgroundFinished`（`:2377-2383`）直接标 `delivered`。

### 3.2 注入点：回合中途、紧跟 tool 批次（G2）

`src/agent/agent.ts` `runTurn` 的循环体里，唯一合法的插入位是 **tool 批次全部结束之后**、
`continue` 之前（`:602` 之后、`:625` 之前），也就是现有 `pendingImageFiles` 的位置（`:603-617`）：

```ts
// （agent.ts:602 之后）
          for (let i = 0; i < assistant.tool_calls.length; i++) { … executeToolCall … }

          // 新增：本节点排队中的完成信号。必须在**整批** tool 响应之后，
          // 否则 assistant(tool_calls) → tool(...) 窗口里夹了别的消息，
          // 下一次 buildPath 的 sanitizeMessages 会把整块删掉
          // （agent.ts:211-221：遇到非 tool 就 break，ids 未清空 ⇒ pop 掉 assistant）。
          for (const text of this.takeSignals?.() ?? []) {
            this.messages.push({ role: 'user', content: text });
          }

          if (this.pendingImageFiles.length > 0) { … }   // 原样保留
          …
          continue;
```

- **合法性**：`sanitizeMessages` 对 user 消息**零约束**（`agent.ts:200`）；请求体原样发送、不过 sanitize
  （`:915-921`）。连续两条 user 消息在本仓库**已有先例**：`sendUserMessage` 在中断后先 push 中断通知再
  push 真实输入（`:543` + `:549`）。`read_image` 的图片块更是「tool 结果之后插 user」的现成范式。
- **持久化**：`finishTurn` 切的是 `messages.slice(run.prefixLen)`（`runtime.ts:1122-1127`），
  中途注入的 user 消息随本回合写回 `node.messages`；`messages[0]` 仍是本回合原始提示，
  「node 历史以 user 开头」不变量不受影响。
- **不做中断**：不 cancel 流、不快进回合——只是让模型**下一跳**看到信号（这正是「right after the
  next tool call」的字面语义）。回合恰好在没有 tool call 的轮次结束？那 hook 不会被调用，
  §3.3 的空闲路径接手，语义仍然是「下一次有机会时立刻告知」。
- **绑定**：hook 是 per-node-worker 的，和 `setBackgroundAccess`（`runtime.ts:376-379`）同一处接线：

```ts
// runtime.ts workerFor()，:380 附近
agent.setSignalHandler(() => this.takeSignalsFor(node));
// runtime.ts runSubAgent()，:1924 之后（让 depth-1 子代理也能在自回合内收到 depth-2 的完成）
sub.setSignalHandler(() => this.takeSignalsFor(job.node));
```

hook 实现（同步、不得抛异常）：

```ts
/** 该节点此刻可投递的信号；在 tool 边界调用，返回要 push 进 messages 的正文。 */
private takeSignalsFor(node: TreeNode): string[] {
  const batch = this.takePendingSignals(node.id);     // 过滤陈旧 + splice + markDelivered + push 卡片
  if (batch.length === 0) return [];
  this.host.persist();
  return [combineSignals(batch)];                     // 一次边界投递合并成一条 user 消息
}

private takePendingSignals(nodeId: string): SignalNotice[] {
  const q = this.signals.get(nodeId);
  if (!q || q.length === 0) return [];
  if (this.host.isHeld()) return [];                  // 排队中的 reload 优先，空闲 drain 会重试
  const batch = q.splice(0).filter((s) => !this.signalStale(s));
  for (const s of batch) {
    if (s.taskId != null) this.markDelivered(s.taskId);        // job 离开 pending 状态
    const node = this.session.nodes[nodeId];
    if (node) node.displayItems.push({ kind: 'background', id: String(s.card.id), name: s.card.name,
                                       doneText: s.card.doneText, content: s.card.content });
    this.markSourceDelivered(s);                               // D1：把产出这条信号的飞行节点翻成 Delivered
    this.post({ type: 'backgroundNotice', nodeId, item: s.card });   // routeTo → 同卡片内追加通知块
  }
  this.postBackgrounds();
  return batch;
}
```

`markSourceDelivered(s)`（D1）：`kind:'background'` → 把 `bgNodes.get(s.taskId)` 那张卡的安全字段
（`delivered=true` + 终态快照，§3.6）落盘并 `post({ type: 'nodeUpdate' })`；
`kind:'subagent'` → 把产出该通知的子代理节点（`s.sourceNodeId`，异步批次/单条 resume 都已知）置
`delivered = true`；同步工具返回那条路在 `runSubAgent.finish()` 里直接置位。

> `node.displayItems` 与 `run.items` 是同一个数组（`beginTurn:1036`），所以运行中的卡片与持久化
> 的显示项天然一致。

### 3.3 空闲路径：同节点 injected turn（G3）

`drainBackgroundQueue`（`:2529`）+ `drainSubAgentNotices`（`:2197`）合并为 `drainSignals()`，
回合结束（`:1443/:1457/:1472`）、ctor（`:355`）、入队去抖后调用：

```ts
private drainSignals(): void {
  if (this.dead) return;
  for (const [nodeId, q] of this.signals) {
    if (!q.length) continue;
    const node = this.session.nodes[nodeId];
    if (!node) { this.signals.delete(nodeId); continue; }        // 分支已删：丢弃
    if (this.runs.has(nodeId)) continue;                          // 正在跑：交给 §3.2 的 hook
    if (this.host.isHeld()) { this.scheduleSignalDrain(500); return; }
    const worker = this.nodeWorkers.get(nodeId);
    if (worker?.agent.running) { this.scheduleSignalDrain(0); continue; }   // finally 还没复位
    const run = this.beginInjectedTurn(node);                      // 同节点、fresh=false、不动视图
    if (!run) { this.scheduleSignalDrain(75); continue; }
    const batch = this.takePendingSignalsFor(nodeId, run);          // 卡片 push 到 run.items
    this.postPath();
    this.setBusy(true);
    run.agent.sendUserMessage(combineSignals(batch));
  }
}
```

相对现状的两处收紧/放松（都是有意的）：

- **去掉 session 级 `this.busy` 门控**，改为**按节点**判定（本节点有 live run 才让位）。
  P3 允许不同节点并发跑回合（`runs: Map<nodeId, TurnRun>`），所以 A 节点跑回合不该再让
  B 节点的完成信号排队到「会话空闲」。
- **`heldBackoff`**（`:2359-2365`）保留：held 期间不新增回合，500ms 重试。

### 3.4 hold 与并发规则一览

| 场景 | 行为 |
|---|---|
| 节点正跑回合，信号到达 | 留在队列；该回合的下一个 tool 边界由 hook 取走（§3.2） |
| 节点空闲，信号到达 | 75ms 去抖后 `beginInjectedTurn`（§3.3） |
| `host.isHeld()`（reload 在途） | hook 返回 `[]`、drain 退避——**绝不**因为注入而延长/新增回合，否则 `/reload-window` 被 "agent is busy" 拒绝（`:998-1004` / `:1062-1066` 的既有闸门语义） |
| 同一节点同时有多条信号 | 一次投递合并成**一条** user 消息（N 个通知块），与今天 `combineNotices` 一致 |
| 不同节点的信号同时到达 | 各自独立投递（并行 injected turn 是 P3 的既有能力） |
| 后台任务被 `join_background` / `kill_background` 处理 | `taskAlreadyHandled` 丢弃陈旧 notice + `markDelivered`（`:2510-2521` 语义保留） |

### 3.5 UI 渲染契约

- **通知块**：沿用 `post({ type: 'backgroundNotice', nodeId, item })`（现有 3 个发送点收敛成 1 个），
  webview 侧 `addBackgroundNotice`（`main.js:675-693`）不变。新增 `item.kind` 字段（`'background' | 'subagent'`），
  用于 badge 文案/配色（`BG` / `SUB`），替掉现在恒为 `BG` 的 `main.js:680`。
- **绝不 push `kind:'user'` 显示项**（升格为不变量，现有代码已如此）：
  - 重放路径 `renderNodeItems`（`main.js:698-718`）只把**第一条** `kind:'user'` 放进顶部固定 prompt 区，
    其后的 user 项**被直接跳过**——即注入信号若存成 `kind:'user'`，刷新后**根本看不见**；
  - 增量路径 `renderItemInto`（`:722-723`）遇到 `kind:'user'` 会调 `addUserPrompt`，
    而后者第一件事就是 `promptEl.innerHTML = ''`（`:213-215`）——**会清掉卡片顶部原有的用户提示**。
  两条都是坏结局，所以注入信号永远走 `kind:'background'`（`.msg.bgnotify`，`main.js:675-693`，CSS `style.css:619-675`）。
- **流式中途插入**：卡片正在流式输出时，通知块会插在当前 answer 元素**之后**；
  `appendAssistant`（`main.js:289-302`）看到 lastElementChild 不是 assistant 会新建一个 answer 块
  ——但**上一个 answer 永远不会被 finalize**（`finalizeStreamingAnswer:338-346` 只看 lastElementChild），
  于是它停留在纯文本节点、markdown 不渲染。所以：
  `case 'backgroundNotice'` 改为 `routeTo(msg.nodeId, () => { finalizeStreamingAnswer(); addBackgroundNotice(msg.item); })`。
- **不改流路由**：`routeTo`（`:1146-1172`）已经按显式 `nodeId` 路由，同卡片追加天然成立；
  `scheduleSubAgentRelayout()` 顺带处理高度变化。

#### `Delivered` 状态（D1：两类飞行节点一致）

「Delivered」= 这条完成信号**已经到达它的读者**（`task.delivered` 今天就是这个语义），
而不是 job 结束。状态机与渲染：

| | 子代理节点（`kind:'agent'`，含 depth-2） | 后台终端卡片（`kind:'bg'`） |
|---|---|---|
| 运行中 | `agentStatus = 'running'` | `status = 'running'` |
| 结束、信号还没投递 | `agentStatus = 'done'/'error'/'killed'`，角标 `pending delivery` | 同左 |
| 投递完成 | **`delivered = true`** → 角标 **`Delivered`** | 同左 |
| 同步工具返回即算投递 | `spawn_agents` / `send_agent_message` 的 `mode:'sync'`：结果本身就是工具返回值，`finish` 时直接 `delivered = true` | — |
| 走 resume 投递的子代理父节点 | `queueSubAgentChildNotice`/`flushSubAgentChildNotices` 真的启动了 resume（`:1988-1993`、`:2004-2010`）时才置 `delivered = true`；仍在队列里（`runningSubAgents` 命中）保持 pending | — |

- 字段：`TreeNode.delivered?: boolean`（两类 sidecar 共用，turn 节点不用），
  持久化进 `session.nodes`（沿用 `node.kind/agentStatus` 那套序列化，`tree.ts:496-510`）。
- 渲染：`createNodeCard` 的 head 里加一个 `span.node-delivered-badge`（`agent`/`bg` 共用），
  文案 `Delivered`；`onAgentDone`（`main.js:1215-1252`）与 bg 卡的 patch 各写一次。
  用 `nodeUpdate`（`runtime.ts:1139-1147`）或新的 `signalDelivered { nodeId }` 轻量消息更新，避免整树 `postTree`。
- 与通知块的对应：每一张 `Delivered` 卡片都对应 owner 卡片里的一个 `.bgnotify` 块（`item.kind` 区分 `BG`/`SUB`），
  这是「信号已送达」的两端证据。

### 3.6 后台终端的飞行节点（G1）

#### 数据模型（`src/chat/tree.ts`）

```ts
kind?: 'turn' | 'agent' | 'bg';
/** 两类 sidecar 共用：完成信号是否已送达它的读者（D1；turn 节点不用）。 */
delivered?: boolean;
/** kind === 'bg'：这个卡片镜像的 session-local 后台任务 id。 */
bgTaskId?: number;
/** kind === 'bg'：终态快照（进程结束后 hub 不再有 live 数据，重启后靠这些字段渲染）。 */
bgCommand?: string;
bgExitCode?: number | null;
bgKilled?: boolean;
bgElapsedMs?: number;
bgOutputTail?: string;
```

- `createNode` 不变；runtime 创建后设 `kind = 'bg'`、`bgTaskId = task.id`、`title = shortCommand(cmd)`。
- `attachNode`（`:226-259`）：sidecar 排序条件从 `node.kind === 'agent'` 扩成
  `kind === 'agent' || kind === 'bg'`（`:233`、`:236`），让飞行节点排在 turn 主干之后。
  `attachNode` 会改 `session.activeNodeId`（`:257`）——调用方必须像 `spawnChildren`
  （`runtime.ts:1787` + `:1840-1842`）那样保存/恢复 `prevActive`，视图焦点绝不能被后台 job 拽走。
- `pathMessages`（`:281-290`）：跳过条件改为 `node.kind !== 'turn'`（`kind === undefined` 视为 turn）。
- `leafOf`（`:306-318`）与 `:311` 的 children 过滤：同样扩到 sidecar 全集，
  飞行节点**永远不能成为 checkout 点**。
- `pruneSession`（`:385-414`）：**不再丢弃 `kind === 'bg'` 节点**（D1：卡片作为工作记录保留）。
  改为把「活」字段归一化：`status === 'running'` 的 bg 节点在加载时改判为 `finished`（进程随宿主
  一起没了，hub 是内存态、`killAll` 在 dispose 时执行），`delivered === false` 的也一并置 `true`
  （那条通知永远不会再投递）。同理 `agentStatus === 'running'` 的归一化（`:411`）覆盖两类 sidecar。

#### 创建/销毁（`src/chat/backgroundHub.ts` + `runtime.ts`）

`execCommand.ts:167` 的 `promote()` → `hub.register(...)` 是**唯一**的后台 job 诞生点。
给 `BackgroundHubHooks` 加一个回调：

```ts
export interface BackgroundHubHooks {
  onUpdated?: (owner: BackgroundOwner) => void;
  onFinish?: (owner: BackgroundOwner, task: BackgroundTask) => void;
  /** 新增：一个 job 刚注册（渲染它的飞行节点）。 */
  onRegistered?: (owner: BackgroundOwner, task: BackgroundTask) => void;
}
// registryFor 里：registry.setOnRegistered?.(…) 不可行（registry 是 tools 层类型），
// 改在 BackgroundHub.register() 里直接调 this.hooks.onRegistered?.(owner, task)（:93-99 之后）
```

runtime 侧：

```ts
onBackgroundRegistered(owner, task) {
  const node = this.createBackgroundNode(owner.nodeId, task);   // kind='bg'，保存/恢复 activeNodeId
  if (node) this.postTree();
}
```

生命周期 = job 生命周期，但**卡片不删**（D1）：投递完成只是状态翻牌，卡片留在 owner 右侧作为记录。

| 事件 | 飞行节点 |
|---|---|
| `register`（运行中） | 创建（status `running`）；`backgrounds` 快照驱动它的命令/耗时/输出尾/kill |
| `complete`（结束、待投递） | 保留，显示 `pending delivery`（`main.js:767-772` 的 `statusTextFor` 语义搬到卡片上）；
  **同时把终态快照写进节点**（见下）——hub 的 live 数据在重启后不可用 |
| notice 投递完成（`markDelivered`） | 卡片**保留**，`delivered = true` → 状态翻成 **`Delivered`**（配 `exit 0` / `killed` 等终态）；`postTree()`/`nodeUpdate` 打补丁 |
| 卡片 kill / `kill_background` | 走既有 `onKillBackground`（`:2568-2580`）→ 同样在投递后翻 `Delivered`，卡片保留 |
| 用户显式清理 | 卡片 head 的 🗑 走既有 `deleteBranch`（`main.js:968-974`）——bg 卡片没有子树，等效于删除这一张记录 |
| 删除 owner 分支 / clear / 删除会话 | 不变：`branchIds(owner)`（`tree.ts:324`）天然包含 bg 子节点，`hub.removeNode(..., {kill:true})` 与 `confirmKillBackgrounds` 计数逻辑（`runningBackgroundsForNodes(branchIds)`）都不用改 |

**终态快照（新增字段）**：为了重启后卡片仍能读出「Delivered · exit 0 · 输出尾」，
`complete` 时把 live 值固化进节点：
`bgTaskId`（已有）、`bgExitCode: number | null`、`bgKilled: boolean`、`bgElapsedMs: number`、
`bgOutputTail: string`（≤800 字符，沿用 `toBackgroundInfo` 的 `:2296-2297` 截尾规则）、
`bgCommand: string`。运行期间这些字段仍由 `backgrounds` 快照实时刷新（不写盘），
只在 finish / delivered 两个时刻 `persist()`。

**hub 归属不变**：registry 仍按 `(session, 发起该 job 的 turn 节点)` 建键（`backgroundHub.ts:59-71`），
飞行节点只是那棵子树里的一个**展示子节点**，`ControlSessionInfo.backgroundNodes` 仍上报 turn 节点
——`harness-test.mjs` 的 `background` 套件（§6）因此保持绿。
需要新增一张 `bgNodes: Map<taskId, nodeId>` 索引来做「任务 → 卡片」的更新映射。

#### 布局（`media/tree.js`）

- `isAgent(id)` → `isSidecar(id)`（`kind === 'agent' || kind === 'bg'`），
  `turnKids`/`agentKids` 相应改名（`tree.js:91-93`、`:136`）。
- 后台 job 直接加入**同一张列优先网格**（`agentMaxRows = 4`），连接线复用 `cells` 路由表与
  `drawEdges()`（`main.js:1413`）——不需要新的几何。
- 默认卡宽对 bg 更友好地小一些可作为一个可调项（`widths[id]`），但不是必须。

#### webview（`media/main.js`）

- `createNodeCard`（`:951-1001`）保持通用；新增 `renderBackgroundCard(card, task)`：
  head = `#id + 短命令`，body = 状态（`running` / `exit 0` / `killed` / `pending delivery`）+ 可折叠输出尾，
  head 上挂 kill（复用 `killBackgroundButton`，`:774-783`）。
- **消息顺序约束**：`routeTo`（`:1146-1172`）在 `nodeEls[nodeId]` 不存在时**静默丢弃**（`:1151-1153`），
  所以 host 必须先 `postTree()` 建好 bg 卡片，再发 `backgrounds` 快照 / `backgroundNotice`；
  注册 job → 建节点 → `postTree()` 的顺序不能颠倒。布局也要真实 DOM（`relayout` 用
  `offsetHeight/offsetWidth` 量尺寸，`:1273-1278`；`drawEdges` 按 `nodeEls[id]` 取矩形，`:1418-1421`）。
- 泛化备选：若以后还要往卡片里塞其它机器生成项，可以加一个通用
  `case 'nodeItem': routeTo(msg.nodeId, () => renderItemInto(msg.item))`——`renderItemInto`（`:721`）
  已经是「按 DisplayItem 渲染」的现成实现；本次不需要。
- `backgrounds` 消费点（`:2446-2448` → `renderBackgrounds:918-936`）：从「group by nodeId → 卡片 dock」
  改为「`task.id` → `bgNodes` 映射 → 更新那张飞行卡」；dock 相关代码（`main.js:752-936` 的
  `ensureDock`/`syncDockMode`/`renderNodeDock`/`createBgItem`/`updateBgItem`/`statusTextFor`/`dockedTask`）
  与配套 CSS（`style.css:684-830`：`.node-bg` / `.bg-dock-*` / `.bg-item*` / `.bg-output`）一起删除。
  旧 host 的 legacy `background` 形状（`:2439-2443`）可以一并删掉或保留为 no-op
  （`check-webview.js:305` 的 `REMOVED_IDS` 里已有 `#bg-panel` 这个前例，可照此登记新删的 id/class）。
- kind 语义审计（全部命中点，必须逐个决定）：
  `ChatViewProvider.ts:1016`（transcript dump：bg 节点无 messages，跳过）、`:1112`、
  `:1711`（会话标题的 turn 计数，`kind !== 'agent'` → 应排除 bg）、
  `runtime.ts:788`（tree 的 items 载体，bg 卡需要 items → 改为 `kind !== 'turn'`）、
  `:1647/:1672`（`send_agent_message` 目标必须是 agent，bg 自然被拒 ✓）、
  `:1764/:1799/:1849`（子代理父节点判定，bg 不参与）、
  `:2280`（`list_nodes` 的 marks）、`sessionTitles.ts:48/54/133`（排除 bg）、
  `tree.ts:231-241/285/311/411/504`（`serialize`）、
  `main.js:1062`（bg 卡不挂 composer）、`:1091-1108`（`updateBranchBanner`：bg 焦点 → 只读、不提示
  「branching from」）、`:1116-1123`（`agentExpanded` → `sidecarExpanded`）、`:1424-1433`（`collectLayout`）。

### 3.7 关键不变量（实现时不得破坏）

1. `assistant(tool_calls) → tool(...)` 窗口完整：注入只能在**整批** tool 响应之后
   （否则 `sanitizeMessages` 删块，`agent.ts:202-221`）。
2. 视图焦点（`session.activeNodeId`）与投递目标解耦：信号永远投到 `owner.nodeId`，`pan:false`。
3. `host.isHeld()` 拦每一次回合启动与每一次注入——它是自驱动 reload 赢竞态的唯一手段。
4. 每个 assistant `tool_calls` 消息后必须紧跟对应 tool 响应（harness 400 的根因），
   所以注入点**不**能放在循环的其它位置（`requestAssistantMessage` 之前等）。
5. hub 的 `(session,node)` 归属与 session-local task id 不变。
6. `journal`/transcript：`kind === 'bg'` 的节点不写 JSONL（`ChatViewProvider.ts:1016`）。

---

## 4. 分期与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0（~10 行，可独立落地） | 后台通知从 `beginTurn(parentId)` 改为 `beginInjectedTurn(owner)`：G3 先消除 | 起 `sleep 3` 后台 job → 等它结束 → 树**不新增节点**，通知块出现在原节点卡片内；`node tools/harness-test.mjs background` 仍绿 |
| P1 | 统一队列 + agent hook（G2） | 一个正在跑的长回合（多轮 tool）中途完成的 job，在**该回合的下一次请求**里被模型看到（transcript dump 里可见 user 消息紧跟 tool 消息）；回合结束后模型自己提到它 |
| P2 | bg 飞行节点（G1）：tree kind、hub `onRegistered`、布局、卡片、快照映射、dock 删除、`Delivered` 角标（两类节点） | 起两个后台 job + 两个子代理 → 四个飞行节点排在同一张网格里；job 结束并投递后卡片**保留**且角标 `Delivered`；kill 一个 job，模型在下一边界知道它被 kill；reload 后卡片仍显示 `Delivered` 与终态 |
| P3 | 文档/不变量/死代码：`docs/agents/invariants/background-terminals.md`、`sub-agents.md`、`multi-session.md`、`conversation-validity.md`；删 dock CSS 与 legacy `background` 消息分支 | `npm run compile` 干净、`check:webview`/`check:models` 绿 |

每阶段收尾按 `AGENTS.md`：`npm run compile` → `powershell -File build-deploy.ps1` → reload
（或 hvsc `reboot`）。

## 5. 与进行中的工作协调

`media/tree.js`、`media/main.js` 与 `tools/research/bench/*` 此刻正被**另一个会话**
（`mtw2ww1kkjjgr9`，`tools/research/bench/agent-grid-plan.md`）改动：列优先网格、
`isAgent`/`agentKids`、`collectLayout`/`drawEdges` 都在动。因此：

- §3.6 的 `isAgent → isSidecar` 改名、`backgrounds` 消费点重写、dock 删除**必须**在网格工作
  落地之后做，或在独立 worktree（`git worktree add`）里做完再 rebase。
- P0/P1（`src/agent`、`src/chat` 侧）与 webview 布局改动不冲突，可以先做。
- `check:webview.js` 的 `TURN_MESSAGES` 重放表要同时容纳两边的新消息形状（bg 节点的 `tree`、
  中途 `backgroundNotice`），建议两边各自只追加、不重排。

## 6. 验证命令

```bash
npm run compile                      # 必须干净
npm run check:webview                # 内存 DOM 重放；新消息类型必须进 TURN_MESSAGES
npm run check:models
powershell -File build-deploy.ps1    # 编译 → 打包 → code --install-extension --force
node tools/harness-test.mjs background branch    # 控制面验收（需活的窗口）
node tools/harness-test.mjs selftest             # 不需窗口
```

要新增的验收点：

- `harness-test.mjs` 新增（phase-tolerant，沿用 `FIELD_PHASE` 的 SKIP 约定）：
  1) **同节点投递**：跑一个后台 job，投递后 `/state` 的该 session `nodes` 数量**不增加**；
  2) **中途注入**：让一个回合连跑多轮 tool，其间 job 完成 → 该节点 transcript 里出现
     `role:'user'` 的通知消息，且**紧跟**在 `tool` 消息之后；
  3) `backgroundNodes` 语义不变（仍报发起 job 的 turn 节点）。
- `check:webview.js`：a) `tree` 带一个 `kind:'bg'` 节点 + `backgrounds` 快照 → 断言飞行卡片被渲染、
  dock 不存在；b) 中转 `backgroundNotice` → 断言通知块落在 owner 卡片**内部**、且流式 answer 被 finalize。

## 7. 风险与开放决策

**风险**

- R1 **回合变长**：中途注入会延长当前回合（多一轮请求）。缓解：一次边界只投递一次合并消息；
  held 期间不注入；`maxTurns` 守卫不变。
- R2 **令牌/缓存**：注入的 user 消息改变历史形状，`prompt_cache` 的后缀会失效一次
  （`agentHarness` 已有 cache 命中率统计，可验收时观察）。
- R3 **飞行节点让树变宽、且不再消失**（D1 后）：长期跑很多 job 的会话会积累卡片。缓解：
  终态卡片比运行中的更矮（一行 head + 折叠输出）；会话级「清理已投递卡片」按钮/命令（`clear delivered`
  之类的控制面动作）可以作为后续小加项；卡宽对 bg 可调窄。
- R6 **终态快照的持久化体积**：每张 bg 卡多存 ≤800 字符输出尾。相比 `displayItems` 里那条通知块
  （已存同样内容），这是可接受的重复；若要省，可在 `clipDisplayItem` 层面共享截断规则。
- R4 `drainSignals` 去掉 session 级 busy 门控后，多条 injected turn 可能并发——这是 P3 的既有能力，
  但要确认 `postPath`/`postTree` 的多节点重绘不产生焦点抖动（`postPath` 跟随 `session.activeNodeId`，
  注入不改它 ✓）。
- R5 `pruneSession` 归一化 bg 节点时若 `activeNodeId` 指向它（理论上不会，因为 bg 永不 checkout），
  要顺手回退到 `leafOf`。

**已定决策（2026-09-11）**

- **D1 — 飞行节点投递后保留，并显示 `Delivered`**：适用于子代理节点（含 depth-2 子子代理）与后台终端
  卡片两类。见 §3.5「`Delivered` 状态」+ §3.6 生命周期表。
  - 影响：bg 卡片不再是纯瞬态 → 需要终态快照字段（§3.6），`pruneSession` 不再丢弃 bg 节点，
    只把 `running` / `delivered:false` 归一化。
- **D2 — 一次边界 N 条信号合并成一条 user 消息**（+ N 个通知块），与今天 `combineNotices` 一致。
- **D3 — depth-1 子代理在自回合内的下一个 tool 边界收到 depth-2 异步完成**，与主 agent 同规则
  （`sub.setSignalHandler(() => this.takeSignalsFor(job.node))`，§3.2）。
- **D4 — 底部 dock：**`[待用户看完实物后拍板]`。dock = 后台 job 运行期间挂在 owner 卡片**底部**的一条
  摘要条（`div.node-bg`，`main.js:836-908` + `style.css:684-737`）：head 是
  `N background tasks · M running` 加每个 live job 一个 `kill #id` 按钮；展开后每项一行
  `#id 短命令 状态`（`running` / `pending delivery` / `exit 0` / `killed`），点开可看输出尾；
  卡片折叠时 dock 缩成那一行摘要。它由 `backgrounds` 快照驱动（`runtime.ts:2329-2343`），
  job 投递后从快照里消失、那一行随之消失。C1 已定「后台 job 改用右侧飞行节点」，
  所以 D4 的实质是**这份「同一个 job 的第二处显示」是否还要留**：
  (a) 全删 dock（推荐：一个 job 只在一处显示，卡片就是它的家）；
  (b) 只保留折叠卡片上的那一行摘要（等价于「折叠时看汇总」）；
  (c) 保留 dock 但只作只读汇总（与 D1 的保留卡片信息重复）。

## 附录 A：改动骨架（关键片段）

`src/agent/agent.ts`

```ts
  /** Provider hook：在 tool 边界取走本节点排队中的完成信号。 */
  private signalHandler: (() => string[]) | null = null;
  setSignalHandler(handler: (() => string[]) | null): void { this.signalHandler = handler; }

  // runTurn 内，tool 批次之后、pendingImageFiles 之前：
  for (const text of this.signalHandler?.() ?? []) {
    this.messages.push({ role: 'user', content: text });
  }
```

`src/chat/tree.ts`

```ts
  kind?: 'turn' | 'agent' | 'bg';
  delivered?: boolean;         // 两类 sidecar 共用：信号已送达（D1）
  bgTaskId?: number;
  // attachNode：if (node.kind === 'agent' || node.kind === 'bg') parent.children.push(node.id)
  // pathMessages：if (node && node.kind !== 'agent' && node.kind !== 'bg') out.push(...)
  // pruneSession：bg 节点**保留**；把 status==='running' / delivered===false 归一化为终态（D1）
  // serialize（:496-510）：kind/delivered/bg* 字段一起持久化
```

`media/main.js`

```js
  case 'backgroundNotice':
    // 中途注入：先给当前 answer 收尾，通知块才会落在它下面而不是让 markdown 不渲染
    routeTo(msg.nodeId, () => { finalizeStreamingAnswer(); addBackgroundNotice(msg.item); });
    break;
```
