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
    <main className="min-h-screen" style={{ background: "var(--rd-paper)" }}>
      <div className="max-w-3xl mx-auto px-6 py-12">
        {/* Word header */}
        <div className="mb-8">
          <div className="flex items-start justify-between gap-4 flex-wrap mb-5">
            <div>
              <h1
                className="font-serif leading-none mb-4"
                style={{
                  fontSize: "clamp(2.5rem,7vw,3.5rem)",
                  fontWeight: 400,
                  color: "var(--rd-ink)",
                }}
              >
                {wordData.word}
              </h1>
              <div className="flex items-center gap-3 flex-wrap">
                {wordData.partOfSpeech && (
                  <span
                    className="font-mono text-xs uppercase tracking-wide px-2.5 py-1 rounded"
                    style={{ background: "var(--rd-hover)", color: "var(--rd-ink-muted)" }}
                  >
                    {wordData.partOfSpeech}
                  </span>
                )}
                {wordData.pronunciation && (
                  <span
                    className="font-mono text-sm"
                    style={{ color: "var(--rd-ink-secondary)" }}
                  >
                    {wordData.pronunciation}
                  </span>
                )}
                {wordData.domain && (
                  <span
                    className="font-mono text-xs uppercase tracking-wide px-2.5 py-1 rounded"
                    style={{ color: "var(--rd-ink-secondary)", border: "1px solid var(--rd-border)" }}
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

          <hr style={{ borderColor: "var(--rd-border)" }} />
        </div>

        {/* Definition — only words profiled before the generative API was
            removed have one. The embedding model cannot write prose. */}
        <section className="mb-10">
          {wordData.definition ? (
            <p
              className="font-serif"
              style={{ fontSize: "20px", lineHeight: 1.6, color: "var(--rd-ink-gloss)" }}
            >
              {wordData.definition}
            </p>
          ) : (
            <p className="font-sans" style={{ lineHeight: 1.6, color: "var(--rd-ink-muted)" }}>
              No written definition on file. This word is placed by its position in
              the model&apos;s semantic space — see the closest words below.
            </p>
          )}
        </section>

        <hr style={{ borderColor: "var(--rd-border)", marginBottom: "2.5rem" }} />

        {/* Etymology */}
        {wordData.etymology && (
          <section className="mb-10">
            <p
              className="font-mono text-xs uppercase tracking-widest mb-4"
              style={{ color: "var(--rd-ink-muted)" }}
            >
              Etymology
            </p>
            <p className="font-sans leading-relaxed" style={{ color: "var(--rd-ink-secondary)" }}>
              {wordData.etymology}
            </p>
          </section>
        )}

        {/* Examples */}
        {wordData.examples.length > 0 && (
          <section className="mb-10">
            <p
              className="font-mono text-xs uppercase tracking-widest mb-4"
              style={{ color: "var(--rd-ink-muted)" }}
            >
              Examples
            </p>
            <ul className="space-y-3">
              {wordData.examples.map((example, i) => (
                <li
                  key={i}
                  className="font-sans flex gap-3 leading-relaxed"
                  style={{ color: "var(--rd-ink-secondary)" }}
                >
                  <span
                    className="text-xs mt-1 shrink-0"
                    style={{ color: "var(--rd-accent)" }}
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
              className="font-mono text-xs uppercase tracking-widest mb-2"
              style={{ color: "var(--rd-ink-muted)" }}
            >
              Closest Words
            </p>
            <p className="font-sans text-sm mb-4" style={{ color: "var(--rd-ink-secondary)" }}>
              Ranked by cosine similarity to {wordData.word} in the model&apos;s
              384-dimensional space.
            </p>
            <div className="flex flex-wrap gap-2">
              {related.map((r) => (
                <WordLink
                  key={r.word}
                  word={r.word}
                  className="font-sans px-3 py-1.5 text-sm rounded-full transition-colors flex items-center gap-2 hover:bg-[var(--rd-hover)]"
                  style={{ color: "var(--rd-ink-secondary)", border: "1px solid var(--rd-border)" }}
                >
                  <span>{r.word}</span>
                  <span className="font-mono text-xs" style={{ color: "var(--rd-accent)" }}>
                    {(r.similarity * 100).toFixed(0)}%
                  </span>
                </WordLink>
              ))}
            </div>
          </section>
        )}

        <hr style={{ borderColor: "var(--rd-border)", marginBottom: "2rem" }} />

        {/* Sign-in CTA for guests */}
        {!userId && (
          <div
            className="p-6 rounded-lg text-center"
            style={{ border: "1px solid var(--rd-border)", background: "var(--rd-hover)" }}
          >
            <p className="font-sans mb-4" style={{ color: "var(--rd-ink-secondary)" }}>
              Sign in to save words to your personal collection.
            </p>
            <Link
              href="/sign-in"
              className="font-sans inline-block px-5 py-2 text-sm font-medium rounded-md transition-colors hover:bg-[var(--rd-accent-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              style={{ background: "var(--rd-accent)", color: "#ffffff", outlineColor: "var(--rd-accent)" }}
            >
              Sign in free →
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
