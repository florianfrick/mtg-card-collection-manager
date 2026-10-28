// Camera mode: hold one card at a time in front of the camera and each one is
// added as you go. Mounted inside the add-card section of index.html (it used to
// be a page of its own).
//
// Rate limiting, most important first:
//   1. the server skips every lookup while `ignoreCues` still matches the frame
//      (a stationary card = one OCR pass, zero Scryfall requests),
//   2. Scryfall lookups are memoized per process (src/scryfall.js),
//   3. frames are sequential, so a slow OCR pass can never stack requests,
//   4. the pace is slow enough for someone swapping cards by hand.
import { $, api, escapeHtml, pct } from './shared.js';

const DEFAULT_PACE_MS = 1500;
// Frames are downscaled to this before upload, so it must not be below the card
// size the OCR needs: the collector number is ~1.4% of the card's width, so
// throwing away pixels here throws away the cues.
const MAX_FRAME_DIM = 1920;
const LOG_MAX = 30; // session entries kept in the UI

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const label = (c) => `${c.name} · ${c.set_name} #${c.collector_number}`;
const stamp = () => new Date().toLocaleTimeString();

/**
 * Wire the camera UI up. `onChange` runs after every add/remove so the page can
 * refresh whatever else it shows about the collection.
 */
export function createCamera({ onChange = () => {} } = {}) {
  const el = {
    enable: $('#cam-enable'),
    start: $('#cam-start'),
    stop: $('#cam-stop'),
    pace: $('#cam-pace'),
    foil: $('#camfoil'),
    condition: $('#camcondition'),
    video: $('#video'),
    crop: $('#crop'),
    cues: $('#cues'),
    status: $('#cam-status'),
    read: $('#cam-read'),
    quality: $('#cam-quality'),
    current: $('#cam-current'),
    session: $('#cam-session'),
    count: $('#cam-count'),
    log: $('#cam-log'),
  };
  if (!el.enable) return null; // the markup is not on this page

  let stream = null;
  let running = false;
  let token = 0; // bumped on start/pause so a stale loop stops
  let handledKey = ''; // parsed.key of the card we already acted on
  let current = null; // session item shown in "Just added", or { kind: 'unsure' }
  const session = []; // live stack, newest first: one merged item per printing

  function setStatus(msg, kind = '') {
    el.status.textContent = msg;
    el.status.className = kind;
  }

  // ---- camera + scan loop ---------------------------------------------------

  async function enableCamera() {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('no camera API available — open http://localhost:3000 (https or localhost only)');
      }
      // Permission is only asked here, never automatically: pressing this
      // button is the "user permission" gate for the whole page. Resolution is
      // the single biggest lever on photo detection — `ideal` (not `exact`) so
      // a camera that cannot do this size still opens.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1440 } },
      });
      el.video.srcObject = stream;
      el.video.hidden = false;
      await el.video.play();
      el.enable.disabled = true;
      el.start.disabled = false;
      const cam = stream.getVideoTracks()[0]?.getSettings?.() || {};
      const size = cam.width && cam.height ? `${cam.width}x${cam.height}` : 'unknown size';
      setStatus(`Camera on (${size}). Put a card under it and press Start scanning.`);
    } catch (e) {
      setStatus('⚠️ Could not use the camera: ' + e.message, 'warn');
    }
  }

  const frameCanvas = document.createElement('canvas');

  function grabFrame() {
    const sw = el.video.videoWidth;
    const sh = el.video.videoHeight;
    if (!sw || !sh) return null; // stream not ready yet
    const scale = Math.min(1, MAX_FRAME_DIM / Math.max(sw, sh));
    frameCanvas.width = Math.round(sw * scale);
    frameCanvas.height = Math.round(sh * scale);
    frameCanvas.getContext('2d').drawImage(el.video, 0, 0, frameCanvas.width, frameCanvas.height);
    return frameCanvas.toDataURL('image/jpeg', 0.85);
  }

  const paceMs = () => Number(el.pace.value) || DEFAULT_PACE_MS;

  async function start() {
    if (!stream || running) return;
    running = true;
    const mine = ++token;
    el.start.disabled = true;
    el.stop.disabled = false;
    setStatus('Scanning — place one card at a time.');
    while (running && mine === token) {
      const t0 = Date.now();
      try {
        await scanOnce();
      } catch (e) {
        setStatus('⚠️ ' + e.message, 'warn');
      }
      // Absorb the rest of the pace, so frames never queue up behind a slow OCR.
      await sleep(Math.max(150, paceMs() - (Date.now() - t0)));
    }
  }

  function stop() {
    running = false;
    token++;
    el.start.disabled = !stream;
    el.stop.disabled = true;
    setStatus('Paused — the camera stays on.');
  }

  async function scanOnce() {
    const image = grabFrame();
    if (!image) return;
    const r = await api('/api/detect', {
      method: 'POST',
      // autoAdd stores the best match; ignoreCues tells the server which card we
      // already acted on, so an unchanged frame resolves (and adds) nothing.
      // foil: the manual toggle — every card scanned while it is on lands as
      // foil (its own row, foil price). Nothing detects foil automatically.
      body: JSON.stringify({
        image,
        autoAdd: true,
        ignoreCues: handledKey,
        foil: el.foil.checked,
        // The grade every card scanned while this is set lands as. Nothing
        // detects condition any more than it detects foil.
        condition: el.condition?.value ?? 'NM',
      }),
    });
    showFrame(r);
    handleResult(r);
  }

  // ---- what OCR saw ---------------------------------------------------------

  function showFrame(r) {
    const p = r.parsed || {};
    const bits = [];
    if (p.setCode) bits.push(`set ${p.setCode}`);
    if (p.collectorNumber) bits.push(`no. ${p.collectorNumber}`);
    if (p.nameCandidates?.[0]) bits.push(`name "${p.nameCandidates[0]}"`);
    el.read.textContent = bits.length
      ? `OCR read: ${bits.join(' · ')}${p.key ? ` → key ${p.key}` : ''}`
      : 'OCR read nothing legible yet.';
    showQuality(r.legibility);

    if (!r.croppedImage) { el.crop.hidden = true; el.cues.hidden = true; return; }
    const same = el.crop.src === r.croppedImage;
    el.crop.hidden = false;
    el.crop.onload = () => paintCues(r);
    el.crop.src = r.croppedImage;
    if (same) paintCues(r); // identical frame: onload will not fire again
  }

  /**
   * Is the card in this frame big enough for its footer to be readable at all?
   * A miss on a too-small card is a framing problem, not a matching one, and
   * "OCR read nothing legible" on its own gives the user nothing to act on.
   * `legibility` is measured server-side (src/ocr.js): the printed collector
   * number's height in source pixels, against the minimum that is readable.
   */
  function showQuality(l) {
    if (!l || l.textPx == null) { el.quality.textContent = ''; el.quality.className = 'like-label'; return; }
    if (l.ok) {
      el.quality.textContent = `Card number ≈ ${l.textPx}px tall (readable at ${l.minTextPx}px+).`;
      el.quality.className = 'like-label';
    } else {
      el.quality.textContent = `⚠️ The card is too small in frame — its number is only ~${l.textPx}px tall `
        + `(needs ${l.minTextPx}px). Move the card closer to the camera.`;
      el.quality.className = 'like-label warn';
    }
  }

  /** The crop OCR saw, with the cue boxes detection used (name/set/number). */
  function paintCues(r) {
    if (!r.ocrSize || !el.crop.clientWidth) { el.cues.hidden = true; return; }
    const W = el.crop.clientWidth;
    const H = el.crop.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    el.cues.hidden = false;
    el.cues.width = Math.round(W * dpr);
    el.cues.height = Math.round(H * dpr);
    el.cues.style.width = W + 'px';
    el.cues.style.height = H + 'px';
    const ctx = el.cues.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const sx = W / r.ocrSize.width;
    const sy = H / r.ocrSize.height;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.65)';
    for (const w of r.words || []) {
      ctx.strokeRect(w.x0 * sx + 0.5, w.y0 * sy + 0.5,
        Math.max(1, (w.x1 - w.x0) * sx), Math.max(1, (w.y1 - w.y0) * sy));
    }
    const kindColor = { name: '#2563eb', set: '#9333ea', number: '#ea580c' };
    ctx.lineWidth = 2;
    for (const m of r.parsed?.marks || []) {
      ctx.strokeStyle = kindColor[m.kind] || '#111';
      ctx.strokeRect(m.x0 * sx, m.y0 * sy, (m.x1 - m.x0) * sx, (m.y1 - m.y0) * sy);
    }
  }

  // ---- one frame -> collection ----------------------------------------------

  /**
   * Decide what a frame means. The only memory kept is `handledKey`: the cues of
   * the card we already acted on. That is deliberately the whole rule — "add it
   * if it is a different card than the previous one".
   * LIMITATION (v1): real duplicate detection is not implemented. A card placed
   * again later (after leaving the camera) is added again; the DB then collapses
   * re-adds of the *same printing*, but two different printings of one card can
   * both end up in the collection.
   */
  function handleResult(r) {
    const key = r.parsed?.key || '';
    if (!key) {
      // Nothing legible: empty tray, or a card not framed yet. Treat it as "the
      // previous card left", so re-placing even the same card is new.
      handledKey = '';
      setStatus('Waiting for a card…');
      return;
    }
    const a = r.autoAdded || {};
    if (a.reason === 'same-card') {
      // Same cues as the previous frame: no lookup, no add, keep the panel. If we
      // just reported a removal for it, stay quiet rather than claiming the card
      // is "still" there — the removal stands until the view changes.
      if (current?.removed) return;
      if (current?.card) setStatus(`Still the same card: ${label(current.card)}`);
      return;
    }
    handledKey = ''; // the cues changed -> a different card is in view now
    if (a.added) {
      // New cues each time — even for a printing already in the stack. But OCR
      // flicker can re-resolve the *same* view twice in a row (before `unchanged`
      // kicks in): only the very first frame of these exact cues adds a copy.
      if (a.entry?.id && current?.id === a.entry.id && !current?.removed) {
        handledKey = key;
        setStatus(`Still the same card: ${label(a.candidate)}`);
        return;
      }
      handledKey = key;
      remember({ card: a.candidate, entry: a.entry, newCopy: a.newCopy, copies: 1, candidates: r.candidates });
    } else if (a.reason === 'low-likelihood') {
      handledKey = key; // don't re-resolve these cues on every single frame
      current = { kind: 'unsure', candidates: r.candidates || [], best: a.candidate, likelihood: a.likelihood, identified: r.identified || null };
      render();
      // Say what was actually read: the title names the card, and the choice left
      // is which printing — a much more useful message than a percentage on a
      // guess the user never made.
      const id = r.identified;
      setStatus(
        id && id.printings > 1
          ? `Read "${id.name}" (${pct(id.confidence)}), but ${id.printings} printings match and the small print is too blurry to choose — pick below.`
          : `Not sure (${pct(a.likelihood)} likely) — pick the printing below, or move the card away and back.`,
        'warn'
      );
    } else if (a.reason === 'no-match') {
      handledKey = key;
      setStatus('Could not read this card — press Re-read, or move it away and back.', 'warn');
    } else {
      setStatus('⚠️ ' + (a.message || 'detection failed'), 'warn');
    }
  }

  /**
   * A card went into the collection: record it, show it, offer −1 / remove.
   *
   * The session is a live stack, newest first — but one merged item per
   * printing: scanning a card already in the stack bumps it back to the top and
   * grows its session count (the card stays "handled" via handledKey, so a
   * stationary card never auto-increments — only a *new* scan of it does).
   */
  function remember({ card, entry, newCopy = true, copies = 1, candidates = [], manual = false }) {
    const key = card?.scryfall_id;
    const at = stamp();
    const foil = !!entry?.foil; // what the server actually stored
    const existing = key ? session.find((s) => !s.removed && s.card?.scryfall_id === key && !!s.foil === foil) : null;
    if (existing && entry) {
      // Another physical copy of a card already in the stack: merge, don't
      // append. Fresh server-side quantity wins; top it back up.
      existing.copies = entry.quantity ?? (existing.copies + copies);
      existing.card = card;
      existing.at = at;
      existing.manual = existing.manual || manual;
      if (candidates.length) existing.candidates = candidates;
      session.splice(session.indexOf(existing), 1);
      session.unshift(existing);
      current = existing;
    } else {
      const item = {
        id: entry?.id ?? null,
        card,
        copies: entry?.quantity ?? copies,
        newCopy: !!newCopy,
        removed: false,
        manual,
        foil,
        at,
        candidates,
      };
      session.unshift(item);
      if (session.length > LOG_MAX) session.length = LOG_MAX;
      current = item;
    }
    render();
    onChange();
    const held = current.copies ?? 1;
    setStatus(
      `✅ Added: ${label(card)}${foil ? ' (foil)' : ''}${held > 1 ? ` (×${held} in collection)` : ''}`
        + (card.likelihood != null ? ` (${pct(card.likelihood)} likely)` : ''),
      'ok'
    );
  }

  // ---- rendering ------------------------------------------------------------

  function render() {
    renderCurrent();
    renderLog();
  }

  function renderCurrent() {
    el.current.innerHTML = '';
    if (!current) { el.current.innerHTML = '<p><em>Waiting for a card…</em></p>'; return; }
    if (current.kind === 'unsure') { renderUnsure(current); return; }
    el.current.appendChild(cardEl(current));
  }

  /** The card that was just added: details, copy count, −1 / +1 / remove. */
  function cardEl(item) {
    const c = item.card;
    const d = document.createElement('div');
    d.className = 'candidate top';
    const held = item.copies ?? 1;
    const status = item.removed ? '✗ removed from your collection'
      : item.manual ? '✅ added (you picked this printing)'
      : '✅ added automatically';
    const bits = [];
    if (item.foil) bits.push('foil');
    if (c.likelihood != null) bits.push(`${pct(c.likelihood)} likely`);
    bits.push(held === 1 ? '1 in collection' : `${held} in collection`);
    const price = item.foil ? (c.prices?.usd_foil ?? c.prices?.usd) : c.prices?.usd;
    d.innerHTML =
      (c.image_url ? `<img class="thumb" src="${escapeHtml(c.image_url)}" alt="" />` : '') +
      `<div><strong>${escapeHtml(c.name)}</strong><br/>` +
      `${escapeHtml(c.set_name)} #${escapeHtml(c.collector_number)}<br/>` +
      `USD ${escapeHtml(price ?? '—')}${c.prices?.eur ? ` · EUR ${escapeHtml(c.prices.eur)}` : ''}</div>` +
      `<p><span class="badge${item.removed ? ' off' : ''}${item.foil ? ' foil' : ''}">${escapeHtml(status)}</span>` +
      `<span class="like-label"> ${escapeHtml(bits.join(' · '))}</span></p>` +
      `<p>${item.id && !item.removed
        ? '<button class="dec">−1 copy</button> <button class="addmore">+1 copy</button> <button class="remove">Remove all</button> '
        : ''}` +
      `<button class="again">Re-read this card</button></p>`;
    if (item.id && !item.removed) {
      d.querySelector('.dec').addEventListener('click', () => adjustItem(item, -1));
      d.querySelector('.addmore').addEventListener('click', () => adjustItem(item, 1));
      d.querySelector('.remove').addEventListener('click', () => removeItem(item));
    }
    d.querySelector('.again').addEventListener('click', reread);

    // Replacement: after a swap the camera stays quiet, because the cues in
    // front of it did not change (that is exactly what `handledKey` remembers).
    const alts = (item.candidates || []).filter((x) => x.scryfall_id !== c.scryfall_id);
    if (alts.length && !item.removed) {
      const det = document.createElement('details');
      det.innerHTML = '<summary>Not this card? Pick a different printing</summary>';
      const wrap = document.createElement('div');
      for (const alt of alts.slice(0, 12)) {
        wrap.appendChild(rowEl(alt, { actions: [{ label: 'Use this instead', cls: 'act', onClick: replaceWith }] }));
      }
      det.appendChild(wrap);
      d.appendChild(det);
    }
    return d;
  }

  /**
   * A card we could not pin to a printing. On a photo this is the normal case,
   * not a failure: the title is readable and names the card, but the set code
   * and collector number on the card's bottom edge are a few pixels tall and
   * come back as noise, so there is nothing to say *which* printing it is.
   * Report the two facts separately — the card we recognized, and the choice
   * that is left — instead of one low percentage that reads as doubt about
   * everything.
   */
  function renderUnsure(cur) {
    const id = cur.identified;
    let msg;
    if (id && id.printings > 1) {
      msg = `📖 Read the title as <strong>${escapeHtml(id.name)}</strong> `
        + `(${pct(id.confidence)} confident) — but it has ${id.printings} printings, `
        + 'and the small print at the bottom of the card is too blurry to say which. '
        + 'Nothing was added; pick the printing:';
    } else if (cur.best) {
      msg = `🤔 Not sure about this one — best guess <strong>${escapeHtml(cur.best.name)}</strong> `
        + `at only ${pct(cur.likelihood)} likely. Nothing was added. `
        + 'Pick the right printing, or move the card away and back to retry:';
    } else {
      msg = '🤔 Nothing legible enough to identify this card. Pick it by name, '
        + 'or move the card closer and try again:';
    }
    el.current.innerHTML = `<p>${msg}</p>`;
    const wrap = document.createElement('div');
    for (const c of (cur.candidates || []).slice(0, 8)) {
      wrap.appendChild(rowEl(c, {
        actions: [{ label: 'Add this one', cls: 'act', onClick: addPick }],
        badge: c.scryfall_id === cur.best?.scryfall_id ? 'best guess' : null,
      }));
    }
    if (!wrap.children.length) wrap.innerHTML = '<p><em>No candidates — the reading was too weak.</em></p>';
    el.current.appendChild(wrap);
    const again = document.createElement('p');
    again.innerHTML = '<button class="again">Re-read this card</button>';
    again.querySelector('.again').addEventListener('click', reread);
    el.current.appendChild(again);
  }

  /** One row of a card list: details, an optional badge/note and buttons. */
  function rowEl(card, { actions = [], badge = null, badgeCls = 'badge', note = '', cls = 'candidate', qty = null, foil = false } = {}) {
    const d = document.createElement('div');
    d.className = cls;
    const price = foil ? (card.prices?.usd_foil ?? card.prices?.usd) : card.prices?.usd;
    d.innerHTML =
      (card.image_url ? `<img class="thumb" src="${escapeHtml(card.image_url)}" alt="" />` : '') +
      `<div><strong>${escapeHtml(card.name)}</strong><br/>` +
      `${escapeHtml(card.set_name)} #${escapeHtml(card.collector_number)}<br/>` +
      `USD ${escapeHtml(price ?? '—')}${card.likelihood != null ? ` · ${pct(card.likelihood)} likely` : ''}` +
      (qty != null && qty !== 1 ? ` · <strong>×${qty}</strong>` : '') + `</div>` +
      ((badge || foil)
        ? `<p>${foil ? '<span class="badge foil">✨ foil</span>' : ''}` +
          (badge ? `<span class="${badgeCls}">${escapeHtml(badge)}</span>` : '') +
          (note ? ` <span class="like-label">${escapeHtml(note)}</span>` : '') + '</p>'
        : '') +
      (actions.length
        ? `<p>${actions.map((a, i) => `<button class="${a.cls || 'act'}" data-i="${i}">${escapeHtml(a.label)}</button>`).join(' ')}</p>`
        : '');
    actions.forEach((a, i) => {
      const btn = d.querySelector(`button[data-i="${i}"]`);
      if (btn && a.onClick) btn.addEventListener('click', () => a.onClick(card));
    });
    return d;
  }

  /** Session live stack, newest on top — one merged row per printing. */
  function renderLog() {
    el.log.innerHTML = '';
    const live = session.filter((s) => !s.removed);
    el.count.textContent = String(live.reduce((s, it) => s + (it.copies ?? 1), 0));
    el.session.hidden = session.length === 0;
    if (!session.length) { el.log.innerHTML = '<p><em>Nothing yet.</em></p>'; return; }
    for (const item of session) {
      const held = item.copies ?? 1;
      el.log.appendChild(rowEl(item.card, {
        cls: 'candidate' + (item.removed ? ' removed' : ''),
        badge: item.removed ? '✗ removed' : held === 1 ? '✓ added' : `✓ added ×${held}`,
        badgeCls: 'badge' + (item.removed ? ' off' : ''),
        note: item.at,
        qty: held,
        foil: item.foil,
        actions: item.id && !item.removed ? [
          { label: '−1', cls: 'dec', onClick: () => adjustItem(item, -1) },
          { label: '+1', cls: 'addmore', onClick: () => adjustItem(item, 1) },
          { label: 'copies…', cls: 'act', onClick: () => setItemCopies(item) },
          { label: 'Remove', cls: 'remove', onClick: () => removeItem(item) },
        ] : [],
      }));
    }
  }

  // ---- actions --------------------------------------------------------------

  /**
   * ±1 copy of a session item. −1 on the last copy removes the row (the same as
   * `removeItem`, but through the decrement endpoint so a 3-copy row drops to 2
   * instead of vanishing).
   */
  async function adjustItem(item, delta) {
    if (!item.id || item.removed) return;
    try {
      const res = delta > 0
        ? await api('/api/collection/' + item.id, { method: 'PATCH', body: JSON.stringify({ copies: 1 }) })
        : await api('/api/collection/' + item.id + '/decrement', { method: 'POST', body: JSON.stringify({ n: 1 }) });
      // Both endpoints answer { entry } — null when the row was deleted (−1 on
      // the last copy). A 404 means the row belongs to a different identity now
      // (e.g. this browser signed in elsewhere): forget it.
      if (!res?.entry) {
        item.removed = true;
        render();
        onChange();
        setStatus(`Removed ${label(item.card)} from your collection.`);
        return;
      }
      item.copies = res.entry.quantity ?? item.copies;
      render();
      onChange();
      setStatus(`${label(item.card)}: ${item.copies === 1 ? '1 copy' : `${item.copies} copies`} in collection.`);
    } catch (e) {
      // A 404 here means the row belongs to a different identity now (e.g. this
      // browser signed in elsewhere): forget the item, do not retry it.
      if (String(e.message).includes('404')) { item.removed = true; render(); onChange(); }
      setStatus('⚠️ Update failed: ' + e.message, 'warn');
    }
  }

  /** Set the exact copy count of a session item (prompt; 0 removes it). */
  async function setItemCopies(item) {
    if (!item.id || item.removed) return;
    const raw = prompt(`How many copies of ${label(item.card)}?`, String(item.copies ?? 1));
    if (raw == null) return; // cancelled
    try {
      const res = await api('/api/collection/' + item.id, {
        method: 'PUT', body: JSON.stringify({ quantity: Math.floor(Number(raw)) }),
      });
      if (res.removed || !res.entry) {
        item.removed = true;
        render();
        onChange();
        setStatus(`Removed ${label(item.card)} from your collection.`);
        return;
      }
      item.copies = res.entry.quantity ?? item.copies;
      render();
      onChange();
      setStatus(`${label(item.card)}: ${item.copies === 1 ? '1 copy' : `${item.copies} copies`} in collection.`);
    } catch (e) {
      setStatus('⚠️ Update failed: ' + e.message, 'warn');
    }
  }

  /**
   * Undo an add. The card may still be under the camera, so its cues stay
   * "handled" — otherwise the very next frame would add it straight back. That
   * is released as soon as the view changes (empty frame or different cues).
   */
  async function removeItem(item) {
    if (!item.id || item.removed) return;
    try {
      await api('/api/collection/' + item.id, { method: 'DELETE' });
      item.removed = true;
      render();
      onChange();
      setStatus(`Removed ${label(item.card)} from your collection.`);
    } catch (e) {
      // 404: the row is gone or belongs to someone else — either way, there is
      // nothing left here to manage.
      if (String(e.message).includes('404')) { item.removed = true; render(); onChange(); }
      setStatus('⚠️ Remove failed: ' + e.message, 'warn');
    }
  }

  /** Manual pick for a card the detector was not sure about. */
  async function addPick(card) {
    const candidates = current?.candidates || [];
    try {
      const res = await api('/api/collection', {
        method: 'POST', body: JSON.stringify({ ...card, foil: el.foil.checked }),
      });
      remember({ card, entry: res.entry, newCopy: res.newCopy, copies: 1, candidates, manual: true });
    } catch (e) {
      setStatus('⚠️ Add failed: ' + e.message, 'warn');
    }
  }

  /** Swap the guess for the printing the user picked (add pick, drop guess). */
  async function replaceWith(card) {
    const item = current;
    const prev = item?.id ?? null;
    try {
      const res = await api('/api/collection', {
        method: 'POST', body: JSON.stringify({ ...card, foil: el.foil.checked }),
      });
      if (prev) {
        try {
          await api('/api/collection/' + prev, { method: 'DELETE' });
        } catch (e) {
          // The old printing may already be gone (or belong to a different
          // identity): the swap still succeeded, so say that, not "fail".
          if (!String(e.message).includes('404')) throw e;
        }
      }
      if (item) {
        item.id = res.entry?.id ?? null;
        item.card = card;
        item.copies = res.entry?.quantity ?? 1;
        item.newCopy = res.newCopy ?? true;
        item.manual = true;
        item.foil = !!res.entry?.foil;
        item.removed = false;
        // A swap changes the printing in place — re-key the stack entry so a
        // later re-scan of the old printing doesn't merge into this row.
        const ix = session.indexOf(item);
        if (ix > 0) { session.splice(ix, 1); session.unshift(item); }
      }
      render();
      onChange();
      setStatus(`Using ${label(card)} instead.`);
    } catch (e) {
      setStatus('⚠️ Replace failed: ' + e.message, 'warn');
    }
  }

  /** Forget the handled card, so the next frame is resolved from scratch. */
  function reread() {
    handledKey = '';
    setStatus('Re-reading this card…');
  }

  /** Release the camera (and the browser's recording indicator). */
  function release() {
    running = false;
    token++;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    el.video.srcObject = null;
    el.video.hidden = true;
    el.enable.disabled = false;
    el.start.disabled = true;
    el.stop.disabled = true;
  }

  // ---- wiring ---------------------------------------------------------------

  el.enable.addEventListener('click', enableCamera);
  el.start.addEventListener('click', start);
  el.stop.addEventListener('click', stop);
  window.addEventListener('beforeunload', release);
  render();

  return { start, stop, release };
}
