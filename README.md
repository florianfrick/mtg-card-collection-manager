# MTG Collection Manager

A local Magic: The Gathering collection tracker. Scan a card — live camera, an
image upload, or a name search — and the exact Scryfall printing is identified
via OCR and added to your SQLite collection with its current price.

## How it works

1. An image goes to the PP-OCR sidecar (PaddleOCR, run locally via ONNX Runtime).
2. The card name, set code, and collector number are parsed from the OCR text.
3. Scryfall resolves the exact printing; above a confidence threshold it is
   auto-added, otherwise candidates are offered to pick from.
4. Prices (USD/EUR) come from Scryfall, with a daily snapshot for history.

Foil copies are marked by hand (a toggle at add time, or later from the
collection); each finish is its own row with its own price. Collections work
anonymously (guest cookie) and are kept when you sign up.

## Pages

| Page | What it does |
| --- | --- |
| `/` | Add cards: **camera** (hold cards one at a time), **image upload**, or **name search**. Camera mode used to be a separate page and now lives in the first section here. |
| `/collection.html` | Gallery with filters, set completion, collection value over time, and a zoom view per card (price trend, copy count, foil count). |
| `/login.html` | Sign in / create an account. A guest collection comes along with it. |

## Setup

Requires Node.js >= 22 and a Python environment for the OCR sidecar (there is no
fallback engine — detection cannot run without it).

```powershell
npm install

py -m venv tools\ppocr\venv
tools\ppocr\venv\Scripts\python.exe -m pip install rapidocr onnxruntime

npm start   # http://localhost:3000
```

## Scripts

| Command | Purpose |
| --- | --- |
| `npm start` | Run the web app |
| `npm test` | Unit tests (cue parser, storage contract, Scryfall wrapper) — no server or Python needed |
| `npm run smoke [-- image]` | API smoke test against a running server (uses the first image in `card scans/` by default) |
| `npm run detect -- <image>` | Run detection on a single file from the CLI |
| `npm run mass [-- --reset]` | Batch-add every image in `card scans/` and write `mass_upload_results.md` |
| `npm run snapshot` | One-shot price snapshot (for cron/Task Scheduler) |
| `npm run backup` | Hot backup of the database to `data/backups/` (keeps the newest 14) |
| `npm run gc [-- --dry-run]` | Remove guest identities that never collected a card (`--all-guests`, `--empty-accounts` to widen it) |

## Set completion

`GET /api/sets` pairs each set in your collection with Scryfall's **printed
size** (`printed_size`, the number on the cards — "143 / 280"), so completion is
measured against the same number printed on the card. The collection page shows
one row per set; clicking a row filters the gallery to that set. Sets with no
Scryfall data still report their owned count, just without a total.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `MTG_DB` | `data/mtg.db` | Database file |
| `MTG_AUTO_ADD_MIN` | `0.5` | Min likelihood to auto-add a scan |
| `PPOCR_PYTHON` | `tools/ppocr/venv/Scripts/python.exe` | Sidecar interpreter |
| `PPOCR_TIMEOUT` | `180000` | Sidecar response timeout (ms) |
| `PPOCR_DEBUG` | off | Forward the sidecar's stderr (model logs) to the console |
| `MTG_SETS_RETRY_MS` | `300000` | How long to wait before retrying a failed Scryfall set list |
| `MTG_ALLOW_GUESTS` / `MTG_ALLOW_SIGNUP` | on | Guest browsing / sign-ups |
| `MTG_BACKUP_DIR` | `data/backups` | Where `npm run backup` writes |

See `src/auth.js` for session and rate-limit knobs, and
`tools/ppocr/setup.md` for OCR sidecar details.

## Layout

```
src/            express app, storage, auth, OCR pipeline, Scryfall client
public/         the three pages + shared.js (helpers) + camera.js (camera mode)
scripts/        CLI: detect, mass upload, smoke, snapshot, backup, gc, OCR sidecar
test/           node:test suites (matcher, db, scryfall)
card scans/     the sample corpus used by `npm run mass` and the smoke test
```
