import type { StatementInput } from "@chris-test/fcp";
import type { StatementsInputFormat } from "../shared.js";
import { parseJsonInputs, mapSingleStatementInput } from "./input-json.js";
import { parseJsonlInputs } from "./input-jsonl.js";
import { parseStatementDocInputs } from "./input-statement-doc.js";

export { mapSingleStatementInput };

export function parseStatementInputsByFormat(raw: string, format: StatementsInputFormat): StatementInput[] {
  if (format === "json") return parseJsonInputs(raw);
  if (format === "jsonl") return parseJsonlInputs(raw);
  return parseStatementDocInputs(raw);
}
