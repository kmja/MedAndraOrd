// The daily schedule for the English bank, frozen.
//
// The word for a date is ROTATION[p], where p counts days from EPOCH. Written
// down rather than derived, for the reason the Swedish schedule records: when
// it was computed as (dayNumber * STRIDE) % WORDS.length, growing the bank
// changed the modulus and every date — today included, mid-play — moved to a
// different word. Appending here extends the runway without disturbing a day
// that already has one.
//
// The order is a stride permutation of the bank (stride 23, coprime with
// 60), so consecutive days are far apart in the array.
//
// EPOCH is the day this bank was authored. Sixty entries is roughly two months
// of play; after that it wraps, which is the signal to extend the bank rather
// than to let it repeat.

export const ROTATION_EPOCH = 20676;

export const ROTATION = [
  0, 23, 46, 9, 32, 55, 18, 41, 4, 27,
  50, 13, 36, 59, 22, 45, 8, 31, 54, 17,
  40, 3, 26, 49, 12, 35, 58, 21, 44, 7,
  30, 53, 16, 39, 2, 25, 48, 11, 34, 57,
  20, 43, 6, 29, 52, 15, 38, 1, 24, 47,
  10, 33, 56, 19, 42, 5, 28, 51, 14, 37,
];
