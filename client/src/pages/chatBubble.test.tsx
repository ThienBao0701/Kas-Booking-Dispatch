/**
 * THE CHAT BUBBLE — one persistent chat for Admin and Reception.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. The bubble is on every page of both roles, and opens a panel without
 *      leaving the page.
 *   2. The branch list is whatever the server sends — 8 today, 9 tomorrow, with no
 *      change here — and an Admin picks one; a receptionist's single branch opens
 *      by itself.
 *   3. Unread is the server's: the total on the bubble, a dot on each branch, and
 *      opening a conversation tells the server it was read.
 *   4. Messages are shown as a conversation (mine on one side), sent with Enter,
 *      and never sent empty.
 *   5. The active branch is marked, and the old question threads are one link away.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN_USER, RECEPTIONIST_USER, installApiMock, renderApp } from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Handler = (init: RequestInit) => { status: number; body?: unknown };

function channel(id: number, over: Record<string, unknown> = {}) {
  return {
    branchId: id,
    branchNumber: id,
    address: `${id}0 Đường ${id}`,
    hotelName: `Hotel ${id}`,
    conversationId: null,
    lastMessage: null,
    unreadCount: 0,
    ...over,
  };
}

const EIGHT = Array.from({ length: 8 }, (_, i) => channel(i + 1));

function message(id: string, body: string, senderId: number, over: Record<string, unknown> = {}) {
  return {
    id,
    conversationId: 'c1',
    body,
    senderRole: senderId === 1 ? 'ADMIN' : 'RECEPTIONIST',
    sender: { id: senderId, fullName: senderId === 1 ? 'Quản trị viên' : 'Lễ tân Một' },
    senderLabel: senderId === 1 ? 'Quản trị viên' : 'Lễ tân Một',
    createdAt: new Date().toISOString(),
    attachments: [],
    ...over,
  };
}

function shell(user: unknown, extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/me': () => ({ status: 200, body: { user } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/issues/summary': () => ({
      status: 200,
      body: { summary: { totalUnresolved: 0, newCount: 0, inProgressCount: 0, byBranch: [] } },
    }),
    'GET /api/nav-badges': () => ({
      status: 200,
      body: { counts: { new: 0, pendingReview: 0, rejected: 0, resendOrders: 0, chat: 0, reminders: 0 } },
    }),
    'GET /api/reception/shifts/current': () => ({ status: 200, body: { session: null } }),
    'GET /api/reception/shifts/options': () => ({ status: 200, body: { shifts: [] } }),
    'GET /api/reminders': () => ({ status: 200, body: { reminders: [] } }),
    ...extra,
  };
}

async function openBubble() {
  await userEvent.click(await screen.findByTestId('chat-bubble'));
  return screen.findByTestId('chat-panel');
}

describe('the bubble', () => {
  it.each([
    ['/app/dashboard', ADMIN_USER],
    ['/app/settings', ADMIN_USER],
    ['/app/reminders', RECEPTIONIST_USER],
  ])('is on %s', async (path, user) => {
    installApiMock(shell(user, { 'GET /api/chat/channels': () => ({ status: 200, body: { channels: EIGHT } }) }));
    renderApp(path);
    expect(await screen.findByTestId('chat-bubble')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-panel')).not.toBeInTheDocument();
  });

  it('opens and closes a panel over the page, without navigating', async () => {
    installApiMock(shell(ADMIN_USER, { 'GET /api/chat/channels': () => ({ status: 200, body: { channels: EIGHT } }) }));
    renderApp('/app/settings');
    const panel = await openBubble();
    expect(panel).toHaveAttribute('role', 'dialog');
    expect(screen.getByTestId('chat-bubble')).toHaveAttribute('aria-expanded', 'true');
    // The page underneath is still there.
    expect(screen.getAllByRole('heading', { name: 'Quản lý tài khoản' }).length).toBeGreaterThan(0);

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('chat-panel')).not.toBeInTheDocument());
    expect(screen.getByTestId('chat-bubble')).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows the total unread on the bubble — and nothing when there is none', async () => {
    installApiMock(
      shell(ADMIN_USER, {
        'GET /api/chat/channels': () => ({
          status: 200,
          body: { channels: [channel(1, { unreadCount: 2 }), channel(2, { unreadCount: 3 }), channel(3)] },
        }),
      }),
    );
    renderApp('/app/dashboard');
    expect(await screen.findByTestId('chat-bubble-unread')).toHaveTextContent('5');
    expect(screen.getByTestId('chat-bubble')).toHaveAccessibleName('Chat — 5 tin chưa đọc');
  });

  it('carries no badge when nothing is unread', async () => {
    installApiMock(shell(ADMIN_USER, { 'GET /api/chat/channels': () => ({ status: 200, body: { channels: EIGHT } }) }));
    renderApp('/app/dashboard');
    await screen.findByTestId('chat-bubble');
    expect(screen.queryByTestId('chat-bubble-unread')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-bubble')).toHaveAccessibleName('Chat');
  });
});

describe('the branch list', () => {
  it('lists exactly the branches the server sends — eight today', async () => {
    installApiMock(shell(ADMIN_USER, { 'GET /api/chat/channels': () => ({ status: 200, body: { channels: EIGHT } }) }));
    renderApp('/app/dashboard');
    const panel = await openBubble();
    const list = within(panel).getByTestId('chat-branch-list');
    expect(within(list).getAllByRole('button')).toHaveLength(8);
    expect(within(list).getByTestId('chat-branch-1')).toHaveTextContent('10 Đường 1');
  });

  it('shows a ninth branch the moment the server sends it — nothing is hard-coded', async () => {
    installApiMock(
      shell(ADMIN_USER, {
        'GET /api/chat/channels': () => ({
          status: 200,
          body: { channels: [...EIGHT, channel(9, { address: '99 Đường Mới', hotelName: 'Khách sạn mới' })] },
        }),
      }),
    );
    renderApp('/app/dashboard');
    const panel = await openBubble();
    expect(within(within(panel).getByTestId('chat-branch-list')).getAllByRole('button')).toHaveLength(9);
    expect(within(panel).getByTestId('chat-branch-9')).toHaveTextContent('99 Đường Mới');
  });

  it('filters by a typed name', async () => {
    installApiMock(shell(ADMIN_USER, { 'GET /api/chat/channels': () => ({ status: 200, body: { channels: EIGHT } }) }));
    renderApp('/app/dashboard');
    const panel = await openBubble();
    await userEvent.type(within(panel).getByLabelText('Tìm chi nhánh'), 'Đường 3');
    const list = within(panel).getByTestId('chat-branch-list');
    expect(within(list).getAllByRole('button')).toHaveLength(1);
    expect(within(list).getByTestId('chat-branch-3')).toBeInTheDocument();
  });

  it('marks unread on the branch that has it, and previews its last message', async () => {
    installApiMock(
      shell(ADMIN_USER, {
        'GET /api/chat/channels': () => ({
          status: 200,
          body: {
            channels: [
              channel(1, {
                unreadCount: 2,
                lastMessage: { preview: 'Máy lạnh phòng 302 hỏng', createdAt: new Date().toISOString(), senderLabel: 'Lễ tân Một', mine: false },
              }),
              channel(2, {
                lastMessage: { preview: 'Đã xử lý', createdAt: new Date().toISOString(), senderLabel: 'Quản trị viên', mine: true },
              }),
            ],
          },
        }),
      }),
    );
    renderApp('/app/dashboard');
    const panel = await openBubble();
    expect(within(panel).getByTestId('chat-unread-1')).toHaveTextContent('2');
    expect(within(panel).queryByTestId('chat-unread-2')).not.toBeInTheDocument();
    expect(within(panel).getByTestId('chat-branch-1')).toHaveTextContent('Máy lạnh phòng 302 hỏng');
    expect(within(panel).getByTestId('chat-branch-2')).toHaveTextContent('Bạn: Đã xử lý');
  });

  it('opens a receptionist’s only branch by itself, with no list to choose from', async () => {
    installApiMock(
      shell(RECEPTIONIST_USER, {
        'GET /api/chat/channels': () => ({ status: 200, body: { channels: [channel(1)] } }),
        'GET /api/chat/channels/1/messages': () => ({ status: 200, body: { messages: [] } }),
      }),
    );
    renderApp('/app/reminders');
    const panel = await openBubble();
    expect(await within(panel).findByTestId('chat-active-branch')).toHaveTextContent('10 Đường 1 - Chi nhánh 01');
    // There is only one branch to talk to: its conversation is all there is.
    expect(within(panel).getByLabelText('Danh sách chi nhánh')).toHaveClass('hidden');
    // …and the way to the old question threads is still there for them.
    expect(within(panel).getByRole('link', { name: /Gửi vấn đề riêng/ })).toHaveAttribute('href', '/app/chat');
    expect(within(panel).getByTestId('chat-bubble-input')).toBeInTheDocument();
  });
});

describe('a conversation', () => {
  function adminRoutes(extra: Record<string, Handler> = {}) {
    return shell(ADMIN_USER, {
      'GET /api/chat/channels': () => ({ status: 200, body: { channels: [channel(1, { unreadCount: 2 }), channel(2)] } }),
      'GET /api/chat/channels/1/messages': () => ({
        status: 200,
        body: { messages: [message('m1', 'Máy lạnh phòng 302 hỏng', 2), message('m2', 'Kỹ thuật sẽ qua ngay', 1)] },
      }),
      'POST /api/chat/channels/1/read': () => ({ status: 200, body: { ok: true } }),
      ...extra,
    });
  }

  it('marks the active branch and shows the messages, mine on my side', async () => {
    installApiMock(adminRoutes());
    renderApp('/app/dashboard');
    const panel = await openBubble();
    await userEvent.click(within(panel).getByTestId('chat-branch-1'));

    expect(within(panel).getByTestId('chat-branch-1')).toHaveAttribute('aria-current', 'true');
    expect(within(panel).getByTestId('chat-branch-2')).not.toHaveAttribute('aria-current');
    expect(within(panel).getByTestId('chat-active-branch')).toHaveTextContent('10 Đường 1 - Chi nhánh 01');

    const bubbles = await within(panel).findAllByTestId('chat-message');
    expect(bubbles).toHaveLength(2);
    // The other side names its sender and role; my own bubble does not.
    expect(bubbles[0]).toHaveTextContent('Lễ tân Một · Lễ tân');
    expect(bubbles[0]).toHaveTextContent('Máy lạnh phòng 302 hỏng');
    expect(bubbles[1]).not.toHaveTextContent('Quản trị viên');
    expect(bubbles[1]!.firstElementChild!.className).toMatch(/bg-brand-600/);
    expect(bubbles[0]!.className).toMatch(/justify-start/);
    expect(bubbles[1]!.className).toMatch(/justify-end/);
  });

  it('tells the server it was read once the messages are on screen', async () => {
    const reads: string[] = [];
    installApiMock(
      adminRoutes({
        'POST /api/chat/channels/1/read': () => {
          reads.push('read');
          return { status: 200, body: { ok: true } };
        },
      }),
    );
    renderApp('/app/dashboard');
    const panel = await openBubble();
    await userEvent.click(within(panel).getByTestId('chat-branch-1'));
    await within(panel).findAllByTestId('chat-message');
    await waitFor(() => expect(reads).toEqual(['read']));
  });

  it('sends with Enter, keeps Shift+Enter for a new line, and never sends nothing', async () => {
    const sent: string[] = [];
    installApiMock(
      adminRoutes({
        'POST /api/chat/channels/1/messages': (init) => {
          sent.push(String((init.body as FormData).get('body')));
          return { status: 201, body: { message: message('m3', 'x', 1) } };
        },
      }),
    );
    renderApp('/app/dashboard');
    const panel = await openBubble();
    await userEvent.click(within(panel).getByTestId('chat-branch-1'));
    const input = await within(panel).findByTestId('chat-bubble-input');

    expect(within(panel).getByTestId('chat-bubble-send')).toBeDisabled();
    await userEvent.type(input, '   {Enter}');
    expect(sent).toEqual([]);
    await userEvent.clear(input);

    await userEvent.type(input, 'Dòng một{Shift>}{Enter}{/Shift}Dòng hai');
    expect(input).toHaveValue('Dòng một\nDòng hai');
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(sent).toEqual(['Dòng một\nDòng hai']));
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('refuses a file that is not an image, before it is ever sent', async () => {
    installApiMock(adminRoutes());
    renderApp('/app/dashboard');
    const panel = await openBubble();
    await userEvent.click(within(panel).getByTestId('chat-branch-1'));
    const files = await within(panel).findByTestId('chat-bubble-images');
    await userEvent.upload(files, new File(['x'], 'macro.exe', { type: 'application/octet-stream' }), { applyAccept: false });
    expect(await within(panel).findByRole('alert')).toHaveTextContent('Chỉ chấp nhận ảnh PNG, JPEG hoặc WebP.');
  });

  it('shows the server’s refusal instead of pretending it sent', async () => {
    installApiMock(
      adminRoutes({
        'POST /api/chat/channels/1/messages': () => ({
          status: 404,
          body: { error: { code: 'NOT_FOUND', message: 'Không tìm thấy chi nhánh.' } },
        }),
      }),
    );
    renderApp('/app/dashboard');
    const panel = await openBubble();
    await userEvent.click(within(panel).getByTestId('chat-branch-1'));
    await userEvent.type(await within(panel).findByTestId('chat-bubble-input'), 'Xin chào{Enter}');
    expect(await within(panel).findByRole('alert')).toHaveTextContent('Không tìm thấy chi nhánh.');
  });

  it('says so when a branch has never been written to', async () => {
    installApiMock(
      adminRoutes({ 'GET /api/chat/channels/2/messages': () => ({ status: 200, body: { messages: [] } }) }),
    );
    renderApp('/app/dashboard');
    const panel = await openBubble();
    await userEvent.click(within(panel).getByTestId('chat-branch-2'));
    expect(await within(panel).findByText(/Chưa có tin nhắn\. Hãy gửi tin đầu tiên/)).toBeInTheDocument();
  });

  it('keeps the old question threads one link away', async () => {
    installApiMock(adminRoutes({ 'GET /api/chat/conversations': () => ({ status: 200, body: { conversations: [] } }) }));
    renderApp('/app/dashboard');
    const panel = await openBubble();
    const link = within(panel).getByRole('link', { name: /Gửi vấn đề riêng/ });
    expect(link).toHaveAttribute('href', '/app/chat');
  });
});
