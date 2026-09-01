"use client";

import { useRouter } from "next/navigation";
import SearchInput from "@/components/SearchInput";
import { useLoading } from "@/context/LoadingContext";

export default function Home() {
  const router = useRouter();
  const { isLoading } = useLoading();

  // Just navigate; the results page does the actual searching. That way a
  // query typed here and one retyped there follow the same single path.
  const handleSearch = (description: string) => {
    router.push(`/search?q=${encodeURIComponent(description)}`);
  };

  return (
    <main
      className="flex flex-col items-center px-6 min-h-screen"
      style={{ background: "var(--rd-paper)" }}
    >
      <div className="w-full max-w-[640px] pt-20 md:pt-[22vh] flex flex-col items-center gap-8">
        {/* Wordmark */}
        <div className="flex flex-col items-center gap-3 text-center">
          <h1
            className="font-serif leading-none flex items-center gap-3"
            style={{
              fontSize: "clamp(2.75rem,6vw,4rem)",
              fontWeight: 400,
              color: "var(--rd-ink)",
            }}
          >
            <span
              aria-hidden="true"
              className="rd-stamp-in"
              style={{ color: "var(--rd-accent)", animationDelay: "80ms" }}
            >
              ¶
            </span>
            <span className="rd-fade-in-up" style={{ animationDelay: "140ms" }}>
              Reverse Dictionary
            </span>
          </h1>
          <div className="rd-fade-in-up flex flex-col items-center gap-2" style={{ animationDelay: "360ms" }}>
            <p
              className="font-mono text-xs uppercase tracking-widest"
              style={{ color: "var(--rd-ink-muted)" }}
            >
              Describe it. Find the word.
            </p>
            <span
              className="rd-underline-draw"
              aria-hidden="true"
              style={{
                width: "56px",
                height: "1.5px",
                background: "var(--rd-accent)",
                animationDelay: "540ms",
              }}
            />
          </div>
        </div>

        {/* Search bar */}
        <div className="rd-fade-in-up w-full" style={{ animationDelay: "480ms" }}>
          <SearchInput onSearch={handleSearch} isLoading={isLoading} variant="landing" />
        </div>
      </div>
    </main>
  );
}
