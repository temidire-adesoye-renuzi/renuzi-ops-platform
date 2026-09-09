/* ============================================================================
   UNIT: upload content sniffing (magic bytes) - the anti-masquerading layer
   ============================================================================ */

const { sniffMime } = require('../../src/services/uploadService');

describe('sniffMime (magic byte detection)', () => {
  test('detects real JPEG', () => {
    const jpeg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF]), Buffer.alloc(10)]);
    expect(sniffMime(jpeg)).toBe('image/jpeg');
  });

  test('detects real PNG', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47]), Buffer.alloc(10)]);
    expect(sniffMime(png)).toBe('image/png');
  });

  test('detects real PDF', () => {
    const pdf = Buffer.from('%PDF-1.7 ...');
    expect(sniffMime(pdf)).toBe('application/pdf');
  });

  test('detects real WEBP (RIFF container)', () => {
    const webp = Buffer.alloc(16);
    Buffer.from('RIFF', 'ascii').copy(webp, 0);
    Buffer.from('WEBP', 'ascii').copy(webp, 8);
    expect(sniffMime(webp)).toBe('image/webp');
  });

  test('rejects an executable masquerading as an image', () => {
    const exe = Buffer.from('MZ\x90\x00\x03\x00\x00\x00');
    expect(sniffMime(exe)).toBeNull();
  });

  test('rejects empty/short buffers', () => {
    expect(sniffMime(Buffer.alloc(0))).toBeNull();
    expect(sniffMime(Buffer.from([0xFF]))).toBeNull();
  });
});
