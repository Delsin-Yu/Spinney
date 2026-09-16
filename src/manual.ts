/**
 * The **user manual**: the shipped markdown pages in `manual/`, and the command
 * that opens one (`spinney.showManual`).
 *
 * This is not the developer documentation — that lives in `docs/agents/`, is
 * written for an agent, and is deliberately excluded from the `.vsix`
 * (`.vscodeignore`: `docs/**`). The manual is the opposite: it ships in the
 * package, it is written for the person using the extension, and
 * `tools/check-docs.js` fails *packaging* when it drifts from the manifest (a
 * missing page, a command title that no longer matches `package.nls*.json`, a
 * `spinney.*` key the settings reference forgot, or a `.vscodeignore` pattern
 * that keeps the whole folder out of the `.vsix`).
 *
 * One page per shipped catalog language, named by the **canonical** tag exactly
 * like the l10n catalogs (`manual.zh-Hans.md`, never `manual.zh-cn.md`): the
 * manual's display language is `vscode.env.language`, which reports the legacy
 * region id for the two Chinese scripts, so the tag goes through
 * `languageTags.ts` before it names a file. `manual.md` is the English source and
 * the fallback for every other language — a missing page is never an error, it
 * falls back, the same way an untranslated UI string does.
 *
 * The page opens as an **untitled** markdown document, the idiom
 * `ChatViewProvider.showSystemPrompt` uses: nothing is written to disk, so the
 * command is free of paths, collisions and cleanup. The trade-off is that the
 * reader's own edits are throwaway, which is what a manual wants.
 */

import * as vscode from 'vscode';
import { CANONICAL_TAGS } from './languageTags';
import { harnessLog } from './perf';

/** The folder inside the extension that carries the pages. */
const MANUAL_DIR = 'manual';

/** The English page: the canonical source, and the fallback for every locale. */
const MANUAL_BASE = 'manual.md';

/**
 * The tag a page is named by: the canonical one (`vscode.env.language` reports
 * `zh-cn` / `zh-tw`, the repo authors `zh-Hans` / `zh-Hant` — see
 * `languageTags.ts`). Every other tag is already canonical and passes through.
 */
export function canonicalLocale(locale: string): string {
  const tag = (locale ?? '').trim();
  return CANONICAL_TAGS[tag] ?? tag;
}

/**
 * The pages to try for a display language, most specific first. English (and an
 * `en-*` variant, which has no page of its own) goes straight to the source.
 */
export function manualFileNames(locale: string): string[] {
  const canonical = canonicalLocale(locale);
  const names: string[] = [];
  if (canonical && !canonical.toLowerCase().startsWith('en')) {
    names.push(`manual.${canonical}.md`);
  }
  names.push(MANUAL_BASE);
  return names;
}

/**
 * Read the first page that exists, or `undefined` when the install carries none.
 * A missing locale page is normal and silent — only a package with no English
 * page at all is broken, and that is what the caller reports.
 */
export async function readManual(
  extensionUri: vscode.Uri,
  locale: string,
): Promise<{ fileName: string; text: string } | undefined> {
  for (const fileName of manualFileNames(locale)) {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extensionUri, MANUAL_DIR, fileName));
      return { fileName, text: Buffer.from(bytes).toString('utf8') };
    } catch {
      // Not there (or unreadable): try the next candidate.
    }
  }
  return undefined;
}

/**
 * Open the manual for the window's display language in an untitled editor tab
 * (`spinney.showManual`). The `[manual]` line names the page and the display
 * language that selected it — the same diagnostic the `[i18n]` line gives for the
 * UI catalogs, and the only way to tell "English because the window is English"
 * from "English because the page is missing".
 */
export async function showManual(extensionUri: vscode.Uri): Promise<void> {
  const page = await readManual(extensionUri, vscode.env.language);
  if (!page) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t('The Spinney user manual is missing from this installation.'),
    );
    return;
  }
  harnessLog(`[manual] ${page.fileName} (display language ${vscode.env.language})`);
  const doc = await vscode.workspace.openTextDocument({ content: page.text, language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: false });
}
