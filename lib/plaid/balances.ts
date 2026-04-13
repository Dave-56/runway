import { AccountBase, AccountType } from "plaid";
import { plaidClient } from "./client";
import { decrypt } from "@/lib/utils/crypto";

export interface AccountBalances {
  checking: { name: string; balance: number }[];
  savings: { name: string; balance: number }[];
  credit: { name: string; balance: number }[];
  totalChecking: number;
  totalSavings: number;
  totalCredit: number;
}

/**
 * Fetch real-time balances for all linked accounts.
 * Groups by account type and sums totals.
 */
export async function getAccountBalances(
  encryptedAccessToken: string,
): Promise<AccountBalances> {
  const accessToken = decrypt(encryptedAccessToken);

  const response = await plaidClient.accountsBalanceGet({
    access_token: accessToken,
  });

  const accounts = response.data.accounts;

  const group = (type: AccountType) =>
    accounts
      .filter((a: AccountBase) => a.type === type)
      .map((a: AccountBase) => ({
        name: a.name,
        balance: a.balances.current ?? 0,
      }));

  const checking = group(AccountType.Depository);
  const savings = accounts
    .filter(
      (a: AccountBase) =>
        a.type === AccountType.Depository &&
        a.subtype?.toLowerCase() === "savings",
    )
    .map((a: AccountBase) => ({
      name: a.name,
      balance: a.balances.current ?? 0,
    }));

  // Separate checking from savings within depository
  const checkingOnly = accounts
    .filter(
      (a: AccountBase) =>
        a.type === AccountType.Depository &&
        a.subtype?.toLowerCase() !== "savings",
    )
    .map((a: AccountBase) => ({
      name: a.name,
      balance: a.balances.current ?? 0,
    }));

  const credit = group(AccountType.Credit);

  const sum = (items: { balance: number }[]) =>
    items.reduce((acc, i) => acc + i.balance, 0);

  return {
    checking: checkingOnly,
    savings,
    credit,
    totalChecking: sum(checkingOnly),
    totalSavings: sum(savings),
    totalCredit: sum(credit),
  };
}
