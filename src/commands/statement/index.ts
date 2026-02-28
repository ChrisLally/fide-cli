import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { buildStatementsWithRoot } from "@chris-test/fcp";
import { getStringFlag, hasFlag, parseArgs } from "../../lib/args.js";
import { parseGraphStatementBatchJsonl } from "../../lib/graph-batch.js";
import { printJson, readUtf8, writeUtf8 } from "../../lib/io.js";

type AddStatementInput = {
  subject: string;
  subjectType: string;
  subjectSource: string;
  predicate: string;
  object: string;
  objectType: string;
  objectSource: string;
};

function statementHelp(): string {
  return [
    "Usage:",
    "  fide statement add --subject <raw> --subject-type <type> --subject-source <type> --predicate <iri> --object <raw> --object-type <type> --object-source <type> [--normalize] [--out <batch.jsonl>] [--json]",
    "  fide statement add --in <inputs.json> [--normalize] [--out <batch.jsonl>] [--json]",
    "  fide statement validate --in <batch.jsonl> [--json]",
    "  fide statement root --in <batch.jsonl>",
    "  fide statement normalize --in <batch.jsonl> [--out <normalized.jsonl>]",
  ].join("\n");
}

function resolveStatementsDir(): string {
  const cwd = process.cwd();
  const fideDir = resolve(cwd, ".fide");
  if (!existsSync(fideDir)) {
    throw new Error("No .fide folder found in current directory. Run this command from your project root or run `fide init` first.");
  }
  return resolve(fideDir, "statements");
}

function ymdUtc(date: Date): { yyyy: string; mm: string; dd: string } {
  const iso = date.toISOString().slice(0, 10);
  const [yyyy, mm, dd] = iso.split("-");
  return { yyyy, mm, dd };
}

async function runAdd(flags: Map<string, string | boolean>): Promise<number> {
  const inPath = getStringFlag(flags, "in");
  const subject = getStringFlag(flags, "subject");
  const subjectType = getStringFlag(flags, "subject-type");
  const subjectSource = getStringFlag(flags, "subject-source");
  const predicate = getStringFlag(flags, "predicate");
  const object = getStringFlag(flags, "object");
  const objectType = getStringFlag(flags, "object-type");
  const objectSource = getStringFlag(flags, "object-source");
  const outPathFlag = getStringFlag(flags, "out");
  const normalize = hasFlag(flags, "normalize");

  let inputs: AddStatementInput[] = [];
  if (inPath) {
    const raw = await readUtf8(inPath);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("Invalid --in payload. Expected non-empty JSON array.");
    }
    inputs = parsed.map((item) => {
      const candidate = item as Partial<AddStatementInput>;
      if (
        !candidate.subject || !candidate.subjectType || !candidate.subjectSource ||
        !candidate.predicate || !candidate.object || !candidate.objectType || !candidate.objectSource
      ) {
        throw new Error("Invalid --in payload item. Each item must include subject/subjectType/subjectSource/predicate/object/objectType/objectSource.");
      }
      return {
        subject: candidate.subject,
        subjectType: candidate.subjectType,
        subjectSource: candidate.subjectSource,
        predicate: candidate.predicate,
        object: candidate.object,
        objectType: candidate.objectType,
        objectSource: candidate.objectSource,
      };
    });
  } else {
    if (!subject || !subjectType || !subjectSource || !predicate || !object || !objectType || !objectSource) {
      console.error("Missing required flags for `statement add`.");
      console.error(statementHelp());
      return 1;
    }
    inputs = [{
      subject,
      subjectType,
      subjectSource,
      predicate,
      object,
      objectType,
      objectSource,
    }];
  }

  const batch = await buildStatementsWithRoot(
    inputs.map((input) => ({
      subject: { rawIdentifier: input.subject, entityType: input.subjectType as any, sourceType: input.subjectSource as any },
      predicate: { rawIdentifier: input.predicate, entityType: "Concept", sourceType: "NetworkResource" },
      object: { rawIdentifier: input.object, entityType: input.objectType as any, sourceType: input.objectSource as any },
    })),
    { normalizeRawIdentifier: normalize }
  );
  const wires = batch.statements.map((statement) => ({
    s: statement.subjectFideId,
    sr: statement.subjectRawIdentifier,
    p: statement.predicateFideId,
    pr: statement.predicateRawIdentifier,
    o: statement.objectFideId,
    or: statement.objectRawIdentifier,
  }));
  const jsonl = `${wires.map((wire) => JSON.stringify(wire)).join("\n")}\n`;

  const outPath = outPathFlag
    ? resolve(process.cwd(), outPathFlag)
    : (() => {
      const { yyyy, mm, dd } = ymdUtc(new Date());
      return resolve(resolveStatementsDir(), yyyy, mm, dd, `${batch.root}.jsonl`);
    })();

  await mkdir(resolve(outPath, ".."), { recursive: true });
  await writeUtf8(outPath, jsonl);

  const payload = {
    ok: true,
    root: batch.root,
    statementCount: batch.statements.length,
    outPath,
    statementFideIds: batch.statements.map((statement) => statement.statementFideId),
  };
  if (hasFlag(flags, "json")) {
    printJson(payload);
  } else {
    console.log(outPath);
  }
  return 0;
}

export { runInitCommand } from "./init.js";

export async function runStatementCommand(command: string | undefined, args: string[]): Promise<number> {
  if (!command || command === "--help") {
    console.log(statementHelp());
    return 0;
  }

  const { flags } = parseArgs(args);
  if (command === "add") return runAdd(flags);

  const inPath = getStringFlag(flags, "in");
  if (!inPath) {
    console.error("Missing required flag: --in <batch.jsonl>");
    return 1;
  }
  const raw = await readUtf8(inPath);
  const parsed = await parseGraphStatementBatchJsonl(raw);

  switch (command) {
    case "validate": {
      const payload = {
        ok: true,
        statementCount: parsed.statementWires.length,
        root: parsed.root,
      };
      if (hasFlag(flags, "json")) {
        printJson(payload);
      } else {
        console.log(`OK statements=${payload.statementCount} root=${payload.root}`);
      }
      return 0;
    }
    case "root": {
      console.log(parsed.root);
      return 0;
    }
    case "normalize": {
      const normalized = parsed.statementWires.map((wire) => JSON.stringify(wire)).join("\n");
      const out = `${normalized}\n`;
      const outPath = getStringFlag(flags, "out");
      if (outPath) {
        await writeUtf8(outPath, out);
        console.log(outPath);
      } else {
        process.stdout.write(out);
      }
      return 0;
    }
    default:
      console.error(`Unknown statement command: ${command}`);
      console.error(statementHelp());
      return 1;
  }
}
