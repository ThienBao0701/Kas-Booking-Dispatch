/**
 * "BẬT THÔNG BÁO" ON A PHONE — each step says what happened: registered is not
 * sent, and sent (accepted by the push service) is not yet shown on the phone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installApiMock } from '../test/utils';
import { PushControl } from '../layout/NotificationBell';

const KEY = btoa(String.fromCharCode(4, ...Array.from({ length: 64 }, (_, i) => i + 1)))
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');
const keyBuffer = () => Uint8Array.from(atob(KEY.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((KEY.length + 3) % 4)), (c) => c.charCodeAt(0)).buffer;

/** A fake browser: Notification permission, a service worker, its push manager. */
function browser(opts: { permission: NotificationPermission; answer?: NotificationPermission; subscribed?: boolean; subscribeFails?: boolean }) {
  let permission = opts.permission;
  const requestPermission = vi.fn(async () => (permission = opts.answer ?? permission));
  vi.stubGlobal('Notification', { get permission() { return permission; }, requestPermission });
  vi.stubGlobal('PushManager', function PushManager() {});
  const sub = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/phone-1',
    options: { applicationServerKey: keyBuffer() },
    toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/phone-1', keys: { p256dh: 'BPUB', auth: 'AUTH' } }),
    unsubscribe: vi.fn(async () => true),
  };
  let current = opts.subscribed ? sub : null;
  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async () => {
      if (opts.subscribeFails) throw new DOMException('push service unreachable', 'AbortError');
      return (current = sub);
    }),
  };
  const reg = { pushManager };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: vi.fn(async () => reg), ready: Promise.resolve(reg) },
  });
  return { requestPermission, pushManager };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

describe('"Bật thông báo"', () => {
  it('asks for permission only on the press, registers the device with the server, and then offers a test', async () => {
    const b = browser({ permission: 'default', answer: 'granted' });
    const saved: unknown[] = [];
    installApiMock({
      'GET /api/push/config': () => ({ status: 200, body: { publicKey: KEY } }),
      'POST /api/push/subscriptions': (init) => {
        saved.push(JSON.parse(String(init.body)));
        return { status: 201, body: { subscription: { id: 1 } } };
      },
      'POST /api/push/test': () => ({ status: 200, body: { devices: 1, sent: 1, revoked: 0, rejected: 0, failed: 0 } }),
    });
    render(<PushControl />);
    const enable = await screen.findByTestId('push-enable');
    // Nothing asked on load.
    expect(b.requestPermission).not.toHaveBeenCalled();
    await userEvent.click(enable);
    expect(b.requestPermission).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Đã đăng ký thiết bị này')).toBeInTheDocument();
    expect(saved).toEqual([{ endpoint: 'https://fcm.googleapis.com/fcm/send/phone-1', keys: { p256dh: 'BPUB', auth: 'AUTH' } }]);
    // Registered — not yet "sent", let alone "received".
    expect(screen.getByTestId('push-note')).toHaveTextContent('Gửi thông báo thử');
    await userEvent.click(screen.getByTestId('push-test'));
    const note = await screen.findByText(/Đã gửi tới dịch vụ thông báo cho 1 thiết bị/);
    expect(note).toHaveTextContent('Nếu điện thoại hiện “KAS — thông báo thử” là đã nhận được');
  });

  it('refreshes an existing registration on load without asking again — and a second load does not duplicate anything client-side', async () => {
    const b = browser({ permission: 'granted', subscribed: true });
    let posts = 0;
    installApiMock({
      'GET /api/push/config': () => ({ status: 200, body: { publicKey: KEY } }),
      'POST /api/push/subscriptions': () => {
        posts += 1;
        return { status: 201, body: { subscription: { id: 1 } } };
      },
    });
    const first = render(<PushControl />);
    expect(await screen.findByText('Đã đăng ký thiết bị này')).toBeInTheDocument();
    first.unmount();
    render(<PushControl />);
    expect(await screen.findByText('Đã đăng ký thiết bị này')).toBeInTheDocument();
    // The same subscription, re-sent (the server upserts it by endpoint); never a prompt, never a new subscribe.
    expect(posts).toBe(2);
    expect(b.requestPermission).not.toHaveBeenCalled();
    expect(b.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('says the server is not configured — without asking the phone for anything', async () => {
    const b = browser({ permission: 'default', answer: 'granted' });
    installApiMock({ 'GET /api/push/config': () => ({ status: 200, body: { publicKey: null } }) });
    render(<PushControl />);
    await userEvent.click(await screen.findByTestId('push-enable'));
    expect(await screen.findByTestId('push-unconfigured')).toHaveTextContent('Máy chủ chưa bật gửi thông báo đẩy');
    expect(b.requestPermission).not.toHaveBeenCalled();
  });

  it('explains how to allow notifications again when permission is refused', async () => {
    browser({ permission: 'default', answer: 'denied' });
    installApiMock({ 'GET /api/push/config': () => ({ status: 200, body: { publicKey: KEY } }) });
    render(<PushControl />);
    await userEvent.click(await screen.findByTestId('push-enable'));
    expect(await screen.findByTestId('push-denied')).toHaveTextContent('Thông báo → Cho phép');
  });

  it('says plainly when the device could not be registered, and when the server refuses the test', async () => {
    browser({ permission: 'granted', subscribeFails: true });
    installApiMock({
      'GET /api/push/config': () => ({ status: 200, body: { publicKey: KEY } }),
      'POST /api/push/test': () => ({ status: 503, body: { error: { code: 'SERVICE_UNAVAILABLE', message: 'Máy chủ chưa được cấu hình gửi thông báo đẩy.' } } }),
    });
    render(<PushControl />);
    await userEvent.click(await screen.findByTestId('push-enable'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Không đăng ký được thiết bị nhận thông báo');
    expect(screen.queryByText('Đã đăng ký thiết bị này')).not.toBeInTheDocument();
  });

  it('reports a gone or refused device from the test, not a success', async () => {
    browser({ permission: 'granted', subscribed: true });
    installApiMock({
      'GET /api/push/config': () => ({ status: 200, body: { publicKey: KEY } }),
      'POST /api/push/subscriptions': () => ({ status: 201, body: { subscription: { id: 1 } } }),
      'POST /api/push/test': () => ({ status: 200, body: { devices: 2, sent: 0, revoked: 1, rejected: 1, failed: 0 } }),
    });
    render(<PushControl />);
    await userEvent.click(await screen.findByTestId('push-test'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('1 thiết bị đã hết hạn đăng ký và đã được gỡ');
    expect(alert).toHaveTextContent('Dịch vụ thông báo từ chối gửi tới 1 thiết bị');
    expect(alert).not.toHaveTextContent('Đã gửi');
  });
});
