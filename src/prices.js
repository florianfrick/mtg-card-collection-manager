// Daily price snapshots.
//
// Scryfall exposes only the *current* price for a card (no history endpoints, and
// the bulk files are a single stale snapshot), so a price series has to be built
// here: once a day, record what every card in the collection is worth. History
// therefore starts when this app does and grows one point per day — see the
// README ("Price history").
import { cardsToSnapshot, lastSnapshotDay, recordPrices } from './db.js';
import { pricesForIds } from './scryfall.js';

const isoDay = () => new Date().toISOString().slice(0, 10);

/**
 * Snapshot today's prices for every card that appears in a collection.
 * Idempotent per day (price_snapshot is keyed card + day), so running twice in a
 * day re-fetches but never duplicates a point.
 */
export async function snapshotPrices() {
  const ids = cardsToSnapshot();
  if (!ids.length) return { cards: 0, priced: 0, written: 0, total: 0 };
  const prices = await pricesForIds(ids);
  const rows = ids.map((id) => ({
    scryfall_id: id,
    price_usd: prices.get(id)?.usd ?? null,
    price_usd_foil: prices.get(id)?.usd_foil ?? null,
    // Same response, no extra request: fills in a rarity or a TCGplayer id an
    // older add missed (the listing export keys on the latter).
    rarity: prices.get(id)?.rarity ?? null,
    tcgplayer_id: prices.get(id)?.tcgplayer_id ?? null,
  }));
  const written = recordPrices(rows);
  return {
    cards: ids.length,
    priced: rows.filter((r) => r.price_usd != null || r.price_usd_foil != null).length,
    written,
    // Log total: non-foil prices only — the portfolio endpoint already weighs
    // each row by its own finish.
    total: rows.reduce((s, r) => s + (r.price_usd ?? 0), 0),
  };
}

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // re-check every 6 h

/**
 * Zero-config scheduling for a long-running server: snapshot shortly after boot,
 * then re-check every few hours. Because only one point per day is ever recorded,
 * the extra checks are cheap and the series stays one point per day.
 */
export function startDailySnapshots() {
  const run = async () => {
    try {
      if (lastSnapshotDay() === isoDay()) return; // today is already recorded
      const r = await snapshotPrices();
      console.log(`price snapshot: ${r.priced}/${r.cards} priced · total USD ${r.total.toFixed(2)}`);
    } catch (e) {
      console.error('price snapshot failed:', String(e?.message || e));
    }
  };
  setTimeout(run, 10_000).unref?.();
  setInterval(run, CHECK_INTERVAL_MS).unref?.();
}
