"""
Recipes for building training examples, and the split that keeps them honest.

What the model needs to learn: a question is a DESCRIPTION and a dictionary entry
is a DEFINITION, related by rephrasing, not by sharing words. Two experiments
already failed for that reason, so every recipe below says where it stands on it.

The original run held nothing back to test against, so its recorded score
describes memorisation and cannot be quoted. The split below, and a harder gate
on top of it, exist so that cannot happen again.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

from .wordnet import Sense, all_senses


@dataclass(frozen=True)
class Pair:
    """One training example. `query` is the description side, `doc` the definition side."""

    query: str
    doc: str
    target: str  # the word the pair is "about", for the disjointness gate
    recipe: str


# --------------------------------------------------------------- the recipes


def pairs_gloss_to_lemma(senses: list[Sense] | None = None) -> list[Pair]:
    """
    Definition to word -- the original recipe, kept as a control.

    Reproduces the baseline properly; not expected to be good. It trains the
    model to match a twelve-word description against a single word, which is the
    representation the index rebuild replaced.
    """
    senses = list(senses if senses is not None else all_senses())
    return [
        Pair(query=s.gloss, doc=s.words[0], target=s.words[0], recipe="gloss_to_lemma")
        for s in senses
        if s.gloss and s.words
    ]


def pairs_example_to_gloss(senses: list[Sense] | None = None) -> list[Pair]:
    """
    Example sentence to definition -- free, and genuinely spans the gap.

    An example is a natural sentence and a definition is a definition, so the
    pair spans the distance a real question does. The catch: an example is about
    one particular case, not the meaning. Expect noise; a supplement, not a base.
    """
    senses = list(senses if senses is not None else all_senses())
    out: list[Pair] = []
    for s in senses:
        if not s.gloss or not s.words:
            continue
        for example in s.examples:
            if len(example) >= 20:
                out.append(
                    Pair(
                        query=example,
                        doc=s.gloss,
                        target=s.words[0],
                        recipe="example_to_gloss",
                    )
                )
    return out


def pairs_wiktionary_paraphrase(
    senses: list[Sense] | None = None,
    *,
    limit_entries: int | None = None,
    max_per_word: int = 2,
) -> list[Pair]:
    """
    Two independent definitions of one word.

    Worth trying first: two lexicographers defining the same word separately
    produce a genuine rephrasing, which is exactly what this task needs. Costs
    one pass over a file already on disk, and no machine-written phrasing gets in.

    Honest weaknesses, so a null result can be read. Senses are matched only by
    spelling and part of speech, so a word with several meanings can pair the
    wrong two. Both sides are still dictionary language, so it does not teach how
    people actually talk. And the source is share-alike licensed.
    """
    from .wiktionary import glosses_by_word

    senses = list(senses if senses is not None else all_senses())
    wikt = glosses_by_word(limit_entries=limit_entries)

    out: list[Pair] = []
    for s in senses:
        if not s.gloss or not s.words:
            continue
        for word in s.words:
            candidates = wikt.get((word.lower(), s.pos))
            if not candidates:
                continue
            for gloss in candidates[:max_per_word]:
                                # A nearly identical pair teaches nothing and pads the count.
                if gloss.lower() == s.gloss.lower():
                    continue
                out.append(
                    Pair(
                        query=gloss,
                        doc=s.gloss,
                        target=word,
                        recipe="wiktionary_paraphrase",
                    )
                )
            break  # one lemma per synset is enough; mates share the gloss
    return out


RECIPES = {
    "gloss_to_lemma": pairs_gloss_to_lemma,
    "example_to_gloss": pairs_example_to_gloss,
    "wiktionary_paraphrase": pairs_wiktionary_paraphrase,
}


# ----------------------------------------------------------------- the split


def split(
    pairs: list[Pair],
    *,
    val_fraction: float = 0.05,
    seed: int = 20260830,
    by_target: bool = True,
) -> tuple[list[Pair], list[Pair]]:
    """
    Split into training and checking data, decided BEFORE training. Never after.

    Splits on the WORD, not the row, so everything about `petrichor` lands on one
    side; otherwise the check measures memorisation. This is for choosing when to
    stop, not for judging the result -- that is the frozen question set.
    """
    rng = random.Random(seed)

    if not by_target:
        shuffled = pairs[:]
        rng.shuffle(shuffled)
        cut = int(len(shuffled) * (1 - val_fraction))
        return shuffled[:cut], shuffled[cut:]

    targets = sorted({p.target for p in pairs})
    rng.shuffle(targets)
    n_val = int(len(targets) * val_fraction)
    val_targets = set(targets[:n_val])

    train = [p for p in pairs if p.target not in val_targets]
    val = [p for p in pairs if p.target in val_targets]
    return train, val


def to_dataset(pairs: list[Pair]):
    """
    The data shaped the way the training method expects.

    It learns by contrasting each example against the others in its batch, so
    batch size decides how many wrong answers each one faces. Which is why the
    original run's training score means nothing as a search result: beating 63
    alternatives and beating 693,325 are different problems.
    """
    from datasets import Dataset

    return Dataset.from_dict(
        {
            "anchor": [p.query for p in pairs],
            "positive": [p.doc for p in pairs],
        }
    )


def summarise(pairs: list[Pair]) -> dict:
    from collections import Counter

    by_recipe = Counter(p.recipe for p in pairs)
    return {
        "n": len(pairs),
        "distinct_targets": len({p.target for p in pairs}),
        "by_recipe": dict(by_recipe),
        "mean_query_chars": round(sum(len(p.query) for p in pairs) / max(1, len(pairs)), 1),
        "mean_doc_chars": round(sum(len(p.doc) for p in pairs) / max(1, len(pairs)), 1),
    }
