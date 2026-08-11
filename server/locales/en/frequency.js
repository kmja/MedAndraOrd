// How often each letter occurs in English, as a percentage.
//
// Used only as a tiebreaker: between two clues of the same length, the one
// built from rarer letters is the harder feat and ranks higher. Comparing sums
// is fair precisely because that step only runs between clues of equal length,
// so both sums have the same number of terms — which is also why this table has
// to match the language being played. Swedish frequencies scoring English clues
// would rank the wrong ones higher.
//
// Figures are the standard relative-frequency table for English text.

export const LETTER_FREQUENCY = {
  e: 12.70, t: 9.06, a: 8.17, o: 7.51, i: 6.97, n: 6.75, s: 6.33, h: 6.09,
  r: 5.99, d: 4.25, l: 4.03, c: 2.78, u: 2.76, m: 2.41, w: 2.36, f: 2.23,
  g: 2.02, y: 1.97, p: 1.93, b: 1.29, v: 0.98, k: 0.77, j: 0.15, x: 0.15,
  q: 0.10, z: 0.07,
};

// An unlisted letter (é, ñ, …) gets roughly the mean of 26 letters, so reaching
// for an exotic character is not a free way to win a tiebreak.
export const UNLISTED_FREQUENCY = 3.85;
