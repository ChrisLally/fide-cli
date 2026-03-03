import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_PACKAGE_ROOT = resolve(THIS_DIR, "../..");

const sourceCache = new Map<string, string>();

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanJsDocText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trimEnd())
    .join("\n")
    .trim();
}

function extractDescription(jsDocBody: string): string | null {
  const tagMatch = jsDocBody.match(/@description\s+([\s\S]*?)(?=\n\s*\*\s*@|$)/);
  if (!tagMatch) return null;
  const clean = cleanJsDocText(tagMatch[1]);
  return clean.length > 0 ? clean.replace(/\s+/g, " ").trim() : null;
}

export async function loadJsDocDescription(params: {
  sourcePathFromCliPackageRoot: string;
  functionName: string;
}): Promise<string | null> {
  const sourcePath = resolve(CLI_PACKAGE_ROOT, params.sourcePathFromCliPackageRoot);
  let source = sourceCache.get(sourcePath);
  if (!source) {
    try {
      source = await readFile(sourcePath, "utf8");
      sourceCache.set(sourcePath, source);
    } catch {
      return null;
    }
  }

  const fn = escapeRegex(params.functionName);
  const re = new RegExp(
    `/\\*\\*((?:[^*]|\\*(?!/))*)\\*/\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${fn}\\s*\\(`,
    "m",
  );
  const match = source.match(re);
  if (!match) return null;
  return extractDescription(match[1]);
}
