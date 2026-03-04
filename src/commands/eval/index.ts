import { runEvalDraft } from "./draft.js";
import { evalHelp } from "./help.js";

/**
 * Route `fide eval <command>` subcommands.
 */
export async function runEvalCommand(command: string | undefined, args: string[]): Promise<number> {
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(evalHelp());
    return 0;
  }

  if (command === "draft") {
    const code = await runEvalDraft(args);
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
