import { eq, and, sum, desc, gte, ilike } from "drizzle-orm";
import { db } from "./index";
import {
  user,
  plaidConnection,
  obligation,
  allocation,
  debt,
  debtSnapshot,
  checkinLog,
  conversationMemory,
} from "./schema";

// ── User ───────────────────────────────────────────────────────────────

export async function getUser(chatId: string) {
  return db.query.user.findFirst({
    where: eq(user.telegramChatId, chatId),
  });
}

export async function getUserById(id: number) {
  return db.query.user.findFirst({
    where: eq(user.id, id),
  });
}

export async function createUser(chatId: string) {
  const [newUser] = await db.insert(user).values({ telegramChatId: chatId }).returning();
  return newUser;
}

export async function updateUser(
  id: number,
  data: Partial<typeof user.$inferInsert>,
) {
  const [updated] = await db.update(user).set(data).where(eq(user.id, id)).returning();
  return updated;
}

export async function getActiveUsers() {
  return db.query.user.findMany({
    where: eq(user.active, true),
  });
}

// ── Plaid Connection ───────────────────────────────────────────────────

export async function getPlaidConnection(userId: number) {
  return db.query.plaidConnection.findFirst({
    where: eq(plaidConnection.userId, userId),
  });
}

export async function createPlaidConnection(
  data: typeof plaidConnection.$inferInsert,
) {
  const [conn] = await db.insert(plaidConnection).values(data).returning();
  return conn;
}

export async function updateCursor(connectionId: number, cursor: string) {
  const [updated] = await db
    .update(plaidConnection)
    .set({ cursor })
    .where(eq(plaidConnection.id, connectionId))
    .returning();
  return updated;
}

// ── Obligations ────────────────────────────────────────────────────────

export async function getObligations(userId: number) {
  return db.query.obligation.findMany({
    where: eq(obligation.userId, userId),
  });
}

export async function getActiveObligations(userId: number) {
  return db.query.obligation.findMany({
    where: and(
      eq(obligation.userId, userId),
      eq(obligation.status, "active"),
    ),
  });
}

export async function getSubscriptions(userId: number) {
  return db.query.obligation.findMany({
    where: and(
      eq(obligation.userId, userId),
      eq(obligation.isSubscription, true),
    ),
  });
}

export async function upsertObligation(
  data: typeof obligation.$inferInsert,
) {
  if (data.plaidStreamId) {
    const existing = await db.query.obligation.findFirst({
      where: and(
        eq(obligation.userId, data.userId),
        eq(obligation.plaidStreamId, data.plaidStreamId),
      ),
    });
    if (existing) {
      const [updated] = await db
        .update(obligation)
        .set({
          merchantName: data.merchantName,
          amount: data.amount,
          frequency: data.frequency,
          nextExpectedDate: data.nextExpectedDate,
          category: data.category,
          isSubscription: data.isSubscription,
          status: data.status,
        })
        .where(eq(obligation.id, existing.id))
        .returning();
      return updated;
    }
  }
  const [result] = await db.insert(obligation).values(data).returning();
  return result;
}

export async function flagObligationDead(id: number) {
  const [updated] = await db
    .update(obligation)
    .set({ status: "dead" })
    .where(eq(obligation.id, id))
    .returning();
  return updated;
}

export async function getObligationsTotal(userId: number) {
  const [result] = await db
    .select({ total: sum(obligation.amount) })
    .from(obligation)
    .where(
      and(eq(obligation.userId, userId), eq(obligation.status, "active")),
    );
  return Number(result?.total ?? 0);
}

// ── Allocation ─────────────────────────────────────────────────────────

export async function getAllocation(userId: number) {
  return db.query.allocation.findFirst({
    where: eq(allocation.userId, userId),
  });
}

export async function upsertAllocation(
  data: typeof allocation.$inferInsert,
) {
  const existing = await getAllocation(data.userId);
  if (existing) {
    const [updated] = await db
      .update(allocation)
      .set(data)
      .where(eq(allocation.id, existing.id))
      .returning();
    return updated;
  }
  const [created] = await db.insert(allocation).values(data).returning();
  return created;
}

// ── Debt ───────────────────────────────────────────────────────────────

export async function getDebts(userId: number) {
  return db.query.debt.findMany({
    where: eq(debt.userId, userId),
    orderBy: debt.priorityOrder,
  });
}

export async function upsertDebt(data: typeof debt.$inferInsert) {
  if (data.plaidAccountId) {
    const existing = await db.query.debt.findFirst({
      where: and(
        eq(debt.userId, data.userId),
        eq(debt.plaidAccountId, data.plaidAccountId),
      ),
    });
    if (existing) {
      const [updated] = await db
        .update(debt)
        .set(data)
        .where(eq(debt.id, existing.id))
        .returning();
      return updated;
    }
  }
  const [created] = await db.insert(debt).values(data).returning();
  return created;
}

export async function createDebtSnapshot(debtId: number, balance: number) {
  const [snapshot] = await db
    .insert(debtSnapshot)
    .values({ debtId, balance })
    .returning();
  return snapshot;
}

export async function getDebtSnapshots(debtId: number, since?: Date) {
  if (since) {
    return db.query.debtSnapshot.findMany({
      where: and(
        eq(debtSnapshot.debtId, debtId),
        gte(debtSnapshot.recordedAt, since),
      ),
      orderBy: desc(debtSnapshot.recordedAt),
    });
  }
  return db.query.debtSnapshot.findMany({
    where: eq(debtSnapshot.debtId, debtId),
    orderBy: desc(debtSnapshot.recordedAt),
  });
}

// ── Check-ins ──────────────────────────────────────────────────────────

export async function getRecentCheckins(userId: number, limit: number) {
  return db.query.checkinLog.findMany({
    where: eq(checkinLog.userId, userId),
    orderBy: desc(checkinLog.sentAt),
    limit,
  });
}

export async function createCheckinLog(
  data: typeof checkinLog.$inferInsert,
) {
  const [log] = await db.insert(checkinLog).values(data).returning();
  return log;
}

export async function markCheckinReplied(telegramMessageId: number) {
  const [updated] = await db
    .update(checkinLog)
    .set({ userReplied: true })
    .where(eq(checkinLog.telegramMessageId, telegramMessageId))
    .returning();
  return updated;
}

export async function getCheckinCountThisWeek(
  userId: number,
  weekStart: Date,
) {
  const results = await db.query.checkinLog.findMany({
    where: and(
      eq(checkinLog.userId, userId),
      gte(checkinLog.sentAt, weekStart),
    ),
  });
  return results.length;
}

// ── Conversation Memory ────────────────────────────────────────────────

export async function saveMemory(userId: number, key: string, value: string) {
  const existing = await db.query.conversationMemory.findFirst({
    where: and(
      eq(conversationMemory.userId, userId),
      eq(conversationMemory.key, key),
    ),
  });
  if (existing) {
    const [updated] = await db
      .update(conversationMemory)
      .set({ value })
      .where(eq(conversationMemory.id, existing.id))
      .returning();
    return updated;
  }
  const [created] = await db
    .insert(conversationMemory)
    .values({ userId, key, value })
    .returning();
  return created;
}

export async function recallMemory(userId: number, key: string) {
  return db.query.conversationMemory.findFirst({
    where: and(
      eq(conversationMemory.userId, userId),
      eq(conversationMemory.key, key),
    ),
  });
}

export async function recallMemoryByPattern(userId: number, keyPattern: string) {
  return db.query.conversationMemory.findMany({
    where: and(
      eq(conversationMemory.userId, userId),
      ilike(conversationMemory.key, keyPattern),
    ),
  });
}
