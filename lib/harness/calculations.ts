export interface DebtPayoffResult {
  months: number;
  totalInterest: number;
  totalPaid: number;
}

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function sumMoney(values: number[]): number {
  return roundMoney(values.reduce((sum, value) => sum + value, 0));
}

export function computeGap(
  monthlyIncome: number,
  obligationsTotal: number,
): number {
  return roundMoney(monthlyIncome - obligationsTotal);
}

export function computeFreeCashRemaining(
  checkingBalance: number,
  obligationsTotal: number,
): number {
  return roundMoney(checkingBalance - obligationsTotal);
}

export function calculateDebtPayoff(
  balance: number,
  annualRatePercent: number,
  monthlyPayment: number,
): DebtPayoffResult | { error: string } {
  if (monthlyPayment <= 0) {
    return { error: "Monthly payment must be greater than zero." };
  }

  const monthlyRate = annualRatePercent / 100 / 12;

  if (monthlyRate === 0) {
    const months = Math.ceil(balance / monthlyPayment);
    return {
      months,
      totalInterest: 0,
      totalPaid: roundMoney(balance),
    };
  }

  const monthlyInterest = balance * monthlyRate;
  if (monthlyPayment <= monthlyInterest) {
    return {
      error: `Payment of $${monthlyPayment} doesn't cover monthly interest of $${monthlyInterest.toFixed(2)}. Need to pay more than that.`,
    };
  }

  const months = Math.ceil(
    -Math.log(1 - (monthlyRate * balance) / monthlyPayment) /
      Math.log(1 + monthlyRate),
  );
  const totalPaid = roundMoney(months * monthlyPayment);

  return {
    months,
    totalPaid,
    totalInterest: roundMoney(totalPaid - balance),
  };
}
