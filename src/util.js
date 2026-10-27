export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Convert a possibly-null/empty string to a number, else null. */
export function numOrNull(v) {
  if (v === null || v === undefined || v === '' || isNaN(Number(v))) return null;
  return Number(v);
}