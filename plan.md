# Chat Tree —— 实施计划

> 状态：Chat Tree（P0–P4）已完成；**子代理 S1/S2 已完成**，全部真机测试（#1–#4）通过，两处显示缺陷已修复，遗留小问题已处理。本文件是续接依据。
> 详细进度/实现/测试见下方「子代理」一节；改动请保编译 `npm run compile` 与打包 `build-deploy.ps1 -NoInstall` 干净。

### 实施进度

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| P0 树模型层 | ✅ 已完成 | `src/chat/tree.ts` 新增；provider 会话换成树（`checkoutNode` / `beginTurn` / `finishTurn`）；v1→v2 迁移 + 原状态备份到 `agentHarness.state.v1backup`；`checkout` 消息已接。线性视图行为不变。`npm run compile` + `build-deploy.ps1 -NoInstall` 通过；迁移/路径/清理逻辑用临时 node 脚本验证后已删除脚本 |
| P1 编辑器区 + 侧栏 | ✅ 已完成 | 聊天搬到编辑器 `WebviewPanel`（`ChatPanel` 抽象，单面板复用，为将来多面板留口子）；侧栏改为原生 `TreeView`（`SessionsProvider`，仅列会话标题）；`package.json` views/commands/menus/activationEvents 更新；`#session-bar` 与相关 main.js 逻辑移除。编译 + 打包通过 |
| P2 树视图（静态） | ✅ 已完成 | `media/tree.js`（纯布局算法）生成；`main.js` 重写为树优先。**含界面反馈改进**：兄弟节点不再被同层最大高度撑高（子树纵排）、展开卡 560px 宽 + `max-height` + `.node-items` 内部滚动、移除极简模式、滚轮按光标位置缩放 + `shift+滚轮` 水平平移 + MMB 拖拽平移。**新加的**：滚轮悬停节点=滚动内容、thinking 块与节点滚动都有绿点锁定（默认点亮）、展开滚到底+提示钉顶、工具/thinking 默认折叠（工具卡带一行 brief，`foldToolCalls`/`foldThinking` 可配）。**可缩放卡片**：节点存 `customSize`（持久化），右下角拖拽手柄只画线框预览（rAF 节流），松手才做一次碰撞重排并 `setNodeSize` 落库；条目滚动区随卡片高度增长。**另**：拖拽用 `setPointerCapture`（离开视口仍跟手、`lostpointercapture` 兜底防卡死）；滚轮缩放下的 1:1 拖拽（位移除以 `zoom`）；底部输入改为居中浮动岛（`min(720px, 100%-28px)`、底部 14px 边距、圆角+阴影），`#input` 最小 3 行高。编译 + 打包通过 |
| P3 流式接入 + 分叉 | ✅ 已完成 | 流式已接入激活叶子节点；发送时在已有子节点的节点上长分支（checkout + 发送即分支）；composer 出现「⤷ branching from <标题> — 你的回复会开新分支」横幅（被检出节点有 children 时）；provider 轮次结束用 `nodeUpdate` 补丁（状态/用量）代替整树重发；`panTo` 消息（checkout/新分支后居中）；去掉状态行 `cache %` 芯片（cache 移到各节点卡脚部）。编译 + 打包通过。**chatTree 全部阶段完成** |
| P4 收尾 + 文档 | ✅ 已完成 | README 更新（编辑器区聊天树 + 侧栏会话列表 + 分支/缩放/折叠用法）；`AGENTS.md` 更新（架构图、文件图、Session persistence、新增 `Chat Tree invariants` 小节、滚动/图片 措辞改为每卡滚动锁 + 树画布）；清理过期 CSS（`#messages*`/`#scroll-lock`）与死代码（webview `sessionLocked`）。`npm run compile` 干净、`build-deploy.ps1 -NoInstall` 成功 |
| 子代理 S1 | ✅ 已完成 | `search_files`(grep) 工具；`spawn_agents` 工具（必填 `write`，`mode` sync/async，`model` 可选）；`SubAgentPool` 并发池；`tree.ts` agent 节点字段；provider `spawnChildren`/`runSubAgent`/`handleSubAgentEvent`（按节点路由）+ `killAgent` + async 结果通知主 agent；webview `routeTo(nodeId)` + 子代理卡/Kill + composer 只读；配置 `maxConcurrentSubagents`(15)/`maxLevel2Subagents`(2)。编译 + 打包通过。**真机测试 #1（并行 sync）通过** |
| 子代理 S2 | ✅ 已完成 | `send_agent_message`（follow-up，向已完成的子代理追加消息让它继续，sync/async）；async 结果通知推广到「子代理父」（运行中的父排队、已完成的父自动 resume）；`model` 白名单（`MODELS` 校验）；子代理对话 `node.messages` 落库以便继续。编译 + 打包通过。**真机测试 #2（async + 完成通知）通过** |

> P0 的 UI 等价性需要在 Extension Development Host 里手动确认（F5）：老会话迁移后线性视图内容应与改动前一致。

---

## 子代理（sub-agents）—— 设计 + S1 实现状态

> 心智模型：子代理 = 树上的一条 **`kind:'agent'` 分支**。父 agent 调 `spawn_agents`（一个工具调用），子代理跑自己的对话；父的 API 历史只留 `assistant(tool_calls)` → `tool(总结)`，子代理的完整过程作为**展示旁系**节点挂在当前 turn 下（可展开查看，检出时 composer 只读）。

### 配置
```jsonc
"agentHarness.maxConcurrentSubagents": { "default": 15 }, // 主 agent 可并行的 level1 子代理数（槽池，超出排队）
"agentHarness.maxLevel2Subagents":     { "default": 2 },  // 每个 level1 子代理可开出的 level2 数（按父计数）
```
- **深度硬上限 = 2**（不可配）：depth≥2 的 agent 不暴露 `spawn_agents`（`Agent.setCanSpawn(false)`），即无 sub-sub-sub-agent。
- **level2 无并发限制**（只受 `maxLevel2Subagents` 按父计数约束）。

### 工具接口
```
spawn_agents({ agents: [{ instruction, write(必填), model? }], mode: 'sync'|'async' })
send_agent_message({ id, message, write?, model?, mode })   // S2：向已完成的子代理追加 follow-up 让它继续
```
- `write:true` → 子代理可 `write_file`/`replace_in_file`/`exec_command`；`write:false`（默认）→ 只读 `read_file`/`list_dir`/`search_files`（`read_image` 恒有）。
- `mode:'sync'` → 阻塞到本批全部完成，返回 `{ results: [{ agentNodeId, ok, summary, model }] }`（tool 结果已满足，API 历史合法）。
- `mode:'async'` → 立即返回 `{ spawned, async:true, ids }`；每个子代理完成时注入一条通知给父 agent（**S2 已推广到「子代理父」**：运行中的父排队、已完成的父自动 resume）。
- `send_agent_message`：`id` 必填（取自 `spawn_agents` 的 `ids`）；`write`/`model` 可选覆盖（`model` 过 `MODELS` 白名单）；目标仍运行中回「still running」。`sync` 阻塞返回结果，`async` 立即返回 `{ resumed, id, async:true }` 随后通知。

### 关键文件/函数（S1 已落地）
- `src/chat/tree.ts`：`TreeNode` 新字段 `kind?/agentDepth?/agentStatus?/agentSummary?/agentModel?/agentWrite?`；`normalizeTreeSession` 保留；**`pathMessages` 跳过 `kind==='agent'` 节点**（独立历史不进父 path）。
- `src/tools/index.ts`：**`search_files`**（Node 递归扫描 + 可选 glob，`rg` 缺失可用，`SKIP_DIRS` 节流，上限 `MAX_SEARCH_*`）；`ToolRegistry.subset(names)`。
- `src/agent/agent.ts`：`SPAWN_AGENTS_TOOL` 定义；`getTools()` 仅在 `canSpawn` 时加入；`executeToolCall` 拦截 `spawn_agents` → `spawnHandler`；`setSpawnHandler`/`setCanSpawn`；`static subAgentSystemPrompt(model, effort, depth, write)`（精简 system，不含完整 CORE_PROMPT/AGENTS.md）。
- `src/chat/SubAgentPool.ts`：并发槽信号量（`withSlot`，超出排队）。
- `src/chat/ChatViewProvider.ts`：`handleSpawnAgents`(主) / `handleSubAgentSpawn`(子) → `spawnChildren(parent, args, signal)`（深度/预算校验 + 建 agent 节点 + `mode` 分支）；`runSubAgent`（新 Agent + 精简 system + `subAgentTools(write)` + 事件绑定节点 + abort）；`handleSubAgentEvent`（流式事件**带 `nodeId`** 发 webview + 提交进 `node.displayItems`）；`onKillAgent`；async 结果 `injectAsyncResult`/`drainSubAgentNotices`；`postTree` 给 agent 节点带 `items`（便于重载恢复）。
- `media/main.js`：`routeTo(nodeId, fn)`（多点并行流式路由）；`case 'agentStart'/'agentDone'`（`onAgentStart`/`onAgentDone`，加 `SUB` 徽章 + `d·model·write/ro` + 运行中 **Kill** 按钮 + finalize + 状态/摘要）；agent 节点恒展开（`onPath = activePathSet.has(id) || kind==='agent'`）；`updateBranchBanner` 检出 agent 节点时 composer 只读；agent 卡 CSS `.node.agent/.node-agent-badge/.node-agent-info/.node-kill`。
- `package.json`：`maxConcurrentSubagents`/`maxLevel2Subagents` 配置项。

### 已测 / 未测
- ✅ **真机测试 #1**（并行 sync，3 个：2 只读 + 1 可写）通过：并行、`write` 门控、sync 收齐、各自独立 Agent。
- ✅ **真机测试 #2**（async + 完成通知）通过：`mode:async` 立即返回 ids；两者完成后注入**一条合并**通知给主 agent（只读列根目录+读 README、可写 `npm run compile` 退出码 0）。
- ✅ **真机测试 #3**（只读强试 `write_file`）通过：只读子代理调用 `write_file` 返回 `Error: "write_file" is not permitted for this read-only sub-agent.`（`withBlocked` 运行时拒绝）。
- ✅ **真机测试 #4**（深度上限）**通过（含义与计划措辞略不同）**：depth-2 子代理的报告确认它**没有** `spawn_agents`/`send_agent_message` 工具（可用仅为 read/list/search + 写工具），即 `setCanSpawn(false)` 已把 spawn 工具从 `getTools()` 摘掉，所以它根本无法发起更深的 spawn。`handleSubAgentSpawn` 里的 `max sub-agent depth is 2` 守卫是**防御兜底**，仅当模型在未声明该工具时强行发出 `spawn_agents` tool_call 才命中；正常 API 流程（函数未声明）不会触发。
- 🐛 **测试后发现并修复的显示缺陷（子代理窗口串扰）**：嵌套 spawn（depth-1 子代理自己再 spawn depth-2）时，`spawnChildren` 把 `session.activeNodeId` 重置为 `parent.id`——若 `parent` 是子代理，就会把 webview 的 `messagesEl` 钉到那张子代理卡上；随后主 agent 恢复/续跑，其不带 `nodeId` 的 `streamDelta`/`thinkingDelta` 就泄漏进子代理窗口（主节点却停在 spawn 工具卡，需重点主节点才渲染）。**数据层无问题**（displayItems 一直挂在主节点），纯显示路由 bug。**修复**：① `spawnChildren` 捕获 `prevActive`，把 active 恢复为 `activeTurnNode?.id ?? prevActive`（永不落到子代理）；② 新增 `mainStreamNodeId()`（= `activeTurnNode?.id ?? session.activeNodeId`），`postPath`/`postTree` 用它取 `activeId`；③ `drainSubAgentNotices` 注入的恢复回合在流式前补一次 `postPath()` 重新把 `messagesEl` pin 到主节点。编译 + 打包通过。
- 🐛 **深度-2 子代理节点不显示/不从其父（depth-1）子代理后面伸出**：`media/tree.js` 的 `layoutTree` 只把 agent 子节点 `pos[a]` 设在这里，**但不递归** —— 于是「agent 节点自己的子节点」（depth-1 子代理 spawn 出的 depth-2）永远拿不到坐标，`relayout()` 不会给它设 `left/top`，卡片叠在左上角/被遮挡，边也画不对。**修复**：① agent 窗口处改为 `place(a, ax, ay)` 递归布局（depth-2 落到 depth-1 右侧并连边）；② `subWidth` 对 agent 子窗口用 `subWidth(a)`（预留其右向子树宽）；③ 新增 `subHeight(id)` 用于竖向堆叠 agent 窗口的间距（避免 depth-1 兄弟与彼此的 depth-2 子窗口重叠）；④ `agentExpanded` 沿 agent 祖先上溯（depth-1 展开时其 depth-2 也保持展开）。编译 + 打包通过。

### 测试 prompt（可直接粘给主 agent）
**#1（已过）** `spawn_agents` mode sync，3 个：① 只读读 `media/main.js` 总结职责；② 只读 `search_files` 搜 `spawn_agents` 说明 provider 接线；③ 可写读 `src/chat/tree.ts` 列出 `TreeNode` 新增字段（别改文件）。
**#2（async）** mode async 开 2 个：一个只读列根目录+读 README 前 30 行；一个可写 `exec_command` 跑 `npm run compile` 报退出码。完成后应通知主 agent。
**#3（边界）** `write:false` 子代理读 `src/agent/agent.ts` 前 60 行后**尝试** `write_file` 改 `/tmp/x.txt`，如实报结果（预期 `unknown tool "write_file"`）。
**#4（深度）** 开一个 `write:true` 子代理，让它在任务里再 `spawn_agents` 开 depth3，报结果（预期 depth2 报错/不暴露工具）。

### S2 —— 已完成
1. **`send_agent_message({ id, message, write?, model?, mode })`**：向指定 agent 节点追加消息、让它继续跑（sync 阻塞返回结果 / async 立即返回 id 并随后通知）。`id` 必填；`write`/`model` 可选覆盖（`model` 过白名单）；目标仍运行中则回「still running」错误。实现见 `handleSendAgentMessage` + `runSubAgent`（`resume` 分支）。
2. **async 结果通知推广到「子代理父」**：`onAsyncBatchDone` 现在对非主父调用 `queueSubAgentChildNotice` —— 子代理父仍运行中则入 `subAgentChildNotices` 排队、完成时经 `flushSubAgentChildNotices` 自动 resume；已完成的父直接 resume。主 agent 父路径（含 `send_agent_message` async 的 `deliverResumeAsync`）沿用 `subAgentNoticeQueue`。
3. **`model` 白名单**：`spawnChildren` / `handleSendAgentMessage` 校验 `MODELS`（由 `CONTEXT_WINDOWS` 键集推导），未知 model 直接报错；`agent.ts` 工具描述仍约束「用户显式要求才换」。
4. **子代理对话落库**：`runSubAgent` 结束把 `agent.getMessages()`（去掉 system）写入 `node.messages`，使 `send_agent_message` 能在同会话/重启后继续；`pruneSession` 把 `agentStatus==='running'` 降级为 `killed`。

### 遗留小问题（S1 已知 —— 已处理）
- 子代理流式期间卡高度变化不触发 `relayout`：**已修复** —— `media/main.js` 的 `routeTo` 在路由子代理 delta 后调用 `scheduleSubAgentRelayout()`（rAF 节流，每帧一次 `relayout()`），让增长的子代理卡实时推动兄弟节点与连接边，不再等到 `agentDone` 才重排。编译 + 打包通过。
- `done` 的 summary：代码已改为 `subAgentSummary` —— 从后往前取**最后一个正文长度 >10 的 assistant 全文**（而非 `items[last].text`），更稳。


## 0. 目标与非目标

### 目标

1. 会话的载体从「线性消息数组」换成**树**：每个节点（block）= 一个 turn（一条用户提示 + agent 为该轮产出的全部内容）。
2. 任意节点都可以分叉：新分支成为激活路径，原链完整保留（变暗）。
3. 聊天界面从侧栏搬到**编辑器区**，形态是**可平移/缩放的 2D 树**；激活路径上的节点展开显示完整内容，旁支折叠成摘要卡。
4. 侧栏退化为**会话标题列表**（原生 `TreeView`）。

### 非目标（v1 明确不做）

- ❌ 「重新生成」（同一 prompt 不输入新提示直接长新分支）——non-goal。
- ❌ 分支/节点删除——non-goal。
- ❌ 编辑历史节点、修改已有消息。
- ❌ 节点级搜索 / 折叠全部 / 导出。
- ❌ 一个会话开多个面板（**但架构要留口子**，见 §7.4）。

---

## 1. 语义（已确认）

- **节点粒度**：一个 turn 一个节点。分叉点 = turn 末端 = agent 的最终消息。
- **检出语义**：点击树中任意节点 → 激活路径 = `root → 该节点`；composer 的下一条消息挂在该节点下。
- **分叉**：在**已有子节点**的节点上发消息 → 新建一个兄弟节点。新分支成为激活路径，原链只是变暗，不移动、不删除。
- **git 心智模型**：checkout 一个 commit，再往上 commit，就长出新分支。

### KV cache（重要修正）

DeepSeek 的 context caching 是**前缀匹配**（按块切），不是整请求命中/未命中：

- 在节点 X 分叉，请求前缀 `root → X` 与之前完全一致 → **这部分照旧命中缓存**，只有分歧点之后的新内容 miss。
- 所以**不做「切分支会全 miss」的提示**。分叉比「在线性会话里改历史」更省缓存，这是树模型的卖点。
- 仍然会大面积 miss 的只有：换模型、换 thinking effort。这两条现有提示保留。

---

## 2. 现状耦合点（改动依据）

| 位置 | 现状 | 影响 |
| --- | --- | --- |
| `Agent.messages` | 扁平 `ChatMessage[]`，system 在 `[0]` | **循环不用改**：树只负责拼出激活路径的扁平数组 |
| `Agent.lastTurnInterrupted` | 进程内状态 | 换分支时要显式重置（§6.3） |
| 会话形状 | `{ messages, displayItems }` 两个平行数组 | 换成节点树，`displayItems` 下沉到节点 |
| `this.displayItems` | 直接指向 session 数组 | 改成指向「当前正在跑的节点」的数组 |
| `turnStartIndex` / `preservePartialTurn` | 本轮起点 + 中断检查点 | 正好等于节点切片起点，天然对齐 |
| `registerWebviewViewProvider` | 侧栏 webview 即聊天界面 | 换成 `WebviewPanel` + 侧栏 `TreeView` |
| `#session-bar` / `scroll-lock` | 会话下拉、自动滚动锁灯 | 前者移入侧栏，后者换成「跟随」开关 |

---

## 3. 数据模型

新增 `src/chat/tree.ts`（纯数据层，不依赖 VS Code UI）：

```ts
export type TurnStatus = 'pending' | 'running' | 'done' | 'interrupted' | 'error';

export interface TreeNode {
  id: string;
  parentId: string | null;
  /** 创建顺序；children[0] 是「原链」的延续 */
  children: string[];
  /** 本 turn 贡献的 API 消息；只要非空就必以 user 开头 */
  messages: ChatMessage[];
  /** 本 turn 的 UI 记录（沿用现有 DisplayItem） */
  displayItems: DisplayItem[];
  status: TurnStatus;
  /** 卡片标题，取自本轮用户提示的首行 */
  title: string;
  createdAt: number;
}

export interface AgentSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  nodes: Record<string, TreeNode>;
  /** 首个节点（初始提交）；空会话为 null */
  rootId: string | null;
  /** 当前检出的节点 = 下一条消息的父节点 */
  activeNodeId: string | null;
}
```

### 3.1 路径拼接

```ts
pathIds(session, nodeId): string[]              // root → node
pathMessages(session, nodeId): ChatMessage[]    // flatMap(n => n.messages)
```

激活一个节点：

```
flat  = [system, ...pathMessages(session, nodeId)]
flat  = Agent.sanitizeMessages(flat)   // 派生副本，绝不写回节点
agent.setMessages(flat)
```

- **system prompt 不进树**，每次激活现场拼（沿用 `Agent.systemPrompt(model, effort)`）。
- 每个节点的切片都以 `user` 开头，所以拼接后 API 序列天然合法；工具调用永远不会跨分叉点。

### 3.2 每轮切片

```
发送前：prefixLen = sanitizedPath.length
本轮结束（done / interrupted / error 三种结局共用）：
    node.messages = agent.getMessages().slice(prefixLen)
```

- 三种结局都走同一条收尾路径，中断检查点（`preservePartialTurn`）、错误回滚（`messages.splice`）自然落进节点。
- 节点在**用户发送时就创建**（`status: 'running'`），不是等轮次结束——这样流式期间的 `displayItems` 有归属。

---

## 4. 不变量与边界情况

1. `node.messages` 非空时必以 `role === 'user'` 开头。
2. 节点切片只在轮次结束时写一次；流式期间节点 `messages` 为空。
3. `prefixLen` 必须基于 **sanitize 之后**的路径长度。
4. 激活路径变化时，若新路径不以「被中断的节点」结尾 → 调用 `agent.resetInterruptState()`（§6.3）。
5. 分叉不产生缓存警告（§1）。
6. 后台任务的 `exec_command` 相关行为不变；`postBackgrounds` / 通知队列 / 会话锁逻辑全部沿用。
7. 会话锁（busy 或存在运行中的后台任务）期间禁止检出/分叉/切会话——沿用现有 `sessionLocked` 语义。
8. 轮次进行中禁止检出别的节点（`busy` 时 composer 与树交互都禁用）。

### 边界

| 情况 | 处理 |
| --- | --- |
| 发送前就中断（上传图片被 Stop） | 节点已被创建但没消息 → 保留空节点并标 `interrupted`？**否**：直接丢弃该节点（`messages.length === 0 && displayItems.length === 0`） |
| 扩展重启时节点 `status === 'running'` | 载入时降级为 `interrupted`（消息可能缺失，路径仍合法） |
| 空节点（无消息无展示项） | 载入时清理 |
| 节点切片为空但状态为 done | 不可能（`sendUserMessage` 至少压入 user 消息）；防御性保留 |

---

## 5. 迁移与持久化

### 5.1 存储

`agentHarness.state` 仍是一个 key，但结构升版：

```ts
interface StoredState {
  version: 2;
  activeSessionId: string;
  sessions: AgentSession[];
}
```

（当前是无 `version` 的 v1：`{ activeSessionId, sessions: [{ id, title, createdAt, updatedAt, messages, displayItems }] }`。）

### 5.2 v1 → v2 迁移（尽力而为）

1. 按 `messages` 里的 `user` 边界切节点，串成单链：遇到 `user` 消息就开一个新节点，`parentId = 上一个节点`。
2. `displayItems` 用指针贪心跟随：遍历展示项，遇到 `kind === 'user'` 就推进到下一个节点。
   - 注意：中断通知、后台通知都是 user-role 消息但**没有**对应的 user 气泡，所以两侧数量不会严格对齐。允许某个节点多挂/少挂几个展示项——**不影响 API 有效性**。
3. 老会话的第一个节点即 `rootId`；`activeNodeId` = 最后一个节点。
4. 迁移后立刻 `persist()` 回写 v2；迁移结果记一条 `[migrate]` 日志（节点数、丢弃的悬空项）。

### 5.3 体积

树会保存**所有分支**的完整 `messages`。风险与对策：

- `persist()` 仍是全量写；节点数或序列化体积超阈值（建议 300 节点 / 4 MB）时在输出通道 + 界面各发一次提示。
- v1 接受全量存储；后续若成为问题，再改「一节点一 key」的惰性存储（`tree.ts` 的接口要为此留出 `loadNode/saveNode` 的抽象口子，但 v1 不实现）。

---

## 6. Agent 与 Provider 改动

### 6.1 `Agent`（`src/agent/agent.ts`）——改动极小

- **新增** `resetInterruptState(): void`：清 `lastTurnInterrupted` / `lastInterruptedTools`。
- 其余不动：循环、工具执行、中断检查点、`sanitizeMessages`、`messagesForCurrentModel` 全部复用。

### 6.2 `ChatViewProvider`

- 会话状态改为树（§3），并持有 `activeNodeId`。
- `activateNode(nodeId)`：拼路径 → sanitize → `agent.setMessages` → `this.displayItems = node.displayItems` → 推 `path` + `context`。
- `onUserMessage`：
  1. 校验（busy / 图片模型检查 / 上传，全部沿用现有逻辑）；
  2. 创建节点：`parentId = activeNodeId`，`status = 'running'`，挂到父节点 `children` 尾部；
  3. `this.displayItems = node.displayItems`，压入 user 展示项；
  4. 激活路径（含新节点，路径消息为空）→ 记 `prefixLen` → `agent.sendUserMessage(content)`；
  5. 推 `tree`（结构变了）。
- 轮次收尾（`done` / `interrupted` / `error`）：写 `node.messages`、`node.status`，推 `nodeUpdate`，`persistActiveSession()`。
- `clear()`：清空当前会话的树（保留 session id/title），语义与今天一致。
- 删除会话：级联丢弃其节点与后台注册表（沿用现有 `handleDeleteSession` 逻辑）。

### 6.3 中断状态

Provider 记录 `lastInterruptedNodeId`。发送前：

```
if (activeNodeId !== lastInterruptedNodeId) agent.resetInterruptState();
```

保证「在 X 被中断后继续在 X 上发消息」→ 通知保留；「切到别的分支再发」→ 通知不串味。

---

## 7. 编辑器区 + 侧栏架构

### 7.1 面板（编辑器区）

- `ChatViewProvider` 不再是 `WebviewViewProvider`，改为管理一个 `vscode.WebviewPanel`：

```ts
this.panel = vscode.window.createWebviewPanel(
  'agentHarness.chatTree',
  'Agent Chat Tree',
  vscode.ViewColumn.Active,
  { enableScripts: true, retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] },
);
```

- 命令 `agentHarness.openChat`：无面板则创建，有则 `reveal()`。`agentHarness.focus` 改为转发到它。
- **面板标题**：`Agent Chat Tree — <会话标题>`。创建时设置，切会话 / 会话标题变化时用 `panel.title = ...` 更新。
- `panel.onDidDispose` → `this.panel = undefined`，**状态不销毁**；重新打开走一遍 `ready` 握手推全量状态。
- 面板关闭时 agent 继续跑（与现在 `retainContextWhenHidden` 的语义一致），但用户看不到流式输出——靠侧栏的 busy 指示 + 状态栏兜底（已知取舍）。
- `this.post()` → `this.panel?.webview.postMessage(...)`，无面板时静默丢弃。

### 7.2 侧栏（原生 TreeView）

新增 `src/chat/SessionsProvider.ts`：`TreeDataProvider<SessionItem>`。

- 每项 = 一个会话：`label` = 标题，`description` = 分支数 / 相对更新时间，`iconPath` = 运行中时 `ThemeIcon('sync~spin')`。
- 点击 → `agentHarness.openSession(id)`：打开面板 + 切到该会话。
- `onDidChangeTreeData` 在会话增删/改名/busy 变化时触发。
- `view/title` 菜单按钮：新建会话；`view/item/context` 菜单：删除会话（`showWarningMessage` 二次确认）、清空会话。
- **只列标题**，不展开分支（已确认）。

### 7.3 `package.json` 变更

```jsonc
"activationEvents": ["onView:agentHarness.sessions", "onCommand:agentHarness.openChat"],
"contributes": {
  "views": { "agentHarness": [
    { "id": "agentHarness.sessions", "name": "Sessions", "contextualTitle": "Agent Harness" }
  ]},
  "commands": [
    { "command": "agentHarness.openChat", "title": "Agent Harness: Open Chat Tree", "icon": "$(comment-discussion)" },
    { "command": "agentHarness.newSession", "title": "New Session", "icon": "$(add)" },
    { "command": "agentHarness.openSession", "title": "Open Session" },   // 内部调用，不出现在命令面板
    { "command": "agentHarness.deleteSession", "title": "Delete Session", "icon": "$(trash)" },
    { "command": "agentHarness.clear", "title": "Agent Harness: Clear Conversation" }
  ],
  "menus": {
    "view/title": [
      { "command": "agentHarness.newSession", "when": "view == agentHarness.sessions", "group": "navigation" },
      { "command": "agentHarness.openChat", "when": "view == agentHarness.sessions", "group": "navigation" }
    ],
    "view/item/context": [
      { "command": "agentHarness.deleteSession", "when": "view == agentHarness.sessions", "group": "inline" }
    ]
  }
}
```

`agentHarness.chat`（webview view）从 `views` 中移除。

### 7.4 为「多会话并行」留口子

v1 单面板，但**不要把「面板」和「会话」写成一一绑定的字段**：

- 面板实例的创建/销毁走一个小的 `ChatPanel` 抽象（持有 `panel` + `sessionId` + `post()`），Provider 内部用 `Map<sessionId, ChatPanel>` 持有——v1 这个 Map 最多一个元素。
- 所有「推给界面」的调用都带上 `sessionId`，投递时按 session 找面板。
- 这样将来开多面板只是放开 Map 的容量，不用重构消息层。

---

## 8. 消息协议（webview ↔ provider）

### provider → webview

| 消息 | 载荷 | 时机 |
| --- | --- | --- |
| `tree` | `{ activeId, nodes: [{ id, parentId, children, title, status, createdAt, usage? }] }` | 结构变化：新节点、检出、切会话、迁移、清空。**不含 items**（体积小） |
| `path` | `{ ids: string[], nodes: [{ id, status, items }] }` | 激活/恢复：激活路径每个节点的展示项 |
| `nodeUpdate` | `{ id, status, usage, title }` | 轮次收尾，webview 就地打补丁，不重发整棵树 |
| `panTo` | `{ id }` | 检出 / 新分支创建后，请求居中 |
| `config` / `state` / `background` / `backgroundNotice` / `context` / `balance` / `status` / `notice` | 沿用 | 同上 |
| `delta` / `thinkingDelta` / `toolCallDelta` / `toolStart` / `toolEnd` / `usage` / `done` / `interrupted` / `error` | 沿用 | 作用对象 = 激活路径最后一个节点 |
| `reset` | — | 切会话时清空画布 |

### webview → provider

| 消息 | 说明 |
| --- | --- |
| `ready` | 握手，provider 回推全量 |
| `userMessage { text, attachments }` | 父节点 = `activeNodeId` |
| `checkout { id }` | 检出某节点（已禁用于 busy 时） |
| `pickImage` / `stop` / `setModel` / `setThinkingEffort` / `clear` / `killBackground` / `openExternal` | 沿用 |
| ~~`newSession` / `switchSession` / `deleteSession`~~ | 移出，改由侧栏命令驱动 |

---

## 9. 树布局与渲染

### 9.1 布局（`media/tree.js`，与 `main.js` 分离）

自上而下的 tidy 树：

- 常量：`NODE_W = 320`，`H_GAP = 32`，`V_GAP = 56`。
- 两遍布局（节点高度可变）：
  1. 渲染节点卡 → 量 `offsetHeight`；
  2. 后序算子树宽度 `sub(n) = children.length ? Σ sub(c) + H_GAP·(n-1) : NODE_W`；`x(n)` = 分配区间居中；`y` 按层累加 `levelY[d+1] = levelY[d] + maxHeight[d] + V_GAP`。
- 连接线：一层 `<svg>` 画父子之间从底边中心到顶边中心的 cubic bezier。
- 重排时机：结构变化 / 展开折叠 / 节点内容定稿 / 极简模式阈值跨越。**流式期间不重排**——正在跑的节点是叶子，向下生长不会挤到任何人。

### 9.2 平移与缩放

- 状态：`panX / panY / zoom`，`#tree-canvas { transform: translate(px,py) scale(z) }`。
- 平移：空白处左键拖拽；**中键（MMB）任意位置拖拽**（`pointerdown` 且 `button === 1`，`preventDefault()` 掉浏览器中键自动滚动）；滚轮竖直平移、`shift+滚轮` 水平平移。
- 缩放：`ctrl/cmd + 滚轮`，范围 0.6–1.5，围绕指针位置缩放。
- 工具栏（面板右上角）：`适应窗口`（fit）、`跟随激活节点`开关。
- **自动 fit**：面板首次渲染完成、切换会话、`reset` 之后各自动 fit 一次；用户一旦手动平移或缩放就不再自动 fit（点工具栏按钮可重新 fit）。
- **跟随模式**（默认开）：激活节点变化或生长时把它带进视野；用户一旦拖拽/缩放即关闭，点开关重新开启。沿用现有「锁灯」的思路，但元素换成工具栏上的开关状态。

### 9.3 节点卡

- **折叠（旁支）**：头部（标题一行 + 状态 pill + 时间）、答复摘要（纯文本，CSS `-webkit-line-clamp: 2`）、脚部用量。**不跑 markdown、不建展示项 DOM**。
- **展开（激活路径）**：完整用户气泡（含图片缩略图）、thinking 块、工具卡、markdown 答复、脚部用量——**复用现有渲染函数**，只是容器从 `#messages` 换成该节点卡的容器。
- 状态 pill：`running / done / interrupted / error`。
- 脚部用量：`tokens N (prompt p + completion c) · cache hit h / miss m`（取自该轮 `displayItems` 里最后一条的 `usage`）。
- **极简模式**（`zoom < 0.8`）：所有节点卡只留标题 + 状态 pill，隐藏摘要、展示项与脚部用量；由画布上的 `zoom-compact` class 驱动（纯 CSS）。
  - 带迟滞，避免缩放时抖动：`zoom < 0.8` 进入，`zoom > 0.85` 退出。
  - 切换后卡片高度变化 → 需要重排；用 rAF 合并，且只在阈值跨越时排一次（不在滚轮连续事件里排）。

### 9.4 `main.js` 的改造要点

- 引入 `activeLeafEl`：流式追加的目标从 `messagesEl.lastElementChild` 改为「激活叶子节点卡的 items 容器」。
  - 受影响函数：`addUser` / `addAssistant` / `appendAssistant` / `appendThinking` / `addTool` / `addLiveTool` / `appendLiveTool` / `finalizeLiveTool` / `updateTool` / `appendUsage` / `addNotice` / `addBackgroundNotice`。
  - 做法：给每个节点一个 `{ rootEl, itemsEl }`，渲染函数接收容器参数（默认取 `activeLeafEl`）。
- `renderHistory` → `renderPath`：按节点分组渲染；激活路径节点走「展开」分支，其余节点走「折叠」分支。
- 旧的 `createScrollController` 不再作用于消息区（滚动交给画布平移）；thinking 块内部滚动继续用。
- 状态行：去掉会话下拉与 `cache %` 芯片；保留状态点、状态文本、`ctx N%`、余额、tok/s。

### 9.5 状态栏口径

- `ctx N%`：**激活路径口径** —— 取激活叶子最后一个 `usage.prompt_tokens` / `contextWindow`。
- 每轮 cache hit/miss：移到节点卡脚部（已确认）。
- 余额：账号级，留在状态行。

---

## 10. 性能

- `tree` 载荷不含 items；`path` 只含激活路径（沿用 `clipDisplayItem` 的裁剪）。
- 折叠节点不建 DOM、不跑 markdown。
- 流式合并（~50ms 一批）与「流式期间纯 Text 节点 + 定稿才跑 markdown」完全保留。
- 布局只在结构变化/定稿/展开时重算，流式期间不动。
- 持久化：`persist()` 仍在轮次结束时调用；超阈值时提示（§5.3）。

---

## 11. 文件清单

| 文件 | 动作 |
| --- | --- |
| `src/chat/tree.ts` | **新增**：节点类型、路径拼接、建节点、迁移、清理、统计 |
| `src/chat/SessionsProvider.ts` | **新增**：侧栏原生 TreeView |
| `src/chat/ChatViewProvider.ts` | 大改：面板生命周期、树状态、协议、检出/分叉、统计口径 |
| `src/agent/agent.ts` | 小改：`resetInterruptState()` |
| `src/extension.ts` | 改：注册 TreeView + 新命令，去掉 webview view provider |
| `media/main.js` | 大改：树渲染、布局、平移缩放、检出/分叉、流式目标容器 |
| `media/tree.js` | **新增**：布局算法 + 画布平移缩放（独立文件，便于单测式验证） |
| `media/style.css` | 大改：节点卡、画布、连接线、工具栏 |
| `package.json` | 改：views / commands / menus / activationEvents |
| `AGENTS.md` / `README.md` | 改：树模型、面板架构、新不变量 |

---

## 12. 要写进 `AGENTS.md` 的新不变量

- 会话 = 节点树；`node.messages` 非空时必以 `user` 开头；路径拼接后必过 `sanitizeMessages`（派生副本，不写回节点）。
- 轮次切片 `node.messages = agent.getMessages().slice(prefixLen)`，`prefixLen` 基于 sanitize 后的路径长度；三种结局共用。
- 检出路径变化且新路径不以被中断节点结尾时，必须 `agent.resetInterruptState()`。
- KV cache 是**前缀匹配**：分叉只让分歧点之后的 token miss，前缀仍命中——**不要**加「切分支会全 miss」的提示。
- 聊天界面是编辑器区 `WebviewPanel`（`retainContextWhenHidden`），侧栏是原生 `TreeView`；面板关闭不销毁状态。
- 多面板是未来方向，`sessionId → ChatPanel` 的映射不要写死成单例。
- 每轮用量挂在节点卡脚部；状态栏 `ctx` 是激活路径口径。

---

## 13. 分阶段实施与验收

> 每阶段结束都必须 `npm run compile` 干净；P1 之后每阶段结束跑一次 `build-deploy.ps1` 在 Extension Development Host 里手动验收。

### P0 —— 树模型层（UI 仍是线性视图）

- 新增 `src/chat/tree.ts`；会话换成 `{ nodes, rootId, activeNodeId }`；v1→v2 迁移；激活/切片/清理。
- 线性视图暂时渲染激活路径，功能与今天等价。

**验收**
- 老会话载入后迁移成功，线性视图内容与改动前一致（逐条比对）。
- 发新消息 → 节点创建、切片正确、重启后恢复。
- 中断 / 报错 / `clear` / 删会话 行为与今天一致。
- 空节点、`running` 残留节点在载入时被正确降级/清理。

### P1 —— 编辑器区 + 侧栏

- `WebviewPanel` 化 + `ChatPanel` 抽象 + `agentHarness.openChat`。
- 侧栏 `SessionsProvider` + 新建/打开/删除/清空命令 + 菜单。
- 聊天 UI 暂时仍是线性视图，但去掉 `#session-bar`。

**验收**
- 关闭面板再打开，历史与进行中的流式状态都恢复。
- 侧栏点击会话能切到对应面板内容；新建/删除/清空行为正确（含运行中后台任务的锁定提示）。
- 扩展重启后 `activationEvents` 能正常激活。

### P2 —— 树视图（静态）

- `media/tree.js`：两遍布局 + 连接线 + 平移/缩放 + fit + 工具栏。
- 节点卡折叠/展开；激活路径展开完整内容。
- 点击节点 → `checkout` → 高亮切换、变暗原链、`panTo`。

**验收**
- 单链会话渲染为一条竖直链；手工构造的分叉会话布局不重叠、连接线正确。
- 中键拖拽、滚轮、shift+滚轮、ctrl+滚轮、fit 都正常；0.6–1.5 缩放边界正确。
- 展开/折叠后重排无跳变；100+ 节点时平移流畅。

### P3 —— 流式接入节点 + 分叉

- 流式目标改为激活叶子节点容器（§9.4）。
- 在已有子节点的节点上发消息 = 创建兄弟节点；新分支成为激活路径。
- `nodeUpdate` 打补丁；节点脚部用量；`ctx` 改激活路径口径；去掉 `cache %` 芯片。

**验收**
- 流式输出、thinking、工具卡草稿→定稿、用量挂载全部落在正确节点上。
- 分叉后原链变暗但内容完整；点击原链节点能切回并继续。
- 在 X 中断 → 在 X 继续发消息，中断通知生效；切到别的分支再发，通知不串味。
- 后台任务通知落在正确的节点上。

### P4 —— 收尾

- 跟随模式细节、工具栏状态、空会话占位、样式打磨。
- 更新 `AGENTS.md` / `README.md`（§12）。
- 全量回归：读/写/执行/图片/后台终端/模型切换。

**验收**
- `npm run compile` 干净、`build-deploy.ps1` 成功。
- 对照 §13 各阶段验收项全过。

---

## 14. 风险

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| `workspaceState` 体积 | 长会话 + 多分支全量 `messages` 变大，启动变慢 | 超阈值提示；接口预留惰性存储（§5.3） |
| 面板不可见时无流式反馈 | 用户以为卡住 | 侧栏 busy 图标 + 状态栏；P4 可加 `showInformationMessage` 一次性提示 |
| `media/main.js` 改动面大 | 回归风险 | 严格按 P0–P4 推进，每阶段独立验收 |
| 变高节点布局抖动 | 展开/极简模式切换时兄弟节点跳动 | 两遍布局 + 只在结构/定稿/阈值跨越时重排（带迟滞） |
| 迁移尽力而为 | 老会话节点边界不完美 | 只保证 API 有效性与「用户提示分组正确」，展示项错挂可接受 |
| 中键拖拽与 VS Code 冲突 | 中键自动滚动被触发 | `pointerdown` + `preventDefault()` + `auxclick` 拦截 |

---

## 15. 已定稿的细节（原「待办」，均已确认）

- **面板标题**：带会话名 —— `Agent Chat Tree — <会话标题>`（§7.1）。
- **自动 fit**：面板首次渲染、切会话、`reset` 后自动 fit 一次；用户手动平移/缩放后不再自动 fit（§9.2）。
- **极简模式**：`zoom < 0.8` 时节点卡只留标题 + 状态 pill，`> 0.85` 恢复（带迟滞，§9.3）。
