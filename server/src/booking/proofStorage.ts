import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { MAX_UPLOAD_BYTES, PROOF_UPLOAD_DIR } from '../config/env';
import { ApiError } from '../lib/errors';

/** The only proof image types Kas accepts. */
export const ALLOWED_PROOF_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type ProofMime = (typeof ALLOWED_PROOF_MIME)[number];

/** Maximum proof image size in bytes — MAX_UPLOAD_MB (10 MB by default). */
export const MAX_PROOF_BYTES = MAX_UPLOAD_BYTES;

const EXTENSION: Record<ProofMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/**
 * Determines the real image type from the file's magic bytes — the client's
 * declared MIME type is never trusted. Returns null for anything that is not a
 * PNG / JPEG / WebP (so executables or spoofed content are rejected).
 */
export function sniffImageMime(buffer: Buffer): ProofMime | null {
  if (buffer.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  // WebP: "RIFF"...."WEBP"
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** Ensures the configured upload directory exists (created once, recursively). */
export function ensureProofDir(): void {
  fs.mkdirSync(PROOF_UPLOAD_DIR, { recursive: true });
}

/**
 * A server-generated, collision-resistant file name. Built only from the booking
 * id (a cuid: [a-z0-9]), the attempt number, a random token and the extension
 * derived from the sniffed image type — so the client's original name (which may
 * contain "../", spaces or an executable extension) never influences the path.
 */
export function generateStoredFileName(bookingId: string, attemptNumber: number, mime: ProofMime): string {
  const safeId = bookingId.replace(/[^a-zA-Z0-9]/g, '');
  const token = randomBytes(8).toString('hex');
  return `${safeId}_a${attemptNumber}_${token}.${EXTENSION[mime]}`;
}

/**
 * Resolves a stored file name to an absolute path *inside* the upload directory.
 * Rejects any name that is not a plain base name or that would escape the root
 * (path-traversal defence — the resolved path must stay under PROOF_UPLOAD_DIR).
 */
export function resolveProofPath(storedFileName: string): string {
  if (
    storedFileName.length === 0 ||
    storedFileName.includes('/') ||
    storedFileName.includes('\\') ||
    storedFileName.includes('\0') ||
    path.basename(storedFileName) !== storedFileName
  ) {
    throw ApiError.notFound('Không tìm thấy tệp.');
  }
  const root = path.resolve(PROOF_UPLOAD_DIR);
  const resolved = path.resolve(root, storedFileName);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw ApiError.notFound('Không tìm thấy tệp.');
  }
  return resolved;
}

/** Writes the validated image buffer to disk under a server-generated name. */
export async function saveProofFile(buffer: Buffer, storedFileName: string): Promise<void> {
  ensureProofDir();
  const dest = resolveProofPath(storedFileName);
  await fsp.writeFile(dest, buffer, { flag: 'wx' }); // wx: fail if it somehow exists
}

/** Reads a stored proof image, or throws NOT_FOUND when the file is gone. */
export async function readProofFile(storedFileName: string): Promise<Buffer> {
  const p = resolveProofPath(storedFileName);
  try {
    return await fsp.readFile(p);
  } catch {
    throw ApiError.notFound('Không tìm thấy tệp.');
  }
}

/** A short content hash, handy for de-duplicating identical re-uploads if desired. */
export function contentHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}
