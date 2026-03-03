import { getStringFlag, hasFlag, parseArgs } from "../../../lib/args.js";
import { printJson, readUtf8 } from "../../../lib/io.js";
import { getRequiredBatchInputPath, parseStatementsInputFormat } from "../../../util/statements/shared.js";
import { resolveBatchFromInput } from "../../../util/statements/targets/resolve-batch.js";

export async function runStatementsValidate(args: string[]): Promise<number> {
  const { flags } = parseArgs(args);
  if (hasFlag(flags, "help")) {
    console.log("Usage: fide graph statements validate --in <input> [--format <json|jsonl|fsd>] [--json]");
    return 0;
  }
  const inPath = getRequiredBatchInputPath(flags);
  if (!inPath) return 1;
  const format = parseStatementsInputFormat(getStringFlag(flags, "format"));

  const raw = await readUtf8(inPath);
  const parsed = await resolveBatchFromInput(raw, { format });
  const payload = {
    ok: true,
    statementCount: parsed.statementCount,
    root: parsed.root,
  };

  if (hasFlag(flags, "json")) {
    printJson(payload);
  } else {
    console.log(`OK statements=${payload.statementCount} root=${payload.root}`);
  }
  return 0;
}
