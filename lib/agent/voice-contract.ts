import fs from "node:fs";
import path from "node:path";

export interface IdentityContract {
  name?: string;
  subname?: string;
  user?: string;
  relationship?: string;
  role?: string;
}

export interface SoulContract {
  conversational: boolean;
  allowSlang: boolean;
  allowLightSwearing: boolean;
  slightlyJudgmental: boolean;
  realistic: boolean;
  noPreachy: boolean;
  shortToMedium: boolean;
  strictCoach: boolean;
}

export interface VoiceContracts {
  identityText: string;
  soulText: string;
  identity: IdentityContract;
  soul: SoulContract;
}

const DEFAULT_IDENTITY_PROMPT = "# IDENTITY.md missing. Use configured defaults if available.";
const DEFAULT_SOUL_PROMPT = "# SOUL.md missing. Keep tone concise, direct, and factual.";

function resolveContractFilePath(fileName: string): string | null {
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, fileName),
    path.resolve(cwd, "clearline", fileName),
  ];

  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

function readContractFile(fileName: string, fallback: string): string {
  const filePath = resolveContractFilePath(fileName);
  if (!filePath) {
    return fallback;
  }
  try {
    const content = fs.readFileSync(filePath, "utf8").trim();
    return content.length > 0 ? content : fallback;
  } catch {
    return fallback;
  }
}

function parseIdentity(content: string): IdentityContract {
  const identity: IdentityContract = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const cleaned = line.trim().replace(/^\s*-\s*/, "");
    const idx = cleaned.indexOf(":");
    if (idx === -1) continue;

    const key = cleaned
      .slice(0, idx)
      .replace(/[*_]/g, "")
      .trim()
      .toLowerCase();
    const value = cleaned
      .slice(idx + 1)
      .replace(/^[*_]+|[*_]+$/g, "")
      .trim();
    if (!value) continue;

    if (key === "name") identity.name = value;
    if (key === "subname") identity.subname = value;
    if (key === "user") identity.user = value;
    if (key === "relationship") identity.relationship = value;
    if (key === "role") identity.role = value;
  }
  return identity;
}

function parseSoul(content: string): SoulContract {
  const text = content.toLowerCase();
  const has = (pattern: string | RegExp) =>
    typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);

  return {
    conversational: has("conversational"),
    allowSlang: has("slang"),
    allowLightSwearing: has("light swearing") || has(/swear(ing)?/),
    slightlyJudgmental: has("judgmental") || has("call out bad money moves"),
    realistic: has("realistic"),
    noPreachy: has("never preach") || has("no preach"),
    shortToMedium: has("short text style") || has("short-to-medium") || has("short to medium"),
    strictCoach: has("strict coach") || has("strict with money"),
  };
}

export function loadVoiceContracts(): VoiceContracts {
  const identityText = readContractFile("IDENTITY.md", DEFAULT_IDENTITY_PROMPT);
  const soulText = readContractFile("SOUL.md", DEFAULT_SOUL_PROMPT);

  return {
    identityText,
    soulText,
    identity: parseIdentity(identityText),
    soul: parseSoul(soulText),
  };
}
