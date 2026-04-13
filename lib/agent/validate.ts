/**
 * Post-response number validation.
 * Extracts dollar amounts from LLM response text and cross-checks
 * against values returned by tool calls in the same request.
 */

const DOLLAR_RE = /-?\$[\d,]+(?:\.\d{1,2})?/g;
const NUMERIC_STRING_RE = /^-?\d+(?:\.\d+)?$/;

type ValidationOptions = {
  requireAmount?: boolean;
};

/** Parse "$1,234.56" → 1234.56 */
function parseDollar(raw: string): number {
  return parseFloat(raw.replace(/[$,]/g, "").trim());
}

/** Extract all dollar amounts from response text. */
export function extractDollarAmounts(text: string): number[] {
  const matches = text.match(DOLLAR_RE);
  if (!matches) return [];
  return matches.map(parseDollar).filter((n) => !isNaN(n));
}

const MONEY_KEY_RE =
  /(amount|balance|income|gap|total|payment|interest|cash|spent|threshold)/i;
const NON_MONEY_KEY_RE = /(id|count|days|months|transactions|year)/i;

function shouldIncludeKey(key: string): boolean {
  if (NON_MONEY_KEY_RE.test(key)) return false;
  return MONEY_KEY_RE.test(key);
}

/** Recursively collect likely-money numbers from tool results. */
export function extractToolNumbers(
  obj: unknown,
  parentKey?: string,
): number[] {
  if (obj == null) return [];
  if (typeof obj === "number") {
    if (parentKey && !shouldIncludeKey(parentKey)) return [];
    return [obj];
  }
  if (Array.isArray(obj)) {
    return obj.flatMap((item) => extractToolNumbers(item, parentKey));
  }
  if (typeof obj === "object") {
    return Object.entries(obj as Record<string, unknown>).flatMap(([key, value]) =>
      extractToolNumbers(value, key),
    );
  }

  // Parse numeric strings only when they are purely numeric
  if (typeof obj === "string") {
    if (!NUMERIC_STRING_RE.test(obj.trim())) return [];
    const n = parseFloat(obj.trim());
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

function normalizeNumbers(values: number[]): number[] {
  const rounded = values.map((value) => Math.round(value * 100) / 100);
  return Array.from(new Set(rounded));
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
  options: ValidationOptions = {},
): ValidationResult {
  const textAmounts = extractDollarAmounts(text);
  if (options.requireAmount && textAmounts.length === 0) {
    return { valid: false, mismatches: [] };
  }
  if (!textAmounts.length) return { valid: true, mismatches: [] };

  // Nothing to validate against if no tools were called
  if (!toolResults.length) return { valid: false, mismatches: textAmounts };

  const toolNums = normalizeNumbers(extractToolNumbers(toolResults));
  if (!toolNums.length) return { valid: false, mismatches: textAmounts };

  const mismatches = textAmounts.filter((a) => !hasMatch(a, toolNums));
  return { valid: mismatches.length === 0, mismatches };
}

/**
 * Validate dollar amounts against an explicit set of allowed values.
 * Useful when values are computed by the harness (cron prompts) and no tools were called.
 */
export function validateNumbersAgainstExpected(
  text: string,
  expectedAmounts: number[],
  options: ValidationOptions = {},
): ValidationResult {
  const textAmounts = extractDollarAmounts(text);
  if (options.requireAmount && textAmounts.length === 0) {
    return { valid: false, mismatches: [] };
  }
  if (!textAmounts.length) return { valid: true, mismatches: [] };

  const allowed = normalizeNumbers(expectedAmounts);
  if (!allowed.length) return { valid: false, mismatches: textAmounts };

  const mismatches = textAmounts.filter((a) => !hasMatch(a, allowed));
  return { valid: mismatches.length === 0, mismatches };
}
