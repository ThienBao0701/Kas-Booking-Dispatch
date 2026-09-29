/**
 * ONE COLOUR PER BRANCH, the same everywhere a branch has to be told apart at a
 * glance — the "Cần tạo lại" list and the chat bubble's branch list.
 *
 * DERIVED FROM THE BRANCH'S NUMBER, never stored and never a list of eight: a
 * branch added tomorrow gets a tone the same way, and the same branch has the
 * same tone on every screen and on every reload. The palette repeats after
 * `TONES.length` branches; the branch's own name is always printed beside it, so
 * the colour is an aid to scanning and never the only thing that identifies one.
 */
export interface BranchTone {
  /** Solid accent — a rail, a dot, an avatar. */
  solid: string;
  /** Soft fill with a matching text colour — a badge or a group header. */
  soft: string;
  /** Left rail on a selected or grouped row. */
  rail: string;
}

const TONES: BranchTone[] = [
  { solid: 'bg-sky-600 text-white', soft: 'bg-sky-50 text-sky-800 ring-sky-200', rail: 'border-l-sky-500' },
  { solid: 'bg-emerald-600 text-white', soft: 'bg-emerald-50 text-emerald-800 ring-emerald-200', rail: 'border-l-emerald-500' },
  { solid: 'bg-violet-600 text-white', soft: 'bg-violet-50 text-violet-800 ring-violet-200', rail: 'border-l-violet-500' },
  { solid: 'bg-amber-600 text-white', soft: 'bg-amber-50 text-amber-900 ring-amber-200', rail: 'border-l-amber-500' },
  { solid: 'bg-rose-600 text-white', soft: 'bg-rose-50 text-rose-800 ring-rose-200', rail: 'border-l-rose-500' },
  { solid: 'bg-teal-600 text-white', soft: 'bg-teal-50 text-teal-800 ring-teal-200', rail: 'border-l-teal-500' },
  { solid: 'bg-indigo-600 text-white', soft: 'bg-indigo-50 text-indigo-800 ring-indigo-200', rail: 'border-l-indigo-500' },
  { solid: 'bg-orange-600 text-white', soft: 'bg-orange-50 text-orange-900 ring-orange-200', rail: 'border-l-orange-500' },
];

/** The tone for a branch — by its number, falling back to its id when it has none. */
export function branchTone(branch: { id: number; branchNumber?: number | null }): BranchTone {
  const key = branch.branchNumber && branch.branchNumber > 0 ? branch.branchNumber : branch.id;
  return TONES[(Math.max(1, key) - 1) % TONES.length]!;
}

/** "05 Trương Định - Chi nhánh 01" — the operator's own way of naming a branch. */
export function branchOptionLabel(branch: { address: string; branchNumber?: number | null }): string {
  if (!branch.branchNumber) return branch.address;
  return `${branch.address} - Chi nhánh ${String(branch.branchNumber).padStart(2, '0')}`;
}
