import { ToolDefinition } from '../types';
import { hopSessionTool } from './hopSession';
import { listNodesTool } from './listNodes';
import { readImageTool } from './readImage';
import { renameSessionTool } from './renameSession';
import { sendAgentMessageTool } from './sendAgentMessage';
import { sendReadonlyAgentMessageTool } from './sendReadonlyAgentMessage';
import { spawnAgentsTool } from './spawnAgents';
import { spawnReadonlyAgentsTool } from './spawnReadonlyAgents';

/**
 * The tools the **provider** orchestrates and `Agent` intercepts (spawning,
 * hopping, reading an image). Their schemas live one-per-file here; their
 * execution stays in `Agent.executeToolCall` (it needs the provider's handlers).
 *
 * Each tool declares the capability it needs (`requires`). `Agent.getTools()`
 * filters this single list by the agent's capabilities, so the tool list the
 * model sees and the capabilities the prompt describes can never drift apart.
 */
export type ToolRequirement = 'vision' | 'spawn' | 'spawnReadOnly' | 'hop';

export interface InterceptedTool {
  definition: ToolDefinition;
  /** The capability an agent must have for this tool to be advertised. */
  requires: ToolRequirement;
}

/** Which intercepted tools an agent is allowed to see. */
export interface ToolCapabilities {
  /** The active model accepts images. */
  vision: boolean;
  /** May spawn / message writable sub-agents. */
  canSpawn: boolean;
  /** May spawn / message read-only sub-agents. */
  canSpawnReadOnly: boolean;
  /** Main agent only: hop to a fresh session, list the tree, rename the session. */
  canHop: boolean;
}

/** Every intercepted tool, in the order it is advertised. */
export const INTERCEPTED_TOOLS: readonly InterceptedTool[] = [
  readImageTool,
  spawnAgentsTool,
  sendAgentMessageTool,
  spawnReadonlyAgentsTool,
  sendReadonlyAgentMessageTool,
  hopSessionTool,
  listNodesTool,
  renameSessionTool,
];

function isAvailable(requires: ToolRequirement, caps: ToolCapabilities): boolean {
  switch (requires) {
    case 'vision':
      return caps.vision;
    case 'spawn':
      return caps.canSpawn;
    case 'spawnReadOnly':
      return caps.canSpawnReadOnly;
    case 'hop':
      return caps.canHop;
  }
}

/** The intercepted tools' definitions for an agent with these capabilities. */
export function interceptedDefinitions(caps: ToolCapabilities): ToolDefinition[] {
  return INTERCEPTED_TOOLS.filter((tool) => isAvailable(tool.requires, caps)).map((tool) => tool.definition);
}
