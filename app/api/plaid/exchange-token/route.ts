import { plaidClient } from "@/lib/plaid/client";
import { encrypt } from "@/lib/utils/crypto";
import {
  createPlaidConnection,
  getUserById,
  upsertObligation,
} from "@/lib/db/queries";
import { getRecurringCharges } from "@/lib/plaid/recurring";
import { normalizeToMonthly } from "@/lib/utils/money";
import { processMessage } from "@/lib/agent/core";
import { BANK_LINKED_SIGNAL } from "@/lib/agent/router";

export async function POST(request: Request) {
  try {
    const { public_token, user_id } = await request.json();

    if (!public_token || !user_id) {
      return Response.json(
        { error: "public_token and user_id are required" },
        { status: 400 },
      );
    }

    const response = await plaidClient.itemPublicTokenExchange({
      public_token,
    });

    const { access_token, item_id } = response.data;

    const encryptedToken = encrypt(access_token);

    await createPlaidConnection({
      userId: Number(user_id),
      accessToken: encryptedToken,
      itemId: item_id,
    });

    // Fetch recurring charges and populate obligations table
    try {
      // Get all account IDs from Plaid for recurring transaction detection
      const balanceResponse = await plaidClient.accountsBalanceGet({
        access_token,
      });
      const allAccountIds = balanceResponse.data.accounts.map((a) => a.account_id);

      const { outflows } = await getRecurringCharges(encryptedToken, allAccountIds);

      // Upsert each recurring charge into the obligations table
      for (const charge of outflows) {
        const monthlyAmount = normalizeToMonthly(charge.amount, charge.frequency);
        await upsertObligation({
          userId: Number(user_id),
          plaidStreamId: charge.streamId,
          merchantName: charge.merchantName,
          amount: monthlyAmount,
          frequency: charge.frequency,
          nextExpectedDate: charge.nextExpectedDate,
          category: "other",
          isSubscription: charge.isSubscription,
          status: "active",
        });
      }

      // Trigger the agent to deliver Phase 1 immediately — no waiting
      const dbUser = await getUserById(Number(user_id));
      if (dbUser) {
        await processMessage(dbUser, BANK_LINKED_SIGNAL);
      }
    } catch (err) {
      console.error("Failed to fetch recurring charges after linking:", err);
    }

    return Response.json({ success: true });
  } catch (error) {
    console.error("Plaid token exchange failed:", error);
    return Response.json(
      { error: "Failed to exchange token" },
      { status: 500 },
    );
  }
}
