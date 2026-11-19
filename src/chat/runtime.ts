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
 * handler, sub-agent and session hooks all close over that node) plus its own
 * `ToolRegistry` (whose background owner is that node) — see
 * `docs/agents/multi-session.md` §2.3. A run is keyed by its node, so a new turn
 * is refused only when the node it would continue from is itself streaming, and
 * the interruption notice is bookkept per node so concurrent branches cannot
 * clobber each other.
 *
 * The runtime reaches the provider through the narrow `RuntimeHost` interface
 * (transcripts, config, persistence, panel routing, the session surface).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Agent, ImageAccounting } from '../agent/agent';
import { DEFAULT_REPLY_LANGUAGE, SYSTEM_PROMPT_TEMPLATE, AgentsMdSources, COMPRESS_SYSTEM_PROMPT_TEMPLATE, agentsMdSection, compressSystemPrompt, systemPrompt } from '../agent/prompt';
import { Balance, emptyBalance } from '../agent/balance';
import { buildChatRequestBody, chatCompletionsUrl } from '../agent/apiClient';
import { ClientRegistry } from '../agent/clients';
import {
  AgentEvent,
  ChatMessage,
  ContentPart,
  ThinkingEffort,
  ToolDefinition,
  Usage,
  detectImageMime,
  withToolTitleLanguage,
} from '../agent/types';
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
// The **handoff** of a context window: the pure half of the rollover contract
// (`docs/agents/invariants/context-rollover.md` §6, `docs/agents/invariants/compress-node.md`) —
// the input selection and its bound, the pointer text, the compression instruction, the
// heading validation and the fallback decision.
import {
  CompactionSource,
  KilledAgentLine,
  KilledJobLine,
  buildCompressInstruction,
  buildContextRolloverMessage,
  classifyCompactionAnswer,
  compactionDiagLine,
  editedFilesFromItems,
  extractCompactionSource,
  firstUserRequest,
  missingCompactionSections,
} from '../agent/compaction';
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
  hasHandoff,
  isSidecar,
  isCompressNode,
  messageText,
  newId,
  nodeCacheRate,
  nodeUsage,
  nodeUsageTotal,
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
import { clipText, sliceText, tailText, wellFormedDeep } from '../text';

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

/**
 * The model's own one-line label for a step: `exec_command`'s required `title`
 * argument (`TOOL_TITLE_DESCRIPTION` in `agent/types.ts`) — the one tool schema
 * that carries it. It is read out of
 * the call's arguments **here**, on the host, and stored on the `DisplayItem` — so
 * the card's step row keeps it even though the display copy of `args` is clipped to
 * 8 KiB and the row may be rebuilt from a repaint or a reload. Whitespace is
 * collapsed to one line and the label is capped at the length the schema promises,
 * because a model that ignores "at most about 60 characters" must not be able to push a
 * paragraph into a one-line row. Anything unparsable, absent or blank yields
 * `undefined`, and the webview then falls back to its own `toolBrief()`.
 */
export function toolTitleFromArgs(args: unknown): string | undefined {
  if (typeof args !== 'string' || !args) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = (JSON.parse(args) as { title?: unknown }).title;
  } catch {
    return undefined;
  }
  if (typeof raw !== 'string') {
    return undefined;
  }
  const label = raw.replace(/\s+/g, ' ').trim();
  return label ? sliceText(label, TOOL_TITLE_MAX) : undefined;
}

/** The longest one-line step label the UI shows (the schema asks for ~60). */
const TOOL_TITLE_MAX = 60;

/**
 * The line diff a file-modifying tool appended to its result (` (+12 -3)`, from
 * `lineDiffSuffix` in `src/tools/index.ts`), taken back off it.
 *
 * The numbers go onto the `DisplayItem` and the card draws them as one chip, so a
 * repaint shows the same chip without re-reading the file; the text the card keeps is the
 * tool's own sentence without the marker, because the marker is for the chip. A result
 * with no marker — any tool that changes nothing, and every tool that is not a file
 * writer — yields no diff and no chip.
 */
function takeLineDiff(content: string): { content: string; diff?: { add: number; del: number } } {
  const match = / \(\+(\d+) -(\d+)\)$/.exec(content);
  if (!match) return { content };
  return {
    content: content.slice(0, match.index),
    diff: { add: Number(match[1]), del: Number(match[2]) },
  };
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
 * How long a rollover waits for the sub-agents its union kill aborted (their finish
 * handler writes the dump the message points at). Long enough for a `persistNow` and a
 * JSONL write, short enough that a stuck job cannot hold the button.
 */
const ROLLOVER_SETTLE_TIMEOUT_MS = 2000;

/**
 * The tools a **compression node** may use: reading a file, listing a directory, searching
 * the workspace, searching the transcript dumps. Nothing else — a compression turn that
 * could write would change the workspace from inside a window nobody is watching.
 */
const COMPRESS_READONLY_TOOLS = ['read_file', 'list_dir', 'search_files', 'search_transcripts'];

/**
 * The tools a compression node's registry **denies** even though the registry it is built
 * from holds them. `subset` already keeps them out of the advertised set; blocking them is
 * defence in depth, so a hallucinated call lands on an explicit denial instead of an
 * "unknown tool" answer (`ToolRegistry.withBlocked`).
 */
const COMPRESS_BLOCKED_TOOLS = [
  'write_file',
  'append_file',
  'replace_in_file',
  'exec_command',
  'check_command',
  'wait_for_command',
  'kill_command',
];

/**
 * Fallback when `spinney.subAgentSyncSeconds` is absent or not a positive number: the
 * 5 minutes the setting ships with.
 */
const DEFAULT_SUB_AGENT_SYNC_SEC = 300;

/**
 * How long a `spawn_agents` / `send_agent_message` call in `sync` mode may hold the
 * turn — `spinney.subAgentSyncSeconds` in seconds, read live so an edited setting
 * applies to the next call without a reload. A batch still running when that window
 * runs out stops holding the turn: the tool returns the ids and the summaries arrive
 * later as one completion notice.
 *
 * This is the **sub-agent** half of the turn, and it is deliberately its own setting:
 * a command's foreground slice (`spinney.execForegroundSeconds`) is about one process
 * and hands over to a background job, while this one is about a batch of conversations
 * and hands over to a batch notice. Keeping them apart means tuning one never silently
 * moves the other.
 */
function subAgentSyncSeconds(): number {
  const configured = vscode.workspace.getConfiguration('spinney').get<number>('subAgentSyncSeconds');
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_SUB_AGENT_SYNC_SEC;
}

/** Fallback when `spinney.sessionMaxRounds` is absent or not a positive number. */
const DEFAULT_SESSION_MAX_ROUNDS = 16;

/**
 * The ceiling of one inter-session exchange — `spinney.sessionMaxRounds`, read live.
 * The caller declares `max_rounds` per send (that is legibility); this number is the
 * brake, because a model under pressure simply declares the ceiling. Only unattended
 * agent-to-agent work is counted: a human message starts a fresh allowance.
 */
export function sessionMaxRounds(): number {
  const configured = vscode.workspace.getConfiguration('spinney').get<number>('sessionMaxRounds');
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_SESSION_MAX_ROUNDS;
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
 * A promise plus the one call that settles it — a run's {@link TurnRun.settled} pair.
 * The resolver is idempotent (`Promise` resolution is), so a `finishTurn` and a
 * `dispose` both calling it is harmless.
 */
function settlePair(): { settled: Promise<void>; resolveSettled: () => void } {
  let resolveSettled: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  return { settled, resolveSettled };
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
  /**
   * The BCP-47 tag of {@link replyLanguage}, resolved from the same setting by the
   * same call (`replyLanguageTag`), or `''` for a free-form language name. The pair
   * travels together: the tag names the language inside `exec_command`'s title
   * description, so the step row is written in the language the user reads.
   */
  replyLanguageTag: string;
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
  /**
   * `spinney.streamAnimation`: may the webview animate how text and rows appear (a
   * fading chunk of new characters, a new row's fade + rise, a live tool label's
   * fade)? It is a **paint-only** flag — the text is in the DOM either way, and the
   * transcript, the markdown render and the streaming path are identical when it is
   * off. It is read live into every `config` post, so a settings change reaches the
   * open tab without a reload, and the webview also honours the OS' own
   * reduced-motion wish on top of it.
   */
  streamAnimation: boolean;
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

/**
 * The output tail every background snapshot carries: the job's output so far, trimmed
 * and clipped to its newest 800 characters (with a leading ellipsis when it was cut).
 *
 * One function, because the `backgrounds` snapshot (a session's jobs) and the
 * `backgroundsGlobal` snapshot (the window-global dock) describe the same job and must
 * not disagree about what its tail is.
 */
export function backgroundOutputTail(task: BackgroundTask): string {
  const out = task.handle.getOutput().trim();
  return out.length > 800 ? '…' + tailText(out, 800) : out;
}

/** What produced a signal: drives the notification block's badge, nothing else. */
export type SignalKind = 'background' | 'subagent';

/**
 * One message for a batch of signals (D2): a single `user` message per delivery, so
 * a burst of finishes costs the model one round of context, not N.
 *
 * This queue carries **completion notices** only: work the node itself started.
 * An inter-session prompt never rides it — it is a turn of its own
 * (`send_session_prompt`), because the rules for "your job finished" and "someone
 * is talking to you" are opposite ones (`docs/agents/plans/session-prompt-addressing.md` §3).
 */
function combineSignalText(batch: SignalNotice[]): string {
  if (batch.length === 1) {
    return batch[0].text;
  }
  const background = batch.filter((s) => s.kind === 'background').length;
  const subagents = batch.filter((s) => s.kind === 'subagent').length;
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
export interface SignalNotice {
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
  /**
   * When this run started, in epoch ms. A refusal that says "busy for 1m 12s" and an
   * interrupt report both quote it, so the number a sender reads is the run's own.
   */
  startedAt: number;
  pendingText: string;
  pendingThinking: string;
  /**
   * The tool calls of this flush window, by the call's index: its id and the pieces of its
   * **name** that have arrived. The arguments are deliberately not accumulated here — the
   * webview draws a call that is still being written as one fixed line, and the settled
   * arguments travel with `toolStart` instead (`flushStreamDeltas`).
   */
  pendingTools: Map<number, { id?: string; name: string }>;
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
  /**
   * Resolves when {@link finishTurn} closed this run — the one fact an orchestrator needs.
   *
   * `compressHandoff` starts a compression turn and must wait for its **real** end before it
   * can read the answer and store it on the card as the handoff; a timer would race the model,
   * and the agent's own events are delivered into a handler that knows nothing about a caller.
   * `finishTurn` resolves it exactly once, whatever the turn's status (done / interrupted /
   * error), so a Stop is a normal outcome here — the card simply stays not-ready.
   */
  settled: Promise<void>;
  /** The resolver behind {@link settled}; called once, by `finishTurn` (or `dispose`). */
  resolveSettled: () => void;
}

/**
 * The provider surface the runtime may use. Kept deliberately narrow: anything
 * about sessions-on-disk, tabs, titles, transcripts, config or the session
 * surface stays on the provider.
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
  /**
   * A background terminal of **this** session changed (a job registered, printed,
   * finished, was killed or was settled). The session's own card repaint is already on
   * its way (`postBackgrounds`); this is the other half — the window-global terminal
   * dock lists every session's jobs in **every** tab, so one session's change is every
   * tab's news. The provider coalesces it, exactly like the per-session snapshot.
   */
  backgroundsChanged(): void;
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
  /**
   * `create_session`: start a fresh session whose first turn is `session_initial_prompt`,
   * titled with the explicit (locking) `session_name`, and return without waiting.
   * The provider owns the session list, the tab and the persistence, so the whole
   * creation is its answer — this runtime only passes its own node along, because
   * the result tells the caller where a report should come back to. `rounds` is what
   * this runtime's own exchange allowance leaves for that first line: it is an
   * agent-written user message like any prompt, so it never starts with a fresh ceiling.
   */
  handleCreateSession(
    rt: SessionRuntime,
    node: TreeNode,
    args: Record<string, unknown>,
    rounds?: number,
  ): Promise<string>;
  /**
   * `send_session_prompt`: start one turn in a session, addressed only by its id. The
   * provider owns every session's live state, so its answer is the busy refusal; the
   * caller's runtime resolves the allowance (`max_rounds`) and names itself as `from`.
   */
  handleSendSessionPrompt(
    args: Record<string, unknown>,
    callerSessionId: string,
    roundsLeft: number,
    from: { sessionId: string; nodeId: string },
  ): Promise<string>;
  /**
   * `wait_for_session_idle`: resolve as soon as that session can take a prompt, or when
   * the caller's window runs out — a slice, not a timeout, so the caller can act on
   * "still busy" instead of reading a failure.
   */
  handleWaitForSessionIdle(
    args: Record<string, unknown>,
    callerSessionId: string,
    signal: AbortSignal,
  ): Promise<string>;
  /**
   * `interrupt_session`: end the work this caller's prompts started in that session, and
   * nothing else. The scope is provenance, so a line a human started is never in it.
   */
  handleInterruptSession(args: Record<string, unknown>, callerSessionId: string): Promise<string>;
  /** `list_sessions`: the window's sessions, rendered one line each. */
  handleListSessions(args: Record<string, unknown>): string;
  /**
   * The node ids of **any** session that have a live run right now. `list_nodes`
   * may name another session, and only the provider holds that session's runtime.
   */
  runningNodesIn(sessionId: string): string[];
  /**
   * The node ids of **any** session that are not streaming but still own unfinished
   * work (`lockedNodes()`). A session with no runtime is idle by definition: a turn
   * only runs inside a runtime, so an absent one has nothing to report.
   */
  lockedNodesIn(sessionId: string): string[];
  /**
   * A session by id, plus whether it is the one this window is focused on — the
   * read `list_nodes` needs for a session that is not this runtime's own. `undefined`
   * when no such session exists.
   */
  sessionForTool(sessionId: string): { session: AgentSession; active: boolean } | undefined;
  handleRenameSession(args: Record<string, unknown>, callerSessionId?: string): string;
  /**
   * True while an external controller is reloading the window (`/wait-for-finish`
   * with a hold). Every turn start — including an injected notice turn — must
   * check it: `/reload-window` refuses to run while a turn does.
   */
  isHeld(): boolean;
  /**
   * The control plane's identity as environment variables
   * (`SPINNEY_INSTANCE_ID`, `SPINNEY_DISCOVERY_FILE`), or `{}` while it is not
   * listening. It is injected into **every** `exec_command` child
   * (`BackgroundAccess.spawnEnv`), which is how `node tools/reload-window.mjs
   * --message "…"` knows which window to ask for its own deferred reload — no
   * discovery scan, no fallback, and no window named on the command line.
   *
   * Never the bearer token: the child is handed the **path** of the 0600 discovery
   * file and reads the token from it, so a command's environment is not a
   * credential store — and a plain terminal, which has no path, cannot use the
   * script at all.
   */
  controlEnv(): Record<string, string>;
  /**
   * True when another window owns this workspace's session files. Every turn start is
   * refused, not just the composer's: nothing may be written into a session this window
   * does not own (`docs/agents/plans/session-epoch.md` §5).
   */
  isReadOnly(): boolean;
  /**
   * The two AGENTS.md instruction files **as they are on disk right now**
   * (`src/chat/agentsMd.ts`), falling back per half to the window's snapshot when a
   * file cannot be read at all.
   *
   * Both prompt paths go through it — `freezeEpoch` renders these bytes and hashes
   * them, `setupState` hashes them again to decide whether the harness drifted — so the
   * prompt a new epoch freezes and the drift check that guards it can never disagree
   * about which instructions are in force. Reading at use is what makes an edit made
   * while VS Code was closed (or during the session) show up as drift on the next
   * check, instead of silently rewriting a frozen prefix or needing a reload.
   */
  agentsMdSources(): AgentsMdSources;
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

/**
 * The facts `Spinney: Show Request Payload` prints beside the body: where the request
 * would go, what it carries, and how big it is. Identifiers and counts only — the body
 * holds no credential (the key is a header), so nothing here can leak one.
 */
export interface RequestPayloadMeta {
  sessionId: string;
  /** The checked-out node the payload was built from. */
  nodeId: string;
  cardId: string;
  providerId: string;
  baseUrl: string;
  /** The full endpoint the request would be posted to. */
  url: string;
  /** How many messages the body carries (the system prompt included). */
  messages: number;
  /** How many `image_url` / `file` parts those messages carry. */
  images: number;
  /** The UTF-8 size of the serialised body — what the provider reads. */
  bytes: number;
  /**
   * The conversation header, for a provider whose row declares one
   * (`ProviderSpec.sessionHeader`). It travels as a **header, never in the body**, which
   * is why it can only be reported here. Opaque, not secret.
   */
  sessionHeader?: { name: string; value: string };
}

/**
 * Everything a handoff captures from the window that is ending, in the order
 * `docs/agents/invariants/context-rollover.md` §7 requires — read **before** the union kill,
 * so no kill notice can be mistaken for something the user wrote
 * (`SessionRuntime.prepareHandoff`).
 */
interface HandoffFacts {
  /** The node the window ends on (P). */
  previous: TreeNode;
  /** The tail: the user's last real request and the last answer. */
  carry: { request: string; answer: string; attachments: number };
  /** The window's first real user request — the original task, quoted verbatim. */
  firstRequest: string;
  /** Files the window changed, in the order it touched them. */
  files: string[];
  /** The window's own bounded messages — the compression node's input. */
  source: CompactionSource;
  /** How full the window was, when both numbers are known. */
  usage?: { used: number; window: number; pct: number };
  killedBackground: KilledJobLine[];
  killedSubAgents: KilledAgentLine[];
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
   * The node an in-flight image upload continues from. An upload runs **before**
   * `beginTurn`, so no run exists yet and `runningNodes()` cannot see it: this is the one
   * live thing in a session that no run is bound to. A branch deletion that took that node
   * would make the pending send land as a fresh root instead of a continuation
   * (`attachNode`'s parent-gone fallback), which is why `branchDeletionBlocked` reads it.
   */
  uploadBaseId: string | null = null;

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
   * The BCP-47 tag of {@link replyLanguage} ('' when the setting is a free-form
   * language name). The pair is resolved together by the provider's `getConfig()` and
   * pushed by {@link applyReplyLanguage}; only the `exec_command` title description
   * carries the tag, and `liveToolSchemas` renders it through the same helper an agent
   * uses so the frozen envelope and the drift hash agree byte for byte.
   */
  replyLanguageTag: string = '';
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
    // the setting; a later edit arrives through `applyReplyLanguage`. The tag rides
    // beside the name: both are resolved together, and the tag is what the
    // `exec_command` title schema names.
    this.replyLanguage = host.getConfig().replyLanguage;
    this.replyLanguageTag = host.getConfig().replyLanguageTag;
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
   * The id of the node that **starts the context window** `node` lives in: the nearest
   * ancestor-or-self whose `contextBaseId` is itself, or the chain's first node when the
   * window is the implicit first one (`contextBase()` answers `undefined` there).
   *
   * This is the conversation a provider is told about when its row declares a session
   * header, and the window — not the epoch — is the right unit: a rollover under "Continue
   * with current setup" inherits the parent's frozen envelope (`beginTurn`), while the
   * cacheable prefix restarts at the new window. A fork re-marks the window start on its
   * own new copy (`contextBaseId: copyId`), so a fork starts a conversation of its own.
   */
  private windowStart(session: AgentSession, nodeId: string): string {
    const base = contextBase(session, nodeId);
    if (base) {
      return base;
    }
    return pathIds(session, nodeId)[0] ?? nodeId;
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
   * over the same node, so a `spawn_agents` / `send_agent_message` / `create_session`
   * call made during node X's turn always acts for X — never for "the active
   * turn", which no longer exists once two branches may run at once. The card and
   * the thinking effort are seeded **from this node** (its own, else an ancestor's,
   * else the session seed), never from the tab's current dropdown.
   */
  private workerFor(node: TreeNode): { agent: Agent; tools: ToolRegistry } {
    let worker = this.nodeWorkers.get(node.id);
    if (!worker) {
      // A **compression** node gets the read-only four and no orchestrator at all
      // (`docs/agents/invariants/compress-node.md` §2): the restriction is the registry it
      // is built with and the capabilities below, not a sentence in its prompt.
      const compress = node.role === 'compress';
      const tools = compress ? this.compressTools() : new ToolRegistry();
      if (!compress) {
        // `search_transcripts` reads the harness's own transcript dumps; the roots
        // depend on config + global storage, so hand it a live resolver.
        tools.setTranscriptRoots(() => [this.host.transcriptRoot()]);
        // One access object per node: registries live per (session, node) inside the
        // hub, so a job belongs to the branch whose turn spawned it and a task id
        // stays session-local.
        tools.setBackgroundAccess({
          currentOwner: () => ({ sessionId: this.sessionId, nodeId: node.id }),
          hub: this.hub,
          // The identity every child process of this node is born with: which node asked
          // (so a command can name the exact conversation it belongs to) plus the window's
          // control plane. Recomputed per spawn, so a plane that is enabled later, or
          // rebound to another port by `restart()`, is never stale.
          spawnEnv: (owner) => ({
            ...(owner ? { SPINNEY_SESSION_ID: owner.sessionId, SPINNEY_NODE_ID: owner.nodeId } : {}),
            ...this.host.controlEnv(),
          }),
        });
        // The two web tools read `searchProvider` off **this node's** card: the paid tier
        // is the card's declaration, and the token it needs is that card's provider's —
        // resolved live, so an edit in the Model Cards page applies to the next call.
        tools.setWebCard(() => this.cardForNode(node));
      }
      const agent = new Agent(this.clients, tools, (event) => this.handleAgentEventFor(node, event));
      agent.setCard(this.cardForNode(node));
      agent.setThinkingEffort(this.effortForNode(node));
      agent.setReplyLanguage(this.replyLanguage, this.replyLanguageTag);
      if (!compress) {
        // This agent can spawn sub-agents: hand it this runtime's orchestrator,
        // bound to the same node.
        agent.setSpawnHandler((args, signal) => this.handleSpawnAgents(node, args, signal));
        // And it can resume a finished sub-agent with a follow-up message.
        agent.setSendMessageHandler((args, signal) => this.handleSendAgentMessage(node, args, signal));
        // The session surface: start a fresh session, prompt one, wait for it, end what
        // it started, and read the window's sessions / a session's tree. Main agent
        // only — a sub-agent reports to its dispatcher, not into another conversation.
        agent.setCanSessions(true);
        agent.setCreateSessionHandler((args) => this.handleCreateSession(node, args));
        agent.setSendSessionPromptHandler((args) => this.handleSendSessionPrompt(node, args));
        agent.setWaitForSessionIdleHandler((args, signal) => this.handleWaitForSessionIdle(args, signal));
        agent.setInterruptSessionHandler((args) => this.handleInterruptSession(args));
        agent.setListSessionsHandler((args) => Promise.resolve(this.handleListSessions(args)));
        agent.setListNodeHandler((args) => Promise.resolve(this.handleListNodes(node, args)));
        // Completion signals (a finished background terminal or an async sub-agent)
        // are injected into this node's *running* turn at its next tool boundary.
        agent.setSignalHandler(() => this.takeSignalsFor(node));
        // And it can rename the session (an explicit rename locks the title, so the
        // automatic namer leaves it alone).
        agent.setRenameSessionHandler((args) => Promise.resolve(this.host.handleRenameSession(args, this.sessionId)));
      } else {
        // Belt and braces beside the all-off capability set: a compression turn is a
        // read-only observer, so it has nothing to spawn and no conversation to address.
        agent.setCanSpawn(false);
        agent.setCanSpawnReadOnly(false);
        agent.setCanSessions(false);
      }
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
   * The node an in-flight image upload continues from, or `null` when no upload is running.
   * `uploadController` is the source of truth for "is there an upload at all": the id alone
   * is never read as one, so a path that clears the controller cannot leave a stale lock.
   */
  uploadingNode(): string | null {
    return this.uploadController ? this.uploadBaseId : null;
  }

  /**
   * What stops a prompt from starting on `basis` (absent = the session's active node)
   * right now, or `null` when it would start.
   *
   * **One predicate, three callers**: `onUserMessage` refuses on it, `wait_for_session_idle`
   * polls it, and the busy sentence an inter-session prompt returns is built from these
   * same fields. Each entry point checking the four conditions itself is how five
   * slightly different gates appeared in the first place
   * (`docs/agents/plans/session-prompt-addressing.md` §1).
   *
   * The order is the composer's: an absent node, a live run, unfinished work the basis
   * still owns, then the reload hold.
   */
  promptBlocker(basis: string | null = this.session.activeNodeId): {
    code: 'missing' | 'running' | 'locked' | 'held';
    nodeId: string | null;
    ranMs: number;
    locked: number;
  } | null {
    if (basis && !this.session.nodes[basis]) {
      return { code: 'missing', nodeId: basis, ranMs: 0, locked: 0 };
    }
    const run = basis ? this.runs.get(basis) : undefined;
    if (run) {
      return { code: 'running', nodeId: basis, ranMs: Date.now() - run.startedAt, locked: 0 };
    }
    // Unfinished work (a background job, an async sub-agent batch, or a notice about to
    // be injected into it): a send would open a second run on the same line while that
    // notice lands in the very node the new turn branches from.
    const locked = basis ? this.lockedWorkCount(basis) : 0;
    if (locked > 0) {
      return { code: 'locked', nodeId: basis, ranMs: 0, locked };
    }
    if (this.host.isHeld()) {
      return { code: 'held', nodeId: basis, ranMs: 0, locked: 0 };
    }
    return null;
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

  /**
   * True while one of `ids` still has a worker agent mid-turn although no run is registered
   * for it. A turn's terminal event is delivered *before* its `finally` clears the run, so
   * there is a window where the node streams nowhere and is still being written into; a
   * branch deletion must not remove that node.
   */
  windingDown(ids: string[]): boolean {
    return ids.some((id) => this.nodeWorkers.get(id)?.agent.running === true);
  }

  /** True while this session owns at least one running background job. */
  hasRunningBackground(): boolean {
    return this.runningBackgroundCount() > 0;
  }

  /**
   * True while this session owns a running **node** job — one that locks its node and sends a
   * completion notice. A `start_detached` (fire-and-forget) job deliberately does not count
   * here, and that is not cosmetic: the idle gates that call this feed the session list's
   * `busy` flag, `globallyIdle()` — which the control plane's `POST /wait-for-finish`
   * (`scope:'all'`) and the reload refusal wait on — and, through `runningNodes` /
   * `lockedNodes`, what `list_nodes` reports as `busy` and what a prompt refuses on. Counting a detached job there would mean a dev server keeps the harness
   * permanently not-idle, so the window could never defer a reload.
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
   * view, with any pending pick on it). Rendered from the instruction files as they are
   * on disk right now — this is a preview of what a *new* node would freeze. */
  systemPromptText(): string {
    return systemPrompt(
      cardDisplayName(this.card),
      this.thinkingEffort,
      this.replyLanguage,
      undefined,
      this.host.agentsMdSources(),
    );
  }

  /**
   * Where one payload would go and what it carries (`Spinney: Show Request Payload`).
   * Counts and identifiers only: the body has no credential in it — the key travels in
   * the `Authorization` header — and this never reads one.
   */
  requestPayload(): { body: Record<string, unknown>; meta: RequestPayloadMeta } | undefined {
    const node = this.viewNode();
    // Nothing to send from: an empty session (no node in view), or a sidecar — a
    // sub-agent's own conversation and a background card's are not this one's history.
    if (!node || isSidecar(node)) {
      return undefined;
    }
    const session = this.session;
    const epoch = epochForNode(session, node.id);
    const card = this.chainCard(node);
    const provider = providerById(card.providerId);
    // The same three sources `beginTurn` sends from: the frozen envelope's prompt plus the
    // window's messages (`buildPath`), the frozen tool schemas (a legacy envelope has none,
    // so the live set is what a request would carry), and the chain's own level.
    const messages = this.buildPath(session, node.id);
    // The frozen set is what a turn really advertises (`Agent.setToolSchemas`); a chain
    // with no envelope — or a foreign/legacy one whose set is empty, which that same
    // method treats as "nothing pinned" — falls back to the live capability set.
    const tools = epoch?.tools && epoch.tools.length > 0 ? epoch.tools : this.liveToolSchemas(card, false);
    // `wellFormedDeep` is what the client normalises the wire copy with, so the body shown
    // is the structure the provider parses — not an inline copy that may still hold a lone
    // surrogate the wire would have repaired.
    const body = wellFormedDeep(
      buildChatRequestBody({
        model: card.oaiModel,
        messages,
        tools,
        thinkingEffort: epoch ? epoch.effort : this.effortForNode(node),
        stream: true,
      }),
    );
    let images = 0;
    for (const message of messages) {
      if (Array.isArray(message.content)) {
        images += message.content.filter((part) => part.type === 'image_url' || part.type === 'file').length;
      }
    }
    // The conversation header is a **header, never a body field** (`SessionDialect`): the
    // value is the window this request's prefix belongs to, and it is opaque rather than
    // secret, so the diagnostic line may carry it.
    const sessionHeader =
      provider.sessionHeader === 'opencode'
        ? { name: 'x-opencode-session', value: `ses_${this.windowStart(session, node.id)}` }
        : undefined;
    return {
      body,
      meta: {
        sessionId: session.id,
        nodeId: node.id,
        cardId: card.id,
        providerId: card.providerId,
        baseUrl: provider.baseUrl,
        url: chatCompletionsUrl(provider.baseUrl),
        messages: messages.length,
        images,
        bytes: Buffer.byteLength(JSON.stringify(body), 'utf8'),
        ...(sessionHeader ? { sessionHeader } : {}),
      },
    };
  }

  /**
   * The system prompt for one node's branch: its identity line names the card
   * **that node resolves to** and the level it runs at, so a request built from an
   * older node's history tells the model which model is about to answer it — the
   * card of that branch, not the dropdown's current value.
   */
  private systemPromptFor(node: TreeNode | undefined): string {
    // A chain with no envelope still renders as it always did, and a **compression** node
    // renders its own template — the live render must never disagree with what a freeze of
    // the same node would produce (`freezeEpoch`).
    if (node?.role === 'compress') {
      return compressSystemPrompt(cardDisplayName(this.cardForNode(node)), this.effortForNode(node));
    }
    return systemPrompt(
      cardDisplayName(this.cardForNode(node)),
      this.effortForNode(node),
      this.replyLanguage,
      undefined,
      this.host.agentsMdSources(),
    );
  }

  /**
   * The tool schemas a **live** setup would advertise right now, built without touching
   * any worker: the drift check compares them against a frozen set, and it runs while
   * other nodes may be mid-turn, so nothing here may mutate an agent.
   *
   * A bare registry is enough because no tool *schema* depends on the wiring (the access
   * objects gate execution, not the definitions); the runtime values in the whole set are
   * `exec_command`'s shell label (a process-wide probe) and its `title` description, which
   * names the reply language — rendered here through the same helper an agent uses
   * (`withToolTitleLanguage`), with the same name + tag, so a frozen envelope and the
   * drift hash over it are computed from identical bytes.
   *
   * `role` decides *which* set: a compression node advertises the read-only four and no
   * intercepted tool at all (`compressToolSchemas`), because its capabilities are all off.
   */
  private liveToolSchemas(
    card: ModelCard,
    sidecar: boolean,
    role?: 'compress' | 'resume',
  ): ToolDefinition[] {
    if (role === 'compress') {
      return this.compressToolSchemas();
    }
    const registry = new ToolRegistry();
    const capabilities: ToolCapabilities = {
      vision: isVisionCard(card),
      canSpawn: !sidecar,
      canSpawnReadOnly: false,
      canSessions: !sidecar,
    };
    return withToolTitleLanguage(
      [...registry.definitions, ...interceptedDefinitions(capabilities)],
      this.replyLanguage,
      this.replyLanguageTag,
    );
  }

  /**
   * The compression node's tool **registry**: the four read tools, built from the full one
   * so the write surface is explicitly denied rather than merely absent
   * (`docs/agents/invariants/compress-node.md` §2).
   *
   * The denial is defence in depth and it is the whole capability: a compression turn has
   * no way to change the workspace, and that is a fact of the registry the agent was built
   * with — not a sentence in its prompt that a model could decide to ignore.
   */
  private compressTools(): ToolRegistry {
    const registry = new ToolRegistry();
    // `search_transcripts` resolves its roots live, and `setTranscriptRoots` rebuilds the
    // registry — so it is set **before** the subset is taken (a rebuild after it would put
    // every tool back).
    registry.setTranscriptRoots(() => [this.host.transcriptRoot()]);
    registry.withBlocked(COMPRESS_BLOCKED_TOOLS);
    return registry.subset(COMPRESS_READONLY_TOOLS);
  }

  /** Those schemas, in the one shape a frozen envelope records. */
  private compressToolSchemas(): ToolDefinition[] {
    const capabilities: ToolCapabilities = {
      vision: false,
      canSpawn: false,
      canSpawnReadOnly: false,
      canSessions: false,
    };
    return withToolTitleLanguage(
      [...this.compressTools().definitions, ...interceptedDefinitions(capabilities)],
      this.replyLanguage,
      this.replyLanguageTag,
    );
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
    // A **compression** node freezes its own envelope: its own template, its own tool set,
    // and no AGENTS.md section (the workspace's instructions describe how to work, and this
    // turn does not work). `kind` is what the drift check reads to compare like with like.
    const compress = node.role === 'compress';
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
    const tools = this.liveToolSchemas(card, isSidecar(node), node.role);
    // The instructions are read **at use** (`agentsMd.ts`, through the host): an edit made
    // while VS Code was closed, or during this session, is what the next epoch freezes —
    // and the hash below is taken from the same bytes, so the drift check that guards this
    // envelope can never disagree with what its prompt says.
    const agentsMd: AgentsMdSources = compress
      ? { global: null, workspace: null }
      : this.host.agentsMdSources();
    return {
      id: newId(),
      prompt: compress
        ? compressSystemPrompt(cardDisplayName(card), level)
        : systemPrompt(cardDisplayName(card), level, this.replyLanguage, undefined, agentsMd),
      tools,
      cardId: card.id,
      effort: level,
      replyLanguage: this.replyLanguage,
      kind: compress ? 'compress' : undefined,
      providerId: card.providerId,
      baseUrl: provider?.baseUrl ?? '',
      wireModel: card.oaiModel,
      vision: isVisionCard(card),
      visionTransport: card.vision.transport === 'deepseek' ? 'deepseek' : 'openai',
      agentsMdHash: contentHash(agentsMdSection(agentsMd)),
      templateHash: contentHash(compress ? COMPRESS_SYSTEM_PROMPT_TEMPLATE : SYSTEM_PROMPT_TEMPLATE),
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
  private rolloverReason(node: TreeNode): 'full' | 'near' | 'images' | 'manual' {
    const failure = node.status === 'error' ? lastFailureText(node) : undefined;
    if (failure && windowFullReason(failure) === 'images') {
      return 'images';
    }
    if (this.contextState(node) === 'full') {
      return 'full';
    }
    // `near` is the 90% suggestion; anything below it is the user's own "move this now" (the
    // Send button's right-click, `force`). The harness text must not claim a window that was
    // nearly used up when it had room left — a model told the wrong reason acts on it
    // (`docs/agents/invariants/context-rollover.md` §6).
    return this.contextState(node) === 'near' ? 'near' : 'manual';
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
  /**
   * Whether the live setup and the checked-out chain's frozen one disagree (`setupState().drift`).
   * The new-window entry asks its second question only when they do: with no drift, "inherit the
   * old envelope" and "freeze the live one" are the same bytes, so a modal could not change the
   * outcome (`confirmHandoffSetup` in `ChatViewProvider`).
   *
   * `nodeId` asks the question about **that** card's chain instead of the view focus: the
   * setup question belongs to a compression card the user may have navigated away from
   * (`docs/agents/invariants/compress-node.md`).
   */
  hasSetupDrift(nodeId?: string): boolean {
    return this.setupState(nodeId).drift !== false;
  }

  private setupState(nodeId?: string): {
    node: { cardId: string; cardLabel: string; effort: ThinkingEffort; language: string } | null;
    live: { cardId: string; cardLabel: string; effort: ThinkingEffort; language: string };
    drift: false | 'user' | 'harness';
    reasons: string[];
  } {
    // `nodeId` overrides the view focus so the question can be asked about a specific card —
    // the compression card a send below it is about. Absent means the checked-out chain.
    const view = nodeId ? this.session.nodes[nodeId] : this.viewNode();
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
    //
    // **Which** prompt and which tool set is the epoch's own question: a chain whose
    // envelope was frozen from the compression template is compared against that template
    // and the compression tool set, and against no AGENTS.md section at all. Comparing it
    // against the main ones would report drift on every check — a compression chain would
    // spend its life claiming the harness changed under it.
    const compress = epoch.kind === 'compress';
    if (contentHash(compress ? COMPRESS_SYSTEM_PROMPT_TEMPLATE : SYSTEM_PROMPT_TEMPLATE) !== epoch.templateHash) {
      reasons.push('prompt');
    }
    if (contentHash(agentsMdSection(compress ? { global: null, workspace: null } : this.host.agentsMdSources())) !== epoch.agentsMdHash) {
      reasons.push('agents.md');
    }
    if (
      contentHash(JSON.stringify(this.liveToolSchemas(liveCard, view?.kind === 'agent', compress ? 'compress' : undefined))) !==
      epoch.toolsetHash
    ) {
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
    // Nothing is waiting on a queued notice any more: the inter-session channel does
    // not use this queue (`send_session_prompt` starts a turn), so a pending signal is
    // just work whose window is going down.
    this.signals.clear();
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
      // A run that never reaches `finishTurn` (the host is going away) must not leave an
      // orchestrator awaiting it forever: release it now, and the caller then sees `dead`.
      run.resolveSettled();
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
   * **name** and `tag` its BCP-47 tag (`ChatViewProvider.getConfig().replyLanguage` /
   * `.replyLanguageTag`), so the `auto` → display-language step has already happened:
   * re-picking `auto` on a window that already follows its own language is a no-op.
   *
   * Nothing already sent is rewritten. Every frozen envelope keeps the language it was
   * rendered with, and the pair below is what the **next new node** will freeze — which is
   * exactly what the composer reports as the drift between the two setups
   * (`setupState`). The language is part of a prefix, and a prefix is append-only.
   */
  applyReplyLanguage(language: string, tag = ''): void {
    if (this.busy) {
      return; // never move a setup under a running request
    }
    const next = (language || '').trim() || DEFAULT_REPLY_LANGUAGE;
    const nextTag = (tag || '').trim();
    if (next === this.replyLanguage && nextTag === this.replyLanguageTag) {
      return;
    }
    this.replyLanguage = next;
    this.replyLanguageTag = nextTag;
    this.host.output.appendLine(`[config] replyLanguage=${next} (new nodes; frozen chains keep theirs)`);
    // The two setups may now disagree: repaint the composer's drift marking.
    this.postConfig();
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
    this.postPath('checkout');
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
   * facts the webview cannot compute for itself — `contextFull`, which decides the
   * button variant (`⧉ Continue in a new window` vs `↻ Retry`), and `handoffReady`, which
   * decides whether a compression card is green and hosts the composer. It is built in one
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
    cachePct: number | null;
    handoffReady: boolean;
  } {
    return {
      id: node.id,
      status: node.status,
      title: node.title,
      // The card bar reads **this card's totals**, not its last request (`nodeUsageTotal`):
      // a tool loop made several and the bar counts all of them.
      usage: nodeUsageTotal(node),
      contextFull: nodeContextFull(node),
      context: this.contextState(node),
      contextPct: this.contextPercent(node),
      // The card's own prompt-cache hit rate, recomputed from the items it now holds: a turn
      // that just ended is exactly the event that changes it, and the checked-out card's
      // outline is where it shows (`docs/agents/invariants/chat-tree.md`).
      cachePct: nodeCacheRate(node) ?? null,
      // A compression card that just wrote its handoff becomes ready without any other
      // change on the card, so the flag has to ride in every patch — not only in `tree`.
      handoffReady: hasHandoff(node),
    };
  }

  /**
   * Structural summary of the session tree + the view/stream ids (no items).
   *
   * The message is built by {@link treeMessage} and posted unchanged.
   */
  postTree(why = 'other'): void {
    const t0 = Date.now();
    const message = this.treeMessage();
    // Always-on, never only inside a traced op: a repaint that lands while the user is
    // typing or dragging is exactly the event no op covers (an op wraps a switch, a
    // checkout or a cold repaint, never a keystroke), and without this line the host's
    // half of that stutter is invisible on the wire.
    perf(
      () =>
        `tree-post why=${why} session=${this.sessionId} build=${Date.now() - t0}ms ` +
        `bytes=${this.payloadBytes(message)} nodes=${Object.keys(this.session.nodes).length}`,
    );
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
      // The card's **totals** (every request its turn made), which is what the docked bar
      // shows; `nodeUsage` answers "the last request" and is not this.
      usage: nodeUsageTotal(node),
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
      // The **prompt-cache hit rate** of this card's own requests, or `null` when none of
      // them reported the cache fields (`nodeCacheRate`). The one card in the tree that is
      // checked out wears it on its outline; it is computed here, at payload time, so there
      // is no stored percentage that could go stale.
      cachePct: nodeCacheRate(node) ?? null,
      contextBaseId: node.contextBaseId,
      // The epoch this node starts, when it starts one: it is what a new tree is copied
      // from and what a diagnostic names.
      epochId: node.epoch ? node.epoch.id : undefined,
      size: node.customSize ?? null,
      kind: node.kind,
      // What this node is in a compression chain: the card draws `CMP` for a compression
      // node and hides its 🗑 for a resume window. A compression card is not sealed by its
      // window any more: `handoffReady` says whether it already carries the handoff, and
      // that is what turns it green and gives it the composer
      // (`docs/agents/invariants/compress-node.md`).
      role: node.role,
      compressedFrom: node.compressedFrom,
      // Ready = the card carries the handoff a send below it opens the window with.
      handoffReady: hasHandoff(node),
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
  postPath(why = 'other'): void {
    const t0 = Date.now();
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
    let items = 0;
    for (const node of nodes) {
      items += (node.items || []).length;
    }
    perf(
      () =>
        `path-post why=${why} session=${this.sessionId} build=${Date.now() - t0}ms ` +
        `bytes=${this.payloadBytes(message)} ids=${ids.length} items=${items}`,
    );
    opPayload('post-path', message);
    this.post(message);
  }

  /**
   * The byte size of one outbound payload, for the always-on repaint lines.
   *
   * A `JSON.stringify` of the payload being posted: it is the only honest size (the
   * `bytes=` an op carries is the same measurement), and it exists only while a perf sink
   * is installed. `-1` is "could not be serialized", which is a bug elsewhere and not this
   * line's job.
   */
  private payloadBytes(message: unknown): number {
    try {
      return JSON.stringify(message)?.length ?? 0;
    } catch {
      return -1;
    }
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
      snippets: cfg.promptSnippets,
      // The appear animation, re-sent with every config: turning it off reaches the open
      // tab at once, and the webview defaults it to on when the field is absent.
      streamAnimation: cfg.streamAnimation,
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
      this.postTree('post-all-state');
      this.postPath('post-all-state');
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
   *
   * `opts.epochFrom` overrides where the run's **envelope** comes from, and it is the one
   * option a compression chain cannot do without (`docs/agents/invariants/compress-node.md`
   * §3): a string names the node whose frozen bytes this node inherits — a **copy** is
   * planted on the new node, so `epochForNode` for its own descendants never walks up past
   * it into the compression envelope above — while `null` means "freeze a fresh one from
   * the live setup", which is what the compression node itself does. Absent (the default)
   * keeps the ordinary rule: inherit the parent's, freeze when there is none.
   */
  private beginTurn(
    title: string,
    opts?: {
      parentId?: string | null;
      pan?: boolean;
      freshContext?: boolean;
      freshEpoch?: boolean;
      /** `null` = freeze a fresh envelope; a node id = plant a copy of that node's. */
      epochFrom?: string | null;
      /** A compression node / the window it produced (`TreeNode.role`). */
      role?: 'compress' | 'resume';
      /** A compression node's own record of the window it compresses. */
      compressedFrom?: string;
    },
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
    //
    // `epochFrom` is the compression chain's override (`docs/agents/invariants/compress-node.md`
    // §3). A **node id** plants a *copy* of that node's envelope on this one — the resume
    // window inherits the compressed window's bytes, never the compression turn's, because
    // the compression node has an envelope of its own between them and `epochForNode` only
    // ever walks up. `null` means the opposite: freeze a fresh envelope from the live setup
    // (a compression node is its own epoch, in its own template and its own tool set).
    // Absent keeps the ordinary inheritance rule.
    const hasEpochFrom = !!opts && 'epochFrom' in opts;
    let inherited: Epoch | undefined;
    let plantInherited = false;
    if (hasEpochFrom) {
      const from = opts!.epochFrom ? epochForNode(session, opts!.epochFrom) : undefined;
      if (from) {
        // Same bytes, new identity: `frozenAt` and every hash still describe when and
        // what was frozen, while the epoch id names the run that now carries them.
        inherited = { ...from, id: newId() };
        plantInherited = true;
      }
    } else {
      inherited = opts?.freshEpoch ? undefined : epochForNode(session, parentId ?? null);
    }
    const freezeLive = !inherited;
    const cardId = freezeLive && opts?.freshEpoch ? this.card.id : inherited ? inherited.cardId : this.requestCardId(basis);
    const effort = freezeLive && opts?.freshEpoch ? this.thinkingEffort : inherited ? inherited.effort : this.requestEffort(basis);
    node.model = cardId;
    node.effort = effort;
    // What this node is in a compression chain. Both roles also start a window (below), so
    // the card draws its dashed edge for them like for any rollover.
    if (opts?.role) {
      node.role = opts.role;
    }
    if (opts?.compressedFrom) {
      node.compressedFrom = opts.compressedFrom;
    }
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
    // removed by a later build cannot change a prefix that is already in the cache. A
    // **planted** envelope is also stored on this node — that is what makes it a boundary:
    // the compression node above it has an envelope of its own, and without the copy every
    // descendant of a resume window would inherit the compression prompt.
    if (inherited) {
      worker.agent.setToolSchemas(inherited.tools);
      if (plantInherited) {
        node.epoch = inherited;
      }
    } else {
      node.epoch = this.freezeEpoch(node, cardId, effort);
      worker.agent.setToolSchemas(node.epoch.tools);
    }
    // The provider-side conversation this turn belongs to: the **context window's** id, so
    // every request of one window names the same conversation across a reload and a new id
    // starts exactly where the cacheable prefix ends — a rollover, or a fork's root. Not the
    // epoch's id: a rollover under "current setup" inherits the parent's frozen envelope
    // while starting a new, shorter window, so the envelope is not the cache boundary. A
    // provider whose row declares no session header never sees it (models.ts
    // `sessionHeader`, `apiClient.ts` `SessionDialect`).
    worker.agent.setProviderSession(this.windowStart(session, node.id));
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
      startedAt: Date.now(),
      pendingText: '',
      pendingThinking: '',
      pendingTools: new Map(),
      flushTimer: null,
      ...settlePair(),
    };
    this.runs.set(node.id, run);
    this.postTree('turn-start');
    // The checkout has already moved (`attachNode`), so the composer's setup identity —
    // and the drift entry that decides whether `#new-context-btn` shows — must describe
    // **this** node's chain, not the one the user was standing on a moment ago. Without
    // this repaint both stay at the previous node's value until a click recomputes them,
    // and the newest window would offer a fork under a setup it was just frozen from
    // (`setupState()` compares the new node's own epoch, so it reads no drift).
    this.postConfig();
    this.postContext();
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
      startedAt: Date.now(),
      pendingText: '',
      pendingThinking: '',
      pendingTools: new Map(),
      flushTimer: null,
      ...settlePair(),
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
        // An injected (sub-agent / background notice) turn continues a node that
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
    // The run is closed: whatever was awaiting it (a compression card, which stores the
    // handoff it just wrote) may look at `node.status` now.
    run.resolveSettled();
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

  /**
   * Start one user turn, from `opts.basisNodeId` (absent = the session's active node).
   *
   * **The decision whether a turn may start is made here, once.** Two callers present
   * it differently — the composer posts a localized notice, and an inter-session
   * prompt needs a sentence in a tool result (`quiet` suppresses the notice) — but the
   * gate itself is this method, so a new entry point cannot acquire a slightly
   * different rule (`docs/agents/plans/session-prompt-addressing.md` §2.2).
   *
   * `from` / `rounds` are the inter-session provenance and allowance: they are written
   * onto the node this turn creates, which is what `list_nodes` renders and what
   * `interrupt_session` reads to decide what an agent may stop.
   */
  async onUserMessage(
    text: string,
    attachments: UserAttachment[] = [],
    opts?: {
      basisNodeId?: string | null;
      from?: { sessionId: string; nodeId: string };
      rounds?: number;
      quiet?: boolean;
      /**
       * Which envelope the window opened below a **compression card** sends with (the setup
       * question the provider asks at send time): `'current'` inherits the compressed window's
       * frozen bytes, `'latest'` freezes the live setup on the new node. Ignored by an ordinary
       * send, which has no boundary to cross.
       */
      handoffSetup?: 'current' | 'latest';
    },
  ): Promise<
    | { ok: true; nodeId: string }
    | {
        ok: false;
        code: 'missing' | 'running' | 'locked' | 'held' | 'empty' | 'refused';
        /** The node the decision was about, when there is one. */
        nodeId?: string | null;
        /** `running`: how long that turn has been going. */
        ranMs?: number;
        /** `locked`: how many pieces of unfinished work are holding the line. */
        locked?: number;
      }
  > {
    // P3: only the node this turn would continue from must be free — another
    // branch of this session may stream meanwhile. (This mirrors the composer's
    // Stop-not-Send rule; `beginTurn` re-checks the same condition once the basis
    // is known.)
    //
    // `'basisNodeId' in opts` — a presence test, never a truthiness read — is what
    // tells an explicit `null` apart from an absent option. `null` means "no parent":
    // an edited **root** node's replacement therefore starts a second forest root
    // instead of silently branching off whatever happens to be checked out
    // (`editUserMessage` in `ChatViewProvider`).
    const quiet = opts?.quiet === true;
    const basis =
      opts && 'basisNodeId' in opts ? opts.basisNodeId ?? null : this.session.activeNodeId;
    // A **compression card** is a boundary, not a conversation: a send from it opens the window
    // below it, led by the handoff the card carries (`docs/agents/invariants/compress-node.md`).
    // A card that does not carry one yet has nothing to lead with, so the send is refused
    // instead of growing a plain child under it. The composer cannot reach this (a card without
    // a handoff shows no input dock) and ▶ is refused in `continueFrom`; this closes the one
    // entry left — an inter-session prompt addressed at a not-ready card.
    const basisNode = basis ? this.session.nodes[basis] : undefined;
    const handoffCard = basisNode && isCompressNode(basisNode) ? basisNode : undefined;
    if (handoffCard && !hasHandoff(handoffCard)) {
      if (!quiet) {
        this.postNotice(
          'warning',
          vscode.l10n.t('This compression has not written its handoff yet. Continue it on its card, then send.'),
        );
      }
      return { ok: false, code: 'refused', nodeId: basis };
    }
    // The card this send runs on **and** the card the image path below must use are
    // the ones of the node the send came from (its own, else an ancestor's, else the
    // session seed), plus a pending pick made on it. Both are read here, once, before
    // the upload can await: the transport an image travels in is a property of that
    // one card, so a checkout that lands mid-upload must not build the request for
    // one card and then run it on another.
    //
    // A send below a **compression card** runs on the card the window it opens will
    // actually send with — `epochFrom` plants P's frozen card (`'current'`), and `'latest'`
    // freezes the live one — never on the dropdown alone, or an image could be uploaded for
    // the wrong provider and handed to a window running on another (`vision-images.md`).
    const windowCardId =
      handoffCard && opts?.handoffSetup !== 'latest'
        ? epochForNode(this.session, handoffCard.compressedFrom ?? null)?.cardId ??
          this.requestCardId(basis ? this.session.nodes[basis] : undefined)
        : this.card.id;
    const sendCard = handoffCard ? this.cardForCardId(windowCardId) : this.card;
    // **One predicate decides whether this turn may start** (`promptBlocker`): an
    // absent node, a live run, unfinished work the basis still owns, or a reload hold.
    // The composer is told which one in a notice; an inter-session prompt gets the same
    // answer, in the terms of its receipt (`quiet`).
    const blocker = this.promptBlocker(basis);
    if (blocker) {
      if (!quiet) {
        if (blocker.code === 'locked') {
          this.postNotice(
            'warning',
            vscode.l10n.t(
              'A background task or sub-agent is still running on this branch ({0}). Press Stop to kill it, or wait for it to finish.',
              blocker.locked || 1,
            ),
          );
        } else if (blocker.code === 'held') {
          this.postNotice(
            'warning',
            vscode.l10n.t('An external controller is rebooting the window; please wait a moment.'),
          );
        }
      }
      return {
        ok: false,
        code: blocker.code,
        nodeId: blocker.nodeId,
        ranMs: blocker.ranMs,
        locked: blocker.locked,
      };
    }
    const userText = text.trim();
    // **The one machine line an inter-session prompt starts with.** It is not localized
    // and not translated, whatever language the reply is in: the model has to be able to
    // tell another agent's instruction from the developer's, or a message from a peer
    // reads as a message from the user. Only the bytes the provider sends carry it (the
    // card shows the prompt itself, and `list_nodes` shows `from=`), so the line never
    // reaches the composer or a human reading the card.
    const promptOrigin = opts?.from
      ? `[session prompt from ${opts.from.sessionId}/${opts.from.nodeId}` +
        `${typeof opts.rounds === 'number' ? `, rounds left ${opts.rounds}` : ''}]\n`
      : '';

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
        parts.push({ type: 'text', text: promptOrigin + userText });
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
        // The node this send continues from, recorded beside the controller that marks the
        // upload as live: until `beginTurn` runs there is no run to bind it to, and a branch
        // deletion of that node would turn this send into a fresh root.
        this.uploadBaseId = basis;
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
              this.uploadBaseId = null;
              // Another branch may still be streaming; only this session's own
              // upload is ending here.
              this.syncBusy();
              this.lastStatus = vscode.l10n.t('Interrupted');
              this.post({ type: 'status', text: vscode.l10n.t('Interrupted') });
              this.post({ type: 'interrupted' });
              return { ok: false, code: 'refused' };
            }
            failed.push(att.name || 'image');
            this.host.output.appendLine(`[image] upload failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        this.uploadController = null;
        this.uploadBaseId = null;
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
          return { ok: false, code: 'empty' };
        }
      }
      content = parts;
      // A send below a compression card leads with the handoff block, so the user's message —
      // the one these images belong to — is message 1, not 0.
      const leadCount = handoffCard ? 1 : 0;
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
            messageIndex: leadCount,
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
            messageIndex: leadCount,
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
      content = promptOrigin + userText;
    }

    if (typeof content === 'string' && !content) {
      return { ok: false, code: 'empty' };
    }
    if (Array.isArray(content) && content.length === 0) {
      return { ok: false, code: 'empty' };
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
    //
    // A send **below a compression card** is not an ordinary child: it opens a new context
    // window (`freshContext`), titled after the window it is, and takes its envelope from the
    // user's setup answer — `'current'` plants P's frozen bytes (`epochFrom`), `'latest'` freezes
    // the live setup (`epochFrom: null`, `freshEpoch`). C's own envelope never travels into the
    // conversation that way. Every send below the same card is a new sibling window, which is
    // why the number counts the ones already produced.
    const windowNo = handoffCard ? this.producedWindowNumber(handoffCard) : 0;
    const run = handoffCard
      ? this.beginTurn(vscode.l10n.t('Context window {0}', windowNo), {
          parentId: basis,
          freshContext: true,
          role: 'resume',
          ...(opts?.handoffSetup === 'latest'
            ? { epochFrom: null, freshEpoch: true }
            : { epochFrom: handoffCard.compressedFrom }),
        })
      : this.beginTurn(titleFromPrompt(userText || attachments[0]?.name || ''), { parentId: basis });
    if (!run) {
      if (handoffCard && !quiet) {
        this.postNotice('warning', vscode.l10n.t('Could not open the new context window here — try again.'));
      }
      return { ok: false, code: 'refused' };
    }
    // The handoff goes first, as the window's own harness block: it describes the window being
    // left, and the user's message below it is this turn's request. `handoff` / `handoffSummary`
    // on the new node are copied from the card only when the card holds a real compression
    // answer — a Simple (pointer) card has no summary, and its window must not claim one.
    if (handoffCard) {
      run.items.push({ kind: 'harness', text: handoffCard.handoffNote! });
      this.post({ type: 'harnessNote', nodeId: run.node.id, text: handoffCard.handoffNote! });
      if (handoffCard.handoffSummary) {
        run.node.handoff = 'summary';
        run.node.handoffSummary = handoffCard.handoffSummary;
      }
      // A diagnostic, not a safety net: the envelope is planted by `beginTurn`, and this line
      // says which bytes the window really sends, so a log can prove the window inherited P and
      // not the card's C — and that a card with several windows opened the right one.
      const fromEpoch = epochForNode(this.session, handoffCard.compressedFrom ?? null);
      this.host.output.appendLine(
        `[compression] ${handoffCard.compressedFrom ?? '?'} -> ${handoffCard.id} -> ${run.node.id} ` +
          `(window ${windowNo}, envelope ${run.node.epoch?.kind ?? 'main'}` +
          `${fromEpoch && opts?.handoffSetup !== 'latest' ? `, inherited ${fromEpoch.kind ?? 'main'} from ${handoffCard.compressedFrom}` : ', frozen from the live setup'})`,
      );
    }
    // Inter-session provenance and allowance live on the node this prompt created:
    // `from=` is what `list_nodes` shows, and `roundsAllowance` is what the answer's
    // own prompt is charged against. `min()` never raises, so a receiving session can
    // use less of the budget it was handed and can never buy more.
    if (opts?.from) {
      run.node.lastFrom = opts.from;
    }
    if (typeof opts?.rounds === 'number') {
      run.node.roundsAllowance = Math.min(run.node.roundsAllowance ?? sessionMaxRounds(), opts.rounds);
    }
    if (sources.length > 0) {
      run.node.imageSources = sources;
    }
    run.items.push({ kind: 'user', text: userText, attachments });
    this.post({ type: 'user', text: userText, attachments });
    this.setBusy(true);
    this.lastStatus = vscode.l10n.t('Thinking…');
    this.post({ type: 'status', text: this.lastStatus });
    void run.agent.sendUserMessage(content, undefined, handoffCard ? handoffCard.handoffNote : undefined);
    return { ok: true, nodeId: run.node.id };
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
    // A compression card whose handoff is already written has nothing left for ▶ to do: the way
    // on is a send **below** it, which is what opens the window (`onUserMessage`). Running the
    // compression again from here would overwrite a handoff the user may already be using
    // (`docs/agents/invariants/compress-node.md`).
    if (isCompressNode(node) && hasHandoff(node)) {
      this.postNotice(
        'info',
        vscode.l10n.t('This compression already wrote its handoff; send a message below it to continue in the new window.'),
      );
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
   * Which **epoch change** the composer's one new-epoch entry would start right now, or
   * `null` when the checked-out chain is exactly on the setup and size it was built for.
   *
   * - `'context'` — the chain's window is `near` or `full` (`contextState`): the only
   *   answer is a compression card below it (`startPointerHandoff` / `compressHandoff`),
   *   because a request that the provider refused cannot be made to fit by changing a
   *   dropdown.
   * - `'drift'` — the chain's frozen setup and the live one disagree (`setupState`, whose
   *   `drift` covers **both** the user's dropdown pick and the harness's own change): the
   *   answer is a fork under the live setup (`forkTree`), so the old tree keeps the bytes
   *   — and the provider cache entry — it was built with.
   *
   * The order is deliberate: a full window wins, since preconditions and cost differ and
   * a fork of an oversized history would just refuse again on the new card.
   */
  newEpochTrigger(): 'context' | 'drift' | null {
    const node = this.viewNode();
    if (node && this.contextState(node) !== 'ok') {
      return 'context';
    }
    return this.setupState().drift !== false ? 'drift' : null;
  }

  /**
   * The prompt tokens of the checked-out chain's newest turn (0 when it has none) — the
   * number the setup-change modal quotes, because it is what the provider will have to
   * read again under the new configuration (`docs/agents/invariants/api-retries.md`).
   */
  chainPromptTokensLive(): number {
    const node = this.viewNode();
    return node ? this.chainPromptTokens(node) : 0;
  }

  /**
   * How full the checked-out chain's window is (`'ok' | 'near' | 'full'`) — the host-side
   * half of the composer's Send gate: a `full` window means the provider has already
   * refused that request, so a plain send is refused here too instead of being re-sent.
   */
  contextStateLive(): 'ok' | 'near' | 'full' {
    const node = this.viewNode();
    return node ? this.contextState(node) : 'ok';
  }

  /**
   * The structural preconditions of starting a **new context window** from this node: a
   * conversational node (not a sub-agent window / job card), not streaming, and with **no
   * conversational child** — a node that already has one has been rolled over (or the user
   * went on from it), and a second window must not start from the same card, or a replayed
   * click would open a sibling window beside the one it already opened.
   *
   * It says nothing about how full the window is: that is `canRollover`'s question, and a
   * deliberate entry (the composer's right-click, `compressNow`) may open a window from a
   * window that still has room.
   */
  private canWindowStart(nodeId: string): boolean {
    return this.windowStartBlocker(nodeId) === null;
  }

  /**
   * Why this node cannot start a new context window right now (`null` when it can), named so the
   * refusal can say the truth instead of one sentence for every case.
   *
   *  - `missing` — no such node, or a sidecar (a sub-agent window or a job card has no
   *    conversation of its own to hand over);
   *  - `running` — that card's own turn is streaming, or a window it already started is still
   *    being written (its compression turn, or the window below it).
   *
   * **A card that already continues below is not blocked.** Several attempts from one card are
   * allowed on purpose: the user compares `Simple` against `Agentic` by keeping both windows,
   * and the second attempt is simply a sibling branch. What the `running` clause prevents is
   * two handoffs of the same window running at once — one attempt at a time, as many attempts as
   * the user wants (`docs/agents/invariants/compress-node.md` §1).
   */
  windowStartBlocker(nodeId: string): 'missing' | 'running' | null {
    const node = this.session.nodes[nodeId];
    if (!node || isSidecar(node)) {
      return 'missing';
    }
    if (this.runs.has(nodeId)) {
      return 'running';
    }
    if (node.children.some((id) => !isSidecar(this.session.nodes[id]) && this.runs.has(id))) {
      return 'running';
    }
    return null;
  }

  /**
   * True when this node offers a **context** continuation: a window that can be started
   * *and* whose chain is at least near full (`contextState`, so the provider's refusal and
   * the 90% threshold both qualify). It is the same predicate the composer's new-epoch entry
   * uses to pick its backend, and it is public so `ChatViewProvider` can decide whether the
   * kill-confirmation is needed *before* anything has changed.
   */
  canRollover(nodeId: string): boolean {
    const node = this.session.nodes[nodeId];
    return this.canWindowStart(nodeId) && !!node && this.contextState(node) !== 'ok';
  }

  /**
   * True when a **window can be opened from this node right now**, whatever its fill level —
   * the precondition of both handoff answers (`docs/agents/invariants/compress-node.md`):
   * the Simple pointer card (`startPointerHandoff`) and the Agentic compression card
   * (`compressHandoff`).
   *
   * It is `canWindowStart` and nothing else on purpose. The user's own click is the trigger
   * here: a right-click on Send (or the composer's new-epoch entry) says "move this
   * conversation into a new window", and a window that still has room is a legitimate moment
   * to say it — `canRollover` keeps the *suggestion* at 90%.
   */
  canCompress(nodeId: string): boolean {
    return this.canWindowStart(nodeId);
  }

  /** True when this node is a compression card that already carries its handoff. */
  handoffReady(nodeId: string): boolean {
    return hasHandoff(this.session.nodes[nodeId]);
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
   * The **Simple** answer of the composer's window entry: open a compression card below
   * `nodeId` that carries the harness-written pointer handoff and runs **no turn at all**.
   *
   * The card is ready the moment it exists; the user continues by sending below it, which is
   * what opens the window (the compression-card branch of `onUserMessage`). See
   * `docs/agents/invariants/compress-node.md` and `docs/agents/invariants/context-rollover.md`;
   * the pointer text is the same one a rollover always carried:
   *
   *  - it points at this node's on-disk transcript, the original task and the last request
   *    verbatim, the files the window changed, and the killed-work list — so nothing has to be
   *    summarised and nothing is lost when a detail is needed;
   *  - this node is **also** union-killed first (the composer's Stop path): its background
   *    terminals and its whole sub-agent subtree cannot deliver into a full window, and their
   *    results would never reach the new one, so leaving them running would be work nobody can
   *    read. Their notices are written back into this node (the existing mechanism) and the
   *    transcript is re-dumped, so the window the card opens really can read what happened.
   *
   * Returns the new card's id, or null when a window cannot start here.
   */
  async startPointerHandoff(nodeId: string): Promise<string | null> {
    const node = this.session.nodes[nodeId];
    if (!node || isSidecar(node)) {
      return null;
    }
    if (!this.canWindowStart(nodeId)) {
      return null;
    }
    if (this.host.isHeld()) {
      this.postNotice(
        'warning',
        vscode.l10n.t('An external controller is rebooting the window; please wait a moment.'),
      );
      return null;
    }
    // The facts the pointer carries — captured **before** the union kill, because the kill
    // appends its notices to this node as `role:'user'` messages, and none of those is the
    // request the user actually made. The window's source is selected the same way, from the
    // context base down (`docs/agents/invariants/context-rollover.md` §7).
    const handoff = await this.prepareHandoff(node);
    const message = buildContextRolloverMessage({
      reason: this.rolloverReason(node),
      sessionId: this.sessionId,
      previousNodeId: node.id,
      transcriptPath: this.rolloverTranscriptPath(node.id),
      transcriptExists: this.rolloverTranscriptOnDisk(node.id),
      request: handoff.carry.request,
      attachments: handoff.carry.attachments,
      answer: handoff.carry.answer,
      firstRequest: handoff.firstRequest,
      files: handoff.files,
      killedBackground: handoff.killedBackground,
      killedSubAgents: handoff.killedSubAgents,
      usage: handoff.usage,
    });
    return this.createHandoffCard(node, message).id;
  }

  /**
   * The context windows on this node's own path, compression cards excluded: a compression
   * card is a boundary between two windows, not a window of its own, and a session's first
   * window is window 1 even though no card starts it.
   */
  private windowsOnPath(node: TreeNode): number {
    return pathIds(this.session, node.id).filter((id) => {
      const n = this.session.nodes[id];
      return !!n && n.contextBaseId === id && n.role !== 'compress';
    }).length;
  }

  /** The window number a send below `card` opens: `Context window {n}`, one per send. */
  private producedWindowNumber(card: TreeNode): number {
    const produced = card.children.filter((id) => this.session.nodes[id]?.role === 'resume').length;
    return this.windowsOnPath(card) + 2 + produced;
  }

  /**
   * Create the compression card below `previous` that already carries `note` as its handoff,
   * and nothing else: this is the Simple answer's whole action, and there is no turn. The card
   * is a `role:'compress'` node with its own context base and a title that names the window it
   * compressed, drawn by the webview exactly like the Agentic card (which `beginTurn` builds,
   * so it also gets an envelope; a card that runs no turn sends nothing and needs none).
   *
   * The old line stays killed (the conversation continues **below** the card, in a window a
   * later send opens), and the note is pushed as the card's one harness item so the user can
   * read, on the card, exactly what the window below will start with.
   */
  private createHandoffCard(previous: TreeNode, note: string): TreeNode {
    const node = createNode(
      newId(),
      previous.id,
      vscode.l10n.t('Compression of window {0}', this.windowsOnPath(previous) + 1),
      'done',
    );
    node.role = 'compress';
    node.compressedFrom = previous.id;
    node.contextBaseId = node.id;
    node.handoffNote = note;
    attachNode(this.session, node);
    // The window this card opens is written by a send, so the old line stays killed.
    this.stoppedLines.add(previous.id);
    node.displayItems.push({ kind: 'harness', text: note });
    this.post({ type: 'harnessNote', nodeId: node.id, text: note });
    this.post({ type: 'nodeUpdate', ...this.nodeStatePatch(node) });
    this.postTree('handoff-card');
    this.postPath('handoff-card');
    this.persistTurn();
    return node;
  }

  /**
   * Every display item of one **window** — its context base down to the node, in order.
   * The same slice `pathMessages` sends, which is what makes "the files this window
   * changed" mean the window and not the branch above it.
   */
  private windowDisplayItems(node: TreeNode): DisplayItem[] {
    const ids = pathIds(this.session, node.id);
    const base = contextBase(this.session, node.id);
    const from = base ? ids.indexOf(base) : 0;
    const items: DisplayItem[] = [];
    for (const id of ids.slice(from)) {
      const current = this.session.nodes[id];
      if (current) {
        items.push(...current.displayItems);
      }
    }
    return items;
  }

  /**
   * Everything both handoff answers need from the window that is ending, in the order
   * `docs/agents/invariants/context-rollover.md` §7 requires:
   *
   *  1. **capture first** — the carried-over tail, the first request, the changed files and
   *     the compression source, all read *before* the kill, because the union kill appends
   *     its own `role:'user'` notices to this node and none of them is a user request;
   *  2. **the union kill** (`stopNode`, the composer's Stop path) with its settle wait:
   *     a killed sub-agent writes its dump in its `finish` handler, so the list would
   *     otherwise be a guess;
   *  3. `flushWritebacks()` and an explicit **re-dump** — the kill's record is the only
   *     durable copy of what those terminals produced, and `finishTurn` is not the one
   *     writing it here.
   */
  private async prepareHandoff(node: TreeNode): Promise<HandoffFacts> {
    const window = pathMessages(this.session, node.id);
    const carry = this.carriedOver(node);
    const firstRequest = firstUserRequest(window);
    const files = editedFilesFromItems(this.windowDisplayItems(node));
    const source = extractCompactionSource(window);
    const usage = this.rolloverUsage(node);
    // The tasks are captured before the kill: the hub forgets the *running* snapshot once
    // they are settled, and their final state is what the new window's message names.
    const killedJobs = this.hub.listForNode(this.sessionId, node.id).filter((task) => task.status === 'running');
    const killedAgents = this.subAgentSubtree(node.id);
    this.stopNode(node.id);
    await this.settleSubAgents();
    this.flushWritebacks();
    this.host.dumpSessionTranscript(node, this.session, node.status);
    return {
      previous: node,
      carry,
      firstRequest,
      files,
      source,
      usage,
      killedBackground: killedJobs.map((task) => ({
        id: task.id,
        command: clipText(task.command, 80),
        state: task.killed ? 'stopped by the rollover' : `finished with exit code ${task.exitCode ?? 'unknown'}`,
      })),
      killedSubAgents: killedAgents.map((id) => ({
        nodeId: id,
        transcript: this.session.nodes[id]?.agentTranscript,
      })),
    };
  }

  /**
   * A notice that belongs to **one card** rather than to the view focus: it is stored in
   * that node's own transcript (so a reload still shows it) and routed by id. Used for the
   * compression chain's own reports, which are about a card the user may not be standing on
   * when the chain ends.
   */
  private postNoticeTo(nodeId: string, kind: 'warning' | 'info', text: string): void {
    const node = this.session.nodes[nodeId];
    if (!node) {
      return;
    }
    node.displayItems.push({ kind: 'notice', noticeKind: kind, text });
    this.post({ type: 'notice', nodeId, kind, text });
    this.persistTurn();
  }

  /**
   * Continue the conversation in a window whose handoff a **turn** wrote — the Agentic answer
   * (`docs/agents/invariants/compress-node.md`).
   *
   * Two steps, not three: this method runs the **compression card** C below the window P and
   * stops there. C's turn reads P's transcript and the workspace and answers with the handoff;
   * when it ends, `finishHandoff` stores that answer on C (`handoffNote` / `handoffSummary`) and
   * the card becomes **ready**. The window itself is opened by the user's next send below the
   * card (the compression-card branch of `onUserMessage`) — or by the auto-send after
   * "Compress and send", which is the same path. So there is never a turn emitted from here
   * that nobody asked for, and a card may carry several windows, one per send.
   *
   *   P (the window being compressed) ──> C (the compression card) ──> R (opened by a send)
   *
   * C is a real turn node: its own context base, its own frozen envelope (the compression
   * template, the read-only tool set) and its own agent. R will inherit **P's** envelope — never
   * C's — so the window that continues the conversation sends the bytes the conversation was
   * written in, and its first message is C's handoff.
   *
   * Returns C's id once it is ready (`hasHandoff`), or null when nothing started, when C was
   * stopped, or when C answered nothing — in which case the card keeps its ▶ and the user can
   * run it again.
   */
  async compressHandoff(nodeId: string): Promise<string | null> {
    const node = this.session.nodes[nodeId];
    if (!node || isSidecar(node)) {
      return null;
    }
    if (!this.canWindowStart(nodeId)) {
      return null;
    }
    if (this.host.isHeld()) {
      this.postNotice(
        'warning',
        vscode.l10n.t('An external controller is rebooting the window; please wait a moment.'),
      );
      return null;
    }
    const handoff = await this.prepareHandoff(node);
    // The number the window a send below the card will open carries. The compression card is
    // titled after the window it **compresses**, which is this number minus one; the card itself
    // counts as no window at all (`windowsOnPath` skips it), so the two formulas agree.
    const nextWindow = this.windowsOnPath(node) + 2;
    const instruction = buildCompressInstruction({
      sessionId: this.sessionId,
      previousNodeId: node.id,
      transcriptPath: this.rolloverTranscriptPath(node.id),
      transcriptExists: this.rolloverTranscriptOnDisk(node.id),
      source: handoff.source,
      files: handoff.files,
      usage: handoff.usage,
      killedBackground: handoff.killedBackground,
      killedSubAgents: handoff.killedSubAgents,
    });
    // The compression card: its own window, its own envelope (a fresh freeze — `epochFrom:
    // null`), its own role. `pan` keeps the view on the node the user just caused.
    const run = this.beginTurn(vscode.l10n.t('Compression of window {0}', nextWindow - 1), {
      parentId: nodeId,
      freshContext: true,
      epochFrom: null,
      role: 'compress',
      compressedFrom: nodeId,
    });
    if (!run) {
      this.setBusy(this.runs.size > 0);
      return null;
    }
    // `beginTurn` treats the basis node as "the user is continuing this line"; here the
    // conversation continues below the card, so the old line stays killed.
    this.stoppedLines.add(nodeId);
    run.items.push({ kind: 'harness', text: instruction });
    this.post({ type: 'harnessNote', nodeId: run.node.id, text: instruction });
    this.setBusy(true);
    this.lastStatus = vscode.l10n.t('Thinking…');
    this.post({ type: 'status', text: this.lastStatus });
    this.post({ type: 'nodeUpdate', ...this.nodeStatePatch(run.node) });
    const startedAt = Date.now();
    void run.agent.sendUserMessage(instruction);
    // The turn's **real** end, not a timer: `finishTurn` resolves this whatever the status,
    // so a Stop is an ordinary outcome here and the card simply stays not-ready.
    await run.settled;
    return this.finishHandoff(run, handoff, startedAt);
  }

  /**
   * The second half of `compressHandoff`: read what the compression card produced and store it
   * **on that card**. No window is opened here and nothing is sent — a send below the card does
   * that later, so this method's only job is to turn the card ready.
   *
   * The four outcomes are all normal:
   *
   *  - **stopped / interrupted** — no handoff is written. The card stays as the record of a
   *    stopped turn and ▶ Continue is still its way to try again.
   *  - **empty answer** — one notice on the card and no handoff: a handoff that says nothing
   *    would open a window whose first message says nothing.
   *  - **missing required sections** — one notice naming them and one `[compression]` line, and
   *    the handoff is stored anyway: the answer is still the only one that exists.
   *  - **a usable handoff** — it goes on the card and the card is ready.
   */
  private finishHandoff(run: TurnRun, handoff: HandoffFacts, startedAt: number): string | null {
    const node = run.node;
    if (this.dead || !this.session.nodes[node.id]) {
      return null;
    }
    const answered = node.status === 'done' ? this.compressionAnswer(node) : '';
    const verdict =
      node.status === 'done' ? classifyCompactionAnswer({ text: answered }) : classifyCompactionAnswer({ failed: 'error' });
    // One line per compression: in, out, how long, and what came out of it — "the handoff
    // was written by a turn" is otherwise unverifiable in a real window.
    perf(
      compactionDiagLine({
        inputChars: handoff.source.chars,
        outputTokens: nodeUsage(node)?.completion_tokens ?? 0,
        ms: Date.now() - startedAt,
        outcome: verdict.ok ? 'summary' : verdict.reason,
      }),
    );
    if (node.status !== 'done') {
      this.postNoticeTo(
        node.id,
        'info',
        vscode.l10n.t('Compression stopped, so no handoff was written. Continue this card to run it again.'),
      );
      return null;
    }
    if (!verdict.ok && verdict.reason === 'empty') {
      this.postNoticeTo(
        node.id,
        'warning',
        vscode.l10n.t('The compression returned no answer, so there is no handoff. Continue this card to run it again.'),
      );
      return null;
    }
    const summary = verdict.ok ? verdict.summary : answered.trim();
    if (!verdict.ok) {
      const missing = missingCompactionSections(summary);
      this.host.output.appendLine(
        `[compression] ${node.id} is missing ${missing.length} required section(s): ${missing.join(', ')}`,
      );
      this.postNoticeTo(
        node.id,
        'warning',
        vscode.l10n.t(
          'The compression is missing {0} required section(s): {1}. The handoff was stored anyway.',
          missing.length,
          missing.join(', '),
        ),
      );
    }
    const previous = handoff.previous;
    // The handoff, stored **on the card**: it is what a send below it leads the new window
    // with, and its presence is the whole definition of "ready" (`hasHandoff`). The card
    // itself started no conversation, so it keeps no `handoff` / `handoffSummary` of its own.
    node.handoffNote = buildContextRolloverMessage({
      // The window ended because it was **compressed**, which is neither a refusal nor the
      // 90% entry: the size line states the number without claiming why.
      reason: 'compress',
      sessionId: this.sessionId,
      previousNodeId: previous.id,
      transcriptPath: this.rolloverTranscriptPath(previous.id),
      transcriptExists: this.rolloverTranscriptOnDisk(previous.id),
      request: handoff.carry.request,
      attachments: handoff.carry.attachments,
      answer: handoff.carry.answer,
      firstRequest: handoff.firstRequest,
      files: handoff.files,
      killedBackground: handoff.killedBackground,
      killedSubAgents: handoff.killedSubAgents,
      usage: handoff.usage,
      summary,
    });
    node.handoffSummary = summary;
    this.persistTurn();
    this.post({ type: 'nodeUpdate', ...this.nodeStatePatch(node) });
    this.postTree('handoff-ready');
    return node.id;
  }

  /**
   * The handoff a compression node produced: its last assistant **text**, from the messages
   * it stored (the API truth), falling back to its transcript item when the turn's slice
   * was not stored. An empty string means it said nothing usable.
   */
  private compressionAnswer(node: TreeNode): string {
    for (let i = node.messages.length - 1; i >= 0; i--) {
      const message = node.messages[i];
      if (message.role === 'assistant') {
        const text = messageText(message.content).trim();
        if (text) {
          return text;
        }
      }
    }
    for (let i = node.displayItems.length - 1; i >= 0; i--) {
      const item = node.displayItems[i];
      if (item.kind === 'assistant' && item.text && item.text.trim()) {
        return item.text.trim();
      }
    }
    return '';
  }

  /**
   * How full the window that is being rolled over was: the chain's newest prompt usage
   * against the window of the card that chain sends with. `undefined` when either number
   * is unknown — the harness message then says nothing about the size rather than
   * inventing one.
   */
  private rolloverUsage(node: TreeNode): { used: number; window: number; pct: number } | undefined {
    const used = this.chainPromptTokens(node);
    const window = this.host.getContextWindow(this.chainCard(node).id);
    if (used <= 0 || !window || window <= 0) {
      return undefined;
    }
    return { used, window, pct: Math.min(100, Math.round((used / window) * 100)) };
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
    this.postTree('fork');
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
   * `interrupt_session`: end the live work **this caller's prompts started** in this
   * session, and nothing else.
   *
   * The scope is a filter over nodes, not a position in the tree: a node qualifies
   * when its `lastFrom` names `callerSessionId` and it is still live. A line a human
   * started carries no `lastFrom` and another agent's line carries a different one,
   * so neither can be reached — not by a check that could be got wrong, but because
   * they are not in the set (`docs/agents/plans/session-prompt-addressing.md` §2.3).
   *
   * `untouched` reports what was live and was not ours, so the caller can report back
   * instead of guessing why nothing died.
   */
  interruptLines(callerSessionId: string): {
    lines: Array<{ nodeId: string; turn: boolean; terminals: number; subAgents: number; ranMs: number }>;
    untouched: Array<{ nodeId: string; by: 'human' | string }>;
  } {
    const lines: Array<{ nodeId: string; turn: boolean; terminals: number; subAgents: number; ranMs: number }> = [];
    const untouched: Array<{ nodeId: string; by: 'human' | string }> = [];
    for (const node of Object.values(this.session.nodes)) {
      if (isSidecar(node)) {
        continue;
      }
      const run = this.runs.get(node.id);
      const live = run != null || this.lockedWorkCount(node.id) > 0;
      if (!live) {
        continue;
      }
      if (node.lastFrom?.sessionId !== callerSessionId) {
        untouched.push({ nodeId: node.id, by: node.lastFrom?.sessionId ?? 'human' });
        continue;
      }
      // Snapshot the facts before the kill: `stopNode` tears them down.
      const terminals = this.hub
        .listForNode(this.sessionId, node.id)
        .filter((task) => task.status === 'running').length;
      const subAgents = this.subAgentSubtree(node.id).length;
      const ranMs = run ? Date.now() - run.startedAt : 0;
      this.stopNode(node.id);
      lines.push({ nodeId: node.id, turn: run != null, terminals, subAgents, ranMs });
    }
    return { lines, untouched };
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
      this.renderSignalCards(nodeId, batch, false);
      // …and the interrupt travels with the next request instead of starting one.
      node.messages = [...node.messages, { role: 'user', content: combineSignalText(batch) }];
      this.persistTurn();
      this.postTree('signal-cards');
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
          this.post({
            type: 'usage',
            // The card's **running totals**, so the docked bar counts the whole card rather
            // than the request that just finished.
            usage: nodeUsageTotal(run.node),
            nodeId: run.nodeId,
            // The card's rate **as it stands after this request**, so the docked bar updates
            // live with the counts rather than waiting for the `nodeUpdate` that ends the
            // turn (`docs/agents/invariants/chat-tree.md`).
            cachePct: nodeCacheRate(run.node) ?? null,
          });
          // Recompute the session totals after this turn's usage is attached to
          // the display items, so the cumulative counters include the turn just
          // finished.
          this.postSessionStats();
        }
        break;
      case 'toolCallDelta':
        if (run) this.queueToolCallDelta(run, event.index, event.id, event.name);
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
            // The model's own label for this step, stored on the item: the UI's row
            // reads it back on a repaint instead of deriving one from (the clipped)
            // arguments. Absent when the call carried no `title`.
            title: toolTitleFromArgs(event.args),
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
            title: toolTitleFromArgs(event.args),
            index: event.index,
            nodeId: run.nodeId,
            startedAt: event.startedAt,
          });
        }
        break;
      case 'toolEnd':
        if (run) {
          const result = takeLineDiff(event.content);
          this.updateToolItem(run, event.id, result.content, event.ms, result.diff);
          this.post({
            type: 'toolEnd',
            id: event.id,
            name: event.name,
            content: clipForUi(result.content),
            diff: result.diff,
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

  private queueToolCallDelta(run: TurnRun, index: number, id?: string, name?: string): void {
    const existing = run.pendingTools.get(index) ?? { id, name: '' };
    if (id) {
      existing.id = id;
    }
    if (name) {
      existing.name += name;
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
        // The draft row is one fixed line in the webview (`addLiveTool`), so the arguments
        // would be a payload nothing renders: they travel once, with `toolStart`, from the
        // call's settled `args`. A call's arguments were the bulk of what this loop used to
        // carry (up to 8 KiB per flush, per call), so this is a net reduction.
        this.post({
          type: 'toolCallDelta',
          index,
          id: draft.id,
          name: draft.name,
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

  private updateToolItem(
    run: TurnRun,
    id: string,
    content: string,
    ms: number,
    diff?: { add: number; del: number },
  ): void {
    const item = run.items.find((it) => it.kind === 'tool' && it.id === id);
    if (item) {
      item.status = 'done';
      item.content = clipForUi(content);
      // The line diff of a file-modifying call, taken off the result by the caller: it
      // is stored with the item so the card's chip is still there after a repaint.
      if (diff) item.diff = diff;
      // `item.title` is deliberately untouched: it was read out of the call's
      // arguments when the item was created (`toolTitleFromArgs`) and the update
      // carries no arguments to read it from again — a step's label may not
      // disappear because its result arrived.
      // The call's own duration: the card freezes on it, and the start clock goes
      // away with it (the pair is "running" or "took this long", never both).
      item.ms = ms;
      // `startedAt` is kept, unlike before: it is the only record of **when** the call
      // ended, and an image row compares a file's mtime against that moment to say whether
      // the pixels it shows are still the ones the call was sent. Nothing reads it for a
      // done row except that comparison — the chip is driven by `ms` alone.
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
    // The three management tools travel with `exec_command`, because this model promotes
    // a foreground command by itself: a sub-agent's `npm run compile` becomes a
    // background job after `spinney.execForegroundSeconds`, and the id it is handed is
    // worthless unless it can read, wait for or end that job. Read-only sub-agents keep
    // none of the four (see the block below).
    const writeTools = [
      'write_file',
      'replace_in_file',
      'append_file',
      'exec_command',
      'check_command',
      'wait_for_command',
      'kill_command',
    ];
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
    // `spinney.subAgentSyncSeconds`, and a target that is still running when that
    // window runs out stops holding the turn — the result is delivered later through
    // the same batch-notice path `async` uses (`deliverResumeAsync`).
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
    const limitMs = subAgentSyncSeconds() * 1000;
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
      this.postTree('agent-resume');
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
    this.postTree('spawn-agents');

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
    // for it. `Promise.race` gives up at `spinney.subAgentSyncSeconds` and the batch is
    // then delivered by the *async* path — one batch notice when the last job finishes
    // — instead of by this tool result.
    //
    // INVARIANT — the batch is delivered **exactly once**: on the normal path the tool
    // result is the only delivery (it settles the cards below, D1) and no notice is ever
    // queued; on the escape path the batch notice is the only delivery (it settles the
    // cards when it lands, `settleSignals`). That is why the escape branch must not
    // touch `job.node.delivered`: marking it here would make the notice render as an
    // already-delivered batch and the summaries would never reach the model.
    const limitMs = subAgentSyncSeconds() * 1000;
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
    this.postTree('spawn-agents-sync');
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
      // **Not** the parent's conversation: a sub-agent sends its own history, so it names
      // its own — the node it lives on, which survives a resume of that same sub-agent.
      // Sharing the parent's id would tell the provider two different prefixes are one
      // conversation.
      sub.setProviderSession(job.node.id);
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
        this.post({ type: 'toolStart', id: event.id, name: event.name, args: clipForUi(event.args, 8 * 1024), title: toolTitleFromArgs(event.args), index: event.index, nodeId: id, startedAt: event.startedAt });
        break;
      case 'toolEnd':
        {
          const result = takeLineDiff(event.content);
          this.commitSubToolResult(items, event.id, result.content, event.ms, result.diff);
          this.post({ type: 'toolEnd', id: event.id, name: event.name, content: clipForUi(result.content), diff: result.diff, nodeId: id, ms: event.ms });
        }
        break;
      case 'usage':
        this.commitSubUsage(items, event.usage);
        this.post({ type: 'usage', usage: nodeUsageTotal({ displayItems: items }), nodeId: id, cachePct: nodeCacheRate({ displayItems: items }) ?? null });
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
    items.push({
      kind: 'tool',
      id,
      name,
      args: clipForUi(args, 8 * 1024),
      title: toolTitleFromArgs(args),
      status: 'running',
      startedAt,
    });
  }

  private commitSubToolResult(
    items: DisplayItem[],
    id: string,
    content: string,
    ms: number,
    diff?: { add: number; del: number },
  ): void {
    const item = items.find((it) => it.kind === 'tool' && it.id === id);
    if (item) {
      item.status = 'done';
      item.content = clipForUi(content);
      if (diff) item.diff = diff;
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
   * `list_nodes` tool: render one session's tree, the read half of the session
   * surface. Node ids are for reading: no tool takes one as an address any more, so
   * they live in the persisted tree and in this render, nowhere else.
   *
   * `node` is the caller's own node (P3 binds the handler per node) and decides the
   * default session; `args.session_id` reads **another** session, whose live state
   * comes from the provider (`runningNodesIn` / `lockedNodesIn`) because a runtime
   * only owns its own session.
   *
   * Every node line carries its **true** state, never a stored status field:
   * `running` comes from that session's live runs, `busy` from `lockedNodes()`
   * (unfinished work that refuses a send), and `checked out` only for the session
   * this window is focused on — a checkout belongs to the window's view, not to a
   * conversation. A session with no runtime is idle by definition: a turn only runs
   * inside a runtime, so there is no run and nothing to report, and reading
   * `node.status` instead would resurrect a turn that ended before a reload.
   */
  private handleListNodes(node: TreeNode, args: Record<string, unknown>): string {
    const wanted = typeof args.session_id === 'string' ? args.session_id.trim() : '';
    const target = wanted
      ? this.host.sessionForTool(wanted)
      : {
          session: this.session,
          active: this.host.sessionForTool(this.sessionId)?.active === true,
        };
    if (!target) {
      return `Error: no such session: ${wanted} (list_sessions lists the session ids).`;
    }
    const session = target.session;
    const own = session.id === this.sessionId;
    const running = new Set(own ? this.runningNodes() : this.host.runningNodesIn(session.id));
    const busy = new Set(own ? this.lockedNodes() : this.host.lockedNodesIn(session.id));
    const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
    const depthOf = (n: TreeNode): number => {
      let depth = 0;
      let parent = n.parentId ? session.nodes[n.parentId] : undefined;
      while (parent && depth < 64) {
        depth++;
        parent = parent.parentId ? session.nodes[parent.parentId] : undefined;
      }
      return depth;
    };
    const ordered = Object.values(session.nodes).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    const shown = query
      ? ordered.filter((n) => n.id.toLowerCase().includes(query) || (n.title ?? '').toLowerCase().includes(query))
      : ordered;
    const lines = shown.map((n) => {
      const kindMark = n.kind === 'agent' ? 'agent' : n.kind === 'bg' ? 'bg' : 'turn';
      const marks = [
        kindMark,
        running.has(n.id) ? 'running' : '',
        busy.has(n.id) ? 'busy' : '',
        n.delivered ? 'delivered' : '',
        n.lastFrom ? `from=${n.lastFrom.sessionId}/${n.lastFrom.nodeId}` : '',
        typeof n.roundsAllowance === 'number' ? `rounds=${n.roundsAllowance}` : '',
      ].filter(Boolean);
      if (target.active && n.id === session.activeNodeId) {
        marks.push('checked out');
      }
      const parent = n.parentId ? ` parent=${n.parentId}` : '';
      return `${'  '.repeat(depthOf(n))}- ${n.id}  [${marks.join(', ')}]${parent}  ${n.title}`;
    });
    const header = [
      `session ${session.id} "${session.title}" — ${ordered.length} node(s)`,
      `active: ${session.activeNodeId ?? '(none)'}`,
      `running: ${running.size}`,
      `busy: ${busy.size}`,
      target.active ? 'this window is focused on it' : 'not the focused session, so no node is checked out here',
      query ? `filter "${query}": ${shown.length} match(es)` : '',
    ]
      .filter(Boolean)
      .join(', ');
    return [header, ...(lines.length > 0 ? lines : ['  (no node matches the filter)'])].join('\n');
  }

  /** `list_sessions` tool: the provider owns the session list, so it renders it. */
  private handleListSessions(args: Record<string, unknown>): string {
    return this.host.handleListSessions(args);
  }

  /**
   * `create_session` tool: the provider owns session creation and persistence.
   * `node` names the caller, because the answer has to say where a report should
   * come back to.
   *
   * Its first message is an **agent-written** user message into another session, so it
   * pays the same round `send_session_prompt` pays and hands the child what is left.
   * Handing a fresh ceiling instead let an agent refill the brake by opening a session
   * rather than continuing a line — the only reset in this design is a human's own
   * message (`docs/agents/plans/session-prompt-addressing.md` §8.6).
   */
  private async handleCreateSession(node: TreeNode, args: Record<string, unknown>): Promise<string> {
    // No declared budget: `create_session` has no `max_rounds` argument, so the round it
    // spends comes off the ceiling, exactly as a prompt with no inherited allowance does.
    const spent = this.spendExchangeRound(node);
    if (!spent.ok) {
      return spent.error;
    }
    const result = await this.host.handleCreateSession(this, node, args, spent.roundsLeft);
    if (result.startsWith('Error:')) {
      this.refundExchangeRound(node, spent.previous);
    }
    return result;
  }

  /**
   * `send_session_prompt` tool. The **allowance** is the caller node's business (it is
   * the node a reply comes back to), so it is resolved here; the provider owns every
   * session's live state, and whether the target can take a turn is its answer.
   */
  private async handleSendSessionPrompt(node: TreeNode, args: Record<string, unknown>): Promise<string> {
    const raw = args.max_rounds;
    const declared = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : Number.NaN;
    if (!Number.isFinite(declared) || declared < 1) {
      return (
        'Error: "max_rounds" is required and must be an integer of at least 1 (how many rounds this exchange may still use). ' +
        'Count the exchanges you actually need and state it.'
      );
    }
    const spent = this.spendExchangeRound(node, declared);
    if (!spent.ok) {
      return spent.error;
    }
    const result = await this.host.handleSendSessionPrompt(args, this.sessionId, spent.roundsLeft, {
      sessionId: this.sessionId,
      nodeId: node.id,
    });
    if (result.startsWith('Error:')) {
      this.refundExchangeRound(node, spent.previous);
    }
    return result;
  }

  /**
   * Spend **one round** of the inter-session exchange on `node`, and answer how many the
   * receiver inherits. This is the one arithmetic both agent-written prompts share:
   * `send_session_prompt`, which declares its budget, and `create_session`'s first
   * message, which does not (so it comes off the ceiling).
   *
   * `min()` never raises, so a session can use less than it was handed and never buys
   * more; the ceiling is `spinney.sessionMaxRounds`, read live; and the only reset is a
   * human's own message on that line. A node with nothing left is refused here rather
   * than at the provider, because the budget belongs to the caller's line.
   */
  private spendExchangeRound(
    node: TreeNode,
    declared?: number,
  ): { ok: true; roundsLeft: number; previous: number | undefined } | { ok: false; error: string } {
    const cap = sessionMaxRounds();
    const inherited = typeof node.roundsAllowance === 'number' ? node.roundsAllowance : undefined;
    if (inherited !== undefined && inherited <= 0) {
      return {
        ok: false,
        error:
          "Error: this line's exchange allowance is used up (no rounds left; the ceiling is " +
          `${cap} per exchange since the last human message), so nothing was sent. ` +
          'Report back to your user (or wait for a human message on this line) instead of sending it from another session.',
      };
    }
    const effective = Math.min(declared ?? (inherited ?? cap), inherited ?? cap, cap);
    const previous = node.roundsAllowance;
    node.roundsAllowance = effective - 1;
    return { ok: true, roundsLeft: effective - 1, previous };
  }

  /**
   * Give a spent round back. A refusal costs the sender nothing: a busy target, a
   * torn-down window or a bad `session_id` must not eat into the budget that is what
   * stops two agents answering each other unattended.
   */
  private refundExchangeRound(node: TreeNode, previous: number | undefined): void {
    node.roundsAllowance = previous;
  }

  /** `wait_for_session_idle` tool: the provider holds every session's live runs. */
  private handleWaitForSessionIdle(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    return this.host.handleWaitForSessionIdle(args, this.sessionId, signal);
  }

  /** `interrupt_session` tool: the provider holds every session's live runs. */
  private handleInterruptSession(args: Record<string, unknown>): Promise<string> {
    return this.host.handleInterruptSession(args, this.sessionId);
  }

  // ---- Background terminals ----

  private toBackgroundInfo(owner: BackgroundOwner, task: BackgroundTask): BackgroundInfo {
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
      outputTail: backgroundOutputTail(task),
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
    // …and the window-global dock, which lists this session's jobs in every tab of
    // the window (the provider coalesces its own snapshot, ~200 ms, the same way).
    this.host.backgroundsChanged();
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
   *
   * The card is born knowing **how the job started** (`bgDetached`), not told at the
   * end. It is a durable fact of the registration — and the window-global dock needs it
   * for a record whose process is gone, so that a reload draws the same dock. Writing it
   * here means the flag does not depend on which terminal path ran: the window's own
   * teardown disposes the runtime *before* it kills the jobs (`dispose()` → `dead`), so
   * `onBackgroundFinished` returns before it could snapshot anything, and a global job
   * that was still running when the window closed would otherwise lose its flag and its
   * dock row. `snapshotBackgroundCard` keeps writing it as well, because a task that
   * carries the flag is what the readers of the terminal state look at.
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
    node.bgDetached = task.detached === true ? true : undefined;
    attachNode(this.session, node);
    this.session.activeNodeId = prevActive;
    this.bgNodes.set(task.id, node.id);
    this.persistTurn();
    this.postTree('bg-register');
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
      // job was never the agent's to wait for. It asks instead: `check_command` or
      // `wait_for_command`.
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
    // A durable fact about **how the job started**, not a lock or notice claim: the
    // window-global dock lists a record whose process is gone by this flag, so a reload
    // draws the same dock. It is written at registration already; written again here so a
    // task read at its terminal end cannot settle a record that disagrees with it. (The
    // `global` badge keeps reading the live task — `backgroundTaskDetached` — because a
    // lock story cannot be verified later.)
    node.bgDetached = task.detached === true ? true : undefined;
    node.bgExitCode = task.exitCode;
    node.bgKilled = task.killed === true;
    // The card's own frozen duration (the hub is in-memory, so this is what a
    // restored record card shows); `finishedAt` is exact, `Date.now()` is only the
    // fallback for a task that somehow finished without going through `complete()`.
    node.bgElapsedMs = Math.max(0, (task.finishedAt ?? Date.now()) - task.startedAt);
    node.bgOutputTail = out.length > 800 ? `…${tailText(out, 800)}` : out;
    node.status = task.killed ? 'interrupted' : 'done';
    this.persistTurn();
    this.postTree('bg-complete');
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
    // The model's own title, when the call carried one: the notice is read by a person, and
    // "Running the test suite" beats the command line it stood for.
    const cmd = this.truncateField(task.title || task.command, 100);
    // How long the job ran. `finishedAt` is set by the registry's `complete()`, which
    // every ending goes through (natural exit, kill, session teardown).
    const took = formatDuration((task.finishedAt ?? Date.now()) - task.startedAt);
    // A job has no deadline any more, so there are exactly two endings to report: it
    // exited on its own, or something killed it (the composer's Stop, the card's kill,
    // kill_command, `interrupt_session`, or the session going away). The verdict
    // replaces the whole clause, which is why the sentence is assembled from it rather
    // than from `outcome` + `after …`. It does not say **who** killed it: since
    // `interrupt_session` an agent can end a line too, so "by the user" would be a lie
    // half the time.
    const verdict = task.killed
      ? `was stopped after ${took}`
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
        const orphaned = this.takePendingSignals(nodeId, { settleStale: false });
        this.settleSignals(orphaned);
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
        this.renderSignalCards(nodeId, batch, true);
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
      // The notice opens this round: it is a boundary in the log, not a step of the run
      // above it (`round: true` — see `renderSignalCards`).
      this.renderSignalCards(nodeId, batch, true);
      this.lastStatus = batch.some((s) => s.kind === 'subagent')
        ? vscode.l10n.t('Sub-agents finished')
        : vscode.l10n.t('Background terminal finished');
      this.setBusy(true);
      this.post({ type: 'status', text: this.lastStatus });
      // Re-affirm the view in the webview BEFORE the turn streams: a nested sub-agent
      // spawn may have left the webview pinned to a sub-agent card, and this injected
      // turn has no `path`/`tree` round-trip of its own. postPath follows the view
      // focus, so the reply cannot leak into a sub-agent card.
      this.postPath('injected-turn');
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
   *
   * `startsRound` says what the block **is** in the log, and the two cases are not the
   * same thing: a notice delivered at a tool boundary of a running turn is one step of
   * that run, while a notice that triggers the very next turn (`beginInjectedTurn`, or a
   * resumed sub-agent run) is a **boundary** — it ends the run above it, and the round it
   * opens gets its own `Ran N steps`. The flag travels on the item, so a repaint divides
   * the log the same way the live turn did.
   */
  private renderSignalCards(nodeId: string, batch: SignalNotice[], startsRound = false): void {
    const node = this.session.nodes[nodeId];
    for (const signal of batch) {
      if (signal.taskId != null) {
        this.markDelivered(signal.taskId);
      }
      if (node) {
        node.displayItems.push({
          kind: 'background',
          // The item's own `kind` can only say `background`; the producer is what a repaint
          // needs to draw the same notice the live turn drew (`producer`).
          producer: signal.card.kind,
          id: String(signal.card.id),
          name: signal.card.name,
          doneText: signal.card.doneText,
          content: signal.card.content,
          round: startsRound || undefined,
        });
      }
      this.post({
        type: 'backgroundNotice',
        nodeId,
        item: { ...signal.card, round: startsRound || undefined },
      });
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
      this.postTree('deliver');
      // `delivered` is also what the window-global dock says (`Delivered`, and "pending
      // delivery" against the job's own exit code), and no background snapshot otherwise
      // announces it: the dock is reposted together with the cards.
      this.host.backgroundsChanged();
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
    this.uploadBaseId = null;
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
    this.postTree('clear');
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
    this.postTree('branch-delete');
    this.postPath('branch-delete');
    if (this.session.activeNodeId) {
      this.post({ type: 'panTo', id: this.session.activeNodeId });
    }
    this.postContext();
    this.postSessionStats();
  }
}
