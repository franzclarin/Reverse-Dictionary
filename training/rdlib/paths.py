"""
Where everything lives, worked out once.

Notebooks run from one directory and scripts from another, so a relative path
means different things in each. Every path here is built from the repo root,
which is found by walking up until a marker appears rather than by counting
directories.
"""

from __future__ import annotations

import os
from pathlib import Path


def _find_repo_root() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
                # `training/` alone is not a distinctive enough marker; these two
                # together pin it to this repo specifically.
        if (parent / "CLAUDE.md").is_file() and (parent / "prisma").is_dir():
            return parent
    raise RuntimeError(
        f"could not locate the repo root above {here}. "
        "rdlib expects to live at <repo>/training/rdlib/."
    )


REPO_ROOT = _find_repo_root()
TRAINING_DIR = REPO_ROOT / "training"

# What the notebooks write: checkpoints, generated examples, locally built
# files. Not tracked in version control. Never commit anything from here.
ARTIFACTS_DIR = TRAINING_DIR / "artifacts"

EVAL_DIR = REPO_ROOT / "eval"
EVAL_SETS_DIR = EVAL_DIR / "sets"
EVAL_RUNS_DIR = EVAL_DIR / "runs"
EVAL_DATA_DIR = EVAL_DIR / "data"

FROZEN_SET = EVAL_SETS_DIR / "v1.jsonl"

# The dictionary files shipped with this project. Read these rather than a
# library's own copy: the TypeScript side reads exactly these bytes, and a second
# copy of the dictionary would silently change the text and every fingerprint.
WORDNET_DICT_DIR = REPO_ROOT / "node_modules" / "wordnet-db" / "dict"

# The model that ships with the app and is loaded from disk.
MODELS_DIR = REPO_ROOT / "models"


def cell_dir() -> Path:
    """
    Where local experiment files live.

    Matches the TypeScript side, so a file written here is found by the harness
    without extra arguments.

    The default on a Mac sits in a temporary directory and GETS DELETED -- it was
    already empty when this was planned, which is why nothing here could be
    scored against the earlier experiments. Point EVAL_CELL_DIR somewhere
    durable and outside the repo.
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
