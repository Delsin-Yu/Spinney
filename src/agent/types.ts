/**
 * Shared type definitions for the agent harness.
 * The message shapes are compatible with the OpenAI-style chat completion
 * protocol that DeepSeek exposes.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/**
 * How much effort the model should spend reasoning before answering.
 * 'none' omits the reasoning_effort parameter entirely (API default).
 */
export type ThinkingEffort = 'none' | 'low' | 'medium' | 'high';

/** A single content part for multimodal (image) user messages. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /** Internal reasoning emitted by reasoner models (sent back for multi-turn). */
  reasoning_content?: string | null;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

/** Token usage reported by the API (including DeepSeek cache metrics). */
export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

/** A single SSE "data:" payload from the streaming chat completion. */
export interface StreamChunk {
  id?: string;
  choices?: Array<{
    index: number;
    delta?: {
      role?: string;
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: Usage;
}

/** Events emitted by the agent and forwarded to the webview. */
export type AgentEvent =
  | { type: 'status'; text: string }
  | { type: 'streamDelta'; content: string }
  | { type: 'reasoningDelta'; content: string }
  | { type: 'assistantDone' }
  | { type: 'usage'; usage: Usage }
  | {
      type: 'toolStart';
      id: string;
      name: string;
      args: string;
    }
  | {
      type: 'toolEnd';
      id: string;
      name: string;
      content: string;
    }
  | { type: 'done' }
  | { type: 'interrupted' }
  | { type: 'error'; message: string };

/** A tool that the agent can invoke. */
export interface AgentTool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}
