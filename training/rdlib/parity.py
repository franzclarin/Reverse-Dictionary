"""
The gate. Pins this package to the TypeScript harness.

RD-22 chose a self-contained Python scoring loop. That is a SECOND
IMPLEMENTATION, and METHODS is blunt about the risk: two scorers can drift, and
a drifted scorer produces numbers that look comparable to committed runs and are
not. The repo's answer to that problem elsewhere is never "be careful" -- it is a
check:

  - `npm run verify-viz` asserts the browser's reimplemented WordPiece tokenizer
    against the real AutoTokenizer over 415 strings.
  - RD-17's `rd17_control` had to reproduce RD-16's `full_gloss_ft` to the digit
    before either arm was allowed to be read.
  - `exact` (pgvector) was cross-validated against `cell_lemma_ft` (local brute
    force) at 99.0% top-1 agreement.

This module is the same move for the Python port. Run `check_all()` after
touching metrics.py, echo.py, wordnet.py or retrieval.py, and before believing
any number a notebook prints.

WHAT IT PROVES AND WHAT IT DOES NOT. It proves the SCORING agrees with the
harness on runs the harness produced, and that the encoder agrees with the ONNX
model that serves production. It does not prove the local exact scan agrees with
the live IVFFlat index -- those are different retrieval methods and are expected
to differ by ~0.3 points. Confirm anything decision-shaped through
`npx tsx scripts/eval.ts`.
"""

from __future__ import annotations

from dataclasses import dataclass

from . import runs as runs_mod
from .echo import echo_share
from .evalset import headline, load_eval_set
from .metrics import compare, score


@dataclass
class Check:
    name: str
    passed: bool
    detail: str

    def __str__(self) -> str:
        return f"  [{'PASS' if self.passed else 'FAIL'}]  {self.name}\n           {self.detail}"


# Published in CLAUDE.md's production table, authored-reachable slice (n=287).
# These are what `npm run eval:prod` wrote and what every RD-17 claim rests on.
PUBLISHED = {
    "prod_wikt_shipped": {
        "lenient_recall1": 0.251,
        "recall1": 0.206,
        "recall10": 0.557,
        "mrr10": 0.307,
    },
    "prod_gloss_shipped": {
        "lenient_recall1": 0.240,
        "recall1": 0.206,
        "recall10": 0.498,
    },
    "baseline": {
        "lenient_recall1": 0.101,
        "recall1": 0.056,
        "recall10": 0.261,
    },
}

# The paired comparisons CLAUDE.md records, as (before, after, wins, regressions).
PUBLISHED_COMPARISONS = [
    ("prod_gloss_shipped", "prod_wikt_shipped", 25, 22),
    ("baseline", "prod_gloss_shipped", 55, 15),
]


def _headline_results(run: runs_mod.Run):
    """The 287-row authored-reachable slice of a run."""
    return [
        r
        for r in run.results
        if r.source == "authored" and r.meta.get("reachable")
    ]


def check_frozen_set() -> Check:
    try:
        rows = load_eval_set()
    except RuntimeError as exc:
        return Check("frozen set sha256", False, str(exc).splitlines()[0])

    n_headline = len(headline(rows))
    ok = len(rows) == 405 and n_headline == 287
    return Check(
        "frozen set sha256 + shape",
        ok,
        f"{len(rows)} rows, {n_headline} authored-reachable "
        f"(expected 405 / 287), sha256 verified",
    )


def check_metrics(tolerance: float = 0.001) -> list[Check]:
    """Re-score committed runs and compare against the published figures."""
    checks: list[Check] = []
    for tag, expected in PUBLISHED.items():
        try:
            run = runs_mod.load_run(tag)
        except FileNotFoundError:
            checks.append(Check(f"metrics: {tag}", False, "run file not found"))
            continue

        got = score(_headline_results(run))
        diffs = []
        ok = True
        for metric, want in expected.items():
            have = getattr(got, metric)
            if abs(have - want) > tolerance:
                ok = False
            # MRR is a reciprocal rank, not a rate; showing it as a percentage
            # alongside the recall figures invites it being copied as one.
            if metric.startswith("mrr"):
                diffs.append(f"{metric} {have:.3f} vs {want:.3f}")
            else:
                diffs.append(f"{metric} {have * 100:.1f} vs {want * 100:.1f}")
        checks.append(
            Check(f"metrics: {tag} (n={got.n})", ok, "; ".join(diffs))
        )
    return checks


def check_mcnemar() -> list[Check]:
    """Re-derive the paired tests CLAUDE.md reports."""
    checks: list[Check] = []
    for before, after, want_w, want_r in PUBLISHED_COMPARISONS:
        try:
            a, b = runs_mod.load_run(before), runs_mod.load_run(after)
        except FileNotFoundError:
            checks.append(Check(f"mcnemar: {before} -> {after}", False, "run file not found"))
            continue

        cmp = compare(_headline_results(a), _headline_results(b), lenient=True)
        ok = cmp["n_wins"] == want_w and cmp["n_regressions"] == want_r
        checks.append(
            Check(
                f"mcnemar: {before} -> {after}",
                ok,
                f"{cmp['n_wins']}W/{cmp['n_regressions']}R p={cmp['p']:.2f} "
                f"delta={cmp['delta_pp']:+.1f}pp "
                f"(published {want_w}W/{want_r}R)",
            )
        )
    return checks


def check_echo(tag: str = "prod_wikt_shipped", tolerance: float = 0.002) -> Check:
    """
    Recompute echo from the ported rule and compare against the stored field.

    This is the strongest check in the module, because it does not trust the
    harness's output at all: it re-derives the value from `query` and `results`
    using echo.py, and compares against what probes.ts computed at run time.
    """
    try:
        run = runs_mod.load_run(tag)
    except FileNotFoundError:
        return Check("echo rule", False, f"{tag} not found")

    rows = _headline_results(run)
    stored = sum(r.echo for r in rows) / len(rows)
    recomputed = sum(echo_share(r.query, r.results) for r in rows) / len(rows)
    worst = max(abs(r.echo - echo_share(r.query, r.results)) for r in rows)

    ok = abs(stored - recomputed) <= tolerance and worst <= tolerance
    return Check(
        "echo rule (recomputed from probes.ts port)",
        ok,
        f"stored {stored * 100:.1f}% vs recomputed {recomputed * 100:.1f}%, "
        f"worst per-row delta {worst:.4f}",
    )


def check_wordnet() -> Check:
    """The parser reproduces the production synset count and gloss text."""
    from .cells import inputs_sha256
    from .wordnet import EXPECTED_SYNSETS, all_senses

    senses = all_senses()
    sha = inputs_sha256([s.gloss for s in senses])
    ok = len(senses) == EXPECTED_SYNSETS
    return Check(
        "wordnet parser",
        ok,
        f"{len(senses):,} synsets (expected {EXPECTED_SYNSETS:,}), "
        f"gloss inputsSha256 {sha[:16]}...",
    )


def check_encoder(tolerance: float = 1e-5) -> Check:
    """
    The Python encoder is the production encoder.

    Loads the fine-tune through sentence-transformers and compares against
    vectors produced by the ONNX model lib/embedder.ts serves. Measured at
    cos = 1.0000001, max abs difference 1.3e-07 when RD-22 was built -- float32
    rounding, nothing more.

    Reference vectors are regenerated on demand rather than committed, so this
    check cannot go stale against a model change.
    """
    try:
        import numpy as np
        from sentence_transformers import SentenceTransformer
    except ImportError as exc:
        return Check("encoder parity", False, f"import failed: {exc}")

    from .reference import onnx_reference_vectors

    try:
        reference = onnx_reference_vectors()
    except Exception as exc:  # noqa: BLE001 - surfaced verbatim to the notebook
        return Check("encoder parity", False, f"could not run the TS embedder: {exc}")

    model = SentenceTransformer("franzclarin/ReverseDictionary")
    texts = list(reference.keys())
    got = model.encode(texts, normalize_embeddings=True)

    worst_cos, worst_abs = 1.0, 0.0
    for text, vec in zip(texts, got):
        ref = np.asarray(reference[text], dtype=np.float64)
        cur = np.asarray(vec, dtype=np.float64)
        worst_cos = min(worst_cos, float(ref @ cur))
        worst_abs = max(worst_abs, float(np.abs(ref - cur).max()))

    ok = worst_abs <= tolerance
    return Check(
        "encoder parity (PyTorch vs served ONNX)",
        ok,
        f"{len(texts)} texts, min cos {worst_cos:.9f}, max abs diff {worst_abs:.2e}",
    )


def check_cell_roundtrip(cell_name: str, ts_run_tag: str) -> Check:
    """
    The strongest available check: same cell, both scorers, per-query comparison.

    Not part of `check_all()` because it needs a built cell and a harness run,
    which `check_all()` deliberately does not require. Run it once after any
    change to retrieval.py, like this:

        EVAL_CELL_DIR=~/rd_eval_cells npx tsx scripts/eval.ts \\
            --set eval/sets/v1.jsonl --index-file <cell> --tag <tag>

    then pass the cell and tag here. When RD-22 was built this returned
    287/287 identical on all three axes -- not "close", identical.
    """
    import numpy as np  # noqa: F401  (imported for the encoder path below)

    from .build import encode_texts, load_encoder
    from .cells import load_cell
    from .evalset import headline, load_eval_set
    from .retrieval import run_eval

    try:
        cell = load_cell(cell_name)
        ts_run = runs_mod.load_run(ts_run_tag)
    except FileNotFoundError as exc:
        return Check(f"cell round-trip: {cell_name}", False, str(exc).splitlines()[0])

    rows = headline(load_eval_set())
    model = load_encoder(cell.meta["model"])
    got = run_eval(
        cell, rows, lambda ts: encode_texts(model, ts, progress=False), progress=False
    )

    by_id = {r.id: r for r in ts_run.results}
    n = len(got)
    same_rank = sum(1 for r in got if by_id[r.id].rank == r.rank)
    same_top10 = sum(1 for r in got if by_id[r.id].results == r.results)

    ok = same_rank == n and same_top10 == n
    return Check(
        f"cell round-trip: {cell_name} vs eval.ts run {ts_run_tag}",
        ok,
        f"identical deep rank {same_rank}/{n}, identical top-10 order {same_top10}/{n}",
    )


def check_all(*, include_encoder: bool = True) -> list[Check]:
    """Every check. Returns the list; `report()` prints it and raises on failure."""
    checks = [check_frozen_set(), check_wordnet()]
    checks += check_metrics()
    checks += check_mcnemar()
    checks.append(check_echo())
    if include_encoder:
        checks.append(check_encoder())
    return checks


def report(checks: list[Check] | None = None, *, raise_on_failure: bool = True) -> list[Check]:
    """Print the gate's result. Raises by default -- a silent gate is not a gate."""
    checks = checks if checks is not None else check_all()

    print("=" * 78)
    print("  RD-22 PARITY GATE -- pinning the Python port to the TypeScript harness")
    print("=" * 78)
    for c in checks:
        print(c)
    print("-" * 78)

    failed = [c for c in checks if not c.passed]
    if failed:
        print(f"  {len(failed)} of {len(checks)} checks FAILED\n")
        if raise_on_failure:
            raise RuntimeError(
                f"parity gate failed: {', '.join(c.name for c in failed)}. "
                "Do not trust any number this package produces until it passes."
            )
    else:
        print(f"  all {len(checks)} checks passed\n")
    return checks
