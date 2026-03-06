import { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { getWordData } from "@/lib/wordData";
import { prisma } from "@/lib/prisma";
import WordShareButtons from "@/components/WordShareButtons";
import SaveWordButton from "@/components/SaveWordButton";

interface PageProps {
  params: { word: string };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  try {
    const wordData = await getWordData(params.word);
    if (!wordData) return { title: "Word not found — Tip of Tongue" };

    return {
      title: `${wordData.word} — Tip of Tongue`,
      description: wordData.definition,
      openGraph: {
        title: `${wordData.word} | Tip of Tongue Reverse Dictionary`,
        description: wordData.definition,
        url: `https://tip-of-tongue.app/word/${wordData.word}`,
        type: "article",
      },
      twitter: {
        card: "summary",
        title: wordData.word,
        description: wordData.definition,
      },
    };
  } catch {
    return { title: "Tip of Tongue" };
  }
}

export default async function WordPage({ params }: PageProps) {
  const wordData = await getWordData(params.word);
  if (!wordData) notFound();

  const { userId } = auth();
  let isSaved = false;

  if (userId) {
    const saved = await prisma.savedWord.findUnique({
      where: { userId_wordId: { userId, wordId: wordData.id } },
    });
    isSaved = !!saved;
  }

  return (
    <div className="min-h-screen bg-white dark:bg-gray-950">
      {/* Nav */}
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

      <main className="max-w-3xl mx-auto px-6 py-12">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-5xl font-bold text-gray-900 dark:text-gray-50 mb-2">
                {wordData.word}
              </h1>
              <div className="flex items-center gap-3 text-sm text-gray-500 dark:text-gray-400">
                <span className="italic">{wordData.partOfSpeech}</span>
                <span>&bull;</span>
                <span className="font-mono">{wordData.pronunciation}</span>
                {wordData.domain && (
                  <>
                    <span>&bull;</span>
                    <span className="px-2 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-xs">
                      {wordData.domain}
                    </span>
                  </>
                )}
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-2 flex-wrap">
              {userId && (
                <SaveWordButton word={wordData.word} initialSaved={isSaved} />
              )}
              <WordShareButtons word={wordData.word} definition={wordData.definition} />
            </div>
          </div>

          <div className="mt-4 h-1 w-24 bg-gradient-to-r from-blue-500 to-purple-500 rounded-full" />
        </div>

        {/* Definition */}
        <section className="mb-8">
          <h2 className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-3">
            Definition
          </h2>
          <p className="text-xl text-gray-800 dark:text-gray-200 leading-relaxed">
            {wordData.definition}
          </p>
        </section>

        {/* Etymology */}
        {wordData.etymology && (
          <section className="mb-8 p-4 bg-amber-50 dark:bg-amber-900/10 border border-amber-100 dark:border-amber-800/30 rounded-xl">
            <h2 className="text-xs font-semibold text-amber-600 dark:text-amber-500 uppercase tracking-widest mb-2">
              Etymology
            </h2>
            <p className="text-gray-700 dark:text-gray-300 leading-relaxed">
              {wordData.etymology}
            </p>
          </section>
        )}

        {/* Examples */}
        {wordData.examples.length > 0 && (
          <section className="mb-8">
            <h2 className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-3">
              Example Sentences
            </h2>
            <ul className="space-y-3">
              {wordData.examples.map((example, i) => (
                <li
                  key={i}
                  className="flex gap-3 text-gray-700 dark:text-gray-300 leading-relaxed"
                >
                  <span className="text-blue-400 dark:text-blue-500 font-mono text-sm mt-0.5 shrink-0">
                    {i + 1}.
                  </span>
                  <span>{example}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Synonyms / Related words */}
        {wordData.synonyms.length > 0 && (
          <section className="mb-8">
            <h2 className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-3">
              Related Words &amp; Synonyms
            </h2>
            <div className="flex flex-wrap gap-2">
              {wordData.synonyms.map((syn, i) => (
                <Link
                  key={i}
                  href={`/word/${encodeURIComponent(syn.toLowerCase())}`}
                  className="px-3 py-1.5 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-full text-sm text-gray-700 dark:text-gray-300 hover:border-blue-300 dark:hover:border-blue-600 hover:text-blue-700 dark:hover:text-blue-400 transition-colors"
                >
                  {syn}
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* CTA for non-logged-in users */}
        {!userId && (
          <div className="mt-12 p-6 bg-gradient-to-br from-blue-50 to-purple-50 dark:from-blue-900/20 dark:to-purple-900/20 border border-blue-100 dark:border-blue-800/30 rounded-2xl text-center">
            <p className="text-gray-700 dark:text-gray-300 mb-3">
              Sign in to save words to your personal collection.
            </p>
            <Link
              href="/sign-in"
              className="inline-block px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
            >
              Sign in free
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}
