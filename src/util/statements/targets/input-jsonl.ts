import type { StatementInput } from "@chris-test/fcp";
import { parseJsonInputs } from "./input-json.js";

/**
 * Parse newline-delimited JSON statement rows into `StatementInput[]`.
 */
export function parseJsonlInputs(raw: string): StatementInput[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Input payload is empty.");
  }

  const rows = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => JSON.parse(line) as unknown);

  return parseJsonInputs(JSON.stringify(rows));
}
