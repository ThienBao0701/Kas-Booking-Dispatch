/**
 * `copyText` — the one place the application touches the system clipboard.
 *
 * WHY A DEDICATED UNIT TEST: every CẮT and every copy button funnels through
 * this function, and the requirement is not "some copy helper was called" but
 * "the string reached the REAL OS clipboard, so Ctrl+V and Win+V produce it".
 * That guarantee lives here, in a test with no React and no user-event
 * involved — `userEvent.setup()` installs its own clipboard stub, so a
 * component test can never honestly assert this.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { copyText } from './copy';

function withClipboard(writeText: ReturnType<typeof vi.fn>, secure = true) {
  Object.defineProperty(window, 'isSecureContext', { value: secure, configurable: true });
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('copyText', () => {
  it('writes through navigator.clipboard.writeText — the real system clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    withClipboard(writeText);

    await expect(copyText('Charlie Nguyen')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('Charlie Nguyen');
  });

  it('preserves line breaks exactly', async () => {
    // The PMS note is a string contract with the hotel system; a lost newline
    // is a broken note.
    const note = 'BK 5832616717_1STAN_1 ĐÊM 891.000 PAY AFTER CHECK-IN CI\n11/08 CÓ SĐT +886 960 617 206';
    const writeText = vi.fn().mockResolvedValue(undefined);
    withClipboard(writeText);

    await copyText(note);

    const written = String(writeText.mock.calls[0]![0]);
    expect(written).toBe(note);
    expect(written.split('\n')).toHaveLength(2);
  });

  it('preserves Vietnamese diacritics byte for byte', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    withClipboard(writeText);

    await copyText('KHÁCH ĐẾN KHOẢNG 18:00');
    expect(writeText).toHaveBeenCalledWith('KHÁCH ĐẾN KHOẢNG 18:00');
  });

  it('reports failure when the browser refuses and no fallback works', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    withClipboard(writeText);
    document.execCommand = vi.fn().mockReturnValue(false);

    await expect(copyText('x')).resolves.toBe(false);
  });

  it('falls back to execCommand outside a secure context', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    withClipboard(writeText, false);
    const exec = vi.fn().mockReturnValue(true);
    document.execCommand = exec;

    await expect(copyText('fallback')).resolves.toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledWith('copy');
  });
});
