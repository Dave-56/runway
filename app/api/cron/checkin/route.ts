import { NextRequest, NextResponse } from "next/server";
import {
  getActiveUsers,
  getPlaidConnection,
  getActiveObligations,
  getObligationsTotal,
  getAllocation,
  getDebts,
  getDebtSnapshots,
  createDebtSnapshot,
  getRecentCheckins,
  createCheckinLog,
  updateUser,
  updateCursor,
} from "@/lib/db/queries";
import { getAccountBalances } from "@/lib/plaid/balances";
import { syncTransactions } from "@/lib/plaid/transactions";
import {
  buildSpendingPaceNote,
  renderCheckinMessage,
  type CheckinDebtProgressItem,
  type CheckinUpcomingSubItem,
} from "@/lib/harness/messages";
import {
  sendFormattedMessage,
  sendMessageWithKeyboard,
} from "@/lib/telegram/client";
import { escapeMarkdownV2 } from "@/lib/telegram/format";
import { isCheckinWindow, daysUntil } from "@/lib/utils/dates";
import { computeFreeCashRemaining } from "@/lib/harness/calculations";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    // 1. Verify cron auth
    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    // 2. Load user (single-user app — get first active user)
    const users = await getActiveUsers();
    const theUser = users[0];
    if (!theUser || !theUser.active) {
      return NextResponse.json({ ok: true, skipped: "no_active_user" });
    }

    // 3. Check timezone: is it the right hour in the user's local time?
    const timezone = theUser.timezone ?? "America/New_York";
    const checkinHour = theUser.checkinHour ?? 10;
    if (!isCheckinWindow(timezone, checkinHour)) {
      return NextResponse.json({ ok: true, skipped: "not_checkin_window" });
    }

    // Also check it's the right day (checkinDay: 0 = Sunday)
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
    });
    const localDayName = formatter.format(now);
    const dayMap: Record<string, number> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };
    const localDayNumber = dayMap[localDayName] ?? 0;
    if (localDayNumber !== (theUser.checkinDay ?? 0)) {
      return NextResponse.json({ ok: true, skipped: "not_checkin_day" });
    }

    // 4. Check ignoredCheckins — if >= 3, agent is silent
    if (theUser.ignoredCheckins >= 3) {
      return NextResponse.json({ ok: true, skipped: "ignored_checkins_limit" });
    }

    // 5. Sync latest transactions from Plaid
    const plaidConn = await getPlaidConnection(theUser.id);
    if (!plaidConn) {
      return NextResponse.json({ ok: true, skipped: "no_plaid_connection" });
    }

    const syncResult = await syncTransactions(
      plaidConn.accessToken,
      plaidConn.cursor,
    );
    await updateCursor(plaidConn.id, syncResult.nextCursor);

    // 6. Get balances and debts, create snapshots
    const [balances, debts, activeObligations, obligationsTotal, allocationData, recentCheckins] =
      await Promise.all([
        getAccountBalances(plaidConn.accessToken),
        getDebts(theUser.id),
        getActiveObligations(theUser.id),
        getObligationsTotal(theUser.id),
        getAllocation(theUser.id),
        getRecentCheckins(theUser.id, 5),
      ]);

    // Create debt snapshots for each active debt
    for (const d of debts) {
      if (d.currentBalance != null) {
        await createDebtSnapshot(d.id, d.currentBalance);
      }
    }

    // 7. Calculate strict payload (code owns values)
    const freeCashRemaining = computeFreeCashRemaining(
      balances.totalChecking,
      obligationsTotal,
    );
    const previousCheckins = recentCheckins.filter(
      (c) => c.type === "weekly_checkin",
    );
    const spendingPaceNote = buildSpendingPaceNote(
      freeCashRemaining,
      allocationData?.gap ?? null,
    );

    // Upcoming subs: obligations with nextExpectedDate within 5 days
    const upcomingSubs: CheckinUpcomingSubItem[] = [];
    for (const ob of activeObligations) {
      if (ob.nextExpectedDate) {
        const nextDate = new Date(ob.nextExpectedDate);
        const days = daysUntil(nextDate);
        if (days >= 0 && days <= 5) {
          upcomingSubs.push({
            merchant: ob.merchantName,
            amount: ob.amount,
            daysUntil: days,
          });
        }
      }
    }

    // Debt progress: compare current balances to previous snapshots
    const debtProgress: CheckinDebtProgressItem[] = [];
    for (const d of debts) {
      if (d.currentBalance == null) continue;
      const snapshots = await getDebtSnapshots(d.id);
      // The most recent snapshot is the one we just created; get the one before it
      const previousSnapshot = snapshots.length > 1 ? snapshots[1] : null;
      const previousBalance = previousSnapshot
        ? previousSnapshot.balance
        : d.currentBalance;
      debtProgress.push({
        accountName: d.accountName,
        currentBalance: d.currentBalance,
        previousBalance,
      });
    }

    // 8. Render message from payload only (no free-form numeric generation)
    const finalCheckinText = renderCheckinMessage({
      freeCashRemaining,
      spendingPaceNote,
      upcomingSubs,
      debtProgress,
    });

    // 9. Send via Telegram
    const telegramMessageId = await sendFormattedMessage(
      theUser.telegramChatId,
      finalCheckinText,
    );

    // 10. Log in checkin_log
    await createCheckinLog({
      userId: theUser.id,
      type: "weekly_checkin",
      messageText: finalCheckinText,
      telegramMessageId,
    });

    // 11. Check if *previous* check-in was replied to — if not, increment ignoredCheckins
    if (previousCheckins.length > 0) {
      const lastCheckin = previousCheckins[0];
      if (!lastCheckin.userReplied) {
        const newIgnoredCount = theUser.ignoredCheckins + 1;
        await updateUser(theUser.id, { ignoredCheckins: newIgnoredCount });

        // 12. If ignoredCheckins reaches 2, send follow-up with inline buttons
        if (newIgnoredCount === 2) {
          const followUpText = escapeMarkdownV2(
            "Been a couple weeks. Want me to keep these coming or go quiet for a bit?",
          );
          await sendMessageWithKeyboard(theUser.telegramChatId, followUpText, [
            [
              { text: "Keep them coming", callback_data: "checkin_keep" },
              { text: "Go quiet", callback_data: "checkin_quiet" },
            ],
          ]);
        }
      } else {
        // Previous check-in was replied to — reset ignored counter
        if (theUser.ignoredCheckins > 0) {
          await updateUser(theUser.id, { ignoredCheckins: 0 });
        }
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[cron/checkin] Error:", error);
    return NextResponse.json({ ok: true });
  }
}
