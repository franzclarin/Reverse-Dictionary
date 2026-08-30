"""
Reading and writing local vector cells -- the interop format with the TS harness.

A "cell" is a file-backed vector index. `scripts/eval.ts --index-file <cell>`
scans one exhaustively, so results are EXACT by construction: no IVFFlat
approximation is mixed into a representation comparison. That is what makes a
cell the right instrument for "is this encoder better" and the wrong one for
"is this fast".

The format is language-neutral, which is why this module is short:

    <cell>.vec    raw little-endian float32, rows * dim, NO HEADER
    <cell>.json   { cell, model, variant, dim, rows, words[], senseKeys[], ... }

Vectors are L2-normalised on the way in (the sentence-transformers Normalize
layer), so cosine similarity is a plain dot product.

WRITING A CELL IS HOW A PYTHON-TRAINED MODEL GETS AN AUTHORITATIVE NUMBER.
Build it here, then score it with the TypeScript harness. See notebook 04.

THE MODEL/QUERY PAIRING IS THE WHOLE HAZARD, and it is silent. Documents encoded
by one model and queries by another compare vectors from two different spaces,
and the output reads as a representation result rather than the nonsense it is.
`eval.ts` defends against this by reading the encoder from `meta.model`, so
`write_cell()` REQUIRES the model id and refuses to guess.
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

# The string the harness recognises as a synset cell (`eval.ts`:
# `local?.meta.variant === "gloss_synset"`), which is what switches on member
# expansion. A synset cell whose variant is anything else will be scored as if
# each row were a single word, and every synonym will be counted wrong.
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
    SHA256 over the ordered input text list -- ports `inputsSha256` in cellText.ts.

    NUL-separated rather than newline-separated so that a text containing a
    newline could not forge a different partition of the same byte stream.

    This exists because nine concurrent processes once wrote overlapping cell
    outputs during an interrupted rebuild, and correctness was argued from
    timestamps and throughput rates -- which is inference, not proof. A cell
    states the exact text sequence it was built from, and the verifier
    recomputes that sequence and compares.
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
    Write a cell readable by `scripts/eval.ts --index-file <name>`.

    `model` MUST be the id of the encoder that produced `vectors`, and the same
    encoder must be reachable by Transformers.js when the harness scores it --
    the harness encodes QUERIES with `meta.model` and will otherwise compare two
    different vector spaces without complaint.

    Pass `input_texts` to record `inputsSha256`. Do it: it is what turns "this
    cell is probably right" into a checkable claim.
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

    # L2 normalisation is assumed by every consumer, since cosine is scored as a
    # plain dot product. Check rather than silently renormalise: a cell arriving
    # unnormalised means the encoder was configured wrong, and quietly fixing it
    # here would hide that from the notebook that built it.
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
