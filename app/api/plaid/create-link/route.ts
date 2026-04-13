import { plaidClient } from "@/lib/plaid/client";
import { CountryCode, Products } from "plaid";

export async function POST(request: Request) {
  try {
    const { user_id } = await request.json();

    if (!user_id) {
      return Response.json({ error: "user_id is required" }, { status: 400 });
    }

    const response = await plaidClient.linkTokenCreate({
      client_name: "Clearline",
      language: "en",
      country_codes: [CountryCode.Us],
      user: {
        client_user_id: String(user_id),
      },
      products: [Products.Auth, Products.Transactions],
      required_if_supported_products: [Products.Liabilities],
    });

    return Response.json({ link_token: response.data.link_token });
  } catch (error) {
    console.error("Plaid link token creation failed:", error);
    return Response.json(
      { error: "Failed to create link token" },
      { status: 500 },
    );
  }
}
