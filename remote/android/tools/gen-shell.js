// One-off: derive remote/android/app/src/main/assets/shell/session.html from the host's
// getHtml() template in src/chat/ChatViewProvider.ts. Deleted after use — the shell is a
// committed, hand-maintained mirror of that template (see remote/android/README.md).
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..', '..');
const src = fs.readFileSync(path.join(root, 'src', 'chat', 'ChatViewProvider.ts'), 'utf8').split(/\r?\n/);
const start = src.findIndex((line) => line.includes('return `<!DOCTYPE html>'));
const end = src.findIndex((line, i) => i > start && line.trim() === '</html>`;');
if (start < 0 || end < 0) {
  console.error("cannot find getHtml()'s template literal");
  process.exit(1);
}
let html = src.slice(start, end + 1).join('\n').replace(/^\s*return `/, '').replace(/`;\s*$/, '');

const l10n = (kind, key) =>
  kind === 'title' ? `data-l10n-title="${key}"` :
  kind === 'placeholder' ? `data-l10n-placeholder="${key}"` :
  kind === 'aria' ? `data-l10n-aria="${key}"` :
  `data-l10n="${key}"`;

html = html
  .replace(/lang="\$\{displayLocale\(\)\}"/, 'lang="en"')
  .replace(/<meta name="viewport"[^\n]*/, '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />')
  .replace(
    /\s*<meta http-equiv="Content-Security-Policy"[^\n]*/,
    '\n  <meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\' \'nonce-<!--SPINNEY_NONCE-->\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: https:; font-src \'self\'; connect-src \'none\';" />',
  )
  .replace(/<script nonce="\$\{nonce\}">window\.__spinneyL10n = \$\{l10n\};<\/script>/, '<!--SPINNEY_L10N-->')
  .replace('<link rel="stylesheet" href="${styleUri}" />', '<link rel="stylesheet" href="/assets/webview/style.css" />')
  .replace(/<script nonce="\$\{nonce\}" src="\$\{markdownItUri\}"><\/script>/, '<script src="/assets/webview/vendor/markdown-it/markdown-it.min.js"></script>')
  .replace(/<script nonce="\$\{nonce\}" src="\$\{layoutEngineUri\}"><\/script>/, '<script src="/assets/webview/vendor/non-layered-tidy-tree-layout/dist/non-layered-tidy-tree-layout.js"></script>')
  .replace(/<script nonce="\$\{nonce\}" src="\$\{treeUri\}"><\/script>/, '<script src="/assets/webview/tree.js"></script>')
  .replace(/<script nonce="\$\{nonce\}" src="\$\{scriptUri\}"><\/script>/, '<script src="/assets/webview/main.js"></script>')
  // Text content: the attribute has to move into the opening tag of the element.
  .replace(/>\$\{vscode\.l10n\.t\('([^']*)'\)\}</g, (m, key) => ` ${l10n('text', key)}><`)
  .replace(/title="\$\{vscode\.l10n\.t\('([^']*)'\)\}"/g, (m, key) => l10n('title', key))
  .replace(/aria-label="\$\{vscode\.l10n\.t\('([^']*)'\)\}"/g, (m, key) => l10n('aria', key))
  .replace(/placeholder="\$\{vscode\.l10n\.t\('([^']*)'\)\}"/g, (m, key) => l10n('placeholder', key));

const leftovers = html.match(/\$\{[^}]*\}/g);
if (leftovers) {
  console.error('unsubstituted template expressions:', leftovers);
  process.exit(1);
}

const banner = `<!DOCTYPE html>
<!--
  The Android WebView shell for a replicated remote session.

  This is NOT a second renderer. It is the DOM the extension host renders in
  \`src/chat/ChatViewProvider.ts\` \`getHtml()\`, with exactly three differences:

    1. the asset URLs point at the app's own assets (\`assets/webview/**\`, copied from
       \`media/**\` by \`tools/sync-remote-assets.js\` and guarded byte for byte by
       \`tools/check-remote-assets.js\`), because a phone has no extension host to serve
       \`vscode-webview://\` URIs;
    2. \`window.__spinneyL10n\` is injected by the Kotlin host (see \`ShellAssets.kt\`) at the
       \`<!--SPINNEY_L10N-->\` marker instead of by a \`vscode.l10n\` call, and the host-rendered
       chrome below reads its own strings out of the same dictionary through \`data-l10n*\`
       attributes, because a webview has no \`vscode.l10n\`;
    3. the CSP carries a per-load nonce for that one injected inline script and pins
       \`connect-src 'none'\` — the session view talks to the publisher through the Kotlin host,
       never through a fetch of its own.

  Everything else here is a copy of the host's shell and must stay one: a DOM id that
  \`media/main.js\` looks up and does not find on the phone would fail in a way the desktop tab
  cannot, and that would be a renderer divergence by the back door. When \`getHtml()\` grows an
  element, this file grows it too — there is no guard for that pairing, and the README says so.
-->

`;

const shim = `  <!-- The host half of the message protocol: acquireVsCodeApi() and the l10n dictionary. -->
  <script src="/assets/shell/session-shim.js"></script>
  <script src="/assets/shell/session-boot.js"></script>
</head>`;

const out = (banner + html.replace(/^<!DOCTYPE html>\n/, ''))
  .replace(/<\/head>/, shim)
  .replace(/\r\n/g, '\n');

const dest = path.join(root, 'remote', 'android', 'app', 'src', 'main', 'assets', 'shell', 'session.html');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, out);
console.log('wrote ' + path.relative(root, dest) + ' (' + out.length + ' bytes)');
