import { buildStatementsWithRoot } from "@chris-test/fcp";
import { buildSameAsEvaluationStatementInputs } from "@fide.work/graph";
import { getStringFlag, hasFlag } from "../../lib/args.js";
import { loadJsDocDescription } from "../../lib/jsdoc.js";
import { loadReportContextRows } from "../../lib/report-context.js";
import { markdownTable, writeMarkdownReport } from "../../lib/report.js";
import { printJson, readUtf8, writeUtf8 } from "../../lib/io.js";
import {
  type EvalRunResult,
  normalizeDecisionFilter,
  toWireJsonl,
} from "./shared.js";

/**
 * @description Shows the output statements created from evaluation decisions.
 */
export async function runEmitStatements(flags: Map<string, string | boolean>): Promise<number> {
  const inPath = getStringFlag(flags, "in");
  if (!inPath) {
    console.error("Missing required flag: --in <eval-result.json>");
    return 1;
  }

  const decision = normalizeDecisionFilter(getStringFlag(flags, "decision"));
  const reportPath = getStringFlag(flags, "report");
  const raw = await readUtf8(inPath);
  const parsed = JSON.parse(raw) as EvalRunResult;

  const filtered = parsed.results.filter((result) =>
    decision === "all" ? true : result.decision === decision,
  );

  const runId = `eval-emit-${Date.now()}`;
  const grouped = new Map<string, {
    methodIdentifier: string;
    methodName: string;
    methodVersion: string;
    evaluationBaseIdentifier: string;
    claimStatementFideIds: string[];
  }>();

  for (const result of filtered) {
    const methodKey = result.method?.key ?? parsed.method.key;
    const methodIdentifier = result.method?.methodIdentifier ?? parsed.method.methodIdentifier;
    const methodName = result.method?.methodName ?? parsed.method.methodName;
    const methodVersion = result.method?.methodVersion ?? parsed.method.methodVersion;
    const evaluationBaseIdentifier = result.method?.evaluationBaseIdentifier ?? parsed.method.evaluationBaseIdentifier;
    const existing = grouped.get(methodKey);
    if (existing) {
      existing.claimStatementFideIds.push(result.targetSameAsStatementFideId);
    } else {
      grouped.set(methodKey, {
        methodIdentifier,
        methodName,
        methodVersion,
        evaluationBaseIdentifier,
        claimStatementFideIds: [result.targetSameAsStatementFideId],
      });
    }
  }

  const inputs = [...grouped.values()].flatMap((group, index) => {
    const built = buildSameAsEvaluationStatementInputs({
      claimStatementFideIds: group.claimStatementFideIds,
      inputSnapshotIdentifier: parsed.input.root
        ? `fide://statement-batch/${parsed.input.root}`
        : "fide://statement-batch/unknown",
      runId: `${runId}-${index + 1}`,
      methodIdentifier: group.methodIdentifier,
      methodName: group.methodName,
      methodVersion: group.methodVersion,
      evaluationBaseIdentifier: group.evaluationBaseIdentifier,
    });
    return built.inputs;
  });

  const { statements, root } = await buildStatementsWithRoot(inputs);

  const wires = statements.map((statement) => ({
    s: statement.subjectFideId,
    sr: statement.subjectRawIdentifier,
    p: statement.predicateFideId,
    pr: statement.predicateRawIdentifier,
    o: statement.objectFideId,
    or: statement.objectRawIdentifier,
  }));
  const jsonl = toWireJsonl(wires);

  const outPath = getStringFlag(flags, "out");
  if (outPath) {
    await writeUtf8(outPath, jsonl);
  }

  const summary = {
    mode: "emit-statements",
    decisionFilter: decision,
    claimCount: filtered.length,
    statementCount: statements.length,
    root,
    outPath,
    reportPath,
  };

  if (reportPath) {
    const contextRows = await loadReportContextRows(["graph", "evaluation-methods"]);
    await writeMarkdownReport({
      reportPath,
      title: "Eval Emitted Statements",
      description: await loadJsDocDescription({
        sourcePathFromCliPackageRoot: "src/commands/eval/emit-statements.ts",
        functionName: "runEmitStatements",
      }) ?? undefined,
      sections: [
        {
          heading: "Executive Summary",
          lines: [
            `Emitted **${summary.statementCount} statements** from **${summary.claimCount} evaluated owl:sameAs statements** using decision filter \`${summary.decisionFilter}\`.`,
            `Output root: \`${summary.root}\`.`,
          ],
        },
        {
          heading: "Emission Details",
          lines: [
            ...markdownTable(
              ["Field", "Value"],
              [
                ["Decision filter", summary.decisionFilter],
                ["owl:sameAs statements included", String(summary.claimCount)],
                ["Statements emitted", String(summary.statementCount)],
                ["Batch root", summary.root],
              ],
            ),
          ],
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
            `- Emitted JSONL: ${outPath ? `\`${outPath}\`` : "not written"}`,
            `- Report: \`${reportPath}\``,
          ],
        },
      ],
    });
  }

  if (hasFlag(flags, "json") || !outPath) {
    printJson(summary);
  } else {
    console.log(outPath);
  }

  return 0;
}
