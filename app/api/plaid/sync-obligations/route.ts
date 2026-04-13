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
import {
  computeGap,
  roundMoney,
  sumMoney,
} from "@/lib/harness/calculations";

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
  const monthlyOutflowAmounts: number[] = [];
  let count = 0;
  for (const charge of outflows) {
    const monthlyAmount = normalizeToMonthly(charge.amount, charge.frequency);
    monthlyOutflowAmounts.push(monthlyAmount);
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
  const obligationsTotal = sumMoney(monthlyOutflowAmounts);

  // Compute monthly income from recurring inflows and store
  const monthlyIncome = sumMoney(
    inflows.map((inflow) =>
      normalizeToMonthly(inflow.amount, inflow.frequency),
    ),
  );
  const gap = computeGap(monthlyIncome, obligationsTotal);

  if (monthlyIncome > 0) {
    await upsertAllocation({
      userId: user.id,
      monthlyIncome: roundMoney(monthlyIncome),
      obligationsTotal: roundMoney(obligationsTotal),
      gap,
    });
  }

  return NextResponse.json({
    success: true,
    obligations_synced: count,
    monthly_income: roundMoney(monthlyIncome),
    obligations_total: roundMoney(obligationsTotal),
    gap,
  });
}
