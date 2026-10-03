/**
 * Driving the shared report filter (`ReportFilterBar`) the way a person does:
 * the branch from its list, a range in the one calendar.
 */
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { hcmToday } from '../lib/format';

const monthBefore = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
const monthAfter = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1)).toISOString().slice(0, 7);

/** "-Chọn chi nhánh-" → one branch (by id) or 'ALL'. */
export async function pickBranch(id: number | string | 'ALL') {
  await userEvent.click(await screen.findByTestId('branch-select'));
  await userEvent.click(await screen.findByTestId(`branch-option-${id}`));
}

/**
 * "Khoảng ngày": the start, then the end, in the one calendar — which opens on
 * the month the current range ends in (`shown`, today's by default).
 */
export async function pickRange(from: string, to: string, shown = hcmToday().slice(0, 7)) {
  await userEvent.click(await screen.findByTestId('period-RANGE'));
  await userEvent.click(screen.getByTestId('period-range'));
  for (let m = shown; m > from.slice(0, 7); m = monthBefore(m)) {
    await userEvent.click(screen.getByRole('button', { name: 'Tháng trước' }));
  }
  await userEvent.click(screen.getByTestId(`period-range-day-${from}`));
  for (let m = from.slice(0, 7); m < to.slice(0, 7); m = monthAfter(m)) {
    await userEvent.click(screen.getByRole('button', { name: 'Tháng sau' }));
  }
  await userEvent.click(screen.getByTestId(`period-range-day-${to}`));
}
