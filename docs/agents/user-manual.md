# The user manual

`manual/**` is the **user-facing** documentation. It ships inside the `.vsix`,
`.vscodeignore` does not exclude it, and the command **`Spinney: Show User Manual`**
(`spinney.showManual`) opens a page in an untitled markdown tab, the idiom
`Spinney: Show System Prompt` uses. It is the third documentation tier:

| Tree | Reader | Ships | Answered question |
| --- | --- | --- | --- |
| `README.md` | a visitor on the Marketplace | yes | "what is this, and how do I start?" |
| `manual/**` | the person using the extension | yes | "how do I do X, and why did it do that?" |
| `docs/agents/**` | an agent working on this repo | no (`.vscodeignore`: `docs/**`) | "how is this built, and what must not break?" |

One page per catalog language, named by the **canonical** tag the way the l10n
catalogs are: `manual/manual.md` (English, the source), `manual/manual.zh-Hans.md`,
`manual/manual.zh-Hant.md`. `src/manual.ts` picks the page from `vscode.env.language`
(routed through `src/languageTags.ts`, because the language packs report `zh-cn` /
`zh-tw`) and falls back to English, so a missing page is never an error. The
`[manual]` line in the **Spinney** output channel names the page it read — the only
way to tell "English because the window is English" from "English because the page
is missing".

## Rules

- **A user-visible change updates the manual, in all three pages.** This is not
  optional, and `npm run check:docs` enforces the mechanical half of it: every
  `contributes.commands` title and every `spinney.*` setting key must appear in every
  page, and the three pages must share one heading structure. A renamed command
  title therefore fails packaging instead of shipping a manual that names a button
  the user cannot find.
- **Never name a model id the catalog does not have.** `manual/**` is scanned by
  `tools/check-models.js` alongside `README.md` and `docs/**`.
- **Write it in ASD-STE100.** Layer 1 of
  [the cure for AI slop](https://github.com/woosal1337/blog/tree/main/videos/ep01-the-cure-for-ai-slop)
  (Simplified Technical English): active voice, simple tenses, one instruction per
  sentence, 20 words per instruction and 25 per other sentence, no contractions, no
  semicolons, no phrasal verbs, no nominalizations, at most three words in a
  multi-word noun, one name for one thing. The procedural and error sections use the
  **strict** word set (but, because, can, must, use or with, obey). Layer 2 (the
  reply shape) does **not** apply: a reference document keeps the structure its topic
  needs. The skill ships a linter:

  ```bash
  # Python 3, no dependencies. Fetch it into the gitignored scratch space.
  curl -o .spinney/ste/ste-lint.py \
    https://raw.githubusercontent.com/woosal1337/blog/main/videos/ep01-the-cure-for-ai-slop/asd-ste100/scripts/ste-lint.py
  python .spinney/ste/ste-lint.py manual/manual.md           # flavored: target under 2.5 per 100 words
  python .spinney/ste/ste-lint.py --strict manual/manual.md  # strict: target under 1.5
  ```

  It is a writing aid, **not** a build guard: `vscode:prepublish` must stay node-only
  and offline. Quote the two numbers when the manual changes. Text quoted from the UI
  (`Stop this turn`, an error message) is verbatim — fix a lint report by rewriting
  the prose around a quote, never the quote.
- **A translated page quotes the UI in its own language.** A string the user reads in
  the UI must read in the manual the way the UI shows it: resolve it through the
  matching catalog (`l10n/bundle.l10n.<tag>.json` for the host and the webview,
  `package.nls.<tag>.json` for command titles, view names and settings), the way the
  zh-Hans / zh-Hant pages do. An identifier, a path, a `spinney.*` key, a tool name
  and a badge token (`SUB`, `BG`, `CTX`, `HARNESS`, `Delivered`) stay as they are.
- **Do not duplicate `docs/agents/**` here, and do not duplicate the manual in
  `README.md`.** The README is a summary that links to the manual. A second copy of a
  reference table is a third thing to keep in sync.

## The guard

`npm run check:docs` (`tools/check-docs.js`, in `vscode:prepublish`, after `compile`)
fails when

1. a language has a catalog but no page (the page set is derived from
   `l10n/bundle.l10n.<tag>.json`, minus the reported-tag aliases `sync:l10n` writes),
2. the pages no longer share one heading level sequence,
3. a command title or a `spinney.*` setting key is missing from a page, or
4. a `.vscodeignore` pattern excludes a page from the `.vsix` — evaluated the way
   `vsce` reads that file (last match wins, `!` re-includes, a slash-free pattern
   matches the base name at any depth).

`node tools/check-docs.js <dir>` checks another folder instead, which is how to prove
the guard still catches what it is for (drop a page from a copy of `manual/`, or add
`manual/**` to `.vscodeignore`, and it must fail).
