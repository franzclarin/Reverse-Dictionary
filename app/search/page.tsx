import { Metadata } from "next";
import SearchResults from "@/components/SearchResults";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: { q?: string };
}

export function generateMetadata({ searchParams }: PageProps): Metadata {
  const query = searchParams.q?.trim();
  return {
    title: query ? `${query} — Reverse Dictionary` : "Search — Reverse Dictionary",
  };
}

export default function SearchPage({ searchParams }: PageProps) {
  const query = searchParams.q?.trim() ?? "";
  // Keyed on the query so a new search starts a fresh page rather than
  // inheriting the last one's state — notably how many results were asked for,
  // which otherwise carried over from "load more" and made the next search
  // request the old count first and the right one immediately after.
  return <SearchResults key={query} query={query} />;
}
