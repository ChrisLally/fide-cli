import { parseArgs } from "../../lib/args.js";
import { runEmitStatements } from "./emit-statements.js";
import { runPromptAtomic } from "./prompt-atomic.js";
import { runPromptCommand } from "./prompt-run.js";
import { runEval } from "./run.js";
import { runSameAsInput } from "./sameas-input.js";

function evalHelp(): string {
  return [
    "Usage:",
    "  fide eval sameas-input [--out <batch.json>] [--jsonl-out <batch.jsonl>] [--report <file.mdx>]",
    "  fide eval run --in <batch.json> [--method <method-id|identifier|key>] [--claims <comma-separated-fide-ids>] [--out <result.json>] [--report <file.mdx>] [--json]",
    "  fide eval emit-statements --in <eval-result.json> [--decision same|uncertain|different|all] [--out <batch.jsonl>] [--report <file.mdx>] [--json]",
    "  fide eval prompt-atomic --statement <owl-sameAs-statement-fide-id> [--consideration <citation_chain|explicit_contradiction|name_alignment|affiliation_overlap|valid_from_timestamp>] [--evidence-statement <statement-fide-id>] [--json]",
    "  fide eval prompt-run --prompt <file.md> [--provider groq|gemini] [--models <comma-list>] [--temps <comma-list>] [--repeats <int>] [--top-p <float>] [--max-output-tokens <int>] [--max-attempts <int>] [--backoff-ms <int>] [--pace-ms <int>] [--json]",
  ].join("\n");
}

export async function runEvalCommand(command: string | undefined, args: string[]): Promise<number> {
  if (!command || command === "--help") {
    console.log(evalHelp());
    return 0;
  }

  const { flags } = parseArgs(args);

  if (command === "sameas-input") {
    return runSameAsInput(flags);
  }

  if (command === "run") {
    return runEval(flags);
  }

  if (command === "emit-statements") {
    return runEmitStatements(flags);
  }

  if (command === "prompt-atomic") {
    return runPromptAtomic(flags);
  }

  if (command === "prompt-run") {
    return runPromptCommand(flags);
  }

  console.error(`Unknown eval command: ${command}`);
  console.error(evalHelp());
  return 1;
}
