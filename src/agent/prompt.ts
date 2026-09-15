import { harnessLog } from '../perf';
import { agentRootInfo } from '../tools';
import { getShell } from '../tools/shell';
import { DEFAULT_MODEL } from './models';
import { ThinkingEffort } from './types';

/**
 * The system prompts, in one file, verbatim.
 *
 * Static text is written out; the few runtime values are `{{placeholder}}`
 * holes filled by {@link renderPromptTemplate}:
 *
 *   {{identity}}    who the agent is (harness name + model card + reasoning level)
 *   {{environment}} where it runs (OS / shell / workspace)
 *   {{language}}    the reply language (`spinney.replyLanguage`)
 *   {{agentsMd}}    the workspace AGENTS.md snapshot taken at session start
 *
 * The sub-agent template shares `{{identity}}` / `{{environment}}` but is
 * deliberately **lean** — it never repeats the main prompt.
 *
 * Invariant: neither template names a tool. Every tool's schema is sent in the
 * API request's `tools` field (see `Agent.getTools()`), so a tool list here
 * would only be a second copy to drift out of sync. Capabilities are described
 * the same way the tool list is built: from the agent's capability flags.
 */

/** Heading of the trailing AGENTS.md section (used by the template and the empty-snapshot case). */
const AGENTS_MD_HEADING = '## Workspace AGENTS.md (project instructions)';

/**
 * The reply language used when nothing else resolves. It is the floor under
 * `replyLanguageName` (`src/agent/languages.ts`), which turns
 * `spinney.replyLanguage` into the language name the prompt carries: a blank
 * value, or `auto` with no VS Code display language, must never send an empty
 * `## Language` line to the model.
 */
export const DEFAULT_REPLY_LANGUAGE = 'English';

/** The main agent's system prompt. */
export const SYSTEM_PROMPT_TEMPLATE = [
  '{{identity}}',
  '',
  '{{environment}}',
  '',
  '## Language',
  '{{language}}',
  '- Leave code, file paths, command output and identifiers verbatim; never translate them.',
  '',
  '## Approval before work',
  '- Do not turn a discussion into work on your own: until the user explicitly approves the topic, do no state-changing work. When a request arrives, talk it through first — what you would change, where, and the trade-offs — and wait for an explicit go-ahead ("go ahead", "do it", "implement it") before you start.',
  '- Investigating is not working: reading files, searching and harmless read-only commands are expected while you discuss. The gate is on state-changing work — writing or editing files, running commands that modify anything, and dispatching sub-agents or background tasks that do it.',
  '- A clear request is not an approved one. Silence, a question back, a correction, or agreement with an *observation* is not a go-ahead; when in doubt, ask whether to start, and wait.',
  '- Approval covers the topic, not every step: once it is given, carry the work through without re-asking per file — and stop to re-confirm when you are about to go beyond what was agreed.',
  '- Exception: when the user explicitly tells you to start without confirmation (for example "just do it", "no need to confirm", "start right away"), work directly on that topic. The exception covers only what was said — never extend it to other topics on the user\'s behalf.',
  '',
  '## Ask when it matters',
  '- When a request is genuinely ambiguous (several readings, a missing detail, a choice that changes the outcome), ask one short clarifying question that lists the likeliest options so the user can answer in a sentence; never guess — a clear request still waits for the go-ahead (see "Approval before work").',
  '',
  '## Calling conventions',
  '- Send complete, valid JSON arguments; read a file before editing it, and use read_file output verbatim as oldText.',
  '- When a command fails, read the error and fix the root cause (the smallest fix); look at what a tool returned before deciding the next step.',
  '- Emit function calls directly; never write tool JSON in your prose.',
  '- A call that depends on an earlier result waits for it; calls that do not depend on each other may go in the same message.',
  '- A background command that ends (or that the user kills) notifies you automatically — do not poll for it.',
  '- When the task is done, reply in one sentence and stop calling tools.',
  '',
  '## Delegation (when to hand work off)',
  '- A task that splits into independent parts, each needing a lot of reading → fan out read-only sub-agents in parallel and merge their reports; do not delegate what a few files can answer.',
  '- To recall an earlier conversation (including other branches of this session, or a sub-agent report in full) → search_transcripts; to see this session\'s branch structure → list_nodes.',
  '- A long-running command → exec_command\'s background mode; do not sit and wait.',
  '- A long task that needs a clean context and no mid-flight input from you → hop_session.',
  'Example: "audit these 30 files for consistency" → 4 batches, one read-only sub-agent each reporting its own diffs; you only reconcile the conflicting items.',
  '',
  '## Style',
  '- You work in the user\'s workspace; paths may be absolute or relative to the root (the root is on the environment line); keep replies brief and put explanations in the reply, not in files.',
  '- Change nothing you were not asked to change; when editing several files, do them one at a time.',
  '- The user can see your thinking and reasoning — do not treat them as private.',
  '',
  AGENTS_MD_HEADING,
  '{{agentsMd}}',
].join('\n');

/**
 * A sub-agent's (lean) system prompt. It reports in English on purpose: a
 * sub-agent never talks to the user, only to the agent that dispatched it, so
 * `spinney.replyLanguage` (a user-facing choice) does not apply here.
 */
export const SUB_AGENT_SYSTEM_PROMPT_TEMPLATE = [
  '{{identity}}',
  '',
  '{{environment}}',
  '',
  'You are a "sub-agent" — an independent unit of work dispatched by the main agent{{depth}}. Your goal is to finish the task you were given and report a concise conclusion; {{permissions}}',
  '- Answer in English; stay brief and make the conclusion clear.',
  '- You report to the agent that dispatched you; never reach outside your task to change other files.',
  '{{fanOut}}',
].join('\n');

/**
 * The identity lines shared by the main and sub-agent prompts.
 *
 * `model` is the **display name of the model card** the agent runs on, not an API
 * model id: the callers pass `cardDisplayName(card)` (`src/agent/models.ts`),
 * which is what the user called the card and carries the wire name in
 * parentheses when the two differ — a card named "Foo" whose `oaiModel` is
 * `foo-v2` is rendered here as `Foo (foo-v2)`, so the sentence never lies about
 * which endpoint answered. The empty case falls back to {@link DEFAULT_MODEL}
 * (the vendored card's id) rather than rendering a blank name.
 *
 * `effort` is the **card's own level string**, free-form by design: each card
 * declares its menu of levels (`ModelCard.efforts` — `BUILTIN_EFFORTS`
 * (`none` / `low` / `medium` / `high`) on a fresh card, freely edited by the
 * user; `normalizeEffort` in `src/agent/models.ts` is what clamps a value onto
 * that menu), so this only echoes whatever level the session currently picked on
 * that card. The one value with a meaning of its own is the literal `none`,
 * which means "send no `reasoning_effort` at all": the sentence is then left out
 * entirely instead of claiming an effort of "none".
 */
export function identityLines(model: string, effort: ThinkingEffort): string[] {
  const lines: string[] = [
    'You are "Spinney" (spinney) — an autonomous, general-purpose agent.',
    'You are currently running on the "' + (model || DEFAULT_MODEL) + '" model.',
  ];
  if (effort && effort !== 'none') {
    lines.push('Your reasoning effort is currently set to "' + effort + '".');
  }
  return lines;
}

/**
 * The `## Language` line, filled from `spinney.replyLanguage`. A blank value
 * falls back to {@link DEFAULT_REPLY_LANGUAGE} instead of sending an empty
 * instruction to the model.
 */
export function languageLine(language: string): string {
  const lang = (language || '').trim() || DEFAULT_REPLY_LANGUAGE;
  return `- Default to ${lang}; keep answering in ${lang} even if the user writes another language, unless the user explicitly asks for one.`;
}

/**
 * The runtime facts injected as `{{environment}}`.
 *
 * Also consumed by `src/agent/profile.ts`, which passes the type through
 * unchanged (`describeAgent`'s optional `facts` parameter) — so this shape is
 * part of that module's API too.
 */
export interface EnvironmentFacts {
  /** Human-readable OS name, e.g. "Windows". */
  os: string;
  /** Label of the shell `exec_command` runs through, e.g. "Git Bash". */
  shell: string;
  /** Harness root: the workspace folder, or the scratch root in no-repo mode. */
  root: string;
  /**
   * What {@link root} points at — 'workspace' when a folder is open, 'scratch'
   * for the `<globalStorage>/no-workspace` root used in no-repo mode.
   */
  rootKind: 'workspace' | 'scratch';
}

function osLabel(platform: string): string {
  switch (platform) {
    case 'win32':
      return 'Windows';
    case 'darwin':
      return 'macOS';
    case 'linux':
      return 'Linux';
    default:
      return platform;
  }
}

/**
 * Resolve the live environment facts. Reading them binds to vscode (the
 * workspace) and to the shell probe, so both the prompt builders accept an
 * injected {@link EnvironmentFacts} instead — a caller that wants a
 * deterministic render (a test, the prompt-dump script) never touches them.
 */
export function currentEnvironmentFacts(): EnvironmentFacts {
  const { root, kind } = agentRootInfo();
  return { os: osLabel(process.platform), shell: getShell().label, root, rootKind: kind };
}

/**
 * The runtime facts (two lines in no-repo mode), e.g.
 * "Current environment: Windows / Git Bash / workspace D:\repo".
 */
export function environmentSection(facts: EnvironmentFacts): string {
  if (facts.rootKind === 'workspace') {
    return `Current environment: ${facts.os} / ${facts.shell} / workspace ${facts.root}`;
  }
  return (
    `Current environment: ${facts.os} / ${facts.shell} / no workspace folder open (no-repo mode)\n` +
    `Relative paths and the default cwd for commands are based on the harness root ${facts.root}; pass absolute paths to touch real files, and do not assume a repository layout exists.`
  );
}

/**
 * Fill a `{{name}}` template. Every placeholder must have a value: an unknown
 * name (a typo) or a malformed `{{` tag is a bug in the template itself, so it
 * is written to the "Spinney" output channel and thrown instead of being
 * shipped to the model. Only the *template* is scanned — a `{{` inside an
 * injected value (an AGENTS.md snippet) is data, not a placeholder.
 */
export function renderPromptTemplate(template: string, values: Record<string, string>): string {
  const unknown: string[] = [];
  for (const match of template.matchAll(/\{\{([^{}]*)\}\}/g)) {
    if (!Object.prototype.hasOwnProperty.call(values, match[1])) {
      unknown.push(match[0]);
    }
  }
  const malformed = template.replace(/\{\{[^{}]*\}\}/g, '').includes('{{');
  if (unknown.length > 0 || malformed) {
    const detail = unknown.length > 0 ? `placeholder(s) ${unknown.join(', ')}` : 'a malformed "{{" tag';
    const message = `Unresolved ${detail} in the system prompt template.`;
    harnessLog(`[prompt] ${message}`);
    throw new Error(message);
  }
  return template.replace(/\{\{([^{}]*)\}\}/g, (_token, name: string) => values[name]);
}

/**
 * Snapshot of the workspace AGENTS.md appended to the system prompt. Set once
 * per session by {@link setAgentsMd}; later edits to AGENTS.md do not propagate.
 */
let agentsMdSnapshot: string | null = null;

/** Fix the workspace AGENTS.md for the session (null = no AGENTS.md). */
export function setAgentsMd(content: string | null): void {
  agentsMdSnapshot = content;
}

/** Drop the now-empty trailing AGENTS.md section when there is no snapshot. */
function stripAgentsMdSection(text: string): string {
  const suffix = '\n\n' + AGENTS_MD_HEADING;
  if (!text.endsWith(suffix + '\n')) {
    return text; // template changed shape; never mangle the output
  }
  return text.slice(0, text.length - suffix.length - 1);
}

/**
 * The main agent's system prompt for a model + reasoning level + reply
 * language. `model` is the card's display name and `effort` a card level, both
 * exactly as {@link identityLines} describes them. `facts` defaults to the live
 * environment so the normal path needs no arguments.
 */
export function systemPrompt(
  model = '',
  effort: ThinkingEffort = 'none',
  language: string = DEFAULT_REPLY_LANGUAGE,
  facts: EnvironmentFacts = currentEnvironmentFacts(),
): string {
  const agentsMd = (agentsMdSnapshot ?? '').trim();
  const text = renderPromptTemplate(SYSTEM_PROMPT_TEMPLATE, {
    identity: identityLines(model, effort).join('\n'),
    environment: environmentSection(facts),
    language: languageLine(language),
    agentsMd,
  });
  return agentsMd ? text : stripAgentsMdSection(text);
}

/**
 * A sub-agent's lean system prompt. `model` / `effort` carry the same meaning as
 * in {@link systemPrompt} (card display name / card level). `write` decides the
 * permission line; a read-only depth-1 sub-agent is reminded it can fan out
 * read-only children — the same capability that advertises
 * `spawn_readonly_agents`.
 */
export function subAgentSystemPrompt(
  model = '',
  effort: ThinkingEffort = 'none',
  depth = 1,
  write = false,
  facts: EnvironmentFacts = currentEnvironmentFacts(),
): string {
  const fanOut =
    depth < 2 && !write
      ? '- If the task splits into several **independent** parts that each need a lot of reading (for example reviewing file by file or module by module), ' +
        'use spawn_readonly_agents to fan out read-only sub-agents in parallel and then merge their conclusions; ' +
        'do not delegate single-point lookups or tasks a few files can answer.'
      : '';
  const text = renderPromptTemplate(SUB_AGENT_SYSTEM_PROMPT_TEMPLATE, {
    identity: identityLines(model, effort).join('\n'),
    environment: environmentSection(facts),
    depth: depth === 2 ? ' (a sub-sub-agent)' : '',
    permissions: write
      ? 'you may read and write files and run commands.'
      : 'you are read-only: you may read files and search content, but you must not modify files or run commands.',
    fanOut,
  });
  return text.replace(/\n+$/, '');
}
