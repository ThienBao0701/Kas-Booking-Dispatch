/**
 * THE TECHNICAL DISPATCH CHAIN, AS EVERY EXPORT PRINTS IT — one mapping for the
 * XLSX and the PDFs, so the two files cannot describe the same incident in two
 * different ways.
 *
 *   Tổng quản lý kỹ thuật > Quản lý kỹ thuật > kĩ thuật khách sạn / bên ngoài,
 *   every hand-off with its note, the completion (who, when) and the cost.
 *
 * It reads the SERIALIZED incident (`serializeIssue(…, viewerRole)`), which has
 * already withheld an outside contractor's phone, specialty and company from a
 * reader without 'technical.viewContractor' — nothing here can print what the
 * serializer did not hand over.
 */
import type { serializeIssue } from '../issue/issueService';

export type TechnicalIssueView = ReturnType<typeof serializeIssue>;
export type DispatchView = TechnicalIssueView['dispatches'][number];

/** "Nguyễn Văn A — Công ty ABC" / "Nguyễn Văn B (Cá nhân)"; empty when none. */
export function externalLabel(d: DispatchView | undefined): string {
  if (!d?.contractor) return '';
  return d.contractor.company
    ? `${d.contractor.name} — ${d.contractor.company}`
    : `${d.contractor.name ?? ''} (${d.contractor.typeLabel})`;
}

/** The persisted cost of every completed outside job, summed — or null when there was none. */
export function repairCostOf(issue: Pick<TechnicalIssueView, 'dispatches'>): number | null {
  const costs = issue.dispatches.filter((d) => d.repairCost !== null).map((d) => d.repairCost!);
  return costs.length ? costs.reduce((a, b) => a + b, 0) : null;
}

/** The Tổng quản lý kỹ thuật of the latest hand-off to a manager. */
export function generalManagerOf(issue: Pick<TechnicalIssueView, 'dispatches'>): string {
  return issue.dispatches.filter((d) => d.kind === 'TO_MANAGER').at(-1)?.assignedByName ?? '';
}

/** The latest outside contractor. */
export function contractorOf(issue: Pick<TechnicalIssueView, 'dispatches'>): string {
  return externalLabel(issue.dispatches.filter((d) => d.kind === 'TO_EXTERNAL').at(-1));
}

/** Phone · specialty of each outside job — empty for a reader the serializer withheld them from. */
export function contractorContactOf(issue: Pick<TechnicalIssueView, 'dispatches'>): string {
  return issue.dispatches
    .filter((d) => d.kind === 'TO_EXTERNAL')
    .map((d) => [d.contractor?.phone, d.contractor?.specialty].filter(Boolean).join(' · '))
    .filter(Boolean)
    .join('\n');
}

/** The in-house technician who holds or held the job. */
export function technicianOf(issue: TechnicalIssueView): string {
  return issue.assignedTechnician?.name ?? issue.attempts.at(-1)?.technicianName ?? issue.technicianName ?? '';
}

export interface HandoffEvent {
  at: string;
  kind: string;
  from: string;
  to: string;
  note: string;
  completedAt: string | null;
  completedBy: string;
  cost: number | null;
}

/** Every hand-off, oldest first: in-house assignments and the dispatch chain, with their notes. */
export function handoffEvents(issue: TechnicalIssueView): HandoffEvent[] {
  return [
    ...issue.assignments.map((a) => ({
      at: a.createdAt,
      kind: 'Giao kĩ thuật khách sạn',
      from: `${a.assignedByName}`,
      to: a.technicianName,
      note: a.note ?? '',
      completedAt: null,
      completedBy: '',
      cost: null,
    })),
    ...issue.dispatches.map((d) => ({
      at: d.createdAt,
      kind: d.kind === 'TO_MANAGER' ? 'Giao quản lý kỹ thuật' : 'Giao kĩ thuật bên ngoài',
      from: `${d.assignedByName}${d.assignedByRoleLabel ? ` (${d.assignedByRoleLabel})` : ''}`,
      to: d.kind === 'TO_MANAGER' ? (d.manager?.name ?? '') : externalLabel(d),
      note: d.note ?? '',
      completedAt: d.completedAt,
      completedBy: d.completedByName ?? '',
      cost: d.repairCost,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * The chain in one cell, for a PDF row:
 *   "Tổng QLKT: A > QLKT: B" / "KT: C" / "Bên ngoài: D — Công ty E".
 */
export function dispatchChainText(issue: TechnicalIssueView): string {
  const lines: string[] = [];
  const general = generalManagerOf(issue);
  const manager = issue.assignedManager?.name ?? issue.dispatches.filter((d) => d.kind === 'TO_MANAGER').at(-1)?.manager?.name;
  if (general || manager) lines.push(`${general ? `Tổng QLKT: ${general}` : ''}${general && manager ? ' > ' : ''}${manager ? `QLKT: ${manager}` : ''}`);
  const contractor = contractorOf(issue);
  if (contractor) lines.push(`Bên ngoài: ${contractor}`);
  const technician = issue.assignedTechnician?.name ?? issue.assignments.at(-1)?.technicianName;
  if (technician) lines.push(`KT: ${technician}`);
  return lines.join('\n') || '—';
}
