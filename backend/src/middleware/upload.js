/* ============================================================================
   UPLOAD MIDDLEWARE
   Multer configuration for multipart uploads. The service layer performs
   content validation (magic bytes, whitelist, virus scan); this middleware
   enforces the transport-level limits before the buffer is even accepted.
   ============================================================================ */

const multer = require('multer');
const { env } = require('../config/env');
const { HttpError } = require('../utils/httpError');

/**
 * Memory storage: files are validated (sniffed + scanned) BEFORE anything
   is written to disk, so a malicious payload never touches storage.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.uploads.maxBytes, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!env.uploads.allowedMime.includes(file.mimetype.toLowerCase())) {
      return cb(new HttpError(415, `Content type ${file.mimetype} is not allowed`));
    }
    return cb(null, true);
  }
});

module.exports = { upload };
