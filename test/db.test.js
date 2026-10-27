// Unit tests for the storage layer (src/db.js) against a throwaway database.
//
// The point of most of these is the contract the HTTP routes depend on: which
// inputs mutate a row, which ones are refused, and that one user's collection is
// never visible through another user's id.
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

const user = (name = `user${++seq}`) =>
  db.createUser({ name, username: name, passwordHash: 'h', passwordSalt: 's', passwordIters: 1 });

test('adding a card stores its rarity', () => {
  const u = user();
  const { entry } = db.addEntry(card({ rarity: 'mythic' }), u.id);
  assert.equal(entry.rarity, 'mythic');
});

test('a partial re-add does not blank out fields it did not send', () => {
  const u = user();
  const c = card({ rarity: 'mythic' });
  db.addEntry(c, u.id);
  // The price job and bulk imports only know the printing id.
  db.addEntry({ scryfall_id: c.scryfall_id, name: c.name, price_usd: 2 }, u.id);
  const [row] = db.listEntries(u.id);
  assert.equal(row.rarity, 'mythic', 'rarity must survive a partial update');
  assert.equal(row.set_code, 'tst', 'set code must survive a partial update');
});

test('copies of the same printing and finish live in one row', () => {
  const u = user();
  const c = card();
  db.addEntry(c, u.id, 2);
  const { entry, newCopy } = db.addEntry(c, u.id, 3);
  assert.equal(newCopy, false);
  assert.equal(entry.quantity, 5);
  assert.equal(db.listEntries(u.id).length, 1);
});

test('foil and non-foil copies of one printing are separate rows', () => {
  const u = user();
  const c = card();
  db.addEntry(c, u.id);
  db.addEntry({ ...c, foil: true }, u.id);
  const rows = db.listEntries(u.id);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => Number(r.foil)).sort(), [0, 1]);
});

test('a missing or unparseable quantity is refused instead of deleting the row', () => {
  const u = user();
  const { entry } = db.addEntry(card(), u.id);
  for (const bad of [undefined, null, '', 'lots', NaN, {}]) {
    assert.throws(() => db.setEntryQuantity(entry.id, bad, u.id), /quantity must be a number/, `accepted ${String(bad)}`);
  }
  assert.equal(db.listEntries(u.id).length, 1, 'the row must still be there');
  assert.equal(db.listEntries(u.id)[0].quantity, 1);
});

test('setting the quantity to zero deletes the row', () => {
  const u = user();
  const { entry } = db.addEntry(card(), u.id, 2);
  assert.equal(db.setEntryQuantity(entry.id, 0, u.id), null);
  assert.equal(db.listEntries(u.id).length, 0);
});

test('setting the quantity floors fractions and keeps the row', () => {
  const u = user();
  const { entry } = db.addEntry(card(), u.id);
  assert.equal(db.setEntryQuantity(entry.id, 2.9, u.id).quantity, 2);
});

test('flipping a row into a finish it already owns merges the two rows', () => {
  const u = user();
  const c = card();
  db.addEntry(c, u.id, 1);
  const { entry: foil } = db.addEntry({ ...c, foil: true }, u.id, 2);
  const merged = db.setEntryFoil(foil.id, false, u.id);
  assert.equal(Number(merged.foil), 0);
  assert.equal(merged.quantity, 3, 'quantities add up');
  assert.equal(db.listEntries(u.id).length, 1);
});

test('one user never sees another user\'s rows', () => {
  const a = user();
  const b = user();
  const { entry } = db.addEntry(card(), a.id);
  assert.equal(db.listEntries(b.id).length, 0);
  assert.equal(db.ownsEntry(entry.id, b.id), false);
  assert.equal(db.setEntryQuantity(entry.id, 5, b.id), null, 'a write scoped to b changes nothing');
  assert.equal(db.listEntries(a.id)[0].quantity, 1);
});

test('a guest collection is folded into an account, copies summed', () => {
  const guest = db.createUser({ name: 'Guest x', isGuest: true });
  const account = user();
  const shared = card();
  db.addEntry(shared, guest.id, 2);
  db.addEntry(shared, account.id, 1);
  const onlyGuestHad = card();
  db.addEntry(onlyGuestHad, guest.id);

  const merged = db.mergeGuestInto(account.id, guest.id);
  assert.equal(merged.rows, 2);

  const rows = db.listEntries(account.id);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.scryfall_id === shared.scryfall_id).quantity, 3);
  assert.equal(db.getUserById(guest.id), null, 'the guest identity is gone');
});

test('set ownership counts printings, not copies, and adds up value', () => {
  const u = user();
  db.addEntry(card({ set_code: 'znr', collector_number: '1', price_usd: 1 }), u.id, 3);
  db.addEntry(card({ set_code: 'znr', collector_number: '2', price_usd: 2 }), u.id);
  db.addEntry(card({ set_code: 'woe', collector_number: '7', price_usd: 5 }), u.id);

  const bySet = new Map(db.setOwnership(u.id).map((s) => [s.code, s]));
  assert.equal(bySet.get('znr').owned, 2, 'three copies of one printing still count once');
  assert.equal(bySet.get('znr').copies, 4);
  assert.equal(bySet.get('znr').value, 5); // 3 × 1 + 1 × 2
  assert.equal(bySet.get('woe').owned, 1);
});

test('guests with cards are kept unless every guest is asked for', () => {
  const empty = db.createUser({ name: 'Guest empty', isGuest: true });
  const holding = db.createUser({ name: 'Guest with cards', isGuest: true });
  db.addEntry(card(), holding.id);

  const { removed } = db.deleteGuests();
  assert.ok(removed >= 1);
  assert.equal(db.getUserById(empty.id), null);
  assert.ok(db.getUserById(holding.id), 'a guest that collected something survives the default sweep');
});

test('the account a guest becomes keeps its collection', () => {
  const guest = db.createUser({ name: 'Guest upgrade', isGuest: true });
  db.addEntry(card(), guest.id);
  const upgraded = db.setUserCredentials(guest.id, {
    username: 'upgraded', passwordHash: 'h', passwordSalt: 's', passwordIters: 1,
  });
  assert.equal(Number(upgraded.is_guest), 0);
  assert.equal(db.collectionSize(guest.id).rows, 1);
});
