# Vendored: vscode-oniguruma@2.0.1

**PINNED. DO NOT UPDATE, DO NOT REPLACE, DO NOT `npm install`.**

The regex engine behind `vscode-textmate`: a compiled oniguruma as WebAssembly plus a
thin loader. Loaded by the **extension host** (Node) from
`src/chat/codeHighlight.ts` — never by the webview, so no CSP token is involved. Not a
runtime dependency: no `package.json` entry, nothing resolved from npm.

| | |
|---|---|
| Package | `vscode-oniguruma` |
| Version | `2.0.1` |
| License | MIT (`LICENSE.txt`, `Copyright (c) Microsoft Corporation`); the compiled engine inside the wasm is oniguruma, **BSD-2-Clause**, `Copyright (c) 2002-2023 K.Kosako` — see `NOTICES.txt` and the third-party notice in the root `THIRD_PARTY_NOTICES.md` |
| Upstream | https://github.com/microsoft/vscode-oniguruma (wasm built from https://github.com/kkos/oniguruma, tag `v6.9.5_rev1`) |
| Tarball | https://registry.npmjs.org/vscode-oniguruma/-/vscode-oniguruma-2.0.1.tgz |
| Tarball integrity | `sha512-poJU8iHIWnC3vgphJnrLZyI3YdqRlR27xzqDmpPXYzA93R4Gk8z7T6oqDzDoHjoikA2aS82crdXFkjELCdJsjQ==` |
| Tarball sha256 | `3b42911fd9609f2cc3b9c6dd52236b3da73780e633aa7dc381267006b7e7da21` |
| Runtime deps | **none** |
| Lifecycle scripts | **none** (`prepublishOnly` builds at publish time; `package` copies the wasm — nothing runs on install) |
| Vendored on | 2026-11-15 |

## Files

| File | sha256 | Bytes |
|---|---|---|
| `release/main.js` | `d49f2bfcbffca8732aac82fb84db5aab2521bcf0acb612f27454dc75cab85b82` | 20469 |
| `release/onig.wasm` | `76ebc1f0d87b2e7449a45ff3cd1a1546a9f05f54bdac44ee03e8a2b8348897be` | 473151 |
| `LICENSE.txt` | `ddde8aba8fe72b4830e27901fc78733eb6db7b6c653161075de213a6adeda3fd` | — |
| `NOTICES.txt` | `615d94d89eacc046241518c247f6650a5df80d1adf4b284a756f500867620b35` | — |

`onig.wasm` is under `media/vendor/**`, which `.gitattributes` marks `-text`, so a
Windows checkout cannot rewrite it. Do not add it to git with autocrlf on.

## How the host loads it

```ts
oniguruma.loadWASM({ data: fs.readFileSync('<ext>/media/vendor/vscode-oniguruma/release/onig.wasm') });
```

Node compiles the module from bytes; nothing is fetched over the network and the
extension keeps working offline. The compile is ~13 ms on the machine this was vendored
on, paid once per window at activation (`ChatViewProvider` constructor calls
`warmUpCodeHighlight`).

## Verification

```sh
npm pack vscode-oniguruma@2.0.1
sha256sum vscode-oniguruma-2.0.1.tgz     # → 3b42911f…e7da21
tar -xzOf vscode-oniguruma-2.0.1.tgz package/release/onig.wasm \
  | cmp - media/vendor/vscode-oniguruma/release/onig.wasm        # → identical
grep -c "eval(\|new Function" media/vendor/vscode-oniguruma/release/main.js   # → 0
```

`npm run check:highlight` loads the wasm and tokenizes real code, so a corrupt or
swapped module fails packaging.
