"""
Exact retrieval over a local cell, and scoring against the frozen set.

This is the Python half of RD-22's inner loop: encode, scan, rank, score --
without a database and without the TypeScript harness, so an experiment can be
judged in seconds rather than minutes.

IT IS A SECOND RETRIEVAL PATH, which METHODS warns about in as many words. Two
things keep it honest, and both matter:

  1. The ENCODER is not a second implementation. `SentenceTransformer(
     "franzclarin/ReverseDictionary")` and the ONNX model lib/embedder.ts serves
     were measured agreeing at cos = 1.0000001, max abs difference 1.3e-07 --
     float32 rounding. `parity.check_encoder()` re-runs that.
  2. The RANKING RULES below are ported line for line from
     scripts/lib/localIndex.ts, tie-break included, because on a gloss index
     ties are not an edge case: synset mates hold bit-identical vectors, and
     which mate surfaces first is worth 2.5 points of lenient R@1.

Anything that would change a decision still gets confirmed through
`npx tsx scripts/eval.ts`. See notebook 04.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .cells import Cell
from .echo import content_tokens, echoes_query
from .evalset import EvalRow
from .metrics import QueryResult


@dataclass(frozen=True)
class _TieBreak:
    """Precomputed lexicographic ranks, so the tie-break is a fast integer sort."""

    word_rank: np.ndarray
    sense_rank: np.ndarray


def _tie_break(cell: Cell) -> _TieBreak:
    """
    Lexicographic rank of each row's word and senseKey.

    `np.unique(..., return_inverse=True)` returns sorted uniques plus the index
    of each element within them -- which IS its lexicographic rank, computed
    once per cell instead of per query.

    Caveat worth knowing: JavaScript's `<` on strings compares UTF-16 code
    units and numpy compares code points. They agree on everything ASCII, which
    is every lemma in WordNet; a non-ASCII headword could in principle order
    differently, and only among rows whose scores are exactly equal.
    """
    words = np.asarray(cell.words, dtype=object)
    _, word_rank = np.unique(words.astype(str), return_inverse=True)

    keys = cell.sense_keys
    if keys is None:
        sense_rank = np.zeros(len(cell.words), dtype=np.int64)
    else:
        _, sense_rank = np.unique(np.asarray(keys, dtype=str), return_inverse=True)

    return _TieBreak(word_rank=word_rank.astype(np.int64), sense_rank=sense_rank.astype(np.int64))


def search_rows(
    cell: Cell,
    query: np.ndarray,
    k: int,
    tie: _TieBreak | None = None,
) -> list[tuple[int, float]]:
    """
    Top-k rows by cosine, with the harness's tie-break. Ports `searchLocalRows`.

    Order is: score descending, then word ascending, then senseKey ascending.
    The dot product is accumulated in float64 because JavaScript numbers are
    float64 and the TypeScript loop promotes each float32 as it multiplies.
    """
    if tie is None:
        tie = _tie_break(cell)

    scores = cell.vectors.astype(np.float64) @ np.asarray(query, dtype=np.float64)

    # lexsort's LAST key is primary, so this reads bottom-up: score desc first,
    # then word, then senseKey.
    order = np.lexsort((tie.sense_rank, tie.word_rank, -scores))[:k]
    return [(int(i), float(scores[i])) for i in order]


def search(
    cell: Cell,
    query: np.ndarray,
    k: int,
    tie: _TieBreak | None = None,
) -> list[tuple[str, float]]:
    """
    Top-k WORDS for a query vector.

    On a synset cell each retrieved row is expanded into its member words in
    WordNet's own order -- the harness's default `--expansion-order wordnet` --
    deduped by word, and truncated to k. That order is never sorted: it is the
    tie-break production actually uses, and alphabetical scores 2.5 points
    lower on identical vectors.

    NOTE THE SCORING SURFACE on a synset cell: one retrieved synset can occupy
    several top-k slots, so a 24-member synset at rank 1 fills the entire top 10
    by itself. These numbers are not a drop-in substitute for a per-sense cell's.
    """
    if tie is None:
        tie = _tie_break(cell)

    if not cell.is_synset:
        return [(cell.words[i], s) for i, s in search_rows(cell, query, k, tie)]

    members = cell.synset_members or {}
    keys = cell.sense_keys or []
    out: list[tuple[str, float]] = []
    seen: set[str] = set()

    # Each synset yields at least one word, so k synsets always yield >= k words.
    for row, sim in search_rows(cell, query, k, tie):
        key = keys[row] if row < len(keys) else ""
        for word in members.get(key, [cell.words[row]]):
            if word in seen:
                continue
            seen.add(word)
            out.append((word, sim))
            if len(out) >= k:
                return out
    return out


def score_row(
    row: EvalRow,
    ranked: list[tuple[str, float]],
    *,
    k: int = 10,
    embed_ms: float = 0.0,
    db_ms: float = 0.0,
) -> QueryResult:
    """
    Turn a ranked word list into a scored QueryResult. Ports eval.ts:480-530.

    `ranked` should be the DEEP list (rank_depth, default 100): `rank` and
    `lenient_rank` are searched over all of it, while `results` and `echo` are
    the top-k only. That asymmetry is deliberate and is what lets a run report
    "target is in the shortlist but not the top 10" -- the 53pp headroom every
    reranking ticket cites.
    """
    words = [w for w, _ in ranked]
    answers = row.answers

    target_idx = next((i for i, w in enumerate(words) if w.lower() == row.target.lower()), -1)
    lenient_idx = next((i for i, w in enumerate(words) if w.lower() in answers), -1)

    top = ranked[:k]
    top_words = [w for w, _ in top]
    tokens = content_tokens(row.query)
    echo = (
        sum(echoes_query(w, tokens) for w in top_words) / len(top_words)
        if top_words
        else 0.0
    )

    return QueryResult(
        id=row.id,
        query=row.query,
        target=row.target,
        source=row.source,
        results=top_words,
        similarities=[s for _, s in top],
        rank=None if target_idx == -1 else target_idx + 1,
        lenient_rank=None if lenient_idx == -1 else lenient_idx + 1,
        echo=echo,
        meta=row.meta,
        embed_ms=embed_ms,
        db_ms=db_ms,
    )


def run_eval(
    cell: Cell,
    rows: list[EvalRow],
    encode,
    *,
    k: int = 10,
    rank_depth: int = 100,
    batch_size: int = 64,
    progress: bool = True,
) -> list[QueryResult]:
    """
    Score `rows` against `cell`. `encode` takes list[str] -> (n, dim) float32.

    Latency is NOT measured here, deliberately. RD-20 is the standing ticket
    about how badly a warm sequential burst misrepresents production
    (61ms warm against 2,678ms cold on the same scan), and a local exact scan
    with no database in it would be even less meaningful. Use the TypeScript
    harness if a latency number is wanted, and read RD-20 before believing it.
    """
    queries = [r.query for r in rows]
    vectors = encode(queries)
    if vectors.shape[0] != len(rows):
        raise ValueError(f"encoder returned {vectors.shape[0]} vectors for {len(rows)} queries")
    if vectors.shape[1] != cell.vectors.shape[1]:
        raise ValueError(
            f"query dim {vectors.shape[1]} != cell dim {cell.vectors.shape[1]}. "
            "The encoder does not match the cell -- these vectors are in "
            "different spaces and every number would be meaningless."
        )

    tie = _tie_break(cell)
    depth = max(k, rank_depth)
    out: list[QueryResult] = []

    for i, row in enumerate(rows):
        ranked = search(cell, vectors[i], depth, tie)
        out.append(score_row(row, ranked, k=k))
        if progress and (i + 1) % 50 == 0:
            print(f"  scored {i + 1}/{len(rows)}", end="\r")

    if progress:
        print(f"  scored {len(rows)}/{len(rows)}    ")
    return out


# ------------------------------------------------------- pulling the live index


def pull_gloss_index(limit: int | None = None, *, batch: int = 20_000) -> Cell:
    """
    Build a Cell from the live `GlossEmbedding` table.

    READ-ONLY, and the notebooks never write to the database. This is how you
    get the ACTUAL production candidate set (693,325 senses since RD-17) into a
    local exact scan, which is useful for one specific thing: separating index
    approximation from representation. The live index is IVFFlat; a scan over
    the same rows is exact, and the gap between them is what `probes` buys.

    ~1 GB of float32 at full size. Pass `limit` to sample while developing.
    """
    import os

    import psycopg

    from .paths import load_dotenv_local

    load_dotenv_local()
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set; expected it in .env.local")

    # Prisma's pooled URL carries params libpq rejects.
    url = url.split("?")[0]

    vectors: list[np.ndarray] = []
    words: list[str] = []
    sense_keys: list[str] = []
    members: dict[str, list[str]] = {}

    sql = (
        'SELECT "synsetKey", lemmas, embedding::text FROM "GlossEmbedding" '
        'ORDER BY "synsetKey"'
    )
    if limit:
        sql += f" LIMIT {int(limit)}"

    with psycopg.connect(url) as conn:
        with conn.cursor(name="gloss_pull") as cur:
            cur.itersize = batch
            cur.execute(sql)
            for key, lemmas, embedding in cur:
                vec = np.fromstring(embedding.strip("[]"), sep=",", dtype=np.float32)
                vectors.append(vec)
                lemma_list = list(lemmas or [])
                words.append(lemma_list[0] if lemma_list else key)
                sense_keys.append(key)
                members[key] = lemma_list

    return Cell(
        meta={
            "cell": "live_gloss_index",
            "model": "franzclarin/ReverseDictionary",
            "variant": "gloss_synset",
            "representation": "gloss",
            "scale": "full",
            "vocabulary": "wordnet+wiktionary",
            "dim": int(vectors[0].shape[0]),
            "rows": len(vectors),
            "words": words,
            "senseKeys": sense_keys,
            "synsetMembers": members,
            "note": "pulled live from GlossEmbedding (read-only)",
        },
        vectors=np.vstack(vectors),
    )
