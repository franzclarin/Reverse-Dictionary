import type { Metadata } from "next";
import "./globals.css";
import { ClerkProvider } from "@clerk/nextjs";

export const metadata: Metadata = {
  title: "Reverse Dictionary - Find Words from Descriptions",
  description: "Describe a concept and discover the exact word you're looking for. Powered by Claude AI.",
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
        <body className="antialiased">
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
