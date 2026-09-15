import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { CANONICAL_TAGS, REPORTED_TAGS } from './languageTags';

/**
 * UI localisation — the one place that knows which display language the user is
 * running and where the catalog for it lives.
 *
 * The extension ships one catalog per language, keyed by the **English source
 * string** (VS Code's own convention: `l10n/bundle.l10n.<locale>.json`), and two
 * mechanisms read it:
 *
 *  - the host asks `vscode.l10n.t('Send')` — VS Code resolves the current locale
 *    itself and reads the same file, so host strings need nothing from here;
 *  - the chat webview cannot call `vscode.l10n` at all (it is a plain `<iframe>`
 *    document with no API bridge), so the host hands it the whole catalog as a
 *    dictionary (`webviewL10n` below) and `media/main.js` looks the string up
 *    with its own `tr()` — the same key, the same `{0}` placeholders.
 *
 * Both paths therefore stay in step by construction: one file per language is the
 * single place a translation is written, and `tools/check-l10n.js` fails packaging
 * when a string used in the code has no entry there (or the other way round).
 *
 * English needs no file, and every catalog is named by its **canonical**,
 * region-invariant tag (`l10n/bundle.l10n.zh-Hans.json`). VS Code looks a catalog
 * up by the tag *it* reports — for Chinese still the legacy region id — so those
 * copies are generated at package time; `docs/agents/invariants/i18n.md` has the
 * whole picture.
 *
 * The locale is `vscode.env.language`, i.e. the user's **display language**: the
 * same value the `spinney.replyLanguage = auto` default already follows, and the
 * language the language packs (and the settings UI around us) are in. English is
 * the floor — a locale with no catalog in this extension falls back to the source
 * strings, so an English window (and every untranslated string) reads exactly as
 * it always did.
 */

/**
 * A display locale → the tag this extension names its catalogs after, i.e. the
 * canonical one. Both spellings of a Chinese display language arrive in practice:
 * what the language packs report (`zh-cn` / `zh-tw`, the legacy region ids — see
 * `src/languageTags.ts`) and the canonical form itself, from `--locale=zh-Hans` or
 * a `vscode.env.language` someone normalized. A lookup has to land on the
 * canonical name either way, because that is what the files in `l10n/` are called;
 * VS Code's *own* lookup still wants the reported one, which is why
 * `tools/sync-l10n-aliases.js` writes those copies into the package.
 */
const LOCALE_ALIASES: Record<string, string> = { ...CANONICAL_TAGS };
for (const canonical of Object.keys(REPORTED_TAGS)) {
  LOCALE_ALIASES[canonical.toLowerCase()] = canonical;
}

/** The locale the UI should be read in, normalized (`''` → `'en'`). */
export function displayLocale(): string {
  const raw = (vscode.env.language || '').trim().toLowerCase();
  if (!raw) {
    return 'en';
  }
  return LOCALE_ALIASES[raw] ?? raw;
}

/**
 * The catalog for `locale` (a canonical tag, see `displayLocale`), or `undefined`
 * when there is none — which is the normal case for English (the source strings
 * *are* the catalog) and for any language this extension does not translate yet.
 */
function readCatalog(extensionUri: vscode.Uri, locale: string): Record<string, string> | undefined {
  if (!locale || locale.startsWith('en')) {
    return undefined;
  }
  try {
    const file = vscode.Uri.joinPath(extensionUri, 'l10n', `bundle.l10n.${locale}.json`).fsPath;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return undefined; // no catalog, or an unreadable one: source strings it is
  }
}

// Read once per window: the display language cannot change without a reload, and
// `getHtml` runs for every chat tab.
let dictionary: Record<string, string> | undefined;

/** The webview's own copy of the catalog, keyed by the English source string. */
export function webviewL10n(extensionUri: vscode.Uri): Record<string, string> {
  if (!dictionary) {
    dictionary = readCatalog(extensionUri, displayLocale()) ?? {};
  }
  return dictionary;
}

/**
 * The title a session carries before anyone has named it. It is *data* as much as
 * UI — a stored session title — so it is read through here rather than typed at the
 * call sites: `chat/runtime.ts` recognizes "still unnamed" by comparing against
 * this exact value (the first turn replaces it with a heuristic title), and a
 * literal in one place and a translation in the other would quietly break that for
 * every non-English window.
 */
export function defaultSessionTitle(): string {
  return vscode.l10n.t('New session');
}

/**
 * Is a stored session title still "nobody has named this"? The check has to accept
 * both spellings: the localized one, and the plain English sentinel that the two
 * pure data modules write — `chat/tree.ts` when it repairs a session record that
 * carries no title, and `chat/sessionTitles.ts`'s `heuristicTitle` when a session
 * has no user text to name it from. Those two must not import `vscode` (they are
 * unit-testable outside the Extension Host, see docs/agents/file-map.md), so they
 * keep the English string; this is where the two meet.
 */
export function isDefaultSessionTitle(title: string): boolean {
  return title === 'New session' || title === defaultSessionTitle();
}


/**
 * One `[i18n]` line for the Spinney output channel: which locale the host thinks
 * it is running in and whether a catalog was actually found. A missing catalog for
 * a non-English window is otherwise invisible — the UI simply stays English.
 *
 * It names the canonical file this extension reads **and** the reported-tag copy
 * VS Code reads on its own behalf, because those two can fail independently: the
 * aliases are generated at package time (`tools/sync-l10n-aliases.js`) and a
 * package built without them has a Chinese webview and an English host.
 */
export function l10nDiagnostics(extensionUri: vscode.Uri): string {
  const locale = displayLocale();
  const file = locale.startsWith('en') ? '(source strings)' : path.join('l10n', `bundle.l10n.${locale}.json`);
  const found = locale.startsWith('en') || readCatalog(extensionUri, locale) !== undefined;
  const reported = REPORTED_TAGS[locale];
  const alias = reported ? ` vs-code-reads=l10n/bundle.l10n.${reported}.json` : '';
  return `[i18n] display language=${locale} catalog=${file}${alias}${found ? '' : ' (missing — falling back to English)'}`;
}
