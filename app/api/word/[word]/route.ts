import { NextRequest, NextResponse } from "next/server";
import { getWordData } from "@/lib/wordData";

export async function GET(
  _request: NextRequest,
  { params }: { params: { word: string } }
) {
  try {
    const wordData = await getWordData(params.word);
    if (!wordData) {
      return NextResponse.json({ error: "Word not found" }, { status: 404 });
    }
    return NextResponse.json(wordData);
  } catch (error) {
    console.error("Error fetching word data:", error);
    return NextResponse.json(
      { error: "Failed to fetch word data" },
      { status: 500 }
    );
  }
}
