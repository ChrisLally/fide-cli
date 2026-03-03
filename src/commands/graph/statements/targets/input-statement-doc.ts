import { statementDoc } from "@chris-test/graph";
import type { StatementInput } from "@chris-test/fcp";

export function parseStatementDocInputs(raw: string): StatementInput[] {
  return statementDoc.v0.parseStatementDocToStatementInputs(raw);
}
