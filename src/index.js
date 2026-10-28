import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectCard } from './detect.js';
import { namedFuzzy, printingsOf } from './scryfall.js';
import {
  addEntry, listEntries, removeEntry, decrementEntry, incrementEntry, setEntryQuantity, setEntryFoil, setEntryCondition,
  priceHistory, portfolioHistory,
  closeDatabase, collectionSize, entryExists,
} from './db.js';
import { numOrNull, sameOriginOnly } from './util.js';
import { ppocrStatus, stopPpocr } from './ppocr.js';
import { startDailySnapshots } from './prices.js';
import { setCompletion } from './sets.js';
import {
  DEFAULT_SETTINGS, PLATFORMS, buylistCsv, insights, loadSettings, plan, plainList, saveSettings, tcgplayerCsv,
} from './economics.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json({ limit: '40mb' })); // base64 scans can be large
app.use(express.static(join(here, '..', 'public')));

// Liveness/readiness for container orchestration. Cheap by design — one COUNT
// over the collection, no writes. A missing OCR engine is reported but is not a
// failure: the collection still works, only scanning does not.
app.get('/healthz', (req, res) => {
  try {
    collectionSize();
    res.json({ ok: true, ocr: ppocrStatus().available });
  } catch (e) {
    res.status(503).json({ ok: false, error: String(e?.message || e) });
  }
});

// The app answers on a port, so a page on another origin must not be able to
// add or delete cards. No session rides along any more, so this is the whole
// guard — see src/util.js.
app.use('/api', sameOriginOnly);

/** Accept a base64 string or a `data:...;base64,...` URL. */
function toBuffer(image) {
  if (typeof image !== 'string') throw new Error('image must be a base64 string or data URL');
  const b64 = image.includes(',') ? image.split(',')[1] : image;
  return Buffer.from(b64, 'base64');
}


// ---- Auto-add: store the best match without a click ------------------------

// A scan adds itself to the collection when its most likely printing clears
// this likelihood (0..1, computed in detect.js). 0.5 keeps the common case
// (set code + collector number validated by Scryfall, ~0.9) zero-click, while a
// name-only match spread thinly over many printings still asks for a click.
// MTG_AUTO_ADD_MIN=0 makes it always take the top candidate.
const AUTO_ADD_MIN_LIKELIHOOD = numOrNull(process.env.MTG_AUTO_ADD_MIN) ?? 0.5;

/** Map a detected candidate / manual POST body onto a collection row.
 * `foil` (manual flag — there is no foil detection yet) picks the foil price:
 * a foil copy is worth its own number, so it stores usd_foil, not usd.
 * `condition` is the manual grade; absent means near mint, and an unknown grade
 * is rejected by addEntry rather than quietly stored as NM.
 * `rarity` and `tcgplayer_id` travel with every candidate; dropping them here is
 * what used to leave the columns empty for every card in the database. */
function entryFromBody(b = {}) {
  const foil = b.foil === true || b.foil === 1;
  return {
    scryfall_id: b.scryfall_id,
    name: b.name,
    set_name: b.set_name,
    set_code: b.set_code,
    collector_number: b.collector_number,
    rarity: b.rarity ?? null,
    image_url: b.image_url,
    tcgplayer_id: b.tcgplayer_id ?? null,
    foil,
    condition: b.condition ?? undefined,
    price_usd: foil
      ? (b.prices?.usd_foil ?? b.price_usd ?? null)
      : (b.prices?.usd ?? b.price_usd ?? null),
  };
}

/**
 * Store the most likely candidate and report exactly what happened, so the UI
 * can name the card it added and offer −1 / remove. Never throws: a scan
 * that can't be added still returns its candidates, with a `reason`.
 * A printing already owned is NOT an error — this call just adds another
 * copy (see addEntry): `newCopy` tells the UI first-copy vs top-up apart.
 * `foil` and `condition` are the UI's manual toggles for this scan; when set,
 * the copy lands as foil (own row, foil price) and/or as that grade (own row).
 */
function autoAdd(candidates, { foil = false, condition = undefined } = {}) {
  const candidate = candidates?.[0] ?? null;
  if (!candidate) {
    return { added: false, candidate: null, reason: 'no-match', threshold: AUTO_ADD_MIN_LIKELIHOOD };
  }
  const likelihood = candidate.likelihood ?? 0;
  if (likelihood < AUTO_ADD_MIN_LIKELIHOOD) {
    return { added: false, candidate, likelihood, reason: 'low-likelihood', threshold: AUTO_ADD_MIN_LIKELIHOOD };
  }
  try {
    const { entry, newCopy, addedCopies } = addEntry(entryFromBody({ ...candidate, foil, condition }));
    return { added: true, newCopy, addedCopies, candidate, likelihood, entry, foil: !!foil, condition: entry?.condition ?? null };
  } catch (e) {
    return { added: false, candidate, likelihood, reason: 'error', message: String(e?.message || e) };
  }
}

// ---- Detection ------------------------------------------------------------

app.post('/api/detect', async (req, res) => {
  try {
    const buf = toBuffer(req.body?.image);
    // `ignoreCues` (camera mode) is a parsed.key the client has already acted
    // on. When OCR reads those cues again nothing changed, so detection comes
    // back `unchanged` with no candidates — a card sitting under the camera then
    // costs one OCR pass and zero Scryfall requests.
    const ignoreCues = typeof req.body?.ignoreCues === 'string' ? req.body.ignoreCues : '';
    const { text, parsed, top, printings, identified, preview, words, ocrSize, unchanged, legibility, ms } = await detectCard(
      buf,
      { ignoreKey: ignoreCues }
    );

    // top + all printings, de-duplicated and ordered by likelihood: the first
    // entry is what autoAdd() stores, the rest are the alternatives the UI
    // offers for a remove / replace.
    const seen = new Set();
    const candidates = [];
    for (const c of [top, ...printings]) {
      if (!c || seen.has(c.scryfall_id)) continue;
      seen.add(c.scryfall_id);
      candidates.push(c);
    }
    candidates.sort((a, b) => (b.likelihood ?? 0) - (a.likelihood ?? 0));
    const shortlist = candidates.slice(0, 20);

    // Opt-in (`autoAdd: true`, used by the UIs): store the most likely printing
    // right here, so one scan = one round trip. Off by default, which keeps
    // /api/detect read-only for the CLI and the smoke test. `foil` and
    // `condition` are the UI's manual toggles for this scan — nothing detects
    // either automatically.
    const foil = req.body?.foil === true || req.body?.foil === 1;
    const condition = typeof req.body?.condition === 'string' ? req.body.condition : undefined;
    const autoAdded = req.body?.autoAdd !== true ? null
      // Camera mode: same card as the previous frame -> keep what the client
      // already shows, don't add anything again.
      : unchanged ? { added: false, candidate: null, reason: 'same-card' }
      : autoAdd(shortlist, { foil, condition });

    res.json({
      text,
      parsed,
      candidates: shortlist,
      top,
      // Which card was recognized and how sure we are of that, separate from the
      // per-candidate `likelihood` (which answers "which printing?"). On a photo
      // the title gives us the card and nothing pins the printing, so the UI says
      // "recognized X, pick the printing" rather than quoting a low number.
      identified,
      // True when the cues matched `ignoreCues`: same card, nothing resolved.
      unchanged,
      // What the auto-add did (or why it didn't) — the UI shows this card.
      autoAdded,
      // The card the box finder located, as a data URL the UI can drop straight
      // into <img>. Display only: PP-OCR read the uploaded image whole.
      croppedImage: preview ? `data:image/jpeg;base64,${preview.toString('base64')}` : null,
      // For the UI overlay: word boxes, moved into the preview's coordinates.
      words,
      // How long PP-OCR spent on this image (ms), shown in the readout panel.
      ms,
      ocrSize,
      // How tall the card's footer text is in the image (`ok: false` = too small
      // to read, so the UIs tell the user to fill the frame instead of reporting
      // a bare "nothing legible").
      legibility,
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---- Manual search (backup add path) ---------------------------------------

app.get('/api/printings', async (req, res) => {
  try {
    const name = (req.query.name || '').trim();
    if (!name) return res.json({ printings: [] });
    const card = await namedFuzzy(name);
    const printings = card ? await printingsOf(card.name) : [];
    res.json({ printings });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---- Collection CRUD -------------------------------------------------------
// One row per printing per finish per grade; duplicate copies of the same
// kind live in `quantity`:
//   POST   /api/collection            { ..., copies?, foil? } -> add that many copies
//   PATCH  /api/collection/:id        { copies } -> add that many (default 1)
//   PUT    /api/collection/:id        { quantity } -> set exact count (0 deletes)
//   POST   /api/collection/:id/decrement { n? } -> remove n copies (default 1)
//   POST   /api/collection/:id/foil   { foil } -> flip the finish (merges with
//                                                 an owned row of that finish)
//   POST   /api/collection/:id/condition { condition } -> re-grade (same merge)
//   DELETE /api/collection/:id        drop the row whatever the count

app.get('/api/collection', (req, res) => {
  try {
    res.json(listEntries());
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post('/api/collection', (req, res) => {
  try {
    res.json(addEntry(entryFromBody(req.body), req.body?.copies ?? 1));
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

app.patch('/api/collection/:id', (req, res) => {
  try {
    // PATCH adds copies to an existing row: no lookup needed beforehand —
    // incrementEntry updates by id and returns null when the row is gone.
    const n = Math.max(1, Math.floor(Number(req.body?.copies ?? 1) || 1));
    const entry = incrementEntry(req.params.id, n);
    if (!entry) return res.status(404).json({ error: 'not found' });
    res.json({ entry, addedCopies: n });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

app.put('/api/collection/:id', (req, res) => {
  try {
    // Checked first because `entry: null` means "the last copy is gone" here,
    // which must not be confused with an id that never existed (404).
    if (!entryExists(req.params.id)) return res.status(404).json({ error: 'not found' });
    const entry = setEntryQuantity(req.params.id, req.body?.quantity);
    res.json({ entry, removed: !entry });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

app.post('/api/collection/:id/decrement', (req, res) => {
  try {
    // Same reason as PUT: a null answer is the last copy leaving, not a 404.
    if (!entryExists(req.params.id)) return res.status(404).json({ error: 'not found' });
    const entry = decrementEntry(req.params.id, req.body?.n ?? 1);
    res.json({ entry, removed: !entry });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

app.post('/api/collection/:id/foil', (req, res) => {
  try {
    if (!entryExists(req.params.id)) return res.status(404).json({ error: 'not found' });
    // Flipping may merge this row into one already owned in the target finish,
    // so the answer is the *surviving* row (its id can differ from the id posted).
    const entry = setEntryFoil(req.params.id, req.body?.foil === true || req.body?.foil === 1);
    res.json({ entry });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

app.post('/api/collection/:id/condition', (req, res) => {
  try {
    if (!entryExists(req.params.id)) return res.status(404).json({ error: 'not found' });
    // Re-grading may merge this row into one already owned at that grade, so the
    // answer is the *surviving* row (its id can differ from the id posted).
    const entry = setEntryCondition(req.params.id, req.body?.condition);
    res.json({ entry });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

app.delete('/api/collection/:id', (req, res) => {
  try {
    // Deleting something that is not there is a 404, not a cheerful "removed" —
    // the UI reloads from the server either way.
    const { changes } = removeEntry(req.params.id);
    if (!changes) return res.status(404).json({ error: 'not found' });
    res.json({ changes });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---- Price history (daily snapshots; see src/prices.js) --------------------

app.get('/api/prices/portfolio', (req, res) => {
  try {
    res.json(portfolioHistory());
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get('/api/prices/:scryfall_id', (req, res) => {
  try {
    res.json(priceHistory(req.params.scryfall_id));
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---- Set completion (see src/sets.js) --------------------------------------

// How much of each set the caller owns. The numerator is the collection, the
// denominator is Scryfall's printed set size — so the answer is "143 of 280",
// the same number printed on the cards.
app.get('/api/sets', async (req, res) => {
  try {
    res.json(await setCompletion());
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---- Economics: what the collection raises, and where ----------------------
//
// The retail benchmark is already in the database (Scryfall's `usd` is the
// TCGplayer market price), so the comparison needs no credentials and no network
// — it is arithmetic over the rows the collection page already fetched. The
// settings are the assumptions that arithmetic rests on, and they are editable.

/** The plan under the saved assumptions, plus the sentences that explain it. */
function economicsFor() {
  const settings = loadSettings();
  const p = plan(listEntries(), settings);
  return { settings, plan: p, insights: insights(p) };
}

app.get('/api/economics', (req, res) => {
  try {
    res.json({ ...economicsFor(), platforms: PLATFORMS, defaults: DEFAULT_SETTINGS });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/** Save assumptions (partial patch) and answer with the plan they produce. */
app.put('/api/economics/settings', (req, res) => {
  try {
    // Validation happens before anything is written: a bad number must not
    // become a stored NaN that makes every card look worthless.
    const settings = saveSettings(req.body ?? {});
    const p = plan(listEntries(), settings);
    res.json({ settings, plan: p, insights: insights(p) });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// The files each route actually wants. `bucket` is which half of the plan the
// format is for: a marketplace inventory file lists cards, a buylist order ships
// a box — they are not the same list and must not be mixed.
const EXPORTS = {
  tcgplayer: { name: 'tcgplayer-inventory', ext: 'csv', type: 'text/csv', bucket: 'list', build: tcgplayerCsv },
  buylist: { name: 'buylist-order', ext: 'csv', type: 'text/csv', bucket: 'box', build: buylistCsv },
  list: { name: 'buylist-list', ext: 'txt', type: 'text/plain', bucket: 'box', build: plainList },
};

app.get('/api/economics/export', (req, res) => {
  try {
    const format = String(req.query.format ?? 'tcgplayer').toLowerCase();
    const spec = EXPORTS[format];
    if (!spec) return res.status(400).json({ error: `format must be one of ${Object.keys(EXPORTS).join(', ')}` });
    const bucket = String(req.query.bucket ?? spec.bucket).toLowerCase();
    if (bucket !== 'list' && bucket !== 'box') {
      return res.status(400).json({ error: 'bucket must be "list" or "box"' });
    }
    const { plan: p } = economicsFor();
    const built = spec.build(p.buckets[bucket].cards);
    const body = built.csv ?? built.text ?? '';
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', `${spec.type}; charset=utf-8`);
    res.setHeader('Content-Disposition', `attachment; filename="${spec.name}-${stamp}.${spec.ext}"`);
    // Rows the format could not carry (a TCGplayer listing without a product id)
    // are reported rather than silently dropped.
    if (built.skipped) res.setHeader('X-Skipped-Rows', String(built.skipped));
    res.send(body);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

const server = app.listen(PORT, () => {
  console.log(`MTG Collection Manager running at http://localhost:${PORT}`);
  // Keep the daily price history going while the server is up (idempotent/day).
  startDailySnapshots();
});

// Shutdown. `docker stop` sends SIGTERM and then waits: answer in-flight
// requests, close the database cleanly and take the OCR child down with us,
// rather than being killed mid-write. The timer is the backstop for a request
// that will not finish (a stuck scan), so the container still exits in time.
let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`${signal}: shutting down`);
  const done = () => {
    try { stopPpocr(); } catch { /* already gone */ }
    try { closeDatabase(); } catch { /* already closed */ }
    process.exit(0);
  };
  server.close(done);
  server.closeIdleConnections?.();
  setTimeout(() => {
    server.closeAllConnections?.();
    done();
  }, 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
