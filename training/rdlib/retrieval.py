"""
Search a local experiment file exactly, and score it against the frozen set.

The Python half of the fast inner loop, so an idea can be judged in seconds
rather than minutes.

This IS a second search path, normally the thing to avoid. Two things keep it
honest: the measuring model is the very one the live site serves, not a copy;
and the ranking rules are ported line for line, tie-break included, because ties
are not an edge case here -- words sharing a meaning have identical numbers.

Anything that would change a decision still goes through the TypeScript harness.
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
    Each row's alphabetical position, worked out once instead of per question.

    JavaScript and Python compare text slightly differently. They agree on
    everything in this dictionary, and only tied rows could ever be affected.
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
    The closest rows: best score first, then alphabetically.

    Arithmetic at the wider precision JavaScript uses, so the two agree.
    """
    if tie is None:
        tie = _tie_break(cell)

    scores = cell.vectors.astype(np.float64) @ np.asarray(query, dtype=np.float64)

        # The last key listed is the primary one, so read this bottom-up: best score
        # first, then word, then key.
    order = np.lexsort((tie.sense_rank, tie.word_rank, -scores))[:k]
    return [(int(i), float(scores[i])) for i in order]


def search(
    cell: Cell,
    query: np.ndarray,
    k: int,
    tie: _TieBreak | None = None,
) -> list[tuple[str, float]]:
    """
    The closest words for a question.

    Each meaning is expanded into its words in the dictionary's own order. Never
    sort that: it is the tie-break production uses, and alphabetical is worse on
    identical numbers. One meaning can fill several slots, so these scores are
    not interchangeable with the one-row-per-meaning kind.
    """
    if tie is None:
        tie = _tie_break(cell)

    if not cell.is_synset:
        return [(cell.words[i], s) for i, s in search_rows(cell, query, k, tie)]

    members = cell.synset_members or {}
    keys = cell.sense_keys or []
    out: list[tuple[str, float]] = []
    seen: set[str] = set()

        # Every meaning yields at least one word, so k meanings yield at least k.
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
    Score one question's ranked list.

    Pass the DEEP list: where the answer came is searched over all of it, while
    the results and echo cover the top few. That difference is what lets a run
    report "in the shortlist but not the top ten".
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
    Score the questions against an experiment file.

    Timing is deliberately not measured: a warm run of many questions back to
    back badly misrepresents what a user experiences. Use the TypeScript harness
    if a timing number is wanted.
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
    Pull the live index into a local file. Read-only.

    Useful for one thing: separating what the fast-but-approximate index loses
    from what the model itself gets wrong. About a gigabyte at full size; pass
    `limit` to sample while developing.
    """
    import os

    import psycopg

    from .paths import load_dotenv_local

    load_dotenv_local()
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set; expected it in .env.local")

        # The app's connection string carries settings this client rejects.
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
