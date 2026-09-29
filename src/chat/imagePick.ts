/**
 * imagePick.ts — "pick one image and turn it into an attachment", once.
 *
 * The local chat tab's composer (+ button) needs exactly this:
 * `SessionRuntime.handlePickImage()` opens the picker, and the file it reads becomes the
 * `{ dataUrl, name }` attachment the turn carries.
 *
 * The result is a value, not a message: `SessionRuntime` posts it as `imagePicked` to its
 * own webview, so the caller owns no second copy of the mime table or of the read.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** What one turn at the picker produced. */
export type ImagePickOutcome =
  /** The user chose a file and it was read: the attachment to hand to a composer. */
  | { kind: 'picked'; dataUrl: string; name: string }
  /** The dialog was dismissed (or the user hit Escape): nothing happened, nothing to say. */
  | { kind: 'cancelled' }
  /** The file was chosen but could not be read: one sentence for the surface. */
  | { kind: 'failed'; error: string };

/**
 * Open the file dialog, read the chosen image and build its `data:` URL.
 *
 * The mime type comes from the extension, and the filter list is the *image* list, not a
 * capability list: whether the model accepts images is the model card's business
 * (`spinney.modelCards.*.vision`), decided later, at send time.
 */
export async function pickImageAttachment(): Promise<ImagePickOutcome> {
  const result = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { [vscode.l10n.t('Images')]: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
    openLabel: vscode.l10n.t('Attach Image'),
  });
  if (!result || result.length === 0) {
    return { kind: 'cancelled' };
  }
  const filePath = result[0].fsPath;
  try {
    const buffer = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime =
      ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return {
      kind: 'picked',
      dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
      name: path.basename(filePath),
    };
  } catch (err) {
    return { kind: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}
