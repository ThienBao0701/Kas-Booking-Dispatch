/**
 * "NƠI LÀM VIỆC" — the hotel a housekeeper names, by its address, at "Vào ca".
 *
 * THE BRANCH LIST NEVER LEAVES THE SERVER. The housekeeper types the address of
 * the hotel they are standing in; the server compares it with the addresses of
 * every active branch and answers with ONE of three outcomes, none of which
 * names any other branch:
 *
 *   RESOLVED   the input identifies exactly one branch — and it is the
 *              account's own (the Admin's assignment decides eligibility; an
 *              address is never proof on its own);
 *   AMBIGUOUS  the input is too short, or fits more than one branch:
 *              "Nhập thêm thông tin địa chỉ để xác định nơi làm việc";
 *   NONE       nothing fits — or what fits is another branch than the
 *              account's: one generic refusal for both, so a guess at another
 *              hotel's address learns nothing about it.
 *
 * "1" fits "170-172-174 Nguyễn Thái Bình" and "13 Bùi Thị Xuân" alike, so it is
 * AMBIGUOUS; "17" fits only the first. Matching ignores case, diacritics and
 * punctuation, and starts at a word: "nguyen thai" fits "170-172-174 Nguyễn Thái
 * Bình", "thai binh" does too, "uyen" does not. The typed text is never logged
 * or stored; only the resolved branch is.
 */
export type WorkplaceResolution =
  | { status: 'RESOLVED'; branchId: number }
  | { status: 'AMBIGUOUS' }
  | { status: 'NONE' };

export const WORKPLACE_AMBIGUOUS = 'Nhập thêm thông tin địa chỉ để xác định nơi làm việc.';
export const WORKPLACE_NOT_FOUND = 'Không xác định được nơi làm việc từ địa chỉ đã nhập. Vui lòng kiểm tra lại địa chỉ khách sạn.';
export const WORKPLACE_REQUIRED = 'Vui lòng nhập địa chỉ khách sạn nơi bạn làm việc.';

/** The shortest input considered at all; anything shorter is AMBIGUOUS. */
export const MIN_ADDRESS_CHARS = 2;
export const MAX_ADDRESS_CHARS = 200;

/** Lower case, no diacritics ("đ" → "d"), punctuation as spaces, one space between words. */
export function normalizeAddress(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Whether the typed text fits an address: a prefix of it, starting at one of its words. */
function fits(input: string, address: string): boolean {
  return ` ${address}`.includes(` ${input}`);
}

export function resolveWorkplace(
  raw: string,
  branches: readonly { id: number; address: string }[],
  accountBranchId: number,
): WorkplaceResolution {
  const input = normalizeAddress(raw);
  if (input.replace(/ /g, '').length < MIN_ADDRESS_CHARS) return { status: 'AMBIGUOUS' };
  const matches = branches.filter((b) => fits(input, normalizeAddress(b.address)));
  if (matches.length === 0) return { status: 'NONE' };
  if (matches.length > 1) return { status: 'AMBIGUOUS' };
  // One fit, but not the account's hotel: indistinguishable from no fit at all.
  return matches[0]!.id === accountBranchId ? { status: 'RESOLVED', branchId: accountBranchId } : { status: 'NONE' };
}
