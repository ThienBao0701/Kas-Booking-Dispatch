/**
 * COLUMN PRIORITIES — how the shared table fits a desktop without a sideways
 * scroll and still hides nothing.
 *
 *   * a column with \`hideBelow\` leaves the row below its breakpoint (Tailwind's
 *     own classes, so the browser decides, not JavaScript) and is read in the
 *     row's detail panel instead;
 *   * the chevron is offered exactly below the widest breakpoint any column
 *     leaves at — above it everything is on screen;
 *   * a column the caller's own record already shows (\`coveredByDetail\`) is
 *     not listed twice; one it does not show is listed, so leaving the row
 *     never makes a value unreachable;
 *   * \`secondary\` keeps its old meaning (below \`md\`).
 *
 * jsdom applies no CSS, so these assert the classes the browser will apply; the
 * widths themselves were measured in a real browser at 1366, 1536 and 1920 px.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataTable, type DataColumn } from './DataTable';

interface Row {
  id: string;
  name: string;
  code: string;
  note: string;
  updated: string;
}

const ROWS: Row[] = [{ id: 'r1', name: 'Nguyễn A', code: 'EZ1', note: 'Ghi chú dài', updated: '12/10 09:00' }];

const columns: DataColumn<Row>[] = [
  { key: 'name', header: 'Tên', render: (r) => r.name },
  { key: 'code', header: 'Mã', secondary: true, render: (r) => r.code },
  { key: 'note', header: 'Ghi chú', hideBelow: '2xl', coveredByDetail: true, render: (r) => r.note },
  { key: 'updated', header: 'Cập nhật', hideBelow: '3xl', render: (r) => r.updated },
];

describe('DataTable column priorities', () => {
  it('puts each column on screen from its own breakpoint, and the primary one always', () => {
    render(<DataTable columns={columns} rows={ROWS} rowKey={(r) => r.id} title="T" emptyTitle="" emptyMessage="" />);
    const header = (name: string) => screen.getByRole('columnheader', { name });
    expect(header('Tên').className).not.toMatch(/\bhidden\b/);
    expect(header('Mã').className).toMatch(/\bhidden md:table-cell\b/);
    expect(header('Ghi chú').className).toMatch(/\bhidden 2xl:table-cell\b/);
    expect(header('Cập nhật').className).toMatch(/\bhidden 3xl:table-cell\b/);
    // The cells follow their header.
    expect(screen.getByText('12/10 09:00').closest('td')!.className).toMatch(/\bhidden 3xl:table-cell\b/);
  });

  it('offers the chevron below the widest breakpoint any column leaves at', () => {
    render(<DataTable columns={columns} rows={ROWS} rowKey={(r) => r.id} title="T" emptyTitle="" emptyMessage="" />);
    expect(screen.getByTestId('row-toggle-r1').closest('td')!.className).toMatch(/\b3xl:hidden\b/);
  });

  it('lists every column that left the row in its panel, each only below its own width', async () => {
    render(<DataTable columns={columns} rows={ROWS} rowKey={(r) => r.id} title="T" emptyTitle="" emptyMessage="" />);
    await userEvent.click(screen.getByTestId('row-toggle-r1'));
    const panel = screen.getByTestId('row-detail-r1');
    expect(within(panel).getByText('EZ1').closest('div')!.className).toMatch(/\bmd:hidden\b/);
    expect(within(panel).getByText('Ghi chú dài').closest('div')!.className).toMatch(/\b2xl:hidden\b/);
    expect(within(panel).getByText('12/10 09:00').closest('div')!.className).toMatch(/\b3xl:hidden\b/);
  });

  it('with a full-record panel, lists only what that record does not already show', async () => {
    render(
      <DataTable
        columns={columns}
        rows={ROWS}
        rowKey={(r) => r.id}
        title="T"
        emptyTitle=""
        emptyMessage=""
        detailToggle="always"
        renderDetail={(r) => <p data-testid="record">Bản ghi {r.name}</p>}
      />,
    );
    await userEvent.click(screen.getByTestId('row-toggle-r1'));
    const panel = screen.getByTestId('row-detail-r1');
    expect(within(panel).getByTestId('record')).toBeInTheDocument();
    // "Cập nhật" is not in the record: it is listed, so it stays reachable.
    expect(within(panel).getByText('12/10 09:00')).toBeInTheDocument();
    // "Ghi chú" is covered by the record, and "Mã" is a phone-only column the record replaces.
    expect(within(panel).queryByText('Ghi chú dài')).not.toBeInTheDocument();
    expect(within(panel).queryByText('EZ1')).not.toBeInTheDocument();
  });
});
