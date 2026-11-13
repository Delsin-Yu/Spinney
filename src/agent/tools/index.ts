import { ToolDefinition } from '../types';
import { createSessionTool } from './createSession';
import { listNodesTool } from './listNodes';
import { listSessionsTool } from './listSessions';
import { readImageTool } from './readImage';
import { renameSessionTool } from './renameSession';
import { sendAgentMessageTool } from './sendAgentMessage';
import { sendReadonlyAgentMessageTool } from './sendReadonlyAgentMessage';
import { sendSessionMessageTool } from './sendSessionMessage';
import { spawnAgentsTool } from './spawnAgents';
import { spawnReadonlyAgentsTool } from './spawnReadonlyAgents';

/**
 * The tools the **provider** orchestrates and `Agent` intercepts (spawning,
 * sessions, reading an image). Their schemas live one-per-file here; their
 * execution stays in `Agent.executeToolCall` (it needs the provider's handlers).
 *
 * Each tool declares the capability it needs (`requires`). `Agent.getTools()`
 * filters this single list by the agent's capabilities, so the tool list the
 * model sees and the capabilities the prompt describes can never drift apart.
 */
export type ToolRequirement = 'vision' | 'spawn' | 'spawnReadOnly' | 'sessions';

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
  /**
   * Main agent only: the session surface — `create_session`,
   * `send_session_message`, `list_sessions`, `list_nodes` and `rename_session`.
   *
   * One capability for all five, because they are one surface: a caller that may
   * start a session and message a node also has to be able to name them, and a
   * sub-agent (or a sidecar card) never may — its report goes up to its
   * dispatcher, not sideways into another conversation.
   */
  canSessions: boolean;
}

/** Every intercepted tool, in the order it is advertised. */
export const INTERCEPTED_TOOLS: readonly InterceptedTool[] = [
  readImageTool,
  spawnAgentsTool,
  sendAgentMessageTool,
  spawnReadonlyAgentsTool,
  sendReadonlyAgentMessageTool,
  createSessionTool,
  sendSessionMessageTool,
  listSessionsTool,
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
    case 'sessions':
      return caps.canSessions;
  }
}

/** The intercepted tools' definitions for an agent with these capabilities. */
export function interceptedDefinitions(caps: ToolCapabilities): ToolDefinition[] {
  return INTERCEPTED_TOOLS.filter((tool) => isAvailable(tool.requires, caps)).map((tool) => tool.definition);
}
