import { createLinkToken } from "@/lib/plaid/client";

export async function POST(request: Request) {
  try {
    const { user_id } = await request.json();

    if (!user_id) {
      return Response.json({ error: "user_id is required" }, { status: 400 });
    }

    const link_token = await createLinkToken(Number(user_id));

    return Response.json({ link_token });
  } catch (error) {
    console.error("Plaid link token creation failed:", error);
    return Response.json(
      { error: "Failed to create link token" },
      { status: 500 },
    );
  }
}
