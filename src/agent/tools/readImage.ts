import type { InterceptedTool } from './index';

/**
 * Tool the vision model can call to look at an image file on disk. Unlike the
 * text tools, the actual image is handed to the model through an injected
 * `user` message — a `tool` message cannot carry an image content block. The
 * image is uploaded to the DeepSeek Files API so the request references the
 * returned `file_id` rather than inlining base64 into the body.
 *
 * Since P1/P2 the bytes that reach the provider are transformed first (crop,
 * then downscale to `IMAGE_TARGET_MAX_SIDE`), which is also what the `rect`
 * argument buys: the endpoint charges a flat ~384 tokens per image, so a region
 * costs the same as the whole image and shows at full detail
 * (`docs/agents/plans/image-budget.md` §2.1). The description teaches that
 * workflow because the model — not the harness — decides when to zoom, and the
 * refusal the brake returns has to make sense to a caller that only ever read
 * this schema.
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
        'Read an image file from disk and make it visible to the model. Path may be absolute or relative to the workspace root. Use this when you need to see or analyze an image file. Before it is sent, the image is downscaled so its longest side is at most 1024 px, and the result line reports the source image pixel size; pass rect to keep one region of the source at full detail instead (a zoom) — read the whole image first, then the region that matters. When the request already carries as many image bytes as the model allows, the tool refuses instead of attaching the image: the refusal names the limit and tells you to delegate the look to a sub-agent, whose empty history can carry the image this conversation cannot. The image is uploaded to the DeepSeek Files API and referenced by file_id. Requires a model that accepts image input.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the image file.' },
          rect: {
            type: 'object',
            description:
              'Optional region of the source image to keep at full detail, in pixels of that source image (a zoom). It must lie inside the image; a rect that lies outside is an error.',
            properties: {
              x: { type: 'integer', description: 'Left edge in source pixels.' },
              y: { type: 'integer', description: 'Top edge in source pixels.' },
              w: { type: 'integer', description: 'Region width in source pixels.' },
              h: { type: 'integer', description: 'Region height in source pixels.' },
            },
            required: ['x', 'y', 'w', 'h'],
          },
        },
        required: ['path'],
      },
    },
  },
};
