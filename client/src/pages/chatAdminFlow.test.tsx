/**
 * Chat box — the ADMIN's end-to-end path, and the ownership boundary.
 *
 * WHY THIS FILE EXISTS SEPARATELY. `chatBox.test.tsx` proves the pieces work.
 * This one walks the whole journey in the order a person actually performs it:
 * see the list → CLICK a receptionist's row → land on the right thread → read
 * both sides → reply with an image. The click-through is the part a
 * component-level test silently skips, and it is exactly where a wrong link, a
 * missing route or a role gate would strand an Admin.
 *
 * EVERY REQUEST THE FLOW MAKES IS ASSERTED TO HAVE SUCCEEDED. The mock returns
 * 200s, so the meaningful check is that the client CALLED the endpoints it
 * should and rendered their result — not merely that nothing crashed. Where a
 * 403 would be the regression, it is asserted absent explicitly.
 *
 * The server suite owns the real authorization proof; it cannot run while the
 * test database is still the production one, so the refusal cases here assert
 * the CLIENT surfaces a refusal correctly rather than pretending to be the
 * boundary.
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
const OTHER_BRANCH = { id: 2, code: 'LY_TU_TRONG_260', hotelName: 'Elegance Hotel' };

/** Receptionist A's thread — the one the Admin must be able to open. */
const CONV_A = {
  id: 'convA',
  subject: 'Khách đòi đổi phòng lúc nửa đêm',
  category: null,
  title: 'Khách đòi đổi phòng lúc nửa đêm',
  senderLabel: 'Lễ tân Một',
  anonymous: false,
  shiftType: null,
  handledBy: null,
  handledAt: null,
  adminNote: null,
  status: 'WAITING_ADMIN' as const,
  branch: BRANCH,
  createdBy: { id: 2, fullName: 'Lễ tân Một', role: 'RECEPTIONIST' },
  createdAt: '2026-08-09T02:00:00.000Z',
  updatedAt: '2026-08-09T02:00:00.000Z',
  lastMessageAt: '2026-08-09T02:00:00.000Z',
  lastMessagePreview: 'Em xử lý sao ạ?',
  messageCount: 1,
};

/** A different receptionist, at a different branch. */
const CONV_B = {
  ...CONV_A,
  id: 'convB',
  subject: 'Máy lạnh phòng 302 hỏng',
  category: null,
  title: 'Máy lạnh phòng 302 hỏng',
  senderLabel: 'Lễ tân Hai',
  anonymous: false,
  shiftType: null,
  handledBy: null,
  handledAt: null,
  adminNote: null,
  branch: OTHER_BRANCH,
  createdBy: { id: 9, fullName: 'Lễ tân Hai', role: 'RECEPTIONIST' },
  lastMessagePreview: 'Gọi thợ chưa ạ?',
  status: 'ANSWERED' as const,
};

const RECEPTIONIST_MSG = {
  id: 'm1',
  conversationId: 'convA',
  body: 'Khách đòi đổi phòng, em xử lý sao ạ?',
  senderRole: 'RECEPTIONIST' as const,
  sender: { id: 2, fullName: 'Lễ tân Một' },
  senderLabel: 'Lễ tân Một',
  createdAt: '2026-08-09T02:00:00.000Z',
  attachments: [
    {
      id: 'attA',
      originalFileName: 'phong-302.png',
      mimeType: 'image/png',
      fileSize: 2048,
      createdAt: '2026-08-09T02:00:00.000Z',
    },
  ],
};

const ADMIN_REPLY = {
  id: 'm2',
  conversationId: 'convA',
  body: 'Em cứ đổi phòng cho khách nhé.',
  senderRole: 'ADMIN' as const,
  sender: { id: 1, fullName: 'Quản trị viên' },
  createdAt: '2026-08-09T02:05:00.000Z',
  attachments: [],
};

type Handler = (init: RequestInit) => { status: number; body?: unknown };

function mount(user: typeof ADMIN_USER, extra: Record<string, Handler> = {}) {
  return installApiMock({
    'GET /api/auth/me': () => ({ status: 200, body: { user } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/chat/conversations': () => ({
      status: 200,
      body: { conversations: [CONV_A, CONV_B] },
    }),
    'GET /api/chat/conversations/convA': () => ({ status: 200, body: { conversation: CONV_A } }),
    'GET /api/chat/conversations/convA/messages': () => ({
      status: 200,
      body: { messages: [RECEPTIONIST_MSG] },
    }),
    'GET /api/chat/conversations/convB': () => ({ status: 200, body: { conversation: CONV_B } }),
    'GET /api/chat/conversations/convB/messages': () => ({
      status: 200,
      body: { messages: [] },
    }),
    ...extra,
  });
}

/** Every URL the client requested, for asserting a flow actually happened. */
function urlsOf(fetchMock: ReturnType<typeof installApiMock>): string[] {
  return fetchMock.mock.calls.map(([u]) => String(u));
}

/* ================================================================== */
/* B + C — Admin sees, clicks, and opens a receptionist conversation   */
/* ================================================================== */

describe('Admin opens a receptionist conversation', () => {
  it('lists every receptionist thread, from every branch', async () => {
    mount(ADMIN_USER);
    renderApp('/app/chat');

    const list = await screen.findByTestId('chat-conversations');
    expect(within(list).getByText(CONV_A.title)).toBeInTheDocument();
    expect(within(list).getByText(CONV_B.title)).toBeInTheDocument();
    // Sender identity is legible without opening the thread.
    expect(within(list).getAllByText(/Lễ tân Một/).length).toBeGreaterThanOrEqual(1);
    expect(within(list).getByText(/Lễ tân Hai/)).toBeInTheDocument();
  });

  /**
   * ONE ROW PER CONVERSATION, as a compact table: status, subject, branch,
   * sender, time, message count and the way in.
   */
  it('lays the conversations out as a compact table with the specified columns', async () => {
    mount(ADMIN_USER);
    renderApp('/app/chat');

    const list = await screen.findByTestId('chat-conversations');
    const headers = within(list).getAllByRole('columnheader').map((h) => h.textContent);
    const wanted = ['Trạng thái', 'Chủ đề', 'Chi nhánh / khách sạn', 'Người gửi', 'Thời gian', 'Số tin nhắn', 'Thao tác'];
    const at = wanted.map((w) => headers.indexOf(w));
    expect(at.every((i) => i >= 0)).toBe(true);
    // In the specified order.
    expect(at).toEqual([...at].sort((a, b) => a - b));

    const row = within(list).getByTestId('row-convB');
    expect(within(row).getByText('Elegance Hotel')).toBeInTheDocument();
    expect(within(row).getByText('Lễ tân Hai')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Mở' })).toHaveAttribute('href', '/app/chat/convB');
  });

  it('CLICKING a row navigates to that conversation and loads it', async () => {
    const fetchMock = mount(ADMIN_USER);
    const user = userEvent.setup();
    renderApp('/app/chat');

    const list = await screen.findByTestId('chat-conversations');
    await user.click(within(list).getByText(CONV_A.title));

    // The thread rendered — this is the step the previous report cast doubt on.
    const thread = await screen.findByTestId('chat-thread');
    expect(within(thread).getByText(RECEPTIONIST_MSG.body)).toBeInTheDocument();

    await waitFor(() => {
      const urls = urlsOf(fetchMock);
      expect(urls).toContain('/api/chat/conversations/convA');
      expect(urls).toContain('/api/chat/conversations/convA/messages');
    });
  });

  it('opens the OTHER receptionist thread just as well', async () => {
    // "Any conversation" means any — not just the first one in the list.
    const fetchMock = mount(ADMIN_USER);
    const user = userEvent.setup();
    renderApp('/app/chat');

    const list = await screen.findByTestId('chat-conversations');
    await user.click(within(list).getByText(CONV_B.title));

    await screen.findByTestId('chat-thread');
    await waitFor(() =>
      expect(urlsOf(fetchMock)).toContain('/api/chat/conversations/convB/messages'),
    );
  });

  it('shows no forbidden page and no error alert on the way in', async () => {
    mount(ADMIN_USER);
    renderApp('/app/chat/convA');

    await screen.findByTestId('chat-thread');
    // A 403 would land the Admin on the forbidden screen instead.
    expect(screen.queryByText(/Không có quyền|403/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders the asker identity on the detail screen', async () => {
    mount(ADMIN_USER);
    renderApp('/app/chat/convA');
    const thread = await screen.findByTestId('chat-thread');

    // In the bubble: who wrote this particular message.
    expect(within(thread).getByText(/Lễ tân Một/)).toBeInTheDocument();
    // And in the page header: whose thread this is, and from where. Both are
    // wanted — an Admin reading a long thread should not have to scroll to the
    // top bubble to remember who they are talking to.
    expect(screen.getAllByText(/Lễ tân Một/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Saigon Hotel/)).toBeInTheDocument();
  });
});

/* ================================================================== */
/* Admin reads attachments through the authenticated endpoint          */
/* ================================================================== */

describe('Admin views a receptionist image', () => {
  it('points the image at the authenticated attachment endpoint', async () => {
    mount(ADMIN_USER);
    renderApp('/app/chat/convA');

    const thread = await screen.findByTestId('chat-thread');
    const img = within(thread).getByAltText('phong-302.png') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/chat/attachments/attA/file');
    // No public path, no token in the URL, nothing derived from the disk name.
    expect(img.getAttribute('src')).not.toContain('uploads');
    expect(img.getAttribute('src')).not.toContain('token');
  });
});

/* ================================================================== */
/* D + E — Admin replies; both sides live in one conversation          */
/* ================================================================== */

describe('Admin replies in the same conversation', () => {
  it('sends a text reply to the existing thread — never creating a new one', async () => {
    const fetchMock = mount(ADMIN_USER, {
      'POST /api/chat/conversations/convA/messages': () => ({
        status: 201,
        body: { message: ADMIN_REPLY },
      }),
    });
    const user = userEvent.setup();
    renderApp('/app/chat/convA');

    await screen.findByTestId('chat-thread');
    await user.type(screen.getByTestId('chat-input'), ADMIN_REPLY.body);
    await user.click(screen.getByRole('button', { name: /Gửi/ }));

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(posts).toHaveLength(1);
      expect(String(posts[0]![0])).toBe('/api/chat/conversations/convA/messages');
    });

    // The reply must NOT have gone to the create endpoint.
    expect(urlsOf(fetchMock)).not.toContain('/api/chat/conversations');
  });

  it('sends images with the reply', async () => {
    const fetchMock = mount(ADMIN_USER, {
      'POST /api/chat/conversations/convA/messages': () => ({
        status: 201,
        body: { message: ADMIN_REPLY },
      }),
    });
    const user = userEvent.setup();
    renderApp('/app/chat/convA');

    await screen.findByTestId('chat-thread');
    await user.type(screen.getByTestId('chat-input'), 'Xem ảnh hướng dẫn');
    await user.upload(screen.getByLabelText('Ảnh đính kèm'), [
      new File(['a'], 'huongdan-1.png', { type: 'image/png' }),
      new File(['b'], 'huongdan-2.png', { type: 'image/png' }),
    ]);
    await user.click(screen.getByRole('button', { name: /Gửi/ }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([u, init]) =>
          String(u) === '/api/chat/conversations/convA/messages' &&
          (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeDefined();
      const form = (post![1] as RequestInit).body as FormData;
      expect(form.get('body')).toBe('Xem ảnh hướng dẫn');
      expect(form.getAll('images')).toHaveLength(2);
    });
  });

  it('shows both sides of the conversation once the reply lands', async () => {
    // After sending, the thread refetches; the mock now returns both messages.
    let replied = false;
    mount(ADMIN_USER, {
      'GET /api/chat/conversations/convA/messages': () => ({
        status: 200,
        body: { messages: replied ? [RECEPTIONIST_MSG, ADMIN_REPLY] : [RECEPTIONIST_MSG] },
      }),
      'POST /api/chat/conversations/convA/messages': () => {
        replied = true;
        return { status: 201, body: { message: ADMIN_REPLY } };
      },
    });
    const user = userEvent.setup();
    renderApp('/app/chat/convA');

    await screen.findByTestId('chat-thread');
    await user.type(screen.getByTestId('chat-input'), ADMIN_REPLY.body);
    await user.click(screen.getByRole('button', { name: /Gửi/ }));

    const thread = await screen.findByTestId('chat-thread');
    await waitFor(() => {
      expect(within(thread).getByText(RECEPTIONIST_MSG.body)).toBeInTheDocument();
      expect(within(thread).getByText(ADMIN_REPLY.body)).toBeInTheDocument();
    });
    // Two distinct bubbles: the sides are visually separated, not concatenated.
    expect(within(thread).getAllByTestId('chat-message')).toHaveLength(2);
  });

  it('closes the conversation when the Admin says so', async () => {
    const fetchMock = mount(ADMIN_USER, {
      'POST /api/chat/conversations/convA/close': () => ({
        status: 200,
        body: { conversation: { ...CONV_A, status: 'CLOSED' } },
      }),
    });
    const user = userEvent.setup();
    renderApp('/app/chat/convA');

    await screen.findByTestId('chat-thread');
    await user.click(screen.getByTestId('chat-close'));
    // Closing records WHO handled it and an optional note, so it confirms first —
    // the verdict is stored beside the thread, never inside the message.
    await user.click(await screen.findByTestId('chat-close-confirm'));

    await waitFor(() =>
      expect(urlsOf(fetchMock)).toContain('/api/chat/conversations/convA/close'),
    );
  });
});

/* ================================================================== */
/* F — the ownership boundary, as the client experiences it            */
/* ================================================================== */

describe('the ownership boundary', () => {
  it("surfaces the server's refusal for another receptionist's conversation", async () => {
    // The server answers 404 (not 403) so the id is not confirmed to exist.
    // The client must show that, not a blank screen.
    mount(RECEPTIONIST_USER, {
      'GET /api/chat/conversations/convB': () => ({
        status: 404,
        body: { error: { code: 'NOT_FOUND', message: 'Không tìm thấy cuộc trò chuyện.' } },
      }),
      'GET /api/chat/conversations/convB/messages': () => ({
        status: 404,
        body: { error: { code: 'NOT_FOUND', message: 'Không tìm thấy cuộc trò chuyện.' } },
      }),
    });
    renderApp('/app/chat/convB');

    expect(await screen.findByText(/Không tìm thấy cuộc trò chuyện/)).toBeInTheDocument();
    expect(screen.queryByTestId('chat-thread')).not.toBeInTheDocument();
  });

  it('a receptionist only ever sees their own list', async () => {
    // The server filters; the client renders whatever it is given. This asserts
    // the client adds no second, contradictory filter of its own.
    mount(RECEPTIONIST_USER, {
      'GET /api/chat/conversations': () => ({ status: 200, body: { conversations: [CONV_A] } }),
    });
    renderApp('/app/chat');

    const list = await screen.findByTestId('chat-conversations');
    expect(within(list).getByText(CONV_A.title)).toBeInTheDocument();
    expect(within(list).queryByText(CONV_B.title)).not.toBeInTheDocument();
  });

  it('Bộ phận đặt phòng cannot reach the conversation detail by URL', async () => {
    mount(BOOKING_DEPARTMENT_USER);
    renderApp('/app/chat/convA');

    await waitFor(() => expect(screen.queryByTestId('chat-thread')).not.toBeInTheDocument());
    expect(screen.queryByTestId('chat-input')).not.toBeInTheDocument();
  });

  it('Bộ phận đặt phòng has no Chat box navigation entry', async () => {
    mount(BOOKING_DEPARTMENT_USER);
    renderApp('/app/charge-documents');
    await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(screen.queryByRole('link', { name: /Chat box/ })).not.toBeInTheDocument();
  });
});

/* ================================================================== */
/* UI states                                                           */
/* ================================================================== */

describe('loading and error states', () => {
  it('shows the error rather than an empty thread when messages fail', async () => {
    mount(ADMIN_USER, {
      'GET /api/chat/conversations/convA/messages': () => ({
        status: 500,
        body: { error: { code: 'INTERNAL', message: 'Lỗi máy chủ.' } },
      }),
    });
    renderApp('/app/chat/convA');

    expect(await screen.findByText(/Lỗi máy chủ/)).toBeInTheDocument();
  });

  it('tells an Admin when there is nothing waiting', async () => {
    mount(ADMIN_USER, {
      'GET /api/chat/conversations': () => ({ status: 200, body: { conversations: [] } }),
    });
    renderApp('/app/chat');

    expect(await screen.findByText('Chưa có cuộc trò chuyện nào')).toBeInTheDocument();
  });
});
