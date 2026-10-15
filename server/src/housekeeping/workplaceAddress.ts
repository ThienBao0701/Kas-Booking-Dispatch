/**
 * "NƠI LÀM VIỆC" — the hotel a housekeeper names, by its address, at "Vào ca".
 *
 * THE BRANCH LIST NEVER LEAVES THE SERVER. The housekeeper types the start of
 * the address of the hotel they are standing in ("17", "170 Nguyễn"); the
 * server compares it with the addresses of every active branch and answers with
 * ONE of three outcomes:
 *
 *   RESOLVED   the input fits exactly one branch — and only THAT branch is
 *              named back, so the housekeeper can confirm it;
 *   AMBIGUOUS  the input is too short, or fits more than one branch: one
 *              generic "nhập thêm" that names no candidate and no count;
 *   NONE       nothing fits.
 *
 * "1" fits "170-172-174 Nguyễn Thái Bình" and "13 Bùi Thị Xuân" alike, so it is
 * AMBIGUOUS — neither is shown; "17" fits only the first, and only it is shown.
 * Matching ignores case, diacritics, punctuation and a number's leading zeros
 * ("5" fits "05 Trương Định"), and starts at a word: "nguyen thai" and "thai
 * binh" fit "170-172-174 Nguyễn Thái Bình", "uyen" does not. The typed text is
 * never logged or stored; only the branch the shift opens at is.
 *
 * Who may work where is no longer the account's: Bộ phận buồng phòng has no
 * permanent branch, and the shift's branch is the one named here.
 */
export type WorkplaceResolution = { status: 'RESOLVED'; branchId: number } | { status: 'AMBIGUOUS' } | { status: 'NONE' };

export const WORKPLACE_AMBIGUOUS = 'Nhập thêm số nhà hoặc tên đường để xác định khách sạn.';
export const WORKPLACE_NOT_FOUND = 'Không tìm thấy khách sạn với địa chỉ đã nhập. Vui lòng kiểm tra lại.';
export const WORKPLACE_REQUIRED = 'Vui lòng nhập địa chỉ khách sạn nơi bạn làm việc.';

/** The shortest input considered at all; anything shorter is AMBIGUOUS. */
export const MIN_ADDRESS_CHARS = 2;
export const MAX_ADDRESS_CHARS = 200;

/** Lower case, no diacritics ("đ" → "d"), punctuation as spaces, no leading zeros, one space between words. */
export function normalizeAddress(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .map((word) => (/^\d+$/.test(word) ? word.replace(/^0+(?=\d)/, '') : word))
    .join(' ');
}

/** Whether the typed text fits an address: a prefix of it, starting at one of its words. */
function fits(input: string, address: string): boolean {
  return ` ${address}`.includes(` ${input}`);
}

export function resolveWorkplace(raw: string, branches: readonly { id: number; address: string }[]): WorkplaceResolution {
  const input = normalizeAddress(raw);
  // One TYPED character discloses nothing — not even a digit ("4" alone would name "40-42 …").
  // Counted on what was typed: "05" is two characters even though it reads as "5".
  if (raw.replace(/\s/g, '').length < MIN_ADDRESS_CHARS) return { status: 'AMBIGUOUS' };
  const matches = branches.filter((b) => fits(input, normalizeAddress(b.address)));
  if (matches.length === 0) return { status: 'NONE' };
  if (matches.length > 1) return { status: 'AMBIGUOUS' };
  return { status: 'RESOLVED', branchId: matches[0]!.id };
}
