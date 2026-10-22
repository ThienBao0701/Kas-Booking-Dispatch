/**
 * "Đang hiển thị N bản ghi gần nhất trên tổng số M." — said plainly under a
 * list that shows only the newest page of more.
 *
 * The active and archived lists of "Báo cáo vấn đề" and "Hoàn thành vấn đề"
 * are pages; a page that quietly stops is how an old unfinished request goes
 * missing without anyone noticing. Nothing is rendered when nothing is cut.
 */
export function MoreNote({ shown, total }: { shown: number; total: number | undefined }) {
  if (total === undefined || total <= shown) return null;
  return (
    <p className="mt-1.5 px-1 text-xs text-slate-500" data-testid="list-more">
      Đang hiển thị {shown} bản ghi gần nhất trên tổng số {total}.
    </p>
  );
}
