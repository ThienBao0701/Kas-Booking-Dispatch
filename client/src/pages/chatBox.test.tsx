/**
 * Chat box, from the browser's side.
 *
 * WHAT THESE TESTS ARE AND ARE NOT. The navigation and route assertions are
 * about ACCESS as the operator experiences it — a menu entry that appears for
 * the wrong role, or a URL that renders when typed, is a real bug. They are NOT
 * the security boundary: the API is, and the server suite proves it. Both are
 * written because either alone would be misleading.
 *
 * The rest is about the two things a chat screen must never get wrong: sending
 * what the user typed (with their images), and showing each side of the
 * conversation to the right person.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ADMIN_USER,
  BOOKING_DEPARTMENT_USER,
  RECEPTIONIST_USER,
  installApiMock,
  renderApp,
} from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BRANCH = { id: 1, code: 'TRUONG_DINH_05', hotelName: 'Saigon Hotel' };

function conversation(over: Record<string, unknown> = {}) {
  return {
    id: 'conv1',
    subject: 'Khách đòi đổi phòng lúc nửa đêm',
    category: null,
    title: 'Khách đòi đổi phòng lúc nửa đêm',
    senderLabel: 'Lễ tân Một',
    anonymous: false,
    shiftType: null,
    handledBy: null,
    handledAt: null,
    adminNote: null,
    status: 'WAITING_ADMIN',
    branch: BRANCH,
    createdBy: { id: RECEPTIONIST_USER.id, fullName: 'Lễ tân Một', role: 'RECEPTIONIST' },
    createdAt: '2026-08-09T02:00:00.000Z',
    updatedAt: '2026-08-09T02:00:00.000Z',
    lastMessageAt: '2026-08-09T02:00:00.000Z',
    // Deliberately NOT the subject: the row shows both, and a fixture that
    // repeated itself would make "which element did we find?" ambiguous.
    lastMessagePreview: 'Em xử lý sao ạ?',
    messageCount: 1,
    ...over,
  };
}

function message(over: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    conversationId: 'conv1',
    body: 'Khách đòi đổi phòng lúc nửa đêm, em xử lý sao ạ?',
    senderRole: 'RECEPTIONIST',
    sender: { id: RECEPTIONIST_USER.id, fullName: 'Lễ tân Một' },
    createdAt: '2026-08-09T02:00:00.000Z',
    attachments: [],
    ...over,
  };
}

function mountChat(
  user: typeof ADMIN_USER,
  extra: Record<string, (init: RequestInit) => { status: number; body?: unknown }> = {},
) {
  return installApiMock({
    'GET /api/auth/me': () => ({ status: 200, body: { user } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/chat/conversations': () => ({ status: 200, body: { conversations: [conversation()] } }),
    'GET /api/chat/conversations/conv1': () => ({ status: 200, body: { conversation: conversation() } }),
    'GET /api/chat/conversations/conv1/messages': () => ({ status: 200, body: { messages: [message()] } }),
    ...extra,
  });
}

/* ================================================================== */
/* Who can see Chat box                                                */
/* ================================================================== */

describe('who can see Chat box', () => {
  /*
    "Chat box" is no longer a menu entry: the chat is the bubble in the corner of
    every page. The question threads' pages are unchanged and still open by
    address (and from a link in the bubble), so nothing that was written is lost.
  */
  it('has no menu item for an Admin — the chat is the bubble', async () => {
    mountChat(ADMIN_USER);
    renderApp('/app/chat');
    await screen.findByTestId('chat-conversations');
    expect(screen.queryByRole('link', { name: /Chat box/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-bubble')).toBeInTheDocument();
  });

  it('has no menu item for a receptionist — the chat is the bubble', async () => {
    mountChat(RECEPTIONIST_USER);
    renderApp('/app/chat');
    await screen.findByTestId('chat-conversations');
    expect(screen.queryByRole('link', { name: /Chat box/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-bubble')).toBeInTheDocument();
  });

  it('does NOT show it to Bộ phận đặt phòng', async () => {
    mountChat(BOOKING_DEPARTMENT_USER);
    renderApp('/app/charge-documents');
    await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(screen.queryByRole('link', { name: /Chat box/ })).not.toBeInTheDocument();
  });

  it('refuses Bộ phận đặt phòng who types the URL directly', async () => {
    mountChat(BOOKING_DEPARTMENT_USER);
    renderApp('/app/chat');
    // The page must not render; the API would refuse the call too.
    await waitFor(() =>
      expect(screen.queryByTestId('chat-conversations')).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId('chat-new')).not.toBeInTheDocument();
  });
});

/* ================================================================== */
/* The list                                                            */
/* ================================================================== */

describe('the conversation list', () => {
  it('shows the sender and branch to an Admin', async () => {
    mountChat(ADMIN_USER);
    renderApp('/app/chat');

    const list = await screen.findByTestId('chat-conversations');
    expect(within(list).getByText(/Khách đòi đổi phòng lúc nửa đêm/)).toBeInTheDocument();
    expect(within(list).getByText(/Lễ tân Một/)).toBeInTheDocument();
    expect(within(list).getByText(/Saigon Hotel/)).toBeInTheDocument();
  });

  it('marks an unanswered thread so an Admin can find it', async () => {
    mountChat(ADMIN_USER);
    renderApp('/app/chat');
    const list = await screen.findByTestId('chat-conversations');
    expect(within(list).getByText('Chờ Admin trả lời')).toBeInTheDocument();
  });

  it('lets an Admin filter down to unanswered threads only', async () => {
    mountChat(ADMIN_USER, {
      'GET /api/chat/conversations': () => ({
        status: 200,
        body: {
          conversations: [
            conversation(),
            conversation({ id: 'conv2', subject: null, title: 'Đã xong', status: 'ANSWERED' }),
          ],
        },
      }),
    });
    const user = userEvent.setup();
    renderApp('/app/chat');

    const list = await screen.findByTestId('chat-conversations');
    expect(within(list).getByText('Đã xong')).toBeInTheDocument();

    await user.click(screen.getByLabelText(/Chỉ hiện chưa trả lời/));
    await waitFor(() => expect(screen.queryByText('Đã xong')).not.toBeInTheDocument());
    expect(screen.getByText(/Khách đòi đổi phòng lúc nửa đêm/)).toBeInTheDocument();
  });

  it('offers the ask-a-question control to a receptionist', async () => {
    mountChat(RECEPTIONIST_USER);
    renderApp('/app/chat');
    expect(await screen.findByTestId('chat-new')).toBeInTheDocument();
  });

  it('does not offer it to an Admin — reception asks, Admin answers', async () => {
    mountChat(ADMIN_USER);
    renderApp('/app/chat');
    await screen.findByTestId('chat-conversations');
    expect(screen.queryByTestId('chat-new')).not.toBeInTheDocument();
  });
});

/* ================================================================== */
/* Creating a conversation                                             */
/* ================================================================== */

describe('a receptionist opens a conversation', () => {
  it('posts the category, body and images as multipart', async () => {
    const fetchMock = mountChat(RECEPTIONIST_USER, {
      'POST /api/chat/conversations': () => ({
        status: 201,
        body: { conversation: conversation(), message: message() },
      }),
    });
    const user = userEvent.setup();
    renderApp('/app/chat');

    await user.click(await screen.findByTestId('chat-new'));
    await user.selectOptions(screen.getByLabelText('Loại vấn đề'), 'ROOM');
    await user.type(screen.getByLabelText('Nội dung'), 'Khách muốn đổi phòng');
    await user.upload(
      screen.getByLabelText(/Ảnh đính kèm/),
      [
        new File(['a'], 'one.png', { type: 'image/png' }),
        new File(['b'], 'two.png', { type: 'image/png' }),
      ],
    );
    await user.click(screen.getByTestId('chat-send'));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([u, init]) =>
          String(u) === '/api/chat/conversations' &&
          (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeDefined();
      const form = (post![1] as RequestInit).body as FormData;
      expect(form.get('category')).toBe('ROOM');
      expect(form.get('subject')).toBeNull();
      expect(form.get('body')).toBe('Khách muốn đổi phòng');
      // MULTIPLE IMAGES PER MESSAGE: both must survive to the request.
      expect(form.getAll('images')).toHaveLength(2);
    });
  });

  it('refuses to send without a category', async () => {
    const fetchMock = mountChat(RECEPTIONIST_USER);
    const user = userEvent.setup();
    renderApp('/app/chat');

    await user.click(await screen.findByTestId('chat-new'));
    await user.type(screen.getByLabelText('Nội dung'), 'Thiếu tiêu đề');
    await user.click(screen.getByTestId('chat-send'));

    expect(await screen.findByText('Vui lòng chọn loại vấn đề.')).toBeInTheDocument();
    const posts = fetchMock.mock.calls.filter(
      ([u, init]) =>
        String(u) === '/api/chat/conversations' &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(posts).toHaveLength(0);
  });

  /** A first message must carry TEXT now: a category plus a photo is nothing an Admin can act on. */
  it('refuses a first message with no text', async () => {
    const fetchMock = mountChat(RECEPTIONIST_USER);
    const user = userEvent.setup();
    renderApp('/app/chat');

    await user.click(await screen.findByTestId('chat-new'));
    await user.selectOptions(screen.getByLabelText('Loại vấn đề'), 'ROOM');
    await user.click(screen.getByTestId('chat-send'));

    expect(
      await screen.findByText('Vui lòng nhập nội dung.'),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
      ),
    ).toHaveLength(0);
  });
});

/* ================================================================== */
/* The thread                                                          */
/* ================================================================== */

describe('the conversation thread', () => {
  it('renders messages and loads images from the authenticated endpoint', async () => {
    mountChat(ADMIN_USER, {
      'GET /api/chat/conversations/conv1/messages': () => ({
        status: 200,
        body: {
          messages: [
            message({
              attachments: [
                {
                  id: 'att1',
                  originalFileName: 'phong.png',
                  mimeType: 'image/png',
                  fileSize: 1024,
                  createdAt: '2026-08-09T02:00:00.000Z',
                },
              ],
            }),
          ],
        },
      }),
    });
    renderApp('/app/chat/conv1');

    const thread = await screen.findByTestId('chat-thread');
    expect(within(thread).getByText(/Khách đòi đổi phòng lúc nửa đêm/)).toBeInTheDocument();

    const img = within(thread).getByAltText('phong.png') as HTMLImageElement;
    // No public URL, no signed link: the bytes come from an endpoint that
    // re-checks the caller on every request.
    expect(img.getAttribute('src')).toBe('/api/chat/attachments/att1/file');
  });

  it('lets an Admin reply, sending the text and images as multipart', async () => {
    const fetchMock = mountChat(ADMIN_USER, {
      'POST /api/chat/conversations/conv1/messages': () => ({
        status: 201,
        body: { message: message({ id: 'm2', body: 'Em cứ đổi phòng cho khách nhé.' }) },
      }),
    });
    const user = userEvent.setup();
    renderApp('/app/chat/conv1');

    await screen.findByTestId('chat-thread');
    await user.type(screen.getByTestId('chat-input'), 'Em cứ đổi phòng cho khách nhé.');
    await user.upload(
      screen.getByLabelText('Ảnh đính kèm'),
      new File(['x'], 'huongdan.png', { type: 'image/png' }),
    );
    await user.click(screen.getByRole('button', { name: /Gửi/ }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([u, init]) =>
          String(u) === '/api/chat/conversations/conv1/messages' &&
          (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeDefined();
      const form = (post![1] as RequestInit).body as FormData;
      expect(form.get('body')).toBe('Em cứ đổi phòng cho khách nhé.');
      expect(form.getAll('images')).toHaveLength(1);
    });
  });

  it('refuses to send an empty message', async () => {
    const fetchMock = mountChat(ADMIN_USER);
    const user = userEvent.setup();
    renderApp('/app/chat/conv1');

    await screen.findByTestId('chat-thread');
    await user.click(screen.getByRole('button', { name: /Gửi/ }));

    expect(
      await screen.findByText('Vui lòng nhập nội dung hoặc đính kèm ảnh.'),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
      ),
    ).toHaveLength(0);
  });

  it('surfaces a server refusal rather than pretending the message sent', async () => {
    mountChat(RECEPTIONIST_USER, {
      'POST /api/chat/conversations/conv1/messages': () => ({
        status: 404,
        body: { error: { code: 'NOT_FOUND', message: 'Không tìm thấy cuộc trò chuyện.' } },
      }),
    });
    const user = userEvent.setup();
    renderApp('/app/chat/conv1');

    await screen.findByTestId('chat-thread');
    await user.type(screen.getByTestId('chat-input'), 'Xin chào');
    await user.click(screen.getByRole('button', { name: /Gửi/ }));

    expect(await screen.findByText(/Không tìm thấy cuộc trò chuyện/)).toBeInTheDocument();
  });

  it('offers "Đã xử lý" to an Admin', async () => {
    mountChat(ADMIN_USER);
    renderApp('/app/chat/conv1');
    await screen.findByTestId('chat-thread');
    expect(screen.getByTestId('chat-close')).toBeInTheDocument();
  });

  it('does not offer "Đã xử lý" to a receptionist', async () => {
    mountChat(RECEPTIONIST_USER);
    renderApp('/app/chat/conv1');
    await screen.findByTestId('chat-thread');
    expect(screen.queryByTestId('chat-close')).not.toBeInTheDocument();
  });
});
