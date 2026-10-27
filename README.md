# MTG Collection Manager

A local Magic: The Gathering collection tracker. Scan a card (photo upload, live
camera, or manual name search), the exact Scryfall printing is identified via OCR,
and it lands in your SQLite collection with its current price.

## How it works

1. An image goes to the PP-OCR sidecar (PaddleOCR, run locally via ONNX Runtime).
2. The card name, set code, and collector number are parsed from the OCR text.
3. Scryfall resolves the exact printing; above a confidence threshold it is
   auto-added, otherwise candidates are offered to pick from.
4. Prices (USD/EUR) come from Scryfall, with a daily snapshot for history.

Foil copies are marked by hand (a toggle at add time, or later from the
collection); each finish is its own row with its own price. Collections work
anonymously (guest cookie) and are kept when you sign up.

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
| `npm run detect -- <image>` | Run detection on scan files from the CLI |
| `npm run mass [-- --reset]` | Batch-add every image in `card scans/` |
| `npm run smoke` | API smoke test against a running server |
| `npm run snapshot` | One-shot price snapshot (for cron/Task Scheduler) |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `MTG_DB` | `data/mtg.db` | Database file |
| `MTG_AUTO_ADD_MIN` | `0.5` | Min likelihood to auto-add a scan |
| `PPOCR_PYTHON` | `tools/ppocr/venv/Scripts/python.exe` | Sidecar interpreter |
| `PPOCR_TIMEOUT` | `180000` | Sidecar response timeout (ms) |
| `MTG_ALLOW_GUESTS` / `MTG_ALLOW_SIGNUP` | on | Guest browsing / sign-ups |

See `src/auth.js` for session and rate-limit knobs, and
`tools/ppocr/setup.md` for OCR sidecar details.

