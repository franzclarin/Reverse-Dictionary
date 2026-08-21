# Evaluation methods — the decision record

Why this benchmark is built the way it is. Everything here was determined before
any authored result existed, and none of it depends on how the numbers come out.
It is written for someone who was not present — including whoever picks this up
in six months.

The companion document is `eval/REPORT.md`, which carries the numbers. That file
is **generated** by `scripts/report.ts` and must never be edited by hand. This
file is the opposite: hand-written, and stable across reruns.

---

## 1. Why the eval set is hand-authored

**There is no user data to draw on. Not a little — none.**

The production schema was searched for anything resembling a (description →
word) pair. What exists:

| Table | Contents | Usable pairs |
|---|---|---|
| `Lookup` | `{ id, userId, createdAt }` | 0 — it is a rate-limit counter. The query text was never stored. |
| `GameRound` | `coinflip`, `slots`, … | 0 — this is the credits casino, not a word game. The name misleads. |
| `SavedWord` | word ids a user starred | 0 — no description attached, and no record of what was typed to find it. |
| `Word` | word profiles from the era when pages had generated definitions | 93, and they leak — see §4. |

So the benchmark cannot be a sample of real queries, because no sample of real
queries exists anywhere in the system. The choice was between a hand-authored set
and no benchmark at all, and "no benchmark" is the status quo that makes every
downstream decision — index tuning, frequency priors, hard-negative mining,
reranking — unfalsifiable.

This is a limitation to state, not to hide. It appears again in §8.

---

## 2. Why WordNet glosses cannot be used as evaluation data

The obvious cheap move is to build the eval set from WordNet: ~117k glosses, each
already paired with its lemma. It is verified contaminated, so it was rejected.

**The evidence is the fine-tune's own model card**, shipped inside
`reverse_dict_model.zip` at `sentence_model/README.md`:

- **181,149 training triplets** of the form (gloss, lemma, negative lemma)
- `MultipleNegativesRankingLoss`, **3 epochs**
- `eval_on_start: False`, **no evaluator configured**, `prediction_loss_only: True`
- **No held-out split of any kind.** Every triplet was trained on.
- The card's own sample rows are verbatim WordNet glosses.

Three epochs over an unsplit corpus means any WordNet-gloss-derived test slice is
approximately 100% leaked. Not "possibly leaked" or "unverified" — the training
set is the whole corpus, by the trainer's own configuration.

**The corroborating probe** (`scripts/inspect-eval-sources.ts`, "Vocabulary
provenance") checks the other half of the claim: that the *index* is the same
WordNet lemma set the model trained on. Eighteen words were probed against
`VocabEmbedding`:

- **14 of 14** words lifted straight from the model card's training samples are
  present — including `American pulsatilla`, `genus Pulsatilla`, `champion lode`,
  `southern spatterdock`, `international mile`, and both casings of
  `damascene` / `Damascene`. No hand-curated vocabulary contains those. A WordNet
  dump does.
- **0 of 4** modern words absent from WordNet 3.0 are present (`petrichor`,
  `metafiction`, `sonder`, `rizz`) — the negative control.

Later measured directly: `VocabEmbedding` is ~95% of WordNet 3.0, and only 139 of
its 141,854 rows are not WordNet lemmas at all.

So the model trained on WordNet glosses, and the index is the WordNet lemma set.
A WordNet-derived benchmark would be scoring the model on its own training data,
retrieving from a vocabulary built out of the same file.

---

## 3. Why WordNet glosses *can* be used as index content

This looks like a contradiction with §2 and is not. Recording the distinction
explicitly, because it will look like one again later.

**Contamination is a property of the test set, not of the corpus.** What
invalidates a benchmark is the evaluator having seen the *answers* — the specific
pairs it is scored on. It says nothing about what the system under test is
allowed to contain.

- Putting a gloss in the **test set** means asking the model a question it was
  trained on. The result measures memorisation.
- Putting a gloss in the **index** means changing what the system retrieves *over*.
  The queries are still blind and hand-authored, and the answer is still scored
  against a held-out description the model has never seen.

Phase E's gloss index is a change to the retrieval corpus, evaluated with the same
uncontaminated queries as every other cell. That is legitimate. Building
`eval/sets/*.jsonl` from those same glosses would not be.

The one place this needs care is the self-retrieval integrity check
(`scripts/verify-eval-pool.ts`), which deliberately queries each cell with its own
indexed text. That is a **wiring check**, not a measurement: it confirms vectors
and word lists are aligned. Its numbers are not recall and never appear in the
report. The `gloss_base_lem` variant is the case in point — it self-retrieves
perfectly because the lemma is literally inside its own indexed text, which is a
property of the variant, not evidence it is better. Worth knowing before the
experiment; worthless as a result after it. (The criterion for gloss cells is
synset-level, not lemma-level; see §10 for why the lemma-level number is
meaningless at full scale.)

---

## 4. The tripwire, and why it is quarantined

`eval/sets/tripwire.jsonl` — 93 pairs built from `Word.definition` rows written
when word pages still had generated profiles.

These are not WordNet gloss text, so they are not leaked at the *token* level. But
they describe words the fine-tune saw glossed, in dictionary register, so they leak
at the **paraphrase** level. Every row carries `meta.leakage: "paraphrase"`, the
harness prints them in a separate block, and `scripts/report.ts` tables them apart
from the authored slice with the label attached.

**What it is for:** catastrophic-regression detection. If a change drops these 93
by twenty points, something is broken in a way that needs no subtle instrument.

**What it is not for:** any headline number, ever.

**The register gap, quantified.** The tripwire smoke test scored **R@10 62.4%**
(R@1 19.4%, R@3 38.7%, MRR@10 0.318, echo 32.5%). Hand-written queries in the
earlier 25-query margin probe put the target in the top 10 roughly **19%** of the
time. Same model, same index, same day — a **~43-point spread produced entirely by
how the question is phrased**.

That gap is the single most important reason this document exists. A dictionary
definition and a person describing a half-remembered word are different
distributions, and a benchmark built from the first tells you almost nothing about
the second. Any future number quoted without saying which register it came from is
uninterpretable.

---

## 5. The blind drafting protocol

**The load-bearing constraint of the entire benchmark.**

Every `authored` query was written from:

- the **target word**, and
- at most a **one-word sense hint** (to disambiguate `bank`, `crane`, `pitch`).

And from nothing else. While drafting, the author did not look up, retrieve, or
consult the WordNet gloss, the `Word.definition` row, or any dictionary definition
of the target.

The tooling enforces this structurally rather than trusting discipline:
`scripts/sample-targets.ts` emits **bare words only** — no glosses, no definitions,
no example sentences — precisely so the sampling step cannot contaminate the
authoring step.

**Why it is load-bearing.** The model was trained on 181,149 WordNet glosses for
three epochs with no held-out data. A query that borrows a gloss's phrasing — even
loosely, even from the memory of having just read it — is a query the model has
effectively already seen. Blind authoring is the only thing standing between this
benchmark and the tripwire's 62.4%, and the ~43-point register gap in §4 is the
measure of exactly how much it is worth.

If this protocol is ever violated for a subsequent version of the set, that version
is worthless and must be discarded rather than patched. **The set is frozen once
built; a new version means a new filename, never an in-place regeneration.**
`scripts/build-eval-set.ts` prints a sha256 for exactly this reason, and
`scripts/report.ts` records it beside every number derived from it.

### Deliberate inclusions

- **Lexical overlap is kept, not filtered.** Ten multi-word targets have their head
  noun in the query (`bowler hat` ← "a stiff black **hat** with a curled brim").
  These were briefly rewritten to avoid it and then reverted: a person asking about
  a bowler hat *says* "hat", and forbidding the natural phrasing would make the set
  measure a distribution that does not exist. `meta.lexical_overlap ∈ {none,
  stem_shared, head_noun}` labels them, and every report gives recall both including
  and excluding them.
- **Unreachable targets are kept.** `meta.reachable: false` rows measure vocabulary
  coverage. They are excluded from headline recall and reported separately.
- **`acceptable[]`** enables a lenient Recall@1 alongside the strict one, for the
  cases where a genuine synonym is not a failure.

---

## 6. Hypotheses tested and killed

Each was a plausible explanation for poor retrieval. Each was measured before any
engineering was spent on it, and each is dead. Recorded with the number that killed
it, so none of them gets re-proposed.

### Junk vocabulary — dead

**Hypothesis:** the index is 22.7% proper nouns and taxonomy (`Peary`,
`genus Pulsatilla`, `Damascene`), and they crowd out real answers.

**Measured:** proper nouns are 22.7% of the index but only **2.8% of top-10
results** — and 5 of those 7 were case-duplicates of a word already in the same
list. Applying the filter moved recall by **0.0 points**.

**Verdict:** the junk is real and it is inert. The predicate survives as
`junkPredicate()` in `scripts/lib/retrieval.ts`, backing both `--filter-junk` and
the `answerable_vocab` view (109,596 of 141,854 rows), because it costs nothing and
a null result is worth being able to reproduce. It is not a lever.

### Verb coverage gap — dead

**Hypothesis:** the vocabulary under-represents verbs, so descriptions of actions
have no answer to find.

**Measured** (POS coverage diff against WordNet 3.0, excluding numerals): noun
96.1%, **verb 94.9%**, adjective 95.2%, adverb 92.2%.

**Verdict:** 94.9% against 96.1% is noise. The gap is diffuse, not structural —
~7,148 missing lemmas, mostly Latin taxonomy, plus ~258 orphaned verbs. A coverage
tax, not a hole.

### The approximate index — dead

**Hypothesis:** IVFFlat with `probes = 10` is missing answers that exact search
would find.

**Measured, two ways.** Sequential scan (`--exact`) on the tripwire gave **+1.0
point of R@1**, on **3 discordant pairs**, **p = 1.0**. And in the 25-query margin
probe, of 17 misses only **2** were approximate-index failures; **15** were true
ranking failures — the target was scored, and scored below the results that beat it.

**Verdict:** the index returns very nearly what an exhaustive scan would. The
answers are not being missed; they are being ranked correctly-by-the-model and
wrongly-by-the-task.

---

## 7. What is known to be broken

The three findings that survived. These are the reason Phase E exists.

### Bare-lemma representation

`VocabEmbedding` stores the embedding of **the word itself**, not of any
description of it. `cos(embed(word), stored[word]) = 1.000000 ± 1e-6` across 24
probe words (`scripts/probe-representation.ts`). Corroborated structurally: the
seed artifact `vocab.index` is 217,887,789 bytes = 141,854 × 384 × 4 + 45.

So search matches a twelve-word description against a **one-token document**.

Note this is *consistent with* the training configuration
(`directions: ["query_to_doc"]`) — the model was trained to map a gloss to a lemma,
and that is what production does. It is **not** a train/serve mismatch. The
fine-tune simply did not achieve its own objective well enough for the task.

### Lexical echo, at 34.4%

**34.4%** of top-10 results share a stem with a content word in the query — "rain"
returns `raininess`, `rainstorm`, `raindrop`. The model is doing string-adjacent
matching where meaning was wanted.

### The margins make reranking impossible

The decisive measurement. Against the true target's score:

- echo results outscore it by **+0.134** mean cosine
- **non-echo results outscore it by +0.094**

The target sits below *nearly everything returned*, not merely below the echoes.
A reranker over the top 10 has nothing to reorder, because the right answer is
usually not in the top 10 to begin with — and when it is, it is at the bottom.

Concretely: a natural description of a word retrieves that word at a cosine of
about **0.53**, while unrelated-but-lexically-adjacent words clear 0.65.

**This is why the next experiment is re-encoding and not reranking.** The
`R@10 − R@1` gap and the rank-10-to-100 headroom figure in the generated report are
the numbers that would overturn it: large headroom means a wider reranker has
something to work with; near-zero headroom means the representation is the only
lever.

---

## 8. Known limitations of this benchmark

To be restated wherever the set is cited. None of these are fixable within the
current version; all of them bound what the numbers can support.

1. **Single author, single session.** Every authored query was written by one
   writer in one sitting. It is blind, but it is single-register. Two authors would
   disagree about phrasing more than this set does.
2. **Not a sample of real user queries.** See §1 — no such sample exists. The set
   is a model of how people might phrase these questions, not a measurement of how
   they do.
3. **Frequency bands come from OpenSubtitles.** `meta.zipf` is drawn from
   OpenSubtitles 2018 (`eval/data/zipf-en.tsv`, 92,929 lemmas). Conversational
   register, which matches how these queries are phrased — but it systematically
   under-weights literary and technical vocabulary. A word marked "rare" here may be
   ordinary in writing. Raw Zipf is stored per row and bands are derived at analysis
   time, so the boundaries can be redrawn without rebuilding the set.
4. **~300 queries.** Enough for a paired test on rank-1 disagreements, not enough
   to read a three-point difference between two independent runs. This is why
   `--compare` is paired and reports McNemar rather than two recall figures side by
   side.
5. **Style and length slices are small.** A slice of 40 queries moving five points
   is not a finding.
6. **`acceptable[]` is only half filled, by choice.** The set was frozen with
   **133 of 312 rows carrying `acceptable[]` entries and 179 empty**, and the 248
   `unsure` recommendations in `eval/audit/acceptable-recommendations.tsv` were
   never resolved. On those 179 rows lenient R@1 is arithmetically identical to
   strict R@1, so **the synonym-tie deflation that §9a switched metrics to correct
   for is only partially corrected in the v1 run.** This was a deliberate
   MVP-scope decision to stop reviewing and get a first real result, not an
   oversight: a partial fix is worth more than a delayed one, and the unresolved
   candidates are recorded and can be applied later without rebuilding anything.
   **Do not read the v1 lenient figures as a complete correction.** The residual
   bias runs against the gloss arms, so a gloss cell that clears the §9a threshold
   here has cleared it despite the handicap; one that narrowly misses may be
   losing to the handicap rather than to the representation.

---

## 9. Pre-registered commitments

Two things recorded before the data, so neither can be retrofitted. Both are
printed by the tooling — the first by every `eval.ts` run, the second by
`scripts/report.ts` directly above the Phase E comparison table — so they arrive
attached to the numbers they constrain rather than filed away here.

### 9a. The decision rule

**Original wording — recorded 2026-08-19, before any Phase E number existed:**

> A gloss cell beating the lemma baseline by fewer than ~6 points of Recall@1 is a
> null result, not a win. At n≈289 the paired test cannot distinguish smaller
> differences from noise; the synthetic run showed a 5.7-point delta reading as
> p = 0.51 on 37 discordant pairs. The effect size that would justify a
> representation change is the scale of the register gap already measured — 62.4%
> against ~19%, i.e. tens of points — not single digits. A small positive result is
> to be reported as a null result and not acted on.

**Amended 2026-08-19, same day, still before any Phase E number existed.** The rule
is unchanged in threshold and in force; only the metric it resolves on is fixed:

> The rule resolves on **lenient Recall@1** — rank-1 scored against the
> hand-authored `acceptable[]` list — not on strict R@1, and not on R@10 or MRR@10.
> Everything else stands: fewer than ~6 points is a null result, not a win, and a
> small positive result is to be reported as a null result and not acted on.

#### Why the metric was fixed

The synonym-tie confound (§10) means a gloss cell faces exact ties on 76% of the
benchmark, which deflates its **strict** R@1 specifically. Four candidate resolutions
were considered and three rejected:

- **R@10 + MRR@10 — rejected. R@10 is not the product metric.** The UI navigates
  straight to `/word/[top.word]`; the user sees position one and nothing else.
  Deciding on R@10 could ship a representation that is better at R@10 and worse at
  what users actually experience.
- **MRR@10 — rejected. It is not tie-immune, only damped.** A two-way tie yields an
  expected reciprocal rank of 0.75 rather than 1.0, and it degrades further as the
  synset grows. Describing it as "largely tie-immune", as an earlier draft of §10
  did, overstated the protection.
- **Synset-aware scoring — rejected. It defines correctness using WordNet**, the
  same resource the gloss cells are built from. Synset-mates hold identical vectors
  in the gloss index *by construction*, so crediting a mate would reward the gloss
  arm for its own structure rather than for retrieval quality.
- **Lenient R@1 — adopted. It is the WordNet-independent, human-authored version of
  the same fix.** `acceptable[]` already exists in the schema and is being filled
  during the current review. A person should dispose of synonymy even where WordNet
  proposes it — WordNet lists `oblivion` and `limbo` as mates; whether that is an
  acceptable answer is a judgement, not a lookup.

**No threshold re-derivation is required.** Lenient R@1 is still a binary rank-1
outcome per query, so the existing paired McNemar machinery applies unchanged and
the ~6-point figure carries over exactly.

#### Why this amendment is not the failure mode it resembles

Revising a pre-commitment after seeing which way it cuts is precisely the failure
mode a pre-commitment exists to prevent, and that objection was raised against this
change before it was made. It does not apply here, and the distinction is recorded
so it stays auditable:

- The confound surfaced from a **machinery integrity check** — asking why a
  full-scale gloss cell self-retrieved at 36/60 — not from any result.
- **Zero eval numbers exist.** No authored run has been scored against any cell. The
  amendment cannot have been influenced by an outcome, because there is no outcome.
- The threshold, the direction and the force of the rule are untouched. Only the
  metric is specified, and it is specified *more* strictly than R@10 would have been.

If this rule is ever changed again, it must be changed the same way: deliberately,
in writing, dated, with both wordings kept — and before the numbers, never after.

#### What is still reported

**Strict R@1 continues to be reported for every run**, flagged as tie-deflated for
gloss cells. So do R@3, R@10, MRR@10, lenient R@3 and R@10, and echo rate. The rule
constrains the *decision*, not the reporting: the actual delta, its p-value and its
discordant-pair count are always printed. What is pre-committed is what they are
allowed to authorise.


### 9b. The narrative-slice prediction

Recorded before any authored numbers existed, so it cannot be retrofitted.
Reproduced verbatim from the harness constant `PREREGISTERED_NOTE`, which is
printed by every run, stored in every `eval/runs/*.json`, and printed by
`scripts/report.ts` directly above the style slice it concerns:

> Pre-registered (Phase A2/POS audit): orphaned verbs are 2.2% of the verb
> inventory, too few to move the narrative slice. Low narrative recall implicates
> the representation, not vocabulary coverage.

In full: 258 orphaned verbs out of 11,540 is 2.2% of the verb inventory — too small
to move a whole style slice. **If `narrative` recall lands materially below the
other styles, orphaned verbs are almost certainly not the explanation, and the
finding points back at the representation.**

---

## 10. The Phase E pool

The 2×2 (fine-tune vs base model) × (lemma index vs gloss index) runs against
**141,362 words** — every word in `VocabEmbedding` that carries a WordNet gloss,
which is **99.7% of the production index**. 204,549 gloss rows across the four
gloss cells.

### Why it is not the 20,287-word sample it started as

The original pool was 287 targets plus 20,000 distractors, a 14% sample. That
number existed for one reason: Neon's 512 MB ceiling, back when the cells were
going to live in Postgres. **The constraint disappeared when the cells moved to
local files, and nothing revisited the number.** It was rebuilt at full scale for
three reasons.

**1. Sampling attenuates the exact effect under investigation.** The failure being
measured is morphological relatives outranking the true answer (§7). At a 14%
sample, a word with twelve relatives in the full index gets roughly two of them
drawn — the sample strips out most of the competition that *produces* the effect.
Combined with a detection threshold of ~4–6 points (§9a), a genuine fifteen-point
gloss advantage could arrive attenuated below threshold and read as "no
difference." **A false negative is the expensive error here**, not an imprecise
margin: it would retire a hypothesis that was actually right.

**2. It enables a cross-validation that is impossible at 20k.** At full
vocabulary, `eval_lemma_ft` scores the same words, the same vectors and the same
model as Phase D's `--exact` run against Postgres — through a completely
independent implementation (brute-force scan of a local Float32 buffer vs a
pgvector sequential scan). **Those two numbers should agree closely, and the
comparison is to be reported explicitly.** A divergence means one of the two
pipelines has a bug, and that has to be known *before* anything is built on top of
the results.

**3. It cost time that was not otherwise being used** — about four hours of
embedding, unattended, and 1.69 GB on disk outside the working tree.

### What is still not comparable to production

- **Cells are exact by construction.** Brute-force scans, not IVFFlat lookups, so
  no approximate-index error enters the comparison. Their latency figures are
  meaningless and their recall is a ceiling, not an estimate.
- **The pool is 141,362 words, production is 141,854.** The 492-word difference is
  words with no WordNet gloss, excluded so that no cell can win on coverage.
- **A production build would still differ.** It would index the full WordNet lemma
  set, repairing the ~5% coverage gap this pool inherits from `VocabEmbedding`.

### Scale is recorded, and crossing it is blocked

A `sampled` cell and a `full` cell answer different questions — fewer distractors
is a strictly easier task — so scale travels with the data rather than living in
someone's memory: `pool-manifest.json` records it, every cell's metadata carries
it, every run's config carries it, `verify-eval-pool.ts` refuses to score a cell
whose word set does not match the current manifest, and `report.ts` marks any
comparison that crosses the boundary **⚠ cross-scale** and states that its delta is
not interpretable. **Do not compare across that boundary.**

The pool remains **matched by construction** within a scale: any word that cannot
appear in every cell of that pool appears in none.

**The six cells are deliberately split across two scales.** The 2×2 that decides
anything — `eval_lemma_ft`, `eval_lemma_base`, `eval_gloss_ft`, `eval_gloss_base` —
is built at **full** scale. The two gloss-text variants — `eval_gloss_base_ex`
(definition + WordNet's quoted examples) and `eval_gloss_base_lem`
(`"<lemma>: <definition>"`) — remain on the **sampled** 20,287-word pool.

They are therefore **not comparable to the 2×2 and not comparable to each other's
full-scale counterparts.** They can only be read against each other and against a
sampled `eval_gloss_base`. Treat them as a secondary question — *which gloss text
works best* — that is only worth asking at full scale if the primary 2×2 gives the
gloss representation a reason to exist. `verify-eval-pool.ts` reports them as STALE
against the full manifest and skips them; `report.ts` marks any comparison that
crosses the boundary ⚠ cross-scale.

The `gloss_base_lem` variant carries a second warning independent of scale: it
reintroduces the lemma into its own indexed text, which is exactly the lexical echo
the gloss index exists to remove. Its 60/60 self-retrieval score is a consequence of
that, not evidence in its favour (§3).

### The synonym-tie confound — measured, and it is large

Discovered during integrity checking of the full-scale cells, before any result
existed. **It systematically disadvantages gloss cells on strict Recall@1, and the
effect is big enough to interact with the decision rule in §9a.**

WordNet gives a **synset** one gloss, shared by every word in it. The pool stores
one row per (word, sense), so that identical text appears once per synonym —
identical input, therefore **bit-identical vectors and an exact tie**. Which
synonym lands at rank 1 is arbitrary tie-breaking, not retrieval.

Measured on the full-scale pool:

| | |
|---|---|
| Distinct synsets in the pool | 114,662 |
| Mean pooled words per synset | 1.78 |
| Synsets holding more than one pooled word | 53,150 (**46.4%**) |
| **Eval targets sharing a synset with another pooled word** | **218 / 287 (76.0%)** |
| Largest synset containing a target | 24 words |

Examples: `aglet` ties with `aiglet` and `aiguilette`; `satiation` with `repletion`
and `satiety`; `windbag` with `gasbag`.

**Consequence.** For roughly three quarters of the benchmark, a gloss cell's strict
R@1 is decided by a coin toss among synonyms even when retrieval is perfect. The
lemma index has no such tie — `aglet` and `aiglet` are different strings, so they
get different vectors and the model genuinely ranks them. **Strict R@1 is therefore
not a like-for-like comparator between the lemma and gloss arms.**

What is and is not affected:

- **R@10 is unaffected** — tied synonyms land adjacent, so the target is still
  inside the top 10. But R@10 is *not* the product metric: the UI navigates
  straight to `/word/[top.word]`, so a decision made on R@10 can ship something
  users experience as worse. See §9a.
- **MRR@10 is damped, not immune.** A two-way tie gives an expected reciprocal rank
  of 0.75 rather than 1.0, and it degrades further as the synset grows. An earlier
  draft of this section called it "largely tie-immune"; that overstated it.
- **Lenient R@1 is the adopted resolution** (§9a) — rank-1 scored against the
  hand-authored `acceptable[]` list. It is WordNet-independent, which synset-aware
  scoring is not. It degrades back into strict R@1 wherever `acceptable[]` is
  empty, which is why `eval/audit/synonym-worklist.txt` exists: it puts the 218
  affected targets in front of the reviewer as candidates.
- **`gloss_base_lem` is not affected at all**: prefixing `"<lemma>: "` makes every
  row's text unique, which breaks the ties. That is a genuine advantage of the
  variant and is confounded with the echo problem it reintroduces — one more reason
  its numbers cannot be read straight.

This was found by asking why the full-scale `eval_gloss_ft` cell scored 36/60 on
exact-lemma self-retrieval where the sampled cell had scored ~57/60. It was not a
regression: **24 of the 24 "misses" were synset-mates at cosine 1.0000, and 0 came
from a different synset.** The old 57/60 was itself the artifact — at 14% sampling
most mates were simply absent from the pool, so the queried word won by default.
The integrity check now scores gloss cells by **synset**, where all three
full-scale cells sit at 60/60.

### The per-synset cell

Because synset-mates hold bit-identical vectors, the gloss index is 43.9%
duplicated: **204,549 rows collapse to 114,662 distinct ones**, with **0 divergent
synsets** — the bit-identity was asserted row by row before any collapse, and
holds exactly. `eval_gloss_base_synset` is that collapse, built by
`scripts/build-synset-cell.ts` as a dedupe pass over vectors already computed. No
re-embedding, seconds rather than an hour.

`gloss_base_ex` was checked separately, since WordNet's example sentences might
have been attached per sense rather than per synset. They are not: **0 divergent
synsets there too**, so gloss+examples is also purely per-synset. (Its 10.4%
collapse rate is lower only because that cell is still on the 20k sampled pool,
where most mates are absent — not because its text differs.)

**Its scoring surface differs, and it is reported separately.** A row is a synset,
so retrieval expands each hit into member words in descending Zipf order — where
the vectors genuinely cannot separate two synonyms, the commoner word is the
better guess. One retrieved synset can therefore occupy several top-k slots: a
24-member synset at rank 1 fills the entire top 10 by itself. R@k is not measured
on the same surface as a per-sense or lemma cell's. **Never substitute this cell
for `eval_gloss_base` in the 2×2.** `report.ts` marks any comparison that crosses
that boundary ⚠ cross-surface, alongside the ⚠ cross-scale marker.

**Why it matters for production.** Vector payload as a Postgres index:

| | vector(384) | halfvec(384) | halfvec(256) |
|---|---|---|---|
| per-sense (204,549 rows) | 314 MB | 157 MB | **105 MB** |
| per-synset (114,662 rows) | 176 MB | 88 MB | **59 MB** |

At halfvec(256) the per-synset index is ~59 MB against ~105 MB per-sense. That is
the difference between a gloss index fitting alongside `VocabEmbedding` inside the
512 MB ceiling and not — which is why the deduplication is worth knowing about
before any cutover question is asked, even though the cutover itself stays
deferred. Index overhead is extra; these are payload figures.

### Cost note

Scoring a full-scale gloss cell is a brute-force scan of 204,549 rows × 384 dims —
about **79M multiply-adds per query**. A ~300-query set takes roughly **10 minutes**
rather than one. That is the search working, not a hang.

### Why local files at all

The Neon project has a **512 MB ceiling** and `VocabEmbedding` alone is 452 MB of
it. There is no room for a second index — an attempt to stage one failed with
`53100 project size limit exceeded`. Moving the experiment out of Postgres removed
every database write, made the scans exact, and — as it turned out — removed the
only reason the pool was ever sampled.

---

## 11. What makes the numbers trustworthy

The mechanical guarantees, for completeness:

- **One embedding path.** `scripts/eval.ts` imports `embed` from `lib/embedder.ts`.
  A second implementation would make every number fiction. The only exception is
  `scripts/lib/embedModel.ts`, which exists solely to load a *different model* for
  the base-model control, and copies the pipeline settings verbatim with a comment
  saying they must stay in sync.
- **One query path.** `scripts/lib/retrieval.ts` mirrors `app/api/lookup/route.ts`
  — same `$transaction`, same `SET LOCAL ivfflat.probes`, same `<=>` ordering, same
  `1 − distance` similarity.
- **Read-only.** The harness performs no writes against the production database.
- **The app is never modified.** This is additive tooling.
- **The embedder is warmed before timing**, so ONNX cold start does not land on
  query #1 and destroy the latency percentiles.
- **The deep scan is untimed and separate**, so measuring rank-100 headroom cannot
  contaminate the latency figures.
- **Latency here is not production latency.** It is a local-machine-to-Neon round
  trip; in production the function and the database are both in `iad1`. Valid for
  comparing runs on one machine, invalid for describing user experience. The
  generated report repeats this next to every latency number.

---

## 12. The tie-break contamination — found 2026-08-20, after v1 was reported

A defect in the harness, found while resolving the `cell_gloss_synset` gap. It
inflates every gloss cell's Recall@1 in the v1 headline table and leaves the
lemma cells untouched, so it inflates the one comparison §9a resolves on. It is
recorded here in full rather than quietly corrected, because numbers derived
from it have already been written down.

### What happened

`build-eval-pool.ts` emits its word list as `[...targets, ...distractors]`. The
287 eval targets therefore occupy the first 685 rows of every cell — the first
row whose word is *not* an eval target is row 685. `searchLocal(perSense)`
resolves equal scores by row order (a `Map` keyed in insertion order, then a
stable sort), so among bit-identical synset mates **the eval target always sorts
first**. It wins every synset tie it is part of, for a reason that is a property
of the answer key rather than of retrieval.

§10 already recorded that synset mates share one gloss and so carry identical
vectors, and that 76.0% of targets sit in a multi-word synset. What was missed is
that the tie *order* was not neutral. The confound was described; its direction
was not.

### Why it is asymmetric, which is what makes it serious

A lemma cell holds one distinct vector per word and produces essentially no ties
— 0 to 1 tied queries out of 287. A gloss cell ties on 138–148 of them. The lift
therefore lands entirely on one side of the gloss-versus-lemma comparison.

### The correction

Under a tie order that does not know the answer key, slot 1 holds an acceptable
word with probability `a/g`: `g` the size of the bit-identical group at the top,
`a` how many of its members are acceptable. Summing that is an **exact**
expectation, not a simulation. It is an upper bound only when a tie group is wide
enough to fill the whole top-k — which happens in **zero** queries here, so the
figures below are exact. `scripts/audit-tiebreak.ts` computes them from the run
files and flags saturation if it ever occurs.

| cell | lenient R@1 as run | neutral tie-break | strict R@1 as run | neutral |
|---|---|---|---|---|
| `cell_gloss_ft` | 26.8% | **23.0%** | 26.5% | 17.6% |
| `cell_gloss_base` | 23.0% | **20.3%** | 22.3% | 15.3% |
| `cell_lemma_ft` | 10.5% | 10.5% | 5.9% | 5.9% |
| `cell_lemma_base` | 5.9% | 5.9% | 2.8% | 2.8% |
| `baseline`, `exact` | 10.1 / 10.5% | unchanged | 5.6 / 5.9% | unchanged |

The Postgres runs search `VocabEmbedding`, whose bare-lemma vectors are distinct,
so they are unaffected.

**Independent check.** `cell_gloss_ft_synset_zipf` uses a completely different
tie order (descending Zipf) and lands on the *same* corrected figures — 17.6%
strict, 23.0% lenient — while its raw figures differ (21.3% / 24.7%). The
correction is invariant to the policy it corrects, which is what it must be.

### What survives

The §9a verdicts are unchanged in direction and still clear the bar by roughly
twofold:

| comparison | as reported | corrected | §9a |
|---|---|---|---|
| `lemma_ft → gloss_ft` | +16.4 pts | **+12.5 pts** | WIN |
| `lemma_base → gloss_base` | +17.1 pts | **+14.4 pts** | WIN |

Echo rate is not a rank-1 metric and is unaffected, so the mechanism evidence —
44.3% → 14.2% — stands as recorded.

### The rule this establishes

**A tie-break must never be able to see the answer key.** Two fixes, both
required, neither yet applied:

1. `build-eval-pool.ts` must not front-load targets. Interleaving them into the
   shuffle costs nothing and removes the mechanism at its source.
2. Any index whose rows can hold identical vectors must declare an explicit,
   answer-key-independent tie order. `--expansion-order` does this for synset
   cells; per-sense cells still inherit row order implicitly.

Until (1) lands, **the starred columns of `audit-tiebreak.ts` are the citable
gloss-cell numbers**, and `eval/REPORT.md` still carries the uncorrected ones.

### What it does not affect

Rebuilding the pool changes the frozen *pool*, not the frozen *set*.
`eval/sets/v1.jsonl` and its sha256 are untouched by any of this.

### Resolution — fixed 2026-08-20, both causes, in the pipeline

Neither cause was patched around. Both were fixed where they lived, and both were
fixed even though either alone would have closed the gap: the pool fix removes
this specific exploit, the tie-break fix removes the general vulnerability so a
future pool change cannot reopen it silently.

1. **`build-eval-pool.ts` shuffles the target/distractor union** with the same
   seeded PRNG that already selected distractors, so the pool stays exactly
   reproducible while row position carries no information. Confirmed by the
   builder's own output: the first target moved from row 0 to row 519, and the
   mean target row is 73,166 of 141,362 against a uniform expectation of 70,681.
   Pool *content* is unchanged — the same 287 targets, 141,362 words and 204,549
   gloss rows.
2. **`localIndex.ts` breaks every tie through `compareWord`** (alphabetical), in
   all three search paths. Row order can no longer decide anything anywhere.

All four 2×2 cells were re-embedded from the clean pool (691,822 texts) and
verified against the manifest by input hash before any of them was scored.

**`audit-tiebreak.ts` is deleted.** A correction applied after the fact is the
wrong shape once the pipeline is correct. Its replacement, `verify-tiebreak.ts`,
computes the same neutral expectation but only to *assert* that no run exceeds
it, exiting non-zero if it does. It corrects nothing.

### The corrected numbers, measured

The audit predicted what the fix would produce. It was right, which is the
evidence that its methodology was sound rather than merely plausible:

| cell | audit predicted | measured | error |
|---|---|---|---|
| `cell_gloss_ft` | 23.0% | **23.3%** | +0.3 |
| `cell_gloss_base` | 20.3% | **21.6%** | +1.3 |
| `cell_lemma_ft` | 10.5% (unchanged) | **10.5%** | 0.0 |
| `cell_lemma_base` | 5.9% (unchanged) | **5.9%** | 0.0 |

Both gloss figures land inside the ~2.1-point sampling deviation expected of a
deterministic policy, which is one draw and not the mean. The lemma cells and all
three Postgres runs reproduced to the digit, as they must — they have no ties.

§9a verdicts on the corrected data, unchanged in direction:

| comparison | contaminated | corrected | §9a |
|---|---|---|---|
| `lemma_ft → gloss_ft` | +16.4 pts | **+12.9 pts** (53/16, p < 0.0001) | WIN |
| `lemma_base → gloss_base` | +17.1 pts | **+15.7 pts** (57/12, p < 0.0001) | WIN |
| `lemma_base → lemma_ft` | +4.5 pts | **+4.5 pts** (p = 0.029) | null result |

`verify-tiebreak.ts` PASSES on every run. The lemma and Postgres runs sit at
exactly +0.0 excess; the alphabetical gloss cells at +1.6 and +1.4, under one
standard deviation.

### A second-order finding: the tie-break is worth points

`--expansion-order wordnet` — WordNet's own within-synset ordering, which is by
sense familiarity — scores **25.8%** lenient R@1 against alphabetical's 23.3% on
the identical vectors. `verify-tiebreak.ts` reads it as +4.4 points of excess over
a random tie order, and that is a real policy gain rather than contamination:
WordNet's ordering is fixed, public, and was computed with no knowledge of this
benchmark.

**State the caveat wherever this is cited.** Choosing WordNet order *because* it
scored best here is mild benchmark-fitting. The independent justification is that
sense familiarity is exactly the right prior when retrieval genuinely cannot
separate two synonyms, and the margin over Zipf (51.8% vs 42.7% target-first on
218 multi-word synsets) is one measurement on a single-register set, not a law.

### The frozen set stayed frozen

`eval/sets/v1.jsonl` still hashes to
`cc03e1347ff696fb253c92dfb8b9e7455c64b2122f711ed5c288f33b06c0ccc8`, verified on
disk after the rebuild and matched by the `setSha256` recorded in all eleven runs.
This was a pool fix. The eval set was never an input to it.

### One control legitimately moved

Gloss-cell self-retrieval went from 60/60 to **59/60** by synset. This is correct,
not a regression: 482 gloss texts are shared by more than one synset (1,216
synsets, 1.1% of the index) — "a genus of Psittacidae" glosses eight distinct
synsets — so their vectors are bit-identical and rank 1 among them is arbitrary.
At n = 60 probes about 0.65 collisions are expected. The old 60/60 was itself
partly row-order tie-breaking, the very artifact removed here. **The criterion is
now 59–60/60 by synset**, and a lemma cell must still be exactly 60/60.
