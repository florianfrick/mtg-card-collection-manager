// Smoke test for the HTTP API. Starts from a running server (npm start).
//   node scripts/smoke.mjs [scanImage]
// Exercises: detect (over HTTP), auto-add of the best match, add, list, remove.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.MTG_BASE || 'http://localhost:3000';

/** The image to test with: the one named on the command line, else the first scan. */
function defaultScan() {
  const dir = join(here, '..', 'card scans');
  const files = readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort();
  if (!files.length) throw new Error(`no image in "${dir}" — pass one: node scripts/smoke.mjs <image>`);
  return join(dir, files[0]);
}

const scan = process.argv[2] || defaultScan();

// The API is per-identity now: every request carries the session cookie, and a
// run that never signs in just works as a guest with its own collection.
let cookie = '';
async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...opts,
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const pair = c.split(';')[0];
    if (pair.startsWith('mtg_session=')) cookie = pair;
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path} -> ${JSON.stringify(body || res.status)}`);
  return body;
}

const img = readFileSync(scan).toString('base64');
const pct = (v) => Math.round((v ?? 0) * 100) + '%';
const show = (e) => `${e.name} #${e.collector_number}`;

// Identify before touching anything — a guest is enough (it is what a browser
// gets on first load), and MTG_USER/MTG_PASS sign in to an account instead.
if (process.env.MTG_USER && process.env.MTG_PASS) {
  const login = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: process.env.MTG_USER, password: process.env.MTG_PASS }),
  });
  console.log('0) signed in as', login.user.username, '· collection', login.collection.rows, 'rows');
  if (login.merged) console.log('   merged a guest collection:', JSON.stringify(login.merged));
} else {
  const { user, collection } = await req('/api/auth/guest', { method: 'POST' });
  console.log('0) guest identity:', user.name, '· collection', collection.rows, 'rows');
  if (!user.isGuest) throw new Error('expected a guest identity when no credentials were given');
}

console.log('1) POST /api/detect (scan:', scan, ')');
const detect = await req('/api/detect', {
  method: 'POST',
  body: JSON.stringify({ image: img }),
});
console.log('   parsed:', JSON.stringify(detect.parsed));
console.log('   top candidate:', detect.candidates?.[0]
  ? `${detect.candidates[0].name} | ${detect.candidates[0].set_name} #${detect.candidates[0].collector_number}`
    + ` (${pct(detect.candidates[0].likelihood)} likely)`
  : 'none');
console.log('   candidate count:', detect.candidates?.length);
console.log('   autoAdded (only sent when asked for):', detect.autoAdded);

// Every response carries PaddleOCR's read: the words the overlay draws, the
// cleaned text the readout panel shows, and the pass timing. The old
// dual-engine keys (`ppocr` / `ppocrError`) are gone — PaddleOCR is the only
// engine now, so their presence would mean stale code is still running.
if (!Array.isArray(detect.words) || !detect.words.length) {
  throw new Error('words missing/empty — the overlay would draw nothing');
}
if (!detect.text) throw new Error('text missing — the readout panel would be empty');
if (detect.ms == null) throw new Error('ms missing — the readout panel cannot show timing');
if ('ppocr' in detect || 'ppocrError' in detect) {
  throw new Error('dual-engine keys still present — PaddleOCR is the only engine now');
}
console.log('   paddle:', detect.words.length, 'words in', Math.round(detect.ms), 'ms');

console.log('2) POST /api/detect { autoAdd: true } (best match added server-side)');
const scanResult = await req('/api/detect', {
  method: 'POST',
  body: JSON.stringify({ image: img, autoAdd: true }),
});
const auto = scanResult.autoAdded;
if (auto?.added) {
  if (!auto.entry?.id) throw new Error('autoAdded.entry.id missing — the UI could not remove/replace it');
  console.log('   added:', `${auto.candidate.name} | ${auto.candidate.set_name} #${auto.candidate.collector_number}`
    + ` (${pct(auto.likelihood)} likely) · collection entry #${auto.entry.id}`
    + ` ×${auto.entry.quantity ?? 1}` + (auto.newCopy === false ? ' [added a copy]' : ''));
} else {
  console.log('   not added:', auto?.reason ?? '(no autoAdded in the response)',
    auto?.threshold != null ? `(needs >= ${pct(auto.threshold)})` : '',
    auto?.candidate ? `· best guess ${auto.candidate.name} (${pct(auto.likelihood)})` : '');
}

console.log('3) GET /api/collection');
const list = await req('/api/collection');
console.log('   entries:', list.length, list.map(show).join(', '));

console.log('4) POST /api/collection (explicit add of the detected best match)');
const add = detect.candidates?.[0];
let addedId = null;
if (add) {
  const res = await req('/api/collection', { method: 'POST', body: JSON.stringify(add) });
  console.log('   ', res);
  if (res.addedCopies >= 1) addedId = res.entry?.id ?? null;
}

console.log('5) GET /api/collection');
console.log('   entries:', (await req('/api/collection')).map(show).join(', '));

// Foil is a manual flag (no automatic detection): the same printing owned as
// foil is a *separate row* with its own (foil) price, and the flip endpoint
// must merge it back when the finishes collide.
const foilUndo = []; // [{ id, n }] copies this section added, undone below
if (add) {
  console.log('6) POST /api/collection { foil: true } — same printing, foil copy');
  const foilAdd = await req('/api/collection', { method: 'POST', body: JSON.stringify({ ...add, foil: true }) });
  if (foilAdd.entry?.foil !== 1) throw new Error('foil add came back non-foil');
  const foilRowId = foilAdd.entry.id;
  const rows = (await req('/api/collection')).filter((e) => e.scryfall_id === add.scryfall_id);
  if (rows.length !== 2 || !rows.some((e) => e.foil === 1)) {
    throw new Error(`foil/non-foil copies must be 2 rows (one foil), got ${rows.length}`);
  }
  console.log('   foil row #' + foilRowId + ' · price USD ' + (foilAdd.entry.price_usd ?? '—') + ' (foil price when Scryfall has one)');

  console.log('7) POST /api/collection/' + foilRowId + '/foil { foil: false } — flip back, merges into the non-foil row');
  const flipped = await req('/api/collection/' + foilRowId + '/foil', { method: 'POST', body: JSON.stringify({ foil: false }) });
  if (flipped.entry?.foil !== 0) throw new Error('flip to non-foil did not stick');
  const after = (await req('/api/collection')).filter((e) => e.scryfall_id === add.scryfall_id);
  if (after.length !== 1) throw new Error(`flip-merge must collapse to 1 row, got ${after.length}`);
  console.log('   merged: 1 row #' + after[0].id + ', ×' + (after[0].quantity ?? '?') + ' copies');
  // The foil copy's 1 copy now lives on the merged row; undo it there (its id
  // may be the same as an id tracked below — the map sums per id either way).
  foilUndo.push({ id: after[0].id, n: 1 });
}

// Camera mode: the same card sitting under the camera must not be resolved (or
// added) again — this is the request the camera page makes every pace tick.
const cues = scanResult.parsed?.key || '';
console.log('8) POST /api/detect { autoAdd: true, ignoreCues:', JSON.stringify(cues), '} — same card, next frame');
const again = await req('/api/detect', {
  method: 'POST',
  body: JSON.stringify({ image: img, autoAdd: true, ignoreCues: cues }),
});
if (again.unchanged !== true || again.autoAdded?.reason !== 'same-card') {
  throw new Error('camera fast path did not trigger — a stationary card would re-hit Scryfall every frame');
}
console.log('   unchanged:', again.unchanged, '| autoAdded:', JSON.stringify(again.autoAdded));
console.log('   candidates:', again.candidates.length, '(empty on the fast path)');
console.log('   entries:', (await req('/api/collection')).length, '(unchanged)');

// Placed again later: with no ignoreCues this is simply a new scan, so another
// copy is added (duplicates live in `quantity`, one row per printing).
console.log('9) POST /api/detect { autoAdd: true } — card placed again');
const repl = await req('/api/detect', { method: 'POST', body: JSON.stringify({ image: img, autoAdd: true }) });
const readd = repl.autoAdded || {};
console.log('   added:', readd.added, '| newCopy:', readd.newCopy, '| entry #' + readd.entry?.id, '| ×' + (readd.entry?.quantity ?? '?'));
console.log('10) quantity check: the re-scan must NOT create a second row');
console.log('11) GET /api/collection (final)');
const finalList = await req('/api/collection');
console.log('   entries:', finalList.length);
if (readd.added && readd.entry) {
  const dupes = finalList.filter((e) => e.scryfall_id === readd.entry.scryfall_id);
  if (dupes.length !== 1) {
    throw new Error(`expected exactly 1 row for the re-scanned printing, got ${dupes.length} — duplicates must live in quantity`);
  }
}

// Cleanup: give back exactly the copies this run added (the pre-existing row,
// if any, keeps its own count). Each successful add was +1 copy — count them
// per id so a printing added by both the auto-add and the explicit POST gets
// decremented twice.
const undo = new Map();
for (const id of [
  auto?.added ? auto.entry?.id : null,
  addedId,
  readd?.added ? readd.entry?.id : null,
  ...foilUndo.map((f) => f.id), // each entry contributed 1 copy (counted here)
]) {
  if (id) undo.set(id, (undo.get(id) || 0) + 1);
}
for (const [id, n] of undo) {
  console.log(`12) POST /api/collection/${id}/decrement ×${n} (undo this run's copies)`);
  for (let i = 0; i < n; i++) {
    await req('/api/collection/' + id + '/decrement', { method: 'POST', body: JSON.stringify({ n: 1 }) });
  }
}
console.log('13) GET /api/collection (post-cleanup)');
console.log('   entries:', (await req('/api/collection')).length);

console.log('smoke test done.');