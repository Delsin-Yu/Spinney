## Line endings
- `read_file` always returns **LF**-normalized content (the canonical form for
  the model) and reports the on-disk EOL in its header (`CRLF`/`CR`/`LF`).
- `write_file` and `replace_in_file` preserve the **existing** file's EOL
  (converting content to match); never flip a CRLF file to LF.
- Use `read_file` output **verbatim** as `replace_in_file` `oldText`. Matching is
  done on LF, so CRLF-on-disk never breaks a match.
- Most source files in this repo are **CRLF**; `src/tools/shell.ts` and
  `.gitignore` are **LF**.

