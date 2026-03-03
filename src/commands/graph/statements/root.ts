import { parseArgs } from "../../../lib/args.js";
import { parseGraphStatementBatchJsonl } from "../../../lib/graph-batch.js";
import { readUtf8 } from "../../../lib/io.js";
import { getRequiredBatchInputPath } from "./shared.js";

export async function runStatementsRoot(args: string[]): Promise<number> {
  const { flags } = parseArgs(args);
  const inPath = getRequiredBatchInputPath(flags);
  if (!inPath) return 1;

  const raw = await readUtf8(inPath);
  const parsed = await parseGraphStatementBatchJsonl(raw);
  console.log(parsed.root);
  return 0;
}
