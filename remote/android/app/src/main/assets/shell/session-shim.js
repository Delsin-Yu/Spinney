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
