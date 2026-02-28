import { buildSameAsEvaluationInputBatchFromDb, closeRuntimeDbClient } from "@fide.work/indexer";
import { getStringFlag, hasFlag } from "../../lib/args.js";
import { loadJsDocDescription } from "../../lib/jsdoc.js";
import { loadReportContextRows } from "../../lib/report-context.js";
import { markdownTable, writeMarkdownReport } from "../../lib/report.js";
import { printJson, writeUtf8 } from "../../lib/io.js";
import { toWireJsonl } from "./shared.js";

/**
 * @description Shows what evidence is ready before running evaluation.
 */
export async function runSameAsInput(flags: Map<string, string | boolean>): Promise<number> {
  try {
    const batch = await buildSameAsEvaluationInputBatchFromDb();
    const outPath = getStringFlag(flags, "out");
    const jsonlOutPath = getStringFlag(flags, "jsonl-out");
    const reportPath = getStringFlag(flags, "report");

    if (jsonlOutPath) {
      await writeUtf8(jsonlOutPath, toWireJsonl(batch.statementWires));
    }

    if (outPath) {
      await writeUtf8(outPath, `${JSON.stringify(batch, null, 2)}\n`);
    }

    if (reportPath) {
      const claimCount = batch.statementFideIds.length;
      const contextRows = await loadReportContextRows(["graph", "indexer"]);
      await writeMarkdownReport({
        reportPath,
        title: "SameAs Input Snapshot",
        description: await loadJsDocDescription({
          sourcePathFromCliPackageRoot: "src/commands/eval/sameas-input.ts",
          functionName: "runSameAsInput",
        }) ?? undefined,
        sections: [
          {
            heading: "Executive Summary",
            lines: [
              `Prepared an evaluation input snapshot with **${batch.statementCount} statements** and **${claimCount} owl:sameAs statements**.`,
              `Snapshot root: \`${batch.root ?? "n/a"}\`.`,
            ],
          },
          {
            heading: "Scope",
            lines: [
              ...markdownTable(
                ["Metric", "Value"],
                [
                  ["Total statements", String(batch.statementCount)],
                  ["owl:sameAs statements", String(claimCount)],
                  ["Snapshot root", batch.root ?? "n/a"],
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
              `- JSON snapshot: ${outPath ? `\`${outPath}\`` : "not written"}`,
              `- JSONL wires: ${jsonlOutPath ? `\`${jsonlOutPath}\`` : "not written"}`,
              `- Report: \`${reportPath}\``,
            ],
          },
        ],
      });
    }

    if (outPath && !hasFlag(flags, "json")) {
      console.log(outPath);
      return 0;
    }

    printJson(batch);
    return 0;
  } finally {
    await closeRuntimeDbClient();
  }
}
