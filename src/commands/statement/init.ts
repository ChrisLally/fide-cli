import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { getStringFlag, hasFlag, parseArgs } from "../../lib/args.js";
import { printJson } from "../../lib/io.js";

function initHelp(): string {
  return [
    "Usage:",
    "  fide init [--dir <path>] [--json]",
  ].join("\n");
}

/**
 * @description Initializes a minimal local .fide folder structure.
 */
export async function runInitCommand(args: string[]): Promise<number> {
  if (args.includes("--help")) {
    console.log(initHelp());
    return 0;
  }

  const { flags } = parseArgs(args);
  const targetDir = getStringFlag(flags, "dir");
  const root = targetDir ? resolve(process.cwd(), targetDir) : process.cwd();

  const directories = [
    resolve(root, ".fide"),
    resolve(root, ".fide/statements"),
  ];

  for (const directory of directories) {
    await mkdir(directory, { recursive: true });
  }

  if (hasFlag(flags, "json")) {
    printJson({
      ok: true,
      root,
      created: directories,
    });
  } else {
    console.log(`Initialized .fide workspace at ${root}`);
    for (const directory of directories) {
      console.log(`- ${directory}`);
    }
  }

  return 0;
}
