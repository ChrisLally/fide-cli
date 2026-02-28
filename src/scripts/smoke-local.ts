import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { calculateFideId, calculateStatementFideId } from "@chris-test/fcp";
import { markdownTable, writeMarkdownReport } from "../lib/report.js";

type ReportItem = {
  slug: string;
  label: string;
  description: string;
};

type ScenarioMeta = {
  id: string;
  title: string;
  description: string;
  capturedAt?: string;
};

type ScenarioStatement = {
  statement_fide_id?: string;
  first_created_at?: number;
  subject_type: string;
  subject_raw_identifier: string;
  predicate_raw_identifier: string;
  object_type: string;
  object_raw_identifier: string;
};

type ScenarioState = {
  statements?: ScenarioStatement[];
  raw_identifiers?: Array<{ raw_identifier: string }>;
};

type FixtureConfig = {
  slug: string;
  label: string;
  scenarioDir: string;
  entityType: string;
  selectIdentifierContains?: string;
  selectNameContains?: string;
};

type FixtureBundle = {
  key: string;
  meta: ScenarioMeta;
  state: ScenarioState;
};

type StatementWire = {
  s: string;
  sr: string;
  p: string;
  pr: string;
  o: string;
  or: string;
};

type SchemaOrgTerm = {
  label: string | null;
  description: string | null;
};

function runShell(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: "inherit",
      shell: false,
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`${cmd} ${args.join(" ")} failed with exit code ${code ?? -1}`));
      }
    });

    child.on("error", rejectPromise);
  });
}

function toUnique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function compact(value: string, max = 88): string {
  if (value.length <= max) return value;
  const head = Math.max(20, Math.floor((max - 3) * 0.6));
  const tail = Math.max(10, max - 3 - head);
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function asLink(value: string): string {
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return `[${compact(value, 72)}](${value})`;
  }
  return `\`${compact(value, 72)}\``;
}

function makeLabel(value: string): string {
  if (value.includes("owl#sameAs")) return "owl:sameAs";
  const hashIndex = value.lastIndexOf("#");
  if (hashIndex >= 0 && hashIndex < value.length - 1) return value.slice(hashIndex + 1);
  const slashIndex = value.lastIndexOf("/");
  if (slashIndex >= 0 && slashIndex < value.length - 1) return value.slice(slashIndex + 1);
  return value;
}

function extractJsonLdText(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const extracted = extractJsonLdText(item);
      if (extracted) return extracted;
    }
    return null;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record["@value"] === "string") return record["@value"];
    if (typeof record["@id"] === "string") return record["@id"];
  }
  return null;
}

async function loadSchemaOrgTermsFromLocal(repoRoot: string): Promise<Map<string, SchemaOrgTerm>> {
  const vocabPath = resolve(repoRoot, "packages/evaluation-methods/vocab/schemaorg-current-https.jsonld");
  const source = await readFile(vocabPath, "utf8");
  const payload = JSON.parse(source) as { "@graph"?: unknown[] };
  const graph = Array.isArray(payload["@graph"]) ? payload["@graph"] : [];
  const terms = new Map<string, SchemaOrgTerm>();

  for (const node of graph) {
    if (!node || typeof node !== "object") continue;
    const record = node as Record<string, unknown>;
    const id = typeof record["@id"] === "string" ? record["@id"] : null;
    if (!id) continue;
    const label = extractJsonLdText(record["rdfs:label"]);
    const description = extractJsonLdText(record["rdfs:comment"]);
    const term: SchemaOrgTerm = { label, description };
    terms.set(id, term);
    if (id.startsWith("schema:")) {
      terms.set(`https://schema.org/${id.slice("schema:".length)}`, term);
    }
  }
  return terms;
}

function predicateLabel(value: string, schemaTerms: Map<string, SchemaOrgTerm>): string {
  const term = schemaTerms.get(value);
  if (term?.label) return term.label;
  return makeLabel(value);
}

function parseDomain(value: string): string {
  if (!(value.startsWith("http://") || value.startsWith("https://"))) return "non-url";
  try {
    return new URL(value).hostname;
  } catch {
    return "invalid-url";
  }
}

function classifySourceType(value: string): string {
  if (value.startsWith("did:fide:") && value.includes("|")) return "StatementIdentifier";
  if (value.startsWith("did:fide:")) return "FideId";

  if (value.startsWith("http://") || value.startsWith("https://")) {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      const path = url.pathname.toLowerCase();
      const isPlatformAccount =
        (host === "x.com" && /^\/[^/]+\/?$/.test(path))
        || (host === "www.linkedin.com" && (path.startsWith("/company/") || path.startsWith("/in/")))
        || (host === "github.com" && /^\/[^/]+\/?$/.test(path))
        || (host === "www.youtube.com" && (path.startsWith("/@") || path.startsWith("/channel/") || path.startsWith("/c/")))
        || (host === "youtube.com" && (path.startsWith("/@") || path.startsWith("/channel/") || path.startsWith("/c/")));
      return isPlatformAccount ? "PlatformAccount" : "NetworkResource";
    } catch {
      return "NetworkResource";
    }
  }

  if (value.includes("@")) return "AccountHandle";
  return "Literal";
}

function mapCountRows(counts: Map<string, number>, top = 10): string[][] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([key, value]) => [key, String(value)]);
}

function domainOrDash(value: string): string {
  const domain = parseDomain(value);
  return domain === "non-url" || domain === "invalid-url" ? "-" : domain;
}

function buildSourceSnapshotLines(references: string[], maxRows = 10): string[] {
  const refCounts = new Map<string, number>();
  const domainCounts = new Map<string, number>();
  const typeCounts = new Map<string, number>();

  for (const ref of references) {
    refCounts.set(ref, (refCounts.get(ref) ?? 0) + 1);
    const domain = parseDomain(ref);
    domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
    const kind = classifySourceType(ref);
    typeCounts.set(kind, (typeCounts.get(kind) ?? 0) + 1);
  }

  const lines: string[] = [];
  lines.push("### Source Types");
  lines.push(...markdownTable(["Source Type", "Mentions"], mapCountRows(typeCounts, maxRows)));
  lines.push("");

  lines.push("### Source Domains");
  lines.push(...markdownTable(["Domain", "Mentions"], mapCountRows(domainCounts, maxRows)));
  lines.push("");

  lines.push("### Most Referenced Items");
  lines.push(...markdownTable(
    ["Reference", "Source Type", "Domain", "Mentions"],
    mapCountRows(refCounts, maxRows).map(([value, count]) => [
      asLink(value),
      classifySourceType(value),
      domainOrDash(value),
      count,
    ]),
  ));

  return lines;
}

async function readJsonFile<T>(path: string): Promise<T> {
  const source = await readFile(path, "utf8");
  return JSON.parse(source) as T;
}

async function loadFixture(repoRoot: string, scenarioDir: string): Promise<FixtureBundle> {
  const metaPath = resolve(repoRoot, scenarioDir, "meta.json");
  const statePath = resolve(repoRoot, scenarioDir, "state.json");
  const meta = await readJsonFile<ScenarioMeta>(metaPath);
  const state = await readJsonFile<ScenarioState>(statePath);
  return {
    key: scenarioDir,
    meta,
    state,
  };
}

function inferSourceType(entityType: string, rawIdentifier: string): string {
  if (entityType === "Statement") return "Statement";
  if (entityType.endsWith("Literal")) return entityType;
  if (rawIdentifier.startsWith("http://") || rawIdentifier.startsWith("https://")) return "NetworkResource";
  return entityType;
}

async function fixtureStateToWires(state: ScenarioState): Promise<StatementWire[]> {
  const rows = state.statements ?? [];
  const wires: StatementWire[] = [];

  for (const row of rows) {
    const subjectFideId = await calculateFideId(
      row.subject_type as Parameters<typeof calculateFideId>[0],
      inferSourceType(row.subject_type, row.subject_raw_identifier) as Parameters<typeof calculateFideId>[1],
      row.subject_raw_identifier,
    );
    const predicateFideId = await calculateFideId(
      "Concept",
      "NetworkResource",
      row.predicate_raw_identifier,
    );
    const objectFideId = await calculateFideId(
      row.object_type as Parameters<typeof calculateFideId>[0],
      inferSourceType(row.object_type, row.object_raw_identifier) as Parameters<typeof calculateFideId>[1],
      row.object_raw_identifier,
    );

    wires.push({
      s: subjectFideId,
      sr: row.subject_raw_identifier,
      p: predicateFideId,
      pr: row.predicate_raw_identifier,
      o: objectFideId,
      or: row.object_raw_identifier,
    });
  }

  return wires;
}

function wiresToJsonl(wires: StatementWire[]): string {
  return `${wires.map((wire) => JSON.stringify(wire)).join("\n")}\n`;
}

function findFocalIdentifier(config: FixtureConfig, statements: ScenarioStatement[]): string | null {
  const candidates = toUnique(
    statements
      .filter((row) => row.subject_type === config.entityType)
      .map((row) => row.subject_raw_identifier),
  );

  if (candidates.length === 0) return null;

  if (config.selectIdentifierContains) {
    const match = candidates.find((value) => value.includes(config.selectIdentifierContains!));
    if (match) return match;
  }

  if (config.selectNameContains) {
    const byName = statements
      .filter(
        (row) =>
          row.subject_type === config.entityType
          && row.predicate_raw_identifier === "https://schema.org/name"
          && row.object_raw_identifier.toLowerCase().includes(config.selectNameContains!.toLowerCase()),
      )
      .map((row) => row.subject_raw_identifier);
    if (byName[0]) return byName[0];
  }

  return candidates[0] ?? null;
}

type PrimaryFideIdResult = {
  primaryFideId: `did:fide:0x${string}`;
  anchorSameAsStatementRawIdentifier: string;
  anchorValidFromStatementFideId: string | null;
  anchorValidFromFirstSeenAt: number | null;
};

async function findPrimaryFideId(
  config: FixtureConfig,
  statements: ScenarioStatement[],
  focalIdentifier: string,
): Promise<PrimaryFideIdResult | null> {
  const owlSameAsStatements = statements.filter(
    (row) =>
      row.predicate_raw_identifier === "https://www.w3.org/2002/07/owl#sameAs"
      && row.subject_type === config.entityType
      && (row.subject_raw_identifier === focalIdentifier || row.object_raw_identifier === focalIdentifier),
  );

  const sameAsStatementIdSet = new Set<string>();
  for (const row of owlSameAsStatements) {
    if (row.statement_fide_id) {
      sameAsStatementIdSet.add(row.statement_fide_id);
    }
  }

  const validFromCandidates: Array<{
    statementFideId: string | null;
    firstSeenAt: number | null;
    subjectRawIdentifier: string;
  }> = [];

  for (const row of statements) {
    if (row.predicate_raw_identifier !== "https://schema.org/validFrom") continue;
    if (row.subject_type !== "Statement") continue;

    const parts = row.subject_raw_identifier.split("|");
    if (parts.length !== 3) continue;
    if (!parts.every((part) => part.startsWith("did:fide:0x"))) continue;

    try {
      const targetStatementFideId = await calculateStatementFideId(
        parts[0] as `did:fide:0x${string}`,
        parts[1] as `did:fide:0x${string}`,
        parts[2] as `did:fide:0x${string}`,
      );
      if (!sameAsStatementIdSet.has(targetStatementFideId)) continue;

      validFromCandidates.push({
        statementFideId: row.statement_fide_id ?? null,
        firstSeenAt: row.first_created_at ?? null,
        subjectRawIdentifier: row.subject_raw_identifier,
      });
    } catch {
      continue;
    }
  }

  if (validFromCandidates.length === 0) return null;

  validFromCandidates.sort((a, b) => {
    const at = a.firstSeenAt ?? Number.MAX_SAFE_INTEGER;
    const bt = b.firstSeenAt ?? Number.MAX_SAFE_INTEGER;
    if (at !== bt) return at - bt;
    const aid = a.statementFideId ?? "~";
    const bid = b.statementFideId ?? "~";
    if (aid !== bid) return aid.localeCompare(bid);
    return a.subjectRawIdentifier.localeCompare(b.subjectRawIdentifier);
  });

  const winner = validFromCandidates[0];
  const primaryFideId = await calculateFideId(
    config.entityType as Parameters<typeof calculateFideId>[0],
    "Statement",
    winner.subjectRawIdentifier,
  );

  return {
    primaryFideId,
    anchorSameAsStatementRawIdentifier: winner.subjectRawIdentifier,
    anchorValidFromStatementFideId: winner.statementFideId,
    anchorValidFromFirstSeenAt: winner.firstSeenAt,
  };
}

async function writeFixtureProfileReport(params: {
  outDir: string;
  fixture: FixtureBundle;
  config: FixtureConfig;
  schemaTerms: Map<string, SchemaOrgTerm>;
}): Promise<ReportItem> {
  const statements = params.fixture.state.statements ?? [];
  const focal = findFocalIdentifier(params.config, statements);

  if (!focal) {
    throw new Error(`No focal identifier found for ${params.config.slug}`);
  }
  const primary = await findPrimaryFideId(params.config, statements, focal);

  const relatedStatements = statements.filter(
    (row) => row.subject_raw_identifier === focal || row.object_raw_identifier === focal,
  );

  const knownNames = toUnique(
    statements
      .filter(
        (row) =>
          row.subject_raw_identifier === focal && row.predicate_raw_identifier === "https://schema.org/name",
      )
      .map((row) => row.object_raw_identifier),
  );

  const sameAsIdentifiers = toUnique(
    statements
      .filter((row) => row.predicate_raw_identifier === "https://www.w3.org/2002/07/owl#sameAs")
      .flatMap((row) => {
        const values: string[] = [];
        if (row.subject_raw_identifier === focal) values.push(row.object_raw_identifier);
        if (row.object_raw_identifier === focal) values.push(row.subject_raw_identifier);
        return values;
      }),
  );

  const relationshipRows = relatedStatements
    .filter(
      (row) => row.subject_raw_identifier === focal
        && row.predicate_raw_identifier !== "https://schema.org/name"
        && row.predicate_raw_identifier !== "https://www.w3.org/2002/07/owl#sameAs",
    )
    .slice(0, 20)
    .map((row) => [predicateLabel(row.predicate_raw_identifier, params.schemaTerms), row.object_type, asLink(row.object_raw_identifier)]);

  const schemaPredicateRows = toUnique(
    relatedStatements
      .map((row) => row.predicate_raw_identifier)
      .filter((iri) => iri.startsWith("https://schema.org/")),
  )
    .slice(0, 12)
    .map((iri) => {
      const term = params.schemaTerms.get(iri);
      return [
        asLink(iri),
        term?.label ?? makeLabel(iri),
        term?.description ? compact(term.description, 180) : "n/a",
      ];
    });

  await writeMarkdownReport({
    reportPath: resolve(params.outDir, `${params.config.slug}.mdx`),
    title: params.config.label,
    description: params.fixture.meta.description.replaceAll("sameAs claim", "owl:sameAs statement"),
    sections: [
      {
        heading: "Executive Summary",
        lines: [
          `${params.config.label} shows identity anchors, key relationships, and source coverage for ${asLink(focal)}.`,
        ],
      },
      {
        heading: "Key Facts",
        lines: markdownTable(
          ["Field", "Value"],
          [
            ["Entity type", params.config.entityType],
            ["Primary Fide ID", primary ? `\`${primary.primaryFideId}\`` : "Not resolved"],
            ["Anchor owl:sameAs Statement", primary ? `\`${primary.anchorSameAsStatementRawIdentifier}\`` : "Not resolved"],
            ["Anchor validFrom Statement Fide ID", primary?.anchorValidFromStatementFideId ? `\`${primary.anchorValidFromStatementFideId}\`` : "Not resolved"],
            ["Anchor validFrom first_created_at", primary?.anchorValidFromFirstSeenAt ? String(primary.anchorValidFromFirstSeenAt) : "Not resolved"],
            ["Display focal identifier", asLink(focal)],
            ["Known names", knownNames.length > 0 ? knownNames.join(", ") : "None found"],
            ["Connected owl:sameAs identifiers", String(sameAsIdentifiers.length)],
            ["Related statements", String(relatedStatements.length)],
            ["Captured at", params.fixture.meta.capturedAt ?? "Unknown"],
          ],
        ),
      },
      {
        heading: "Primary ID Selection Rule",
        lines: [
          "Primary Fide ID is anchored to the first trusted `schema:validFrom` statement whose subject is an `owl:sameAs` statement in this profile cluster.",
          "Selection uses `first_created_at` (first seen), not the `schema:validFrom` literal value.",
          "Tie-breakers are deterministic: statement Fide ID (lexicographic), then subject raw identifier (lexicographic).",
          primary
            ? `Chosen anchor: \`${primary.anchorValidFromStatementFideId ?? "Not resolved"}\` at first seen \`${primary.anchorValidFromFirstSeenAt ?? "Not resolved"}\`.`
            : "No trusted `schema:validFrom` statement-about-statement was found for this profile yet, so primary ID is not resolved.",
        ],
      },
      {
        heading: "Identity Anchors",
        lines: sameAsIdentifiers.length > 0
          ? markdownTable(["Identifier"], sameAsIdentifiers.map((value) => [asLink(value)]))
          : ["No connected owl:sameAs identifiers found."],
      },
      {
        heading: "Relationship Highlights",
        lines: relationshipRows.length > 0
          ? markdownTable(["Relationship", "Target type", "Target"], relationshipRows)
          : ["No additional relationships found for this profile."],
      },
      {
        heading: "Source Snapshot",
        lines: buildSourceSnapshotLines(
          relatedStatements.flatMap((row) => [row.subject_raw_identifier, row.object_raw_identifier]),
          12,
        ),
      },
      ...(schemaPredicateRows.length > 0
        ? [{
            heading: "Schema.org Predicate Context",
            lines: markdownTable(
              ["Predicate", "Label", "Description"],
              schemaPredicateRows,
            ),
          }]
        : []),
    ],
  });

  return {
    slug: params.config.slug,
    label: params.config.label,
    description: `Identity profile generated from fixture scenario: ${params.fixture.meta.title}.`,
  };
}

async function writeOwlSameAsStatementReports(params: {
  outDir: string;
  fixtures: FixtureBundle[];
  maxStatements: number;
}): Promise<ReportItem[]> {
  const sameAsRows = params.fixtures
    .flatMap((fixture) => (fixture.state.statements ?? []).map((row) => ({ fixture, row })))
    .filter(({ row }) => row.predicate_raw_identifier === "https://www.w3.org/2002/07/owl#sameAs")
    .slice(0, params.maxStatements);

  const items: ReportItem[] = [];

  let index = 1;
  for (const entry of sameAsRows) {
    const slug = `statement-${String(index).padStart(4, "0")}`;
    const row = entry.row;

    await writeMarkdownReport({
      reportPath: resolve(params.outDir, `${slug}.mdx`),
      title: `owl:sameAs Statement ${String(index).padStart(4, "0")}`,
      description: `Shows one owl:sameAs statement and its source context.`,
      sections: [
        {
          heading: "Executive Summary",
          lines: [
            `This report covers one owl:sameAs statement from fixture scenario \`${entry.fixture.meta.id}\`.`,
          ],
        },
        {
          heading: "owl:sameAs Statement",
          lines: markdownTable(
            ["Field", "Value"],
            [
              ["Statement Fide ID", row.statement_fide_id ? `\`${row.statement_fide_id}\`` : "Not available"],
              ["Subject", asLink(row.subject_raw_identifier)],
              ["Predicate", "owl:sameAs"],
              ["Object", asLink(row.object_raw_identifier)],
              ["Scenario", entry.fixture.meta.id],
            ],
          ),
        },
        {
          heading: "Source Snapshot",
          lines: buildSourceSnapshotLines([row.subject_raw_identifier, row.object_raw_identifier], 8),
        },
      ],
    });

    items.push({
      slug,
      label: `owl:sameAs Statement ${String(index).padStart(4, "0")}`,
      description: `From ${entry.fixture.meta.id}: ${row.subject_raw_identifier} -> ${row.object_raw_identifier}`,
    });

    index += 1;
  }

  return items;
}

async function writeIndexPage(params: {
  path: string;
  title: string;
  description: string;
  items: ReportItem[];
  relativePrefix?: string;
  extraLines?: string[];
}): Promise<void> {
  const prefix = params.relativePrefix ?? "./";
  const generatedAt = new Date().toISOString().slice(0, 10);
  const lines = ["| Report | What it tells you |", "| --- | --- |"];
  for (const item of params.items) {
    lines.push(`| [${item.label}](${prefix}${item.slug}) | ${item.description.replaceAll("|", "\\|")} |`);
  }

  const extra = params.extraLines?.join("\n") ?? "";
  const source = `---
title: "${params.title.replaceAll('"', '\\"')}"
description: "${params.description.replaceAll('"', '\\"')}"
---

Generated at: ${generatedAt}

## Reports
${lines.join("\n")}${extra ? `\n\n${extra}` : ""}
`;

  await writeFile(params.path, source, "utf8");
}

async function writeMeta(path: string, title: string, pages: string[], root = true): Promise<void> {
  const metaJson = {
    title,
    description: "Generated graph test reports",
    root,
    defaultOpen: false,
    icon: "FileText",
    pages,
  };
  await writeFile(path, `${JSON.stringify(metaJson, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const cliPackageRoot = process.cwd();
  const repoRoot = resolve(cliPackageRoot, "../..");
  const fixtureScenarioDirs = [
    "packages/graph/fixtures/scenarios/identity-resolution/person-jeff-bezos",
    "packages/graph/fixtures/scenarios/identity-resolution/person-elon-musk",
    "packages/graph/fixtures/scenarios/identity-resolution/org-amazon",
    "packages/graph/fixtures/scenarios/identity-resolution/org-spacex",
    "packages/graph/fixtures/scenarios/identity-resolution/org-openai",
    "packages/graph/fixtures/scenarios/identity-attributes/concept-crypto-assets",
  ] as const;

  process.stdout.write("\n[reports] reset local db\n");
  await runShell("pnpm", ["-C", resolve(repoRoot, "packages/db"), "run", "db:reset:local"], repoRoot);

  const reportOutDir = resolve(repoRoot, "apps/docs/content/graph/reports");
  const profileOutDir = resolve(reportOutDir, "profiles");
  const scenarioOutDir = resolve(reportOutDir, "scenarios");

  await rm(reportOutDir, { recursive: true, force: true });
  await mkdir(profileOutDir, { recursive: true });
  await mkdir(scenarioOutDir, { recursive: true });

  const fixtures = await Promise.all(fixtureScenarioDirs.map((scenarioDir) => loadFixture(repoRoot, scenarioDir)));
  const schemaTerms = await loadSchemaOrgTermsFromLocal(repoRoot);

  process.stdout.write("\n[reports] ingest fixture statements\n");
  const ingestTmpDir = resolve(repoRoot, "_scratch/smoke/ingest");
  await mkdir(ingestTmpDir, { recursive: true });
  for (const fixture of fixtures) {
    const wires = await fixtureStateToWires(fixture.state);
    const ingestInputPath = resolve(ingestTmpDir, `${fixture.meta.id}.jsonl`);
    await writeFile(ingestInputPath, wiresToJsonl(wires), "utf8");
    await runShell(
      "node",
      [
        resolve(cliPackageRoot, "dist/bin/fide.js"),
        "ingest",
        "apply",
        "--in",
        ingestInputPath,
      ],
      repoRoot,
    );
  }

  const profileConfigs: FixtureConfig[] = [
    {
      slug: "jeff-bezos",
      label: "Jeff Bezos",
      scenarioDir: "packages/graph/fixtures/scenarios/identity-resolution/person-jeff-bezos",
      entityType: "Person",
      selectNameContains: "Jeff Bezos",
    },
    {
      slug: "amazon",
      label: "Amazon",
      scenarioDir: "packages/graph/fixtures/scenarios/identity-resolution/org-amazon",
      entityType: "Organization",
      selectNameContains: "Amazon",
    },
    {
      slug: "elon-musk",
      label: "Elon Musk",
      scenarioDir: "packages/graph/fixtures/scenarios/identity-resolution/person-elon-musk",
      entityType: "Person",
      selectNameContains: "Elon Musk",
    },
    {
      slug: "spacex",
      label: "SpaceX",
      scenarioDir: "packages/graph/fixtures/scenarios/identity-resolution/org-spacex",
      entityType: "Organization",
      selectNameContains: "Space Exploration Technologies Corp.",
    },
    {
      slug: "openai",
      label: "OpenAI",
      scenarioDir: "packages/graph/fixtures/scenarios/identity-resolution/org-openai",
      entityType: "Organization",
      selectNameContains: "OpenAI",
    },
    {
      slug: "bitcoin",
      label: "Bitcoin",
      scenarioDir: "packages/graph/fixtures/scenarios/identity-attributes/concept-crypto-assets",
      entityType: "CreativeWork",
      selectNameContains: "Bitcoin",
    },
  ];

  const fixtureByDir = new Map(fixtures.map((fixture) => [fixture.key, fixture]));
  const profileItems: ReportItem[] = [];
  for (const config of profileConfigs) {
    const fixture = fixtureByDir.get(config.scenarioDir);
    if (!fixture) {
      throw new Error(`Missing fixture for ${config.slug}`);
    }
    const item = await writeFixtureProfileReport({
      outDir: profileOutDir,
      fixture,
      config,
      schemaTerms,
    });
    profileItems.push(item);
  }

  const scenarioItems: ReportItem[] = fixtures.map((fixture) => ({
    slug: fixture.meta.id,
    label: fixture.meta.title,
    description: fixture.meta.description,
  }));

  for (const fixture of fixtures) {
    const statements = fixture.state.statements ?? [];
    const uniqueSubjects = toUnique(statements.map((row) => row.subject_raw_identifier));
    const uniqueObjects = toUnique(statements.map((row) => row.object_raw_identifier));
    const sameAsCount = statements.filter((row) => row.predicate_raw_identifier === "https://www.w3.org/2002/07/owl#sameAs").length;

    await writeMarkdownReport({
      reportPath: resolve(scenarioOutDir, `${fixture.meta.id}.mdx`),
      title: fixture.meta.title,
      description: fixture.meta.description.replaceAll("sameAs claim", "owl:sameAs statement"),
      sections: [
        {
          heading: "Executive Summary",
          lines: [fixture.meta.description.replaceAll("sameAs claim", "owl:sameAs statement")],
        },
        {
          heading: "Scenario Stats",
          lines: markdownTable(
            ["Field", "Value"],
            [
              ["Scenario ID", fixture.meta.id],
              ["Captured at", fixture.meta.capturedAt ?? "Unknown"],
              ["Total statements", String(statements.length)],
              ["owl:sameAs statements", String(sameAsCount)],
              ["Unique subject identifiers", String(uniqueSubjects.length)],
              ["Unique object identifiers", String(uniqueObjects.length)],
            ],
          ),
        },
      ],
    });
  }

  await writeIndexPage({
    path: resolve(profileOutDir, "index.mdx"),
    title: "Entity Profiles",
    description: "Profiles generated from real fixture scenarios.",
    items: profileItems,
    relativePrefix: "./profiles/",
  });

  await writeIndexPage({
    path: resolve(scenarioOutDir, "index.mdx"),
    title: "Scenario Reports",
    description: "Fixture scenario summaries and coverage stats.",
    items: scenarioItems,
    relativePrefix: "./scenarios/",
  });

  await writeIndexPage({
    path: resolve(reportOutDir, "index.mdx"),
    title: "Graph Test Reports",
    description: "Human-readable reports generated from real fixture scenarios.",
    items: [
      {
        slug: "profiles",
        label: "Entity Profiles",
        description: `${profileItems.length} real profiles with identity anchors and source snapshots.`,
      },
      {
        slug: "scenarios",
        label: "Scenario Reports",
        description: `${scenarioItems.length} scenario summaries with coverage metrics.`,
      },
    ],
    relativePrefix: "./",
    extraLines: [
      "## Coverage",
      `- Total reports: ${1 + profileItems.length + scenarioItems.length + 2}`,
      `- Profiles: ${profileItems.length}`,
      `- Scenarios: ${scenarioItems.length}`,
    ],
  });

  await writeMeta(resolve(reportOutDir, "meta.json"), "Reports", [
    "index",
    "profiles",
    "scenarios",
  ], true);
  await writeMeta(resolve(profileOutDir, "meta.json"), "Profiles", [
    "index",
    ...profileItems.map((item) => item.slug),
  ]);
  await writeMeta(resolve(scenarioOutDir, "meta.json"), "Scenarios", [
    "index",
    ...scenarioItems.map((item) => item.slug),
  ]);

  process.stdout.write(`\n[reports] complete: ${reportOutDir}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
