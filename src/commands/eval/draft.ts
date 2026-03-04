import { readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { evaluateSameAsPersonV1, buildPersonV1PromptFromResult, type FideIdStatement } from "@chris-test/evaluation-methods";
import { parseGraphStatementBatchJsonl } from "@chris-test/graph";
import { getStringFlag, hasFlag, parseArgs } from "../../util/args.js";
import { printJson, readUtf8, writeUtf8 } from "../../util/io.js";

const execFileAsync = promisify(execFile);
const SUPPORTED_METHOD = "temporal-validity/owl-sameAs/Person@v1";

type EvalDraftOptions = {
  method: string;
  target: string;
  from: string | null;
  agent: string | null;
  out: string | null;
  json: boolean;
};

function sanitizePart(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function utcDatePath(now = new Date()): string {
  const y = String(now.getUTCFullYear());
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}/${m}/${d}`;
}

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function injectFrontmatterMeta(
  content: string,
  meta: {
    method: string;
    target: string;
    batch: string;
    promptFile: string;
    promptHash: string;
    agent: string;
  },
): string {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") {
    return content;
  }

  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) {
    return content;
  }

  const metaLines = [
    "meta:",
    `  method: ${quoteYaml(meta.method)}`,
    `  target: ${quoteYaml(meta.target)}`,
    `  batch: ${quoteYaml(meta.batch)}`,
    `  promptFile: ${quoteYaml(meta.promptFile)}`,
    `  promptHash: ${quoteYaml(`sha256:${meta.promptHash}`)}`,
    `  agent: ${quoteYaml(meta.agent)}`,
  ];

  const frontmatterBody = lines.slice(1, end);
  const hasMeta = frontmatterBody.some((line) => line.trimStart().startsWith("meta:"));
  const mergedBody = hasMeta ? frontmatterBody : [...frontmatterBody, ...metaLines];
  const merged = [lines[0], ...mergedBody, lines[end], ...lines.slice(end + 1)];
  return merged.join("\n");
}

async function collectJsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsonlFiles(full)));
      continue;
    }
    if (entry.isFile() && full.endsWith(".jsonl")) files.push(full);
  }

  return files;
}

async function resolveInputBatchPath(inPath: string | null): Promise<string> {
  if (inPath) return resolve(process.cwd(), inPath);

  const root = resolve(process.cwd(), ".fide", "statements");
  const candidates = await collectJsonlFiles(root);
  if (candidates.length === 0) {
    throw new Error("No statement batches found under .fide/statements. Pass --from <batch.jsonl>.");
  }

  candidates.sort();
  return candidates[candidates.length - 1]!;
}

function mapToFideIdStatements(
  statements: Awaited<ReturnType<typeof parseGraphStatementBatchJsonl>>["statements"],
  statementFideIds: string[],
): FideIdStatement[] {
  return statements.map((statement, i) => ({
    ...statement,
    statementFideId: statementFideIds[i]!,
  }));
}

function buildAgentPrompt(evalPrompt: string): string {
  return [
    "You are drafting Fide graph statements.",
    "Return ONLY a statement document in markdown-compatible text with this exact frontmatter:",
    "---",
    "type: fide-statements",
    "version: v0",
    "defaults:",
    "  subject:",
    "    source: NetworkResource",
    "  object:",
    "    source: NetworkResource",
    "---",
    "",
    "Then include one statement per line in the format:",
    "[EntityType:subjectRaw] predicate [EntityType:objectRaw]",
    "",
    "Do not include prose before or after the document.",
    "",
    "Evaluation context:",
    evalPrompt,
  ].join("\n");
}

function parseOptions(args: string[]): EvalDraftOptions {
  const { flags } = parseArgs(args);

  if (hasFlag(flags, "help")) {
    throw new Error("HELP");
  }

  const method = getStringFlag(flags, "method");
  const target = getStringFlag(flags, "target");
  if (!method) throw new Error("Missing required flag --method <id@v>.");
  if (!target) throw new Error("Missing required flag --target <statementFideId>.");

  return {
    method,
    target,
    from: getStringFlag(flags, "from"),
    agent: getStringFlag(flags, "agent"),
    out: getStringFlag(flags, "out"),
    json: hasFlag(flags, "json"),
  };
}

async function runCodexDraft(prompt: string): Promise<string> {
  const { stdout } = await execFileAsync("codex", ["exec", prompt], {
    cwd: process.cwd(),
    maxBuffer: 5 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function runEvalDraft(args: string[]): Promise<number> {
  let options: EvalDraftOptions;
  try {
    options = parseOptions(args);
  } catch (error) {
    if (error instanceof Error && error.message === "HELP") return 2;
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (options.method !== SUPPORTED_METHOD) {
    console.error(`Unsupported method: ${options.method}`);
    console.error(`Currently supported: ${SUPPORTED_METHOD}`);
    return 1;
  }

  try {
    const batchPath = await resolveInputBatchPath(options.from);
    const raw = await readUtf8(batchPath);
    const parsed = await parseGraphStatementBatchJsonl(raw);
    const statements = mapToFideIdStatements(parsed.statements, parsed.statementFideIds);

    const result = evaluateSameAsPersonV1({
      targetSameAsStatementFideId: options.target,
      statements,
    });
    const evalPrompt = buildPersonV1PromptFromResult(
      { targetSameAsStatementFideId: options.target, statements },
      result,
    );
    const agentPrompt = buildAgentPrompt(evalPrompt);

    const methodSlug = sanitizePart(options.method.replace("@", "__"));
    const targetSlug = sanitizePart(options.target);
    const defaultOut = `.fide/statement-drafts/${utcDatePath()}/${methodSlug}__${targetSlug}.md`;
    const outPath = options.out ?? defaultOut;
    const promptPath = `.fide/evals/prompts/${methodSlug}/${targetSlug}.prompt.md`;
    const promptHash = sha256Hex(agentPrompt);
    await writeUtf8(promptPath, `${agentPrompt.trimEnd()}\n`);

    let draftContent = agentPrompt;
    if (options.agent === "codex") {
      draftContent = await runCodexDraft(agentPrompt);
    } else if (options.agent) {
      throw new Error(`Unsupported agent: ${options.agent}. Supported: codex`);
    }

    const withMeta = injectFrontmatterMeta(draftContent, {
      method: options.method,
      target: options.target,
      batch: batchPath,
      promptFile: promptPath,
      promptHash,
      agent: options.agent ?? "none",
    });
    await writeUtf8(outPath, `${withMeta.trimEnd()}\n`);

    const payload = {
      ok: true,
      method: options.method,
      target: options.target,
      from: batchPath,
      agent: options.agent ?? "none",
      out: outPath,
      promptFile: promptPath,
      promptHash: `sha256:${promptHash}`,
      decision: result.decision,
      score: result.score,
      confidence: result.confidence,
      reviewRequired: result.reviewRequired,
    };

    if (options.json) {
      printJson(payload);
    } else {
      console.log(`Draft written: ${payload.out}`);
      console.log(`Method: ${payload.method}`);
      console.log(`Target: ${payload.target}`);
      console.log(`Batch: ${payload.from}`);
      console.log(`Agent: ${payload.agent}`);
      console.log(`Prompt: ${payload.promptFile}`);
      console.log(`PromptHash: ${payload.promptHash}`);
      console.log(`Decision: ${payload.decision} score=${payload.score.toFixed(4)} confidence=${payload.confidence.toFixed(4)}`);
    }

    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
