/**
 * The **handoff summary** of a context rollover — the pure half
 * (`docs/agents/invariants/context-rollover.md` §6).
 *
 * A rollover normally hands the new window a *pointer*: the previous window's
 * transcript path plus a clipped tail. The composer's `Write a handoff summary`
 * answer instead spends **one** extra request on the current card to write a summary
 * of the previous window, and that summary is what the new window carries.
 *
 * Everything here is deliberately `vscode`-free and side-effect-free — the input
 * selection, its bound, the previous-summary marking, the prompt, the heading
 * validation and the fallback decision — so `tools/check-compaction.js`
 * (`npm run check:compaction`) can drive the compiled module from plain node:
 * `src/chat/runtime.ts` owns the request, the timeout and the busy state, and this
 * module owns every rule that can be wrong without a window.
 *
 * Three rules shape the whole file:
 *
 *  - **The input is bounded, and never the whole chain.** The summariser is asked
 *    about *one window* (`contextBase` → node), never the branch above it, and the
 *    selection is capped at {@link COMPACTION_INPUT_MAX_CHARS}, keeping the head and
 *    the tail when a window is too large to include whole (the first request and the
 *    most recent work are what a handoff cannot lose).
 *  - **The answer is validated by heading, not by trust.** A model that answers with
 *    prose has written nothing a next agent can navigate, so a missing heading is a
 *    retry — exactly one — and then the pointer fallback.
 *  - **Every failure is a fallback, never a failed rollover.** A timeout, an error,
 *    an empty or invalid answer all mean "the summary was unavailable": the window
 *    opens anyway with the ordinary pointer text, which is why nothing here throws.
 */

import { ChatMessage } from './types';
import { clipText, sliceText, wellFormed } from '../text';

/**
 * The cap on the **input** text handed to the summariser, in characters. It is a
 * bound on the prompt we build, not a token budget: one window can hold hundreds of
 * messages, and the summary is a second, extra request on a card whose window the
 * conversation has already outgrown — so the source is selected, clipped and
 * head+tail-trimmed instead of passed through.
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

/**
 * The output cap of the summary request (`max_tokens`). A summary that has to be read
 * by the next agent on every request must stay short; 1500 tokens is the size the
 * eleven sections fit in.
 */
export const COMPACTION_MAX_OUTPUT_TOKENS = 1_500;

/**
 * The **hard** wall-clock bound on the whole summary (the request plus its one
 * validation retry). The user already confirmed the rollover and is looking at a
 * busy composer, so a slow or wedged provider must degrade to the pointer instead of
 * holding the new window forever.
 */
export const COMPACTION_TIMEOUT_MS = 30_000;

/** Sampling temperature: a handoff is a report, not a creative act. */
export const COMPACTION_TEMPERATURE = 0.2;

/**
 * The title line a summarized rollover writes as the first message of its window.
 * It is also *how* the next rollover recognises an earlier handoff summary
 * ({@link detectPriorHandoffSummary}): the summary's own headings are ordinary
 * Markdown, so the marker has to be the harness line above them.
 */
export const COMPACTION_HARNESS_TITLE = '[Harness: context window reset — handoff summary]';

/** The marker of an *unsummarized* rollover (the pointer shape of the same feature). */
export const ROLLOVER_HARNESS_TITLE = '[Harness: context window reset]';

/**
 * The openings of the harness' own `role:'user'` texts — the pointer / resume notes
 * (`[Harness…`), an interruption notice (`[Interruption notice]`) and a background job's
 * completion writeback (`Background command …`). The user wrote none of them, so none of
 * them is a user request in the summary's input (they stay in the transcript, which the
 * window is pointed at).
 */
export const HARNESS_USER_PREFIXES = ['[Harness', '[Interruption notice]', 'Background command '] as const;

/** True when this text was written by the harness rather than by the user. */
export function isHarnessAuthored(text: string): boolean {
  const head = text.trimStart();
  return HARNESS_USER_PREFIXES.some((prefix) => head.startsWith(prefix));
}

/**
 * The eleven sections the prompt asks for, in order. The first nine are
 * {@link COMPACTION_REQUIRED_SECTIONS}; the last two are this harness' local extras
 * (they name what a file-reading agent needs and how it must treat the summary).
 */
export const COMPACTION_SECTIONS = [
  'Primary Request and Intent',
  'Key Technical Concepts',
  'Files and Code Sections',
  'Errors and Fixes',
  'Problem Solving',
  'All User Messages',
  'Pending Tasks',
  'Current Work',
  'Optional Next Step',
  'Durable References',
  'Handoff Contract',
] as const;

/**
 * The nine headings a summary **must** carry. A missing one is the one case worth a
 * retry: an answer without them is a narrative, and the next agent cannot navigate a
 * narrative. The two local extras are asked for and not required, so a model that
 * folds them into its prose still produces a usable handoff.
 */
export const COMPACTION_REQUIRED_SECTIONS = [
  'Primary Request and Intent',
  'Key Technical Concepts',
  'Files and Code Sections',
  'Errors and Fixes',
  'Problem Solving',
  'All User Messages',
  'Pending Tasks',
  'Current Work',
  'Optional Next Step',
] as const;

/** Why a summary request produced no usable summary — the `fallback:<reason>` half. */
export type CompactionFailure = 'timeout' | 'error' | 'empty' | 'invalid';

/** What {@link extractCompactionSource} produced, and the numbers the diagnostics report. */
export interface CompactionSource {
  /** The text handed to the summariser; at most {@link COMPACTION_INPUT_MAX_CHARS}. */
  text: string;
  /** `text.length` — the `in=` number of the `[perf] compaction` line. */
  chars: number;
  /** How many user messages the window holds (all of them appear in the list). */
  userCount: number;
  /** How many tool calls the selection covers. */
  toolCallCount: number;
  /** True when the window starts from an earlier handoff summary. */
  priorSummary: boolean;
  /** Characters the head+tail selection dropped (0 when the whole window fitted). */
  omittedChars: number;
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
 * True when this window **already starts from a handoff summary**: its first message
 * is the harness title this module writes. A window that begins with the plain
 * pointer title is not one — that pointer was written by the harness, not by a model,
 * and has no unresolved items of its own to carry forward.
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
 * Select and bound the **input** of the summary request from one window's messages
 * (`contextBase` → node, i.e. exactly the API prefix minus the system prompt).
 *
 * What it keeps:
 *
 *  - the **first** user message verbatim (a handoff that loses the original request
 *    is a handoff of the wrong task);
 *  - **every** user message, each clipped to {@link COMPACTION_USER_CLIP}, with the
 *    count stated (that list is what `## All User Messages` is written from);
 *  - the assistant texts of the last {@link COMPACTION_LAST_ASSISTANT} turns, clipped;
 *  - each tool call as `name -> brief -> first line of the result`;
 *  - the marking line when the window already starts from a handoff summary.
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
 * The prompt of the summary request: **one** user message, no tools, the fixed
 * eleven-section schema, and the handoff contract. Model-facing, therefore English and
 * never `vscode.l10n.t` — a translated instruction is a different instruction.
 */
export function buildCompactionPrompt(source: CompactionSource): string {
  const extras = source.priorSummary
    ? '\nThis window itself started from an earlier handoff summary: carry its unresolved items forward rather than re-inventing them, and say which of them are still open.'
    : '';
  return [
    'You are writing a handoff summary of one context window of a long conversation.',
    'Another turn of the same agent — the same agent, the same task, the same user — will read only this summary and a pointer to the full transcript. It cannot see the conversation. Write for that agent.',
    '',
    'Write English Markdown. Use exactly these eleven headings, in this order, and write nothing outside them:',
    ...COMPACTION_SECTIONS.map((heading) => `## ${heading}`),
    '',
    'Rules:',
    '- Primary Request and Intent: what the user asked for, in their own terms, and why.',
    `- Files and Code Sections: full paths plus the key snippets, each one marked "re-read before editing".`,
    '- All User Messages: every user request in this window, in order, condensed but complete — do not drop one.',
    '- Optional Next Step: quote the user\'s own words for the step that comes next.',
    '- Durable References: the transcript path of this window, the key file paths, and the background jobs and sub-agents that were stopped when the window was opened.',
    '- Handoff Contract: state that you are the same agent continuing the same task; that this summary is your memory of it; that exact file contents must be re-read before editing; and that this summary may be stale against the working tree.',
    '- Be factual. Never invent a file, a decision, a command or a result. Where the window does not show something, say that it is unknown.',
    extras,
    '',
    'The material below is the whole window, selected and clipped. Where a section says it was clipped, say in the summary what kind of work was in that gap only if the visible text shows it — never guess.',
    '',
    '--- BEGIN WINDOW ---',
    source.text,
    '--- END WINDOW ---',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** What the summary request is: its messages, its output cap and its temperature. */
export interface CompactionRequest {
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
}

/**
 * The one request `SessionRuntime` sends for a summary: no tools, non-streaming (the
 * caller uses the completion path, which never streams), a low temperature and the
 * {@link COMPACTION_MAX_OUTPUT_TOKENS} cap. Kept here so the cap and the prompt cannot
 * drift apart, and so the guard can read them.
 */
export function buildCompactionRequest(source: CompactionSource): CompactionRequest {
  return {
    messages: [{ role: 'user', content: buildCompactionPrompt(source) }],
    maxTokens: COMPACTION_MAX_OUTPUT_TOKENS,
    temperature: COMPACTION_TEMPERATURE,
  };
}

/**
 * Which of the nine required headings `summary` is missing — empty when the answer is a
 * usable handoff. Matching is deliberately forgiving (any heading level, any casing, a
 * trailing colon or period) because the *sections* are the contract, not the spelling.
 */
export function missingCompactionSections(summary: string): string[] {
  const lines = wellFormed(summary).split(/\r?\n/);
  const headings = lines
    .map((line) => line.trim().replace(/^#+/, '').trim().replace(/[:.]$/, '').toLowerCase())
    .filter(Boolean);
  const missing: string[] = [];
  for (const required of COMPACTION_REQUIRED_SECTIONS) {
    if (!headings.includes(required.toLowerCase())) {
      missing.push(required);
    }
  }
  return missing;
}

/** The decision after one summary request: the summary, or the reason it fell back. */
export type CompactionResult = { ok: true; summary: string } | { ok: false; reason: CompactionFailure };

/**
 * Decide what a finished summary request produced — the whole fallback rule, in one
 * pure place: a timeout/error is reported by the caller (it knows the failure), an
 * empty answer is `'empty'`, an answer missing a required heading is `'invalid'`.
 * Anything else is the summary, trimmed.
 *
 * It never throws and never decides anything about the rollover: every failure is the
 * pointer fallback, so this function's answer can only choose *which* handoff text
 * the new window gets.
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
 * The one-line diagnostics record of a summary attempt — `perf()` prefixes `[perf] `,
 * so this is the `[perf] compaction …` line of `docs/agents/invariants/context-rollover.md`
 * §6: the input size, the output size, how long it took and what came out of it.
 * `outcome` is `summary` or `fallback:<reason>`, so a log can count how often the
 * pointer had to cover for a provider.
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

/**
 * The **one** validation retry: the same request, the model's own answer kept as its
 * assistant turn, and a plain statement of which headings are missing. One retry and no
 * more — a model that ignores the schema twice will not produce a navigable summary on
 * the third ask, and the pointer fallback is a working handoff.
 */
export function buildCompactionRetryMessages(
  source: CompactionSource,
  answer: string,
  missing: string[],
): ChatMessage[] {
  const request = buildCompactionRequest(source);
  return [
    ...request.messages,
    { role: 'assistant', content: answer },
    {
      role: 'user',
      content:
        `That summary is missing ${missing.length} required section(s): ` +
        `${missing.map((heading) => `"## ${heading}"`).join(', ')}. ` +
        'Rewrite the whole summary with exactly the eleven headings, in order, and nothing outside them.',
    },
  ];
}
