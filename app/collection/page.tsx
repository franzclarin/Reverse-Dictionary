import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Link from "next/link";
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
    <div className="min-h-screen bg-white dark:bg-gray-950">
      <nav className="border-b border-gray-100 dark:border-gray-800 px-6 py-4">
        <Link
          href="/"
          className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors flex items-center gap-1.5 w-fit"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Reverse Dictionary
        </Link>
      </nav>

      <main className="max-w-5xl mx-auto px-6 py-12">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-50 mb-2">
          My Saved Words
        </h1>
        <p className="text-gray-500 dark:text-gray-400 mb-8">
          {words.length} {words.length === 1 ? "word" : "words"} saved
        </p>
        <CollectionGrid words={words} />
      </main>
    </div>
  );
}
