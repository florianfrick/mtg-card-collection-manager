// Card condition — the one field a seller cannot infer and a price cannot be
// quoted without.
//
// The five grades are TCGplayer's, because every route that pays for a card
// (marketplace or buylist) uses them, and a card's grade is the difference
// between a $40 sale and a $28 one.
//
// `factor` is the fraction of the near-mint market price a copy is worth. These
// are ESTIMATES, not measurements: the real ratio moves with the card and the
// buyer. They are here so the economics can be computed at all, and every one of
// them is editable per user (see src/economics.js) — the UI labels them as
// assumptions rather than quoting them as facts.
export const CONDITIONS = [
  { code: 'NM', label: 'Near mint', short: 'NM', factor: 1 },
  { code: 'LP', label: 'Lightly played', short: 'LP', factor: 0.85 },
  { code: 'MP', label: 'Moderately played', short: 'MP', factor: 0.7 },
  { code: 'HP', label: 'Heavily played', short: 'HP', factor: 0.5 },
  { code: 'DMG', label: 'Damaged', short: 'DMG', factor: 0.35 },
];

export const CONDITION_CODES = CONDITIONS.map((c) => c.code);

/** The grade a card gets when nobody says otherwise: NM, matching the market price. */
export const DEFAULT_CONDITION = 'NM';

/** TCGplayer's own spelling, which its bulk-upload file expects. */
const TCG_LABELS = {
  NM: 'Near Mint',
  LP: 'Lightly Played',
  MP: 'Moderately Played',
  HP: 'Heavily Played',
  DMG: 'Damaged',
};

/**
 * Coerce a grade to its canonical code ('lp' -> 'LP'), or return null when it
 * is not a grade at all. Callers that must not guess (the API, the exporter)
 * pass the result through and reject a null; the storage layer falls back to
 * DEFAULT_CONDITION so an old row or a partial update can never write junk.
 */
export function normalizeCondition(value) {
  if (value == null || value === '') return null;
  const code = String(value).trim().toUpperCase();
  return CONDITION_CODES.includes(code) ? code : null;
}

/** The grade's label ("Lightly played"), for display. */
export function conditionLabel(code) {
  return CONDITIONS.find((c) => c.code === normalizeCondition(code))?.label ?? String(code ?? '');
}

/** What TCGplayer calls this grade, for the bulk-upload file. */
export function tcgConditionLabel(code) {
  return TCG_LABELS[normalizeCondition(code) ?? DEFAULT_CONDITION] ?? 'Near Mint';
}
