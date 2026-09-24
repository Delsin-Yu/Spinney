// One-off: derive remote/android/app/src/main/assets/shell/session.html from the host's
// getHtml() template (today `src/chat/webviewShell.ts`; `ChatViewProvider.ts`, which the manifest
// still names, was where it lived before the two shells were unified). Deleted after use — the
// shell is a committed, hand-maintained mirror of that template (see remote/android/README.md).
//
// It must reproduce the committed shell, including the three rewrites and the one placement the
// mirror adds: the l10n pass (`assets/shell/session-boot.js`) belongs in the body, after the
// chrome it translates and before `media/main.js`. Emitting it in the <head> again is what left
// the phone's Send/Stop buttons with no text, so the placement is written out here in full —
// comment included — and is verified by regenerating and diffing, not by this comment.
//
//   node remote/android/tools/gen-shell.js && git diff --stat remote/android/app/src/main/assets/shell/session.html
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..', '..');
const manifestPath = path.join(__dirname, '..', 'remote-assets.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
// Same candidate order as `tools/check-remote-assets.js` rule 7, for the same reason: the host's
// shell moved, and a generator that only looks where it used to be fails instead of regenerating.
const templatePath = [path.join(root, 'src', 'chat', 'webviewShell.ts'), path.join(root, manifest.shell.template)].find(
  (candidate) => fs.existsSync(candidate),
);
if (!templatePath) {
  console.error('cannot find the host shell template: tried src/chat/webviewShell.ts and ' + manifest.shell.template);
  process.exit(1);
}
const src = fs.readFileSync(templatePath, 'utf8').split(/\r?\n/);
const start = src.findIndex((line) => line.includes('return `<!DOCTYPE html>'));
const end = src.findIndex((line, i) => i > start && line.trim() === '</html>`;');
if (start < 0 || end < 0) {
  console.error("cannot find getHtml()'s template literal in " + path.relative(root, templatePath));
  process.exit(1);
}
let html = src.slice(start, end + 1).join('\n').replace(/^\s*return `/, '').replace(/`;\s*$/, '');

const l10n = (kind, key) =>
  kind === 'title' ? `data-l10n-title="${key}"` :
  kind === 'placeholder' ? `data-l10n-placeholder="${key}"` :
  kind === 'aria' ? `data-l10n-aria="${key}"` :
  `data-l10n="${key}"`;

// The l10n pass, emitted at the one position where it can work: at the end of the static chrome
// (everything it translates is above it) and before the first body script. `defer` is not the
// alternative: a deferred script executes after parsing, i.e. after every plain script in the
// body, `media/main.js` included — and main.js's opening IIFE writes the stateful title
// `Following the active node` onto #follow-btn, which a pass that ran afterwards would clobber
// with the static source string.
const markdownItTag = '  <script src="/assets/webview/vendor/markdown-it/markdown-it.min.js"></script>';
const boot = `  <!-- The shell chrome's l10n pass, and why the tag sits exactly here.
       \`session-boot.js\` walks the page for \`data-l10n*\` attributes and rewrites them. That
       means it needs the elements that carry them to exist already: everything above this line
       — the toolbar, the tree wrap, the composer (Send/Stop, the placeholder, every tooltip) and
       the meter row — and nothing after it but scripts. Loaded from the \`<head>\`, where this
       file first shipped it, the body did not exist yet, so the walk selected nothing and the
       phone rendered Send and Stop with no text at all.
       It must also run BEFORE \`media/main.js\` (the last script below), and that rules out
       \`defer\` as the fix: a deferred script runs after the document is parsed, while a plain
       script runs the moment it is parsed — so a deferred pass here would run *after* main.js,
       whose opening IIFE calls \`updateFollowButton()\` and writes the stateful title
       \`Following the active node\` onto #follow-btn. The pass would then clobber it with the
       static English source \`Follow the active node\` and nothing would re-render it until the
       follow state changed, so the phone's tooltip would disagree with the desktop's.
       A body script has the other property this needs too: it runs in the same parsing task as
       main.js, so no host frame can interleave. The Kotlin host releases the frames it held
       (\`tree\`, \`config\`) the instant main.js posts \`ready\`, and those callbacks are queued
       tasks — with a task boundary between the pass and the renderer, a frame that carried a
       dynamic title (\`Context: … / … tokens\`) could land first and then be overwritten by the
       static one. -->
  <script src="/assets/shell/session-boot.js"></script>`;

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

// The boot tag goes into the body, anchored on the tag this script itself just emitted (the
// renderer's first sibling). A template whose body script block is renamed fails here rather
// than silently dropping the pass back into a place where it selects nothing.
if (!html.includes(markdownItTag)) {
  console.error('cannot find ' + markdownItTag.trim() + ' in the emitted body — the boot tag has no anchor');
  process.exit(1);
}
html = html.replace(markdownItTag, boot + '\n' + markdownItTag);

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
       attributes, because a webview has no \`vscode.l10n\`. That read is a *pass* over the
       built DOM (\`assets/shell/session-boot.js\`) and it runs at the end of the body, before
       \`media/main.js\` — its tag says why;
    3. the CSP carries a per-load nonce for that one injected inline script and pins
       \`connect-src 'none'\` — the session view talks to the publisher through the Kotlin host,
       never through a fetch of its own.

  Everything else here is a copy of the host's shell and must stay one: a DOM id that
  \`media/main.js\` looks up and does not find on the phone would fail in a way the desktop tab
  cannot, and that would be a renderer divergence by the back door. When \`getHtml()\` grows an
  element, this file grows it too — there is no guard for that pairing, and the README says so.
-->

`;

// The head keeps exactly one script — the shim — because `media/main.js` calls
// `acquireVsCodeApi()` on its line 2 and this is the only thing that defines it. The l10n pass
// is NOT here (see `boot` above): from the head it selected nothing, because the body did not
// exist yet.
const shim = `  <!-- The host half of the message protocol: acquireVsCodeApi(), window.__spinneyHost.receive
       and the l10n dictionary (injected above). This must stay the shell's own first script —
       only the injected dictionary precedes it — because \`media/main.js\`, the last script in the
       body, calls acquireVsCodeApi() on its line 2, and the Kotlin host holds every
       host→webview frame until main.js posts \`ready\` (the order of operations is written out
       in session-shim.js's header). The l10n pass is not here: it rewrites \`data-l10n*\`
       attributes, so it can only work once the body that carries them exists — the tag is in
       the body, before the renderer, and explains itself there. -->
  <script src="/assets/shell/session-shim.js"></script>
</head>`;

const out = (banner + html.replace(/^<!DOCTYPE html>\n/, ''))
  .replace(/<\/head>/, shim)
  .replace(/\r\n/g, '\n');

// The placement is checked on the bytes that are about to be written, not trusted to the
// template's shape: the pass after the chrome it translates, and before `media/main.js`.
const bootTag = '  <script src="/assets/shell/session-boot.js"></script>';
const rendererTag = '  <script src="/assets/webview/main.js"></script>';
if (!(out.indexOf(bootTag) > 0 && out.indexOf(bootTag) < out.indexOf(rendererTag))) {
  console.error(
    'the l10n pass is not in the body ahead of ' + rendererTag.trim() + ' — regenerating would ' +
      'revert the fix that gave Send/Stop their text',
  );
  process.exit(1);
}

const dest = path.join(root, 'remote', 'android', 'app', 'src', 'main', 'assets', 'shell', 'session.html');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, out);
console.log('wrote ' + path.relative(root, dest) + ' (' + out.length + ' bytes)');
