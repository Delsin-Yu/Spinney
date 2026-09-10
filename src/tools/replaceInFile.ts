import * as fs from 'fs';
import { AgentTool } from '../agent/types';
import { applyEol, detectEol, ensureNotAborted, eolLabelOf, resolvePath, toLf } from './index';

export const replaceInFileTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'replace_in_file',
      description:
        'Replace an exact substring in a file with new text. The oldText must appear exactly once, otherwise an error is returned. Use for surgical edits. Matching is done in normalized LF, so CRLF vs LF never breaks a match; the file is written back with its original line endings. Old and new text may be normal JSON strings or, for large/multi-line snippets, verbatim frames: set frame:true, put a JSON header for the path, then <<<RAW:oldText>>>...<<<END_RAW:oldText>>> and <<<RAW:newText>>>...<<<END_RAW:newText>>>.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to edit.' },
          oldText: { type: 'string', description: 'Exact text to find.' },
          newText: { type: 'string', description: 'Replacement text.' },
          frame: { type: 'boolean', description: 'Optional. Set true for large/multi-line oldText/newText; the harness treats them as verbatim frames (RAW markers) instead of escaped JSON strings.' },
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
