import * as fs from 'fs';
import { AgentTool } from '../agent/types';
import { ensureNotAborted, eolLabelOf, resolvePath, toLf } from './index';

export const readFileTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read the contents of a text file. Path may be absolute or relative to the workspace root. Optionally read a specific 1-based line range. Content is returned with LF line endings. The header reports the total line count (wc -l convention: a trailing newline does not add a line) and the on-disk line ending (e.g. CRLF); read a one-line range (startLine 1, endLine 1) when you only need the count. Use read_file output verbatim as replace_in_file oldText.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path.' },
          startLine: { type: 'number', description: 'Inclusive 1-based start line.' },
          endLine: { type: 'number', description: 'Inclusive 1-based end line.' },
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
    if (startLine === 1 && endLine >= lineCount) {
      return `${header} (${lineCount} lines, ${label})\n${normalized}`;
    }
    const numbered = slice.map((line, i) => `${startLine + i}: ${line}`).join('\n');
    return `${header} (lines ${startLine}-${last} of ${lineCount}, ${label})\n${numbered}`;
  },
};
