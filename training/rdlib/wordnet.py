"""
WordNet 3.0, parsed from the same bytes the TypeScript side reads.

A LINE-FOR-LINE port of `readSenses()` in scripts/lib/wordnet.ts, and it has to
stay that way. The gloss text produced here is the text a cell is built from,
and `cells.inputs_sha256()` pins it: if this parser and the TS one disagree by
so much as a stripped semicolon, a cell built in Python and a cell built in
TypeScript get different hashes and neither can be checked against the other.

DO NOT SUBSTITUTE nltk.corpus.wordnet. It is a different distribution of the
same version with its own gloss punctuation and its own offsets, and swapping it
in would be invisible until a hash mismatch much later.

ENCODING: latin1, matching `readDataLines()`. The WordNet data files are not
UTF-8; reading them as UTF-8 either throws or mangles the accented headwords.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from .paths import WORDNET_DICT_DIR

POS_LIST = ("noun", "verb", "adj", "adv")

# The production GlossEmbedding WordNet row count, as a drift check rather than
# a requirement. RD-17 added 575,534 Wiktionary senses on top of these.
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
    All synsets for one part of speech, in WordNet's own file order.

    A WordNet gloss is `definition; "example one"; "example two"`. The examples
    are split out rather than dropped so gloss-text variants can be tested with
    and without them (RD-16 measured examples at -1.4pp, and they raised echo).

    MEMBER ORDER IS WORDNET'S OWN AND IS NEVER SORTED. `--expansion-order
    wordnet` reads that order back out of these files at query time to break
    synonym ties, and it is worth 2.5 points of lenient R@1 over alphabetical on
    identical vectors. Re-sorting here would silently change production's
    tie-break.
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
    The text indexed for one row, per cell variant. Ports `glossTextFor()` in
    scripts/lib/cellText.ts -- keep the two in step or hashes will not match.

    Measured outcomes, so you do not have to re-derive them:
      "gloss"          the production variant. Definition only.
      "gloss_examples" -1.4pp lenient R@1 and echo UP (RD-16). Examples are
                       usage sentences about a specific referent, not the
                       meaning.
      "lemma_gloss"    reintroduces the exact echo the gloss index exists to
                       remove -- RD-12 measured echo climbing to 21.4% on the
                       reranker arm that used it. It also makes every row's text
                       unique, which incidentally breaks the synonym ties the
                       other variants have.

    A NEW VARIANT IS THE CHEAPEST REAL EXPERIMENT IN THIS PROJECT. Changing what
    is indexed bought +12.9pp at the RD-02 cutover; the entire fine-tune bought
    +4.5pp. Add a branch here, build a cell, score it.
    """
    if variant == "gloss_examples" and sense.examples:
        return f"{sense.gloss}; {'; '.join(sense.examples)}"
    if variant == "lemma_gloss":
        return f"{sense.words[0] if sense.words else ''}: {sense.gloss}"
    return sense.gloss
