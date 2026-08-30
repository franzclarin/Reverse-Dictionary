"""
The lexical-echo rule, ported from scripts/lib/probes.ts.

Echo is a PRIMARY metric in this project, not a diagnostic: CLAUDE.md's standing
instruction is that "a change that improves recall without moving it needs
explaining". RD-12's lemma-gloss reranker arm was rejected partly because it
bought recall by driving echo from 14.5% to 21.4%.

That only works if every tool computes it the same way. probes.ts says so in
as many words -- "Change the rule here or not at all" -- so this is a verbatim
port, not a reimplementation, and `verify_against_runs()` in parity.py checks it
reproduces the `echo` field the TypeScript harness stored.

If probes.ts changes, change this and re-run the parity gate.
"""

from __future__ import annotations

import re

# --- verbatim from probes.ts:44 ---------------------------------------------
# Function words that carry no retrieval signal.
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

# probes.ts splits on /[^a-z]+/ AFTER lowercasing, so apostrophes are separators
# and "don't" can never actually match as a single token. Kept exactly as-is:
# the point is to agree with the harness, not to improve on it.
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
    Does `result_word` echo a content word of the query? (`echoesQuery`)

    Deliberately crude: a shared 4-character prefix on any token pair. That is
    enough to catch rain/raininess/raindrop/rainstorm, laugh/laughter/laughing
    and minute/minuteness, which is the pattern of interest.
    """
    for rt in filter(None, _NON_ALPHA.split(result_word.lower())):
        for qt in query_tokens:
            n = min(4, len(rt), len(qt))
            if n >= 4 and rt[:n] == qt[:n]:
                return True
    return False


def echo_share(query: str, results: list[str]) -> float:
    """
    Share of `results` echoing the query -- the per-row `echo` field.

    Returns 0.0 for an empty result list, matching the harness, which only ever
    computes this over a non-empty top-k.
    """
    if not results:
        return 0.0
    tokens = content_tokens(query)
    return sum(echoes_query(w, tokens) for w in results) / len(results)
