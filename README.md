# Spinney

Spinney is a VS Code extension. It puts an agent harness in an editor tab, and the conversation is a tree.

## Install

Install Spinney from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=DE-YU.spinney).

Spinney works with a folder open and with no folder open. With no folder, a relative path resolves against a scratch folder in the extension storage.

## Features

- The conversation is a history you can branch: every turn is a node. Click a turn to check it out, then send a message to branch from it.
- The old line stays in the tree, dimmed, so an earlier turn is one click away.
- The agent edits the working tree, runs shell commands, and can keep a long command in a background terminal while the turn continues.
- Sub-agents run as parallel branches and report back to the parent that spawned them.
- Press Stop to abort the turn at an active head.
- A prompt-snippet button at the left of the composer fills it with a pre-written
  instruction — the shipped `Plan` / `Implement Parallel`, or your own rows from
  `spinney.promptSections` — so a routine instruction is one click and still editable
  before you send it.

An agent inspects the same history with `list_nodes`, and it can hop to a separate history with `hop_session`, then take back that history's answer.

## Tools

Files and search:

| Tool | Purpose |
| --- | --- |
| `read_file` | Read a file, or one line range. |
| `write_file` | Write a file and create parent folders. |
| `replace_in_file` | Replace an exact substring. The substring must be unique. |
| `list_dir` | List directory entries. |
| `search_files` | Search files for a regex. A large result spills to a file under `<agentRoot>/.spinney/tool-output/` (the workspace root, or the no-folder scratch root); `os.tmpdir()` is only a fallback. |

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

The default model is the built-in `deepseek-flash`, which accepts image input. It is
what a fresh profile runs on before anything is configured.

Everything else is configured as **model cards**. Run `Spinney: Open Model Cards` from the
Command Palette, or click the gear beside the model dropdown in the chat. The page
draws your providers as a tree with their model cards branching off them, and it is
the editor of the model configuration:

- `spinney.providers` — one entry per OpenAI-compatible endpoint: a name, a base URL
  (`https://api.deepseek.com` for the built-in provider), and a concurrency cap
  (`0` = unlimited requests in flight).
- `spinney.modelCards` — one entry per selectable model: the name you see in the chat,
  the provider it branches off, the wire model name sent to the provider, its context
  window, its own concurrency cap, whether it takes images and which dialect their
  bytes travel in (`deepseek` = upload to the provider's Files API and reference the
  returned id, `openai` = an inline `data:` URL, the OpenAI-compatible shape), and the
  thinking levels it offers with the one a session starts on.
- `spinney.model` — the card a new conversation starts on.

The page holds your edits as a draft until you press Save; it validates there and
again in the host, and a save it rejects writes nothing. Your API key never goes into
`settings.json` — each provider's key lives in VS Code SecretStorage, entered on the
page or with `Spinney: Set API Key`.

The chat's model dropdown groups the cards per provider, and switching a card
switches its thinking levels with it.

## API key

Run `Spinney: Set API Key` from the Command Palette. Spinney keeps the key in VS Code
SecretStorage, one entry per provider (the built-in provider also accepts the
`DEEPSEEK_API_KEY` environment variable). Run `Spinney: Clear API Key` to erase it.
With more than the built-in provider, set each key from that provider's row on the
`Spinney: Open Model Cards` page.

## Privacy and data

Spinney sends no telemetry. It connects only to the provider endpoints you configure
(by default `https://api.deepseek.com`). A request carries your messages, tool
results, and images.

The local HTTP control plane is off by default. Turn it on only if you need it. It then listens on `127.0.0.1` and needs a bearer token. The `/continue` endpoint makes the agent run an instruction, so treat it as a local trust boundary.

The sessions themselves are not files: they are Memento rows in `state.vscdb`, under the extension's `spinney.state` key (see below). What does reach disk is a finished turn's transcript (JSONL, one API message per line) and an oversized tool result spilled as a text file. Transcripts go to the extension global storage by default — set `spinney.subAgentTranscriptDir` to choose another folder — and spilled output goes to the agent root (see the tools table above).

## Uninstall and clear data

Uninstall Spinney from the Extensions view. Then delete the folder `<globalStorage>/de-yu.spinney` by hand. That folder holds transcripts, backups, and the HTTP discovery file — not the conversations. The sessions themselves are Memento rows in `state.vscdb`, keyed by the extension id as `package.json` spells it (`DE-YU.spinney`): one in `globalStorage/state.vscdb`, and one in each `<workspaceStorage>/<hash>/state.vscdb`. Delete those rows too.

## Roadmap

- More built-in model presets.

## Development

1. `npm install`
2. `npm run dev` — `compile` plus `sync:l10n`. The Chinese catalogs VS Code looks up
   are generated from the canonical ones, so a plain `npm run compile` leaves the
   manifest and host strings English in this window (`docs/agents/invariants/i18n.md`).
3. Press F5. This opens an Extension Development Host window.

Six build guards run before packaging: `npm run check:models`, `npm run check:webview`, `npm run check:modeltree`, `npm run check:signals`, `npm run check:l10n`, and `npm run check:rollover`.

Dev tooling lives in `tools/`: the guards, `sync-l10n-aliases.js` (the generated l10n aliases), the acceptance driver `harness-test.mjs`, `rollover-acceptance.js` (a windowless acceptance run for the context rollover), `modeltree-acceptance.js` (a windowless acceptance run for the Model Card Tree page's host half), `gate-acceptance.js` (a windowless acceptance run for the provider/card request gate), `model-switch-acceptance.js` (a windowless acceptance run for the per-node model selection), the `hvsc` supervisor, and one migration script. A change under `tools/` needs no build and no reload; that folder is not shipped in the `.vsix`.

## Migrating data from an older build

An older build used a different extension id. `tools/migrate-state.mjs` moves its sessions and transcripts to the new id. It handles both spellings of that id: the Memento rows in `state.vscdb` keep the manifest case (`DE-YU.spinney`), while the folder under `globalStorage` is lowercased (`de-yu.spinney`). The script prints both halves before it writes anything. If the new build already ran, it merges into the rows that build wrote, and keeps the conversations of both. Close VS Code first: it refuses to write while a window is open. Start with a dry run. Then apply it:

```bash
node tools/migrate-state.mjs --dry-run
node tools/migrate-state.mjs --apply
```

The script moves no Secrets. Run `Spinney: Set API Key` again after the migration. It also leaves `<repo>/.agent-harness` folders alone; those hold tool output of the old build.

## License and third-party code

The license is MIT. See `LICENSE`. Third-party notices live in `THIRD_PARTY_NOTICES.md` in the repository root.

The package ships markdown-it, with linkify-it, mdurl, uc.micro, punycode.js, and entities inlined. It also ships non-layered-tidy-tree-layout. markdown-it, linkify-it, mdurl, uc.micro, punycode.js, and non-layered-tidy-tree-layout are MIT licensed; entities is BSD-2-Clause.
