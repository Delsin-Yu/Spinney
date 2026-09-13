# Vendored: non-layered-tidy-tree-layout@2.0.2

**PINNED. DO NOT UPDATE, DO NOT REPLACE, DO NOT `npm install`.**

This directory is a byte-exact copy of files from the published npm tarball. It is
**not** an npm dependency: there is no entry in `package.json`, nothing is fetched at
build time, and no install/postinstall script ever runs. The tree layout engine is
frozen at this version by design — a new version would need a new supply-chain audit
(see `docs/agents/invariants/vendored-deps.md`).

| | |
|---|---|
| Package | `non-layered-tidy-tree-layout` |
| Version | `2.0.2` (latest; published 2019-10-17) |
| License | MIT (`LICENSE`, `Copyright (c) 2019 Michael Wong`) |
| Upstream | https://github.com/stetrevor/non-layered-tidy-tree-layout (tag `v2.0.2`) |
| Tarball | https://registry.npmjs.org/non-layered-tidy-tree-layout/-/non-layered-tidy-tree-layout-2.0.2.tgz |
| Tarball integrity | `sha512-gkXMxRzUH+PB0ax9dUN0yYF0S25BqeAYqhgMaLUFmpXLEk7Fcu8f4emJuOAY0V8kjDICxROIKsTAKsV/v355xw==` |
| Runtime deps | **none** (devDependencies only) |
| Lifecycle scripts | **none** (`build`, `test` only) |
| Vendored on | 2026-09-10 |

## Files (sha256, byte-exact from the tarball)

| File | sha256 | Bytes |
|---|---|---|
| `dist/non-layered-tidy-tree-layout.js` | `66562202bd0b7b456439d127fea7208887e713ba1aa82208b21ac0c60a86e3e1` | 5599 |
| `src/index.js` | `27befdfc33e387d3d0e0260292be51145dbb0d79025a07688a8aec932007d112` | 152 |
| `src/algorithm.js` | `c2ec0ef1a36b6ef35d20e2d94637967d205a8afc78947d54807e77495f7294d4` | 5482 |
| `src/helpers.js` | `e00183b0c1b8f9c84f55ebd9bb7cdc77c3a476bd102b4efb9583064f6b761345` | 3491 |
| `LICENSE` | (MIT, from the same tarball) | 1070 |

`src/` is kept only so the minified `dist/` bundle can be re-audited without network
access: `dist/` is a webpack build of exactly `src/algorithm.js` + `src/helpers.js`.
All four vendored code files were verified **byte-identical to GitHub tag `v2.0.2`**
(`cmp` against `codeload.github.com/.../tar.gz/refs/tags/v2.0.2`), which is stronger
evidence than npm provenance — this package has no provenance attestation.

## How it is used

`media/tree.js` loads it as a plain nonce'd `<script>` (see
`src/chat/ChatViewProvider.ts`) and calls:

```js
const { Layout, BoundingBox } = window.nonLayeredTidyTreeLayout;
const layout = new Layout(new BoundingBox(hGap, vGap));   // global gaps, scalars
const { result, boundingBox } = layout.layout({ id, width, height, children: [...] });
```

Semantics that matter (verified against `src/`, not the README — the README's numbers
are inconsistent):

- Each node's box is `(width + hGap) × (height + vGap)`; the card's top-left is
  `boxLeft + hGap/2`, children start at `parent.y + height + vGap`.
- Returned `x`/`y` are the card's **top-left** (already un-boxed), `y` downward.
- Input tree is **mutated** in place; sibling order is preserved (deterministic).
- Browser-only UMD: the factory is invoked with a bare `window` reference, so it
  throws `ReferenceError: window is not defined` under Node without a shim.

## Audit record

Audited 2026-09-10; this file is the surviving record of that audit (the pre-vendoring
working notes were removed from the repository when it went open source). Summary:
single maintainer `stetrevor` (GitHub owner matches the npm publisher), 4 versions all
published in October 2019, no ownership change, no install scripts, no `eval`/`Function`/
`child_process`/network access, zero runtime dependencies, MIT SPDX match, tarball
integrity matches the registry, `dist` + `src` byte-identical to tag `v2.0.2`, no
typosquat of the name exists on npm, OSV reports no advisories. Residual risk is the
usual one for a dormant single-maintainer package — neutralised here by pinning and
vendoring: this copy is never resolved from the registry again.
