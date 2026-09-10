# Supply-Chain Audit — JS Layout Packages (vendor & pin candidate set)

- **Date (UTC):** 2026-09-09
- **Auditor:** agentHarness sub-agent (research-only; nothing outside `.agent-harness/research/audit/` was touched)
- **Scope:** `d3-flextree@2.1.2`, `@dagrejs/dagre@3.1.1`, `d3-dag@1.2.2` (latest as of date)
- **Method:** npm registry JSON API (`registry.npmjs.org`), `npm pack` tarball inspection, GitHub REST + raw/codeload source tarballs, OSV API, npm audit, source↔dist byte diffs. `www.npmjs.com` is 403; registry API only.
- **Env:** Node v24.18.1 / npm 11.16.0; VPN on; `bun` NOT available (matters for d3-dag rebuild).

Reproduce everything from this directory:

```bash
mkdir -p .agent-harness/research/audit/tarballs
cd .agent-harness/research/audit/tmp
npm pack d3-flextree@2.1.2 --pack-destination ../tarballs
npm pack @dagrejs/dagre@3.1.1 --pack-destination ../tarballs
npm pack d3-dag@1.2.2 --pack-destination ../tarballs
# metadata
curl -s https://registry.npmjs.org/d3-flextree
curl -s https://registry.npmjs.org/@dagrejs%2fdagre
curl -s https://registry.npmjs.org/d3-dag
# source
curl -sL https://codeload.github.com/dagrejs/dagre/tar.gz/refs/tags/v3.1.1
curl -sL https://codeload.github.com/erikbrinkman/d3-dag/tar.gz/refs/tags/v1.2.2
curl -sL https://codeload.github.com/Klortho/d3-flextree/tar.gz/refs/heads/master
# vulns
curl -s -X POST -d @osv.json https://api.osv.dev/v1/querybatch
```

---

## Verdict table

| # | Package | Pinned | Verdict | Headline reason |
|---|---------|--------|---------|-----------------|
| 1 | `d3-flextree` | 2.1.2 | **SAFE-WITH-CAVEATS** | No tag for 2.1.2; dormant since 2021; extra npm maintainer w/ publish rights never contributed; `prepare` script |
| 2 | `@dagrejs/dagre` | 3.1.1 | **SAFE-WITH-CAVEATS** | 78/78 dist files byte-identical to tag `v3.1.1`, but no npm provenance + old `dagre`/`dagrejs` name confusion + reused GitHub username |
| 3 | `d3-dag` | 1.2.2 | **SAFE** | SLSA provenance from GitHub Actions OIDC, single maintainer, clean source; caveat: minified-only dist |

---

## 1) `d3-flextree` — 2.1.2 — **SAFE-WITH-CAVEATS**

### (a) Version & history
- Latest **2.1.2**, published **2021-11-08T22:54:06Z**; `dist-tags.latest = 2.1.2` (single tag).
- 6 versions total, no unpublished/removed versions, no deprecated versions:
  `1.0.3` 2016-05-31 → `1.4.0` 2018-03-27 → `2.0.0` 2018-04-05 → `2.1.0` 2018-04-16 → `2.1.1` 2018-04-16 → `2.1.2` 2021-11-08.
- **Anomaly:** 3.5-year gap between 2.1.1 and 2.1.2; the package has been dormant ~4.8 years since. All versions published by `klortho`. No ownership change, no republished old versions.
- **No git tag for 2.1.2** — highest tag in repo is `2.0.0`. Master HEAD is commit `af196220927218bbe7ac6cad8e059f56430befb6` "bump version", 2021-11-08T22:53:39Z — **27 s before the npm publish**.

### (b) Maintainers / 2FA / provenance
- npm maintainers: **`klortho`** (Chris Maloney, `voldrani@gmail.com`, repo owner) **and `sidyes`** (Stefan Herpich, `kontakt@simpel-web.de`).
  - GitHub `Klortho` id 77226, created **2009-04-24**, 194 public repos → established.
  - GitHub `sidyes` id created **2015-03-25**, 11 repos.
  - **Caveat:** `sidyes` has **zero commits/contributions** to `Klortho/d3-flextree` (contributors: Klortho 101, avs-doom 1) yet holds **publish rights** on npm. Unexplained co-maintainer.
- npm account creation age not retrievable: `GET /-/user/org.couchdb.user:<name>` → **HTTP 401** (auth required). Proxy: `klortho`'s oldest package created 2016-01-27.
- **No npm provenance / no `dist.attestations`.** Only the legacy registry `npm-signature` (npm's old registry PGP key), no per-publisher attestation.
- GitHub repo owner `Klortho` **matches** npm publisher `klortho` ✅.

### (c) Tarball contents
- 35 files, unpacked 703 779 B. Ships `src/`, `demo/`, `test/`, `build/` (no `files` field).
- Lifecycle scripts in shipped `package.json`: **`prepare` = `npm-run-all clean build lint test`** (no pre/install/postinstall). `prepare` runs on git/local (`file:`) installs — see vendor note.
- Static scan (runtime JS, excluding `.map`): no `eval(`, no `new Function`, no `child_process`, no `net/http/https`, no `fetch`/`XMLHttpRequest`, no base64 blobs >200 chars.
  - `process.env` only in `rollup.config.js` (build-time `process.env.BUILD`).
  - `.exec(` only in `demo/bundle.js` (d3 demo bundle) — regex use.
  - `Function(` only in `demo/bundle.js` (bundled d3/rollup runtime).
  - URLs: project/author homepages + W3C/SVG namespaces only.
- Unicode: only smart-quotes in comments (`build/d3-flextree.js`, `demo/bundle.js`); no homoglyphs.
- `demo/bundle.js` is a demo artifact that should NOT be vendored (large, includes d3).

### (d) Dependency tree (transitive) + licenses
- `d3-flextree@2.1.2` → `d3-hierarchy@^1.1.5` → resolves **1.1.9** (BSD-3-Clause), **no transitive deps**.
- The published `build/d3-flextree.js` **bundles d3-hierarchy inline** (UMD, self-contained).
- All licenses permissive.

### (e) License
- `LICENSE` present in tarball (482 B, sha256 `2db195a4562728bcbd49310a1886e09223dec0bc95ce362c73d7387d6bb45f58`), `package.json` `license: "WTFPL"` — **SPDX match** ✅.
- **Caveat:** WTFPL is a permissive public-domain-like license but **not OSI-approved**; legal review recommended.

### (f) Integrity
- registry `sha512` = `gJiHrx5uTTHq44bjyIb3xpbmmdZcWLYPKeO9EPVOq8EylMFOiH2+9sWqKAiQ4DcFuOZTAxPOQyv0Rnmji/g15A==`; registry `shasum` sha1 `1f0419f4e6c972e096dd884627a87b6b38e7ba73`.
- Local tarball: sha512 **matches**, sha1 **matches**, sha256 `9de2ca6f04ed34d5807d136b6c59816c140812335a0647d35162b6834e048240` (174 202 B).

### (g) Typosquat / name confusion
- `d3-flextree` is unique; probes for `d3-flex-tree`, `d3flex-tree`, `d3-flextreee`, `d3-flextrees`, `d3-flextree2`, `d3-flexitree` → **all absent**.
- Unrelated `flextree@3.2.2` exists (zhangfisher, tree-storage lib, created 2024-06-19) — different purpose, no name confusion for the scoped install.

### (h) Provenance / reproducibility vs GitHub
- No tag for 2.1.2, so no tag diff possible. Verified against **master HEAD `af19622`**:
  - `index.js`, `package.json`, `src/flextree.js`, `README.md`, `rollup.config.js`, `.babelrc`, `.eslintrc.js` → **byte-identical**.
  - `build/d3-flextree.js.map` **`sourcesContent`** embeds `../src/flextree.js` with sha256 `bf8be89af771d2bc…`, **byte-identical to the shipped `src/flextree.js`** → the shipped dist was built from the shipped/HEAD source. (Build artifacts are NOT committed to the repo, so a full independent rebuild is not byte-verifiable; toolchain is rollup 0.55 / babel 6.)

### (i) CVEs / deprecation
- GitHub advisories API (`ecosystem=npm&affects=d3-flextree`): **0**.
- OSV `d3-flextree@2.1.2`: **OK**.
- `npm audit` on the resolved tree: 0 vulnerabilities. No registry deprecation.

---

## 2) `@dagrejs/dagre` — 3.1.1 — **SAFE-WITH-CAVEATS**

### (a) Version & history
- Latest **3.1.1**, published **2026-08-08T15:10:12Z** (one day before this audit).
- 20 versions. `0.7.5` 2017-12-26 / `0.8.0` 2017-12-29 (by `cpettitt`) → **5.4-year gap** → `1.0.0` 2023-05-10 (by `davidnewell`) → continuous through 3.1.1.
- **Ownership change:** original author/publisher `cpettitt` handed publishing to `davidnewell` at 1.0.0 (2023-05-10).
- **Version-number gaps (never published, no registry/time entries):** `1.0.3`, `1.1.6`, `1.1.7`, `2.0.2` — normal skipped bumps, not yanks/unpublishes.
- No deprecated versions, no republished old versions.

### (b) Maintainers / 2FA / provenance
- npm maintainers: **`cpettitt`** (original author, `cpettitt@gmail.com`), **`lutzroeder`** (Lutz Roeder, `npmjs@lutzr.com`), **`davidnewell`** (David Newell, `rustedgrail@gmail.com`). All versions since 1.0.0 published by `davidnewell`.
- **No npm provenance / no `dist.attestations` on any version** (including 3.1.1). Registry `signatures` only (npm registry key).
- GitHub linkage: tag commit `c3ed0802cd98de74c21cff1f754689ebbb0f8dae` (v3.1.1) authored/committed by **`rustedgrail` = David Newell `<beta@alumni.rice.edu>`**; `rustedgrail` id created **2011-02-11**, 54 repos, `@google`. npm `davidnewell` email `rustedgrail@gmail.com` matches the handle → **publisher identity consistent** ✅.
- **Caveat — reused GitHub username:** the GitHub account `cpettitt` is now **id 133097800, name "SmileKamboj", created 2023-05-10** — *not* the original dagre author. The npm account `cpettitt` still exists and still holds publish rights to `@dagrejs/dagre`, but its GitHub identity can no longer be cross-verified. A dormant/compromised `cpettitt` npm account could publish.
- `dagrejs` org has **no public members** (API returned empty), so `davidnewell`'s org membership cannot be independently confirmed; repo contributor list shows `rustedgrail` with 260 commits → de-facto maintainer.

### (c) Tarball contents
- 78 files, unpacked 1 413 014 B; `files: ["dist/"]` (dist + README + LICENSE + package.json).
- Lifecycle: only **`prepublishOnly`** (runs on publish only, never on install). No pre/install/postinstall/prepare.
- Static scan: **clean** — no eval/Function/child_process/net/fetch/XMLHttpRequest/process.env/base64 blobs/unicode issues.
- `dagre.esm.js` is a self-contained ESM bundle (graphlib inlined); `dagre.cjs` / `dagre.js` reference `@dagrejs/graphlib` externally (CJS) — `.LEGAL.txt` files present for bundled third-party license.

### (d) Dependency tree (transitive) + licenses
- `@dagrejs/dagre@3.1.1` → `@dagrejs/graphlib@4.0.5` (MIT), **no transitive deps**.
- All licenses permissive.

### (e) License
- `LICENSE` present (1062 B, sha256 `6a349742a6cb219d5a2fc8d0844f6d89a6efc62e20c664450d884fc7ff2d6015`), `package.json` `license: "MIT"` — **SPDX match** ✅.

### (f) Integrity
- registry `sha512` = `zroZB1dFOFiGgv4Xcrn1DckB1o4aOikPqD2NDQPV0WM//CXGcS6xiD0rNkqHmw6FEg4tabt4nxPLwgCWT+Vb2A==`; `shasum` sha1 `06de3070d584886b8820aaceeefc45a553cf2b97`.
- Local tarball: sha512 **matches**, sha1 **matches**, sha256 `6db2c35cf4c52cd1cd3a87c3a97c7c5fa559deaf4e452f67aab4008e00ca28c4` (359 254 B).

### (g) Typosquat / name confusion
- **High-value confusion targets exist:**
  - `dagre@0.8.5` (last publish **2019-12-03**, `deprecated: null` — *not* formally deprecated, effectively abandoned). Installing `dagre` instead of `@dagrejs/dagre` silently yields 7-year-old code.
  - `dagrejs@0.2.1` — an **unrelated** package by `xdzhao` (repo `brickmaker/dagre`), created 2021-08-03. Looks like the official scope name but is not.
  - `dagre-d3` (renderer) also exists. `@dagre/dagre` absent.
- Mitigation: pin the exact scoped name `@dagrejs/dagre@3.1.1`; never `npm i dagre`.

### (h) Provenance / reproducibility vs GitHub
- **Best-in-class artifact match:** repo `dagrejs/dagre` **commits `dist/`**, and **all 78 published files are byte-identical to tag `v3.1.1`** (`cmp` per file; 0 differences, 0 extra files). The dist is a reproducible build of the tag. ✅

### (i) CVEs / deprecation
- GitHub advisories (`@dagrejs/dagre`, `dagre`): **0**.
- OSV `@dagrejs/dagre@3.1.1`, `@dagrejs/graphlib@4.0.5`: **OK**. `npm audit`: 0. No deprecation on latest.

---

## 3) `d3-dag` — 1.2.2 — **SAFE**

### (a) Version & history
- Latest **1.2.2**, published **2026-07-05T17:34:41Z**. 57 versions, 2018-07-06 → 2026-07-05; active project.
- **Dormancy anomaly:** `1.1.0` 2023-09-30 → **2.5-year gap** → `1.2.0` 2026-04-13, then 1.2.1/1.2.2. Single publisher `erik.brinkman` for all ≤1.1.0; 1.2.0+ published by **`GitHub Actions`** (OIDC trusted publisher).
- **Deprecations (transparent, latest unaffected):** `0.11.0` ("this package wasn't built correctly"), `1.2.0` ("Broken package exports (missing main/types); use 1.2.1 or later"). No republished old versions.

### (b) Maintainers / 2FA / provenance
- Single npm maintainer **`erik.brinkman`** (Erik Brinkman, `erik.brinkman@gmail.com`). GitHub `erikbrinkman` id 858926, created **2011-06-18**, 69 repos — matches repo owner and provenance owner id ✅.
- **npm provenance: YES.** `dist.attestations.provenance` (SLSA v1) + `_npmUser.trustedPublisher = {id: github, oidcConfigId: …}`, publisher `GitHub Actions`.
  - Attestation digest sha512 = `453e3e204504b6121e2224dbe1351f9abc3ca3ba883667918edbeba249ae85f937297a7c6105fac9938550922aeec1e1bf924ca43291de11d6cd86fdabf8d469` (**matches the tarball**).
  - Build: repo `https://github.com/erikbrinkman/d3-dag`, workflow `.github/workflows/release.yml`, ref `refs/heads/main`, git commit `73133c62b7b74fcad900f302f647796f7ddd73a2`, runner `github-hosted`, run `28749113433`.
  - Workflow reviewed: gate → changelog → release job with `id-token: write`, `bun install --frozen-lockfile`, `bun export`, `npm version`, commit+tag, **`npm publish --provenance --access public --ignore-scripts`**, then `git push --follow-tags`.

### (c) Tarball contents
- 48 files, unpacked 595 787 B; `files: ["/dist/**/*.js","/dist/**/*.mjs","/dist/**/*.d.ts"]` → ships **only minified dist bundles + `.d.ts`** + LICENSE/README/package.json.
- Lifecycle: **`prepack`** (publish/pack only, never install). No pre/install/postinstall/prepare.
- Static scan:
  - `src/` (from GitHub tag): **clean** — no eval/Function/child_process/fs/net/fetch/process.env.
  - `dist/d3-dag.esm.min.mjs`: **clean, self-contained** — no external imports, no Node built-ins.
  - `dist/d3-dag.cjs.min.js`: **top-level** `require("fs")` (×2), `require("child_process")`, `require("node:vm")`, `require("path")`, `require("url")`, `require("vm")`, `require("worker_threads")`. Traced to bundled transitive deps: `javascript-lp-solver` (`solver.cjs.js` uses `fs`/`child_process.execFile` for its external lpsolve CLI) and `web-worker` (`worker_threads`/`vm`/`url`/`path`). **Not malicious, but a CJS-hygiene smell** — prefer the ESM bundle.
  - `Buffer.from(…,"base64")` appears in all bundles inside bundled deps (data-URL handling), not an exfil blob. No base64 blobs >200 chars. No suspicious unicode.
- 3 files carry the exec bit (`LICENSE`, `package.json`, `README.md`) — cosmetic npm-11 quirk, not code.

### (d) Dependency tree (transitive) + licenses
Direct: `d3-array@^3.2.4`, `javascript-lp-solver@^1.0.3`, `quadprog@^1.6.1`, `stringify-object@^6.0.0`. Resolved tree = **24 packages** (incl. root), **all permissive**:

| Package | Version | License |
|---|---|---|
| d3-array | 3.2.4 | ISC |
| internmap | 2.0.3 | ISC |
| javascript-lp-solver | 1.0.3 | Unlicense |
| quadprog | 1.6.1 | MIT |
| stringify-object | 6.0.0 | BSD-2-Clause |
| get-own-enumerable-keys | 1.0.0 | MIT |
| is-identifier | 1.1.0 | MIT |
| identifier-regex | 1.1.0 | MIT |
| reserved-identifiers | 1.2.0 | MIT |
| super-regex | 1.1.0 | MIT |
| function-timeout | 1.0.2 | MIT |
| make-asynchronous | 1.1.0 | MIT |
| p-event | 6.0.1 | MIT |
| p-timeout | 6.1.4 | MIT |
| time-span | 5.1.0 | MIT |
| convert-hrtime | 5.0.0 | MIT |
| web-worker | 1.5.0 | Apache-2.0 |
| type-fest | 4.41.0 | (MIT OR CC0-1.0) |
| is-obj | 3.0.0 | MIT |
| is-regexp | 3.1.0 | MIT |

No copyleft. Note the surface: `stringify-object` (debug-only) pulls 10 packages.

### (e) License
- `LICENSE` present (1070 B, sha256 `3c5db2177ee2b3d917bde9f952cc0df46eaeb7a5d8ea9d42a65a9088aa869c86`), `package.json` `license: "MIT"` — **SPDX match** ✅.

### (f) Integrity
- registry `sha512` = `RT4+IEUEthIeIiTb4TUfmrw8o7qINmeRjtvrokmuhfk3KXp8YQX6yZOFUJIq7sHhv5JMpDKR3hHWzYb9q/jUaQ==`; `shasum` sha1 `430b2bf4bccabe023d867a8ca52bbe9fb5b66cea`.
- Local tarball: sha512 **matches** (and matches the provenance subject digest), sha1 **matches**, sha256 `e1de1be1b812aef5ba5919d2aa5b65963bc8be8a05f4cb5fe3ab3b9cdf092754` (181 826 B).

### (g) Typosquat / name confusion
- `d3-dag` is unique; probes `d3dag`, `d3-dag-layout`, `d3-dag-layouts`, `d3dagre`, `dagre-dag` → **all absent**. No confusion.

### (h) Provenance / reproducibility vs GitHub
- Provenance build commit `73133c6` (`refs/heads/main`) has `package.json` version **1.2.1**; tag `v1.2.2` is annotated → commit `c634242f8eb76032ef0597969a4cb11cc1e2d55d`, **exactly 1 commit ahead**, touching only `CHANGELOG.md` (+4/−1) and `package.json` (+1/−1: `1.2.1`→`1.2.2`). This is the workflow's own `npm version` + commit + tag step — **source code identical between build commit and tag** ✅.
- **Caveat:** the tag itself is not the build input, and the published bundles are **minified with no source maps**; `bun` is not installed here, so I could **not locally rebuild** and byte-compare the dist. Trust rests on the SLSA attestation + clean source review, not on a local rebuild.

### (i) CVEs / deprecation
- GitHub advisories (`d3-dag`): **0**. OSV `d3-dag@1.2.2` + all 9 sampled transitive deps: **OK**. `npm audit`: 0. Latest not deprecated.

---

## Vendor manifest (offline-reproducible)

All three tarballs verified: registry `sha512` == local sha512, registry `shasum` == local sha1.

### 1. `d3-flextree` — pin **2.1.2**
- Tarball: `https://registry.npmjs.org/d3-flextree/-/d3-flextree-2.1.2.tgz`
- integrity `sha512-gJiHrx5uTTHq44bjyIb3xpbmmdZcWLYPKeO9EPVOq8EylMFOiH2+9sWqKAiQ4DcFuOZTAxPOQyv0Rnmji/g15A==`
- sha256 `9de2ca6f04ed34d5807d136b6c59816c140812335a0647d35162b6834e048240`
- **Vendor file: `package/build/d3-flextree.js`** (unminified UMD, self-contained incl. d3-hierarchy; this is `main`)
  - sha256 `e4cd9feea0d126fd4839c39fb3526fb5806173e20e486ef703171e7803dd9d75`, size **23 184 B**
  - alt (ESM source, requires `d3-hierarchy`): `package/src/flextree.js` sha256 `bf8be89af771d2bc064bb32e7526ac167df1b4131a68a9f1106a047eaca238a8`, 11 212 B
- ⚠️ Do **not** install as a `file:` dependency: its `prepare` script (`npm-run-all clean build lint test`) would execute on install. Copy the file, or vendor with scripts stripped.

### 2. `@dagrejs/dagre` — pin **3.1.1**
- Tarball: `https://registry.npmjs.org/@dagrejs/dagre/-/dagre-3.1.1.tgz`
- integrity `sha512-zroZB1dFOFiGgv4Xcrn1DckB1o4aOikPqD2NDQPV0WM//CXGcS6xiD0rNkqHmw6FEg4tabt4nxPLwgCWT+Vb2A==`
- sha256 `6db2c35cf4c52cd1cd3a87c3a97c7c5fa559deaf4e452f67aab4008e00ca28c4`
- **Vendor file: `package/dist/dagre.esm.js`** (self-contained ESM; graphlib inlined)
  - sha256 `93f5f23d1bee1217531900366798277689400850a5560f238d4f213c8d552a63`, size **48 559 B**
  - alt (CJS, requires `@dagrejs/graphlib@4.0.5`): `package/dist/dagre.cjs` sha256 `70b9a4367932dd436075d98892a7968d65cf66ae83263f995e0531823b59b671`, 35 961 B
- Transitive pin if using CJS: `@dagrejs/graphlib@4.0.5` — `https://registry.npmjs.org/@dagrejs/graphlib/-/graphlib-4.0.5.tgz`, integrity `sha512-7xrBTqIts3o+PMUZX97wSc+7TUbW+/rULzGNCTP6yooNVDXbzw4Wutg/H/xOutTB/c/k0YqOAavgPh4/Zk9PFA==` (MIT, no deps).

### 3. `d3-dag` — pin **1.2.2**
- Tarball: `https://registry.npmjs.org/d3-dag/-/d3-dag-1.2.2.tgz`
- integrity `sha512-RT4+IEUEthIeIiTb4TUfmrw8o7qINmeRjtvrokmuhfk3KXp8YQX6yZOFUJIq7sHhv5JMpDKR3hHWzYb9q/jUaQ==`
- sha256 `e1de1be1b812aef5ba5919d2aa5b65963bc8be8a05f4cb5fe3ab3b9cdf092754`
- **Vendor file: `package/dist/d3-dag.esm.min.mjs`** (self-contained ESM; **no Node built-ins**)
  - sha256 `37c98e4ea147f2bb9a703bd4839606040a2a1c74ee97d0fc4d13fef62e44eb4b`, size **142 255 B**
  - avoid `package/dist/d3-dag.cjs.min.js` (sha256 `354001141a6df00c437e5ca9a44cee337ec1ff8f11260fa0f6859c80b91b8187`, 148 456 B) — top-level `require` of `fs`/`child_process`/`vm`/`worker_threads` inherited from bundled deps.
- Type declarations (if TS): all `package/dist/**/*.d.ts` (types entry `dist/index.d.ts`).

---

## Final summary (verdict table + what would flip it)

| Package | Pinned | Verdict | Dist↔tag match | npm provenance | Maintainer risk | Name-confusion risk | CVEs |
|---|---|---|---|---|---|---|---|
| `d3-flextree` | 2.1.2 | **SAFE-WITH-CAVEATS** | source↔master HEAD ✅, no 2.1.2 tag, dist not committed | ❌ none | extra co-maintainer `sidyes` w/ publish rights, 0 commits | low | 0 |
| `@dagrejs/dagre` | 3.1.1 | **SAFE-WITH-CAVEATS** | **78/78 files byte-identical to tag v3.1.1** ✅ | ❌ none | `cpettitt` still has publish rights; GitHub `cpettitt` now a different person | **high** (`dagre`, `dagrejs`) | 0 |
| `d3-dag` | 1.2.2 | **SAFE** | source identical to build commit; tag = +1 version-bump commit | ✅ SLSA v1 + GitHub OIDC | single maintainer, owner match | low | 0 |

What would change each verdict:
- **d3-flextree:** a new publish after the 4.8-year dormancy (or any maintainer change) → re-audit as RISK; if legal rejects WTFPL → drop.
- **@dagrejs/dagre:** a publish by `cpettitt` (rather than `davidnewell`) or a dist that no longer matches the repo tag → RISK; missing provenance is mitigated *only* by the exact 78/78 tag match.
- **d3-dag:** a publish not carrying a `dist.attestations` provenance bundle, or a CJS/ESM bundle that no longer matches the attested digest → RISK; also re-audit if `erik.brinkman` adds maintainers.

Bottom line: **vendor all three, pinned exactly as above**, preferring the self-contained ESM/UMD artifacts listed in the vendor manifest; for `d3-flextree` copy the file rather than installing it as a `file:` dependency (its `prepare` script runs on install).

---

## non-layered-tidy-tree-layout@2.0.2 — **SAFE-WITH-CAVEATS** (audited 2026-09-10, all gaps closed)

Audited in-repo with shell + network by the main agent (a first pass by a read-only
sub-agent produced the packument/tarball evidence but could not run the network checks).
**This is the package we actually vendored** into
`media/vendor/non-layered-tidy-tree-layout/`.

### (a) Version & history
- Latest / only tag: **2.0.2** (`dist-tags = {"latest":"2.0.2"}`). Tarball
  `https://registry.npmjs.org/non-layered-tidy-tree-layout/-/non-layered-tidy-tree-layout-2.0.2.tgz`.
- Entire history = 4 versions, all published within 5 days in Oct 2019:
  `1.0.0` 2019-10-12T12:59:40.824Z · `2.0.0` 2019-10-13T01:37:44.727Z ·
  `2.0.1` 2019-10-14T02:18:41.004Z · `2.0.2` 2019-10-17T02:45:13.323Z.
  **No publish in the 6.9 years since.** No yank / unpublish / deprecation / ownership change.
- Upstream `stetrevor/non-layered-tidy-tree-layout`: **tags `v1.0.0, v2.0.0, v2.0.1, v2.0.2`
  all exist**; last push 2022-12-11, 27★, 23 open issues, not archived, GitHub license MIT.

### (b) Maintainers / provenance
- Single npm maintainer **`stetrevor <stephen.trevor.wong@outlook.com>`**; every version's
  `_npmUser` is `stetrevor`. GitHub owner `stetrevor` **matches** the npm publisher
  (account created 2018-06-12, 25 public repos).
- **No npm provenance / no `dist.attestations`** — legacy registry signature only.
  Mitigation: see (h), the published artifacts are byte-identical to the git tag, which is
  stronger than an attestation.

### (c) Tarball contents & lifecycle scripts
- 23 entries / 61,284 B unpacked. Ships `package.json`, `LICENSE`, `README.md`,
  `dist/non-layered-tidy-tree-layout.js`, `src/{index,algorithm,helpers}.js`, `test/*`,
  screenshots, webpack/babel/eslint configs.
- **No lifecycle scripts** (`scripts` = `build: webpack`, `test: jest test`).
  (Contrast: d3-flextree ships `prepare`.)
- Static scan of `dist/` + `src/`: **0 matches** for `eval(`, `new Function`, `Function(`,
  `child_process`, `XMLHttpRequest`, `document.`, network APIs, base64 blobs.
- Quirks: the UMD factory is invoked with a bare `window` (`}(window,…` → `ReferenceError`
  under Node; browser/webview-only); `Layout.layout()` **mutates** the input tree; the
  published `dist` is **minified** (readable `src/` ships alongside, so it can be
  re-audited offline — `dist` is a faithful webpack build of exactly those two modules).

### (d) Dependency tree
- **Zero runtime dependencies** (`dependencies` absent; only devDependencies).
  License surface = MIT only.

### (e) License
- `LICENSE` in tarball = MIT (`Copyright (c) 2019 Michael Wong`); `package.json`
  `license: "MIT"`; GitHub API `license.spdx_id = "MIT"` → SPDX match.

### (f) Integrity
- Registry `integrity` `sha512-gkXMxRzUH+PB0ax9dUN0yYF0S25BqeAYqhgMaLUFmpXLEk7Fcu8f4emJuOAY0V8kjDICxROIKsTAKsV/v355xw==`
  (packument and an independent `package-lock.json` agree).
- Local `npm pack` tarball sha256 `1e7fbc3c779ea3626e3783042717df64abab7814a1e8be670a4dfb60836a2a72`;
  `dist/non-layered-tidy-tree-layout.js` sha256
  `66562202bd0b7b456439d127fea7208887e713ba1aa82208b21ac0c60a86e3e1` (5,599 B) — recomputed
  three independent times (registry fetch, npm pack, repo copy) and identical.

### (g) Typosquat / name-confusion
- 10 near-miss names probed against the registry, **all 404**: `…-layouts`,
  `nonlayered-tidy-tree-layout`, `non-layered-tidytree-layout`, `non-layered-tidy-tree`,
  `nonlayeredtidy-tree-layout`, `nlt-tree-layout`, `nl-tidy-tree-layout`,
  `d3-non-layered-tidy-tree-layout`, `tidy-tree-layout`, `non-layered-tidy-trees`.
- Real confusion risk is with *algorithm siblings*, not typosquats: `d3-flextree`
  (same van der Ploeg paper, WTFPL) and `@mermaid-js/layout-tidy-tree`. Pin the exact name.

### (h) Artifact provenance (strongest signal)
- Downloaded `codeload.github.com/stetrevor/non-layered-tidy-tree-layout/tar.gz/refs/tags/v2.0.2`
  and `cmp`-ed against the npm tarball: **`dist/non-layered-tidy-tree-layout.js`,
  `src/index.js`, `src/algorithm.js`, `src/helpers.js` are all BYTE-IDENTICAL** (4/4).
  The repo commits `dist/`, so the published bundle is reproducible from the tagged source.

### (i) Vulnerabilities
- `POST https://api.osv.dev/v1/query` (npm, version 2.0.2) → `{}` (no advisories).
  No registry deprecation.

### Verdict & vendor manifest
**SAFE-WITH-CAVEATS** — the caveats are dormancy, a single maintainer, and no npm
provenance; none of them can affect us after vendoring because the package is **never
resolved from the registry again** (no `package.json` entry, no install script, files
copied byte-exact into the repo).

Vendored into `media/vendor/non-layered-tidy-tree-layout/` (see its `PROVENANCE.md`):
`dist/non-layered-tidy-tree-layout.js` (sha256 `66562202…e3e1`), `src/{index,algorithm,helpers}.js`,
`LICENSE`. Loaded via a nonce'd `<script>` in the webview (no `unsafe-eval` needed —
the bundle contains no `eval`/`Function`).

What would change the verdict: a new publish (dormancy broken), a maintainer change, a
dist that no longer matches tag `v2.0.2`, or any `eval`/network/`child_process` appearing
in a future artifact.

