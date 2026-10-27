// ---------------------------------------------------------------------------
// Set completion: how much of each set a collection holds.
//
// The numerator comes from the collection itself (`card.set_code` +
// `card.collector_number`, which the exact-printing lookup already relies on);
// the denominator comes from Scryfall's set list: `printed_size` (the number
// printed on the cards — "143/280"), falling back to `card_count` for the older
// sets that do not carry it. Nothing new is stored, so this works on
// collections built before the feature existed.
//
// Owning extra treatments whose collector numbers run past the printed size
// (surge foils, "124s") can push the raw count above the total, so the
// percentage is clamped — the raw numbers are reported as they are.
// ---------------------------------------------------------------------------
import { setOwnership } from './db.js';
import { allSets } from './scryfall.js';

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * One entry per set the collection touches, best progress first:
 * `{ code, name, owned, total, percent, copies, value, complete, releasedAt, setType, icon }`.
 * `total` and `percent` are null when Scryfall's set list is unavailable — the
 * owned counts are still correct, there is just nothing to measure them against.
 */
export async function setCompletion(userId) {
  const owned = setOwnership(userId);
  if (!owned.length) return { sets: [], summary: { sets: 0, complete: 0, cards: 0, value: 0 } };

  const catalog = await allSets();
  const sets = owned.map((o) => {
    const code = String(o.code).toUpperCase();
    const meta = catalog?.get(code) ?? null;
    const total = meta?.printedSize ?? meta?.cardCount ?? null;
    const percent = total ? Math.min(1, o.owned / total) : null;
    return {
      code,
      name: meta?.name ?? code,
      owned: o.owned,
      total,
      percent,
      copies: o.copies,
      value: round2(o.value),
      complete: total != null && o.owned >= total,
      releasedAt: meta?.releasedAt ?? null,
      setType: meta?.setType ?? null,
      icon: meta?.icon ?? null,
    };
  });

  // Sets you have finished float to the top, then whatever is closest to done;
  // sets with no known total sit at the bottom (they can never be "nearly done").
  sets.sort((a, b) => {
    if ((a.percent == null) !== (b.percent == null)) return a.percent == null ? 1 : -1;
    if (a.percent != null && a.percent !== b.percent) return b.percent - a.percent;
    return b.owned - a.owned || a.name.localeCompare(b.name);
  });

  return {
    sets,
    summary: {
      sets: sets.length,
      complete: sets.filter((s) => s.complete).length,
      cards: sets.reduce((n, s) => n + s.owned, 0),
      value: round2(sets.reduce((n, s) => n + s.value, 0)),
    },
  };
}
