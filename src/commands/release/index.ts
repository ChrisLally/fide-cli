import { spawnSync } from "node:child_process";

function releaseHelp(): string {
  return [
    "Usage:",
    "  fide release <target> --tag <tag> [--dry-run] [--json]",
    "",
    "Delegates to:",
    "  lally release <target> --tag <tag> [--dry-run] [--json]",
    "",
    "Examples:",
    "  fide release fumadocs --tag alpha --dry-run",
    "  fide release cli --tag alpha --dry-run --json",
  ].join("\n");
}

/**
 * @description Delegates release operations to the shared `lally` CLI.
 */
export async function runReleaseCommand(command: string | undefined, args: string[]): Promise<number> {
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(releaseHelp());
    return 0;
  }

  const lallyArgs = ["release", command, ...args];
  const result = spawnSync("lally", lallyArgs, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    console.error("Failed to run `lally`.");
    console.error("Install/link @chris-lally/cli so the `lally` command is available in PATH.");
    console.error(`Underlying error: ${result.error.message}`);
    return 1;
  }

  return result.status ?? 1;
}
