/**
 * Sub-agent transcript dumps.
 *
 * A sub-agent's conversation only lives inside the session tree (`node.messages`),
 * which the *main* agent cannot reach with any tool — `spawn_agents` returns just
 * a summary. So when a sub-agent finishes we also write its full structured
 * conversation to disk and hand the path back to the caller.
 *
 * Format: JSONL — one JSON object per line, no embedded newlines.
 *
 *   line 1        meta: ids, spec, status, summary, system prompt, stats
 *   line 2..N+1   one API message per line (user / assistant / tool)
 *
 * JSONL is deliberate: `read_file` can page it by line number, `search_files` can
 * grep it (e.g. every `read_file` call of a run), and the line index maps 1:1 to a
 * message. A single pretty-printed JSON blob makes all three awkward. A resume
 * rewrites the same file with the whole conversation.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ChatMessage, Usage } from '../agent/types';

/**
 * Tool results that are a runtime denial rather than real output. Anchored and
 * length-capped on purpose: a `read_file` of the source that *defines* these
 * strings (e.g. `src/tools/index.ts`) must not be mistaken for a denial.
 */
const DENIED_RES: RegExp[] = [
  /^Error: "[A-Za-z_]+" is not permitted for this read-only sub-agent\.?$/,
  /^Error: this agent may not (?:spawn|message) sub-agents\b.*$/,
];

function isDenial(text: string): boolean {
  const t = text.trim();
  return t.length < 300 && DENIED_RES.some((re) => re.test(t));
}

export interface TranscriptStats {
  /** Assistant messages that carried tool calls. */
  rounds: number;
  /** Tool name -> number of calls. */
  toolCalls: Record<string, number>;
  /** Tool name -> number of calls refused by the read-only guard. */
  deniedToolCalls: Record<string, number>;
  /** Token totals across the run's rounds (absent when the API reported none). */
  usage?: Usage;
}

export interface SubAgentTranscriptInput {
  /** Absolute directory; created on demand. The file is `<nodeId>.jsonl`. */
  dir: string;
  nodeId: string;
  sessionId: string;
  depth: number;
  write: boolean;
  model: string;
  status: string;
  resumed: boolean;
  /** This run's dispatched instruction (a resume's follow-up, when resumed). */
  instruction: string;
  summary: string;
  startedAt: number;
  endedAt: number;
  /** The sub-agent's synthesized system prompt (stripped from `messages`). */
  systemPrompt: string;
  /** Conversation without the system message. */
  messages: ChatMessage[];
  usage?: Usage;
}

export interface SubAgentTranscriptRef {
  file: string;
  lines: number;
  bytes: number;
}

/** Tool usage derived from a conversation — the "how did it use the tools" view. */
export function summarizeTranscript(messages: ChatMessage[]): TranscriptStats {
  const stats: TranscriptStats = { rounds: 0, toolCalls: {}, deniedToolCalls: {} };
  const namesById = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      stats.rounds += 1;
      for (const call of msg.tool_calls) {
        const name = call.function?.name || '?';
        stats.toolCalls[name] = (stats.toolCalls[name] ?? 0) + 1;
        if (call.id) {
          namesById.set(call.id, name);
        }
      }
      continue;
    }
    if (msg.role === 'tool' && typeof msg.content === 'string' && isDenial(msg.content)) {
      const name = (msg.tool_call_id ? namesById.get(msg.tool_call_id) : undefined) ?? msg.name ?? '?';
      stats.deniedToolCalls[name] = (stats.deniedToolCalls[name] ?? 0) + 1;
    }
  }
  return stats;
}

/** Sum per-round usage into one total (cache counters included). */
export function sumUsage(usages: Array<Usage | undefined>): Usage | undefined {
  let total: Usage | undefined;
  for (const usage of usages) {
    if (!usage) {
      continue;
    }
    total = total ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    total.prompt_tokens += usage.prompt_tokens ?? 0;
    total.completion_tokens += usage.completion_tokens ?? 0;
    total.total_tokens += usage.total_tokens ?? 0;
    if (usage.prompt_cache_hit_tokens != null) {
      total.prompt_cache_hit_tokens = (total.prompt_cache_hit_tokens ?? 0) + usage.prompt_cache_hit_tokens;
    }
    if (usage.prompt_cache_miss_tokens != null) {
      total.prompt_cache_miss_tokens = (total.prompt_cache_miss_tokens ?? 0) + usage.prompt_cache_miss_tokens;
    }
  }
  return total;
}

/** Write (or overwrite) a sub-agent's transcript and return its path + size. */
export function writeSubAgentTranscript(input: SubAgentTranscriptInput): SubAgentTranscriptRef {
  const file = path.join(input.dir, `${input.nodeId}.jsonl`);
  const stats = summarizeTranscript(input.messages);
  if (input.usage) {
    stats.usage = input.usage;
  }
  const meta = {
    type: 'meta',
    nodeId: input.nodeId,
    sessionId: input.sessionId,
    depth: input.depth,
    write: input.write,
    model: input.model,
    status: input.status,
    resumed: input.resumed,
    instruction: input.instruction,
    summary: input.summary,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: input.endedAt - input.startedAt,
    messageCount: input.messages.length,
    systemPrompt: input.systemPrompt,
    stats,
  };
  const lines: string[] = [JSON.stringify(meta)];
  input.messages.forEach((msg, index) => {
    lines.push(JSON.stringify({ type: 'message', index, ...msg }));
  });
  const body = lines.join('\n') + '\n';
  fs.mkdirSync(input.dir, { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  return { file, lines: lines.length, bytes: Buffer.byteLength(body, 'utf8') };
}

/** Remove a session's transcript folder (best effort — never throws). */
export function removeTranscriptDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Nothing to clean up, or the folder is in use; ignore.
  }
}
