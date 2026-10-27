// Unit tests for the OCR cue parser (src/matcher.js).
//
// parseOcr is the piece of the pipeline with the most branching and no I/O: it
// takes word boxes and returns the cues. Fixtures below are trimmed-down
// versions of real PP-OCR output (a flatbed scan and a 720p photo), so a change
// to the bands, the digit repair or the set-code logic fails here instead of
// silently costing matches in the field.
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseOcr } from '../src/matcher.js';

const SETS = new Set(['ZNR', 'KHM', 'WOE', 'MID', 'BRO']);

/** A word box; `x`/`y` are the top-left corner, `w`/`h` the size. */
const w = (text, x, y, { w: ww = text.length * 8, h = 18, conf = 95 } = {}) => ({
  text, conf, x0: x, y0: y, x1: x + ww, y1: y + h,
});

/**
 * A whole card's worth of rows: title at the top, art in the middle (which the
 * parser must drop), and the footer with the collector number and set line.
 * The spacing mirrors a real card: the number sits just above the set line and
 * the copyright line is right under it, which is what puts the number inside
 * the parser's footer band (the bottom ~60px of text).
 */
function card({ title = 'Legion Angel', number = '23/280 R', set = 'ZNR • EN', art = [] } = {}) {
  return [
    w(title, 40, 60, { w: 260 }),
    ...art,
    w(number, 40, 530),
    w(set, 120, 548),
    w('Wizards of the Coast', 200, 566),
  ];
}

test('reads the collector number from a slash line and strips leading zeros', () => {
  const p = parseOcr(card({ number: '023/280 R' }), SETS);
  assert.equal(p.collectorNumber, '23');
  assert.equal(p.numForm, 'slash');
  assert.equal(p.setCode, 'ZNR');
  assert.equal(p.setValidated, true);
});

test('takes the numerator when the denominator dissolved', () => {
  const p = parseOcr(card({ number: '45/' }), SETS);
  assert.equal(p.collectorNumber, '45');
  assert.equal(p.numForm, 'slash');
});

test('a bare three-digit number is a printing number, not the set total', () => {
  const p = parseOcr(card({ number: '0190' }), SETS);
  assert.equal(p.collectorNumber, '190');
  assert.equal(p.numForm, 'bare');
});

test('a short bare number is reported as a fragile reading', () => {
  const p = parseOcr(card({ number: '29' }), SETS);
  assert.equal(p.collectorNumber, '29');
  assert.equal(p.numForm, 'frag');
});

test('a copyright year in the footer is not read as the collector number', () => {
  const words = [
    w('Shady Traveler', 40, 60, { w: 260 }),
    w('TM & © 2023 Wizards of the Coast', 120, 560, { w: 300 }),
    w('291', 40, 520),
  ];
  const p = parseOcr(words, SETS);
  // "291" sits next to the copyright line, so it is the only candidate left —
  // the year itself must never win.
  assert.equal(p.collectorNumber, '291');
});

test('OCR digit look-alikes are normalised before matching', () => {
  const p = parseOcr(card({ number: 'O23/28O' }), SETS);
  assert.equal(p.collectorNumber, '23');
});

test('a set code one edit away from a known set is repaired when it is the only candidate', () => {
  const p = parseOcr(card({ set: 'WOT • EN' }), SETS);
  assert.equal(p.setCode, 'WOE');
  assert.equal(p.setValidated, true);
});

test('an unknown set code next to EN is kept but not validated', () => {
  const p = parseOcr(card({ set: 'XYZ • EN' }), SETS);
  assert.equal(p.setCode, 'XYZ');
  assert.equal(p.setValidated, false);
});

test('the title row becomes the name candidates, with shorter prefixes as fallbacks', () => {
  const p = parseOcr(card({ title: 'Stab Wound 2e J' }), SETS);
  assert.equal(p.nameCandidates[0], 'Stab Wound 2e J'); // the row as read
  // ...and the neighbour junk is trimmed off by the shorter variants, which is
  // what rescues the name when Scryfall's fuzzy match rejects the full row.
  assert.ok(p.nameCandidates.includes('Stab Wound'), `got ${JSON.stringify(p.nameCandidates)}`);
});

test('words in the art band are dropped from the reported rows', () => {
  const p = parseOcr(card({ art: [w('HALLUCINATED', 150, 300, { conf: 92 })] }), SETS);
  assert.ok(!p.rows.join(' ').includes('HALLUCINATED'), `art leaked into rows: ${p.rows.join(' | ')}`);
});

test('the cue key prefers set + number, so a stationary camera frame is recognised', () => {
  const p = parseOcr(card(), SETS);
  assert.equal(p.key, 'ZNR:23');
});

test('without a number the cue key falls back to the cleaned title', () => {
  const p = parseOcr([w('Virtue of Loyalty 3', 40, 60, { w: 240 })], SETS);
  assert.equal(p.key, 'name:virtue of loyalty');
});

test('an empty read yields no cues instead of throwing', () => {
  const p = parseOcr([], SETS);
  assert.equal(p.setCode, null);
  assert.equal(p.collectorNumber, null);
  assert.equal(p.key, '');
  assert.deepEqual(p.nameCandidates, []);
});
