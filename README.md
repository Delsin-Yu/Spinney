# Minimal Agent Harness

A minimalistic VS Code extension that puts an **agentic coding assistant** in your sidebar. It uses the official **DeepSeek API** to drive an agent that can:

- ✅ Chat with you in a sidebar webview
- ✅ **Read / write / edit** files and list directories in your workspace
- ✅ **Run shell commands** (builds, tests, git, npm, …)
- ✅ Be **interrupted** at any time (Stop button / abort)

It is intentionally small: no framework, no external runtime dependencies — just TypeScript, the VS Code API, the Node.js `fetch` global, and DeepSeek's OpenAI-compatible chat completions endpoint.

---

## Features

### 1. Sidebar agent chat with interruption
Open the **Agent Harness** icon in the Activity Bar to chat. Streams tokens live. Click **Stop** to interrupt the model mid-stream, mid tool-call, or even kill a running command.

### 2. File & command tools
The agent can call these tools:

| Tool | Purpose |
| --- | --- |
| `read_file` | Read a file, optionally a 1-based line range. |
| `write_file` | Write/overwrite a file (creates parent dirs). |
| `replace_in_file` | Replace an exact substring (must be unique). |
| `list_dir` | List directory entries. |
| `exec_command` | Run a shell command in the workspace root. |

### 3. DeepSeek official API
Talks to `https://api.deepseek.com/chat/completions` and supports streaming + function calling.

### 4. Vision (image input)
Set the model to `deepseek-v4-flash-vision-exp` and attach or paste an image in the chat:
- Click the **📎 attach** button to pick an image file, or
- **Paste** an image (Ctrl/Cmd+V) from your clipboard into the input.

Images are sent as base64 `image_url` content parts (allowed in `user` messages only).

### 5. Context window usage indicator
The header shows a live bar + label of **input-token usage vs. the model's context window** (e.g. `ctx 24k / 1M`). It updates from the `usage.prompt_tokens` returned by the API. Context sizes auto-detect per model (1M for the v4 models); override with `agentHarness.contextWindow`.

### 6. Multiple persistent sessions
Create, switch, continue, and delete **multiple agent sessions** from the session bar. Each session keeps its own conversation history and UI transcript. Sessions are persisted to the workspace and restored on reload.

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

Send a message like:

> *"List the files in this repo, then read package.json and summarize what the project does."*

The agent will call `list_dir` → `read_file`, show each tool call with its result, and then reply.

Click **Stop** at any time to interrupt. Click the **clear** (trash) button in the header to clear the current conversation.

### Sessions
- Use the **session dropdown** to switch between conversations.
- **＋** creates a new session; **🗑** deletes the selected session.
- Sessions auto-save (to VS Code workspace storage) and are restored on reload, so you can pick up any conversation later.

### Sending images (vision)
1. Set `agentHarness.model` to `deepseek-v4-flash-vision-exp`.
2. Attach an image with the **📎** button or paste one into the input.
3. The image is shown as a thumbnail in your message and sent to the model as an `image_url` content part.

> Supported formats: JPEG, PNG, GIF, WebP. Images are only accepted in `user` messages. See the [DeepSeek Vision guide](https://api-docs.deepseek.com/guides/vision) for limits (e.g. 32 MiB per inline image, 48 MiB request body).

### Project structure
```
src/
  extension.ts            # Entry point, registers the view + commands
  agent/
    agent.ts              # Agent loop: stream, tool calls, interrupt, rollback
    deepseek.ts           # DeepSeek API client (streaming, SSE parsing)
    types.ts              # Shared message / tool / event types
  tools/
    index.ts              # Tool registry + read/write/exec/list implementations
  chat/
    ChatViewProvider.ts   # Webview provider + transcript state
media/
  main.js                 # Webview client (rendering, input, send/stop)
  style.css               # Chat UI styling
```

## How it works

1. User sends a message → `Agent.sendUserMessage` appends a `user` message.
2. The agent streams a completion from DeepSeek, forwarding text deltas to the webview (`streamDelta`).
3. If the model requests tool calls, the agent executes each tool (showing a live "running" badge), appends the results as `tool` messages, and loops back to the model.
4. The loop ends when the model returns a plain text answer, or after `agentHarness.maxTurns` tool rounds.
5. **Stop** aborts an `AbortController`; the fetch, and any running command, are cancelled. The partial turn is rolled back so the transcript stays consistent.
