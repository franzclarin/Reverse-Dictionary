"""
Reading the saved runs -- the committed evidence.

Every run file already carries, per question, where the answer came and how much
of the result echoed the question, all computed by the TypeScript harness.
Reading those is not a second scoring implementation; it is reading the
harness's own output, and it is the safest thing this package does.

Which runs mean what:
  prod_wikt_shipped ... the CURRENT production path. Compare against this.
  prod_gloss_shipped .. the previous path -- "versus what we replaced".
  baseline/exact/filtered ... the old word-by-word index, now the rollback path.
  rd17_*, full_gloss_* ...... local experiments, not production numbers.
  rerank_* .................. a rejected experiment. Not search quality.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .metrics import QueryResult
from .paths import EVAL_RUNS_DIR


@dataclass(frozen=True)
class Run:
    tag: str
    config: dict
    preregistered: str
    results: list[QueryResult]
    path: Path

    @property
    def set_sha256(self) -> str | None:
        return self.config.get("setSha256")

    def __repr__(self) -> str:  # keeps notebook output readable
        return f"<Run {self.tag}: {len(self.results)} rows, {self.config.get('index', '?')}>"


def _to_query_result(obj: dict) -> QueryResult:
    return QueryResult(
        id=obj["id"],
        query=obj["query"],
        target=obj["target"],
        source=obj["source"],
        results=list(obj.get("results") or []),
        similarities=list(obj.get("similarities") or []),
        rank=obj.get("rank"),
        lenient_rank=obj.get("lenientRank"),
        echo=float(obj.get("echo") or 0.0),
        meta=obj.get("meta") or {},
        embed_ms=float(obj.get("embedMs") or 0.0),
        db_ms=float(obj.get("dbMs") or 0.0),
    )


def load_run(ref: str | Path, *, runs_dir: Path = EVAL_RUNS_DIR) -> Run:
    """Load a run by tag (`"prod_wikt_shipped"`) or by path."""
    path = Path(ref)
    if not path.suffix:
        path = runs_dir / f"{ref}.json"
    if not path.is_absolute() and not path.exists():
        path = runs_dir / path.name

    obj = json.loads(path.read_text(encoding="utf-8"))
    return Run(
        tag=obj.get("tag", path.stem),
        config=obj.get("config") or {},
        preregistered=obj.get("preregistered", ""),
        results=[_to_query_result(r) for r in obj.get("results") or []],
        path=path,
    )


def list_runs(runs_dir: Path = EVAL_RUNS_DIR) -> list[str]:
    """Tags of every run file on disk, sorted."""
    return sorted(p.stem for p in runs_dir.glob("*.json") if not p.name.endswith(".shortlist.json"))


def load_all_runs(runs_dir: Path = EVAL_RUNS_DIR) -> dict[str, Run]:
    return {tag: load_run(tag, runs_dir=runs_dir) for tag in list_runs(runs_dir)}


# ------------------------------------------------------------------ shortlists


@dataclass(frozen=True)
class ShortlistRow:
    """
    One question's shortlist, with the definitions attached.

    The richest record in the repo for re-sorting work: every question with a
    hundred candidates, each carrying its key, the definition that was indexed,
    its words, and both models' scores.

    It is built FROM the test set. It is a development aid and a format
    template, and it is never training data.
    """

    id: str
    query: str
    target: str
    candidates: list[dict]

    def positives(self, answers: set[str]) -> list[dict]:
        """Candidates whose lemmas include an acceptable answer."""
        return [
            c
            for c in self.candidates
            if any(l.lower() in answers for l in c.get("lemmas", []))
        ]

    def hard_negatives(self, answers: set[str]) -> list[dict]:
        """Retrieved but wrong -- the negatives worth training against."""
        return [
            c
            for c in self.candidates
            if not any(l.lower() in answers for l in c.get("lemmas", []))
        ]


def load_shortlist(ref: str | Path, *, runs_dir: Path = EVAL_RUNS_DIR) -> list[ShortlistRow]:
    """Load a `<tag>.shortlist.jsonl` sidecar. Gitignored; regenerate with `npm run eval:rerank`."""
    path = Path(ref)
    if not path.suffix:
        path = runs_dir / f"{ref}.shortlist.jsonl"
    if not path.exists():
        raise FileNotFoundError(
            f"{path} not found. Shortlist sidecars are gitignored -- regenerate "
            "with `npm run eval:rerank` from the repo root."
        )

    rows: list[ShortlistRow] = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            rows.append(
                ShortlistRow(
                    id=obj["id"],
                    query=obj["query"],
                    target=obj["target"],
                    candidates=list(obj.get("candidates") or []),
                )
            )
    return rows


# ------------------------------------------------------------------- to pandas


def to_dataframe(run: Run):
    """
    Flatten a run into a table, with the per-question details as columns.

    Frequency bands are deliberately worked out at analysis time rather than
    stored, so their boundaries can be redrawn without rebuilding the set.
    """
    import pandas as pd

    records = []
    for r in run.results:
        rec = {
            "id": r.id,
            "query": r.query,
            "target": r.target,
            "source": r.source,
            "rank": r.rank,
            "lenient_rank": r.lenient_rank,
            "echo": r.echo,
            "embed_ms": r.embed_ms,
            "db_ms": r.db_ms,
            "top1": r.results[0] if r.results else None,
            "top1_sim": r.similarities[0] if r.similarities else None,
            "n_results": len(r.results),
        }
        for k, v in r.meta.items():
            rec[k] = ", ".join(v) if isinstance(v, list) else v
        records.append(rec)

    df = pd.DataFrame.from_records(records)
    df["hit1"] = df["rank"].notna() & (df["rank"] <= 1)
    df["lenient_hit1"] = df["lenient_rank"].notna() & (df["lenient_rank"] <= 1)
    df["hit10"] = df["rank"].notna() & (df["rank"] <= 10)
    df["run"] = run.tag
    return df
