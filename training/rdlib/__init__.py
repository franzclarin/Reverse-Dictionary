"""
rdlib -- the shared library behind RD-22's notebooks.

Notebooks stay thin and every rule lives here exactly once. That is the repo's
existing convention rather than a preference: `scripts/lib/probes.ts` carries
the instruction "Change the rule here or not at all", and `cellText.ts` sits
apart from both its builder and its verifier specifically so the two cannot
drift. Five notebooks each holding their own copy of the echo rule would
reintroduce precisely that failure.

Start with `parity.report()`. Nothing else in this package is trustworthy until
it passes -- see parity.py for why.

  paths      where everything lives, resolved from the repo root
  evalset    the frozen set, its sha256 gate, and the disjointness gate
  metrics    port of scripts/lib/metrics.ts (score, percentile, mcnemar)
  echo       port of scripts/lib/probes.ts (the lexical-echo rule)
  wordnet    port of scripts/lib/wordnet.ts (latin1, WordNet member order)
  cells      the .vec/.json interop format with scripts/eval.ts
  retrieval  exact scan, synset expansion, scoring
  runs       eval/runs/*.json and the RD-12 shortlist sidecars
  build      WordNet -> cell with any sentence-transformers encoder
  pairs      training-pair recipes and the train/val split
  wiktionary the Kaikki dump, for training pairs ONLY (not the index filter)
  parity     the gate
"""

from . import (
    build,
    cells,
    echo,
    evalset,
    metrics,
    pairs,
    parity,
    paths,
    retrieval,
    runs,
    wiktionary,
    wordnet,
)

__all__ = [
    "build",
    "cells",
    "echo",
    "evalset",
    "metrics",
    "pairs",
    "parity",
    "paths",
    "retrieval",
    "runs",
    "wiktionary",
    "wordnet",
]
