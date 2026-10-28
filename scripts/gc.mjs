// Housekeeping for the local database — the things that accumulate on their own
// while the app runs.
//
//   node scripts/gc.mjs                 # report what an orphan sweep would drop
//   node scripts/gc.mjs --orphans       # drop cards nobody owns (and their history)
//   node scripts/gc.mjs --dry-run       # only report, change nothing
//
// Importing src/db.js also runs the schema migrations, which is what folds away
// the user_id columns of a pre-accounts database.
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const sweepOrphans = process.argv.includes('--orphans');
const dryRun = process.argv.includes('--dry-run');

const db = await import('../src/db.js');
const dbPath = process.env.MTG_DB || join(root, 'data', 'mtg.db');

const size = db.collectionSize();
console.log(`database: ${relative(root, dbPath) || dbPath}`);
console.log(`collection: ${size.rows} rows, ${size.copies} copies`);

// Removing a collection row keeps the card so its price history survives an
// accidental delete — which means the `card` table grows forever. A card nobody
// owns can never be shown again, so sweeping it is safe; it is opt-in because
// the sweep also drops that card's price history.
const orphans = db.orphanCards();
if (!orphans.length) {
  console.log('no orphan card.');
} else if (!sweepOrphans) {
  console.log(`${orphans.length} card(s) nobody owns — run with --orphans to drop them.`);
} else if (dryRun) {
  console.log(`would remove ${orphans.length} orphan card(s) (dry run):`);
  for (const c of orphans.slice(0, 20)) console.log(`  - ${c.name} · ${c.set_code} ${c.collector_number}`);
  if (orphans.length > 20) console.log(`  … and ${orphans.length - 20} more`);
} else {
  const { removed, snapshots } = db.deleteOrphanCards();
  console.log(`removed ${removed} orphan card(s) · ${snapshots} price snapshot(s)`);
}
