import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectCard } from './detect.js';
import { namedFuzzy, printingsOf } from './scryfall.js';
import {
  addEntry, listEntries, removeEntry, decrementEntry, incrementEntry, setEntryQuantity, setEntryFoil, setEntryCondition,
  priceHistory, portfolioHistory,
  collectionSize, createUser, deleteUserSessions, findUserByUsername, mergeGuestInto, ownsEntry,
  publicUser, purgeExpiredSessions, purgeGuests, setUserCredentials, setUserPassword,
} from './db.js';
import {
  AUTH, MIN_PASSWORD, attachUser, cleanUsername, clearFailures, endSession, hashPassword, lockoutMs, mintIdentity,
  noteFailure, requireIdentity, requireUser, sameOriginOnly, startSession, verifyPassword, withinLimit,
} from './auth.js';
import { numOrNull } from './util.js';
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

// Every request gets an identity: a signed-in account or a guest (an anonymous
// visitor with a real collection, so cards can be added before signing up).
app.use('/api', sameOriginOnly);
app.use(attachUser);
// /api/auth/* is the way in, so it stays open; everything else under /api answers
// for whoever the cookie points at, minting a guest when there is no cookie yet.
app.use('/api', (req, res, next) => (req.path.startsWith('/auth') ? next() : requireIdentity(req, res, next)));

/** Accept a base64 string or a `data:...;base64,...` URL. */
function toBuffer(image) {
  if (typeof image !== 'string') throw new Error('image must be a base64 string or data URL');
  const b64 = image.includes(',') ? image.split(',')[1] : image;
  return Buffer.from(b64, 'base64');
}

function session(userId) {
  // `node:sqlite` is synchronous; just wrap for clarity/mockability. Every call
  // is scoped to one user id — that scoping is what keeps collections apart.
  return {
    // `copies` (default 1) adds that many of the same printing — duplicates
    // live in `quantity`, one row per printing per user.
    add(entry, copies = 1) { return addEntry(entry, userId, copies); },
    list() { return listEntries(userId); },
    remove(id) { return removeEntry(id, userId); },
    increment(id, n = 1) { return incrementEntry(id, userId, n); },
    decrement(id, n = 1) { return decrementEntry(id, userId, n); },
    setQuantity(id, qty) { return setEntryQuantity(id, qty, userId); },
    // Ownership, for answers that must be 404 rather than "changed nothing".
    owns(id) { return ownsEntry(id, userId); },
  };
}

// ---- Accounts, guests and sessions -----------------------------------------

// Identity is the session cookie (see src/auth.js). These routes are the way in
// and the way out; every other route under /api simply answers for req.userId,
// which the middleware above resolved to an account, a guest, or a fresh guest.

/** Create an account — or upgrade the guest that is already browsing. */
app.post('/api/auth/register', (req, res) => {
  try {
    if (!AUTH.allowSignup) return res.status(403).json({ error: 'sign-ups are closed right now' });
    if (!withinLimit(`register:${req.ip || ''}`, AUTH.signupsPerHour, 3600e3)) {
      return res.status(429).json({ error: 'too many sign-ups from this address — try again later' });
    }
    const username = cleanUsername(req.body?.username);
    const password = String(req.body?.password ?? '');
    if (!username) return res.status(400).json({ error: 'pick a name of 3-32 letters, digits, ".", "-" or "_"' });
    if (password.length < MIN_PASSWORD) {
      return res.status(400).json({ error: `use a password of at least ${MIN_PASSWORD} characters` });
    }
    if (findUserByUsername(username)) return res.status(409).json({ error: 'that name is taken' });

    const credentials = { username, ...hashPassword(password) };
    // Who is asking, and what should this account own? A guest is upgraded in
    // place, so the cards it already collected stay theirs; anyone else gets a
    // brand-new account with an empty collection.
    const visitor = req.user ?? null;
    const isGuest = Number(visitor?.is_guest) === 1;
    const user = visitor && isGuest
      ? setUserCredentials(visitor.id, credentials)
      : createUser({ name: username, ...credentials });
    // Privilege just changed: retire the row's old sessions and hand this
    // browser a fresh one.
    deleteUserSessions(user.id);
    startSession(res, user.id, AUTH.accountTtlDays);
    res.json({ user: publicUser(user), collection: collectionSize(user.id) });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/** Sign in. Anything collected as a guest comes along with it. */
app.post('/api/auth/login', (req, res) => {
  try {
    const username = cleanUsername(req.body?.username) ?? String(req.body?.username ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    const key = `login:${req.ip || ''}:${username}`;
    const wait = lockoutMs(key);
    if (wait) return res.status(429).json({ error: `too many attempts — try again in ${Math.ceil(wait / 1000)}s` });

    const user = username ? findUserByUsername(username) : null;
    if (!user || !verifyPassword(password, user)) {
      noteFailure(key);
      return res.status(401).json({ error: 'invalid username or password' });
    }
    clearFailures(key);

    // Collected cards as a guest first? Fold them into the account (copies are
    // summed, the earlier added_at wins) and drop the guest identity; `merged`
    // is what lets the UI say how many cards came across. Other devices stay
    // signed in: sessions are per device, and only a password change retires
    // them all (see /api/auth/password below).
    const merged = Number(req.user?.is_guest) === 1 ? mergeGuestInto(user.id, req.user.id) : null;
    startSession(res, user.id, AUTH.accountTtlDays);
    res.json({ user: publicUser(user), merged, collection: collectionSize(user.id) });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/** Who am I? Pages ask this on load to show the account (or guest) badge. */
app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'not signed in', user: null });
  res.json({ user: publicUser(req.user), collection: collectionSize(req.user.id) });
});

/**
 * Start a guest collection before adding anything. Idempotent — a caller who
 * already has an identity gets the same one back — so the pages can call it on
 * load and know their collection is somewhere.
 */
app.post('/api/auth/guest', (req, res) => {
  try {
    if (req.user) return res.json({ user: publicUser(req.user), collection: collectionSize(req.user.id) });
    const minted = mintIdentity(req, res);
    if (!minted.user) return res.status(minted.status).json({ error: minted.error });
    res.json({ user: publicUser(minted.user), collection: collectionSize(minted.user.id) });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post('/api/auth/logout', (req, res) => {
  try {
    endSession(res, req.sessionTokenHash);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/** Change the password; every other session of that account is retired. */
app.post('/api/auth/password', requireUser, (req, res) => {
  try {
    const current = String(req.body?.current ?? '');
    const next = String(req.body?.next ?? '');
    if (!verifyPassword(current, req.user)) return res.status(403).json({ error: 'the current password is wrong' });
    if (next.length < MIN_PASSWORD) {
      return res.status(400).json({ error: `use a password of at least ${MIN_PASSWORD} characters` });
    }
    setUserPassword(req.user.id, hashPassword(next));
    deleteUserSessions(req.user.id);
    startSession(res, req.user.id, AUTH.accountTtlDays);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

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
function autoAdd(candidates, userId, { foil = false, condition = undefined } = {}) {
  const candidate = candidates?.[0] ?? null;
  if (!candidate) {
    return { added: false, candidate: null, reason: 'no-match', threshold: AUTO_ADD_MIN_LIKELIHOOD };
  }
  const likelihood = candidate.likelihood ?? 0;
  if (likelihood < AUTO_ADD_MIN_LIKELIHOOD) {
    return { added: false, candidate, likelihood, reason: 'low-likelihood', threshold: AUTO_ADD_MIN_LIKELIHOOD };
  }
  try {
    const { entry, newCopy, addedCopies } = session(userId).add(entryFromBody({ ...candidate, foil, condition }));
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
      : autoAdd(shortlist, req.userId, { foil, condition });

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
// One row per printing per finish per user; duplicate copies of the same
// finish live in `quantity`:
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
    res.json(session(req.userId).list());
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post('/api/collection', (req, res) => {
  try {
    res.json(session(req.userId).add(entryFromBody(req.body), req.body?.copies ?? 1));
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

app.patch('/api/collection/:id', (req, res) => {
  try {
    // PATCH adds copies to an existing row: no lookup needed beforehand —
    // incrementEntry updates by id and returns null when the row is gone.
    const n = Math.max(1, Math.floor(Number(req.body?.copies ?? 1) || 1));
    const entry = session(req.userId).increment(req.params.id, n);
    if (!entry) return res.status(404).json({ error: 'not found' });
    res.json({ entry, addedCopies: n });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

app.put('/api/collection/:id', (req, res) => {
  try {
    const s = session(req.userId);
    // Someone else's id answers exactly like one that does not exist.
    if (!s.owns(req.params.id)) return res.status(404).json({ error: 'not found' });
    const entry = s.setQuantity(req.params.id, req.body?.quantity);
    res.json({ entry, removed: !entry });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

app.post('/api/collection/:id/decrement', (req, res) => {
  try {
    const s = session(req.userId);
    // `entry: null` means "you just removed your last copy", so ownership is
    // checked separately to tell that apart from someone else's id (404).
    if (!s.owns(req.params.id)) return res.status(404).json({ error: 'not found' });
    const entry = s.decrement(req.params.id, req.body?.n ?? 1);
    res.json({ entry, removed: !entry });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

app.post('/api/collection/:id/foil', (req, res) => {
  try {
    const s = session(req.userId);
    // Someone else's id answers exactly like one that does not exist.
    if (!s.owns(req.params.id)) return res.status(404).json({ error: 'not found' });
    // Flipping may merge this row into one already owned in the target finish,
    // so the answer is the *surviving* row (its id can differ from the id posted).
    const entry = setEntryFoil(req.params.id, req.body?.foil === true || req.body?.foil === 1, req.userId);
    res.json({ entry });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

app.post('/api/collection/:id/condition', (req, res) => {
  try {
    const s = session(req.userId);
    if (!s.owns(req.params.id)) return res.status(404).json({ error: 'not found' });
    // Re-grading may merge this row into one already owned at that grade, so the
    // answer is the *surviving* row (its id can differ from the id posted).
    const entry = setEntryCondition(req.params.id, req.body?.condition, req.userId);
    res.json({ entry });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

app.delete('/api/collection/:id', (req, res) => {
  try {
    // Deleting something that is not there (or not yours) is a 404, not a
    // cheerful "removed" — the UI reloads from the server either way.
    const { changes } = session(req.userId).remove(req.params.id);
    if (!changes) return res.status(404).json({ error: 'not found' });
    res.json({ changes });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---- Price history (daily snapshots; see src/prices.js) --------------------

app.get('/api/prices/portfolio', (req, res) => {
  try {
    res.json(portfolioHistory(req.userId));
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
    res.json(await setCompletion(req.userId));
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---- Economics: what the collection raises, and where ----------------------
//
// The retail benchmark is already in the database (Scryfall's `usd` is the
// TCGplayer market price), so the comparison needs no credentials and no network
// — it is arithmetic over the rows the collection page already fetched. The
// settings are the assumptions that arithmetic rests on, and the user owns them.

/** The plan under the caller's own assumptions, plus the sentences that explain it. */
function economicsFor(userId) {
  const settings = loadSettings(userId);
  const p = plan(listEntries(userId), settings);
  return { settings, plan: p, insights: insights(p) };
}

app.get('/api/economics', (req, res) => {
  try {
    res.json({ ...economicsFor(req.userId), platforms: PLATFORMS, defaults: DEFAULT_SETTINGS });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/** Save assumptions (partial patch) and answer with the plan they produce. */
app.put('/api/economics/settings', (req, res) => {
  try {
    // Validation happens before anything is written: a bad number must not
    // become a stored NaN that makes every card look worthless.
    const settings = saveSettings(req.userId, req.body ?? {});
    const p = plan(listEntries(req.userId), settings);
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
    const { plan: p } = economicsFor(req.userId);
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

app.listen(PORT, () => {
  console.log(`MTG Collection Manager running at http://localhost:${PORT}`);
  console.log(`auth: guests ${AUTH.allowGuests ? 'on' : 'off'} · sign-ups ${AUTH.allowSignup ? 'open' : 'closed'}`);
  // Keep the daily price history going while the server is up (idempotent/day).
  startDailySnapshots();
  // Expired sessions and abandoned guest collections are housekeeping, not a
  // request-time concern: clear them at boot, then every few hours.
  const housekeeping = () => {
    try {
      const sessions = purgeExpiredSessions();
      const guests = purgeGuests();
      if (sessions || guests) {
        console.log(`housekeeping: ${sessions} expired sessions, ${guests} guest collections removed`);
      }
    } catch (e) {
      console.error('housekeeping failed:', String(e?.message || e));
    }
  };
  housekeeping();
  setInterval(housekeeping, 6 * 60 * 60 * 1000).unref?.();
});