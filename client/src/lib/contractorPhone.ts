/** The server's phone rule: digits with spaces, dots, dashes, + or brackets — 8 to 15 digits. */
export function phoneProblem(value: string): string | null {
  const phone = value.trim();
  if (!phone) return 'Vui lòng nhập số điện thoại.';
  const digits = phone.replace(/\D/g, '');
  if (!/^[0-9+().\s-]+$/.test(phone) || digits.length < 8 || digits.length > 15) return 'Số điện thoại không hợp lệ.';
  return null;
}
