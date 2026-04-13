import { tool } from "ai";
import { z } from "zod";
import {
  getActiveObligations,
  getSubscriptions,
  flagObligationDead,
  getDebts,
  getAllocation,
  upsertAllocation,
  saveMemory,
  recallMemoryByPattern,
  recallMemoryByType,
  getPlaidConnection,
} from "@/lib/db/queries";
import { getAccountBalances } from "@/lib/plaid/balances";
import { syncTransactions } from "@/lib/plaid/transactions";
import { updateCursor } from "@/lib/db/queries";

/**
 * Build the full tool set for a given user.
 * Each tool closes over the userId so the LLM doesn't need to pass it.
 */
export function buildTools(userId: number) {
  return {
    get_account_balances: tool({
      description:
        "Get current balances for all linked bank accounts — checking, savings, and credit cards.",
      inputSchema: z.object({}),
      execute: async () => {
        const conn = await getPlaidConnection(userId);
        if (!conn) return { error: "No bank account linked yet." };
        return getAccountBalances(conn.accessToken);
      },
    }),

    get_obligations: tool({
      description:
        "Get all active recurring charges (rent, loans, insurance, subscriptions, utilities). Returns the full list with amounts and next expected dates.",
      inputSchema: z.object({}),
      execute: async () => {
        return getActiveObligations(userId);
      },
    }),

    get_subscriptions: tool({
      description:
        "Get all subscription-type recurring charges with their status (active or dead). Use this when the user wants to review or flag subscriptions.",
      inputSchema: z.object({}),
      execute: async () => {
        return getSubscriptions(userId);
      },
    }),

    flag_subscription_dead: tool({
      description:
        "Mark a subscription as dead (user wants to cancel it). Use when the user taps 'Dead' or says they want to cancel a subscription.",
      inputSchema: z.object({
        obligation_id: z.number().describe("The ID of the obligation to flag as dead"),
      }),
      execute: async ({ obligation_id }) => {
        const result = await flagObligationDead(obligation_id);
        if (!result) return { error: "Obligation not found." };
        return { success: true, merchant: result.merchantName };
      },
    }),

    get_debt_summary: tool({
      description:
        "Get all debt accounts (credit cards, loans) with current balances, interest rates, and minimum payments.",
      inputSchema: z.object({}),
      execute: async () => {
        return getDebts(userId);
      },
    }),

    calculate_payoff: tool({
      description:
        "Calculate how long it takes to pay off a debt given a monthly payment amount. Returns months to payoff and total interest paid.",
      inputSchema: z.object({
        balance: z.number().describe("Current debt balance in dollars"),
        rate: z.number().describe("Annual interest rate as a percentage (e.g. 22.9)"),
        monthly_payment: z.number().describe("Monthly payment amount in dollars"),
      }),
      execute: async ({ balance, rate, monthly_payment }) => {
        if (monthly_payment <= 0) {
          return { error: "Monthly payment must be greater than zero." };
        }

        const monthlyRate = rate / 100 / 12;

        // Interest-free debt
        if (monthlyRate === 0) {
          const months = Math.ceil(balance / monthly_payment);
          return { months, totalInterest: 0, totalPaid: balance };
        }

        // Check if payment covers at least the interest
        const monthlyInterest = balance * monthlyRate;
        if (monthly_payment <= monthlyInterest) {
          return {
            error: `Payment of $${monthly_payment} doesn't cover monthly interest of $${monthlyInterest.toFixed(2)}. Need to pay more than that.`,
          };
        }

        // Standard amortization formula: n = -log(1 - (r*PV)/PMT) / log(1+r)
        const months = Math.ceil(
          -Math.log(1 - (monthlyRate * balance) / monthly_payment) /
            Math.log(1 + monthlyRate),
        );
        const totalPaid = months * monthly_payment;
        const totalInterest = Math.round((totalPaid - balance) * 100) / 100;

        return { months, totalInterest, totalPaid: Math.round(totalPaid * 100) / 100 };
      },
    }),

    get_spending_summary: tool({
      description:
        "Get a summary of recent spending by syncing the latest transactions. Shows total spent and a breakdown. Use when the user asks about spending or during check-ins.",
      inputSchema: z.object({
        days: z
          .number()
          .optional()
          .describe("Number of days to look back (default: 7)"),
      }),
      execute: async ({ days = 7 }) => {
        const conn = await getPlaidConnection(userId);
        if (!conn) return { error: "No bank account linked yet." };

        const result = await syncTransactions(conn.accessToken, conn.cursor);

        // Update the cursor for next sync
        if (result.nextCursor && result.nextCursor !== conn.cursor) {
          await updateCursor(conn.id, result.nextCursor);
        }

        // Filter to the requested time window
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);

        const recentTransactions = result.added.filter((t) => {
          const txDate = new Date(t.date);
          return txDate >= cutoff;
        });

        // Aggregate by merchant
        const byMerchant: Record<string, { count: number; total: number }> = {};
        let totalSpent = 0;

        for (const tx of recentTransactions) {
          // Plaid uses positive amounts for outflows
          if (tx.amount > 0) {
            const name = tx.merchant_name || tx.name;
            if (!byMerchant[name]) {
              byMerchant[name] = { count: 0, total: 0 };
            }
            byMerchant[name].count += 1;
            byMerchant[name].total += tx.amount;
            totalSpent += tx.amount;
          }
        }

        // Sort by total spent descending
        const topMerchants = Object.entries(byMerchant)
          .sort(([, a], [, b]) => b.total - a.total)
          .slice(0, 10)
          .map(([name, data]) => ({
            merchant: name,
            transactions: data.count,
            total: Math.round(data.total * 100) / 100,
          }));

        return {
          days,
          totalSpent: Math.round(totalSpent * 100) / 100,
          transactionCount: recentTransactions.filter((t) => t.amount > 0).length,
          topMerchants,
        };
      },
    }),

    get_allocation: tool({
      description:
        "Get the user's current allocation decision — how they've split their gap money between debt, cushion, and living expenses.",
      inputSchema: z.object({}),
      execute: async () => {
        const result = await getAllocation(userId);
        if (!result) return { error: "No allocation set yet." };
        return result;
      },
    }),

    update_allocation: tool({
      description:
        "Store the user's allocation decision for how to split their gap money. Use after the user decides how much to put toward debt, cushion, and living.",
      inputSchema: z.object({
        debt_amount: z.number().describe("Monthly amount to put toward debt payoff"),
        cushion_amount: z
          .number()
          .describe("Monthly amount to put toward emergency cushion"),
        strategy: z
          .enum(["avalanche", "snowball", "hybrid", "none"])
          .describe("Debt payoff strategy: avalanche (highest rate first), snowball (smallest balance first), hybrid (mix), or none"),
      }),
      execute: async ({ debt_amount, cushion_amount, strategy }) => {
        const result = await upsertAllocation({
          userId,
          debtAmount: debt_amount,
          cushionAmount: cushion_amount,
          strategy,
        });
        return result;
      },
    }),

    save_memory: tool({
      description:
        "Save a piece of information about the user for future reference. Categorize it by type so memories stay organized and retrievable.",
      inputSchema: z.object({
        key: z.string().describe("Short descriptive key (e.g. 'sister_got_job', 'prefers_morning_checkins', 'pay_off_chase_by_december')"),
        value: z.string().describe("The information to remember"),
        type: z
          .enum(["financial", "behavioral", "life_event", "goal"])
          .describe(
            "financial: income changes, spending habits, account events. behavioral: communication preferences, check-in timing. life_event: job changes, moves, family events. goal: debt targets, savings milestones, deadlines.",
          ),
        source: z
          .enum(["user_stated", "agent_inferred"])
          .default("agent_inferred")
          .describe("user_stated: user explicitly told you this. agent_inferred: you noticed or concluded this from context."),
      }),
      execute: async ({ key, value, type, source }) => {
        await saveMemory(userId, key, value, type, source);
        return { success: true };
      },
    }),

    recall_memory: tool({
      description:
        "Recall stored memories about the user. Search by key pattern, or filter by type to get all memories in a category.",
      inputSchema: z.object({
        key_pattern: z
          .string()
          .optional()
          .describe("SQL ILIKE pattern to match memory keys (e.g. '%sister%'). Omit to use type filter instead."),
        type: z
          .enum(["financial", "behavioral", "life_event", "goal"])
          .optional()
          .describe("Filter memories by type. Omit to search by key_pattern."),
      }),
      execute: async ({ key_pattern, type }) => {
        if (type) {
          return recallMemoryByType(userId, type);
        }
        return recallMemoryByPattern(userId, key_pattern || "%");
      },
    }),
  };
}
