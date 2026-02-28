import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_PACKAGE_ROOT = resolve(THIS_DIR, "../..");
const WORKSPACE_ROOT = resolve(CLI_PACKAGE_ROOT, "../..");

const CONTEXT_SOURCES: Record<string, string[]> = {
  graph: [
    "packages/graph/src/index.ts",
  ],
  "evaluation-methods": [
    "packages/evaluation-methods/src/index.ts",
  ],
  indexer: [
    "packages/indexer/src/index.ts",
  ],
};

function extractTagValue(source: string, tag: string): string | null {
  const regex = new RegExp(`@${tag}\\s+([^\\n\\r*]+)`, "m");
  const match = source.match(regex);
  return match?.[1]?.trim() ?? null;
}

function contextLabelForKey(key: string): string {
  if (key === "graph") return "Graph";
  if (key === "evaluation-methods") return "Evaluation Methods";
  if (key === "indexer") return "Indexer";
  return key;
}

export type ReportContextRow = {
  system: string;
  role: string;
  whyItMatters: string;
};

export async function loadReportContextRows(keys: string[]): Promise<ReportContextRow[]> {
  const rows: ReportContextRow[] = [];

  for (const key of keys) {
    const relPath = CONTEXT_SOURCES[key]?.[0];
    if (!relPath) continue;
    const absPath = resolve(WORKSPACE_ROOT, relPath);
    try {
      const source = await readFile(absPath, "utf8");
      const role = extractTagValue(source, "reportRole");
      const value = extractTagValue(source, "reportValue");
      if (role || value) {
        const label = contextLabelForKey(key);
        rows.push({
          system: label,
          role: role ?? "Role not specified.",
          whyItMatters: value ?? "Business value not specified.",
        });
      }
    } catch {
      // Context extraction should never break report generation.
    }
  }

  return rows;
}
