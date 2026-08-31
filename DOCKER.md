# Docker — the whole project in one image

`docker compose up web` gives you the running app. `docker compose up lab`
gives you JupyterLab over both Python surfaces. **They are the same image**, so
building either builds both.

This is an *additional* surface. Vercel still deploys by pushing to `main`, and
`next.config.js` is untouched — see [DEPLOYMENT.md](DEPLOYMENT.md).

## What is in it

| | |
|---|---|
| Node | 22 (bookworm-slim), full `npm ci` — dev deps included, so `tsx` and the eval harness run inside the container |
| the app | `.next` built at image build time; `npm start` on **:3000** |
| the model | `models/franzclarin/ReverseDictionary` — the 87 MB ONNX artifact, fetched and byte-verified during the build |
| Python | **two** venvs: `/opt/venv-training` (`training/`) and `/opt/venv-lab` (`lab/`) |
| Jupyter | **:8888**, with both kernels registered: `reverse-dictionary` and `reverse-dictionary-lab` |
| the database | **not here.** Neon, over `DATABASE_URL` |

## Quick start

```bash
# DATABASE_URL must be in .env.local (it already is, if you have run the app locally)
docker compose up --build web        # -> http://127.0.0.1:3000
docker compose up --build lab        # -> http://127.0.0.1:8888
```

Both ports are bound to **loopback** on purpose: the app has no auth or rate
limiting by design (RD-06), and the Jupyter server runs with no token.

Without compose:

```bash
docker build -t reverse-dictionary .
docker run --rm --env-file .env.local -p 127.0.0.1:3000:3000 reverse-dictionary
```

## Why the database stays in Neon

`GlossEmbedding` is **693,325 rows** of `halfvec(384)` and is not in the repo.
A `pgvector` service in this compose file would come up with the schema and
**zero rows**, so `/api/lookup` would return an empty list and every eval number
would be meaningless. Rebuilding the index locally is an embedding job over
693k senses, not a seed script. So the container connects to the same Neon
database local dev does.

The consequence: **the first request after an idle period is slow** — Neon
auto-suspends its compute. `searchGlossSynsets()` already waits for the wake-up
(`maxWait: 15s`), and the same `EXPLAIN ANALYZE` numbers apply as anywhere
else: 61 ms warm, 2,678 ms cold.

## The two Python surfaces, and why they are two

`lab/` deliberately does not import `training/rdlib`, because `rdlib` already
implements the scoring, retrieval, echo metric and paired McNemar test that the
from-scratch rebuild exists to reimplement. Separate venvs make that rule true
at the filesystem level rather than by convention.

```bash
# the training surface — rdlib, psycopg, the optimum ONNX exporter.
# RD-22's parity gate, run inside the container: 9/9.
docker compose exec -w /app/training lab \
  /opt/venv-training/bin/python -c "from rdlib import parity; parity.report()"

# the lab surface — a login shell gets it, because RD_VENV is set on the service
docker compose exec lab bash -lc 'python -c "import torch; print(torch.__version__)"'
```

`RD_VENV` exists because **`ENV PATH` does not survive a login shell**:
`bash -l` re-sources `/etc/profile` and resets `PATH`, which would silently hand
back the base image's python with no torch in it. `/etc/profile.d/10-venv.sh`
re-prepends `${RD_VENV:-/opt/venv-training}/bin`. Many IDE and terminal
integrations open a login shell by default. (`lab/Dockerfile` found this the
hard way; this image inherits the fix.)

## The CUDA trap, and what it cost

`training/uv.lock` used to resolve torch to the **CUDA** build on linux —
`nvidia-cublas`, `nvidia-cudnn`, `triton` and thirteen more, ~2.9 GB of
libraries that can never execute, because Docker on macOS has no GPU at all.
Nobody had ever built `training/` for linux, so nothing surfaced it.

`training/pyproject.toml` now carries the same `[tool.uv.sources]` pin `lab/`
added when it hit this (that one took an image from **18.8 GB to 5.31 GB**):

```toml
torch = [{ index = "pytorch-cpu", marker = "sys_platform == 'linux'" }]
```

The marker is **linux-only**, so the macOS host still resolves `torch 2.13.0`
from PyPI with MPS, and one lockfile serves both. Re-locking removed 18 packages
and **changed no version of anything else** — verified by diffing every
`name`/`version` pair in `uv.lock` before and after.

**The container is CPU-only.** Docker on macOS runs a Linux VM with no Metal
passthrough. Embedding a full 117k-gloss cell is ~30 s on MPS and several
minutes here; a fine-tune epoch is ~10 min against ~40–80. Do real training on
the host (`cd training && uv sync && uv run jupyter lab`) and use the container
for portability, reproducibility, and handing the environment to someone else.

Corollary, worth keeping: **"it worked in the container" is not proof it works
natively**, and vice versa. The torch *build* differs (`2.13.0+cpu` linux vs
`2.13.0` macOS) even though the *version* cannot. Concretely: RD-22's parity gate
passes 9/9 in here, but its PyTorch-vs-served-ONNX check reads **max abs diff
1.90e-07** against the host's 1.6e-07. Both are float32 rounding; the point is
that this is a reproducible environment, not a bit-identical one.

## Is it really the same thing?

The harness runs inside the image and reproduces the shipped numbers to the digit:

```bash
docker compose exec web npx tsx scripts/eval.ts \
  --set eval/sets/v1.jsonl --index GlossEmbedding --tag docker_smoke
```

| | lenient R@1 | strict R@1 | R@10 | MRR@10 | echo |
|---|---|---|---|---|---|
| `prod_wikt_shipped` (committed) | 25.1% | 20.6% | 55.7% | 0.307 | 17.4% |
| the same set, inside the container | **25.1%** | **20.6%** | **55.7%** | **0.307** | **17.4%** |

RD-22's parity gate also passes 9/9 in here. Latency is the usual caveat: this is a
laptop-to-Neon round trip (`db p50 588 ms`), not what production does with both
sides in `iad1`.

## Things that will bite you

- **The build needs network.** `npm run build` runs `scripts/fetch-model.mjs`,
  which pulls 87 MB from the HF CDN and checks exact byte sizes. A truncated
  download or an HTML error page served with a 200 fails the build — which is
  correct: `lib/embedder.ts` loads with `allowRemoteModels = false`, so a
  missing file would be a hard 500 on `/api/lookup`, never a silent slow path.
- **`next build` runs against a dummy `DATABASE_URL`.** `app/sitemap.ts`
  constructs a `PrismaClient` at module scope. The dummy is a build ARG and
  never reaches a layer; the real one arrives via `--env-file` at run time.
- **`prisma/` is copied with `package.json`**, before `npm ci`, because
  `postinstall` runs `prisma generate` and needs the schema.
- **`eval/` is mounted read-only.** `docker compose exec lab touch /app/eval/x`
  failing is the feature. The frozen set is only a benchmark for as long as
  nothing can rewrite it.
- **Cells and Wiktionary sources live outside the image**, at
  `${EVAL_CELL_DIR:-~/rd_eval_cells}` and `${RD_SOURCE_DIR:-~/rd_sources}`.
  ~170 MB per cell and a 3.2 GB extraction have no business in a layer.
