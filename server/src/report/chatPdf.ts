/**
 * "KAS – BÁO CÁO CHAT BOX / PHẢN ÁNH NỘI BỘ" as a PDF.
 *
 * THE ANONYMITY RULE APPLIES HERE TOO, AND IS ENFORCED THE SAME WAY.
 *
 * This report is built from the SERIALIZED conversation view, not from Prisma
 * rows — which means the author of an anonymous submission has already been
 * dropped by `serializeConversation` before anything reaches this file. There is
 * no column here that could print it even by mistake, because the data is not in
 * the object.
 *
 * Branch and shift ARE printed, as the audit view specifies. That is a real
 * weakening of anonymity on a small team and it is a deliberate, stated
 * trade-off: an internal report nobody can locate is also one nobody can act on.
 */
import type { ChatConversationView } from '../chat/chatService';
import { shiftDefinition } from '../shift/shiftTypes';
import { hcmDateTime, periodLabel, rankedTotals } from './format';
import {
  addPageNumbers,
  assertFitsLandscape,
  createReportDocument,
  drawTable,
  drawTotals,
  finishDocument,
  sectionTitle,
  type Column,
} from './pdf';

export const CHAT_REPORT_TITLE = 'KAS – BÁO CÁO CHAT BOX';

const STATUS_LABELS: Record<ChatConversationView['status'], string> = {
  WAITING_ADMIN: 'Chờ Admin trả lời',
  ANSWERED: 'Đã trả lời',
  CLOSED: 'Đã xử lý',
};

const COLUMNS: Column<ChatConversationView>[] = assertFitsLandscape('chat report', [
  { header: 'Thời gian', width: 78, value: (c) => hcmDateTime(new Date(c.createdAt)) },
  { header: 'Loại vấn đề', width: 80, value: (c) => c.title },
  { header: 'Chi nhánh', width: 74, value: (c) => c.branch?.code ?? '—' },
  { header: 'Ca', width: 40, value: (c) => (c.shiftType ? shiftDefinition(c.shiftType).name : '—') },
  // Already "Ẩn danh" for an anonymous thread — the serializer decided that, not
  // this column.
  { header: 'Người gửi', width: 88, value: (c) => c.senderLabel },
  { header: 'Hình thức', width: 66, value: (c) => (c.anonymous ? 'Ẩn danh' : 'Bình thường') },
  { header: 'Nội dung', width: 124, value: (c) => c.lastMessagePreview ?? '—' },
  { header: 'Trạng thái', width: 76, value: (c) => STATUS_LABELS[c.status] },
  { header: 'Người xử lý', width: 72, value: (c) => c.handledBy?.fullName ?? '—' },
  { header: 'Xử lý lúc', width: 76, value: (c) => (c.handledAt ? hcmDateTime(new Date(c.handledAt)) : '—') },
]);

export interface ChatReportInput {
  from: string;
  to: string;
  scope: string;
  conversations: ChatConversationView[];
  generatedAt: Date;
}

export async function buildChatReportPdf(input: ChatReportInput): Promise<Buffer> {
  const doc = createReportDocument({
    title: CHAT_REPORT_TITLE,
    period: periodLabel(input.from, input.to),
    generatedAt: hcmDateTime(input.generatedAt),
    scope: input.scope,
  });

  if (input.conversations.length === 0) {
    doc.text('Không có phản ánh nào trong kỳ báo cáo này.');
    addPageNumbers(doc);
    return finishDocument(doc);
  }

  drawTable(doc, COLUMNS, input.conversations);

  const byCategory = new Map<string, number>();
  const byBranch = new Map<string, number>();
  const byMode = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string): void => void m.set(k, (m.get(k) ?? 0) + 1);
  for (const c of input.conversations) {
    bump(byCategory, c.title);
    bump(byBranch, c.branch ? `${c.branch.code} — ${c.branch.hotelName}` : 'Không rõ');
    bump(byMode, c.anonymous ? 'Ẩn danh' : 'Bình thường');
  }

  doc.moveDown(0.8);
  sectionTitle(doc, 'TỔNG HỢP');
  doc.text(`Tổng số phản ánh: ${input.conversations.length}`);

  drawTotals(doc, 'Theo loại vấn đề', rankedTotals(byCategory));
  drawTotals(doc, 'Theo chi nhánh', rankedTotals(byBranch));
  drawTotals(doc, 'Theo hình thức gửi', rankedTotals(byMode));

  addPageNumbers(doc);
  return finishDocument(doc);
}

export function chatReportFileName(from: string, to: string): string {
  return `KAS-bao-cao-chat-box-${from}-${to}.pdf`;
}
