"""
Reading the Wiktionary download, FOR TRAINING EXAMPLES ONLY.

Read this before using it. This is deliberately NOT a copy of the TypeScript
filter, and must never be used to reproduce the shipped index. That filter is
what built the entries currently in the live table, its per-rule counts are a
committed record, and a second version of it would be a real drift hazard for a
real production table.

What this does is much narrower: pull (word, part of speech, definition) out of
the raw file so training examples can be built. Nothing here decides what gets
indexed, so nothing here can silently change what users search.

It does mirror the same categorical exclusions -- pointers to other words, dead
usages, junk spellings, a minimum length -- because those are as right for
training data as for index rows: an example whose "definition" is "plural of
cat" teaches nothing. Where it differs, it is stricter, never looser.

The source is a multi-gigabyte download, fetched separately, and share-alike
licensed.
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

# Usages nobody would be describing. "Rare" is deliberately absent: `petrichor`
# and `limerence` are rare in exactly that sense.
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

# Multi-word entries are kept on purpose -- `deja vu` and `stiff upper lip` are
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
    The first definition, tidied up.

    Uses the plain text, not the version prefixed with "(transitive)" and the
    like: that prefix is a label, not meaning.
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
    Read surviving entries one at a time; the file is far too big to load whole.

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
                                # The file has the odd broken line; skipping is correct and the
                                # count is immaterial at this scale.
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
    Definitions grouped by word and part of speech.

    Keyed by both, so a noun meaning is never paired against a verb definition
    of the same spelling.
    """
    out: dict[tuple[str, str], list[str]] = {}
    for sense in iter_senses(path, limit_entries=limit_entries):
        out.setdefault((sense.word.lower(), sense.pos), []).append(sense.gloss)
    print(f"  {len(out):,} (word, pos) entries with at least one usable gloss")
    return out
