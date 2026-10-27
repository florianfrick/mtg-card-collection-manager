# PP-OCR sidecar (the OCR engine)

`scripts/ppocr_sidecar.py` is the app's OCR engine — PaddleOCR's
**PP-OCRv6** (via `rapidocr`, ONNX Runtime) — read by `src/ppocr.js` and used by
every `/api/detect`, the CLI and both UIs. Detection cannot run without it: if
the Python environment below is missing, `/api/detect` fails with the reason
(`ppocrStatus()` in src/ppocr.js) and the UIs show that error. There is no
fallback engine.

## Rebuild

```powershell
py -m venv tools\ppocr\venv
tools\ppocr\venv\Scripts\python.exe -m pip install rapidocr onnxruntime
```

That is the whole setup. The PP-OCRv6 detection / angle / recognition models ship
**inside** the `rapidocr` wheel, so there is no model download or conversion step,
and nothing is fetched at runtime.

- Tested with `rapidocr` 3.9.2, `onnxruntime` 1.30.0, Python 3.14.
- `py -m venv` picks the newest installed Python; the interpreter first on `PATH`
  may be much older (here: 3.8.3), and `onnxruntime` 1.30 needs >= 3.11.
- Point the app at a different environment with `PPOCR_PYTHON=<path to python.exe>`.
