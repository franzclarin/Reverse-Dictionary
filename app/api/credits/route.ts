import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getCredits, awardCredits } from "@/lib/credits";

export const dynamic = "force-dynamic";

export async function GET() {
  const { userId } = auth();
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const data = await getCredits(userId);
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const { userId } = auth();
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { amount, reason } = await req.json();
  if (typeof amount !== "number" || amount <= 0)
    return NextResponse.json({ error: "Invalid amount" }, { status: 400 });

  const credits = await awardCredits(userId, amount);
  return NextResponse.json({ credits, awarded: amount, reason });
}
