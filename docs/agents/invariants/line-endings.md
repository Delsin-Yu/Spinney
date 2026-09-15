## Line endings
- `read_file` always returns **LF**-normalized content (the canonical form for
  the model) and reports the on-disk EOL in its header (`CRLF`/`CR`/`LF`).
- `write_file` and `replace_in_file` preserve the **existing** file's EOL
  (converting content to match); never flip a CRLF file to LF.
- Use `read_file` output **verbatim** as `replace_in_file` `oldText`. Matching is
  done on LF, so CRLF-on-disk never breaks a match.
- Most source files in this repo are **CRLF** — `.gitignore` and
  `src/tools/shell.ts` included. Under `src/` exactly these five are **LF**:
  `src/tools/index.ts`, `src/chat/ChatPanel.ts`, `src/chat/SessionsProvider.ts`,
  `src/chat/SubAgentPool.ts`, `src/chat/panels.ts` (a few docs pages and the
  vendored `media/vendor/**` bundles are LF too, so read the header instead of
  trusting a list).

