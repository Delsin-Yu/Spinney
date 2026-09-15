# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `spinney.replyLanguage` (dropdown, default `auto` = follow the VS Code display
  language, plus the languages VS Code ships display translations for): the language
  the agent replies in, injected as the system prompt's `## Language` line. The
  options are ordered by use — `en`, `zh-Hans`, `zh-Hant` first, the rest after —
  and each is labelled with the exact name the prompt receives (`English`,
  `Simplified Chinese`, `Brazilian Portuguese`, …). Changing
  it mid-conversation warns that the next request may miss the prompt cache, like a
  model or thinking-effort change.
- UI localization: every user-visible string — the chat window (webview), dialogs,
  the sidebar, and the manifest (command titles, setting descriptions) — now
  follows the VS Code display language, and the extension ships Simplified Chinese
  (`zh-Hans`) and Traditional Chinese (`zh-Hant`). One catalog per language
  (`l10n/bundle.l10n.<locale>.json`, keyed by the English source string) serves the
  host and the webview; `package.nls.<locale>.json` serves `package.json`. The files
  are named by the region-invariant tag, while VS Code still looks a catalog up by
  the region tag it reports (`zh-cn` / `zh-tw` for the language packs), so those
  copies are generated at package time (`npm run sync:l10n`) and removed again once
  the `.vsix` is written. English needs no file — the source strings are the English
  catalog — and any other language falls back to it. A new packaging guard
  (`npm run check:l10n`) fails the build when a catalog and the code drift apart — a
  string with no translation, a stale entry, a mismatched `{0}` placeholder, or a
  generated copy that is missing or stale. The **Spinney** output channel prints an
  `[i18n]` line naming the display language it resolved, the catalog it read, and the
  copy VS Code reads for the host strings.

### Changed

- A node that owns unfinished work is now locked against new sends. While a
  background terminal or an async sub-agent batch started by that node is still
  running — or its completion notice is already queued for it — the composer
  disables the input, Send and attach buttons and shows a "waiting for the
  background task / sub-agent on this branch" banner, and the host refuses the
  send (`onUserMessage`, `POST /continue`, `POST /session/start`). `GET /state`
  reports those nodes as `sessions[].lockedNodes` (and `state.lockedNodes` to the
  webview). The notice is injected into the node that owns the work while a user
  turn branches off the node it was sent from, so sending from there used to run
  two agents on one conversation line: the notice landed before the user's question
  in tree order but after it in wall-clock order, and that reply never saw the job's
  result. Only the owner is locked — its existing descendant branches stay usable,
  so a long-lived job (a dev server) does not freeze the conversation below it.
- The composer (the checked-out node's input dock) no longer scales. Its controls and
  fonts used to follow the host card's width — `--cs` was `card width / 560`, clamped to
  0.8–1.6, so dragging a card's resize handle (or a wide/narrow window hosting the
  placeholder card) resized the input, buttons and metrics along with it. Every size in
  the pane is now a fixed px value, and the pane ignores the card and panel size
  entirely.

- The settings are grouped in the Settings UI: `contributes.configuration` is now one
  section per topic — **Model & API**, **Chat & Display**, **Tools & Execution**,
  **Sub-agents**, **Sessions & Transcripts**, **Control Plane** — in a logical order
  within each group. The 18 keys and their defaults are unchanged; an entry that lived
  in the middle of the old flat list (say `spinney.autoSessionTitles`) simply moved next
  to its neighbours.

## [0.0.1] - 2026-09-14

### Added

- Branchable chat tree: click any turn to fork a new branch and keep the old chain.
- File and command tools: `read_file`, `write_file`, `replace_in_file`, `list_dir`, `exec_command`, `read_image`.
- Parallel sub-agents.
- Background terminals.
- Vision (image input).
- An optional local HTTP control plane.
- API key storage in VS Code SecretStorage.
- A state migration script for older builds.

### Notes

- First public release.
- Sessions from the old extension id need a migration; see the migration section of the README.
