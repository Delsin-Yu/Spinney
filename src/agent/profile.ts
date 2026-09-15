import { DEFAULT_REPLY_LANGUAGE, EnvironmentFacts, subAgentSystemPrompt, systemPrompt } from './prompt';
import { ToolCapabilities, interceptedDefinitions } from './tools';
import { ThinkingEffort, ToolDefinition } from './types';

/**
 * The public answer to "what does the model actually receive?" — the system
 * prompt and the `tools` array for one agent, both derived from the *same*
 * capability flags. The prompt's guidance and the advertised tools therefore
 * cannot disagree (the invariant this refactor is built around).
 *
 * Pure: the environment facts and the registry's own tool definitions are
 * passed in, so a caller can render without a live extension host (the
 * prompt-dump script) or with the real thing (`ChatViewProvider`).
 */
export interface AgentProfile {
  role: 'main' | 'subagent';
  model: string;
  effort: ThinkingEffort;
  /**
   * Reply language **name** for the main agent, already resolved from
   * `spinney.replyLanguage` (see `replyLanguageName` in `src/agent/languages.ts`);
   * ignored for a sub-agent, whose reports stay English (see
   * `SUB_AGENT_SYSTEM_PROMPT_TEMPLATE`).
   */
  language?: string;
  /** Sub-agent depth (sub-agents only; default 1). */
  depth?: number;
  /** Sub-agent may write files / run commands (sub-agents only; default false). */
  write?: boolean;
  /** Which intercepted tools this agent may see. */
  capabilities: ToolCapabilities;
}

/** The prompt and the tool list for one agent profile. */
export function describeAgent(
  profile: AgentProfile,
  registryTools: readonly ToolDefinition[] = [],
  facts?: EnvironmentFacts,
): { systemPrompt: string; tools: ToolDefinition[] } {
  const system =
    profile.role === 'subagent'
      ? subAgentSystemPrompt(profile.model, profile.effort, profile.depth ?? 1, profile.write ?? false, facts)
      : systemPrompt(profile.model, profile.effort, profile.language ?? DEFAULT_REPLY_LANGUAGE, facts);
  return {
    systemPrompt: system,
    tools: [...registryTools, ...interceptedDefinitions(profile.capabilities)],
  };
}
