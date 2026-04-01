import { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { getWordData } from "@/lib/wordData";
import { prisma } from "@/lib/prisma";
import WordShareButtons from "@/components/WordShareButtons";
import SaveWordButton from "@/components/SaveWordButton";

export const dynamic = "force-dynamic";

interface PageProps {
  params: { word: string };
  searchParams: { alternatives?: string };
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  try {
    const wordData = await getWordData(params.word);
    if (!wordData) return { title: "Word not found — Reverse Dictionary" };

    return {
      title: `${wordData.word} — Reverse Dictionary`,
      description: wordData.definition,
      openGraph: {
        title: `${wordData.word} | Reverse Dictionary`,
        description: wordData.definition,
        type: "article",
      },
      twitter: {
        card: "summary",
        title: wordData.word,
        description: wordData.definition,
      },
    };
  } catch {
    return { title: "Reverse Dictionary" };
  }
}

export default async function WordPage({ params, searchParams }: PageProps) {
  const wordData = await getWordData(params.word);
  if (!wordData) notFound();

  const alternatives = searchParams.alternatives?.split(",").filter(Boolean) ?? [];

  const { userId } = auth();
  let isSaved = false;

  if (userId) {
    const saved = await prisma.savedWord.findUnique({
      where: { userId_wordId: { userId, wordId: wordData.id } },
    });
    isSaved = !!saved;
  }

  return (
    <main className="max-w-3xl mx-auto px-6 py-12">
      {/* Word header */}
      <div className="mb-8">
        <div className="flex items-start justify-between gap-4 flex-wrap mb-5">
          <div>
            <h1
              className="font-serif leading-none mb-4"
              style={{
                fontSize: "clamp(3rem,8vw,4.5rem)",
                color: "var(--text-primary)",
              }}
            >
              {wordData.word}
            </h1>
            <div className="flex items-center gap-3 flex-wrap">
              <span
                className="font-mono text-xs px-2.5 py-1 rounded"
                style={{
                  background: "var(--accent-gold-dim)",
                  color: "var(--accent-gold)",
                }}
              >
                {wordData.partOfSpeech}
              </span>
              <span
                className="font-mono text-sm"
                style={{ color: "var(--text-secondary)" }}
              >
                {wordData.pronunciation}
              </span>
              {wordData.domain && (
                <span
                  className="font-mono text-xs px-2.5 py-1 rounded"
                  style={{
                    color: "var(--text-secondary)",
                    border: "1px solid var(--border)",
                  }}
                >
                  {wordData.domain}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap mt-1">
            {userId && (
              <SaveWordButton word={wordData.word} initialSaved={isSaved} />
            )}
            <WordShareButtons
              word={wordData.word}
              definition={wordData.definition}
            />
          </div>
        </div>

        <hr style={{ borderColor: "var(--border)" }} />
      </div>

      {/* Definition */}
      <section className="mb-10">
        <p
          className="font-light text-xl leading-relaxed"
          style={{ color: "var(--text-primary)" }}
        >
          {wordData.definition}
        </p>
      </section>

      <hr style={{ borderColor: "var(--border)", marginBottom: "2.5rem" }} />

      {/* Etymology */}
      {wordData.etymology && (
        <section className="mb-10">
          <p
            className="font-mono text-[10px] uppercase tracking-widest mb-4"
            style={{ color: "var(--accent-gold)" }}
          >
            Etymology
          </p>
          <p
            className="leading-relaxed font-light"
            style={{ color: "var(--text-secondary)" }}
          >
            {wordData.etymology}
          </p>
        </section>
      )}

      {/* Examples */}
      {wordData.examples.length > 0 && (
        <section className="mb-10">
          <p
            className="font-mono text-[10px] uppercase tracking-widest mb-4"
            style={{ color: "var(--accent-gold)" }}
          >
            Examples
          </p>
          <ul className="space-y-3">
            {wordData.examples.map((example, i) => (
              <li
                key={i}
                className="flex gap-3 font-light italic leading-relaxed"
                style={{ color: "var(--text-secondary)" }}
              >
                <span
                  className="font-mono text-xs mt-0.5 shrink-0"
                  style={{ color: "var(--accent-gold)" }}
                >
                  ·
                </span>
                <span>{example}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Related words */}
      {wordData.synonyms.length > 0 && (
        <section className="mb-10">
          <p
            className="font-mono text-[10px] uppercase tracking-widest mb-4"
            style={{ color: "var(--accent-gold)" }}
          >
            Related Words
          </p>
          <div className="flex flex-wrap gap-2">
            {wordData.synonyms.map((syn, i) => (
              <Link
                key={i}
                href={`/word/${encodeURIComponent(syn.toLowerCase())}`}
                className="px-3 py-1.5 font-mono text-xs rounded-full transition-colors"
                style={{
                  color: "var(--text-secondary)",
                  border: "1px solid var(--border)",
                }}
              >
                {syn}
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Other results from search */}
      {alternatives.length > 0 && (
        <section className="mb-10">
          <p
            className="font-mono text-[10px] uppercase tracking-widest mb-4"
            style={{ color: "var(--accent-gold)" }}
          >
            See Other Results
          </p>
          <div className="flex flex-col gap-2">
            {alternatives.map((alt, i) => (
              <Link
                key={i}
                href={`/word/${encodeURIComponent(alt)}`}
                className="px-4 py-3 rounded-lg font-mono text-sm transition-opacity hover:opacity-80"
                style={{
                  color: "var(--text-primary)",
                  border: "1px solid var(--border)",
                }}
              >
                {alt} →
              </Link>
            ))}
          </div>
        </section>
      )}

      <hr style={{ borderColor: "var(--border)", marginBottom: "2rem" }} />

      {/* Sign-in CTA for guests */}
      {!userId && (
        <div
          className="p-6 rounded-lg text-center"
          style={{
            border: "1px solid rgba(201,168,76,0.2)",
            background: "var(--accent-gold-dim)",
          }}
        >
          <p
            className="font-light mb-4"
            style={{ color: "var(--text-secondary)" }}
          >
            Sign in to save words to your personal collection.
          </p>
          <Link
            href="/sign-in"
            className="inline-block px-5 py-2 font-mono text-sm rounded transition-opacity hover:opacity-90"
            style={{
              background: "var(--accent-gold)",
              color: "var(--bg)",
            }}
          >
            Sign in free →
          </Link>
        </div>
      )}
    </main>
  );
}
