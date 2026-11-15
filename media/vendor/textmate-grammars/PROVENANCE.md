# Vendored: TextMate grammars (96 files, two upstreams)

**PINNED. DO NOT UPDATE, DO NOT ADD A GRAMMAR BY HAND.**

The grammars that colour fenced code blocks, resolved through `index.json` by
`src/chat/codeHighlight.ts` in the extension host. They are byte-exact copies of
published files; `SHA256SUMS` records every one, and `tools/vendor-grammars.mjs`
regenerates `index.json` from them (it is the only thing here this repository wrote
besides the index).

**Two upstreams, on purpose:**

| Upstream | Files | Bytes | Why |
|---|---|---|---|
| `microsoft/vscode` @ **1.146.0** | 84 (under `vscode/`) | ~6.9 MB | everything the editor's own built-in language extensions ship, so the `include` closure is complete: `cpp` finds `c`, `html` finds `css` and `js`, `php` finds `html`, `markdown` finds its embedded languages |
| `tm-grammars@1.32.22` (shikijs/textmate-grammars-themes) | 12 (under `tm-grammars/`) | ~328 KB | the languages VS Code does **not** ship: `diff`, `toml`, `kotlin`, `scala`, `haskell`, `elixir`, `graphql`, `proto`, `terraform`, `hcl`, `cmake`, `nginx` |

The split is the whole point: one upstream covers 83 language ids without a single
missing embed, and the twelve files that are not in it come from one tarball whose
`NOTICE` already records each file's upstream commit, SPDX id and full license text.

## Licence record

- `vscode-ThirdPartyNotices.txt` — the upstream `ThirdPartyNotices.txt` of
  `microsoft/vscode` @ 1.146.0, verbatim (`sha256
  4cb210d0c8f8fa304b37a31d44436ebf86dff59466a4033fbcd0c401d63c6568`). Only the grammar
  files are redistributed from that repository; this file is the authoritative notice
  for them, in place of hand-picking ~84 license lines.
- `tm-grammars-NOTICE.txt` — tm-grammars' own `NOTICE`, verbatim (`sha256
  26b10bb42960080d6dfabcd1d4f2ae69a5bf104b30fea399c646f598551e7519`), listing each of
  the twelve files' upstream and licence (MIT, Apache-2.0, and MPL-2.0 for `terraform`).
- `tm-grammars-LICENSE.txt` — that collection's MIT text (`sha256
  7a9d8d01038aeacf9e5bcdabbddf2a7815200dce9fc1118468cc553e00ae3eee`).

Both upstreams' notices ship inside the `.vsix` because both sets of files do.

## `index.json` (generated, not vendored)

```json
{ "version": 1, "sources": { … }, "scopes": { "<scopeName>": "<file>" },
  "languages": { "<language id>": "<scopeName>" },
  "aliases": { "<alias>": "<language id>" },
  "extensions": { "<file extension, no dot>": "<language id>" } }
```

- `scopes` is the grammar a scope name resolves to. A duplicate declaration (VS Code
  ships `source.yaml` and `source.diff` twice, `prompt-basics` declares three scopes for
  one file) keeps the first, in the order the extensions were listed.
- `languages` picks the **primary** grammar for an id by shape, not by file order —
  `cpp` declares `source.cpp`, `source.cpp.cuda` and `source.cpp.embedded.macro`, and the
  first would otherwise have been the embedded one.
- `aliases` come from `contributes.languages[].aliases`; `extensions` from
  `contributes.languages[].extensions`, because what a model writes in a fence is very
  often a file extension (`yml`, `cc`, `h`, `kt`, `md`, `tf`, `ps1`) and never an alias.

A fence word is resolved `languages` → `aliases` → `extensions`; anything left
unresolved renders as plain text, which is the intended behaviour and not a bug.

## Files that are still plist

One of the 84 vscode files (`javascript/syntaxes/Regular Expressions
(JavaScript).tmLanguage`) is XML, not JSON. `parseRawGrammar` sniffs that by extension,
which is why the loader passes the real file name instead of an invented `.json` one.
`SHA256SUMS` is generated with `find -print0`, so the spaces in that name survive.

## Regenerating (only with the developer's decision, and a new pin record)

```sh
npm pack vscode-textmate@9.3.2 vscode-oniguruma@2.0.1 tm-grammars@1.32.22
tar -xzf tm-grammars-1.32.22.tgz
node tools/vendor-grammars.mjs --vscode <vscode tag> --shiki <extracted>/package
```

Then re-run `npm run check:highlight` (it fails if the index points at a missing file,
if a promised language stops resolving, or if a bundle stops being eval-free).
