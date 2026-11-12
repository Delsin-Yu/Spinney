import * as fs from 'fs';
import { AgentTool, TOOL_TITLE_DESCRIPTION } from '../agent/types';
import { headByBytes, tailByBytes } from '../text';
import { ensureNotAborted, eolLabelOf, resolvePath, toLf } from './index';

/**
 * The most text one `read_file` answer carries inline. A read is the one tool
 * result a model copies back into another call (`replace_in_file`'s `oldText`),
 * so this is a **safety ceiling**, not a page size: 256 KiB is far above a file
 * a model should paste back and far below a request that fills a window. The
 * failure it prevents is concrete: a 7.7 MB minified `ir.json` was once returned
 * whole by a single-line `grep`, and the next request asked for 2.78 M tokens
 * against a 1,048,576-token window — a 400 on every retry, the node unusable.
 *
 * A capped answer is never silent: the header says TRUNCATED, gives the range's
 * byte size, and warns that the text must not be used as `oldText`.
 */
const READ_MAX_BYTES = 256 * 1024;
/** How much of the ceiling the head gets; the tail takes the rest. */
const READ_HEAD_BYTES = Math.floor(READ_MAX_BYTES * 0.75);
const READ_TAIL_BYTES = READ_MAX_BYTES - READ_HEAD_BYTES;

export const readFileTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read the contents of a text file. Path may be absolute or relative to the harness root (the workspace folder, or the harness scratch folder when no folder is open). Optionally read a specific 1-based line range. Content is returned with LF line endings. The header reports the total line count (wc -l convention: a trailing newline does not add a line) and the on-disk line ending (e.g. CRLF); read a one-line range (startLine 1, endLine 1) when you only need the count. A range whose text exceeds 256 KiB comes back as an explicit TRUNCATED head/tail excerpt with the byte counts (never silently), so read a narrower range or use search_files for a big minified file. Use read_file output verbatim as replace_in_file oldText, and never use a TRUNCATED excerpt as oldText. Prefer this over reading through the shell.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path.' },
          startLine: { type: 'number', description: 'Inclusive 1-based start line.' },
          endLine: { type: 'number', description: 'Inclusive 1-based end line.' },
          title: { type: 'string', description: TOOL_TITLE_DESCRIPTION },
        },
        required: ['path'],
      },
    },
  },
  async execute(args, signal) {
    ensureNotAborted(signal);
    const filePath = resolvePath(String(args.path ?? ''));
    const content = await fs.promises.readFile(filePath, 'utf8');
    // Report the on-disk line ending but always present content in a canonical
    // LF form so the model sees a stable representation; its future oldText/
    // newText then lines up regardless of CRLF vs LF.
    const label = eolLabelOf(content);
    const normalized = toLf(content);
    const lines = normalized.split('\n');
    // `split` yields a trailing empty element for a newline-terminated file; the
    // real line count (what `wc -l` reports) excludes it, so the header must too.
    const lineCount = normalized === '' ? 0 : normalized.endsWith('\n') ? lines.length - 1 : lines.length;
    const startLine = typeof args.startLine === 'number' ? args.startLine : 1;
    const endLine = typeof args.endLine === 'number' ? args.endLine : lineCount;
    const last = Math.min(endLine, lineCount);
    const slice = lines.slice(Math.max(1, startLine) - 1, Math.max(0, last));
    const header = `File: ${filePath}`;
    const wholeFile = startLine === 1 && endLine >= lineCount;
    const body = wholeFile ? normalized : slice.map((line, i) => `${startLine + i}: ${line}`).join('\n');
    const range = wholeFile ? `${lineCount} lines, ${label}` : `lines ${startLine}-${last} of ${lineCount}, ${label}`;
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes <= READ_MAX_BYTES) {
      return `${header} (${range})\n${body}`;
    }
    const head = headByBytes(body, READ_HEAD_BYTES);
    const tail = tailByBytes(body, READ_TAIL_BYTES);
    const headBytes = Buffer.byteLength(head, 'utf8');
    const tailBytes = Buffer.byteLength(tail, 'utf8');
    const omitted = bytes - headBytes - tailBytes;
    // Which way out exists depends on the shape of the file: when the widest
    // requested line is longer than the head, no line range can ever fit it and
    // the model has to search instead. Saying so is the difference between a
    // model that retries the same read and one that changes its approach.
    let widest = 0;
    let widestLine = startLine;
    for (let i = 0; i < slice.length; i++) {
      if (slice[i].length > widest) {
        widest = slice[i].length;
        widestLine = startLine + i;
      }
    }
    const why =
      widest > head.length
        ? `line ${widestLine} alone is ${widest} characters, so a smaller line range will not help — use search_files to find a short slice`
        : 'read a smaller line range for the rest';
    return (
      `${header} (${range})\n` +
      `[TRUNCATED: this range is ${bytes} bytes against a ${READ_MAX_BYTES}-byte ceiling; ` +
      `showing the first ${headBytes} and last ${tailBytes} bytes (${omitted} omitted). ` +
      `Why: ${why}. Do not use this text as replace_in_file oldText.]\n` +
      `${head}\n…[${omitted} bytes omitted]…\n${tail}`
    );
  },
};
