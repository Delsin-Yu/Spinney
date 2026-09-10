import * as fs from 'fs';
import * as path from 'path';
import { AgentTool } from '../agent/types';
import {
  SKIP_DIRS,
  ensureNotAborted,
  getAgentRoot,
  getWorkspaceRoot,
  globToRegex,
  hasWorkspaceFolder,
  limitInline,
  resolvePath,
} from './index';

const MAX_SEARCH_FILE = 1_000_000;
const MAX_SEARCH_FILES = 4000;
const MAX_SEARCH_MATCHES = 300;
const MAX_CONTEXT_LINES = 10;

/** Trailing note appended to a search result that stopped before scanning everything. */
function searchCapNote(capped: boolean, maxResults: number, skippedLarge: number): string {
  const notes: string[] = [];
  if (capped) {
    notes.push(
      `reached the ${maxResults}-match cap (hard cap ${MAX_SEARCH_MATCHES}) — results may be incomplete; ` +
        'narrow the pattern, add a glob, or raise maxResults',
    );
  }
  if (skippedLarge > 0) {
    notes.push(`skipped ${skippedLarge} file(s) larger than ${MAX_SEARCH_FILE} bytes`);
  }
  return notes.length ? `\n…[search stopped early: ${notes.join('; ')}.]` : '';
}

export const searchFilesTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'search_files',
      description:
        'Search files in the workspace for a regex pattern and return matching "file:line: text" lines (paths are relative to the harness root; absolute when no folder is open). `path` may be a file or a directory (default = the harness root: the workspace folder, or the harness scratch folder when no folder is open). An optional glob (e.g. "**/*.ts") filters which files are searched; caseSensitive defaults to false; maxResults caps the matches (default 200, hard cap 300); context adds up to 10 surrounding lines per match (context lines use "-" separators, e.g. "src/a.ts-11- text"). Heavy dirs (node_modules/.git/out...) are skipped automatically. When the search stops before scanning everything (match cap / oversized files) the result ends with an explicit note — never treat a capped result as complete.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex to search for (JS regex syntax).' },
          path: { type: 'string', description: 'File or directory to search (default = the harness root: the workspace folder, or the harness scratch folder when no folder is open).' },
          glob: { type: 'string', description: 'Optional glob filter, e.g. "**/*.ts".' },
          caseSensitive: { type: 'boolean', description: 'Default false.' },
          maxResults: { type: 'number', description: 'Default 200 (capped at 300).' },
          context: { type: 'number', description: 'Lines of context around each match (0-10, default 0).' },
        },
        required: ['pattern'],
      },
    },
  },
  async execute(args, signal) {
    ensureNotAborted(signal);
    const pattern = String(args.pattern ?? '');
    if (!pattern) {
      return 'Error: search_files requires a "pattern".';
    }
    let re: RegExp;
    try {
      re = new RegExp(pattern, args.caseSensitive ? '' : 'i');
    } catch (err) {
      return `Error: invalid regex: ${err instanceof Error ? err.message : String(err)}`;
    }
    const root = args.path ? resolvePath(String(args.path)) : getAgentRoot();
    const glob = args.glob ? globToRegex(String(args.glob)) : null;
    const maxResults =
      typeof args.maxResults === 'number' ? Math.min(Math.max(1, args.maxResults), MAX_SEARCH_MATCHES) : 200;
    const context =
      typeof args.context === 'number' ? Math.min(Math.max(0, Math.floor(args.context)), MAX_CONTEXT_LINES) : 0;
    // With no folder open we print absolute paths: scratch-root-relative paths would be ambiguous.
    const wsRoot = hasWorkspaceFolder() ? getWorkspaceRoot() : null;

    /** Path shown in a hit: workspace-relative when inside it, else absolute. */
    const display = (full: string): string => {
      if (wsRoot) {
        const rel = path.relative(wsRoot, full).split(path.sep).join('/');
        if (rel && !rel.startsWith('..')) {
          return rel;
        }
      }
      return full.split(path.sep).join('/');
    };

    const results: string[] = [];
    let matches = 0;
    let files = 0;
    let skippedLarge = 0;
    let capped = false;

    /** Append every hit in one file's text (plus optional context lines). */
    const searchText = (text: string, label: string): void => {
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) {
          continue;
        }
        if (matches >= maxResults) {
          capped = true;
          return;
        }
        matches++;
        if (context > 0) {
          const from = Math.max(0, i - context);
          const to = Math.min(lines.length - 1, i + context);
          for (let j = from; j <= to; j++) {
            const sep = j === i ? ':' : '-';
            results.push(`${label}${sep}${j + 1}${sep} ${lines[j].trim().slice(0, 160)}`);
          }
        } else {
          results.push(`${label}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
        }
      }
    };

    let rootStat;
    try {
      rootStat = await fs.promises.stat(root);
    } catch {
      return `Error: no such file or directory: ${root}`;
    }
    // `path` may name a single file (the parameter says so) — search just it.
    if (rootStat.isFile()) {
      searchText(await fs.promises.readFile(root, 'utf8'), display(root));
      return results.length
        ? limitInline(results.join('\n') + searchCapNote(capped, maxResults, 0), 'search_files')
        : '(no matches)';
    }

    const walk = async (dir: string, rel: string): Promise<void> => {
      if (signal?.aborted) throw new Error('Operation aborted.');
      if (matches >= maxResults || files >= MAX_SEARCH_FILES) {
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
        if (signal?.aborted) throw new Error('Operation aborted.');
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) {
            continue;
          }
          await walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
          continue;
        }
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (glob && !glob.test(relPath)) {
          continue;
        }
        files++;
        const full = path.join(dir, entry.name);
        let text: string;
        try {
          const stat = await fs.promises.stat(full);
          if (stat.size > MAX_SEARCH_FILE) {
            skippedLarge++;
            continue;
          }
          text = await fs.promises.readFile(full, 'utf8');
        } catch {
          continue;
        }
        searchText(text, display(full));
        if (matches >= maxResults) {
          capped = true;
          return;
        }
      }
    };

    await walk(root, '');
    return results.length
      ? limitInline(results.join('\n') + searchCapNote(capped, maxResults, skippedLarge), 'search_files')
      : '(no matches)';
  },
};
