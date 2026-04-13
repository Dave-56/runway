import {
  getPlaidConnection,
  getUser,
  upsertObligation,
  upsertAllocation,
} from "@/lib/db/queries";
import { plaidClient } from "@/lib/plaid/client";
import { getRecurringCharges } from "@/lib/plaid/recurring";
import { decrypt } from "@/lib/utils/crypto";
import { normalizeToMonthly } from "@/lib/utils/money";
import { NextResponse } from "next/server";

/**
 * One-time utility route to backfill obligations from an existing Plaid connection.
 * Hit GET /api/plaid/sync-obligations?chat_id=<telegram_chat_id>
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const chatId = searchParams.get("chat_id");

  if (!chatId) {
    return NextResponse.json({ error: "chat_id required" }, { status: 400 });
  }

  const user = await getUser(chatId);
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const conn = await getPlaidConnection(user.id);
  if (!conn) {
    return NextResponse.json({ error: "No Plaid connection" }, { status: 404 });
  }

  const accessToken = decrypt(conn.accessToken);

  // Get all account IDs
  const balanceResponse = await plaidClient.accountsBalanceGet({
    access_token: accessToken,
  });
  const allAccountIds = balanceResponse.data.accounts.map((a) => a.account_id);

  // Fetch recurring charges
  const { outflows, inflows } = await getRecurringCharges(conn.accessToken, allAccountIds);

  // Upsert into obligations table
  let obligationsTotal = 0;
  let count = 0;
  for (const charge of outflows) {
    const monthlyAmount = normalizeToMonthly(charge.amount, charge.frequency);
    obligationsTotal += monthlyAmount;
    await upsertObligation({
      userId: user.id,
      plaidStreamId: charge.streamId,
      merchantName: charge.merchantName,
      amount: monthlyAmount,
      frequency: charge.frequency,
      nextExpectedDate: charge.nextExpectedDate,
      category: "other",
      isSubscription: charge.isSubscription,
      status: "active",
    });
    count++;
  }

  // Compute monthly income from recurring inflows and store
  const monthlyIncome = inflows.reduce(
    (sum, i) => sum + normalizeToMonthly(i.amount, i.frequency),
    0,
  );

  if (monthlyIncome > 0) {
    await upsertAllocation({
      userId: user.id,
      monthlyIncome: Math.round(monthlyIncome * 100) / 100,
      obligationsTotal: Math.round(obligationsTotal * 100) / 100,
      gap: Math.round((monthlyIncome - obligationsTotal) * 100) / 100,
    });
  }

  return NextResponse.json({
    success: true,
    obligations_synced: count,
    monthly_income: Math.round(monthlyIncome * 100) / 100,
    obligations_total: Math.round(obligationsTotal * 100) / 100,
    gap: Math.round((monthlyIncome - obligationsTotal) * 100) / 100,
  });
}
