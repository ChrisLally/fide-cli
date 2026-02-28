import { runIngestCommand } from "./ingest/index.js";
import { runQueryCommand } from "./query/index.js";

function graphHelp(): string {
  return [
    "Usage:",
    "  fide graph ingest <apply|replay> [flags]",
    "  fide graph query sql --sql \"<query>\" [--json] [--allow-write]",
    "",
    "Compatibility aliases:",
    "  fide ingest <apply|replay> [flags]",
    "  fide query sql --sql \"<query>\" [--json] [--allow-write]",
  ].join("\n");
}

export async function runGraphCommand(command: string | undefined, args: string[]): Promise<number> {
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(graphHelp());
    return 0;
  }

  const [subcommand, ...rest] = args;

  if (command === "ingest") {
    return runIngestCommand(subcommand, rest);
  }

  if (command === "query") {
    return runQueryCommand(subcommand, rest);
  }

  console.error(`Unknown graph command: ${command}`);
  console.error(graphHelp());
  return 1;
}
