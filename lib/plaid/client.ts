import { Configuration, PlaidApi, PlaidEnvironments, CountryCode, Products } from "plaid";

const configuration = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || "sandbox"],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
      "PLAID-SECRET": process.env.PLAID_SECRET,
    },
  },
});

export const plaidClient = new PlaidApi(configuration);

/**
 * Create a Plaid Link token for the given user.
 * Returns the link_token string to pass to the Plaid Link frontend.
 */
export async function createLinkToken(userId: number): Promise<string> {
  const response = await plaidClient.linkTokenCreate({
    client_name: "Clearline",
    language: "en",
    country_codes: [CountryCode.Us],
    user: {
      client_user_id: String(userId),
    },
    products: [Products.Auth, Products.Transactions],
    required_if_supported_products: [Products.Liabilities],
  });

  return response.data.link_token;
}
