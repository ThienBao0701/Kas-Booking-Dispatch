/**
 * Private file storage for Chứng từ attachments.
 *
 * Deliberately the same shape as `booking/proofStorage.ts` — disk outside any
 * served directory, server-generated names, magic-byte sniffing, path-traversal
 * refusal — extended for PDF, which the charge module needs and the proof path
 * does not. Sharing the RULES without sharing a module keeps each domain's
 * accepted types explicit rather than implicitly widening the proof path.
 *
 * NOTHING HERE IS EVER SERVED AS STATIC CONTENT. Bytes leave only through an
 * authenticated route that re-checks the caller's role, with `private, no-store`
 * and `nosniff`. There is no public URL for any of these files, by construction:
 * the stored name is meaningless without the database row that authorises it.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CHARGE_UPLOAD_DIR, MAX_UPLOAD_BYTES } from '../config/env';
import { ApiError } from '../lib/errors';

/** Images for "Ảnh khách" and "Ảnh mã thẻ". */
export const CHARGE_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;
/** "File chứng từ" additionally accepts PDF. */
export const CHARGE_DOCUMENT_MIME = [...CHARGE_IMAGE_MIME, 'application/pdf'] as const;

export type ChargeMime = (typeof CHARGE_DOCUMENT_MIME)[number];

export const MAX_CHARGE_FILE_BYTES = MAX_UPLOAD_BYTES;
/** How many files one upload request may carry. */
export const MAX_CHARGE_FILES_PER_REQUEST = 10;

const EXTENSION: Record<ChargeMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/**
 * The real type, from the file's own magic bytes. The client's declared MIME is
 * never trusted — it is trivially forged, and this is the check that stops a
 * renamed executable being stored as evidence.
 */
export function sniffChargeMime(buffer: Buffer): ChargeMime | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  // PDF: "%PDF-" at the start of the file.
  if (buffer.toString('ascii', 0, 5) === '%PDF-') {
    return 'application/pdf';
  }
  return null;
}

/** Whether a sniffed type is allowed in a given upload slot. */
export function mimeAllowedForCategory(
  mime: ChargeMime,
  category: 'GUEST_IMAGE' | 'CHARGE_DOCUMENT' | 'CARD_IMAGE',
): boolean {
  if (category === 'CHARGE_DOCUMENT') {
    return (CHARGE_DOCUMENT_MIME as readonly string[]).includes(mime);
  }
  // The two image slots take images only — a PDF "photo of the guest" is a
  // mislabelled document, and silently accepting it hides that.
  return (CHARGE_IMAGE_MIME as readonly string[]).includes(mime);
}

export function ensureChargeDir(): void {
  fs.mkdirSync(CHARGE_UPLOAD_DIR, { recursive: true });
}

/**
 * A server-generated name built only from the document id (a cuid), a random
 * token and the SNIFFED extension — so the client's original name, which may
 * contain "../", a null byte or an executable extension, never reaches the path.
 */
export function generateStoredFileName(chargeDocumentId: string, mime: ChargeMime): string {
  const safeId = chargeDocumentId.replace(/[^a-zA-Z0-9]/g, '');
  const token = randomBytes(8).toString('hex');
  return `${safeId}_${token}.${EXTENSION[mime]}`;
}

/**
 * Resolves a stored name to an absolute path INSIDE the upload directory, or
 * refuses. Both checks matter: the name must be a plain base name, and the
 * resolved path must still sit under the root after normalisation.
 */
export function resolveChargePath(storedFileName: string): string {
  if (
    storedFileName.length === 0 ||
    storedFileName.includes('/') ||
    storedFileName.includes('\\') ||
    storedFileName.includes('\0') ||
    path.basename(storedFileName) !== storedFileName
  ) {
    throw ApiError.notFound('Không tìm thấy tệp.');
  }
  const root = path.resolve(CHARGE_UPLOAD_DIR);
  const resolved = path.resolve(root, storedFileName);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw ApiError.notFound('Không tìm thấy tệp.');
  }
  return resolved;
}

export async function saveChargeFile(buffer: Buffer, storedFileName: string): Promise<void> {
  ensureChargeDir();
  const dest = resolveChargePath(storedFileName);
  await fsp.writeFile(dest, buffer, { flag: 'wx' }); // wx: never overwrite
}

export async function readChargeFile(storedFileName: string): Promise<Buffer> {
  const p = resolveChargePath(storedFileName);
  try {
    return await fsp.readFile(p);
  } catch {
    throw ApiError.notFound('Không tìm thấy tệp.');
  }
}

/**
 * Removes a stored file. A missing file is not an error: the database row is
 * the record of truth, and a delete that already half-happened must still be
 * able to complete.
 */
export async function deleteChargeFile(storedFileName: string): Promise<void> {
  try {
    await fsp.unlink(resolveChargePath(storedFileName));
  } catch {
    /* already gone */
  }
}
