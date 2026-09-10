import * as fs from 'fs';
import * as path from 'path';
import { AgentTool } from '../agent/types';
import { SKIP_DIRS, ensureNotAborted, globToRegex, limitInline, resolvePath } from './index';

/** Cap a recursive listing so one call cannot dump an unbounded tree. */
const MAX_LIST_ENTRIES = 2000;

export const listDirTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'list_dir',
      description:
        'List the entries of a directory. Path may be absolute or relative to the workspace root. Directories are suffixed with "/". An optional glob filters entries against their path relative to the listed directory (e.g. "*.ts" for top-level, "**/*.ts" for any depth); recursive:true walks subdirectories (heavy dirs node_modules/.git/out/dist/build are skipped) and prints each entry\'s relative path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path.' },
          glob: { type: 'string', description: 'Optional glob filter, e.g. "*.ts" or "**/*.ts".' },
          recursive: { type: 'boolean', description: 'Walk subdirectories (default false).' },
        },
        required: ['path'],
      },
    },
  },
  async execute(args, signal) {
    ensureNotAborted(signal);
    const dirPath = resolvePath(String(args.path ?? '.'));
    const glob = args.glob ? globToRegex(String(args.glob)) : null;
    const recursive = args.recursive === true;
    const out: string[] = [];
    let capped = false;

    const walk = async (dir: string, rel: string): Promise<void> => {
      ensureNotAborted(signal);
      if (out.length >= MAX_LIST_ENTRIES) {
        capped = true;
        return;
      }
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (out.length >= MAX_LIST_ENTRIES) {
          capped = true;
          return;
        }
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (recursive && !SKIP_DIRS.has(entry.name)) {
            if (!glob || glob.test(relPath)) {
              out.push(`${relPath}/`);
            }
            await walk(path.join(dir, entry.name), relPath);
            continue;
          }
          if (!glob || glob.test(relPath)) {
            out.push(`${relPath}/`);
          }
          continue;
        }
        if (!glob || glob.test(relPath)) {
          out.push(relPath);
        }
      }
    };

    await walk(dirPath, '');
    const names = out.sort().join('\n');
    const suffix = capped ? `\n…[listing stopped at ${MAX_LIST_ENTRIES} entries; narrow it with a glob.]` : '';
    return limitInline(`Directory: ${dirPath}${recursive ? ' (recursive)' : ''}\n${names || '(empty)'}${suffix}`, 'list_dir');
  },
};
