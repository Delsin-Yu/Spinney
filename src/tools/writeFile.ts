import * as fs from 'fs';
import * as path from 'path';
import { AgentTool } from '../agent/types';
import { applyEol, detectEol, ensureNotAborted, eolLabelOf, resolvePath, toLf } from './index';

export const writeFileTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write content to a file, creating parent directories as needed. Fully overwrites the file. Path may be absolute or relative to the workspace root. When overwriting an existing file, its line-ending style (CRLF/LF) is preserved. Content may be supplied either as a normal JSON string (escaped) or, for large/multi-line content, as a verbatim frame: set frame:true, put a short JSON header for the path, then frame the content between <<<RAW:content>>> and <<<END_RAW:content>>>.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to write.' },
          content: { type: 'string', description: 'Full file content to write.' },
          frame: { type: 'boolean', description: 'Optional. Set true for large/multi-line content; the harness treats the big fields as a verbatim frame (RAW markers) instead of an escaped JSON string.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  async execute(args, signal) {
    ensureNotAborted(signal);
    const filePath = resolvePath(String(args.path ?? ''));
    const content = String(args.content ?? '');
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
