"""
The shared library behind the notebooks.

Notebooks stay thin and every rule lives here exactly once. That is this repo's
existing habit rather than a preference: the echo rule already says "change it
here or not at all", and the text rule sits apart from both its builder and its
checker so the two cannot drift. Five notebooks each holding their own copy
would reintroduce exactly that failure.

Start with `parity.report()`. Nothing else here is trustworthy until it passes.

  paths      where everything lives
  evalset    the frozen question set and the gates that keep it frozen
  metrics    the scores
  echo       the word-echoing rule
  wordnet    reading the dictionary
  cells      the file format shared with the TypeScript harness
  retrieval  exhaustive search and scoring
  runs       the saved runs and their shortlists
  build      dictionary to experiment file, with any model
  pairs      training-example recipes and the train/check split
  wiktionary the second dictionary, for training examples ONLY
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
