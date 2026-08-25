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
      className="rd-fade-in-up py-3"
      style={{ animationDelay: `${index * 30}ms` }}
    >
      <Link
        href={`/word/${encodeURIComponent(word)}`}
        className="-mx-3 flex items-center justify-between gap-4 rounded-lg px-3 py-2.5 transition-colors hover:bg-[var(--rd-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{ outlineColor: "var(--rd-accent)" }}
      >
        <div className="flex flex-wrap items-baseline gap-2 min-w-0">
          <span
            className="font-serif truncate"
            style={{ fontSize: "22px", color: "var(--rd-ink)" }}
          >
            {word}
          </span>
          {partOfSpeech && (
            <span
              className="font-mono shrink-0 uppercase tracking-wide"
              style={{ fontSize: "11px", color: "var(--rd-ink-muted)" }}
            >
              {partOfSpeech}
            </span>
          )}
        </div>
        <span
          className="font-mono shrink-0 tabular-nums"
          style={{ fontSize: "13px", color: "var(--rd-accent)" }}
        >
          {(similarity * 100).toFixed(0)}%
        </span>
      </Link>
    </li>
  );
}
