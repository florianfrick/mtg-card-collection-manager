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
collection); each finish is its own row with its own price. There are no
accounts: the app serves one collection, the one in its database.

Every copy also carries a **grade** (NM / LP / MP / HP / DMG), set when you add
it and editable later. The sell plan page turns that into a plan: what each card
nets if you list it yourself versus dropping it in one box, and the files to act
on it (see [Sell plan](#sell-plan)).

## Pages

| Page | What it does |
| --- | --- |
| `/` | Add cards: **camera** (hold cards one at a time), **image upload**, or **name search**. Camera mode used to be a separate page and now lives in the first section here. |
| `/collection.html` | Gallery with filters, set completion, collection value over time, and a zoom view per card (price trend, copy count, foil count, grade). |
| `/sell.html` | The sell plan: what the collection nets per route, the cards worth listing, editable assumptions, and the export files. |

All three share one shell: the page's own work in a wide left column, and a rail
on the right holding one small card per page you are **not** on. Each card
carries a number or two from the page it points at — the collection's size and
market value, the sell plan's two piles — so the link says what is behind it
before you click. The rail is sticky (a 272-card gallery scrolls a long way),
and below 760px it stacks under the content while the header pills take over the
navigation.

## Setup

Requires Node.js >= 22 and a Python environment for the OCR sidecar (there is no
fallback engine — detection cannot run without it).

```powershell
npm install

py -m venv tools\ppocr\venv
tools\ppocr\venv\Scripts\python.exe -m pip install rapidocr onnxruntime

npm start   # http://localhost:3000
```

**Upgrading from a version with accounts.** Older databases carry a `user_id` on
`collection` and `setting`, plus `user` and `session` tables. The first boot
folds every account's rows into the one collection (quantities add, the earlier
`added_at` wins) and drops those tables. Take a backup first — `npm run backup`
— because the columns are gone afterwards: going back to an older build needs
that backup, not just an older checkout.

## Docker

The same two runtimes in one image: Node for the app, Python for the OCR
sidecar. They stay in one container because they are one process tree — the app
spawns `scripts/ppocr_sidecar.py` and talks to it over stdin/stdout.

```bash
docker compose up -d --build     # http://localhost:3000
docker compose logs -f app
```

The database lives in the `mtg-data` volume at `/data/mtg.db`, so rebuilding the
image never touches the collection. The published port comes from `.env` (copy
`.env.example`).

**Bringing an existing collection across.** The container starts with an empty
database; copy yours in, then fix ownership (the app runs as uid 1000, and a
copied file lands as root):

```bash
docker compose up -d
docker compose cp data/mtg.db app:/data/mtg.db
docker compose exec -u root app chown node:node /data/mtg.db
docker compose restart app
```

To keep the database on the host instead of in a volume, swap the volume line in
`docker-compose.yml` for `- ./data:/data` — that directory must be writable by
uid 1000.

Notes that matter in a container:

- `PPOCR_PYTHON=/opt/ppocr/venv/bin/python` is set in the image; the code's
  default path is the Windows layout (`tools/ppocr/venv/Scripts/python.exe`).
- `GET /healthz` is the probe: one cheap read of the collection, no writes. It
  answers `{"ok":true,"ocr":false}` when the OCR engine is missing — the
  collection still works, only scanning does not.
- `SIGTERM` closes the HTTP server, the database and the OCR child, so
  `docker stop` is clean. Give it the 15s in `stop_grace_period`.
- Behind a reverse proxy, forward the original `Host` header (`proxy_set_header
  Host $host` in nginx). Cross-origin writes are refused by comparing the
  `Origin` host to `Host`, so a rewritten `Host` turns every save into a 403.
- The image is a few hundred MB (ONNX Runtime, OpenCV, the OCR models), and the
  OCR models ship inside the `rapidocr` wheel — nothing is downloaded at
  runtime. Tests are not in the image; run `npm test` on the host.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm start` | Run the web app |
| `npm test` | Unit tests (cue parser, storage contract, Scryfall wrapper, economics) — no server or Python needed |
| `npm run smoke [-- image]` | API smoke test against a running server (uses the first image in `card scans/` by default) |
| `npm run detect -- <image>` | Run detection on a single file from the CLI |
| `npm run mass [-- --reset]` | Batch-add every image in `card scans/` and write `mass_upload_results.md` |
| `npm run snapshot` | One-shot price snapshot (for cron/Task Scheduler) |
| `npm run backup` | Hot backup of the database to `data/backups/` (keeps the newest 14) |
| `npm run gc [-- --dry-run]` | Report cards nobody owns; `--orphans` drops them and their price history |

## Sell plan

`/sell.html` answers a narrower question than "what is this worth": **what
should I do with each card, and what does each route actually pay?** It is its
own page rather than a section on the gallery because it is a different job —
the gallery is for finding a card, this is for deciding what to do with it.

The retail benchmark is already stored — Scryfall's `usd` *is* the TCGplayer
market price — so the comparison needs no credentials and no network. Each card
is valued three ways:

| Route | What it nets | Certainty |
| --- | --- | --- |
| List individually | market − grade haircut − undercut − commission − payment fee − postage | only if it sells |
| One box to a buylist | market × grade × buylist rate | certain, one shipment |
| Neither | below the wholesale floor — postage costs more than the card | — |

Cards are bucketed (`list`, `box`, `ignore`), and the `list` bucket is cut at a
capacity the user sets. Effort is per batch, not per card, so "list all 600" is
never the answer: the cards with the biggest retail-over-wholesale gain get the
envelopes, the rest go in the box.

Every figure is an estimate and the page says so. Commission and per-order fees
are published rates; postage, the undercut, the buylist rate and the five grade
multipliers are assumptions — all editable under **Assumptions** and stored per
in the `setting` table.

### The files it produces

`GET /api/economics/export?format=…&bucket=…`

| Format | Bucket | What it is |
| --- | --- | --- |
| `tcgplayer` | list | Seller-portal inventory CSV, keyed on the TCGplayer product id (stored from Scryfall; rows without one are skipped and counted in `X-Skipped-Rows`) |
| `buylist` | box | Spreadsheet of what to send: quantity, set, number, grade, finish, expected payout |
| `list` | box | Paste-a-list text (`4 Lightning Bolt [2XM] 129`) for a buylist's bulk tool |

Deliberately **not** automated: no posting, no seller credentials. The app
prepares the file and the user reviews it before uploading — an automatic upload
with a stale price or a guessed grade is how a bad listing gets published at
scale.

### Grades

`NM`, `LP`, `MP`, `HP`, `DMG` (TCGplayer's scale). A grade is part of a row's
identity alongside the finish, so an NM and an LP copy of one printing are
separate rows with their own value. Set it when adding a card (the picker next to
the foil toggle) or change it later from the card's zoom view. Rows that predate
the column are near mint, which is what their stored market price already
describes.

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
| `MTG_BACKUP_DIR` | `data/backups` | Where `npm run backup` writes |

See `tools/ppocr/setup.md` for OCR sidecar details.

## Layout

```
src/            express app, storage, OCR pipeline, Scryfall client,
                economics (what each route nets), grades, set completion
public/         the two pages + shared.js (helpers) + camera.js (camera mode)
scripts/        CLI: detect, mass upload, smoke, snapshot, backup, gc, OCR sidecar
test/           node:test suites (matcher, db, scryfall, economics)
card scans/     the sample corpus used by `npm run mass` and the smoke test
```
