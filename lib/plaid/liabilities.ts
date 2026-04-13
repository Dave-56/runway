import { plaidClient } from "./client";
import { decrypt } from "@/lib/utils/crypto";

export interface DebtAccount {
  accountId: string;
  accountName: string;
  type: "credit_card" | "student_loan" | "mortgage";
  currentBalance: number;
  interestRate: number | null;
  minimumPayment: number | null;
}

/**
 * Fetch liabilities (credit cards, student loans, mortgages).
 * Returns structured debt accounts ready for the debt table.
 */
export async function getLiabilities(
  encryptedAccessToken: string,
): Promise<DebtAccount[]> {
  const accessToken = decrypt(encryptedAccessToken);

  const response = await plaidClient.liabilitiesGet({
    access_token: accessToken,
  });

  const { liabilities, accounts } = response.data;
  const debts: DebtAccount[] = [];

  // Map account IDs to names
  const accountNames = new Map(
    accounts.map((a) => [a.account_id, a.name]),
  );

  // Credit cards
  if (liabilities.credit) {
    for (const cc of liabilities.credit) {
      if (!cc.account_id) continue;

      // Get the highest APR (usually purchase APR)
      const purchaseApr = cc.aprs.find(
        (a) => a.apr_type === "purchase_apr",
      );
      const highestApr = purchaseApr ?? cc.aprs[0];

      debts.push({
        accountId: cc.account_id,
        accountName: accountNames.get(cc.account_id) || "Credit Card",
        type: "credit_card",
        currentBalance: cc.last_statement_balance ?? 0,
        interestRate: highestApr
          ? Math.round(highestApr.apr_percentage * 100) / 100
          : null,
        minimumPayment: cc.minimum_payment_amount ?? null,
      });
    }
  }

  // Student loans
  if (liabilities.student) {
    for (const loan of liabilities.student) {
      if (!loan.account_id) continue;
      debts.push({
        accountId: loan.account_id,
        accountName:
          accountNames.get(loan.account_id) || loan.loan_name || "Student Loan",
        type: "student_loan",
        currentBalance: loan.last_statement_balance ?? 0,
        interestRate: loan.interest_rate_percentage ?? null,
        minimumPayment: loan.minimum_payment_amount ?? null,
      });
    }
  }

  return debts;
}
