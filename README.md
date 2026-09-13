# Spinney

Spinney is a VS Code extension. It puts an agent harness in an editor tab, and the conversation is a tree.

## Install

Install Spinney from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=deyu.spinney).

## What you get

- Every turn is a node in a tree. Click a turn to check it out, then send a message to start a new branch there.
- The old chain stays in the tree, dimmed.
- The agent reads and writes files, and it runs shell commands.
- Sub-agents run in parallel and report to the caller.
- Press Stop at any time to interrupt a turn.

## Tools

| Tool | Purpose |
| --- | --- |
| `read_file` | Read a file, or one line range. |
| `write_file` | Write a file and create parent folders. |
| `replace_in_file` | Replace an exact substring. The substring must be unique. |
| `list_dir` | List directory entries. |
| `exec_command` | Run a shell command. |
| `read_image` | Read an image, then upload it for a vision model. |

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
