/**
 * Private file storage for Chat box image attachments.
 *
 * Deliberately the same shape as `charge/chargeDocStorage.ts` and
 * `booking/proofStorage.ts` — disk outside any served directory,
 * server-generated names, magic-byte sniffing, path-traversal refusal.
 *
 * IMAGES ONLY, AND NARROWER THAN THE CHARGE PATH ON PURPOSE. The charge module
 * accepts PDF because a charge document frequently is one. A chat message has
 * no such need, and every extra accepted type is another parser pointed at a
 * file a receptionist was sent by a stranger. Sharing the RULES without sharing
 * a module is what keeps this list explicit rather than inherited.
 *
 * NOTHING HERE IS EVER SERVED AS STATIC CONTENT. Bytes leave only through an
 * authenticated route that re-checks the caller may read the conversation, with
 * `private, no-store` and `nosniff`. There is no public URL for any of these
 * files, by construction: the stored name is meaningless without the database
 * row that authorises it.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CHAT_UPLOAD_DIR, MAX_UPLOAD_BYTES } from '../config/env';
import { ApiError } from '../lib/errors';

/** Chat attachments are images and nothing else. */
export const CHAT_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;

export type ChatMime = (typeof CHAT_IMAGE_MIME)[number];

export const MAX_CHAT_FILE_BYTES = MAX_UPLOAD_BYTES;
/** How many images one message may carry. */
export const MAX_CHAT_FILES_PER_MESSAGE = 10;

const EXTENSION: Record<ChatMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/**
 * The real type, from the file's own magic bytes. The client's declared MIME is
 * never trusted — it is trivially forged, and this is the check that stops a
 * renamed executable being stored and later handed back as an "image".
 */
export function sniffChatMime(buffer: Buffer): ChatMime | null {
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
  return null;
}

export function ensureChatDir(): void {
  fs.mkdirSync(CHAT_UPLOAD_DIR, { recursive: true });
}

/**
 * A server-generated name built only from the conversation id (a cuid), a
 * random token and the SNIFFED extension — so the client's original name, which
 * may contain "../", a null byte or an executable extension, never reaches the
 * path.
 */
export function generateChatFileName(conversationId: string, mime: ChatMime): string {
  const safeId = conversationId.replace(/[^a-zA-Z0-9]/g, '');
  const token = randomBytes(8).toString('hex');
  return `${safeId}_${token}.${EXTENSION[mime]}`;
}

/**
 * Resolves a stored name to an absolute path INSIDE the upload directory, or
 * refuses. Both checks matter: the name must be a plain base name, and the
 * resolved path must still sit under the root after normalisation.
 */
export function resolveChatPath(storedFileName: string): string {
  if (
    storedFileName.length === 0 ||
    storedFileName.includes('/') ||
    storedFileName.includes('\\') ||
    storedFileName.includes('\0') ||
    path.basename(storedFileName) !== storedFileName
  ) {
    throw ApiError.notFound('Không tìm thấy tệp.');
  }
  const root = path.resolve(CHAT_UPLOAD_DIR);
  const resolved = path.resolve(root, storedFileName);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw ApiError.notFound('Không tìm thấy tệp.');
  }
  return resolved;
}

export async function saveChatFile(buffer: Buffer, storedFileName: string): Promise<void> {
  ensureChatDir();
  const dest = resolveChatPath(storedFileName);
  await fsp.writeFile(dest, buffer, { flag: 'wx' }); // wx: never overwrite
}

export async function readChatFile(storedFileName: string): Promise<Buffer> {
  const p = resolveChatPath(storedFileName);
  try {
    return await fsp.readFile(p);
  } catch {
    throw ApiError.notFound('Không tìm thấy tệp.');
  }
}
