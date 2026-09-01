"""
The dictionary, read from the same bytes the TypeScript side reads.

A line-for-line port, and it has to stay that way: if the two readers disagree by
so much as a stripped semicolon, files built on each side get different
fingerprints and neither can be checked against the other.

Do not substitute a library version of the dictionary -- different punctuation,
different numbering, invisible until a fingerprint mismatch much later. And the
data files are not UTF-8; reading them as UTF-8 mangles every accented headword.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from .paths import WORDNET_DICT_DIR

POS_LIST = ("noun", "verb", "adj", "adv")

# The live row count from this dictionary, as a drift check rather than a
# requirement. A second dictionary adds many more on top of these.
EXPECTED_SYNSETS = 117_791


@dataclass(frozen=True)
class Sense:
    offset: str  # WordNet synset offset, unique within a part of speech
    pos: str
    words: list[str]  # every lemma in this synset, spaces restored
    gloss: str  # definition text, with example sentences stripped off
    examples: list[str]  # the quoted examples that followed the definition

    @property
    def key(self) -> str:
        """`pos:offset` -- the synset key the production index uses."""
        return f"{self.pos}:{self.offset}"


def _read_data_lines(path: Path) -> list[str]:
    text = path.read_text(encoding="latin-1")
    # Lines beginning with two spaces are the licence header.
    return [ln for ln in text.split("\n") if ln and not ln.startswith("  ")]


_QUOTE_START = re.compile(r"^[\"']")
_QUOTE_EDGES = re.compile(r"^[\"']|[\"']$")
_WHITESPACE = re.compile(r"\s+")


def read_senses(pos: str, dict_dir: Path = WORDNET_DICT_DIR) -> list[Sense]:
    """
    Every meaning for one part of speech, in the dictionary's own file order.

    Example sentences are split off rather than dropped, so text variants can be
    tested with and without them.

    The word order within a meaning is never sorted: it is read back at query
    time to break ties between synonyms, and it is measurably better than
    alphabetical. Re-sorting here would silently change production.
    """
    if pos not in POS_LIST:
        raise ValueError(f"pos must be one of {POS_LIST}, got {pos!r}")

    path = Path(dict_dir) / f"data.{pos}"
    if not path.exists():
        raise FileNotFoundError(
            f"{path} not found. The WordNet files ship with the `wordnet-db` npm "
            "package -- run `npm install` at the repo root."
        )

    senses: list[Sense] = []
    for line in _read_data_lines(path):
        bar = line.find("|")
        if bar == -1:
            continue

        fields = _WHITESPACE.split(line[:bar].strip())
        offset = fields[0]
        try:
            word_count = int(fields[3], 16)
        except (IndexError, ValueError):
            continue

        # Words start at field 4, each followed by a lex_id.
        words: list[str] = []
        for i in range(word_count):
            idx = 4 + i * 2
            if idx < len(fields) and fields[idx]:
                words.append(fields[idx].replace("_", " "))

        raw = line[bar + 1 :].strip()
        parts = [p.strip() for p in raw.split(";")]
        definition: list[str] = []
        examples: list[str] = []
        for part in parts:
            if _QUOTE_START.match(part):
                examples.append(_QUOTE_EDGES.sub("", part))
            elif not examples:
                definition.append(part)

        senses.append(
            Sense(
                offset=offset,
                pos=pos,
                words=words,
                gloss="; ".join(definition).strip(),
                examples=examples,
            )
        )

    return senses


@lru_cache(maxsize=1)
def all_senses() -> tuple[Sense, ...]:
    """Every synset across all four parts of speech, in POS_LIST order."""
    out: list[Sense] = []
    for pos in POS_LIST:
        out.extend(read_senses(pos))
    return tuple(out)


def read_index(pos: str, dict_dir: Path = WORDNET_DICT_DIR) -> list[str]:
    """Lemmas for one part of speech, spaces restored from underscores."""
    path = Path(dict_dir) / f"index.{pos}"
    lemmas: list[str] = []
    for line in _read_data_lines(path):
        space = line.find(" ")
        if space == -1:
            continue
        lemmas.append(line[:space].replace("_", " "))
    return lemmas


# ------------------------------------------------------------- indexed text


def gloss_text_for(variant: str, sense: Sense) -> str:
    """
    The text indexed for one row. Keep in step with the TypeScript version, or
    fingerprints will not match.

    What each has been measured to do: definition only is what production uses;
    adding example sentences is slightly worse and echoes more; prefixing the
    word itself brings back the echoing this index exists to remove.

    Adding a variant is the cheapest real experiment in this project -- changing
    what gets indexed bought roughly three times what the entire fine-tune did.
    """
    if variant == "gloss_examples" and sense.examples:
        return f"{sense.gloss}; {'; '.join(sense.examples)}"
    if variant == "lemma_gloss":
        return f"{sense.words[0] if sense.words else ''}: {sense.gloss}"
    return sense.gloss
