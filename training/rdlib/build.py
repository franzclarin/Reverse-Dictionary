"""
Building cells from WordNet with any sentence-transformers encoder.

The Python counterpart to `scripts/build-encoder-cell.ts`, and it exists for the
same reason that script does: to go WordNet -> cell with no database and no pool
manifest, at full scale, so absolute recall is comparable to a production run.

Roughly 2,800 glosses/second on an M5 via MPS, so all 117,791 WordNet synsets
take about 40 seconds. That is the point of doing this locally -- RD-16's six
cells were an overnight job; here a representation experiment is a coffee break.
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
    Load a sentence-transformers encoder, preferring MPS on Apple silicon.

    MEAN POOLING, NO PREFIX -- inherited from whatever the model's own
    `modules.json` declares. That is correct for the fine-tune, its base, gte and
    the MiniLM family, and WRONG and SILENT for two families worth naming:

      - BGE expects CLS pooling.
      - E5 expects an instruction prefix ("query: " / "passage: ").

    Encoding either of those here produces plausible-looking vectors that are
    simply not what the model was trained to produce, and the resulting cell
    reads as a representation result. If you test one, prefix and pool it
    correctly on BOTH sides -- documents here and queries at scoring time -- or
    the comparison is meaningless.
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
    Build a full-scale synset cell and write it where `scripts/eval.ts` finds it.

    `variant` selects the indexed text via `wordnet.gloss_text_for` -- this is
    the cheapest real experiment in the project, so it is the first argument
    worth changing.

    The cell is keyed by SYNSET, matching production: `GlossEmbedding` holds one
    row per sense and `expandSynsets()` unpacks each into its member lemmas at
    query time. Collapsing to synsets was measured lossless (287/287 identical
    top-10 order, 0 discordant rank-1 pairs).
    """
    senses = list(senses if senses is not None else all_senses())
    if limit:
        senses = senses[:limit]

    texts = [gloss_text_for(variant, s) for s in senses]
    # Member order is WordNet's own and is never sorted -- it is the tie-break
    # production uses, and it is worth 2.5 points over alphabetical.
    words = [s.words[0] if s.words else s.key for s in senses]
    sense_keys = [s.key for s in senses]
    members = {s.key: list(s.words) for s in senses}

    model = load_encoder(model_id, device=device)
    started = time.time()
    vectors = encode_texts(model, texts, batch_size=batch_size)
    elapsed = time.time() - started

    dim = vectors.shape[1]
    if dim != 384:
        # Not fatal here -- a wider cell is still a valid experiment -- but it
        # cannot ship. GlossEmbedding is halfvec(384), which is exactly why
        # all-mpnet-base-v2 was rejected despite scoring +2.8pp.
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
