package dev.spinney.remote.app

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.os.Looper
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
 *          --(held until the page says `ready`)--> window.__spinneyHost.receive
 *          --> MessageEvent --> media/main.js
 *
 * media/main.js --> vscode.postMessage --> shim --> spinneyControl/__spinneyAndroid
 *          --> SessionWebView --> §6 routing --> RemoteClient.submit  (or a local action)
 * ```
 *
 * The hold in the middle of that diagram is not an optimisation: the publisher answers this
 * surface's `attach` within a network round trip of `load()`, so the session's first frame
 * (`tree`) usually arrives *while the document is still parsing* — before `media/main.js` has
 * defined anything, and before the renderer has a `message` listener. See [SessionWebHost.deliver].
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
     * composable; called on whichever thread the bridge used, which is the main thread only for
     * the WebMessageListener route — a legacy `@JavascriptInterface` call arrives on the
     * WebView's own bridge thread. A handler that touches the WebView, the held queue or the
     * Compose tree therefore hops first ([onMain]).
     */
    var onMessage: ((String) -> Unit)? = null

    val assets = ShellAssets(context, l10n)

    private var replyProxy: JavaScriptReplyProxy? = null

    /**
     * Host→webview messages that arrived before the page could hear them, in arrival order.
     *
     * The page cannot hear anything until it has run its own scripts, and the moment that is
     * true is the renderer's own `ready`: `media/main.js` installs its `window` `message`
     * listener a hundred lines before the end of the file and posts `ready` at the very end, so
     * `ready` is the first instant at which *both* halves of the bridge exist — the shim's
     * `window.__spinneyHost.receive` (defined when `assets/shell/session-shim.js` runs, in the
     * `<head>`) and the renderer's listener that turns one into a `MessageEvent`. Delivering
     * before that loses the frame on either route: the legacy route throws
     * `Cannot read property 'receive' of undefined` and the frame is gone, while the
     * `postMessage` route dispatches a `MessageEvent` to nobody — the same loss with no symptom
     * at all, which is exactly how a replica that never received a `tree` renders no cards.
     *
     * Same mechanism, same signal, same cap as the desktop replica of the same session
     * (`src/remote/remoteSessionPanel.ts`: "Set by the webview's first `ready`: before that,
     * mirror messages are held"). `WebViewCompat.postWebMessage` was the other candidate and is
     * not the fix: it is only supported where `WEB_MESSAGE_LISTENER` is, and the emulator's
     * error names `__spinneyHost.receive`, the route `evaluateJavascript` takes when
     * `replyProxy` is still null — i.e. the case that has to keep working is the one that API
     * cannot serve.
     */
    private val held = ArrayDeque<String>()

    /** Set by the page's first `ready`: the release for everything in [held]. */
    private var rendererReady = false

    /**
     * The WebMessageListener route carries a big string without the legacy bridge's mangling —
     * a phone photo is ~10 MB of base64 inside one `userMessage` (§8 counts on exactly that).
     * When the platform WebView is too old for it, the legacy `addJavascriptInterface` bridge is
     * used and a reply proxy never appears; [push] then goes through `evaluateJavascript`.
     */
    val usesWebMessageListener: Boolean = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)

    val webView: WebView = buildWebView()

    /**
     * Load the shell. This is a **fresh document**, so the hold starts over: whatever the
     * previous page was told, this one may not be pushed to until its own `ready` arrives.
     */
    fun load() {
        rendererReady = false
        held.clear()
        webView.loadUrl(assets.shellUrl)
    }

    /**
     * Push one host→webview message into the page, verbatim, once the page can hear it.
     *
     * Before the page's `ready` the message is *held* rather than dropped or thrown at a global
     * that does not exist yet (see [held]); `ready` then releases the hold in arrival order, and
     * every later message goes straight through. Held, not merged: the frames that matter are
     * the publisher's answer to this surface's `attach`, and reordering or coalescing them here
     * would be a second, silent copy of the protocol's ordering rules.
     */
    fun deliver(messageJson: String) {
        onMain {
            if (!rendererReady) {
                // A cap, never a queue — the same number as the desktop replica's MAX_HELD. A
                // document that never reports `ready` (a broken asset, a syntax error, a dead
                // page) must not grow this list without bound; `tree` is the whole state, so the
                // newest frames are the ones worth keeping.
                if (held.size >= MAX_HELD) held.removeFirst()
                held.addLast(messageJson)
                return@onMain
            }
            push(messageJson)
        }
    }

    /**
     * The page announced its boot handshake (`{"type":"ready"}` from `media/main.js`) — the one
     * signal that says "there is a listener on the other side of `receive` now". Release the
     * hold.
     */
    fun rendererReady() {
        onMain {
            if (rendererReady) return@onMain
            rendererReady = true
            // Drain before anything newer can be pushed, so a frame that arrived during the
            // load is still rendered before the frame that arrived after it.
            val queued = held.toList()
            held.clear()
            for (messageJson in queued) push(messageJson)
        }
    }

    /** Hand one message to the page. Only meaningful once the page can hear it. */
    private fun push(messageJson: String) {
        val proxy = replyProxy
        if (proxy != null) {
            proxy.postMessage(messageJson)
        } else {
            // `JSONObject.quote` is the JSON string literal the page needs; the payload is the
            // publisher's bytes and is not re-encoded anywhere else.
            webView.evaluateJavascript(
                "window.__spinneyHost.receive(${JSONObject.quote(messageJson)})",
                null,
            )
        }
    }

    /**
     * Run [block] on the thread that owns the WebView.
     *
     * Only the WebMessageListener route is main-thread by contract; a legacy
     * `@JavascriptInterface` call arrives on the WebView's own bridge thread, and `replyProxy`,
     * [held], [rendererReady], `postMessage` and `evaluateJavascript` are all main-thread state.
     * Posting through the WebView's handler makes the two routes behave identically, and keeps
     * their order: a [deliver] and a [rendererReady] reached in that order are queued in it.
     */
    private fun onMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else webView.post(Runnable(block))
    }

    fun destroy() {
        replyProxy = null
        onMessage = null
        // A destroyed page can never report `ready`, and its held frames belong to it alone.
        rendererReady = false
        held.clear()
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
            // The shell carries a viewport meta (`width=device-width, initial-scale=1.0`), so the
            // WebView has to honour it: Android's default is `useWideViewPort = false`, which
            // *ignores* the meta and computes the layout viewport itself — and on API 28 that
            // came out 393x**0** while the view was 393x719, so `html{height:100%}`, `100vh` and
            // `#tree-wrap` all resolved to 0 and the tree was drawn and then clipped away
            // entirely (measured). This setting is what makes the API-28 emulator right.
            //
            // It is not the whole story, and the difference matters. The phone (HarmonyOS, WebView
            // 114) *does* honour the meta — its layout viewport is the full 764x268 CSS px and its
            // `documentElement.clientHeight` agrees — and still resolves `height: 100%`, `100vh`,
            // `100dvh`, `100svh` and `100lvh` to **0** for the document it is given, so the tree
            // is laid out 0 tall and paints nothing while the toolbar above it draws. No setting
            // here reaches that: the fix is the shell's own stylesheet,
            // `assets/shell/session-viewport.css`, which anchors `body` to the viewport instead of
            // to the percentage chain (generated with the shell by
            // `remote/android/tools/gen-shell.js`; difference 4 in the shell's banner carries the
            // measurement). Do not delete it as a duplicate of `media/style.css`: it is the fix.
            useWideViewPort = true
            loadWithOverviewMode = false // honour the meta; never zoom out to fit content
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

        /**
         * How many host→webview messages are held before the page's first `ready`. The same
         * figure, and the same meaning, as `MAX_HELD` in `src/remote/remoteSessionPanel.ts`.
         */
        const val MAX_HELD = 400
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
            type == "ready" -> host.rendererReady() // this surface's own boot handshake, deliberately never forwarded (§6) — and the release for every frame the host held while this document was loading (§5)
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
