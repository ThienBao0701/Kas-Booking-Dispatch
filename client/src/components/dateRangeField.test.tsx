/**
 * The shared date-range control used by the dashboard and by History.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE PAGE TESTS. The page tests assert
 * what goes on the wire (`?date=`, `?from=&to=`, `sentFrom=`/`sentTo=`). They
 * cannot see the rules of the control itself, and those rules are the part that
 * is easy to break while every page test stays green: the two ends must read as
 * ONE named field, each end must still be individually addressable, and an
 * inverted range must be unreachable.
 *
 * THE LOAD-BEARING CASE IS INVERSION (see "pulls the other end along" below).
 * An inverted range is not rejected anywhere downstream — it becomes a
 * `start > end` window that the database runs happily and that matches zero
 * rows. The operator sees an empty screen with no error, no empty-state reason
 * and nothing to correct; the only visible symptom is "the app lost my data".
 *
 * fireEvent.change, never userEvent.type: a native `<input type="date">` takes a
 * whole value, and typing it character by character produces intermediate
 * invalid states that this control's own min/max then clamp. The same
 * convention is documented at client/src/pages/adminUiRevision.test.tsx.
 */
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { DateRangeField, type DateRangeValue } from './DateRangeField';

const LEGEND = 'Khoảng thời gian';
const TEST_ID = 'dashboard-range';
const FROM_LABEL = `${LEGEND}: từ ngày`;
const TO_LABEL = `${LEGEND}: đến ngày`;

/** Renders the control with a spy, and hands back the spy plus both ends. */
function mount(value: DateRangeValue, max?: string) {
  const onChange = vi.fn<(next: DateRangeValue) => void>();
  render(
    <DateRangeField legend={LEGEND} value={value} onChange={onChange} max={max} testId={TEST_ID} />,
  );
  return {
    onChange,
    from: screen.getByTestId(`${TEST_ID}-from`),
    to: screen.getByTestId(`${TEST_ID}-to`),
    /** The single payload emitted by the last interaction. */
    emitted: (): DateRangeValue => {
      expect(onChange).toHaveBeenCalledTimes(1);
      const call = onChange.mock.calls[0];
      if (!call) throw new Error('the control emitted nothing');
      return call[0];
    },
  };
}

/**
 * The same control wired to real state, so a sequence of edits can be asserted
 * the way an operator actually produces one — each edit seeing the result of
 * the last, exactly as the pages mount it.
 */
function LiveRange({ initial, max }: { initial: DateRangeValue; max?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <DateRangeField legend={LEGEND} value={value} onChange={setValue} max={max} testId={TEST_ID} />
  );
}

/* ================================================================== */
/* One field, two ends                                                 */
/* ================================================================== */

describe('the control is one labelled field', () => {
  // Prevents: the range reading to a screen reader as two unrelated questions,
  // and the pages losing the single `getByRole('group')` handle they address it
  // by. Two loose date boxes are also what the rules below drifted apart in.
  it('is exactly ONE group, named by its legend, with both ends inside it', () => {
    const { from, to } = mount({ from: '2026-08-05', to: '2026-08-12' });

    const group = screen.getByRole('group', { name: LEGEND });
    expect(screen.getAllByRole('group')).toHaveLength(1);
    expect(group).toBe(screen.getByTestId(TEST_ID));

    expect(within(group).getByLabelText(FROM_LABEL)).toBe(from);
    expect(within(group).getByLabelText(TO_LABEL)).toBe(to);
  });

  // Prevents: a "date range" that is secretly a text box. A text input accepts
  // "10/8" and any other shape an operator invents, and the whole min/max
  // clamp below stops existing.
  it('renders both ends as native date inputs carrying the current value', () => {
    const { from, to } = mount({ from: '2026-08-05', to: '2026-08-12' });

    expect(from).toHaveAttribute('type', 'date');
    expect(to).toHaveAttribute('type', 'date');
    expect(from).toHaveValue('2026-08-05');
    expect(to).toHaveValue('2026-08-12');
  });

  // Prevents: both ends answering to the same accessible name, which makes them
  // indistinguishable to assistive tech AND makes every getByLabelText in the
  // page tests ambiguous — the start and the end become untestable apart.
  it('gives each end its own distinguishable accessible name', () => {
    const { from, to } = mount({ from: '', to: '' });

    expect(screen.getByLabelText(FROM_LABEL)).toBe(from);
    expect(screen.getByLabelText(TO_LABEL)).toBe(to);
    expect(from).not.toBe(to);
    // The names are derived from the legend, so a renamed field renames both.
    expect(from).toHaveAttribute('aria-label', FROM_LABEL);
    expect(to).toHaveAttribute('aria-label', TO_LABEL);
  });
});

/* ================================================================== */
/* Editing one end                                                     */
/* ================================================================== */

describe('editing one end', () => {
  // Prevents: an edit to the start silently discarding the end (the page would
  // widen the query to everything, or narrow it to one day, without being asked).
  it('emits the whole range with the start updated', () => {
    const h = mount({ from: '2026-08-05', to: '2026-08-12' });

    fireEvent.change(h.from, { target: { value: '2026-08-07' } });

    expect(h.emitted()).toEqual({ from: '2026-08-07', to: '2026-08-12' });
  });

  // Prevents: the mirror image — an edit to the end dropping the start.
  it('emits the whole range with the end updated', () => {
    const h = mount({ from: '2026-08-05', to: '2026-08-12' });

    fireEvent.change(h.to, { target: { value: '2026-08-20' } });

    expect(h.emitted()).toEqual({ from: '2026-08-05', to: '2026-08-20' });
  });
});

/* ================================================================== */
/* Inversion is unreachable — the load-bearing rule                    */
/* ================================================================== */

describe('an inverted range cannot be produced', () => {
  // THE CASE THIS FILE EXISTS FOR. Moving a range forward, an operator types
  // the new START first. If that were emitted as-is the range would be
  // start > end for one render, the query would go out inverted, and the screen
  // would come back empty with no error anywhere to explain it.
  it('pulls the end forward when the start is moved past it', () => {
    const h = mount({ from: '2026-08-05', to: '2026-08-10' });

    fireEvent.change(h.from, { target: { value: '2026-08-20' } });

    const next = h.emitted();
    expect(next).toEqual({ from: '2026-08-20', to: '2026-08-20' });
    // Stated as the invariant, not just the value: never start > end.
    expect(next.from <= next.to).toBe(true);
  });

  // The mirror image: moving the range backwards, the END is typed first.
  it('pulls the start back when the end is moved before it', () => {
    const h = mount({ from: '2026-08-10', to: '2026-08-15' });

    fireEvent.change(h.to, { target: { value: '2026-08-01' } });

    const next = h.emitted();
    expect(next).toEqual({ from: '2026-08-01', to: '2026-08-01' });
    expect(next.from <= next.to).toBe(true);
  });

  // Prevents a clamp that over-corrects: landing exactly ON the other end is a
  // legitimate single-day range, and must not drag anything anywhere.
  it('leaves an equal pair alone — one day is a valid range', () => {
    const h = mount({ from: '2026-08-05', to: '2026-08-10' });

    fireEvent.change(h.from, { target: { value: '2026-08-10' } });

    expect(h.emitted()).toEqual({ from: '2026-08-10', to: '2026-08-10' });
  });

  // The same rule with real state behind it: after the pull, what is ON SCREEN
  // is a valid range, and the second end can then be widened normally.
  it('shows a valid range on screen after the pull, and widens from there', () => {
    render(<LiveRange initial={{ from: '2026-08-05', to: '2026-08-10' }} />);
    const from = screen.getByTestId(`${TEST_ID}-from`);
    const to = screen.getByTestId(`${TEST_ID}-to`);

    fireEvent.change(from, { target: { value: '2026-08-20' } });
    expect(from).toHaveValue('2026-08-20');
    expect(to).toHaveValue('2026-08-20');

    fireEvent.change(to, { target: { value: '2026-08-25' } });
    expect(from).toHaveValue('2026-08-20');
    expect(to).toHaveValue('2026-08-25');
  });
});

/* ================================================================== */
/* Clearing an end                                                     */
/* ================================================================== */

describe('clearing an end', () => {
  // Prevents: clearing the end wiping the start with it. The clamp reads "end
  // before start" — an empty end must not be treated as the earliest date on
  // the calendar and drag the start to ''.
  it('empties only the end, leaving the start untouched', () => {
    const h = mount({ from: '2026-08-05', to: '2026-08-10' });

    fireEvent.change(h.to, { target: { value: '' } });

    expect(h.emitted()).toEqual({ from: '2026-08-05', to: '' });
  });

  // The mirror image: an empty start must not be read as "later than the end"
  // and blank the end too.
  it('empties only the start, leaving the end untouched', () => {
    const h = mount({ from: '2026-08-05', to: '2026-08-10' });

    fireEvent.change(h.from, { target: { value: '' } });

    expect(h.emitted()).toEqual({ from: '', to: '2026-08-10' });
  });
});

/* ================================================================== */
/* Bounds                                                              */
/* ================================================================== */

describe('the selectable bounds', () => {
  // Prevents: the dashboard offering tomorrow. Its scope is days that have
  // already happened; a future day is a guaranteed all-zero screen that looks
  // like data loss rather than an empty future.
  it('applies max to BOTH ends, so no future day is offerable', () => {
    const { from, to } = mount({ from: '', to: '' }, '2026-09-15');

    expect(from).toHaveAttribute('max', '2026-09-15');
    expect(to).toHaveAttribute('max', '2026-09-15');
  });

  // Prevents inversion at the picker itself, one layer before the handler: the
  // start cannot even be *offered* a day after the current end.
  it('tightens the start max down to the current end', () => {
    const { from, to } = mount({ from: '2026-08-05', to: '2026-08-10' }, '2026-09-15');

    expect(from).toHaveAttribute('max', '2026-08-10');
    // The outer bound still governs the end itself.
    expect(to).toHaveAttribute('max', '2026-09-15');
    // …and the end cannot be offered a day before the start.
    expect(to).toHaveAttribute('min', '2026-08-05');
  });

  // Prevents an empty end from collapsing the start's bound to nothing — with
  // no end chosen yet, the outer max is what still applies.
  it('falls back to the outer max while the end is empty', () => {
    const { from, to } = mount({ from: '2026-08-05', to: '' }, '2026-09-15');

    expect(from).toHaveAttribute('max', '2026-09-15');
    expect(to).toHaveAttribute('max', '2026-09-15');
  });

  // Prevents a bound appearing out of nowhere on History, which has no upper
  // limit at all: an absent max must stay absent, not become '' or 'undefined'.
  it('sets no bound at all when max is omitted and nothing is chosen', () => {
    const { from, to } = mount({ from: '', to: '' });

    expect(from).not.toHaveAttribute('max');
    expect(to).not.toHaveAttribute('max');
    expect(from).not.toHaveAttribute('min');
    expect(to).not.toHaveAttribute('min');
  });
});

/* ================================================================== */
/* Without a testId                                                    */
/* ================================================================== */

describe('without a testId', () => {
  // Prevents: a literal data-testid="undefined" landing in the DOM, which would
  // make every untagged instance answer to the SAME testid — and the clamp
  // silently not running because the callers hang off the tagged path.
  it('renders no testid attributes, and stays fully usable by its labels', () => {
    const onChange = vi.fn<(next: DateRangeValue) => void>();
    render(
      <DateRangeField legend={LEGEND} value={{ from: '2026-08-05', to: '2026-08-10' }} onChange={onChange} />,
    );

    const group = screen.getByRole('group', { name: LEGEND });
    const from = screen.getByLabelText(FROM_LABEL);
    const to = screen.getByLabelText(TO_LABEL);

    expect(group).not.toHaveAttribute('data-testid');
    expect(from).not.toHaveAttribute('data-testid');
    expect(to).not.toHaveAttribute('data-testid');

    // The rules still hold on the untagged instance.
    fireEvent.change(from, { target: { value: '2026-08-20' } });
    expect(onChange).toHaveBeenCalledWith({ from: '2026-08-20', to: '2026-08-20' });
  });
});
