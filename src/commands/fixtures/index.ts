import { appendFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { calculateFideId } from "@chris-test/fcp";
import { getStringFlag, hasFlag, parseArgs } from "../../lib/args.js";
import { printJson } from "../../lib/io.js";

const execFileAsync = promisify(execFile);
const OWL_SAME_AS_IRI = "https://www.w3.org/2002/07/owl#sameAs";
const SCHEMA_VALID_FROM_IRI = "https://schema.org/validFrom";
const PROV_HAD_PRIMARY_SOURCE_IRI = "https://www.w3.org/ns/prov#hadPrimarySource";
const RDF_TYPE_IRI = "https://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const SCHEMA_CREATIVE_WORK_IRI = "https://schema.org/CreativeWork";
const SCHEMA_NAME_IRI = "https://schema.org/name";
const SCHEMA_VERSION_IRI = "https://schema.org/version";
const SCHEMA_DESCRIPTION_IRI = "https://schema.org/description";
const SCHEMA_IS_BASED_ON_IRI = "https://schema.org/isBasedOn";
const SCHEMA_ADDITIONAL_PROPERTY_IRI = "https://schema.org/additionalProperty";
const SCHEMA_PROPERTY_VALUE_IRI = "https://schema.org/PropertyValue";
const SCHEMA_PROPERTY_ID_IRI = "https://schema.org/propertyID";
const SCHEMA_VALUE_IRI = "https://schema.org/value";
const SCHEMA_VALUE_REFERENCE_IRI = "https://schema.org/valueReference";
const DEFAULT_REPORT_BASE_URL = "https://fide.work/evidence/reports/temporal-validity/owl-sameAs/Person";

type StatementInput = {
  subject: { rawIdentifier: string; entityType: string; sourceType: string };
  predicate: { rawIdentifier: string; entityType: string; sourceType: string };
  object: { rawIdentifier: string; entityType: string; sourceType: string };
};

type Manifest = {
  scenarios: Array<{
    id: string;
    path: string;
  }>;
};

function fixturesHelp(): string {
  return [
    "Usage:",
    "  fide fixtures add --scenario <id> --subject <raw> --subject-type <type> --subject-source <type> --predicate <iri> --object <raw> --object-type <type> --object-source <type> [--json]",
    "  fide fixtures add-valid-from --scenario <id> --sameas-subject <raw> --sameas-object <raw> --valid-from <iso> [--json]",
    "  fide fixtures add-primary-source --scenario <id> --statement-raw <s|p|o> --source <url> [--json]",
    "  fide fixtures add-evidence-report --scenario <id> --target-statement-raw <s|p|o> --version <v> [--base-url <url>] [--report-url <url>] [--name <text>] [--description <text>] [--valid-from-confidence <0..1>] [--json]",
    "  fide fixtures add-evidence-part --scenario <id> --report-url <url> --source-url <url> [--json]",
    "  fide fixtures add-evidence-summary --scenario <id> --report-url <url> --text <summary> [--json]",
    "  fide fixtures rebuild --scenario <id> [--json]",
    "  fide fixtures check [--scenario <id>] [--json]",
  ].join("\n");
}

function repoRootFromThisFile(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../../../");
}

async function loadManifest(repoRoot: string): Promise<Manifest> {
  const manifestPath = resolve(repoRoot, "packages/graph/fixtures/manifest.json");
  const source = await readFile(manifestPath, "utf8");
  return JSON.parse(source) as Manifest;
}

async function resolveScenarioInputsPath(repoRoot: string, scenarioId: string): Promise<string> {
  const manifest = await loadManifest(repoRoot);
  const entry = manifest.scenarios.find((scenario) => scenario.id === scenarioId);
  if (!entry) {
    throw new Error(`Scenario not found in fixture manifest: ${scenarioId}`);
  }
  return resolve(repoRoot, "packages/graph/fixtures", entry.path, "statement-inputs.jsonl");
}

function parseJsonlStatementInputs(source: string): StatementInput[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as StatementInput);
}

function sameStatement(a: StatementInput, b: StatementInput): boolean {
  return a.subject.rawIdentifier === b.subject.rawIdentifier
    && a.subject.entityType === b.subject.entityType
    && a.subject.sourceType === b.subject.sourceType
    && a.predicate.rawIdentifier === b.predicate.rawIdentifier
    && a.predicate.entityType === b.predicate.entityType
    && a.predicate.sourceType === b.predicate.sourceType
    && a.object.rawIdentifier === b.object.rawIdentifier
    && a.object.entityType === b.object.entityType
    && a.object.sourceType === b.object.sourceType;
}

async function appendStatementInputIfMissing(
  statementInputsPath: string,
  input: StatementInput,
): Promise<{ appended: boolean; line: string }> {
  const existingSource = await readFile(statementInputsPath, "utf8");
  const existing = parseJsonlStatementInputs(existingSource);
  const alreadyExists = existing.some((candidate) => sameStatement(candidate, input));
  const line = JSON.stringify(input);

  if (alreadyExists) {
    return { appended: false, line };
  }

  const needsLeadingNewline = existingSource.length > 0 && !existingSource.endsWith("\n");
  await appendFile(statementInputsPath, `${needsLeadingNewline ? "\n" : ""}${line}\n`, "utf8");
  return { appended: true, line };
}

async function runGraphScript(
  repoRoot: string,
  script: "build:fixture" | "fixtures:check" | "fixtures:update",
  extraArgs: string[],
): Promise<void> {
  await execFileAsync("pnpm", ["-C", resolve(repoRoot, "packages/graph"), "run", script, "--", ...extraArgs], {
    cwd: repoRoot,
    env: process.env,
  });
}

async function runAdd(flags: Map<string, string | boolean>): Promise<number> {
  const scenario = getStringFlag(flags, "scenario");
  const subject = getStringFlag(flags, "subject");
  const subjectType = getStringFlag(flags, "subject-type");
  const subjectSource = getStringFlag(flags, "subject-source");
  const predicate = getStringFlag(flags, "predicate");
  const object = getStringFlag(flags, "object");
  const objectType = getStringFlag(flags, "object-type");
  const objectSource = getStringFlag(flags, "object-source");

  if (!scenario || !subject || !subjectType || !subjectSource || !predicate || !object || !objectType || !objectSource) {
    console.error("Missing required flags for `fixtures add`.");
    console.error(fixturesHelp());
    return 1;
  }

  const repoRoot = repoRootFromThisFile();
  const statementInputsPath = await resolveScenarioInputsPath(repoRoot, scenario);
  const result = await appendStatementInputIfMissing(statementInputsPath, {
    subject: { rawIdentifier: subject, entityType: subjectType, sourceType: subjectSource },
    predicate: { rawIdentifier: predicate, entityType: "Concept", sourceType: "NetworkResource" },
    object: { rawIdentifier: object, entityType: objectType, sourceType: objectSource },
  });

  const summary = {
    mode: "fixtures-add",
    scenario,
    statementInputsPath,
    appended: result.appended,
  };

  if (hasFlag(flags, "json")) {
    printJson(summary);
  } else {
    console.log(`${result.appended ? "appended" : "already-exists"} ${statementInputsPath}`);
  }
  return 0;
}

async function runAddValidFrom(flags: Map<string, string | boolean>): Promise<number> {
  const scenario = getStringFlag(flags, "scenario");
  const sameAsSubjectRaw = getStringFlag(flags, "sameas-subject");
  const sameAsObjectRaw = getStringFlag(flags, "sameas-object");
  const validFrom = getStringFlag(flags, "valid-from");

  if (!scenario || !sameAsSubjectRaw || !sameAsObjectRaw || !validFrom) {
    console.error("Missing required flags for `fixtures add-valid-from`.");
    console.error(fixturesHelp());
    return 1;
  }

  const subjectFideId = await calculateFideId("Person", "NetworkResource", sameAsSubjectRaw);
  const predicateFideId = await calculateFideId("Concept", "NetworkResource", OWL_SAME_AS_IRI);
  const objectType = sameAsObjectRaw.startsWith("http") ? "Person" : "PlatformAccount";
  const objectSource = sameAsObjectRaw.startsWith("http") ? "NetworkResource" : "PlatformAccount";
  const objectFideId = await calculateFideId(objectType as any, objectSource as any, sameAsObjectRaw);
  const statementRaw = `${subjectFideId}|${predicateFideId}|${objectFideId}`;

  const repoRoot = repoRootFromThisFile();
  const statementInputsPath = await resolveScenarioInputsPath(repoRoot, scenario);
  const result = await appendStatementInputIfMissing(statementInputsPath, {
    subject: { rawIdentifier: statementRaw, entityType: "Statement", sourceType: "Statement" },
    predicate: { rawIdentifier: SCHEMA_VALID_FROM_IRI, entityType: "Concept", sourceType: "NetworkResource" },
    object: { rawIdentifier: validFrom, entityType: "DateTimeLiteral", sourceType: "DateTimeLiteral" },
  });

  const summary = {
    mode: "fixtures-add-valid-from",
    scenario,
    statementInputsPath,
    targetStatementRawIdentifier: statementRaw,
    appended: result.appended,
  };

  if (hasFlag(flags, "json")) {
    printJson(summary);
  } else {
    console.log(`${result.appended ? "appended" : "already-exists"} ${statementInputsPath}`);
  }
  return 0;
}

async function runAddPrimarySource(flags: Map<string, string | boolean>): Promise<number> {
  const scenario = getStringFlag(flags, "scenario");
  const statementRaw = getStringFlag(flags, "statement-raw");
  const source = getStringFlag(flags, "source");

  if (!scenario || !statementRaw || !source) {
    console.error("Missing required flags for `fixtures add-primary-source`.");
    console.error(fixturesHelp());
    return 1;
  }

  const repoRoot = repoRootFromThisFile();
  const statementInputsPath = await resolveScenarioInputsPath(repoRoot, scenario);
  const result = await appendStatementInputIfMissing(statementInputsPath, {
    subject: { rawIdentifier: statementRaw, entityType: "Statement", sourceType: "Statement" },
    predicate: { rawIdentifier: PROV_HAD_PRIMARY_SOURCE_IRI, entityType: "Concept", sourceType: "NetworkResource" },
    object: { rawIdentifier: source, entityType: "NetworkResource", sourceType: "NetworkResource" },
  });

  const summary = {
    mode: "fixtures-add-primary-source",
    scenario,
    statementInputsPath,
    appended: result.appended,
  };

  if (hasFlag(flags, "json")) {
    printJson(summary);
  } else {
    console.log(`${result.appended ? "appended" : "already-exists"} ${statementInputsPath}`);
  }
  return 0;
}

function statementSuffixFromRaw(statementRaw: string): string {
  const compact = statementRaw
    .replaceAll("did:fide:0x", "")
    .replaceAll("|", "-");
  return compact.slice(0, 36);
}

function buildDefaultReportUrl(targetStatementRaw: string, version: string, baseUrl: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}/${statementSuffixFromRaw(targetStatementRaw)}/${version}`;
}

function parseConfidence(value: string | null): string | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error("--valid-from-confidence must be a number between 0 and 1.");
  }
  return String(parsed);
}

async function runAddEvidenceReport(flags: Map<string, string | boolean>): Promise<number> {
  const scenario = getStringFlag(flags, "scenario");
  const targetStatementRaw = getStringFlag(flags, "target-statement-raw");
  const version = getStringFlag(flags, "version");
  const baseUrl = getStringFlag(flags, "base-url") ?? DEFAULT_REPORT_BASE_URL;
  const explicitReportUrl = getStringFlag(flags, "report-url");
  const name = getStringFlag(flags, "name");
  const description = getStringFlag(flags, "description");
  let validFromConfidence: string | null = null;
  try {
    validFromConfidence = parseConfidence(getStringFlag(flags, "valid-from-confidence"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (!scenario || !targetStatementRaw || !version) {
    console.error("Missing required flags for `fixtures add-evidence-report`.");
    console.error(fixturesHelp());
    return 1;
  }

  const reportUrl = explicitReportUrl ?? buildDefaultReportUrl(targetStatementRaw, version, baseUrl);
  const repoRoot = repoRootFromThisFile();
  const statementInputsPath = await resolveScenarioInputsPath(repoRoot, scenario);

  const created: Array<{ label: string; appended: boolean }> = [];
  const append = async (label: string, input: StatementInput): Promise<void> => {
    const result = await appendStatementInputIfMissing(statementInputsPath, input);
    created.push({ label, appended: result.appended });
  };

  await append("target-hadPrimarySource-report", {
    subject: { rawIdentifier: targetStatementRaw, entityType: "Statement", sourceType: "Statement" },
    predicate: { rawIdentifier: PROV_HAD_PRIMARY_SOURCE_IRI, entityType: "Concept", sourceType: "NetworkResource" },
    object: { rawIdentifier: reportUrl, entityType: "CreativeWork", sourceType: "NetworkResource" },
  });
  await append("report-rdf-type-creativework", {
    subject: { rawIdentifier: reportUrl, entityType: "CreativeWork", sourceType: "NetworkResource" },
    predicate: { rawIdentifier: RDF_TYPE_IRI, entityType: "Concept", sourceType: "NetworkResource" },
    object: { rawIdentifier: SCHEMA_CREATIVE_WORK_IRI, entityType: "Concept", sourceType: "NetworkResource" },
  });
  await append("report-version", {
    subject: { rawIdentifier: reportUrl, entityType: "CreativeWork", sourceType: "NetworkResource" },
    predicate: { rawIdentifier: SCHEMA_VERSION_IRI, entityType: "Concept", sourceType: "NetworkResource" },
    object: { rawIdentifier: version, entityType: "TextLiteral", sourceType: "TextLiteral" },
  });
  if (name) {
    await append("report-name", {
      subject: { rawIdentifier: reportUrl, entityType: "CreativeWork", sourceType: "NetworkResource" },
      predicate: { rawIdentifier: SCHEMA_NAME_IRI, entityType: "Concept", sourceType: "NetworkResource" },
      object: { rawIdentifier: name, entityType: "TextLiteral", sourceType: "TextLiteral" },
    });
  }
  if (description) {
    await append("report-description", {
      subject: { rawIdentifier: reportUrl, entityType: "CreativeWork", sourceType: "NetworkResource" },
      predicate: { rawIdentifier: SCHEMA_DESCRIPTION_IRI, entityType: "Concept", sourceType: "NetworkResource" },
      object: { rawIdentifier: description, entityType: "TextLiteral", sourceType: "TextLiteral" },
    });
  }
  if (validFromConfidence !== null) {
    const confidenceNode = `${reportUrl}#validFromConfidence`;
    await append("report-additional-property-validFromConfidence", {
      subject: { rawIdentifier: reportUrl, entityType: "CreativeWork", sourceType: "NetworkResource" },
      predicate: { rawIdentifier: SCHEMA_ADDITIONAL_PROPERTY_IRI, entityType: "Concept", sourceType: "NetworkResource" },
      object: { rawIdentifier: confidenceNode, entityType: "Concept", sourceType: "NetworkResource" },
    });
    await append("report-validFromConfidence-rdf-type", {
      subject: { rawIdentifier: confidenceNode, entityType: "Concept", sourceType: "NetworkResource" },
      predicate: { rawIdentifier: RDF_TYPE_IRI, entityType: "Concept", sourceType: "NetworkResource" },
      object: { rawIdentifier: SCHEMA_PROPERTY_VALUE_IRI, entityType: "Concept", sourceType: "NetworkResource" },
    });
    await append("report-validFromConfidence-propertyID", {
      subject: { rawIdentifier: confidenceNode, entityType: "Concept", sourceType: "NetworkResource" },
      predicate: { rawIdentifier: SCHEMA_PROPERTY_ID_IRI, entityType: "Concept", sourceType: "NetworkResource" },
      object: { rawIdentifier: "validFromConfidence", entityType: "TextLiteral", sourceType: "TextLiteral" },
    });
    await append("report-validFromConfidence-value", {
      subject: { rawIdentifier: confidenceNode, entityType: "Concept", sourceType: "NetworkResource" },
      predicate: { rawIdentifier: SCHEMA_VALUE_IRI, entityType: "Concept", sourceType: "NetworkResource" },
      object: { rawIdentifier: validFromConfidence, entityType: "DecimalLiteral", sourceType: "DecimalLiteral" },
    });
    await append("report-validFromConfidence-valueReference", {
      subject: { rawIdentifier: confidenceNode, entityType: "Concept", sourceType: "NetworkResource" },
      predicate: { rawIdentifier: SCHEMA_VALUE_REFERENCE_IRI, entityType: "Concept", sourceType: "NetworkResource" },
      object: { rawIdentifier: SCHEMA_VALID_FROM_IRI, entityType: "Concept", sourceType: "NetworkResource" },
    });
  }

  const summary = {
    mode: "fixtures-add-evidence-report",
    scenario,
    statementInputsPath,
    reportUrl,
    targetStatementRaw,
    validFromConfidence,
    created,
  };

  if (hasFlag(flags, "json")) {
    printJson(summary);
  } else {
    console.log(`${reportUrl}`);
  }
  return 0;
}

async function runAddEvidencePart(flags: Map<string, string | boolean>): Promise<number> {
  const scenario = getStringFlag(flags, "scenario");
  const reportUrl = getStringFlag(flags, "report-url");
  const sourceUrl = getStringFlag(flags, "source-url");

  if (!scenario || !reportUrl || !sourceUrl) {
    console.error("Missing required flags for `fixtures add-evidence-part`.");
    console.error(fixturesHelp());
    return 1;
  }

  const repoRoot = repoRootFromThisFile();
  const statementInputsPath = await resolveScenarioInputsPath(repoRoot, scenario);
  const result = await appendStatementInputIfMissing(statementInputsPath, {
    subject: { rawIdentifier: reportUrl, entityType: "CreativeWork", sourceType: "NetworkResource" },
    predicate: { rawIdentifier: SCHEMA_IS_BASED_ON_IRI, entityType: "Concept", sourceType: "NetworkResource" },
    object: { rawIdentifier: sourceUrl, entityType: "NetworkResource", sourceType: "NetworkResource" },
  });

  const summary = {
    mode: "fixtures-add-evidence-part",
    scenario,
    statementInputsPath,
    reportUrl,
    sourceUrl,
    appended: result.appended,
  };
  if (hasFlag(flags, "json")) {
    printJson(summary);
  } else {
    console.log(`${result.appended ? "appended" : "already-exists"} ${statementInputsPath}`);
  }
  return 0;
}

async function runAddEvidenceSummary(flags: Map<string, string | boolean>): Promise<number> {
  const scenario = getStringFlag(flags, "scenario");
  const reportUrl = getStringFlag(flags, "report-url");
  const text = getStringFlag(flags, "text");

  if (!scenario || !reportUrl || !text) {
    console.error("Missing required flags for `fixtures add-evidence-summary`.");
    console.error(fixturesHelp());
    return 1;
  }

  const repoRoot = repoRootFromThisFile();
  const statementInputsPath = await resolveScenarioInputsPath(repoRoot, scenario);
  const result = await appendStatementInputIfMissing(statementInputsPath, {
    subject: { rawIdentifier: reportUrl, entityType: "CreativeWork", sourceType: "NetworkResource" },
    predicate: { rawIdentifier: SCHEMA_DESCRIPTION_IRI, entityType: "Concept", sourceType: "NetworkResource" },
    object: { rawIdentifier: text, entityType: "TextLiteral", sourceType: "TextLiteral" },
  });

  const summary = {
    mode: "fixtures-add-evidence-summary",
    scenario,
    statementInputsPath,
    reportUrl,
    appended: result.appended,
  };
  if (hasFlag(flags, "json")) {
    printJson(summary);
  } else {
    console.log(`${result.appended ? "appended" : "already-exists"} ${statementInputsPath}`);
  }
  return 0;
}

async function runRebuild(flags: Map<string, string | boolean>): Promise<number> {
  const scenario = getStringFlag(flags, "scenario");
  if (!scenario) {
    console.error("Missing required flag: --scenario <id>");
    return 1;
  }
  const repoRoot = repoRootFromThisFile();
  await runGraphScript(repoRoot, "build:fixture", ["--scenario", scenario]);
  await runGraphScript(repoRoot, "fixtures:update", ["--scenario", scenario]);

  const summary = { mode: "fixtures-rebuild", scenario, updatedExpected: true };
  if (hasFlag(flags, "json")) {
    printJson(summary);
  } else {
    console.log(`rebuilt ${scenario}`);
  }
  return 0;
}

async function runCheck(flags: Map<string, string | boolean>): Promise<number> {
  const scenario = getStringFlag(flags, "scenario");
  const repoRoot = repoRootFromThisFile();
  const extra = scenario ? ["--scenario", scenario] : [];
  await runGraphScript(repoRoot, "fixtures:check", extra);

  const summary = { mode: "fixtures-check", scenario: scenario ?? null };
  if (hasFlag(flags, "json")) {
    printJson(summary);
  } else {
    console.log(`checked ${scenario ?? "all fixtures"}`);
  }
  return 0;
}

export async function runFixturesCommand(command: string | undefined, args: string[]): Promise<number> {
  if (!command || command === "--help") {
    console.log(fixturesHelp());
    return 0;
  }

  const { flags } = parseArgs(args);

  if (command === "add") {
    return runAdd(flags);
  }
  if (command === "add-valid-from") {
    return runAddValidFrom(flags);
  }
  if (command === "add-primary-source") {
    return runAddPrimarySource(flags);
  }
  if (command === "add-evidence-report") {
    return runAddEvidenceReport(flags);
  }
  if (command === "add-evidence-part") {
    return runAddEvidencePart(flags);
  }
  if (command === "add-evidence-summary") {
    return runAddEvidenceSummary(flags);
  }
  if (command === "rebuild") {
    return runRebuild(flags);
  }
  if (command === "check") {
    return runCheck(flags);
  }

  console.error(`Unknown fixtures command: ${command}`);
  console.error(fixturesHelp());
  return 1;
}
