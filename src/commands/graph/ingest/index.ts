import { parseGraphStatementBatchJsonl } from "@fide-work/graph";
import { getStringFlag, hasFlag, parseArgs } from "../../../lib/args.js";
import { printJson, readUtf8, writeUtf8 } from "../../../lib/io.js";

function ingestHelp(): string {
  return [
    "Usage:",
    "  fide graph ingest apply --in <batch.jsonl> [--out <validated.jsonl>] [--json]",
    "  fide graph ingest replay --from <batch-root>",
    "",
    "Notes:",
    "  - apply currently performs local validation/parsing only",
    "  - replay requires graph API/indexer runtime and is not available yet",
  ].join("\n");
}

async function runIngestApply(args: string[]): Promise<number> {
  const { flags } = parseArgs(args);
  const inPath = getStringFlag(flags, "in");
  if (!inPath) {
    console.error("Missing required flag: --in <batch.jsonl>");
    return 1;
  }

  const jsonl = await readUtf8(inPath);
  const parsed = await parseGraphStatementBatchJsonl(jsonl);

  const outPath = getStringFlag(flags, "out");
  if (outPath) {
    const normalized = `${parsed.statementWires.map((wire) => JSON.stringify(wire)).join("\n")}\n`;
    await writeUtf8(outPath, normalized);
  }

  const payload = {
    ok: true,
    mode: "apply",
    root: parsed.root,
    statementCount: parsed.statementWires.length,
    ...(outPath ? { outPath } : {}),
    next: "Graph runtime apply is pending API/indexer wiring in fide-internal.",
  };

  if (hasFlag(flags, "json")) {
    printJson(payload);
  } else {
    console.log(
      `validated root=${payload.root} statementCount=${payload.statementCount}${outPath ? ` outPath=${outPath}` : ""}`,
    );
    console.log(payload.next);
  }

  return 0;
}

function runIngestReplay(args: string[]): number {
  const { flags } = parseArgs(args);
  const root = getStringFlag(flags, "from");
  if (!root) {
    console.error("Missing required flag: --from <batch-root>");
    return 1;
  }

  const payload = {
    ok: false,
    mode: "replay",
    root,
    error: "`fide graph ingest replay` is not available until graph API/indexer runtime is wired.",
  };

  if (hasFlag(flags, "json")) {
    printJson(payload);
  } else {
    console.error(payload.error);
  }

  return 1;
}

export async function runIngestCommand(command: string | undefined, args: string[]): Promise<number> {
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(ingestHelp());
    return 0;
  }

  if (command === "apply") return runIngestApply(args);
  if (command === "replay") return runIngestReplay(args);

  console.error(`Unknown ingest command: ${command}`);
  console.error(ingestHelp());
  return 1;
}
