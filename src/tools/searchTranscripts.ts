import { AgentTool, TOOL_TITLE_DESCRIPTION } from '../agent/types';
import { listTranscriptSessions, searchTranscripts, TranscriptKind } from '../chat/transcript';
import { ensureNotAborted, limitInline, searchTimeoutError, searchTimeoutSeconds } from './index';

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
 *
 * The search shares `spinney.searchTimeoutSeconds` with `search_files`: one hard
 * budget for the whole call, and a budget stop answers an `Error:` line with no hits
 * and no count, so a partial page never reads as "the end of the history".
 */
export function makeSearchTranscriptsTool(getRoots: () => string[]): AgentTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'search_transcripts',
        description:
          'Search the on-disk transcripts of every session (and sub-agent run) for a regex pattern — use this to recall what happened in a previous conversation. Transcripts are JSONL files at <root>/<sessionId>/<nodeId>.jsonl: line 1 is a meta record (kind, session title, node, status, prompt, summary, tool stats) and each following line is one API message rendered as "[role] text → tool(args)". Returns "file:line: text" hits with the ABSOLUTE path, so `read_file <path>` with those line numbers shows the full untruncated record. These folders normally live outside the workspace (extension global storage), so search_files cannot reach them. Omit `query` to get an index of sessions (id, file count, size, last write, titles) — with `sessionId` it lists that session\'s files instead. Optional: sessionId (limit to one session), kind ("session" = main-agent turns, "subagent" = sub-agent runs), caseSensitive (default false), maxResults (default 50, cap 300), context (0-10 neighbouring lines, "-" separators). Every call has ONE hard time budget (spinney.searchTimeoutSeconds, 10 s by default): when it runs out the result is an `Error: search_transcripts timed out …` line with no hits and no count — then pass sessionId to search one session instead of every session.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Regex to search for (JS regex syntax). Omit to list sessions instead.' },
            sessionId: { type: 'string', description: 'Limit the search to one session id.' },
            kind: { type: 'string', enum: ['session', 'subagent'], description: 'Limit to main-agent turns or sub-agent runs.' },
            caseSensitive: { type: 'boolean', description: 'Default false.' },
            maxResults: { type: 'number', description: 'Default 50 (capped at 300).' },
            context: { type: 'number', description: 'Lines of context around each hit (0-10, default 0).' },
            title: { type: 'string', description: TOOL_TITLE_DESCRIPTION },
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
      // One hard budget for the whole call, read live — the same setting and the same
      // shape of answer as `search_files`.
      const timeoutSec = searchTimeoutSeconds();
      const started = Date.now();
      let result;
      try {
        // The await sits *inside* this try on purpose: a regex that fails to
        // compile now rejects the promise, and the tool text must stay
        // `Error: invalid regex: …`.
        result = await searchTranscripts({
          roots,
          pattern: query,
          sessionId,
          kind: kindArg ? (kindArg as TranscriptKind) : undefined,
          caseSensitive: args.caseSensitive === true,
          maxResults: typeof args.maxResults === 'number' ? args.maxResults : undefined,
          context: typeof args.context === 'number' ? args.context : undefined,
          deadlineAt: started + timeoutSec * 1000,
        });
      } catch (err) {
        return `Error: invalid regex: ${err instanceof Error ? err.message : String(err)}`;
      }
      ensureNotAborted(signal);
      if (result.timedOut || Date.now() >= started + timeoutSec * 1000) {
        // No hits and no count: a page that stopped mid-history must not read as the
        // end of the history.
        return searchTimeoutError('search_transcripts', roots.join(', '), timeoutSec);
      }
      return limitInline(result.text, 'search_transcripts');
    },
  };
}
