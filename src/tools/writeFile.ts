import * as fs from 'fs';
import * as path from 'path';
import { AgentTool, TOOL_TITLE_DESCRIPTION } from '../agent/types';
import { applyEol, detectEol, ensureNotAborted, eolLabelOf, resolvePath, toLf, verbatimFrameError } from './index';

export const writeFileTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write content to a file, creating parent directories as needed. Fully overwrites the file. Path may be absolute or relative to the harness root (the workspace folder, or the harness scratch folder when no folder is open). "content" is a plain JSON string: newlines, quotes and backslashes are escaped normally (\\n for a newline, \\" for a quote, \\\\ for a backslash), and the decoded string is written exactly as it decodes. When overwriting an existing file, its line-ending style (CRLF/LF) is preserved. For a large file, write the first part with this tool and append the rest in bounded chunks with append_file instead of sending one huge string.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to write.' },
          content: { type: 'string', description: 'Full file content to write, as a plain JSON string.' },
          title: { type: 'string', description: TOOL_TITLE_DESCRIPTION },
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
    // Preserve the line-ending style of an existing file so rewriting a CRLF
    // file with LF content does not flip the whole file. New files are written
    // exactly as supplied.
    let finalContent = content;
    let label = eolLabelOf(content);
    if (fs.existsSync(filePath)) {
      const existing = await fs.promises.readFile(filePath, 'utf8');
      label = eolLabelOf(existing);
      finalContent = applyEol(toLf(content), detectEol(existing));
    }
    await fs.promises.writeFile(filePath, finalContent, 'utf8');
    const lines = toLf(finalContent).split('\n').length;
    return `Wrote ${filePath} (${lines} lines, ${label}).`;
  },
};
