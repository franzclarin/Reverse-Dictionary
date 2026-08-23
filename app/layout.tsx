import type { Metadata } from "next";
import "./globals.css";
import { ClerkProvider } from "@clerk/nextjs";
import Navbar from "@/components/Navbar";
import { LoadingProvider } from "@/context/LoadingContext";

export const metadata: Metadata = {
  title: "Reverse Dictionary - Find Words from Descriptions",
  description:
    "Describe a concept and find the exact word. Semantic search over a 141,000-word vocabulary, powered by a fine-tuned sentence-embedding model.",
  keywords: [
    "reverse dictionary",
    "word finder",
    "vocabulary",
    "semantic search",
    "sentence embeddings",
    "find the word",
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body className="antialiased min-h-screen flex flex-col">
          <LoadingProvider>
            <Navbar />
            <div className="flex-1">{children}</div>
            <footer
              className="py-5 text-center"
              style={{ borderTop: "1px solid var(--gs-border)", background: "var(--gs-bg)" }}
            >
              <p className="font-google text-xs" style={{ color: "var(--gs-text-muted)" }}>
                © Reverse Dictionary ·{" "}
                <a
                  href="https://github.com/franzclarin/Reverse-Dictionary"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                  style={{ outlineColor: "var(--gs-accent)" }}
                >
                  GitHub
                </a>
              </p>
            </footer>
          </LoadingProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
