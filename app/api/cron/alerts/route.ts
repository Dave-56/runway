import { NextRequest, NextResponse } from "next/server";
import { type ModelMessage } from "ai";
import {
  getActiveUsers,
  getActiveObligations,
  getObligations,
  getPlaidConnection,
  getDebts,
  getDebtSnapshots,
  createDebtSnapshot,
  getRecentCheckins,
  createCheckinLog,
  getCheckinCountThisWeek,
  getAllocation,
  getObligationsTotal,
  recallMemoryByPattern,
} from "@/lib/db/queries";
import { syncTransactions } from "@/lib/plaid/transactions";
import { updateCursor } from "@/lib/db/queries";
import { sendFormattedMessage } from "@/lib/telegram/client";
import { escapeMarkdownV2 } from "@/lib/telegram/format";
import { isQuietHours, daysUntil, getWeekBoundaries } from "@/lib/utils/dates";
import {
  buildAlertPrompt,
  buildSystemPrompt,
  type AlertPromptData,
  type SystemPromptContext,
} from "@/lib/agent/prompts";
import { callLLM } from "@/lib/agent/provider";
import { validateNumbersAgainstExpected } from "@/lib/agent/validate";
import { formatCurrency } from "@/lib/utils/money";
import { sumMoney } from "@/lib/harness/calculations";

// ── GET handler — called by Vercel Cron ──────────────────────────────

function getExpectedAlertAmounts(data: AlertPromptData): number[] {
  const renewalTotal = sumMoney(data.renewals.map((renewal) => renewal.amount));
  return [
    renewalTotal,
    ...data.renewals.map((renewal) => renewal.amount),
    ...data.zombies.map((zombie) => zombie.amount),
    ...data.unusualCharges.flatMap((charge) => [
      charge.amount,
      charge.typicalAmount,
    ]),
    ...data.milestones.flatMap((milestone) => [
      milestone.currentBalance,
      milestone.threshold,
    ]),
  ];
}

function buildSafeAlertFallback(data: AlertPromptData): string {
  const parts: string[] = [];

  if (data.renewals.length > 0) {
    const total = sumMoney(data.renewals.map((renewal) => renewal.amount));
    parts.push(
      `${data.renewals.length} subs renew in the next 5 days totaling ${formatCurrency(total)}.`,
    );
  }

  if (data.zombies.length > 0) {
    const firstZombie = data.zombies[0];
    parts.push(
      `${firstZombie.merchant} charged again at ${formatCurrency(firstZombie.amount)}.`,
    );
  }

  if (data.unusualCharges.length > 0) {
    const firstCharge = data.unusualCharges[0];
    parts.push(
      `${formatCurrency(firstCharge.amount)} posted from ${firstCharge.merchant}, higher than the usual ${formatCurrency(firstCharge.typicalAmount)}.`,
    );
  }

  if (data.milestones.length > 0) {
    const firstMilestone = data.milestones[0];
    parts.push(
      `${firstMilestone.accountName} is now ${formatCurrency(firstMilestone.currentBalance)}, below ${formatCurrency(firstMilestone.threshold)}.`,
    );
  }

  return escapeMarkdownV2(`Heads up — ${parts.join(" ")}`);
}

export async function GET(req: NextRequest) {
  try {
    // 1. Verify cron auth
    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 2. Load user (single-user app — get the first user)
    const users = await getActiveUsers();
    const dbUser = users[0];
    if (!dbUser || !dbUser.active) {
      return NextResponse.json({ ok: true });
    }

    // 3. Check quiet hours
    const timezone = dbUser.timezone || "America/New_York";
    if (isQuietHours(timezone)) {
      return NextResponse.json({ ok: true });
    }

    // 4. Enforce message caps
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    // Check if an alert was already sent today
    const recentCheckins = await getRecentCheckins(dbUser.id, 20);
    const alertSentToday = recentCheckins.some(
      (c) => c.type === "alert" && new Date(c.sentAt) >= todayStart,
    );
    if (alertSentToday) {
      return NextResponse.json({ ok: true });
    }

    // Check total messages this week (max 3)
    const { start: weekStart } = getWeekBoundaries(timezone);
    const weekCount = await getCheckinCountThisWeek(dbUser.id, weekStart);
    if (weekCount >= 3) {
      return NextResponse.json({ ok: true });
    }

    // 5. Run alert checks — collect all triggers
    const alertData: AlertPromptData = {
      renewals: [],
      zombies: [],
      unusualCharges: [],
      milestones: [],
    };

    // 5a. Subscription renewals: obligations where nextExpectedDate is within 3–5 days
    const activeObligations = await getActiveObligations(dbUser.id);
    for (const ob of activeObligations) {
      if (!ob.nextExpectedDate) continue;
      const days = daysUntil(new Date(ob.nextExpectedDate));
      if (days >= 3 && days <= 5) {
        alertData.renewals.push({
          merchant: ob.merchantName,
          amount: ob.amount,
          daysUntil: days,
        });
      }
    }

    // 5b. Zombie charges: sync recent transactions, match against dead obligations
    const allObligations = await getObligations(dbUser.id);
    const deadObligations = allObligations.filter((ob) => ob.status === "dead");

    const plaidConn = await getPlaidConnection(dbUser.id);
    let addedTransactions: Awaited<ReturnType<typeof syncTransactions>>["added"] = [];

    if (plaidConn) {
      try {
        const syncResult = await syncTransactions(
          plaidConn.accessToken,
          plaidConn.cursor,
        );
        addedTransactions = syncResult.added;

        // Update cursor for next sync
        if (syncResult.nextCursor && syncResult.nextCursor !== plaidConn.cursor) {
          await updateCursor(plaidConn.id, syncResult.nextCursor);
        }
      } catch (err) {
        console.error("[cron/alerts] Transaction sync failed:", err);
      }
    }

    // Only look at outflows (amount > 0 in Plaid means money leaving the account)
    const outflows = addedTransactions.filter((tx) => tx.amount > 0);

    for (const deadOb of deadObligations) {
      const deadName = deadOb.merchantName.toLowerCase();
      const zombieTx = outflows.find((tx) => {
        const txMerchant = (tx.merchant_name || tx.name || "").toLowerCase();
        return txMerchant.includes(deadName) || deadName.includes(txMerchant);
      });
      if (zombieTx) {
        alertData.zombies.push({
          merchant: deadOb.merchantName,
          amount: zombieTx.amount,
        });
      }
    }

    // 5c. Unusual charges: any single transaction > 2x the average for that merchant
    // Group outflows by merchant to calculate averages
    const merchantTotals = new Map<string, { sum: number; count: number }>();
    for (const tx of outflows) {
      const merchant = (tx.merchant_name || tx.name || "").toLowerCase();
      if (!merchant) continue;
      const entry = merchantTotals.get(merchant) || { sum: 0, count: 0 };
      entry.sum += tx.amount;
      entry.count += 1;
      merchantTotals.set(merchant, entry);
    }

    for (const tx of outflows) {
      const merchant = (tx.merchant_name || tx.name || "").toLowerCase();
      if (!merchant) continue;
      const entry = merchantTotals.get(merchant);
      if (!entry || entry.count < 2) continue;
      const avg = entry.sum / entry.count;
      if (tx.amount > avg * 2) {
        alertData.unusualCharges.push({
          merchant: tx.merchant_name || tx.name || merchant,
          amount: tx.amount,
          typicalAmount: Math.round(avg * 100) / 100,
        });
      }
    }

    // 5d. Debt milestones: compare current balance to last snapshot
    const debts = await getDebts(dbUser.id);
    for (const d of debts) {
      if (d.currentBalance == null) continue;

      const snapshots = await getDebtSnapshots(d.id);
      const lastSnapshot = snapshots[0]; // ordered desc by recordedAt

      if (lastSnapshot) {
        const prevBalance = Number(lastSnapshot.balance);
        const currBalance = d.currentBalance;

        // Check if balance crossed below a $1,000 threshold
        // e.g. $8,100 → $6,900 crosses $7,000
        const prevThousand = Math.ceil(prevBalance / 1000) * 1000;
        const crossedThresholds: number[] = [];
        for (
          let threshold = prevThousand - 1000;
          threshold > 0;
          threshold -= 1000
        ) {
          if (prevBalance > threshold && currBalance <= threshold) {
            crossedThresholds.push(threshold);
          }
        }

        if (crossedThresholds.length > 0) {
          alertData.milestones.push({
            accountName: d.accountName,
            currentBalance: currBalance,
            threshold: crossedThresholds[0], // report the highest crossed threshold
          });
        }
      }

      // Record a new snapshot for future comparisons
      await createDebtSnapshot(d.id, d.currentBalance);
    }

    // 6. If no triggers found, return 200 (silence is fine)
    const hasTriggers =
      alertData.renewals.length > 0 ||
      alertData.zombies.length > 0 ||
      alertData.unusualCharges.length > 0 ||
      alertData.milestones.length > 0;

    if (!hasTriggers) {
      return NextResponse.json({ ok: true });
    }

    // 7. Build alert prompt
    const alertPrompt = buildAlertPrompt(alertData);

    // 8. Build system prompt context and call LLM
    const obligationsTotal = await getObligationsTotal(dbUser.id);
    const allocationData = await getAllocation(dbUser.id);
    const memories = await recallMemoryByPattern(dbUser.id, "%");
    const recentCheckinsForCtx = await getRecentCheckins(dbUser.id, 5);

    const systemCtx: SystemPromptContext = {
      phase: dbUser.phase,
      obligations: activeObligations.map((ob) => ({
        id: ob.id,
        merchantName: ob.merchantName,
        amount: ob.amount,
        frequency: ob.frequency,
        nextExpectedDate: ob.nextExpectedDate,
        category: ob.category,
        isSubscription: ob.isSubscription,
        status: ob.status,
      })),
      obligationsTotal,
      allocation: allocationData
        ? {
            monthlyIncome: allocationData.monthlyIncome,
            obligationsTotal: allocationData.obligationsTotal,
            gap: allocationData.gap,
            debtAmount: allocationData.debtAmount,
            cushionAmount: allocationData.cushionAmount,
            livingAmount: allocationData.livingAmount,
            strategy: allocationData.strategy,
          }
        : null,
      debts: debts.map((d) => ({
        accountName: d.accountName,
        currentBalance: d.currentBalance,
        interestRate: d.interestRate,
        minimumPayment: d.minimumPayment,
      })),
      memories: memories.map((m) => ({
        key: m.key,
        value: m.value,
        type: m.type,
        source: m.source,
        updatedAt: m.updatedAt,
      })),
      recentCheckins: recentCheckinsForCtx.map((c) => ({
        type: c.type,
        messageText: c.messageText,
        sentAt: c.sentAt,
      })),
    };

    const systemPrompt = buildSystemPrompt(systemCtx);
    const messages: ModelMessage[] = [
      { role: "user", content: alertPrompt },
    ];

    const { text: alertMessage } = await callLLM({
      systemPrompt,
      messages,
    });

    const expectedAmounts = getExpectedAlertAmounts(alertData);
    let finalAlertMessage = alertMessage;
    let validation = validateNumbersAgainstExpected(
      finalAlertMessage,
      expectedAmounts,
      { requireAmount: true },
    );

    if (!validation.valid) {
      console.warn(
        "[cron/alerts] Blocking mismatched amounts:",
        validation.mismatches.map((amount) => `$${amount}`),
      );

      const retry = await callLLM({
        systemPrompt,
        messages: [
          {
            role: "user",
            content: [
              alertPrompt,
              "",
              "Rewrite the alert.",
              `Use only these dollar amounts: ${expectedAmounts
                .map((amount) => formatCurrency(amount))
                .join(", ")}`,
              "If unsure, avoid introducing any new dollar amount.",
            ].join("\n"),
          },
        ],
      });

      finalAlertMessage = retry.text;
      validation = validateNumbersAgainstExpected(
        finalAlertMessage,
        expectedAmounts,
        { requireAmount: true },
      );
    }

    if (!validation.valid) {
      finalAlertMessage = buildSafeAlertFallback(alertData);
    }

    // 9. Send via Telegram
    const telegramMessageId = await sendFormattedMessage(
      dbUser.telegramChatId,
      finalAlertMessage,
    );

    // 10. Log in checkin_log with type "alert"
    await createCheckinLog({
      userId: dbUser.id,
      type: "alert",
      messageText: finalAlertMessage,
      telegramMessageId,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[cron/alerts] Unhandled error:", err);
    return NextResponse.json({ ok: true });
  }
}
