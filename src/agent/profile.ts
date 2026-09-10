import { EnvironmentFacts, subAgentSystemPrompt, systemPrompt } from './prompt';
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
      : systemPrompt(profile.model, profile.effort, facts);
  return {
    systemPrompt: system,
    tools: [...registryTools, ...interceptedDefinitions(profile.capabilities)],
  };
}
