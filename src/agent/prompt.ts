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
 *   {{agentsMd}}    the AGENTS.md sections in force — the systemwide one
 *                   (`~/.spinney/AGENTS.md`), then the workspace one
 *
 * The sub-agent template shares `{{identity}}` / `{{environment}}` but is
 * deliberately **lean** — it never repeats the main prompt.
 *
 * Invariant: neither template names a tool. Every tool's schema is sent in the
 * API request's `tools` field (see `Agent.getTools()`), so a tool list here
 * would only be a second copy to drift out of sync. Capabilities are described
 * the same way the tool list is built: from the agent's capability flags.
 */

/** Heading of the workspace AGENTS.md section (the workspace root's own file). */
const AGENTS_MD_HEADING = '## Workspace AGENTS.md (project instructions)';

/**
 * Heading of the systemwide AGENTS.md section — the one file that applies to
 * every workspace on this machine. It is rendered **first**, so the workspace's
 * own instructions are the ones closest to the turn.
 */
const GLOBAL_AGENTS_MD_HEADING = '## Global AGENTS.md (all workspaces)';

/**
 * The precedence line, rendered inside the global section and only when both
 * sections are present: the systemwide file applies everywhere, so a workspace
 * that says otherwise is the narrower instruction and wins.
 */
const AGENTS_MD_PRECEDENCE =
  '- The instructions below apply to every workspace; where the two sections conflict, the workspace section wins.';

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
  '- Commands already start in the harness root (the environment line names it): use exec_command\'s `cwd` argument to run elsewhere, instead of prefixing every command with a "cd … && …".',
  '- Reach for the tool that names the work before the shell: reading, listing, searching and recalling an earlier conversation each have one. The shell is for what no tool covers — builds, tests, version control, running a program — and a read-only command is not a free way to look around.',
  '- Never search through the shell (no grep, rg, findstr, Select-String, find): search_files and search_transcripts answer with exclusions, binary skipping, a scope echo and one hard, configurable time budget, and a call over that budget returns an `Error:` line with no hits — so prefer many small, narrow searches over one wide one. Only a genuinely large sweep that needs a long-running job belongs in a background exec_command.',
  '- Emit function calls directly; never write tool JSON in your prose.',
  '- A call that depends on an earlier result waits for it; calls that do not depend on each other may go in the same message.',
  '- Never sleep to wait for a command, and never poll a running one. A foreground command is moved to the background by itself when it outlives spinney.execForegroundSeconds, and the result then hands you its id: keep working or end the turn instead of watching it. Use wait_for_command(id, seconds?) to wait — it returns the moment the command ends, or says it is still running — and check_command(id) only for a status read. A node job keeps the composer on Stop and its own completion notice reaches you; a detached job locks nothing and never notifies, so its result is read by asking.',
  '- When the task is done, reply in one sentence and stop calling tools.',
  '',
  '## Delegation (when to hand work off)',
  '- A task that splits into independent parts, each needing a lot of reading → fan out read-only sub-agents in parallel and merge their reports; do not delegate what a few files can answer.',
  '- To recall an earlier conversation (including other branches of this session, or a sub-agent report in full) → search_transcripts; to see this session\'s branch structure → list_nodes.',
  '- A long-running command → just run it: exec_command\'s default `run_type` is "foreground", and a command still running after `spinney.execForegroundSeconds` (30 seconds by default) is moved to the background by itself — nothing is killed and the result hands you its id. Use `run_type: "background"` when you already know the work is long and belongs to this turn: it registers the job at once, the composer shows Stop until it ends, and its completion notice reaches you. Use `run_type: "detached"` for a long-lived thing (a dev server, an emulator, a watcher) or for work whose result you will collect later: it is session-wide and fire-and-forget, it locks no node and never notifies, so `check_command` or `wait_for_command` is how you read it. There is no per-call timeout: a job runs until it ends or something kills it (`kill_command`). Do not sit and wait, and never hand the work to a process the harness does not own — neither by backgrounding it inside the shell ("&", "nohup", "Start-Process") nor by asking a long-lived process to run it (an editor addon, a test bridge, a build server): the harness can neither track, wait for nor stop a process it did not spawn, its output never comes back, and a child of that process is out of Stop\'s reach entirely.',
  '- A long task that needs a clean context and no mid-flight input from you → hop_session.',
  'Example: "audit these 30 files for consistency" → 4 batches, one read-only sub-agent each reporting its own diffs; you only reconcile the conflicting items.',
  '',
  '## Style',
  '- You work in the user\'s workspace; paths may be absolute or relative to the root (the root is on the environment line); keep replies brief and put explanations in the reply, not in files.',
  '- Change nothing you were not asked to change; when editing several files, do them one at a time.',
  '- The user can see your thinking and reasoning — do not treat them as private.',
  '',
  // The instruction files — the systemwide `~/.spinney/AGENTS.md` first, then the
  // workspace root's own `AGENTS.md`. The headings are part of the value
  // (`agentsMdSection`, below) because each section only exists when its file does.
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
 * One pair of AGENTS.md instruction sources: the **systemwide** file (`~/.spinney/AGENTS.md`,
 * or its fallback under global storage) and the open workspace folder's own `AGENTS.md`.
 *
 * A value of this type is either the window's **fallback snapshot** ({@link AgentsMdSources}
 * filled by {@link currentAgentsMdSources}) or the pair a caller read **at use**
 * (`src/chat/agentsMd.ts` → `liveAgentsMdSources`, which is what the shipped freeze path
 * and the drift check both use, so an edit is seen on the next check instead of needing a
 * reload). The summary order is fixed — global first, workspace second.
 */
export interface AgentsMdSources {
  /** The systemwide file's content (null = no such file). */
  global: string | null;
  /** The workspace root `AGENTS.md`'s content (null = no such file). */
  workspace: string | null;
}

/**
 * Snapshots of the AGENTS.md files appended to the system prompt. Set once per
 * window by {@link setAgentsMd} / {@link setGlobalAgentsMd} — they are now the
 * **fallback** floor for a file that exists but cannot be read
 * (`src/chat/agentsMd.ts`), not the source of truth: the render path reads both files
 * at use, so an edit is seen by the next freeze and the next drift check.
 *
 * {@link systemPrompt}'s `agentsMd` argument lets a caller pass its own pair without
 * touching these (see there — one snapshot cannot describe every workspace a window
 * serves across a folder change).
 */
let agentsMdSnapshot: string | null = null;
let globalAgentsMdSnapshot: string | null = null;

/** Fix the workspace AGENTS.md for the window (null = no AGENTS.md). */
export function setAgentsMd(content: string | null): void {
  agentsMdSnapshot = content;
}

/** Fix the systemwide AGENTS.md for the window (null = no such file). */
export function setGlobalAgentsMd(content: string | null): void {
  globalAgentsMdSnapshot = content;
}

/** Both snapshots in force right now — what a render is built from. */
export function currentAgentsMdSources(): AgentsMdSources {
  return { global: globalAgentsMdSnapshot, workspace: agentsMdSnapshot };
}

/**
 * Compose the `{{agentsMd}}` value: the systemwide section first, then the
 * workspace section, each dropped entirely when its file is missing or blank. An
 * empty result means the template's trailing section disappears, so a workspace
 * with neither file sends no AGENTS.md heading at all.
 */
export function agentsMdSection(sources: AgentsMdSources): string {
  const global = (sources.global ?? '').trim();
  const workspace = (sources.workspace ?? '').trim();
  const sections: string[] = [];
  if (global) {
    const lines = [GLOBAL_AGENTS_MD_HEADING];
    if (workspace) {
      lines.push(AGENTS_MD_PRECEDENCE);
    }
    lines.push(global);
    sections.push(lines.join('\n'));
  }
  if (workspace) {
    sections.push([AGENTS_MD_HEADING, workspace].join('\n'));
  }
  return sections.join('\n\n');
}

/**
 * The AGENTS.md bytes the window's **fallback snapshot** would carry (`''` when neither
 * file is known), for the module-global snapshots.
 *
 * The freeze path no longer hashes this: it renders from, and hashes, the live pair
 * (`liveAgentsMdSources`), so an edit on disk is what the next epoch freezes. This stays
 * as the one-line answer for a caller that has nothing live to read (a dump script, a
 * test), and it is the same builder — hashing the rendered section rather than a raw file
 * is what makes one hash cover both sources.
 */
export function currentAgentsMdSection(): string {
  return agentsMdSection(currentAgentsMdSources());
}

/**
 * The main agent's system prompt for a model + reasoning level + reply
 * language. `model` is the card's display name and `effort` a card level, both
 * exactly as {@link identityLines} describes them. `facts` defaults to the live
 * environment so the normal path needs no arguments.
 *
 * `agentsMd` selects the AGENTS.md snapshots this render carries: **omitted**
 * (`undefined`) means the module-global pair {@link setAgentsMd} /
 * {@link setGlobalAgentsMd} fixed, which is what every current caller gets; a value
 * uses *those* snapshots (pass `{ global: null, workspace: null }` for a prompt with
 * no AGENTS.md section at all). The explicit case is what a caller that freezes one
 * prompt per session/epoch needs: a window can serve several sessions, each with its
 * own files, so such a caller passes the snapshots it took for **its** session here
 * instead of rendering whatever the module-global ones hold by the time the render
 * happens. Nothing is remembered: the argument never writes the module state back.
 */
export function systemPrompt(
  model = '',
  effort: ThinkingEffort = 'none',
  language: string = DEFAULT_REPLY_LANGUAGE,
  facts: EnvironmentFacts = currentEnvironmentFacts(),
  agentsMd?: AgentsMdSources,
): string {
  const section = agentsMdSection(agentsMd ?? currentAgentsMdSources());
  const text = renderPromptTemplate(SYSTEM_PROMPT_TEMPLATE, {
    identity: identityLines(model, effort).join('\n'),
    environment: environmentSection(facts),
    language: languageLine(language),
    agentsMd: section,
  });
  // With no instructions the template's trailing blank line is all that is left,
  // so the prompt ends where the last written line does (and the AGENTS.md heading
  // never appears with an empty body). A section that exists is already trimmed,
  // so this only ever removes that blank tail.
  return text.replace(/\n+$/, '');
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
