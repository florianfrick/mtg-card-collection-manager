import { prepareScan, intoPreviewSpace } from './ocr.js';
import { parseOcr } from './matcher.js';
import { ppocrWords, ppocrStatus } from './ppocr.js';
import {
  namedFuzzy,
  bySetNumber,
  searchCards,
  printingsOf,
  knownSets,
  toPrinting,
} from './scryfall.js';

// How much a match is worth depending on how we found it (see likelihoods()).
// 'set-number-weak' = a validated set+number pair whose name row could not be
// read well enough to confirm (photos). It is still the exact printing, but the
// total stays lower because so little else backed the match.
const PATH_CONFIDENCE = { 'set-number': 0.98, 'set-number-weak': 0.52, fuzzy: 0.8, search: 0.55 };

/**
 * Full detection pipeline: OCR -> parse cues -> resolve to a printing -> score
 * the candidate printings so the UI can show how sure we are.
 *
 * opts.ignoreKey: a `parsed.key` the caller has already handled (camera mode).
 * When OCR reads those same cues again nothing about the card changed, so
 * resolution is skipped and `unchanged` comes back true with an empty
 * top/printings — this is what keeps a camera polling one stationary card from
 * re-hitting Scryfall (see src/index.js).
 *
 * PP-OCR (PaddleOCR) is the only OCR engine: it reads the uploaded bytes as-is
 * (no preprocessing, see src/ocr.js) and a missing Python environment is a hard
 * failure — `detectCard` throws `ppocrStatus()`'s reason instead of degrading.
 *
 * Returns:
 *   text      OCR text with art/noise rows filtered out (what the UI shows)
 *   parsed    { setCode, collectorNumber, nameCandidates, rows, marks, key }
 *   top       the best-guess printing, carrying a `likelihood` (0..1), or null
 *   printings every other printing of the matched name (for the confirm step),
 *             each also carrying a `likelihood`
 *   identified { name, confidence, printings } — which *card* was recognized
 *             and how sure we are of that, kept apart from the per-printing
 *             `likelihood` above (a photo gives us the card, not the printing)
 *   preview   colour JPEG (Buffer) of the cropped card, for the UI
 *   words     every recognized word with its box (preview space) and confidence
 *   ms        how long PP-OCR took on this image
 *   ocrSize   { width, height } of the card preview (scales the boxes)
 *   legibility { textPx, minTextPx, ok } — height of the card's footer text in
 *             source pixels. `ok: false` means the cues are too small in the
 *             image to be readable, so a miss here is a framing problem, not a
 *             matching one (see measureLegibility in src/ocr.js)
 *   unchanged true when the cues matched `ignoreKey`, so nothing was resolved
 */
export async function detectCard(imageBuffer, { ignoreKey = '' } = {}) {
  const prep = await prepareScan(imageBuffer);
  const sets = await knownSets();
  // One OCR pass over the image exactly as uploaded; the word boxes come back in
  // the original's coordinates, so they are moved onto the card preview (and
  // parsed there, which is the space the cue bands are relative to). The sidecar
  // answers one request at a time, so concurrent /api/detect calls are
  // serialized for free (see src/ppocr.js).
  const read = await ppocrWords(prep.buffer);
  if (!read) {
    // The only engine, so this is fatal — the caller (route/CLI) reports it.
    const reason = ppocrStatus().reason || 'PP-OCR is unavailable';
    throw new Error(reason.includes('tools/ppocr/setup.md') ? reason : `${reason} (see tools/ppocr/setup.md)`);
  }
  const words = intoPreviewSpace(read.words, prep.origin);
  const parsed = parseOcr(words, sets);
  const ms = read.ms ?? null;
  // What the engine literally saw, for when the parser keeps nothing (all rows
  // were art/noise): the UI still has something to show.
  const rawText = words.map((w) => w.text).join(' ');

  // Camera fast path: this is the card the caller already resolved, so skip all
  // lookups (OCR was the only cost of this frame) and hand back no candidates.
  if (ignoreKey && parsed.key && parsed.key === ignoreKey) {
    return {
      text: parsed.rows.join('\n') || rawText,
      parsed,
      top: null,
      printings: [],
      preview: prep.preview,
      words,
      ms,
      ocrSize: prep.ocrSize,
      legibility: prep.legibility,
      unchanged: true,
    };
  }

  const ocrWords = new Set(parsed.rows.join(' ').toLowerCase().match(/[a-z']+/g) || []);
  const resolved = await resolve(parsed, ocrWords);

  let top = null;
  let printings = [];
  let identified = null;
  if (resolved) {
    // Candidate list = the matched printing first, then every other printing of
    // that name, de-duplicated and scored with a `likelihood`.
    const list = [];
    const seen = new Set();
    const others = (await printingsOf(resolved.printing.name)).map((p) => ({ ...p }));
    for (const c of [resolved.printing, ...others]) {
      if (!c || seen.has(c.scryfall_id)) continue;
      seen.add(c.scryfall_id);
      list.push(c);
    }
    const coverage = nameCoverage(resolved.printing.name, ocrWords);
    const scores = likelihoods(list, parsed, resolved.path, coverage);
    for (const c of list) c.likelihood = scores.get(c.scryfall_id);
    top = list[0];
    printings = list.slice(1);
    // The card and the printing are two different questions, and on a photo only
    // the first can be answered: the title identifies the card, while which
    // printing it is needs the footer (a set code + collector number too small to
    // read on a 720p frame) or a pick from the list. Reporting both as one number
    // makes a confidently read card look like a coin flip just because it has
    // twenty printings, so they are reported separately: `confidence` is how sure
    // we are of the *card*, and the per-candidate `likelihood` stays the relative
    // "which printing" score for the picker.
    identified = {
      name: resolved.printing.name,
      confidence: Math.round(cardConfidence(resolved.path, coverage) * 100) / 100,
      printings: list.length,
    };
  }

  // The parser drops the art (where the engine hallucinates), so the cleaned
  // rows make a better report than the raw OCR text.
  return { text: parsed.rows.join('\n') || rawText, parsed, top, printings, identified, preview: prep.preview, words, ms, ocrSize: prep.ocrSize, legibility: prep.legibility, unchanged: false };
}

/**
 * Resolve parsed cues to a printing, in order:
 *   1. exact printing via set code + collector number (Scryfall validates both)
 *   2. fuzzy name match on the top OCR rows
 *   3. text search from the top-row words
 * ...then prefer the printing whose set / collector number matches the cues.
 * The name-based paths (2, 3) require the name to be legible in the OCR, so a
 * garbage cue can never hijack the match. Step 1's exact pair stands on its own
 * when the set code is a real set (`parsed.setValidated`) and the name does not
 * resolve to a *different* real card: a photographed footer often reads fine
 * while the name row does not, and missing/weak legibility then lowers the
 * confidence (see likelihoods()) rather than losing the card. Returns
 * { printing, path } (path = which step won, for the likelihood) or null.
 */
async function resolve(parsed, ocrWords) {
  const ok = (card) => card && nameCoverage(card.name, ocrWords) >= 0.6;

  // 1) Exact printing via set code + collector number.
  if (parsed.setCode && parsed.collectorNumber) {
    const c = await bySetNumber(parsed.setCode, parsed.collectorNumber);
    if (ok(c)) {
      const printing = toPrinting(c);
      if (printing) return { printing, path: 'set-number' };
    }
    // The pair is a real set with a real number in it, but the name is not
    // legible enough to confirm: accept it at a lower confidence, unless the
    // name candidates resolve to a different real card (then the pair is most
    // likely a misread neighbour line, and it loses). A 'frag' number ("29" of
    // a blurred "291") is the parser's weakest reading, so it additionally
    // needs partial agreement from the name — a lone fragment must not pin a
    // printing on its own. The c && test comes first on purpose: bySetNumber
    // returns null for a pair Scryfall does not have, and reading c.name before
    // that check used to throw on exactly the garbled photos that reach here.
    if (c && parsed.setValidated && (parsed.numForm !== 'frag' || nameCoverage(c.name, ocrWords) >= 0.34)) {
      let clash = false;
      for (const name of parsed.nameCandidates.slice(0, 3)) {
        if (!name) continue;
        const other = await namedFuzzy(name);
        if (other && other.id !== c.id && ok(other)) { clash = true; break; }
      }
      if (!clash) {
        const printing = toPrinting(c);
        if (printing) return { printing, path: 'set-number-weak' };
      }
    }
  }

  // 2) Fuzzy match on name cues extracted from the OCR.
  let card = null;
  let path = null;
  for (const name of parsed.nameCandidates) {
    const c = await namedFuzzy(name);
    if (ok(c)) {
      card = c;
      path = 'fuzzy';
      break;
    }
  }

  // 3) Text-search fallback for names OCR splits messily.
  if (!card) {
    const query = (parsed.rows.slice(0, 3).join(' ').match(/[a-z]{3,}/gi) || []).join(' ');
    if (query) {
      card = (await searchCards(query)).find(ok) ?? null;
      if (card) path = 'search';
    }
  }
  if (!card) return null;

  // 4) Prefer the printing in the parsed set / with the parsed collector number.
  if (parsed.setCode || parsed.collectorNumber) {
    const set = parsed.setCode?.toLowerCase();
    const prints = await printingsOf(card.name);
    const sameSet = (p) => set && p.set_code === set;
    const sameNum = (p) => parsed.collectorNumber && p.collector_number === parsed.collectorNumber;
    const hit = prints.find((p) => sameSet(p) && sameNum(p)) ?? prints.find(sameSet) ?? prints.find(sameNum);
    if (hit) return { printing: hit, path };
  }
  const printing = toPrinting(card);
  return printing ? { printing, path } : null;
}

/**
 * How sure we are of the *card* (not the printing), from which step matched it
 * and how legible the name was. A validated set code + collector number is a
 * complete identification, so it is near-certain; a fuzzy name match is only as
 * good as the title read, which is why this is kept apart from the per-candidate
 * printing likelihood.
 */
function cardConfidence(path, coverage) {
  const base = path === 'set-number' || path === 'set-number-weak' ? 0.97 : 0.6 + 0.35 * coverage;
  return Math.max(0, Math.min(1, base));
}

/** Fraction of a card name's words that are legible in the OCR text (0..1). */
function nameCoverage(name, ocrWords) {
  const big = (name.toLowerCase().match(/[a-z']+/g) || []).filter((w) => w.length >= 3);
  if (!big.length) return 0;
  return big.filter((w) => ocrWords.has(w)).length / big.length;
}

/**
 * Likelihood per candidate printing (0..1), built from the evidence we have:
 *   - which step found the card: a validated set+number pair pins the *exact*
 *     version, so it outweighs even a clean name read that is spread thinly
 *     over many printings ('set-number-weak' from photos included),
 *   - how legible the matched name is,
 *   - how well each printing agrees with the parsed set / collector number.
 * Weights are normalized over the candidates, so this is a relative confidence
 * for "which version is it?" — not a calibrated probability. The total stays
 * below 1 when the name itself is uncertain (the remainder = "something else").
 */
function likelihoods(cands, parsed, path, coverage) {
  const nameConf = (PATH_CONFIDENCE[path] ?? 0.5) * (0.7 + 0.3 * coverage);
  if (path === 'set-number' || path === 'set-number-weak') {
    // The resolved printing IS the version the cues picked (Scryfall validated
    // the pair itself), so it keeps the full name confidence undiluted and
    // stays first. Only the doubt is split over the alternates, by cue
    // agreement, for the manual picker. Without this, a strong name-only read
    // on a card with hundreds of printings outranks the exact printing its own
    // footer identified.
    const weights = cands.slice(1).map((c) => printingWeight(c, parsed));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const rest = 1 - nameConf;
    const out = new Map([[cands[0].scryfall_id, nameConf]]);
    cands.slice(1).forEach((c, i) => out.set(c.scryfall_id, rest * (weights[i] / total)));
    return out;
  }
  const hasCues = !!(parsed.setCode || parsed.collectorNumber);
  const weights = cands.map((c) => (hasCues ? printingWeight(c, parsed) : 1));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  return new Map(cands.map((c, i) => [c.scryfall_id, nameConf * (weights[i] / total)]));
}

/** Relative weight of one printing given the parsed set / collector number. */
function printingWeight(p, parsed) {
  const setHit = !!parsed.setCode && p.set_code === parsed.setCode.toLowerCase();
  const numHit = !!parsed.collectorNumber && p.collector_number === parsed.collectorNumber;
  if (setHit && numHit) return 1; // the printed set + number, validated by Scryfall
  if (setHit) return 0.06; // right set, number misread
  if (numHit) return 0.04; // right number, set misread
  return 0.006; // another version of the same card
}
