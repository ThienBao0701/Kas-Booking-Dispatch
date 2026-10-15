/**
 * Chat box: the category selector, "Gửi", and "Gửi ẩn danh".
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. The title is a CHOICE now, not a sentence. There is no free-text title
 *      field left anywhere in the form.
 *   2. The send button says "Gửi", and "Gửi câu hỏi" is gone — as is the
 *      "Câu hỏi mới" heading above the form.
 *   3. "Gửi ẩn danh" states its three consequences BEFORE it happens. A
 *      receptionist who expected an answer and never gets one has been failed
 *      quietly, which is the one failure mode a privacy feature must not have.
 *   4. An Admin sees an anonymous thread as "Ẩn danh", with no name anywhere.
 *   5. An ordinary thread still shows who asked — the anonymity is a property of
 *      the thread, not a blanket suppression.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN_USER, RECEPTIONIST_USER, installApiMock, renderApp } from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BRANCH = { id: 1, code: 'TRUONG_DINH_05', hotelName: 'KAS Passion' };

function conversation(over: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    subject: null,
    category: 'ROOM',
    title: 'Phòng',
    status: 'WAITING_ADMIN',
    branch: BRANCH,
    createdBy: { id: 2, fullName: 'Lễ tân Một', role: 'RECEPTIONIST' },
    senderLabel: 'Lễ tân Một',
    anonymous: false,
    shiftType: 'A',
    handledBy: null,
    handledAt: null,
    adminNote: null,
    createdAt: '2026-09-17T02:00:00.000Z',
    updatedAt: '2026-09-17T02:00:00.000Z',
    lastMessageAt: '2026-09-17T02:00:00.000Z',
    lastMessagePreview: 'Máy lạnh phòng 302 kêu to',
    messageCount: 1,
    ...over,
  };
}

function shellRoutes(
  user: unknown,
  extra: Record<string, (init: RequestInit) => { status: number; body?: unknown }> = {},
) {
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
    'GET /api/chat/conversations': () => ({ status: 200, body: { conversations: [] } }),
    ...extra,
  };
}

describe('the submission form', () => {
  async function openForm(
    extra: Record<string, (init: RequestInit) => { status: number; body?: unknown }> = {},
  ) {
    installApiMock(shellRoutes(RECEPTIONIST_USER, extra));
    const user = userEvent.setup();
    renderApp('/app/chat');
    await user.click(await screen.findByTestId('chat-new'));
    return user;
  }

  it('has no free-text title and no "Câu hỏi mới" heading', async () => {
    await openForm();
    expect(screen.queryByText('Câu hỏi mới')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Tiêu đề')).not.toBeInTheDocument();
    // What replaced it.
    expect(screen.getByLabelText('Loại vấn đề')).toBeInTheDocument();
  });

  it('offers exactly the three categories, with nothing preselected', async () => {
    await openForm();
    const select = screen.getByLabelText('Loại vấn đề') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      '— Chọn —',
      'Phòng',
      'Môi trường làm việc',
      'Các vấn đề nội bộ',
    ]);
    // A default nobody chose is accepted without anybody noticing it was never
    // a decision — the same lesson Ca A and Ca A4 taught.
    expect(select.value).toBe('');
  });

  it('says "Gửi", not "Gửi câu hỏi"', async () => {
    await openForm();
    expect(screen.getByTestId('chat-send')).toHaveTextContent('Gửi');
    expect(screen.queryByRole('button', { name: /Gửi câu hỏi/ })).not.toBeInTheDocument();
  });

  it('refuses to send without a category', async () => {
    let posted = 0;
    const user = await openForm({
      'POST /api/chat/conversations': () => {
        posted += 1;
        return { status: 201, body: { conversation: conversation(), message: {} } };
      },
    });

    await user.type(screen.getByLabelText('Nội dung'), 'Có việc cần hỏi');
    await user.click(screen.getByTestId('chat-send'));

    expect(await screen.findByText('Vui lòng chọn loại vấn đề.')).toBeInTheDocument();
    expect(posted).toBe(0);
  });

  it('refuses to send without content', async () => {
    let posted = 0;
    const user = await openForm({
      'POST /api/chat/conversations': () => {
        posted += 1;
        return { status: 201, body: { conversation: conversation(), message: {} } };
      },
    });

    await user.selectOptions(screen.getByLabelText('Loại vấn đề'), 'ROOM');
    await user.click(screen.getByTestId('chat-send'));

    expect(await screen.findByText('Vui lòng nhập nội dung.')).toBeInTheDocument();
    expect(posted).toBe(0);
  });

  it('posts the category and a NOT-anonymous flag for an ordinary send', async () => {
    let form: FormData | null = null;
    const user = await openForm({
      'POST /api/chat/conversations': (init) => {
        form = init.body as FormData;
        return { status: 201, body: { conversation: conversation(), message: {} } };
      },
    });

    await user.selectOptions(screen.getByLabelText('Loại vấn đề'), 'WORK_ENVIRONMENT');
    await user.type(screen.getByLabelText('Nội dung'), 'Điều hoà khu vực lễ tân hỏng');
    await user.click(screen.getByTestId('chat-send'));

    await waitFor(() => expect(form).not.toBeNull());
    expect(form!.get('category')).toBe('WORK_ENVIRONMENT');
    expect(form!.get('body')).toBe('Điều hoà khu vực lễ tân hỏng');
    // The literal string, not a boolean: `Boolean('false')` is `true`, and
    // getting that wrong would make every submission anonymous.
    expect(form!.get('anonymous')).toBe('false');
    expect(form!.get('subject')).toBeNull();
  });
});

describe('"Gửi ẩn danh"', () => {
  async function fillForm(
    extra: Record<string, (init: RequestInit) => { status: number; body?: unknown }> = {},
  ) {
    installApiMock(shellRoutes(RECEPTIONIST_USER, extra));
    const user = userEvent.setup();
    renderApp('/app/chat');
    await user.click(await screen.findByTestId('chat-new'));
    await user.selectOptions(screen.getByLabelText('Loại vấn đề'), 'INTERNAL');
    await user.type(screen.getByLabelText('Nội dung'), 'Phản ánh nội bộ');
    return user;
  }

  /**
   * ALL THREE CONSEQUENCES, SAID PLAINLY, BEFORE IT HAPPENS.
   *
   * None of them is reversible, and the third one — no reply will ever arrive —
   * is the one a receptionist would otherwise discover by waiting.
   */
  it('confirms, and names what anonymity actually costs', async () => {
    let posted = 0;
    const user = await fillForm({
      'POST /api/chat/conversations': () => {
        posted += 1;
        return { status: 201, body: { conversation: conversation({ anonymous: true }), message: {} } };
      },
    });

    await user.click(screen.getByTestId('chat-send-anonymous'));
    const dialog = await screen.findByRole('dialog', { name: 'Gửi ẩn danh' });
    expect(posted).toBe(0);

    expect(within(dialog).getByText(/Admin sẽ thấy người gửi là “Ẩn danh”/)).toBeInTheDocument();
    expect(within(dialog).getByText(/sẽ không còn hiển thị trong danh sách của bạn/)).toBeInTheDocument();
    expect(within(dialog).getByText(/sẽ không nhận được câu trả lời/)).toBeInTheDocument();
  });

  it('sends anonymous=true only after the confirmation', async () => {
    let form: FormData | null = null;
    const user = await fillForm({
      'POST /api/chat/conversations': (init) => {
        form = init.body as FormData;
        return { status: 201, body: { conversation: conversation({ anonymous: true }), message: {} } };
      },
    });

    await user.click(screen.getByTestId('chat-send-anonymous'));
    await user.click(await screen.findByTestId('chat-anonymous-confirm'));

    await waitFor(() => expect(form).not.toBeNull());
    expect(form!.get('anonymous')).toBe('true');
    expect(form!.get('category')).toBe('INTERNAL');
  });

  it('sends nothing if the confirmation is cancelled', async () => {
    let posted = 0;
    const user = await fillForm({
      'POST /api/chat/conversations': () => {
        posted += 1;
        return { status: 201, body: { conversation: conversation(), message: {} } };
      },
    });

    await user.click(screen.getByTestId('chat-send-anonymous'));
    const dialog = await screen.findByRole('dialog', { name: 'Gửi ẩn danh' });
    await user.click(within(dialog).getByRole('button', { name: 'Hủy' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Gửi ẩn danh' })).not.toBeInTheDocument(),
    );
    expect(posted).toBe(0);
  });

  it('validates before it confirms — no dialog for an empty form', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    const user = userEvent.setup();
    renderApp('/app/chat');
    await user.click(await screen.findByTestId('chat-new'));
    await user.click(screen.getByTestId('chat-send-anonymous'));

    expect(await screen.findByText('Vui lòng chọn loại vấn đề.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Gửi ẩn danh' })).not.toBeInTheDocument();
  });
});

describe('the Admin list', () => {
  it('shows an anonymous thread as "Ẩn danh", with no name', async () => {
    installApiMock(
      shellRoutes(ADMIN_USER, {
        'GET /api/chat/conversations': () => ({
          status: 200,
          body: {
            conversations: [
              conversation({
                id: 'anon',
                category: 'INTERNAL',
                title: 'Các vấn đề nội bộ',
                anonymous: true,
                createdBy: null,
                senderLabel: 'Ẩn danh',
              }),
            ],
          },
        }),
      }),
    );
    renderApp('/app/chat');

    const list = await screen.findByTestId('chat-conversations');
    expect(within(list).getByText('Các vấn đề nội bộ')).toBeInTheDocument();
    // Twice: the chip beside the status, and the sender line.
    expect(within(list).getAllByText('Ẩn danh').length).toBeGreaterThanOrEqual(1);
    expect(within(list).queryByText(/Lễ tân Một/)).not.toBeInTheDocument();
  });

  /**
   * The anonymity is a property of the THREAD, not a blanket suppression: an
   * ordinary question must still say who asked, or the Admin cannot answer it.
   */
  it('still names the asker on an ordinary thread', async () => {
    installApiMock(
      shellRoutes(ADMIN_USER, {
        'GET /api/chat/conversations': () => ({
          status: 200,
          body: { conversations: [conversation()] },
        }),
      }),
    );
    renderApp('/app/chat');

    const list = await screen.findByTestId('chat-conversations');
    expect(within(list).getByText(/Lễ tân Một/)).toBeInTheDocument();
    expect(within(list).queryByText('Ẩn danh')).not.toBeInTheDocument();
  });

  it('renders a category thread by its label and a legacy thread by its title', async () => {
    installApiMock(
      shellRoutes(ADMIN_USER, {
        'GET /api/chat/conversations': () => ({
          status: 200,
          body: {
            conversations: [
              conversation({ id: 'new', category: 'ROOM', title: 'Phòng' }),
              // A thread that predates the selector keeps the words its author
              // typed — reclassifying it would be a guess recorded as a fact.
              conversation({
                id: 'old',
                category: null,
                subject: 'Câu hỏi cũ',
                title: 'Câu hỏi cũ',
              }),
            ],
          },
        }),
      }),
    );
    renderApp('/app/chat');

    const list = await screen.findByTestId('chat-conversations');
    expect(within(list).getByText('Phòng')).toBeInTheDocument();
    expect(within(list).getByText('Câu hỏi cũ')).toBeInTheDocument();
  });
});
