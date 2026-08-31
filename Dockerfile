# syntax=docker/dockerfile:1
#
# One image, every dependency: the Next.js serving path AND both Python
# surfaces (`training/`, `lab/`).
#
# The database is NOT in here. `GlossEmbedding` is 693,325 rows and lives in
# Neon; the container reads DATABASE_URL from the environment exactly as local
# dev and Vercel do. What this image does ship is the 87 MB ONNX model, because
# `lib/embedder.ts` loads it from disk with `allowRemoteModels = false` — a
# container without it is a hard 500 on /api/lookup, not a slow fallback.
#
# This is an ADDITIONAL surface. Vercel still deploys by pushing to `main`
# (the Git integration clones the repo and runs `npm run build`); nothing here
# changes that path, and `next.config.js` is deliberately untouched.
#
#   docker compose up web        ->  http://127.0.0.1:3000
#   docker compose up lab        ->  http://127.0.0.1:8888
#
# See DOCKER.md.

# ---------------------------------------------------------------------------
# Stage 1 — Node dependencies
# ---------------------------------------------------------------------------
# node:22, not 26: Next 14.2 targets an LTS line, and onnxruntime-node ships
# napi-v3 prebuilds for linux arm64/x64 that this line resolves cleanly.
FROM node:22-bookworm-slim AS node-deps

# openssl: Prisma 5's query engine links against libssl. ca-certificates:
# scripts/fetch-model.mjs talks to the HF CDN over TLS in the next stage.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# prisma/ is copied WITH the package files, not after them. package.json has
# `"postinstall": "prisma generate"`, which reads prisma/schema.prisma — copy
# only the manifests and `npm ci` dies on postinstall. The schema also changes
# far less often than app code, so the dependency layer still caches well.
COPY package.json package-lock.json ./
COPY prisma ./prisma

# Full install, not --omit=dev, for two reasons. The `prisma` CLI that
# postinstall invokes IS a devDependency, so a prod-only install cannot even
# complete; and this image is also the experimentation surface, where `tsx` and
# `wordnet-db` must be present or `npx tsx scripts/eval.ts` — the harness every
# Python number is confirmed through — cannot run inside the container.
RUN npm ci

# ---------------------------------------------------------------------------
# Stage 2 — Build the app
# ---------------------------------------------------------------------------
FROM node-deps AS node-build

COPY . .

# `app/sitemap.ts` imports lib/prisma.ts, which constructs a PrismaClient at
# module scope, and Prisma raises on a missing DATABASE_URL. The sitemap already
# swallows query failures ("DB may not be available during build"), so a
# syntactically valid dummy is all `next build` needs. The REAL DATABASE_URL is
# supplied at run time and never enters a layer.
ARG DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build"
ENV DATABASE_URL=${DATABASE_URL}

# = `npm run fetch-model && next build`. The model is gitignored and therefore
# never in the build context; fetching it here is the containerised form of
# RD-11's invariant. fetch-model.mjs verifies exact byte sizes, so a truncated
# download or an HTML error page served with a 200 fails the build rather than
# shipping a corrupt model. This step needs network.
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3 — Runtime: Node + both Python environments
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# libgomp1 is what onnxruntime-node and torch's CPU kernels want at load time;
# it is not in the slim base.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates openssl libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# uv 0.9.30 as of this writing. Same base tag lab/Dockerfile builds FROM, so
# both containers resolve the same tool.
COPY --from=ghcr.io/astral-sh/uv:python3.12-bookworm-slim /usr/local/bin/uv /usr/local/bin/uvx /usr/local/bin/

ENV NEXT_TELEMETRY_DISABLED=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_CACHE=1

# Debian bookworm ships Python 3.11; both projects require >=3.12,<3.13, so uv
# downloads a managed CPython. Pin WHERE, so it is a known path in the image
# rather than a cache directory that looks disposable.
ENV UV_PYTHON=3.12 \
    UV_PYTHON_INSTALL_DIR=/opt/uv-python

WORKDIR /app

# --- the two Python surfaces ------------------------------------------------
# Installed BEFORE the app source is copied, so editing a component or a
# notebook never reinstalls torch.
#
# Two venvs, not one, and they are not merged: lab/ deliberately does not import
# training/rdlib — rdlib already implements the scoring, retrieval, echo metric
# and paired McNemar test that the rebuild exists to reimplement. Separate
# environments make that rule true at the filesystem level, not just by
# convention.
COPY training/pyproject.toml training/uv.lock ./training/
RUN cd training && UV_PROJECT_ENVIRONMENT=/opt/venv-training uv sync --frozen --no-install-project

COPY lab/pyproject.toml lab/uv.lock ./lab/
RUN cd lab && UV_PROJECT_ENVIRONMENT=/opt/venv-lab uv sync --frozen --no-install-project

# Both kernels are registered SYSTEM-WIDE (/usr/local/share/jupyter), not with
# --prefix, so one JupyterLab server can offer both regardless of which venv
# started it. Each kernel.json's argv points at its own venv's python, so the
# separation above survives.
#
# The names are not decorative: the committed notebooks declare
# `reverse-dictionary` (training/) and `reverse-dictionary-lab` (lab/). A
# mismatch means every notebook opens with a "select kernel" prompt.
RUN /opt/venv-training/bin/python -m ipykernel install \
        --name reverse-dictionary --display-name "reverse-dictionary" \
    && /opt/venv-lab/bin/python -m ipykernel install \
        --name reverse-dictionary-lab --display-name "reverse-dictionary-lab"

# `ENV PATH` does not survive a login shell: `bash -l` re-sources /etc/profile
# and resets PATH, so `docker compose exec … bash -l` would silently get the
# base image's python and fail to import torch. Many IDE and terminal
# integrations open a login shell by default. RD_VENV lets a service pick its
# surface (compose sets it on `lab`); the default is training/, which is the
# environment tied to the app's own numbers.
ENV RD_VENV=/opt/venv-training
ENV PATH=/opt/venv-training/bin:$PATH
RUN printf 'export PATH="${RD_VENV:-/opt/venv-training}/bin:$PATH"\n' > /etc/profile.d/10-venv.sh

# --- the app ----------------------------------------------------------------
# node_modules, .next, models/ and the source, exactly as built. models/ is the
# 87 MB ONNX artifact; node_modules carries wordnet-db's WordNet 3.0 dict, so
# the Python surfaces read it straight out of the image (the files are latin1,
# not UTF-8 — reading them as UTF-8 mangles headwords silently).
COPY --from=node-build /app /app

# 3000 = next start, 8888 = jupyter lab. One image, two services.
EXPOSE 3000 8888

# Prove the route the whole image exists for is answering, not merely that the
# process is up. --network none makes this fail, which is the correct signal.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
