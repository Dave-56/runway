import { plaidClient } from "@/lib/plaid/client";
import { encrypt } from "@/lib/utils/crypto";
import { createPlaidConnection } from "@/lib/db/queries";

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
      userId: user_id,
      accessToken: encryptedToken,
      itemId: item_id,
    });

    // TODO: Send Telegram message once Telegram client (Task #6) is built
    // sendMessage(chatId, "Got your accounts linked. Give me a minute to pull your numbers.")

    return Response.json({ success: true });
  } catch (error) {
    console.error("Plaid token exchange failed:", error);
    return Response.json(
      { error: "Failed to exchange token" },
      { status: 500 },
    );
  }
}
