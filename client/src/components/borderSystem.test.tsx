/**
 * THE BORDER SYSTEM — pinned, because it regressed to "barely visible" before.
 *
 * Operators asked, more than once, for borders they can actually see. The fix
 * is one shared scale (client/tailwind.config.js `line` tokens) used by every
 * Reception report surface, not per-screen greys. This file fails if:
 *   1. the tokens are set back to the faint first version;
 *   2. an input, a report table or an outlined control stops using them, or a
 *      field's hover / disabled / focus state stops being distinct;
 *   3. a Reception report file reintroduces a faint raw slate border.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { Input } from './Input';
import { MoneyInput } from './MoneyInput';
import { DateRangeField } from './DateRangeField';
import { Button } from './Button';
import { DataTable, RowAction } from './DataTable';

const SRC = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.resolve(SRC, rel), 'utf8');

describe('the line tokens', () => {
  it('are the stronger scale: slate-300 rows, slate-400 shells, slate-500 fields', () => {
    const config = fs.readFileSync(path.resolve(SRC, '..', 'tailwind.config.js'), 'utf8');
    const block = /line:\s*\{([^}]*)\}/.exec(config)?.[1] ?? '';
    expect(block).toMatch(/subtle:\s*'#cbd5e1'/);
    expect(block).toMatch(/DEFAULT:\s*'#94a3b8'/);
    expect(block).toMatch(/strong:\s*'#64748b'/);
  });

  it('weighs a report 3px at its frame and 2px at the rules inside it', () => {
    const config = fs.readFileSync(path.resolve(SRC, '..', 'tailwind.config.js'), 'utf8');
    const block = /borderWidth:\s*\{([^}]*)\}/.exec(config)?.[1] ?? '';
    expect(block).toMatch(/section:\s*'3px'/);
    expect(block).toMatch(/rule:\s*'2px'/);
  });
});

describe('what the operator types into', () => {
  it('draws every field on line-strong, darker on hover, lighter when disabled, ringed on focus', () => {
    render(
      <>
        <Input label="Tên khách" data-testid="text" />
        <Input label="Khóa" data-testid="off" disabled />
        <MoneyInput label="Giá tiền" value="" onChange={() => undefined} data-testid="money" />
        <DateRangeField legend="Ngày tiếp nhận" value={{ from: '', to: '' }} onChange={() => undefined} testId="range" />
      </>,
    );
    for (const id of ['text', 'money', 'range-from', 'range-to']) {
      const field = screen.getByTestId(id);
      expect(field.className, id).toMatch(/\bborder-line-strong\b/);
      expect(field.className, id).toMatch(/\bhover:border-slate-600\b/);
      expect(field.className, id).toMatch(/\bfocus(-visible)?:ring-2\b/);
      expect(field.className, id).not.toMatch(/\bborder-slate-(100|200|300)\b/);
    }
    expect(screen.getByTestId('off').className).toMatch(/\bdisabled:border-line\b/);
    expect(screen.getByTestId('money').className).toMatch(/\bdisabled:border-line\b/);
  });

  it('outlines secondary buttons and row actions as controls, not as faint hairlines', () => {
    render(
      <>
        <Button variant="secondary">Làm mới</Button>
        <RowAction onClick={() => undefined} testId="edit">
          Sửa
        </RowAction>
        <RowAction onClick={() => undefined} tone="danger" testId="void">
          Hủy
        </RowAction>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Làm mới' }).className).toMatch(/\bborder-line-strong\b/);
    expect(screen.getByTestId('edit').className).toMatch(/\bborder-line-strong\b/);
    expect(screen.getByTestId('void').className).toMatch(/\bborder-rose-300\b/);
  });
});

describe('a report table', () => {
  it('is framed 3px by line, ruled 2px under its header by line, and divided 2px by line-subtle', () => {
    render(
      <DataTable
        testId="report"
        title="Vấn đề khách yêu cầu thực hiện (Request)"
        columns={[{ key: 'name', header: 'Tên khách', render: (r: { id: string; name: string }) => r.name }]}
        rows={[
          { id: 'a', name: 'Khách A' },
          { id: 'b', name: 'Khách B' },
        ]}
        rowKey={(r) => r.id}
        section={{ marker: 'II' }}
        emptyTitle="—"
        emptyMessage="—"
        footer={<span>2 bản ghi</span>}
      />,
    );
    const section = screen.getByTestId('report');
    expect(section.className).toMatch(/\bborder-section\b/);
    expect(section.className).toMatch(/\bborder-line\b/);
    const table = within(section).getByRole('table');
    expect(table.querySelector('thead tr')!.className).toMatch(/\bborder-b-rule\b/);
    expect(table.querySelector('thead tr')!.className).toMatch(/\bborder-line\b/);
    expect(table.querySelector('tbody')!.className).toMatch(/\bdivide-y-rule\b/);
    expect(table.querySelector('tbody')!.className).toMatch(/\bdivide-line-subtle\b/);
    const footer = within(section).getByText('2 bản ghi').parentElement!;
    expect(footer.className).toMatch(/\bborder-t-rule\b/);
    expect(footer.className).toMatch(/\bborder-line\b/);
  });
});

describe('the Reception report files', () => {
  const RECEPTION_REPORT_FILES = [
    'components/ReportSection.tsx',
    'components/DataTable.tsx',
    'components/OperationalTables.tsx',
    'components/OperationalForms.tsx',
    'components/PaymentLedger.tsx',
    'components/RecordDialogs.tsx',
    'components/IncidentReporting.tsx',
    'components/FacilityIssueBoard.tsx',
    'components/Input.tsx',
    'components/MoneyInput.tsx',
    'components/DateRangeField.tsx',
    'components/PeriodQuickPicks.tsx',
    'components/MoreNote.tsx',
    'components/Button.tsx',
    'pages/OperationalReportsPage.tsx',
    'pages/CompletedIssuesPage.tsx',
  ];

  it.each(RECEPTION_REPORT_FILES)('%s draws no faint raw slate border', (rel) => {
    const faint = read(rel).match(/\b(border|divide)(-[tblrxy])?-slate-(50|100|200|300)\b/g) ?? [];
    expect(faint).toEqual([]);
  });
});
