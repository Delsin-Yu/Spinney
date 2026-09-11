import * as fs from 'fs';
import * as path from 'path';
import { AgentTool } from '../agent/types';
import { applyEol, detectEol, embeddedFrameError, ensureNotAborted, eolLabelOf, resolvePath, toLf } from './index';

export const writeFileTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write content to a file, creating parent directories as needed. Fully overwrites the file. Path may be absolute or relative to the harness root (the workspace folder, or the harness scratch folder when no folder is open). When overwriting an existing file, its line-ending style (CRLF/LF) is preserved. Content is either a normal JSON string (short content; newlines, quotes and backslashes must be escaped) or a verbatim frame, whose RAW markers must stand OUTSIDE the JSON, on their own lines: a header line { "path": "a.ts" }, then <<<RAW:content>>>, the file text verbatim, then <<<END_RAW:content>>>. The header holds the small fields; the payload between the markers is captured verbatim (one framing newline after the open marker is skipped, a trailing newline before END_RAW is kept). A frame wrapped *inside* a JSON string value — { "content": "<<<RAW:content>>>..." } — is not a frame: it is valid JSON, so the markers would land in the file, and the call is rejected with an error.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to write.' },
          content: { type: 'string', description: 'Full file content to write.' },
          frame: { type: 'boolean', description: 'Optional. Declares that the payload is a verbatim frame. Framing is decided by the argument text itself (markers outside the JSON), not by this flag.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  async execute(args, signal) {
    ensureNotAborted(signal);
    const filePath = resolvePath(String(args.path ?? ''));
    const content = String(args.content ?? '');
    const frameError = embeddedFrameError('write_file', 'content', content);
    if (frameError) {
      throw new Error(frameError);
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
