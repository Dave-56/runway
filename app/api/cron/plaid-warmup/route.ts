import { NextRequest, NextResponse } from "next/server";
import {
  getActiveUsers,
  getPlaidConnection,
  getActiveObligations,
} from "@/lib/db/queries";
import { syncRecurringOnboardingData } from "@/lib/plaid/onboarding-sync";
import { processMessage } from "@/lib/agent/core";
import { BANK_LINKED_SIGNAL } from "@/lib/agent/router";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const users = await getActiveUsers();
    let checked = 0;
    let ready = 0;
    let warming = 0;
    let skipped = 0;
    let failed = 0;

    for (const dbUser of users) {
      if (dbUser.phase !== "know_number") {
        skipped += 1;
        continue;
      }

      const plaidConn = await getPlaidConnection(dbUser.id);
      if (!plaidConn) {
        skipped += 1;
        continue;
      }

      const obligations = await getActiveObligations(dbUser.id);
      if (obligations.length > 0) {
        skipped += 1;
        continue;
      }

      checked += 1;

      try {
        const result = await syncRecurringOnboardingData(
          dbUser.id,
          plaidConn.accessToken,
        );

        if (result.status === "ready") {
          ready += 1;
          await processMessage(
            dbUser,
            BANK_LINKED_SIGNAL,
            undefined,
            { internalTrigger: true },
          );
        } else {
          warming += 1;
        }
      } catch (error) {
        failed += 1;
        console.error(
          `[cron/plaid-warmup] user ${dbUser.id} sync failed:`,
          error,
        );
      }
    }

    return NextResponse.json({
      ok: true,
      checked,
      ready,
      warming,
      skipped,
      failed,
    });
  } catch (error) {
    console.error("[cron/plaid-warmup] Error:", error);
    return NextResponse.json({ ok: true });
  }
}
