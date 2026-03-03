import { getStringFlag, parseArgs } from "../../../lib/args.js";
import { parseGraphStatementBatchJsonl } from "../../../lib/graph-batch.js";
import { readUtf8, writeUtf8 } from "../../../lib/io.js";
import { getRequiredBatchInputPath } from "./shared.js";

export async function runStatementsNormalize(args: string[]): Promise<number> {
  const { flags } = parseArgs(args);
  const inPath = getRequiredBatchInputPath(flags);
  if (!inPath) return 1;

  const raw = await readUtf8(inPath);
  const parsed = await parseGraphStatementBatchJsonl(raw);
  const normalized = parsed.statementWires.map((wire) => JSON.stringify(wire)).join("\n");
  const out = `${normalized}\n`;
  const outPath = getStringFlag(flags, "out");

  if (outPath) {
    await writeUtf8(outPath, out);
    console.log(outPath);
  } else {
    process.stdout.write(out);
  }

  return 0;
}
