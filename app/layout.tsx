import type { Metadata } from "next";
import "./globals.css";
import { ClerkProvider } from "@clerk/nextjs";
import Navbar from "@/components/Navbar";

export const metadata: Metadata = {
  title: "Reverse Dictionary - Find Words from Descriptions",
  description:
    "Describe a concept and discover the exact word you're looking for. Powered by Claude AI.",
  keywords: ["reverse dictionary", "word finder", "vocabulary", "AI", "Claude"],
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
          <Navbar />
          <div className="flex-1">{children}</div>
          <footer
            className="py-5 text-center"
            style={{ borderTop: "1px solid var(--border)" }}
          >
            <p
              className="font-mono text-xs"
              style={{ color: "var(--text-secondary)" }}
            >
              © Reverse Dictionary
            </p>
          </footer>
        </body>
      </html>
    </ClerkProvider>
  );
}
