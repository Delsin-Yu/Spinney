/**
 * The pure half of **handing a context window over** — the two shapes of it
 * (`docs/agents/invariants/context-rollover.md`, `docs/agents/invariants/compress-node.md`).
 *
 * A window ends, and the conversation continues in a new one. There are exactly two
 * deliveries, and this module owns the text of both:
 *
 *  - **the pointer** (`buildContextRolloverMessage` without `summary`) — the Simple
 *    answer: the new window is pointed at the old one's transcript and reads it itself.
 *    Zero extra requests, and everything it needs is already in memory.
 *  - **the compression** (`buildCompressInstruction`, then
 *    `buildContextRolloverMessage` with the compression node's `summary`) — the Agentic
 *    answer: a real turn reads the previous window and writes a brief, and the new window
 *    starts from that brief.
 *
 * The whole selection rule is here, `vscode`-free and side-effect-free, so
 * `tools/check-compaction.js` (`npm run check:compaction`) can drive the compiled module
 * from plain node. `src/chat/runtime.ts` owns the tree, the turns and the transcript
 * dumps; this module owns every sentence that gets written into a window.
 *
 * Four rules shape the whole file:
 *
 *  - **The input is one bounded window, never the whole chain.** The selection walks the
 *    window's own messages (`contextBase` → node, i.e. the API prefix without the system
 *    prompt) and is capped at {@link COMPACTION_INPUT_MAX_CHARS}, keeping the head and the
 *    tail when it is too large to include whole — the first request and the most recent
 *    work are what a handoff cannot lose.
 *  - **The original request is quoted, never paraphrased.** It is the one thing a summary
 *    must never be the only copy of.
 *  - **The answer is validated by heading, not by trust.** A compression that answers with
 *    prose has written nothing the next agent can navigate, so the missing headings are
 *    named — and the window still opens (`missingCompactionSections`).
 *  - **Nothing here throws, and nothing here decides.** Every judgement is data the caller
 *    acts on, so a bad handoff degrades a window instead of failing a turn.
 */

import { ChatMessage } from './types';
import { clipText, sliceText, wellFormed } from '../text';

/**
 * The cap on the **input** text handed to a compression node, in characters. It is a
 * bound on what has to be read into one turn, not a token budget: one window can hold
 * hundreds of messages, and the node that reads it has a whole window of its own to fit
 * them in.
 */
export const COMPACTION_INPUT_MAX_CHARS = 60_000;

/** How much of each user message the selection keeps ("each clipped to 500 chars"). */
export const COMPACTION_USER_CLIP = 500;

/** How many of the most recent assistant texts the selection keeps. */
export const COMPACTION_LAST_ASSISTANT = 8;

/** How much of each assistant text the selection keeps. */
export const COMPACTION_ASSISTANT_CLIP = 1_000;

/** How much of a tool call's arguments ("brief") one entry keeps. */
export const COMPACTION_TOOL_BRIEF_CLIP = 120;

/** How much of a tool call's result — its **first line** — one entry keeps. */
export const COMPACTION_TOOL_RESULT_CLIP = 200;

/** How much of the user's last request the pointer / handoff quotes verbatim. */
export const ROLLOVER_REQUEST_CAP = 2_000;

/** How much of the previous window's last answer the pointer keeps. */
export const ROLLOVER_ANSWER_CAP = 1_000;

/** The tools whose arguments name a file the turn **changed** (`editedFilesFromItems`). */
export const EDITING_TOOLS = ['write_file', 'replace_in_file', 'append_file'] as const;

/**
 * The title line a compressed window writes as the first message of its harness block.
 * It is also *how* the next compression recognises a window that already starts from a
 * handoff ({@link detectPriorHandoffSummary}): the handoff's own headings are ordinary
 * Markdown, so the marker has to be the harness line above them.
 */
export const COMPACTION_HARNESS_TITLE = '[Harness: context window reset — handoff summary]';

/** The marker of a **pointer** rollover (the Simple answer, which carries no summary). */
export const ROLLOVER_HARNESS_TITLE = '[Harness: context window reset]';

/**
 * The openings of the harness' own `role:'user'` texts — the pointer / resume notes
 * (`[Harness…`), an interruption notice (`[Interruption notice]`) and a background job's
 * completion writeback (`Background command …`). The user wrote none of them, so none of
 * them is a user request in the selection's input (they stay in the transcript, which the
 * window is pointed at).
 */
export const HARNESS_USER_PREFIXES = ['[Harness', '[Interruption notice]', 'Background command '] as const;

/** True when this text was written by the harness rather than by the user. */
export function isHarnessAuthored(text: string): boolean {
  const head = text.trimStart();
  return HARNESS_USER_PREFIXES.some((prefix) => head.startsWith(prefix));
}

/**
 * The eight sections a compression answer is asked for, in order — rewritten from
 * *You don't need long context* (arXiv:2611.05306v1, Appendix A): a compression is not a
 * summary of what happened, it is the brief the remaining work needs.
 */
export const COMPRESS_SECTIONS = [
  'Objective',
  'Standing instructions and preferences',
  'Established facts',
  'Applied changes',
  'Verification',
  'Dead ends',
  'Remaining plan',
  'Durable references',
] as const;

/**
 * The seven headings a compression answer **must** carry. Matching is deliberately
 * forgiving (any heading level, any casing, a trailing colon or period) because the
 * *sections* are the contract, not the spelling.
 *
 * `Durable references` is the one asked for and not required: an answer that folds the
 * transcript path and the re-read list into its prose still produced a usable brief,
 * while an answer that skips `Objective` has lost the task.
 */
export const COMPRESS_REQUIRED_SECTIONS = [
  'Objective',
  'Standing instructions and preferences',
  'Established facts',
  'Applied changes',
  'Verification',
  'Dead ends',
  'Remaining plan',
] as const;

/**
 * The compression node's fixed instruction — the body of its first (and only) user
 * message, after the facts the harness adds. Verbatim from the paper's Appendix A, with
 * one harness sentence in front, and deliberately English: the agent that reads the
 * handoff was given an English contract, so a translated instruction is a different
 * instruction.
 */
export const COMPRESS_INSTRUCTION = [
  'Stop and write the handoff now. Nothing continues from the previous window: this',
  'answer is the only memory the next window will have.',
  '',
  'It is not a record of what happened. It is a brief for the work that still has to',
  'be done. A narrative of the past is worthless to the agent who reads it; a picked',
  'list of facts, intentions, artifacts and next steps is what keeps this task alive.',
  '',
  'Write exactly these sections, each heading at the top of its own section, and',
  'write nothing outside them:',
  '',
  '## Objective',
  "The task in the user's own words, quoted verbatim, plus one line naming the result",
  'that counts as done.',
  '',
  '## Standing instructions and preferences',
  'Every rule, constraint and preference the user stated that still applies, with',
  'their exact words where the wording matters. Do not paraphrase a constraint.',
  '',
  '## Established facts',
  'Exact paths, symbols, commands, observed values, error texts. Separate what you',
  'observed from what you merely believe: mark an unverified idea as unverified.',
  '',
  '## Applied changes',
  'Each file created or edited, what changed in it, and whether the change was',
  'verified.',
  '',
  '## Verification',
  'The checks that were run, their outcomes, the failures and the workarounds.',
  '',
  '## Dead ends',
  'Approaches that failed, and why they must not be repeated.',
  '',
  '## Remaining plan',
  'The outstanding subgoals in execution order; the immediate next command or edit;',
  'the condition that ends the task.',
  '',
  '## Durable references',
  "The previous window's transcript path, the files that must be re-read before",
  'editing, and how to retrieve anything you had to leave out.',
  '',
  'Rules:',
  '- Quote the original task verbatim. Never replace it with your own summary of it.',
  '- Never invent an observation. If you did not read it, say so.',
  '- If a result was too large to carry, name the exact narrow command or file and',
  '  line range that retrieves it instead of quoting it.',
  '- Do not repeat the whole task or the whole document manifest back at the reader.',
  '- Write English Markdown. No preamble, no closing summary.',
].join('\n');

/** Why a compression produced no usable handoff — the `fallback:<reason>` half. */
export type CompactionFailure = 'timeout' | 'error' | 'empty' | 'invalid';

/** What {@link extractCompactionSource} produced, and the numbers the diagnostics report. */
export interface CompactionSource {
  /** The text handed to the compression node; at most {@link COMPACTION_INPUT_MAX_CHARS}. */
  text: string;
  /** `text.length` — the `in=` number of the `[perf] compaction` line. */
  chars: number;
  /** How many user messages the window holds (all of them appear in the list). */
  userCount: number;
  /** How many tool calls the selection covers. */
  toolCallCount: number;
  /** True when the window starts from an earlier handoff. */
  priorSummary: boolean;
  /** Characters the head+tail selection dropped (0 when the whole window fitted). */
  omittedChars: number;
}

/** One leftover job the rollover killed, as the handoff names it. */
export interface KilledJobLine {
  id: number;
  command: string;
  state: string;
}

/** One killed sub-agent, as the handoff names it. */
export interface KilledAgentLine {
  nodeId: string;
  transcript?: string;
}

/** The text of one message's content, without pulling `chat/tree.ts` in here. */
function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => (part.type === 'text' ? part.text : `[${part.type}]`))
    .filter(Boolean)
    .join(' ');
}

/** First line of a tool result — what an entry of the selection keeps. */
function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? '';
  return clipText(line.trim(), COMPACTION_TOOL_RESULT_CLIP);
}

/**
 * True when this window **already starts from a handoff**: its first message is the
 * harness title a compressed window writes. A window that begins with the plain pointer
 * title is not one — that pointer was written by the harness, not by a model, and has no
 * unresolved items of its own to carry forward.
 */
export function detectPriorHandoffSummary(messages: ChatMessage[]): boolean {
  for (const message of messages) {
    if (message.role !== 'user') {
      continue;
    }
    const text = textOf(message.content).trimStart();
    if (text.startsWith(COMPACTION_HARNESS_TITLE)) {
      return true;
    }
    // The first user message decides: a harness title anywhere later is a resume note,
    // not what the window started from.
    return false;
  }
  return false;
}

/**
 * The **first real user request** of a window, verbatim — the original task, which the
 * pointer and the compression instruction both quote rather than describe.
 *
 * Harness notes are `role:'user'` too, and they are skipped (`isHarnessAuthored`): a
 * window whose first message is a resume note asked nothing in that message.
 */
export function firstUserRequest(messages: ChatMessage[]): string {
  for (const message of messages) {
    if (message.role !== 'user') {
      continue;
    }
    const text = textOf(message.content).trim();
    if (text && !isHarnessAuthored(text)) {
      return text;
    }
  }
  return '';
}

/**
 * The files a window's turns **changed**, in the order they were touched, without
 * duplicates — read out of the `kind:'tool'` display items' arguments.
 *
 * It is deliberately read from the transcript items rather than from a git diff: the
 * handoff's purpose is "re-read these before editing", and what has to be re-read is what
 * the conversation itself wrote (a file changed before the window opened is the working
 * tree's business, not this handoff's). An item whose arguments do not parse is skipped:
 * a broken display item must not cost the handoff its other facts.
 */
export function editedFilesFromItems(items: ReadonlyArray<{ kind?: string; name?: string; args?: string }>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || item.kind !== 'tool' || !item.args) {
      continue;
    }
    const name = String(item.name ?? '');
    if (!(EDITING_TOOLS as readonly string[]).includes(name)) {
      continue;
    }
    let path = '';
    try {
      const parsed = JSON.parse(item.args) as { path?: unknown };
      path = typeof parsed.path === 'string' ? parsed.path : '';
    } catch {
      continue;
    }
    const trimmed = path.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * Select and bound the **input** of a compression from one window's messages
 * (`contextBase` → node, i.e. exactly the API prefix minus the system prompt).
 *
 * What it keeps:
 *
 *  - the **first** user message verbatim (a handoff that loses the original request is a
 *    handoff of the wrong task);
 *  - **every** user message, each clipped to {@link COMPACTION_USER_CLIP}, with the count
 *    stated;
 *  - the assistant texts of the last {@link COMPACTION_LAST_ASSISTANT} turns, clipped;
 *  - each tool call as `name -> brief -> first line of the result`;
 *  - the marking line when the window already starts from a handoff.
 *
 * When all of that exceeds `maxChars`, the middle is dropped — the head (the first
 * request) and the tail (the most recent work) are kept, and one marker line states how
 * many characters went missing and where to read them.
 */
export function extractCompactionSource(
  messages: ChatMessage[],
  opts?: { maxChars?: number },
): CompactionSource {
  const maxChars =
    typeof opts?.maxChars === 'number' && opts.maxChars > 0 ? opts.maxChars : COMPACTION_INPUT_MAX_CHARS;
  const priorSummary = detectPriorHandoffSummary(messages);

  // Tool results first, so one pass over the assistant messages can pair them by id.
  const results = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'tool') {
      const id = message.tool_call_id ?? '';
      if (id) {
        results.set(id, textOf(message.content));
      }
    }
  }

  const users: string[] = [];
  const assistants: string[] = [];
  const tools: string[] = [];
  for (const message of messages) {
    const text = textOf(message.content);
    if (message.role === 'user') {
      const trimmed = text.trim();
      // The harness' own notes are `role:'user'` too (a pointer, an interrupt notice, a
      // writeback). The user did not write them, so they are not user requests.
      if (trimmed && !isHarnessAuthored(trimmed)) {
        users.push(trimmed);
      }
      continue;
    }
    if (message.role === 'assistant') {
      if (text.trim()) {
        assistants.push(text.trim());
      }
      for (const call of message.tool_calls ?? []) {
        const name = call.function?.name || 'tool';
        const brief = clipText((call.function?.arguments ?? '').replace(/\s+/g, ' ').trim(), COMPACTION_TOOL_BRIEF_CLIP);
        const result = results.get(call.id) ?? '';
        tools.push(`${name} -> ${brief || '(no arguments)'} -> ${firstLine(result) || '(no result)'}`);
      }
    }
  }

  const first = users.length > 0 ? users[0] : '';
  const assistantTail = assistants.slice(-COMPACTION_LAST_ASSISTANT);

  // A flat, self-describing block list in source order: the head+tail selection below
  // drops whole blocks, so each one has to stand on its own.
  const blocks: string[] = [];
  blocks.push(
    `Window messages: ${messages.length}; user messages: ${users.length}; tool calls: ${tools.length}.` +
      (priorSummary
        ? '\nThis window already starts from an earlier handoff summary: carry its unresolved items forward instead of re-inventing them.'
        : ''),
  );
  blocks.push(`First user message (verbatim):\n${first || '(none found)'}`);
  users.forEach((text, index) => {
    blocks.push(
      `User message ${index + 1} of ${users.length} (clipped to ${COMPACTION_USER_CLIP} chars):\n` +
        clipText(text, COMPACTION_USER_CLIP),
    );
  });
  assistantTail.forEach((text, index) => {
    blocks.push(
      `Assistant text ${index + 1} of the last ${assistantTail.length} (clipped):\n` +
        clipText(text, COMPACTION_ASSISTANT_CLIP),
    );
  });
  tools.forEach((entry, index) => {
    blocks.push(`Tool call ${index + 1} of ${tools.length}:\n${entry}`);
  });

  const selected = headTailSelect(blocks, maxChars);
  return {
    text: selected.text,
    chars: selected.text.length,
    userCount: users.length,
    toolCallCount: tools.length,
    priorSummary,
    omittedChars: selected.omitted,
  };
}

/** The one line a bounded selection writes where it dropped messages. */
function omissionMarker(droppedChars: number): string {
  return (
    `…[compaction input clipped: ${droppedChars} chars from the middle of this window were left out; ` +
    'read the transcript for those messages]'
  );
}

/**
 * Keep the head and the tail of `blocks` within `maxChars` — the head (the header and
 * the first request) and the newest blocks first, alternating, because both ends of a
 * window carry what a handoff cannot lose: what was asked, and what was happening last.
 * Dropped blocks leave **one** marker line stating how much went missing.
 */
function headTailSelect(blocks: string[], maxChars: number): { text: string; omitted: number } {
  if (blocks.length === 0) {
    return { text: '', omitted: 0 };
  }
  const total = blocks.reduce((sum, block) => sum + block.length + 1, 0);
  if (total <= maxChars) {
    return { text: blocks.join('\n'), omitted: 0 };
  }
  const copy = [...blocks];
  const reserve = omissionMarker(9_999_999).length + 2;
  const kept = new Set<number>();
  let used = 0;
  const capacity = (): number => maxChars - used - reserve;
  const keep = (index: number): boolean => {
    const cost = copy[index].length + 1;
    if (cost <= capacity()) {
      kept.add(index);
      used += cost;
      return true;
    }
    // The two anchors are kept even when they alone overflow: a shortened first request
    // is still the first request, and losing it loses the task.
    if (index <= 1 && capacity() > 200) {
      copy[index] = sliceText(copy[index], capacity() - 2) + '…';
      kept.add(index);
      used += copy[index].length + 1;
      return true;
    }
    return false;
  };
  // Candidates in the order they are tried: the header, the first request, then the
  // newest block, the oldest unkept one, the second-newest, the second-oldest…
  const order: number[] = [0];
  if (copy.length > 1) {
    order.push(1);
  }
  let left = 2;
  let right = copy.length - 1;
  let takeRight = true;
  while (left <= right) {
    if (takeRight) {
      order.push(right);
      right--;
    } else {
      order.push(left);
      left++;
    }
    takeRight = !takeRight;
  }
  for (const index of order) {
    keep(index);
  }

  const pieces: string[] = [];
  let dropped = 0;
  let omitted = 0;
  for (let index = 0; index < copy.length; index++) {
    if (kept.has(index)) {
      if (dropped > 0) {
        pieces.push(omissionMarker(dropped));
        omitted += dropped;
        dropped = 0;
      }
      pieces.push(copy[index]);
    } else {
      dropped += blocks[index].length + 1;
    }
  }
  if (dropped > 0) {
    pieces.push(omissionMarker(dropped));
    omitted += dropped;
  }
  let text = pieces.join('\n');
  // Belt and braces: the selection above is sized to fit, and a bound that can still be
  // crossed by one long marker would be no bound at all.
  if (text.length > maxChars) {
    const before = text.length;
    text = sliceText(text, maxChars - 1) + '…';
    omitted += before - text.length;
  }
  return { text, omitted };
}

/**
 * Which of the seven required headings `answer` is missing — empty when the answer is a
 * usable handoff. Matching is deliberately forgiving (any heading level, any casing, a
 * trailing colon or period) because the *sections* are the contract, not the spelling.
 *
 * A non-empty result is **not** a failure: the window still opens, and the list is
 * reported on the compression card (`docs/agents/invariants/compress-node.md` §6).
 */
export function missingCompactionSections(summary: string): string[] {
  const lines = wellFormed(summary).split(/\r?\n/);
  const headings = lines
    .map((line) => line.trim().replace(/^#+/, '').trim().replace(/[:.]$/, '').toLowerCase())
    .filter(Boolean);
  const missing: string[] = [];
  for (const required of COMPRESS_REQUIRED_SECTIONS) {
    if (!headings.includes(required.toLowerCase())) {
      missing.push(required);
    }
  }
  return missing;
}

/** The decision a compression answer gets: usable, or why not. */
export type CompactionResult = { ok: true; summary: string } | { ok: false; reason: CompactionFailure };

/**
 * Decide what a finished compression turn produced — the whole rule, in one pure place:
 * the caller reports the two outcomes it alone can see (`'timeout'` / `'error'`), an empty
 * answer is `'empty'`, and an answer missing a required heading is `'invalid'`.
 *
 * The caller treats `'empty'` as "no window was opened" and `'invalid'` as "opened
 * anyway, with the missing headings named" — this function only says which it is, so the
 * judgement about a handoff lives in one place instead of two.
 */
export function classifyCompactionAnswer(input: {
  text?: string;
  failed?: 'timeout' | 'error';
}): CompactionResult {
  if (input.failed) {
    return { ok: false, reason: input.failed };
  }
  const summary = typeof input.text === 'string' ? input.text.trim() : '';
  if (!summary) {
    return { ok: false, reason: 'empty' };
  }
  if (missingCompactionSections(summary).length > 0) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, summary };
}

/**
 * The one-line diagnostics record of a compression — `perf()` prefixes `[perf] `, so this
 * is the `[perf] compaction …` line: how much was handed in, how much came out, how long
 * the turn took and what came of it. `outcome` is `summary` or `fallback:<reason>`, so a
 * log can count how often a handoff had to be delivered anyway.
 */
export function compactionDiagLine(input: {
  inputChars: number;
  outputTokens: number;
  ms: number;
  outcome: 'summary' | CompactionFailure;
}): string {
  return (
    `compaction in=${input.inputChars}chars out=${input.outputTokens}tok ms=${input.ms} ` +
    `outcome=${input.outcome === 'summary' ? 'summary' : `fallback:${input.outcome}`}`
  );
}

/** Where a window's transcript stands, as both handoff shapes state it. */
interface PointerFacts {
  sessionId: string;
  previousNodeId: string;
  transcriptPath: string;
  /** False when that file is not on disk (dumps off / never written): the pointer degrades. */
  transcriptExists: boolean;
}

/**
 * The transcript paragraph: the pointer that makes "look it up" a real instruction.
 * Model-facing English, and it degrades honestly when there is no file to point at.
 */
function transcriptParagraph(input: PointerFacts): string {
  return input.transcriptExists
    ? 'Its full transcript — every message, tool call and result — is on disk:\n' +
        `  ${input.transcriptPath}\n` +
        'Read it when you need a detail: read_file on that path, or search_transcripts with sessionId=' +
        `${input.sessionId} (line 1 is the meta record). Earlier windows of this session have their own files ` +
        'in the same folder.'
    : "The previous window's transcript is not available on disk; rely on the carried-over text and ask the " +
        'user when a detail is missing.';
}

/** The killed-work list, composed from what the rollover actually stopped. */
function killedParagraph(input: { killedBackground?: KilledJobLine[]; killedSubAgents?: KilledAgentLine[] }): string {
  const jobs = input.killedBackground ?? [];
  const agents = input.killedSubAgents ?? [];
  if (jobs.length === 0 && agents.length === 0) {
    return '';
  }
  return (
    'Stopped when this window was opened:\n' +
    [
      ...jobs.map((job) => `- background terminal #${job.id} \`${job.command}\` — ${job.state}`),
      ...agents.map(
        (agent) => `- sub-agent node ${agent.nodeId}${agent.transcript ? ` — transcript: ${agent.transcript}` : ''}`,
      ),
    ].join('\n')
  );
}

/** The size line: how full the window that ended was, in the provider's own terms. */
function usageParagraph(
  usage: { used: number; window: number; pct: number } | undefined,
  reason: 'full' | 'near' | 'images' | 'compress',
): string {
  if (!usage) {
    return '';
  }
  const tail =
    reason === 'near'
      ? "which is past the harness's 90% rollover threshold; nothing was refused yet."
      : reason === 'images'
        ? 'the refusal was about the bytes of that request, not about these tokens.'
        : reason === 'compress'
          ? 'the window was compressed to continue the conversation in a shorter one.'
          : 'which is at or past the limit this provider accepts for one request.';
  return (
    `The previous window used ${usage.used} of this model's ${usage.window}-token context ` +
    `(${usage.pct}%), ${tail}`
  );
}

/** The "changed files" paragraph: what must be re-read before it is edited again. */
function filesParagraph(files: string[]): string {
  if (files.length === 0) {
    return '';
  }
  return (
    'Files the previous window changed — re-read one before editing it, it may have moved on:\n' +
    files.map((file) => `- ${file}`).join('\n')
  );
}

/**
 * The resume text of a **context window**: the one `role:'user'` harness message the new
 * window stores (`docs/agents/invariants/context-rollover.md` §6).
 *
 * Model-facing, therefore deliberately **English** and built by plain string
 * concatenation, never through `vscode.l10n.t` — it is an instruction to the model, and a
 * translated instruction is a different instruction. The user does see this text (the card
 * renders it verbatim in a `HARNESS` block), but that is a readout of what the model was
 * told, not a message to the user.
 *
 * Two shapes, one order of facts:
 *
 *  - **the pointer** (`summary` absent) — the Simple answer: the story of why the window
 *    ended, the pointer, and the tail that makes the pointer usable (the original task, the
 *    last request, the last answer, the changed files, what was killed).
 *  - **the handoff** (`summary` present) — the Agentic answer: a compression node's answer
 *    *is* the handoff, so it comes first and the pointer facts follow it.
 */
export function buildContextRolloverMessage(input: PointerFacts & {
  /**
   * Why a new window was opened: `full` is the provider's refusal of the **tokens** (the
   * only authoritative statement of a full window), `images` its refusal of the **bytes**
   * (`Total image size exceeds the limit`), and `near` the user taking the entry before
   * anything is refused. It is stated because "it was refused" would be a lie in the last
   * case, and naming the wrong refusal sends the model after the wrong fix. `'compress'` is
   * the Agentic answer's own case: the window ended because it was compressed, whatever its
   * fill level, and the size line then claims no reason.
   */
  reason: 'full' | 'near' | 'images' | 'compress';
  /** The user's last request, raw: clipped here, and the clip is announced. */
  request: string;
  /** How many `image_url` / `file` parts that request carried (they cannot come along). */
  attachments: number;
  /** The last answer the previous window produced, raw (clipped here). */
  answer: string;
  /** The window's **first** user request (the original task), quoted verbatim. */
  firstRequest?: string;
  /** Files the previous window changed, in the order it touched them. */
  files?: string[];
  /**
   * How much of the model's context the previous window had used, when both numbers are
   * known: this is what makes the reset auditable instead of mysterious. `undefined` when
   * no request has reported usage yet, or the card declares no window — a fact the harness
   * cannot state is not stated.
   */
  usage?: { used: number; window: number; pct: number };
  /** One entry per background terminal the rollover killed (id, clipped command, final state). */
  killedBackground: KilledJobLine[];
  /** One entry per sub-agent node it killed: its dump path once its finish handler wrote it. */
  killedSubAgents: KilledAgentLine[];
  /**
   * A **compression node's** answer (`compressAndContinue`). When it is here the window is a
   * compressed one: the answer replaces the pointer's own story, and the facts that cannot
   * be handed over in prose follow it.
   */
  summary?: string;
}): string {
  const previousLine = `Previous window: node ${input.previousNodeId} of session ${input.sessionId}.`;
  const usageLine = usageParagraph(input.usage, input.reason);
  const transcriptLine = transcriptParagraph(input);
  // A caller may leave the two kill lists out (there was nothing to kill); the paragraph is
  // the only place that would notice, so the default lives here rather than in every caller.
  const killedBackground = input.killedBackground ?? [];
  const killedSubAgents = input.killedSubAgents ?? [];
  const request =
    input.request.length > ROLLOVER_REQUEST_CAP ? sliceText(input.request, ROLLOVER_REQUEST_CAP) : input.request;
  const answer =
    input.answer.length > ROLLOVER_ANSWER_CAP ? sliceText(input.answer, ROLLOVER_ANSWER_CAP) : input.answer;
  const notes = [
    // Clipping is announced: a model that reads a truncated request as the whole
    // request would silently redo only part of the work.
    input.request.length > ROLLOVER_REQUEST_CAP
      ? `(truncated: ${input.request.length} chars total, the full text is in the transcript)`
      : '',
    input.attachments > 0 ? `(the original request had ${input.attachments} attachment(s))` : '',
  ].filter(Boolean);
  // The user's own words, twice: the task that started the window and the request that
  // ended it. Both are quoted, never paraphrased — a handoff that loses the original
  // request is a handoff of the wrong task.
  const firstRequest = (input.firstRequest ?? '').trim();
  const originalLine =
    firstRequest && firstRequest !== request.trim()
      ? `The user's first request in that window, verbatim: ` +
        (firstRequest.length > ROLLOVER_REQUEST_CAP ? sliceText(firstRequest, ROLLOVER_REQUEST_CAP) : firstRequest) +
        (firstRequest.length > ROLLOVER_REQUEST_CAP
          ? ` (truncated: ${firstRequest.length} chars total, the full text is in the transcript)`
          : '')
      : '';
  const requestLine =
    `The user's last request, verbatim: ${request || '(none found)'}` +
    (notes.length > 0 ? ` ${notes.join(' ')}` : '');
  const killedLine = killedParagraph({ killedBackground, killedSubAgents });
  const filesLine = filesParagraph(input.files ?? []);
  const stillRunningLine =
    `Still running from the previous window: none — ${killedBackground.length} background terminal(s) and ` +
    `${killedSubAgents.length} sub-agent(s) were stopped when this window was opened, because their ` +
    "results could not be delivered into a full window. They are recorded in the previous window's transcript, " +
    "including each job's command, final state and output tail; a sub-agent has its own file (kind=subagent). " +
    'Read those records before redoing any of that work.';
  const redoLine =
    "Redo the user's last request here. If it depends on earlier work, fetch that from the transcript first — do " +
    'not guess.';

  // ---- A compressed window: a real turn wrote the handoff --------------------------------
  //
  // The order is fixed: the handoff first (it is what the window started from), then the
  // facts that must never exist only inside prose — the user's own words, the pointer, the
  // killed-work list, the files, and the size of the window that ended.
  if (input.summary) {
    return [
      COMPACTION_HARNESS_TITLE,
      input.summary,
      previousLine,
      originalLine,
      requestLine,
      transcriptLine,
      stillRunningLine,
      killedLine,
      filesLine,
      usageLine,
      redoLine,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  // ---- The pointer shape (the Simple answer) --------------------------------------------

  const refused =
    input.reason === 'full'
      ? 'The previous conversation could not be sent to the model any more (the provider refused it: the context window was full)'
      : input.reason === 'images'
        ? 'The previous conversation could not be sent to the model any more: the provider refused the request because of its images (the attachments it carried were over its per-request image size limit)'
        : 'The previous conversation was stopped before the provider had to refuse it (the context window was nearly used up)';
  const paragraphs: string[] = [];
  paragraphs.push(
    `${ROLLOVER_HARNESS_TITLE}\n` +
      `${refused}, so this turn continues in a new, empty window of the same session. ` +
      // A new window genuinely starts without the images (the rollover carries text only —
      // a `file_id`'s validity across windows is not guaranteed), and a model that assumed
      // its images were still here would answer about nothing.
      (input.reason === 'images'
        ? 'Those images are exactly what the provider refused, and a new window does not carry attachments: ' +
          'none of them came along, and attaching them again would cost the same bytes again — have them looked ' +
          'at by a sub-agent and report back in text. '
        : '') +
      'Nothing above was carried over: do not claim to remember it.',
  );
  paragraphs.push(previousLine);
  if (usageLine) {
    paragraphs.push(usageLine);
  }
  paragraphs.push(transcriptLine);
  // The tail is what stops the pointer from being useless: a model that does not know
  // what it does not know never looks anything up.
  paragraphs.push(
    'Carried over verbatim:\n' +
      (originalLine ? `${originalLine}\n` : '') +
      `- the user's last request: ${request || '(none found)'}${notes.length > 0 ? ` ${notes.join(' ')}` : ''}\n` +
      `- the last answer you gave: ${answer || '(none)'}`,
  );
  if (filesLine) {
    paragraphs.push(filesLine);
  }
  paragraphs.push(stillRunningLine);
  if (killedLine) {
    paragraphs.push(killedLine);
  }
  paragraphs.push(redoLine);
  return paragraphs.join('\n\n');
}

/**
 * The **first user message** of a compression node: the facts the harness knows, the
 * window's own bounded source, and then the fixed instruction
 * ({@link COMPRESS_INSTRUCTION}) — in that order, because a model reads a long prompt from
 * the top and the instruction must not be buried under a transcript.
 *
 * What the facts add over the source: the transcript path (so the model can look something
 * up rather than guess), the changed files, the size line and the killed work. The source
 * itself is bounded and clipped, so the "look it up" instruction has something to point at.
 */
export function buildCompressInstruction(input: PointerFacts & {
  source: CompactionSource;
  files?: string[];
  usage?: { used: number; window: number; pct: number };
  killedBackground: KilledJobLine[];
  killedSubAgents: KilledAgentLine[];
}): string {
  const facts = [
    '[Harness: compression turn]',
    'You are the compression node between two context windows of one conversation: the window above you ends ' +
      'here, and the window below you starts from your answer. Everything it will know about the window above ' +
      'is what you write now.',
    '',
    `Previous window: node ${input.previousNodeId} of session ${input.sessionId}.`,
    // No refusal tail here: this turn was not necessarily started by a refusal, and the
    // compression node is told the size as a fact, not as a reason.
    input.usage
      ? `The previous window used ${input.usage.used} of this model's ${input.usage.window}-token context ` +
        `(${input.usage.pct}%).`
      : '',
    transcriptParagraph(input),
    filesParagraph(input.files ?? []),
    killedParagraph(input),
    '',
    `The window's own messages, selected and bounded (${input.source.chars} chars; ` +
      `${input.source.userCount} user message(s), ${input.source.toolCallCount} tool call(s)). ` +
      'Where this says it was clipped, the transcript above has the rest.',
    '--- BEGIN WINDOW ---',
    input.source.text,
    '--- END WINDOW ---',
  ]
    .filter((part) => part !== '')
    .join('\n\n');
  return `${facts}\n\n${COMPRESS_INSTRUCTION}`;
}
