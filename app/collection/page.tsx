import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import CollectionGrid from "@/components/CollectionGrid";

export const dynamic = "force-dynamic";

export default async function CollectionPage() {
  const { userId } = auth();
  if (!userId) redirect("/sign-in");

  const saved = await prisma.savedWord.findMany({
    where: { userId },
    include: { word: true },
    orderBy: { savedAt: "desc" },
  });

  const words = saved.map(({ word, savedAt }) => ({
    word: {
      id: word.id,
      word: word.word,
      partOfSpeech: word.partOfSpeech,
      definition: word.definition,
    },
    savedAt: savedAt.toISOString(),
  }));

  return (
    <main className="min-h-screen" style={{ background: "var(--rd-paper)" }}>
      <div className="max-w-5xl mx-auto px-6 py-12">
        <div className="mb-10">
          <h1
            className="font-serif mb-2"
            style={{ fontSize: "clamp(1.75rem,4vw,2.5rem)", fontWeight: 400, color: "var(--rd-ink)" }}
          >
            My Words
          </h1>
          <p className="font-mono text-xs uppercase tracking-wide" style={{ color: "var(--rd-ink-muted)" }}>
            {words.length} {words.length === 1 ? "word" : "words"} saved
          </p>
        </div>

        <CollectionGrid words={words} />
      </div>
    </main>
  );
}
