import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { numOrNull, sleep } from './util.js';

// ---------------------------------------------------------------------------
// PP-OCR (PaddleOCR, via ONNX Runtime) is MTG Collection Manager's OCR engine. It runs as a
// Python sidecar — see scripts/ppocr_sidecar.py and tools/ppocr/setup.md —
// started once and reused, because most of the start-up cost is loading the
// models.
//
// One request per line on stdin, answered one at a time, so overlapping
// /api/detect calls are serialized by the sidecar for free (no queue needed
// here). If the interpreter or the package is missing, `ppocrWords` returns
// null and it is up to the caller to fail with `ppocrStatus()`'s reason: there
// is no second engine to fall back on.
//
// Two kinds of failure are kept apart on purpose:
//   - the engine cannot work at all (no interpreter, no package): sticky, so
//     every request does not pay for the same discovery;
//   - the sidecar died (OOM, a killed process, a model crash): restarted on the
//     next request after a short backoff, because one bad frame must not turn
//     scanning off until the server is restarted.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const PYTHON =
  process.env.PPOCR_PYTHON || join(here, '..', 'tools', 'ppocr', 'venv', 'Scripts', 'python.exe');
const SIDECAR = join(here, '..', 'scripts', 'ppocr_sidecar.py');
const TIMEOUT_MS = numOrNull(process.env.PPOCR_TIMEOUT) ?? 180000;
const MAX_RESTART_DELAY_MS = 30_000;

let child = null;
let nextId = 1;
let buf = '';
let unavailable = null; // sticky reason, so a missing engine is not retried forever
let restartAt = 0; // earliest time the next spawn is allowed (crash backoff)
let crashes = 0;
const pending = new Map(); // id -> { resolve, reject, timer }

/** Why PP-OCR is unusable right now, or null when it is (or may be) available. */
export function ppocrStatus() {
  if (unavailable) return { available: false, reason: unavailable };
  if (!existsSync(PYTHON)) {
    return {
      available: false,
      reason: `no Python environment at ${PYTHON} (see tools/ppocr/setup.md, or set PPOCR_PYTHON)`,
    };
  }
  return { available: true, reason: null, python: PYTHON };
}

/**
 * Report a failure to every waiting request and drop the process. `permanent`
 * marks a reason no restart can fix (a missing interpreter or package); a crash
 * is retried instead, with a growing delay so a model that cannot load is not
 * respawned once per camera frame.
 */
function fail(reason, { permanent = false } = {}) {
  if (permanent) unavailable = reason;
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(new Error(reason));
  }
  pending.clear();
  stop();
}

function scheduleRestart() {
  crashes += 1;
  restartAt = Date.now() + Math.min(MAX_RESTART_DELAY_MS, 1000 * 2 ** (crashes - 1));
}

function start() {
  if (child) return child;
  child = spawn(PYTHON, [SIDECAR], { windowsHide: true });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // a stray log line, not a reply
      }
      if (msg.id == null) {
        // The startup handshake: the models loaded, so this process is healthy
        // and the crash counter starts over.
        crashes = 0;
        restartAt = 0;
        continue;
      }
      const wait = pending.get(msg.id);
      if (!wait) continue;
      pending.delete(msg.id);
      clearTimeout(wait.timer);
      if (msg.error) wait.reject(new Error(msg.error));
      else wait.resolve({ words: msg.words || [], ms: msg.ms ?? null });
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    // RapidOCR logs its model choices to stderr; keep it visible for debugging
    // but out of the protocol on stdout.
    if (process.env.PPOCR_DEBUG) process.stderr.write(`[ppocr] ${chunk}`);
  });

  // A missing interpreter/package cannot be fixed by trying again.
  child.on('error', (e) => fail(`could not start ${PYTHON}: ${e.message}`, { permanent: true }));
  child.on('exit', (code) => {
    if (pending.size) fail(`PP-OCR sidecar exited (code ${code})`);
    child = null;
    if (!unavailable) scheduleRestart();
  });
  return child;
}

function stop() {
  const c = child;
  child = null;
  if (c && !c.killed) c.kill();
}

/** The running sidecar, waiting out a crash backoff if one is in effect. */
async function ensureChild() {
  if (child) return child;
  const wait = restartAt - Date.now();
  if (wait > 0) await sleep(wait);
  if (child) return child;
  return start();
}

/**
 * Recognize one image with PP-OCR.
 * Returns { words, ms } with word boxes in the image's own pixel space, or null
 * when the engine is unavailable (never throws for that).
 */
export async function ppocrWords(buffer) {
  const status = ppocrStatus();
  if (!status.available) return null;

  let proc;
  try {
    proc = await ensureChild();
  } catch (e) {
    return null;
  }

  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`PP-OCR timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      proc.stdin.write(JSON.stringify({ id, image: buffer.toString('base64') }) + '\n');
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      fail(`could not write to the PP-OCR sidecar: ${e.message}`);
      reject(e);
    }
  });
}
