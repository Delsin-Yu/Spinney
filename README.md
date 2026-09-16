# Spinney

Spinney is a VS Code extension. It puts an agent harness in an editor tab, and the conversation is a tree.

## Install

Install Spinney from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=DE-YU.spinney).

Spinney works with a folder open and with no folder open. With no folder, a relative path resolves against a scratch folder in the extension storage.

## Start

1. Run **`Spinney: Set API Key`** and paste a key. Spinney keeps it in VS Code secret storage, never in `settings.json`. The built-in provider also accepts the `DEEPSEEK_API_KEY` environment variable.
2. Open the **Spinney** container in the Activity Bar, then click **New Session**.
3. Write your message in the composer. `Enter` sends, `Shift+Enter` adds a line.

## Features

- The conversation is a history you can branch: every turn is a node. Click a turn to check it out, then send a message to branch from it.
- The old line stays in the tree, dimmed, so an earlier turn is one click away.
- The agent edits the working tree, runs shell commands, and can hold a long command in a background terminal while the turn continues.
- Sub-agents run as parallel branches and report back to the parent that started them.
- Press Stop to end the turn at the checked-out node: it aborts the turn, kills that node's background terminals and its sub-agent subtree, and nothing continues.
- A prompt-snippet button at the left of the composer fills the input with a pre-written instruction: the shipped `Plan` / `Implement Parallel`, or your own rows from `spinney.promptSections`.
- A full context window continues in a new one instead of being compressed, from the **⧉ Continue in a new window** button on the failed card.
- An agent inspects the same history with `list_nodes`, and it can hand a task to a fresh session with `hop_session`, then take back that session's answer.

## Documentation

Run **`Spinney: Show User Manual`** from the Command Palette. It opens the full manual in an editor tab: the chat tree and its gestures, sessions and tabs, models and providers, sub-agents and background terminals, images, retries and the context rollover, the complete settings and command reference, privacy, and troubleshooting.

The manual ships in English, Simplified Chinese, and Traditional Chinese, and follows the VS Code display language. The same pages live in [`manual/`](manual/manual.md), and the English page is the source.

## Models

A profile with no configuration runs the built-in `deepseek-flash` card, which accepts image input and talks to `https://api.deepseek.com`.

Everything else is a **model card**: a row of `spinney.modelCards` bound to one endpoint from `spinney.providers`. Edit both in the **Model Cards** page, which `Spinney: Open Model Cards` opens, or with the gear beside the chat's model dropdown. The page validates a save before it writes, and it holds your edits as a draft until you press Save.

- A provider row carries its name, its base URL, a concurrency cap (`0` = no limit), and how the endpoint reports its credit (`none`, `deepseek`, `openrouter`, or `moonshot`).
- A card carries the name you pick in the chat, the wire model name sent to the provider, its context window, its own concurrency cap, whether it takes images and in which dialect their bytes travel, and the thinking levels it offers with the one a session starts on.
- Each provider's API key lives in VS Code secret storage, one entry per provider. Run `Spinney: Set API Key` or `Spinney: Clear API Key`, or set a named provider's key from its row on the page.

The manual explains every field, the per-node model rule, and the cache warning a model switch costs.

## Workspace instructions

If the workspace root holds an `AGENTS.md` file, Spinney reads it once at start and adds it to the system prompt. Reload the window after you edit that file. Run `Spinney: Show System Prompt` to read the exact prompt the model receives.

## Privacy and data

Spinney sends no telemetry. It connects only to the provider endpoints you configure. A request carries your messages, the tool results, and the images.

The conversations are not files: they are rows in the VS Code state database. What does reach disk is a finished turn's transcript (JSONL), an oversized tool result, and the optional http file. Uninstall, and the steps to delete the conversations too, are in the manual.

The local HTTP control plane is off by default. Turn it on only if you need it. It then listens on `127.0.0.1` and needs a bearer token. The `/continue` endpoint makes the agent run an instruction, so treat it as a local trust boundary.

## Roadmap

- More built-in model presets.

## Development

1. `npm install`
2. `npm run dev` — `compile` plus `sync:l10n`. The Chinese catalogs VS Code looks up are generated from the canonical ones, so a plain `npm run compile` leaves the manifest and host strings English in this window (`docs/agents/invariants/i18n.md`).
3. Press F5. This opens an Extension Development Host window.

Eight build guards run before packaging: `npm run check:models`, `npm run check:webview`, `npm run check:modeltree`, `npm run check:signals`, `npm run check:l10n`, `npm run check:rollover`, `npm run check:grid`, and `npm run check:docs`.

Dev tooling lives in `tools/`: the guards, `sync-l10n-aliases.js` (the generated l10n aliases), the acceptance driver `harness-test.mjs`, `rollover-acceptance.js` (a windowless acceptance run for the context rollover), `modeltree-acceptance.js` (a windowless acceptance run for the Model Card Tree page's host half), `gate-acceptance.js` (a windowless acceptance run for the provider/card request gate), `model-switch-acceptance.js` (a windowless acceptance run for the per-node model selection), the `hvsc` supervisor, and one migration script. A change under `tools/` needs no build and no reload; that folder is not shipped in the `.vsix`.

A change under `manual/` is different: the pages ship in the `.vsix`, so they need the compile, the package and the reload like code. See `docs/agents/user-manual.md`.

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
