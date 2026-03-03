import { getStringFlag } from "../../../../lib/args.js";

export type StatementsInputFormat = "json" | "jsonl" | "fsd";

export function parseStatementsInputFormat(value: string | null): StatementsInputFormat | null {
  if (!value) return null;
  if (value === "json" || value === "jsonl" || value === "fsd") return value;
  throw new Error(`Invalid --format value: ${value}. Expected one of: json, jsonl, fsd.`);
}

export function detectStatementsInputFormat(raw: string): StatementsInputFormat {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Input payload is empty.");

  if (trimmed.startsWith("---")) return "fsd";
  if (/^\[\s*[{"]/.test(trimmed)) return "json";
  if (/^\[\s*[A-Za-z][\w-]*\s*:/.test(trimmed)) return "fsd";

  const lines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  if (lines.length > 0 && lines.every((line) => line.startsWith("{"))) {
    return "jsonl";
  }

  throw new Error("Ambiguous input format. Pass --format <json|jsonl|fsd>.");
}

export function getRequiredBatchInputPath(flags: Map<string, string | boolean>): string | null {
  const inPath = getStringFlag(flags, "in");
  if (!inPath) {
    console.error("Missing required flag: --in <input>");
    return null;
  }
  return inPath;
}
