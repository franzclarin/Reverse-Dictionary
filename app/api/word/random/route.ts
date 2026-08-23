import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { describeError, formatErrorShape } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * Draws from answerable_vocab, not raw VocabEmbedding — it excludes the
 * capitalised/digit/punctuation lemmas that make up 22.7% of the full index,
 * so "Random Word" doesn't hand back a proper noun most of the time.
 */
export async function GET() {
  try {
    const rows = await prisma.$queryRawUnsafe<{ word: string }[]>(
      `SELECT word FROM answerable_vocab
       ORDER BY word
       OFFSET floor(random() * (SELECT COUNT(*) FROM answerable_vocab))
       LIMIT 1`
    );

    const word = rows[0]?.word;
    if (!word) {
      return NextResponse.json({ error: "No words available" }, { status: 404 });
    }

    return NextResponse.json({ word });
  } catch (error) {
    const shape = describeError(error);
    console.error(`[word/random] FAILED ${formatErrorShape(shape)}`);
    return NextResponse.json(
      {
        error: "Failed to fetch a random word",
        code: shape.code,
        detail: shape.message,
      },
      { status: 500 }
    );
  }
}
