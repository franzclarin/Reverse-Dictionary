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
  return <SearchResults query={query} />;
}
