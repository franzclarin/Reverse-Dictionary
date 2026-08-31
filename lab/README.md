# `lab/` — the from-scratch rebuild

A second, independent attempt at the reverse dictionary, built by hand rather
than generated. `training/` (RD-22) and the shipped app stay exactly as they
are — they are the **baseline this gets measured against**, not a starting
point to edit.

Dev-only. Nothing here is imported by the app; nothing here is installed on
Vercel.

## The one rule

**`lab/` does not import `training/rdlib`.**

`rdlib` already implements scoring, retrieval, the echo metric and the paired
McNemar test. Importing it would hand back precisely the parts this rebuild
exists to understand. Write your own.

The single thing shared with the old work is the **frozen eval set**, because it
is the only thing that makes the two numbers comparable.

## Two ways to run it, and which one to use

| | host (**use this**) | container |
|---|---|---|
| start | `uv sync` then `uv run jupyter lab` | `docker compose up --build` |
| device | **`mps`** — the M5 GPU | `cpu` |
| for | all real work | portability, reproducibility, learning Docker |

**Docker on macOS cannot reach the Apple GPU.** Containers run inside a Linux VM
and Metal is not passed through, so torch in the container is CPU-only —
roughly 5–10× slower for anything that touches the GPU. Embedding a full
117k-gloss index is ~30s on MPS and several minutes on CPU; a fine-tune epoch is
~10 min against ~40–80.

Both surfaces are built from the same `uv.lock`, so package *versions* cannot
drift. Three things still differ, and they are worth remembering:

- **The torch build.** `2.13.0` (macOS arm64, MPS) on the host;
  `2.13.0+cpu` (linux aarch64) in the image. PyPI's default linux wheel is the
  **CUDA** build, which drags ~2.9 GB of `nvidia/*` libraries that can never
  execute here — `[tool.uv.sources]` in `pyproject.toml` pins the CPU index for
  linux only, which took the image from **18.8 GB to 5.31 GB** and changes
  nothing on the host.
- **The Python patch version** — 3.12.14 host, 3.12.12 in the image (the base
  image ships its own).
- Therefore: **"it worked in the container" is not proof it works natively, and
  vice versa.**

### Host

```bash
cd lab
uv sync
uv run python -m ipykernel install --user \
    --name reverse-dictionary-lab --display-name "reverse-dictionary-lab"
uv run jupyter lab
```

Confirm the GPU is really executing — `is_available()` returning `True` is not
the same thing:

```bash
uv run python -c "import torch; a=torch.randn(2048,2048,device='mps'); \
  print((a@a).device)"        # -> mps:0
```

### Container

Needs a runtime; none ships with macOS. `brew install --cask orbstack` is the
lightest on Apple Silicon and provides the standard `docker` / `docker compose`
CLIs, so everything transfers to any other Docker host.

```bash
docker compose up --build     # -> http://localhost:8888
```

The port is bound to `127.0.0.1` because the Jupyter server runs with no token.
Do not publish it to a network.

The `reverse-dictionary-lab` kernel is registered inside the image under the
same name the host uses, so a committed notebook opens on either surface
without a "select kernel" prompt.

One trap the container will spring if you undo it: `ENV PATH` does **not**
survive a login shell — `bash -l` re-sources `/etc/profile` and resets PATH, so
`docker compose exec lab bash -l` would get the base image's python and fail to
import torch. The Dockerfile writes `/etc/profile.d/10-venv.sh` to prevent
this.

## Data

Mounted read-only in the container; on the host, reach it at the paths below.
Read-only is deliberate — the eval set is only a valid benchmark for as long as
nothing can rewrite it.

| what | host path | in container |
|---|---|---|
| frozen eval set (405 rows) | `../eval/sets/v1.jsonl` | `/workspace/eval/sets/v1.jsonl` |
| committed baseline runs | `../eval/runs/*.json` | `/workspace/eval/runs/` |
| WordNet 3.0 | `../node_modules/wordnet-db/dict` | `/workspace/data/wordnet` |
| Kaikki Wiktionary (3.2 GB), OEWN | `~/rd_sources` | `/workspace/data/sources` |

Override the last one with `RD_SOURCE_DIR`.

### Traps worth knowing before you hit them

- **WordNet's files are `latin1`, not UTF-8.** Decoding them as UTF-8 mangles
  headwords silently rather than raising.
- The eval set is **frozen**: sha256
  `cc03e1347ff696fb253c92dfb8b9e7455c64b2122f711ed5c288f33b06c0ccc8`. A new
  version means a new filename, never an in-place edit.
- Only **133 of 312** authored rows carry `acceptable[]`, so on the rest
  "lenient" recall equals strict recall. Any synonym-tie correction is partial.
- **`echo` in a run's rows is already a per-row fraction**, not a count. The
  aggregate is the *mean of those fractions* (`sum(echo)/n_rows`), not
  echoing-slots over total-slots. The two differ by ~10x and both look
  plausible. Rows also hold 7-10 results, not always 10.
- The eval set was authored **blind** — targets plus a one-word sense hint, no
  glosses consulted. That is the only reason it is worth anything against a
  model trained on WordNet glosses. Do not train on it.

## What the baseline scored

From `eval/runs/prod_wikt_shipped.json` — the current production path, 287
authored reachable queries:

| metric | value |
|---|---|
| lenient R@1 | 25.1% |
| strict R@1 | 20.6% |
| R@10 | 55.7% |
| echo rate | 17.4% |

That is the number to beat. **Echo rate** — the share of top-10 results sharing
a word stem with the query — is a primary metric, not a footnote: a change that
lifts recall while pushing echo up is usually not the improvement it looks like.

## Layout

```
lab/
  pyproject.toml      dependencies (the single source of truth)
  uv.lock             pinned; host and container both build from it
  Dockerfile          uv official base, CPU-only
  compose.yaml        jupyter on :8888, read-only data mounts
  notebooks/          your work
  artifacts/          checkpoints, exports — gitignored
```

Notebooks are committed **with outputs cleared** (repo-wide rule): a stored
output is a number nobody can date.
