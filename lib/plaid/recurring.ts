import { RecurringTransactionFrequency, TransactionStream } from "plaid";
import { plaidClient } from "./client";
import { decrypt } from "@/lib/utils/crypto";

type ObligationFrequency =
  | "weekly"
  | "biweekly"
  | "monthly"
  | "quarterly"
  | "annually";

export interface RecurringCharge {
  streamId: string;
  merchantName: string;
  amount: number;
  frequency: ObligationFrequency;
  nextExpectedDate: string | null;
  isSubscription: boolean;
  isActive: boolean;
}

const FREQUENCY_MAP: Record<string, ObligationFrequency> = {
  [RecurringTransactionFrequency.Weekly]: "weekly",
  [RecurringTransactionFrequency.Biweekly]: "biweekly",
  [RecurringTransactionFrequency.SemiMonthly]: "biweekly",
  [RecurringTransactionFrequency.Monthly]: "monthly",
  [RecurringTransactionFrequency.Annually]: "annually",
};

// Subscription-like categories from Plaid's personal finance categories
const SUBSCRIPTION_KEYWORDS = [
  "subscription",
  "streaming",
  "software",
  "cloud",
  "membership",
  "gym",
  "music",
  "video",
  "gaming",
  "news",
  "magazine",
];

function isLikelySubscription(stream: TransactionStream): boolean {
  const desc = (stream.description || "").toLowerCase();
  const merchant = (stream.merchant_name || "").toLowerCase();
  const combined = `${desc} ${merchant}`;
  return SUBSCRIPTION_KEYWORDS.some((kw) => combined.includes(kw));
}

/**
 * Fetch all recurring transaction streams (outflows = obligations).
 * Returns normalized charges ready to be upserted into the obligation table.
 */
export async function getRecurringCharges(
  encryptedAccessToken: string,
  accountIds: string[],
): Promise<{ outflows: RecurringCharge[]; inflows: RecurringCharge[] }> {
  const accessToken = decrypt(encryptedAccessToken);

  const response = await plaidClient.transactionsRecurringGet({
    access_token: accessToken,
    account_ids: accountIds,
  });

  const data = response.data;

  const mapStream = (stream: TransactionStream): RecurringCharge => ({
    streamId: stream.stream_id,
    merchantName: stream.merchant_name || stream.description,
    amount: Math.abs(stream.average_amount.amount ?? 0),
    frequency: FREQUENCY_MAP[stream.frequency] || "monthly",
    nextExpectedDate: stream.predicted_next_date || null,
    isSubscription: isLikelySubscription(stream),
    isActive: stream.is_active,
  });

  return {
    outflows: data.outflow_streams.filter((s) => s.is_active).map(mapStream),
    inflows: data.inflow_streams.filter((s) => s.is_active).map(mapStream),
  };
}
