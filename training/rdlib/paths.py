"""
Where everything lives, resolved once.

Notebooks run from `training/notebooks/`, scripts from the repo root, and a
stray `Path("eval/sets/v1.jsonl")` resolves differently in each. Every path in
this package is derived from `REPO_ROOT`, which is found by walking up for a
marker rather than by counting `..` segments.
"""

from __future__ import annotations

import os
from pathlib import Path


def _find_repo_root() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        # `training/` alone is not enough of a marker; CLAUDE.md plus prisma/
        # pins it to this repo specifically.
        if (parent / "CLAUDE.md").is_file() and (parent / "prisma").is_dir():
            return parent
    raise RuntimeError(
        f"could not locate the repo root above {here}. "
        "rdlib expects to live at <repo>/training/rdlib/."
    )


REPO_ROOT = _find_repo_root()
TRAINING_DIR = REPO_ROOT / "training"

# Artifacts written by the notebooks: checkpoints, generated pairs, cells built
# locally. Gitignored — see .gitignore. Never commit anything from here.
ARTIFACTS_DIR = TRAINING_DIR / "artifacts"

EVAL_DIR = REPO_ROOT / "eval"
EVAL_SETS_DIR = EVAL_DIR / "sets"
EVAL_RUNS_DIR = EVAL_DIR / "runs"
EVAL_DATA_DIR = EVAL_DIR / "data"

FROZEN_SET = EVAL_SETS_DIR / "v1.jsonl"

# The WordNet 3.0 dictionary files, shipped by the `wordnet-db` npm package.
# Read these rather than nltk's copy: scripts/lib/wordnet.ts reads exactly these
# bytes, and a second WordNet distribution would silently change gloss text and
# therefore every `inputsSha256` a cell records.
WORDNET_DICT_DIR = REPO_ROOT / "node_modules" / "wordnet-db" / "dict"

# The bundled ONNX model that lib/embedder.ts serves from (RD-11).
MODELS_DIR = REPO_ROOT / "models"


def cell_dir() -> Path:
    """
    Where local vector cells live.

    Mirrors `cellDir()` in scripts/lib/localIndex.ts so a cell written here is
    found by `npx tsx scripts/eval.ts --index-file <cell>` without arguments.

    The darwin default sits under `os.tmpdir()` and **gets reaped** — it was
    already empty when RD-22 was planned, which is why nothing on this machine
    could be scored against RD-16's cells. Set EVAL_CELL_DIR somewhere durable
    and outside the repo (the working tree is in OneDrive, which would try to
    sync ~230 MB of derived vectors).
    """
    env = os.environ.get("EVAL_CELL_DIR")
    if env:
        return Path(env)
    if os.name == "nt":
        return Path("C:/Temp/rd_eval_cells")
    import tempfile

    return Path(tempfile.gettempdir()) / "rd_eval_cells"


def load_dotenv_local() -> None:
    """Load `.env.local` (DATABASE_URL) without overriding a real environment."""
    from dotenv import load_dotenv

    load_dotenv(REPO_ROOT / ".env.local", override=False)
