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
// Schema — four concerns, six tables:
//   card            one row per printed card (identity + latest market price)
//   user            a collection owner. An account has credentials; a *guest*
//                   is the same row with `is_guest = 1` and nothing set, so an
//                   anonymous visitor can own a real collection before signing
//                   up (and sign-up is then a single UPDATE of that row).
//   session         one cookie's worth of trust: opaque token hash -> user
//   collection      who owns which card, when they added it and what it was
//                   worth then (per-user, so two users share one `card` row)
//   price_snapshot  daily market price per card — the history series (global)
//   meta            bookkeeping flags (migrations, last snapshot day)
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
CREATE TABLE IF NOT EXISTS user (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  -- Auth columns. A database created before accounts existed gets these through
  -- the ALTERs below instead, so both paths end in the same shape.
  is_guest       INTEGER NOT NULL DEFAULT 0,  -- 1 = anonymous visitor's collection
  username       TEXT,                        -- NULL until someone signs up
  password_hash  TEXT,
  password_salt  TEXT,
  password_iters INTEGER
);
CREATE TABLE IF NOT EXISTS collection (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES user(id),
  card_id      INTEGER NOT NULL REFERENCES card(id),
  quantity     INTEGER NOT NULL DEFAULT 1,       -- copies owned (duplicates live here, not extra rows)
  added_at     TEXT NOT NULL,
  price_at_add REAL,                        -- what it was worth when added
  foil         INTEGER NOT NULL DEFAULT 0,  -- 1 = foil finish; foil and non-foil copies are separate rows
  condition    TEXT NOT NULL DEFAULT 'NM',  -- NM/LP/MP/HP/DMG (src/condition.js); a grade is its own row
  UNIQUE(user_id, card_id, foil, condition) -- one row per printing, finish and grade per user
);
CREATE TABLE IF NOT EXISTS price_snapshot (
  card_id        INTEGER NOT NULL REFERENCES card(id),
  day            TEXT NOT NULL,             -- 'YYYY-MM-DD' (UTC), one row per day
  price_usd      REAL,
  price_usd_foil REAL,                      -- the same day's price for the foil finish
  PRIMARY KEY (card_id, day)
);
CREATE TABLE IF NOT EXISTS session (
  token_hash   TEXT PRIMARY KEY,            -- sha256(cookie value); the token itself is never stored
  user_id      INTEGER NOT NULL REFERENCES user(id),
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
-- Per-user knobs (the economics assumptions today). A key/value table rather
-- than columns: adding a knob should not need a migration.
CREATE TABLE IF NOT EXISTS setting (
  user_id INTEGER NOT NULL REFERENCES user(id),
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS idx_collection_user ON collection(user_id);
CREATE INDEX IF NOT EXISTS idx_price_snapshot_day ON price_snapshot(day);
CREATE INDEX IF NOT EXISTS idx_session_user ON session(user_id);
`);

// One-time (and idempotent) upgrade of a pre-auth database. SQLite cannot
// `ADD COLUMN ... UNIQUE`, so `username` is added plainly and uniqueness comes
// from the NOCASE index. Existing rows get is_guest = 0: whatever user was
// there before accounts existed is the *owner*, never a guest.
{
  const columns = new Set(db.prepare('PRAGMA table_info(user)').all().map((c) => c.name));
  const missing = [
    ['is_guest', 'INTEGER NOT NULL DEFAULT 0'],
    ['username', 'TEXT'],
    ['password_hash', 'TEXT'],
    ['password_salt', 'TEXT'],
    ['password_iters', 'INTEGER'],
  ];
  for (const [name, type] of missing) {
    if (!columns.has(name)) db.exec(`ALTER TABLE user ADD COLUMN ${name} ${type}`);
  }
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_user_username ON user(username COLLATE NOCASE);');

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

/** UTC day stamp for a date (defaults to now) — the snapshot granularity. */
const isoDay = (d = new Date()) => new Date(d).toISOString().slice(0, 10);

/**
 * Which collection a caller that names no user writes to: the oldest account.
 * An empty user table answers null instead of inventing an owner — user rows
 * come from sign-up, never from importing this module.
 */
export const DEFAULT_USER_ID =
  db.prepare('SELECT id FROM user WHERE is_guest = 0 ORDER BY id LIMIT 1').get()?.id ?? null;

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
export function portfolioHistory(userId = DEFAULT_USER_ID) {
  return db
    .prepare(
      `SELECT ps.day AS day,
              SUM(CASE WHEN collection.foil = 1
                       THEN COALESCE(ps.price_usd_foil, ps.price_usd)
                       ELSE ps.price_usd END * collection.quantity) AS total_usd,
              SUM(collection.quantity) AS cards
         FROM price_snapshot ps
         JOIN collection ON collection.card_id = ps.card_id AND collection.user_id = ?
        GROUP BY ps.day
        ORDER BY ps.day`
    )
    .all(userId);
}

// ---- Collection (per user) -------------------------------------------------

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
    collection.user_id        AS user_id,
    collection.added_at       AS added_at
  FROM collection
  JOIN card ON card.id = collection.card_id
`;

/** Add copies of a printing to a user's collection (upsert on user + printing + finish + grade).
 *
 * One row per printing per finish per grade per user; duplicates of the same
 * kind live in `quantity`, not extra rows. `copies` (default 1) is how many to
 * add: a fresh row starts there, an existing row increments by that many.
 * `e.foil` (truthy) stores the copy as foil — worth its own price, so it is a
 * separate row rather than a flag on the non-foil one. `e.condition` is the
 * grade (src/condition.js): an LP copy is not the same asset as an NM one, so it
 * gets its own row too. An unknown grade throws rather than quietly becoming NM.
 */
export function addEntry(e, userId = DEFAULT_USER_ID, copies = 1) {
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
    .prepare('SELECT 1 AS ok FROM collection WHERE user_id = ? AND card_id = ? AND foil = ? AND condition = ?')
    .get(userId, card.id, foil, condition);
  const res = db
    .prepare(
      `INSERT INTO collection (user_id, card_id, quantity, added_at, price_at_add, foil, condition)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(user_id, card_id, foil, condition) DO UPDATE SET quantity = quantity + excluded.quantity`
    )
    .run(userId, card.id, n, new Date().toISOString(), e.price_usd ?? null, foil, condition);
  const entry = getEntry(e.scryfall_id, userId, foil, condition);
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
 * Move a row onto a different finish and/or grade. When the user already owns a
 * row of the target kind, the two merge (quantities add, the earlier `added_at`
 * wins) instead of violating the one-row-per-kind rule. Returns the surviving
 * row, or null when the id is not this user's.
 *
 * Both `foil` and `condition` are part of a row's identity, so "flip the finish"
 * and "re-grade the card" are the same operation with a different target — and
 * both have to handle the merge, which is why this lives in one place.
 */
function moveEntryTo(id, { foil, condition }, userId) {
  const row = db
    .prepare('SELECT id, card_id, quantity, added_at, foil, condition FROM collection WHERE id = ? AND user_id = ?')
    .get(Number(id), userId);
  if (!row) return null;
  const target = { foil: foil ?? row.foil, condition: condition ?? row.condition };
  if (target.foil === row.foil && target.condition === row.condition) return fetchEntry(row.id, userId);
  const other = db
    .prepare('SELECT id, quantity, added_at FROM collection WHERE user_id = ? AND card_id = ? AND foil = ? AND condition = ?')
    .get(userId, row.card_id, target.foil, target.condition);
  return tx(() => {
    if (other) {
      db.prepare(
        `UPDATE collection SET quantity = quantity + ?, added_at = MIN(added_at, ?) WHERE id = ?`
      ).run(row.quantity, row.added_at, other.id);
      db.prepare('DELETE FROM collection WHERE id = ?').run(row.id);
      return fetchEntry(other.id, userId);
    }
    db.prepare('UPDATE collection SET foil = ?, condition = ? WHERE id = ? AND user_id = ?')
      .run(target.foil, target.condition, row.id, userId);
    return fetchEntry(row.id, userId);
  });
}

/** Flip a row between foil and non-foil (merging into an owned row of that finish). */
export function setEntryFoil(id, foil, userId = DEFAULT_USER_ID) {
  return moveEntryTo(id, { foil: foil ? 1 : 0 }, userId);
}

/**
 * Re-grade a row (NM -> LP etc.), merging into an owned row of that grade.
 * The market price does not move: the grade is a multiplier applied by the
 * economics layer, so this changes what the copy is *worth*, not what it is.
 */
export function setEntryCondition(id, condition, userId = DEFAULT_USER_ID) {
  const code = normalizeCondition(condition);
  if (!code) throw new Error(`condition must be one of ${CONDITION_CODES.join(', ')}`);
  return moveEntryTo(id, { condition: code }, userId);
}

/** The stored collection row (flattened) for a printing id + finish + grade, or null. */
function getEntry(scryfallId, userId = DEFAULT_USER_ID, foil = 0, condition = DEFAULT_CONDITION) {
  return (
    db
      .prepare(ENTRY_SELECT + ' WHERE collection.user_id = ? AND card.scryfall_id = ? AND collection.foil = ? AND collection.condition = ?')
      .get(userId, scryfallId, foil, condition) ?? null
  );
}

/**
 * Read a row back by id, scoped to its owner. Every mutating helper below reads
 * back through here: reading by id alone would hand one user another user's row
 * (the write is scoped, but the select would still match the id).
 */
function fetchEntry(id, userId) {
  return (
    db
      .prepare(ENTRY_SELECT + ' WHERE collection.id = ? AND collection.user_id = ?')
      .get(Number(id), userId) ?? null
  );
}

/**
 * Does this row belong to the user? The routes use it to answer 404 for someone
 * else's id — the same answer as for an id that does not exist at all, so
 * nothing is revealed about rows other people own.
 */
export function ownsEntry(id, userId = DEFAULT_USER_ID) {
  return !!db
    .prepare('SELECT 1 AS ok FROM collection WHERE id = ? AND user_id = ?')
    .get(Number(id), userId);
}

export function listEntries(userId = DEFAULT_USER_ID) {
  return db
    .prepare(ENTRY_SELECT + ' WHERE collection.user_id = ? ORDER BY collection.id DESC')
    .all(userId);
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
export function setOwnership(userId = DEFAULT_USER_ID) {
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
        WHERE collection.user_id = ? AND card.set_code IS NOT NULL AND card.set_code <> ''
        GROUP BY LOWER(card.set_code)`
    )
    .all(userId);
}

export function removeEntry(id, userId = DEFAULT_USER_ID) {
  return db.prepare('DELETE FROM collection WHERE id = ? AND user_id = ?').run(Number(id), userId);
}

/**
 * Add `n` copies to an existing collection row (by id). Returns the updated
 * row, or null when no such row exists.
 */
export function incrementEntry(id, userId = DEFAULT_USER_ID, n = 1) {
  const inc = Math.max(1, Math.floor(Number(n) || 1));
  const row = db
    .prepare('SELECT id FROM collection WHERE id = ? AND user_id = ?')
    .get(Number(id), userId);
  if (!row) return null;
  db.prepare('UPDATE collection SET quantity = quantity + ? WHERE id = ? AND user_id = ?')
    .run(inc, Number(id), userId);
  return fetchEntry(id, userId);
}

/**
 * Decrease a collection row's quantity by `n` (default 1). The row is
 * deleted when the quantity would drop to zero or below. Returns the
 * updated row, or null when the row was removed entirely.
 */
export function decrementEntry(id, userId = DEFAULT_USER_ID, n = 1) {
  const dec = Math.max(1, Math.floor(Number(n) || 1));
  const row = db
    .prepare('SELECT id, quantity, card_id FROM collection WHERE id = ? AND user_id = ?')
    .get(Number(id), userId);
  if (!row) return null;
  if (row.quantity - dec <= 0) {
    db.prepare('DELETE FROM collection WHERE id = ? AND user_id = ?').run(Number(id), userId);
    return null;
  }
  db.prepare('UPDATE collection SET quantity = quantity - ? WHERE id = ? AND user_id = ?')
    .run(dec, Number(id), userId);
  return fetchEntry(id, userId);
}

/**
 * Set a collection row's exact quantity. `0` (or less) deletes the row.
 * Returns the updated row, or null when the row was removed.
 *
 * A missing or unparseable quantity throws instead of deleting: `Number(
 * undefined)` is NaN, and treating NaN as "zero copies" is how a PUT with an
 * empty body used to wipe a row. The route turns the throw into a 400.
 */
export function setEntryQuantity(id, qty, userId = DEFAULT_USER_ID) {
  // `null`/`undefined`/`''` are all "the client sent nothing", and Number() turns
  // them into 0 (or NaN) — which must never be read as "zero copies".
  const blank = qty === null || qty === undefined || (typeof qty === 'string' && qty.trim() === '');
  const n = blank ? NaN : Number(qty);
  if (!Number.isFinite(n)) throw new Error('quantity must be a number');
  const q = Math.floor(n);
  if (q <= 0) {
    db.prepare('DELETE FROM collection WHERE id = ? AND user_id = ?').run(Number(id), userId);
    return null;
  }
  db.prepare('UPDATE collection SET quantity = ? WHERE id = ? AND user_id = ?')
    .run(q, Number(id), userId);
  return fetchEntry(id, userId);
}

// ---- Per-user settings -----------------------------------------------------

/** A stored JSON setting, or `fallback` when it was never written. */
export function getSetting(userId, key, fallback = null) {
  const row = db
    .prepare('SELECT value FROM setting WHERE user_id = ? AND key = ?')
    .get(Number(userId), String(key));
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback; // a corrupt blob is a missing one, never a crash
  }
}

export function setSetting(userId, key, value) {
  db.prepare(
    `INSERT INTO setting (user_id, key, value) VALUES (?,?,?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`
  ).run(Number(userId), String(key), JSON.stringify(value));
  return value;
}

// ---- Users, sessions & guest identities ------------------------------------

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

/** A user as the API may expose it — never the password columns. */
export function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, username: u.username ?? null, isGuest: Number(u.is_guest) === 1 };
}

export function getUserById(id) {
  return db.prepare('SELECT * FROM user WHERE id = ?').get(Number(id)) ?? null;
}

export function findUserByUsername(username) {
  return db.prepare('SELECT * FROM user WHERE username = ? COLLATE NOCASE').get(String(username ?? '')) ?? null;
}

export function listUsers() {
  return db.prepare('SELECT id, name, username, is_guest, created_at FROM user ORDER BY id').all();
}

export function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM user').get().n;
}

export function countGuests() {
  return db.prepare('SELECT COUNT(*) AS n FROM user WHERE is_guest = 1').get().n;
}

/** Create an account — or a guest, when `isGuest` is true. */
export function createUser({
  name, username = null, passwordHash = null, passwordSalt = null, passwordIters = null, isGuest = false,
}) {
  const info = db
    .prepare(
      `INSERT INTO user (name, created_at, username, password_hash, password_salt, password_iters, is_guest)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(name, new Date().toISOString(), username, passwordHash, passwordSalt, passwordIters, isGuest ? 1 : 0);
  return getUserById(Number(info.lastInsertRowid));
}

/** Turn a row into an account: credentials on, guest flag off. */
export function setUserCredentials(id, { username, passwordHash, passwordSalt, passwordIters }) {
  db.prepare(
    `UPDATE user SET username = ?, password_hash = ?, password_salt = ?, password_iters = ?, is_guest = 0
      WHERE id = ?`
  ).run(username, passwordHash, passwordSalt, passwordIters, Number(id));
  return getUserById(id);
}

/** Change only the password (the username stays). */
export function setUserPassword(id, { passwordHash, passwordSalt, passwordIters }) {
  db.prepare('UPDATE user SET password_hash = ?, password_salt = ?, password_iters = ? WHERE id = ?')
    .run(passwordHash, passwordSalt, passwordIters, Number(id));
  return getUserById(id);
}

/** What a user owns: rows, and copies (the sum of `quantity`). */
export function collectionSize(userId) {
  const row = db
    .prepare('SELECT COUNT(*) AS rows, COALESCE(SUM(quantity), 0) AS copies FROM collection WHERE user_id = ?')
    .get(userId);
  return { rows: row.rows, copies: row.copies };
}

// Sessions — the cookie is an opaque random token and the database only ever
// sees its SHA-256, so a copy of mtg.db hands out no usable session.

export function createSession({ tokenHash, userId, ttlDays }) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlDays * 864e5).toISOString();
  db.prepare(
    'INSERT INTO session (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?,?,?,?,?)'
  ).run(tokenHash, Number(userId), now.toISOString(), now.toISOString(), expiresAt);
  return { tokenHash, userId: Number(userId), expiresAt };
}

/** The session and its user for a token hash; expired rows are dropped on sight. */
export function getSessionUser(tokenHash) {
  const session = db.prepare('SELECT * FROM session WHERE token_hash = ?').get(tokenHash);
  if (!session) return null;
  const user = getUserById(session.user_id);
  if (!user || session.expires_at <= new Date().toISOString()) {
    db.prepare('DELETE FROM session WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  return { session, user };
}

/** Slide a session's expiry (called at most once an hour, not per request). */
export function touchSession(tokenHash, ttlDays) {
  const now = new Date();
  db.prepare('UPDATE session SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?')
    .run(now.toISOString(), new Date(now.getTime() + ttlDays * 864e5).toISOString(), tokenHash);
}

export function deleteSession(tokenHash) {
  return db.prepare('DELETE FROM session WHERE token_hash = ?').run(tokenHash).changes;
}

/** Retire every session of a user (optionally sparing the caller's own). */
export function deleteUserSessions(userId, keepTokenHash = null) {
  return keepTokenHash
    ? db.prepare('DELETE FROM session WHERE user_id = ? AND token_hash <> ?').run(Number(userId), keepTokenHash).changes
    : db.prepare('DELETE FROM session WHERE user_id = ?').run(Number(userId)).changes;
}

export function purgeExpiredSessions() {
  return db.prepare('DELETE FROM session WHERE expires_at <= ?').run(new Date().toISOString()).changes;
}

// Guests — an anonymous visitor's collection. Signing in *folds* it into the
// account rather than throwing it away.

/** Delete the rows that reference a user — there is no ON DELETE CASCADE. */
function deleteUserRows(userId) {
  const id = Number(userId);
  const entries = db.prepare('DELETE FROM collection WHERE user_id = ?').run(id).changes;
  const sessions = db.prepare('DELETE FROM session WHERE user_id = ?').run(id).changes;
  db.prepare('DELETE FROM setting WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM user WHERE id = ?').run(id);
  return { entries, sessions };
}

/** Delete a user and everything that points at it. */
export function deleteUser(userId) {
  return tx(() => deleteUserRows(userId));
}

/**
 * Fold a guest's collection into an account, then drop the guest. A printing
 * the account already owns *in the same finish and grade* adds the copies
 * together and keeps the earlier `added_at` — "owned since the first time either
 * side added it". Foil and non-foil, NM and LP, all fold independently. Price
 * history needs no work at all: `price_snapshot` is keyed by card, not by user.
 */
export function mergeGuestInto(targetUserId, guestUserId) {
  const target = Number(targetUserId);
  const guest = Number(guestUserId);
  if (target === guest) return { rows: 0, copies: 0 };
  const size = collectionSize(guest);
  const upsert = db.prepare(
    `INSERT INTO collection (user_id, card_id, quantity, added_at, price_at_add, foil, condition)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(user_id, card_id, foil, condition) DO UPDATE SET
       quantity = collection.quantity + excluded.quantity,
       added_at = MIN(collection.added_at, excluded.added_at)`
  );
  tx(() => {
    const rows = db
      .prepare('SELECT card_id, quantity, added_at, price_at_add, foil, condition FROM collection WHERE user_id = ?')
      .all(guest);
    for (const row of rows) {
      upsert.run(target, row.card_id, row.quantity, row.added_at, row.price_at_add, row.foil, row.condition);
    }
    deleteUserRows(guest);
  });
  return size;
}

/**
 * Housekeeping for anonymous identities: a guest that never collected anything
 * goes after `emptyDays`, one with cards after `idleDays` (it gets longer to be
 * claimed). Accounts are never touched.
 */
export function purgeGuests({ emptyDays = 7, idleDays = 30 } = {}) {
  const olderThan = (days) => new Date(Date.now() - days * 864e5).toISOString();
  const guests = db
    .prepare(
      `SELECT user.id AS id, user.created_at AS created_at,
              (SELECT COUNT(*) FROM collection WHERE collection.user_id = user.id) AS rows
         FROM user WHERE user.is_guest = 1`
    )
    .all();
  let removed = 0;
  for (const g of guests) {
    if (g.created_at > olderThan(g.rows ? idleDays : emptyDays)) continue;
    deleteUserRows(g.id);
    removed++;
  }
  return removed;
}

/** Guest identities with how many collection rows each holds (housekeeping). */
export function guestInventory() {
  return db
    .prepare(
      `SELECT user.id AS id, user.name AS name, user.created_at AS created_at,
              (SELECT COUNT(*) FROM collection WHERE collection.user_id = user.id) AS rows,
              (SELECT COALESCE(SUM(quantity), 0) FROM collection WHERE collection.user_id = user.id) AS copies
         FROM user WHERE user.is_guest = 1
        ORDER BY user.id`
    )
    .all();
}

/**
 * Delete guest identities now, regardless of age: every one of them, or only
 * those that never collected a card (`includeWithCards: false`). Used by
 * `npm run gc` after a session of test scans. Accounts are never touched.
 */
export function deleteGuests({ includeWithCards = false } = {}) {
  const guests = guestInventory().filter((g) => includeWithCards || g.rows === 0);
  let removed = 0;
  tx(() => {
    for (const g of guests) {
      deleteUserRows(g.id);
      removed++;
    }
  });
  return { removed, kept: guestInventory().length };
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
      // The rows need an account to own them. Without one, leave the old table
      // in place and retry on a later boot — the flag stays unset until it lands.
      if (DEFAULT_USER_ID == null) return;
      const addToCollection = db.prepare(
        `INSERT OR IGNORE INTO collection (user_id, card_id, quantity, added_at, price_at_add)
         VALUES (?,?,?,?,?)`
      );
      for (const r of db.prepare('SELECT * FROM collection_entry ORDER BY id').all()) {
        const card = upsertCard({ ...r, rarity: null });
        addToCollection.run(DEFAULT_USER_ID, card.id, 1, r.added_at, r.price_usd);
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