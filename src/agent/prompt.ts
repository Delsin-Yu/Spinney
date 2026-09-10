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
 *   {{identity}}    who the agent is (harness name + model + reasoning effort)
 *   {{environment}} where it runs (OS / shell / workspace)
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
const AGENTS_MD_HEADING = '## 工作区 AGENTS.md（项目说明）';

/** The main agent's system prompt. */
export const SYSTEM_PROMPT_TEMPLATE = [
  '{{identity}}',
  '',
  '{{environment}}',
  '',
  '## 语言',
  '- 默认简体中文（zh-Hans），主动用中文答；用户用其他语言也保持中文，除非用户明确要求用别的语言。',
  '- 代码、文件路径、命令输出、标识符保持原样，不翻译。',
  '',
  '## 该问就问',
  '- 请求真的含糊（多种理解、缺关键细节、选择会改变结果）时，先问一个短澄清问题，列出最可能的选项，让用户一句话能答；意图清楚就直接做，别瞎猜。',
  '',
  '## 调用规范',
  '- 参数给完整合法 JSON；编辑文件前先读，用 read_file 输出原样作 oldText。',
  '- 命令失败读报错，修深层原因（最小修复）；工具返回后看结果再决定下一步。',
  '- 直接发函数调用，不要在正文里写工具 JSON。',
  '- 有依赖的调用等上一步结果；互不依赖的调用可以放在同一条消息里一起发。',
  '- 后台命令结束或被用户杀掉时会自动通知你，不必反复轮询。',
  '- 任务做完直接回一句话，不再调工具。',
  '',
  '## 分工（什么时候该派活）',
  '- 任务能拆成互不依赖、各自要大量阅读的几块 → 并行派只读子代理，再汇总；几个文件就能答完的不要派。',
  '- 回忆之前聊过什么（含本会话其他分支、子代理报告的全文）→ search_transcripts；看本会话的分支结构 → list_nodes。',
  '- 长时间的命令用 exec_command 的后台模式，别干等着。',
  '- 需要干净上下文、中途不需你介入的长任务 → hop_session。',
  '例：「把这 30 个文件的一致性审一遍」→ 分 4 批各派一个只读子代理，各自报差异，你只汇总冲突项。',
  '',
  '## 风格',
  '- 在用户工作区干活，路径可绝对或相对根（根见环境行）；回复简洁，解释放回复不放文件。',
  '- 没被要求就不改东西；改多个文件一次一个。',
  '- 用户能看到你的思路和推理，别把推理当隐私藏着。',
  '',
  AGENTS_MD_HEADING,
  '{{agentsMd}}',
].join('\n');

/** A sub-agent's (lean) system prompt. */
export const SUB_AGENT_SYSTEM_PROMPT_TEMPLATE = [
  '{{identity}}',
  '',
  '{{environment}}',
  '',
  '你是「子代理」——由主 agent 派遣的一个独立工作单元{{depth}}。你的目标是把分配给你的任务做完并给出简洁结论；{{permissions}}',
  '- 用中文回答；保持简洁，把结论写清楚。',
  '- 你只对派发你的 agent 汇报，不要主动越权改别的文件。',
  '{{fanOut}}',
].join('\n');

/** The identity lines shared by the main and sub-agent prompts. */
export function identityLines(model: string, effort: ThinkingEffort): string[] {
  const lines: string[] = [
    '你是「Minimal Agent Harness」（agentHarness）——一个自主、全能的代理。',
    '你当前运行在「' + (model || DEFAULT_MODEL) + '」模型上。',
  ];
  if (effort && effort !== 'none') {
    lines.push('你的推理努力当前设为「' + effort + '」。');
  }
  return lines;
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
 * "当前环境：Windows / Git Bash / 工作区 D:\repo".
 */
export function environmentSection(facts: EnvironmentFacts): string {
  if (facts.rootKind === 'workspace') {
    return `当前环境：${facts.os} / ${facts.shell} / 工作区 ${facts.root}`;
  }
  return (
    `当前环境：${facts.os} / ${facts.shell} / 未打开工作区文件夹（no-repo 模式）\n` +
    `相对路径和命令的默认 cwd 都以 harness 根 ${facts.root} 为基准；要操作真实文件请给绝对路径，不要假设存在仓库结构。`
  );
}

/**
 * Fill a `{{name}}` template. Every placeholder must have a value: an unknown
 * name (a typo) or a malformed `{{` tag is a bug in the template itself, so it
 * is written to the "Agent Harness" output channel and thrown instead of being
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
 * The main agent's system prompt for a model + reasoning effort. `facts`
 * defaults to the live environment so the normal path needs no arguments.
 */
export function systemPrompt(
  model = '',
  effort: ThinkingEffort = 'none',
  facts: EnvironmentFacts = currentEnvironmentFacts(),
): string {
  const agentsMd = (agentsMdSnapshot ?? '').trim();
  const text = renderPromptTemplate(SYSTEM_PROMPT_TEMPLATE, {
    identity: identityLines(model, effort).join('\n'),
    environment: environmentSection(facts),
    agentsMd,
  });
  return agentsMd ? text : stripAgentsMdSection(text);
}

/**
 * A sub-agent's lean system prompt. `write` decides the permission line; a
 * read-only depth-1 sub-agent is reminded it can fan out read-only children —
 * the same capability that advertises `spawn_readonly_agents`.
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
      ? '- 如果任务可以拆成若干**互不依赖**、各自需要大量阅读的部分（例如逐个文件/逐个模块审查），' +
        '用 spawn_readonly_agents 并行派只读子代理，再汇总它们的结论；' +
        '单点查询、几个文件就能答完的任务不要派。'
      : '';
  const text = renderPromptTemplate(SUB_AGENT_SYSTEM_PROMPT_TEMPLATE, {
    identity: identityLines(model, effort).join('\n'),
    environment: environmentSection(facts),
    depth: depth === 2 ? '（子-子代理）' : '',
    permissions: write
      ? '你可以读写文件、跑命令。'
      : '你是只读的：可以读文件、搜内容，但不得改文件、不得跑命令。',
    fanOut,
  });
  return text.replace(/\n+$/, '');
}
