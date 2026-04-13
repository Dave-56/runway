import { plaidClient } from "@/lib/plaid/client";
import { encrypt } from "@/lib/utils/crypto";
import {
  createPlaidConnection,
  getPlaidConnection,
  getUserById,
  upsertObligation,
} from "@/lib/db/queries";
import { getRecurringCharges } from "@/lib/plaid/recurring";
import { getAccountBalances } from "@/lib/plaid/balances";
import { sendMessage } from "@/lib/telegram/client";
import { normalizeToMonthly } from "@/lib/utils/money";

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
      const balances = await getAccountBalances(encryptedToken);
      const accountIds = [
        ...balances.checking.map(() => ""),
      ];

      // Get all account IDs from Plaid for recurring transaction detection
      const balanceResponse = await plaidClient.accountsBalanceGet({
        access_token,
      });
      const allAccountIds = balanceResponse.data.accounts.map((a) => a.account_id);

      const { outflows } = await getRecurringCharges(encryptedToken, allAccountIds);

      // Upsert each recurring charge into the obligations table
      for (const charge of outflows) {
        await upsertObligation({
          userId: Number(user_id),
          plaidStreamId: charge.streamId,
          merchantName: charge.merchantName,
          amount: normalizeToMonthly(charge.amount, charge.frequency),
          frequency: charge.frequency,
          nextExpectedDate: charge.nextExpectedDate,
          category: "other",
          isSubscription: charge.isSubscription,
          status: "active",
        });
      }

      // Notify the user via Telegram
      const user = await getUserById(Number(user_id));
      if (user) {
        await sendMessage(
          user.telegramChatId,
          "Got your accounts linked. I've pulled your recurring charges. Say hi when you're ready to see the numbers.",
        );
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
