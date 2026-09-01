"""
Building experiment files from the dictionary, with any model.

The Python counterpart to the TypeScript builder, and it exists for the same
reason: to go from dictionary to file with no database in between, at full size,
so the scores are comparable to a production run.

Fast enough that the whole dictionary takes under a minute on this machine. That
is the point of doing it locally -- the same six experiments were once an
overnight job, and here one is a coffee break.
"""

from __future__ import annotations

import time
from pathlib import Path

import numpy as np

from .cells import SYNSET_VARIANT, write_cell
from .wordnet import Sense, all_senses, gloss_text_for

PRODUCTION_MODEL = "franzclarin/ReverseDictionary"
BASE_MODEL = "sentence-transformers/all-MiniLM-L6-v2"


def load_encoder(model_id: str = PRODUCTION_MODEL, device: str | None = None):
    """
    Load a model, using the Mac GPU where available.

    Every model is handled the way its own settings declare. That is right for
    the models used here, and wrong and silent for two families worth naming:
    one expects a different way of combining word parts, and one expects a
    prefix on every input.

    Measuring either of those here produces plausible-looking numbers that are
    simply not what the model was trained to produce, and the result reads as a
    real finding. If you test one, handle it correctly on BOTH sides -- the
    entries here and the questions at scoring time -- or the comparison is
    meaningless.
    """
    import torch
    from sentence_transformers import SentenceTransformer

    if device is None:
        device = "mps" if torch.backends.mps.is_available() else "cpu"
    return SentenceTransformer(model_id, device=device)


def encode_texts(model, texts: list[str], batch_size: int = 256, progress: bool = True) -> np.ndarray:
    """Encode to L2-normalised float32, the form every cell consumer assumes."""
    vectors = model.encode(
        texts,
        batch_size=batch_size,
        normalize_embeddings=True,
        show_progress_bar=progress,
        convert_to_numpy=True,
    )
    return np.ascontiguousarray(vectors, dtype=np.float32)


def build_wordnet_cell(
    name: str,
    *,
    model_id: str = PRODUCTION_MODEL,
    variant: str = "gloss",
    senses: list[Sense] | None = None,
    limit: int | None = None,
    batch_size: int = 256,
    directory: Path | None = None,
    note: str | None = None,
    device: str | None = None,
) -> dict:
    """
    Build a full-size experiment file where the TypeScript harness will find it.

    `variant` picks which text gets indexed -- the cheapest real experiment in
    this project, and so the first argument worth changing.

    Keyed by meaning, matching production, where each row is unpacked into its
    words at query time. Collapsing to meanings was measured lossless.
    """
    senses = list(senses if senses is not None else all_senses())
    if limit:
        senses = senses[:limit]

    texts = [gloss_text_for(variant, s) for s in senses]
        # The word order is the dictionary's own and is never sorted -- it is the
        # tie-break production uses, and it is measurably better than alphabetical.
    words = [s.words[0] if s.words else s.key for s in senses]
    sense_keys = [s.key for s in senses]
    members = {s.key: list(s.words) for s in senses}

    model = load_encoder(model_id, device=device)
    started = time.time()
    vectors = encode_texts(model, texts, batch_size=batch_size)
    elapsed = time.time() - started

    dim = vectors.shape[1]
    if dim != 384:
                # Not fatal here -- a wider model is still a valid experiment -- but it
                # cannot ship, because the live column has a fixed width. That is exactly
                # why one otherwise promising model was rejected.
        print(
            f"  NOTE: {dim}-dim encoder. Measurable, but NOT shippable: "
            "GlossEmbedding is halfvec(384)."
        )

    vec_path, json_path = write_cell(
        name,
        vectors,
        words,
        model=model_id,
        variant=SYNSET_VARIANT,
        representation="gloss",
        scale="full",
        vocabulary="wordnet",
        sense_keys=sense_keys,
        synset_members=members,
        input_texts=texts,
        directory=directory,
        note=note
        or f"RD-22 python build; text variant={variant}; model={model_id}",
    )

    return {
        "cell": name,
        "rows": len(senses),
        "dim": dim,
        "model": model_id,
        "variant": variant,
        "seconds": round(elapsed, 1),
        "rate": round(len(senses) / elapsed) if elapsed else None,
        "vec": str(vec_path),
        "json": str(json_path),
        "mb": round(vec_path.stat().st_size / 1_048_576, 1),
    }
