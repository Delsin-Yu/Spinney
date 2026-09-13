# Spinney

Spinney is a VS Code extension. It puts an agent harness in an editor tab, and the conversation is a tree.

## Install

Install Spinney from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=deyu.spinney).

Spinney works with a folder open and with no folder open. With no folder, a relative path resolves against a scratch folder in the extension storage.

## Features

- The conversation is a history you can branch: every turn is a node. Click a turn to check it out, then send a message to branch from it.
- The old line stays in the tree, dimmed, so an earlier turn is one click away.
- The agent edits the working tree, runs shell commands, and can keep a long command in a background terminal while the turn continues.
- Sub-agents run as parallel branches and report back to the parent that spawned them.
- Press Stop to abort the turn at an active head.

An agent inspects the same history with `list_nodes`, and it can hop to a separate history with `hop_session`, then take back that history's answer.

## Tools

Files and search:

| Tool | Purpose |
| --- | --- |
| `read_file` | Read a file, or one line range. |
| `write_file` | Write a file and create parent folders. |
| `replace_in_file` | Replace an exact substring. The substring must be unique. |
| `list_dir` | List directory entries. |
| `search_files` | Search files for a regex. A large result spills to a temp file. |

Shell and background terminals:

| Tool | Purpose |
| --- | --- |
| `exec_command` | Run a shell command. It can hold the command in a background terminal. |
| `check_background_terminal` | Read a background terminal's status and output. |
| `join_background` | Wait for a background terminal to finish. |
| `kill_background` | Stop a background terminal and its process tree. |

Images and history:

| Tool | Purpose |
| --- | --- |
| `read_image` | Read an image, then upload it for a vision model. |
| `search_transcripts` | Search earlier conversations, including sub-agent runs. |

Chat tree, sessions and sub-agents:

| Tool | Purpose |
| --- | --- |
| `list_nodes` | Read the chat tree: its nodes, its branches, and the checked-out node. |
| `spawn_agents` | Start sub-agents in parallel, each with its own task. |
| `spawn_readonly_agents` | Start sub-agents that can only read. |
| `send_agent_message` | Continue a sub-agent that has finished. |
| `send_readonly_agent_message` | Continue a read-only sub-agent that has finished. |
| `hop_session` | Hand a task to a fresh session, then take back its answer. |
| `rename_session` | Rename a session. |

## Workspace instructions

If the workspace root holds an `AGENTS.md` file, Spinney reads it once at start and adds it to the agent's system prompt. Reload the window after you edit that file. Run `Spinney: Show System Prompt` to read the exact prompt the model receives.

## Models

The default model is `deepseek-flash`. It accepts image input. Add other models to `spinney.modelTable`, with a context window and a `vision` flag. Set `spinney.baseUrl` to point at another endpoint.

## API key

Run `Spinney: Set API Key` from the Command Palette. Spinney keeps the key in VS Code SecretStorage. Run `Spinney: Clear API Key` to erase it. You can also set the `DEEPSEEK_API_KEY` environment variable.

## Privacy and data

Spinney sends no telemetry. It connects only to `https://api.deepseek.com`. A request carries your messages, tool results, and images.

The local HTTP control plane is off by default. Turn it on only if you need it. It then listens on `127.0.0.1` and needs a bearer token. The `/continue` endpoint makes the agent run an instruction, so treat it as a local trust boundary.

Spinney writes sessions and tool output to disk as plaintext JSONL. The default folder is the extension global storage. Set `spinney.subAgentTranscriptDir` to choose another folder.

## Uninstall and clear data

Uninstall Spinney from the Extensions view. Then delete the folder `<globalStorage>/deyu.spinney` by hand. That folder holds transcripts, backups, and the HTTP discovery file. Sessions also live in the workspace storage. Delete that folder too.

## Roadmap

- A multi-provider abstraction, not only the DeepSeek endpoint.
- More built-in model presets.

## Development

1. `npm install`
2. `npm run compile`
3. Press F5. This opens an Extension Development Host window.

Three build guards run before packaging: `npm run check:models`, `npm run check:webview`, and `npm run check:signals`.

## Migrating data from an older build

An older build used a different extension id. `tools/migrate-state.mjs` moves its sessions and transcripts into `deyu.spinney`. Run the script only when VS Code is closed. Start with a dry run. Then apply it:

```bash
node tools/migrate-state.mjs --dry-run
node tools/migrate-state.mjs --apply
```

## License and third-party code

The license is MIT. See `LICENSE`. Third-party notices live in `THIRD_PARTY_NOTICES.md` in the repository root.

The package ships markdown-it, with linkify-it, mdurl, uc.micro, and punycode.js inlined. It also ships non-layered-tidy-tree-layout. Both are MIT licensed.
