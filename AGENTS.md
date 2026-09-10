# AGENTS.md — Minimal Agent Harness

> 本文件是**索引**，也是会话开始时注入 agent 的工作区说明。正文在 `docs/agents/`：要动哪块代码，先读对应那篇。快照在**扩展宿主启动时读一次**（`ChatViewProvider` 构造），所以改本文件要 reload 窗口才生效。

---

## 收尾流程：compile → build-deploy → reload（强制）

改动 `src/`、`media/`、`package.json` 里的任何东西，没走完这三步就不算完成：

1. `npm run compile` 必须干净——`build-deploy.ps1` 会先跑它，别打包一个编译不过的版本。
2. `powershell -File build-deploy.ps1`：编译 → 打包 `.vsix` → `code --install-extension --force`。只有用户明确说"只构建"时才加 `-NoInstall`。
3. **让用户 `Ctrl+Shift+P` → "Developer: Reload Window"**。扩展宿主在 reload 之前一直跑旧代码，所以 reload 之前不要宣称改动已生效，也不要把这步留给人猜。

- 自动替代：`hvsc` supervisor 在跑时（`tools/hyper-vscode/.state/daemon.json` 里有活的 pid），改用 `node tools/hyper-vscode/hvsc.mjs reboot <instanceId> --continue "<消息>"` 驱动 reload；**回合内永远不要加 `--wait`**（会死锁）。
- 只改文档（`README.md` / `AGENTS.md`）不需要 `build-deploy`，除非要顺带刷新已打包的 `.vsix`。
- reload 会重启扩展宿主；会话存在 `agentHarness.state` 里，对话不丢。

## 必读硬约束（动手前扫一眼）

- 每个带 `tool_calls` 的 assistant 消息后面必须紧跟对应的 `tool` 响应，否则 400；恢复会话走 `Agent.sanitizeMessages`。
- system prompt 在会话开始时固定，切模型/努力只原地重写 `messages[0]`；**模板、占位符和两条硬规则**见 `docs/agents/invariants/system-prompt.md`。想看模型实际收到什么：命令 `Agent Harness: Show System Prompt`。
- system prompt 不存进节点，每次激活重新合成；节点历史以 user 消息开头。
- 提示词里**不写工具清单**：schema 走 API 的 `tools` 字段。每个工具的 schema、执行代码和能力门槛（`vision` / `spawn` / `spawnReadOnly` / `hop`）都在同一个文件里。
- 行尾不要凭记忆：`read_file` 返回 LF，`write_file`/`replace_in_file` 保留磁盘 EOL。见 `docs/agents/invariants/line-endings.md`。
- `media/vendor/non-layered-tidy-tree-layout/` 是 vendored 且 hash 固定的布局引擎（@2.0.2）：不编辑、不升级、不写进 `package.json`。
- 同一时刻只驱动一个会话；该会话有后台终端在跑时会被锁定（不能切换/删除/清空）。
- `npm run check:models` 会让"在 `src/**` 里硬写模型 id"直接打包失败——模型名一律从 `src/agent/models.ts` 取。

## 目录（正文在 `docs/agents/`）

- **这是什么 / 怎么跑**：`what-this-is` · `stack` · `commands` · `architecture` · `file-map`（找文件）· `where-to-change`（不知道改哪儿）
- **提示词**：`invariants/system-prompt`（模板 + 规则）· `invariants/agent-authoring`（改提示词）· `invariants/agents-md-snapshot`
- **工具**：`tools`（加/改工具、verbatim frame 语法）· `invariants/sub-agents`（spawn_* / send_*）· `invariants/background-terminals`（exec_command 与后台终端）· `invariants/transcripts`（search_transcripts）· `invariants/vision-images`（read_image）
- **会话与持久化**：`invariants/conversation-validity` · `invariants/session-persistence`（持久化 + rename_session 的自动命名与锁定）· `invariants/chat-tree`（分支/签出）· `invariants/interrupt-rollback`
- **控制平面 / 桌面**：`control-plane`（含 hop_session / list_nodes）· `computer-use`
- **其余不变量**：`invariants/line-endings` · `invariants/config-keys` · `invariants/streaming-perf` · `invariants/vendored-deps`
- **无工作区模式（没打开文件夹）**：`no-repo-mode`（根、会话存储、行为差异）
- **验收与产物**：`testing` · `scratch-space`
