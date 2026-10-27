// Hot backup of the collection database.
//
//   node scripts/backup.mjs              # data/backups/mtg-YYYY-MM-DD.db
//   node scripts/backup.mjs out.db       # a specific path
//
// Uses SQLite's VACUUM INTO, so the copy is consistent even while the server is
// running and comes out defragmented. Old backups are pruned to the newest 14.
// Point a Windows Scheduled Task / cron entry at `npm run backup` and a bad day
// costs one day of scans instead of the whole collection.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const KEEP = 14;

const db = await import('../src/db.js');
const dbPath = process.env.MTG_DB || join(root, 'data', 'mtg.db');
const dir = process.env.MTG_BACKUP_DIR || join(root, 'data', 'backups');

const stamp = new Date().toISOString().slice(0, 10);
const target = process.argv[2] || join(dir, `mtg-${stamp}.db`);

if (existsSync(target)) {
  console.error(`backup: ${relative(root, target) || target} already exists — keeping the first one of the day`);
  process.exit(1);
}

mkdirSync(dirname(target), { recursive: true });
db.backupTo(target);

const kb = Math.round(statSync(target).size / 1024);
console.log(`backup: ${relative(root, dbPath) || dbPath} -> ${relative(root, target) || target} (${kb} kB)`);

// Prune: newest KEEP files in the backup directory, oldest first.
if (dirname(target) === dir) {
  const old = readdirSync(dir)
    .filter((f) => /^mtg-.*\.db$/.test(f) && join(dir, f) !== target)
    .sort()
    .slice(0, -KEEP);
  for (const f of old) {
    rmSync(join(dir, f), { force: true });
    console.log(`pruned: ${f}`);
  }
}
