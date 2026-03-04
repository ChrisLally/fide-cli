import { evalHelp } from "./help.js";
import { runEvalAdd } from "./add.js";
import { runEvalPrompt } from "./prompt.js";

/**
 * Route `fide eval <command>` subcommands.
 */
export async function runEvalCommand(command: string | undefined, args: string[]): Promise<number> {
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(evalHelp());
    return 0;
  }

  if (command === "prompt") {
    const code = await runEvalPrompt(args);
    if (code === 2) {
      console.log(evalHelp());
      return 0;
    }
    return code;
  }

  if (command === "add") {
    const code = await runEvalAdd(args);
    if (code === 2) {
      console.log(evalHelp());
      return 0;
    }
    return code;
  }

  console.error(`Unknown eval command: ${command}`);
  console.error(evalHelp());
  return 1;
}
