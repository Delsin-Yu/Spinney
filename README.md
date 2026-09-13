# Spinney

A minimalistic VS Code extension: an **agentic coding assistant** whose chat is a **branchable tree** in an editor tab, driven by the official **DeepSeek API**. The agent can:

- ✅ **Chat** — each conversation is a 2D pannable/zoomable **chat tree**; any block can branch into a new thread
- ✅ **Read / write / edit** files and list directories in your workspace (or in the harness scratch folder when no folder is open)
- ✅ **Run shell commands** (builds, tests, git, npm, …)
- ✅ Be **interrupted** at any time (Stop button / abort)

It is intentionally small: no framework, no external runtime dependencies — just TypeScript, the VS Code API, the Node.js `fetch` global, and DeepSeek's OpenAI-compatible chat completions endpoint.

---

## Features

### 1. Branchable chat tree in an editor tab
Open the **Spinney** icon in the Activity Bar, pick a session (or `Open Chat Tree`), and the chat lives in an editor tab as a **tree**:
- Every block = one turn (your prompt + the agent's answer, incl. its tool calls / thinking).
- **Click a block** to check it out; a fresh reply there starts a new branch (the old chain stays, dimmed).
- **Pan** (drag / MMB), **zoom** (`ctrl+wheel`, 0.4–1.5), **fit**, and **follow** the active node.
- **Drag a card's corner** to resize it (persisted per node); a wireframe previews the target and the tree re-resolves on mouse-up.
- Tool calls & thinking are **folded by default** (with a one-line brief), configurable via `spinney.foldToolCalls` / `spinney.foldThinking`.
- Streams tokens live into the active block; a per-card green light pins the scroll to the newest content while a turn runs, releases itself when the turn finishes, and can also be toggled by hand.
- **Sub-agents** sit to the right of the card that spawned them, packed into an aligned lattice that grows **rightward** — at most 4 rows per column, then a new column — so a 12-way parallel `spawn_agents` fans out sideways instead of stretching the canvas into a long ribbon. A sub-agent's own sub-agents do the same beside *its* card.
- The sidebar lists your **sessions** (titles + node count + busy state).

### 2. File & command tools
The agent can call these tools:

| Tool | Purpose |
| --- | --- |
| `read_file` | Read a file, optionally a 1-based line range. |
| `write_file` | Write/overwrite a file (creates parent dirs). |
| `replace_in_file` | Replace an exact substring (must be unique). |
| `list_dir` | List directory entries. |
| `exec_command` | Run a shell command (`cwd` defaults to the harness root: the workspace folder, or the scratch folder when none is open). |
| `read_image` | Read & upload an image for the vision model. |

### 3. DeepSeek official API
Talks to `https://api.deepseek.com/chat/completions` and supports streaming + function calling.

### 4. Vision (image input)
The vendored model `deepseek-flash` (DeepSeek-V4.1-Flash) accepts images. Attach or paste an image in the chat:
- Click the **📎 attach** button to pick an image file, or
- **Paste** an image (Ctrl/Cmd+V) from your clipboard into the input.

Images are uploaded to the DeepSeek Files API and referenced by `file_id` (allowed in `user` messages only). Attachments are hidden on models that are not image-capable. To add another image-capable model, list it in `spinney.modelTable` with `vision=true`.

### 5. Context + wallet + speed readout
The send pane's status row shows a compact readout: live **status** text, then a right-aligned group `ctx % · bal ¥ · tok/s`. `ctx` is the active branch's `usage.prompt_tokens` — the number the API itself reports for the last request — against the model's context window (from the catalog, or your `spinney.modelTable` row for it; `spinney.contextWindow` is the fallback for models in neither). Per-turn token totals and cache hit/miss are shown once, in the usage line under the latest assistant reply (there is no per-node footer copy).

The send pane is the active node's **input dock**: it sits at the bottom of the checked-out node's card, so it pans/zooms with the tree and it is always obvious which node a message goes to — check out another node and the pane moves to its card. Its contents scale with the card: resizing the card with its bottom-right handle grows/shrinks the pane's controls and fonts too (0.8×–1.6×, and the tree zoom scales it further). With an empty session (no node yet) the pane is hosted by a bare **New session** card — a normal node card with just the input, no prompt/transcript — which pans and zooms with the view like any other node.

### 6. Persistent sessions + branches
Multiple **sessions** are listed in the **Activity Bar sidebar** (title, node count, busy). Each session is a tree of turns with persistent branch history; everything is stored in workspace storage (the profile's **global storage** when no folder is open) and restored on reload. Delete/clear a session from the sidebar (right-click → Delete).

### 7. Workspace instructions (AGENTS.md)
If the workspace root contains an **`AGENTS.md`** file, its contents are read **once when the extension host starts** and appended to the agent's system prompt under a `## 工作区 AGENTS.md（项目说明）` heading. Later edits to `AGENTS.md` do **not** reach a running window (the snapshot is not re-read when you merely start a new session) — reload the window to pick them up. Opening or closing a workspace folder does re-snapshot it. Run **`Spinney: Show System Prompt`** from the command palette to read the exact prompt the model is receiving.

### 8. No folder open (no-repo mode)
An empty VS Code window (no workspace folder) is a supported mode — the sidebar, chat trees, tools and sessions all keep working:
- Every relative `path` and `exec_command`'s default `cwd` resolve against the **harness root**: the workspace folder when one is open, otherwise a scratch root at `<globalStorage>/no-workspace` (created on demand). There is no repository layout to be relative to — reach real files by **absolute path**.
- Scratch output (oversized tool results such as `.spinney/tool-output/…`, screenshots) goes to `<globalStorage>/no-workspace/.spinney/` instead of a workspace-local `.spinney/`.
- `search_files` prints **absolute** paths with no folder open, and sub-agent transcripts land under the scratch root when `spinney.subAgentTranscriptDir` is relative.
- Sessions are stored in the profile's **global storage** (with a folder open they stay in workspace storage), so a no-repo conversation does not disappear when you open a folder later.

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
3. In that window, open the **Spinney** icon in the Activity Bar.

### Configure your API key
Either set the setting in VS Code:

```json
"spinney.apiKey": "sk-..."
```

Or set the environment variable before launching:
```
DEEPSEEK_API_KEY=sk-...
```

You can also choose the model and base URL in settings:
- `spinney.model` → `deepseek-flash` (default, DeepSeek-V4.1-Flash, image-capable)
- `spinney.modelTable` → extra models for the dropdown, as structured data —
  edit it in `settings.json` (the setting's description links straight there):

  ```json model-table
  "spinney.modelTable": {
    "deepseek-v4-pro": { "vision": false, "max_tokens": 1048576 }
  }
  ```

  (`max_tokens` = that model's context window; `vision` = whether it takes images.)
- `spinney.baseUrl` → `https://api.deepseek.com` (default)

All `spinney.*` settings apply **immediately** — no window reload: the API
key / base URL are re-read into the live client (the next request uses them),
and the remaining keys are read at their point of use. The only exception is
`AGENTS.md`, whose snapshot into the system prompt is taken once per activation
(reload after editing it). See `docs/agents/invariants/config-keys.md`.

> Note: whether a model supports tool/function calling is not something the
> harness can know — a legacy reasoner model may ignore the `tools` field. If a
> model you added never calls a tool, try another one.

---

## Usage

Open the **Spinney** Activity Bar icon (lists your sessions). Click a session (or the 📄 `Open Chat Tree` button) to open it in an editor tab, then send a message like:

> *"List the files in this repo, then read package.json and summarize what the project does."*

The agent will call `list_dir` → `read_file`, show each tool call with its result, and then reply.

Click **Stop** at any time to interrupt.

### Chat tree interactions
- **Click a node** (its header or a collapsed preview) to switch to that branch; the original chain dims.
- On a node that already has branches, a **“branching from …”** banner appears — send to start a new branch.
- **Pan**: drag the empty canvas, or hold the middle mouse button anywhere.
- **Zoom**: `Ctrl/Cmd + wheel` (0.4–1.5), or wheel over the background. **Wheel over a node** scrolls that node's content instead.
- **Resize a card**: drag its bottom-right corner (a wireframe previews the size; layout resolves on mouse-up; size is stored per node).
- **Copy a node's id**: right-click a card's **header** → *Copy node ID*. The id is what names the node in `list_nodes`, in the transcript dumps (`<root>/<sessionId>/<nodeId>.jsonl`) and in the `spinney` output channel's `[node …]` lines. The copy goes through the host (status-bar confirmation); the transcript **below** the header keeps VS Code's own right-click menu, so its text stays selectable and copyable as usual.
- **Delete a branch**: hover a card and click the 🗑 in its header (or run the palette command `Spinney: Delete Branch at Checked-out Turn`). A modal confirmation always comes first — the turn and *everything below it* (sub-agent cards included) are removed from the history **and** their JSONL transcript dumps are deleted from disk, so `search_transcripts` can no longer recall them. The checkout moves to the parent of the deleted branch. Blocked while the agent or a sub-agent inside that branch is running.
- **Fit to view** / **follow the active node**: toolbar buttons.

### Sessions & branches
- The **sidebar** lists sessions; ✅ shows the active one, ⟳ while busy. Right-click → **Delete Session**; the **＋** button creates a new one.
- Each session's conversation is a **tree**; branches persist and are restored on reload.
- `Ctrl/Cmd + click` a node's title to jump back to an earlier turn and continue a branch.

### Sending images (vision)
1. Keep a model that is image-capable selected (`deepseek-flash` is; another one needs `vision=true` in `spinney.modelTable`).
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
4. The loop ends on a plain-text answer or after `spinney.maxTurns` tool rounds; `finishTurn` stores the node's message slice and patches the card (`nodeUpdate`).
5. **Stop** aborts an `AbortController`; the fetch and any running command are cancelled. The partial turn is preserved as a checkpoint per node.
6. The webview assembles the active path (`root → checked-out node`) and lays it out as a tree; branches are sibling cards, and the activated path is expanded while others collapse.
