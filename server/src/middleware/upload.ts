import type { NextFunction, Request, RequestHandler, Response } from 'express';
import multer, { MulterError } from 'multer';
import { ApiError } from '../lib/errors';
import { ALLOWED_PROOF_MIME, MAX_PROOF_BYTES, type ProofMime } from '../booking/proofStorage';
import {
  CHARGE_DOCUMENT_MIME,
  MAX_CHARGE_FILES_PER_REQUEST,
  MAX_CHARGE_FILE_BYTES,
} from '../charge/chargeDocStorage';
import {
  CHAT_IMAGE_MIME,
  MAX_CHAT_FILES_PER_MESSAGE,
  MAX_CHAT_FILE_BYTES,
} from '../chat/chatStorage';

// Buffer the upload in memory (max 10 MB) so we can sniff its magic bytes and
// write it ourselves under a server-generated name. The client's declared MIME
// is only a first-pass filter; proofStorage re-verifies the real image type.
const uploader = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PROOF_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if ((ALLOWED_PROOF_MIME as readonly string[]).includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new ApiError('UNSUPPORTED_MEDIA', 'Chỉ chấp nhận ảnh PNG, JPEG hoặc WebP.'));
    }
  },
});

/**
 * A single-image ("image") multipart handler that translates multer's own errors
 * into the app's ApiError shape (oversized -> 413, wrong type -> 415).
 */
export function proofUpload(): RequestHandler {
  const single = uploader.single('image');
  return (req: Request, res: Response, next: NextFunction) => {
    single(req, res, (err: unknown) => {
      if (!err) {
        next();
        return;
      }
      if (err instanceof MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          next(ApiError.fileTooLarge());
          return;
        }
        next(ApiError.badRequest('Tải ảnh không hợp lệ.'));
        return;
      }
      next(err); // already an ApiError (e.g. unsupported media) or unexpected
    });
  };
}

export type { ProofMime };

/**
 * Multi-file handler for Chứng từ attachments.
 *
 * Separate from `proofUpload` on purpose: it accepts several files and it
 * accepts PDF, neither of which the proof path should quietly gain. The
 * declared MIME here is only a first-pass filter — `chargeDocStorage` sniffs
 * every buffer's magic bytes before anything is written, and that is the check
 * that actually decides.
 */
const chargeUploader = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CHARGE_FILE_BYTES, files: MAX_CHARGE_FILES_PER_REQUEST },
  fileFilter: (_req, file, cb) => {
    if ((CHARGE_DOCUMENT_MIME as readonly string[]).includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new ApiError('UNSUPPORTED_MEDIA', 'Chỉ chấp nhận ảnh PNG, JPEG, WebP hoặc tệp PDF.'));
    }
  },
});

/**
 * Multi-image handler for Chat box messages.
 *
 * Narrower than `chargeUpload` on purpose: images only, no PDF. A chat message
 * has no need for one, and the charge module's wider list must not leak into a
 * surface a receptionist can be sent anything on. As everywhere else, the
 * declared MIME is only a first-pass filter — `chatStorage` sniffs every
 * buffer's magic bytes before anything is written, and that is what decides.
 */
const chatUploader = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CHAT_FILE_BYTES, files: MAX_CHAT_FILES_PER_MESSAGE },
  fileFilter: (_req, file, cb) => {
    if ((CHAT_IMAGE_MIME as readonly string[]).includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new ApiError('UNSUPPORTED_MEDIA', 'Chỉ chấp nhận ảnh PNG, JPEG hoặc WebP.'));
    }
  },
});

export function chatUpload(): RequestHandler {
  const many = chatUploader.array('images', MAX_CHAT_FILES_PER_MESSAGE);
  return (req: Request, res: Response, next: NextFunction) => {
    many(req, res, (err: unknown) => {
      if (!err) {
        next();
        return;
      }
      if (err instanceof MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          next(ApiError.fileTooLarge());
          return;
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          next(ApiError.badRequest(`Tối đa ${MAX_CHAT_FILES_PER_MESSAGE} ảnh mỗi tin nhắn.`));
          return;
        }
        next(ApiError.badRequest('Tải ảnh không hợp lệ.'));
        return;
      }
      next(err);
    });
  };
}

export function chargeUpload(): RequestHandler {
  const many = chargeUploader.array('files', MAX_CHARGE_FILES_PER_REQUEST);
  return (req: Request, res: Response, next: NextFunction) => {
    many(req, res, (err: unknown) => {
      if (!err) {
        next();
        return;
      }
      if (err instanceof MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          next(ApiError.fileTooLarge());
          return;
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          next(ApiError.badRequest(`Tối đa ${MAX_CHARGE_FILES_PER_REQUEST} tệp mỗi lần tải lên.`));
          return;
        }
        next(ApiError.badRequest('Tải tệp không hợp lệ.'));
        return;
      }
      next(err);
    });
  };
}
