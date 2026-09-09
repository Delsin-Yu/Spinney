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
  | { type: 'image_url'; image_url: { url: string; detail?: string } }
  /** An image uploaded to the DeepSeek Files API, referenced by its file_id. */
  | { type: 'file'; file_id: string };

/** A file uploaded to the DeepSeek Files API (POST /files). */
export interface UploadedFile {
  id: string;
  filename: string;
  bytes: number;
}

/** Models that accept image input. Only these may carry image content blocks. */
export const VISION_MODELS: ReadonlySet<string> = new Set([
  'deepseek-v4-flash-vision-exp',
  'deepseek-v4.1-flash-expires-on-0910',
]);

/** True if the given model accepts image content blocks. */
export function isVisionModel(model: string): boolean {
  return VISION_MODELS.has(model);
}

/**
 * Detect the image MIME type from magic bytes. DeepSeek detects image format
 * from actual content (not the filename or declared MIME), so this is used only
 * for a friendly local check / to set the upload's content type. Returns null
 * for anything that is not a supported format (JPEG, PNG, GIF, WebP).
 */
export function detectImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/** CRC32 table for PNG chunk validation (computed once). */
const CRC_TABLE: readonly number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function readU32BE(bytes: Uint8Array, off: number): number {
  return ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
}

/** Walk a PNG's chunks and verify every CRC and the IEND terminator. */
function pngIntegrityError(bytes: Uint8Array): string | null {
  let off = 8;
  while (off + 8 <= bytes.length) {
    const len = readU32BE(bytes, off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    if (off + 12 + len > bytes.length) {
      return `truncated PNG (${type} chunk overruns the file)`;
    }
    const dataEnd = off + 8 + len;
    if (readU32BE(bytes, dataEnd) !== crc32(bytes.subarray(off + 4, dataEnd))) {
      return `corrupt PNG (bad CRC in the ${type} chunk)`;
    }
    off = dataEnd + 4;
    if (type === 'IEND') {
      return null;
    }
  }
  return 'corrupt PNG (missing IEND chunk)';
}

/**
 * A structural integrity check on top of the magic-byte detection. Returns a
 * human-readable reason when the bytes are a truncated/corrupt image that
 * `detectImageMime` alone would accept (e.g. a PNG with a bad chunk CRC), or
 * null when the image is well-formed. DeepSeek rejects such files with a 400.
 */
export function imageIntegrityError(bytes: Uint8Array): string | null {
  if (detectImageMime(bytes) === 'image/png') {
    return pngIntegrityError(bytes);
  }
  return null;
}

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
      /** A tool call's arguments are being drafted (streamed incrementally). */
      type: 'toolCallDelta';
      /** Stable discriminator for this tool call within the message (its stream index). */
      index: number;
      /** The tool-call id, if the stream has provided it yet. */
      id?: string;
      /** Incremental fragment of the tool *name* (append to the running value). */
      name?: string;
      /** Incremental fragment of the tool's JSON *arguments* (append to the running value). */
      args?: string;
    }
  | {
      type: 'toolStart';
      id: string;
      name: string;
      args: string;
      /** The stream index this tool call was drafted under (used to reconcile a live card). */
      index?: number;
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
