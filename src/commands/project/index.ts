import { runInitCommand } from "../statement/init.js";

function projectHelp(): string {
  return [
    "Usage:",
    "  fide project init [--dir <path>] [--json]",
    "",
    "Aliases:",
    "  fide init [--dir <path>] [--json]",
  ].join("\n");
}

export async function runProjectCommand(command: string | undefined, args: string[]): Promise<number> {
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(projectHelp());
    return 0;
  }

  if (command === "init") {
    return runInitCommand(args);
  }

  console.error(`Unknown project command: ${command}`);
  console.error(projectHelp());
  return 1;
}
