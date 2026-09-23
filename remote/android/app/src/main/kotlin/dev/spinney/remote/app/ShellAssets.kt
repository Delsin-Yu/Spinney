package dev.spinney.remote.app

import android.content.Context
import android.net.Uri
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream
import java.security.SecureRandom

/**
 * Serves the app's assets to the session WebView, and injects the two things the shell cannot
 * carry itself.
 *
 * `WebViewAssetLoader` serves `assets/` under `https://appassets.androidplatform.net/`, which is
 * the only way to give a WebView a normal https origin (`file://` origins break `fetch`,
 * `localStorage` and origin checks). The whole session view therefore runs at one origin:
 *
 * ```
 * https://appassets.androidplatform.net/assets/shell/session.html     the shell (rewritten here)
 * https://appassets.androidplatform.net/assets/webview/main.js        copied from media/main.js
 * https://appassets.androidplatform.net/assets/webview/vendor/…       the vendored engine
 * https://appassets.androidplatform.net/assets/l10n/bundle.l10n.….json the shipped catalogs
 * ```
 *
 * Only `session.html` is rewritten, and only at two markers:
 *
 * - `<!--SPINNEY_NONCE-->` — a per-load nonce in the shell's own CSP. The desktop host does the
 *   same thing from `getHtml()`; without it the one inline script below could not run, and with
 *   `'unsafe-inline'` instead the CSP would stop meaning anything for the renderer that displays
 *   model output.
 * - `<!--SPINNEY_L10N-->` — the whole catalog as `window.__spinneyL10n`, which is what a
 *   VS Code window injects and what `media/main.js`'s `tr()` reads. `<` is escaped to `\u003c`,
 *   exactly as `ChatViewProvider.getHtml` escapes it, because the bytes land inside a `<script>`
 *   element.
 *
 * Nothing else is touched: the whole of `assets/webview/` is served byte for byte as the committed copy of
 * `media/`, because that byte-identity is the whole point of the renderer being shared.
 */
class ShellAssets(private val context: Context, private val l10n: L10n) {

    /** The origin every asset URL in the shell resolves against. */
    val origin: String = "https://$DOMAIN"

    /** The shell's URL — the one the WebView loads, and the only rewritten resource. */
    val shellUrl: String = "$origin/assets/$SHELL_PATH"

    /** A per-load CSP nonce, 32 characters like the host's (`ChatViewProvider.getNonce`). */
    val nonce: String = buildString(32) {
        val random = SecureRandom()
        repeat(32) { append(ALPHABET[random.nextInt(ALPHABET.length)]) }
    }

    private val loader: WebViewAssetLoader = WebViewAssetLoader.Builder()
        .setDomain(DOMAIN)
        .addPathHandler("/assets/", ShellPathHandler(context, l10n, nonce))
        .build()

    fun intercept(url: Uri): WebResourceResponse? = loader.shouldInterceptRequest(url)

    companion object {
        const val DOMAIN = "appassets.androidplatform.net"
        private const val SHELL_PATH = "shell/session.html"
        private const val NONCE_MARKER = "<!--SPINNEY_NONCE-->"
        private const val L10N_MARKER = "<!--SPINNEY_L10N-->"
        private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    }

    /**
     * Delegates to the stock assets handler and rewrites the shell on the way through. The
     * rewrite happens per request, so changing the phone's locale and reopening the session is
     * enough to change the language — there is no cached HTML to invalidate.
     */
    private class ShellPathHandler(
        context: Context,
        private val l10n: L10n,
        private val nonce: String,
    ) : WebViewAssetLoader.PathHandler {

        private val assets = WebViewAssetLoader.AssetsPathHandler(context)
        private val appContext = context.applicationContext

        override fun handle(path: String): WebResourceResponse? {
            val normalized = path.removePrefix("/")
            if (normalized != SHELL_PATH) {
                return assets.handle(path)
            }

            val html = try {
                appContext.assets.open(SHELL_PATH).bufferedReader().use { it.readText() }
            } catch (err: java.io.IOException) {
                return WebResourceResponse(
                    "text/plain",
                    "utf-8",
                    500,
                    "shell missing",
                    mapOf("Cache-Control" to "no-store"),
                    ByteArrayInputStream("the shell asset is missing; run `node tools/sync-remote-assets.js`".toByteArray()),
                )
            }

            // Nonce first: the injected script carries it, and its own JSON cannot contain the
            // marker (a `<` in the dictionary is escaped below).
            val rewritten = html
                .replace(NONCE_MARKER, nonce)
                .replace(L10N_MARKER, l10n.injectionScript(nonce))

            return WebResourceResponse(
                "text/html",
                "utf-8",
                200,
                "OK",
                mapOf("Cache-Control" to "no-store"),
                ByteArrayInputStream(rewritten.toByteArray(Charsets.UTF_8)),
            )
        }
    }
}
