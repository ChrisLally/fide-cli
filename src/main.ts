function helpText(): string {
  return [
    "fide CLI",
    "",
    "Usage:",
    "  fide <group> [command] [flags]",
    "  fide init [flags]",
    "",
    "Groups:",
    "  statement   add | validate | root | normalize",
    "  graph       ingest | query",
    "  project     init",
    "  vocab       populate",
    "",
    "Global:",
    "  --json      Machine-readable output when supported",
    "  --help      Show help",
  ].join("\n");
}

export async function runCli(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(helpText());
    return 0;
  }

  const [group, command, ...rest] = argv;
  if (group === "init") {
    const initArgs = [command, ...rest].filter((value): value is string => typeof value === "string");
    const { runProjectCommand } = await import("./commands/project/index.js");
    return runProjectCommand("init", initArgs);
  }

  switch (group) {
    case "statement":
    case "statements": {
      const { runStatementCommand } = await import("./commands/statement/index.js");
      return runStatementCommand(command, rest);
    }
    case "graph":
    case "ingest":
    case "query": {
      const { runGraphCommand } = await import("./commands/graph/index.js");
      if (group === "ingest") return runGraphCommand("ingest", [command, ...rest]);
      if (group === "query") return runGraphCommand("query", [command, ...rest]);
      return runGraphCommand(command, rest);
    }
    case "project": {
      const { runProjectCommand } = await import("./commands/project/index.js");
      return runProjectCommand(command, rest);
    }
    case "vocab": {
      const { runVocabCommand } = await import("./commands/vocab/index.js");
      return runVocabCommand(command, rest);
    }
    default:
      console.error(`Unknown group: ${group}`);
      console.error("Run `fide --help` to see available commands.");
      return 1;
  }
}
