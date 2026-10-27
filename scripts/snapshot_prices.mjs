// One-shot price snapshot for every card in the collection — the same job the
// server runs daily, exposed as a script for cron / Task Scheduler use.
//   node scripts/snapshot_prices.mjs      (or: npm run snapshot)
import { snapshotPrices } from '../src/prices.js';

const r = await snapshotPrices();
console.log(
  `snapshot: ${r.priced}/${r.cards} cards priced · ${r.written} rows written · total USD ${r.total.toFixed(2)}`
);
process.exit(0);
