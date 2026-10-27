// Diagnostic: OCR/detection report over the image corpus.
//   node scripts/debug.mjs --summary        every image in card scans/, compact table
//   node scripts/debug.mjs <image...>       detailed per-image report + crop JPEGs
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { detectCard } from '../src/detect.js';

const outDir = 'debug-out';
mkdirSync(outDir, { recursive: true });

const summary = process.argv.includes('--summary');
let files = process.argv.slice(2).filter((a) => a !== '--summary');
if (summary) {
  files = readdirSync('card scans')
    .filter((f) => /\.(png|jpe?g)$/i.test(f))
    .map((f) => `card scans/${f}`)
    .sort();
}
if (!files.length) {
  console.log('usage: node scripts/debug.mjs --summary | <image...>');
  process.exit(1);
}

const rows = [];
for (const f of files) {
  const r = await detectCard(readFileSync(f));
  const name = f.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  if (!summary && r.preview) writeFileSync(`${outDir}/${name}.jpg`, r.preview);
  const pct = (v) => (v == null ? 'n/a' : Math.round(v * 100) + '%');

  const cls = !r.top
    ? 'NONE'
    : r.parsed.setCode && r.parsed.collectorNumber
      ? 'EXACT'
      : r.parsed.setCode || r.parsed.collectorNumber
        ? 'PARTIAL'
        : 'NAME';
  const row = {
    file: name,
    cls,
    like: r.top ? Math.round(r.top.likelihood * 100) : 0,
    cues: `${r.parsed.setCode ?? '-'}/${r.parsed.collectorNumber ?? '-'}`,
    match: r.top ? `${r.top.name} ${r.top.set_code}/${r.top.collector_number}` : '-',
    words: r.words.length,
  };
  rows.push(row);
  console.log(
    `${String(rows.length).padStart(2)}/${files.length} ${cls.padEnd(7)} ${String(row.like).padStart(3)}%  ` +
      `cues ${row.cues.padEnd(9)} ${row.match}  <= ${name}`
  );
  if (!summary) {
    console.log('   rows:', JSON.stringify(r.parsed.rows.slice(0, 12)));
    console.log('   ocr :', r.text.replace(/\n+/g, ' | ').slice(0, 240));
  }
}

const tally = (pred) => rows.filter(pred).length;
const group = (prefix) => rows.filter((r) => r.file.startsWith(prefix));
const stat = (label, rs) => {
  const n = (cls) => rs.filter((r) => r.cls === cls).length;
  console.log(
    `${label}: ${rs.length} images | EXACT ${n('EXACT')} | PARTIAL ${n('PARTIAL')} | NAME ${n('NAME')} | NONE ${n('NONE')}` +
      ` | avg like ${rs.length ? Math.round(rs.reduce((a, b) => a + b.like, 0) / rs.length) : 0}%`
  );
};
console.log('');
stat('TOTAL  ', rows);
stat('scans  ', group('Scan_'));
stat('photos ', group('WIN_'));
console.log('photos with both cues:', tally((r) => r.file.startsWith('WIN_') && r.cls === 'EXACT'),
  '| photos identified at all:', tally((r) => r.file.startsWith('WIN_') && r.cls !== 'NONE'));

console.log('done.');
