# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.1] - unreleased

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
