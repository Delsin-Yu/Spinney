# Minimal Agent Harness

A minimalistic VS Code extension: an **agentic coding assistant** whose chat is a **branchable tree** in an editor tab, driven by the official **DeepSeek API**. The agent can:

- ✅ **Chat** — each conversation is a 2D pannable/zoomable **chat tree**; any block can branch into a new thread
- ✅ **Read / write / edit** files and list directories in your workspace
- ✅ **Run shell commands** (builds, tests, git, npm, …)
- ✅ Be **interrupted** at any time (Stop button / abort)

It is intentionally small: no framework, no external runtime dependencies — just TypeScript, the VS Code API, the Node.js `fetch` global, and DeepSeek's OpenAI-compatible chat completions endpoint.

---

## Features

### 1. Branchable chat tree in an editor tab
Open the **Agent Harness** icon in the Activity Bar, pick a session (or `Open Chat Tree`), and the chat lives in an editor tab as a **tree**:
- Every block = one turn (your prompt + the agent's answer, incl. its tool calls / thinking).
- **Click a block** to check it out; a fresh reply there starts a new branch (the old chain stays, dimmed).
- **Pan** (drag / MMB), **zoom** (`ctrl+wheel`, 0.4–1.5), **fit**, and **follow** the active node.
- **Drag a card's corner** to resize it (persisted per node); a wireframe previews the target and the tree re-resolves on mouse-up.
- Tool calls & thinking are **folded by default** (with a one-line brief), configurable via `agentHarness.foldToolCalls` / `agentHarness.foldThinking`.
- Streams tokens live into the active block; a per-card green light pins the scroll to the newest content while a turn runs, releases itself when the turn finishes, and can also be toggled by hand.
- The sidebar lists your **sessions** (titles + node count + busy state).

### 2. File & command tools
The agent can call these tools:

| Tool | Purpose |
| --- | --- |
| `read_file` | Read a file, optionally a 1-based line range. |
| `write_file` | Write/overwrite a file (creates parent dirs). |
| `replace_in_file` | Replace an exact substring (must be unique). |
| `list_dir` | List directory entries. |
| `exec_command` | Run a shell command in the workspace root. |
| `read_image` | Read & upload an image for the vision model. |

### 3. DeepSeek official API
Talks to `https://api.deepseek.com/chat/completions` and supports streaming + function calling.

### 4. Vision (image input)
Set the model to a vision model (`deepseek-v4-flash-vision-exp` or `deepseek-v4.1-flash-expires-on-0910`) and attach or paste an image in the chat:
- Click the **📎 attach** button to pick an image file, or
- **Paste** an image (Ctrl/Cmd+V) from your clipboard into the input.

Images are uploaded to the DeepSeek Files API and referenced by `file_id` (allowed in `user` messages only). Attachments are hidden on text-only models.

### 5. Context + wallet + speed readout
The send pane's status row shows a compact readout: live **status** text, then a right-aligned group `ctx % · bal ¥ · tok/s`. `ctx` is the active branch's `usage.prompt_tokens` vs. the context window (auto-detected per model; override with `agentHarness.contextWindow`). Per-turn token totals and cache hit/miss are shown once, in the usage line under the latest assistant reply (there is no per-node footer copy).

The send pane is the active node's **input dock**: it sits at the bottom of the checked-out node's card, so it pans/zooms with the tree and it is always obvious which node a message goes to — check out another node and the pane moves to its card. Its contents scale with the card: resizing the card with its bottom-right handle grows/shrinks the pane's controls and fonts too (0.8×–1.6×, and the tree zoom scales it further). With an empty session (no node yet) the pane is hosted by a bare **New session** card — a normal node card with just the input, no prompt/transcript — which pans and zooms with the view like any other node.

### 6. Persistent sessions + branches
Multiple **sessions** are listed in the **Activity Bar sidebar** (title, node count, busy). Each session is a tree of turns with persistent branch history; everything is stored in workspace storage and restored on reload. Delete/clear a session from the sidebar (right-click → Delete).

### 7. Workspace instructions (AGENTS.md)
If the workspace root contains an **`AGENTS.md`** file, its contents are read **once at session start** and appended to the agent's system prompt under a `## Workspace AGENTS.md (project instructions)` heading. The snapshot is fixed for the session — later edits to `AGENTS.md` do **not** propagate to the prompt until a new session is started.

---

## Setup

### Prerequisites
- [VS Code](https://code.visualstudio.com/) **1.85+**
- A DeepSeek API key from <https://platform.deepseek.com>

### Install dependencies & compile
```bash
npm install
npm run compile
```

### Run in the Extension Development Host
1. Open this folder in VS Code.
2. Press **F5** (Run Extension). A new "Extension Development Host" window opens.
3. In that window, open the **Agent Harness** icon in the Activity Bar.

### Configure your API key
Either set the setting in VS Code:

```json
"agentHarness.apiKey": "sk-..."
```

Or set the environment variable before launching:
```
DEEPSEEK_API_KEY=sk-...
```

You can also choose the model and base URL in settings:
- `agentHarness.model` → `deepseek-chat` (default) or `deepseek-reasoner`
- `agentHarness.baseUrl` → `https://api.deepseek.com` (default)

> Note: `deepseek-reasoner` may not support tool/function calling. Use `deepseek-chat` for the agentic (tool-using) loop.

---

## Usage

Open the **Agent Harness** Activity Bar icon (lists your sessions). Click a session (or the 📄 `Open Chat Tree` button) to open it in an editor tab, then send a message like:

> *"List the files in this repo, then read package.json and summarize what the project does."*

The agent will call `list_dir` → `read_file`, show each tool call with its result, and then reply.

Click **Stop** at any time to interrupt.

### Chat tree interactions
- **Click a node** (its header or a collapsed preview) to switch to that branch; the original chain dims.
- On a node that already has branches, a **“branching from …”** banner appears — send to start a new branch.
- **Pan**: drag the empty canvas, or hold the middle mouse button anywhere.
- **Zoom**: `Ctrl/Cmd + wheel` (0.4–1.5), or wheel over the background. **Wheel over a node** scrolls that node's content instead.
- **Resize a card**: drag its bottom-right corner (a wireframe previews the size; layout resolves on mouse-up; size is stored per node).
- **Fit to view** / **follow the active node**: toolbar buttons.

### Sessions & branches
- The **sidebar** lists sessions; ✅ shows the active one, ⟳ while busy. Right-click → **Delete Session**; the **＋** button creates a new one.
- Each session's conversation is a **tree**; branches persist and are restored on reload.
- `Ctrl/Cmd + click` a node's title to jump back to an earlier turn and continue a branch.

### Sending images (vision)
1. Set `agentHarness.model` to a vision model (`deepseek-v4-flash-vision-exp` or `deepseek-v4.1-flash-expires-on-0910`).
2. Attach an image with the **📎** button or paste one into the input.
3. The image is shown as a thumbnail in your message, uploaded to the DeepSeek Files API, and referenced by `file_id`.

> Supported formats: JPEG, PNG, GIF, WebP. Images are only accepted in `user` messages. Thumbnails are hidden on text-only models (the data is kept). See the [DeepSeek Vision guide](https://api-docs.deepseek.com/guides/vision) for limits.

### Project structure
```
src/
  extension.ts            # Entry point — registers the sidebar + commands
  agent/
    agent.ts              # Agent loop: stream, tool calls, interrupt, rollback
    deepseek.ts           # DeepSeek API client (streaming, SSE parsing)
    types.ts              # Shared message / tool / event types
  tools/
    index.ts              # Tool registry + read/write/exec/list implementations
    background.ts         # Background terminals + process-tree kill
  chat/
    ChatViewProvider.ts   # Session/tree state, panel lifecycle, message routing
    ChatPanel.ts          # Editor WebviewPanel wrapper (single panel for now)
    SessionsProvider.ts   # Sidebar TreeDataProvider listing sessions
    tree.ts               # Chat Tree data model (nodes, path walk, migration)
media/
  main.js                 # Webview client (tree render, pan/zoom, streaming)
  tree.js                 # Chat Tree layout algorithm (pure, no DOM)
  style.css               # Chat UI styling
```

## How it works

1. User sends a message → `beginTurn` creates a (child) node, checks it out, and `Agent.sendUserMessage` appends a `user` message.
2. The agent streams a completion from DeepSeek, forwarding text deltas (which the webview renders into the active card).
3. If the model requests tool calls, the agent executes each tool (live "running" badge), appends the `tool` results, and loops.
4. The loop ends on a plain-text answer or after `agentHarness.maxTurns` tool rounds; `finishTurn` stores the node's message slice and patches the card (`nodeUpdate`).
5. **Stop** aborts an `AbortController`; the fetch and any running command are cancelled. The partial turn is preserved as a checkpoint per node.
6. The webview assembles the active path (`root → checked-out node`) and lays it out as a tree; branches are sibling cards, and the activated path is expanded while others collapse.
