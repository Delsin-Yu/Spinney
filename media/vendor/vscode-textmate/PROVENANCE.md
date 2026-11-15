# Vendored: vscode-textmate@9.3.2

**PINNED. DO NOT UPDATE, DO NOT REPLACE, DO NOT `npm install`.**

The TextMate tokenizer VS Code itself uses, loaded by the **extension host** (Node) and
never by the webview: `src/chat/codeHighlight.ts` requires it from this directory. It is
**not** a runtime dependency — no entry in `package.json`, nothing fetched at build
time, no install script. Frozen by design: a new version would need a new supply-chain
audit.

| | |
|---|---|
| Package | `vscode-textmate` |
| Version | `9.3.2` |
| License | MIT (`LICENSE.md`, `Copyright (c) Microsoft Corporation`) |
| Upstream | https://github.com/microsoft/vscode-textmate |
| Tarball | https://registry.npmjs.org/vscode-textmate/-/vscode-textmate-9.3.2.tgz |
| Tarball integrity | `sha512-n2uGbUcrjhUEBH16uGA0TvUfhWwliFZ1e3+pTjrkim1Mt7ydB41lV08aUvsi70OlzDWp6X7Bx3w/x3fAXIsN0Q==` |
| Tarball sha256 | `f7c742b16d59600d77529b7a904af09b59dfddb0f046fc045340004ae2fc50e7` |
| Runtime deps | **none** (the tarball has no `dependencies`) |
| Lifecycle scripts | **none** (`prepublishOnly` builds at publish time; nothing runs on install) |
| Vendored on | 2026-11-15 |

## Files

| File | sha256 | Bytes |
|---|---|---|
| `release/main.js` | `9da91ca33178e8d68ac5b9ea5733258275fe2f1924db02930ef9cf7e0d850e0f` | 61242 |
| `LICENSE.md` | `b5cb7ff7859e7d282d98fc43ab081b0dda5dc659dc3385cf65740c759a7e6a6c` | — |

Only `release/main.js` ships. The tarball's `types/`, `README.md` and `package.json`
are not vendored (the types live in the pin record, not in the package), because
`media/vendor/**` is payload, not paperwork.

## Why the engine runs in the host

The colouring engine needs oniguruma, a WebAssembly module. A webview compiles wasm only
with `'wasm-unsafe-eval'` in its CSP, which `src/chat/webviewShell.ts` deliberately does
not have (see `docs/agents/invariants/vendored-deps.md`, rule 5). The extension host has
no CSP: Node compiles the wasm, `tokenizeLine` is synchronous, and the webview only
receives finished, escaped HTML. That is also why **no CSP change is needed** for this
asset — it is never loaded by the webview.

## Verification (once the tarball is fetched)

```sh
npm pack vscode-textmate@9.3.2            # → vscode-textmate-9.3.2.tgz
sha256sum vscode-textmate-9.3.2.tgz      # → f7c742b1…fc50e7
openssl dgst -sha512 -binary vscode-textmate-9.3.2.tgz | base64 | tr -d '\n'
# → n2uGbUcrjhUEBH16uGA0TvUfhWwliFZ1e3+pTjrkim1Mt7ydB41lV08aUvsi70OlzDWp6X7Bx3w/x3fAXIsN0Q==
tar -xzOf vscode-textmate-9.3.2.tgz package/release/main.js \
  | cmp - media/vendor/vscode-textmate/release/main.js      # → identical
grep -c "eval(\|new Function" media/vendor/vscode-textmate/release/main.js   # → 0
```

`npm run check:highlight` re-checks the eval-free property and loads the bundle the way
the host does, so a broken pin fails packaging.
