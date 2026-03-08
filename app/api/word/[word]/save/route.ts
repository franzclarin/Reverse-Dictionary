import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { awardWordSave } from "@/lib/credits";

export const dynamic = "force-dynamic";

export async function POST(
  _request: NextRequest,
  { params }: { params: { word: string } }
) {
  const { userId } = auth();
  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const wordRecord = await prisma.word.findUnique({
    where: { word: params.word.toLowerCase().trim() },
  });

  if (!wordRecord) {
    return NextResponse.json({ error: "Word not found" }, { status: 404 });
  }

  const existing = await prisma.savedWord.findUnique({
    where: { userId_wordId: { userId, wordId: wordRecord.id } },
  });

  await prisma.savedWord.upsert({
    where: { userId_wordId: { userId, wordId: wordRecord.id } },
    create: { userId, wordId: wordRecord.id },
    update: {},
  });

  // Award +2 credits for saving a new word (not for duplicate saves)
  if (!existing) {
    await awardWordSave(userId);
  }

  return NextResponse.json({ saved: true });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { word: string } }
) {
  const { userId } = auth();
  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const wordRecord = await prisma.word.findUnique({
    where: { word: params.word.toLowerCase().trim() },
  });

  if (!wordRecord) {
    return NextResponse.json({ error: "Word not found" }, { status: 404 });
  }

  await prisma.savedWord.deleteMany({
    where: { userId, wordId: wordRecord.id },
  });

  return NextResponse.json({ saved: false });
}
