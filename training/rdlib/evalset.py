"""
The frozen question set, and the gates that keep it honest.

Every number in the project is measured against this. It never changes: a new
version means a new filename. An edit in place is otherwise silent and
invalidates every recorded run, so the fingerprint is checked on load.

Every question was written blind -- the word and a one-word hint, no dictionary
open -- which is the only thing making it worth anything against a model trained
on dictionary definitions. Call the disjointness check before every fit.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path

from .paths import FROZEN_SET

# The frozen set: 405 questions, 312 hand-written and 93 paraphrased.
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
        Hand-written synonyms that also count as correct.

        Fewer than half the questions carry any, so for the rest the forgiving
        score collapses into the strict one. A deliberate limit, not a bug.
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
    Load the frozen set, checking its fingerprint.

    Skip the check only for a genuinely new set file, and record its fingerprint
    the same way this one is recorded.
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
    The hand-written, answerable questions -- every headline number.

    The total stays fixed even though two excluded words have since become
    answerable: the set is frozen, so the flags stay as recorded.
    """
    return [r for r in authored(rows) if r.reachable]


def coverage(rows: list[EvalRow]) -> list[EvalRow]:
    """
    The questions no dictionary we had could answer -- a coverage check.

    Reported separately, never folded into the headline, and scored rather than
    counted: a count cannot tell "in the index" from "in the index and findable".
    """
    return [r for r in authored(rows) if not r.reachable]


def tripwire(rows: list[EvalRow]) -> list[EvalRow]:
    """
    The 93 questions paraphrased from stored definitions.

    A detector for catastrophic breakage only, never a headline number -- these
    paraphrase text the model was trained on, so a score here measures
    memorisation. One legitimate use: measuring how much phrasing matters.
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
    Refuse to let test data into a training set.

    The original model held nothing back, which is why its score cannot be
    quoted. Repeating that is the easiest way to make every later number
    worthless, so this raises rather than warns.

    A test question appearing verbatim in training is always fatal. Checking the
    answer words too is stricter and is the default; turning it off is
    defensible for a model trained on the whole dictionary, but must be a
    deliberate choice, made explicitly and explained.
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
