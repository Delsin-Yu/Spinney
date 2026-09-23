package dev.spinney.remote.app

import android.content.Context
import dev.spinney.remote.core.JsonValue
import dev.spinney.remote.core.LanguageTags
import java.util.Locale

/**
 * The webview's dictionary, and the app chrome's, from the repo's own catalogs.
 *
 * A VS Code window has `vscode.l10n` and the host injects the whole catalog as
 * `window.__spinneyL10n` (`ChatViewProvider.getHtml`, `media/main.js`'s `tr()`). A WebView has
 * no `vscode.l10n`, so the same job is done here: pick the catalog for the phone's locale out
 * of `assets/l10n/` — which `tools/sync-remote-assets.js` copies from `l10n/` and
 * `tools/check-remote-assets.js` keeps identical to it — and inject it at the shell's
 * `<!--SPINNEY_L10N-->` marker.
 *
 * English is the **source language** and has no catalog file: `l10n/` holds only the two
 * Chinese catalogs, and every English string in the product *is* the key. So "no catalog" is
 * not an error and not a missing translation — it is [dictionary] being empty and every lookup
 * returning the English source string, which is exactly what an English VS Code window does.
 *
 * The app's own chrome uses [t] with the same keys, so a Chinese phone shows Chinese chrome
 * where the desktop already has a translation, and English where it does not.
 */
class L10n(private val context: Context) {

    /** What the platform reports for this phone, e.g. `zh-CN`, `zh-Hans-CN`, `en-US`. */
    val reportedLanguageTag: String = Locale.getDefault().toLanguageTag()

    /**
     * The catalog tag in the app's assets, or null for English (the source language).
     *
     * The phone's reported tag is **canonicalised before anything is looked up**:
     * `zh-CN` → `zh-Hans`, `zh-tw` → `zh-Hant`, a bare `zh` → `zh-Hans`, English → null. That is
     * the same mapping `src/languageTags.ts` writes for the extension host, and it is what makes
     * the reported-tag alias catalogs (`l10n/bundle.l10n.zh-cn.json`, which
     * `tools/sync-l10n-aliases.js` writes for as long as `vsce` is reading the tree) **unnecessary
     * on Android**: they are a `vsce` build artifact, they are gitignored, not one byte of them is
     * copied into the APK, and a phone that reported `zh-cn` reads `bundle.l10n.zh-Hans.json`
     * directly.
     */
    val catalogTag: String? = LanguageTags.catalogTagFor(reportedLanguageTag)

    /** The tag whose catalog is actually loaded, or null when English (the source language) is used. */
    val tag: String? = catalogTag?.takeIf { assetExists(it) }

    /** `<html lang="…">` — the canonical tag the webview reports, English included. */
    val htmlLang: String = tag ?: "en"

    private val raw: String? = tag?.let { readAsset(context, "l10n/bundle.l10n.$it.json") }

    /** The catalog as a plain map. Empty for English, and empty for a catalog that will not parse. */
    val dictionary: Map<String, String> = run {
        val text = raw ?: return@run emptyMap()
        val parsed = try {
            JsonValue.parse(text) as? JsonValue.Obj
        } catch (err: IllegalArgumentException) {
            null
        }
        parsed?.fields?.mapNotNull { (key, value) ->
            (value as? JsonValue.Str)?.let { key to it.value }
        }?.toMap() ?: emptyMap()
    }

    /** The lookup `media/main.js`'s `tr()` performs: the catalog, else the English source. */
    fun t(message: String, vararg args: String): String {
        var text = dictionary[message] ?: message
        args.forEachIndexed { index, value -> text = text.replace("{$index}", value) }
        return text
    }

    /**
     * The inline script the shell needs, nonce'd against the shell's own CSP. `<` is escaped
     * the way `ChatViewProvider.getHtml` escapes its dictionary, because the bytes land inside
     * a `<script>` element in an HTML document.
     */
    fun injectionScript(nonce: String): String {
        val json = (raw ?: "{}").replace("<", "\\u003c")
        return "<script nonce=\"$nonce\">window.__spinneyL10n = $json;" +
            "document.documentElement.lang = ${JsonValue.of(htmlLang).toJson()};</script>"
    }

    /** Printed, never the token: which catalog the phone picked, and how big it is. */
    fun describe(): String = "locale=$reportedLanguageTag catalog=${tag ?: "en (source)"} strings=${dictionary.size}"

    private fun assetExists(tag: String): Boolean =
        runCatching { context.assets.list("l10n")?.toSet() ?: emptySet() }.getOrDefault(emptySet())
            .contains("bundle.l10n.$tag.json")

    companion object {

        private fun readAsset(context: Context, name: String): String? =
            runCatching { context.assets.open(name).bufferedReader().use { it.readText() } }.getOrNull()
    }
}
