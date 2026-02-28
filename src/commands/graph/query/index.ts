import { hasFlag, parseArgs } from "../../../lib/args.js";
import { printJson } from "../../../lib/io.js";

function queryHelp(): string {
  return [
    "Usage:",
    "  fide graph query sql --sql \"<query>\" [--json]",
    "",
    "Notes:",
    "  - direct SQL execution is disabled in this CLI",
    "  - use graph API endpoints once apps/api graph routes are wired",
  ].join("\n");
}

export async function runQueryCommand(command: string | undefined, args: string[]): Promise<number> {
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(queryHelp());
    return 0;
  }

  if (command !== "sql") {
    console.error(`Unknown graph query command: ${command}`);
    console.error(queryHelp());
    return 1;
  }

  const { flags } = parseArgs(args);
  const payload = {
    ok: false,
    command: "graph query sql",
    error: "Direct SQL query is not available in this CLI. Use graph API query endpoints.",
  };

  if (hasFlag(flags, "json")) {
    printJson(payload);
  } else {
    console.error(payload.error);
  }

  return 1;
}
