# AGENTS.md — Minimal Agent Harness

> 本文件是索引。正文在 docs/agents/。改代码前先读对应小节。

This file is the reference an agent should use instead of re-reading the whole
repo. It describes what the project is, how it is wired together, and the
invariants you must preserve when you change it. Read it first; dive into code
only for the part you are touching.

> This repo *is* the harness that reads `AGENTS.md` at session start and injects
> it into the agent system prompt (see "AGENTS.md snapshot" below). Editing this
> file does **not** change the current session's prompt — it only takes effect
> for a newly started session.

---

## Standard closing procedure (build, install, reload) — MANDATORY

**This is the standard procedure of this workspace.** A change that ships code
(anything under `src/`, `media/`, `package.json`) is *not finished* until it is
installed and the user has been told to reload:

1. `npm run compile` must be clean. `build-deploy.ps1` runs it — fix errors
   first, never package a broken build.
2. Run `powershell -File build-deploy.ps1` as the last step: it compiles,
   packages the `.vsix`, and `code --install-extension --force`s it. Use
   `-NoInstall` only when the user explicitly asked for build-only.
3. **Tell the user to run "Developer: Reload Window"** (`Ctrl+Shift+P` →
   "Developer: Reload Window"). The extension host keeps running the *old* code
   until then, so without the reload the change is invisible. Never claim a code
   change is live before that reload, and never leave step 3 implicit.

Notes:

- A reload restarts the extension host; chat sessions persist in
  `agentHarness.state`, so the conversation survives it.
- **Automated alternative:** if the `hvsc` supervisor is running
  (`tools/hyper-vscode/.state/daemon.json` with a live pid), the reload can be
  driven from the CLI instead of asking the user:
  `node tools/hyper-vscode/hvsc.mjs reboot <instanceId> --continue "<message>"`
  (see "External control plane & the `hvsc` supervisor" below). Never add
  `--wait` from inside a turn — it deadlocks.
- Edits to *this file* also only reach the agent prompt at session start — ask
  the user to reload if the new instructions should apply immediately.
- Docs-only edits (README / `AGENTS.md`) do not need `build-deploy` unless
  the packaged `.vsix` itself should be refreshed.

---

## 必读硬约束（动手前扫一眼）
- 行尾：read_file 返回 LF，write_file/replace_in_file 保留磁盘 EOL；多数 src/*.ts 是 CRLF，src/tools/shell.ts、.gitignore、src/http/controlServer.ts 是 LF。
- 每个带 tool_calls 的 assistant 消息后面必须紧跟对应 tool 响应，否则 400；恢复会话走 Agent.sanitizeMessages。
- AGENTS.md 快照只在会话开始时读一次，之后编辑不影响当前会话。
- vendored 布局引擎 `media/vendor/non-layered-tidy-tree-layout/` 固定 @2.0.2：不得编辑、升级或写进 package.json（见 docs/agents/invariants/vendored-deps.md）。
- system prompt 不存进节点，每次激活重新合成；节点历史以 user 消息开头。
- 会话同一时刻只驱动一个；有后台终端在跑时该会话锁定（不能切换/删除/清空）。
- 改完代码必须 `npm run compile` + `build-deploy.ps1`，并让用户 reload 窗口。

## 目录
| 文件 | 什么时候读 |
|---|---|
| docs/agents/what-this-is.md | 想了解这个项目是什么 |
| docs/agents/stack.md | 动构建/依赖/打包 |
| docs/agents/commands.md | 跑命令前 |
| docs/agents/control-plane.md | 动控制平面 / hvsc / 会话跳转 |
| docs/agents/architecture.md | 动数据流、事件、会话结构 |
| docs/agents/file-map.md | 找文件 |
| docs/agents/tools.md | 加/改工具 |
| docs/agents/invariants/line-endings.md | 任何文件读写 |
| docs/agents/invariants/agents-md-snapshot.md | 改 AGENTS.md 注入逻辑 |
| docs/agents/invariants/conversation-validity.md | 动消息历史 / 恢复会话 |
| docs/agents/invariants/interrupt-rollback.md | 动中断/回滚 |
| docs/agents/invariants/session-persistence.md | 动持久化 |
| docs/agents/invariants/chat-tree.md | 动会话树/分支/签出 |
| docs/agents/invariants/background-terminals.md | 动后台终端 |
| docs/agents/invariants/transcripts.md | 动 transcript |
| docs/agents/invariants/sub-agents.md | 动子代理 |
| docs/agents/invariants/streaming-perf.md | 动流式渲染 |
| docs/agents/invariants/config-keys.md | 加配置项 |
| docs/agents/invariants/vision-images.md | 动图片 |
| docs/agents/invariants/vendored-deps.md | 动布局引擎 / vendored 依赖 |
| docs/agents/invariants/agent-authoring.md | 改 agent 提示词 |
| docs/agents/where-to-change.md | 不知道改哪儿 |
| docs/agents/computer-use.md | 需要驱动桌面 GUI |
| docs/agents/scratch-space.md | 找 agent 产物 |
| docs/agents/testing.md | 验收 |

## 折叠工具的深度文档
- background-terminal → docs/agents/invariants/background-terminals.md
- sub-agents → docs/agents/invariants/sub-agents.md
- transcripts → docs/agents/invariants/transcripts.md
- vision → docs/agents/invariants/vision-images.md
- file-verbatim-frame → docs/agents/tools.md
- session-hop → docs/agents/control-plane.md
