import { AgentTool } from '../agent/types';
import { listTranscriptSessions, searchTranscripts, TranscriptKind } from '../chat/transcript';
import { ensureNotAborted, limitInline } from './index';

/**
 * `search_transcripts` reads the JSONL dumps written by `src/chat/transcript.ts`
 * — one file per main-agent turn (`kind: 'session'`) and per sub-agent run
 * (`kind: 'subagent'`) under `<root>/<sessionId>/<nodeId>.jsonl`. Those folders
 * normally live in the extension's global storage, i.e. **outside** the
 * workspace, so `search_files` cannot reach them.
 *
 * The roots are supplied by the provider (they depend on
 * `spinney.subAgentTranscriptDir` and the global-storage path), resolved at
 * call time so a settings change needs no tool rebuild.
 */
export function makeSearchTranscriptsTool(getRoots: () => string[]): AgentTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'search_transcripts',
        description:
          'Search the on-disk transcripts of every session (and sub-agent run) for a regex pattern — use this to recall what happened in a previous conversation. Transcripts are JSONL files at <root>/<sessionId>/<nodeId>.jsonl: line 1 is a meta record (kind, session title, node, status, prompt, summary, tool stats) and each following line is one API message rendered as "[role] text → tool(args)". Returns "file:line: text" hits with the ABSOLUTE path, so `read_file <path>` with those line numbers shows the full untruncated record. These folders normally live outside the workspace (extension global storage), so search_files cannot reach them. Omit `query` to get an index of sessions (id, file count, size, last write, titles) — with `sessionId` it lists that session\'s files instead. Optional: sessionId (limit to one session), kind ("session" = main-agent turns, "subagent" = sub-agent runs), caseSensitive (default false), maxResults (default 50, cap 300), context (0-10 neighbouring lines, "-" separators).',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Regex to search for (JS regex syntax). Omit to list sessions instead.' },
            sessionId: { type: 'string', description: 'Limit the search to one session id.' },
            kind: { type: 'string', enum: ['session', 'subagent'], description: 'Limit to main-agent turns or sub-agent runs.' },
            caseSensitive: { type: 'boolean', description: 'Default false.' },
            maxResults: { type: 'number', description: 'Default 50 (capped at 300).' },
            context: { type: 'number', description: 'Lines of context around each hit (0-10, default 0).' },
          },
          required: [],
        },
      },
    },
    async execute(args, signal) {
      ensureNotAborted(signal);
      const roots = getRoots();
      if (roots.length === 0) {
        return 'Error: transcript search is unavailable (no transcript folder).';
      }
      const sessionId = args.sessionId ? String(args.sessionId).trim() : undefined;
      const kindArg = args.kind ? String(args.kind).trim() : '';
      if (kindArg && kindArg !== 'session' && kindArg !== 'subagent') {
        return 'Error: "kind" must be "session" or "subagent".';
      }
      const query = args.query == null ? '' : String(args.query);
      if (!query.trim()) {
        return limitInline(listTranscriptSessions(roots, sessionId).text, 'search_transcripts');
      }
      let result;
      try {
        result = searchTranscripts({
          roots,
          pattern: query,
          sessionId,
          kind: kindArg ? (kindArg as TranscriptKind) : undefined,
          caseSensitive: args.caseSensitive === true,
          maxResults: typeof args.maxResults === 'number' ? args.maxResults : undefined,
          context: typeof args.context === 'number' ? args.context : undefined,
        });
      } catch (err) {
        return `Error: invalid regex: ${err instanceof Error ? err.message : String(err)}`;
      }
      return limitInline(result.text, 'search_transcripts');
    },
  };
}
