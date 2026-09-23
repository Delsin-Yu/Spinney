package dev.spinney.remote.core

/**
 * The two Chinese scripts, and the one place on this side that knows what a *phone* calls them.
 *
 * The repo authors one catalog per language under the **canonical, region-invariant** BCP-47 tag
 * — `l10n/bundle.l10n.zh-Hans.json`, `l10n/bundle.l10n.zh-Hant.json` — and that is the name used
 * everywhere a language is *named*. VS Code, however, reports the **legacy region id**
 * (`vscode-language-pack-zh-hans` carries `"languageId": "zh-cn"`), so `vscode.env.language` is
 * `zh-cn` / `zh-tw`, and `tools/sync-l10n-aliases.js` writes reported-tag copies of the catalogs
 * for exactly as long as `vsce` is reading the tree.
 *
 * A phone reports a locale, not a tag: `Locale.getDefault().toLanguageTag()` gives `zh-CN`,
 * `zh-Hans-CN`, `zh-TW`, `zh-Hant-TW` or a bare `zh`. So the app has to do what the extension
 * host does — map what the platform reports onto the canonical tag — and it does it **before it
 * looks the file up**. That is why the Android app can never need the alias files:
 *
 * - the alias catalogs are build artifacts of a `vsce` run (`vscode:prepublish` writes them and
 *   `build-deploy.ps1` deletes them in its `finally`), they are gitignored, and not one byte of
 *   them is copied into an APK (`tools/check-remote-assets.js` refuses to copy an unreviewed
 *   alias — see its rule for authored vs generated catalogs);
 * - `zh-cn` and `zh-Hans` are the same language, and canonicalising is what says so, rather than
 *   shipping a second identical catalog on the phone.
 *
 * [REPORTED_TO_CANONICAL] mirrors `REPORTED_TAGS` / `CANONICAL_TAGS` in `src/languageTags.ts`.
 * Agreement between the two is a review obligation, not a machine-checked one: no test can read
 * the TypeScript at run time. The Kotlin unit test pins this table by value so an edit shows up
 * in a diff.
 */
object LanguageTags {

    /** The tag VS Code reports → the canonical tag the repo authors. Mirrors `CANONICAL_TAGS`. */
    val REPORTED_TO_CANONICAL: Map<String, String> = linkedMapOf(
        "zh-cn" to "zh-Hans",
        "zh-tw" to "zh-Hant",
    )

    /** The canonical tag → the reported one. Mirrors `REPORTED_TAGS`. */
    val CANONICAL_TO_REPORTED: Map<String, String> =
        REPORTED_TO_CANONICAL.entries.associate { (reported, canonical) -> canonical to reported }

    /** `zh-cn` → `zh-Hans`, `zh-Hant` → `zh-Hant`, `en` → null. Case-insensitive on the tag. */
    fun canonicalTagFor(reportedTag: String): String? = REPORTED_TO_CANONICAL[reportedTag.lowercase()]

    /**
     * A platform language tag (`zh-CN`, `zh-Hans-CN`, `zh-tw`, `zh`) → the canonical tag of the
     * catalog to read, or **null for English**.
     *
     * English is the source language and has no catalog: every English string *is* the key, and
     * `media/main.js`'s `tr()` falls back to it. So `null` is not "no translation found", it is
     * "this phone is an English phone", and the shell injects an empty dictionary.
     *
     * Order matters: a **reported** region id first (that is what VS Code and many phones name),
     * then a script subtag (the more specific fact), then the region. A bare `zh` resolves to
     * Simplified, which is what the language packs themselves report for it.
     */
    fun catalogTagFor(languageTag: String): String? {
        val parts = languageTag.split('-', '_').filter { it.isNotEmpty() }
        if (parts.isEmpty() || !parts[0].equals("zh", ignoreCase = true)) return null

        canonicalTagFor(languageTag)?.let { return it }
        for (part in parts.drop(1)) {
            when {
                part.equals("Hant", ignoreCase = true) -> return "zh-Hant"
                part.equals("Hans", ignoreCase = true) -> return "zh-Hans"
            }
        }
        for (part in parts.drop(1)) {
            when (part.uppercase()) {
                "TW", "HK", "MO" -> return "zh-Hant"
                "CN", "SG", "MY" -> return "zh-Hans"
            }
        }
        return "zh-Hans"
    }
}
