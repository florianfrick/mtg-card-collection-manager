import { sleep, numOrNull } from './util.js';

// ---------------------------------------------------------------------------
// Thin, rate-limited wrapper around the Scryfall API.
// NOTE: matching uses the live API for now (simplest + most accurate). A local
// card index could be swapped in behind these same functions later.
// ---------------------------------------------------------------------------

const UA = 'mtg-collection-manager/0.1 (personal dev)';
const BASE = 'https://api.scryfall.com';
// Scryfall documents 10 req/s, but it answers *bursts* with a 429 and a 60-second
// penalty box, and the penalty is not something a 250ms spacing can wait out.
// Name-first detection needs only a couple of requests per new card (the name
// lookup, then that card's printings), so there is no reason to be greedy: ~4/s
// is well past what a human-paced workflow can produce.
const MIN_SPACING_MS = 250;

let lastRequest = 0;

async function throttled(fn) {
  const now = Date.now();
  const wait = Math.max(0, MIN_SPACING_MS - (now - lastRequest));
  if (wait) await sleep(wait);
  lastRequest = Date.now();
  return fn();
}

// Set by sf() when a request did not actually produce an answer (429, 5xx, a
// dropped connection). cachedCard() refuses to cache those: a rate-limited
// lookup must not become a permanent "this card does not exist" for the life of
// the process, which is both wrong and invisible — detection just reports no
// match. Safe without locking: throttled() serializes the requests, so a
// failure always belongs to the cachedCard() call that is awaiting it.
let lastRequestFailed = false;

/** One request, inside the rate limiter. Returns { json } or { status, json }. */
async function sfOnce(path, init = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      ...init,
      headers: { 'User-Agent': UA, ...(init.headers ?? {}) },
    });
  } catch (e) {
    return { status: 0, json: String(e?.message || e) };
  }
  if (res.status === 404) return { status: 404, json: null }; // a real answer
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) return { status: res.status, json };
  return { status: res.status, json };
}

// Scryfall answers a burst with 429 and "try again after 60 seconds". The spacing
// above is enough on its own, but a cold start (server boot, camera switched on)
// or a batch run can still trip the limiter — and a plain null then reaches the
// resolver looking exactly like "no such card", which silently costs a correct
// identification. So a throttled or failed request is waited out and retried
// rather than reported as a miss. The ladder sums to ~23s, inside the 60s
// penalty box, so one unlucky burst does not lose the card.
const RETRY_DELAYS_MS = [2000, 6000, 15000];
const isTransient = (status) => status === 429 || status === 0 || status >= 500;

async function sf(path, init) {
  for (let attempt = 0; ; attempt++) {
    const { status, json } = await throttled(() => sfOnce(path, init));
    if (status === 404) return { not_found: true, status };
    if (status >= 200 && status < 300) return json;
    if (isTransient(status) && attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    lastRequestFailed = true;
    return { not_found: true, status, error: json };
  }
}

// Memoized card lookups, keyed by the query (per process). Camera mode polls
// the same card frame after frame, and the same printing comes back repeatedly
// during a session, so each distinct lookup should cost exactly one request —
// including the negative results (a misread set/number is never re-checked).
const CARD_CACHE_MAX = 500;
const cardCache = new Map();

async function cachedCard(key, load) {
  if (cardCache.has(key)) return cardCache.get(key);
  lastRequestFailed = false;
  const card = await load();
  // Only a real answer is worth remembering; a failed request must stay
  // retryable (see lastRequestFailed).
  if (!lastRequestFailed) {
    if (cardCache.size >= CARD_CACHE_MAX) cardCache.delete(cardCache.keys().next().value); // drop oldest
    cardCache.set(key, card);
  }
  return card;
}

/** Returns the raw Scryfall card object for a fuzzy name match, or null. */
export async function namedFuzzy(name) {
  return cachedCard('fuzzy:' + String(name).toLowerCase(), async () => {
    const c = await sf('/cards/named?fuzzy=' + encodeURIComponent(name));
    return c && !c.not_found && typeof c.id === 'string' ? c : null;
  });
}

/** Returns the raw Scryfall card object for a set code + collector number, or null. */
export async function bySetNumber(setCode, collectorNumber) {
  const set = String(setCode).toLowerCase();
  const num = String(collectorNumber);
  return cachedCard(`set:${set}/${num}`, async () => {
    const c = await sf(`/cards/${encodeURIComponent(set)}/${encodeURIComponent(num)}`);
    return c && !c.not_found && typeof c.id === 'string' ? c : null;
  });
}

/** Returns an array of raw Scryfall card objects from a text search. */
export async function searchCards(query, unique = 'cards') {
  const q = '/cards/search?q=' + encodeURIComponent(query) + '&unique=' + unique;
  const r = await sf(q);
  if (r.not_found || !Array.isArray(r.data)) return [];
  return r.data;
}

const printingsCache = new Map(); // name -> printing list (per process)

/** Returns an array of every printing of `name`, mapped via toPrinting(). */
export async function printingsOf(name) {
  if (printingsCache.has(name)) return printingsCache.get(name);
  const q =
    '/cards/search?q=' +
    encodeURIComponent('!"' + name + '"') +
    '&unique=prints&order=set&include_extras=true';
  const r = await sf(q);
  if (r.not_found || !Array.isArray(r.data)) return [];
  const out = r.data.map(toPrinting).filter(Boolean);
  printingsCache.set(name, out);
  return out;
}

let setCodes = null;
let setsLoaded = false;

/**
 * All Scryfall set codes (uppercase), fetched once per process; null on failure.
 * Used to validate set codes OCR'd from the card's "SET • EN" line.
 */
export async function knownSets() {
  if (!setsLoaded) {
    setsLoaded = true;
    const r = await sf('/sets');
    if (Array.isArray(r.data)) {
      setCodes = new Set(r.data.map((s) => String(s.code).toUpperCase()));
    }
  }
  return setCodes;
}

/** Normalize a raw Scryfall card object into our compact "printing" shape. */
export function toPrinting(card) {
  if (!card || typeof card.id !== 'string') return null;
  const imgs = card.image_uris ?? card.card_faces?.[0]?.image_uris ?? null;
  return {
    scryfall_id: card.id,
    name: card.name,
    set_code: card.set,
    set_name: card.set_name,
    collector_number: card.collector_number,
    rarity: card.rarity,
    image_url: imgs?.large ?? imgs?.normal ?? null,
    prices: {
      usd: numOrNull(card.prices?.usd),
      eur: numOrNull(card.prices?.eur),
      usd_foil: numOrNull(card.prices?.usd_foil),
      eur_foil: numOrNull(card.prices?.eur_foil),
    },
  };
}

/**
 * Current USD prices for a batch of Scryfall printing ids — one entry per id:
 * `{ usd, usd_foil }`, each null when Scryfall has no price for that finish.
 * Uses POST /cards/collection (up to 75 identifiers per request), so a whole
 * collection costs a handful of requests instead of one per card — this is what
 * keeps the daily price snapshot cheap. Missing ids simply do not appear in the
 * returned Map.
 */
export async function pricesForIds(ids) {
  const out = new Map();
  const CHUNK = 75;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const identifiers = ids.slice(i, i + CHUNK).map((id) => ({ id }));
    const r = await sf('/cards/collection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifiers }),
    });
    if (r && Array.isArray(r.data)) {
      for (const c of r.data) {
        out.set(c.id, { usd: numOrNull(c.prices?.usd), usd_foil: numOrNull(c.prices?.usd_foil) });
      }
    }
  }
  return out;
}