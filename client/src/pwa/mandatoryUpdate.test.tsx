/**
 * THE MANDATORY UPDATE — claims proved here:
 *   1. No waiting version: nothing is shown and the application is untouched.
 *   2. A waiting version: one full-screen dialog, the application underneath
 *      inert and hidden, no way to close it (no close button, Escape does nothing).
 *   3. "Cập nhật ngay" runs the existing activation, says it is installing, and
 *      never claims success: without the reload in time it says it failed.
 *   4. A failed or rejected activation offers "Thử lại", which tries again; a
 *      second failure adds the "close every KAS tab" advice. Nothing reloads by itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MandatoryUpdate } from './MandatoryUpdate';

let root: HTMLDivElement;

beforeEach(() => {
  root = document.createElement('div');
  root.id = 'root';
  root.innerHTML = '<nav><a href="/app/hk/rooms" data-testid="app-link">Tình trạng phòng</a></nav>';
  document.body.appendChild(root);
});

afterEach(() => {
  vi.useRealTimers();
  root.remove();
});

describe('the mandatory update', () => {
  it('shows nothing, and leaves the application alone, while no new version waits', () => {
    const apply = vi.fn(async () => undefined);
    render(<MandatoryUpdate needed={false} apply={apply} />);
    expect(screen.queryByTestId('mandatory-update')).not.toBeInTheDocument();
    expect(root).not.toHaveAttribute('inert');
    expect(apply).not.toHaveBeenCalled();
  });

  it('covers the whole application with one dialog that cannot be dismissed', () => {
    const { unmount } = render(<MandatoryUpdate needed apply={vi.fn(async () => undefined)} />);
    const dialog = screen.getByRole('alertdialog', { name: 'Cần cập nhật để tiếp tục sử dụng KAS' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.className).toContain('fixed inset-0');
    // The application underneath: out of reach for the mouse, the keyboard and screen readers.
    expect(root).toHaveAttribute('inert');
    expect(root).toHaveAttribute('aria-hidden', 'true');
    // One action, focused; nothing closes it.
    const button = screen.getByTestId('mandatory-update-button');
    expect(button).toHaveTextContent('Cập nhật ngay');
    expect(button).toHaveFocus();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Đóng|Bỏ qua|Để sau/ })).not.toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByTestId('mandatory-update')).toBeInTheDocument();
    // When the update is no longer pending (the new version took over), the application is given back.
    unmount();
    expect(root).not.toHaveAttribute('inert');
  });

  it('runs the existing activation, says it is installing, and calls it failed if the reload does not come', async () => {
    vi.useFakeTimers();
    const apply = vi.fn(async () => undefined);
    render(<MandatoryUpdate needed apply={apply} timeoutMs={5_000} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('mandatory-update-button'));
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('mandatory-update-status')).toHaveTextContent('Đang cài đặt bản mới');
    expect(screen.getByTestId('mandatory-update-button')).toBeDisabled();
    // No success claimed: the reload is the success; without it, a failure with "Thử lại".
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByTestId('mandatory-update-error')).toHaveTextContent('Chưa cài được bản mới');
    expect(screen.getByTestId('mandatory-update-button')).toHaveTextContent('Thử lại');
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('offers "Thử lại" after a rejected activation, tries again, and then advises closing every tab', async () => {
    const apply = vi.fn(async () => {
      throw new Error('activation failed');
    });
    render(<MandatoryUpdate needed apply={apply} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('mandatory-update-button'));
    });
    expect(screen.getByTestId('mandatory-update-error')).toHaveTextContent('Kiểm tra kết nối mạng');
    expect(screen.getByTestId('mandatory-update-error')).not.toHaveTextContent('đóng mọi cửa sổ');
    await act(async () => {
      fireEvent.click(screen.getByTestId('mandatory-update-button'));
    });
    expect(apply).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('mandatory-update-error')).toHaveTextContent('đóng mọi cửa sổ / tab KAS');
    // Still mandatory after failures — never dismissed, the application still out of reach.
    expect(root).toHaveAttribute('inert');
  });
});
