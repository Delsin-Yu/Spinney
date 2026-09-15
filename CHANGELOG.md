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
