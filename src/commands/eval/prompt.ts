import { readdir } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  buildStatementRawIdentifier,
  compactPredicateRawIdentifier,
  parseFideId,
} from "@chris-test/fcp";
import { parseGraphStatementBatchJsonl } from "@chris-test/graph";
import type { FideIdStatement } from "@chris-test/evaluation-methods";
import { getStringFlag, hasFlag, parseArgs } from "../../util/args.js";
import { printJson, readUtf8, writeUtf8 } from "../../util/io.js";

const execFileAsync = promisify(execFile);

const OWL_SAME_AS_IRI = "https://www.w3.org/2002/07/owl#sameAs";
const OWL_DIFFERENT_FROM_IRI = "https://www.w3.org/2002/07/owl#differentFrom";
const SCHEMA_VALID_FROM_IRI = "https://schema.org/validFrom";
const SCHEMA_VALID_THROUGH_IRI = "https://schema.org/validThrough";
const PROV_HAD_PRIMARY_SOURCE_IRI = "https://www.w3.org/ns/prov#hadPrimarySource";
const SCHEMA_NAME_IRI = "https://schema.org/name";

const PERSON_AFFILIATION_PREDICATES = new Set([
  "https://schema.org/worksFor",
  "https://schema.org/memberOf",
  "https://schema.org/affiliation",
]);

const METHOD_TARGET_TYPES = {
  "temporal-validity/owl-sameAs/Person@v1": "Person",
  "temporal-validity/owl-sameAs/Concept@v1": "Concept",
} as const;
type SupportedMethod = keyof typeof METHOD_TARGET_TYPES;

type AtomicConsideration =
  | "citation_chain"
  | "explicit_contradiction"
  | "name_alignment"
  | "affiliation_overlap"
  | "valid_from_timestamp";

const ALL_ATOMIC_CONSIDERATIONS: AtomicConsideration[] = [
  "citation_chain",
  "explicit_contradiction",
  "name_alignment",
  "affiliation_overlap",
  "valid_from_timestamp",
];

function considerationSourceUrl(method: SupportedMethod, consideration: AtomicConsideration): string | null {
  if (!method.startsWith("temporal-validity/owl-sameAs/")) return null;

  const base = "https://github.com/ChrisLally/evaluation-methods/blob/main/temporal-validity/owl-sameAs/v1";
  const fileByConsideration: Record<AtomicConsideration, string> = {
    citation_chain: "objective/citation-chain.ts",
    explicit_contradiction: "objective/explicit-contradiction.ts",
    name_alignment: "heuristic/name-alignment.ts",
    affiliation_overlap: "heuristic/affiliation-overlap.ts",
    valid_from_timestamp: "buildValidityIntervals.ts",
  };

  return `${base}/${fileByConsideration[consideration]}`;
}

type PromptAtomicOptions = {
  method: SupportedMethod;
  target: string;
  from: string | null;
  consideration: AtomicConsideration | null;
  evidenceStatement: string | null;
  agent: string | null;
  draft: boolean;
  stream: boolean;
  json: boolean;
};

function utcDatePath(now = new Date()): string {
  const y = String(now.getUTCFullYear());
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}/${m}/${d}`;
}

function slugify(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function shortFideSuffix(fideId: string): string {
  const m = fideId.match(/0x([a-f0-9]{40})$/i);
  if (!m) return slugify(fideId).slice(-12);
  return m[1]!.slice(-12);
}

function normalizeAtomicConsideration(value: string | null): AtomicConsideration | null {
  if (!value) return null;
  return (ALL_ATOMIC_CONSIDERATIONS as string[]).includes(value)
    ? (value as AtomicConsideration)
    : null;
}

async function collectJsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectJsonlFiles(full)));
    else if (entry.isFile() && full.endsWith(".jsonl")) files.push(full);
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

function matchesStatementReference(statement: FideIdStatement, target: FideIdStatement): boolean {
  const raw = buildStatementRawIdentifier(target.subjectFideId, target.predicateFideId, target.objectFideId);
  return (
    statement.subjectFideId === target.statementFideId ||
    statement.subjectRawIdentifier === target.statementFideId ||
    statement.subjectRawIdentifier === raw
  );
}

function toFideTypeCurie(entityType: string): string {
  return `fide:${entityType}`;
}

function statementTextBlock(
  statement: FideIdStatement,
  sectionByStatementRef: Map<string, string>,
): string {
  const subject = (() => {
    try {
      return parseFideId(statement.subjectFideId as `did:fide:0x${string}`);
    } catch {
      return { entityType: "Unknown", sourceType: "Unknown" };
    }
  })();
  const object = (() => {
    try {
      return parseFideId(statement.objectFideId as `did:fide:0x${string}`);
    } catch {
      return { entityType: "Unknown", sourceType: "Unknown" };
    }
  })();

  const subjectPhrase = subject.entityType === "Statement"
    ? "fide:Statement"
    : `${toFideTypeCurie(subject.entityType)} (source ${toFideTypeCurie(subject.sourceType)})`;
  const objectPhrase = `${toFideTypeCurie(object.entityType)} (source ${toFideTypeCurie(object.sourceType)})`;
  const subjectRef =
    sectionByStatementRef.get(statement.subjectRawIdentifier) ??
    sectionByStatementRef.get(statement.subjectFideId) ??
    statement.subjectRawIdentifier;
  const subjectValue = subjectRef.startsWith("Statement:") ? `section: ${subjectRef}` : subjectRef;

  return [
    `- subject (${subjectPhrase}): ${subjectValue}`,
    `- predicate: ${compactPredicateRawIdentifier(statement.predicateRawIdentifier)}`,
    `- object (${objectPhrase}): ${statement.objectRawIdentifier}`,
  ].join("\n");
}

function buildDefinitionsMarkdown(consideration: AtomicConsideration): string[] {
  const base = [
    "### owl:sameAs",
    "- kind: predicate",
    "- definition: Indicates two identifiers refer to the same entity.",
    "",
    "### schema:validFrom",
    "- kind: predicate",
    "- definition: The date/time from which a statement is valid.",
  ];

  if (consideration === "citation_chain") {
    return [
      ...base,
      "",
      "### prov:hadPrimarySource",
      "- kind: predicate",
      "- definition: Links a statement to primary-source evidence.",
    ];
  }

  if (consideration === "explicit_contradiction") {
    return [
      ...base,
      "",
      "### owl:differentFrom",
      "- kind: predicate",
      "- definition: Indicates two identifiers refer to different entities.",
    ];
  }

  if (consideration === "name_alignment") {
    return [
      ...base,
      "",
      "### schema:name",
      "- kind: predicate",
      "- definition: The name of an item.",
    ];
  }

  if (consideration === "affiliation_overlap") {
    return [
      ...base,
      "",
      "### schema:worksFor",
      "- kind: predicate",
      "- definition: Organization that a person works for.",
      "",
      "### schema:memberOf",
      "- kind: predicate",
      "- definition: Indicates membership in an organization.",
      "",
      "### schema:affiliation",
      "- kind: predicate",
      "- definition: Indicates affiliation with an organization.",
    ];
  }

  return base;
}

function buildPrimarySourceReportLines(
  evidence: FideIdStatement,
  contextStatements: FideIdStatement[],
): string[] {
  if (evidence.predicateRawIdentifier !== PROV_HAD_PRIMARY_SOURCE_IRI) {
    return ["none"];
  }
  const reportStatements = contextStatements.filter(
    (statement) =>
      statement.subjectFideId === evidence.objectFideId ||
      statement.subjectRawIdentifier === evidence.objectRawIdentifier,
  );
  if (reportStatements.length === 0) return ["none"];

  const first = (predicateRawIdentifier: string): string | null =>
    reportStatements.find((statement) => statement.predicateRawIdentifier === predicateRawIdentifier)?.objectRawIdentifier ?? null;
  const all = (predicateRawIdentifier: string): string[] =>
    reportStatements
      .filter((statement) => statement.predicateRawIdentifier === predicateRawIdentifier)
      .map((statement) => statement.objectRawIdentifier);

  const name = first(SCHEMA_NAME_IRI);
  const version = first("https://schema.org/version");
  const description = first("https://schema.org/description");
  const basedOn = all("https://schema.org/isBasedOn");

  const lines: string[] = [];
  if (name) lines.push(`schema:name: "${name}"`);
  if (version) lines.push(`schema:version: "${version}"`);
  if (description) lines.push(`schema:description: "${description.replace(/"/g, '\\"')}"`);
  if (basedOn.length > 0) {
    lines.push("schema:isBasedOn:");
    for (const iri of basedOn) lines.push(`  - "${iri}"`);
  }
  return lines.length > 0 ? lines : ["none"];
}

function buildPromptContextStatements(target: FideIdStatement, allStatements: FideIdStatement[]): FideIdStatement[] {
  const validTemporal = allStatements.filter(
    (statement) =>
      (statement.predicateRawIdentifier === SCHEMA_VALID_FROM_IRI ||
        statement.predicateRawIdentifier === SCHEMA_VALID_THROUGH_IRI) &&
      matchesStatementReference(statement, target),
  );

  const validTemporalSet = new Set(validTemporal.map((statement) => statement.statementFideId));
  const validTemporalRawSet: Set<string> = new Set(
    validTemporal.map((statement) =>
      buildStatementRawIdentifier(
        statement.subjectFideId as `did:fide:0x${string}`,
        statement.predicateFideId as `did:fide:0x${string}`,
        statement.objectFideId as `did:fide:0x${string}`,
      ),
    ),
  );

  const citations = allStatements.filter(
    (statement) =>
      statement.predicateRawIdentifier === PROV_HAD_PRIMARY_SOURCE_IRI &&
      (validTemporalSet.has(statement.subjectFideId) ||
        validTemporalSet.has(statement.subjectRawIdentifier) ||
        validTemporalRawSet.has(statement.subjectRawIdentifier) ||
        matchesStatementReference(statement, target)),
  );

  const names = allStatements.filter(
    (statement) =>
      statement.predicateRawIdentifier === SCHEMA_NAME_IRI &&
      (statement.subjectFideId === target.subjectFideId || statement.subjectFideId === target.objectFideId),
  );

  const affiliations = allStatements.filter(
    (statement) =>
      PERSON_AFFILIATION_PREDICATES.has(statement.predicateRawIdentifier) &&
      (statement.subjectFideId === target.subjectFideId || statement.subjectFideId === target.objectFideId),
  );

  const contradictions = allStatements.filter(
    (statement) =>
      statement.predicateRawIdentifier === OWL_DIFFERENT_FROM_IRI &&
      ((statement.subjectFideId === target.subjectFideId && statement.objectFideId === target.objectFideId) ||
        (statement.subjectFideId === target.objectFideId && statement.objectFideId === target.subjectFideId)),
  );

  const map = new Map<string, FideIdStatement>();
  [target, ...validTemporal, ...citations, ...names, ...affiliations, ...contradictions].forEach((statement) =>
    map.set(statement.statementFideId, statement),
  );
  return [...map.values()];
}

function pickAtomicEvidencePool(
  consideration: AtomicConsideration,
  target: FideIdStatement,
  contextStatements: FideIdStatement[],
): FideIdStatement[] {
  if (consideration === "citation_chain") {
    return contextStatements.filter((statement) => statement.predicateRawIdentifier === PROV_HAD_PRIMARY_SOURCE_IRI);
  }
  if (consideration === "explicit_contradiction") {
    return contextStatements.filter((statement) => statement.predicateRawIdentifier === OWL_DIFFERENT_FROM_IRI);
  }
  if (consideration === "name_alignment") {
    return contextStatements.filter((statement) => statement.predicateRawIdentifier === SCHEMA_NAME_IRI);
  }
  if (consideration === "affiliation_overlap") {
    return contextStatements.filter((statement) => PERSON_AFFILIATION_PREDICATES.has(statement.predicateRawIdentifier));
  }
  return contextStatements.filter(
    (statement) =>
      statement.predicateRawIdentifier === SCHEMA_VALID_FROM_IRI &&
      matchesStatementReference(statement, target),
  );
}

function pickAtomicRequiredAnchor(
  consideration: AtomicConsideration,
  target: FideIdStatement,
  evidence: FideIdStatement,
  contextStatements: FideIdStatement[],
): FideIdStatement[] {
  const targetValidFrom = contextStatements
    .filter((statement) => statement.predicateRawIdentifier === SCHEMA_VALID_FROM_IRI && matchesStatementReference(statement, target))
    .sort((a, b) => a.statementFideId.localeCompare(b.statementFideId));
  const nearestValidFrom = targetValidFrom[0] ?? null;

  if (consideration === "valid_from_timestamp") return [evidence];
  if (consideration === "citation_chain") {
    const direct = contextStatements.find(
      (statement) =>
        statement.statementFideId === evidence.subjectFideId &&
        statement.predicateRawIdentifier === SCHEMA_VALID_FROM_IRI,
    );
    if (direct) return [direct];
  }
  if (nearestValidFrom) return [nearestValidFrom];
  return [];
}

function buildAtomicPrompt(args: {
  target: FideIdStatement;
  consideration: AtomicConsideration;
  evidence: FideIdStatement;
  supportingStatements: FideIdStatement[];
  contextStatements: FideIdStatement[];
  definitionsMarkdownLines: string[];
}): string {
  const anchorValidity = args.supportingStatements[0] ?? null;
  const targetSection = "Statement: Target owl:sameAs";
  const anchorSection = "Statement: Anchor schema:validFrom";
  const evidenceSection = "Statement: Evidence under review";

  const sectionByStatementRef = new Map<string, string>();
  sectionByStatementRef.set(args.target.statementFideId, targetSection);
  sectionByStatementRef.set(
    buildStatementRawIdentifier(args.target.subjectFideId, args.target.predicateFideId, args.target.objectFideId),
    targetSection,
  );
  if (anchorValidity) {
    sectionByStatementRef.set(anchorValidity.statementFideId, anchorSection);
    sectionByStatementRef.set(
      buildStatementRawIdentifier(anchorValidity.subjectFideId, anchorValidity.predicateFideId, anchorValidity.objectFideId),
      anchorSection,
    );
  }

  const anchorValidityLine = anchorValidity ? statementTextBlock(anchorValidity, sectionByStatementRef) : "- none";
  const reportLines = buildPrimarySourceReportLines(args.evidence, args.contextStatements);
  const hasAnchorSection = anchorValidityLine.trim() !== "- none";
  const hasPrimarySourceReport = !(reportLines.length === 1 && reportLines[0] === "none");

  const lines = [
    "# Atomic Evidence Check",
    "",
    "## Introduction",
    "- You are reading an atomic evidence-evaluation prompt for one owl:sameAs validity decision.",
    "- Your goal is to evaluate exactly one evidence statement against one consideration for the anchor schema:validFrom statement.",
    "- The statement chain is: target owl:sameAs statement -> anchor schema:validFrom statement -> evidence statement under review.",
    "- All inputs are provided as subject-predicate-object triples and report attributes.",
    "",
    "## Definitions",
    ...args.definitionsMarkdownLines,
    "",
    "## Task",
    "Evaluate one evidence statement for one consideration.",
    "- schema:validFrom is the real-world validity start for the owl:sameAs claim.",
    "- provenance/observation timestamps are separate from schema:validFrom.",
    "",
    `## ${targetSection}`,
    statementTextBlock(args.target, sectionByStatementRef),
    "",
    "## Consideration",
    `- ${args.consideration}`,
    "",
    `## ${evidenceSection}`,
    statementTextBlock(args.evidence, sectionByStatementRef),
    "",
    "## Draft Command",
    "- Write the evaluation draft directly with CLI:",
    "```bash",
    "fide eval add \\",
    "  --decision <supports|contradicts|insufficient> \\",
    "  --confidence <0..1> \\",
    "  --reason \"<short evidence-grounded rationale>\"",
    "```",
    "",
    "## Rules",
    "- Use only the statements in this prompt.",
    "- Evaluate this one evidence statement only.",
    "- Do not make an overall identity decision here.",
    "- Do not invent facts beyond the provided statements.",
  ];

  if (hasAnchorSection) {
    lines.splice(
      lines.indexOf(`## ${evidenceSection}`),
      0,
      `## ${anchorSection}`,
      anchorValidityLine,
      "",
    );
  }

  if (hasPrimarySourceReport) {
    lines.splice(
      lines.indexOf("## Draft Command"),
      0,
      "## Primary Source Report",
      "```",
      ...reportLines,
      "```",
      "",
    );
  }

  return lines.join("\n");
}

function defaultEvalPromptAtomicOutPath(params: {
  method: SupportedMethod;
  consideration: AtomicConsideration;
  targetStatementFideId: string;
  evidenceStatementFideId: string;
}): string {
  const datePath = utcDatePath();
  const statementSlug = slugify(params.targetStatementFideId);
  const evidenceShort = shortFideSuffix(params.evidenceStatementFideId);
  const methodPath = params.method.split("@")[0]!;
  return [
    ".fide/evals/prompts",
    datePath,
    methodPath,
    statementSlug,
    `${params.consideration}--${evidenceShort}.md`,
  ].join("/");
}

function buildAgentPrompt(evalPrompt: string): string {
  return [
    "You are executing a Fide evaluation draft task.",
    "Run exactly one CLI command to create the draft.",
    "",
    "Rules:",
    "- Use `fide eval add` (not `fide graph statements add`).",
    "- Use decision values: supports | contradicts | insufficient.",
    "- Confidence must be a decimal in [0,1].",
    "- Reason must be short and evidence-grounded.",
    "- Context values (method/target/from) are provided via env vars in this process.",
    "- Do not ask for additional input.",
    "- After running the command, output one short confirmation line only.",
    "",
    "Evaluation context:",
    evalPrompt,
    "",
    "Run this command template:",
    "fide eval add --decision <supports|contradicts|insufficient> --confidence <0..1> --reason \"<short evidence-grounded rationale>\" --json",
  ].join("\n");
}

async function runCodexDraft(
  prompt: string,
  context: {
    method: string;
    target: string;
    from: string;
    consideration: AtomicConsideration;
    evidenceStatement: string;
    promptFile: string;
    considerationRef: string | null;
  },
  stream: boolean,
): Promise<void> {
  if (stream) {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn("codex", ["exec", prompt], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          FIDE_EVAL_METHOD: context.method,
          FIDE_EVAL_TARGET: context.target,
          FIDE_EVAL_FROM: context.from,
          FIDE_EVAL_CONSIDERATION: context.consideration,
          FIDE_EVAL_EVIDENCE_STATEMENT: context.evidenceStatement,
          FIDE_EVAL_PROMPT_FILE: context.promptFile,
          FIDE_EVAL_CONSIDERATION_REF: context.considerationRef ?? "",
        },
        stdio: "inherit",
      });

      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolvePromise();
        else reject(new Error(`codex exited with code ${code ?? "unknown"}`));
      });
    });
    return;
  }

  await execFileAsync("codex", ["exec", prompt], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FIDE_EVAL_METHOD: context.method,
      FIDE_EVAL_TARGET: context.target,
      FIDE_EVAL_FROM: context.from,
      FIDE_EVAL_CONSIDERATION: context.consideration,
      FIDE_EVAL_EVIDENCE_STATEMENT: context.evidenceStatement,
      FIDE_EVAL_PROMPT_FILE: context.promptFile,
      FIDE_EVAL_CONSIDERATION_REF: context.considerationRef ?? "",
    },
    maxBuffer: 5 * 1024 * 1024,
  });
}

async function collectFilesWithExt(dir: string, ext: string): Promise<string[]> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFilesWithExt(full, ext)));
    } else if (entry.isFile() && full.endsWith(ext)) {
      files.push(full);
    }
  }
  return files;
}

function parseOptions(args: string[]): PromptAtomicOptions {
  const { flags } = parseArgs(args);
  if (hasFlag(flags, "help")) {
    throw new Error("HELP");
  }
  const methodRaw = getStringFlag(flags, "method") ?? "temporal-validity/owl-sameAs/Person@v1";
  if (!(methodRaw in METHOD_TARGET_TYPES)) {
    throw new Error(
      `Unsupported --method: ${methodRaw}. Supported: ${Object.keys(METHOD_TARGET_TYPES).join(", ")}`,
    );
  }
  const method = methodRaw as SupportedMethod;
  const target = getStringFlag(flags, "target");
  if (!target) throw new Error("Missing required flag --target <owl-sameAs-statement-fide-id>.");

  const rawConsideration = getStringFlag(flags, "consideration");
  const consideration = normalizeAtomicConsideration(rawConsideration);
  if (rawConsideration && !consideration) {
    throw new Error(
      "Invalid --consideration. Use one of: citation_chain, explicit_contradiction, name_alignment, affiliation_overlap, valid_from_timestamp.",
    );
  }
  if (getStringFlag(flags, "evidence-statement") && !consideration) {
    throw new Error("--evidence-statement requires --consideration.");
  }
  const agent = getStringFlag(flags, "agent");
  const draft = hasFlag(flags, "draft");
  const stream = hasFlag(flags, "stream");
  if (draft && !agent) {
    throw new Error("--draft requires --agent <codex>.");
  }
  if (agent && !draft) {
    throw new Error("--agent requires --draft. Use --draft to write statement-doc drafts.");
  }
  if (stream && !agent) {
    throw new Error("--stream requires --agent <codex>.");
  }

  return {
    method,
    target,
    from: getStringFlag(flags, "from"),
    consideration,
    evidenceStatement: getStringFlag(flags, "evidence-statement"),
    agent,
    draft,
    stream,
    json: hasFlag(flags, "json"),
  };
}

export async function runEvalPrompt(args: string[]): Promise<number> {
  try {
    const options = parseOptions(args);

    const batchPath = await resolveInputBatchPath(options.from);
    const raw = await readUtf8(batchPath);
    const parsed = await parseGraphStatementBatchJsonl(raw);
    const statements = mapToFideIdStatements(parsed.statements, parsed.statementFideIds);

    const target = statements.find((statement) => statement.statementFideId === options.target) ?? null;
    if (!target) {
      console.error(`Target owl:sameAs statement not found: ${options.target}`);
      return 1;
    }
    if (target.predicateRawIdentifier !== OWL_SAME_AS_IRI) {
      console.error(`Target statement is not owl:sameAs: ${options.target}`);
      return 1;
    }
    const targetSubjectType = parseFideId(target.subjectFideId as `did:fide:0x${string}`).entityType;
    const expectedType = METHOD_TARGET_TYPES[options.method];
    if (targetSubjectType !== expectedType) {
      console.error(
        `Target does not satisfy method criteria for ${options.method}: expected subject type ${expectedType}, found ${targetSubjectType}.`,
      );
      return 1;
    }

    const contextStatements = buildPromptContextStatements(target, statements);
    const considerations = options.consideration ? [options.consideration] : [...ALL_ATOMIC_CONSIDERATIONS];

    const generated: Array<{
      consideration: AtomicConsideration;
      evidenceStatementFideId: string;
      outPath: string;
      draftOutPath: string | null;
      promptChars: number;
      supportingStatementCount: number;
    }> = [];

    for (const currentConsideration of considerations) {
      const evidencePool = pickAtomicEvidencePool(currentConsideration, target, contextStatements);
      const selectedEvidence = options.evidenceStatement
        ? evidencePool.filter((statement) => statement.statementFideId === options.evidenceStatement)
        : evidencePool;

      if (options.evidenceStatement && selectedEvidence.length === 0) {
        console.error(
          `Evidence statement ${options.evidenceStatement} not found in pool for consideration ${currentConsideration}.`,
        );
        return 1;
      }

      for (const evidence of selectedEvidence) {
        const supportingStatements = pickAtomicRequiredAnchor(
          currentConsideration,
          target,
          evidence,
          contextStatements,
        );
        const prompt = buildAtomicPrompt({
          target,
          consideration: currentConsideration,
          evidence,
          supportingStatements,
          contextStatements,
          definitionsMarkdownLines: buildDefinitionsMarkdown(currentConsideration),
        });
        const outPath = defaultEvalPromptAtomicOutPath({
          method: options.method,
          consideration: currentConsideration,
          targetStatementFideId: target.statementFideId,
          evidenceStatementFideId: evidence.statementFideId,
        });
        await writeUtf8(outPath, prompt.endsWith("\n") ? prompt : `${prompt}\n`);
        let draftOutPath: string | null = null;
        if (options.agent) {
          if (options.agent !== "codex") {
            throw new Error(`Unsupported agent: ${options.agent}. Supported: codex`);
          }
          const agentPrompt = buildAgentPrompt(prompt);
          const draftRoot = resolve(process.cwd(), ".fide", "evals", "drafts");
          const beforeDrafts = new Set(await collectFilesWithExt(draftRoot, ".md"));
          await runCodexDraft(agentPrompt, {
            method: options.method,
            target: options.target,
            from: batchPath,
            consideration: currentConsideration,
            evidenceStatement: evidence.statementFideId,
            promptFile: outPath,
            considerationRef: considerationSourceUrl(options.method, currentConsideration),
          }, options.stream);
          const afterDrafts = await collectFilesWithExt(draftRoot, ".md");
          const created = afterDrafts.filter((path) => !beforeDrafts.has(path)).sort();
          if (created.length === 0) {
            throw new Error("Agent run completed but no eval draft file was created.");
          }
          draftOutPath = created[created.length - 1]!;
        }
        generated.push({
          consideration: currentConsideration,
          evidenceStatementFideId: evidence.statementFideId,
          outPath,
          draftOutPath,
          promptChars: prompt.length,
          supportingStatementCount: supportingStatements.length,
        });
      }
    }

    if (generated.length === 0) {
      console.error("No prompts generated.");
      return 1;
    }

    const payload = {
      ok: true,
      mode: "prompt",
      method: options.method,
      target: options.target,
      agent: options.agent ?? "none",
      from: batchPath,
      generatedCount: generated.length,
      generated,
    };

    if (options.json) printJson(payload);
    else generated.forEach((item) => console.log(item.outPath));
    return 0;
  } catch (error) {
    if (error instanceof Error && error.message === "HELP") {
      return 2;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
