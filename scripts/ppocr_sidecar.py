"""PP-OCR sidecar: the OCR engine of MTG Collection Manager, spoken to by src/ppocr.js.

PaddleOCR's PP-OCRv6 (detection -> angle classifier -> recognition), run locally
through ONNX Runtime by the `rapidocr` package. The models ship inside that
wheel, so there is no download and no network use. See tools/ppocr/setup.md.

Protocol, one request per line on stdin and one reply per line on stdout:

    -> {"id": 7, "image": "<base64 of the uploaded file>"}
    <- {"id": 7, "ms": 436, "words": [{"text": "Shady Traveler", "conf": 100.0,
                                       "x0": 463, "y0": 88, "x1": 640, "y1": 129}]}

Boxes are axis-aligned bounding rectangles of PP-OCR's four corner points, in the
*original* image's pixel space — the frame src/ocr.js intoPreviewSpace uses to move
them onto the card-crop preview. `conf` is the recognition score as a percentage
(0-100), the scale the UI's confidence colours expect.
"""

import base64
import json
import sys
import time

import cv2
import numpy as np

# The model's character set includes Chinese and it occasionally misreads Latin
# text as a Chinese glyph; the Windows console codepage cannot encode those, so a
# decode error must not kill the sidecar mid-run.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from rapidocr import RapidOCR  # noqa: E402


def words_from(result):
    """PP-OCR result -> the {text, conf, x0, y0, x1, y1} list the app expects.

    `or []` is avoided on purpose: these fields come back as numpy arrays, and
    testing an array for truth raises "truth value of an array is ambiguous".
    """
    txts = getattr(result, "txts", None)
    scores = getattr(result, "scores", None)
    boxes = getattr(result, "boxes", None)
    if txts is None:
        return []
    scores = [] if scores is None else scores
    boxes = [] if boxes is None else boxes

    words = []
    for i, text in enumerate(txts):
        if not text:
            continue
        xs = [float(p[0]) for p in boxes[i]]
        ys = [float(p[1]) for p in boxes[i]]
        words.append(
            {
                "text": text,
                "conf": float(scores[i]) * 100.0 if i < len(scores) else 0.0,
                "x0": min(xs),
                "y0": min(ys),
                "x1": max(xs),
                "y1": max(ys),
            }
        )
    return words


def main():
    engine = RapidOCR()
    # Handshake, so the caller can tell "ready" from "still loading the models"
    # (that first load is the slow part) and fail fast if the engine cannot start.
    print(json.dumps({"ready": True}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        started = time.time()
        try:
            req = json.loads(line)
            raw = base64.b64decode(req["image"])
            img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
            if img is None:
                raise ValueError("could not decode the image")
            reply = {"id": req.get("id"), "words": words_from(engine(img))}
        except Exception as exc:  # report, never die: the caller stays alive
            reply = {"id": None, "words": [], "error": f"{type(exc).__name__}: {exc}"}
            try:
                reply["id"] = req.get("id")  # type: ignore[possibly-undefined]
            except Exception:
                pass
        reply["ms"] = round((time.time() - started) * 1000)
        print(json.dumps(reply, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
