"""
The word-echoing rule, ported from the TypeScript.

Echo is a headline measure here, not a diagnostic: the standing instruction is
that a change improving accuracy without moving echo needs explaining. One
re-sorting experiment was rejected partly because it bought accuracy by driving
echo up by half again.

That only works if every tool computes it identically. The original says so in
as many words -- change the rule there or not at all -- so this is a verbatim
port, and the gate checks it reproduces what the harness stored.

If the original changes, change this and re-run the gate.
"""

from __future__ import annotations

import re

# --- verbatim from the TypeScript -------------------------------------------
# Everyday joining words that say nothing about meaning.
STOPWORDS: frozenset[str] = frozenset(
    (
        "a an the of to in on at for from by with and or but not no is are was were be been "
        "being it its that this these those you your they them their he she his her i we our "
        "when where why how what who which as if then than so very much many most more some "
        "any all only just about into out up down over under after before until while do does "
        "did done have has had get gets got make makes made you're dont don't never ever also "
        "something someone anything nothing things thing way place person people know knows"
    ).split()
)

# The original treats apostrophes as separators, so "don't" can never match as
# one word. Kept exactly as-is: the point is to agree with the harness, not to
# improve on it.
_NON_ALPHA = re.compile(r"[^a-z]+")


def content_tokens(query: str) -> list[str]:
    """Content tokens of a query, for the echo rule. (`contentTokens`)"""
    return [
        t
        for t in _NON_ALPHA.split(query.lower())
        if len(t) >= 3 and t not in STOPWORDS
    ]


def echoes_query(result_word: str, query_tokens: list[str]) -> bool:
    """
    Does this answer just repeat a word from the question?

    Crude on purpose -- a shared four-letter opening. Enough to catch
    rain/raininess/raindrop and laugh/laughter, which is the pattern of interest.
    """
    for rt in filter(None, _NON_ALPHA.split(result_word.lower())):
        for qt in query_tokens:
            n = min(4, len(rt), len(qt))
            if n >= 4 and rt[:n] == qt[:n]:
                return True
    return False


def echo_share(query: str, results: list[str]) -> float:
    """
    How much of the result list merely echoes the question.

    Returns zero for an empty list, matching the harness.
    """
    if not results:
        return 0.0
    tokens = content_tokens(query)
    return sum(echoes_query(w, tokens) for w in results) / len(results)
