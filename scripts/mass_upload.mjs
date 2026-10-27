// Mass batch: optionally reset the local DB, run every image in card scans/ through the
// detection pipeline, auto-add the matches, and write a report to
// mass_upload_results.md.
//   node scripts/mass_upload.mjs [--reset]   (or: npm run mass [-- --reset])
//
// The DB reset is OPT-IN: by default the existing data/mtg.db is kept and new
// matches are appended (cards already owned are counted as duplicates). Pass
// --reset (or set MTG_RESET=1) to wipe it first for a clean run.
//
// Auto-add uses the same rule as the server (src/index.js): the top candidate
// is stored when its likelihood clears MTG_AUTO_ADD_MIN (default 0.5).
//
// Scryfall rate limiting: every lookup goes through src/scryfall.js, which
// already spaces requests 250ms apart and waits out 429s (2/6/15s retry
// ladder). On top of that this batch pauses MTG_BATCH_DELAY_MS (default 500)
// between images, so a run never pushes the API harder than a human-paced
// session — OCR alone takes seconds per image anyway.
//
// Env:
//   MTG_AUTO_ADD_MIN    minimum likelihood to add (default 0.5, as the server)
//   MTG_BATCH_DELAY_MS  pause between images (default 500; 0 disables)
//   MTG_DB              database file (same override src/db.js honours)
//   MTG_RESET           1/true/yes to wipe the DB before running (default: keep it)
//   MTG_RESULTS         report path (default <repo>/mass_upload_results.md)
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, numOrNull } from '../src/util.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const SCANS_DIR = join(root, 'card scans');
const RESULTS_FILE = process.env.MTG_RESULTS || join(root, 'mass_upload_results.md');
const AUTO_ADD_MIN = numOrNull(process.env.MTG_AUTO_ADD_MIN) ?? 0.5;
const BATCH_DELAY_MS = numOrNull(process.env.MTG_BATCH_DELAY_MS) ?? 500;
// Reset is opt-in: --reset flag or MTG_RESET=1/true/yes (default: keep existing rows).
const RESET_DB =
  process.argv.includes('--reset') ||
  ['1', 'true', 'yes'].includes(String(process.env.MTG_RESET ?? '').toLowerCase());

// ---- 1. Optionally reset the database ---------------------------------------
// When asked, delete the file BEFORE importing anything that opens it:
// node:sqlite keeps the handle for the life of the process, and src/db.js
// re-creates the schema on import, so a fresh file = a fresh, empty collection.
// Without a reset the existing rows stay; duplicates are detected via the
// (user, printing, finish) UNIQUE constraint in addEntry().
const dbPath = process.env.MTG_DB || join(root, 'data', 'mtg.db');
if (RESET_DB) {
  rmSync(dbPath, { force: true });
  console.log(`reset: removed ${relative(root, dbPath) || dbPath} (recreated empty on import)`);
} else {
  console.log(`reset: skipped — keeping ${relative(root, dbPath) || dbPath} (pass --reset or MTG_RESET=1 to wipe it)`);
}

// Imported after the optional reset (see above) — detect.js itself never touches the DB.
const { detectCard } = await import('../src/detect.js');
const { addEntry, listEntries, DEFAULT_USER_ID } = await import('../src/db.js');
// Cards belong to an account. A database without one (say: a --reset run on a
// fresh install) is not something this batch can invent — sign up first.
if (DEFAULT_USER_ID == null) {
  console.error('no account in the database — create one (sign up) before mass-uploading');
  process.exit(1);
}

// ---- 2. Collect the corpus -------------------------------------------------
const files = readdirSync(SCANS_DIR)
  .filter((f) => /\.(png|jpe?g)$/i.test(f))
  .sort();
if (!files.length) {
  console.error(`no images found in ${SCANS_DIR}`);
  process.exit(1);
}
const scans = files.filter((f) => /^Scan_/i.test(f)).length;
console.log(
  `running ${files.length} images (${scans} scans, ${files.length - scans} photos) — ` +
    `auto-add >= ${Math.round(AUTO_ADD_MIN * 100)}%, ${BATCH_DELAY_MS}ms between images\n`
);

// ---- 3. Detect + auto-add --------------------------------------------------
const pct = (v) => (v == null ? 'n/a' : Math.round(v * 100) + '%');
const startedAt = Date.now();
const rows = [];

for (let i = 0; i < files.length; i++) {
  const file = files[i];
  const row = { file };
  try {
    const r = await detectCard(readFileSync(join(SCANS_DIR, file)));
    row.ms = r.ms;
    row.cues = `${r.parsed.setCode ?? '-'}/${r.parsed.collectorNumber ?? '-'}`;
    if (!r.top) {
      row.status = 'no-match';
    } else {
      row.name = r.top.name;
      row.set_code = r.top.set_code;
      row.set_name = r.top.set_name;
      row.collector_number = r.top.collector_number;
      row.likelihood = r.top.likelihood ?? 0;
      row.confidence = r.identified?.confidence ?? null;
      row.price_usd = r.top.prices?.usd ?? null;
      if (row.likelihood < AUTO_ADD_MIN) {
        row.status = 'low-likelihood';
        row.reason = `best candidate ${pct(row.likelihood)} < ${pct(AUTO_ADD_MIN)} threshold`;
      } else {
        // Same row mapping as entryFromBody() in src/index.js.
        const { newCopy } = addEntry({
          scryfall_id: r.top.scryfall_id,
          name: r.top.name,
          set_name: r.top.set_name,
          set_code: r.top.set_code,
          collector_number: r.top.collector_number,
          image_url: r.top.image_url,
          price_usd: r.top.prices?.usd ?? null,
        });
        row.status = newCopy ? 'added' : 'duplicate';
      }
    }
  } catch (e) {
    row.status = 'error';
    row.error = String(e?.message || e);
  }
  rows.push(row);

  const tag = { added: 'ADDED', duplicate: 'DUP', 'low-likelihood': 'LOW ', 'no-match': 'NONE', error: 'ERROR' }[row.status] ?? row.status;
  const detail = row.name
    ? `${row.name} | ${row.set_code}/${row.collector_number} | ${pct(row.likelihood)}`
    : row.reason || row.error || '';
  console.log(`[${String(i + 1).padStart(2)}/${files.length}] ${tag.padEnd(5)} ${detail}  <= ${row.file}`);
  if (BATCH_DELAY_MS > 0 && i < files.length - 1) await sleep(BATCH_DELAY_MS);
}

// ---- 4. Report -------------------------------------------------------------
const byStatus = (s) => rows.filter((r) => r.status === s);
const added = byStatus('added');
const dups = byStatus('duplicate');
const low = byStatus('low-likelihood');
const none = byStatus('no-match');
const errs = byStatus('error');
const matched = rows.filter((r) => r.name); // any top candidate, added or not
const avg = (list) =>
  list.length ? Math.round((list.reduce((a, r) => a + (r.likelihood ?? 0), 0) / list.length) * 100) : 0;
const dur = Math.round((Date.now() - startedAt) / 1000);
const durStr = `${Math.floor(dur / 60)}m ${dur % 60}s`;
const entryRows = listEntries();
const md = (s) => String(s ?? '').replace(/\|/g, '\\|');
const fileLink = (f) => `\`card scans/${f}\``;

const lines = [];
lines.push('# Mass upload results');
lines.push('');
lines.push(`- Generated: ${new Date().toISOString()}`);
lines.push(`- Corpus: \`card scans/\` — ${rows.length} images (${scans} scans, ${rows.length - scans} photos)`);
lines.push(
  RESET_DB
    ? '- Database: `data/mtg.db` — **reset to empty before this run**'
    : '- Database: `data/mtg.db` — **not reset; existing rows kept**'
);
lines.push(`- Auto-add rule: top candidate added when its likelihood is >= ${pct(AUTO_ADD_MIN)} (same rule as the server, \`MTG_AUTO_ADD_MIN\`)`);
lines.push(`- Rate limiting: every Scryfall lookup went through \`src/scryfall.js\` (250 ms spacing, 429 retry ladder 2/6/15 s) plus ${BATCH_DELAY_MS} ms between images`);
lines.push(`- Duration: ${durStr}`);
lines.push('');
lines.push('## Summary stats');
lines.push('');
lines.push('| metric | value |');
lines.push('|---|---:|');
lines.push(`| images processed | ${rows.length} |`);
lines.push(`| images that found a match | ${matched.length} |`);
lines.push(`| **cards added (new collection rows)** | **${added.length}** |`);
lines.push(`| duplicates (same printing already owned) | ${dups.length} |`);
lines.push(`| matched but below threshold (not added) | ${low.length} |`);
lines.push(`| **images that failed to find a match** | **${none.length}** |`);
lines.push(`| errors | ${errs.length} |`);
lines.push(`| collection rows after run | ${entryRows.length} |`);
lines.push(`| distinct cards in collection | ${new Set(entryRows.map((e) => e.name)).size} |`);
lines.push(`| avg certainty of added cards | ${avg(added)}% |`);
if (matched.length) lines.push(`| avg certainty of all matches | ${avg(matched)}% |`);
lines.push('');
lines.push(`## Cards added with percent certainty (${added.length})`);
lines.push('');
if (added.length) {
  lines.push('| # | image | card | set | collector | certainty | card confidence | USD |');
  lines.push('|--:|---|---|---|--:|--:|--:|--:|');
  added.forEach((r, i) => {
    lines.push(
      `| ${i + 1} | ${fileLink(r.file)} | ${md(r.name)} | ${md(r.set_name)} (\`${r.set_code}\`) | ${r.collector_number} | ${pct(r.likelihood)} | ${pct(r.confidence)} | ${r.price_usd ?? 'n/a'} |`
    );
  });
} else {
  lines.push('_none_');
}
lines.push('');

lines.push(`## Duplicates — same printing already in the collection (${dups.length})`);
lines.push('');
if (dups.length) {
  lines.push('| image | card | set | collector | certainty |');
  lines.push('|---|---|---|--:|--:|');
  for (const r of dups) {
    lines.push(`| ${fileLink(r.file)} | ${md(r.name)} | ${md(r.set_name)} (\`${r.set_code}\`) | ${r.collector_number} | ${pct(r.likelihood)} |`);
  }
} else {
  lines.push('_none_');
}
lines.push('');

lines.push(`## Matched but not added — below ${pct(AUTO_ADD_MIN)} threshold (${low.length})`);
lines.push('');
if (low.length) {
  lines.push('| image | best guess | set | collector | certainty |');
  lines.push('|---|---|---|--:|--:|');
  for (const r of low) {
    lines.push(`| ${fileLink(r.file)} | ${md(r.name)} | ${md(r.set_name)} (\`${r.set_code}\`) | ${r.collector_number} | ${pct(r.likelihood)} |`);
  }
} else {
  lines.push('_none_');
}
lines.push('');

lines.push(`## Images that failed to find a match (${none.length})`);
lines.push('');
if (none.length) {
  lines.push('| image | OCR cues read (set/collector) |');
  lines.push('|---|---|');
  for (const r of none) lines.push(`| ${fileLink(r.file)} | ${r.cues ?? '-'} |`);
} else {
  lines.push('_none_');
}
lines.push('');

if (errs.length) {
  lines.push(`## Errors (${errs.length})`);
  lines.push('');
  lines.push('| image | error |');
  lines.push('|---|---|');
  for (const r of errs) lines.push(`| ${fileLink(r.file)} | ${md(r.error)} |`);
  lines.push('');
}

writeFileSync(RESULTS_FILE, lines.join('\n'));
console.log(`\nsummary: ${rows.length} processed | ${added.length} added | ${dups.length} dup | ${low.length} below threshold | ${none.length} no match | ${errs.length} errors`);
console.log(`collection rows: ${entryRows.length} | duration: ${durStr}`);
console.log(`report: ${RESULTS_FILE}`);

// The PP-OCR sidecar's open pipes keep the event loop alive forever (it only
// exits when its stdin closes), so a finished batch would otherwise hang.
// Everything above is synchronous through writeFileSync — nothing is pending.
process.exit(errs.length ? 1 : 0);


