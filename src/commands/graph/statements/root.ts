import { getStringFlag, hasFlag, parseArgs } from "../../../util/args.js";
import { readUtf8 } from "../../../util/io.js";
import { getRequiredBatchInputPath, parseStatementsInputFormat } from "../../../util/statements/shared.js";
import { resolveBatchFromInput } from "../../../util/statements/targets/resolve-batch.js";

export async function runStatementsRoot(args: string[]): Promise<number> {
  const { flags } = parseArgs(args);
  if (hasFlag(flags, "help")) {
    console.log("Usage: fide graph statements root --in <input> [--format <json|jsonl|fsd>]");
    return 0;
  }
  const inPath = getRequiredBatchInputPath(flags);
  if (!inPath) return 1;
  const format = parseStatementsInputFormat(getStringFlag(flags, "format"));

  const raw = await readUtf8(inPath);
  const parsed = await resolveBatchFromInput(raw, { format });
  console.log(parsed.root);
  return 0;
}
