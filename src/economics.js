// What a card is actually worth to you, per route.
//
// The retail price in the database (Scryfall's `usd` = TCGplayer market, near
// mint) is a *benchmark*, not proceeds. Getting from one to the other takes five
// adjustments, and only the first two are facts:
//
//   fees        published by the platform, encoded below
//   postage     known per method; a default, editable per user
//   condition   an estimate — see src/condition.js
//   undercut    an estimate: you must price at or below market to actually sell
//   sell-through an estimate we do not model at all (see the caveat below)
//
// Everything here is therefore labelled an estimate in the UI. The value of the
// module is not precision, it is that the comparison is made at all: the gap
// between "list it yourself" and "put it in a box" is wide enough that the
// decision survives the error bars.
//
// Caveat worth stating once: retail is *probabilistic*. A listed card may never
// sell, and it sells at an unknown time. A buylist quote is certain. That is why
// the plan reports the two nets side by side and never blends them into one
// number — and why the floor (`minNet`) exists: below it, the certain thing wins
// no matter what the optimistic arithmetic says.
import { CONDITION_CODES, CONDITIONS, DEFAULT_CONDITION, normalizeCondition, tcgConditionLabel } from './condition.js';
import { getSetting, setSetting } from './db.js';

const SETTING_KEY = 'economics';

/** A card below this wholesale value is not worth the postage to send anywhere. */
const BUYLIST_FLOOR = 0.25;

// Money, to the cent. The nudge absorbs binary floating point: 10 * 0.85 * 0.95
// is 8.074999999999999, and without it a half-cent would round *down* and make
// the displayed price a cent short of what a person computes by hand.
const round2 = (v) => Math.round(Number(v) * 100 + Math.sign(Number(v)) * 1e-6) / 100;

/**
 * Per-platform fee presets. Both are marketplace commission + a fixed per-order
 * charge; eBay's managed payments are inside its final value fee, TCGplayer
 * bills processing separately, hence the two columns.
 *
 * These change. They are presets, not gospel: every number is editable and the
 * stored settings win over the preset.
 */
export const PLATFORMS = {
  tcgplayer: {
    label: 'TCGplayer',
    commissionPct: 10.25,
    paymentPct: 2.5,
    perOrderFee: 0.3,
    note: 'commission on the card category, plus payment processing',
  },
  ebay: {
    label: 'eBay',
    commissionPct: 13.35,
    paymentPct: 0,
    perOrderFee: 0.3,
    note: 'final value fee (payment processing is inside it)',
  },
};

export const DEFAULT_SETTINGS = {
  platform: 'tcgplayer',
  commissionPct: PLATFORMS.tcgplayer.commissionPct,
  paymentPct: PLATFORMS.tcgplayer.paymentPct,
  perOrderFee: PLATFORMS.tcgplayer.perOrderFee,
  postage: 1.1, // stamp + envelope + toploader for one card, US
  undercutPct: 5, // price below market, so the card actually moves
  buylistRatePct: 50, // what a dealer pays against market — replace with a real quote
  minNet: 3, // do not spend an envelope on a card that nets less than this
  capacity: 40, // listings you are actually willing to pack this month
  conditionFactors: Object.fromEntries(CONDITIONS.map((c) => [c.code, c.factor])),
};

// ---- settings --------------------------------------------------------------

function readNumber(raw, fallback, { label, min = 0, max = Infinity, int = false }) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number`);
  if (n < min || n > max) throw new Error(`${label} must be between ${min} and ${max}`);
  return int ? Math.floor(n) : n;
}

/**
 * Validate and normalize a settings object. Throws with a human-readable message
 * on anything unusable, so the API can answer 400 rather than storing a NaN that
 * silently makes every card "not worth selling".
 */
export function resolveSettings(raw = {}) {
  const platform = String(raw.platform ?? DEFAULT_SETTINGS.platform).toLowerCase();
  if (!PLATFORMS[platform]) {
    throw new Error(`platform must be one of ${Object.keys(PLATFORMS).join(', ')}`);
  }
  const preset = PLATFORMS[platform];
  const factors = {};
  for (const code of CONDITION_CODES) {
    factors[code] = readNumber(
      raw.conditionFactors?.[code],
      DEFAULT_SETTINGS.conditionFactors[code],
      { label: `condition multiplier for ${code}`, min: 0, max: 1 }
    );
  }
  return {
    platform,
    commissionPct: readNumber(raw.commissionPct, preset.commissionPct, { label: 'commission', max: 100 }),
    paymentPct: readNumber(raw.paymentPct, preset.paymentPct, { label: 'payment fee', max: 100 }),
    perOrderFee: readNumber(raw.perOrderFee, DEFAULT_SETTINGS.perOrderFee, { label: 'per-order fee', max: 100 }),
    postage: readNumber(raw.postage, DEFAULT_SETTINGS.postage, { label: 'postage', max: 100 }),
    undercutPct: readNumber(raw.undercutPct, DEFAULT_SETTINGS.undercutPct, { label: 'undercut', max: 100 }),
    buylistRatePct: readNumber(raw.buylistRatePct, DEFAULT_SETTINGS.buylistRatePct, { label: 'buylist rate', max: 100 }),
    minNet: readNumber(raw.minNet, DEFAULT_SETTINGS.minNet, { label: 'minimum net', max: 10000 }),
    capacity: readNumber(raw.capacity, DEFAULT_SETTINGS.capacity, { label: 'capacity', max: 100000, int: true }),
    conditionFactors: factors,
  };
}

/** The saved assumptions, or the defaults when none have been stored yet. */
export function loadSettings() {
  const stored = getSetting(SETTING_KEY, null);
  try {
    return resolveSettings(stored ?? {});
  } catch {
    // A stored value that no longer validates (an old knob, a bad edit) must not
    // break the page — fall back to defaults and let the next save overwrite it.
    return resolveSettings({});
  }
}

/**
 * Merge a patch into the stored settings. Switching platform also switches the
 * fee preset unless the patch sets the fees explicitly — otherwise "eBay" would
 * keep TCGplayer's commission and quietly overstate every eBay net.
 */
export function saveSettings(patch = {}) {
  const current = loadSettings();
  const next = { ...current, ...patch };
  const switchesPlatform = patch.platform && patch.platform !== current.platform;
  const setsFees = ['commissionPct', 'paymentPct', 'perOrderFee'].some((k) => patch[k] !== undefined);
  if (switchesPlatform && !setsFees) {
    const preset = PLATFORMS[String(patch.platform).toLowerCase()];
    if (preset) {
      next.commissionPct = preset.commissionPct;
      next.paymentPct = preset.paymentPct;
      next.perOrderFee = preset.perOrderFee;
    }
  }
  const resolved = resolveSettings(next);
  setSetting(SETTING_KEY, resolved);
  return resolved;
}

// ---- the arithmetic --------------------------------------------------------

/** The price to list at: market, adjusted for grade, minus a deliberate undercut. */
export function askPrice(market, factor, settings) {
  return round2(market * factor * (1 - settings.undercutPct / 100));
}

/** What one copy nets after commission, payment processing and postage. */
export function retailNet(market, factor, settings) {
  const ask = askPrice(market, factor, settings);
  const fees = (ask * (settings.commissionPct + settings.paymentPct)) / 100 + settings.perOrderFee;
  return round2(ask - fees - settings.postage);
}

/**
 * What one copy nets through a buylist. There is no per-card postage: the whole
 * box ships once, and the dealer's condition penalty is already inside the rate.
 */
export function buylistNet(market, factor, settings) {
  return round2((market * factor * settings.buylistRatePct) / 100);
}

/**
 * The break-even market price: below it, retail net is zero and the envelope
 * costs more than the card returns. Exposed because the tests pin it and the UI
 * quotes it ("cards under $X are not worth listing").
 */
export function retailBreakEven(settings) {
  // net = ask*(1 - c) - perOrder - postage = 0, solved for market with factor 1
  const c = (settings.commissionPct + settings.paymentPct) / 100;
  const askNeeded = (settings.perOrderFee + settings.postage) / (1 - c);
  return round2(askNeeded / (1 - settings.undercutPct / 100));
}

// ---- the plan --------------------------------------------------------------

/**
 * Classify every collection row into a route and total each bucket.
 *
 * Rows are moved whole, never split: a row is one listing (one grade, one
 * finish), so half of it cannot go in the box while the other half is listed.
 * `capacity` therefore cuts on whole rows, and the overflow lands in the box.
 */
export function plan(entries, settings) {
  const cards = [];

  for (const e of entries) {
    const quantity = Math.max(1, Math.floor(Number(e.quantity) || 1));
    const condition = normalizeCondition(e.condition) ?? DEFAULT_CONDITION;
    const factor = settings.conditionFactors[condition] ?? 1;
    const market = e.price_usd == null ? null : Number(e.price_usd);

    const row = {
      id: e.id,
      name: e.name,
      set_name: e.set_name ?? null,
      set_code: e.set_code ?? null,
      collector_number: e.collector_number ?? null,
      rarity: e.rarity ?? null,
      foil: !!e.foil,
      condition,
      quantity,
      image_url: e.image_url ?? null,
      tcgplayer_id: e.tcgplayer_id ?? null,
      market: market == null ? null : round2(market),
      ask: null,
      retailNet: null,
      buylistNet: null,
      bucket: 'unknown',
      reason: '',
    };

    if (!(market > 0)) {
      row.reason = 'no price yet';
      cards.push(row);
      continue;
    }

    row.ask = askPrice(market, factor, settings);
    row.retailNet = retailNet(market, factor, settings);
    row.buylistNet = buylistNet(market, factor, settings);
    const gain = row.retailNet - row.buylistNet;

    if (row.retailNet >= settings.minNet && gain > 0) {
      row.bucket = 'list';
      row.reason = `nets $${row.retailNet.toFixed(2)} after fees and postage`;
    } else if (row.buylistNet >= BUYLIST_FLOOR) {
      row.bucket = 'box';
      row.reason = row.retailNet < settings.minNet
        ? `listing nets only $${row.retailNet.toFixed(2)}`
        : 'the box pays nearly as much for less work';
    } else {
      row.bucket = 'ignore';
      row.reason = `under $${BUYLIST_FLOOR.toFixed(2)} wholesale`;
    }
    cards.push(row);
  }

  // Capacity: keep the cards with the biggest retail-over-wholesale gain (the
  // value of spending an envelope on them), push the rest into the box.
  const listable = cards.filter((c) => c.bucket === 'list').sort((a, b) => (b.retailNet - b.buylistNet) - (a.retailNet - a.buylistNet));
  let packed = 0;
  let overflow = 0;
  for (const c of listable) {
    if (packed + c.quantity <= settings.capacity) {
      packed += c.quantity;
      continue;
    }
    c.bucket = 'box';
    c.reason = `over your ${settings.capacity}-card limit`;
    overflow += c.quantity;
  }

  const byBucket = (name) => cards.filter((c) => c.bucket === name);
  const copies = (rows) => rows.reduce((s, c) => s + c.quantity, 0);
  const sum = (rows, pick) => round2(rows.reduce((s, c) => s + (pick(c) ?? 0) * c.quantity, 0));

  const list = byBucket('list').sort((a, b) => (b.retailNet - b.buylistNet) - (a.retailNet - a.buylistNet));
  const box = byBucket('box').sort((a, b) => (b.buylistNet ?? 0) - (a.buylistNet ?? 0));
  const ignore = byBucket('ignore').sort((a, b) => (b.market ?? 0) - (a.market ?? 0));
  const unknown = byBucket('unknown');

  const marketTotal = sum(cards, (c) => c.market);
  const conditionLoss = round2(
    cards.reduce((s, c) => {
      if (!(c.market > 0)) return s;
      const factor = settings.conditionFactors[c.condition] ?? 1;
      return s + c.market * (1 - factor) * c.quantity;
    }, 0)
  );

  return {
    settings,
    cards,
    buckets: {
      list: { cards: list, count: list.length, copies: copies(list), net: sum(list, (c) => c.retailNet) },
      box: { cards: box, count: box.length, copies: copies(box), net: sum(box, (c) => c.buylistNet) },
      ignore: { cards: ignore, count: ignore.length, copies: copies(ignore), market: sum(ignore, (c) => c.market) },
      unknown: { cards: unknown, count: unknown.length, copies: copies(unknown) },
    },
    totals: {
      market: marketTotal,
      copies: copies(cards),
      rows: cards.length,
      // What the whole collection would raise on the two routes actually chosen.
      net: round2(sum(list, (c) => c.retailNet) + sum(box, (c) => c.buylistNet)),
      retailNet: sum(list, (c) => c.retailNet),
      buylistNet: sum(box, (c) => c.buylistNet),
      overflow,
      conditionLoss,
      breakEven: retailBreakEven(settings),
      missingPrice: unknown.length,
      missingTcgId: list.filter((c) => c.tcgplayer_id == null).length,
    },
  };
}

/**
 * The sentences that make the numbers mean something. Each one is a fact about
 * this collection under these assumptions — no generic advice, and nothing that
 * would still be printed if the number behind it were zero.
 */
export function insights(p) {
  const out = [];
  const { buckets, totals, settings } = p;
  const money = (v) => `$${v.toFixed(2)}`;

  if (buckets.list.count) {
    out.push({
      tone: 'good',
      text: `Listing ${buckets.list.copies} ${buckets.list.copies === 1 ? 'card' : 'cards'} nets about ${money(buckets.list.net)} after fees and postage, at ${settings.undercutPct}% below market.`,
    });
    const extra = round2(buckets.list.net - buckets.list.cards.reduce((s, c) => s + (c.buylistNet ?? 0) * c.quantity, 0));
    if (extra > 0) {
      out.push({
        tone: 'good',
        text: `Retail beats a box by ${money(extra)} on those cards — that is what the envelopes buy you.`,
      });
    }
  }
  if (buckets.box.count) {
    out.push({
      tone: 'info',
      text: `${buckets.box.copies} ${buckets.box.copies === 1 ? 'card goes' : 'cards go'} in one box for about ${money(buckets.box.net)} — worth sending, not worth listing.`,
    });
  }
  if (buckets.ignore.count) {
    out.push({
      tone: 'muted',
      text: `${buckets.ignore.copies} ${buckets.ignore.copies === 1 ? 'card is' : 'cards are'} under ${money(BUYLIST_FLOOR)} wholesale. Postage costs more than they return, so leave them out of every shipment.`,
    });
  }
  if (totals.conditionLoss >= 0.5) {
    out.push({
      tone: 'warn',
      text: `Grades below near mint cost about ${money(totals.conditionLoss)} against the market price. Re-grade anything you listed as NM without looking.`,
    });
  }
  if (totals.overflow) {
    out.push({
      tone: 'warn',
      text: `${totals.overflow} more ${totals.overflow === 1 ? 'card qualifies' : 'cards qualify'} for listing than your ${settings.capacity}-card limit allows; they moved to the box. Raise the limit if you will pack them.`,
    });
  }
  if (totals.missingPrice) {
    out.push({
      tone: 'warn',
      text: `${totals.missingPrice} ${totals.missingPrice === 1 ? 'card has' : 'cards have'} no price yet — run a price snapshot before trusting these totals.`,
    });
  }
  return out;
}

// ---- export files ----------------------------------------------------------

/** RFC4180-ish cell: quote anything containing a comma, quote or newline. */
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Rows in, CSV out (CRLF line endings, which Excel and every importer accept). */
export function toCsv(header, rows) {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/**
 * TCGplayer seller-portal inventory file. The importer keys on `TCGplayer Id`,
 * so a row without one is skipped rather than silently rejected — the caller
 * reports how many were dropped.
 */
export function tcgplayerCsv(cards) {
  const header = [
    'TCGplayer Id', 'Product Line', 'Set Name', 'Product Name', 'Number',
    'Rarity', 'Condition', 'Printing', 'Price', 'Quantity',
  ];
  const rows = [];
  let skipped = 0;
  for (const c of cards) {
    if (c.tcgplayer_id == null) {
      skipped++;
      continue;
    }
    rows.push([
      c.tcgplayer_id,
      'Magic: The Gathering',
      c.set_name ?? '',
      c.name,
      c.collector_number ?? '',
      c.rarity ?? '',
      tcgConditionLabel(c.condition),
      c.foil ? 'Foil' : 'Normal',
      (c.ask ?? c.market ?? 0).toFixed(2),
      c.quantity,
    ]);
  }
  return { csv: toCsv(header, rows), skipped, rows: rows.length };
}

/**
 * A buylist order as a spreadsheet: what to send, in what grade, and what it is
 * expected to pay. Buylists grade on receipt, so the condition column is your
 * claim, not theirs — which is exactly why it is in the file.
 */
export function buylistCsv(cards) {
  const header = ['Quantity', 'Name', 'Set Code', 'Collector Number', 'Condition', 'Finish', 'Market Price', 'Est. Payout'];
  const rows = cards.map((c) => [
    c.quantity,
    c.name,
    (c.set_code ?? '').toUpperCase(),
    c.collector_number ?? '',
    c.condition,
    c.foil ? 'Foil' : 'Non-foil',
    (c.market ?? 0).toFixed(2),
    (c.buylistNet ?? 0).toFixed(2),
  ]);
  return { csv: toCsv(header, rows), rows: rows.length };
}

/**
 * The paste-a-list format every buylist tool accepts ("4 Lightning Bolt [2XM] 129").
 * Deliberately plain: no prices, no grades — this is for the box you are about to
 * put in the mail, and the dealer grades it on arrival anyway.
 */
export function plainList(cards) {
  const lines = cards.map((c) => {
    const set = (c.set_code ?? '').toUpperCase();
    const num = c.collector_number ?? '';
    return `${c.quantity} ${c.name}${set ? ` [${set}]` : ''}${num ? ` ${num}` : ''}`;
  });
  return { text: lines.join('\r\n') + (lines.length ? '\r\n' : ''), rows: lines.length };
}
