/**
 * The two Chinese scripts this extension ships a catalog for — the one place that
 * knows what VS Code calls them.
 *
 * The **canonical** tags are the region-invariant BCP-47 forms (`zh-Hans` /
 * `zh-Hant`), and they are what this repo writes everywhere a language is *named*:
 * the `spinney.replyLanguage` enum, the catalog file names, the prose. But the
 * language packs still declare the legacy region ids
 * (`vscode-language-pack-zh-hans` carries `"languageId": "zh-cn"`), so
 * `vscode.env.language` reports `zh-cn` / `zh-tw` — and that reported tag is also
 * the name VS Code's own lookup uses, for both catalogs it reads itself:
 *
 *   l10n/bundle.l10n.<tag>.json    the host strings (`vscode.l10n.t`)
 *   package.nls.<tag>.json         the manifest strings (`%key%`)
 *
 * The two spellings therefore cannot be collapsed: the repo authors the canonical
 * names and `tools/sync-l10n-aliases.js` writes the reported-tag copies VS Code
 * needs, for exactly as long as `vsce` is reading the tree. See
 * `docs/agents/invariants/i18n.md`.
 *
 * **Keep this module import-free.** It is the shared truth of three consumers that
 * live in different worlds — `src/i18n.ts` (Extension Host),
 * `src/agent/languages.ts` (pure prompt code) and the `tools/` dev scripts, which
 * `require('../out/languageTags.js')` outside the host, exactly as
 * `check-models.js` requires `out/agent/models.js`. One `import` of anything that
 * reaches `vscode` would break the third one.
 */

/** Canonical (region-invariant) tag → the tag VS Code reports for it. */
export const REPORTED_TAGS: Record<string, string> = {
  'zh-Hans': 'zh-cn',
  'zh-Hant': 'zh-tw',
};

/** The same pair from the other side: the reported tag → the canonical one. */
export const CANONICAL_TAGS: Record<string, string> = Object.fromEntries(
  Object.entries(REPORTED_TAGS).map(([canonical, reported]) => [reported, canonical]),
);
