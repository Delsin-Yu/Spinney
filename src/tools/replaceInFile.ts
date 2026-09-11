import * as fs from 'fs';
import { AgentTool } from '../agent/types';
import { applyEol, detectEol, embeddedFrameError, ensureNotAborted, eolLabelOf, resolvePath, toLf } from './index';

export const replaceInFileTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'replace_in_file',
      description:
        'Replace an exact substring in a file with new text. The oldText must appear exactly once, otherwise an error is returned. Use for surgical edits. Matching is done in normalized LF, so CRLF vs LF never breaks a match; the file is written back with its original line endings. Old and new text are either normal JSON strings or verbatim frames, whose RAW markers must stand OUTSIDE the JSON, on their own lines: a header line { "path": "a.ts" }, then <<<RAW:oldText>>>...<<<END_RAW:oldText>>> and <<<RAW:newText>>>...<<<END_RAW:newText>>>. A frame wrapped *inside* a JSON string value is not a frame: it is valid JSON, so the markers would land in the file, and the call is rejected with an error.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to edit.' },
          oldText: { type: 'string', description: 'Exact text to find.' },
          newText: { type: 'string', description: 'Replacement text.' },
          frame: { type: 'boolean', description: 'Optional. Declares that the payload is a verbatim frame. Framing is decided by the argument text itself (markers outside the JSON), not by this flag.' },
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
    const frameError =
      embeddedFrameError('replace_in_file', 'oldText', oldText) ??
      embeddedFrameError('replace_in_file', 'newText', newText);
    if (frameError) {
      throw new Error(frameError);
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
