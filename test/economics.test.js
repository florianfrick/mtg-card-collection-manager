// Unit tests for the economics layer (src/economics.js).
//
// The arithmetic is the product here, so the tests pin the numbers that matter:
// the fee subtraction, the break-even price below which an envelope costs more
// than the card returns, which bucket a card lands in, and the capacity cut.
// The settings tests exist because a bad assumption silently changes every
// figure on the page — validation is the feature.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// economics.js imports db.js (for the settings table), which opens the database
// at import time — so the path must be set before the dynamic import below.
const dir = mkdtempSync(join(tmpdir(), 'mtg-econ-test-'));
process.env.MTG_DB = join(dir, 'test.db');

const econ = await import('../src/economics.js');
const db = await import('../src/db.js');

test.after(() => {
  db.closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

/** One collection row as the API returns it, with only the fields plan() reads. */
const row = (over = {}) => ({
  id: Math.random(),
  name: 'Test Card',
  set_code: 'tst',
  set_name: 'Test Set',
  collector_number: '1',
  rarity: 'rare',
  foil: false,
  condition: 'NM',
  quantity: 1,
  price_usd: 10,
  tcgplayer_id: 12345,
  ...over,
});

const settings = (over = {}) => econ.resolveSettings(over);

// ---- the arithmetic --------------------------------------------------------

test('a listed card is priced below market by the undercut', () => {
  const s = settings({ undercutPct: 5 });
  assert.equal(econ.askPrice(10, 1, s), 9.5);
  assert.equal(econ.askPrice(10, 0.85, s), 8.08, 'the grade scales the market price first');
});

test('retail net subtracts commission, payment processing and postage', () => {
  const s = settings();
  // ask 9.50, fees 9.50 x 12.75% + 0.30 = 1.51125, postage 1.10
  assert.equal(econ.retailNet(10, 1, s), 6.89);
  // The same card in lightly played condition is worth less than the NM one.
  assert.ok(econ.retailNet(10, 0.85, s) < econ.retailNet(10, 1, s));
});

test('a buylist pays a fraction of market and no per-card postage', () => {
  const s = settings({ buylistRatePct: 50 });
  assert.equal(econ.buylistNet(10, 1, s), 5);
  assert.equal(econ.buylistNet(10, 0.85, s), 4.25);
});

test('the break-even price is where retail net reaches zero', () => {
  const s = settings();
  const be = econ.retailBreakEven(s);
  assert.equal(be, 1.69);
  // Just below it the envelope loses money; just above it, it does not.
  assert.ok(econ.retailNet(be - 0.02, 1, s) <= 0);
  assert.ok(econ.retailNet(be + 0.02, 1, s) > 0);
});

// ---- classification --------------------------------------------------------

test('an expensive card is listed, a cheap one goes in the box', () => {
  const s = settings();
  const p = econ.plan([row({ price_usd: 40 }), row({ price_usd: 2, id: 2 })], s);
  const byPrice = new Map(p.cards.map((c) => [c.market, c]));
  assert.equal(byPrice.get(40).bucket, 'list');
  assert.equal(byPrice.get(2).bucket, 'box', 'netting under the floor is not worth an envelope');
});

test('a card worth pennies wholesale is not worth shipping at all', () => {
  const s = settings();
  const p = econ.plan([row({ price_usd: 0.3 })], s);
  assert.equal(p.cards[0].bucket, 'ignore');
  assert.match(p.cards[0].reason, /wholesale/);
});

test('a card with no price is reported as unknown, not as worthless', () => {
  const s = settings();
  const p = econ.plan([row({ price_usd: null })], s);
  assert.equal(p.cards[0].bucket, 'unknown');
  assert.equal(p.totals.missingPrice, 1);
});

test('the minimum net floor moves a card from list to box', () => {
  const card = row({ price_usd: 6 });
  assert.equal(econ.plan([card], settings({ minNet: 1 })).cards[0].bucket, 'list');
  assert.equal(econ.plan([card], settings({ minNet: 4 })).cards[0].bucket, 'box');
});

test('capacity keeps the biggest gains and pushes the rest into the box', () => {
  const s = settings({ capacity: 1 });
  const p = econ.plan([row({ price_usd: 10, id: 1 }), row({ price_usd: 30, id: 2 })], s);
  const listed = p.buckets.list.cards;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].market, 30, 'the card with the most to gain gets the envelope');
  assert.equal(p.totals.overflow, 1);
});

test('bucket totals multiply by copies, not by rows', () => {
  const s = settings();
  const p = econ.plan([row({ price_usd: 20, quantity: 3 })], s);
  assert.equal(p.buckets.list.copies, 3);
  assert.equal(p.buckets.list.net, Math.round(p.cards[0].retailNet * 3 * 100) / 100);
});

test('a collection total is retail plus box, and market is the headline', () => {
  const s = settings();
  const p = econ.plan([row({ price_usd: 20 }), row({ price_usd: 2, id: 2 })], s);
  assert.equal(p.totals.market, 22);
  assert.equal(p.totals.net, Math.round((p.buckets.list.net + p.buckets.box.net) * 100) / 100);
});

// ---- settings --------------------------------------------------------------

test('a non-numeric assumption is refused instead of stored as NaN', () => {
  assert.throws(() => econ.resolveSettings({ postage: 'free' }), /postage must be a number/);
  assert.throws(() => econ.resolveSettings({ commissionPct: 500 }), /between/);
});

test('an unknown platform is refused', () => {
  assert.throws(() => econ.resolveSettings({ platform: 'cardmarket' }), /platform must be one of/);
});

test('switching platform swaps the fee preset', () => {
  const u = db.createUser({ name: 'econ', username: 'econ', passwordHash: 'h', passwordSalt: 's', passwordIters: 1 });
  const saved = econ.saveSettings(u.id, { platform: 'ebay' });
  assert.equal(saved.commissionPct, econ.PLATFORMS.ebay.commissionPct);
  assert.equal(saved.paymentPct, 0, 'eBay bundles payment processing into its final value fee');
});

test('a custom fee survives a later unrelated change', () => {
  const u = db.createUser({ name: 'econ2', username: 'econ2', passwordHash: 'h', passwordSalt: 's', passwordIters: 1 });
  econ.saveSettings(u.id, { commissionPct: 7 });
  const after = econ.saveSettings(u.id, { postage: 2.5 });
  assert.equal(after.commissionPct, 7, 'editing postage must not reset the commission');
  assert.equal(after.postage, 2.5);
});

test('settings round-trip through storage', () => {
  const u = db.createUser({ name: 'econ3', username: 'econ3', passwordHash: 'h', passwordSalt: 's', passwordIters: 1 });
  econ.saveSettings(u.id, { capacity: 7, conditionFactors: { LP: 0.9 } });
  const loaded = econ.loadSettings(u.id);
  assert.equal(loaded.capacity, 7);
  assert.equal(loaded.conditionFactors.LP, 0.9);
  assert.equal(loaded.conditionFactors.NM, 1, 'grades that were not overridden keep their default');
});

test('a user who never saved anything gets the defaults', () => {
  const u = db.createUser({ name: 'econ4', username: 'econ4', passwordHash: 'h', passwordSalt: 's', passwordIters: 1 });
  assert.deepEqual(econ.loadSettings(u.id), econ.DEFAULT_SETTINGS);
});

// ---- export files ----------------------------------------------------------

test('CSV cells containing commas, quotes or newlines are quoted', () => {
  const csv = econ.toCsv(['A', 'B'], [['plain', 'has, comma'], ['say "hi"', 'two\nlines']]);
  assert.equal(csv, 'A,B\r\nplain,"has, comma"\r\n"say ""hi""","two\nlines"\r\n');
});

test('the TCGplayer file uses its own column names and condition spelling', () => {
  const { csv, rows } = econ.tcgplayerCsv([row({ price_usd: 10, ask: 9.5, condition: 'LP', tcgplayer_id: 99 })]);
  assert.equal(rows, 1);
  const [header, line] = csv.trim().split('\r\n');
  assert.equal(header, 'TCGplayer Id,Product Line,Set Name,Product Name,Number,Rarity,Condition,Printing,Price,Quantity');
  assert.match(line, /^99,Magic: The Gathering,Test Set,Test Card,1,rare,Lightly Played,Normal,9.50,1$/);
});

test('a row with no TCGplayer id is skipped and counted, never silently dropped', () => {
  const { rows, skipped } = econ.tcgplayerCsv([row({ tcgplayer_id: null }), row({ tcgplayer_id: 7 })]);
  assert.equal(rows, 1);
  assert.equal(skipped, 1);
});

test('the buylist file carries the grade and the expected payout', () => {
  const { csv } = econ.buylistCsv([row({ condition: 'MP', buylistNet: 3.5, market: 10 })]);
  const line = csv.trim().split('\r\n')[1];
  assert.equal(line, '1,Test Card,TST,1,MP,Non-foil,10.00,3.50');
});

test('the plain list is one pasteable line per row', () => {
  const { text, rows } = econ.plainList([row({ quantity: 4, name: 'Lightning Bolt', set_code: '2xm', collector_number: '129' })]);
  assert.equal(rows, 1);
  assert.equal(text, '4 Lightning Bolt [2XM] 129\r\n');
});
