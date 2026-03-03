import { runIngestCommand } from "./ingest/index.js";
import { runQueryCommand } from "./query/index.js";
import { runStatementsCommand } from "./statements/command.js";

function graphHelp(): string {
  return [
    "Usage:",
    "  fide graph ingest <apply|replay> [flags]",
    "  fide graph query sql --sql \"<query>\" [--json] [--allow-write]",
    "  fide graph statements <add|validate|root> [flags]",
  ].join("\n");
}

/**
 * Route `fide graph <command>` subcommands.
 */
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

  if (command === "statements") {
    return runStatementsCommand(subcommand, rest);
  }

  console.error(`Unknown graph command: ${command}`);
  console.error(graphHelp());
  return 1;
}
