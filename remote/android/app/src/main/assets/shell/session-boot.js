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
 *
 * WHERE IT RUNS, AND WHY THERE. This is the shell chrome's l10n pass, so it reads the *document*:
 * it has to run once the elements carrying `data-l10n*` exist, and before the renderer that
 * overwrites some of them. It is therefore the last script of the static chrome and the first
 * script of the body's script block, immediately before `media/main.js` — `assets/shell/session.html`
 * carries the placement comment, and `remote/android/tools/gen-shell.js` emits it, so the two
 * cannot drift. It was a `<head>` script first, which is exactly the bug this placement fixes:
 * there the body did not exist, the walk below selected nothing, and the phone showed Send and
 * Stop with no text at all.
 */
(function () {
  'use strict';

  // The one precondition this file cannot express by what it produces: it walks the body.
  //
  // Misplaced in the <head>, every `querySelectorAll` below still ran, selected nothing and threw
  // nothing — the shell's chrome just stayed empty, with no error anywhere on the phone to say
  // why. A pass that cannot see what it is supposed to translate is a placement bug, so it says
  // so out loud instead of no-opping.
  if (!document.body) {
    console.error(
      'spinney: session-boot.js ran before <body> existed (it is loaded from the <head>): every ' +
        'data-l10n* label on the page stays empty. Load it at the end of the body, after the ' +
        'chrome it translates and before media/main.js.',
    );
  }

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
