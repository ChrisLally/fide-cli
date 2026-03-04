import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parseGraphStatementBatchJsonl, statementDoc } from "@chris-test/graph";
import { buildStatementRawIdentifier, type StatementInput } from "@chris-test/fcp";
import { getStringFlag, hasFlag, parseArgs } from "../../util/args.js";
import { printJson, readUtf8, writeUtf8 } from "../../util/io.js";

const EVAL_DECISION_IRI = "https://example.org/evaluation/decision";
const EVAL_CONFIDENCE_IRI = "https://example.org/evaluation/confidence";
const EVAL_REASON_IRI = "https://example.org/evaluation/reason";
const VALID_DECISIONS = new Set(["supports", "contradicts", "insufficient"]);

type EvalAddOptions = {
  method: string | null;
  target: string | null;
  from: string | null;
  decision: "supports" | "contradicts" | "insufficient";
  confidence: number;
  reason: string;
  json: boolean;
};

type ActiveEvalContext = {
  method?: string;
  target?: string;
  from?: string;
};

function readEnvContext(): ActiveEvalContext {
  const method = process.env.FIDE_EVAL_METHOD?.trim();
  const target = process.env.FIDE_EVAL_TARGET?.trim();
  const from = process.env.FIDE_EVAL_FROM?.trim();
  return {
    method: method && method.length > 0 ? method : undefined,
    target: target && target.length > 0 ? target : undefined,
    from: from && from.length > 0 ? from : undefined,
  };
}

function utcDatePath(now = new Date()): string {
  const y = String(now.getUTCFullYear());
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}/${m}/${d}`;
}

function slugify(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

function injectFrontmatterMeta(
  content: string,
  meta: {
    method: string;
    target: string;
    batch: string | null;
    source: string;
  },
): string {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return content;

  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return content;

  const metaLines = [
    "meta:",
    `  method: ${JSON.stringify(meta.method)}`,
    `  target: ${JSON.stringify(meta.target)}`,
    `  batch: ${JSON.stringify(meta.batch ?? "none")}`,
    `  source: ${JSON.stringify(meta.source)}`,
  ];

  const frontmatterBody = lines.slice(1, end);
  const hasMeta = frontmatterBody.some((line) => line.trimStart().startsWith("meta:"));
  const mergedBody = hasMeta ? frontmatterBody : [...frontmatterBody, ...metaLines];
  return [lines[0], ...mergedBody, lines[end], ...lines.slice(end + 1)].join("\n");
}

function parseOptions(args: string[]): EvalAddOptions {
  const { flags } = parseArgs(args);
  if (hasFlag(flags, "help")) throw new Error("HELP");

  const method = getStringFlag(flags, "method");
  const target = getStringFlag(flags, "target");
  const decisionRaw = getStringFlag(flags, "decision");
  const confidenceRaw = getStringFlag(flags, "confidence");
  const reason = getStringFlag(flags, "reason");

  if (!decisionRaw) throw new Error("Missing required flag --decision <supports|contradicts|insufficient>.");
  if (!confidenceRaw) throw new Error("Missing required flag --confidence <0..1>.");
  if (!reason) throw new Error("Missing required flag --reason <text>.");

  const decision = decisionRaw.toLowerCase();
  if (!VALID_DECISIONS.has(decision)) {
    throw new Error("Invalid --decision. Use one of: supports, contradicts, insufficient.");
  }

  const confidence = Number(confidenceRaw);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("Invalid --confidence. Use a number in [0, 1].");
  }

  return {
    method,
    target,
    from: getStringFlag(flags, "from"),
    decision: decision as EvalAddOptions["decision"],
    confidence,
    reason,
    json: hasFlag(flags, "json"),
  };
}

async function readActiveContext(): Promise<ActiveEvalContext> {
  const path = resolve(process.cwd(), ".fide/evals/.active-context.json");
  try {
    const raw = await readUtf8(path);
    const parsed = JSON.parse(raw) as ActiveEvalContext;
    return parsed ?? {};
  } catch {
    return {};
  }
}

export async function runEvalAdd(args: string[]): Promise<number> {
  try {
    const options = parseOptions(args);
    const envContext = readEnvContext();
    const active = await readActiveContext();
    const method = options.method ?? envContext.method ?? active.method ?? null;
    const target = options.target ?? envContext.target ?? active.target ?? null;
    const from = options.from ?? envContext.from ?? active.from ?? null;
    if (!method) throw new Error("Missing --method and no active context found. Run `fide eval prompt ...` first or pass --method.");
    if (!target) throw new Error("Missing --target and no active context found. Run `fide eval prompt ...` first or pass --target.");
    if (!from) throw new Error("Missing --from and no active context found. Run `fide eval prompt ...` first or pass --from.");

    const batchPath = resolve(process.cwd(), from);
    const batchRaw = await readUtf8(batchPath);
    const parsed = await parseGraphStatementBatchJsonl(batchRaw);
    const targetIndex = parsed.statementFideIds.findIndex((id) => id === target);
    if (targetIndex < 0) {
      throw new Error(`Target statement not found in batch: ${target}`);
    }
    const targetStatement = parsed.statements[targetIndex]!;
    const targetStatementRawIdentifier = buildStatementRawIdentifier(
      targetStatement.subjectFideId,
      targetStatement.predicateFideId,
      targetStatement.objectFideId,
    );

    const statements: StatementInput[] = [
      {
        subject: {
          rawIdentifier: targetStatementRawIdentifier,
          entityType: "Statement",
          sourceType: "Statement",
        },
        predicate: {
          rawIdentifier: EVAL_DECISION_IRI,
          entityType: "Concept",
          sourceType: "NetworkResource",
        },
        object: {
          rawIdentifier: options.decision,
          entityType: "TextLiteral",
          sourceType: "TextLiteral",
        },
      },
      {
        subject: {
          rawIdentifier: targetStatementRawIdentifier,
          entityType: "Statement",
          sourceType: "Statement",
        },
        predicate: {
          rawIdentifier: EVAL_CONFIDENCE_IRI,
          entityType: "Concept",
          sourceType: "NetworkResource",
        },
        object: {
          rawIdentifier: String(options.confidence),
          entityType: "DecimalLiteral",
          sourceType: "DecimalLiteral",
        },
      },
      {
        subject: {
          rawIdentifier: targetStatementRawIdentifier,
          entityType: "Statement",
          sourceType: "Statement",
        },
        predicate: {
          rawIdentifier: EVAL_REASON_IRI,
          entityType: "Concept",
          sourceType: "NetworkResource",
        },
        object: {
          rawIdentifier: options.reason,
          entityType: "TextLiteral",
          sourceType: "TextLiteral",
        },
      },
    ];

    const rawDoc = statementDoc.v0.formatStatementInputsAsStatementDoc(statements, {
      defaults: {
        subject: { sourceType: "NetworkResource" },
        object: { sourceType: "NetworkResource" },
      },
    });
    const baseDoc = rawDoc.replace(/^---\n/, "---\ntype: fide-statements\nversion: v0\n");
    const withMeta = injectFrontmatterMeta(baseDoc, {
      method,
      target,
      batch: batchPath,
      source: "eval-add",
    });

    const datePath = utcDatePath();
    const methodPath = method.split("@")[0] ?? method;
    const targetSlug = slugify(target);
    const id = shortHash(
      `${method}|${target}|${options.decision}|${options.confidence}|${options.reason}`,
    );
    const outPath = `.fide/evals/drafts/${datePath}/${methodPath}/${targetSlug}/add-${id}.md`;
    await writeUtf8(outPath, `${withMeta.trimEnd()}\n`);

    const payload = {
      ok: true,
      mode: "add",
      method,
      target,
      from: batchPath,
      outPath,
      decision: options.decision,
      confidence: options.confidence,
    };
    if (options.json) printJson(payload);
    else console.log(outPath);
    return 0;
  } catch (error) {
    if (error instanceof Error && error.message === "HELP") return 2;
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
