"""
Reading and writing local experiment files -- the format shared with TypeScript.

An experiment file is a search index kept as a plain file. The harness scans one
exhaustively, so results are exact: no index shortcuts get mixed into a
comparison. That makes it the right tool for "is this model better" and the
wrong one for "is this fast".

The format is language-neutral, which is why this file is short: one file of raw
numbers with no header, and one describing them. Numbers are scaled to a
standard length on the way in, so comparing them is a plain multiply.

Writing one of these is how a Python-trained model gets an authoritative number:
build it here, then score it with the TypeScript harness.

The one real hazard, and it is silent: if the entries are measured by one model
and the questions by another, the comparison is nonsense that reads like a
finding. The harness defends against this by reading the model out of the file,
so writing one REQUIRES naming the model and refuses to guess.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .paths import cell_dir

DIM = 384

# The exact label the harness looks for to know rows are meanings rather than
# single words. Anything else and every synonym gets counted wrong.
SYNSET_VARIANT = "gloss_synset"


@dataclass
class Cell:
    meta: dict
    vectors: np.ndarray  # (rows, dim) float32, L2-normalised

    @property
    def words(self) -> list[str]:
        return self.meta["words"]

    @property
    def sense_keys(self) -> list[str] | None:
        return self.meta.get("senseKeys")

    @property
    def synset_members(self) -> dict[str, list[str]] | None:
        return self.meta.get("synsetMembers")

    @property
    def is_synset(self) -> bool:
        return self.meta.get("variant") == SYNSET_VARIANT

    def __repr__(self) -> str:
        return (
            f"<Cell {self.meta.get('cell')}: {self.vectors.shape[0]:,} rows x "
            f"{self.vectors.shape[1]}d, model={self.meta.get('model')}>"
        )


def cell_paths(name: str, directory: Path | None = None) -> tuple[Path, Path]:
    d = Path(directory) if directory is not None else cell_dir()
    return d / f"{name}.vec", d / f"{name}.json"


def load_cell(name: str, directory: Path | None = None) -> Cell:
    vec_path, json_path = cell_paths(name, directory)
    if not json_path.exists():
        raise FileNotFoundError(
            f"{json_path} not found.\n"
            "Cells are not committed (~230 MB each) and the darwin default "
            "directory lives under os.tmpdir(), which gets reaped. Set "
            "EVAL_CELL_DIR somewhere durable and rebuild."
        )

    meta = json.loads(json_path.read_text(encoding="utf-8"))
    dim = int(meta["dim"])
    rows = int(meta["rows"])
    vectors = np.fromfile(vec_path, dtype="<f4")
    if vectors.size != rows * dim:
        raise ValueError(
            f"{vec_path.name} holds {vectors.size} floats, expected "
            f"{rows * dim} ({rows} x {dim}). The cell is truncated or the "
            "sidecar is stale."
        )
    return Cell(meta=meta, vectors=vectors.reshape(rows, dim))


def inputs_sha256(texts: list[str]) -> str:
    """
    Fingerprint of the ordered text list.

    Joined with an invisible separator, so a text containing a line break cannot
    disguise itself as two entries.

    This exists because a half-finished parallel rebuild once left overlapping
    output, and correctness was argued from timestamps and speeds -- which is
    inference, not proof. A file now states exactly what it was built from, and
    the checker recomputes that and compares.
    """
    h = hashlib.sha256()
    for t in texts:
        h.update(t.encode("utf-8"))
        h.update(b"\x00")
    return h.hexdigest()


def write_cell(
    name: str,
    vectors: np.ndarray,
    words: list[str],
    *,
    model: str,
    note: str,
    variant: str = SYNSET_VARIANT,
    representation: str = "gloss",
    scale: str = "full",
    vocabulary: str = "wordnet",
    sense_keys: list[str] | None = None,
    synset_members: dict[str, list[str]] | None = None,
    input_texts: list[str] | None = None,
    directory: Path | None = None,
) -> tuple[Path, Path]:
    """
    Write a file the TypeScript harness can score.

    `model` MUST be the model that produced these numbers, and it must be
    reachable when the harness runs -- the harness measures the QUESTIONS with
    it, and would otherwise compare two different scales without complaint.

    Pass the input texts to record a fingerprint. Do it: that is what turns
    "this file is probably right" into a checkable claim.
    """
    d = Path(directory) if directory is not None else cell_dir()
    d.mkdir(parents=True, exist_ok=True)
    vec_path, json_path = cell_paths(name, d)

    vectors = np.ascontiguousarray(vectors, dtype="<f4")
    if vectors.ndim != 2:
        raise ValueError(f"vectors must be 2-D (rows, dim), got shape {vectors.shape}")
    rows, dim = vectors.shape
    if rows != len(words):
        raise ValueError(f"{rows} vectors but {len(words)} words -- these must correspond by index")

        # Everything downstream assumes the numbers are already scaled to a standard
        # length. Check rather than quietly fix: numbers arriving unscaled means the
        # model was configured wrong, and silently correcting it here would hide that
        # from whoever built the file.
    norms = np.linalg.norm(vectors, axis=1)
    if not np.allclose(norms, 1.0, atol=1e-3):
        bad = int((~np.isclose(norms, 1.0, atol=1e-3)).sum())
        raise ValueError(
            f"{bad} of {rows} vectors are not L2-normalised "
            f"(norms range {norms.min():.4f}..{norms.max():.4f}). "
            "Encode with normalize_embeddings=True."
        )

    vectors.tofile(vec_path)

    meta = {
        "cell": name,
        "model": model,
        "variant": variant,
        "representation": representation,
        "scale": scale,
        "vocabulary": vocabulary,
        "dim": dim,
        "rows": rows,
        "distinctWords": len(set(words)),
        "builtAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "note": note,
        "words": words,
        "precision": "float32",
        "vectorsSha256": hashlib.sha256(vec_path.read_bytes()).hexdigest(),
    }
    if sense_keys is not None:
        meta["senseKeys"] = sense_keys
    if synset_members is not None:
        meta["synsetMembers"] = synset_members
    if input_texts is not None:
        meta["inputsSha256"] = inputs_sha256(input_texts)

    json_path.write_text(json.dumps(meta), encoding="utf-8")
    return vec_path, json_path
