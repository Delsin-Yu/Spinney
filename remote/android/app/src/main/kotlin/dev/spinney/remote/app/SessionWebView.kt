package dev.spinney.remote.app

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import dev.spinney.remote.core.MirrorPolicy
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import org.json.JSONObject
import dev.spinney.remote.core.RemoteClient

/**
 * The replicated session view: **the repo's own renderer, in a WebView.**
 *
 * This composable adds no rendering of its own. It loads `assets/shell/session.html` — the DOM
 * `ChatViewProvider.getHtml()` renders, plus the shim that supplies `acquireVsCodeApi()` — and
 * that shell loads the copied `media/main.js`, `tree.js`, the vendored layout engine, the
 * vendored markdown-it and `style.css`. `remote/PROTOCOL.md` §5 and
 * `docs/agents/plans/remote-control.md` §5: one renderer, three places. A rendering difference
 * between the phone and the desktop tab is therefore always a transport defect, never a
 * renderer difference — which is only true while this file stays as thin as it is.
 *
 * The message flow, in both directions:
 *
 * ```
 * publisher --(sealed mirror frame)--> RemoteClient --(SharedFlow)--> host.deliver(json)
 *          --> window.__spinneyHost.receive --> MessageEvent --> media/main.js
 *
 * media/main.js --> vscode.postMessage --> shim --> spinneyControl/__spinneyAndroid
 *          --> SessionWebView --> §6 routing --> RemoteClient.submit  (or a local action)
 * ```
 *
 * §6's routing is `MirrorPolicy`: a message that acts on this phone (the clipboard, a link, the
 * image picker) is handled here; a message that acts on the session is submitted verbatim; a
 * type on neither list is refused and *said so*, never silently dropped.
 */
class SessionWebHost(
    private val context: Context,
    private val l10n: L10n,
) {

    /**
     * Every webview→host message, as the JSON text `media/main.js` produced. Set by the
     * composable; called on the main thread (the WebView bridge always is).
     */
    var onMessage: ((String) -> Unit)? = null

    val assets = ShellAssets(context, l10n)

    private var replyProxy: JavaScriptReplyProxy? = null

    /**
     * The WebMessageListener route carries a big string without the legacy bridge's mangling —
     * a phone photo is ~10 MB of base64 inside one `userMessage` (§8 counts on exactly that).
     * When the platform WebView is too old for it, the legacy `addJavascriptInterface` bridge is
     * used and a reply proxy never appears; [deliver] then goes through `evaluateJavascript`.
     */
    val usesWebMessageListener: Boolean = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)

    val webView: WebView = buildWebView()

    fun load() {
        webView.loadUrl(assets.shellUrl)
    }

    /** Push one host→webview message into the page, verbatim. Main thread only. */
    fun deliver(messageJson: String) {
        val post = Runnable {
            val proxy = replyProxy
            if (proxy != null) {
                proxy.postMessage(messageJson)
            } else {
                // `JSONObject.quote` is the JSON string literal the page needs; the payload is
                // the publisher's bytes and is not re-encoded anywhere else.
                webView.evaluateJavascript(
                    "window.__spinneyHost.receive(${JSONObject.quote(messageJson)})",
                    null,
                )
            }
        }
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) post.run() else webView.post(post)
    }

    fun destroy() {
        replyProxy = null
        onMessage = null
        webView.destroy()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildWebView(): WebView {
        val webView = WebView(context)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true // media/main.js keeps per-surface state in localStorage
            // No file or content access: everything the page may read is served by ShellAssets,
            // and a `file://` origin would be a way out of that origin's sandbox.
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            builtInZoomControls = false
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_NO_CACHE
            // The page is a control surface, not a document: it must not be able to navigate
            // away from the app's own origin.
            setGeolocationEnabled(false)
        }
        webView.setBackgroundColor(Color.TRANSPARENT)
        webView.isHorizontalScrollBarEnabled = false
        webView.webViewClient = object : androidx.webkit.WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assets.intercept(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (url.startsWith(assets.origin)) return false
                // A link is opened where it was *clicked* (§3): media/main.js posts
                // `openExternal` and the Kotlin host opens it with an Intent, so the WebView
                // itself must never follow one.
                onMessage?.invoke("""{"type":"openExternal","url":${JSONObject.quote(url)}}""")
                return true
            }
        }

        if (usesWebMessageListener) {
            WebViewCompat.addWebMessageListener(
                webView,
                BRIDGE_NAME,
                setOf(assets.origin),
                object : WebViewCompat.WebMessageListener {
                    override fun onPostMessage(
                        view: WebView,
                        message: WebMessageCompat,
                        sourceOrigin: Uri,
                        isMainFrame: Boolean,
                        replyProxy: JavaScriptReplyProxy,
                    ) {
                        this@SessionWebHost.replyProxy = replyProxy
                        val data = message.data ?: return
                        onMessage?.invoke(data)
                    }
                },
            )
        } else {
            webView.addJavascriptInterface(
                object {
                    @JavascriptInterface
                    fun postMessage(json: String) {
                        onMessage?.invoke(json)
                    }
                },
                LEGACY_BRIDGE_NAME,
            )
        }
        return webView
    }

    companion object {
        /** The global the shim looks for (`session-shim.js`). */
        const val BRIDGE_NAME = "spinneyControl"

        /** The legacy fallback's global, used only when the listener is unavailable. */
        const val LEGACY_BRIDGE_NAME = "__spinneyAndroid"
    }
}

/**
 * One replicated session on screen: the shipped renderer in a WebView.
 *
 * [host] is created and owned by the caller, because the caller also has to push one message
 * *into* the page the webview cannot produce itself (`imagePicked`, after the system photo
 * picker returns). [onLocal] is called for a webview→host message that acts on this phone and
 * must be handled here (§6): the clipboard, opening a link, the image picker. [onNotice] shows a
 * one-line explanation when a message is refused — a refused action that says nothing is the
 * kind of silence that gets debugged for an afternoon.
 */
@Composable
fun SessionWebView(
    sessionId: String,
    client: RemoteClient,
    l10n: L10n,
    host: SessionWebHost,
    onLocal: (type: String, message: JSONObject) -> Unit,
    onNotice: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    host.onMessage = { json ->
        val (type, message) = try {
            val obj = JSONObject(json)
            obj.optString("type") to obj
        } catch (err: org.json.JSONException) {
            null to null
        }
        when {
            type == null || message == null -> onNotice(l10n.t("The session sent a message this phone cannot read."))
            type == "ready" -> Unit // this surface's own boot handshake, deliberately never forwarded (§6)
            MirrorPolicy.routeWebviewMessage(type) == MirrorPolicy.Route.LOCAL -> onLocal(type, message)
            MirrorPolicy.routeWebviewMessage(type) == MirrorPolicy.Route.INPUT_UP -> {
                if (!client.submit(sessionId, json)) {
                    onNotice(l10n.t("The room refused that action."))
                }
            }
            else -> onNotice(l10n.t("'{0}' acts on the machine it is operating and is not sent anywhere.", type))
        }
    }

    DisposableEffect(sessionId) {
        onDispose { client.detach(sessionId) }
    }
    DisposableEffect(host) {
        onDispose { host.destroy() }
    }

    LaunchedEffect(sessionId, host) {
        // A fresh page per session: nothing from the previous session's DOM may survive into
        // this one, and the publisher re-sends everything a newly opened webview would get.
        host.load()
        // Subscribe before attaching: the publisher answers an `attach` immediately, and a
        // mirror frame emitted with no collector would be dropped (the flow has no replay).
        val collector = launch {
            client.mirror.collect { message ->
                if (message.sessionId == sessionId) host.deliver(message.messageJson)
            }
        }
        client.awaitMirrorCollector()
        client.attach(sessionId)
        awaitCancellation()
        collector.cancel()
    }

    AndroidView(
        modifier = modifier,
        factory = { host.webView },
    )
}
