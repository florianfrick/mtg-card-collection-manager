// ---------------------------------------------------------------------------
// Parse OCR word boxes into detection cues:
//   - set code + collector number (bottom-left of the card: "115/280 R" / "ZNR • EN")
//   - candidate card-name lines (the name is the top legible text row)
// ---------------------------------------------------------------------------

/** Group words into visual rows, top to bottom. */
function clusterRows(words) {
  const ws = words.filter((w) => w.conf > 0 && (w.text || '').trim());
  if (!ws.length) return [];
  const heights = ws.map((w) => (w.y1 - w.y0) || 4);
  const med = heights.slice().sort((a, b) => a - b)[heights.length >> 1] || 4;
  const tol = Math.max(2, med * 0.5);
  const rows = [];
  for (const w of ws.slice().sort((a, b) => a.y0 - b.y0)) {
    let row = rows.find((r) => Math.abs(r.y - w.y0) <= tol);
    if (!row) rows.push((row = { y: w.y0, items: [] }));
    row.items.push(w);
  }
  return rows
    .map((r) => ({
      y: r.y,
      conf: Math.max(...r.items.map((i) => i.conf)),
      items: r.items.slice().sort((a, b) => a.x0 - b.x0),
      text: r.items.slice().sort((a, b) => a.x0 - b.x0).map((i) => i.text).join(' '),
    }))
    .sort((a, b) => a.y - b.y);
}

/**
 * Cheap identity of the card in front of the camera: only the cues OCR read —
 * "SET:number" when both were found, else the leading name guess. A camera
 * client sends it back with its next frame, so the server can tell "same card,
 * nothing changed" (skip resolution -> no Scryfall calls) from "new card". The
 * key never depends on the image itself, so the same printing read twice from
 * slightly different angles gives the same key.
 */
function cuesKey(setCode, collectorNumber, nameCandidates) {
  if (setCode && collectorNumber) return `${setCode}:${collectorNumber}`;
  const name = (nameCandidates[0] || '')
    .toLowerCase()
    .replace(/[^a-z' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return name ? `name:${name}` : '';
}

/**
 * knownSets: Set of Scryfall set codes (uppercase), or null when unavailable.
 * Returns { setCode, collectorNumber, nameCandidates, rows, marks, key,
 *           setValidated, numForm }, where `key` is the cheap camera identity
 * (see cuesKey()), `setValidated` says the code is on Scryfall's set list (not
 * just something next to "EN"), and `numForm` says how self-describing the
 * number was: 'slash' ("115/280"), 'bare' (>= 3 digits, alternate-art style),
 * 'frag' (a short fragment that could be half a misread).
 */
export function parseOcr(words, knownSets) {
  const rows = clusterRows(words);
  const live = words.filter((w) => w.conf > 0 && (w.text || '').trim());

  // ---- Bottom band: the collector line sits right above the set/language line ----
  const maxY = live.length ? Math.max(...live.map((w) => w.y1)) : 0;
  const maxX = live.length ? Math.max(...live.map((w) => w.x1)) : 1;

  // ---- Art filter: OCR engines hallucinate words in the card's art, and the
  // art is never needed for detection. Keep only the top rows (title/name —
  // including junk OCR puts just above it) and the footer rows (collector
  // number, set code, copyright); drop everything in between. conf >= 70
  // additionally kills low-confidence noise anywhere on the card.
  //
  // The band cutoffs are fractions of the text height (with floors), not fixed
  // pixels, so a card of any size lands in the same bands: a flatbed scan puts
  // the card at ~1100px, a camera photo at ~700px, and a full-resolution page
  // scan at ~3200px. (They are also relative to the text extent, so the whole
  // image around the card does not matter — see intoPreviewSpace in ocr.js.)
  const nameBand = Math.max(50, 0.08 * maxY);       // (was 90px at ~1100px tall)
  const footBand = Math.max(90, 0.135 * maxY);      // (was 150px)
  const footerTop = maxY - Math.max(60, 0.09 * maxY); // collector + set line (was maxY - 100px)
  // The name row is exempt from the conf >= 70 filter further down (a photo's
  // title is often read weakly, and it is the only cue we have), but the row
  // that *locates* the name band is not: a confident-looking hallucination in
  // the art or the frame sits above the name, and anchoring the band on it
  // captures that junk instead of the title.
  const nameTop = (rows.find((r) => r.conf >= 70 && (r.text.match(/[A-Za-z]/g) || []).length >= 2) ?? rows[0])?.y ?? 0;
  let kept = rows.filter((r) => r.conf >= 70 && !(r.y > nameTop + nameBand && r.y < maxY - footBand));
  if (!kept.length) kept = rows; // hopeless scan: fall back to everything
  const band = live.filter((w) => w.y0 >= footerTop);
  const onLeft = (w) => w.x0 < maxX * 0.45; // power/toughness lives bottom-right

  // The engine can glue footer pieces together on photos ("KHM-EN", "071/285C"), so
  // match against the punctuation-split segments too, with their x range spread
  // over the original token (the set/EN adjacency check below needs positions).
  const segs = [...band];
  for (const w of band) {
    const parts = w.text.split(/[^A-Za-z0-9]+/).filter((p) => p && p !== w.text);
    if (!parts.length) continue;
    const span = (w.x1 - w.x0) / parts.length;
    parts.forEach((p, i) =>
      segs.push({ ...w, text: p, x0: w.x0 + i * span, x1: w.x0 + (i + 1) * span })
    );
  }

  // Collector number: "115/280" (take the numerator), else a bare token like
  // "0190". Leading zeros are stripped because Scryfall stores "52", not "052".
  // Photographic OCR confuses digits with look-alike letters (O/0, l/1, S/5),
  // so normalize before matching.
  const digits = (s) =>
    s.replace(/[OoDQ]/g, '0').replace(/[Ili|]/g, '1').replace(/[Ss]/g, '5').replace(/[Bb]/g, '8').replace(/[Zz]/g, '2');
  // A slash is a slash even when the denominator dissolved ("45/"): the
  // numerator alone still pins the line. Bare numbers must not be copyright
  // years ("2023" sits two lines down and right of the collector number, but
  // on blurred photos the bands overlap).
  const yearLike = (w) => {
    if (!/^(19|20)\d\d$/.test(digits(w.text))) return false;
    return band.some((t) => /[©™&.]|wizards|wotc/i.test(t.text) && Math.abs(t.y0 - w.y0) <= 30);
  };
  const slash = segs.find((w) => onLeft(w) && /^\d{1,3}[\/\\]/.test(digits(w.text)));
  const bareCands = segs.filter(
    (w) => onLeft(w) && /^\d{2,4}$/.test(digits(w.text)) && !yearLike(w)
  );
  // The collector line reads "N/T" left to right, so when OCR lost the slash
  // the numerator is still the *leftmost* number (a lone "285" is the set
  // total, not this card's number, and loses here just like that).
  const bare = bareCands.length
    ? bareCands.reduce((a, b) => (a.x0 <= b.x0 ? a : b))
    : null;
  const num = slash ? digits(slash.text).split('/')[0] : bare ? digits(bare.text) : null;
  const collectorNumber = num && Number(num) > 0 ? String(Number(num)) : null;
  // Where the number came from: an explicit "115/280" line is self-describing,
  // a short bare fragment ("29" of a blurred "291") is not. The exact-printing
  // path trusts the weak forms less (see src/detect.js).
  const numForm = slash ? 'slash' : num && num.length >= 3 ? 'bare' : 'frag';

  // Set code: a 2-4 letter token on the "SET • EN" line, case-insensitively
  // (photos sometimes come back as "Khm"). Tokens on the Scryfall set list win;
  // anything else is only trusted when it sits next to "EN".
  const enAdjacent = (w) =>
    segs.some(
      (t) =>
        t.text.length <= 4 &&
        /EN$/i.test(t.text) &&
        Math.abs(t.y0 - w.y0) <= 15 &&
        t.x0 >= w.x1 &&
        t.x0 - w.x1 <= 60
    );
  const caps = segs.filter((w) => /^[A-Za-z]{2,4}$/.test(w.text) && w.text.toUpperCase() !== 'EN');
  const inKnown = (w) => !!knownSets && knownSets.has(w.text.toUpperCase());
  const inSets = knownSets ? caps.filter(inKnown) : caps;
  const adjacent = caps.find(enAdjacent);
  const setWord =
    adjacent && inKnown(adjacent) ? adjacent
    : inSets.length === 1 ? inSets[0]
    : adjacent ?? null;
  let setCode = setWord ? setWord.text.toUpperCase() : null;
  let setValidated = !!setCode && !!knownSets && knownSets.has(setCode);
  // Repair a misread code: on the "SET • EN" line a near-miss like "WOT" is
  // almost always the unique known set within one edit ("WOE"). Only adopt a
  // repair when the neighbourhood pins it down (one candidate, or one sharing
  // the first letter); Scryfall's bySetNumber still validates the pair below.
  if (setCode && !setValidated && knownSets) {
    const withinOne = (a, b) => {
      if (a === b || Math.abs(a.length - b.length) > 1) return a === b;
      let i = 0, j = 0, diff = 0;
      while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
          i++; j++;
          continue;
        }
        if (++diff > 1) return false;
        if (a.length > b.length) i++;
        else if (b.length > a.length) j++;
        else { i++; j++; }
      }
      return true;
    };
    const near = [...knownSets].filter((k) => withinOne(setCode, k));
    const pick = near.length === 1 ? near[0] : near.find((k) => k[0] === setCode[0]);
    if (pick) {
      setCode = pick;
      setValidated = true;
    }
  }

  // ---- Name candidates -----------------------------------------------------
  // The card name is the cue that survives a camera photo. The collector number
  // and set code are a handful of pixels tall at that size and effectively
  // unreadable (see the README), while the title is the largest text on the
  // card, so the name is now the primary way a card is identified and the footer
  // only refines which printing it is.
  //
  // The name is the topmost line, but it rarely comes back cleanly:
  //   - the rest of the frame gets glued on — mana cost, set/language line,
  //     collector number, stray symbols: "Stab Wound 2e J",
  //     "[5 Knightly Valor dx", "Ie Garruk's Uprising", "Compulsion Le"
  //   - the ornate modern frames sometimes come out reordered:
  //     "Witch EJ Candlegrove = 7" for "Candlegrove Witch"
  // So candidates are generated as several cleaned variants and Scryfall's fuzzy
  // match picks the one that is a real card. Breadth is cheap (each variant is
  // one request, memoized per process); precision is the API's job.
  // The rows considered as the name are the same trusted set as everywhere else
  // (confidence-filtered, art-filtered `kept`): a low-confidence row inside the
  // band is far more often a hallucination in the art than a weak reading of the
  // title, and feeding those to the fuzzy matcher just invents card names.
  const nameRows = kept.filter(
    (r) => r.y <= nameTop + nameBand && (r.text.match(/[A-Za-z]/g) || []).length >= 2
  );
  // Tokens that are never part of a card name: the set code and language marker
  // (parsed above), the mana cost, the collector number, bare symbol runs.
  const cueTokens = new Set(
    [setCode, 'EN', 'NE', 'R', 'C', '★', 'ℯ'].filter(Boolean).map((s) => String(s).toUpperCase())
  );
  const nameWords = (text) =>
    String(text ?? '')
      .split(/[\s/]+/)
      .map((t) => t.replace(/^[^\w]+|[^\w]+$/g, ''))
      .filter((t) => t && /[A-Za-z]/.test(t) && !/^\d+$/.test(t) && !cueTokens.has(t.toUpperCase()));

  const nameCandidates = [];
  const add = (s) => {
    s = (s || '').replace(/\s+/g, ' ').trim();
    if (s && /[A-Za-z]/.test(s) && !nameCandidates.includes(s)) nameCandidates.push(s);
  };
  // The row as read, then the same words reversed (out-of-order frames), then
  // progressively shorter prefixes, which is what rescues a name that got a
  // neighbour line appended to it.
  const variants = (text) => {
    const w = nameWords(text);
    if (!w.length) return [];
    const out = [w.join(' ')];
    if (w.length >= 2 && w.length <= 4) out.push([...w].reverse().join(' '));
    for (let n = Math.min(3, w.length - 1); n >= 1; n--) out.push(w.slice(0, n).join(' '));
    return out;
  };

  for (const v of variants(nameRows[0]?.text)) add(v);
  // A long name can wrap onto the next row; join the first two before splitting.
  if (nameRows[0] && nameRows[1]) {
    const joined = [...nameRows[0].items, ...nameRows[1].items]
      .sort((a, b) => a.x0 - b.x0)
      .map((i) => i.text)
      .join(' ');
    for (const v of variants(joined)) add(v);
  }
  for (const r of nameRows.slice(1, 2)) for (const v of variants(r.text)) add(v);

  // ---- Marks: word boxes of the cues that drove detection (for the UI overlay)
  const marks = [];
  const mark = (w, kind, label) => {
    if (w) marks.push({ x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1, kind, label: label ?? null });
  };
  (nameRows[0]?.items ?? []).forEach((w, i) => mark(w, 'name', i === 0 ? 'name' : null));
  mark(setWord, 'set', setCode);
  const numWord = slash ?? bare;
  mark(numWord, 'number', numWord?.text ?? null);

  return {
    setCode,
    collectorNumber,
    nameCandidates,
    rows: kept.map((r) => r.text),
    marks,
    key: cuesKey(setCode, collectorNumber, nameCandidates),
    setValidated,
    numForm,
  };
}
