import { decrypt } from "@/lib/utils/crypto";
import { normalizeToMonthly } from "@/lib/utils/money";
import { plaidClient } from "./client";
import {
  getRecurringCharges,
  getPlaidErrorCode,
  getPlaidErrorMessage,
  isProductNotReadyError,
} from "./recurring";
import { getLiabilities } from "./liabilities";
import { upsertDebt, upsertObligation } from "@/lib/db/queries";

export type RecurringOnboardingStatus = "ready" | "warming_up" | "failed";

export interface RecurringOnboardingResult {
  status: RecurringOnboardingStatus;
  obligationsSynced: number;
  debtsSynced: number;
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

    let debtsSynced = 0;
    try {
      const liabilities = await getLiabilities(encryptedAccessToken);
      liabilities.sort((a, b) => {
        const aRate = a.interestRate ?? -1;
        const bRate = b.interestRate ?? -1;
        if (bRate !== aRate) return bRate - aRate;
        return b.currentBalance - a.currentBalance;
      });

      for (let index = 0; index < liabilities.length; index += 1) {
        const debt = liabilities[index];
        await upsertDebt({
          userId,
          accountName: debt.accountName,
          plaidAccountId: debt.accountId,
          currentBalance: debt.currentBalance,
          interestRate: debt.interestRate,
          minimumPayment: debt.minimumPayment,
          priorityOrder: index + 1,
        });
        debtsSynced += 1;
      }
    } catch (error) {
      if (!isProductNotReadyError(error)) {
        console.warn("[onboarding-sync] Failed to sync liabilities:", error);
      }
    }

    return {
      status: "ready",
      obligationsSynced: synced,
      debtsSynced,
    };
  } catch (error) {
    if (isProductNotReadyError(error)) {
      return {
        status: "warming_up",
        obligationsSynced: 0,
        debtsSynced: 0,
        errorCode: getPlaidErrorCode(error) ?? "PRODUCT_NOT_READY",
        errorMessage: getPlaidErrorMessage(error) ?? undefined,
      };
    }

    throw error;
  }
}
