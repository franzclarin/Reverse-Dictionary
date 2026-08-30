"""
Reading the Kaikki Wiktionary extraction, FOR TRAINING PAIRS ONLY.

READ THIS BEFORE USING IT. This module is deliberately NOT a port of
`scripts/lib/wiktionary.ts`, and it must never be used to reproduce the shipped
index. That filter (`FILTER_VERSION = "rd17.2"`) is what built the 575,534
senses currently in `GlossEmbedding`, its per-rule kill counts are a committed
artifact (`eval/data/supplement-manifest.json`), and a second implementation of
it would be a real drift hazard for a real production table.

What this module does instead is much narrower: pull (word, pos, gloss) triples
out of the raw dump so training PAIRS can be built from them. Nothing here
decides what is indexed, so nothing here can silently change what users search.

It does mirror the TS filter's *categorical* rules -- form-of senses, dead
registers, junk surfaces, a minimum gloss length -- because those exclusions are
as right for training data as for index rows: a pair whose "definition" is
"plural of cat" teaches nothing. Where it differs, it differs by being stricter,
never looser.

SOURCE: kaikki.org's English extraction, ~3.2 GB, fetched by
`npm run supplement:fetch` into RD_SOURCE_DIR (default ~/rd_sources).
LICENCE: CC BY-SA -- see `eval/data/supplement-manifest.json`.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

# --- mirrored from scripts/lib/wiktionary.ts --------------------------------

KEPT_POS = frozenset({"noun", "verb", "adj", "adv"})

# Tags marking a sense as a pointer to another word rather than a meaning.
FORM_TAGS = frozenset(
    {
        "form-of", "alt-of", "alternative", "abbreviation", "initialism",
        "acronym", "misspelling", "plural", "singular", "past", "participle",
        "comparative", "superlative", "romanization", "pronunciation-spelling",
        "eye-dialect", "clipping", "ellipsis", "contraction",
    }
)

# Registers nobody would be describing. `rare` is deliberately NOT here:
# `petrichor` and `limerence` are rare in exactly that sense.
DEAD_TAGS = frozenset({"obsolete", "archaic", "dated", "dialectal"})

SHELL_GLOSS = re.compile(
    r"^(alternative|obsolete|archaic|dated|nonstandard|informal|common|eye)?\s*"
    r"(spelling|form|misspelling|pronunciation|romanization)\s+of\b",
    re.IGNORECASE,
)

INFLECTION_GLOSS = re.compile(
    r"^(plural|singular|past|present|simple past|gerund|inflection|comparative|"
    r"superlative|third-person|participle|abbreviation|initialism|acronym|"
    r"clipping|ellipsis|synonym|antonym|obsolete form|used other than|"
    r"only used in|see\b)",
    re.IGNORECASE,
)

# Multi-word lemmas are KEPT on purpose -- `deja vu` and `stiff upper lip` are
# legitimate answers.
_JUNK_SURFACE = re.compile(r"^[A-Z]|[0-9]|[^A-Za-z '-]")

MIN_GLOSS_CHARS = 20
MAX_SENSES_PER_ENTRY = 4

# Wiktextract normalises POS to these; map to WordNet's four.
_POS_MAP = {"noun": "noun", "verb": "verb", "adj": "adj", "adv": "adv"}

_WS = re.compile(r"\s+")


def source_dir() -> Path:
    return Path(os.environ.get("RD_SOURCE_DIR", Path.home() / "rd_sources"))


def kaikki_path() -> Path:
    return source_dir() / "kaikki-english.jsonl"


def is_junk_surface(word: str) -> bool:
    return bool(_JUNK_SURFACE.search(word))


def clean_gloss(sense: dict) -> str:
    """
    First gloss, whitespace-collapsed.

    `glosses` rather than `raw_glosses` because the latter keeps the
    parenthesised tag prefix ("(transitive) To look up in a dictionary"), and
    that prefix is register metadata, not meaning.
    """
    glosses = sense.get("glosses") or []
    return _WS.sub(" ", glosses[0]).strip() if glosses else ""


@dataclass(frozen=True)
class WiktSense:
    word: str
    pos: str
    gloss: str


def iter_senses(
    path: Path | None = None,
    *,
    limit_entries: int | None = None,
    progress_every: int | None = 500_000,
) -> Iterator[WiktSense]:
    """
    Stream surviving senses. The dump is 3.2 GB, so this never loads it whole.

    A full pass takes a few minutes. Pass `limit_entries` while developing.
    """
    path = path or kaikki_path()
    if not path.exists():
        raise FileNotFoundError(
            f"{path} not found. Fetch it with `npm run supplement:fetch` from "
            "the repo root (~3.2 GB), or set RD_SOURCE_DIR."
        )

    with path.open(encoding="utf-8") as fh:
        for n, line in enumerate(fh):
            if limit_entries is not None and n >= limit_entries:
                return
            if progress_every and n and n % progress_every == 0:
                print(f"  read {n:,} entries", end="\r")

            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                # The dump has occasional malformed lines; skipping is correct
                # and the count is immaterial at this scale.
                continue

            if entry.get("lang_code") != "en":
                continue
            pos = _POS_MAP.get(entry.get("pos", ""))
            if pos is None:
                continue
            word = entry.get("word") or ""
            if not word or is_junk_surface(word):
                continue

            kept = 0
            for sense in entry.get("senses") or []:
                if kept >= MAX_SENSES_PER_ENTRY:
                    break
                tags = set(sense.get("tags") or [])
                if tags & FORM_TAGS or tags & DEAD_TAGS:
                    continue
                if sense.get("form_of") or sense.get("alt_of"):
                    continue
                gloss = clean_gloss(sense)
                if len(gloss) < MIN_GLOSS_CHARS:
                    continue
                if SHELL_GLOSS.match(gloss) or INFLECTION_GLOSS.match(gloss):
                    continue
                kept += 1
                yield WiktSense(word=word, pos=pos, gloss=gloss)


def glosses_by_word(
    path: Path | None = None, *, limit_entries: int | None = None
) -> dict[tuple[str, str], list[str]]:
    """
    `{(word, pos): [gloss, ...]}` -- the shape the paraphrase recipe needs.

    Keyed by (word, pos) rather than word alone so a noun sense is never paired
    against a verb definition of the same spelling.
    """
    out: dict[tuple[str, str], list[str]] = {}
    for sense in iter_senses(path, limit_entries=limit_entries):
        out.setdefault((sense.word.lower(), sense.pos), []).append(sense.gloss)
    print(f"  {len(out):,} (word, pos) entries with at least one usable gloss")
    return out
