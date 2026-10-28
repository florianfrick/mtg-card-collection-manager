import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONDITION_CODES, DEFAULT_CONDITION, normalizeCondition } from './condition.js';

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.MTG_DB || join(here, '..', 'data', 'mtg.db');

mkdirSync(dirname(dbPath), { recursive: true });

// Foreign keys on, so collection -> card/user and price_snapshot -> card are real
// references (node:sqlite enables them by default; be explicit about it).
const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });

// ---------------------------------------------------------------------------
// Schema — one collection per instance:
//   card            one row per printed card (identity + latest market price)
//   collection      which printing is owned, when it was added and what it was
//                   worth then. One row per printing, finish and grade; the
//                   duplicate copies of that kind live in `quantity`.
//   price_snapshot  daily market price per card — the history series
//   setting         the economics assumptions (key/value, so a new knob does
//                   not need a migration)
//   meta            bookkeeping flags (migrations, last snapshot day)
//
// There is no user table: this app runs on one machine for one collection, so
// the database *is* the collection. A database from before that change carries
// user_id columns; the last migration below folds them away.
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS card (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  scryfall_id       TEXT NOT NULL UNIQUE,   -- one printing = one scryfall id
  name              TEXT NOT NULL,
  set_name          TEXT,
  set_code          TEXT,
  collector_number  TEXT,
  rarity            TEXT,
  image_url         TEXT,
  tcgplayer_id      INTEGER,                -- Scryfall's TCGplayer product id (what a listing file keys on)
  current_price_usd REAL,                   -- latest known market price (cache)
  price_updated_at  TEXT
);
CREATE TABLE IF NOT EXISTS collection (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id      INTEGER NOT NULL REFERENCES card(id),
  quantity     INTEGER NOT NULL DEFAULT 1,       -- copies owned (duplicates live here, not extra rows)
  added_at     TEXT NOT NULL,
  price_at_add REAL,                        -- what it was worth when added
  foil         INTEGER NOT NULL DEFAULT 0,  -- 1 = foil finish; foil and non-foil copies are separate rows
  condition    TEXT NOT NULL DEFAULT 'NM',  -- NM/LP/MP/HP/DMG (src/condition.js); a grade is its own row
  UNIQUE(card_id, foil, condition)          -- one row per printing, finish and grade
);
CREATE TABLE IF NOT EXISTS price_snapshot (
  card_id        INTEGER NOT NULL REFERENCES card(id),
  day            TEXT NOT NULL,             -- 'YYYY-MM-DD' (UTC), one row per day
  price_usd      REAL,
  price_usd_foil REAL,                      -- the same day's price for the foil finish
  PRIMARY KEY (card_id, day)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_price_snapshot_day ON price_snapshot(day);
`);

// Foil finish support. A database created before it gets the price columns via
// plain ALTERs, but `collection` needs more: its uniqueness widens from
// (user, card) to (user, card, foil), and SQLite cannot change a table's
// constraints — the table is rebuilt instead. Existing rows all become the
// non-foil finish.
{
  const cardCols = new Set(db.prepare('PRAGMA table_info(card)').all().map((c) => c.name));
  if (!cardCols.has('current_price_foil_usd')) db.exec('ALTER TABLE card ADD COLUMN current_price_foil_usd REAL');
  if (!cardCols.has('price_foil_updated_at')) db.exec('ALTER TABLE card ADD COLUMN price_foil_updated_at TEXT');
  // The TCGplayer product id rides along on every Scryfall card object; a
  // listing file for their seller portal keys on it, so it is worth a column.
  if (!cardCols.has('tcgplayer_id')) db.exec('ALTER TABLE card ADD COLUMN tcgplayer_id INTEGER');
  const snapCols = new Set(db.prepare('PRAGMA table_info(price_snapshot)').all().map((c) => c.name));
  if (!snapCols.has('price_usd_foil')) db.exec('ALTER TABLE price_snapshot ADD COLUMN price_usd_foil REAL');
  const cols = new Set(db.prepare('PRAGMA table_info(collection)').all().map((c) => c.name));
  if (!cols.has('foil')) {
    db.exec(`
      CREATE TABLE collection_v2 (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL REFERENCES user(id),
        card_id      INTEGER NOT NULL REFERENCES card(id),
        quantity     INTEGER NOT NULL DEFAULT 1,
        added_at     TEXT NOT NULL,
        price_at_add REAL,
        foil         INTEGER NOT NULL DEFAULT 0,
        UNIQUE(user_id, card_id, foil)
      );
      INSERT INTO collection_v2 (id, user_id, card_id, quantity, added_at, price_at_add, foil)
        SELECT id, user_id, card_id, quantity, added_at, price_at_add, 0 FROM collection;
      DROP TABLE collection;
      ALTER TABLE collection_v2 RENAME TO collection;
    `);
    // The index belonged to the old table and went with it.
    db.exec('CREATE INDEX IF NOT EXISTS idx_collection_user ON collection(user_id);');
  }
}

// Condition support. Like `foil`, a grade is part of a row's identity — an NM
// and an LP copy of the same printing are worth different money and are sold
// separately — so the unique key widens once more and the table is rebuilt,
// because SQLite cannot alter a constraint.
//
// Every existing row becomes 'NM'. That is not a guess: the price stored for it
// is the near-mint market price, so the backfill adds a label without changing a
// single number. The whole rebuild runs in one transaction, so a failure leaves
// the old table untouched rather than half-copied.
{
  const cols = new Set(db.prepare('PRAGMA table_info(collection)').all().map((c) => c.name));
  if (!cols.has('condition')) {
    tx(() => {
      db.exec(`
        CREATE TABLE collection_v3 (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id      INTEGER NOT NULL REFERENCES user(id),
          card_id      INTEGER NOT NULL REFERENCES card(id),
          quantity     INTEGER NOT NULL DEFAULT 1,
          added_at     TEXT NOT NULL,
          price_at_add REAL,
          foil         INTEGER NOT NULL DEFAULT 0,
          condition    TEXT NOT NULL DEFAULT 'NM',
          UNIQUE(user_id, card_id, foil, condition)
        );
        INSERT INTO collection_v3 (id, user_id, card_id, quantity, added_at, price_at_add, foil, condition)
          SELECT id, user_id, card_id, quantity, added_at, price_at_add, foil, 'NM' FROM collection;
        DROP TABLE collection;
        ALTER TABLE collection_v3 RENAME TO collection;
        CREATE INDEX IF NOT EXISTS idx_collection_user ON collection(user_id);
      `);
    });
  }
}

// Accounts are gone: one instance, one collection. A database from before that
// change still carries user_id on `collection` and `setting`, plus the `user`
// and `session` tables. Fold everything into one collection, then drop them.
//
// Rows that collide once user_id is gone — two accounts owning the same
// printing in the same finish and grade — are merged: quantities add up and the
// earlier added_at wins, which is what having both in one collection would have
// meant. price_at_add comes from the earliest of them, so "what it was worth
// when I got it" stays truthful instead of becoming a MIN() of two prices.
{
  const cols = new Set(db.prepare('PRAGMA table_info(collection)').all().map((c) => c.name));
  if (cols.has('user_id')) {
    tx(() => {
      db.exec(`
        CREATE TABLE collection_v4 (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          card_id      INTEGER NOT NULL REFERENCES card(id),
          quantity     INTEGER NOT NULL DEFAULT 1,
          added_at     TEXT NOT NULL,
          price_at_add REAL,
          foil         INTEGER NOT NULL DEFAULT 0,
          condition    TEXT NOT NULL DEFAULT 'NM',
          UNIQUE(card_id, foil, condition)
        );
        INSERT INTO collection_v4 (card_id, quantity, added_at, price_at_add, foil, condition)
          SELECT g.card_id,
                 SUM(g.quantity),
                 MIN(g.added_at),
                 (SELECT c2.price_at_add FROM collection c2
                   WHERE c2.card_id = g.card_id
                     AND c2.foil = g.foil
                     AND c2.condition = g.condition
                   ORDER BY c2.added_at, c2.id LIMIT 1),
                 g.foil,
                 g.condition
            FROM collection g
           GROUP BY g.card_id, g.foil, g.condition;
        DROP TABLE collection;
        ALTER TABLE collection_v4 RENAME TO collection;
      `);
    });
  }
  // The assumptions are per-installation now, so one set of knobs survives: the
  // oldest account's (lowest user_id), which is the one this machine has been
  // using. An empty table simply copies nothing.
  const settingCols = new Set(db.prepare('PRAGMA table_info(setting)').all().map((c) => c.name));
  if (settingCols.has('user_id')) {
    tx(() => {
      db.exec(`
        CREATE TABLE setting_v2 (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO setting_v2 (key, value)
          SELECT key, value FROM setting
           WHERE user_id = (SELECT MIN(user_id) FROM setting);
        DROP TABLE setting;
        ALTER TABLE setting_v2 RENAME TO setting;
      `);
    });
  }
  // Identities last: nothing points at `user` any more, so the implicit DELETE
  // that DROP TABLE runs cannot trip a foreign key.
  db.exec('DROP TABLE IF EXISTS session;');
  db.exec('DROP TABLE IF EXISTS user;');
  db.exec('DROP INDEX IF EXISTS idx_collection_user;');
}

/** UTC day stamp for a date (defaults to now) — the snapshot granularity. */
const isoDay = (d = new Date()) => new Date(d).toISOString().slice(0, 10);

const meta = {
  get: (k) => db.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value ?? null,
  set: (k, v) => db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(k, String(v)),
};

// ---- Cards -----------------------------------------------------------------

// Every descriptive column is COALESCEd: a caller that only knows a printing's
// id and price (a re-add, a bulk import, the price job) must not blank out what
// an earlier, more complete answer stored. `name` is the exception — it is the
// card's identity and every caller has it.
const CARD_UPSERT = db.prepare(`
  INSERT INTO card (scryfall_id, name, set_name, set_code, collector_number, rarity, image_url, tcgplayer_id)
  VALUES (?,?,?,?,?,?,?,?)
  ON CONFLICT(scryfall_id) DO UPDATE SET
    name             = excluded.name,
    set_name         = COALESCE(excluded.set_name, card.set_name),
    set_code         = COALESCE(excluded.set_code, card.set_code),
    collector_number = COALESCE(excluded.collector_number, card.collector_number),
    rarity           = COALESCE(excluded.rarity, card.rarity),
    image_url        = COALESCE(excluded.image_url, card.image_url),
    tcgplayer_id     = COALESCE(excluded.tcgplayer_id, card.tcgplayer_id)
`);

/** Insert a printing or refresh its identity fields; returns the card row. */
function upsertCard(e) {
  const num = e.collector_number == null || e.collector_number === '' ? null : String(e.collector_number);
  CARD_UPSERT.run(
    e.scryfall_id,
    e.name,
    e.set_name ?? null,
    e.set_code ?? null,
    num,
    e.rarity ?? null,
    e.image_url ?? null,
    Number.isFinite(Number(e.tcgplayer_id)) ? Number(e.tcgplayer_id) : null
  );
  return db.prepare('SELECT * FROM card WHERE scryfall_id = ?').get(e.scryfall_id);
}

// ---- Prices ----------------------------------------------------------------

/** Upsert one card's price for a day and refresh its cached current price.
 * The two finishes are independent columns: passing null leaves the other
 * column (and a previously recorded value for the same day) untouched. */
function recordPriceAt(cardId, priceUsd, day, priceUsdFoil = null) {
  db.prepare(
    `INSERT INTO price_snapshot (card_id, day, price_usd, price_usd_foil) VALUES (?,?,?,?)
     ON CONFLICT(card_id, day) DO UPDATE SET
       price_usd      = COALESCE(excluded.price_usd, price_snapshot.price_usd),
       price_usd_foil = COALESCE(excluded.price_usd_foil, price_snapshot.price_usd_foil)`
  ).run(cardId, day, priceUsd, priceUsdFoil);
  const now = new Date().toISOString();
  if (priceUsd != null) {
    db.prepare('UPDATE card SET current_price_usd = ?, price_updated_at = ? WHERE id = ?')
      .run(priceUsd, now, cardId);
  }
  if (priceUsdFoil != null) {
    db.prepare('UPDATE card SET current_price_foil_usd = ?, price_foil_updated_at = ? WHERE id = ?')
      .run(priceUsdFoil, now, cardId);
  }
}

/**
 * Record today's prices for many cards at once — the daily snapshot job.
 * `rows` = [{ scryfall_id, price_usd, price_usd_foil, rarity? }]. Returns how
 * many cards were written.
 *
 * `rarity` and `tcgplayer_id` ride along on the same Scryfall response for free,
 * so a card stored by an older build (or by a caller that did not know them) is
 * filled in here rather than costing an extra request. Both are only written
 * when missing, so a later answer never blanks a known value.
 */
export function recordPrices(rows) {
  const day = isoDay();
  const findCard = db.prepare('SELECT id FROM card WHERE scryfall_id = ?');
  const fillRarity = db.prepare('UPDATE card SET rarity = ? WHERE id = ? AND rarity IS NULL');
  const fillTcg = db.prepare('UPDATE card SET tcgplayer_id = ? WHERE id = ? AND tcgplayer_id IS NULL');
  let written = 0;
  for (const r of rows) {
    const card = findCard.get(r.scryfall_id);
    if (!card) continue;
    if (r.rarity) fillRarity.run(r.rarity, card.id);
    // Same response again: the TCGplayer id a listing file needs, for free.
    if (Number.isFinite(Number(r.tcgplayer_id))) fillTcg.run(Number(r.tcgplayer_id), card.id);
    if (r.price_usd == null && r.price_usd_foil == null) continue; // nothing to record
    recordPriceAt(card.id, r.price_usd ?? null, day, r.price_usd_foil ?? null);
    written++;
  }
  return written;
}

/** Distinct Scryfall ids across every user's collection — what to snapshot. */
export function cardsToSnapshot() {
  return db
    .prepare('SELECT DISTINCT card.scryfall_id AS id FROM collection JOIN card ON card.id = collection.card_id')
    .all()
    .map((r) => r.id);
}

/** The most recent day any snapshot was recorded, or null. */
export function lastSnapshotDay() {
  return db.prepare('SELECT MAX(day) AS day FROM price_snapshot').get()?.day ?? null;
}

/** The price series for one card, oldest first. Both finishes: the caller
 * picks the column that matches the collection row it is rendering. */
export function priceHistory(scryfallId) {
  return db
    .prepare(
      `SELECT ps.day AS day, ps.price_usd AS price_usd, ps.price_usd_foil AS price_usd_foil
         FROM price_snapshot ps JOIN card ON card.id = ps.card_id
        WHERE card.scryfall_id = ?
        ORDER BY ps.day`
    )
    .all(scryfallId);
}

/**
 * The collection's total market value per day. A card held in multiple copies
 * counts once per copy, so the daily sum is quantity-weighted. Each row is
 * valued at its own finish's price (foil rows fall back to the non-foil
 * series for days before foil tracking existed).
 */
export function portfolioHistory() {
  return db
    .prepare(
      `SELECT ps.day AS day,
              SUM(CASE WHEN collection.foil = 1
                       THEN COALESCE(ps.price_usd_foil, ps.price_usd)
                       ELSE ps.price_usd END * collection.quantity) AS total_usd,
              SUM(collection.quantity) AS cards
         FROM price_snapshot ps
         JOIN collection ON collection.card_id = ps.card_id
        GROUP BY ps.day
        ORDER BY ps.day`
    )
    .all();
}

// ---- Collection ------------------------------------------------------------

// The shape callers already expect, flattened from collection + card.
// `price_usd` = current market price for this row's finish when known, else
// the price at add time.
const ENTRY_SELECT = `
  SELECT
    collection.id             AS id,
    card.scryfall_id          AS scryfall_id,
    card.name                 AS name,
    card.set_name             AS set_name,
    card.set_code             AS set_code,
    card.rarity               AS rarity,
    card.collector_number     AS collector_number,
    card.image_url            AS image_url,
    card.tcgplayer_id         AS tcgplayer_id,
    CASE WHEN collection.foil = 1
         THEN COALESCE(card.current_price_foil_usd, collection.price_at_add)
         ELSE COALESCE(card.current_price_usd, collection.price_at_add) END AS price_usd,
    collection.price_at_add   AS price_at_add,
    card.current_price_usd    AS current_price_usd,
    card.current_price_foil_usd AS current_price_foil_usd,
    collection.quantity       AS quantity,
    collection.foil           AS foil,
    collection.condition      AS condition,
    collection.added_at       AS added_at
  FROM collection
  JOIN card ON card.id = collection.card_id
`;

/** Add copies of a printing to the collection (upsert on printing + finish + grade).
 *
 * One row per printing per finish per grade; duplicates of the same kind live
 * in `quantity`, not extra rows. `copies` (default 1) is how many to add: a
 * fresh row starts there, an existing row increments by that many.
 * `e.foil` (truthy) stores the copy as foil — worth its own price, so it is a
 * separate row rather than a flag on the non-foil one. `e.condition` is the
 * grade (src/condition.js): an LP copy is not the same asset as an NM one, so it
 * gets its own row too. An unknown grade throws rather than quietly becoming NM.
 */
export function addEntry(e, copies = 1) {
  if (!e.scryfall_id) throw new Error('scryfall_id is required');
  const n = Math.max(1, Math.floor(Number(copies) || 1));
  const foil = e.foil ? 1 : 0;
  const condition = e.condition == null ? DEFAULT_CONDITION : normalizeCondition(e.condition);
  if (!condition) throw new Error(`condition must be one of ${CONDITION_CODES.join(', ')}`);
  const card = upsertCard(e);
  // `changes`/`lastInsertRowid` cannot tell insert from upsert-update apart
  // (node:sqlite reports 1 row either way, and last_insert_rowid is left on
  // whatever inserted last), so look first.
  const existed = !!db
    .prepare('SELECT 1 AS ok FROM collection WHERE card_id = ? AND foil = ? AND condition = ?')
    .get(card.id, foil, condition);
  const res = db
    .prepare(
      `INSERT INTO collection (card_id, quantity, added_at, price_at_add, foil, condition)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(card_id, foil, condition) DO UPDATE SET quantity = quantity + excluded.quantity`
    )
    .run(card.id, n, new Date().toISOString(), e.price_usd ?? null, foil, condition);
  const entry = getEntry(e.scryfall_id, foil, condition);
  // Seed today's point so a fresh card has a series without waiting for the
  // job. The price belongs to whichever finish was added.
  if (e.price_usd != null) {
    if (foil) recordPriceAt(card.id, null, isoDay(), e.price_usd);
    else recordPriceAt(card.id, e.price_usd, isoDay());
  }
  return {
    changes: res.changes,
    // True when this call created the row (first copy ever), false when it
    // just added copies to a printing already owned.
    newCopy: !existed,
    addedCopies: n,
    // The row as stored, so callers can name what they just added (and undo it).
    entry,
  };
}

/**
 * Move a row onto a different finish and/or grade. When a row of the target
 * kind is already owned, the two merge (quantities add, the earlier `added_at`
 * wins) instead of violating the one-row-per-kind rule. Returns the surviving
 * row, or null when the id does not exist.
 *
 * Both `foil` and `condition` are part of a row's identity, so "flip the finish"
 * and "re-grade the card" are the same operation with a different target — and
 * both have to handle the merge, which is why this lives in one place.
 */
function moveEntryTo(id, { foil, condition }) {
  const row = db
    .prepare('SELECT id, card_id, quantity, added_at, foil, condition FROM collection WHERE id = ?')
    .get(Number(id));
  if (!row) return null;
  const target = { foil: foil ?? row.foil, condition: condition ?? row.condition };
  if (target.foil === row.foil && target.condition === row.condition) return fetchEntry(row.id);
  const other = db
    .prepare('SELECT id, quantity, added_at FROM collection WHERE card_id = ? AND foil = ? AND condition = ?')
    .get(row.card_id, target.foil, target.condition);
  return tx(() => {
    if (other) {
      db.prepare(
        `UPDATE collection SET quantity = quantity + ?, added_at = MIN(added_at, ?) WHERE id = ?`
      ).run(row.quantity, row.added_at, other.id);
      db.prepare('DELETE FROM collection WHERE id = ?').run(row.id);
      return fetchEntry(other.id);
    }
    db.prepare('UPDATE collection SET foil = ?, condition = ? WHERE id = ?')
      .run(target.foil, target.condition, row.id);
    return fetchEntry(row.id);
  });
}

/** Flip a row between foil and non-foil (merging into a row of that finish). */
export function setEntryFoil(id, foil) {
  return moveEntryTo(id, { foil: foil ? 1 : 0 });
}

/**
 * Re-grade a row (NM -> LP etc.), merging into a row of that grade.
 * The market price does not move: the grade is a multiplier applied by the
 * economics layer, so this changes what the copy is *worth*, not what it is.
 */
export function setEntryCondition(id, condition) {
  const code = normalizeCondition(condition);
  if (!code) throw new Error(`condition must be one of ${CONDITION_CODES.join(', ')}`);
  return moveEntryTo(id, { condition: code });
}

/** The stored collection row (flattened) for a printing id + finish + grade, or null. */
function getEntry(scryfallId, foil = 0, condition = DEFAULT_CONDITION) {
  return (
    db
      .prepare(ENTRY_SELECT + ' WHERE card.scryfall_id = ? AND collection.foil = ? AND collection.condition = ?')
      .get(scryfallId, foil, condition) ?? null
  );
}

/** Read a row back by id, so a mutating helper answers with what it stored. */
function fetchEntry(id) {
  return (
    db.prepare(ENTRY_SELECT + ' WHERE collection.id = ?').get(Number(id)) ?? null
  );
}

/** Does this collection row exist? */
export function entryExists(id) {
  return !!db.prepare('SELECT 1 AS ok FROM collection WHERE id = ?').get(Number(id));
}

export function listEntries() {
  return db.prepare(ENTRY_SELECT + ' ORDER BY collection.id DESC').all();
}

/**
 * Per-set totals for one collection: how many *distinct printings* of a set are
 * owned, how many copies that is, and what they are worth.
 *
 * The numerator of set completion lives here because the data already does:
 * `card.set_code` + `card.collector_number` are what the exact-printing lookup
 * matches on. Foil and non-foil copies of the same printing count once (they are
 * two rows of the same card).
 */
export function setOwnership() {
  return db
    .prepare(
      `SELECT LOWER(card.set_code) AS code,
              COUNT(DISTINCT card.collector_number) AS owned,
              COALESCE(SUM(collection.quantity), 0) AS copies,
              COALESCE(SUM(
                CASE WHEN collection.foil = 1
                     THEN COALESCE(card.current_price_foil_usd, card.current_price_usd, 0)
                     ELSE COALESCE(card.current_price_usd, 0) END * collection.quantity
              ), 0) AS value
         FROM collection
         JOIN card ON card.id = collection.card_id
        WHERE card.set_code IS NOT NULL AND card.set_code <> ''
        GROUP BY LOWER(card.set_code)`
    )
    .all();
}

export function removeEntry(id) {
  return db.prepare('DELETE FROM collection WHERE id = ?').run(Number(id));
}

/**
 * Add `n` copies to an existing collection row (by id). Returns the updated
 * row, or null when no such row exists.
 */
export function incrementEntry(id, n = 1) {
  const inc = Math.max(1, Math.floor(Number(n) || 1));
  const row = db.prepare('SELECT id FROM collection WHERE id = ?').get(Number(id));
  if (!row) return null;
  db.prepare('UPDATE collection SET quantity = quantity + ? WHERE id = ?').run(inc, Number(id));
  return fetchEntry(id);
}

/**
 * Decrease a collection row's quantity by `n` (default 1). The row is
 * deleted when the quantity would drop to zero or below. Returns the
 * updated row, or null when the row was removed entirely.
 */
export function decrementEntry(id, n = 1) {
  const dec = Math.max(1, Math.floor(Number(n) || 1));
  const row = db.prepare('SELECT id, quantity, card_id FROM collection WHERE id = ?').get(Number(id));
  if (!row) return null;
  if (row.quantity - dec <= 0) {
    db.prepare('DELETE FROM collection WHERE id = ?').run(Number(id));
    return null;
  }
  db.prepare('UPDATE collection SET quantity = quantity - ? WHERE id = ?').run(dec, Number(id));
  return fetchEntry(id);
}

/**
 * Set a collection row's exact quantity. `0` (or less) deletes the row.
 * Returns the updated row, or null when the row was removed.
 *
 * A missing or unparseable quantity throws instead of deleting: `Number(
 * undefined)` is NaN, and treating NaN as "zero copies" is how a PUT with an
 * empty body used to wipe a row. The route turns the throw into a 400.
 */
export function setEntryQuantity(id, qty) {
  // `null`/`undefined`/`''` are all "the client sent nothing", and Number() turns
  // them into 0 (or NaN) — which must never be read as "zero copies".
  const blank = qty === null || qty === undefined || (typeof qty === 'string' && qty.trim() === '');
  const n = blank ? NaN : Number(qty);
  if (!Number.isFinite(n)) throw new Error('quantity must be a number');
  const q = Math.floor(n);
  if (q <= 0) {
    db.prepare('DELETE FROM collection WHERE id = ?').run(Number(id));
    return null;
  }
  db.prepare('UPDATE collection SET quantity = ? WHERE id = ?').run(q, Number(id));
  return fetchEntry(id);
}

// ---- Settings --------------------------------------------------------------

/** A stored JSON setting, or `fallback` when it was never written. */
export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM setting WHERE key = ?').get(String(key));
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback; // a corrupt blob is a missing one, never a crash
  }
}

export function setSetting(key, value) {
  db.prepare(
    `INSERT INTO setting (key, value) VALUES (?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(key), JSON.stringify(value));
  return value;
}

/** Drop every stored setting — the assumptions go back to their defaults. */
export function clearSettings() {
  return db.prepare('DELETE FROM setting').run().changes;
}

// ---- Housekeeping ----------------------------------------------------------

function tx(fn) {
  // node:sqlite has no transaction helper of its own; keep the BEGIN/COMMIT
  // pair (and the rollback) in one place.
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Close the database handle (tests and graceful shutdown). */
export function closeDatabase() {
  db.close();
}

/**
 * Write a consistent copy of the database to `path` (VACUUM INTO: one statement,
 * no file locking games, and the copy is defragmented). Refuses to overwrite.
 */
export function backupTo(path) {
  db.exec(`VACUUM INTO '${String(path).replace(/'/g, "''")}'`);
}

/** What the collection holds: rows, and copies (the sum of `quantity`). */
export function collectionSize() {
  const row = db
    .prepare('SELECT COUNT(*) AS rows, COALESCE(SUM(quantity), 0) AS copies FROM collection')
    .get();
  return { rows: row.rows, copies: row.copies };
}


// Cards nobody owns any more. Removing a collection row deliberately leaves the
// card behind so its price history survives an accidental delete, but a card
// that no user owns will never be shown again — it only makes `card` (and the
// lookups over it) grow. Sweeping is opt-in for that reason.
export function orphanCards() {
  return db
    .prepare(
      `SELECT c.id, c.scryfall_id, c.name, c.set_code, c.collector_number
         FROM card c
        WHERE NOT EXISTS (SELECT 1 FROM collection col WHERE col.card_id = c.id)
        ORDER BY c.name`
    )
    .all();
}

export function deleteOrphanCards() {
  const doomed = orphanCards();
  if (!doomed.length) return { removed: 0, snapshots: 0 };
  const ids = doomed.map((c) => c.id);
  const marks = ids.map(() => '?').join(',');
  let snapshots = 0;
  tx(() => {
    snapshots = db.prepare(`DELETE FROM price_snapshot WHERE card_id IN (${marks})`).run(...ids).changes;
    db.prepare(`DELETE FROM card WHERE id IN (${marks})`).run(...ids);
  });
  return { removed: doomed.length, snapshots };
}

// ---- One-time fold of the pre-normalization table --------------------------

// The old single table (collection_entry) is split into card + collection so an
// existing collection survives. Guarded by a meta flag, so a card the user later
// removes is never silently re-added by a second pass. Once the rows are folded
// in, the old table is dropped: keeping it around only invites reading stale
// data (and it is never written to again).
function migrateLegacy() {
  const legacy = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'collection_entry'")
    .get();
  if (!meta.get('legacy_split_done')) {
    if (legacy) {
      const addToCollection = db.prepare(
        `INSERT OR IGNORE INTO collection (card_id, quantity, added_at, price_at_add)
         VALUES (?,?,?,?)`
      );
      for (const r of db.prepare('SELECT * FROM collection_entry ORDER BY id').all()) {
        const card = upsertCard({ ...r, rarity: null });
        addToCollection.run(card.id, 1, r.added_at, r.price_usd);
        // Seed day-one history from the price captured when the card was added.
        if (r.price_usd != null) recordPriceAt(card.id, r.price_usd, isoDay(r.added_at));
      }
    }
    meta.set('legacy_split_done', 1);
  }
  // Safe now: the flag is set, so the rows (if any) are in `collection`.
  if (legacy) db.exec('DROP TABLE collection_entry');
}

migrateLegacy();