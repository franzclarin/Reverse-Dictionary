import { NextResponse } from "next/server";
import { clerkClient, auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const { userId: currentUserId } = auth();

  const top = await prisma.user.findMany({
    orderBy: { credits: "desc" },
    take: 10,
    select: { id: true, credits: true },
  });

  const entries = await Promise.all(
    top.map(async (u: { id: string; credits: number }, i: number) => {
      let name = "Anonymous";
      try {
        const clerkUser = await clerkClient.users.getUser(u.id);
        const fullName = [clerkUser.firstName, clerkUser.lastName]
          .filter(Boolean)
          .join(" ");
        name = clerkUser.username ?? (fullName || "Anonymous");
      } catch {}
      return {
        rank: i + 1,
        name,
        credits: u.credits,
        isYou: u.id === currentUserId,
      };
    })
  );

  return NextResponse.json({ leaderboard: entries });
}
