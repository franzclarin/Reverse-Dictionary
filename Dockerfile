# syntax=docker/dockerfile:1
#
# One image, every dependency: the web app AND both Python environments.
#
# The database is NOT in here. The index is far too big to ship, so the
# container reads its address from the environment exactly as local development
# and production do. What this image DOES carry is the model, because the app
# loads it from disk and refuses to download one — without it, search is a hard
# error rather than a slow fallback.
#
# This is an extra way to run the project, not the deployed one. Pushing to the
# main branch still deploys as before, and nothing here changes that.
#
#   docker compose up web        ->  http://127.0.0.1:3000
#   docker compose up lab        ->  http://127.0.0.1:8888
#
# See DOCKER.md.

# --- Node dependencies -------------------------------------------------------
FROM node:22-bookworm-slim AS node-deps

# openssl: the database client needs it. ca-certificates: the build downloads
# the model over a secure connection in the next stage.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# The database folder is copied WITH the manifests, because installing runs a
# step that reads it. Copy only the manifests and the install dies.
COPY package.json package-lock.json ./
COPY prisma ./prisma

# Not a production-only install: the eval tools are development dependencies and
# must be present for the harness to run inside the container.
RUN npm ci



# --- Build the app -----------------------------------------------------------
FROM node-deps AS node-build

COPY . .

# A placeholder address, because one page builds a database client as it loads
# and refuses to start without one. The real address arrives at run time and
# never ends up inside the image.
ARG DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build"
ENV DATABASE_URL=${DATABASE_URL}

# This also downloads the model into the image, which is why the build needs
# network access.
RUN npm run build



# --- What actually runs ------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates openssl libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:python3.12-bookworm-slim /usr/local/bin/uv /usr/local/bin/uvx /usr/local/bin/

ENV NEXT_TELEMETRY_DISABLED=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_CACHE=1

ENV UV_PYTHON=3.12 \
    UV_PYTHON_INSTALL_DIR=/opt/uv-python

WORKDIR /app



# Two separate Python environments, deliberately not merged: the two halves of
# this project do not import each other, and keeping them apart makes that a
# fact about the filesystem rather than an agreement.
COPY training/pyproject.toml training/uv.lock ./training/
RUN cd training && UV_PROJECT_ENVIRONMENT=/opt/venv-training uv sync --frozen --no-install-project

COPY lab/pyproject.toml lab/uv.lock ./lab/
RUN cd lab && UV_PROJECT_ENVIRONMENT=/opt/venv-lab uv sync --frozen --no-install-project

# Registered for everyone, under the names the committed notebooks expect, so
# one server offers both and nothing asks which to use.
RUN /opt/venv-training/bin/python -m ipykernel install \
        --name reverse-dictionary --display-name "reverse-dictionary" \
    && /opt/venv-lab/bin/python -m ipykernel install \
        --name reverse-dictionary-lab --display-name "reverse-dictionary-lab"

# A login shell resets the path and would hand back the base image's python with
# none of the packages installed, so put it back.
ENV RD_VENV=/opt/venv-training
ENV PATH=/opt/venv-training/bin:$PATH
RUN printf 'export PATH="${RD_VENV:-/opt/venv-training}/bin:$PATH"\n' > /etc/profile.d/10-venv.sh

COPY --from=node-build /app /app

EXPOSE 3000 8888

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
