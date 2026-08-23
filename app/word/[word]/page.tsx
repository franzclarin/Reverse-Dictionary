import { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import WordLink from "@/components/WordLink";
import { getWordData, getRelatedWords } from "@/lib/wordData";
import { prisma } from "@/lib/prisma";
import WordShareButtons from "@/components/WordShareButtons";
import SaveWordButton from "@/components/SaveWordButton";

export const dynamic = "force-dynamic";

interface PageProps {
  params: { word: string };
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  try {
    const wordData = await getWordData(params.word);
    if (!wordData) return { title: "Word not found — Reverse Dictionary" };

    const description =
      wordData.definition || `Words semantically closest to “${wordData.word}”.`;

    return {
      title: `${wordData.word} — Reverse Dictionary`,
      description,
      openGraph: {
        title: `${wordData.word} | Reverse Dictionary`,
        description,
        type: "article",
      },
      twitter: {
        card: "summary",
        title: wordData.word,
        description,
      },
    };
  } catch {
    return { title: "Reverse Dictionary" };
  }
}

export default async function WordPage({ params }: PageProps) {
  const wordData = await getWordData(params.word);
  if (!wordData) notFound();

  const related = await getRelatedWords(wordData.word);

  const { userId } = auth();
  let isSaved = false;

  if (userId) {
    const saved = await prisma.savedWord.findUnique({
      where: { userId_wordId: { userId, wordId: wordData.id } },
    });
    isSaved = !!saved;
  }

  return (
    <main className="min-h-screen" style={{ background: "var(--gs-bg)" }}>
      <div className="max-w-3xl mx-auto px-6 py-12">
        {/* Word header */}
        <div className="mb-8">
          <div className="flex items-start justify-between gap-4 flex-wrap mb-5">
            <div>
              <h1
                className="font-google leading-none mb-4"
                style={{
                  fontSize: "clamp(2.5rem,7vw,3.5rem)",
                  fontWeight: 400,
                  color: "var(--gs-text-primary)",
                }}
              >
                {wordData.word}
              </h1>
              <div className="flex items-center gap-3 flex-wrap">
                {wordData.partOfSpeech && (
                  <span
                    className="font-google text-xs px-2.5 py-1 rounded"
                    style={{ background: "var(--gs-hover-bg)", color: "var(--gs-text-muted)" }}
                  >
                    {wordData.partOfSpeech}
                  </span>
                )}
                {wordData.pronunciation && (
                  <span
                    className="font-google text-sm"
                    style={{ color: "var(--gs-text-secondary)" }}
                  >
                    {wordData.pronunciation}
                  </span>
                )}
                {wordData.domain && (
                  <span
                    className="font-google text-xs px-2.5 py-1 rounded"
                    style={{ color: "var(--gs-text-secondary)", border: "1px solid var(--gs-border)" }}
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

          <hr style={{ borderColor: "var(--gs-border)" }} />
        </div>

        {/* Definition — only words profiled before the generative API was
            removed have one. The embedding model cannot write prose. */}
        <section className="mb-10">
          {wordData.definition ? (
            <p
              className="font-google"
              style={{ fontSize: "18px", lineHeight: 1.6, color: "var(--gs-text-gloss)" }}
            >
              {wordData.definition}
            </p>
          ) : (
            <p className="font-google" style={{ lineHeight: 1.6, color: "var(--gs-text-muted)" }}>
              No written definition on file. This word is placed by its position in
              the model&apos;s semantic space — see the closest words below.
            </p>
          )}
        </section>

        <hr style={{ borderColor: "var(--gs-border)", marginBottom: "2.5rem" }} />

        {/* Etymology */}
        {wordData.etymology && (
          <section className="mb-10">
            <p
              className="font-google text-xs uppercase tracking-widest mb-4"
              style={{ color: "var(--gs-text-muted)" }}
            >
              Etymology
            </p>
            <p className="font-google leading-relaxed" style={{ color: "var(--gs-text-secondary)" }}>
              {wordData.etymology}
            </p>
          </section>
        )}

        {/* Examples */}
        {wordData.examples.length > 0 && (
          <section className="mb-10">
            <p
              className="font-google text-xs uppercase tracking-widest mb-4"
              style={{ color: "var(--gs-text-muted)" }}
            >
              Examples
            </p>
            <ul className="space-y-3">
              {wordData.examples.map((example, i) => (
                <li
                  key={i}
                  className="font-google flex gap-3 leading-relaxed"
                  style={{ color: "var(--gs-text-secondary)" }}
                >
                  <span
                    className="text-xs mt-1 shrink-0"
                    style={{ color: "var(--gs-accent)" }}
                  >
                    ·
                  </span>
                  <span>{example}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Nearest neighbours in embedding space — the model's own answer for
            "what is this word like?", with cosine similarity shown. */}
        {related.length > 0 && (
          <section className="mb-10">
            <p
              className="font-google text-xs uppercase tracking-widest mb-2"
              style={{ color: "var(--gs-text-muted)" }}
            >
              Closest Words
            </p>
            <p className="font-google text-sm mb-4" style={{ color: "var(--gs-text-secondary)" }}>
              Ranked by cosine similarity to {wordData.word} in the model&apos;s
              384-dimensional space.
            </p>
            <div className="flex flex-wrap gap-2">
              {related.map((r) => (
                <WordLink
                  key={r.word}
                  word={r.word}
                  className="font-google px-3 py-1.5 text-xs rounded-full transition-colors flex items-center gap-2 hover:bg-[var(--gs-hover-bg)]"
                  style={{ color: "var(--gs-text-secondary)", border: "1px solid var(--gs-border)" }}
                >
                  <span>{r.word}</span>
                  <span style={{ color: "var(--gs-accent)" }}>{r.similarity.toFixed(2)}</span>
                </WordLink>
              ))}
            </div>
          </section>
        )}

        <hr style={{ borderColor: "var(--gs-border)", marginBottom: "2rem" }} />

        {/* Sign-in CTA for guests */}
        {!userId && (
          <div
            className="p-6 rounded-lg text-center"
            style={{ border: "1px solid var(--gs-border)", background: "var(--gs-hover-bg)" }}
          >
            <p className="font-google mb-4" style={{ color: "var(--gs-text-secondary)" }}>
              Sign in to save words to your personal collection.
            </p>
            <Link
              href="/sign-in"
              className="font-google inline-block px-5 py-2 text-sm rounded transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              style={{ background: "var(--gs-accent)", color: "#ffffff", outlineColor: "var(--gs-accent)" }}
            >
              Sign in free →
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
