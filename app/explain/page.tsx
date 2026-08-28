import type { Metadata } from "next";
import ExplainClient from "@/components/explain/ExplainClient";

export const metadata: Metadata = {
  title: "How the search works · Reverse Dictionary",
  description:
    "Type a description and watch the retrieval pipeline run: WordPiece tokens, one 384-dimensional vector, and the nearest word senses in the live index — with every approximation labelled.",
};

/**
 * RD-18's explainer.
 *
 * A server shell around one client component, the shape `app/search/page.tsx`
 * already uses. Nothing here loads the model: the page renders from the
 * committed snapshot under `public/viz/` and gets its numbers from
 * `/api/lookup`, so this route must NOT be given an
 * `outputFileTracingIncludes` entry for `models/**`.
 */
export default function ExplainPage() {
  return <ExplainClient />;
}
