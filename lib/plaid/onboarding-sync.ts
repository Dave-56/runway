import { decrypt } from "@/lib/utils/crypto";
import { normalizeToMonthly } from "@/lib/utils/money";
import { plaidClient } from "./client";
import {
  getRecurringCharges,
  getPlaidErrorCode,
  getPlaidErrorMessage,
  isProductNotReadyError,
} from "./recurring";
import { upsertObligation } from "@/lib/db/queries";

export type RecurringOnboardingStatus = "ready" | "warming_up" | "failed";

export interface RecurringOnboardingResult {
  status: RecurringOnboardingStatus;
  obligationsSynced: number;
  errorCode?: string;
  errorMessage?: string;
}

export async function syncRecurringOnboardingData(
  userId: number,
  encryptedAccessToken: string,
): Promise<RecurringOnboardingResult> {
  const accessToken = decrypt(encryptedAccessToken);

  const balanceResponse = await plaidClient.accountsBalanceGet({
    access_token: accessToken,
  });
  const allAccountIds = balanceResponse.data.accounts.map((a) => a.account_id);

  try {
    const { outflows } = await getRecurringCharges(
      encryptedAccessToken,
      allAccountIds,
    );

    let synced = 0;
    for (const charge of outflows) {
      const monthlyAmount = normalizeToMonthly(charge.amount, charge.frequency);
      await upsertObligation({
        userId,
        plaidStreamId: charge.streamId,
        merchantName: charge.merchantName,
        amount: monthlyAmount,
        frequency: charge.frequency,
        nextExpectedDate: charge.nextExpectedDate,
        category: "other",
        isSubscription: charge.isSubscription,
        status: "active",
      });
      synced += 1;
    }

    return {
      status: "ready",
      obligationsSynced: synced,
    };
  } catch (error) {
    if (isProductNotReadyError(error)) {
      return {
        status: "warming_up",
        obligationsSynced: 0,
        errorCode: getPlaidErrorCode(error) ?? "PRODUCT_NOT_READY",
        errorMessage: getPlaidErrorMessage(error) ?? undefined,
      };
    }

    throw error;
  }
}
