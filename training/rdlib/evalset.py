"""
The frozen evaluation set, and the gate that keeps it frozen.

`eval/sets/v1.jsonl` is the benchmark every number in this project is measured
against. It is frozen: a new version means a NEW FILENAME, never an in-place
regeneration. An in-place edit is otherwise completely silent and invalidates
every run already recorded, so `load_eval_set()` verifies the sha256 on every
load and raises rather than warns.

It also carries the training-side gate. Every query in this file was authored
BLIND -- target word plus a one-word sense hint, no gloss, no dictionary -- and
that blindness is the only thing making it worth anything against a model
fine-tuned on WordNet glosses. `assert_disjoint()` is what stops a training run
from quietly consuming it. Call it before every fit.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path

from .paths import FROZEN_SET

# eval/sets/v1.jsonl, built 2026-08-19 from the reviewed v1-draft.tsv.
# 405 rows: 312 authored (287 reachable + 25 coverage) and 93 gloss_tripwire.
V1_SHA256 = "cc03e1347ff696fb253c92dfb8b9e7455c64b2122f711ed5c288f33b06c0ccc8"


@dataclass(frozen=True)
class EvalRow:
    id: str
    query: str
    target: str
    source: str  # "authored" | "gloss_tripwire"
    meta: dict

    @property
    def reachable(self) -> bool:
        return bool(self.meta.get("reachable", False))

    @property
    def acceptable(self) -> list[str]:
        """
        Hand-authored synonyms that also count at rank 1.

        Only 133 of 312 authored rows carry one, so on the other 179 lenient
        R@1 collapses to strict R@1 and the synonym-tie correction is only
        partial. Deliberate MVP scope, not a bug -- METHODS 8.6.
        """
        return list(self.meta.get("acceptable") or [])

    @property
    def answers(self) -> set[str]:
        """Target plus acceptable, lowercased -- the lenient answer key."""
        return {self.target.lower(), *(a.lower() for a in self.acceptable)}


def sha256_file(path: Path) -> str:
    """Raw file bytes, no normalisation -- matches `sha256File()` in eval.ts:145."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_eval_set(
    path: Path = FROZEN_SET, *, expect_sha256: str | None = V1_SHA256
) -> list[EvalRow]:
    """
    Load the frozen set, verifying its hash.

    Pass `expect_sha256=None` only for a genuinely new set file (v2), and record
    the new hash the same way v1's is recorded here.
    """
    actual = sha256_file(path)
    if expect_sha256 is not None and actual != expect_sha256:
        raise RuntimeError(
            f"{path.name} has changed on disk.\n"
            f"  expected sha256 {expect_sha256}\n"
            f"  found           {actual}\n"
            "The set is FROZEN. If this change is intentional it must be a new "
            "filename (v2.jsonl), not an edit -- every committed run records the "
            "hash it was scored against, and an in-place edit silently "
            "invalidates all of them."
        )

    rows: list[EvalRow] = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            rows.append(
                EvalRow(
                    id=obj["id"],
                    query=obj["query"],
                    target=obj["target"],
                    source=obj["source"],
                    meta=obj.get("meta") or {},
                )
            )
    return rows


# ----------------------------------------------------------------- the slices


def authored(rows: list[EvalRow]) -> list[EvalRow]:
    """The real benchmark: blind-authored queries. Excludes the tripwire."""
    return [r for r in rows if r.source == "authored"]


def headline(rows: list[EvalRow]) -> list[EvalRow]:
    """
    The 287-row authored-reachable slice -- every headline number in the project.

    Note the denominator deliberately stays 287 even though RD-17 found that
    `capsize` and `loiter` have been answerable since RD-02: the set is frozen,
    so the flags stay as recorded.
    """
    return [r for r in authored(rows) if r.reachable]


def coverage(rows: list[EvalRow]) -> list[EvalRow]:
    """
    The 25 `reachable: false` rows -- a vocabulary-coverage probe.

    Reported SEPARATELY and never folded into headline recall. Since RD-17 this
    slice is scored rather than merely counted: a count cannot distinguish
    "indexed" from "indexed and findable", which is the only question a
    vocabulary change actually asks.
    """
    return [r for r in authored(rows) if not r.reachable]


def tripwire(rows: list[EvalRow]) -> list[EvalRow]:
    """
    93 pairs derived from `Word.definition`, carrying `meta.leakage`.

    CATASTROPHIC-REGRESSION DETECTOR ONLY -- never a headline number. These are
    paraphrases of text the model was trained on, so recall here measures
    memorisation. RD-16 used it legitimately for one thing: scoring it beside
    the blind slice inside a single run to measure the register gap.
    """
    return [r for r in rows if r.source == "gloss_tripwire"]


# ------------------------------------------------------------- the disjointness gate

_WORD = re.compile(r"[a-z0-9']+")


def _normalise(text: str) -> str:
    return " ".join(_WORD.findall(text.lower()))


def assert_disjoint(
    pairs: list[tuple[str, str]],
    rows: list[EvalRow] | None = None,
    *,
    check_targets: bool = True,
) -> None:
    """
    Refuse to let evaluation data into a training set.

    `pairs` is whatever is about to be trained on, as (query_text, target_word).

    The original fine-tune was trained with `eval_on_start: False` and
    `prediction_loss_only: True` -- 3 epochs, no evaluator, NO HELD-OUT SPLIT AT
    ALL -- which is why its recorded 10.9% describes memorisation and cannot be
    cited. Repeating that mistake is the single easiest way to make every number
    downstream of a retrain worthless, so this raises rather than warns.

    Two levels:
      - query overlap is ALWAYS fatal. A verbatim eval query in training is
        direct contamination.
      - `check_targets` is fatal by default and is the stricter, more honest
        setting: it also refuses any pair whose target word appears as an eval
        target. Turning it off is defensible for a bi-encoder trained on the
        full dictionary (the eval targets are ordinary English words and
        excluding them biases the vocabulary), but it must be a DELIBERATE,
        recorded choice -- pass `check_targets=False` explicitly and say why in
        the notebook.
    """
    if rows is None:
        rows = load_eval_set()

    eval_queries = {_normalise(r.query) for r in rows}
    train_queries = {_normalise(q) for q, _ in pairs}
    shared_queries = eval_queries & train_queries
    if shared_queries:
        sample = sorted(shared_queries)[:5]
        raise RuntimeError(
            f"CONTAMINATION: {len(shared_queries)} training queries appear "
            f"verbatim in the eval set.\n  e.g. {sample}\n"
            "The benchmark is only worth something because it was authored "
            "blind. Regenerate the training pairs over disjoint queries."
        )

    if check_targets:
        eval_targets = {r.target.lower() for r in rows}
        train_targets = {t.lower() for _, t in pairs}
        shared_targets = eval_targets & train_targets
        if shared_targets:
            sample = sorted(shared_targets)[:8]
            raise RuntimeError(
                f"CONTAMINATION: {len(shared_targets)} training targets are also "
                f"eval targets.\n  e.g. {sample}\n"
                "If this is intended for a full-vocabulary bi-encoder run, pass "
                "check_targets=False EXPLICITLY and record the reason."
            )
