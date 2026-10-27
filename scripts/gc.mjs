// Housekeeping for the local database — the things that accumulate on their own
// while the app runs.
//
//   node scripts/gc.mjs                 # guests that never collected a card
//   node scripts/gc.mjs --all-guests    # every guest identity (accounts are kept)
//   node scripts/gc.mjs --empty-accounts # accounts with an empty collection too
//   node scripts/gc.mjs --dry-run       # only report, change nothing
//
// Importing src/db.js also runs the schema migrations, which is what drops the
// dead `collection_entry` table of a pre-normalization database.
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const allGuests = process.argv.includes('--all-guests');
const emptyAccounts = process.argv.includes('--empty-accounts');
const dryRun = process.argv.includes('--dry-run');

const db = await import('../src/db.js');
const dbPath = process.env.MTG_DB || join(root, 'data', 'mtg.db');

const before = db.guestInventory();
const users = db.listUsers();
const accounts = users.filter((u) => Number(u.is_guest) !== 1);

console.log(`database: ${relative(root, dbPath) || dbPath}`);
console.log(`users: ${users.length} (${accounts.length} accounts, ${before.length} guests)`);
if (before.length) {
  const withCards = before.filter((g) => g.rows > 0);
  console.log(`guests holding cards: ${withCards.length}${withCards.length ? ' — ' + withCards.map((g) => `${g.name} (${g.copies} copies)`).join(', ') : ''}`);
}

const doomed = before.filter((g) => allGuests || g.rows === 0);
if (!doomed.length) {
  console.log('no guest to remove.');
} else if (dryRun) {
  console.log(`would remove ${doomed.length} guest ${doomed.length === 1 ? 'identity' : 'identities'} (dry run):`);
  for (const g of doomed) console.log(`  - ${g.name} · ${g.rows} rows · created ${g.created_at}`);
} else {
  const { removed, kept } = db.deleteGuests({ includeWithCards: allGuests });
  console.log(`removed ${removed} guest ${removed === 1 ? 'identity' : 'identities'} · ${kept} left`);
}

// Accounts are only ever touched on request, and only when they hold nothing:
// an empty account is either a test sign-up or one someone gave up on.
const staleAccounts = emptyAccounts ? accounts.filter((a) => db.collectionSize(a.id).rows === 0) : [];
if (staleAccounts.length) {
  if (dryRun) {
    console.log(`would remove ${staleAccounts.length} empty account(s) (dry run): ${staleAccounts.map((a) => a.username || a.name).join(', ')}`);
  } else {
    for (const a of staleAccounts) db.deleteUser(a.id);
    console.log(`removed ${staleAccounts.length} empty account(s): ${staleAccounts.map((a) => a.username || a.name).join(', ')}`);
  }
} else if (emptyAccounts) {
  console.log('no empty account to remove.');
}

const keptAccounts = db.listUsers().filter((u) => Number(u.is_guest) !== 1);
console.log(
  'collection rows: ' +
    (keptAccounts.map((a) => `${a.username || a.name}: ${db.collectionSize(a.id).rows}`).join(', ') || 'none')
);
