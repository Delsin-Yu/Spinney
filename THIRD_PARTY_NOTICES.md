# Third-Party Notices

Spinney (the `spinney` VS Code extension) is licensed under the MIT License — see
`LICENSE`. The published extension (`.vsix`) additionally redistributes the seven
third-party assets listed below. All are vendored: byte-exact copies of published
artifacts (npm tarballs, grammar files from two pinned repositories, the official ripgrep
release binaries, and one generated data table), pinned at a fixed version, with the
archive integrity and the per-file sha256 recorded next to them. Nothing is resolved from
the npm registry or the network at install, build or package time.

## 1. markdown-it 14.3.1

Markdown renderer used by the chat webview.

- Package: `markdown-it`, version `14.3.1`
- License: MIT — `Copyright (c) 2014 Vitaly Puzrin, Alex Kocharin`
- Upstream: https://github.com/markdown-it/markdown-it
- License text: [`media/vendor/markdown-it/LICENSE`](media/vendor/markdown-it/LICENSE)
- Shipped file: `media/vendor/markdown-it/markdown-it.min.js`
- Pin record: [`media/vendor/markdown-it/PROVENANCE.md`](media/vendor/markdown-it/PROVENANCE.md)

The minified bundle statically inlines five more libraries. They are not separate files
in this repository, so their attributions are reproduced here:

| Inlined package | License | Copyright |
|---|---|---|
| `linkify-it` `^5.0.2` | MIT | `Copyright (c) 2015 Vitaly Puzrin` |
| `mdurl` `^2.0.0` | MIT | `Copyright (c) 2015 Vitaly Puzrin` |
| `uc.micro` `^2.1.0` | MIT | `Copyright (c) 2015 Vitaly Puzrin` |
| `punycode.js` `^2.3.1` | MIT | `Copyright (c) 2014 Mathias Bynens` |
| `entities` `^4.5.0` | BSD-2-Clause | `Copyright (c) Felix Böhm` |

Upstreams: https://github.com/markdown-it/linkify-it ·
https://github.com/markdown-it/mdurl · https://github.com/markdown-it/uc.micro ·
https://github.com/mathiasbynens/punycode.js · https://github.com/fb55/entities

## 2. non-layered-tidy-tree-layout 2.0.2

Tidy-tree layout engine for the chat tree canvas.

- Package: `non-layered-tidy-tree-layout`, version `2.0.2`
- License: MIT — `Copyright (c) 2019 Michael Wong`
- Upstream: https://github.com/stetrevor/non-layered-tidy-tree-layout
- License text: [`media/vendor/non-layered-tidy-tree-layout/LICENSE`](media/vendor/non-layered-tidy-tree-layout/LICENSE)
- Shipped file: `media/vendor/non-layered-tidy-tree-layout/dist/non-layered-tidy-tree-layout.js`
- Pin record: [`media/vendor/non-layered-tidy-tree-layout/PROVENANCE.md`](media/vendor/non-layered-tidy-tree-layout/PROVENANCE.md)

## 3. ripgrep 14.1.1

The `rg` binary `search_files` runs in a child process, vendored per
platform-architecture so a search never depends on what the host happens to bundle.
It is the unmodified executable from the official release archive; nothing else from
the archives ships.

- Upstream: https://github.com/BurntSushi/ripgrep — release `14.1.1`
- License: MIT (the project is dual-licensed `Unlicense OR MIT`); the MIT text is
  reproduced in the pin record below
- Copyright: `Copyright (c) 2015 Andrew Gallant`
- Shipped files: `media/vendor/ripgrep/win32-x64/rg.exe`,
  `media/vendor/ripgrep/linux-x64/rg`, `media/vendor/ripgrep/linux-arm64/rg`,
  `media/vendor/ripgrep/darwin-x64/rg`, `media/vendor/ripgrep/darwin-arm64/rg`
- Pin record: [`media/vendor/ripgrep/PROVENANCE.md`](media/vendor/ripgrep/PROVENANCE.md)
  — the release URL, the archive sha256, the extracted binary's sha256 and size, the
  MIT text, and the two artifacts that 14.1.1 does not publish (`win32-arm64`, and a
  musl build for `linux-arm64`), with why each falls through to the host's own `rg`.

PCRE2 (`BSD-3-Clause`) is statically linked inside the x86_64 Windows build, which is
compiled with ripgrep's `pcre2` feature; no other third-party code is added by these
binaries, and nothing is loaded at runtime.

## 4. vscode-textmate 9.3.2

The TextMate tokenizer behind the chat's code colouring. It runs in the extension host,
never in the webview (`src/chat/codeHighlight.ts`).

- Package: `vscode-textmate`, version `9.3.2`
- License: MIT — `Copyright (c) Microsoft Corporation`
- Upstream: https://github.com/microsoft/vscode-textmate
- License text: [`media/vendor/vscode-textmate/LICENSE.md`](media/vendor/vscode-textmate/LICENSE.md)
- Shipped file: `media/vendor/vscode-textmate/release/main.js`
- Pin record: [`media/vendor/vscode-textmate/PROVENANCE.md`](media/vendor/vscode-textmate/PROVENANCE.md)

## 5. vscode-oniguruma 2.0.1

The regex engine `vscode-textmate` needs, as a WebAssembly module plus a loader. Also
host-side only.

- Package: `vscode-oniguruma`, version `2.0.1`
- License: MIT — `Copyright (c) Microsoft Corporation`
- Upstream: https://github.com/microsoft/vscode-oniguruma
- License text: [`media/vendor/vscode-oniguruma/LICENSE.txt`](media/vendor/vscode-oniguruma/LICENSE.txt)
- Shipped files: `media/vendor/vscode-oniguruma/release/main.js`,
  `media/vendor/vscode-oniguruma/release/onig.wasm`
- Pin record: [`media/vendor/vscode-oniguruma/PROVENANCE.md`](media/vendor/vscode-oniguruma/PROVENANCE.md)

The WebAssembly module is a build of **oniguruma** `v6.9.5_rev1`, which is separately
licensed:

- License: BSD-2-Clause — `Copyright (c) 2002-2023 K.Kosako`
- Upstream: https://github.com/kkos/oniguruma
- License text: [`media/vendor/vscode-oniguruma/NOTICES.txt`](media/vendor/vscode-oniguruma/NOTICES.txt)

## 6. TextMate grammars (96 files)

The grammars that colour fenced code blocks, from two upstreams: everything the
built-in language extensions of `microsoft/vscode` @ `1.146.0` ship (84 files), and the
twelve languages VS Code does not ship, taken from `tm-grammars` `1.32.22`
(shikijs/textmate-grammars-themes, MIT collection). Licences are per file and are
recorded verbatim in the two notices shipped beside the grammars:

- `media/vendor/textmate-grammars/vscode-ThirdPartyNotices.txt` — the upstream
  `ThirdPartyNotices.txt` of `microsoft/vscode` `1.146.0`, verbatim. Only the grammar
  files are redistributed from that repository, and this is their authoritative notice.
- `media/vendor/textmate-grammars/tm-grammars-NOTICE.txt` — tm-grammars' own notice,
  verbatim, listing each of the twelve files' upstream, SPDX id and full licence text
  (MIT, Apache-2.0, and MPL-2.0 for `terraform`).
- `media/vendor/textmate-grammars/tm-grammars-LICENSE.txt` — that collection's MIT text.
- Index and per-file sha256: [`media/vendor/textmate-grammars/PROVENANCE.md`](media/vendor/textmate-grammars/PROVENANCE.md),
  `media/vendor/textmate-grammars/SHA256SUMS`.

## 7. pinyin-data pinyin.txt (version 0.16.0)

The Unicode → tone-less pinyin table behind the `@` picker's CJK matching, read by
`src/chat/pinyin.ts`. The shipped file is a **derived** table, not the upstream file as
published: the converter keeps the first (canonical) reading of every character in three
CJK ranges only, folds it to the spelling a Chinese IME accepts, sorts by code point and
emits two parallel strings. It is data, not code — nothing in it is executed. No npm
package is involved: the source is a plain text file in a GitHub repository.

- Upstream: https://github.com/mozillazg/pinyin-data — `pinyin.txt`, whose own header
  reads `# version: 0.16.0`
- Source file: https://raw.githubusercontent.com/mozillazg/pinyin-data/master/pinyin.txt
  — 985 559 bytes, sha256
  `2342a6f98c85dbc3c8d26aef31744876a36326c6466e51e9a0f16898c36c2011`, fetched 2026-11-19
- License: MIT — `Copyright (c) 2016 mozillazg`
- License text: reproduced at the end of
  [`media/vendor/pinyin/PROVENANCE.md`](media/vendor/pinyin/PROVENANCE.md) (the MIT notice
  travels with the data; no separate `LICENSE` file ships for this asset). Upstream copy:
  https://github.com/mozillazg/pinyin-data/blob/master/LICENSE
- Shipped file: `media/vendor/pinyin/pinyin.json` — 189 257 bytes, sha256
  `6c6e16a96d4fe5526d4bd21220f1d1eb26bc89bef3af8c0acb52eb5f47fefbb6`, 26 713 entries
- Pin record: [`media/vendor/pinyin/PROVENANCE.md`](media/vendor/pinyin/PROVENANCE.md)
  — the exact source URL, the five filtering/normalisation steps, the counts they produce,
  and the converter script (`build-pinyin.js`) reproduced verbatim, which is the only way
  the file may be regenerated.

No other third-party code is redistributed in the extension package. The seven bundled
`LICENSE`/`PROVENANCE` records carry the full MIT text for `markdown-it`, for
`non-layered-tidy-tree-layout`, for `ripgrep`, for `vscode-textmate`, for
`vscode-oniguruma` and for the pinyin data, plus oniguruma's BSD-2 text and the two
grammar notices; the attributions for the five libraries inlined in the Markdown bundle
(all MIT, except `entities`) are listed above.
