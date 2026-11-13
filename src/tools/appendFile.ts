import * as fs from 'fs';
import * as path from 'path';
import { AgentTool } from '../agent/types';
import { applyEol, detectEol, ensureNotAborted, lineDiff, lineDiffSuffix, resolvePath, toLf, verbatimFrameError } from './index';

export const appendFileTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'append_file',
      description:
        'Append content to the end of a file, creating the file (and its parent directories) when it does not exist. Use this for a large file: write the first part with write_file, then append the rest in bounded chunks, so no single call carries a huge string. Path may be absolute or relative to the harness root (the workspace folder, or the harness scratch folder when no folder is open). "content" is a plain JSON string: newlines, quotes and backslashes are escaped normally (\\n for a newline, \\" for a quote, \\\\ for a backslash), and the decoded string is added exactly as it decodes — start it with a newline when the existing file does not already end with one. When the file exists its line-ending style (CRLF/LF) is preserved: the content is converted to it. Nothing already in the file is changed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to append to (created when absent).' },
          content: { type: 'string', description: 'Text to add at the end of the file, as a plain JSON string.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  async execute(args, signal) {
    ensureNotAborted(signal);
    const filePath = resolvePath(String(args.path ?? ''));
    const content = String(args.content ?? '');
    const frameError = verbatimFrameError('content', content);
    if (frameError) {
      return frameError;
    }
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    // An existing file keeps its line-ending style (`detectEol` / `applyEol`, the
    // same pair write_file uses); a new file is written exactly as supplied.
    const existing = fs.existsSync(filePath)
      ? await fs.promises.readFile(filePath, 'utf8')
      : '';
    const finalContent = existing
      ? applyEol(toLf(content), detectEol(existing))
      : content;
    await fs.promises.appendFile(filePath, finalContent, 'utf8');
    // `split('\n').length` is the count write_file reports, so "lines total" here
    // agrees with the "Wrote … (N lines)" answer for the same bytes; an absent
    // file contributes nothing rather than the empty string's phantom first line.
    const lineCount = (text: string) => toLf(text).split('\n').length;
    const total = lineCount(existing + finalContent);
    const added = total - (existing ? lineCount(existing) : 0);
    // Appending can only add lines, so the diff's `del` is 0 and the card draws no red
    // half; the number still comes from the same helper as the other two file tools.
    return `Appended to ${filePath} (${added} lines added, ${total} lines total).${lineDiffSuffix(lineDiff(existing, existing + finalContent))}`;
  },
};
