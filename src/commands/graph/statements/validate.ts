import { hasFlag, parseArgs } from "../../../lib/args.js";
import { parseGraphStatementBatchJsonl } from "../../../lib/graph-batch.js";
import { printJson, readUtf8 } from "../../../lib/io.js";
import { getRequiredBatchInputPath } from "./shared.js";

export async function runStatementsValidate(args: string[]): Promise<number> {
  const { flags } = parseArgs(args);
  const inPath = getRequiredBatchInputPath(flags);
  if (!inPath) return 1;

  const raw = await readUtf8(inPath);
  const parsed = await parseGraphStatementBatchJsonl(raw);
  const payload = {
    ok: true,
    statementCount: parsed.statementWires.length,
    root: parsed.root,
  };

  if (hasFlag(flags, "json")) {
    printJson(payload);
  } else {
    console.log(`OK statements=${payload.statementCount} root=${payload.root}`);
  }
  return 0;
}
