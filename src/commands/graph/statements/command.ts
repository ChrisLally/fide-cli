import { parseArgs } from "../../../util/args.js";
import { runStatementsAdd } from "./add.js";
import { statementsHelp } from "./help.js";
import { runStatementsRoot } from "./root.js";
import { runStatementsValidate } from "./validate.js";

/**
 * Route `fide graph statements <command>` subcommands.
 */
export async function runStatementCommand(command: string | undefined, args: string[]): Promise<number> {
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(statementsHelp());
    return 0;
  }

  if (command === "add") {
    const { flags } = parseArgs(args);
    return runStatementsAdd(flags);
  }

  if (command === "validate") return runStatementsValidate(args);
  if (command === "root") return runStatementsRoot(args);

  console.error(`Unknown statement command: ${command}`);
  console.error(statementsHelp());
  return 1;
}

export { runStatementCommand as runStatementsCommand };
