import { plaidClient } from "@/lib/plaid/client";
import { encrypt } from "@/lib/utils/crypto";
import {
  createPlaidConnection,
  getUserById,
} from "@/lib/db/queries";
import { processMessage } from "@/lib/agent/core";
import { BANK_LINKED_SIGNAL } from "@/lib/agent/router";
import { sendMessage } from "@/lib/telegram/client";
import { syncRecurringOnboardingData } from "@/lib/plaid/onboarding-sync";

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

    // Fetch recurring charges and populate obligations table.
    // PRODUCT_NOT_READY is expected immediately after link; treat it as warm-up, not failure.
    try {
      const dbUser = await getUserById(Number(user_id));
      if (!dbUser) {
        return Response.json({ success: true });
      }

      const syncResult = await syncRecurringOnboardingData(
        dbUser.id,
        encryptedToken,
      );

      if (syncResult.status === "ready") {
        await processMessage(
          dbUser,
          BANK_LINKED_SIGNAL,
          undefined,
          { internalTrigger: true },
        );
      } else {
        await sendMessage(
          dbUser.telegramChatId,
          "Accounts linked. I’m still pulling recurring charges from Plaid. This usually takes a minute or two. I’ll message you as soon as it’s ready.",
        );
      }
    } catch (err) {
      console.error("Failed to fetch recurring charges after linking:", err);
      const dbUser = await getUserById(Number(user_id));
      if (dbUser) {
        await sendMessage(
          dbUser.telegramChatId,
          "Accounts linked. I couldn’t pull recurring charges yet, but I’ll keep trying in the background and message you when they’re ready.",
        );
      }
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
