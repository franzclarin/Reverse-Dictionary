import { prisma } from "./prisma";

export async function getOrCreateUser(userId: string) {
  return prisma.user.upsert({
    where: { id: userId },
    create: { id: userId },
    update: {},
  });
}

export async function getCredits(userId: string): Promise<{ credits: number; streak: number }> {
  const user = await getOrCreateUser(userId);
  return { credits: user.credits, streak: user.streak };
}

export async function awardCredits(userId: string, amount: number): Promise<number> {
  const user = await prisma.user.upsert({
    where: { id: userId },
    create: { id: userId, credits: 100 + amount },
    update: { credits: { increment: amount } },
  });
  return user.credits;
}

// Settle a game: net outcome applied, bet already NOT deducted.
// winAmount = how many credits to give back (0 = full loss, bet = break even, bet*mult = win)
export async function settleGame(
  userId: string,
  game: string,
  bet: number,
  winAmount: number
): Promise<{ newBalance: number; isBankrupt: boolean }> {
  const netOutcome = winAmount - bet;
  const updated = await prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { id: userId },
      data: { credits: { increment: netOutcome } },
    });
    await tx.gameRound.create({
      data: { userId, game, bet, outcome: netOutcome },
    });
    return user;
  });

  if (updated.credits <= 0) {
    await prisma.user.update({ where: { id: userId }, data: { credits: 25 } });
    return { newBalance: 25, isBankrupt: true };
  }
  return { newBalance: updated.credits, isBankrupt: false };
}

// Award daily lookup credits. Records each lookup, awards on first of the day.
export async function awardDailyLookup(userId: string): Promise<number> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const todayLookup = await prisma.lookup.findFirst({
    where: { userId, createdAt: { gte: today } },
  });

  // Always record the lookup
  await prisma.lookup.create({ data: { userId } });

  if (todayLookup) return 0;

  // First lookup of the day — check yesterday for streak
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayLookup = await prisma.lookup.findFirst({
    where: { userId, createdAt: { gte: yesterday, lt: today } },
  });

  const user = await getOrCreateUser(userId);
  const newStreak = yesterdayLookup ? user.streak + 1 : 1;
  const streakBonus = Math.min(5 * newStreak, 50);
  const total = 10 + streakBonus;

  await prisma.user.update({
    where: { id: userId },
    data: { credits: { increment: total }, streak: newStreak, lastLogin: new Date() },
  });

  return total;
}

// Award +2 for saving a word
export async function awardWordSave(userId: string): Promise<void> {
  await prisma.user.upsert({
    where: { id: userId },
    create: { id: userId, credits: 102 },
    update: { credits: { increment: 2 } },
  });
}

// Award +3 for sharing
export async function awardWordShare(userId: string): Promise<void> {
  await prisma.user.upsert({
    where: { id: userId },
    create: { id: userId, credits: 103 },
    update: { credits: { increment: 3 } },
  });
}
