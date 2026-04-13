/**
 * Post-response number validation.
 * Extracts dollar amounts from LLM response text and cross-checks
 * against values returned by tool calls in the same request.
 */

const DOLLAR_RE = /\$[\d,]+(?:\.\d{1,2})?/g;

/** Parse "$1,234.56" → 1234.56 */
function parseDollar(raw: string): number {
  return parseFloat(raw.replace(/[$,]/g, ""));
}

/** Extract all dollar amounts from response text. */
export function extractDollarAmounts(text: string): number[] {
  const matches = text.match(DOLLAR_RE);
  if (!matches) return [];
  return matches.map(parseDollar).filter((n) => !isNaN(n));
}

/** Recursively collect all numbers from tool results. */
export function extractToolNumbers(obj: unknown): number[] {
  if (obj == null) return [];
  if (typeof obj === "number") return [obj];
  if (Array.isArray(obj)) return obj.flatMap(extractToolNumbers);
  if (typeof obj === "object") {
    return Object.values(obj as Record<string, unknown>).flatMap(
      extractToolNumbers,
    );
  }
  // Try parsing string numbers (e.g. "1234.56")
  if (typeof obj === "string") {
    const n = parseFloat(obj);
    return isNaN(n) ? [] : [n];
  }
  return [];
}

/**
 * Check if a text amount matches any tool result number.
 * Uses a small tolerance for floating-point rounding ($0.02).
 */
function hasMatch(amount: number, toolNums: number[]): boolean {
  return toolNums.some((n) => Math.abs(n - amount) < 0.02);
}

export interface ValidationResult {
  valid: boolean;
  /** Dollar amounts in the response that don't match any tool result. */
  mismatches: number[];
}

/**
 * Validate dollar amounts in LLM response against tool call results.
 * Returns valid: true if no tools were called (nothing to check)
 * or all text amounts match a tool result value.
 */
export function validateNumbers(
  text: string,
  toolResults: unknown[],
): ValidationResult {
  // Nothing to validate if no tools were called
  if (!toolResults.length) return { valid: true, mismatches: [] };

  const textAmounts = extractDollarAmounts(text);
  if (!textAmounts.length) return { valid: true, mismatches: [] };

  const toolNums = extractToolNumbers(toolResults);
  if (!toolNums.length) return { valid: true, mismatches: [] };

  const mismatches = textAmounts.filter((a) => !hasMatch(a, toolNums));
  return { valid: mismatches.length === 0, mismatches };
}
