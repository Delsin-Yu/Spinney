/*
 * session-boot.js — translate the shell's own chrome out of the injected dictionary.
 *
 * `media/main.js` translates its own strings with `tr()`, which reads `window.__spinneyL10n`.
 * The shell that hosts it also renders chrome the host normally renders (`ChatViewProvider.getHtml()`):
 * the toolbar buttons' titles, the composer's placeholder, the meter row's tooltips, Stop and
 * Send. In a VS Code window those come from `vscode.l10n.t`. A WebView has no `vscode.l10n`, so
 * the same English source string is carried in a `data-l10n*` attribute here and looked up in
 * the dictionary the host injected — one catalog, one key, no second translation table.
 *
 * A string the catalog does not carry falls back to the attribute itself, which is the English
 * source, so this file is also correct in an English window and against a stale bundle.
 */
(function () {
  'use strict';

  var dict = window.__spinneyL10n || {};

  function t(message) {
    var text = dict[message] || message;
    // `{0}`, `{1}`, … are the placeholders, exactly like `vscode.l10n.t`. The shell's own
    // strings carry none today; the loop is here so a future one cannot be silently dropped.
    for (var i = 1; i < arguments.length; i++) {
      text = text.split('{' + (i - 1) + '}').join(String(arguments[i]));
    }
    return text;
  }

  function each(attribute, apply) {
    var nodes = document.querySelectorAll('[' + attribute + ']');
    for (var i = 0; i < nodes.length; i++) {
      apply(nodes[i], nodes[i].getAttribute(attribute));
    }
  }

  each('data-l10n', function (node, key) {
    node.textContent = t(key);
  });
  each('data-l10n-title', function (node, key) {
    node.title = t(key);
  });
  each('data-l10n-placeholder', function (node, key) {
    node.placeholder = t(key);
  });
  each('data-l10n-aria', function (node, key) {
    node.setAttribute('aria-label', t(key));
  });

  // Exposed so the Kotlin host can translate its own chrome with the same lookup.
  window.__spinneyT = t;
})();
