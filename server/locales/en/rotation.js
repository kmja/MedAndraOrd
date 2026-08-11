// The daily schedule for the English bank, frozen.
//
// The word for a date is ROTATION[p], where p counts days from EPOCH. Written
// down rather than derived, for the reason the Swedish schedule records: when
// it was computed as (dayNumber * STRIDE) % WORDS.length, growing the bank
// changed the modulus and every date — today included, mid-play — moved to a
// different word. Appending here extends the runway without disturbing a day
// that already has one.
//
// The order is a stride permutation of the bank (stride 25, coprime with
// 66), so consecutive days are far apart in the array.
//
// EPOCH is unchanged from the first English bank: nothing has been played yet,
// so there is no day to protect, and keeping it means the calendar starts the
// day the edition was first built rather than drifting with each rewrite.

export const ROTATION_EPOCH = 20676;

export const ROTATION = [
  0, 25, 50, 9, 34, 59, 18, 43, 2, 27,
  52, 11, 36, 61, 20, 45, 4, 29, 54, 13,
  38, 63, 22, 47, 6, 31, 56, 15, 40, 65,
  24, 49, 8, 33, 58, 17, 42, 1, 26, 51,
  10, 35, 60, 19, 44, 3, 28, 53, 12, 37,
  62, 21, 46, 5, 30, 55, 14, 39, 64, 23,
  48, 7, 32, 57, 16, 41,
];
