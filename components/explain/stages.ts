// The eight steps the real search takes, in order — read off this app's own
// code rather than copied from a generic diagram. Two things a stock picture
// would get wrong: there is no re-sorting step and no writing model anywhere,
// and step 7 ranks meanings, not words, so one meaning can fill several slots.

export type StageId =
  | "request"
  | "tokenize"
  | "encode"
  | "pool"
  | "normalize"
  | "retrieve"
  | "expand"
  | "render";

export type Stage = {
  id: StageId;
  n: number;
  title: string;
  /** What this step does, named. Shown as-is at the head of the caption. */
  operation: string;
  caption: string;
  /** Where the code lives, so a curious reader can go and check. */
  where: string;
  /** Whether the 3D view is the subject of this step or just the backdrop. */
  spatial: boolean;
};

export const STAGES: Stage[] = [
  {
    id: "request",
    n: 1,
    title: "Request",
    operation: "POST /api/lookup",
    caption:
      "A description goes out as JSON, capped at 500 characters. No account, no rate limit, no session.",
    where: "app/api/lookup/route.ts",
    spatial: false,
  },
  {
    id: "tokenize",
    n: 2,
    title: "Tokenize",
    operation: "WordPiece",
    caption:
      "Lower-cased and cut into sub-words from a fixed list of 30,522 pieces, wrapped in [CLS] and [SEP], truncated at 256. Pieces beginning ## continue the word before them. This step runs in your browser, on the model's own vocabulary file.",
    where: "tokenizer.json",
    spatial: false,
  },
  {
    id: "encode",
    n: 3,
    title: "Encode",
    operation: "BertModel, 6 layers, hidden size 384, 12 attention heads",
    caption:
      "The all-MiniLM-L6-v2 architecture, fine-tuned on 181,149 WordNet triplets. There is no decoder — which is exactly why word pages here carry no definitions, pronunciations or etymologies. This model can compare meanings; it cannot write.",
    where: "config.json",
    spatial: false,
  },
  {
    id: "pool",
    n: 4,
    title: "Pool",
    operation: "Mean pooling",
    caption:
      "Every token has its own vector by now. They are averaged — [CLS] and [SEP] included — into one. A sentence of any length becomes exactly 384 numbers.",
    where: "lib/embedder.ts",
    spatial: false,
  },
  {
    id: "normalize",
    n: 5,
    title: "Normalize",
    operation: "L2 normalisation",
    caption:
      "Scaled to unit length, so cosine similarity is a plain dot product. Only the direction survives; magnitude is discarded.",
    where: "lib/embedder.ts",
    spatial: true,
  },
  {
    id: "retrieve",
    n: 6,
    title: "Retrieve",
    operation: "Cosine similarity, computed in 384 dimensions",
    caption:
      "The query vector is compared against one stored vector per WordNet sense. Not a keyword match anywhere in this — the index holds definitions, and nothing is ever compared by spelling.",
    where: "lib/glossSearch.ts",
    spatial: true,
  },
  {
    id: "expand",
    n: 7,
    title: "Expand",
    operation: "Synset → lemmas, in WordNet's order",
    caption:
      "The step a stock diagram misses. What came back are senses, not words. Each unpacks into its member words, and every word inherits its sense's score — so synonyms return at identical similarity, and one large synset can fill the entire list by itself.",
    where: "lib/glossSearch.ts",
    spatial: true,
  },
  {
    id: "render",
    n: 8,
    title: "Render",
    operation: "Rank and navigate",
    caption:
      "The top word becomes the destination; the rest ride along as ?alternatives=. Ties keep WordNet's own within-synset order, which is a familiarity prior — measured at 2.5 points of lenient Recall@1 over alphabetical, on identical vectors.",
    where: "app/page.tsx",
    spatial: false,
  },
];

export const STAGE_INDEX: Record<StageId, number> = STAGES.reduce(
  (acc, s, i) => ({ ...acc, [s.id]: i }),
  {} as Record<StageId, number>
);

/** The four things the picture simplifies, said on the page itself. */
// A flattened picture is a claim about distance, and viewers will believe it.
export const APPROXIMATIONS = [
  {
    short: "3D distance is not the ranking",
    long:
      "Scores are cosine similarity across all 384 dimensions. This picture shows three of them. A true nearest neighbour can appear far away, and two points that look adjacent may be unrelated.",
  },
  {
    short: "The cloud is a sample",
    long:
      "A few thousand senses are drawn. Retrieval always searches the entire index, every time.",
  },
  {
    short: "The vector is computed on the server",
    long:
      "Tokenization above is real and local. The encoding is not: the model is 86 MB of ONNX with no quantized build, and shipping it to a browser would change query vectors and require a full re-evaluation. It stays on the server.",
  },
  {
    short: "The index partition cannot be drawn",
    long:
      "IVFFlat splits 384-dimensional space into 115 cells and opens the nearest 40. Any cell boundary drawn in three dimensions would be a metaphor, so none is drawn.",
  },
];
