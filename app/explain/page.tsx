import type { Metadata } from "next";
import ExplainClient from "@/components/explain/ExplainClient";

export const metadata: Metadata = {
  title: "How the search works · Reverse Dictionary",
  description:
    "Type a description and watch the retrieval pipeline run: WordPiece tokens, one 384-dimensional vector, and the nearest word senses in the live index — with every approximation labelled.",
};

/** The page that explains how search works. */
// Nothing here loads the model — it draws from saved files and calls the API —
// so never add this route to the model-bundling list in next.config.js.
export default function ExplainPage() {
  return <ExplainClient />;
}
