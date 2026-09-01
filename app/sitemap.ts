import { MetadataRoute } from "next";
import { prisma } from "@/lib/prisma";

/** The site's real address, which every link in the sitemap is built from. */
// Search engines ignore a sitemap that points somewhere else, so this must
// match the domain the site is actually served from.
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
    // The database may be unreachable during a build; list the fixed pages only.
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
