# Vendored pinyin table — pin record

`media/vendor/pinyin/pinyin.json` is a **derived** Unicode → tone-less pinyin table: one
canonical reading per CJK character, over the three CJK ranges the `@` picker's shadow may
cover. It is data, not code — nothing here is executed. `src/chat/pinyin.ts` is the only
reader.

- Upstream: https://github.com/mozillazg/pinyin-data
- Source file: `pinyin.txt`, whose own header reads `# version: 0.16.0`
- Exact source URL:
  https://raw.githubusercontent.com/mozillazg/pinyin-data/master/pinyin.txt
- Licence: **MIT**, `Copyright (c) 2016 mozillazg`. The licence text lives beside the
  source at https://github.com/mozillazg/pinyin-data/blob/master/LICENSE and is reproduced
  at the end of this file, because MIT requires the notice to travel with the data.
- Date fetched: **2026-11-19** (UTC)
- Downloaded source file: **985 559 bytes**, 44 442 lines,
  sha256 `2342a6f98c85dbc3c8d26aef31744876a36326c6466e51e9a0f16898c36c2011`
- Vendored output: **189 257 bytes**, sha256
  `6c6e16a96d4fe5526d4bd21220f1d1eb26bc89bef3af8c0acb52eb5f47fefbb6`,
  **26 713 entries**, zero duplicate characters, every character inside the three ranges.

`src/chat/pinyin.ts` resolves the file the way `src/tools/searchFiles.ts` resolves its
vendored ripgrep: `path.resolve(__dirname, '..', '..')` from the compiled `out/chat/`, then
`media/vendor/pinyin/pinyin.json` — the same relative path in a checkout and inside the
`.vsix`.

## Shape of the vendored file

```json
{ "format": "spinney-pinyin-v1", "source": "…", "separator": ",",
  "count": 26713, "chars": "㐀㐁㐄…", "readings": "qiu,jiu,kua…" }
```

Two **parallel strings**, not one object per character: `chars` holds the CJK characters in
code-point order and `readings` holds their readings joined by `separator`. The object form
(`{"档":"dang"}`) costs roughly ten bytes an entry while the parallel form costs about
seven, which is the difference between the plan's "hundreds of kilobytes for nothing" and a
table smaller than one of the vendored grammar files. Code-point order makes the file
deterministic, so a re-generation shows up as a real diff and the file is reviewable.

Every reading is lowercase `[a-z]` only, tones dropped, `ü` written as **`v`** — the
spelling a Chinese IME accepts (`nv`, `lv`, `lve`, `xue`, `jue`, `que`, `yue`). Storing the
IME form is what removes the query-side `ue`→`ve` rewrite §6.8 records as the C# project's
repair: `normalizeQuery` only has to fold `ü` and `u:` into `v`.

## Filtering and normalisation, exactly

1. Parse one row per data line: `U+XXXX: reading[,reading…]  # 字`. **Only the first
   reading is kept** — the canonical one (§6.8). Alternate polyphone readings and fuzzy
   sounds are phase 2, not this file.
2. Keep only the three CJK ranges: **U+3400–U+4DBF** (Extension A), **U+4E00–U+9FFF**
   (Unified Ideographs), **U+F900–U+FAFF** (Compatibility Ideographs). 44 440 rows
   upstream → **26 713 kept, 17 727 dropped** by this rule alone (CJK Extension B–F, the
   U+3000 block that holds 〇, Hangul, Latin, the compatibility supplement, and so on).
3. Fold the reading to its IME spelling, in this order: `toLowerCase()` (so `Ü`/`Ǖ` behave
   like `ü`/`ǖ`), then `ü` and its tone-marked forms `ǖ ǘ ǚ ǜ` (U+01D5–U+01DC) → `v`, then
   NFD, then drop every combining mark U+0300–U+036F. **The `ü` step must come first**: NFD
   decomposes `ü` into `u` + U+0308, and stripping the marks afterwards would leave a plain
   `u` — `nv` would become `nu`, which is the exact reading §6.8 says the C# project lost
   (学/雪/月/决/确/约 and their 732 `üe` readings).
4. Drop any reading that is not `[a-z]+` after step 3. **0 rows were dropped** by this
   step, so the count above is the range count. A character with no usable reading is
   simply absent: it never pinyin-matches and still matches literally, and `shadow()` treats
   it like the ASCII in `UI缩放` — not part of the shadow at all.
5. Sort by code point and emit the two parallel strings.

## Reproduce it (do not trust these bytes)

```sh
curl -L -o pinyin.txt https://raw.githubusercontent.com/mozillazg/pinyin-data/master/pinyin.txt
sha256sum pinyin.txt          # must print 2342a6f98c85dbc3c8d26aef31744876a36326c6466e51e9a0f16898c36c2011
node build-pinyin.js pinyin.txt pinyin.json
sha256sum pinyin.json         # must print 6c6e16a96d4fe5526d4bd21220f1d1eb26bc89bef3af8c0acb52eb5f47fefbb6
```

`build-pinyin.js` is reproduced verbatim below; it is not part of the repository.

```js
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2];
const OUT = process.argv[3];

// The three CJK ranges the shadow is allowed to cover.
const RANGES = [
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
];
const inRange = (cp) => RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);

// One reading -> the spelling a Chinese IME accepts: tones dropped, ü written as v.
function toIme(reading) {
  return reading
    .toLowerCase()                          // Ü -> ü, Ǖ -> ǖ, Ā -> ā
    .replace(/[\u00fc\u01d5-\u01dc]/g, 'v') // ü ǖ ǘ ǚ ǜ
    .normalize('NFD')                       // ā -> a + U+0304, ê -> e + U+0302
    .replace(/[\u0300-\u036f]/g, '');       // drop every combining tone mark
}

const rows = [];
for (const line of fs.readFileSync(SRC, 'utf8').split('\n')) {
  const m = /^U\+([0-9A-Fa-f]+):\s*([^#]*?)\s*(?:#.*)?$/.exec(line);
  if (!m) continue;
  const cp = parseInt(m[1], 16);
  if (!inRange(cp)) continue;
  const first = m[2].split(',')[0].trim(); // the first written reading is the canonical one
  const reading = toIme(first);
  if (!/^[a-z]+$/.test(reading)) continue;
  rows.push([String.fromCodePoint(cp), reading]);
}
// Code-point order, so the file is deterministic and reviewable as a diff.
rows.sort((a, b) => a[0].codePointAt(0) - b[0].codePointAt(0));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  format: 'spinney-pinyin-v1',
  source: 'https://github.com/mozillazg/pinyin-data pinyin.txt (MIT)',
  separator: ',',
  count: rows.length,
  chars: rows.map((r) => r[0]).join(''),
  readings: rows.map((r) => r[1]).join(','),
}));
```

The run that produced this file reported `{"total":44440,"outOfRange":17727,"unreadable":0,"kept":26713}`.

## The `-text` rule

`.gitattributes` carries `media/vendor/** -text`, so git normalises **no** end-of-line on
add or checkout for anything under this directory. That is what keeps the bytes exact: the
sha256 above reproduces in a fresh clone, and a Windows checkout with `core.autocrlf=true`
cannot rewrite the file out from under the pin. Do not "fix" a line-ending warning here — a
re-serialised table is a different table.

## Licence (MIT)

```
The MIT License (MIT)

Copyright (c) 2016 mozillazg

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Owed by other files (not part of this directory)

The plan's §6.8 also asks for an entry in `THIRD_PARTY_NOTICES.md` (repository root, which
ships in the `.vsix`: upstream, copyright line `Copyright (c) 2016 mozillazg`, MIT, and the
paths of this file and `pinyin.json`) and a row in
`docs/agents/invariants/vendored-deps.md`. Neither is written here — those files belong to
other slices of the plan.
