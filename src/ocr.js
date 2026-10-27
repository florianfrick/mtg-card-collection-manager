import { Jimp } from 'jimp';

// MTG Collection Manager does no image processing before OCR. The uploaded bytes go to
// PaddleOCR (PP-OCR, through the Python sidecar — see src/ppocr.js) exactly as
// they arrived: no crop, no downscale, no greyscale, no contrast stretch, no
// binarizing, no deskew, no retry variants. If a photo reads badly, that is the
// engine's verdict on the original, not an artefact of a preprocessing chain.
//
// The two things computed here are for the UIs only, and neither touches
// a pixel handed to the engine:
//   findCardBox / cropToCard  where the card is, so the preview can zoom to it
//   measureLegibility         whether the card is even big enough to be read

const MAX_PREVIEW_DIM = 900; // display-only cap for the UI's zoomed-in view

// Pure-black pillarbox/letterbox bars (a portrait card inside a landscape video
// frame comes with them). A bar column is black over its entire height, so left
// untrimmed it out-votes the card in the darkness profile and the crop lands on black.
const BAR_LUMA = 32; // near-black (JPEG bars sit at 0-16)
const BAR_FRAC = 0.98; // fraction of a bar column/row that must be black
const KEEP_AREA = 0.25; // never trim below this much of the frame: that is a dark photo, not bars

/**
 * Find the card's bounding box on a full-resolution page scan.
 *
 * A scanned page is ~90% empty off-white, so OCR wastes effort on noise and the
 * card's (small) text ends up downscaled. The card is a solid rectangle ringed
 * by black borders, so:
 *   - count dark pixels per column and per row;
 *   - every in-card row/column carries a baseline of dark pixels (~40+ from the
 *     side/top/bottom borders) while empty page rows carry ~0;
 *   - the card is the single contiguous run with the largest darkness sum
 *     (an isolated page-edge line is a separate run whose tiny sum loses).
 *
 * Camera photos add one wrinkle: a portrait card inside a landscape frame is
 * pillarboxed/letterboxed with pure black bars, and those bars are black over
 * their full height, so they win that contest. Trim them first (see BAR_*).
 *
 * Returns { x0, y0, x1, y1 } inclusive, or null if nothing plausible is found.
 */
function findCardBox(data, width, height) {
  const DARK = 200;
  const luma = (x, y) => {
    const idx = (width * y + x) << 2;
    return (data[idx] * 299 + data[idx + 1] * 587 + data[idx + 2] * 114) / 1000;
  };

  // ---- Pass 1: locate the pure-black bars along the edges --------------------
  const colBlack = new Float32Array(width);
  const rowBlack = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (luma(x, y) < BAR_LUMA) {
        colBlack[x]++;
        rowBlack[y]++;
      }
    }
  }
  let x0 = 0, x1 = width, y0 = 0, y1 = height;
  while (x0 < x1 && colBlack[x0] >= BAR_FRAC * height) x0++;
  while (x1 > x0 && colBlack[x1 - 1] >= BAR_FRAC * height) x1--;
  while (y0 < y1 && rowBlack[y0] >= BAR_FRAC * width) y0++;
  while (y1 > y0 && rowBlack[y1 - 1] >= BAR_FRAC * width) y1--;
  // Guard: if trimming would swallow most of the frame this was not bars but a
  // genuinely dark photo — fall back to the whole frame.
  if ((x1 - x0) * (y1 - y0) < KEEP_AREA * width * height) {
    x0 = 0; x1 = width; y0 = 0; y1 = height;
  }

  // ---- Pass 2: darkness profile over the usable region only ------------------
  const colCount = new Int32Array(width);
  const rowCount = new Int32Array(height);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (luma(x, y) < DARK) {
        colCount[x]++;
        rowCount[y]++;
      }
    }
  }

  const largestRun = (counts, from, to) => {
    let max = 0;
    for (let i = from; i < to; i++) if (counts[i] > max) max = counts[i];
    if (max === 0) return null;
    const th = Math.max(0.02 * max, 15);
    let best = { start: -1, end: -1, sum: -1 };
    let curStart = -1;
    let curSum = 0;
    for (let i = from; i < to; i++) {
      if (counts[i] >= th) {
        if (curStart < 0) curStart = i;
        curSum += counts[i];
      } else if (curStart >= 0) {
        if (curSum > best.sum) best = { start: curStart, end: i - 1, sum: curSum };
        curStart = -1;
        curSum = 0;
      }
    }
    if (curStart >= 0 && curSum > best.sum) best = { start: curStart, end: to - 1, sum: curSum };
    return best.start >= 0 ? best : null;
  };

  const marginX = Math.floor((x1 - x0) * 0.02);
  const marginY = Math.floor((y1 - y0) * 0.02);
  const cols = largestRun(colCount, x0 + marginX, x1 - marginX);
  const rows = largestRun(rowCount, y0 + marginY, y1 - marginY);
  if (!cols || !rows) return null;
  return { x0: cols.start, x1: cols.end, y0: rows.start, y1: rows.end };
}

/**
 * Crop to the card (if detected), leaving colour and native resolution alone.
 * Used only to build the UI's zoomed preview, never to feed the OCR engine.
 * Returns { img, box, origin }, where `origin` is where the crop starts in the
 * original image, so the engine's word boxes (which are in original coordinates)
 * can be moved into preview coordinates. box = null when nothing plausible was
 * found: the image then comes back whole, and the origin is 0,0.
 */
function cropToCard(img) {
  const { width, height, data } = img.bitmap;
  const box = findCardBox(data, width, height);
  if (!box) return { img, box: null, origin: { x: 0, y: 0 } };

  const bw = box.x1 - box.x0 + 1;
  const bh = box.y1 - box.y0 + 1;
  const padX = Math.round(bw * 0.02);
  const padY = Math.round(bh * 0.02);
  const x = Math.max(0, box.x0 - padX);
  const y = Math.max(0, box.y0 - padY);
  const w = Math.min(width - x, bw + padX * 2);
  const h = Math.min(height - y, bh + padY * 2);
  if (w < 100 || h < 100) return { img, box: null, origin: { x: 0, y: 0 } };
  return { img: img.clone().crop({ x, y, w, h }), box, origin: { x, y } };
}

// ---- Legibility: is the card's footer readable at all? ---------------------
//
// The exact printing comes from the collector number + set code printed in the
// card's bottom band. On a camera photo that text is sometimes only 6-7 pixels
// tall, and then it is simply not in the image any more: every OCR pass returns
// noise, detection reports "nothing legible", and the one thing that would have
// fixed it (moving the card closer) goes unmentioned. So the UIs are told how
// tall that text actually is, and say so when it is too small to read.
//
// The estimate is geometric rather than measured: a card's printed layout is
// fixed, so the collector number's height is a constant fraction of the card's
// width (FOOTER_TEXT_RATIO). Measuring the glyphs directly was tried and is far
// noisier than the quantity it is meant to proxy: ink/coverage heuristics lock
// onto art, frame edges and the rules box (a scan whose footer is 11px tall
// measured as 41px, a photo whose footer is 7px measured as 76px), and none of
// that survives contact with real cards in a real frame. Card width is also
// exactly the thing the user controls, which is what the warning asks about.
const FOOTER_TEXT_RATIO = 0.014; // ~0.9mm of text on a 63mm-wide card

// Below this the digits blur into the frame. Calibrated against the sample
// corpus: the flatbed scans (card ~800px wide, so ~11px of text) all resolve
// their exact printing, while 1280x720 camera frames (card ~490px, so ~7px)
// resolve 13 of 55. A 1920-wide frame with the same framing lands at ~10-11px,
// just over the line, which is the point: it says when a card is still too small
// to read instead of silently returning nothing.
const MIN_TEXT_PX = 10;

/**
 * How readable the card's footer cues are, given the size of the card found in
 * the image: { textPx, minTextPx, ok }.
 *
 * `textPx` is the estimated height of the printed collector number in SOURCE
 * pixels: the pixels actually captured, which is what decides whether OCR can
 * read it (the image is never resampled before the engine sees it, and
 * upsampling a blurry photo afterwards would add no information anyway). It is
 * null when no card could be located at all, because `box === null` leaves the
 * whole page as the "crop" and the page width says
 * nothing about how big the card is in it; an unknown is reported as ok, so a
 * card the detector cannot even frame is never blamed on being too small.
 *
 * `box` is the axis-aligned bounding box of a possibly tilted card, so it very
 * slightly overestimates the card's true width; that errs towards not warning.
 */
function measureLegibility(box) {
  if (!box) return { textPx: null, minTextPx: MIN_TEXT_PX, ok: true };
  const textPx = Math.max(1, Math.round((box.x1 - box.x0 + 1) * FOOTER_TEXT_RATIO));
  return { textPx, minTextPx: MIN_TEXT_PX, ok: textPx >= MIN_TEXT_PX };
}

/**
 * Small colour JPEG of the crop, so the UI can zoom in on the card too.
 * Display only — never fed to the OCR engine, so resizing it costs nothing.
 * Clones before resizing: Jimp's resize() mutates in place, and the caller still
 * needs the crop's own dimensions for `ocrSize`, which the word boxes are in.
 */
async function toPreviewJpeg(img) {
  const { width: w, height: h } = img.bitmap;
  const long = Math.max(w, h);
  if (long <= MAX_PREVIEW_DIM) return img.getBuffer('image/jpeg', { quality: 85 });
  const small = img.clone().resize({
    w: Math.max(1, Math.round((w * MAX_PREVIEW_DIM) / long)),
    h: Math.max(1, Math.round((h * MAX_PREVIEW_DIM) / long)),
  });
  return small.getBuffer('image/jpeg', { quality: 85 });
}

/**
 * Read one uploaded image once, to find the card and build its preview.
 * Returns:
 *   buffer    the uploaded bytes, untouched — this, not the crop, is what
 *             PP-OCR reads
 *   preview   colour JPEG of the card, shown by the UI after Detect (display
 *             only; it is never fed to the OCR engine)
 *   box       the card bounding box used, or null
 *   origin    where that crop starts in the original image, so the engine's word
 *             boxes (in original coordinates) can be moved onto the preview
 *   ocrSize   size of `preview`, i.e. the space the word boxes are reported in
 *   img       the colour crop itself
 *   legibility { textPx, minTextPx, ok } - how tall the card's footer text is
 *              in source pixels, i.e. whether the cues are readable at all
 *              (see measureLegibility())
 */
export async function prepareScan(buffer) {
  const page = await Jimp.read(buffer);
  const { img, box, origin } = cropToCard(page);
  const legibility = measureLegibility(box);
  const preview = await toPreviewJpeg(img);
  return {
    buffer,
    preview,
    box,
    origin,
    ocrSize: { width: img.bitmap.width, height: img.bitmap.height },
    img,
    legibility,
  };
}

// ---------------------------------------------------------------------------
// Recognition lives in src/ppocr.js: PP-OCR runs in a Python sidecar, which
// serializes requests itself (one line of stdin at a time), so overlapping
// /api/detect calls need no queue here.
// ---------------------------------------------------------------------------

/**
 * Move word boxes from the original image's coordinates into the preview crop's,
 * so the UI can draw them on the card without knowing about the page around it.
 * A pure translation: every cue the matcher derives from these boxes is relative
 * (row clustering, the top/bottom bands), so the shift changes nothing but where
 * the boxes are drawn. When no card was found the origin is 0,0 and this is a
 * no-op.
 */
export function intoPreviewSpace(words, origin) {
  if (!origin || (!origin.x && !origin.y)) return words;
  const { x, y } = origin;
  return words.map((w) => ({ ...w, x0: w.x0 - x, y0: w.y0 - y, x1: w.x1 - x, y1: w.y1 - y }));
}
