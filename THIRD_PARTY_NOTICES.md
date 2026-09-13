# Third-Party Notices

Spinney (the `spinney` VS Code extension) is licensed under the MIT License — see
`LICENSE`. The published extension (`.vsix`) additionally redistributes the two
third-party browser bundles listed below. Both are vendored: byte-exact copies of
published npm tarballs, pinned at a fixed version, with the tarball integrity and the
per-file sha256 recorded next to them. Nothing is resolved from the npm registry at
install, build or package time.

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

---

No other third-party code is redistributed in the extension package. The two bundled
`LICENSE` files carry the full MIT text for `markdown-it` and for
`non-layered-tidy-tree-layout`; the attributions for the five libraries inlined in the
Markdown bundle (all MIT, except `entities`) are listed above.
