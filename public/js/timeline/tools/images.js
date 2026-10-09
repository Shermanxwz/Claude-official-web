/**
 * Image blocks of tool results, checked before anything is shown. Pure functions (no DOM), so the limits are unit
 * tested in Node. An image is shown only when its type is a web image type, its data is base64 and its decoded size is
 * at most IMAGE_LIMIT_BYTES. Anything else falls back to the generic JSON view of the result.
 */

/** Largest decoded image a tool result may show inline (docs/FRONTEND.md). */
export const IMAGE_LIMIT_BYTES = 5 * 1024 * 1024;

/** Media types a data: URL may carry. SVG and every other type are never shown as images. */
export const IMAGE_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const ALLOWED = new Set(IMAGE_MEDIA_TYPES);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Number of bytes a base64 string decodes to. Whitespace must already be removed.
 * @param {string} base64 base64 text without whitespace
 * @returns {number}
 */
export function decodedSize(base64) {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/**
 * A data: URL for an image the viewer may show, or null for a type, encoding or size that is not allowed.
 * @param {unknown} mediaType
 * @param {unknown} data base64 text (line breaks and spaces are allowed)
 * @returns {{ mediaType: string, src: string, bytes: number } | null}
 */
export function imageSource(mediaType, data) {
  if (typeof mediaType !== 'string' || !ALLOWED.has(mediaType)) return null;
  if (typeof data !== 'string') return null;
  const clean = data.replace(/\s+/g, '');
  if (clean === '' || clean.length % 4 === 1 || !BASE64.test(clean)) return null;
  const bytes = decodedSize(clean);
  if (bytes > IMAGE_LIMIT_BYTES) return null;
  return { mediaType, src: `data:${mediaType};base64,${clean}`, bytes };
}

/**
 * The image of one content block. Accepts the Messages API shape `{type: 'image', source: {type: 'base64', media_type,
 * data}}` and the MCP shape `{type: 'image', data, mimeType}`.
 * @param {unknown} block
 * @returns {{ mediaType: string, src: string, bytes: number } | null}
 */
export function imageFromBlock(block) {
  if (!block || typeof block !== 'object') return null;
  const record = /** @type {Record<string, unknown>} */ (block);
  if (record.type !== 'image') return null;
  const source = record.source;
  if (source && typeof source === 'object') {
    const origin = /** @type {Record<string, unknown>} */ (source);
    if (origin.type !== 'base64') return null;
    return imageSource(origin.media_type, origin.data);
  }
  return imageSource(record.mimeType, record.data);
}
