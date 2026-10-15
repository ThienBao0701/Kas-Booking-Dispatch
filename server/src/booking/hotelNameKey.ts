/**
 * The comparison key for a hotel name.
 *
 * WHY THIS EXISTS. A Booking.com reservation prints the property under whatever
 * public name the listing carries that week, and it is rarely character-equal to
 * the internal name an Admin maintains. "KAS Dilly Hotel", "KAS DILLY",
 * "Kas Dilly Hotel & Spa" are one property; `normalizeText` folds case, accents
 * and punctuation but leaves "hotel" and "spa" in place, so all three produce
 * different keys and none matches. That is the production symptom: a booking
 * arrives, the branch does not resolve, and an Admin assigns it by hand.
 *
 * The fix is to drop the words that carry no identity. What remains is the part
 * that actually names the property.
 *
 *   "KAS DILLY HOTEL"        -> "kas dilly"
 *   "KAS DILLY"              -> "kas dilly"
 *   "Kas Dilly Hotel"        -> "kas dilly"
 *   "KAS DILLY HOTEL & SPA"  -> "kas dilly"
 *
 * WHY THE LIST IS SHORT. Every word removed here is a word two different
 * branches can no longer be told apart by, and this system runs eight
 * properties whose names deliberately share vocabulary. "Boutique", "Luxury",
 * "Premium", "Modern" and "Ancient" are NOT in the list even though they read
 * like filler, because they are exactly what separates *Luxury Ancient Boutique
 * Hotel* from *Boutique Zody Hotel*. Only words that appear in a property's name
 * without distinguishing it from any other are removed.
 *
 * A collision would be silent and would send a guest to the wrong hotel, so the
 * accompanying tests assert that no two configured branch names collapse to the
 * same key, and that none becomes a substring of another. Adding a word here
 * without re-running those tests is how this module turns into an incident.
 */
import { normalizeText } from './text';

/**
 * Words dropped from a hotel name before comparison.
 *
 * Generic establishment nouns and connectives only. Anything that could name a
 * specific property stays.
 */
const NOISE_WORDS: ReadonlySet<string> = new Set([
  'hotel',
  'hotels',
  'spa',
  'and',
  'the',
]);

/**
 * The identity-bearing part of a hotel name, lower-cased and space-separated.
 *
 * Returns the plain normalised form when stripping would leave nothing: a
 * property genuinely called "The Hotel" must still compare against itself
 * rather than against the empty string, which would match everything.
 */
export function hotelNameKey(input: string | null | undefined): string {
  if (!input) return '';
  const normalized = normalizeText(input);
  if (normalized.length === 0) return '';

  const kept = normalized.split(' ').filter((word) => word.length > 0 && !NOISE_WORDS.has(word));
  return kept.length > 0 ? kept.join(' ') : normalized;
}

/**
 * Whether two hotel names refer to the same property by containment.
 *
 * Word-boundary containment, not raw substring: "kas dilly" is inside
 * "kas dilly riverside" but "kas dil" is not, so a truncated fragment cannot
 * claim a property it only partially spells. Both keys must be non-empty.
 */
export function hotelNameContains(outer: string, inner: string): boolean {
  if (outer.length === 0 || inner.length === 0) return false;
  if (outer === inner) return true;
  return ` ${outer} `.includes(` ${inner} `);
}
