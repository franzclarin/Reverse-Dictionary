"""
Faithful port of scripts/lib/metrics.ts.

This is the second scoring implementation in the project, which METHODS is
explicit is a hazard: a harness with two scorers can drift, and a drifted scorer
produces numbers that look comparable to committed runs and are not. It exists
because RD-22 chose a self-contained Python loop, and it is made safe the same
way the repo makes its other second implementations safe -- by pinning it to the
original with a check. `parity.py` re-scores committed runs with this module and
asserts the published figures reproduce. Run it after touching this file.

Two details are easy to get wrong and are called out at their definitions:
`percentile` does not interpolate, and rank is 1-based with `None` for absent.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, asdict
from typing import Callable, Iterable, Sequence


@dataclass(frozen=True)
class QueryResult:
    """One scored query. Mirrors `QueryResult` in metrics.ts."""

    id: str
    query: str
    target: str
    source: str
    results: list[str]
    similarities: list[float]
    # 1-based rank of the target within the deep scan, or None if absent.
    rank: int | None
    # 1-based rank of the best acceptable answer (target included).
    lenient_rank: int | None
    # Share of the top-10 sharing a stem with a query content word.
    echo: float
    meta: dict
    embed_ms: float = 0.0
    db_ms: float = 0.0


@dataclass(frozen=True)
class Metrics:
    n: int
    recall1: float
    recall3: float
    recall10: float
    mrr10: float
    lenient_recall1: float
    lenient_recall10: float
    echo_rate: float
    # Share whose target is somewhere in the deep scan but outside the top 10.
    beyond10: float

    def as_dict(self) -> dict:
        return asdict(self)


def _hit(rank: int | None, k: int) -> bool:
    return rank is not None and rank <= k


def score(results: Sequence[QueryResult]) -> Metrics:
    """Mirrors `score()` in metrics.ts, including the empty-input NaN shape."""
    n = len(results)
    if n == 0:
        nan = float("nan")
        return Metrics(0, nan, nan, nan, nan, nan, nan, nan, nan)

    def mean(f: Callable[[QueryResult], float]) -> float:
        return sum(f(r) for r in results) / n

    return Metrics(
        n=n,
        recall1=mean(lambda r: 1.0 if _hit(r.rank, 1) else 0.0),
        recall3=mean(lambda r: 1.0 if _hit(r.rank, 3) else 0.0),
        recall10=mean(lambda r: 1.0 if _hit(r.rank, 10) else 0.0),
        mrr10=mean(lambda r: 1.0 / r.rank if _hit(r.rank, 10) else 0.0),
        lenient_recall1=mean(lambda r: 1.0 if _hit(r.lenient_rank, 1) else 0.0),
        lenient_recall10=mean(lambda r: 1.0 if _hit(r.lenient_rank, 10) else 0.0),
        echo_rate=mean(lambda r: r.echo),
        beyond10=mean(lambda r: 1.0 if (r.rank is not None and r.rank > 10) else 0.0),
    )


def percentile(values: Iterable[float], p: float) -> float:
    """
    Mirrors `percentile()` in metrics.ts.

    DO NOT replace this with `np.percentile`. The TypeScript version indexes at
    `floor((p/100) * len)` into the sorted list and takes that element; numpy
    interpolates between neighbours by default. On 287 rows the two disagree by
    a few milliseconds on every latency figure, which is exactly the kind of
    silent drift the parity gate exists to prevent.
    """
    sorted_values = sorted(values)
    if not sorted_values:
        return float("nan")
    idx = min(len(sorted_values) - 1, math.floor((p / 100) * len(sorted_values)))
    return sorted_values[idx]


def mcnemar(b: int, c: int) -> tuple[float, int]:
    """
    Exact two-sided McNemar test on rank-1 disagreements. Returns `(p, n)`.

    Comparing two independent Recall@1 figures at n=300 cannot see a three-point
    change. The paired test can, because it discards every query both runs get
    right -- which is exactly where the variance lives -- and looks only at the
    discordant pairs. The exact binomial form is used rather than the chi-square
    approximation because b + c is often small.

    Ported rather than delegated to `scipy.stats.binomtest` so the arithmetic is
    the harness's arithmetic, digit for digit.
    """
    n = b + c
    if n == 0:
        return 1.0, 0

    # Two-sided: 2 * P(X <= min(b,c)) under X ~ Binomial(n, 0.5).
    lo = min(b, c)
    log_c = 0.0  # log of the binomial coefficient, kept in logs for large n
    total = 0.0
    for i in range(lo + 1):
        if i > 0:
            log_c += math.log((n - i + 1) / i)
        total += math.exp(log_c + n * math.log(0.5))
    return min(1.0, 2 * total), n


def compare(
    a: Sequence[QueryResult],
    b: Sequence[QueryResult],
    *,
    lenient: bool = True,
) -> dict:
    """
    Paired comparison of two runs on rank-1, by query id.

    Lenient by default, because METHODS 9a resolves on lenient R@1 and nothing
    else. Before RD-12 this tool tested strict rank-1 over all 405 rows while
    every recall figure printed beside it was the 287-row authored-reachable
    slice; read the "Established facts" entry on paired-test scope before
    citing any pre-2026-08-28 count.

    `wins` are queries b gets right and a does not.
    """
    by_id_a = {r.id: r for r in a}
    wins: list[str] = []
    regressions: list[str] = []

    for rb in b:
        ra = by_id_a.get(rb.id)
        if ra is None:
            continue
        rank_a = ra.lenient_rank if lenient else ra.rank
        rank_b = rb.lenient_rank if lenient else rb.rank
        hit_a, hit_b = _hit(rank_a, 1), _hit(rank_b, 1)
        if hit_b and not hit_a:
            wins.append(rb.id)
        elif hit_a and not hit_b:
            regressions.append(rb.id)

    p, n_discordant = mcnemar(len(wins), len(regressions))
    metric = "lenient_recall1" if lenient else "recall1"
    delta = getattr(score(b), metric) - getattr(score(a), metric)

    return {
        "metric": metric,
        "delta": delta,
        "delta_pp": delta * 100,
        "wins": wins,
        "regressions": regressions,
        "n_wins": len(wins),
        "n_regressions": len(regressions),
        "p": p,
        "n_discordant": n_discordant,
        # METHODS 9a: under ~6 points of lenient R@1 is a null result, not a win.
        "clears_9a_bar": lenient and (delta * 100) >= 6.0,
    }
