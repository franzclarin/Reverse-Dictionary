// Twenty-five test questions written the way a person would ask them, plus the
// rule for spotting answers that merely echo the question back.
//
// Shared by every script that reports echo, so the numbers stay comparable.
// Change the rule here or not at all.
//
// The questions were written from the idea alone, never from a dictionary. The
// listed answer is the word the author had in mind — often not the only fair
// one, so treat it as a reference rather than a verdict.
export type ProbeQuery = { query: string; answer: string };

export const PROBE_QUERIES: ProbeQuery[] = [
  { query: "the smell of rain hitting dry ground", answer: "petrichor" },
  { query: "that feeling when you walk into a room and forget why you came in", answer: "absentmindedness" },
  { query: "the little plastic bit on the end of a shoelace", answer: "aglet" },
  { query: "when you say a word so many times it stops sounding like a word", answer: "satiation" },
  { query: "someone who collects stamps as a hobby", answer: "philatelist" },
  { query: "the fear of being completely forgotten after you die", answer: "oblivion" },
  { query: "a word that reads the same forwards and backwards", answer: "palindrome" },
  { query: "the thing that holds the lenses in a pair of glasses", answer: "frame" },
  { query: "when the moon completely blocks out the sun", answer: "solar eclipse" },
  { query: "a person who has no interest in food or pleasure at all", answer: "ascetic" },
  { query: "the small dent above your upper lip below your nose", answer: "philtrum" },
  { query: "the feeling of missing a place you have never actually been to", answer: "nostalgia" },
  { query: "someone who talks a great deal but never says anything meaningful", answer: "windbag" },
  { query: "the sound a door makes when the hinges need oil", answer: "creak" },
  { query: "when a company quietly makes its product worse over time", answer: "degradation" },
  { query: "the practice of eating only plants and nothing from animals", answer: "veganism" },
  { query: "the part of a story where everything gets resolved at the end", answer: "denouement" },
  { query: "a tool you use in the kitchen to open metal cans", answer: "can opener" },
  { query: "when you laugh at something you know you should not laugh at", answer: "corpsing" },
  { query: "the habit of putting things off until the very last minute", answer: "procrastination" },
  { query: "a place where dead people are buried under headstones", answer: "cemetery" },
  { query: "the way light bends when it passes from air into water", answer: "refraction" },
  { query: "someone who pretends to hold beliefs they do not actually have", answer: "hypocrite" },
  { query: "the anxious feeling you get before speaking in front of a crowd", answer: "stage fright" },
  { query: "when two words sound the same but mean completely different things", answer: "homophone" },
];

/** Everyday joining words that say nothing about meaning. */
export const STOPWORDS = new Set(
  ("a an the of to in on at for from by with and or but not no is are was were be been " +
    "being it its that this these those you your they them their he she his her i we our " +
    "when where why how what who which as if then than so very much many most more some " +
    "any all only just about into out up down over under after before until while do does " +
    "did done have has had get gets got make makes made you're dont don't never ever also " +
    "something someone anything nothing things thing way place person people know knows")
    .split(/\s+/)
);

/** The meaningful words of a question, used by the echo rule. */
export function contentTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** Does this answer just repeat a word from the question? */
// Crude on purpose — a shared four-letter opening. Enough to catch
// rain/raininess/raindrop and laugh/laughter, which is the pattern of interest.
export function echoesQuery(resultWord: string, queryTokens: string[]): boolean {
  const resultTokens = resultWord.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (const rt of resultTokens) {
    for (const qt of queryTokens) {
      const n = Math.min(4, rt.length, qt.length);
      if (n >= 4 && rt.slice(0, n) === qt.slice(0, n)) return true;
    }
  }
  return false;
}
