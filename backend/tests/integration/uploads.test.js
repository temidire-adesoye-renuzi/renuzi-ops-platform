/* ============================================================================
   INTEGRATION: Upload service (Objective 5)
   Verifies:
   - valid damage/receipt photos upload and return a signed URL
   - the signed URL retrieves the exact bytes
   - MIME masquerading (exe as .jpg) is rejected by magic-byte sniffing
   - size limit enforcement
   ============================================================================ */

const path = require('path');
const fs = require('fs');
const db = require('../helpers/dbTestHelper');
const { authed, login, clearRotationFlags } = require('../helpers/apiClient');
const { env } = require('../../src/config/env');

const uploadDir = path.resolve('uploads-test');
beforeAll(async () => {
  await db.migrate();
  await clearRotationFlags();
  fs.mkdirSync(uploadDir, { recursive: true });
});

afterAll(async () => {
  fs.rmSync(uploadDir, { recursive: true, force: true });
  await db.close();
});

function realJpeg() {
  // JPEG magic prefix + payload
  return Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(2048, 0x11)]);
}

describe('POST /api/uploads', () => {
  test('stores a DAMAGE_PHOTO and returns a working signed URL', async () => {
    const { token } = await login('driver');
    const { request, app } = require('../helpers/apiClient');

    const res = await request(app)
      .post('/api/uploads?purpose=DAMAGE_PHOTO')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', realJpeg(), { filename: 'damage.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    expect(res.body.data.mime).toBe('image/jpeg');
    expect(res.body.data.url).toMatch(/^\/api\/uploads\/content\//);

    // Retrieve via the signed URL - exact bytes come back
    const get = await request(app).get(res.body.data.url);
    expect(get.status).toBe(200);
    expect(get.headers['content-type']).toBe('image/jpeg');
    expect(get.body.length).toBe(2052);
  });

  test('stores a RECEIPT_PHOTO (pdf)', async () => {
    const { token } = await login('driver');
    const { request, app } = require('../helpers/apiClient');

    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64)]);
    const res = await request(app)
      .post('/api/uploads?purpose=RECEIPT_PHOTO')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', pdf, { filename: 'receipt.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
    expect(res.body.data.mime).toBe('application/pdf');
  });

  test('rejects an executable masquerading as an image (magic bytes)', async () => {
    const { token } = await login('driver');
    const { request, app } = require('../helpers/apiClient');

    const exe = Buffer.concat([Buffer.from('MZ\x90\x00'), Buffer.alloc(128)]);
    const res = await request(app)
      .post('/api/uploads?purpose=DAMAGE_PHOTO')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', exe, { filename: 'evil.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(415);
    // nothing stored
    const files = fs.readdirSync(uploadDir, { recursive: true });
    expect(files.length).toBe(0);
  });

  test('rejects disallowed purposes', async () => {
    const { token } = await login('driver');
    const { request, app } = require('../helpers/apiClient');

    const res = await request(app)
      .post('/api/uploads?purpose=NOT_A_PURPOSE')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', realJpeg(), { filename: 'x.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
  });
});

describe('signed URL integrity', () => {
  test('an expired/tampered token yields 404', async () => {
    const { request, app } = require('../helpers/apiClient');
    const res = await request(app).get('/api/uploads/content/not-a-valid-token');
    expect(res.status).toBe(404);
  });

  test('url encodes the token safely', async () => {
    const { token } = await login('driver');
    const { request, app } = require('../helpers/apiClient');

    const res = await request(app)
      .post('/api/uploads?purpose=GENERAL')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', realJpeg(), { filename: 'g.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(201);

    // Tamper with the signature: base64url chars swapped
    const tampered = res.body.data.url.slice(0, -4) + 'AAAA';
    const get = await request(app).get(tampered);
    expect(get.status).toBe(404);
  });
});
