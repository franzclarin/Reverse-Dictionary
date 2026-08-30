"""
Training-pair recipes, and the split that keeps them honest.

WHAT THE MODEL NEEDS TO LEARN, stated precisely, because two separate
measurements now point at it:

    A query is a DESCRIPTION. A gloss is a DEFINITION.
    They are related by PARAPHRASE, not by term overlap.

RD-12 found MS MARCO cross-encoders ranking glosses by overlap with the query
and losing to plain retrieval. RD-16 found `multi-qa-MiniLM` -- same
architecture, same width, same depth as the fine-tune, trained on 215M QA pairs
instead of 181k WordNet triplets -- losing 7.0 points, the only significant
result in that sweep. Different architectures, different pipeline stages, one
cause: QA and web-passage corpora teach question-to-answer-passage relevance,
and this task is not that.

So the recipes below are judged on ONE question: does this pair teach
description-to-definition paraphrase? Each says where it stands.

THE ORIGINAL RUN'S MISTAKE IS THE ONE TO AVOID. 181,149 triplets,
`MultipleNegativesRankingLoss`, 3 epochs, `eval_on_start: False`,
`prediction_loss_only: True` -- no evaluator and NO HELD-OUT SPLIT. Its recorded
10.9% describes memorisation and cannot be cited. `split()` below exists so that
cannot happen again, and `evalset.assert_disjoint()` is the harder gate on top.
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
    (gloss, lemma) -- THE ORIGINAL RECIPE, reproduced as a CONTROL.

    This is what the shipped fine-tune was trained on: 181,149 triplets of
    (gloss, lemma, negative-lemma). Include it to reproduce the baseline with a
    proper split, not because it is expected to be good.

    Why it is weak, measured rather than argued: `VocabEmbedding` stores bare
    lemma embeddings and `cos(embed(word), stored[word]) = 1.000000 +/- 1e-6`
    across 24 probe words, so this recipe trains the model to match a 12-word
    description against a ONE-TOKEN document. The whole RD-02 cutover exists
    because that representation loses to indexing gloss text by 12.9 points.
    """
    senses = list(senses if senses is not None else all_senses())
    return [
        Pair(query=s.gloss, doc=s.words[0], target=s.words[0], recipe="gloss_to_lemma")
        for s in senses
        if s.gloss and s.words
    ]


def pairs_example_to_gloss(senses: list[Sense] | None = None) -> list[Pair]:
    """
    (usage example, gloss) -- free, and genuinely cross-register.

    32,991 of 117,791 WordNet synsets carry quoted examples. An example is a
    natural sentence ("he loitered on the corner") and a gloss is a definition,
    so the pair spans exactly the register distance a real query does.

    The catch, and it is the same one that made `gloss_examples` a losing INDEX
    variant at -1.4pp: an example is about a specific referent, not the meaning.
    "how big is that part compared to the whole?" describes a situation, not
    `whole`. Expect noise; that is why it is offered as a supplement rather than
    a base.
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
    (Wiktionary gloss, WordNet gloss) -- TWO INDEPENDENT DEFINITIONS OF ONE WORD.

    This is the recipe worth trying first, and the reasoning is short: two
    lexicographers, working separately, defining the same word, produce a
    genuine paraphrase pair. That is the exact relation the task needs and the
    exact relation QA corpora do not teach. It costs nothing but a pass over a
    dump already on disk, and no language model is involved, so no LLM register
    leaks in (which is the risk RD-14 carries).

    Its honest weaknesses, stated up front so a null result is interpretable:
      - SENSE ALIGNMENT IS APPROXIMATE. Pairing is by (word, pos), so a
        polysemous word can pair Wiktionary's sense 2 with WordNet's sense 1.
        `max_per_word` limits how far that compounds.
      - Both sides are still DICTIONARY REGISTER. It teaches paraphrase, which
        is the thing; it does not teach user phrasing, which is RD-10/RD-14's
        separate problem. Do not claim it closes that gap.
      - Wiktionary is CC BY-SA. Attribution travels with anything derived.

    Requires the Kaikki dump -- `npm run supplement:fetch`.
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
                # A near-identical pair teaches nothing and inflates the count.
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
    Train/validation split, decided BEFORE training. Never after.

    `by_target=True` splits on the WORD, not the row, so every pair about
    `petrichor` lands on one side. Splitting by row would put one definition of
    a word in train and another in validation, and the validation number would
    then measure memorisation -- which is precisely the failure the original run
    made at full scale.

    This validation set is for watching the loss curve and choosing a
    checkpoint. IT IS NOT THE BENCHMARK. The benchmark is `eval/sets/v1.jsonl`,
    it is scored through the retrieval path, and METHODS 9a resolves on lenient
    R@1 there and nowhere else.
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
    A `datasets.Dataset` shaped for MultipleNegativesRankingLoss.

    MNRL takes (anchor, positive) columns and mines negatives IN-BATCH, so the
    batch size is the number of negatives each example sees. That is also the
    reason the original run's training-time figure is meaningless as a retrieval
    number: ranking against 63 in-batch negatives and ranking against 693,325
    live candidates are different problems, and this project exists partly
    because they disagreed.
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
