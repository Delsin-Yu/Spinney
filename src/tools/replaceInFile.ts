import * as fs from 'fs';
import { AgentTool, TOOL_TITLE_DESCRIPTION } from '../agent/types';
import { applyEol, detectEol, ensureNotAborted, eolLabelOf, resolvePath, toLf, verbatimFrameError } from './index';

export const replaceInFileTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'replace_in_file',
      description:
        'Replace an exact substring in a file with new text. The oldText must appear exactly once, otherwise an error is returned. Use for surgical edits. Matching is done in normalized LF, so CRLF vs LF never breaks a match; the file is written back with its original line endings. "oldText" and "newText" are plain JSON strings: newlines, quotes and backslashes are escaped normally (\\n for a newline, \\" for a quote, \\\\ for a backslash), and the decoded strings are matched and inserted exactly as they decode. The replacement is inserted verbatim (no String.replace dollar patterns).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to edit.' },
          oldText: { type: 'string', description: 'Exact text to find, as a plain JSON string.' },
          newText: { type: 'string', description: 'Replacement text, as a plain JSON string.' },
          title: { type: 'string', description: TOOL_TITLE_DESCRIPTION },
        },
        required: ['path', 'oldText', 'newText'],
      },
    },
  },
  async execute(args, signal) {
    ensureNotAborted(signal);
    const filePath = resolvePath(String(args.path ?? ''));
    const oldText = String(args.oldText ?? '');
    const newText = String(args.newText ?? '');
    const frameError = verbatimFrameError('oldText', oldText) ?? verbatimFrameError('newText', newText);
    if (frameError) {
      return frameError;
    }
    if (!oldText) {
      throw new Error('replace_in_file requires a non-empty "oldText".');
    }
    const content = await fs.promises.readFile(filePath, 'utf8');
    const eol = detectEol(content);
    // Match and replace in canonical LF, then write back in the original style.
    const matchContent = toLf(content);
    const matchOld = toLf(oldText);
    const matchNew = toLf(newText);
    const count = matchContent.split(matchOld).length - 1;
    if (count === 0) {
      throw new Error(
        `Could not find oldText in ${filePath}. The file uses ${eolLabelOf(content)} line endings; ` +
        'verify the exact text (including indentation) against read_file output.',
      );
    }
    if (count > 1) {
      throw new Error(
        `oldText is ambiguous in ${filePath}: found ${count} occurrences. Provide more context.`,
      );
    }
    // A *string* replacement would interpret dollar-ampersand, dollar-backtick,
    // dollar-quote and double-dollar patterns (String.replace semantics), silently
    // mangling the file; the function form inserts newText verbatim.
    const result = matchContent.replace(matchOld, () => matchNew);
    await fs.promises.writeFile(filePath, applyEol(result, eol), 'utf8');
    return `Replaced one occurrence in ${filePath}.`;
  },
};
