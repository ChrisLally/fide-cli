import { getStringFlag } from "../../../lib/args.js";

export function getRequiredBatchInputPath(flags: Map<string, string | boolean>): string | null {
  const inPath = getStringFlag(flags, "in");
  if (!inPath) {
    console.error("Missing required flag: --in <batch.jsonl>");
    return null;
  }
  return inPath;
}
