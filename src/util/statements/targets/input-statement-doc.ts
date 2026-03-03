import { statementDoc } from "@chris-test/graph";
import type { StatementInput } from "@chris-test/fcp";

/**
 * Parse statement-doc markdown into canonical `StatementInput[]`.
 */
export function parseStatementDocInputs(raw: string): StatementInput[] {
  return statementDoc.v0.parseStatementDocToStatementInputs(raw);
}
