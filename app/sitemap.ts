import { MetadataRoute } from "next";
import { prisma } from "@/lib/prisma";

/**
 * Canonical origin for the absolute URLs a sitemap requires.
 *
 * Must match the domain the site is actually served from — crawlers treat a
 * sitemap pointing at another host as unverified and ignore it. Set
 * NEXT_PUBLIC_SITE_URL to override when the domain changes; the fallback is
 * the live production domain, not a preview URL.
 */
const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.reversedictionary.xyz"
).replace(/\/+$/, "");

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  let words: { word: string; createdAt: Date }[] = [];

  try {
    words = await prisma.word.findMany({
      select: { word: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
  } catch {
    // DB may not be available during build — return static routes only
  }

  const wordEntries: MetadataRoute.Sitemap = words.map((w) => ({
    url: `${SITE_URL}/word/${encodeURIComponent(w.word)}`,
    lastModified: w.createdAt,
    changeFrequency: "monthly",
    priority: 0.8,
  }));

  return [
    {
      url: SITE_URL,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 1,
    },
    ...wordEntries,
  ];
}
