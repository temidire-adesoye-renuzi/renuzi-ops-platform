/* ============================================================================
   UPLOAD API ROUTES   All endpoints prefixed with /api/uploads

     POST /api/uploads?purpose=DAMAGE_PHOTO|RECEIPT_PHOTO|...   - store a file
     GET  /api/uploads/content/:token                           - signed retrieval

   Objective 5: damage_photo_url and receipt_photo_url content. The URL
   stored in fact tables is the SIGNED, time-limited retrieval URL returned
   by the POST; clients refresh via /content when it expires.
   ============================================================================ */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { requireAny } = require('../middleware/roleCheck');
const { upload } = require('../middleware/upload');
const uploadService = require('../services/uploadService');
const { HttpError } = require('../utils/httpError');

/* POST /api/uploads?purpose=DAMAGE_PHOTO
   multipart/form-data: field "file" */
router.post('/', authenticateToken, requireAny, upload.single('file'), async (req, res) => {
  try {
    const purpose = (req.query.purpose || 'GENERAL').toUpperCase();
    const stored = await uploadService.storeUpload(
      { userKey: req.user.userKey, businessKey: req.user.businessKey },
      req.file,
      purpose
    );
    return res.status(201).json({
      success: true,
      message: 'File stored',
      data: stored
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ success: false, message: err.publicMessage });
    }
    console.error('[UPLOAD] store error:', err.message);
    return res.status(500).json({ success: false, message: 'Upload failed' });
  }
});

/* GET /api/uploads/content/:token - signed retrieval (no auth token needed:
   the HMAC token IS the bearer credential, letting the mobile webview and
   the native photo viewer fetch images without header injection). */
router.get('/content/:token', async (req, res) => {
  try {
    const storagePath = uploadService.resolveSignedToken(req.params.token);
    if (!storagePath) {
      return res.status(404).json({ success: false, message: 'Link expired or invalid' });
    }
    const buffer = await uploadService.readUpload(storagePath);
    const ext = storagePath.split('.').pop().toLowerCase();
    const mimes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' };
    res.setHeader('Content-Type', mimes[ext] || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.send(buffer);
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ success: false, message: err.publicMessage });
    }
    console.error('[UPLOAD] read error:', err.message);
    return res.status(500).json({ success: false, message: 'Retrieval failed' });
  }
});

module.exports = router;
