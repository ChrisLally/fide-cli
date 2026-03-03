import { parseArgs } from "../../../lib/args.js";
import { runStatementsAdd } from "./commands/add/index.js";
import { statementsHelp } from "./commands/help.js";
import { runStatementsRoot } from "./commands/root/index.js";
import { runStatementsValidate } from "./commands/validate/index.js";

export { runInitCommand } from "./commands/init/index.js";

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
