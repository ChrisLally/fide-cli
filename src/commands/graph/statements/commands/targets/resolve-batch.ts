import { buildStatementsWithRoot, parseGraphStatementBatchJsonl } from "@chris-test/graph";
import { detectStatementsInputFormat, type StatementsInputFormat } from "../shared.js";
import { parseStatementInputsByFormat } from "./parse-inputs.js";

export async function resolveBatchFromInput(
  raw: string,
  options?: { format?: StatementsInputFormat | null; normalizeRawIdentifier?: boolean },
): Promise<{ root: string; statementCount: number; format: StatementsInputFormat }> {
  const format = options?.format ?? detectStatementsInputFormat(raw);

  if (format === "jsonl") {
    const parsed = await parseGraphStatementBatchJsonl(raw);
    return { root: parsed.root, statementCount: parsed.statementWires.length, format };
  }

  const statementInputs = parseStatementInputsByFormat(raw, format);
  const batch = await buildStatementsWithRoot(statementInputs, {
    normalizeRawIdentifier: options?.normalizeRawIdentifier ?? true,
  });

  return { root: batch.root, statementCount: batch.statements.length, format };
}
