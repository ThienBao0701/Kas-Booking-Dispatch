/**
 * ONE date-range control: a start and an end that read as a single field.
 *
 * WHY A COMPONENT AND NOT TWO INPUTS. The dashboard and History both need a
 * range, and a range has rules — the end cannot precede the start, clearing one
 * end must not strand the other, and a future bound may or may not be allowed.
 * Written twice, those rules drift; the screens then disagree about what a range
 * even is. This is the single place they live.
 *
 * WHY NATIVE `<input type="date">`. Every date control in this application is
 * native and the client has no date-picker dependency. Adding one for this would
 * mean a new package, a new visual language, and a second way to enter a date in
 * a product where reception already knows the first.
 *
 * WHY IT IS ONE CONTROL AND NOT TWO. A `<fieldset>` with a `<legend>` is exactly
 * one labelled group to a screen reader — `getByRole('group', {name})` finds it —
 * and reads as one boxed field on screen. The two inputs inside are the ends of
 * that field, not independent questions, so they carry the legend's name in their
 * own labels rather than standalone ones.
 *
 * INVERSION IS UNREACHABLE, not merely discouraged. `min`/`max` stop it in the
 * browser's own picker, and the handlers below pull the other end along when a
 * value would cross it. That matters because nothing downstream catches it: an
 * inverted range becomes `{gte: start, lt: end}` with `start > end`, which every
 * database runs happily and which matches nothing — a blank screen with no error
 * and no explanation.
 */

export interface DateRangeValue {
  /** ISO `YYYY-MM-DD`, or '' when unset. */
  from: string;
  to: string;
}

export function DateRangeField({
  legend,
  value,
  onChange,
  max,
  testId,
}: {
  /** The field's one visible name, e.g. "Khoảng thời gian". */
  legend: string;
  value: DateRangeValue;
  onChange: (next: DateRangeValue) => void;
  /** Latest selectable day, e.g. today. Omitted means no upper bound. */
  max?: string;
  testId?: string;
}) {
  /*
    Setting a start after the current end carries the end with it rather than
    refusing the keystroke. An operator moving a range forward types the new
    start first; rejecting it would make the control feel broken at exactly the
    moment it is being used correctly.
  */
  function setFrom(from: string): void {
    onChange({ from, to: value.to && from && from > value.to ? from : value.to });
  }

  function setTo(to: string): void {
    onChange({ from: value.from && to && to < value.from ? to : value.from, to });
  }

  const inputClass =
    'min-h-[2.75rem] w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-sm text-slate-700 hover:border-slate-600 ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

  return (
    <fieldset data-testid={testId}>
      <legend className="mb-1 text-xs font-medium text-slate-500">{legend}</legend>
      {/*
        The en dash is the field's own separator, not decoration: it is what makes
        two boxes read as one span at a glance.
      */}
      <div className="flex items-center gap-2">
        <input
          type="date"
          value={value.from}
          max={value.to || max}
          onChange={(e) => setFrom(e.target.value)}
          aria-label={`${legend}: từ ngày`}
          data-testid={testId ? `${testId}-from` : undefined}
          className={inputClass}
        />
        <span aria-hidden="true" className="flex-shrink-0 text-sm text-slate-400">
          –
        </span>
        <input
          type="date"
          value={value.to}
          min={value.from || undefined}
          max={max}
          onChange={(e) => setTo(e.target.value)}
          aria-label={`${legend}: đến ngày`}
          data-testid={testId ? `${testId}-to` : undefined}
          className={inputClass}
        />
      </div>
    </fieldset>
  );
}
