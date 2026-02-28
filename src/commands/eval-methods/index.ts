import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { EVALUATION_METHOD_REGISTRY } from "@fide.work/evaluation-methods/registry";
import type { EvaluationMethodRegistryEntry } from "@fide.work/evaluation-methods";
import { getStringFlag, hasFlag, parseArgs } from "../../lib/args.js";
import { printJson } from "../../lib/io.js";

function evalMethodsHelp(): string {
  return [
    "Usage:",
    "  fide eval-methods list [--installed-only] [--dest <path>] [--json]",
    "  fide eval-methods add --method <method-id|key|identifier> [--dest <path>] [--json]",
    "  fide eval-methods add --all [--dest <path>] [--json]",
  ].join("\n");
}

function repoRootFromThisFile(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../../../");
}

function hasFideDirectory(dir: string): boolean {
  return existsSync(join(dir, ".fide"));
}

function resolveDestRoot(flags: Map<string, string | boolean>): string {
  const custom = getStringFlag(flags, "dest");
  if (custom) return resolve(process.cwd(), custom);
  const cwd = process.cwd();
  if (!hasFideDirectory(cwd)) {
    throw new Error(
      "No .fide folder found in current directory. Run this command from your project root (where .fide exists) or run `fide init` in that root.",
    );
  }
  return resolve(cwd, ".fide/evaluation-methods");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function copyDirectoryRecursive(sourceDir: string, destinationDir: string): Promise<void> {
  await mkdir(destinationDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = resolve(sourceDir, entry.name);
    const destinationPath = resolve(destinationDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryRecursive(sourcePath, destinationPath);
      continue;
    }
    if (entry.isFile()) {
      const content = await readFile(sourcePath);
      await writeFile(destinationPath, content);
    }
  }
}

function resolveRegistryMethod(input: string): EvaluationMethodRegistryEntry | null {
  return EVALUATION_METHOD_REGISTRY.find((method) =>
    method.methodId === input || method.key === input || method.methodIdentifier === input
  ) ?? null;
}

function methodSourceDir(repoRoot: string, method: EvaluationMethodRegistryEntry): string {
  return resolve(repoRoot, "packages/evaluation-methods/src/evidence", method.methodId, method.methodVersion);
}

function methodDestDir(destRoot: string, method: EvaluationMethodRegistryEntry): string {
  return resolve(destRoot, method.methodId, method.methodVersion);
}

async function runList(flags: Map<string, string | boolean>): Promise<number> {
  const destRoot = resolveDestRoot(flags);
  const installedOnly = hasFlag(flags, "installed-only");

  const rows = await Promise.all(EVALUATION_METHOD_REGISTRY.map(async (method) => {
    const installedPath = methodDestDir(destRoot, method);
    const installed = await pathExists(installedPath);
    return {
      key: method.key,
      methodId: method.methodId,
      version: method.methodVersion,
      subjectTypes: method.subjectTypes,
      stability: method.stability,
      installed,
      installedPath: installed ? installedPath : null,
    };
  }));

  const filtered = installedOnly ? rows.filter((row) => row.installed) : rows;

  if (hasFlag(flags, "json")) {
    printJson({
      destRoot,
      count: filtered.length,
      methods: filtered,
    });
  } else {
    console.log(`Destination root: ${destRoot}`);
    for (const row of filtered) {
      console.log(
        `- ${row.methodId}@${row.version} [${row.stability}] subjects=${row.subjectTypes.join(",")} installed=${row.installed ? "yes" : "no"}`,
      );
    }
    if (filtered.length === 0) {
      console.log("No evaluation methods matched.");
    }
  }

  return 0;
}

async function installOne(
  repoRoot: string,
  destRoot: string,
  method: EvaluationMethodRegistryEntry,
): Promise<{
  key: string;
  methodId: string;
  methodIdentifier: string;
  methodName: string;
  version: string;
  stability: string;
  subjectTypes: string[];
  destination: string;
}> {
  const sourceDir = methodSourceDir(repoRoot, method);
  if (!await pathExists(sourceDir)) {
    throw new Error(`Method source not found: ${sourceDir}`);
  }

  const destination = methodDestDir(destRoot, method);
  await copyDirectoryRecursive(sourceDir, destination);
  await writeFile(
    resolve(destination, "method.json"),
    `${JSON.stringify({
      key: method.key,
      methodId: method.methodId,
      methodIdentifier: method.methodIdentifier,
      methodVersion: method.methodVersion,
      methodName: method.methodName,
      methodDescription: method.methodDescription,
      stability: method.stability,
      subjectTypes: method.subjectTypes,
      installedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    "utf8",
  );

  return {
    key: method.key,
    methodId: method.methodId,
    methodIdentifier: method.methodIdentifier,
    methodName: method.methodName,
    version: method.methodVersion,
    stability: method.stability,
    subjectTypes: [...method.subjectTypes],
    destination,
  };
}

async function writeInstalledIndex(
  destRoot: string,
  installed: Array<{
    key: string;
    methodId: string;
    methodIdentifier: string;
    methodName: string;
    version: string;
    stability: string;
    subjectTypes: string[];
    destination: string;
  }>
): Promise<string> {
  const indexPath = resolve(destRoot, "index.json");
  const generatedAt = new Date().toISOString();
  const projectRoot = resolve(destRoot, "..", "..");
  const methods = installed
    .map((item) => ({
      key: item.key,
      methodId: item.methodId,
      methodIdentifier: item.methodIdentifier,
      methodName: item.methodName,
      version: item.version,
      stability: item.stability,
      subjectTypes: item.subjectTypes,
      path: relative(projectRoot, item.destination).split(sep).join("/"),
      installedAt: generatedAt,
    }))
    .sort((a, b) => `${a.methodId}@${a.version}`.localeCompare(`${b.methodId}@${b.version}`));

  await writeFile(
    indexPath,
    `${JSON.stringify({
      generatedAt,
      count: methods.length,
      methods,
    }, null, 2)}\n`,
    "utf8",
  );

  return indexPath;
}

async function runInstall(flags: Map<string, string | boolean>): Promise<number> {
  const repoRoot = repoRootFromThisFile();
  const destRoot = resolveDestRoot(flags);
  const installAll = hasFlag(flags, "all");
  const methodInput = getStringFlag(flags, "method");

  if (!installAll && !methodInput) {
    console.error("Missing --method or --all for `eval-methods add`.");
    console.error(evalMethodsHelp());
    return 1;
  }

  const methods = installAll
    ? [...EVALUATION_METHOD_REGISTRY]
    : (() => {
      const resolved = resolveRegistryMethod(methodInput!);
      if (!resolved) {
        throw new Error(`Unknown evaluation method: ${methodInput}`);
      }
      return [resolved];
    })();

  const installed = [];
  for (const method of methods) {
    installed.push(await installOne(repoRoot, destRoot, method));
  }
  const indexPath = await writeInstalledIndex(destRoot, installed);

  if (hasFlag(flags, "json")) {
    printJson({
      ok: true,
      destRoot,
      indexPath,
      installed,
    });
  } else {
    console.log(`Installed ${installed.length} evaluation method(s) to ${destRoot}`);
    for (const item of installed) {
      console.log(`- ${item.methodId}@${item.version} -> ${item.destination}`);
    }
    console.log(`- index -> ${indexPath}`);
  }

  return 0;
}

/**
 * @description Lists and adds evaluation methods into local .fide/evaluation-methods folders.
 */
export async function runEvalMethodsCommand(command: string | undefined, args: string[]): Promise<number> {
  if (!command || command === "--help") {
    console.log(evalMethodsHelp());
    return 0;
  }

  const { flags } = parseArgs(args);

  try {
    if (command === "list") return runList(flags);
    if (command === "add") return runInstall(flags);
    console.error(`Unknown eval-methods command: ${command}`);
    console.error(evalMethodsHelp());
    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (hasFlag(flags, "json")) {
      printJson({ ok: false, error: message });
    } else {
      console.error(message);
    }
    return 1;
  }
}
