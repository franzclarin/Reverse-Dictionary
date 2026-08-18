import { NextRequest, NextResponse } from "next/server";
import { getWordData, getRelatedWords } from "@/lib/wordData";
import { describeError, formatErrorShape } from "@/lib/errors";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: { word: string } }
) {
  try {
    const wordData = await getWordData(params.word);
    if (!wordData) {
      return NextResponse.json({ error: "Word not found" }, { status: 404 });
    }
    const related = await getRelatedWords(wordData.word);
    return NextResponse.json({ ...wordData, related });
  } catch (error) {
    const shape = describeError(error);
    console.error(`[word] FAILED word=${JSON.stringify(params.word)} ${formatErrorShape(shape)}`);
    return NextResponse.json(
      {
        error: "Failed to fetch word data",
        code: shape.code,
        detail: shape.message,
      },
      { status: 500 }
    );
  }
}
