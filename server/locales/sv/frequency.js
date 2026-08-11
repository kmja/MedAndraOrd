// How often each letter occurs in Swedish, as a percentage.
//
// Used only as a tiebreaker: between two clues of the same length, the one
// built from rarer letters is the harder feat and ranks higher. Comparing sums
// is fair precisely because that step only runs between clues of equal length,
// so both sums have the same number of terms — which is also why this table has
// to match the language being played. Swedish frequencies scoring English
// clues would rank the wrong ones higher.

export const LETTER_FREQUENCY = {
  a: 10.04, e: 9.85, t: 8.89, n: 8.45, r: 7.88, s: 5.32, i: 5.01, d: 4.90,
  l: 4.81, o: 4.06, m: 3.55, g: 3.44, k: 3.24, h: 2.85, v: 2.55, ä: 2.10,
  u: 1.86, f: 1.81, c: 1.71, å: 1.66, p: 1.57, ö: 1.50, b: 1.31, j: 0.90,
  y: 0.49, x: 0.11, w: 0.06, z: 0.04, q: 0.01,
};

// An unlisted letter (é, à, …) gets roughly the mean, so reaching for an exotic
// character is not a free way to win a tiebreak.
export const UNLISTED_FREQUENCY = 3.4;
