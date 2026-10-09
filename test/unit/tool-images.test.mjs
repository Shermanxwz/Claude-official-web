import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IMAGE_LIMIT_BYTES,
  decodedSize,
  imageFromBlock,
  imageSource,
} from '../../public/js/timeline/tools/images.js';

/** Base64 text that decodes to exactly `bytes` bytes (zeros), with the padding base64 requires. */
function base64Of(bytes) {
  const groups = Math.floor(bytes / 3);
  const rest = bytes % 3;
  if (rest === 0) return 'A'.repeat(groups * 4);
  if (rest === 1) return `${'A'.repeat(groups * 4)}AA==`;
  return `${'A'.repeat(groups * 4)}AAA=`;
}

describe('decodedSize', () => {
  test('counts the bytes behind unpadded and padded base64', () => {
    assert.equal(decodedSize('QUJD'), 3);
    assert.equal(decodedSize('QUI='), 2);
    assert.equal(decodedSize('QQ=='), 1);
    assert.equal(decodedSize(base64Of(5_242_880)), 5_242_880);
  });
});

describe('imageSource', () => {
  test('accepts the web image types and returns a data: URL with the decoded size', () => {
    assert.deepEqual(imageSource('image/png', 'QUJD'), {
      mediaType: 'image/png', src: 'data:image/png;base64,QUJD', bytes: 3,
    });
    for (const type of ['image/jpeg', 'image/gif', 'image/webp']) {
      assert.equal(imageSource(type, 'QUJD')?.mediaType, type);
    }
  });

  test('refuses SVG and every other media type, even with valid base64', () => {
    assert.equal(imageSource('image/svg+xml', 'PHN2Zz4='), null);
    assert.equal(imageSource('text/html', 'QUJD'), null);
    assert.equal(imageSource('application/octet-stream', 'QUJD'), null);
    assert.equal(imageSource(undefined, 'QUJD'), null);
  });

  test('refuses data that is not base64', () => {
    assert.equal(imageSource('image/png', ''), null);
    assert.equal(imageSource('image/png', 'not base64!'), null);
    assert.equal(imageSource('image/png', 'QUJDR'), null);
    assert.equal(imageSource('image/png', 42), null);
  });

  test('tolerates line breaks and spaces inside the base64 text', () => {
    const image = imageSource('image/png', 'QUJD\nRE VG\n');
    assert.equal(image?.src, 'data:image/png;base64,QUJDREVG');
    assert.equal(image?.bytes, 6);
  });

  test('accepts an image of exactly the limit and refuses one byte more', () => {
    const atLimit = imageSource('image/png', base64Of(IMAGE_LIMIT_BYTES));
    assert.equal(atLimit?.bytes, IMAGE_LIMIT_BYTES);
    assert.equal(imageSource('image/png', base64Of(IMAGE_LIMIT_BYTES + 1)), null);
  });

  test('keeps the limit at 5 MiB', () => {
    assert.equal(IMAGE_LIMIT_BYTES, 5 * 1024 * 1024);
  });
});

describe('imageFromBlock', () => {
  test('reads the Messages API shape', () => {
    const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } };
    assert.deepEqual(imageFromBlock(block), {
      mediaType: 'image/png', src: 'data:image/png;base64,QUJD', bytes: 3,
    });
  });

  test('reads the MCP shape with data and mimeType', () => {
    const block = { type: 'image', data: 'QUJD', mimeType: 'image/webp' };
    assert.equal(imageFromBlock(block)?.src, 'data:image/webp;base64,QUJD');
  });

  test('refuses a source that is a URL, an SVG or an oversized image', () => {
    assert.equal(imageFromBlock({ type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } }), null);
    assert.equal(imageFromBlock({ type: 'image', data: 'PHN2Zz4=', mimeType: 'image/svg+xml' }), null);
    assert.equal(imageFromBlock({ type: 'image', data: base64Of(IMAGE_LIMIT_BYTES + 3), mimeType: 'image/png' }), null);
  });

  test('ignores blocks that are not images', () => {
    assert.equal(imageFromBlock(null), null);
    assert.equal(imageFromBlock('image'), null);
    assert.equal(imageFromBlock({ type: 'text', text: 'hello' }), null);
  });
});
