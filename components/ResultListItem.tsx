import Link from "next/link";

interface ResultListItemProps {
  word: string;
  similarity: number;
  partOfSpeech?: string;
  /** Position in the list — drives the ~30ms fade-in-up stagger. */
  index?: number;
}

export default function ResultListItem({
  word,
  similarity,
  partOfSpeech,
  index = 0,
}: ResultListItemProps) {
  return (
    <li
      className="gs-fade-in-up py-3"
      style={{ animationDelay: `${index * 30}ms` }}
    >
      <Link
        href={`/word/${encodeURIComponent(word)}`}
        className="-mx-3 block rounded-lg px-3 py-2 transition-colors hover:bg-[var(--gs-hover-bg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{ outlineColor: "var(--gs-accent)" }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="font-google hover:underline"
            style={{ fontSize: "20px", fontWeight: 500, color: "var(--gs-accent)" }}
          >
            {word}
          </span>
          {partOfSpeech && (
            <span
              className="font-google shrink-0 rounded px-2 py-0.5"
              style={{
                fontSize: "12px",
                color: "var(--gs-text-muted)",
                background: "var(--gs-hover-bg)",
              }}
            >
              {partOfSpeech}
            </span>
          )}
        </div>
        <p
          className="font-google mt-1"
          style={{ fontSize: "14px", lineHeight: 1.58, color: "var(--gs-text-gloss)" }}
        >
          {similarity.toFixed(2)} match
        </p>
      </Link>
    </li>
  );
}
