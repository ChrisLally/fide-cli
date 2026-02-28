import { parseFideId } from "@chris-test/fcp";
import { EVALUATION_METHOD_REGISTRY } from "@fide.work/evaluation-methods/registry";
import { resolveEvaluationMethodExecutor } from "@fide.work/evaluation-methods/execution";
import { getStringFlag, hasFlag } from "../../lib/args.js";
import { loadJsDocDescription } from "../../lib/jsdoc.js";
import { loadReportContextRows } from "../../lib/report-context.js";
import { markdownTable, writeMarkdownReport } from "../../lib/report.js";
import { printJson, readUtf8, writeUtf8 } from "../../lib/io.js";
import {
  type EvalRunResult,
  type SameAsInputBatch,
  OWL_SAME_AS_IRI,
  parseClaimFilter,
  toEvalRunSummary,
  toPercent,
  wiresToStatements,
} from "./shared.js";

const DEFAULT_METHOD_BY_ENTITY_TYPE: Record<string, { methodId: string; methodVersion: string }> = {
  Person: { methodId: "temporal-validity/owl-sameAs/Person", methodVersion: "v1" },
  Organization: { methodId: "temporal-validity/owl-sameAs/Organization", methodVersion: "v1" },
  Concept: { methodId: "temporal-validity/owl-sameAs/Concept", methodVersion: "v1" },
};

function resolveMethod(input: string | null) {
  const methodInput = input ?? "temporal-validity/owl-sameAs/Person@v1";
  const method = EVALUATION_METHOD_REGISTRY.find((candidate) =>
    candidate.key === methodInput ||
    candidate.methodId === methodInput ||
    candidate.methodIdentifier === methodInput,
  );

  if (!method) {
    throw new Error(`Unknown method: ${methodInput}`);
  }

  const executor = resolveEvaluationMethodExecutor(method.methodId, method.methodVersion);
  if (!executor) {
    throw new Error(`No executor available for method ${method.methodId}@${method.methodVersion}`);
  }

  return { methodInput, method, executor };
}

function resolveMethodForEntityType(entityType: string) {
  const mapped = DEFAULT_METHOD_BY_ENTITY_TYPE[entityType]
    ?? DEFAULT_METHOD_BY_ENTITY_TYPE.Person;
  return resolveMethod(`${mapped.methodId}@${mapped.methodVersion}`);
}

/**
 * @description Shows evaluation results and where human review is needed.
 */
export async function runEval(flags: Map<string, string | boolean>): Promise<number> {
  const inPath = getStringFlag(flags, "in");
  if (!inPath) {
    console.error("Missing required flag: --in <batch.json>");
    return 1;
  }

  const requestedMethod = getStringFlag(flags, "method");
  const explicitMethod = requestedMethod ? resolveMethod(requestedMethod) : null;
  const claimFilter = parseClaimFilter(getStringFlag(flags, "claims"));
  const reportPath = getStringFlag(flags, "report");

  const raw = await readUtf8(inPath);
  const parsed = JSON.parse(raw) as SameAsInputBatch;
  const statements = await wiresToStatements(parsed.statementWires);

  const claimCandidates = statements
    .filter((statement) => statement.predicateRawIdentifier === OWL_SAME_AS_IRI)
    .map((statement) => statement.statementFideId);

  const targetClaims = claimFilter
    ? claimCandidates.filter((claimId) => claimFilter.has(claimId))
    : claimCandidates;

  const statementById = new Map(statements.map((statement) => [statement.statementFideId, statement]));

  const run = targetClaims.map((claimId) => {
    const claimStatement = statementById.get(claimId) ?? null;
    const subjectEntityType = claimStatement
      ? parseFideId(claimStatement.subjectFideId as `did:fide:0x${string}`).entityType
      : "Person";
    const methodChoice = explicitMethod ?? resolveMethodForEntityType(subjectEntityType);

    const result = methodChoice.executor({
      targetSameAsStatementFideId: claimId,
      statements: statements as unknown as Parameters<typeof methodChoice.executor>[0]["statements"],
    } as Parameters<typeof methodChoice.executor>[0]);

    return {
      targetSameAsStatementFideId: result.targetSameAsStatementFideId,
      decision: result.decision,
      score: result.score,
      confidence: result.confidence,
      reviewRequired: result.reviewRequired,
      evidenceStatementFideIds: result.evidenceStatementFideIds,
      method: {
        key: methodChoice.method.key,
        methodId: methodChoice.method.methodId,
        methodIdentifier: methodChoice.method.methodIdentifier,
        methodVersion: methodChoice.method.methodVersion,
        methodName: methodChoice.method.methodName,
        evaluationBaseIdentifier: methodChoice.method.evaluationBaseIdentifier,
      },
    };
  });

  const methodsUsed = [...new Set(run.map((result) => result.method.key))].sort();
  const primaryMethod = explicitMethod?.method ?? (
    run[0]?.method ? {
      key: run[0].method.key,
      methodId: run[0].method.methodId,
      methodIdentifier: run[0].method.methodIdentifier,
      methodVersion: run[0].method.methodVersion,
      methodName: run[0].method.methodName,
      evaluationBaseIdentifier: run[0].method.evaluationBaseIdentifier,
    } : {
      key: "auto",
      methodId: "auto",
      methodIdentifier: "auto",
      methodVersion: "auto",
      methodName: "auto",
      evaluationBaseIdentifier: "auto",
    }
  );

  const output: EvalRunResult = {
    method: {
      input: explicitMethod ? explicitMethod.methodInput : "auto",
      key: explicitMethod ? primaryMethod.key : "auto",
      methodId: explicitMethod ? primaryMethod.methodId : "auto",
      methodIdentifier: explicitMethod ? primaryMethod.methodIdentifier : "auto",
      methodVersion: explicitMethod ? primaryMethod.methodVersion : "auto",
      methodName: explicitMethod ? primaryMethod.methodName : "Auto by subject entity type",
      evaluationBaseIdentifier: explicitMethod ? primaryMethod.evaluationBaseIdentifier : "mixed",
      methodsUsed,
    },
    input: {
      root: parsed.root,
      statementCount: parsed.statementCount,
      claimCount: targetClaims.length,
    },
    summary: toEvalRunSummary(run),
    results: run,
  };

  const outPath = getStringFlag(flags, "out");
  if (outPath) {
    await writeUtf8(outPath, `${JSON.stringify(output, null, 2)}\n`);
  }

  if (reportPath) {
    const total = output.input.claimCount;
    const reviewRate = toPercent(output.summary.reviewRequired, total);
    const sampled = [...output.results]
      .sort((a, b) => a.confidence - b.confidence || a.score - b.score)
      .slice(0, 12);
    const contextRows = await loadReportContextRows(["evaluation-methods", "graph", "indexer"]);

    await writeMarkdownReport({
      reportPath,
      title: "Eval Run Result",
      description: await loadJsDocDescription({
        sourcePathFromCliPackageRoot: "src/commands/eval/run.ts",
        functionName: "runEval",
      }) ?? undefined,
      sections: [
        {
          heading: "Executive Summary",
          lines: [
            explicitMethod
              ? `Evaluated **${total} owl:sameAs statements** with method \`${output.method.methodName}\` (${output.method.methodVersion}).`
              : `Evaluated **${total} owl:sameAs statements** with automatic method routing by subject entity type.`,
            `Decisions: **${output.summary.same} same**, **${output.summary.uncertain} uncertain**, **${output.summary.different} different**.`,
            `Manual review required for **${output.summary.reviewRequired} owl:sameAs statements (${reviewRate})**.`,
          ],
        },
        {
          heading: "Method And Scope",
          lines: [
            ...markdownTable(
              ["Field", "Value"],
              [
                ["Method mode", explicitMethod ? "explicit" : "auto"],
                ["Method identifier", output.method.methodIdentifier],
                ["Method version", output.method.methodVersion],
                ["Evaluation base", output.method.evaluationBaseIdentifier],
                ["Methods used", (output.method.methodsUsed ?? []).join(", ") || "n/a"],
                ["Input root", output.input.root ?? "n/a"],
                ["Input statements", String(output.input.statementCount)],
                ["owl:sameAs statements evaluated", String(total)],
              ],
            ),
          ],
        },
        {
          heading: "Decision Breakdown",
          lines: [
            ...markdownTable(
              ["Decision", "Count", "Share"],
              [
                ["same", String(output.summary.same), toPercent(output.summary.same, total)],
                ["uncertain", String(output.summary.uncertain), toPercent(output.summary.uncertain, total)],
                ["different", String(output.summary.different), toPercent(output.summary.different, total)],
                ["reviewRequired", String(output.summary.reviewRequired), reviewRate],
              ],
            ),
            "",
            `Average score: **${output.summary.avgScore.toFixed(6)}**`,
            `Average confidence: **${output.summary.avgConfidence.toFixed(6)}**`,
          ],
        },
        {
          heading: "Lowest-Confidence owl:sameAs Statements (Top 12)",
          lines: sampled.length > 0
            ? markdownTable(
              ["owl:sameAs Statement Fide ID", "Decision", "Score", "Confidence", "Review"],
              sampled.map((row) => [
                row.targetSameAsStatementFideId,
                row.decision,
                row.score.toFixed(6),
                row.confidence.toFixed(6),
                row.reviewRequired ? "yes" : "no",
              ]),
            )
            : ["No owl:sameAs statements available."],
        },
        {
          heading: "System Roles (Plain English)",
          lines: contextRows.length > 0
            ? markdownTable(
              ["System", "Role", "Why it matters"],
              contextRows.map((row) => [row.system, row.role, row.whyItMatters]),
            )
            : ["Context not available."],
        },
        {
          heading: "Artifacts",
          lines: [
            `- Full JSON result: ${outPath ? `\`${outPath}\`` : "not written"}`,
            `- Report: \`${reportPath}\``,
          ],
        },
      ],
    });
  }

  if (hasFlag(flags, "json") || !outPath) {
    printJson(output);
  } else {
    console.log(outPath);
  }

  return 0;
}
