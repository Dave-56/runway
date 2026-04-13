export function formatCurrency(amount: number): string {
  const abs = Math.abs(amount);
  const isWhole = abs === Math.floor(abs);
  const formatted = isWhole
    ? abs.toLocaleString("en-US", { maximumFractionDigits: 0 })
    : abs.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
  return amount < 0 ? `-$${formatted}` : `$${formatted}`;
}

const MONTHLY_MULTIPLIERS: Record<string, number> = {
  weekly: 4.33,
  biweekly: 2.17,
  monthly: 1,
  quarterly: 1 / 3,
  annually: 1 / 12,
};

export function normalizeToMonthly(
  amount: number,
  frequency: string,
): number {
  const multiplier = MONTHLY_MULTIPLIERS[frequency];
  if (multiplier === undefined) return amount;
  return Math.round(amount * multiplier * 100) / 100;
}
