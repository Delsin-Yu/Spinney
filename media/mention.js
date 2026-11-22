/*
 * Mention syntax — the `@` trigger and the wash, as pure functions. No DOM, no host.
 *
 * WHY IT IS A SCRIPT OF ITS OWN
 * The `@` file picker has exactly one piece that both sides must agree on byte for byte:
 * where a token starts, where it ends, and what replacing it does to the buffer. The
 * webview needs it inside the caret handlers of `media/main.js`, and the build-time guard
 * needs to drive the same rules from Node without a browser — a second copy on the host
 * side that could drift from the webview's would defeat the point. So it lives here, in a
 * file that touches nothing but `window`, and is loaded by the HTML shell as its own
 * `<script>` before `media/main.js` (exactly like `media/tree.js`, which the shell loads
 * for the same reason and which ends the same way — `window.treeLayout = { … }`).
 *
 * HOW THE GUARD RUNS IT
 * `tools/check-tree-grid.js` is the pattern: a `vm` context with `ctx.window = ctx`, the
 * webview's own bytes `vm.runInContext`-ed into it, and then the arithmetic checked from
 * outside. `tools/check-mention.js` does the same for this file, so the rules below are
 * asserted on the shipped bytes. Anything that needed a `document` here would make that
 * impossible — keep it out.
 *
 * THE TWO RULES (the frozen plan, §3)
 *   * TRIGGER — walk back from the caret to the nearest `@` that is at index 0 or preceded
 *     by whitespace or one of `([{"'`; no whitespace may appear between that `@` and the
 *     caret. `foo@bar.com` therefore never triggers (`@` follows a word character), and
 *     `@Component(` in pasted code does (the menu is non-modal, and a query with no
 *     matches closes it).
 *   * WASH — accepting a row replaces the WHOLE token with the path, so no `@` ever
 *     survives in the buffer and no `@` can ever reach the model. The `@` is a trigger and
 *     nothing else: what the model reads is what the user would have typed by hand.
 *
 * ES5 (no arrow functions, no `let` / `const`, no template literals): this file is loaded
 * by the webview and by Node's `vm` alike, and nothing here needs more than that.
 */
(function () {
  'use strict';

  /** A character the `@` may directly follow (index 0 is handled separately). */
  var TRIGGER_PREFIX = '([{"\'';

  /** A string, from anything: the callers pass DOM values that may be absent. */
  function asText(value) {
    if (typeof value === 'string') return value;
    return value === undefined || value === null ? '' : String(value);
  }

  /** Whitespace, per the one definition the trigger and the token end share. */
  function isSpace(ch) {
    return ch !== '' && /\s/.test(ch);
  }

  /**
   * The `@` token under the caret, or null.
   *
   * value: the textarea's value. caret: its selectionStart.
   * -> { at, query, end }, where `end` is the first whitespace at or after the caret, or
   *    the value's length. `end` is deliberately not "the end of the query": accepting a
   *    row washes out everything up to that whitespace, so a caret parked in the middle of
   *    `@src/a.ts` still replaces the whole word.
   */
  function token(value, caret) {
    var text = asText(value);
    var atCaret = typeof caret === 'number' && isFinite(caret) ? Math.floor(caret) : text.length;
    if (atCaret < 0) atCaret = 0;
    if (atCaret > text.length) atCaret = text.length;

    var at = -1;
    var i;
    for (i = atCaret - 1; i >= 0; i--) {
      var ch = text.charAt(i);
      if (ch === '@') {
        at = i;
        break;
      }
      // Whitespace between the caret and any `@` means there is no token at the caret at
      // all — this is what stops a query from running away across a sentence.
      if (isSpace(ch)) return null;
    }
    if (at < 0) return null;
    if (at > 0) {
      var prev = text.charAt(at - 1);
      // The `@` must start the token: index 0, whitespace, or an opening bracket / quote.
      // A word character before it is an email address or a decorator, never a reference.
      if (!isSpace(prev) && TRIGGER_PREFIX.indexOf(prev) < 0) return null;
    }

    var end = atCaret;
    while (end < text.length && !isSpace(text.charAt(end))) end++;
    return { at: at, query: text.slice(at + 1, atCaret), end: end };
  }

  /**
   * Replace the WHOLE token with `insert`. -> { value, caret }.
   *
   * The trailing space is the one detail that keeps a path usable: when the character
   * after the replaced token is neither whitespace nor the end of the buffer, exactly one
   * space is added, so `@a.ts` followed by `please` becomes `a.ts please` rather than
   * `a.tsplease`. The caret lands after everything just inserted.
   */
  function wash(value, token, insert) {
    var text = asText(value);
    var payload = asText(insert);
    var at = -1;
    var end = -1;
    if (token && typeof token === 'object') {
      if (typeof token.at === 'number') at = Math.floor(token.at);
      if (typeof token.end === 'number') end = Math.floor(token.end);
    }
    // Defensive only: every caller passes a token built by `token()`. With nothing to go
    // on, the insertion goes to the end of the buffer rather than to its start.
    if (at < 0 || at > text.length) at = text.length;
    if (end < at || end > text.length) end = at;

    var before = text.slice(0, at);
    var after = text.slice(end);
    var space = after !== '' && !isSpace(after.charAt(0)) ? ' ' : '';
    return {
      value: before + payload + space + after,
      caret: before.length + payload.length + space.length,
    };
  }

  /**
   * `"…"` around a path that needs it — one with whitespace or a `"` in it — otherwise the
   * path unchanged. A path that already arrives quoted stays as it is, so quoting can
   * never double up.
   */
  function quotePath(path) {
    var text = asText(path);
    if (text === '') return '';
    if (text.length > 1 && text.charAt(0) === '"' && text.charAt(text.length - 1) === '"') return text;
    return /[\s"]/.test(text) ? '"' + text + '"' : text;
  }

  window.mentionSyntax = {
    token: token,
    wash: wash,
    quotePath: quotePath,
  };
})();
