import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { buildStatementsWithRoot, statementDoc } from "@chris-test/graph";
import { parseFideId, type StatementInput } from "@chris-test/fcp";
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
  const draftMode = hasFlag(flags, "draft");
  if (hasFlag(flags, "out")) {
    throw new Error("`graph statements add` no longer accepts --out. Output path is auto-generated.");
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
  const outPath = (() => {
    const { yyyy, mm, dd } = ymdUtc(new Date());
    if (draftMode) {
      return resolve(process.cwd(), ".fide", "statement-drafts", yyyy, mm, dd, `${batch.root}.md`);
    }
    return resolve(resolveStatementsDir(), yyyy, mm, dd, `${batch.root}.jsonl`);
  })();

  let output: string;
  if (draftMode) {
    const normalizedInputs: StatementInput[] = batch.statements.map((statement) => ({
      subject: {
        rawIdentifier: statement.subjectRawIdentifier,
        entityType: parseFideId(statement.subjectFideId).entityType,
        sourceType: parseFideId(statement.subjectFideId).sourceType,
      },
      predicate: {
        rawIdentifier: statement.predicateRawIdentifier,
        entityType: "Concept",
        sourceType: "NetworkResource",
      },
      object: {
        rawIdentifier: statement.objectRawIdentifier,
        entityType: parseFideId(statement.objectFideId).entityType,
        sourceType: parseFideId(statement.objectFideId).sourceType,
      },
    }));

    const baseDoc = statementDoc.v0.formatStatementInputsAsStatementDoc(normalizedInputs, {
      defaults: {
        subject: { sourceType: "NetworkResource" },
        object: { sourceType: "NetworkResource" },
      },
    });
    output = baseDoc.replace(/^---\n/, "---\ntype: fide-statements\nversion: v0\n");
  } else {
    const wires = batch.statements.map((statement) => ({
      s: statement.subjectFideId,
      sr: statement.subjectRawIdentifier,
      p: statement.predicateFideId,
      pr: statement.predicateRawIdentifier,
      o: statement.objectFideId,
      or: statement.objectRawIdentifier,
    }));
    output = `${wires.map((wire) => JSON.stringify(wire)).join("\n")}\n`;
  }

  await mkdir(resolve(outPath, ".."), { recursive: true });
  await writeUtf8(outPath, output);

  const payload = {
    ok: true,
    root: batch.root,
    statementCount: batch.statements.length,
    mode: draftMode ? "draft" : "batch",
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
