# Vendored ripgrep 14.1.1 — pin record

`media/vendor/ripgrep/<platform>-<arch>/rg` (or `rg.exe`) is the **unmodified `rg`
binary** from the official [BurntSushi/ripgrep](https://github.com/BurntSushi/ripgrep)
release `14.1.1`, one directory per platform-architecture. Nothing else from the
archives is shipped (no `doc/`, no `README.md`, no shell completions): the tool only
ever spawns the binary.

`src/tools/searchFiles.ts` probes this directory **first**
(`path.resolve(__dirname, '../..')` + `media/vendor/ripgrep/<process.platform>-<process.arch>/rg`),
then VS Code's bundled ripgrep under `vscode.env.appRoot`, then `rg` on `PATH`, so a
search does not depend on what the host happens to bundle.

- Upstream: https://github.com/BurntSushi/ripgrep
- Release: https://github.com/BurntSushi/ripgrep/releases/tag/14.1.1
- Version string of the vendored binary: `ripgrep 14.1.1 (rev 4649aa9700)`
- License: **MIT** (the project is dual-licensed `Unlicense OR MIT`; this
  redistribution takes the MIT branch, whose text is reproduced at the end of this
  file, because MIT requires the notice to travel with the binary). The MIT copyright
  line is `Copyright (c) 2015 Andrew Gallant`.
- Statically linked third-party code: the x86_64 Windows build enables the `pcre2`
  feature, so PCRE2 (`BSD-3-Clause`, see the upstream `LICENSE-MIT`/`COPYING` notes)
  is inside that binary. Nothing is loaded from the system.

## The six artifacts (five landed, one not published)

| Directory | Release artifact | `rg` sha256 | Bytes |
|---|---|---|---|
| `win32-x64/` | `ripgrep-14.1.1-x86_64-pc-windows-msvc.zip` | `f162b54de2adfc72d78adb1dbada2dedda111ae0a5e2f6e9500f4f909664c5d2` | 5 407 744 |
| `win32-arm64/` | **not published for 14.1.1** — see below | — | — |
| `linux-x64/` | `ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz` | `f401154e2393f9002ac77e419f9ee5521c18f4f8cd3e32293972f493ba06fce7` | 6 597 984 |
| `linux-arm64/` | `ripgrep-14.1.1-aarch64-unknown-linux-gnu.tar.gz` | `e07d5c85fa9ca740ff4ab8bbac60a1e11c7a5ce242435f7820a03f7c20ef6276` | 5 233 424 |
| `darwin-x64/` | `ripgrep-14.1.1-x86_64-apple-darwin.tar.gz` | `923dcc25cab57d33f4e7dd0476d4b74a554401a38817e246a8d6101dcd51c50f` | 5 162 504 |
| `darwin-arm64/` | `ripgrep-14.1.1-aarch64-apple-darwin.tar.gz` | `0e0cb83f5195f1f51bb8feef1fff5b0b171e82bd1db6bd35deee701a3e7102f8` | 4 375 216 |

Archive sha256s (each one also recomputed locally and compared against the
`.sha256` file the release publishes next to it — all five matched):

| Release artifact | Archive sha256 |
|---|---|
| `ripgrep-14.1.1-x86_64-pc-windows-msvc.zip` | `d0f534024c42afd6cb4d38907c25cd2b249b79bbe6cc1dbee8e3e37c2b6e25a1` |
| `ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz` | `4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e` |
| `ripgrep-14.1.1-aarch64-unknown-linux-gnu.tar.gz` | `c827481c4ff4ea10c9dc7a4022c8de5db34a5737cb74484d62eb94a95841ab2f` |
| `ripgrep-14.1.1-x86_64-apple-darwin.tar.gz` | `fc87e78f7cb3fea12d69072e7ef3b21509754717b746368fd40d88963630e2b3` |
| `ripgrep-14.1.1-aarch64-apple-darwin.tar.gz` | `24ad76777745fbff131c8fbc466742b011f925bfa4fffa2ded6def23b5b937be` |

### Why two of them are not the "obvious" artifact

- **`win32-arm64` does not exist in 14.1.1.** The release publishes only
  `x86_64-pc-windows-msvc`, `x86_64-pc-windows-gnu` and `i686-pc-windows-msvc` for
  Windows — there is no `aarch64-pc-windows-msvc` asset, so there is no honest binary
  to vendor and the directory is absent. On Windows on ARM the probe list falls
  through to VS Code's own bundled `ripgrep-universal/bin/win32-arm64/rg.exe` and then
  to `PATH`, which is exactly the chain that directory exists to feed. Do not "fix"
  this by copying the x64 binary into `win32-arm64/`: it would work only under
  Windows' x64 emulation and the directory name would then lie about what is inside.
- **`linux-x64` uses the musl build and `linux-arm64` the gnu build**, because of the
  two only those exist: 14.1.1 publishes `x86_64-unknown-linux-musl` (statically
  linked, runs on any distribution) and `aarch64-unknown-linux-gnu` (there is no
  `aarch64-unknown-linux-musl` asset). Verified with `file`: static-pie x86-64 ELF,
  and a dynamically linked aarch64 ELF whose interpreter is
  `/lib/ld-linux-aarch64.so.1`.

## How this was produced (reproduce it, do not trust it)

```sh
base=https://github.com/BurntSushi/ripgrep/releases/download/14.1.1
curl -L -O $base/ripgrep-14.1.1-x86_64-pc-windows-msvc.zip
curl -L -O $base/ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz
curl -L -O $base/ripgrep-14.1.1-aarch64-unknown-linux-gnu.tar.gz
curl -L -O $base/ripgrep-14.1.1-x86_64-apple-darwin.tar.gz
curl -L -O $base/ripgrep-14.1.1-aarch64-apple-darwin.tar.gz

# one at a time: the archive hash must equal the table above (and the release's
# own .sha256 file)
sha256sum ripgrep-14.1.1-*.zip ripgrep-14.1.1-*.tar.gz

# extract, then copy ONLY the binary out of each archive
unzip -o ripgrep-14.1.1-x86_64-pc-windows-msvc.zip \
      'ripgrep-14.1.1-x86_64-pc-windows-msvc/rg.exe' -d x-win32
tar -xzf ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz \
      ripgrep-14.1.1-x86_64-unknown-linux-musl/rg -C x-linux-x64
# … the same for the other three, into media/vendor/ripgrep/<platform>-<arch>/
```

Verification, without a Linux or a Mac:

- `sha256sum media/vendor/ripgrep/*/rg media/vendor/ripgrep/*/rg.exe` must print the
  `rg` hashes above;
- `file media/vendor/ripgrep/*/rg` must agree with the platform (Mach-O arm64 /
  Mach-O x86_64 / ELF aarch64 / static-pie ELF x86-64);
- the Windows binary runs on the developer machine: `media/vendor/ripgrep/win32-x64/rg.exe --version`
  → `ripgrep 14.1.1 (rev 4649aa9700)`.

The POSIX binaries need the executable bit in git (`mode 100755`) so a user on Linux
or macOS can spawn them; the Windows one does not.

## Updating this pin

Do not, without a fresh supply-chain audit: a new version needs its own archive and
binary hashes, this file rewritten, and the same five (or six) platform checks. See
`docs/agents/invariants/vendored-deps.md`.

## License (MIT)

```
The MIT License (MIT)

Copyright (c) 2015 Andrew Gallant

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
