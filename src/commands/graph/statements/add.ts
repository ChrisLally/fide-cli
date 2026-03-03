import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { buildStatementsWithRoot } from "@chris-test/graph";
import type { StatementInput } from "@chris-test/fcp";
import { getStringFlag, hasFlag } from "../../../util/args.js";
import { printJson, readUtf8, writeUtf8 } from "../../../util/io.js";
import { statementsHelp } from "./help.js";
import {
  detectStatementsInputFormat,
  parseStatementsInputFormat,
} from "../../../util/statements/shared.js";
import { mapSingleStatementInput, parseStatementInputsByFormat } from "../../../util/statements/targets/parse-inputs.js";

/**
 * Resolve project statements output directory under `.fide/statements`.
 */
function resolveStatementsDir(): string {
  const cwd = process.cwd();
  const fideDir = resolve(cwd, ".fide");
  if (!existsSync(fideDir)) {
    throw new Error("No .fide folder found in current directory. Run this command from your project root or run `fide init` first.");
  }
  return resolve(fideDir, "statements");
}

/**
 * Format a date as UTC year/month/day path segments.
 */
function ymdUtc(date: Date): { yyyy: string; mm: string; dd: string } {
  const iso = date.toISOString().slice(0, 10);
  const [yyyy, mm, dd] = iso.split("-");
  return { yyyy, mm, dd };
}

/**
 * Read all UTF-8 content from stdin.
 */
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

/**
 * Build a statements batch and write it to `.fide/statements/YYYY/MM/DD/<root>.jsonl`.
 */
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
  const formatFlag = parseStatementsInputFormat(getStringFlag(flags, "format"));
  const normalize = !hasFlag(flags, "no-normalize");
  if (hasFlag(flags, "out")) {
    throw new Error("`--out` is not supported for `graph statements add`. Output is always written under .fide/statements/YYYY/MM/DD/<root>.jsonl.");
  }

  let statementInputs: StatementInput[] = [];
  if (inPath && useStdin) {
    throw new Error("Use either --in or --stdin, not both.");
  }

  if (inPath) {
    const raw = await readUtf8(inPath);
    const format = formatFlag ?? detectStatementsInputFormat(raw);
    statementInputs = parseStatementInputsByFormat(raw, format);
  } else if (useStdin) {
    const raw = await readStdinUtf8();
    const format = formatFlag ?? detectStatementsInputFormat(raw);
    statementInputs = parseStatementInputsByFormat(raw, format);
  } else {
    if (!subject || !subjectType || !subjectSource || !predicate || !object || !objectType || !objectSource) {
      console.error("Missing required flags for `graph statements add`.");
      console.error(statementsHelp());
      return 1;
    }
    statementInputs = [mapSingleStatementInput({
      subject,
      subjectType,
      subjectSource,
      predicate,
      object,
      objectType,
      objectSource,
    })];
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

  const outPath = (() => {
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
