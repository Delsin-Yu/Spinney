import type { InterceptedTool } from './index';

/**
 * Tool the vision model can call to look at an image file on disk. Unlike the
 * text tools, the actual image is handed to the model through an injected
 * `user` message — a `tool` message cannot carry an image content block. The
 * image is uploaded to the DeepSeek Files API so the request references the
 * returned `file_id` rather than inlining base64 into the body.
 *
 * Advertised only when the active model accepts images; `Agent.executeReadImage`
 * keeps its own guard as a fallback for a hallucinated call.
 */
export const readImageTool: InterceptedTool = {
  requires: 'vision',
  definition: {
    type: 'function',
    function: {
      name: 'read_image',
      description:
        'Read an image file from disk and make it visible to the model. Path may be absolute or relative to the workspace root. Use this when you need to see or analyze an image file. The image is uploaded to the DeepSeek Files API and referenced by file_id. Requires a model that accepts image input.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the image file.' },
        },
        required: ['path'],
      },
    },
  },
};
