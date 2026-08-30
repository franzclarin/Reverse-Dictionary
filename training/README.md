# `training/` — the Python experimentation surface (RD-22)

Dev-only. **Nothing here is imported by the app, and nothing here is installed
on Vercel.** The serving path loads ONNX through Transformers.js and has no
Python in it at all.

## Why this exists

Before RD-22 this repo had no training code — no `.py`, no `.ipynb`, no `torch`.
The original fine-tune happened in Colab, outside version control, and
`reverse_dict_model.zip` is gone. What the repo *did* have was an unusually
careful evaluation half: a frozen benchmark, a pre-registered decision rule,
paired significance testing, and eleven committed runs.

This directory adds the missing training half **without damaging that**.

## Setup

```bash
brew install uv                     # once
cd training && uv sync              # creates .venv from uv.lock
uv run python -m ipykernel install --user \
    --name reverse-dictionary --display-name "reverse-dictionary"
```

Then set a durable cell directory — the darwin default is under `os.tmpdir()`
and **gets reaped**:

```bash
export EVAL_CELL_DIR=~/rd_eval_cells
```

Keep it outside the repo: the working tree is in OneDrive, which would try to
sync ~170 MB per cell.

## The notebooks, in order

| notebook | what it does |
|---|---|
| `00_setup_and_parity.ipynb` | **Run first.** Environment check, then the parity gate |
| `01_explore_the_evidence.ipynb` | Reads the committed runs. No training. Where retrieval actually fails |
| `02_biencoder_finetune.ipynb` | RD-09 — retrain the encoder itself |
| `03_crossencoder_finetune.ipynb` | RD-12/RD-13 — a reranker over the shortlist |
| `04_export_and_ship_gate.ipynb` | ONNX export, and the reconciliation with `eval.ts` |

## The one rule

> **Python numbers are for iteration. Any number that would change a decision
> gets confirmed through `npx tsx scripts/eval.ts` before it is written down.**

`rdlib` contains a second implementation of scoring and retrieval, which
`eval/METHODS.md` is explicit is a hazard: two scorers can drift, and a drifted
scorer produces numbers that *look* comparable to committed runs and are not.

The repo's answer to that problem is never "be careful" — it is a check.
`npm run verify-viz` pins the browser's reimplemented tokenizer to the real
`AutoTokenizer`; RD-17's `rd17_control` had to reproduce RD-16's `full_gloss_ft`
to the digit before either arm could be read.

`rdlib.parity` is the same move here. It re-derives the published figures from
the committed runs, re-derives the paired McNemar tests, recomputes echo from
scratch, and compares the PyTorch encoder against the ONNX model that actually
serves `/api/lookup`. **It raises on failure.** Run it after touching anything
in `rdlib/`:

```python
from rdlib import parity
parity.report()
```

Measured when RD-22 was built:

```
[PASS] frozen set sha256 + shape       405 rows, 287 authored-reachable
[PASS] wordnet parser                  117,791 synsets, matching gloss inputsSha256
[PASS] metrics: prod_wikt_shipped      lenient 25.1 / strict 20.6 / R@10 55.7 / MRR 0.307
[PASS] metrics: prod_gloss_shipped     lenient 24.0 / strict 20.6 / R@10 49.8
[PASS] metrics: baseline               lenient 10.1 / strict 5.6  / R@10 26.1
[PASS] mcnemar: gloss -> wikt          25W/22R p=0.77   (published 25W/22R)
[PASS] mcnemar: baseline -> gloss      55W/15R p<0.0001 (published 55W/15R)
[PASS] echo rule                       stored 17.4% vs recomputed 17.4%, worst row delta 0.0000
[PASS] encoder parity                  min cos 1.000000000, max abs diff 1.6e-07
```

And the full round-trip — a cell built in Python, scored by *both* scorers —
came back **287/287 identical** on deep rank, top-1, and full top-10 order.

## `rdlib`

Notebooks stay thin; every rule lives here exactly once. That is the repo's
existing convention, not a preference: `scripts/lib/probes.ts` carries the
instruction *"Change the rule here or not at all"*, and `cellText.ts` sits apart
from both its builder and its verifier so the two cannot drift.

| module | what | ported from |
|---|---|---|
| `paths` | path resolution, `EVAL_CELL_DIR` | `scripts/lib/localIndex.ts` |
| `evalset` | the frozen set, sha256 gate, **disjointness gate** | — |
| `metrics` | `score`, `percentile`, `mcnemar`, `compare` | `scripts/lib/metrics.ts` |
| `echo` | the lexical-echo rule | `scripts/lib/probes.ts` |
| `wordnet` | WordNet 3.0 parsing, gloss-text variants | `scripts/lib/wordnet.ts`, `cellText.ts` |
| `cells` | the `.vec`/`.json` interop format | `scripts/lib/localIndex.ts` |
| `retrieval` | exact scan, synset expansion, scoring | `scripts/lib/localIndex.ts` |
| `build` | WordNet → cell with any encoder | `scripts/build-encoder-cell.ts` |
| `runs` | `eval/runs/*.json` and the shortlist sidecars | — |
| `pairs` | training-pair recipes and the train/val split | new |
| `wiktionary` | the Kaikki dump, **for training pairs only** | *not* a port — see below |
| `parity` | the gate | — |

### `wiktionary.py` is deliberately not a port

`scripts/lib/wiktionary.ts` (`FILTER_VERSION = "rd17.2"`) is what built the
575,534 senses currently in `GlossEmbedding`, and its per-rule kill counts are a
committed artifact. A second implementation of *that* would be a real drift
hazard for a real production table.

`rdlib.wiktionary` only pulls `(word, pos, gloss)` triples out of the dump so
training pairs can be built. Nothing in it decides what is indexed, so nothing
in it can change what users search.

## Gotchas that will cost you time

| | |
|---|---|
| **WordNet files are `latin1`** | Not UTF-8. Reading them as UTF-8 mangles accented headwords and breaks `inputsSha256` parity |
| **`percentile` does not interpolate** | `metrics.ts` floor-indexes; `np.percentile` interpolates. Use `rdlib.metrics.percentile` |
| **384 dimensions to ship** | `GlossEmbedding` is `halfvec(384)`. A 768-dim win is unshippable — one of three reasons `all-mpnet-base-v2` was rejected at +2.8pp |
| **Mean pooling, no prefix** | Correct for the fine-tune, MiniLM and gte. **Silently wrong** for BGE (CLS pooling) and E5 (`"query: "` prefix) |
| **Cells get reaped** | Set `EVAL_CELL_DIR`. There were no cells on this machine when RD-22 was planned |
| **The disjointness gate will fire** | Eval targets are ordinary WordNet words. That is the gate working — see notebook 02 for the two legitimate responses |

## Cost of a full experiment

On an M5 with MPS, encoding runs at ~4,200 glosses/second:

| step | time |
|---|---|
| Build a full 117,791-synset cell | **~30 s** |
| Score it in Python (287 queries, exact scan to depth 100) | ~20 s |
| Score it with `eval.ts` | ~2 min |
| Fine-tune 1 epoch over ~35k pairs | ~10 min |

A representation experiment is a coffee break. RD-16's six cells were an
overnight job.

## What is gitignored

`.venv/`, `__pycache__/`, and `training/artifacts/` (checkpoints, generated
pairs, ONNX exports, pre-registrations). Notebooks are committed with **outputs
cleared**.
