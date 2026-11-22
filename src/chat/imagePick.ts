/**
 * imagePick.ts — the composer's one attach dialog, and the one place a chosen file is
 * routed by its extension.
 *
 * The dialog has **no filters**: the Attach button references any file, and only a handful
 * of extensions are read as images. Routing is therefore a decision about the *extension*
 * and never about the model's capability:
 *
 *   - an extension in {@link IMAGE_EXTENSIONS} is read here and becomes the
 *     `data:<mime>;base64,…` URL a turn carries as an attachment;
 *   - anything else is `{ kind: 'path' }` — a **reference**, which the caller inserts into
 *     the composer. A reference is plain text: the agent reads the file itself with
 *     `read_file`, which is why nothing here inlines content and why no token cost is paid
 *     at pick time (`docs/agents/plans/mention-syntax.md` §1, §9).
 *
 * Whether the model can *see* an image is not decided here. That is the model card's
 * `vision` gate, applied by `SessionRuntime` at send time (it keeps the existing hint and
 * attaches nothing), so this module never has to know which card is in use and a pick is
 * always a value the caller can route — never a dialog that silently did nothing.
 *
 * The module stays dependency-free (`fs`, `path`, `vscode`) and takes the
 * workspace-normaliser as an argument. That is deliberate: the normaliser is
 * `workspaceRelativePath` in `./mentionIndex` (the one function that maps a file inside the
 * agent root back to a forward-slash relative path), and §4 requires the menu, the dialog
 * and the typed `@` path to produce the *same* string for the same file. Importing it here
 * would drag the whole index — ripgrep, child_process, listeners — into every caller that
 * only wants to open a dialog.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * The extensions read as images — lowercase, no dots — and the **only** list anything
 * routes by. `IMAGE_MIME` below has one row per entry: a new extension needs both, and the
 * default branch sends an unknown one as `image/jpeg`, which is what a browser does and
 * what the provider's decoder accepts for a mislabelled image.
 */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

/**
 * Extension → the mime type it is sent as. This is the table `SessionRuntime` inlined
 * before this module existed, kept byte-identical so a pick produces the same `data:` URL
 * it always did.
 */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** What one trip through the attach dialog produced. */
export type AttachmentPick =
  /** An image, already read: the `data:` URL and the name the composer shows. */
  | { kind: 'image'; dataUrl: string; name: string }
  /** Any other file: the path to insert into the composer, as a **reference**. */
  | { kind: 'path'; path: string }
  /** The dialog was dismissed (Escape, Cancel): nothing happened, nothing to say. */
  | { kind: 'cancelled' }
  /** The file was chosen but could not be read: one sentence for the surface. */
  | { kind: 'failed'; error: string };

/** The lowercased extension of a path, without its dot (`''` when it has none). */
function extensionOf(file: string): string {
  return path.extname(file).slice(1).toLowerCase();
}

/**
 * Open the attach dialog and route its answer by extension.
 *
 * `insideRoot` is the caller's normaliser: it maps a file inside the workspace back to the
 * relative path a menu pick would insert, and returns `null` for anything outside. A pick
 * it declines stays the native absolute path, which is the only honest spelling for a file
 * the agent can reach by no shorter name.
 */
export async function pickAttachment(insideRoot: (abs: string) => string | null): Promise<AttachmentPick> {
  let picked: vscode.Uri[] | undefined;
  try {
    picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      // No `filters`, on purpose: the same button references `AGENTS.md`, a `.ts` file and
      // a screenshot, so a dialog that hides the file the user wants would defeat it.
      openLabel: vscode.l10n.t('Attach'),
    });
  } catch (err) {
    return { kind: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
  if (!picked || picked.length === 0) {
    return { kind: 'cancelled' };
  }

  const abs = picked[0].fsPath;
  const extension = extensionOf(abs);
  if (!IMAGE_EXTENSIONS.includes(extension)) {
    let normalised: string | null = null;
    try {
      normalised = insideRoot(abs);
    } catch {
      // A caller's normaliser must never cost the pick: the absolute path is always a
      // usable answer, so a throwable one degrades to it instead of failing the dialog.
      normalised = null;
    }
    return { kind: 'path', path: normalised ?? abs };
  }

  try {
    const bytes = await fs.promises.readFile(abs);
    return {
      kind: 'image',
      dataUrl: `data:${IMAGE_MIME[extension] ?? 'image/jpeg'};base64,${bytes.toString('base64')}`,
      name: path.basename(abs),
    };
  } catch (err) {
    // The OS reason travels; the caller wraps it in its own one-sentence notice, so this
    // never becomes a second, differently worded error surface.
    return { kind: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}
