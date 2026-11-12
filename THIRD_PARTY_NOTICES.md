# Third-Party Notices

Spinney (the `spinney` VS Code extension) is licensed under the MIT License — see
`LICENSE`. The published extension (`.vsix`) additionally redistributes the three
third-party assets listed below. All are vendored: byte-exact copies of published
artifacts (two npm tarballs and, for ripgrep, the official release binaries), pinned
at a fixed version, with the archive integrity and the per-file sha256 recorded next to
them. Nothing is resolved from the npm registry or the network at install, build or
package time.

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

---

No other third-party code is redistributed in the extension package. The three bundled
`LICENSE`/`PROVENANCE` records carry the full MIT text for `markdown-it`, for
`non-layered-tidy-tree-layout` and for `ripgrep`; the attributions for the five
libraries inlined in the Markdown bundle (all MIT, except `entities`) are listed above.
