/*
 * session-shim.js — the host half of the message protocol, in the WebView.
 *
 * `media/main.js` line 2 is `const vscode = acquireVsCodeApi();` and that is the file's SINGLE
 * coupling point to a host (there is no other reference to `vscode` in it beyond
 * `vscode.postMessage`). Providing that function is therefore the whole of what an Android
 * host has to invent, and everything above it — the renderer, the tree, the cards, the
 * composer — is the shipped file, unchanged.
 *
 * Directions:
 *   webview -> host   window.acquireVsCodeApi().postMessage(obj)
 *   host -> webview   window.__spinneyHost.receive(jsonText)  (Kotlin calls this)
 *
 * ORDER OF OPERATIONS — which half of the bridge exists when, and why the host holds its
 * messages until `ready`. This order is the contract, not an implementation detail: delivering
 * one step too early loses the frame and, on the `postMessage` route, loses it silently.
 *
 *   1. the document starts parsing; the shell injects the l10n dictionary as one inline
 *      `<script>` first, and then this script — the shell's own first `<script>` — runs, before
 *      anything else the shell loads. It defines `window.acquireVsCodeApi`, then
 *      `window.__spinneyHost.receive`, then binds `window.spinneyControl.onmessage`. From here
 *      on the webview can **send** to the host;
 *   2. the rest of the head is parsed (nothing but the injected dictionary is there), and then
 *      the body, whose scripts run in order: the l10n pass (`session-boot.js`, which must come
 *      after the body exists and **before** the renderer, because it translates the chrome the
 *      renderer then reads), markdown-it, the layout engine, `tree.js`, and last the shipped
 *      `media/main.js` — placing the pass in the head, or `defer`ring it, would run it too late
 *      and clobber `main.js`'s own stateful write to a translated attribute;
 *   3. `media/main.js` registers its `window` `message` listener near the end of the file and
 *      posts `{ type: 'ready' }` at the end of its opening IIFE — the reference renderer's boot
 *      handshake, and the first moment this page can **receive**. Before it, a host→webview
 *      frame has nowhere to land: `receive` would dispatch its `MessageEvent` to a page with no
 *      listener, and on the legacy route (`addJavascriptInterface`, and the `evaluateJavascript`
 *      fallback a null reply proxy takes) it would not get that far — `window.__spinneyHost`
 *      does not exist yet and the frame dies as
 *      `Uncaught TypeError: Cannot read property 'receive' of undefined`;
 *   4. the Kotlin host (`SessionWebView.kt`) has been holding every host→webview message since
 *      `load()`, so it pushes them through in arrival order the instant that `ready` arrives,
 *      and every later message goes straight through. There is no buffer here at all, by
 *      design: the publisher answers `attach` within one round trip of the page load, so the
 *      session's own `tree` is normally the *first* frame held, and a replica that lost it
 *      renders an empty tree with no error to show for it.
 *
 * `ready` arrives on the rendered page's terms, not the host's, which is the point: it is later
 * than step 1, so it is false that "the shim is loaded" means "the page is listening".
 *
 * Two transports exist because one of them is not available on every WebView:
 *   - `window.spinneyControl` is a WebMessageListener injected by `androidx.webkit`
 *     (WebViewCompat.addWebMessageListener). It is the preferred route: it is origin-checked,
 *     it carries a big payload (a phone photo is ~10 MB of base64) without the legacy bridge's
 *     string mangling, and it does not expose a Java object to every page.
 *   - `window.__spinneyAndroid` is the legacy `addJavascriptInterface` bridge, used only when
 *     the WebView does not support the listener. Same messages, same JSON.
 *
 * The dictionary: `window.__spinneyL10n` is injected by the Kotlin host from the repo's own
 * `l10n/bundle.l10n.<tag>.json` (copied into the app's assets), chosen by the phone's locale,
 * with English — the source strings themselves — as the fallback. That is the same lookup
 * `media/main.js`'s `tr()` performs in a VS Code window; the shell's own chrome does the same
 * via `data-l10n*` attributes in `session-boot.js`.
 */
(function () {
  'use strict';

  var webState = null;

  function send(json) {
    try {
      if (window.spinneyControl && typeof window.spinneyControl.postMessage === 'function') {
        window.spinneyControl.postMessage(json);
        return;
      }
      if (window.__spinneyAndroid && typeof window.__spinneyAndroid.postMessage === 'function') {
        window.__spinneyAndroid.postMessage(json);
        return;
      }
      console.error('spinney: no host bridge is present; dropping a message');
    } catch (err) {
      console.error('spinney: cannot post to the host', err);
    }
  }

  function receive(jsonText) {
    var data;
    try {
      data = typeof jsonText === 'string' ? JSON.parse(jsonText) : jsonText;
    } catch (err) {
      console.error('spinney: the host sent something that is not JSON', err);
      return;
    }
    // `media/main.js` listens with `window.addEventListener('message', …)` and reads
    // `event.data`, so a real MessageEvent is what it must receive.
    //
    // Nothing is buffered before that listener exists: the Kotlin host holds every message until
    // `media/main.js` posts `ready` (see the header), which is strictly later than this function
    // being defined, so a frame that reaches here has a listener waiting for it.
    window.dispatchEvent(new MessageEvent('message', { data: data }));
  }

  window.acquireVsCodeApi = function () {
    if (!window.__spinneyApi) {
      window.__spinneyApi = {
        postMessage: function (message) {
          send(JSON.stringify(message));
        },
        getState: function () {
          return webState;
        },
        setState: function (next) {
          webState = next;
          return next;
        },
      };
    }
    return window.__spinneyApi;
  };

  window.__spinneyHost = { receive: receive };

  if (window.spinneyControl) {
    window.spinneyControl.onmessage = function (event) {
      receive(event.data);
    };
  }
})();
