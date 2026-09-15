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

- The block that is live right now is always expanded, and it lets go on its own. A
  thinking block receiving deltas, and a tool call between its first delta and its
  result, are expanded whatever `spinney.foldThinking` / `spinney.foldToolCalls` say —
  those two settings describe a block **at rest** again — and they fold back the moment
  the answer's text takes over, the call reports its result, or the turn ends (an
  interrupted call used to stay open, marked `running`, forever). A click on a block's
  header is still the last word: a block you folded or opened by hand is never touched
  by the rule again, and a settings change no longer reaches the block that is live.
- A node that owns unfinished work now offers **Stop** instead of a greyed-out composer.
  While a background terminal or an async sub-agent batch started by that node is still
  running — or its completion notice is already queued for it — the composer's
  bottom-right button is Stop rather than Send (with a tooltip saying so; no banner, and
  the input stays usable exactly as while a turn streams). Pressing it is a **union
  kill**: that node's turn, every background terminal it spawned and every sub-agent it
  is still running are stopped, and **nothing continues the conversation** — each
  suppressed notice is written back into that node's own history (and shown in its card
  as the usual notification block), so it reaches the model with the user's next prompt
  or ▶ Continue. `POST /stop {nodeId}` and `GET /state → sessions[].lockedNodes` expose
  the same rule to the control plane; a card's ✕ still kills one job and *does* tell the
  model. The reason for the node-scoped lock is unchanged: the notice is injected into
  the node that owns the work while a user turn branches off the node it was sent from,
  so sending from there used to run two agents on one conversation line. Only the owner
  is covered — its existing descendant branches stay usable, so a long-lived job (a dev
  server) does not freeze the conversation below it.
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

### Fixed

- A model request that produces no traffic can no longer hang a turn. The client
  only ever retried on an *error*, and a connection that goes quiet neither errors
  nor ends, so the only thing that used to end it was pressing Stop — the "first
  answer takes forever, Stop + Continue makes it instant" report, which shows up as
  `Thinking…` with the tok/s meter pinned at 0 (typically on the first request after
  the window sat idle, when the pooled keep-alive socket is already half-open). Each
  attempt now runs under three watchdogs: 20 s to the response headers (12 s for the
  first request after a ≥60 s idle gap), 20 s to the first chunk, 60 s of silence
  inside an answer. An abort by a watchdog retries transparently through the existing
  backoff (the abort is what tears the dead socket down, so the retry leaves on a
  fresh connection); after the first chunk a stall stays fatal, so no output is
  duplicated. Stop keeps its meaning: a user abort is never retried. The output
  channel also gained `request-headers pending/slow`, `request-first-chunk`,
  `request-timeout` and `request-stall` lines, so a request that has not produced
  its first byte is now visible *while* it waits.

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
