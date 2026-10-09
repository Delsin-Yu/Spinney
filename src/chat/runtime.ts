/**
 * SessionRuntime — everything that belongs to one session, plus its in-flight
 * turn(s). P1 moved per-session and per-turn state out of `ChatViewProvider` so
 * the provider can be a pure coordinator (sessions on disk, tabs, titles,
 * transcripts, the control plane) and each session can stream on its own.
 *
 * Two notions that used to be one are now separate (see
 * `docs/agents/multi-session.md` §2.1):
 *
 *  - **view focus** = `session.activeNodeId`: which branch the tab expands,
 *    where the composer docks, what `path` describes. `checkoutNode` moves it
 *    and repaints — it must never touch the agent history while a run is live.
 *  - **turn basis** = the node a `TurnRun` is bound to (`run.nodeId`): the agent
 *    history is (re)based only at `beginTurn`, the one safe moment, and a run
 *    writes exclusively into `run.node`'s messages/displayItems.
 *
 * Consequently every streaming message carries an explicit `nodeId`; the
 * webview never infers the stream target from the view.
 *
 * P3 runs several turns of one session at the same time, one per **node**: every
 * node that has ever run a turn owns a *worker* — its own `Agent` (whose event
 * handler, sub-agent and hop/session hooks all close over that node) plus its own
 * `ToolRegistry` (whose background owner is that node) — see
 * `docs/agents/multi-session.md` §2.3. A run is keyed by its node, so a new turn
 * is refused only when the node it would continue from is itself streaming, and
 * the interruption notice is bookkept per node so concurrent branches cannot
 * clobber each other.
 *
 * The runtime reaches the provider through the narrow `RuntimeHost` interface
 * (transcripts, config, persistence, panel routing, the global hop bookkeeping).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Agent, ImageAccounting } from '../agent/agent';
import { DEFAULT_REPLY_LANGUAGE, SYSTEM_PROMPT_TEMPLATE, currentAgentsMd } from '../agent/prompt';
import { Balance, emptyBalance } from '../agent/balance';
import { ClientRegistry } from '../agent/clients';
import { AgentEvent, ChatMessage, ContentPart, ThinkingEffort, ToolDefinition, Usage, detectImageMime } from '../agent/types';
import { ToolCapabilities, interceptedDefinitions } from '../agent/tools';
import {
  IMAGE_BUDGET_RATIO,
  INLINE_REQUEST_BODY_BYTES,
  MAX_REQUEST_IMAGE_BYTES,
  ModelCard,
  ProviderSpec,
  cardById,
  cardDisplayName,
  cards,
  contentHash,
  defaultCard,
  effortsFor,
  isVisionCard,
  normalizeEffort,
  providerById,
  resolveCard,
  visionCardsLabel,
  windowFullReason,
} from '../agent/models';
// The transform the image budget is built on (`docs/agents/plans/image-budget.md`): what
// actually leaves for the provider, so the bytes a request carries are the small ones.
import { IMAGE_TARGET_MAX_SIDE, ImageTransformRecord, transformImage } from '../agent/imageTransform';
import {
  AgentSession,
  DisplayItem,
  Epoch,
  ImageSource,
  ImageSourceEntry,
  TreeNode,
  branchIds,
  contextBase,
  epochForNode,
  TurnStatus,
  UserAttachment,
  attachNode,
  createNode,
  isSidecar,
  messageText,
  newId,
  nodeUsage,
  pathIds,
  pathMessages,
  sessionModelPick,
  titleFromPrompt,
} from './tree';
import { ToolRegistry } from '../tools';
import { BackgroundTask } from '../tools/background';
import { formatDuration } from '../duration';
import { defaultSessionTitle, isDefaultSessionTitle } from '../i18n';
import { BackgroundHub, BackgroundOwner } from './backgroundHub';
import { PromptSnippet } from './promptSnippets';
import { SubAgentPool } from './SubAgentPool';
import { hasPendingTranscriptWrite, sumUsage, summarizeTranscript } from './transcript';
import { opPayload, opTag, perf, startRepaintOp, timedSync } from '../perf';
import { clipText, sliceText, tailText } from '../text';

/** Cap tool output stored/shown in the webview so a 16 MiB command dump cannot freeze the UI. */
export const UI_TOOL_CONTENT_CAP = 32 * 1024;

/**
 * How full a chain's context has to be before the card offers to continue in a new
 * node. The provider's own refusal stays the hard trigger; this is where the *choice*
 * becomes visible — and from 90% it is a free one, because a new node starts an empty
 * prefix anyway (`docs/agents/plans/session-epoch.md` §4.3).
 */
const NEAR_CONTEXT_RATIO = 0.9;

/**
 * The largest image the materialiser will inline as a `data:` URL. Past this the block
 * degrades to a placeholder instead: inlining is what the inline transport is worst at,
 * and the read is synchronous, so it must not stall the extension host.
 */
const INLINE_IMAGE_LIMIT_BYTES = 8 * 1024 * 1024;

/** The model-facing replacements the materialiser writes (see `agent.ts` for the twin). */
const MATERIALISED_NO_VISION = '[image hidden: the current model does not support images]';
const MATERIALISED_FOREIGN_UPLOAD =
  '[image hidden: it was uploaded to a provider that this model cannot read from]';

export function clipForUi(text: string, cap = UI_TOOL_CONTENT_CAP): string {
  if (text.length <= cap) {
    return text;
  }
  const kept = sliceText(text, cap);
  return `${kept}\n…[truncated ${text.length - kept.length} chars for UI]`;
}

/** Shrink tool cards in the UI transcript; agent `messages` keep the full tool payload. */
export function clipDisplayItem(item: DisplayItem): DisplayItem {
  if (item.kind === 'tool') {
    const args = item.args ? clipForUi(item.args, 8 * 1024) : item.args;
    const content = item.content ? clipForUi(item.content) : item.content;
    if (args === item.args && content === item.content) {
      return item;
    }
    return { ...item, args, content };
  }
  if (item.kind === 'assistant' && item.thinking && item.thinking.length > 64 * 1024) {
    return { ...item, thinking: clipForUi(item.thinking, 64 * 1024) };
  }
  return item;
}

/**
 * The failure text of a node whose last turn died on an error: the `⚠️ …` item
 * `handleAgentEvent` pushed onto its card. Derived from the node's own transcript
 * rather than a side table, so it survives a reload (the error item is persisted).
 * It is a **readout and a classifier**, never a message to the model: a resume
 * tells the model nothing (see `continueFrom`), so the only callers left are the
 * full-window judgement and the rollover's reason.
 */
function lastFailureText(node: TreeNode): string | undefined {
  for (let i = node.displayItems.length - 1; i >= 0; i--) {
    const item = node.displayItems[i];
    if (item.kind === 'assistant' && item.error && item.text) {
      return item.text.replace(/^⚠️\s*/, '');
    }
  }
  return undefined;
}

/**
 * True when this node's card is a **full context window**: the turn ended in
 * `error` and the failure text it shows is the provider refusing the request as too
 * big. That 400 is the only authoritative statement that the window is full
 * (`model-capabilities.md`); `usage.prompt_tokens` is a lagging readout of the
 * *previous* request — it once read `ctx 65%` while the request actually carried
 * ~1.28 M tokens — so it is deliberately **not** a trigger. Reading the refusal back
 * off the node's own `⚠️ …` item (`lastFailureText`) is what makes the judgement
 * survive a reload: the card and the button cannot disagree about what was refused.
 *
 * There are **two** such refusals, and `windowFullReason` reads both off the same text:
 * the token one ("maximum context length …") and the byte one ("Total image size exceeds
 * the limit …" — `docs/agents/plans/image-budget.md` §2.3). A window can be full by
 * images while its token readout sits at 30%, and that refusal is the same kind of
 * statement ("I cannot send this"), so it must offer the same way out. Nothing else — no
 * threshold, no ratio — may ever qualify a node here.
 */
function nodeContextFull(node: TreeNode): boolean {
  if (node.status !== 'error') {
    return false;
  }
  const failure = lastFailureText(node);
  return !!failure && windowFullReason(failure) !== undefined;
}

/**
 * The caps on the tail a rollover carries over (§6). Carrying it is deliberate — both
 * messages are already in memory, so it costs no extra API call — but a 200 k-char
 * request would eat the new, empty window on its first request, so it is clipped and
 * the clip is announced.
 */
const ROLLOVER_REQUEST_CAP = 2000;
const ROLLOVER_ANSWER_CAP = 1000;
/**
 * How long a rollover waits for the sub-agents its union kill aborted (their finish
 * handler writes the dump the message points at). Long enough for a `persistNow` and a
 * JSONL write, short enough that a stuck job cannot hold the button.
 */
const ROLLOVER_SETTLE_TIMEOUT_MS = 2000;

/**
 * Fallback when `spinney.commandMaxForegroundDuration` is absent or not a positive
 * number: the 5 minutes the setting ships with.
 */
const DEFAULT_COMMAND_MAX_FOREGROUND_DURATION_SEC = 300;

/**
 * **Nothing may hold a turn longer than this** — `spinney.commandMaxForegroundDuration`
 * in seconds, read live so an edited setting applies to the next call without a
 * reload. The chat-side half of the rule: a sub-agent batch (`spawn_agents`) or a
 * resume (`send_agent_message`) that is still running when the budget runs out stops
 * holding the turn — the tool returns the ids and the summaries arrive later as a
 * completion notice.
 *
 * This is a deliberate **local** copy of `commandMaxForegroundDurationSec()` in
 * `src/tools/execCommand.ts` (the command-side half): importing that one would make
 * the chat layer depend on the tools layer for a single number — a cycle across the
 * seam — so the same small read is repeated here, under the same name, rather than
 * shared. Keep the two in step.
 */
function commandMaxForegroundDurationSec(): number {
  const configured = vscode.workspace.getConfiguration('spinney').get<number>('commandMaxForegroundDuration');
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_COMMAND_MAX_FOREGROUND_DURATION_SEC;
}

/**
 * Resolve after `ms` — the timer half of a bounded wait (`Promise.race` against the
 * work). Unref'd: a wait that nobody needs any more (the work finished first) must
 * not keep the extension host — or a finished test run — alive for its remainder.
 */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

/**
 * What a tool call that ran out of budget says instead of the summaries (the exact
 * text the escape result carries as `note`). One sentence of fact plus one
 * instruction: a model handed nothing but ids would otherwise keep waiting for the
 * batch — precisely the turn the budget exists to end.
 */
function batchEscapeNote(limitMs: number): string {
  return (
    `The batch is still running after ${limitMs / 1000} s; it is now delivered as a batch notice. ` +
    'End your turn: the notice carries every summary when the last one finishes.'
  );
}

/**
 * True when a finished background job was ended by the **budget**
 * (`spinney.commandMaxForegroundDuration`) rather than by the user or by its own exit.
 * That is the one ending whose completion notice has to name the budget: the command
 * was promoted to the background so the turn could end, so "was killed by the user"
 * would blame the wrong cause and hide the reason the work stopped.
 *
 * `killReason` is stamped by the tools layer (`src/tools/background.ts`, which owns the
 * command side of the same rule) and travels on the task the hub hands this runtime; a
 * task with no reason — or with `user` / `stop` / `rollover` — keeps the pre-existing
 * wording (see `buildBackgroundSignal`).
 */
function isBudgetKill(task: BackgroundTask): boolean {
  return task.killReason === 'timeout';
}

/**
 * The resume text of a rollover: the single `role:'user'` message the new window
 * stores, i.e. everything it sends besides the synthesized system prompt
 * (§5/§6 of `docs/agents/invariants/context-rollover.md`).
 *
 * Model-facing, therefore deliberately **English** and built by plain string
 * concatenation, never through `vscode.l10n.t` — it is an instruction to the
 * model, and a translated instruction is a different instruction. The user does
 * see this text (the card renders it verbatim in a `HARNESS` block), but that is
 * a readout of what the model was told, not a message to the user.
 *
 * The shape, including its three degradations, is fixed by the contract: no
 * transcript on disk (the pointer is replaced by "rely on what was carried over"), a
 * clipped request (announced with its total size) and attachments (counted, never
 * carried — a `file_id`'s validity across windows is not guaranteed). The
 * killed-work list at the end is composed from what §7 actually stopped.
 */
function buildContextRolloverMessage(input: {
  sessionId: string;
  previousNodeId: string;
  /**
   * Why a new node was opened: `full` is the provider's refusal of the **tokens** (the only
   * authoritative statement of a full window), `images` is its refusal of the **bytes**
   * (`Total image size exceeds the limit`, `docs/agents/plans/image-budget.md` §2.3), and
   * `near` is the user taking the 90% entry before the request is refused. The model is told
   * which one, because "it was refused" would be a lie in the last case — and because the
   * images have to be named as what was refused when that is what happened.
   */
  reason: 'full' | 'near' | 'images';
  /** Absolute path of the previous window's dump — the pointer the model is given. */
  transcriptPath: string;
  /** False when that file is not on disk (dump disabled / never written): the pointer degrades. */
  transcriptExists: boolean;
  /** The user's last request, raw: clipped here, and the clip is announced. */
  request: string;
  /** How many `image_url` / `file` parts that request carried (they cannot come along). */
  attachments: number;
  /** The last answer the previous window produced, raw (clipped here). */
  answer: string;
  /** One entry per background terminal the rollover killed (id, clipped command, final state). */
  killedBackground: Array<{ id: number; command: string; state: string }>;
  /** One entry per sub-agent node it killed: its dump path once its finish handler wrote it. */
  killedSubAgents: Array<{ nodeId: string; transcript?: string }>;
}): string {
  const paragraphs: string[] = [];
  // What was refused (or nearly was) is stated *first*, in the provider's own terms: the two
  // refusals are different statements, and a model told the wrong one redoes the wrong thing
  // — under `images` especially, where the fix is "do not re-attach these bytes", not "send
  // less text".
  const refused =
    input.reason === 'full'
      ? 'The previous conversation could not be sent to the model any more (the provider refused it: the context window was full)'
      : input.reason === 'images'
        ? 'The previous conversation could not be sent to the model any more: the provider refused the request because of its images (the attachments it carried were over its per-request image size limit)'
        : 'The previous conversation was stopped before the provider had to refuse it (the context window was nearly used up)';
  paragraphs.push(
    '[Harness: context window reset]\n' +
      `${refused}, so this turn continues in a new, empty window of the same session. ` +
      // The tail below already counts the attachments; this says what that count means for
      // the images themselves, because a new window genuinely starts without them (the
      // rollover carries text only — a `file_id`'s validity across windows is not
      // guaranteed). A model that assumed its images were still here would answer about
      // nothing.
      (input.reason === 'images'
        ? 'Those images are exactly what the provider refused, and a new window does not carry attachments: ' +
          'none of them came along, and attaching them again would cost the same bytes again — have them looked ' +
          'at by a sub-agent and report back in text. '
        : '') +
      'Nothing above was carried over: do not claim to remember it.',
  );
  // The display path is not cut (the tree stays connected), so "previous window"
  // names the overflowing node the new one hangs below — not its whole chain.
  paragraphs.push(`Previous window: node ${input.previousNodeId} of session ${input.sessionId}.`);
  paragraphs.push(
    input.transcriptExists
      ? 'Its full transcript — every message, tool call and result — is on disk:\n' +
        `  ${input.transcriptPath}\n` +
        'Read it when you need a detail: read_file on that path, or search_transcripts with sessionId=' +
        `${input.sessionId} (line 1 is the meta record). Earlier windows of this session have their own files ` +
        'in the same folder.'
      : "The previous window's transcript is not available on disk; rely on the carried-over text and ask the " +
        'user when a detail is missing.',
  );
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
  // The tail is what stops the pointer from being useless: a model that does not know
  // what it does not know never looks anything up.
  paragraphs.push(
    'Carried over verbatim:\n' +
      `- the user's last request: ${request || '(none found)'}${notes.length > 0 ? ` ${notes.join(' ')}` : ''}\n` +
      `- the last answer you gave: ${answer || '(none)'}`,
  );
  paragraphs.push(
    `Still running from the previous window: none — ${input.killedBackground.length} background terminal(s) and ` +
      `${input.killedSubAgents.length} sub-agent(s) were stopped when this window was opened, because their ` +
      "results could not be delivered into a full window. They are recorded in the previous window's transcript, " +
      "including each job's command, final state and output tail; a sub-agent has its own file (kind=subagent). " +
      'Read those records before redoing any of that work.',
  );
  if (input.killedBackground.length > 0 || input.killedSubAgents.length > 0) {
    paragraphs.push(
      'Stopped when this window was opened:\n' +
        [
          ...input.killedBackground.map((job) => `- background terminal #${job.id} \`${job.command}\` — ${job.state}`),
          ...input.killedSubAgents.map(
            (agent) =>
              `- sub-agent node ${agent.nodeId}${agent.transcript ? ` — transcript: ${agent.transcript}` : ''}`,
          ),
        ].join('\n'),
    );
  }
  paragraphs.push(
    "Redo the user's last request here. If it depends on earlier work, fetch that from the transcript first — do " +
      'not guess.',
  );
  return paragraphs.join('\n\n');
}

/**
 * Messages are persisted **verbatim**. There is deliberately no storage-side
 * content cap any more: what a node stores has to be byte-identical to what was
 * sent to the API, or the provider's prefix cache is lost from the truncated
 * message on after every window reload. The display caps above (`clipForUi` /
 * `clipDisplayItem`) are a different thing — they shape `displayItems` for the
 * webview and never touch `messages`.
 */

/**
 * The shape `ChatViewProvider.getConfig()` returns. Both sides need the type, so
 * it lives here next to the runtime that consumes most of it.
 */
export interface HarnessConfig {
  /**
   * The **card id** `spinney.model` holds, already healed by
   * `ChatViewProvider.resolveModel` (a deleted card, or a pre-card model id,
   * resolves to the first usable card here). It is the card a session with no
   * pick of its own starts on — never the session's live selection, which lives
   * on `SessionRuntime.model`.
   */
  defaultCardId: string;
  /**
   * Reply language **name** (not the setting's raw value) injected into the main
   * agent's system prompt — `ChatViewProvider.getConfig()` resolves
   * `spinney.replyLanguage` (`auto` → the VS Code display language) through
   * `replyLanguageName`.
   */
  replyLanguage: string;
  foldToolCalls: boolean;
  foldThinking: boolean;
  foldWork: boolean;
  maxConcurrentSubagents: number;
  maxLevel2Subagents: number;
  saveSubAgentTranscripts: boolean;
  saveSessionTranscripts: boolean;
  subAgentTranscriptDir: string;
  autoSessionTitles: boolean;
  /**
   * The composer's prompt snippets — `spinney.promptSections` merged over the
   * shipped rows (`resolvePromptSnippets` in `src/chat/promptSnippets.ts`), in
   * menu order and addressed by display name. They are **user-turn** text: the
   * webview inserts one into the input box and it travels as the message the user
   * sends, so nothing about them reaches the system prompt.
   */
  promptSnippets: PromptSnippet[];
}

/**
 * What one finished sub-agent run hands back. `durationMs` is that run's own
 * wall-clock time — the same number the node stores as `agentElapsedMs` and the
 * card freezes on, so the caller, the transcript dump's meta and the UI can never
 * disagree about how long the sub-agent took.
 */
export interface SubAgentRunResult {
  ok: boolean;
  summary: string;
  model?: string;
  modelName?: string;
  durationMs: number;
}

/**
 * One settled sub-agent of a batch, as the completion notice names it. `durationMs`
 * is that run's own time (absent only for a caller that could not have measured it).
 */
export interface SubAgentBatchEntry {
  ok: boolean;
  summary: string;
  node: TreeNode;
  durationMs?: number;
}

/** One sub-agent run: its dispatch spec plus the tree node that owns it. */
export interface SubAgentJob {
  /**
   * The dispatch as the caller wrote it. `model` is an optional **card id**
   * (already resolved from whatever the caller typed — see `parseModelOverride`);
   * absent means "the card of the session that dispatched this sub-agent".
   */
  spec: { instruction: string; write: boolean; model?: string };
  node: TreeNode;
  resume?: boolean;
  /** Session the node belongs to (for the transcript folder; falls back to active). */
  sessionId?: string;
}

/** A background terminal summarized for the webview UI. */
interface BackgroundInfo {
  id: number;
  /** The node that owns the job — the node that started it, never the view focus. */
  nodeId: string;
  /**
   * The `kind:'bg'` card that mirrors this job (null when its branch is gone): the
   * webview patches that card instead of docking a row at the bottom of the owner.
   */
  cardNodeId?: string | null;
  command: string;
  status: 'running' | 'finished';
  exitCode: number | null;
  killed: boolean;
  /**
   * The job's clock, in **host epoch ms**: `startedAt` is the origin the webview's
   * elapsed chip ticks from, and `finishedAt` (null while the job runs) is where it
   * freezes. Shipping the two clocks instead of a pre-computed `elapsed` is what
   * lets a quiet command — one that prints nothing for minutes — still show a
   * moving number, without the host pushing a snapshot every second.
   */
  startedAt: number;
  finishedAt: number | null;
  truncated: boolean;
  outputTail: string;
  /** True when the job finished but the agent has not yet been notified. */
  pendingDelivery: boolean;
}

/** What produced a signal: drives the notification block's badge, nothing else. */
export type SignalKind = 'background' | 'subagent';

/**
 * One message for a batch of signals (D2): a single `user` message per delivery, so
 * a burst of finishes costs the model one round of context, not N.
 */
function combineSignalText(batch: SignalNotice[]): string {
  if (batch.length === 1) {
    return batch[0].text;
  }
  const background = batch.filter((s) => s.kind === 'background').length;
  const subagents = batch.length - background;
  const parts = [
    background > 0 ? `${background} background terminal(s)` : '',
    subagents > 0 ? `${subagents} sub-agent batch(es)` : '',
  ].filter(Boolean);
  const lines = batch.map((s) => `- ${s.text.replace(/\n/g, '\n  ')}`);
  return `[Completion signals] ${parts.join(' + ')} finished:\n${lines.join('\n')}`;
}

/**
 * One queued "the work you started has finished" signal, waiting for delivery.
 *
 * A signal is delivered **at the next tool boundary of its owner node's running
 * turn** (so the model reacts on its next hop), or — when the node is idle — as an
 * injected turn on that same node. Either way it lands in the node that started
 * the work, never on the view focus, and it renders as a notification block
 * inside that node's card rather than as a user bubble.
 */
interface SignalNotice {
  /** The node that owns the work: where the signal (and its block) lands. */
  nodeId: string;
  kind: SignalKind;
  /**
   * The sidecar card(s) that produced the signal (`kind:'bg'` node / the sub-agent
   * node). Flipped to `delivered` the moment the signal reaches the agent.
   */
  sourceNodeIds?: string[];
  /** The text injected as a `role:'user'` message (one batch = one message). */
  text: string;
  /** Card fields of the notification block (`backgroundNotice.item`). */
  card: { kind: SignalKind; id: string | number; name: string; doneText: string; content: string };
  /** Background only: its task id, for the join/kill staleness check. */
  taskId?: number;
}

/**
 * One send = one new node (or, for an injected turn, one existing node it
 * continues). Holds the streaming basis and the coalescing buffers for exactly
 * that node, so a view change can never redirect the stream.
 */
export interface TurnRun {
  nodeId: string;
  node: TreeNode;
  /** The agent that streams this run: the worker of `node` (P3, §2.3). */
  agent: Agent;
  /** Streaming target: always `node.displayItems`. */
  items: DisplayItem[];
  /** Length of the flat path before this run; the run's messages are sliced from it. */
  prefixLen: number;
  /**
   * The message that sat at `prefixLen - 1` when the run started. Identity, not
   * equality: if the agent's history was swapped mid-run this no longer matches
   * and `finishTurn` refuses to write the slice.
   */
  prefixTail: ChatMessage | null;
  /** True when this run created its node (a user turn), false for an injected turn. */
  fresh: boolean;
  pendingText: string;
  pendingThinking: string;
  pendingTools: Map<number, { id?: string; name: string; args: string }>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /**
   * The run's one **display-only** marker: the engine's silent-retry notice
   * (`AgentEvent` `'retry'`). It lives in `items` so the card shows it, and it is
   * updated in place rather than pushed per attempt — and it is never part of
   * `messages`, because the model was told nothing (see `continueFrom`).
   */
  marker?: DisplayItem;
  /**
   * The marker's identity for the webview (`noticeId`). It is unique **per run**, not
   * per node: a later run's first retry must not rewrite the block an earlier run left
   * behind while this run's own copy of it sits in `items`.
   */
  markerId?: string;
}

/**
 * The provider surface the runtime may use. Kept deliberately narrow: anything
 * about sessions-on-disk, tabs, titles, transcripts, config or the global hop
 * bookkeeping stays on the provider.
 */
export interface RuntimeHost {
  readonly output: vscode.OutputChannel;
  /** True once the provider is tearing down; suppresses async deliveries. */
  readonly disposed: boolean;
  getConfig(): HarnessConfig;
  /**
   * Queue a content write (coalesced — see `ChatViewProvider.persist`). The default
   * for the chatty call sites (card sizes, delivered flags, tail lines).
   */
  persist(): void;
  /**
   * Name the session whose content just changed, so the next write can be limited to it.
   *
   * Every `RuntimeHost.persist()` from a `SessionRuntime` is about that runtime's own
   * session, which makes the runtime the one place that knows *what* changed — and the
   * reason a large profile no longer re-serializes all of its conversations on every turn
   * end (measured: 382 ms of blocked host for 30 sessions / 86 M chars). Marking is
   * advisory on purpose: a write with **nothing** marked writes everything, so a path that
   * forgets to mark costs time and never loses content.
   */
  markSessionDirty(sessionId: string): void;
  /**
   * Write the content **now**. For the moments where a delayed write would lose
   * real conversation state or leave the memento disagreeing with the disk (a
   * finished turn, a sub-agent's transcript, a deletion).
   */
  persistNow(): void;
  stateChanged(): void;
  /**
   * Remember an explicit dropdown pick as the **default for future sessions**: the
   * persisted `spinney.runtimeConfig` record plus the provider's
   * `defaultCardId` / `defaultThinkingEffort` seeds. The live model of a
   * conversation is per **node** (`TreeNode.model`, resolved by ancestry — see
   * `SessionRuntime.cardIdForNode`), and an explicit pick is a pending choice for
   * the node in view written back onto the session as its seed, so this call must
   * never overwrite another session's own choice: it only seeds the next one.
   * `model` is a card id.
   */
  persistRuntimeConfig(model: string, thinkingEffort: ThinkingEffort): void;
  postTo(sessionId: string, message: unknown): void;
  transcriptRoot(): string;
  transcriptDir(sessionId: string): string;
  dumpSessionTranscript(node: TreeNode, session: AgentSession, status: TurnStatus): void;
  writeSubAgentTranscript(
    job: SubAgentJob,
    subAgent: Agent,
    status: string,
    summary: string,
    startedAt: number,
  ): string | undefined;
  /** The context window in tokens for a card id (the card table's own value). */
  getContextWindow(model: string): number;
  systemPrompt(): string;
  requestAutoTitle(session: AgentSession): void;
  /**
   * Heal a user-facing model value to a **card id**: a card's name or `oaiModel`
   * (what the `spawn_agents` tool's `model` argument may hold) and a stale
   * pre-card id both land on a real card; an empty/unknown value lands on the
   * first usable card.
   */
  resolveModel(candidate: string): string;
  handleHopSession(rt: SessionRuntime, node: TreeNode, args: Record<string, unknown>): string;
  handleRenameSession(args: Record<string, unknown>): string;
  queueHopReturn(rt: SessionRuntime, node: TreeNode | null, status: TurnStatus): void;
  /**
   * True while an external controller is reloading the window (`/wait-for-finish`
   * with a hold). Every turn start — including an injected notice turn — must
   * check it: `/reload-window` refuses to run while a turn does.
   */
  isHeld(): boolean;
  /**
   * True when another window owns this workspace's session files. Every turn start is
   * refused, not just the composer's: nothing may be written into a session this window
   * does not own (`docs/agents/plans/session-epoch.md` §5).
   */
  isReadOnly(): boolean;
}

/** Decode the base64 payload of a `data:<mime>;base64,<data>` URL into bytes. */
function dataUrlBytes(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Buffer.from(base64, 'base64');
}

/**
 * A byte count for the `[image] …` log lines, at the magnitude the image budget speaks in
 * (`agent.ts` prints MiB for the same family of sentences). Never shown to a user — these are
 * `output.appendLine` diagnostics, so they need no l10n entry (`i18n.md`).
 */
function imageBytesText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${Math.round(bytes / 1024)} KiB`;
}

/** What one composer attachment is sent as, and what produced it (see `prepareAttachment`). */
interface PreparedAttachment {
  /** The bytes to upload (the transform's output when it changed anything). */
  bytes: Buffer;
  /** The `data:` URL to inline, exactly as it should ride in the request. */
  dataUrl: string;
  /** Present only when the pixels were really rewritten. */
  transform?: ImageTransformRecord;
}

/**
 * What a wallet readout is a readout **of**: the provider's identity, the dialect it
 * was read in, and the endpoint it came from. Two readouts with the same key answer
 * for the same wallet, which is what lets a checkout skip a read it already has.
 */
function balanceKeyOf(provider: ProviderSpec): string {
  return `${provider.id}|${provider.balance}|${provider.baseUrl}`;
}

export class SessionRuntime {
  readonly sessionId: string;
  readonly session: AgentSession;

  /**
   * The provider-facing client registry every request of this session goes
   * through. It is shared (one per window): a *card* names the provider, its
   * `baseUrl`, its key and the wire model, so the runtime never talks to an
   * endpoint or a model directly — see `ClientRegistry`.
   */
  private readonly clients: ClientRegistry;

  // ---- per-run / per-session state (moved off the provider in P1) ----
  /**
   * The window-level background hub. Registries live per (session, node), so a
   * job belongs to the node whose turn spawned it and never leaks into another
   * session/branch.
   */
  readonly hub: BackgroundHub;
  busy = false;
  lastStatus = '';
  currentPromptTokens = 0;
  /** Aborts an in-flight image upload (attachment path) when the user stops. */
  uploadController: AbortController | null = null;

  /**
   * One worker per node that has ever run a turn (P3, §2.3). Its `Agent`'s event
   * handler and every provider hook it exposes close over that node, and its
   * `ToolRegistry` mints background jobs under that node — so nothing ever has to
   * ask "which run is this?". Created lazily by `workerFor`.
   */
  private readonly nodeWorkers = new Map<string, { agent: Agent; tools: ToolRegistry }>();
  /**
   * Nodes whose agent currently holds a pending interruption notice (P3), keyed
   * by node id so a concurrent branch's interruption cannot clobber this one. A
   * new run on node M inherits its parent P's notice (`transferInterruptTo`) only
   * when P is in here, and otherwise clears its own stale notice — the P1 rule,
   * made per node.
   */
  private readonly interruptedNodes = new Map<string, Agent>();

  /** Live turns, keyed by the node each is bound to. P3: several may coexist. */
  readonly runs = new Map<string, TurnRun>();

  /** Concurrency pool for the main agent's level-1 sub-agents (per session). */
  readonly subAgentPool: SubAgentPool;
  /** Per-parent count of level-2 sub-agents spawned (budgeted by maxLevel2Subagents). */
  readonly level2Counts = new Map<string, number>();
  /**
   * Running sub-agents: agentNodeId -> { agent, abort } for individual kill (plus the
   * promise its own `finish` handler resolves, so a rollover can wait for the dump the
   * kill produces before it writes the new window's message).
   */
  readonly runningSubAgents = new Map<string, { agent: Agent; abort: AbortController; settled: Promise<void> }>();

  /**
   * Completion signals waiting to be delivered, keyed by the node that owns the
   * work. There is **one** queue for both producers (background terminals and
   * async sub-agents) because their delivery rules are identical: take them at the
   * owner turn's next tool boundary, or (idle node) inject them as a turn on that
   * same node.
   */
  private readonly signals = new Map<string, SignalNotice[]>();
  /** Coalesces delivery so a burst of finishes becomes one message / one turn. */
  private signalDrainTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Notices the user's **union kill** produced (pressing Stop on a node): they must
   * not open a turn — the conversation continues only when the user sends the next
   * prompt or presses ▶ Continue — so they are appended to the owning node's own
   * history (and rendered in its card) as soon as that node is quiet. That is what
   * puts them into the *next* request's context instead of continuing the
   * conversation on their own.
   */
  private readonly writebacks = new Map<string, SignalNotice[]>();

  /**
   * Turn nodes whose line was union-killed ("Stop") and has not been continued since:
   * nothing under them may continue on its own. A notice belonging to such a line is
   * written back (`writebacks`) instead of being delivered as a turn, and a stopped
   * sub-agent is **never resumed** just because its own children settled. Cleared when
   * the user sends the next prompt / ▶ Continue into that node.
   */
  private readonly stoppedLines = new Set<string>();
  /**
   * Serial behind `TurnRun.markerId`. A display-only block the webview rewrites in
   * place needs an identity that outlives one run, and only a counter can hand out
   * one without asking the DOM which blocks are already on screen.
   */
  private markerSerial = 0;
  /** Background task id -> the `kind:'bg'` card that mirrors it. */
  private readonly bgNodes = new Map<number, string>();
  /** Coalesces background UI refreshes (chatty processes fire onUpdated many times/s). */
  private bgFlushTimer: ReturnType<typeof setTimeout> | null = null;

  // Streaming perf counters (reset on a 2s window; see flushStreamDeltas).
  private streamFlushCount = 0;
  private streamFlushBytes = 0;
  private streamFlushWindow = 0;

  /**
   * The **session seed**: the card id and the level a session whose nodes recorded
   * no card of their own starts from. It is *not* the wire model name: the card's
   * `oaiModel` is filled in by `ClientRegistry.stream`, and the display name comes
   * from {@link cardDisplayName} — a rename never invalidates a stored session.
   * Seeded at construction from the session's own pick when it still shadows the
   * setting it was made under, else from the provider's defaults
   * (`spinney.runtimeConfig`, then `spinney.model`); an explicit dropdown pick still
   * writes the session's own pick back onto `this.session` (saved with it) and onto
   * the record for future sessions, so a reload and a *new* session start where the
   * user left off.
   *
   * The seed is only the **last** link of the resolution chain — a node's own card,
   * else the nearest ancestor's, else this (see `cardIdForNode`): what a session
   * with no node history at all begins with, which is exactly what the old
   * per-session pick meant (the first turn of a fresh conversation).
   */
  private seedCardId: string;
  /** The level half of the seed (see {@link seedCardId}), clamped onto the seed
   * card's own menu wherever the seed card moves. */
  private seedEffort: ThinkingEffort;
  /**
   * The dropdown's **pending** pick for the node it was made on: the card and the
   * level the **next send from that node** must use. It is deliberately a pending
   * choice and not a new session-wide value — a conversation node belongs to one
   * branch that was produced under one card, so moving the dropdown while standing
   * on an older node must not retarget anything that already ran.
   *
   * `nodeId` is the node the pick was made on (`null` for an empty session) and is
   * compared by identity against the node a request is sent from: a pick made on one
   * node is invisible from another, and a checkout forgets it outright, so the
   * dropdown follows the node you click (`checkoutNode`). A send consumes it — the
   * node that turn creates records the card and carries it from then on (`beginTurn`).
   */
  private pending: { nodeId: string | null; cardId: string; effort: ThinkingEffort } | null = null;

  /**
   * The language the main agent replies in, as the **name** the prompt carries
   * ("Japanese"), not the setting's raw value. It has **no** per-session pick — it
   * comes straight from `spinney.replyLanguage` (resolved by
   * `ChatViewProvider.getConfig()`, seeded at construction, pushed by
   * {@link applyReplyLanguage} when the setting changes), because the language is a
   * property of the reader, not of one conversation.
   */
  replyLanguage: string = DEFAULT_REPLY_LANGUAGE;
  /**
   * The context window last reported by {@link recheckContextWindow}, so a settings
   * change that did not move the window of the node in view does not repaint the
   * indicator (the live value is the {@link contextWindow} getter).
   */
  private lastContextWindow: number;

  /**
   * The provider the wallet readout on screen belongs to (id, dialect and endpoint),
   * so a checkout can tell "another provider's wallet" from "the same one again" —
   * see {@link refreshBalanceOnCheckout}. Empty until the first readout is posted.
   */
  private lastBalanceKey = '';

  /** Set by `dispose()`: a deleted session's runtime must stop delivering. */
  private disposed = false;

  constructor(
    private readonly host: RuntimeHost,
    session: AgentSession,
    clients: ClientRegistry,
    cardId: string,
    thinkingEffort: ThinkingEffort,
    hub: BackgroundHub,
  ) {
    this.session = session;
    this.sessionId = session.id;
    this.clients = clients;
    this.seedCardId = cardId;
    // The session's stored level is clamped to the seed card's own menu (a card the
    // user edited in the meantime may have dropped it), so the very first request
    // never names a level the provider never heard of.
    this.seedEffort = normalizeEffort(this.cardForCardId(cardId), thinkingEffort);
    // The reply language is not a per-session pick, so it is read straight from
    // the setting; a later edit arrives through `applyReplyLanguage`.
    this.replyLanguage = host.getConfig().replyLanguage;
    // The readout `recheckContextWindow` compares against, seeded from what the node
    // in view reports (a restored session may already stand on an older node with a
    // card of its own, which is not the constructor's seed).
    this.lastContextWindow = this.contextWindow;
    this.hub = hub;

    // A fresh sub-agent pool + budget for this session.
    this.subAgentPool = new SubAgentPool(this.host.getConfig().maxConcurrentSubagents);

    // P3: there is deliberately no session-wide agent any more. Node workers are
    // created lazily by `workerFor`, and a node's agent history is built only when
    // a run starts on it (`beginTurn` / `beginInjectedTurn`), so construction has
    // nothing to (re)base — it only seeds the view-derived counters.
    this.currentPromptTokens = this.getLatestPromptTokens();

    // Deliver any completion signal queued for this session (e.g. it finished
    // while the agent was busy and the user switched away before the drain ran).
    this.drainSignals();
  }

  // ---- Model selection: a node owns the card that produced it ----

  /**
   * The card id the **next request** would use: the pending dropdown pick when it
   * was made on the node in view, else that node's own resolved card (its own
   * `model`, else the nearest ancestor's, else the session seed). Public because the
   * coordinator reads it: the control plane's per-session readout, a transcript's
   * model label and every "what is this session running" surface are about the
   * **checked-out node**, so this is what `rt.model` must answer — never one
   * session-wide setting. {@link effectiveEffort} is the same read for the level.
   */
  effectiveCardId(): string {
    return this.requestCardId(this.viewNode());
  }

  /** See {@link effectiveCardId}: the level the next request would name. */
  effectiveEffort(): ThinkingEffort {
    return this.requestEffort(this.viewNode());
  }

  /**
   * {@link effectiveCardId} as the coordinator reads it (`rt.model`) — the same value
   * under the name the coordinator and the control plane compile against, so the
   * per-session readout reports the checked-out node's card with no change on their
   * side.
   */
  get model(): string {
    return this.effectiveCardId();
  }

  /** See {@link model}: the level the next request from the node in view would name. */
  get thinkingEffort(): ThinkingEffort {
    return this.effectiveEffort();
  }

  /**
   * The context window of the card {@link model} names. A window is a property of
   * the card, so it follows the node in view (and a pending pick on it) exactly
   * like the model does: a switch to an older node reports that node's own card's
   * window, not the one the session last used.
   */
  get contextWindow(): number {
    return this.host.getContextWindow(this.model);
  }

  /**
   * The card {@link model} names. Always defined: when that card id no longer names
   * a card (the Model Card Tree page deleted it, or a hand-edited session holds a
   * pre-card id), the fallback is the configured default card, and `cards()` itself
   * never returns an empty list — so the harness degrades to a usable model instead
   * of failing a request. Everything user-facing reads the card from here
   * (`cardDisplayName`, `isVisionCard`, `vision.transport`, `efforts`).
   */
  get card(): ModelCard {
    return this.cardForCardId(this.model);
  }

  /** A card id healed to a real card: the configured default when it names nothing. */
  private cardForCardId(id: string): ModelCard {
    return cardById(id) ?? (defaultCard(this.host.getConfig().defaultCardId) as ModelCard);
  }

  /** The node the **view focus** stands on (`undefined` for an empty session). */
  private viewNode(): TreeNode | undefined {
    const id = this.session.activeNodeId;
    return id ? this.session.nodes[id] : undefined;
  }

  /**
   * The card id a node's branch runs on, resolved **by ancestry**: the node's own
   * `model`, else the nearest ancestor that has one, else the session seed
   * ({@link seedCardId}). A node that recorded no card therefore lands on the card
   * of the branch it grew out of — which is what makes a resumed or replayed node
   * run on the model its own history was produced under instead of on whatever the
   * dropdown showed last. The walk is cycle-safe and returns the seed for an unknown
   * node (the first turn of a session, whose basis is `null`).
   */
  private cardIdForNode(node: TreeNode | undefined): string {
    let cur = node;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.model) {
        return cur.model;
      }
      cur = cur.parentId ? this.session.nodes[cur.parentId] : undefined;
    }
    return this.seedCardId;
  }

  /**
   * The level a node's branch stores, resolved by the same walk as
   * {@link cardIdForNode}: the node's own `effort`, else the nearest ancestor's,
   * else the seed level. The raw stored name is returned — it is a free-form level
   * and is only clamped by {@link effortForNode}, against **the card that node runs
   * on**, which is the whole reason the two resolutions are separate.
   */
  private effortNameForNode(node: TreeNode | undefined): ThinkingEffort {
    let cur = node;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.effort) {
        return cur.effort;
      }
      cur = cur.parentId ? this.session.nodes[cur.parentId] : undefined;
    }
    return this.seedEffort;
  }

  /**
   * The card {@link cardIdForNode} names, healed to a real card — what a request
   * built from this node's history must be sent with (`buildPath`'s identity line,
   * a node worker's seed, a sub-agent's inherited card).
   */
  private cardForNode(node: TreeNode | undefined): ModelCard {
    return this.cardForCardId(this.cardIdForNode(node));
  }

  /**
   * The level a node runs at: the stored name clamped onto **that node's card's**
   * own menu. Clamping per node is what keeps a level a card once offered from
   * reaching a provider that never heard of it, while a level shared by both cards
   * survives a switch — the same rule the session seed's level follows.
   */
  private effortForNode(node: TreeNode | undefined): ThinkingEffort {
    return normalizeEffort(this.cardForNode(node), this.effortNameForNode(node));
  }

  /** The pending pick, but only when it was made on this node (identity, not content). */
  private pendingFor(node: TreeNode | undefined): { cardId: string; effort: ThinkingEffort } | null {
    if (!this.pending || this.pending.nodeId !== (node?.id ?? null)) {
      return null;
    }
    return this.pending;
  }

  /** The card id the next request **sent from this node** would use. */
  private requestCardId(node: TreeNode | undefined): string {
    return this.pendingFor(node)?.cardId ?? this.cardIdForNode(node);
  }

  /** The level the next request **sent from this node** would name. */
  private requestEffort(node: TreeNode | undefined): ThinkingEffort {
    return this.pendingFor(node)?.effort ?? this.effortForNode(node);
  }

  /**
   * Seed the worker of the node in view with a pick, without ever creating one
   * (a node that never ran a turn has no worker) and without touching a node that
   * is **streaming**: its agent is assembling a request from the old card, so
   * swapping the card under it would invalidate what it is about to send. Nothing
   * is lost by not pushing now — `beginTurn` re-checks the node's card before every
   * request, so the pick reaches the next send either way.
   */
  private pushNodeCard(node: TreeNode | undefined, card: ModelCard, effort: ThinkingEffort): void {
    if (!node || this.runs.has(node.id)) {
      return;
    }
    const worker = this.nodeWorkers.get(node.id);
    if (worker) {
      worker.agent.setCard(card);
      worker.agent.setThinkingEffort(effort);
    }
  }

  /**
   * The nodes whose `imageSources` describe the images the next request of `node`'s chain
   * would carry: the chain from its **context base** down — exactly the slice
   * `pathMessages` sends. An image of an older window is not part of a request below it
   * (`docs/agents/invariants/context-rollover.md`), so it is not in the budget either; the
   * ids are read live, because a chain and its provenance both grow while the session runs.
   */
  private carriedPathIds(node: TreeNode): string[] {
    const ids = pathIds(this.session, node.id);
    const base = contextBase(this.session, node.id);
    const from = base ? ids.indexOf(base) : -1;
    return from > 0 ? ids.slice(from) : ids;
  }

  /**
   * What this runtime knows about the images a request would carry: the bytes behind one
   * image content part, and the ceiling the chain's transport has.
   *
   * `bytesOf` is **id-keyed**, deliberately. Provenance is *addressed* by position
   * (`messageIndex` / `partIndex`), and positions shift the moment a message is rewritten —
   * a budget that silently stopped matching would read as "free space" and walk the turn
   * into the provider's 400. A `file_id` never shifts.
   *
   * Nothing is **guessed**, either: a `file_id` with no recorded byte count, and a part that
   * is not an image at all, come back `undefined`. The consumer (`Agent.imageBytesInUse`)
   * falls back to its own record of what it uploaded this turn and otherwise counts 0, which
   * is an honest under-count that the ceiling's `IMAGE_BUDGET_RATIO` margin absorbs; a made-up
   * number would either refuse a request that would have fit or arrive one image too late.
   *
   * `limitBytes` is read at **use** time rather than frozen at construction: the ceiling
   * belongs to the card the chain sends with, and a card pick between two turns changes the
   * transport (200 MB referenced vs 48 MiB inline).
   *
   * It is installed **on the agent that will send the request** (one view per agent), and
   * both sides of it resolve live: `ids` walks the chain as provenance grows, and `transport`
   * reads the card when the ceiling is asked for. A process-wide view would answer one
   * chain's request with another chain's index — branches, sessions and sub-agents all run in
   * parallel here.
   */
  private imageAccountingFor(
    /** The nodes whose provenance describes the history the next request carries. */
    ids: () => string[],
    /** The transport the card this chain sends with declares. */
    transport: () => 'deepseek' | 'openai',
  ): ImageAccounting {
    const bytesOf = (part: ContentPart): number | undefined => {
      // An inline image needs no table: the `data:` URL in the part **is** what the request
      // body carries, so measuring it here is exact by construction — and the transform is
      // already baked into the URL (`onUserMessage` re-encodes it).
      if (part.type === 'image_url') {
        return Buffer.byteLength(part.image_url.url, 'utf8');
      }
      if (part.type !== 'file') {
        return undefined;
      }
      // A legacy entry carries no `bytes` (the field is additive, no version bump), and that
      // is exactly the case that must answer "unknown" rather than a plausible number.
      for (const id of ids()) {
        for (const entry of this.session.nodes[id]?.imageSources ?? []) {
          const source = entry.source;
          if (source.kind === 'upload' && source.fileId === part.file_id) {
            return typeof source.bytes === 'number' ? source.bytes : undefined;
          }
        }
      }
      return undefined;
    };
    return {
      bytesOf,
      get limitBytes(): number {
        const ceiling = transport() === 'openai' ? INLINE_REQUEST_BODY_BYTES : MAX_REQUEST_IMAGE_BYTES;
        return Math.floor(ceiling * IMAGE_BUDGET_RATIO);
      },
    };
  }

  /**
   * The worker for a node, created on first use (P3, §2.3). Its tools register
   * background jobs under **this** node, and its agent's provider hooks all close
   * over the same node, so a `spawn_agents` / `send_agent_message` / `hop_session`
   * call made during node X's turn always acts for X — never for "the active
   * turn", which no longer exists once two branches may run at once. The card and
   * the thinking effort are seeded **from this node** (its own, else an ancestor's,
   * else the session seed), never from the tab's current dropdown.
   */
  private workerFor(node: TreeNode): { agent: Agent; tools: ToolRegistry } {
    let worker = this.nodeWorkers.get(node.id);
    if (!worker) {
      const tools = new ToolRegistry();
      // `search_transcripts` reads the harness's own transcript dumps; the roots
      // depend on config + global storage, so hand it a live resolver.
      tools.setTranscriptRoots(() => [this.host.transcriptRoot()]);
      // One access object per node: registries live per (session, node) inside the
      // hub, so a job belongs to the branch whose turn spawned it and a task id
      // stays session-local.
      tools.setBackgroundAccess({
        currentOwner: () => ({ sessionId: this.sessionId, nodeId: node.id }),
        hub: this.hub,
      });
      const agent = new Agent(this.clients, tools, (event) => this.handleAgentEventFor(node, event));
      agent.setCard(this.cardForNode(node));
      agent.setThinkingEffort(this.effortForNode(node));
      agent.setReplyLanguage(this.replyLanguage);
      // This agent can spawn sub-agents: hand it this runtime's orchestrator,
      // bound to the same node.
      agent.setSpawnHandler((args, signal) => this.handleSpawnAgents(node, args, signal));
      // And it can resume a finished sub-agent with a follow-up message.
      agent.setSendMessageHandler((args, signal) => this.handleSendAgentMessage(node, args, signal));
      // And it can hand a self-contained task to a fresh session, which reports
      // its answer back here (only the main agent may do this).
      agent.setCanHop(true);
      // Completion signals (a finished background terminal or an async sub-agent)
      // are injected into this node's *running* turn at its next tool boundary.
      agent.setSignalHandler(() => this.takeSignalsFor(node));
      agent.setHopHandler((args) => Promise.resolve(this.host.handleHopSession(this, node, args)));
      agent.setListNodeHandler(() => Promise.resolve(this.handleListNodes(node)));
      // And it can rename the session (an explicit rename locks the title, so the
      // automatic namer leaves it alone).
      agent.setRenameSessionHandler((args) => Promise.resolve(this.host.handleRenameSession(args)));
      worker = { agent, tools };
      this.nodeWorkers.set(node.id, worker);
    }
    // The budget accounting `read_image` needs before it may attach anything: which bytes
    // this chain's next request would already carry, and the ceiling its transport has.
    // Installed on **every** call, not only when the worker is built: `workerFor` runs at the
    // start of each of this node's turns, and the view resolves the chain's provenance and
    // its card live (`carriedPathIds` / `chainCard`), so the moment before a request is
    // exactly when it has to be current. It is *this agent's* view alone — a sibling branch,
    // another tab's session and every sub-agent carry their own.
    worker.agent.setImageAccounting(
      this.imageAccountingFor(
        () => this.carriedPathIds(node),
        () => this.chainCard(node).vision.transport,
      ),
    );
    return worker;
  }

  // ---- Queries used by the coordinator ----

  /** True while a turn (or its image upload) is in flight. */
  isRunning(): boolean {
    return this.busy || this.runs.size > 0;
  }

  /** Node ids with a live run. */
  runningNodes(): string[] {
    return [...this.runs.keys()];
  }

  /**
   * Node ids whose work is not done yet, even though no turn of theirs is streaming:
   * a running background terminal (`BackgroundHub` keys a job on the node whose turn
   * spawned it), a running sub-agent batch (its direct `kind:'agent'` children are in
   * `runningSubAgents`), or a completion notice already queued for it (`signals`, the
   * window between a job finishing and its injected turn starting).
   *
   * The composer shows **Stop** for these nodes, exactly as it does for a node that is
   * streaming: one button, "stop what this node is doing". Pressing it is a union kill
   * (`stop`), which also refuses a send host-side (`onUserMessage`, `/continue`,
   * `/session/start`) — the completion notice is injected into the node that owns the
   * work while a user turn branches off the node it was sent from, so sending there
   * would run two agents on one conversation line.
   *
   * Only the owner is listed — deliberately **not** its existing descendants. A send
   * from one of those is a different line (its own path), and locking the whole
   * subtree would freeze a long-lived job's whole conversation below it.
   */
  lockedNodes(): string[] {
    const out = new Set<string>();
    for (const hit of this.hub.listForSession(this.sessionId)) {
      // A **detached** job (fire-and-forget, `BackgroundTask.detached`) owns no lock:
      // it never delivers a notice, so there is nothing for its owner to wait for —
      // and holding the composer on Stop for a job that will never report back is
      // exactly the loop this filter exists to break. Ownership is unchanged: the
      // card still renders in that node's column, and the job is still killed with
      // its node's line (`runningBackgroundsForNodes` / `runningBackgroundCount`
      // deliberately keep counting it — deleting the branch really does kill it).
      if (hit.task.status === 'running' && hit.task.detached !== true) {
        out.add(hit.owner.nodeId);
      }
    }
    for (const agentNodeId of this.runningSubAgents.keys()) {
      const parentId = this.session.nodes[agentNodeId]?.parentId;
      if (parentId) {
        out.add(parentId);
      }
    }
    for (const [nodeId, queue] of this.signals) {
      if (queue.length > 0) {
        out.add(nodeId);
      }
    }
    return [...out].filter((id) => !!this.session.nodes[id]);
  }

  /** How many unfinished pieces of work `lockedNodes` is counting for one node. */
  lockedWorkCount(nodeId: string): number {
    // The **same filter** as `lockedNodes`, counted per node instead of as a set:
    // a running detached job is not work this node owes the conversation (no notice
    // can ever arrive), so the count and the lock must not disagree — the composer
    // reads the set, and the host's refusal of a send there reads this number.
    let n = 0;
    for (const task of this.hub.listForNode(this.sessionId, nodeId)) {
      if (task.status === 'running' && task.detached !== true) {
        n += 1;
      }
    }
    for (const agentNodeId of this.runningSubAgents.keys()) {
      if (this.session.nodes[agentNodeId]?.parentId === nodeId) {
        n += 1;
      }
    }
    n += this.signals.get(nodeId)?.length ?? 0;
    return n;
  }

  /** True while any node worker's agent is mid-turn (defensive; see `isRunning`). */
  agentRunning(): boolean {
    for (const worker of this.nodeWorkers.values()) {
      if (worker.agent.running) {
        return true;
      }
    }
    return false;
  }

  /** True while this session owns at least one running background job. */
  hasRunningBackground(): boolean {
    return this.runningBackgroundCount() > 0;
  }

  /**
   * True while this session owns a running **node** job — one that locks its node and sends a
   * completion notice. A `start_detached` (fire-and-forget) job deliberately does not count
   * here, and that is not cosmetic: the idle gates that call this feed `hop_session`'s refusal,
   * the session list's `busy` flag, `globallyIdle()` — which the queued session start, the hop
   * return and the control plane's `POST /wait-for-finish` all wait on — and the reload
   * refusal. Counting a detached job there would mean a dev server keeps the harness
   * permanently not-idle, so the supervisor could never reload the window.
   *
   * The kill paths still count it: `runningBackgroundCount` is what the delete/clear
   * confirmations read (a reload or a branch deletion really does kill the process), and
   * `ControlState.runningBackgrounds` stays a factual readout of what is running.
   */
  hasRunningNodeBackground(): boolean {
    return this.hub
      .listForSession(this.sessionId)
      .some((hit) => hit.task.status === 'running' && hit.task.detached !== true);
  }

  /** How many background jobs of this session are still running. */
  runningBackgroundCount(): number {
    return this.hub.listForSession(this.sessionId).filter((hit) => hit.task.status === 'running').length;
  }

  /**
   * The nodes of this session that own at least one still-running background job.
   * The control plane reports it so a controller (or a test) can verify that a job
   * stayed with the branch that spawned it while the view moved elsewhere.
   */
  backgroundNodes(): string[] {
    const nodes: string[] = [];
    for (const hit of this.hub.listForSession(this.sessionId)) {
      if (hit.task.status === 'running' && !nodes.includes(hit.owner.nodeId)) {
        nodes.push(hit.owner.nodeId);
      }
    }
    return nodes;
  }

  /**
   * Running background jobs owned by any of these nodes. The delete/clear paths
   * use it to decide whether a "kill them too?" confirmation is needed.
   */
  runningBackgroundsForNodes(ids: string[]): number {
    let n = 0;
    for (const id of ids) {
      n += this.hub.runningForNode(this.sessionId, id);
    }
    return n;
  }

  runningSubAgentCount(): number {
    return this.runningSubAgents.size;
  }

  hasRunningSubAgent(id: string): boolean {
    return this.runningSubAgents.has(id);
  }

  /** The system prompt this session would send on its next request (the node in
   * view, with any pending pick on it). */
  systemPromptText(): string {
    return Agent.systemPrompt(cardDisplayName(this.card), this.thinkingEffort, this.replyLanguage);
  }

  /**
   * The system prompt for one node's branch: its identity line names the card
   * **that node resolves to** and the level it runs at, so a request built from an
   * older node's history tells the model which model is about to answer it — the
   * card of that branch, not the dropdown's current value.
   */
  private systemPromptFor(node: TreeNode | undefined): string {
    return Agent.systemPrompt(cardDisplayName(this.cardForNode(node)), this.effortForNode(node), this.replyLanguage);
  }

  /**
   * The tool schemas a **live** setup would advertise right now, built without touching
   * any worker: the drift check compares them against a frozen set, and it runs while
   * other nodes may be mid-turn, so nothing here may mutate an agent.
   *
   * A bare registry is enough because no tool *schema* depends on the wiring (the access
   * objects gate execution, not the definitions); the one runtime value in the whole set
   * is `exec_command`'s shell label, which is a process-wide probe.
   */
  private liveToolSchemas(card: ModelCard, sidecar: boolean): ToolDefinition[] {
    const registry = new ToolRegistry();
    const capabilities: ToolCapabilities = {
      vision: isVisionCard(card),
      canSpawn: !sidecar,
      canSpawnReadOnly: false,
      canHop: !sidecar,
    };
    return [...registry.definitions, ...interceptedDefinitions(capabilities)];
  }

  /**
   * Freeze the request envelope a chain starts with: the rendered prompt bytes, the tool
   * schemas, the endpoint facts and the content hashes the drift check compares.
   *
   * Called once per epoch — a session's first node, a rollover node, a fork's root, and
   * a legacy chain adopted at load — and never again. Re-rendering is exactly what this
   * mechanism exists to prevent: a prefix that changes behind the model's back can never
   * be cached again, while one that never changes is billed at the cache price whenever
   * the entry is alive (`docs/agents/plans/session-epoch.md`).
   */
  private freezeEpoch(node: TreeNode, cardId: string, effort: ThinkingEffort): Epoch {
    const card = this.cardForCardId(cardId);
    const level = normalizeEffort(card, effort);
    const provider = providerById(card.providerId);
    // Seed any existing worker with this card, but never *create* one here: a fork freezes
    // an envelope per copied node, and building an agent (plus its tool registry) for a node
    // that may never run would be pure overhead. `beginTurn` builds the one that matters.
    const worker = this.nodeWorkers.get(node.id);
    if (worker && !this.runs.has(node.id)) {
      worker.agent.setCard(card);
      worker.agent.setThinkingEffort(level);
    }
    // The schemas are read from the **live** capability set for this card, never from a pin
    // an earlier epoch left on that worker: the envelope has to describe what this build
    // would send, or a re-frozen chain would inherit a tool set that belongs to the epoch
    // before it.
    const tools = this.liveToolSchemas(card, isSidecar(node));
    return {
      id: newId(),
      prompt: Agent.systemPrompt(cardDisplayName(card), level, this.replyLanguage),
      tools,
      cardId: card.id,
      effort: level,
      replyLanguage: this.replyLanguage,
      providerId: card.providerId,
      baseUrl: provider?.baseUrl ?? '',
      wireModel: card.oaiModel,
      vision: isVisionCard(card),
      visionTransport: card.vision.transport === 'deepseek' ? 'deepseek' : 'openai',
      agentsMdHash: contentHash(currentAgentsMd() ?? ''),
      templateHash: contentHash(SYSTEM_PROMPT_TEMPLATE),
      toolsetHash: contentHash(JSON.stringify(tools)),
      frozenAt: Date.now(),
    };
  }

  /**
   * The prompt-token count of the newest turn on **this node's own chain** (0 when it has
   * none). Deliberately not the session-wide readout: a branch's own history is what its
   * next request will carry, so that is what "how full is it" has to mean.
   */
  private chainPromptTokens(node: TreeNode): number {
    const ids = pathIds(this.session, node.id);
    for (let i = ids.length - 1; i >= 0; i--) {
      const n = this.session.nodes[ids[i]];
      const usage = n ? nodeUsage(n) : undefined;
      if (usage && typeof usage.prompt_tokens === 'number' && usage.prompt_tokens > 0) {
        return usage.prompt_tokens;
      }
    }
    return 0;
  }

  /** The card a node's chain sends with: its epoch's, else the live resolution. */
  private chainCard(node: TreeNode): ModelCard {
    const epoch = epochForNode(this.session, node.id);
    return epoch ? this.cardForCardId(epoch.cardId) : this.cardForNode(node);
  }

  /**
   * How full this node's chain is: `'full'` when the provider refused the request (the
   * only authoritative statement of a full window), `'near'` from {@link NEAR_CONTEXT_RATIO}
   * of the card's window, `'ok'` otherwise. Computed once, here, and shipped as data —
   * the webview never re-derives a model fact.
   */
  private contextState(node: TreeNode): 'ok' | 'near' | 'full' {
    if (nodeContextFull(node)) {
      return 'full';
    }
    const tokens = this.chainPromptTokens(node);
    const window = this.host.getContextWindow(this.chainCard(node).id);
    if (tokens <= 0 || !window || window <= 0) {
      return 'ok';
    }
    return tokens / window >= NEAR_CONTEXT_RATIO ? 'near' : 'ok';
  }

  /** The same measurement as a percentage, for the card's title (0 when unknown). */
  private contextPercent(node: TreeNode): number {
    const tokens = this.chainPromptTokens(node);
    const window = this.host.getContextWindow(this.chainCard(node).id);
    if (tokens <= 0 || !window || window <= 0) {
      return 0;
    }
    return Math.min(100, Math.round((tokens / window) * 100));
  }

  /**
   * Which ceiling the `⧉` rollover is being offered for, as the new window's message has to
   * state it: the provider's refusal of the **tokens** (`full`), its refusal of the
   * **bytes** (`images`), or the user taking the 90% entry before anything is refused
   * (`near`).
   *
   * The kind is read from the very text `nodeContextFull` reads, so the button, the card and
   * the sentence the model gets cannot disagree — and `images` is asked **first**, because
   * `contextState()` reports both refusals as `'full'` (deliberately: both mean "this request
   * cannot be sent"). No threshold is involved; the refusal text is the only trigger.
   */
  private rolloverReason(node: TreeNode): 'full' | 'near' | 'images' {
    const failure = node.status === 'error' ? lastFailureText(node) : undefined;
    if (failure && windowFullReason(failure) === 'images') {
      return 'images';
    }
    return this.contextState(node) === 'full' ? 'full' : 'near';
  }

  /**
   * The composer's two setups and whether they disagree —
   * `docs/agents/plans/session-epoch.md` §4.2. `node` is the envelope of the checked-out
   * node (what a send really uses) and `live` is what a **new** node would freeze right
   * now. `drift` is `'user'` when the difference comes from a pick the user just made,
   * `'harness'` when it comes from the shipped prompt, the workspace AGENTS.md, the tool
   * set or the endpoint, and `false` when a plain send already is the latest setup.
   *
   * The webview recomputes none of this: it renders what it is told and posts back the
   * user's choice. Keeping the judgement here is what makes "default send always uses the
   * old setup" true by construction instead of by agreement between two code bases.
   */
  private setupState(): {
    node: { cardId: string; cardLabel: string; effort: ThinkingEffort; language: string } | null;
    live: { cardId: string; cardLabel: string; effort: ThinkingEffort; language: string };
    drift: false | 'user' | 'harness';
    reasons: string[];
  } {
    const view = this.viewNode();
    const liveCard = this.card;
    const liveEffort = this.thinkingEffort;
    const live = {
      cardId: liveCard.id,
      cardLabel: cardDisplayName(liveCard),
      effort: liveEffort,
      language: this.replyLanguage,
    };
    const epoch = epochForNode(this.session, view?.id ?? null);
    if (!epoch) {
      // Nothing frozen to protect: the next send freezes whatever is live now.
      return { node: null, live, drift: false, reasons: [] };
    }
    const node = {
      cardId: epoch.cardId,
      cardLabel: cardDisplayName(this.cardForCardId(epoch.cardId)),
      effort: epoch.effort,
      language: epoch.replyLanguage,
    };
    const reasons: string[] = [];
    const picked =
      liveCard.id !== epoch.cardId || liveEffort !== epoch.effort || this.replyLanguage !== epoch.replyLanguage;
    if (liveCard.id !== epoch.cardId) {
      reasons.push('model');
    }
    if (liveEffort !== epoch.effort) {
      reasons.push('effort');
    }
    if (this.replyLanguage !== epoch.replyLanguage) {
      reasons.push('language');
    }
    // The harness side: the shipped prompt, the workspace's AGENTS.md, the tool set and
    // the endpoint. All four are content hashes, never version numbers, so a release that
    // changes none of them is not a change.
    if (contentHash(SYSTEM_PROMPT_TEMPLATE) !== epoch.templateHash) {
      reasons.push('prompt');
    }
    if (contentHash(currentAgentsMd() ?? '') !== epoch.agentsMdHash) {
      reasons.push('agents.md');
    }
    if (contentHash(JSON.stringify(this.liveToolSchemas(liveCard, view?.kind === 'agent'))) !== epoch.toolsetHash) {
      reasons.push('tools');
    }
    const provider = providerById(liveCard.providerId);
    if ((provider?.baseUrl ?? '') !== epoch.baseUrl || liveCard.oaiModel !== epoch.wireModel) {
      reasons.push('provider');
    }
    // How an image travels is part of a setup too: a card that cannot read what this
    // chain's history carries is a real difference, not a cosmetic one.
    if (isVisionCard(liveCard) !== epoch.vision || liveCard.vision.transport !== epoch.visionTransport) {
      reasons.push('images');
    }
    if (reasons.length === 0) {
      return { node, live, drift: false, reasons };
    }
    return { node, live, drift: picked ? 'user' : 'harness', reasons };
  }

  /** Tear down: kill background jobs, abort sub-agents, cancel timers. */
  dispose(): void {
    this.disposed = true;
    if (this.signalDrainTimer != null) {
      clearTimeout(this.signalDrainTimer);
      this.signalDrainTimer = null;
    }
    if (this.bgFlushTimer != null) {
      clearTimeout(this.bgFlushTimer);
      this.bgFlushTimer = null;
    }
    for (const run of this.runs.values()) {
      if (run.flushTimer != null) {
        clearTimeout(run.flushTimer);
        run.flushTimer = null;
      }
    }
    // Kill and forget every job this session owns (registries are per node).
    this.hub.removeSession(this.sessionId, { kill: true });
    this.cleanupSubAgents();
    // Drop every node worker (and its agent) with the runtime.
    this.nodeWorkers.clear();
    this.interruptedNodes.clear();
  }

  /** True once the runtime (or the whole extension) is shutting down. */
  private get dead(): boolean {
    return this.disposed || this.host.disposed;
  }

  private post(message: unknown): void {
    this.host.postTo(this.sessionId, message);
  }

  // ---- Configuration ----

  /**
   * The dropdown picked a card: a **pending** pick for the node in view, i.e. what
   * the next send from that node will run on. `model` is a card id (the webview's
   * dropdown carries ids, never names).
   *
   * Nothing that already ran is retargeted — a branch's history was produced under
   * one card and must keep running on it — so no other node's worker is touched;
   * only the worker of the node in view is, and only when it exists and is idle
   * (`pushNodeCard`). `beginTurn` re-checks the node's card before every request,
   * so the pick reaches the next send even when it cannot be pushed now.
   *
   * The bookkeeping the pick still carries is unchanged: it is written onto the
   * session as this session's own seed (saved with the session) and remembered as
   * the default for **future** sessions; but a pick that merely re-selects the card
   * the node in view already runs is a **no-op** — nothing said, nothing persisted —
   * which is exactly the case a per-session comparison used to get wrong.
   */
  setModel(model: string): void {
    // A card id, a card name or a wire name (`resolveModel` accepts all three) is
    // healed to a real card id here: a stale value from an older catalog resolves
    // to a usable card rather than silently mis-sizing the indicator, hiding
    // images or sending a model the provider never heard of.
    const nextCardId = this.host.resolveModel(model);
    if (!nextCardId) {
      return;
    }
    const view = this.viewNode();
    // What the node in view was produced under (its own card/level, else an
    // ancestor's, else the session seed) versus what its next request would use.
    const nodeCardId = this.cardIdForNode(view);
    const nodeEffort = this.effortForNode(view);
    const beforeCardId = this.requestCardId(view);
    const beforeEffort = this.requestEffort(view);
    const nextCard = this.cardForCardId(nextCardId);
    // The level travels with the card: one the picked card does not offer is
    // repaired to the picked card's own default, so a pick never leaves a level
    // behind that this provider has never heard of.
    const nextEffort = normalizeEffort(nextCard, beforeEffort);

    if (nextCardId === nodeCardId) {
      // The pick names the card this node already runs, so the next request does not
      // move: the dropdown is a **no-op** here — no notice, no notice text change and
      // nothing persisted. This is the case a per-session comparison used to get
      // wrong: the session's last pick (made on another node) was what it compared
      // against, so switching back to the card the node was already using warned
      // about a change the next request never makes. A stale pending override is
      // dropped, because what the dropdown must show is this node's own card and
      // level again; the dropdowns and the context-usage indicator are repainted only
      // when that override really was in force.
      this.pending = null;
      if (nodeCardId !== beforeCardId || nodeEffort !== beforeEffort) {
        this.postConfig();
        this.postContext();
      }
      this.host.output.appendLine(`[config] model=${nextCardId} (card in view; no change)`);
      return;
    }

    // A real pick: pending for the node in view, and forgotten the moment the view
    // focus moves (`checkoutNode`) — the dropdown then follows the node that was
    // clicked instead of dragging a stale override along.
    this.pending = { nodeId: view?.id ?? null, cardId: nextCardId, effort: nextEffort };
    // The pick is also this session's own seed, exactly as before: written onto the
    // session (saved with it) and remembered as the default for future sessions. The
    // session's stored level is updated with it so a reload reconstructs the same
    // seed instead of re-deriving it from a level that belonged to the old card.
    this.session.model = nextCardId;
    this.session.modelFromSettings = this.host.getConfig().defaultCardId;
    this.session.effort = nextEffort;
    this.session.effortFromSettings = nextCard.defaultEffort;
    this.seedCardId = nextCardId;
    this.seedEffort = nextEffort;
    // The one agent a pick may touch: the worker of the node in view (no broadcast
    // loop — a worker is seeded from its own node, and `beginTurn` re-checks the
    // node's card anyway).
    this.pushNodeCard(view, nextCard, nextEffort);
    this.persistTurn();
    this.host.persistRuntimeConfig(nextCardId, nextEffort);
    this.postConfig();
    this.postContext();
    // The id, not the display name: this is a diagnostic line, and the id is what
    // the stored session, the transcripts and the sub-agent nodes all carry.
    this.host.output.appendLine(
      `[config] model=${nextCardId} (pending for ${view ? `node ${view.id}` : 'an empty session'})`,
    );
  }

  /**
   * Adopt a changed `spinney.model` setting (`spinney.model` is a card id). The
   * setting is the **seed** — what a session with no node history starts from — so
   * it moves the nodes that resolve to the seed (nothing on their path recorded a
   * card) and leaves every branch that recorded its own card exactly where it is: a
   * branch keeps running on the card its history was produced under, however the
   * setting changes afterwards.
   *
   * The arbitration is the old one: only a session with no effective pick of its own
   * follows the setting (an explicit pick keeps winning), and a pick anchored to the
   * previous setting value is retired here, because editing the setting is an
   * explicit choice too (see `loadRuntimeConfig` in the provider).
   */
  applyDefaultModel(model: string): void {
    if (sessionModelPick(this.session, this.host.getConfig().defaultCardId) !== undefined) {
      // This session picked a model itself and the setting it was picked against has
      // not changed: the session's own seed wins over the settings value.
      return;
    }
    // A pick anchored to an older `spinney.model` value loses to the edited
    // setting, so it is dropped here rather than being resurrected on the next
    // reload (where `sessionModelPick` would ignore it anyway).
    const hadPick = this.session.model !== undefined;
    const next = this.host.resolveModel(model);
    if (!next) {
      return;
    }
    delete this.session.model;
    delete this.session.modelFromSettings;
    const beforeCardId = this.model;
    const moved = next !== this.seedCardId;
    this.seedCardId = next;
    this.seedEffort = normalizeEffort(this.cardForCardId(next), this.seedEffort);
    if (!moved) {
      // The seed itself did not move; only the session's stored pick may have (a
      // stale one being retired).
      if (hadPick) {
        this.persistTurn();
      }
      return;
    }
    // Every node whose card comes from the seed follows it. A node that recorded a
    // card of its own is left alone, and a node that is streaming keeps the card its
    // running request was built with — its next turn re-checks it (`beginTurn`).
    for (const [id, worker] of this.nodeWorkers) {
      const node = this.session.nodes[id];
      if (!node || this.cardIdForNode(node) !== next || this.runs.has(id)) {
        continue;
      }
      worker.agent.setCard(this.cardForNode(node));
      worker.agent.setThinkingEffort(this.effortForNode(node));
    }
    this.persistTurn();
    this.postConfig();
    this.postContext();
    this.host.output.appendLine(`[config] model=${next} (settings; the session seed)`);
  }

  /**
   * The dropdown picked a level: a **pending** level for the node in view, on the
   * card that node's next request will use (a pending card pick included). The card
   * owns the menu of levels, so the value is passed through `normalizeEffort` first:
   * one the card does not offer is repaired to that card's own default instead of
   * being sent to a provider that never heard of it.
   *
   * Like {@link setModel} this is a pending choice for the next send from the node in
   * view, it touches no other node's worker, and picking the level this node already
   * runs is a no-op: no notice, nothing persisted. There is no
   * `spinney.thinkingEffort` setting any more, so the anchor a pick shadows is the
   * **card's** `defaultEffort` (a card the user re-pointed at a different default
   * therefore retires the pick, exactly as an edited setting used to).
   */
  setThinkingEffort(effort: ThinkingEffort): void {
    const view = this.viewNode();
    const nodeCardId = this.cardIdForNode(view);
    const nodeEffort = this.effortForNode(view);
    const nextCardId = this.requestCardId(view);
    const beforeEffort = this.requestEffort(view);
    // The card the next request uses (a pending card pick included) owns the menu.
    const nextCard = this.cardForCardId(nextCardId);
    const next = normalizeEffort(nextCard, effort);

    if (next === nodeEffort && nextCardId === nodeCardId) {
      // The level this node already runs: a no-op (see `setModel`); a stale pending
      // level is dropped and the dropdown repainted only if it really was in force.
      this.pending = null;
      if (next !== beforeEffort) {
        this.postConfig();
      }
      this.host.output.appendLine(`[config] thinkingEffort=${next} (level in view; no change)`);
      return;
    }

    this.pending = { nodeId: view?.id ?? null, cardId: nextCardId, effort: next };
    // The session-level bookkeeping is the old one: the pick is the session's own
    // level, written onto the session (saved with it) and remembered as the default
    // for future sessions. It is anchored to the **seed card's** default, because
    // `session.model` / `session.effort` are the pair a reload reads back as the
    // seed (`effectiveEffort` in the coordinator), and the seed card need not be the
    // card in view — the seed level is the pick clamped onto the seed card.
    const seedCard = this.cardForCardId(this.seedCardId);
    this.session.effort = next;
    this.session.effortFromSettings = seedCard.defaultEffort;
    this.seedEffort = normalizeEffort(seedCard, next);
    this.pushNodeCard(view, nextCard, next);
    this.persistTurn();
    this.host.persistRuntimeConfig(this.seedCardId, this.seedEffort);
    this.postConfig();
    this.host.output.appendLine(
      `[config] thinkingEffort=${next} (pending for ${view ? `node ${view.id}` : 'an empty session'})`,
    );
  }

  /**
   * Adopt a changed `spinney.replyLanguage` setting. `language` is the resolved
   * **name** (`ChatViewProvider.getConfig().replyLanguage`), so the `auto` →
   * display-language step has already happened: re-picking `auto` on a window that
   * already follows its own language is a no-op.
   *
   * Nothing already sent is rewritten. Every frozen envelope keeps the language it was
   * rendered with, and the value below is what the **next new node** will freeze — which
   * is exactly what the composer reports as the drift between the two setups
   * (`setupState`). The language is part of a prefix, and a prefix is append-only.
   */
  applyReplyLanguage(language: string): void {
    if (this.busy) {
      return; // never move a setup under a running request
    }
    const next = (language || '').trim() || DEFAULT_REPLY_LANGUAGE;
    if (next === this.replyLanguage) {
      return;
    }
    this.replyLanguage = next;
    this.host.output.appendLine(`[config] replyLanguage=${next} (new nodes; frozen chains keep theirs)`);
    // The two setups may now disagree: repaint the composer's drift marking.
    this.postConfig();
  }

  /**
   * Drop the pending setup and put the session seed back where the checked-out chain's
   * envelope says it belongs. This is the "Continue with current setup" answer
   * (`docs/agents/plans/session-epoch.md` §4.2): the pick the user made is *discarded*,
   * never remembered — the dropdown returns to the frozen values precisely because the
   * send that follows it must not silently become a different setup.
   */
  discardPendingSetup(): void {
    this.pending = null;
    const view = this.viewNode();
    const epoch = epochForNode(this.session, view?.id ?? null);
    if (!epoch) {
      this.postConfig();
      return;
    }
    const card = this.cardForCardId(epoch.cardId);
    this.session.model = epoch.cardId;
    this.session.effort = epoch.effort;
    this.session.modelFromSettings = this.host.getConfig().defaultCardId;
    this.session.effortFromSettings = card.defaultEffort;
    this.seedCardId = epoch.cardId;
    this.seedEffort = normalizeEffort(card, epoch.effort);
    this.persistTurn();
    this.host.persistRuntimeConfig(this.seedCardId, this.seedEffort);
    this.postConfig();
    this.postContext();
  }

  /** Push a settings change onto the live sub-agent pool. */
  setSubAgentPoolLimit(maxConcurrent: number): void {
    this.subAgentPool.setMaxConcurrent(maxConcurrent);
  }

  /** Re-read the context window for the card the node in view reports (and the
   * pending pick on it) and repaint if it moved. */
  recheckContextWindow(): void {
    const contextWindow = this.contextWindow;
    if (contextWindow !== this.lastContextWindow) {
      this.lastContextWindow = contextWindow;
      this.postContext();
    }
  }

  /** True if the checked-out branch has any conversation beyond the system prompt. */
  private hasHistory(): boolean {
    return this.activePathItems().length > 0;
  }





  // ---- Checkout / view focus ----

  /**
   * Check out a node: the view focus becomes `nodeId` (root→node defines the
   * `path` the tab shows and where the composer docks). P3 keeps **no** session
   * agent to rebase — each node worker's history is rebuilt when a run starts on
   * its node (`beginTurn`), the one safe moment — so a checkout is always
   * view-only and can never disturb a live run. Callers post to the webview.
   *
   * The model selection follows this focus: the dropdown's pending pick is forgotten
   * here, because it was made *for the node the user was standing on* and every node
   * has its own card — clicking an older node must show that node's card, not drag
   * the override along. (Workers that were seeded from it are re-seeded by the next
   * `beginTurn`, which re-checks the node's card before every request.)
   */
  private checkoutNode(session: AgentSession, nodeId: string | null): void {
    if (nodeId !== session.activeNodeId) {
      this.pending = null;
    }
    session.activeNodeId = nodeId;
  }

  /**
   * The flat API history of a branch: a fresh system prompt + the path messages.
   * The prompt is built for **that node**, so its identity line and effort sentence
   * name the card `nodeId` resolves to — a request assembled from an older node's
   * history announces the model that will really answer it, not the dropdown's
   * current value.
   */
  private buildPath(session: AgentSession, nodeId: string | null): ChatMessage[] {
    const node = nodeId ? session.nodes[nodeId] : undefined;
    // The frozen envelope wins over the live render: that is what makes a prefix
    // reproducible across a reload, a settings change and an extension update. A chain
    // with no envelope (one that predates the epoch model) still renders as it always
    // did, so nothing breaks while a legacy session waits to be adopted (`freezeEpoch`).
    const epoch = epochForNode(session, nodeId);
    const system: ChatMessage = {
      role: 'system',
      content: epoch ? epoch.prompt : this.systemPromptFor(node),
    };
    // sanitizeMessages returns a derived copy; it is never written back into the
    // nodes, so the stored history keeps its original shape.
    return Agent.sanitizeMessages([system, ...pathMessages(session, nodeId)]);
  }

  /** Every transcript item of the checked-out branch, in reading order. */
  private activePathItems(): DisplayItem[] {
    const session = this.session;
    const items: DisplayItem[] = [...session.orphanItems];
    for (const id of pathIds(session, session.activeNodeId)) {
      const node = session.nodes[id];
      if (node) {
        items.push(...node.displayItems);
      }
    }
    return items;
  }

  /**
   * Check out another node (tree UI "click a block"). A view-only switch: it is
   * allowed while a run streams (the run keeps writing into its own node) and
   * only ignores unknown or already-checked-out nodes.
   */
  handleCheckout(nodeId: string): void {
    const session = this.session;
    if (!session.nodes[nodeId] || nodeId === session.activeNodeId) {
      return;
    }
    // Clicking a block only repaints the view path — but the webview may have to
    // render a branch it never showed (markdown + layout), so it is traced like a
    // session switch, and the `path` message carries the op id back to it.
    startRepaintOp('checkout-node', this.sessionId, `session=${this.sessionId} node=${nodeId}`);
    timedSync('checkout', () => {
      this.checkoutNode(session, nodeId);
      this.currentPromptTokens = this.getLatestPromptTokens();
    });
    // No `reset`/`tree`: the structure is unchanged, so the webview just repaints
    // the active path in place (no tear-down → no blink), then pans to it.
    this.postPath();
    this.post({ type: 'panTo', id: nodeId });
    // The model selection is per node, so the checkout **is** a config change: both
    // dropdowns and the context-usage indicator follow the node that was clicked
    // (which is why the pending pick had to be dropped above).
    this.postConfig();
    this.postContext();
    this.postSessionStats();
    // The wallet is the other thing a checkout moves: it answers for the provider the
    // tab is on now (`refreshBalanceOnCheckout` skips it when that did not change).
    void this.refreshBalanceOnCheckout();
  }

  /** Persist a user-resized card's bounds onto a node (drag-resize finished). */
  onSetNodeSize(id: string, w: number, h: number): void {
    const node = this.session.nodes[id];
    if (!node || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      return;
    }
    node.customSize = { w, h };
    this.persistTurn();
  }

  /** Prompt size of the checked-out branch, taken from its latest turn's usage. */
  private getLatestPromptTokens(): number {
    const items = this.activePathItems();
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.usage && typeof item.usage.prompt_tokens === 'number') {
        return item.usage.prompt_tokens;
      }
    }
    return 0;
  }

  // ---- Repaints ----

  /**
   * The one `nodeUpdate` patch shape: the card's status/title/usage plus the derived
   * fact the webview cannot compute for itself — `contextFull`, which decides the
   * button variant (`⧉ Continue in a new window` vs `↻ Retry`). It is built in one
   * place because hand-built payloads drift apart, and a turn that ends **after** the
   * tree was drawn only ever arrives as a `nodeUpdate`: a patch that forgot the flag
   * would leave the card offering a retry of the very request the provider just
   * refused.
   */
  private nodeStatePatch(node: TreeNode): {
    id: string;
    status: TurnStatus;
    title: string;
    usage: Usage | undefined;
    contextFull: boolean;
    context: 'ok' | 'near' | 'full';
    contextPct: number;
  } {
    return {
      id: node.id,
      status: node.status,
      title: node.title,
      usage: nodeUsage(node),
      contextFull: nodeContextFull(node),
      context: this.contextState(node),
      contextPct: this.contextPercent(node),
    };
  }

  /**
   * Structural summary of the session tree + the view/stream ids (no items).
   *
   * The message is built by {@link treeMessage} and posted unchanged.
   */
  postTree(): void {
    const message = this.treeMessage();
    opPayload('post-tree', message);
    this.post(message);
  }

  /**
   * The `tree` message of this session, built but **not** posted (`postTree` is the poster).
   */
  treeMessage(): Record<string, unknown> {
    const session = this.session;
    const nodes = Object.values(session.nodes).map((node) => ({
      id: node.id,
      parentId: node.parentId,
      children: node.children.slice(),
      title: node.title,
      status: node.status,
      createdAt: node.createdAt,
      preview: this.nodePreview(node),
      usage: nodeUsage(node),
      // The webview never re-derives a model fact from error text: the provider's
      // refusal is judged once, here, and shipped as a boolean. `contextBaseId` is
      // what it draws the dashed edge and the `CTX` badge from.
      contextFull: nodeContextFull(node),
      // How full this chain is (`ok` / `near` / `full`) and how much of the card's window
      // that is: the card's button slot follows `context`, and the `near` variant's title
      // carries `contextPct`. Both are judged in one place so the host and the webview can
      // never disagree about when a new node is worth offering.
      context: this.contextState(node),
      contextPct: this.contextPercent(node),
      contextBaseId: node.contextBaseId,
      // The epoch this node starts, when it starts one: it is what a new tree is copied
      // from and what a diagnostic names.
      epochId: node.epoch ? node.epoch.id : undefined,
      size: node.customSize ?? null,
      kind: node.kind,
      delivered: node.delivered === true,
      agentDepth: node.agentDepth,
      agentStatus: node.agentStatus,
      agentModel: node.agentModel,
      agentWrite: node.agentWrite,
      // A sub-agent's clock: `agentStartedAt` is live-only (it drives the card's
      // ticking chip) and `agentElapsedMs` is the last run's duration (what the card
      // shows once the run is over, and what the caller was told in its result).
      agentStartedAt: node.agentStartedAt,
      agentElapsedMs: node.agentElapsedMs,
      // A `kind:'bg'` card carries the terminal snapshot of its job, so it renders
      // (and re-renders after a reload) without asking the hub, which is
      // in-memory and forgot the job the moment the window went away.
      bgTaskId: node.bgTaskId,
      bgCommand: node.bgCommand,
      bgExitCode: node.bgExitCode,
      bgKilled: node.bgKilled,
      bgElapsedMs: node.bgElapsedMs,
      bgOutputTail: node.bgOutputTail,
      // Whether this job is **detached** (fire-and-forget): it locks no node and never
      // notifies, so its card wears the `shared` badge. Read from the hub rather than
      // stored on the node — the flag belongs to the live task, not to the card's
      // terminal snapshot — so a card restored after a reload (which has no task left
      // to ask) renders as the plain record it is. `shared` is not a delivery marker:
      // `delivered` stays the D1 field for "the agent has been told".
      bgDetached: node.kind === 'bg' && this.backgroundTaskDetached(node.bgTaskId) ? true : undefined,
      // The row's item half, built in the one place both payloads build it
      // (`nodeRowItems`): a **finished** turn leaves as its two-item **summary**, a
      // running one in the shape it always had. A sub-agent card still carries only its
      // **count** and fetches its transcript when the card is actually expanded
      // (`onAgentItems`), because shipping every sidecar's items made one session's tree
      // 2.3 MB and 10 k DOM elements for 8 cards
      // (see docs/agents/invariants/streaming-perf.md).
      ...this.nodeRowItems(node, 'tree'),
    }));
    return {
      type: 'tree',
      activeId: this.activeStreamNodeId(),
      viewId: session.activeNodeId,
      rootId: session.rootIds[0] ?? null,
      rootIds: session.rootIds.slice(),
      nodes,
      // Only a traced repaint (a switch / a checkout) of *this* session carries the
      // id: the webview measures the burst it belongs to and reports it back.
      ...opTag(this.sessionId),
    };
  }

  /**
   * The checked-out branch's transcript, grouped by node (for the tree view).
   *
   * `items` comes from the same builder `treeMessage` uses (`nodeRowItems`), so a finished
   * node leaves as its two-item summary here too: a `path` for a long session used to ship
   * every node's whole transcript, and one node's full log now crosses only when its card is
   * expanded (`loadNodeItems` → `nodeItems`, `onNodeItems`).
   */
  postPath(): void {
    const session = this.session;
    const ids = pathIds(session, session.activeNodeId);
    const nodes = ids.map((id) => {
      const node = session.nodes[id];
      return {
        id,
        status: node.status,
        ...this.nodeRowItems(node, 'path'),
      };
    });
    const message = { type: 'path', ids, nodes, ...opTag(this.sessionId) };
    opPayload('post-path', message);
    this.post(message);
  }

  /**
   * The two items a finished turn is summarised by: its **first `user` item** (what was
   * asked) and its **last assistant item with text** (what came back), in that order.
   *
   * `undefined` when that pair is not a *proper* subset of the log, which is the rule that
   * keeps the flag honest in both directions:
   *
   *  - a node with **no items**, or with items carrying neither half, must gain no empty
   *    summary at all — a renderer reads a summary row as "this card is rendered", so an
   *    empty one would stop the card from ever asking for the log it has not got (the
   *    measured symptom: a card next to a `preview` that promised a full session and
   *    showed nothing);
   *  - a pair that **is** the whole log (a two-item turn) needs no flag either: the row
   *    would carry the same bytes either way, and without the flag nothing is fetched
   *    again for a log already in hand.
   *
   * Both halves at most, never a third item: the summary is what a *collapsed* card shows.
   * The last assistant item **with text** is the answer because that is the same rule the
   * collapsed `preview` uses (`nodePreview`) — an assistant item that carries only usage or
   * thinking is not something to show as the result.
   *
   * Two incidental rules, both of which this file holds to on purpose: it names **nothing**
   * but its argument and the one clipper (no `this`, no second helper), and its body carries
   * no type annotation.
   */
  private summaryItems(items: DisplayItem[]): DisplayItem[] | undefined {
    const ask = items.find((item) => item.kind === 'user');
    const answer = items.filter((item) => item.kind === 'assistant' && item.text).pop();
    const picked = ask ? (answer ? [ask, answer] : [ask]) : answer ? [answer] : [];
    // The one clipper (`clipDisplayItem`) — a summary must not ship bytes a `path` would
    // have clipped, or a tool item's 16 MiB dump would ride the tree after all.
    return picked.length > 0 && picked.length < items.length ? picked.map(clipDisplayItem) : undefined;
  }

  /**
   * The item half of one node row, built **here** for both payloads so `tree` and `path`
   * cannot disagree about what a row is: `{ items?, summary?, itemCount? }`, spread into the
   * row by the caller.
   *
   * A **finished** turn (`status !== 'running'`) leaves as its {@link summaryItems} summary
   * and says so with `summary: true`, plus its true `itemCount` — the count is on the row
   * for *every* finished node (before this, only an `agent` row carried one), which is what
   * lets a card say how much log it is not showing. A **running** turn's row is unchanged:
   * its card is filled by its own stream, and a summary built mid-turn would be overwritten
   * by the next delta anyway.
   *
   * Why this exists: a session's `tree` carries structure only — `itemCount` for `agent`
   * nodes alone and a 120-char `preview` — so a card drawn from a `tree` row that carried no
   * log would show nothing but the preview text. The other fix (ship the transcript in
   * `tree`) is the one that made a session's tree 2.3 MB and 10 k DOM elements; two items per
   * finished node keep that off, and one node's full log crosses only when its card is
   * expanded (`loadNodeItems` → `nodeItems`, `onNodeItems`).
   *
   * A `kind: 'agent'` row stays summary-less on purpose: its card's contract is `itemCount`
   * plus `loadAgentItems` (the lazy sidecar rule above), its transcript is a sidecar log
   * rather than a conversation turn, and a `summary: true` row would tell a renderer the
   * transcript is already in hand — exactly what that rule says is not true. The two items
   * a summary would pick are already carried where they belong, as the sub-agent's own
   * `agentDone` summary. A `kind: 'bg'` card has no items at all (its body mirrors the live
   * job), so it is simply an `itemCount: 0` row.
   *
   * `payload` is the one difference between the two rows: a `path` is the owner's own view
   * and always carried a log, so a row that is not a summary keeps shipping one; a `tree`
   * never carried a log at all (`itemCount` only), so there the same row leaves with the
   * count alone and its card fetches what it needs.
   */
  private nodeRowItems(
    node: TreeNode,
    payload: 'tree' | 'path',
  ): { items?: DisplayItem[]; summary?: true; itemCount?: number } {
    const all = node.displayItems;
    const finished = node.status !== 'running';
    const summary = finished && node.kind !== 'agent' ? this.summaryItems(all) : undefined;
    if (summary) {
      return { items: summary, summary: true, itemCount: all.length };
    }
    if (payload === 'path') {
      const items = all.map(clipDisplayItem);
      return finished ? { items, itemCount: all.length } : { items };
    }
    return finished || node.kind === 'agent' ? { itemCount: all.length } : {};
  }

  /**
   * One sub-agent card asked for its transcript (`loadAgentItems`, posted by the
   * webview when such a card is expanded). The `tree` message carries only
   * `itemCount` for those nodes, so a session switch ships KBs instead of
   * megabytes; this is the on-demand half of that contract.
   */
  onAgentItems(nodeId: string): void {
    const node = this.session.nodes[nodeId];
    if (!node || node.kind !== 'agent') {
      return;
    }
    this.postItems(node, 'agentItems');
  }

  /**
   * One **regular** node asked for its items (`loadNodeItems`, sent by a card whose items
   * never arrived — see `media/main.js`). A card is normally filled from the `path` message,
   * which `postPath` only sends for the owner's own view chain, so a card drawn from a `tree`
   * row alone holds no log: it says it is waiting and asks once. The summary is what an
   * *expanded* card renders while its full log is on the way; a collapsed card shows the
   * row's `preview` and asks for nothing.
   *
   * An id this session does not have answers nothing, exactly like the `agentItems` half
   * above: there is no node to clip and no `items` to invent.
   */
  onNodeItems(nodeId: string): void {
    const node = this.session.nodes[nodeId];
    if (!node) {
      return;
    }
    this.postItems(node, 'nodeItems');
  }

  /**
   * The one on-demand answer shape: a node's **full** `displayItems`, clipped by the one
   * clipper (`clipDisplayItem`), plus the `[perf]` line that says the fetch fired. Both
   * requests (`loadAgentItems` / `loadNodeItems`) go through here, so the two answers cannot
   * drift apart in clipping or in what a card renders.
   *
   * It is deliberately **not** the summary a row carries (`nodeRowItems`): this is the
   * answer to a card that was expanded, so it is the whole log — the summary is what makes
   * the row useful *before* anyone asks, and asking is what replaces it.
   */
  private postItems(node: TreeNode, messageType: 'agentItems' | 'nodeItems'): void {
    const items = node.displayItems.map(clipDisplayItem);
    // The `[perf]` label keeps the word the log already used for the sidecar half
    // (`agent-items`) and gives this sibling its own, so an existing grep stays true.
    const label = messageType === 'agentItems' ? 'agent-items' : 'node-items';
    // Logged unconditionally: this is the on-demand half of the lazy sidecar
    // contract, and `[perf]` is the only place a real window can confirm it fired
    // (and how big the answer was) without a debugger.
    perf(
      () =>
        `${label} ${node.id} items=${items.length} ` +
        `chars=${items.reduce((n, it) => n + (it.text?.length ?? 0) + (it.content?.length ?? 0) + (it.args?.length ?? 0), 0)}`,
    );
    this.post({ type: messageType, id: node.id, items });
  }

  /** First line of the turn's answer, used as a collapsed card preview. */
  private nodePreview(node: TreeNode): string {
    for (let i = node.displayItems.length - 1; i >= 0; i--) {
      const item = node.displayItems[i];
      if (item.kind === 'assistant' && item.text) {
        return item.text.split('\n')[0].trim().slice(0, 120);
      }
    }
    return node.title.slice(0, 80);
  }

  /**
   * The context-usage readout of the **node in view**: `total` is that node's card's
   * window and `model` the card id it reports, both read through the same getters
   * `postConfig` uses, so a checkout (or a pending pick) moves the indicator with the
   * dropdown instead of leaving the session's last window on screen.
   */
  postContext(): void {
    this.post({
      type: 'context',
      used: this.currentPromptTokens,
      total: this.contextWindow,
      model: this.model,
    });
  }

  /** Token totals for the checked-out branch, derived from each turn's usage. */
  private computeSessionStats(): {
    totalTokens: number;
    cacheHit: number;
    cacheMiss: number;
    cacheHitRate: number;
    cacheKnown: boolean;
  } {
    let totalTokens = 0;
    let cacheHit = 0;
    let cacheMiss = 0;
    for (const item of this.activePathItems()) {
      if (!item.usage) continue;
      totalTokens += item.usage.total_tokens || 0;
      cacheHit += item.usage.prompt_cache_hit_tokens || 0;
      cacheMiss += item.usage.prompt_cache_miss_tokens || 0;
    }
    const denom = cacheHit + cacheMiss;
    const cacheKnown = denom > 0;
    const cacheHitRate = cacheKnown ? (cacheHit / denom) * 100 : 0;
    return { totalTokens, cacheHit, cacheMiss, cacheHitRate, cacheKnown };
  }

  postSessionStats(): void {
    this.post({ type: 'sessionStats', stats: this.computeSessionStats() });
  }

  /**
   * Push the model selection of the **node in view** to the webview — the card and
   * the level its next request would use (a pending dropdown pick on that node
   * included). The `cards` array is the whole catalog (id, name, provider, vision,
   * levels) so the two dropdowns and the image affordances are built from one list —
   * the webview keeps no copy of its own, and a card the Model Card Tree page just
   * edited shows up on the next repaint. `model` is a card **id**; `efforts` are the
   * levels *that card* offers, which is what the effort dropdown shows.
   *
   * `snippets` is the composer's prompt-snippet list (`{ name, text }`, shipped
   * rows first) — the webview builds the menu from it and keeps no copy, so
   * editing `spinney.promptSections` repaints it exactly like a catalog edit.
   */
  postConfig(): void {
    const cfg = this.host.getConfig();
    this.post({
      type: 'config',
      model: this.model,
      cards: cards().map((c) => ({
        id: c.id,
        name: c.name,
        providerId: c.providerId,
        providerName: providerById(c.providerId).name,
        vision: c.vision.enabled,
        efforts: effortsFor(c),
        defaultEffort: c.defaultEffort,
      })),
      efforts: effortsFor(this.card),
      thinkingEffort: this.thinkingEffort,
      foldToolCalls: cfg.foldToolCalls,
      foldThinking: cfg.foldThinking,
      foldWork: cfg.foldWork,
      snippets: cfg.promptSnippets,
      // The two setups the composer shows, and whether they disagree: the webview marks
      // Send (and offers the new-setup entry) from this alone.
      setup: this.setupState(),
    });
  }

  /**
   * Push the busy/status state for this session plus the nodes that are
   * streaming. The webview shows Stop iff the view focus is one of
   * `runningNodes`; `sessionId` lets it remember its session (vscode.setState).
   * `lockedNodes` is the complementary rule for a node that is *not* streaming but
   * still owns unfinished work (see `lockedNodes`): its Send and input are disabled
   * until that work has been delivered.
   */
  postState(): void {
    this.post({
      type: 'state',
      sessionId: this.sessionId,
      busy: this.isRunning(),
      status: this.lastStatus,
      runningNodes: this.runningNodes(),
      lockedNodes: this.lockedNodes(),
      // A read-only window (another window owns this workspace's sessions) says so with
      // every state post, so the composer can show it instead of failing a send.
      readOnly: this.host.isReadOnly(),
    });
  }

  /**
   * Fetch the wallet of the provider **the card in view routes to** and push it to
   * this session's tab, with the provider's own identity beside it. Two sessions on
   * different providers therefore show different numbers, which is exactly right — a
   * wallet is a property of the endpoint, not of the harness — and a checkout to a
   * node of another provider follows it (`refreshBalanceOnCheckout`). Refreshed at the
   * start and after each turn, always.
   *
   * Best-effort, but **never stale**: whatever happens below, the tab is told which
   * provider the readout belongs to and is handed an empty one when there is nothing
   * to show (a failed refresh, or a provider whose `balance` dialect is `none`). That
   * is what keeps a `bal –` honest instead of leaving the previous provider's number
   * on screen. A failure costs one line in the output channel.
   */
  async refreshBalance(): Promise<void> {
    const provider = providerById(this.card.providerId);
    let balance: Balance;
    try {
      balance = await this.clients.balance(provider);
    } catch (err) {
      this.host.output.appendLine(
        `[balance] ${provider.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      balance = emptyBalance();
    }
    this.lastBalanceKey = balanceKeyOf(provider);
    this.post({ type: 'balance', providerId: provider.id, providerName: provider.name, balance });
  }

  /**
   * The checkout's half of the rule above: the wallet answers for the provider the tab
   * is on now, so clicking into another provider's branch re-reads it — and clicking
   * around one provider's own branch does not, because the readout already belongs to
   * that provider and a checkout is a gesture, not a spend.
   */
  async refreshBalanceOnCheckout(): Promise<void> {
    if (balanceKeyOf(providerById(this.card.providerId)) === this.lastBalanceKey) {
      return;
    }
    await this.refreshBalance();
  }

  /** Full repaint of this session's tab (used on activation / panel rerender). */
  postAllState(): void {
    // A cold session switch is already traced (its op is open, for this session);
    // a repaint nobody asked for — a window reload, a panel VS Code revived, which
    // restores *every* chat tab at once — opens an op of its own per session, so
    // the tabs never report on each other. Either way the webview's `paint` report
    // closes the op.
    startRepaintOp('panel-repaint', this.sessionId);
    timedSync('post-all-state', () => {
      this.currentPromptTokens = this.getLatestPromptTokens();
      this.post({ type: 'reset', ...opTag(this.sessionId) });
      this.postState();
      this.postTree();
      this.postPath();
      this.postConfig();
      this.postContext();
      this.postSessionStats();
      this.postBackgrounds();
    });
    void this.refreshBalance();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.postState();
    this.host.stateChanged();
  }

  private pushItem(item: DisplayItem): void {
    this.currentItems().push(item);
  }

  /** Append a notice card to the current turn/view and push it to the webview. */
  postNotice(kind: 'warning' | 'info', text: string): void {
    this.pushItem({ kind: 'notice', noticeKind: kind, text });
    this.post({ type: 'notice', kind, text });
  }

  /** Where a non-streaming item belongs: the focused node's run, else the view node. */
  private currentItems(): DisplayItem[] {
    const run = this.viewRun();
    return run ? run.items : this.viewItems();
  }

  /** The view focus node's items (or the session's orphan bucket). */
  private viewItems(): DisplayItem[] {
    const session = this.session;
    const node = session.activeNodeId ? session.nodes[session.activeNodeId] : undefined;
    return node ? node.displayItems : session.orphanItems;
  }

  /** The run bound to the current view focus, when that node is streaming. */
  private viewRun(): TurnRun | undefined {
    const id = this.session.activeNodeId;
    return id ? this.runs.get(id) : undefined;
  }

  /**
   * The node `tree.activeId` reports. This is a routing *hint* for the webview
   * only (every streaming message carries its own explicit `nodeId`): the focused
   * node's run when one exists, else any live run's node, else null.
   */
  private activeStreamNodeId(): string | null {
    const focused = this.viewRun();
    if (focused) {
      return focused.nodeId;
    }
    const any = this.runs.values().next().value as TurnRun | undefined;
    return any ? any.nodeId : null;
  }

  /**
   * Recompute the session-level `busy` flag from the live runs. P3 needs this:
   * one run finishing must not mark the session idle while another still streams,
   * or the notice drains would inject a turn into a busy session.
   */
  private syncBusy(): void {
    this.setBusy(this.uploadController != null || this.runs.size > 0);
  }

  // ---- Turn lifecycle ----

  /**
   * Create this turn's node, check it out (view focus follows the composer), and
   * record where its message slice starts. The caller pushes the turn's display
   * items and then sends the prompt to the node's own agent.
   *
   * P3 refuses to start only when the node this turn would continue from
   * (`parentId`) is *itself* streaming — two different branches of one session
   * may run at once, and the composer's Stop-not-Send rule already prevents
   * sending into a node that is running.
   *
   * `opts.parentId` overrides the basis node: an injected background notice is
   * based on the node that *owns* the job, not on the view focus, and passes
   * `pan: false` so the arrival of a notice never yanks what the user is
   * looking at.
   *
   * `opts.freshContext` opens a **new context window**: the node is marked as its own
   * context base, so the API prefix of this run (and of everything below it) contains
   * no ancestor message at all — the rollover's whole point. It also drops the parent's
   * pending interruption notice (see below).
   */
  private beginTurn(
    title: string,
    opts?: { parentId?: string | null; pan?: boolean; freshContext?: boolean; freshEpoch?: boolean },
  ): TurnRun | null {
    const session = this.session;
    if (this.host.isHeld()) {
      // An external controller is reloading the window (`/wait-for-finish` with a
      // hold). `/reload-window` refuses to run while any turn does, so *every* turn
      // start has to go through this gate — including the injected ones (background
      // and sub-agent notices), which is exactly the race that killed two reboots.
      // Callers re-queue and the drain retries once the hold expires.
      return null;
    }
    if (this.host.isReadOnly()) {
      // A read-only window owns nothing: no turn, injected or otherwise, may start here.
      return null;
    }
    const parentId = opts?.parentId !== undefined ? opts.parentId : session.activeNodeId;
    if (parentId) {
      // The user is continuing this line, so a union kill's "nothing continues" no
      // longer applies to it (the interrupt it wrote back is already in the history).
      this.stoppedLines.delete(parentId);
    }
    // P3: only the basis node must be free. `parentId` null (the session's first
    // turn) can never be running, so it is never refused.
    if (parentId != null && this.runs.has(parentId)) {
      this.postNotice(
        'warning',
        vscode.l10n.t(
          'A turn is already running in this session. Wait for it to finish (or stop it) before sending another.',
        ),
      );
      return null;
    }
    const node = createNode(newId(), parentId, title, 'running');
    // The card and the level this turn runs with, taken **from the node the request
    // is sent from** (the basis): the dropdown's pending pick when it was made on
    // that node, else that node's own resolved values (its own card, else the nearest
    // ancestor's, else the session seed). Recording them on the new node is what
    // makes the node own the card its history was produced under — so a later resume
    // of *this* node runs where this turn ran, however the dropdown moved since.
    const basis = parentId ? session.nodes[parentId] : undefined;
    // A send that continues an existing epoch uses **that** epoch, whatever the dropdown
    // says: a live pick belongs to the next *new* node (a fork), never to a prefix that
    // has already been sent. A chain without an epoch — a fresh session, or a legacy one
    // — resolves the way it always did, and freezes the result below.
    // `freshEpoch` is the "Continue with Latest setup" answer: this node must freeze the
    // live configuration instead of inheriting the parent's. A rollover can afford it —
    // its new context has no cached prefix to lose.
    const inherited = opts?.freshEpoch ? undefined : epochForNode(session, parentId ?? null);
    const cardId = opts?.freshEpoch ? this.card.id : inherited ? inherited.cardId : this.requestCardId(basis);
    const effort = opts?.freshEpoch ? this.thinkingEffort : inherited ? inherited.effort : this.requestEffort(basis);
    node.model = cardId;
    node.effort = effort;
    // A new context window: this node is its own basis, so the run's prefix — built
    // by `buildPath` a few lines below — contains no ancestor message at all. The
    // order is load-bearing: the marker has to be in place *before* `buildPath` reads
    // it, and `finishTurn` records the basis from that same call.
    if (opts?.freshContext) {
      node.contextBaseId = node.id;
    }
    attachNode(session, node);
    // Only a send that **applied** the pick consumes it: that is the first turn of a
    // chain, where the dropdown's choice really became `node.model`. A pick made on a
    // node that already has an epoch is not applied by a send — it is the drift the
    // composer asks about — so it stays pending until the user answers.
    if (!inherited && this.pending && this.pending.nodeId === (parentId ?? null)) {
      this.pending = null;
    }
    const worker = this.workerFor(node);
    // The turn re-checks the node's card: a worker is seeded when it is created, and
    // a node that inherited its card (or whose card the session seed decided) may
    // have a worker built under another card. The agent that sends this request must
    // run on the card recorded on the node above — never on what the dropdown showed
    // when its worker happened to be created.
    worker.agent.setCard(this.cardForCardId(cardId));
    worker.agent.setThinkingEffort(effort);
    // Freeze the envelope this node starts, or pin the worker to the one it inherits: a
    // chain keeps the tools its own instructions were written against, so a tool added or
    // removed by a later build cannot change a prefix that is already in the cache.
    if (inherited) {
      worker.agent.setToolSchemas(inherited.tools);
    } else {
      node.epoch = this.freezeEpoch(node, cardId, effort);
      worker.agent.setToolSchemas(node.epoch.tools);
    }
    // The interruption notice only makes sense when this turn continues from the
    // turn that was actually interrupted. P3 keys the pending notice per node, so
    // the new node's agent inherits its parent's notice (delivered once) or clears
    // any stale one of its own. A fresh window never inherits it: the notice names a
    // tool call from a context that is not being sent any more. The parent's own
    // entry is left alone — its line can still be continued later, with its own
    // history intact.
    const source =
      opts?.freshContext || parentId == null ? undefined : this.interruptedNodes.get(parentId);
    if (source) {
      worker.agent.transferInterruptTo(source);
    } else {
      worker.agent.resetInterruptState();
    }
    // The new node contributes no messages yet, so this is the parent's path;
    // the basis and the array are recorded together so they cannot drift apart.
    const messages = this.buildPath(session, node.id);
    worker.agent.setMessages(messages);
    const run: TurnRun = {
      nodeId: node.id,
      node,
      agent: worker.agent,
      items: node.displayItems,
      prefixLen: worker.agent.getMessages().length,
      prefixTail: worker.agent.getMessages()[worker.agent.getMessages().length - 1] ?? null,
      fresh: true,
      pendingText: '',
      pendingThinking: '',
      pendingTools: new Map(),
      flushTimer: null,
    };
    this.runs.set(node.id, run);
    this.postTree();
    if (opts?.pan !== false) {
      this.post({ type: 'panTo', id: node.id });
    }
    return run;
  }

  /**
   * Bind a run to an *existing* node (an injected sub-agent notice turn). Unlike
   * `beginTurn` this does not create a node and does not move the view focus;
   * the reply is appended to the node's existing messages (`fresh = false`). P3
   * binds it to that node's own worker and refuses only when that node is already
   * streaming, so it may run beside a run on another branch.
   */
  private beginInjectedTurn(node: TreeNode): TurnRun | null {
    if (this.host.isHeld()) {
      // Same gate as `beginTurn`: a held window must not gain a turn, or the
      // reload that is about to happen is refused ("the agent is busy").
      return null;
    }
    if (this.host.isReadOnly()) {
      // Same gate as `beginTurn`, and it is the one that matters most here: ▶ Continue,
      // a rollover's first turn and every background / sub-agent notice arrive through
      // this path, and none of them may write into a session another window owns.
      return null;
    }
    if (this.runs.has(node.id)) {
      // That node already has a live run; there is no second basis to bind.
      return null;
    }
    if (this.nodeWorkers.get(node.id)?.agent.running) {
      // The node has no run but its agent has not finished winding down: a turn's
      // terminal event is delivered *before* `runTurn`'s `finally` clears `isRunning`,
      // so a resume arriving in that window would be refused by the agent and would
      // leave this run on the node with nothing streaming. The same guard the notice
      // queue uses (`drainSignals`, `flushWritebacks`); the card still offers its
      // button, so the click is simply refused and can be repeated.
      return null;
    }
    // ▶ Continue (or an injected turn) on a line the user once stopped is the user
    // continuing it again: normal delivery resumes from here.
    this.stoppedLines.delete(node.id);
    // The card and the level this turn runs with, recorded on the node it continues:
    // the pending pick when it belongs to **this** node (a ▶ Continue is a send from
    // the node the user is looking at), else the node's own resolved values. This is
    // the in-place half of "a node owns the card that produced it": a turn that does
    // not create a node still pins the node to the card its reply was produced under.
    const cardId = this.requestCardId(node);
    const effort = this.requestEffort(node);
    node.model = cardId;
    node.effort = effort;
    if (this.pending && this.pending.nodeId === node.id) {
      this.pending = null;
    }
    const worker = this.workerFor(node);
    // Same re-check as `beginTurn`: the agent that sends this request runs on the
    // card the node now records, whatever its worker was created with.
    worker.agent.setCard(this.cardForCardId(cardId));
    worker.agent.setThinkingEffort(effort);
    const messages = this.buildPath(this.session, node.id);
    worker.agent.setMessages(messages);
    const run: TurnRun = {
      nodeId: node.id,
      node,
      agent: worker.agent,
      items: node.displayItems,
      prefixLen: messages.length,
      prefixTail: messages[messages.length - 1] ?? null,
      fresh: false,
      pendingText: '',
      pendingThinking: '',
      pendingTools: new Map(),
      flushTimer: null,
    };
    this.runs.set(node.id, run);
    return run;
  }

  /**
   * Close out a run: store exactly the messages the agent appended during it
   * (the interrupt checkpoint and the error rollback both land here), then
   * persist, and patch just this card instead of resending the whole tree.
   *
   * The slice is *verified* before it is written. `run.prefixLen` /
   * `run.prefixTail` describe the history this run started from; if the agent's
   * array was swapped since, the offset no longer means "the run's own messages"
   * and slicing it would store ancestor history in the node. Losing a turn's
   * messages to a log line beats silently duplicating ~1M tokens.
   */
  private finishTurn(run: TurnRun, status: TurnStatus): void {
    const node = run.node;
    this.runs.delete(run.nodeId);
    if (run.flushTimer != null) {
      clearTimeout(run.flushTimer);
      run.flushTimer = null;
    }
    const session = this.session;
    if (node && session.nodes[node.id]) {
      // P3: slice the *run's own* agent history, not a session-wide one.
      const messages = run.agent.getMessages();
      const start = run.prefixLen;
      const intact = start > 0 && start <= messages.length && messages[start - 1] === run.prefixTail;
      if (intact) {
        const added = messages.slice(start);
        // An injected (sub-agent notice / hop answer) turn continues a node that
        // already holds the turn that spawned it — appending keeps both; a user
        // turn owns the node `beginTurn` just created for it, so it assigns.
        node.messages = run.fresh ? added : [...node.messages, ...added];
      } else {
        this.host.output.appendLine(
          `[slice] ${node.id}: skipped storing this turn's messages — the agent history was ` +
            `replaced mid-turn (basis ${start}, tail ${run.prefixTail ? 'set' : 'unset'}, ` +
            `${messages.length} messages now; kept ${node.messages.length})`,
        );
      }
      this.recordUploadSources(node, run.agent);
      node.status = status;
      session.updatedAt = Date.now();
      // Mirror the finished turn to disk so it stays searchable later.
      this.host.dumpSessionTranscript(node, session, status);
      // A finished turn is the moment to (re)name the session. An interrupted
      // turn has no reliable content yet, so it is skipped.
      if (status !== 'interrupted') {
        this.host.requestAutoTitle(session);
      }
    }
    // A finished turn is the state that must never be lost (its history is what the
    // next turn sends), so it is written now rather than coalesced.
    this.persistTurnNow();
    // A union kill that hit this node while its turn was winding down: the interrupt
    // message can only be appended now (the turn's own slice was just stored).
    this.flushWritebacks();
    if (node && session.nodes[node.id]) {
      this.post({ type: 'nodeUpdate', ...this.nodeStatePatch(node) });
    }
    // A hopped session's turn just ended: queue the trip back to the session
    // that dispatched it, carrying this turn's final answer (the provider also
    // kicks any queued `POST /session/start` once this turn is fully closed).
    this.host.queueHopReturn(this, node, status);
  }

  // ---- User input / stop / image picker ----

  /**
   * What one composer attachment is sent as, and what produced it.
   *
   * The transform is the point of the whole image budget: the provider caps the bytes a
   * **request** carries (200 MB referenced, 48 MiB inline) and resizes everything above
   * ~800 px server-side anyway, so a 10 MiB sheet that leaves here at `IMAGE_TARGET_MAX_SIDE`
   * loses nothing the model would have seen (`docs/agents/plans/image-budget.md` §1/§2).
   *
   * Never throws and never drops an attachment: an image this build cannot transform (an
   * unsupported variant, an unreadable one — `changed: false`), or one whose format it cannot
   * even name, is sent **verbatim**, exactly as before this work. The per-request brake in
   * `read_image` stays the backstop.
   */
  private async prepareAttachment(att: UserAttachment): Promise<PreparedAttachment> {
    const raw = dataUrlBytes(att.dataUrl);
    const mime = detectImageMime(raw);
    if (!mime) {
      // Not a format we can measure, so not one we may re-encode: pass it through untouched
      // rather than rebuild a `data:` URL from a mime we had to guess.
      return { bytes: raw, dataUrl: att.dataUrl };
    }
    try {
      const out = await transformImage({ bytes: raw, mime });
      if (!out.changed) {
        return { bytes: raw, dataUrl: att.dataUrl };
      }
      const bytes = Buffer.from(out.bytes);
      const dataUrl = `data:${out.mime};base64,${bytes.toString('base64')}`;
      this.host.output.appendLine(
        `[image] transformed ${att.name || 'attachment'}: ${imageBytesText(raw.length)} -> ` +
          `${imageBytesText(bytes.length)}, ${out.sourceWidth}x${out.sourceHeight} -> ${out.width}x${out.height}`,
      );
      return {
        bytes,
        dataUrl,
        transform: {
          rect: out.rect,
          targetMaxSide: IMAGE_TARGET_MAX_SIDE,
          sourceWidth: out.sourceWidth,
          sourceHeight: out.sourceHeight,
          width: out.width,
          height: out.height,
        },
      };
    } catch (err) {
      this.host.output.appendLine(
        `[image] transform failed for ${att.name || 'attachment'}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return { bytes: raw, dataUrl: att.dataUrl };
    }
  }

  async onUserMessage(text: string, attachments: UserAttachment[] = []): Promise<void> {
    // P3: only the node this turn would continue from must be free — another
    // branch of this session may stream meanwhile. (This mirrors the composer's
    // Stop-not-Send rule; `beginTurn` re-checks the same condition once the basis
    // is known.)
    const basis = this.session.activeNodeId;
    // The card this send runs on **and** the card the image path below must use are
    // the ones of the node the send came from (its own, else an ancestor's, else the
    // session seed), plus a pending pick made on it. Both are read here, once, before
    // the upload can await: the transport an image travels in is a property of that
    // one card, so a checkout that lands mid-upload must not build the request for
    // one card and then run it on another.
    const sendCard = this.card;
    if (basis && this.runs.has(basis)) {
      return;
    }
    // The basis node still owns unfinished work (a background job, an async
    // sub-agent batch, or a notice about to be injected into it): a send here would
    // open a second run on the same line while that notice lands in the very node
    // this turn branches from. The composer shows Stop for those nodes (`lockedNodes`
    // in `state`), so this is the host-side half of one rule.
    if (basis && this.lockedWorkCount(basis) > 0) {
      this.postNotice(
        'warning',
        vscode.l10n.t(
          'A background task or sub-agent is still running on this branch ({0}). Press Stop to kill it, or wait for it to finish.',
          this.lockedWorkCount(basis),
        ),
      );
      return;
    }
    if (this.host.isHeld()) {
      this.postNotice(
        'warning',
        vscode.l10n.t('An external controller is rebooting the window; please wait a moment.'),
      );
      return;
    }
    const userText = text.trim();

    // Only a card that declares itself image-capable (`card.vision.enabled`) may
    // carry image blocks. A card that is not would not 400 — DeepSeek silently
    // swaps the image for an "[Unsupported Image]" text part and the model then
    // invents what it cannot see — so drop the attachments, send the text alone,
    // and tell the user to switch cards.
    if (attachments.length > 0 && !isVisionCard(sendCard)) {
      const vision = visionCardsLabel();
      const model = cardDisplayName(sendCard);
      this.postNotice(
        'warning',
        vision
          ? vscode.l10n.t(
              'Images are not supported by the current model ({0}). Switch to a vision model ({1}) to attach or paste an image.',
              model,
              vision,
            )
          : vscode.l10n.t(
              'Images are not supported by the current model ({0}). No vision model is configured for this harness.',
              model,
            ),
      );
      attachments = [];
    }

    // How the card's images reach its provider is the card's own statement
    // (`vision.transport`), and it decides this whole block:
    //
    //  - `deepseek`: upload each image to the provider's Files API and reference it
    //    by `file_id` via a `file` content block, instead of inlining base64. That
    //    keeps the request body under the 48 MiB inline limit and lets each image
    //    be up to 64 MiB — at the price of a second round-trip, which is why this
    //    is the only path that shows "Uploading images…" and can be interrupted
    //    (`uploadController`, the composer's Stop).
    //  - `openai`: the attachment's own `data:` URL goes straight into an
    //    `image_url` part (the OpenAI-compatible shape). Nothing leaves the request
    //    body, so there is no upload to wait for and no busy state to flicker: the
    //    send goes on to `beginTurn` immediately.
    //
    // Image blocks are only allowed in user messages.
    let content: string | ContentPart[];
    /** Provenance of this turn's own image blocks, written onto the node below (§6). */
    const sources: ImageSourceEntry[] = [];
    if (attachments.length > 0) {
      const parts: ContentPart[] = [];
      /** What each image part was actually sent as, by part identity (read back below). */
      const sent = new Map<ContentPart, PreparedAttachment>();
      if (userText) {
        parts.push({ type: 'text', text: userText });
      }
      if (sendCard.vision.transport === 'openai') {
        for (const att of attachments) {
          // The transform runs first here too: an inlined attachment's wire cost is its
          // `data:` URL, so a smaller image is a smaller request body — the 48 MiB inline
          // ceiling is the one this transport has to fit under.
          const prepared = await this.prepareAttachment(att);
          const part: ContentPart = { type: 'image_url', image_url: { url: prepared.dataUrl } };
          parts.push(part);
          sent.set(part, prepared);
        }
      } else {
        this.setBusy(true);
        this.lastStatus = vscode.l10n.t('Uploading images…');
        this.post({ type: 'status', text: this.lastStatus });
        this.uploadController = new AbortController();
        const uploadSignal = this.uploadController.signal;
        const failed: string[] = [];
        for (const att of attachments) {
          try {
            // Transform before the upload, never after: the bytes that ever reach the
            // provider are the small ones (`docs/agents/plans/image-budget.md` §2.1), and the
            // provider's own `Total image size` cap counts exactly these.
            const prepared = await this.prepareAttachment(att);
            const uploaded = await this.clients.upload(sendCard, prepared.bytes, att.name || 'image', uploadSignal);
            const part: ContentPart = { type: 'file', file_id: uploaded.id };
            parts.push(part);
            sent.set(part, prepared);
          } catch (err) {
            if (uploadSignal.aborted) {
              // The user pressed Stop during upload: reset and do not send.
              this.uploadController = null;
              // Another branch may still be streaming; only this session's own
              // upload is ending here.
              this.syncBusy();
              this.lastStatus = vscode.l10n.t('Interrupted');
              this.post({ type: 'status', text: vscode.l10n.t('Interrupted') });
              this.post({ type: 'interrupted' });
              return;
            }
            failed.push(att.name || 'image');
            this.host.output.appendLine(`[image] upload failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        this.uploadController = null;
        if (failed.length > 0) {
          this.postNotice(
            'warning',
            vscode.l10n.t('Could not upload: {0}. Those images were omitted.', failed.join(', ')),
          );
        }
        if (parts.length === 0) {
          // Nothing to send (no text and every upload failed).
          this.syncBusy();
          this.lastStatus = '';
          this.post({ type: 'status', text: '' });
          return;
        }
      }
      content = parts;
      // Remember where each image came from, addressed by its position in the message
      // this turn stores: a `file_id` is one provider's handle and nothing else in the
      // history can turn it back into bytes (`docs/agents/plans/session-epoch.md` §6). The
      // bytes and the transform ride along, because they are what the per-request image
      // budget is computed from and what lets a fork rebuild the **same view** rather than
      // inlining the raw attachment again (`docs/agents/plans/image-budget.md` §2.4).
      parts.forEach((part, partIndex) => {
        const prepared = sent.get(part);
        if (part.type === 'image_url') {
          sources.push({
            messageIndex: 0,
            partIndex,
            // Inline, the wire cost is the URL itself — the same thing `bytesOf` measures for
            // a live `image_url` part, so the record and the accounting agree.
            source: {
              kind: 'inline',
              dataUrl: part.image_url.url,
              bytes: prepared ? Buffer.byteLength(prepared.dataUrl, 'utf8') : undefined,
              transform: prepared?.transform,
            },
          });
        } else if (part.type === 'file') {
          sources.push({
            messageIndex: 0,
            partIndex,
            source: {
              kind: 'upload',
              providerId: sendCard.providerId,
              fileId: part.file_id,
              bytes: prepared?.bytes.length,
              transform: prepared?.transform,
            },
          });
        }
      });
    } else {
      content = userText;
    }

    if (typeof content === 'string' && !content) {
      return;
    }
    if (Array.isArray(content) && content.length === 0) {
      return;
    }

    // Name a fresh session from its first user message (provisional: the
    // automatic namer replaces it with a model-generated title once the turn
    // finishes).
    const session = this.session;
    if (isDefaultSessionTitle(session.title) && (userText || attachments.length > 0)) {
      session.title = sliceText(userText || defaultSessionTitle(), 40);
      session.titleSource = 'provisional';
      this.host.stateChanged();
    }
    session.updatedAt = Date.now();

    // This turn becomes a new node, checked out as a child of the previously
    // selected node — a branch when that node already had children. The basis is
    // pinned to the node `basis` captured above, so the card decision this request
    // was built with (`sendCard`, and therefore the shape its images travel in) is
    // the card `beginTurn` records on the new node.
    const run = this.beginTurn(titleFromPrompt(userText || attachments[0]?.name || ''), { parentId: basis });
    if (!run) {
      return;
    }
    if (sources.length > 0) {
      run.node.imageSources = sources;
    }
    run.items.push({ kind: 'user', text: userText, attachments });
    this.post({ type: 'user', text: userText, attachments });
    this.setBusy(true);
    this.lastStatus = vscode.l10n.t('Thinking…');
    this.post({ type: 'status', text: this.lastStatus });
    void run.agent.sendUserMessage(content);
  }

  /**
   * Resume a node in place: run a turn **on `nodeId` itself**, so a turn that ended
   * in `interrupted` or `error` does not force the user to type "continue" — and,
   * just as important, does not grow a new card in the tree. This is the same
   * mechanism the background / sub-agent completion notices use
   * (`beginInjectedTurn`): the run is bound to the existing node, its reply is
   * appended to that node's own history (`fresh: false`) and the view focus does
   * not move. The engine starts the turn itself (`Agent.resumeTurn`), so this path
   * never calls `sendUserMessage`.
   *
   * **The resume is transparent: a failure says nothing to the model.** The
   * history the agent holds is the one the turn died with — the checkpoint
   * `preservePartialTurn` stored for an interruption, or the state the rollback
   * restored for an error — and the resume adds no explanation to it, so a model
   * call that failed can never read as "your work was thrown away, start over".
   * The one exception is a tool call a Stop stranded: `resumeTurn` pushes that
   * single pure-fact line itself and returns it, and only then is it shown here.
   * `undefined` means the model was told nothing, so the card says nothing either:
   * a harness note is posted **only** when there is a fact to show.
   * `docs/agents/invariants/api-retries.md` carries the full rule.
   *
   * Refused (returns false, no turn) while the reboot hold is armed, while that
   * node is already streaming, or for a node that is not a conversational turn (a
   * sub-agent window / job card has no history of its own in this path).
   */
  async continueFrom(nodeId: string): Promise<boolean> {
    const node = this.session.nodes[nodeId];
    // Only a real turn node can be continued: `isSidecar` covers the sub-agent
    // windows and the `kind:'bg'` job cards.
    if (!node || isSidecar(node)) {
      return false;
    }
    if (this.runs.has(nodeId)) {
      return false;
    }
    if (this.host.isHeld()) {
      this.postNotice(
        'warning',
        vscode.l10n.t('An external controller is rebooting the window; please wait a moment.'),
      );
      return false;
    }
    const run = this.beginInjectedTurn(node);
    if (!run) {
      return false;
    }
    node.status = 'running';
    // What the model was actually told, straight from the engine: a stranded tool
    // call is the only thing a resume ever says. The card shows exactly that line
    // as an inline harness block (never a fabricated user bubble, and never the
    // pinned prompt — that one still holds what the user asked for).
    const fact = run.agent.resumeTurn();
    if (fact !== undefined) {
      run.items.push({ kind: 'harness', text: fact });
      this.post({ type: 'harnessNote', nodeId: node.id, text: fact });
    }
    this.setBusy(true);
    this.lastStatus = vscode.l10n.t('Thinking…');
    this.post({ type: 'status', text: this.lastStatus });
    // Patch just this card: the chip follows the run, and the ▶ button goes away
    // for the duration (the webview hides it while the node has a live run).
    this.post({ type: 'nodeUpdate', ...this.nodeStatePatch(node) });
    return true;
  }

  /**
   * True when the checked-out chain's setup and the live one disagree **because the user
   * just picked a different card / level / language**: the send that follows must ask
   * before it discards that pick (`docs/agents/plans/session-epoch.md` §4.2). Harness-side
   * drift is deliberately not part of this — a plain send keeps the frozen setup silently,
   * which is the whole point of freezing it.
   */
  hasUserDrift(): boolean {
    return this.setupState().drift === 'user';
  }

  /** True when *anything* differs: what the composer's new-setup entry is offered for. */
  hasDrift(): boolean {
    return this.setupState().drift !== false;
  }

  /**
   * True when this node offers a context continuation: a conversational node that is not
   * streaming and whose chain is at least **near** full (`contextState`, so the provider's
   * refusal and the 90% threshold both qualify). It is the same predicate the webview's `⧉`
   * button reflects, and it is public so `ChatViewProvider` can decide whether the
   * kill-confirmation is needed *before* anything has changed.
   */
  canRollover(nodeId: string): boolean {
    const node = this.session.nodes[nodeId];
    if (!node || isSidecar(node) || this.runs.has(nodeId)) {
      return false;
    }
    // A node that already has a conversational child has been rolled over (or the
    // user went on from it): the button is gone, so a second window must not start
    // from the same card. This is the host half of the webview's "tip of the branch"
    // rule — the two must agree, or a replayed click would open a sibling window.
    if (node.children.some((id) => !isSidecar(this.session.nodes[id]))) {
      return false;
    }
    return this.contextState(node) !== 'ok';
  }

  /**
   * Adopt the epoch model for a chain that predates it: freeze the setup the next request
   * would have used onto the node that starts the checked-out chain, and mark the session
   * `legacy`.
   *
   * The old harness never stored a prompt (it re-rendered one per request), so the exact
   * bytes of a legacy chain's original requests are unrecoverable — this is a one-time
   * approximation, and one unavoidable miss. What it buys is everything after it: from
   * then on that chain is frozen like any other, and only a fork changes it
   * (`docs/agents/plans/session-epoch.md` §7).
   */
  adoptLegacyEpoch(): void {
    const session = this.session;
    if (session.legacyEpoch) {
      return;
    }
    const viewId = session.activeNodeId ?? session.rootIds[0] ?? null;
    const ids = pathIds(session, viewId);
    if (ids.length === 0) {
      return;
    }
    const base = contextBase(session, viewId) ?? ids[0];
    const baseNode = session.nodes[base];
    if (!baseNode || baseNode.epoch) {
      session.legacyEpoch = true;
      return;
    }
    const frozen = this.freezeEpoch(baseNode, this.cardIdForNode(baseNode), this.effortNameForNode(baseNode));
    baseNode.epoch = { ...frozen, legacy: true };
    session.legacyEpoch = true;
    this.host.output.appendLine(`[epoch] adopted legacy chain ${base} (card=${frozen.cardId} effort=${frozen.effort})`);
    this.persistTurnNow();
  }

  /**
   * Continue the conversation in a **new, empty context window** — the `⧉` button on
   * a card whose request the provider refused as too big. See
   * `docs/agents/invariants/context-rollover.md`; in short:
   *
   *  - the new node is an ordinary child of this one (`freshContext`), so the tree
   *    stays connected and a dashed edge marks the window break — only the *message
   *    prefix* is cut, which is exactly what `contextBaseId` does;
   *  - the message is harness-written and carries a pointer to this node's on-disk
   *    transcript plus the last request and answer verbatim, so nothing has to be
   *    summarised and nothing is lost when a detail is needed;
   *  - this node is **also** union-killed first (the composer's Stop path): its
   *    background terminals and its whole sub-agent subtree cannot deliver into a
   *    full window, and their results would never reach the new one, so leaving them
   *    running would be work nobody can read. Their notices are written back into
   *    this node (the existing mechanism) and the transcript is re-dumped, so the new
   *    window really can read what happened.
   *
   * A node that is *not* a context-window failure is continued **in place** instead
   * (`continueFrom`): one behaviour, no new failure mode, so a stale card can never
   * dead-end the button.
   *
   * When it returns true the new node is checked out and running, and this node keeps
   * its full history on its stopped line.
   */
  async rolloverContext(nodeId: string, setup: 'current' | 'latest' = 'current'): Promise<boolean> {
    const node = this.session.nodes[nodeId];
    if (!node || isSidecar(node)) {
      return false;
    }
    if (!this.canRollover(nodeId)) {
      return this.continueFrom(nodeId);
    }
    if (this.host.isHeld()) {
      this.postNotice(
        'warning',
        vscode.l10n.t('An external controller is rebooting the window; please wait a moment.'),
      );
      return false;
    }
    // Capture the tail the message carries BEFORE the kill: the kill appends its
    // notices to this node as `role:'user'` messages, and one of those must never be
    // mistaken for the request the user actually made.
    const carry = this.carriedOver(node);
    // Leftover work: the same union kill the composer's Stop uses, so "nothing
    // continues" holds for the old line while the conversation moves on. The tasks
    // are captured first because the hub forgets the *running* snapshot once they are
    // settled — and their final state is what the new window's message has to name.
    const killedJobs = this.hub.listForNode(this.sessionId, nodeId).filter((task) => task.status === 'running');
    const killedAgents = this.subAgentSubtree(nodeId);
    this.stopNode(nodeId);
    await this.settleSubAgents();
    // `flushWritebacks` appends the kill notices to this node's history but never
    // dumps it (only `finishTurn` does), and a `kind:'bg'` card has no dump of its
    // own. Without this explicit re-dump, the record of the killed work — the only
    // durable copy of what those terminals produced — would never reach the file the
    // new window is told to read.
    this.flushWritebacks();
    this.host.dumpSessionTranscript(node, this.session, node.status);
    // Windows are numbered per branch: the session's first window is window 1, and
    // every window below it adds one, so the first rollover of a session is 2.
    const windows = pathIds(this.session, nodeId).filter(
      (id) => this.session.nodes[id]?.contextBaseId === id,
    ).length;
    const windowNo = windows + 2;
    const message = buildContextRolloverMessage({
      reason: this.rolloverReason(node),
      sessionId: this.sessionId,
      previousNodeId: node.id,
      transcriptPath: this.rolloverTranscriptPath(node.id),
      transcriptExists: this.rolloverTranscriptOnDisk(node.id),
      request: carry.request,
      attachments: carry.attachments,
      answer: carry.answer,
      killedBackground: killedJobs.map((task) => ({
        id: task.id,
        command: clipText(task.command, 80),
        state: task.killed
          ? 'stopped by the rollover'
          : `finished with exit code ${task.exitCode ?? 'unknown'}`,
      })),
      killedSubAgents: killedAgents.map((id) => ({
        nodeId: id,
        transcript: this.session.nodes[id]?.agentTranscript,
      })),
    });
    const run = this.beginTurn(vscode.l10n.t('Context window {0}', windowNo), {
      parentId: nodeId,
      freshContext: true,
      // "Continue with Latest setup" freezes the live configuration into the new node;
      // "current" inherits the parent's envelope. Both are free here — a new context has no
      // cached prefix to lose — which is why the choice can be offered at all.
      freshEpoch: setup === 'latest',
    });
    if (!run) {
      return false;
    }
    // `beginTurn` treats the basis node as "the user is continuing this line" and
    // clears its stopped line; here the conversation continues in the *new* node, so
    // the old one stays killed — nothing produced under it may open a turn there.
    this.stoppedLines.add(nodeId);
    run.items.push({ kind: 'harness', text: message });
    this.post({ type: 'harnessNote', nodeId: run.node.id, text: message });
    this.setBusy(true);
    this.lastStatus = vscode.l10n.t('Thinking…');
    this.post({ type: 'status', text: this.lastStatus });
    this.post({ type: 'nodeUpdate', ...this.nodeStatePatch(run.node) });
    void run.agent.sendUserMessage(message);
    return true;
  }

  /**
   * Record, on the node, where this turn's `read_image` uploads came from — and how many
   * bytes each one costs the request. A `file_id` is one provider's private handle, so
   * translating it for another card (a fork) is only possible while its source is known
   * (`docs/agents/plans/session-epoch.md` §6), and the byte count is what makes the chain's
   * per-request image budget arithmetic over provenance rather than a re-read of every source
   * file (`docs/agents/plans/image-budget.md` §2.4). Matching is by id, so a message this
   * turn did not touch simply finds nothing.
   *
   * Both callers use it — the main agent's `finishTurn` and a sub-agent's `finish` — so a
   * resumed sub-agent has provenance too and the accounting stays exact for it.
   *
   * Best effort and side-effect-free on failure: the whole record is built before it is
   * assigned, so a throw (an agent mid-teardown, say) can neither lose the turn's messages
   * nor leave half the provenance written.
   */
  private recordUploadSources(node: TreeNode, agent: Agent): void {
    try {
      const uploads = agent.getImageUploads();
      if (uploads.length === 0) {
        return;
      }
      const known = new Set(
        (node.imageSources ?? []).map((entry) => (entry.source.kind === 'upload' ? entry.source.fileId : '')),
      );
      const next: ImageSourceEntry[] = [];
      node.messages.forEach((message, messageIndex) => {
        if (!Array.isArray(message.content)) {
          return;
        }
        message.content.forEach((part, partIndex) => {
          if (part.type !== 'file' || known.has(part.file_id)) {
            return;
          }
          const upload = uploads.find((u) => u.fileId === part.file_id);
          if (!upload) {
            return;
          }
          known.add(part.file_id);
          const source: ImageSource = {
            kind: 'upload',
            providerId: upload.providerId,
            fileId: part.file_id,
            srcPath: upload.path,
            // The bytes actually sent, and the transform that produced them: the first is the
            // budget's input, the second is what lets a fork rebuild this view instead of
            // inlining the raw source file.
            bytes: upload.bytes,
            transform: upload.transform,
          };
          next.push({ messageIndex, partIndex, source });
        });
      });
      if (next.length > 0) {
        node.imageSources = [...(node.imageSources ?? []), ...next];
      }
    } catch (err) {
      this.host.output.appendLine(
        `[image] provenance skipped for ${node.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Re-materialise one node's messages for another card: the images of a copied chain are
   * written in the wire form the **target** can read, once, at copy time — never again per
   * request (`docs/agents/plans/session-epoch.md` §6).
   *
   * Best effort, deliberately: bytes are recovered when the provenance says where they are
   * (an inline `data:` URL, or a source file still on disk and small enough to inline), and
   * the block becomes an ordinary placeholder text part when they are not. A chain is never
   * left unsendable because of an image.
   */
  private materialiseMessages(
    messages: ChatMessage[],
    sources: ImageSourceEntry[],
    card: ModelCard,
  ): { messages: ChatMessage[]; sources: ImageSourceEntry[] } {
    const vision = isVisionCard(card);
    const uploadTransport = card.vision.transport === 'deepseek';
    const byPart = new Map<string, ImageSource>();
    for (const entry of sources) {
      byPart.set(`${entry.messageIndex}:${entry.partIndex}`, entry.source);
    }
    const out: ChatMessage[] = [];
    const outSources: ImageSourceEntry[] = [];
    let changed = false;
    messages.forEach((message, messageIndex) => {
      if (message.role !== 'user' || !Array.isArray(message.content)) {
        out.push(message);
        return;
      }
      const parts = message.content;
      if (!parts.some((part) => part.type === 'image_url' || part.type === 'file')) {
        out.push(message);
        return;
      }
      let moved = false;
      const nextParts: ContentPart[] = parts.map((part, partIndex) => {
        if (part.type !== 'image_url' && part.type !== 'file') {
          return part;
        }
        if (!vision) {
          moved = true;
          return { type: 'text', text: MATERIALISED_NO_VISION };
        }
        if (part.type === 'file') {
          const source = byPart.get(`${messageIndex}:${partIndex}`);
          if (uploadTransport && source?.kind === 'upload' && source.providerId === card.providerId) {
            return part; // the same account can still read its own handle
          }
          // A transformed upload is **not** re-inlined from its raw source file: the chain
          // that recorded it saw the cropped/downscaled view, so inlining the original would
          // silently show the copy a *different* image than the one the model answered about —
          // and it would re-inflate exactly the bytes the transform exists to avoid (a 10 MiB
          // sheet becomes ~13 MiB of base64). The faithful rebuild replays the recorded
          // `transform`, which needs the derived bytes; until that cache exists the copy
          // degrades to the placeholder, the same way an unreachable source already does
          // (`docs/agents/plans/image-budget.md` §2.4).
          if (source?.kind === 'upload' && source.transform) {
            moved = true;
            return { type: 'text', text: MATERIALISED_FOREIGN_UPLOAD } as ContentPart;
          }
          const dataUrl = this.inlineBytesFor(source);
          moved = true;
          return dataUrl
            ? ({ type: 'image_url', image_url: { url: dataUrl } } as ContentPart)
            : ({ type: 'text', text: MATERIALISED_FOREIGN_UPLOAD } as ContentPart);
        }
        return part;
      });
      if (moved) {
        changed = true;
        out.push({ ...message, content: nextParts });
        nextParts.forEach((part, partIndex) => {
          if (part.type === 'image_url') {
            outSources.push({ messageIndex, partIndex, source: { kind: 'inline', dataUrl: part.image_url.url } });
          } else if (part.type === 'file') {
            const source = byPart.get(`${messageIndex}:${partIndex}`);
            if (source) {
              outSources.push({ messageIndex, partIndex, source });
            }
          }
        });
      } else {
        out.push(message);
        for (const entry of sources) {
          if (entry.messageIndex === messageIndex) {
            outSources.push(entry);
          }
        }
      }
    });
    return { messages: out, sources: changed ? outSources : sources };
  }

  /** The bytes behind one provenance record, as a `data:` URL, when they are reachable. */
  private inlineBytesFor(source: ImageSource | undefined): string | undefined {
    if (!source) {
      return undefined;
    }
    if (source.kind === 'inline') {
      return source.dataUrl;
    }
    if (!source.srcPath) {
      return undefined;
    }
    try {
      const stat = fs.statSync(source.srcPath);
      if (!stat.isFile() || stat.size > INLINE_IMAGE_LIMIT_BYTES) {
        return undefined;
      }
      const bytes = fs.readFileSync(source.srcPath);
      const mime = detectImageMime(bytes);
      return mime ? `data:${mime};base64,${bytes.toString('base64')}` : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Continue the tree that owns `nodeId` under the **live** setup, as an adjacent tree —
   * the "Continue with Latest setup" answer (`docs/agents/plans/session-epoch.md` §4.4).
   *
   * The whole tree is copied, not just the branch being read: a conversation is a shape the
   * user navigates, and a fork that dropped its siblings would silently lose them. Every
   * copy gets a fresh identity, its images are re-materialised for the target card (§6), and
   * its epoch-starting node freezes a **new** envelope. That is the whole point: the old tree
   * keeps the bytes — and therefore the provider cache entry — it was built with, so
   * switching back is a hit instead of a re-bill.
   */
  forkTree(nodeId: string): { rootId: string; tipId: string } | null {
    const session = this.session;
    const source = session.nodes[nodeId];
    if (!source || isSidecar(source) || this.runs.size > 0) {
      // A copy taken while a turn streams would race that run's own slice into the node it
      // is writing; the composer only offers the fork on an idle session, and a replayed
      // click is refused here.
      return null;
    }
    const rootPath = pathIds(session, nodeId);
    const sourceRootId = rootPath[0];
    if (!sourceRootId || !session.nodes[sourceRootId]) {
      return null;
    }
    // The **whole tree** is copied, not just the node's own subtree: "continue with the
    // latest setup" continues a conversation, and the conversation is the tree the user is
    // reading — including the branches they are not standing on.
    const ids = branchIds(session, sourceRootId);
    const cardId = this.model;
    const effort = this.thinkingEffort;
    const card = this.cardForCardId(cardId);
    const idMap = new Map<string, string>();
    for (const id of ids) {
      idMap.set(id, newId());
    }
    for (const id of ids) {
      const src = session.nodes[id];
      const copyId = idMap.get(id)!;
      const materialised = this.materialiseMessages(src.messages, src.imageSources ?? [], card);
      session.nodes[copyId] = {
        ...src,
        id: copyId,
        parentId: src.parentId ? (idMap.get(src.parentId) ?? null) : null,
        children: src.children.map((child) => idMap.get(child)).filter((child): child is string => !!child),
        messages: materialised.messages,
        imageSources: materialised.sources.length > 0 ? materialised.sources : undefined,
        // The transcript items are copied, never shared: a live run pushes into its own
        // node's array, and two trees must not write the same objects.
        displayItems: src.displayItems.map((item) => ({
          ...item,
          attachments: item.attachments ? item.attachments.map((a) => ({ ...a })) : undefined,
          usage: item.usage ? { ...item.usage } : undefined,
        })),
        contextBaseId: src.contextBaseId === src.id ? copyId : undefined,
        // Re-frozen below for the nodes that own an envelope; a copy must never point at
        // the old tree's epoch.
        epoch: undefined,
        // A copy of a turn that never finished is a record, not a live run.
        status: src.status === 'running' || src.status === 'pending' ? 'interrupted' : src.status,
      };
    }
    for (const id of ids) {
      const src = session.nodes[id];
      const copy = session.nodes[idMap.get(id)!];
      if (src.epoch || id === sourceRootId) {
        const frozen = this.freezeEpoch(copy, cardId, effort);
        copy.epoch = frozen;
        copy.model = frozen.cardId;
        copy.effort = frozen.effort;
      }
    }
    const newRootId = idMap.get(sourceRootId)!;
    session.rootIds = session.rootIds.filter((id) => id !== newRootId);
    session.rootIds.push(newRootId);
    session.activeNodeId = idMap.get(nodeId) ?? newRootId;
    session.updatedAt = Date.now();
    this.host.output.appendLine(
      `[epoch] forked ${sourceRootId} -> ${newRootId} nodes=${ids.length} card=${cardId} effort=${effort}`,
    );
    this.persistTurnNow();
    this.postTree();
    if (session.activeNodeId) {
      this.post({ type: 'panTo', id: session.activeNodeId });
    }
    this.postConfig();
    this.postContext();
    this.postState();
    return { rootId: newRootId, tipId: session.activeNodeId ?? newRootId };
  }

  /** Where this node's transcript dump lives (the pointer the new window is given). */
  private rolloverTranscriptPath(nodeId: string): string {
    return path.join(this.host.transcriptDir(this.sessionId), `${nodeId}.jsonl`);
  }

  /**
   * Whether that dump is actually on disk. It usually is — `finishTurn` dumps the
   * failed turn too — but `spinney.saveSessionTranscripts` can be off, and then the
   * message must degrade to "rely on what was carried over" instead of pointing at a
   * file that does not exist.
   */
  private rolloverTranscriptOnDisk(nodeId: string): boolean {
    if (!this.host.getConfig().saveSessionTranscripts) {
      return false;
    }
    const file = this.rolloverTranscriptPath(nodeId);
    // The dump now reaches disk through a queue off the host thread, so a
    // **queued** write counts as present: queueing it is what makes it present,
    // and only a deletion (`removeTranscriptDir` / `removeTranscripts`) cancels
    // it. Without this the rollover would point at a file that is about to appear
    // microseconds later. `existsSync` stays for the ordinary case — a dump
    // written by an earlier turn.
    if (hasPendingTranscriptWrite(file)) {
      return true;
    }
    try {
      return fs.existsSync(file);
    } catch {
      return false;
    }
  }

  /**
   * The tail a rollover carries verbatim: the user's last real request and the last
   * answer. Both are already in memory (so they cost no extra request) and both are
   * what stops the pointer from being useless — a model that does not know what it
   * does not know never looks anything up. Harness and writeback notices are skipped:
   * they are `role:'user'` messages too, but the user did not write them.
   */
  private carriedOver(node: TreeNode): { request: string; answer: string; attachments: number } {
    let request = '';
    let attachments = 0;
    let answer = '';
    for (let i = node.messages.length - 1; i >= 0 && (!request || !answer); i--) {
      const message = node.messages[i];
      if (!request && message.role === 'user') {
        const text = messageText(message.content);
        if (text.trim() && !text.startsWith('[Harness')) {
          request = text;
          if (Array.isArray(message.content)) {
            attachments = message.content.filter(
              (part) => part.type === 'image_url' || part.type === 'file',
            ).length;
          }
        }
      } else if (!answer && message.role === 'assistant') {
        const text = messageText(message.content);
        if (text.trim()) {
          answer = text;
        }
      }
    }
    return { request, answer, attachments };
  }

  /**
   * Wait (bounded) for the sub-agents a kill just aborted. A killed sub-agent writes
   * its own transcript *inside* its finish handler, so a rollover that did not wait
   * would name nodes whose dump path it cannot know yet — while a job that never
   * settles must not hang the button, hence the timeout.
   */
  private async settleSubAgents(): Promise<void> {
    const pending = [...this.runningSubAgents.values()].map((entry) => entry.settled);
    if (pending.length === 0) {
      return;
    }
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => {
        setTimeout(resolve, ROLLOVER_SETTLE_TIMEOUT_MS);
      }),
    ]);
    // One macrotask tick: an async sub-agent's *batch* notice is queued by a
    // continuation chained after its own promise, so a writeback flush placed
    // immediately after the settle could still miss it (and with the line stopped, the
    // notice would then never reach a dump). A timer callback only runs once the
    // microtask queue is empty, which is exactly what that continuation needs.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  /**
   * Stop a node — the composer's bottom-right button while that node runs or while
   * it still owns unfinished work (`lockedNodes`).
   *
   * `nodeId` is a **union kill**: the node's live turn, every background terminal it
   * spawned and every sub-agent it is still running are all stopped, and **nothing
   * continues**: the completion notices are written back into the node's own history
   * (`writebacks`) instead of being injected as a turn, so they reach the model only
   * with the user's next prompt / ▶ Continue. Killing a card's ✕ stays the
   * fine-grained path: one job, and the model *is* told about it.
   *
   * Without `nodeId` the session-wide meaning is kept (cancel every live run); it
   * deliberately does not touch background jobs, which outlive a turn by design.
   */
  stop(nodeId?: string): number {
    this.uploadController?.abort();
    if (nodeId) {
      return this.stopNode(nodeId);
    }
    let stopped = 0;
    const seen = new Set<Agent>();
    for (const run of this.runs.values()) {
      if (!seen.has(run.agent)) {
        seen.add(run.agent);
        run.agent.cancel();
        stopped++;
      }
    }
    return stopped;
  }

  /**
   * Everything one node owns, in one go. The completion notices are *redirected*
   * (`queueWriteback`) rather than dropped, so the interrupt message is still in the
   * context of the next request — it just cannot start one by itself.
   */
  private stopNode(nodeId: string): number {
    let killed = 0;
    // Nothing under this line may continue on its own until the user sends again.
    this.stoppedLines.add(nodeId);
    // 1. The node's own turn (its agent is cancelled; `finishTurn` stores the
    //    partial turn and the next send resumes with the usual interrupt notice).
    const run = this.runs.get(nodeId);
    const agent = run?.agent ?? this.nodeWorkers.get(nodeId)?.agent;
    if (agent && (run || agent.running)) {
      agent.cancel();
      killed++;
    }
    // 2. Its background terminals, killed without the usual notice — the interrupt
    //    message is written back below instead.
    killed += this.killJobsOf(nodeId);
    // 3. Its sub-agents, the **whole subtree**: a depth-1 sub-agent may be running
    //    depth-2 children of its own, and those belong to this node just as much.
    for (const agentNodeId of this.subAgentSubtree(nodeId)) {
      const entry = this.runningSubAgents.get(agentNodeId);
      if (!entry) {
        continue;
      }
      entry.abort.abort();
      entry.agent.cancel();
      killed++;
      // A sub-agent's own `exec_command` registers under the *sub-agent's* node, so
      // its terminals are this node's work too.
      killed += this.killJobsOf(agentNodeId);
    }
    // 4. A notice already queued for this node must not fire a turn now either.
    for (const signal of this.takePendingSignals(nodeId)) {
      this.queueWriteback(signal);
    }
    this.postBackgrounds();
    this.postState();
    return killed;
  }

  /** Every running sub-agent below `nodeId`, depth first (max depth 2 by design). */
  private subAgentSubtree(nodeId: string): string[] {
    const out: string[] = [];
    const collect = (parentId: string, guard = 0): void => {
      if (guard > 8) {
        return;
      }
      for (const agentNodeId of [...this.runningSubAgents.keys()]) {
        if (this.session.nodes[agentNodeId]?.parentId !== parentId) {
          continue;
        }
        out.push(agentNodeId);
        collect(agentNodeId, guard + 1);
      }
    };
    collect(nodeId);
    return out;
  }

  /** Kill one node's background terminals silently; their interrupt is written back. */
  private killJobsOf(nodeId: string): number {
    let killed = 0;
    const owner: BackgroundOwner = { sessionId: this.sessionId, nodeId };
    for (const task of this.hub.listForNode(this.sessionId, nodeId)) {
      if (task.status !== 'running') {
        continue;
      }
      const hit = this.hub.kill(this.sessionId, task.id, { notifyAgent: false });
      if (hit) {
        this.queueWriteback(this.buildBackgroundSignal(owner, hit));
        killed++;
      }
    }
    return killed;
  }

  /** The conversational node a card belongs to: the sub-agent / job chain's owner. */
  private turnOwnerOf(nodeId: string): TreeNode | null {
    let node: TreeNode | undefined = this.session.nodes[nodeId];
    for (let guard = 0; node && isSidecar(node) && guard < 64; guard++) {
      node = node.parentId ? this.session.nodes[node.parentId] : undefined;
    }
    return node ?? null;
  }

  /**
   * True when this card belongs to a line the user union-killed and has not continued
   * since — nothing produced under it may start a turn (it is written back instead).
   */
  private isStoppedLine(nodeId: string): boolean {
    const turn = this.turnOwnerOf(nodeId);
    return !!turn && this.stoppedLines.has(turn.id);
  }

  /**
   * Queue a notice that must reach the *next* request instead of opening a turn. A
   * sub-agent's own notice is retargeted to the turn node that owns its line — that is
   * the history the next request is built from (a sidecar's history is never sent).
   */
  private queueWriteback(signal: SignalNotice): void {
    const target = this.turnOwnerOf(signal.nodeId);
    if (!target) {
      return;
    }
    signal.nodeId = target.id;
    const queue = this.writebacks.get(target.id);
    if (queue) {
      queue.push(signal);
    } else {
      this.writebacks.set(target.id, [signal]);
    }
    this.flushWritebacks();
  }

  /**
   * Append queued union-kill notices to their node's history — the card block and
   * the message the next request carries — once that node is quiet. A node whose
   * turn is still winding down is retried by the signal drain (`scheduleSignalDrain`)
   * so the text can never slip past a request built in between.
   */
  private flushWritebacks(): void {
    if (this.dead || this.writebacks.size === 0) {
      return;
    }
    let deferred = false;
    for (const nodeId of [...this.writebacks.keys()]) {
      const node = this.session.nodes[nodeId];
      if (!node) {
        this.writebacks.delete(nodeId);
        continue;
      }
      if (this.runs.has(nodeId) || this.runningSubAgents.has(nodeId) || this.nodeWorkers.get(nodeId)?.agent.running) {
        // Its turn is still finishing: `finishTurn` flushes again, and the drain
        // retries in the meantime (the agent's own history decides what the next
        // request sends, so writing earlier would be overwritten).
        deferred = true;
        continue;
      }
      const batch = this.writebacks.get(nodeId);
      this.writebacks.delete(nodeId);
      if (!batch || batch.length === 0) {
        continue;
      }
      // The card shows what happened (the same block a delivered notice renders)…
      this.renderSignalCards(nodeId, batch);
      // …and the interrupt travels with the next request instead of starting one.
      node.messages = [...node.messages, { role: 'user', content: combineSignalText(batch) }];
      this.persistTurn();
      this.postTree();
      this.postState();
    }
    if (deferred) {
      this.scheduleSignalDrain(75);
    }
  }

  /** Stop every run of this session (the control plane's interrupt path). */
  onStop(): void {
    this.stop();
  }

  /** Open a file picker, read the chosen image, and send a base64 data URL back. */
  async handlePickImage(): Promise<void> {
    const result = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { [vscode.l10n.t('Images')]: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
      openLabel: vscode.l10n.t('Attach Image'),
    });
    if (!result || result.length === 0) {
      return;
    }
    const filePath = result[0].fsPath;
    try {
      const buffer = await fs.promises.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime =
        ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
      this.post({ type: 'imagePicked', dataUrl, name: path.basename(filePath) });
    } catch (err) {
      this.post({
        type: 'error',
        message: `Could not read image: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // ---- Agent events / streaming ----

  private logUsage(usage: Usage): void {
    this.host.output.appendLine(
      `[usage] total=${usage.total_tokens} prompt=${usage.prompt_tokens} ` +
        `completion=${usage.completion_tokens} ` +
        `cache_hit=${usage.prompt_cache_hit_tokens ?? 0} ` +
        `cache_miss=${usage.prompt_cache_miss_tokens ?? 0}`,
    );
  }

  /**
   * Route one agent event into the run bound to `node` (P3). The agent is the
   * node's own worker, so the run is whichever run currently holds that node, and
   * every reference below goes through `run` rather than through "the active
   * turn" — a second branch streaming at the same time is simply a different
   * `run` and never receives these events.
   */
  private handleAgentEventFor(node: TreeNode, event: AgentEvent): void {
    const run = this.runs.get(node.id);
    switch (event.type) {
      case 'status':
        this.lastStatus = event.text;
        this.post({ type: 'status', text: event.text });
        break;
      case 'streamDelta':
        if (run) this.appendDelta(run, event.content);
        break;
      case 'reasoningDelta':
        if (run) this.appendThinkingDelta(run, event.content);
        break;
      case 'assistantDone':
        if (run) this.flushStreamDeltas(run);
        break;
      case 'usage':
        if (run) {
          this.flushStreamDeltas(run);
          this.logUsage(event.usage);
          this.currentPromptTokens = event.usage.prompt_tokens;
          this.postContext();
          // The turn's usage belongs on the turn's window: the assistant bubble
          // for a text answer, or the tool call card for a tool-call turn. Attach
          // it to whichever item concluded the turn (the last item) so the token
          // count shows in place and is never hoisted into an empty message bubble.
          const last = run.items[run.items.length - 1];
          if (last && (last.kind === 'assistant' || last.kind === 'tool') && !last.error) {
            last.usage = event.usage;
          }
          this.post({ type: 'usage', usage: event.usage, nodeId: run.nodeId });
          // Recompute the session totals after this turn's usage is attached to
          // the display items, so the cumulative counters include the turn just
          // finished.
          this.postSessionStats();
        }
        break;
      case 'toolCallDelta':
        if (run) this.queueToolCallDelta(run, event.index, event.id, event.name, event.args);
        break;
      case 'toolStart':
        if (run) {
          this.flushStreamDeltas(run);
          // Once a tool call starts running, reflect it in the header instead of
          // the generic "Thinking…".
          if (event.name) {
            this.lastStatus = vscode.l10n.t('Calling {0}…', event.name);
            this.post({ type: 'status', text: this.lastStatus });
          }
          run.items.push({
            kind: 'tool',
            id: event.id,
            name: event.name,
            args: clipForUi(event.args, 8 * 1024),
            status: 'running',
            // The host's start clock, not the webview's: a card created by a repaint
            // mid-call must tick from the same origin the live one does.
            startedAt: event.startedAt,
          });
          this.post({
            type: 'toolStart',
            id: event.id,
            name: event.name,
            args: clipForUi(event.args, 8 * 1024),
            index: event.index,
            nodeId: run.nodeId,
            startedAt: event.startedAt,
          });
        }
        break;
      case 'toolEnd':
        if (run) {
          this.updateToolItem(run, event.id, event.content, event.ms);
          this.post({
            type: 'toolEnd',
            id: event.id,
            name: event.name,
            content: clipForUi(event.content),
            nodeId: run.nodeId,
            ms: event.ms,
          });
        }
        break;
      case 'retry':
        // The engine re-issued the whole request transparently: the model's
        // conversation holds nothing about it, so neither may `messages`. The card
        // gets one **display-only** marker (`run.marker`), updated in place as the
        // attempts advance — one item for the run, never one per attempt. Posted
        // node-scoped because the run need not be the view focus, and with a
        // `noticeId` so the webview rewrites the same block instead of appending.
        if (run) {
          const text = vscode.l10n.t('\u27f3 Silent retry {0}/{1}', event.attempt, event.max);
          // The id belongs to this **run**, not to its node (see `Run.markerId`): the
          // second retry of a later run must add its own block, not rewrite the one
          // this run left in the card.
          if (!run.markerId) {
            run.markerId = `retry-${run.nodeId}-${++this.markerSerial}`;
          }
          if (run.marker) {
            run.marker.text = text;
          } else {
            run.marker = { kind: 'notice', noticeKind: 'info', text, noticeId: run.markerId };
            run.items.push(run.marker);
          }
          this.post({
            type: 'notice',
            kind: 'info',
            text,
            nodeId: run.nodeId,
            noticeId: run.markerId,
          });
        }
        break;
      case 'done':
        if (run) this.flushStreamDeltas(run);
        // Preserve an informative final status (e.g. loop-limit note) if one was
        // set; otherwise fall back to a simple "Done".
        if (!this.lastStatus || this.lastStatus === vscode.l10n.t('Thinking…')) {
          this.lastStatus = vscode.l10n.t('Done');
        }
        this.post({ type: 'status', text: this.lastStatus });
        this.post({ type: 'done', nodeId: run?.nodeId });
        if (run) this.finishTurn(run, 'done');
        // P3: `busy` clears only once the *last* run of the session is gone.
        this.syncBusy();
        void this.refreshBalance();
        this.drainSignals();
        break;
      case 'interrupted':
        if (run) this.flushStreamDeltas(run);
        this.lastStatus = vscode.l10n.t('Interrupted');
        this.post({ type: 'interrupted', nodeId: run?.nodeId });
        // Remember, per node, which worker holds the pending interruption notice,
        // so a turn that continues from this node still gets it while a
        // concurrent branch's own interruption cannot clobber it.
        if (run) this.interruptedNodes.set(run.nodeId, run.agent);
        if (run) this.finishTurn(run, 'interrupted');
        this.syncBusy();
        void this.refreshBalance();
        this.drainSignals();
        break;
      case 'error':
        if (run) {
          this.flushStreamDeltas(run);
          this.lastStatus = vscode.l10n.t('Error');
          run.items.push({ kind: 'assistant', text: `⚠️ ${event.message}`, error: true });
          this.post({ type: 'error', message: event.message, nodeId: run.nodeId });
        } else {
          this.lastStatus = vscode.l10n.t('Error');
        }
        if (run) this.finishTurn(run, 'error');
        this.syncBusy();
        void this.refreshBalance();
        this.drainSignals();
        break;
      default:
        break;
    }
  }

  /**
   * Persist **this session**: mark it as the one that changed, then use the provider's
   * usual queue. Every runtime-driven write is about this runtime's own session (a turn
   * ending, a tool boundary, a card's size), so marking here is exact — and it is the
   * single place that makes the write a per-session one instead of a whole-profile one.
   */
  private persistTurn(): void {
    this.host.markSessionDirty(this.session.id);
    this.host.persist();
  }

  /** The same, for the moments where a delayed write would lose real state. */
  private persistTurnNow(): void {
    this.host.markSessionDirty(this.session.id);
    this.host.persistNow();
  }

  private appendDelta(run: TurnRun, text: string): void {
    run.pendingText += text;
    this.scheduleStreamFlush(run);
  }

  private appendThinkingDelta(run: TurnRun, text: string): void {
    run.pendingThinking += text;
    this.scheduleStreamFlush(run);
  }

  private commitTextDelta(run: TurnRun, text: string): void {
    const last = run.items[run.items.length - 1];
    if (last && last.kind === 'assistant' && !last.error) {
      last.text = (last.text ?? '') + text;
    } else {
      run.items.push({ kind: 'assistant', text });
    }
  }

  private commitThinkingDelta(run: TurnRun, text: string): void {
    const last = run.items[run.items.length - 1];
    if (last && last.kind === 'assistant' && !last.error) {
      last.thinking = (last.thinking ?? '') + text;
    } else {
      run.items.push({ kind: 'assistant', thinking: text });
    }
  }

  private queueToolCallDelta(run: TurnRun, index: number, id?: string, name?: string, args?: string): void {
    const existing = run.pendingTools.get(index) ?? { id, name: '', args: '' };
    if (id) {
      existing.id = id;
    }
    if (name) {
      existing.name += name;
    }
    if (args) {
      existing.args += args;
    }
    run.pendingTools.set(index, existing);
    this.scheduleStreamFlush(run);
  }

  private scheduleStreamFlush(run: TurnRun): void {
    if (run.flushTimer != null) {
      return;
    }
    run.flushTimer = setTimeout(() => {
      run.flushTimer = null;
      this.flushStreamDeltas(run);
    }, 50);
  }

  private flushStreamDeltas(run: TurnRun): void {
    if (run.flushTimer != null) {
      clearTimeout(run.flushTimer);
      run.flushTimer = null;
    }
    const text = run.pendingText;
    const thinking = run.pendingThinking;
    const tools = run.pendingTools.size;
    if (!text && !thinking && tools === 0) {
      return;
    }
    run.pendingText = '';
    run.pendingThinking = '';
    const bytes = text.length + thinking.length;
    this.streamFlushCount++;
    this.streamFlushBytes += bytes;
    const now = Date.now();
    if (this.streamFlushWindow === 0) {
      this.streamFlushWindow = now;
    }
    if (text) {
      this.commitTextDelta(run, text);
      this.post({ type: 'delta', text, nodeId: run.nodeId });
    }
    if (thinking) {
      this.commitThinkingDelta(run, thinking);
      this.post({ type: 'thinkingDelta', text: thinking, nodeId: run.nodeId });
    }
    if (tools > 0) {
      for (const [index, draft] of run.pendingTools) {
        this.post({
          type: 'toolCallDelta',
          index,
          id: draft.id,
          name: draft.name,
          args: clipForUi(draft.args, 8 * 1024),
          nodeId: run.nodeId,
        });
      }
      run.pendingTools.clear();
    }
    if (now - this.streamFlushWindow >= 2000) {
      perf(
        () =>
          `stream-flush n=${this.streamFlushCount} bytes=${this.streamFlushBytes} ` +
          `window=${now - this.streamFlushWindow}ms items=${run.items.length}`,
      );
      this.streamFlushCount = 0;
      this.streamFlushBytes = 0;
      this.streamFlushWindow = now;
    }
  }

  private updateToolItem(run: TurnRun, id: string, content: string, ms: number): void {
    const item = run.items.find((it) => it.kind === 'tool' && it.id === id);
    if (item) {
      item.status = 'done';
      item.content = clipForUi(content);
      // The call's own duration: the card freezes on it, and the start clock goes
      // away with it (the pair is "running" or "took this long", never both).
      item.ms = ms;
      item.startedAt = undefined;
    }
  }

  // ---- Sub-agents ----

  /**
   * Tools a sub-agent may use, by `write` flag, bound to the node it acts for
   * (P3): building from `workerFor(node).tools` means the sub-agent's background
   * jobs register under the same node as its own spawn/send handlers, instead of
   * under "the active turn" (which is ambiguous once two branches run at once).
   */
  private subAgentTools(node: TreeNode, write: boolean): ToolRegistry {
    const base = this.workerFor(node).tools;
    // `web_search` / `web_fetch` are read-only in the sense that matters here: they
    // touch nothing on this machine, so a read-only sub-agent may research (before
    // them, a read-only sub-agent had no network tool at all — the research tools
    // are the shell, which a read-only sub-agent correctly does not get).
    const read = ['read_file', 'list_dir', 'search_files', 'search_transcripts', 'web_search', 'web_fetch'];
    const writeTools = ['write_file', 'replace_in_file', 'exec_command'];
    if (write) {
      return base.subset([...read, ...writeTools]);
    }
    // Read-only sub-agents: the write tools stay registered with a rejecting
    // executor (defense-in-depth) but are hidden from the model's tool list, so
    // it does not spend a round proposing a tool it can never use.
    return base.subset([...read, ...writeTools]).withBlocked(writeTools).withHidden(writeTools);
  }

  /** " · transcript: <path>" suffix for a sub-agent completion note ('' when off). */
  private transcriptNote(node: TreeNode): string {
    return node.agentTranscript ? ` · transcript: ${node.agentTranscript}` : '';
  }

  /**
   * The main agent spawned sub-agents. The handler is bound to the node whose
   * turn called `spawn_agents` (P3), so the children always attach to *that*
   * node — no "which run is this?" lookup, and no fallback to the view focus.
   */
  private handleSpawnAgents(node: TreeNode, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const parent = this.session.nodes[node.id];
    if (!parent) {
      return Promise.resolve('Error: no active turn to attach sub-agents to.');
    }
    // The shape of the fan-out, in one line: a report from a machine where "it is still
    // slow" is unreadable unless the log says how many sub-agents were asked for at once
    // (the concurrency limit, not the machine, may be the answer).
    perf(
      () =>
        `spawn-request count=${Array.isArray(args.agents) ? args.agents.length : '?'} ` +
        `mode=${String(args.mode ?? 'sync')} depth=1 node=${node.id}`,
    );
    return this.spawnChildren(parent, args, signal);
  }

  /** A sub-agent spawned its own (level-2) sub-agents. */
  private handleSubAgentSpawn(parent: TreeNode, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    return this.spawnChildren(parent, args, signal);
  }

  /** The main agent resumed a finished sub-agent via `send_agent_message`
   * (trusted: it may raise or lower the target's `write`). `caller` is the calling
   * node (P3 binds the handler per node); the lookup is session-wide exactly as
   * before. */
  private handleSendAgentMessage(caller: TreeNode, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    void caller;
    const session = this.session;
    const id = String(args.id ?? '');
    const node = session.nodes[id];
    if (!node || node.kind !== 'agent') {
      return Promise.resolve(`Error: no sub-agent with id "${id}".`);
    }
    let write = node.agentWrite ?? false;
    if (typeof args.write === 'boolean') {
      write = args.write;
    }
    const override = this.parseModelOverride(args.model);
    if (override.error) {
      return Promise.resolve(override.error);
    }
    return this.resumeSubAgent(session, node, String(args.message ?? ''), String(args.mode ?? 'sync'), write, override.card, signal);
  }

  /**
   * A depth-1 sub-agent resumed one of its own finished sub-agents
   * (`send_agent_message` for a writable worker, `send_readonly_agent_message`
   * for a read-only one). Least privilege: the target must be a **direct child**
   * of the caller, and the resumed run's `write` is the AND of the caller's and
   * the target's — a sub-agent can never raise a child's permission.
   */
  private handleSubAgentSendMessage(parent: TreeNode, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const session = this.session;
    const id = String(args.id ?? '');
    const node = session.nodes[id];
    if (!node || node.kind !== 'agent') {
      return Promise.resolve(`Error: no sub-agent with id "${id}".`);
    }
    if (node.parentId !== parent.id) {
      return Promise.resolve('Error: you may only message a sub-agent that you spawned yourself.');
    }
    const override = this.parseModelOverride(args.model);
    if (override.error) {
      return Promise.resolve(override.error);
    }
    const write = parent.agentWrite === true && node.agentWrite === true;
    return this.resumeSubAgent(session, node, String(args.message ?? ''), String(args.mode ?? 'sync'), write, override.card, signal);
  }

  /**
   * Validate an optional `model` override; returns `{ card }` or `{ error }`. The
   * `model` field of a spec is a **card** value now — a card id, or the card's
   * name / wire name, exactly like a stored `session.model` — so it is resolved
   * through `resolveCard` and an unknown value is refused by name rather than
   * guessed at.
   */
  private parseModelOverride(value: unknown): { card?: ModelCard; error?: string } {
    if (typeof value !== 'string' || !value) {
      return {};
    }
    const card = resolveCard(value);
    if (!card) {
      return { error: `Error: unknown model "${value}".` };
    }
    return { card };
  }

  /** Shared resume path for `send_agent_message` / `send_readonly_agent_message`. */
  private async resumeSubAgent(
    session: AgentSession,
    node: TreeNode,
    message: string,
    mode: string,
    write: boolean,
    card: ModelCard | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    if (!message) {
      return Promise.resolve('Error: a follow-up "message" is required.');
    }
    if (mode !== 'sync' && mode !== 'async') {
      return Promise.resolve(`Error: invalid mode "${mode}". Use "sync" or "async".`);
    }
    if (this.runningSubAgents.has(node.id)) {
      return Promise.resolve(
        'Error: that sub-agent is still running. Wait for it to finish (or kill it) before sending a follow-up.',
      );
    }
    // The follow-up runs on the card the caller named, else on the card this
    // sub-agent last ran on (`node.agentModel`, a card id), else on the card of the
    // node that **spawned** it (a sub-agent node carries no card of its own, so its
    // ancestry walk lands on the turn that spawned it — never on the session's
    // current dropdown, which belongs to another branch).
    const subCard = card ?? resolveCard(node.agentModel) ?? this.cardForNode(node);
    node.agentWrite = write;
    node.agentModel = subCard.id;
    // The spec's `model` is only the *override*: it is stored when it differs from
    // what the spawning node already gives this sub-agent, so a resume that keeps the
    // inherited card stays a plain `resume` (the card resolution above reproduces it).
    const job: SubAgentJob = {
      node,
      spec: { instruction: message, write, model: subCard.id !== this.cardIdForNode(node) ? subCard.id : undefined },
      resume: true,
      sessionId: session.id,
    };
    if (mode === 'async') {
      void this.runSubAgent(job, signal).then((r) => this.deliverResumeAsync(node, r), () => {});
      return Promise.resolve(JSON.stringify({ resumed: true, id: node.id, async: true }));
    }
    // `sync` is **bounded** exactly like `spawn_agents`: the resume is awaited at most
    // `spinney.commandMaxForegroundDuration`, and a target that is still running when
    // the budget runs out stops holding the turn — the result is delivered later
    // through the same batch-notice path `async` uses (`deliverResumeAsync`).
    //
    // INVARIANT — delivered **exactly once**: the tool result is the only delivery on
    // the normal path (it settles the card below, D1), the notice is the only delivery
    // on the escape path (`settleSignals` settles the card when it lands). So the
    // escape must not set `node.delivered`, or the notice would render as an
    // already-delivered batch and the summary would never reach the model.
    const task = this.runSubAgent(job, signal);
    let finished = false;
    const all = task.then((r) => {
      finished = true;
      return r;
    });
    const limitMs = commandMaxForegroundDurationSec() * 1000;
    const settled = await Promise.race([all.then(() => null), delay(limitMs).then(() => 'timeout' as const)]);
    if (settled === 'timeout') {
      void all.then((r) => this.deliverResumeAsync(node, r), () => {});
      return JSON.stringify({
        resumed: true,
        async: true,
        escaped: true,
        waitedMs: limitMs,
        id: node.id,
        done: finished ? [node.id] : [],
        running: finished ? [] : [node.id],
        note: batchEscapeNote(limitMs),
        transcriptDir: this.host.transcriptDir(session.id),
      });
    }
    const r = await all;
    // Sync resume: the resumed output is the tool result, so the caller is
    // informed by construction — settle the card (D1).
    if (!node.delivered) {
      node.delivered = true;
      this.persistTurn();
      this.postTree();
    }
    return JSON.stringify({
      resumed: true,
      id: node.id,
      ok: r.ok,
      summary: r.summary,
      model: r.model,
      modelName: r.modelName,
      durationMs: r.durationMs,
      transcript: node.agentTranscript,
      stats: summarizeTranscript(node.messages),
    });
  }

  /** Async resume: deliver the resumed sub-agent's outcome to whoever owns it —
   * the main agent (a card + one signal), or a sub-agent parent (queued for its
   * next tool boundary, or auto-resumed when it is already done). */
  private deliverResumeAsync(node: TreeNode, result: SubAgentRunResult): void {
    const parent = this.session.nodes[node.parentId ?? ''] ?? null;
    if (!parent) {
      return;
    }
    const entry: SubAgentBatchEntry = {
      ok: result.ok,
      summary: result.summary,
      node,
      durationMs: result.durationMs,
    };
    const cardText = `Sub-agent #${node.id.slice(-6)} ${result.ok ? 'finished' : 'failed'} in ${formatDuration(result.durationMs)}: ${result.summary || '(no summary)'}${this.transcriptNote(node)}`;
    if (this.isStoppedLine(node.id)) {
      // Stop killed this resume: record the interrupt where the next request will
      // pick it up instead of delivering a notice turn.
      this.queueWriteback(this.buildSubAgentSignal(parent, [entry], cardText));
      this.persistTurn();
      return;
    }
    this.queueSubAgentSignal(parent, [entry], cardText);
    this.persistTurn();
  }

  /**
   * Create agent child nodes under `parent`, run them (in parallel, pool-limited
   * for level-1), and return the spawn result. `sync` blocks and returns the
   * summaries; `async` returns immediately and delivers per-job results as an
   * injected notification to the parent when idle.
   */
  private async spawnChildren(parent: TreeNode, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const session = this.session;
    // The batch's own wall clock, for the sync result's top-level `durationMs` and the
    // async notice's status line: in parallel mode it is *not* the sum of the runs.
    const batchStartedAt = Date.now();
    // Capture the view focus BEFORE attachNode below moves it to the new
    // (sidecar) agent node, so we can restore it: a sub-agent card is display-only
    // and must never become the view focus/composer dock.
    const prevActive = session.activeNodeId;
    const rawAgents = Array.isArray(args.agents) ? args.agents : [];
    if (rawAgents.length === 0) {
      return 'Error: spawn_agents requires a non-empty "agents" array.';
    }
    const mode = String(args.mode ?? 'sync');
    if (mode !== 'sync' && mode !== 'async') {
      return `Error: invalid mode "${mode}". Use "sync" or "async".`;
    }
    const childDepth = (parent.agentDepth ?? 0) + 1;
    // Defense-in-depth: a read-only sub-agent must never create a writable child,
    // even if a spawn call somehow reaches the provider.
    const parentReadOnly = parent.kind === 'agent' && parent.agentWrite === false;
    if (childDepth > 2) {
      return 'Error: a sub-sub-sub-agent is not allowed (max sub-agent depth is 2).';
    }
    // Level-2 budget: per-parent count.
    if (childDepth === 2) {
      const used = this.level2Counts.get(parent.id) ?? 0;
      const budget = this.host.getConfig().maxLevel2Subagents;
      if (rawAgents.length > Math.max(0, budget - used)) {
        return `Error: this sub-agent may start at most ${budget} sub-sub-agents (${used} already started).`;
      }
      this.level2Counts.set(parent.id, used + rawAgents.length);
    }

    // Build a node + spec per task.
    const jobs: SubAgentJob[] = [];
    for (const raw of rawAgents) {
      const spec = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const instruction = String(spec.instruction ?? '');
      const write = parentReadOnly ? false : spec.write === true;
      // The spec's `model` is a card value (id, or the card's name / wire name —
      // the same spellings `resolveCard` accepts everywhere else).
      const model = typeof spec.model === 'string' ? spec.model : undefined;
      if (!instruction) {
        return 'Error: each agent spec requires an "instruction".';
      }
      const modelCard = model === undefined ? undefined : resolveCard(model);
      if (model !== undefined && modelCard === undefined) {
        return `Error: unknown model "${model}".`;
      }
      // The sub-agent runs on the card it named, else on the card of the node that
      // spawned it: a sub-agent inherits its **parent node's** card, never the
      // session's current selection (the draft pass may sit on another branch).
      const subCard = modelCard ?? this.cardForNode(parent);
      const node = createNode(newId(), parent.id, `Sub-agent: ${sliceText(instruction, 32)}`, 'running');
      node.kind = 'agent';
      node.agentDepth = childDepth;
      node.agentStatus = 'running';
      // The node stores the card **id** (the webview and the transcripts name the
      // display form; the id is what survives a rename).
      node.agentModel = subCard.id;
      node.agentWrite = write;
      node.children = [];
      node.displayItems.push({ kind: 'user', text: instruction });
      attachNode(session, node);
      jobs.push({
        spec: { instruction, write, model: modelCard ? subCard.id : undefined },
        node,
        sessionId: session.id,
      });
    }
    // Restore the view focus we captured above: attachNode moved it to the last
    // agent child, and the view must stay where the user left it. The stream
    // target is tracked separately (`runs`), so nothing else needs pinning here.
    if (session.activeNodeId !== prevActive) {
      session.activeNodeId = prevActive;
    }
    this.postTree();

    // One promise per job, built **once**: the array feeds the bounded wait below and —
    // when that wait escapes — the delivery callback, because a promise may be awaited
    // twice but the work it wraps may not (a second `map` would run every sub-agent a
    // second time). `doneFlags` is what the escape result reports as `done`/`running`:
    // it is set by the job's own resolution, so it is exact when the timer wins the race
    // (microtasks run before the timer callback, so a job that had settled shows up).
    const doneFlags = jobs.map(() => false);
    const tasks = jobs.map((job, index) => {
      const run = () => this.runSubAgent(job, signal);
      return (childDepth === 1 ? this.subAgentPool.withSlot(run) : run()).then((result) => {
        doneFlags[index] = true;
        return { job, result };
      });
    });

    if (mode === 'async') {
      // Notify the parent once the whole batch settles, so it reacts a single time
      // (`onAsyncBatchDone` handles a main-agent parent and a sub-agent parent the
      // same way now — the batch belongs to `parent`, whoever it is).
      this.deliverBatchWhenSettled(parent, jobs, tasks, batchStartedAt);
      return JSON.stringify({
        spawned: jobs.length,
        async: true,
        ids: jobs.map((j) => j.node.id),
        transcriptDir: this.host.transcriptDir(session.id),
      });
    }

    // `sync` is **bounded**: the batch runs exactly as before, but the turn is not held
    // for it. `Promise.race` gives up at `spinney.commandMaxForegroundDuration` and the
    // batch is then delivered by the *async* path — one batch notice when the last job
    // finishes — instead of by this tool result.
    //
    // INVARIANT — the batch is delivered **exactly once**: on the normal path the tool
    // result is the only delivery (it settles the cards below, D1) and no notice is ever
    // queued; on the escape path the batch notice is the only delivery (it settles the
    // cards when it lands, `settleSignals`). That is why the escape branch must not
    // touch `job.node.delivered`: marking it here would make the notice render as an
    // already-delivered batch and the summaries would never reach the model.
    const limitMs = commandMaxForegroundDurationSec() * 1000;
    const all = Promise.allSettled(tasks);
    const settled = await Promise.race([all.then(() => null), delay(limitMs).then(() => 'timeout' as const)]);
    if (settled === 'timeout') {
      this.deliverBatchWhenSettled(parent, jobs, tasks, batchStartedAt);
      return JSON.stringify({
        spawned: jobs.length,
        async: true,
        escaped: true,
        waitedMs: limitMs,
        ids: jobs.map((j) => j.node.id),
        // Which jobs the budget actually caught (see `doneFlags`).
        done: jobs.filter((_, i) => doneFlags[i]).map((j) => j.node.id),
        running: jobs.filter((_, i) => !doneFlags[i]).map((j) => j.node.id),
        note: batchEscapeNote(limitMs),
        transcriptDir: this.host.transcriptDir(session.id),
      });
    }

    const results = (await all).map((s, i) =>
      s.status === 'fulfilled' ? s.value.result : { ok: false, summary: 'cancelled', durationMs: 0 },
    );
    // Sync mode: the summaries are the tool result, so the caller is informed by
    // construction — no notice will follow. Settle their cards (D1).
    for (const job of jobs) {
      if (!job.node.delivered) {
        job.node.delivered = true;
      }
    }
    this.persistTurn();
    this.postTree();
    return JSON.stringify({
      results: results.map((r, i) => ({
        agentNodeId: jobs[i].node.id,
        transcript: jobs[i].node.agentTranscript,
        stats: summarizeTranscript(jobs[i].node.messages),
        ...r,
      })),
      // The whole batch: one number for "how long did asking for N sub-agents take",
      // which the per-agent `durationMs` cannot answer when they ran in parallel.
      durationMs: Date.now() - batchStartedAt,
    });
  }

  /**
   * The **one** delivery path for a sub-agent batch that settles after the tool call
   * which started it has already returned: `async` mode's only path, and the path a
   * timed-out `sync` batch escapes onto. It builds the settled entries (a job that
   * rejected counts as `cancelled`) and hands them to `onAsyncBatchDone`, which queues
   * a single batch signal for the parent node — injected at that turn's next tool
   * boundary, or delivered as an injected turn once it is idle (`queueSubAgentSignal`).
   *
   * `tasks` is the caller's own array, never rebuilt: awaiting a promise twice is free,
   * running the sub-agents twice is not.
   */
  private deliverBatchWhenSettled(
    parent: TreeNode,
    jobs: SubAgentJob[],
    tasks: ReadonlyArray<Promise<{ job: SubAgentJob; result: SubAgentRunResult }>>,
    batchStartedAt: number,
  ): void {
    void Promise.allSettled(tasks).then((settled) => {
      const list = settled.map((s, i) =>
        s.status === 'fulfilled' ? s.value : { job: jobs[i], result: { ok: false, summary: 'cancelled', durationMs: 0 } },
      );
      this.onAsyncBatchDone(parent, list.map((l) => ({ ...l.result, node: l.job.node })), Date.now() - batchStartedAt);
    });
  }

  /** Run one sub-agent to completion and resolve its result. When `resume` is set,
   * the sub-agent's stored conversation is prepended so a follow-up continues it. */
  private runSubAgent(
    job: SubAgentJob,
    signal: AbortSignal,
  ): Promise<SubAgentRunResult> {
    return new Promise((resolve) => {
      const abort = new AbortController();
      const onAbort = () => abort.abort();
      signal.addEventListener('abort', onAbort, { once: true });

      const startedAt = Date.now();
      // The card's ticking chip reads this; it is cleared the moment the run ends so
      // a card can never count for a run that is over (see `finish`).
      job.node.agentStartedAt = startedAt;
      const subTools = this.subAgentTools(job.node, job.spec.write);
      // The card this sub-agent runs on: the one its spec named (a card id, or the
      // name a caller typed — `resolveCard` accepts both), else the card of the node
      // that spawned it (its ancestry: a sub-agent inherits from its **parent node**,
      // not from the session's current dropdown). Resolved once, up front, so the
      // system prompt's identity line, the wire request the agent sends and what the
      // caller is told cannot disagree about which model answered.
      const subCard = resolveCard(job.spec.model) ?? this.cardForNode(job.node);
      // The level, likewise: the spawning node's level, clamped onto the card this
      // sub-agent actually runs on (the spec may have retargeted it).
      const subEffort = normalizeEffort(subCard, this.effortNameForNode(job.node));
      let finished = false;
      let subAgent: Agent | null = null;
      // Resolved once this run is fully wound down — the transcript dump included. A
      // context rollover kills its node's sub-agents and then has to *name* them (and
      // point at their dumps) in the new window's message, so it waits on this rather
      // than guessing. `finish` early-returns, so it settles exactly once.
      let settle!: () => void;
      const settled = new Promise<void>((resolveSettled) => {
        settle = resolveSettled;
      });
      const finish = (status: 'done' | 'killed' | 'error', summary: string) => {
        if (finished) return;
        finished = true;
        const durationMs = Math.max(0, Date.now() - startedAt);
        signal.removeEventListener('abort', onAbort);
        this.runningSubAgents.delete(job.node.id);
        job.node.agentStatus = status;
        job.node.status = status === 'done' ? 'done' : status === 'error' ? 'error' : 'interrupted';
        job.node.agentSummary = summary;
        // This run is over: the card swaps a ticking chip for the frozen number, and
        // the start clock goes away with the run it timed.
        job.node.agentElapsedMs = durationMs;
        job.node.agentStartedAt = undefined;
        // Persist the sub-agent's conversation (minus the synthesized system prompt)
        // so a later send_agent_message (or an async child-notice resume) can
        // continue it, even across an extension-host restart.
        if (subAgent) {
          job.node.messages = subAgent.getMessages().filter((m) => m.role !== 'system');
          // A sub-agent's own `read_image` uploads get the same provenance the main agent's
          // do, so a resumed sub-agent knows where its images came from and the budget stays
          // exact across the resume (the node's history is what it starts from).
          this.recordUploadSources(job.node, subAgent);
          // …and dump the same conversation to disk (JSONL) so the *caller* can
          // read the full tool-call history it cannot see in the summary.
          job.node.agentTranscript = this.host.writeSubAgentTranscript(job, subAgent, status, summary, startedAt);
        }
        this.post({ type: 'agentDone', id: job.node.id, status, summary, elapsedMs: durationMs });
        // The sub-agent's whole conversation (and the transcript dump it points at)
        // is written now: a `send_agent_message` may resume it at any moment, and a
        // coalesced write would lose the conversation the resume builds on.
        this.persistTurnNow();
        // This sub-agent (depth-1) may have queued its depth-2 children's completion
        // signals while it ran. Now that it stopped, the drain can hand them over:
        // an idle sub-agent node is resumed with them (a live one would have taken
        // them at its own tool boundary — see `takeSignalsFor`).
        this.drainSignals();
        settle();
        resolve({ ok: status === 'done', summary, model: subCard.id, modelName: cardDisplayName(subCard), durationMs });
      };

      const sub = new Agent(this.clients, subTools, (event) => this.handleSubAgentEvent(job.node, event, finish));
      subAgent = sub;
      sub.setCard(subCard);
      sub.setThinkingEffort(subEffort);
      // A sub-agent's history is its **own**: it starts empty, or resumes the conversation
      // stored on its node, and the parent chain's images are never part of its requests. So
      // its budget is computed from its own node's provenance alone — which is also what
      // makes a sub-agent the escape hatch for a chain that can no longer carry images. The
      // view is installed on this agent, so a pool of parallel sub-agents cannot see each
      // other's histories.
      sub.setImageAccounting(
        this.imageAccountingFor(
          () => [job.node.id],
          () => subCard.vision.transport,
        ),
      );
      // A sub-agent takes its own children's completion signals at its own tool
      // boundary, exactly like the main agent (D3).
      sub.setSignalHandler(() => this.takeSignalsFor(job.node));
      // Depth is hard-capped at 2, so only a depth-1 sub-agent may fan out. A
      // writable one gets `spawn_agents` (children may write); a read-only one
      // gets `spawn_readonly_agents` instead, whose args cannot express
      // `write:true` — so it keeps read-only parallelism without an escalation
      // path. `setCanSpawn*` decides which spawn/message tools are advertised to
      // the model (see `Agent.getTools`);
      // `Agent.executeToolCall` returns a clear error if they are called anyway.
      const depth = job.node.agentDepth ?? 1;
      const canSpawn = depth < 2 && job.spec.write;
      const canSpawnReadOnly = depth < 2 && !job.spec.write;
      sub.setCanSpawn(canSpawn);
      sub.setCanSpawnReadOnly(canSpawnReadOnly);
      if (canSpawn || canSpawnReadOnly) {
        sub.setSpawnHandler((args2, sig2) => this.handleSubAgentSpawn(job.node, args2, sig2));
        // Resume of its own children. The provider's sub-agent path enforces
        // least privilege: target must be a direct child, and its write
        // permission is capped by the caller's.
        sub.setSendMessageHandler((args2, sig2) => this.handleSubAgentSendMessage(job.node, args2, sig2));
      }
      const system = Agent.subAgentSystemPrompt(cardDisplayName(subCard), subEffort, depth, job.spec.write);
      // Lean system prompt (not the full main prompt/AGENTS.md) + dispatched note.
      // On a resume, prepend the stored conversation so the follow-up continues
      // where the sub-agent left off.
      sub.setMessages(
        job.resume
          ? Agent.sanitizeMessages([{ role: 'system', content: system }, ...(job.node.messages ?? [])])
          : [{ role: 'system', content: system }],
      );
      job.node.agentStatus = 'running';
      job.node.status = 'running';
      if (job.resume) {
        // The follow-up becomes a new user card in this sub-agent's transcript.
        job.node.displayItems.push({ kind: 'user', text: job.spec.instruction });
      }
      this.runningSubAgents.set(job.node.id, { agent: sub, abort, settled });
      // `model` is the card id (what the stored node and the transcripts carry);
      // `modelName` is the display form the card's caption prefers.
      this.post({
        type: 'agentStart',
        id: job.node.id,
        depth,
        model: subCard.id,
        modelName: cardDisplayName(subCard),
        write: job.spec.write,
        // The chip's origin: this run's own start, not the card's creation (a task
        // queued behind the sub-agent pool has not started running yet).
        startedAt,
      });
      void sub.sendUserMessage(job.spec.instruction);
    });
  }

  /**
   * Deliver one batch of finished sub-agents to their **parent node** as a single
   * completion signal (D2: one message, one block per signal).
   *
   * The parent may be the main agent's turn, or another sub-agent. Both are handled
   * the same way now:
   *  - parent still running → the signal waits and is injected at its next tool
   *    boundary (`takeSignalsFor`), so a sub-agent hears about its depth-2 children
   *    mid-turn exactly like the main agent does (D3);
   *  - parent already finished → resume it with the notification (a sub-agent's own
   *    conversation is a separate history, so it cannot be "injected" into a turn
   *    that no longer exists).
   */
  private queueSubAgentSignal(
    parent: TreeNode,
    results: SubAgentBatchEntry[],
    cardText?: string,
    elapsedMs?: number,
  ): void {
    const signal = this.buildSubAgentSignal(parent, results, cardText, elapsedMs);
    if (parent.kind === 'agent' && !this.isNodeLive(parent.id)) {
      // A finished sub-agent parent cannot receive an injected turn on its own
      // node (its history is not in the API path), so resume it with the text.
      const abort = new AbortController();
      void this.runSubAgent(
        { node: parent, spec: { instruction: signal.text, write: parent.agentWrite ?? false, model: undefined }, resume: true, sessionId: this.sessionId },
        abort.signal,
      );
      return;
    }
    this.pushSignal(signal);
  }

  /** The one-notice-per-batch signal both delivery paths share (D2). */
  private buildSubAgentSignal(
    parent: TreeNode,
    results: SubAgentBatchEntry[],
    cardText?: string,
    elapsedMs?: number,
  ): SignalNotice {
    // Each line carries that sub-agent's own run time; the batch's wall clock (when
    // the caller measured it) is what the status line names, because in parallel mode
    // the runs overlap and only the batch length is a fact about the whole request.
    const lines = results.map((r) => {
      const took = typeof r.durationMs === 'number' ? ` in ${formatDuration(r.durationMs)}` : '';
      return `Sub-agent #${r.node.id.slice(-6)} ${r.ok ? 'finished' : 'failed'}${took}: ${r.summary || '(no summary)'}${this.transcriptNote(r.node)}`;
    });
    const body = cardText ?? lines.join('\n');
    const batchTime = typeof elapsedMs === 'number' ? ` (${formatDuration(elapsedMs)})` : '';
    // A batch the user stopped with Stop did not "finish": say what actually happened,
    // because this block is what the next request's context carries.
    const stopped = this.isStoppedLine(parent.id);
    const doneText = stopped
      ? `${results.length} sub-agent(s) stopped by Stop${batchTime}`
      : `${results.length} sub-agent(s) finished${batchTime}`;
    return {
      nodeId: parent.id,
      kind: 'subagent',
      sourceNodeIds: results.map((r) => r.node.id),
      text: `[Sub-agent batch] ${doneText}\n${body}`,
      card: {
        kind: 'subagent',
        id: `sub-${parent.id}`,
        name: stopped ? 'Sub-agents stopped' : 'Sub-agents finished',
        doneText,
        content: body,
      },
    };
  }

  /** True when this node has a live run (its turn would take signals mid-turn). */
  private isNodeLive(nodeId: string): boolean {
    if (this.runs.has(nodeId)) {
      return true;
    }
    return this.runningSubAgents.has(nodeId);
  }

  /** Route a sub-agent's events to its own node (streaming carries a nodeId). */
  private handleSubAgentEvent(node: TreeNode, event: AgentEvent, finish: (status: 'done' | 'killed' | 'error', summary: string) => void): void {
    const id = node.id;
    const items = node.displayItems;
    switch (event.type) {
      case 'streamDelta':
        this.commitSubText(items, event.content);
        this.post({ type: 'delta', text: event.content, nodeId: id });
        break;
      case 'reasoningDelta':
        this.commitSubThinking(items, event.content);
        this.post({ type: 'thinkingDelta', text: event.content, nodeId: id });
        break;
      case 'toolStart':
        this.commitSubTool(items, event.id, event.name, event.args, event.startedAt);
        this.post({ type: 'toolStart', id: event.id, name: event.name, args: clipForUi(event.args, 8 * 1024), index: event.index, nodeId: id, startedAt: event.startedAt });
        break;
      case 'toolEnd':
        this.commitSubToolResult(items, event.id, event.content, event.ms);
        this.post({ type: 'toolEnd', id: event.id, name: event.name, content: clipForUi(event.content), nodeId: id, ms: event.ms });
        break;
      case 'usage':
        this.commitSubUsage(items, event.usage);
        this.post({ type: 'usage', usage: event.usage, nodeId: id });
        break;
      case 'status':
        break;
      case 'done':
        finish('done', this.subAgentSummary(items));
        break;
      case 'interrupted':
        finish('killed', 'interrupted');
        break;
      case 'error':
        finish('error', event.message);
        break;
      default:
        break;
    }
  }

  // ---- Sub-agent displayItems commits (kept in sync with the main handler) ----
  /** Prefer the last substantial assistant answer for the sub-agent summary. */
  private subAgentSummary(items: DisplayItem[]): string {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.kind === 'assistant' && item.text && item.text.trim().length > 10) {
        return item.text.trim();
      }
    }
    const last = items[items.length - 1];
    return last && last.kind === 'assistant' && last.text ? last.text.trim() : 'done';
  }

  private commitSubText(items: DisplayItem[], text: string): void {
    const last = items[items.length - 1];
    if (last && last.kind === 'assistant' && !last.error) {
      last.text = (last.text ?? '') + text;
    } else {
      items.push({ kind: 'assistant', text });
    }
  }

  private commitSubThinking(items: DisplayItem[], text: string): void {
    const last = items[items.length - 1];
    if (last && last.kind === 'assistant' && !last.error) {
      last.thinking = (last.thinking ?? '') + text;
    } else {
      items.push({ kind: 'assistant', thinking: text });
    }
  }

  private commitSubTool(items: DisplayItem[], id: string, name: string, args: string, startedAt: number): void {
    items.push({ kind: 'tool', id, name, args: clipForUi(args, 8 * 1024), status: 'running', startedAt });
  }

  private commitSubToolResult(items: DisplayItem[], id: string, content: string, ms: number): void {
    const item = items.find((it) => it.kind === 'tool' && it.id === id);
    if (item) {
      item.status = 'done';
      item.content = clipForUi(content);
      item.ms = ms;
      item.startedAt = undefined;
    }
  }

  private commitSubUsage(items: DisplayItem[], usage: Usage): void {
    const last = items[items.length - 1];
    if (last && (last.kind === 'assistant' || last.kind === 'tool') && !last.error) {
      last.usage = usage;
    }
  }

  /** Individual kill of a running sub-agent (from the webview Kill button). */
  onKillAgent(id: string): void {
    const entry = this.runningSubAgents.get(id);
    if (!entry) {
      return;
    }
    entry.abort.abort();
    entry.agent.cancel();
  }

  /** Clean up a finished/killed sub-agent (no-op guard for stale kills). */
  private onSubAgentDone(node: TreeNode, result: { ok: boolean; summary: string }): void {
    if (node.agentStatus === 'running') {
      node.agentStatus = result.ok ? 'done' : 'killed';
      node.agentSummary = result.summary;
      this.post({ type: 'agentDone', id: node.id, status: node.agentStatus, summary: result.summary });
      this.persistTurn();
    }
  }

  /** Dump a layout diagnostic (overlapping cards + tree connections) to the log. */
  logLayoutDiagnostic(nodes: unknown, overlaps: unknown, connections: unknown, force: unknown): void {
    const out = this.host.output;
    out.appendLine(force ? '[layout] manual diagnostic:' : '[layout] overlaps detected (auto):');
    if (Array.isArray(overlaps)) {
      for (const o of overlaps) {
        if (o && typeof o === 'object') {
          const oo = o as { a?: string; b?: string; ta?: string; tb?: string; over?: number };
          out.appendLine(`[layout] OVERLAP ${oo.a}("${oo.ta}") × ${oo.b}("${oo.tb}") area=${oo.over}`);
        }
      }
    }
    if (Array.isArray(nodes)) {
      for (const n of nodes) {
        if (n && typeof n === 'object') {
          const nn = n as { id?: string; kind?: string; parent?: string; title?: string; x?: number; y?: number; w?: number; h?: number };
          out.appendLine(`[layout] NODE ${nn.id} kind=${nn.kind} parent=${nn.parent} "${nn.title}" x=${nn.x} y=${nn.y} ${nn.w}x${nn.h}`);
        }
      }
    }
    if (Array.isArray(connections)) {
      for (const c of connections) {
        if (c && typeof c === 'object') {
          const cc = c as { parent?: string; child?: string };
          out.appendLine(`[layout] EDGE ${cc.parent} -> ${cc.child}`);
        }
      }
    }
  }

  /**
   * Async mode, all sub-agents of the batch settled: push one clearly-separated
   * completion card into the parent node (like a background terminal card) and
   * deliver one combined notice so the main agent reacts a single time. All
   * still belongs to the single parent node.
   */
  /**
   * Async mode, all sub-agents of the batch settled: queue **one** completion
   * signal for the parent node (D2) instead of opening a turn right away. The
   * parent may be the main agent's turn or a depth-1 sub-agent; `queueSubAgentSignal`
   * picks between "inject at the next tool boundary / next idle moment" and
   * "resume the finished sub-agent", so a sub-agent parent is notified exactly like
   * the main agent (D3). The notification block itself is only rendered when the
   * signal is actually delivered (`takePendingSignals`), so what the UI shows and
   * what the agent knew stay in step.
   */
  private onAsyncBatchDone(
    parent: TreeNode,
    results: SubAgentBatchEntry[],
    elapsedMs?: number,
  ): void {
    if (this.isStoppedLine(parent.id)) {
      // The user's Stop killed this work: the batch's interrupt message is written
      // back into the owning turn's history instead of opening a turn — and a stopped
      // sub-agent is never resumed just because its own children settled.
      this.queueWriteback(this.buildSubAgentSignal(parent, results, undefined, elapsedMs));
      this.persistTurn();
      return;
    }
    this.queueSubAgentSignal(parent, results, undefined, elapsedMs);
    this.persistTurn();
  }

  private cleanupSubAgents(): void {
    for (const [, entry] of this.runningSubAgents) {
      entry.abort.abort();
      entry.agent.cancel();
    }
    this.runningSubAgents.clear();
  }

  /**
   * `list_nodes` tool: render this session's tree (id, status, parent, title) so
   * the agent can name a node — e.g. as `hop_session`'s `returnNodeId`. Node ids
   * otherwise live only in the persisted tree. `node` is the caller's own node
   * (P3 binds the handler per node); the rendered tree is always the whole
   * session's, exactly as before.
   */
  private handleListNodes(node: TreeNode): string {
    const session = this.session;
    const depthOf = (node: TreeNode): number => {
      let depth = 0;
      let parent = node.parentId ? session.nodes[node.parentId] : undefined;
      while (parent && depth < 64) {
        depth++;
        parent = parent.parentId ? session.nodes[parent.parentId] : undefined;
      }
      return depth;
    };
    const ordered = Object.values(session.nodes).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    const lines = ordered.map((node) => {
      const kindMark = node.kind === 'agent' ? 'agent' : node.kind === 'bg' ? 'bg' : 'turn';
      const marks = [
        kindMark,
        node.delivered ? 'delivered' : '',
        node.kind === 'agent' ? node.agentStatus ?? node.status : node.status,
      ].filter(Boolean);
      if (node.id === session.activeNodeId) {
        marks.push('checked out');
      }
      const parent = node.parentId ? ` parent=${node.parentId}` : '';
      return `${'  '.repeat(depthOf(node))}- ${node.id}  [${marks.join(', ')}]${parent}  ${node.title}`;
    });
    return [
      `session ${session.id} "${session.title}" — ${ordered.length} nodes, checked out: ${session.activeNodeId ?? '(none)'}`,
      ...lines,
    ].join('\n');
  }

  // ---- Background terminals ----

  private toBackgroundInfo(owner: BackgroundOwner, task: BackgroundTask): BackgroundInfo {
    const out = task.handle.getOutput().trim();
    const outputTail = out.length > 800 ? '…' + tailText(out, 800) : out;
    return {
      id: task.id,
      nodeId: owner.nodeId,
      // The `kind:'bg'` card that mirrors this job (null when its branch is gone).
      cardNodeId: this.bgNodes.get(task.id) ?? null,
      command: task.command,
      status: task.status,
      exitCode: task.exitCode,
      killed: task.killed,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      truncated: task.truncated,
      outputTail,
      pendingDelivery: task.status === 'finished' && !task.delivered,
    };
  }

  /** The hub calls this for a job of this session (any of its nodes). */
  refreshBackgrounds(): void {
    this.postBackgrounds();
  }

  private postBackgrounds(): void {
    // Background output can fire onUpdated many times per second. Coalesce UI
    // refreshes so a chatty process cannot freeze the webview.
    if (this.bgFlushTimer != null) {
      return;
    }
    this.bgFlushTimer = setTimeout(() => {
      this.bgFlushTimer = null;
      this.postBackgroundsNow();
    }, 200);
  }

  private postBackgroundsNow(): void {
    const t0 = Date.now();
    // One flat list for the whole session: every task tagged with its owning
    // node, so the webview renders each node's own dock (there is no panel).
    // Running jobs plus finished ones still awaiting delivery (their notice has
    // not reached the agent yet); delivered jobs drop out, so the list never
    // accumulates stale entries.
    const tasks = this.hub
      .listForSession(this.sessionId)
      .filter(({ task }) => task.status === 'running' || (task.status === 'finished' && !task.delivered))
      .map(({ owner, task }) => this.toBackgroundInfo(owner, task));
    this.post({ type: 'backgrounds', tasks });
    this.postState();
    perf(() => `backgrounds ${Date.now() - t0}ms tasks=${tasks.length}`);
  }

  /** Mark a task's completion notice as delivered so it leaves the pending dock state. */
  private markDelivered(taskId: number): void {
    const hit = this.hub.lookup(this.sessionId, taskId);
    if (hit) {
      hit.task.delivered = true;
    }
  }

  /**
   * While an external controller holds the window (a reload is due), no turn may
   * start — `/reload-window` refuses while one does. A drain that finds itself
   * held retries later instead of spinning its 75 ms timer. Returns true when the
   * caller must back off.
   */
  private heldBackoff(reschedule: () => void): boolean {
    if (!this.host.isHeld()) {
      return false;
    }
    setTimeout(reschedule, 500);
    return true;
  }

  // ---- Completion signals (background terminals + async sub-agents) ----

  /**
   * Called by the hub when a job of this session is registered: create the flying
   * node that mirrors it — a `kind:'bg'` sidecar beside the owning turn, in the same
   * right-hand grid the sub-agents use. The card is created here (not by the
   * webview) so the tree stays the single source of truth: it is laid out, sized,
   * persisted and deleted like any other node.
   */
  onBackgroundRegistered(owner: BackgroundOwner, task: BackgroundTask): void {
    if (this.dead) {
      return;
    }
    const parent = this.session.nodes[owner.nodeId];
    if (!parent) {
      return;
    }
    // `attachNode` checks the new node out; a job started by a turn must never move
    // the view focus (same trick as `spawnChildren` for sub-agent cards).
    const prevActive = this.session.activeNodeId;
    const node = createNode(newId(), parent.id, this.truncateField(task.command, 60), 'running');
    node.kind = 'bg';
    node.bgTaskId = task.id;
    node.bgCommand = task.command;
    attachNode(this.session, node);
    this.session.activeNodeId = prevActive;
    this.bgNodes.set(task.id, node.id);
    this.persistTurn();
    this.postTree();
    this.postBackgrounds();
  }

  /**
   * Called by the hub when a job of this session ends (naturally or via kill).
   * First snapshot its terminal state onto the card — the hub is in-memory, the
   * card must outlive it — then queue the completion signal. `scheduleSignalDrain`
   * delivers it at the owning turn's next tool boundary, or as an injected turn on
   * that same node when it is idle.
   */
  onBackgroundFinished(owner: BackgroundOwner, task: BackgroundTask): void {
    if (this.dead) {
      return;
    }
    this.snapshotBackgroundCard(task);
    if (task.detached === true) {
      // **The detached branch of the completion notice.** This function is the one
      // seam where the hub's `onFinish` becomes a notice, and a detached job leaves it
      // without ever building a `SignalNotice`: nothing is queued for a tool boundary
      // (`takeSignalsFor`), nothing is injected into an idle owner (`drainSignals`) and
      // nothing is written back — the agent is *never* told, because a fire-and-forget
      // job was never the agent's to wait for. It asks instead:
      // `check_background_terminal`.
      //
      // The **card** still settles, exactly as it does for a tool-initiated kill (which
      // is the other ending no notice follows): the terminal state has just gone onto
      // the node (`bgExitCode`, `bgKilled`, `bgElapsedMs`, `bgOutputTail`), `delivered`
      // flips so the card never claims a delivery that can never come, and the snapshot
      // is repainted for the new status line.
      //
      // Explicit even though `BackgroundRegistry.register` already forces
      // `notifyAgent: false` for a detached task: the rule belongs to the side that
      // *delivers* notices, so it holds for any task that carries the flag.
      task.delivered = true;
      this.settleSignals([this.staleSignalFor(task)]);
      this.postBackgrounds();
      return;
    }
    if (task.notifyAgent !== true) {
      // A tool-initiated kill/join already informed the agent through the tool
      // result, so this signal is never sent: settle the card instead (D1).
      task.delivered = true;
      this.settleSignals([this.staleSignalFor(task)]);
      this.postBackgrounds();
      return;
    }
    this.pushSignal(this.buildBackgroundSignal(owner, task));
  }

  /** Write a job's terminal state onto its card so it survives a restart (D1). */
  private snapshotBackgroundCard(task: BackgroundTask): void {
    const node = this.bgCardFor(task.id);
    if (!node) {
      return;
    }
    const out = task.handle.getOutput().trim();
    node.bgCommand = task.command;
    node.bgExitCode = task.exitCode;
    node.bgKilled = task.killed === true;
    // The card's own frozen duration (the hub is in-memory, so this is what a
    // restored record card shows); `finishedAt` is exact, `Date.now()` is only the
    // fallback for a task that somehow finished without going through `complete()`.
    node.bgElapsedMs = Math.max(0, (task.finishedAt ?? Date.now()) - task.startedAt);
    node.bgOutputTail = out.length > 800 ? `…${tailText(out, 800)}` : out;
    node.status = task.killed ? 'interrupted' : 'done';
    this.persistTurn();
    this.postTree();
  }

  /** The `kind:'bg'` node mirroring a task (undefined when its branch is gone). */
  private bgCardFor(taskId: number): TreeNode | undefined {
    const nodeId = this.bgNodes.get(taskId);
    return nodeId ? this.session.nodes[nodeId] : undefined;
  }

  /**
   * True when the job behind a `kind:'bg'` card is still known to the hub and is
   * **detached** — the one thing `treeMessage` needs to know to badge that card
   * `shared`. It is a read of the live task, deliberately not a node field: the hub is
   * in-memory, so a card restored after a reload has no task left to ask, and the
   * record it renders then must not invent a lock/notice story it can no longer verify.
   */
  private backgroundTaskDetached(taskId: number | undefined): boolean {
    if (taskId == null) {
      return false;
    }
    return this.hub.lookup(this.sessionId, taskId)?.task.detached === true;
  }

  /** A signal carrying only the card it settles: used when no notice will be sent. */
  private staleSignalFor(task: BackgroundTask): SignalNotice {
    const card = this.bgCardFor(task.id);
    return {
      nodeId: card?.parentId ?? '',
      kind: 'background',
      sourceNodeIds: card ? [card.id] : [],
      taskId: task.id,
      text: '',
      card: { kind: 'background', id: task.id, name: task.command, doneText: '', content: '' },
    };
  }

  private buildBackgroundSignal(owner: BackgroundOwner, task: BackgroundTask): SignalNotice {
    const cmd = this.truncateField(task.command, 100);
    // How long the job ran. `finishedAt` is set by the registry's `complete()`, which
    // every ending goes through (natural exit, kill, session teardown).
    const took = formatDuration((task.finishedAt ?? Date.now()) - task.startedAt);
    // A job the **budget** ended is not the same news as one the user killed: the
    // command was promoted to the background to keep the turn within
    // `spinney.commandMaxForegroundDuration`, so what the reader has to learn is that
    // the budget it was given ran out — not that somebody stopped its work. The
    // verdict replaces the whole clause (which is why the sentence is assembled from
    // `verdict` below rather than from `outcome` + `after …`): "was killed after 30m 0s
    // — its 30m 0s budget ran out after 30m 0s" would say the same thing three times.
    const budgetKilled = isBudgetKill(task);
    const verdict = budgetKilled
      ? `was killed after ${took} — its ${formatDuration(commandMaxForegroundDurationSec() * 1000)} budget ran out`
      : task.killed
        ? `was killed by the user after ${took}`
        : `finished with exit code ${task.exitCode ?? 'unknown'} after ${took}`;
    const output = this.truncateField(task.handle.getOutput().trim(), 1200);
    const text = `Background command \`${cmd}\` (id ${task.id}) ${verdict}.${output ? `\nOutput:\n${output}` : ''}`;
    // The card's status text is the compact token form shown next to the `#id` — not
    // the English sentence above, which belongs to the agent. The webview renders this
    // verbatim (it never re-translates a payload the host built), so it stays
    // locale-free.
    const doneText = task.killed ? `killed (${took})` : `exit ${task.exitCode ?? '?'} (${took})`;
    const card = this.bgCardFor(task.id);
    return {
      nodeId: owner.nodeId,
      kind: 'background',
      sourceNodeIds: card ? [card.id] : [],
      taskId: task.id,
      text,
      card: { kind: 'background', id: task.id, name: cmd, doneText, content: output },
    };
  }

  private truncateField(value: string, limit: number): string {
    return clipText(value, limit);
  }

  /** Queue one signal under the node that owns the work and schedule delivery. */
  private pushSignal(signal: SignalNotice): void {
    // Work that finishes on a line the user already union-killed must not open a turn
    // either — it is written back and travels with the next request.
    if (this.isStoppedLine(signal.nodeId)) {
      this.queueWriteback(signal);
      return;
    }
    const queue = this.signals.get(signal.nodeId);
    if (queue) {
      queue.push(signal);
    } else {
      this.signals.set(signal.nodeId, [signal]);
    }
    this.scheduleSignalDrain();
  }

  /**
   * Coalesce delivery so a burst of finishes becomes one message (and, when the
   * owner node is idle, one injected turn) instead of one per job.
   */
  private scheduleSignalDrain(delay = 75): void {
    if (this.signalDrainTimer != null) {
      return;
    }
    this.signalDrainTimer = setTimeout(() => {
      this.signalDrainTimer = null;
      this.drainSignals();
    }, delay);
  }

  /**
   * The agent hook (`Agent.setSignalHandler`): hand this node's queued signals to
   * its **running** turn, which injects them as one `user` message at its next tool
   * boundary. Called at most once per assistant tool round; must not throw.
   */
  private takeSignalsFor(node: TreeNode): string[] {
    if (this.dead) {
      return [];
    }
    const queue = this.signals.get(node.id);
    if (!queue || queue.length === 0) {
      return [];
    }
    if (this.host.isHeld()) {
      // A reload is waiting for this window to go idle: do not extend the turn with
      // new work. The idle drain picks the signals up after the hold expires.
      return [];
    }
    const batch = this.takePendingSignals(node.id);
    if (batch.length === 0) {
      return [];
    }
    this.renderSignalCards(node.id, batch);
    return [combineSignalText(batch)];
  }

  /**
   * Deliver every queued signal whose owning node can receive it right now.
   *
   * A live node keeps its signals for the agent hook (they belong mid-turn, at the
   * next tool boundary). An idle node gets an **injected turn on itself** — never a
   * new node under it, never the view focus — or, for a sub-agent node, a resume
   * (its history is not the session path, so `beginInjectedTurn` would rebase it on
   * its parent's messages).
   */
  drainSignals(): void {
    if (this.dead) {
      return;
    }
    if (this.heldBackoff(() => this.scheduleSignalDrain(500))) {
      return;
    }
    // Union-kill notices are handled by their own flush (they never open a turn, but
    // they must land before the next request is built).
    this.flushWritebacks();
    let retry = false;
    for (const nodeId of [...this.signals.keys()]) {
      const node = this.session.nodes[nodeId];
      if (!node) {
        // The owning branch was deleted: nothing may own the signal any more.
        this.settleSignals(this.takePendingSignals(nodeId, { settleStale: false }));
        this.signals.delete(nodeId);
        continue;
      }
      if (this.isNodeLive(nodeId)) {
        // Its turn is streaming: the tool-boundary hook owns the delivery.
        continue;
      }
      if (this.nodeWorkers.get(nodeId)?.agent.running) {
        // The turn's `finally` has not reset `isRunning` yet — sending now would be
        // dropped silently. Retry a tick later.
        retry = true;
        continue;
      }
      const batch = this.takePendingSignals(nodeId);
      if (batch.length === 0) {
        continue;
      }
      if (node.kind === 'agent') {
        const abort = new AbortController();
        void this.runSubAgent(
          {
            node,
            spec: { instruction: combineSignalText(batch), write: node.agentWrite ?? false, model: undefined },
            resume: true,
            sessionId: this.sessionId,
          },
          abort.signal,
        );
        this.renderSignalCards(nodeId, batch);
        continue;
      }
      // Same node, `fresh: false`: the notice and the reply are appended to the turn
      // that spawned the job, and the view focus does not move.
      const run = this.beginInjectedTurn(node);
      if (!run) {
        // Held (a reload is due) or that node already has a live run: keep them.
        this.pushBackSignals(nodeId, batch);
        retry = true;
        continue;
      }
      this.renderSignalCards(nodeId, batch);
      this.lastStatus = batch.some((s) => s.kind === 'subagent')
        ? vscode.l10n.t('Sub-agents finished')
        : vscode.l10n.t('Background terminal finished');
      this.setBusy(true);
      this.post({ type: 'status', text: this.lastStatus });
      // Re-affirm the view in the webview BEFORE the turn streams: a nested sub-agent
      // spawn may have left the webview pinned to a sub-agent card, and this injected
      // turn has no `path`/`tree` round-trip of its own. postPath follows the view
      // focus, so the reply cannot leak into a sub-agent card.
      this.postPath();
      run.agent.sendUserMessage(combineSignalText(batch));
    }
    if (retry) {
      this.scheduleSignalDrain(75);
    }
  }

  /** Pull this node's deliverable signals out of the queue (drops stale ones). */
  private takePendingSignals(nodeId: string, opts?: { settleStale?: boolean }): SignalNotice[] {
    const queue = this.signals.get(nodeId);
    if (!queue || queue.length === 0) {
      return [];
    }
    const batch: SignalNotice[] = [];
    const stale: SignalNotice[] = [];
    for (const signal of queue.splice(0)) {
      if (this.signalStale(signal)) {
        stale.push(signal);
      } else {
        batch.push(signal);
      }
    }
    if (queue.length === 0) {
      this.signals.delete(nodeId);
    }
    if (stale.length > 0 && opts?.settleStale !== false) {
      this.settleSignals(stale);
    }
    return batch;
  }

  /** Put a batch back at the front of its queue (delivery was not possible). */
  private pushBackSignals(nodeId: string, batch: SignalNotice[]): void {
    const queue = this.signals.get(nodeId);
    if (queue) {
      queue.unshift(...batch);
    } else {
      this.signals.set(nodeId, [...batch]);
    }
  }

  /**
   * True when a queued signal must not be delivered: the task was joined or killed
   * through a tool (its result is the signal), it no longer exists (cleared), or the
   * node that owns it is gone (its branch was deleted).
   */
  private signalStale(signal: SignalNotice): boolean {
    if (!this.session.nodes[signal.nodeId]) {
      return true;
    }
    if (signal.taskId == null) {
      return false;
    }
    const hit = this.hub.lookup(this.sessionId, signal.taskId);
    return !hit || hit.task.notifyAgent !== true;
  }

  /**
   * Render one notification block per signal inside the owning node's card. The
   * block is part of that node's own transcript (`DisplayItem.kind: 'background'`),
   * so a reload re-renders it, and it is deliberately **not** a `kind:'user'` item:
   * replaying one of those would be skipped, or would clobber the pinned prompt.
   */
  private renderSignalCards(nodeId: string, batch: SignalNotice[]): void {
    const node = this.session.nodes[nodeId];
    for (const signal of batch) {
      if (signal.taskId != null) {
        this.markDelivered(signal.taskId);
      }
      if (node) {
        node.displayItems.push({
          kind: 'background',
          id: String(signal.card.id),
          name: signal.card.name,
          doneText: signal.card.doneText,
          content: signal.card.content,
        });
      }
      this.post({ type: 'backgroundNotice', nodeId, item: signal.card });
    }
    this.settleSignals(batch);
    this.persistTurn();
    if (node) {
      this.post({ type: 'nodeUpdate', ...this.nodeStatePatch(node) });
    }
  }

  /** Flip the source cards of a batch to `Delivered` and repaint them once (D1). */
  private settleSignals(batch: SignalNotice[]): void {
    let touched = false;
    for (const signal of batch) {
      for (const id of signal.sourceNodeIds ?? []) {
        const card = this.session.nodes[id];
        if (card && !card.delivered) {
          card.delivered = true;
          touched = true;
        }
      }
    }
    if (touched) {
      this.persistTurn();
      this.postTree();
    }
  }

  /** Kill a background terminal from the UI (a job card's kill button). */

  onKillBackground(id: number): void {
    const hit = this.hub.lookup(this.sessionId, id);
    if (!hit) {
      return;
    }
    if (hit.task.status !== 'running') {
      this.postNotice('info', vscode.l10n.t('Background terminal {0} is not running.', id));
      return;
    }
    // User-initiated kill: notify the agent (queue if busy, deliver if idle).
    this.hub.registryFor(hit.owner).kill(id, { notifyAgent: true });
    this.postBackgrounds();
  }

  // ---- Bulk mutations owned by the coordinator ----

  /**
   * Clear the conversation (the `clear` command / webview button): keep the
   * session's identity but drop the whole tree, every node worker (and its agent
   * history), the queued notices and the background-terminal history. The
   * provider removes the transcript dumps and resets the automatic-title
   * bookkeeping.
   */
  clearConversation(): void {
    // P3: the tree goes, so every node worker (and its agent) goes with it.
    this.nodeWorkers.clear();
    this.interruptedNodes.clear();
    for (const run of this.runs.values()) {
      if (run.flushTimer != null) {
        clearTimeout(run.flushTimer);
        run.flushTimer = null;
      }
    }
    this.runs.clear();
    this.uploadController = null;
    // A pending pick belonged to a node of the tree that is about to go.
    this.pending = null;
    const session = this.session;
    // A cleared conversation keeps its identity but loses the whole tree.
    session.nodes = {};
    session.rootIds = [];
    session.activeNodeId = null;
    session.orphanItems.length = 0;
    session.updatedAt = Date.now();
    // A cleared conversation drops its background jobs too: the provider asks
    // for a confirmation first, so anything still running here is killed here.
    this.hub.removeSession(this.sessionId, { kill: true });
    this.signals.clear();
    this.bgNodes.clear();
    if (this.signalDrainTimer != null) {
      clearTimeout(this.signalDrainTimer);
      this.signalDrainTimer = null;
    }
    this.setBusy(false);
    this.lastStatus = '';
    this.currentPromptTokens = 0;
    this.post({ type: 'reset' });
    this.postBackgrounds();
    this.postContext();
    this.postSessionStats();
    this.postTree();
  }

  /**
   * Apply a confirmed branch deletion to this session: drop anything the removed
   * nodes still queued (the pending interruption notice, completion signals),
   * re-check out the surviving view focus and repaint. The provider does the tree
   * surgery, the transcript dumps and the persistence.
   */
  afterBranchDetach(ids: string[]): void {
    // Drop the removed nodes' workers and any pending interruption notice they
    // held: their branches no longer exist.
    for (const id of ids) {
      this.interruptedNodes.delete(id);
      this.nodeWorkers.delete(id);
    }
    // Completion signals queued for a removed node can never be delivered (its
    // branch is gone). Their source cards go with the branch anyway.
    for (const id of ids) {
      this.signals.delete(id);
    }
    // Background jobs are owned by nodes: dropping a branch kills the jobs it
    // spawned (the provider confirmed that with the user) and forgets their cards.
    for (const id of ids) {
      this.hub.removeNode(this.sessionId, id, { kill: true });
      const node = this.session.nodes[id];
      if (node?.kind === 'bg' && node.bgTaskId != null) {
        this.bgNodes.delete(node.bgTaskId);
      }
    }
    for (const [taskId, nodeId] of [...this.bgNodes]) {
      if (!this.session.nodes[nodeId]) {
        this.bgNodes.delete(taskId);
      }
    }
    this.postBackgrounds();
    this.checkoutNode(this.session, this.session.activeNodeId);
    this.currentPromptTokens = this.getLatestPromptTokens();
    this.postTree();
    this.postPath();
    if (this.session.activeNodeId) {
      this.post({ type: 'panTo', id: this.session.activeNodeId });
    }
    this.postContext();
    this.postSessionStats();
  }
}
