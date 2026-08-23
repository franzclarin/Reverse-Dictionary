"use client";

import { useRouter } from "next/navigation";
import SearchInput from "@/components/SearchInput";
import { useLoading } from "@/context/LoadingContext";

export default function Home() {
  const router = useRouter();
  const { isLoading } = useLoading();

  // No fetch here — the results page owns the /api/lookup call (and its
  // errors, rate limiting, and timing display) so a query typed on the
  // landing page and one re-run from the results page's own search bar go
  // through exactly one code path.
  const handleSearch = (description: string) => {
    router.push(`/search?q=${encodeURIComponent(description)}`);
  };

  return (
    <main
      className="flex flex-col items-center px-6 min-h-screen"
      style={{ background: "var(--gs-bg)" }}
    >
      <div className="w-full max-w-[584px] pt-16 md:pt-[25vh] flex flex-col items-center gap-8">
        {/* Wordmark */}
        <h1
          className="font-google leading-none text-center"
          style={{
            fontSize: "clamp(2.75rem,6vw,4rem)",
            fontWeight: 400,
            color: "var(--gs-text-primary)",
          }}
        >
          Reverse Dictionary
        </h1>

        {/* Search bar */}
        <SearchInput onSearch={handleSearch} isLoading={isLoading} variant="landing" />

        {/* Ghost action buttons */}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            form="search-form-landing"
            disabled={isLoading}
            className="font-google text-sm px-5 py-2.5 rounded transition-colors border border-transparent hover:border-[var(--gs-border)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
            style={{
              background: "var(--gs-hover-bg)",
              color: "var(--gs-text-secondary)",
              outlineColor: "var(--gs-accent)",
            }}
          >
            Search
          </button>
        </div>
      </div>
    </main>
  );
}
