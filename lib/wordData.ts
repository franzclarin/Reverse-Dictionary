import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { Word } from "@prisma/client";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const WORD_PROFILE_SYSTEM_PROMPT = `You are a lexicographer. Given a word, return a complete word profile as JSON:

{
  "word": "petrichor",
  "part_of_speech": "noun",
  "pronunciation": "/ˈpɛtrɪkɔːr/",
  "definition": "A pleasant smell that frequently accompanies the first rain after a long period of warm, dry weather.",
  "etymology": "Coined in 1964 from Greek petra (stone) + ichor (the fluid that flows in the veins of the gods).",
  "examples": [
    "She stepped outside and breathed in the petrichor after the summer storm.",
    "The petrichor from the garden reminded him of childhood.",
    "Scientists have identified geosmin as the compound responsible for petrichor."
  ],
  "synonyms": ["rain scent", "rain smell", "after-rain fragrance"],
  "domain": "meteorology"
}

Return ONLY valid JSON. No preamble.`;

export async function getWordData(wordSlug: string): Promise<Word | null> {
  const normalized = wordSlug.toLowerCase().trim();

  // 1. Check DB first
  const existing = await prisma.word.findUnique({ where: { word: normalized } });
  if (existing) return existing;

  // 2. Generate via Claude
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    temperature: 0.3,
    system: WORD_PROFILE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: normalized }],
  });

  const text = message.content[0].type === "text" ? message.content[0].text : "";

  let profile: {
    word: string;
    part_of_speech: string;
    pronunciation: string;
    definition: string;
    etymology: string;
    examples: string[];
    synonyms: string[];
    domain: string;
  };

  try {
    profile = JSON.parse(text);
  } catch {
    throw new Error("Failed to parse Claude word profile response");
  }

  // 3. Upsert — safe if two requests race past the findUnique check simultaneously
  const wordKey = profile.word.toLowerCase().trim();
  const saved = await prisma.word.upsert({
    where: { word: wordKey },
    update: {},
    create: {
      word: wordKey,
      partOfSpeech: profile.part_of_speech,
      pronunciation: profile.pronunciation,
      definition: profile.definition,
      etymology: profile.etymology,
      examples: profile.examples,
      synonyms: profile.synonyms,
      domain: profile.domain,
    },
  });

  return saved;
}
