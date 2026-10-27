// CLI: run detection on one or more scan files.
//   node scripts/detect.mjs "card scans/Scan.png" "card scans/Scan (2).png"
import { readFileSync } from 'node:fs';
import { detectCard } from '../src/detect.js';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.log('usage: node scripts/detect.mjs <image-file> [more-images...]');
  process.exit(1);
}

/** likelihood (0..1) as a display percentage */
const pct = (v) => (v == null ? 'n/a' : Math.round(v * 100) + '%');

for (const f of files) {
  console.log('\n================================================================');
  console.log('FILE:', f);
  console.log('================================================================');
  const buf = readFileSync(f);
  const { text, parsed, top, printings } = await detectCard(buf);

  console.log('parsed: setCode=%s collectorNumber=%s', parsed.setCode, parsed.collectorNumber);
  console.log('nameCandidates:', parsed.nameCandidates);

  if (top) {
    console.log('TOP MATCH :', top.name, '|', top.set_name, '#' + top.collector_number, '|', pct(top.likelihood), 'likely');
    console.log('            USD', top.prices.usd ?? 'n/a', '| EUR', top.prices.eur ?? 'n/a');
    console.log('            image:', top.image_url);
  } else {
    console.log('TOP MATCH : none');
  }

  console.log('printings of matched name (confirm step):');
  for (const p of printings.slice(0, 10)) {
    console.log('   -', p.name, '|', p.set_name, '#' + p.collector_number, '| USD', p.prices.usd ?? 'n/a', '|', pct(p.likelihood), 'likely');
  }

  console.log('OCR text (first 500 chars):');
  console.log(text.replace(/\n+/g, ' ').slice(0, 500));
}

console.log('\ndone.');