import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { buildStatementsWithRoot, fsd } from "@chris-test/graph";
import type { StatementInput } from "@chris-test/fcp";
import { getStringFlag, hasFlag } from "../../../lib/args.js";
import { printJson, readUtf8, writeUtf8 } from "../../../lib/io.js";
import { statementsHelp } from "./help.js";

type AddStatementInput = {
  subject: string;
  subjectType: string;
  subjectSource: string;
  predicate: string;
  object: string;
  objectType: string;
  objectSource: string;
};

type AddInputFormat = "json" | "jsonl" | "fsd";

function parseAddInputFormat(value: string | null): AddInputFormat | null {
  if (!value) return null;
  if (value === "json" || value === "jsonl" || value === "fsd") return value;
  throw new Error(`Invalid --format value: ${value}. Expected one of: json, jsonl, fsd.`);
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

async function readStdinUtf8(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
    } else {
      chunks.push(chunk);
    }
  }

  return Buffer.concat(chunks).toString("utf8");
}

function normalizeAddInputs(parsed: unknown): AddStatementInput[] {
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Invalid input payload. Expected non-empty array of statement inputs.");
  }

  return parsed.map((item) => {
    const candidate = item as Partial<AddStatementInput>;
    if (
      !candidate.subject || !candidate.subjectType || !candidate.subjectSource ||
      !candidate.predicate || !candidate.object || !candidate.objectType || !candidate.objectSource
    ) {
      throw new Error("Invalid input item. Each item must include subject/subjectType/subjectSource/predicate/object/objectType/objectSource.");
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
}

function mapAddInputsToStatementInputs(inputs: AddStatementInput[]): StatementInput[] {
  return inputs.map((input) => ({
    subject: {
      rawIdentifier: input.subject,
      entityType: input.subjectType as StatementInput["subject"]["entityType"],
      sourceType: input.subjectSource as StatementInput["subject"]["sourceType"],
    },
    predicate: {
      rawIdentifier: input.predicate,
      entityType: "Concept",
      sourceType: "NetworkResource",
    },
    object: {
      rawIdentifier: input.object,
      entityType: input.objectType as StatementInput["object"]["entityType"],
      sourceType: input.objectSource as StatementInput["object"]["sourceType"],
    },
  }));
}

function parseJsonInputs(raw: string): StatementInput[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Input payload is empty.");
  }

  const parsed = JSON.parse(trimmed) as unknown;
  return mapAddInputsToStatementInputs(normalizeAddInputs(parsed));
}

function parseJsonlInputs(raw: string): StatementInput[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Input payload is empty.");
  }
  const rows = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => JSON.parse(line) as unknown);
  return mapAddInputsToStatementInputs(normalizeAddInputs(rows));
}

function detectAddInputFormat(raw: string): AddInputFormat {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Input payload is empty.");

  if (trimmed.startsWith("---")) return "fsd";
  if (/^\[\s*[{"]/.test(trimmed)) return "json";
  if (/^\[\s*[A-Za-z][\w-]*\s*:/.test(trimmed)) return "fsd";

  const lines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  if (lines.length > 0 && lines.every((line) => line.startsWith("{"))) {
    return "jsonl";
  }

  throw new Error("Ambiguous input format. Pass --format <json|jsonl|fsd>.");
}

function parseAddInputsByFormat(raw: string, format: AddInputFormat): StatementInput[] {
  if (format === "json") return parseJsonInputs(raw);
  if (format === "jsonl") return parseJsonlInputs(raw);
  return fsd.parseFsdToStatementInputs(raw);
}

export async function runStatementsAdd(flags: Map<string, string | boolean>): Promise<number> {
  const inPath = getStringFlag(flags, "in");
  const useStdin = hasFlag(flags, "stdin");
  const subject = getStringFlag(flags, "subject");
  const subjectType = getStringFlag(flags, "subject-type");
  const subjectSource = getStringFlag(flags, "subject-source");
  const predicate = getStringFlag(flags, "predicate");
  const object = getStringFlag(flags, "object");
  const objectType = getStringFlag(flags, "object-type");
  const objectSource = getStringFlag(flags, "object-source");
  const formatFlag = parseAddInputFormat(getStringFlag(flags, "format"));
  const outPathFlag = getStringFlag(flags, "out");
  const normalize = !hasFlag(flags, "no-normalize");

  let statementInputs: StatementInput[] = [];
  if (inPath && useStdin) {
    throw new Error("Use either --in or --stdin, not both.");
  }

  if (inPath) {
    const raw = await readUtf8(inPath);
    const format = formatFlag ?? detectAddInputFormat(raw);
    statementInputs = parseAddInputsByFormat(raw, format);
  } else if (useStdin) {
    const raw = await readStdinUtf8();
    const format = formatFlag ?? detectAddInputFormat(raw);
    statementInputs = parseAddInputsByFormat(raw, format);
  } else {
    if (!subject || !subjectType || !subjectSource || !predicate || !object || !objectType || !objectSource) {
      console.error("Missing required flags for `graph statements add`.");
      console.error(statementsHelp());
      return 1;
    }
    statementInputs = mapAddInputsToStatementInputs([
      {
        subject,
        subjectType,
        subjectSource,
        predicate,
        object,
        objectType,
        objectSource,
      },
    ]);
  }

  const batch = await buildStatementsWithRoot(statementInputs, { normalizeRawIdentifier: normalize });
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
