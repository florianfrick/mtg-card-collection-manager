// Unit tests for the storage layer (src/db.js) against a throwaway database.
//
// The point of most of these is the contract the HTTP routes depend on: which
// inputs mutate a row, which ones are refused, and how finish and grade decide
// whether two copies are one row or two.
//
// There is one collection now, so the tests share it: each one starts from an
// empty table (see beforeEach) instead of from its own user id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// db.js opens the database when it is imported, so the path has to be in place
// before the import below.
const dir = mkdtempSync(join(tmpdir(), 'mtg-db-test-'));
process.env.MTG_DB = join(dir, 'test.db');

const db = await import('../src/db.js');

test.beforeEach(() => {
  for (const entry of db.listEntries()) db.removeEntry(entry.id);
  db.deleteOrphanCards(); // cards left behind by the removals above
});

test.after(() => {
  db.closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
const card = (over = {}) => ({
  scryfall_id: `sf-${++seq}`,
  name: `Test Card ${seq}`,
  set_name: 'Test Set',
  set_code: 'tst',
  collector_number: String(seq),
  rarity: 'rare',
  price_usd: 1,
  ...over,
});

test('adding a card stores its rarity', () => {
  const { entry } = db.addEntry(card({ rarity: 'mythic' }));
  assert.equal(entry.rarity, 'mythic');
});

test('a partial re-add does not blank out fields it did not send', () => {
  const c = card({ rarity: 'mythic' });
  db.addEntry(c);
  // The price job and bulk imports only know the printing id.
  db.addEntry({ scryfall_id: c.scryfall_id, name: c.name, price_usd: 2 });
  const [row] = db.listEntries();
  assert.equal(row.rarity, 'mythic', 'rarity must survive a partial update');
  assert.equal(row.set_code, 'tst', 'set code must survive a partial update');
});

test('copies of the same printing and finish live in one row', () => {
  const c = card();
  db.addEntry(c, 2);
  const { entry, newCopy } = db.addEntry(c, 3);
  assert.equal(newCopy, false);
  assert.equal(entry.quantity, 5);
  assert.equal(db.listEntries().length, 1);
});

test('foil and non-foil copies of one printing are separate rows', () => {
  const c = card();
  db.addEntry(c);
  db.addEntry({ ...c, foil: true });
  const rows = db.listEntries();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => Number(r.foil)).sort(), [0, 1]);
});

test('a missing or unparseable quantity is refused instead of deleting the row', () => {
  const { entry } = db.addEntry(card());
  for (const bad of [undefined, null, '', 'lots', NaN, {}]) {
    assert.throws(() => db.setEntryQuantity(entry.id, bad), /quantity must be a number/, `accepted ${String(bad)}`);
  }
  assert.equal(db.listEntries().length, 1, 'the row must still be there');
  assert.equal(db.listEntries()[0].quantity, 1);
});

test('setting the quantity to zero deletes the row', () => {
  const { entry } = db.addEntry(card(), 2);
  assert.equal(db.setEntryQuantity(entry.id, 0), null);
  assert.equal(db.listEntries().length, 0);
});

test('setting the quantity floors fractions and keeps the row', () => {
  const { entry } = db.addEntry(card());
  assert.equal(db.setEntryQuantity(entry.id, 2.9).quantity, 2);
});

test('flipping a row into a finish it already owns merges the two rows', () => {
  const c = card();
  db.addEntry(c, 1);
  const { entry: foil } = db.addEntry({ ...c, foil: true }, 2);
  const merged = db.setEntryFoil(foil.id, false);
  assert.equal(Number(merged.foil), 0);
  assert.equal(merged.quantity, 3, 'quantities add up');
  assert.equal(db.listEntries().length, 1);
});

test('set ownership counts printings, not copies, and adds up value', () => {
  db.addEntry(card({ set_code: 'znr', collector_number: '1', price_usd: 1 }), 3);
  db.addEntry(card({ set_code: 'znr', collector_number: '2', price_usd: 2 }));
  db.addEntry(card({ set_code: 'woe', collector_number: '7', price_usd: 5 }));

  const bySet = new Map(db.setOwnership().map((s) => [s.code, s]));
  assert.equal(bySet.get('znr').owned, 2, 'three copies of one printing still count once');
  assert.equal(bySet.get('znr').copies, 4);
  assert.equal(bySet.get('znr').value, 5); // 3 × 1 + 1 × 2
  assert.equal(bySet.get('woe').owned, 1);
});

test('the collection size counts rows and copies', () => {
  db.addEntry(card(), 2);
  db.addEntry(card());
  assert.deepEqual(db.collectionSize(), { rows: 2, copies: 3 });
});

// ---- condition (grade) -----------------------------------------------------
//
// A grade is part of a row's identity, like the finish: an NM copy and an LP
// copy of the same printing are worth different money, so they are different
// rows and neither may silently absorb the other.

test('a card added without a grade is near mint', () => {
  const { entry } = db.addEntry(card());
  assert.equal(entry.condition, 'NM');
});

test('an LP copy is its own row, separate from the NM copy', () => {
  const c = card();
  db.addEntry(c, 2);
  db.addEntry({ ...c, condition: 'LP' });
  const rows = db.listEntries();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.condition).sort(), ['LP', 'NM']);
  assert.equal(rows.find((r) => r.condition === 'NM').quantity, 2);
});

test('a grade that does not exist is refused instead of quietly becoming NM', () => {
  assert.throws(() => db.addEntry({ ...card(), condition: 'MINT' }), /condition must be one of/);
  assert.equal(db.listEntries().length, 0);
});

test('grades are matched case-insensitively', () => {
  const { entry } = db.addEntry({ ...card(), condition: 'lp' });
  assert.equal(entry.condition, 'LP');
});

test('re-grading into a grade already owned merges the rows', () => {
  const c = card();
  db.addEntry(c, 1);
  const { entry: lp } = db.addEntry({ ...c, condition: 'LP' }, 2);
  const merged = db.setEntryCondition(lp.id, 'NM');
  assert.equal(merged.condition, 'NM');
  assert.equal(merged.quantity, 3, 'the copies add up');
  assert.equal(db.listEntries().length, 1);
});

test('a grade change keeps the finish', () => {
  const { entry } = db.addEntry({ ...card(), foil: true });
  const regraded = db.setEntryCondition(entry.id, 'MP');
  assert.equal(regraded.condition, 'MP');
  assert.equal(Number(regraded.foil), 1);
});

// ---- settings --------------------------------------------------------------

test('a setting round-trips as JSON and falls back when unset', () => {
  assert.equal(db.getSetting('missing', 'fallback'), 'fallback');
  db.setSetting('k', { a: 1, b: [2] });
  assert.deepEqual(db.getSetting('k'), { a: 1, b: [2] });
  db.setSetting('k', { a: 2 });
  assert.deepEqual(db.getSetting('k'), { a: 2 }, 'a second write replaces the first');
});

// ---- housekeeping ----------------------------------------------------------

test('a card nobody owns is reported as an orphan once its last row is gone', () => {
  const c = card();
  const { entry } = db.addEntry(c);
  assert.equal(db.orphanCards().some((o) => o.scryfall_id === c.scryfall_id), false);
  db.removeEntry(entry.id);
  assert.equal(db.orphanCards().some((o) => o.scryfall_id === c.scryfall_id), true);
});

test('sweeping orphans drops the card and its price history, and nothing owned', () => {
  const kept = card();
  const dropped = card();
  db.addEntry(kept);
  db.addEntry(dropped);
  db.recordPrices([{ scryfall_id: dropped.scryfall_id, price_usd: 3 }]);
  const droppedId = db.listEntries().find((e) => e.scryfall_id === dropped.scryfall_id).id;
  db.removeEntry(droppedId);

  const before = db.orphanCards().length;
  const { removed, snapshots } = db.deleteOrphanCards();
  assert.equal(removed, before);
  assert.ok(snapshots >= 1, 'the orphan carried a price snapshot');
  // Nothing unowned is left — a surviving card row would still show up here.
  assert.equal(db.orphanCards().length, 0);
  assert.equal(db.listEntries().length, 1, 'the owned card survives');
});
