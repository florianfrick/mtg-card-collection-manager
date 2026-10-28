# syntax=docker/dockerfile:1
#
# One image, two runtimes: the Express app (Node 22) and the PP-OCR sidecar it
# spawns (Python). They are in the same image because they are one process tree
# talking over stdin/stdout — src/ppocr.js spawns scripts/ppocr_sidecar.py and
# reads one JSON reply per line. Splitting them into two containers would mean
# inventing a network protocol the app does not have.
#
# Debian (not Alpine) is deliberate: onnxruntime publishes manylinux_2_28
# wheels, which want glibc. Alpine's musl would force a source build of
# onnxruntime. bookworm ships Python 3.11, and onnxruntime 1.30 ships a cp311
# wheel — so the base image needs no extra Python.

FROM node:22-bookworm-slim

# ---- OCR engine -------------------------------------------------------------
# Its own venv, so the app's interpreter is never the one pip writes into and
# the system Python stays untouched. src/ppocr.js looks here via PPOCR_PYTHON
# (the code's default path is the Windows layout: tools/ppocr/venv/Scripts).
# The models ship inside the rapidocr wheel — nothing is downloaded at runtime.
#
# The chown is because the app runs as `node`: anything that writes beside its
# own package (a model cache, a converted graph) must not hit a root-owned
# directory. It stays in this same RUN so it costs no extra image layer.
ENV PPOCR_PYTHON=/opt/ppocr/venv/bin/python

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/ppocr/venv \
 && /opt/ppocr/venv/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/ppocr/venv/bin/pip install --no-cache-dir rapidocr==3.9.2 onnxruntime==1.30.0 \
 && chown -R node:node /opt/ppocr

# ---- App --------------------------------------------------------------------
WORKDIR /app
ENV NODE_ENV=production

# Dependencies first: this layer is cached until the lockfile changes, so editing
# source does not reinstall anything (and never re-runs pip above).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY scripts ./scripts

# The database is the only state there is, and it must outlive the container:
# MTG_DB points at the volume, and src/db.js creates the directory if missing.
# Backups written by `npm run backup` land in /data/backups, same volume.
ENV MTG_DB=/data/mtg.db
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# Not root: the app only ever writes to /data. HOME is set explicitly because
# the OCR child is a Python process, and Python tooling that caches (pip, rapidocr
# model files) resolves $HOME rather than the passwd entry.
ENV HOME=/home/node
USER node

EXPOSE 3000

# A probe carries no cookie, so /healthz sits outside /api (see src/index.js) —
# otherwise every check would mint a guest. start-period covers the boot
# housekeeping pass; there is no OCR warm-up in it (the sidecar starts lazily on
# the first scan, which keeps a cold start fast).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# --disable-warning=ExperimentalWarning matches `npm start`: node:sqlite is still
# flagged experimental, and the warning on every boot is only noise.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
