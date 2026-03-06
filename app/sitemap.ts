import { MetadataRoute } from "next";
import { prisma } from "@/lib/prisma";

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
    url: `https://tip-of-tongue.app/word/${encodeURIComponent(w.word)}`,
    lastModified: w.createdAt,
    changeFrequency: "monthly",
    priority: 0.8,
  }));

  return [
    {
      url: "https://tip-of-tongue.app",
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 1,
    },
    ...wordEntries,
  ];
}
