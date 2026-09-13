# Vendored: markdown-it@14.3.1

**PINNED. DO NOT UPDATE, DO NOT REPLACE, DO NOT `npm install`.**

This directory is a byte-exact copy of the browser bundle from the published npm
tarball. It is **not** a runtime dependency: there is no entry for it in
`package.json`, nothing is fetched at build time, and no install/postinstall script
ever runs. (A same-named package does appear in `package-lock.json` as a transitive
dev dependency of `@vscode/vsce` — build-time only, never shipped; see
`docs/agents/invariants/vendored-deps.md`.) The renderer is frozen at this version by
design — a new version would need a new supply-chain audit.

| | |
|---|---|
| Package | `markdown-it` |
| Version | `14.3.1` (published 2026-08-27; a later patch `14.3.2` exists — do not auto-update) |
| License | MIT (`LICENSE`, `Copyright (c) 2014 Vitaly Puzrin, Alex Kocharin`) |
| Upstream | https://github.com/markdown-it/markdown-it |
| Tarball | https://registry.npmjs.org/markdown-it/-/markdown-it-14.3.1.tgz |
| Tarball integrity | `sha512-4Ej49aYTDFIQ+uBkfX8GBvJGccoARxxPep+7aWTs55ozbjQJpW9M26Fe53vnGgvLeVzva/amzjQQaQu9w0vMhA==` |
| Tarball sha256 | `3b967ceb626e0bccb90d1095ffed543182615797076dcffbb381f923634fdf1f` |
| Runtime deps | `mdurl`, `uc.micro`, `linkify-it`, `punycode.js`, `entities` — all **inlined** in the bundle (see below); `argparse` is CLI-only and absent |
| Lifecycle scripts | **none for consumers** (`prepack` = `npm test && npm run build` at publish time; no install/postinstall) |
| Vendored on | 2026-09-13 |

## Files (sha256, byte-exact from the tarball)

| File | sha256 | Bytes |
|---|---|---|
| `markdown-it.min.js` | `b1d56e32cbc489aac37dfe76136c5040840eb7af693785ba3a83310c2b4f4999` | 125205 |
| `LICENSE` | `b290523eedb5b909a5655dc15de3148f2a2f263b2f890877db00d925a599c456` | 1078 |

`markdown-it.min.js` is byte-identical to `dist/markdown-it.min.js` in the tarball
(`cmp`, 125205 bytes, sha256 above). It is the UMD bundle — a `/*! markdown-it 14.3.1 …
@license MIT */` banner line, then one long minified line — followed by a
`//# sourceMappingURL=markdown-it.min.js.map` comment. The map itself is **not**
vendored: it is large, it is unused at runtime, and devtools simply fail to resolve it
(`.vscodeignore` strips `**/*.map` anyway).

`LICENSE` is the upstream MIT text, byte-for-byte, including its copyright line
(`Copyright (c) 2014 Vitaly Puzrin, Alex Kocharin.`).

## Why vendored

- `markdown-it` is the Markdown renderer of the chat webview. The webview is a plain,
  nonce'd `<script>` environment and this repo has no bundler step for `media/`, so a
  prebuilt minified browser bundle is the only practical delivery vehicle — and the
  `.vsix` has to stay self-contained, offline and reproducible.
- Before this move the file lived at `media/markdown-it.min.js`, i.e. **outside** the
  `media/vendor/** -text` rule in `.gitattributes`: a Windows checkout rewrote its
  banner line ending to CRLF and the file drifted to 125207 bytes
  (`sha256 97770f5c3af2b5aa6010fe21915020354fd1d9bb26eed1ba1c5ab73c5edaa324`; upstream
  is 125205 bytes / `sha256 b1d56e32…f4999`). Moving it under `media/vendor/` restores
  the published bytes and puts it under the same "byte-exact, hash-recorded" rule as
  the layout engine. The `-text` attribute is what keeps a fresh clone byte-exact.

## Third-party code inlined in this bundle

`dist/markdown-it.min.js` statically bundles these packages (verified against the
`dist/markdown-it.min.js.map` `sources` list and by comparing the embedded entity
decode tree against the published `entities` tarballs):

| Package | Range | In bundle | License / copyright |
|---|---|---|---|
| `linkify-it` | `^5.0.2` | yes | MIT — `Copyright (c) 2015 Vitaly Puzrin` |
| `mdurl` | `^2.0.0` | yes | MIT — `Copyright (c) 2015 Vitaly Puzrin` |
| `uc.micro` | `^2.1.0` | yes | MIT — `Copyright (c) 2015 Vitaly Puzrin` |
| `punycode.js` | `^2.3.1` | yes | MIT — `Copyright (c) 2014 Mathias Bynens` |
| `entities` | `^4.5.0` | yes (entity decode tables) | BSD-2-Clause — `Copyright (c) Felix Böhm` |

`argparse` (CLI only) and `entities`' `encode` half are not in the bundle. The bundle's
banner credits only `markdown-it` itself, so the notices for the five inlined packages
are reproduced in the root `THIRD_PARTY_NOTICES.md`, next to `markdown-it`'s own
attribution in `media/vendor/markdown-it/LICENSE`.

## Verification (no network access needed once the tarball is fetched)

```sh
curl -sS -o /tmp/mdit.tgz https://registry.npmjs.org/markdown-it/-/markdown-it-14.3.1.tgz
sha256sum /tmp/mdit.tgz          # → 3b967ceb…634fdf1f (Tarball sha256 above)
# registry `dist.integrity` (base64 sha512 of the tarball):
openssl dgst -sha512 -binary /tmp/mdit.tgz | base64 | tr -d '\n'
# → 4Ej49aYTDFIQ+uBkfX8GBvJGccoARxxPep+7aWTs55ozbjQJpW9M26Fe53vnGgvLeVzva/amzjQQaQu9w0vMhA==
tar -xzOf /tmp/mdit.tgz package/dist/markdown-it.min.js \
  | cmp - media/vendor/markdown-it/markdown-it.min.js    # → identical
```

The bundle stays `eval`/`Function`-free, so the webview CSP needs no `'unsafe-eval'`:

```sh
grep -c "eval(\|new Function" media/vendor/markdown-it/markdown-it.min.js   # → 0
```
