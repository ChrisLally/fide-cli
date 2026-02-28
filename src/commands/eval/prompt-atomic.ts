import { buildStatementRawIdentifier, parseFideId } from "@chris-test/fcp";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSameAsEvaluationInputBatchFromDb, closeRuntimeDbClient } from "@fide.work/indexer";
import { getStringFlag, hasFlag } from "../../lib/args.js";
import { printJson, writeUtf8 } from "../../lib/io.js";
import {
  type FideIdStatement,
  OWL_SAME_AS_IRI,
  buildStatementRawIdentifier as buildRawId,
  matchesStatementReference,
  shortFideSuffix,
  slugifyIdentifier,
  wiresToStatements,
} from "./shared.js";

const SCHEMA_VALID_FROM_IRI = "https://schema.org/validFrom";
const SCHEMA_VALID_THROUGH_IRI = "https://schema.org/validThrough";
const PROV_HAD_PRIMARY_SOURCE_IRI = "https://www.w3.org/ns/prov#hadPrimarySource";
const SCHEMA_ADDITIONAL_PROPERTY_IRI = "https://schema.org/additionalProperty";
const OWL_DIFFERENT_FROM_IRI = "https://www.w3.org/2002/07/owl#differentFrom";
const SCHEMA_NAME_IRI = "https://schema.org/name";

const TERM_DEFINITIONS: Record<string, string> = {
  "owl:sameAs": "owl:sameAs: indicates that two identifiers refer to the same entity.",
  "owl:differentFrom": "owl:differentFrom: indicates that two identifiers refer to different entities.",
  "schema:validFrom": "schema:validFrom: the date/time from which a statement is considered valid.",
  "schema:validThrough": "schema:validThrough: the date/time until which a statement is considered valid.",
  "schema:name": "schema:name: the name of an item.",
  "schema:version": "schema:version: the version identifier of a resource.",
  "schema:description": "schema:description: a description of an item.",
  "schema:isBasedOn": "schema:isBasedOn: a resource used as a source or basis.",
  "prov:hadPrimarySource": "prov:hadPrimarySource: links a statement to the primary source report used as evidence.",
  "fide:Statement": "fide:Statement: an atomic subject-predicate-object assertion.",
  "fide:Person": "fide:Person: a person entity type.",
  "fide:Organization": "fide:Organization: an organization entity type.",
  "fide:SoftwareAgent": "fide:SoftwareAgent: a software agent entity type.",
  "fide:NetworkResource": "fide:NetworkResource: a network-addressable identifier source.",
  "fide:PlatformAccount": "fide:PlatformAccount: an authority-hosted account identifier source.",
  "fide:CryptographicAccount": "fide:CryptographicAccount: a cryptographic account identifier source.",
  "fide:CreativeWork": "fide:CreativeWork: a creative work entity type.",
  "fide:Concept": "fide:Concept: a concept entity type.",
  "fide:Place": "fide:Place: a place entity type.",
  "fide:Event": "fide:Event: an event entity type.",
  "fide:Action": "fide:Action: an action entity type.",
  "fide:PhysicalObject": "fide:PhysicalObject: a physical object entity type.",
  "fide:TextLiteral": "fide:TextLiteral: a text literal value.",
  "fide:IntegerLiteral": "fide:IntegerLiteral: an integer literal value.",
  "fide:DecimalLiteral": "fide:DecimalLiteral: a decimal literal value.",
  "fide:BoolLiteral": "fide:BoolLiteral: a boolean literal value.",
  "fide:DateLiteral": "fide:DateLiteral: a date literal value.",
  "fide:TimeLiteral": "fide:TimeLiteral: a time literal value.",
  "fide:DateTimeLiteral": "fide:DateTimeLiteral: a datetime literal value.",
  "fide:DurationLiteral": "fide:DurationLiteral: a duration literal value.",
  "fide:URILiteral": "fide:URILiteral: a URI literal value.",
  "fide:JSONLiteral": "fide:JSONLiteral: a JSON literal value.",
};

const PERSON_AFFILIATION_PREDICATES = new Set([
  "https://schema.org/worksFor",
  "https://schema.org/memberOf",
  "https://schema.org/affiliation",
]);

type PromptDefinitionEntry = {
  term: string;
  kind: "entity_type" | "predicate" | "other";
  label?: string;
  definition?: string;
  category?: string;
  equivalentClass?: string[];
  subClassOf?: string[];
};

type VocabularyIndex = Map<string, PromptDefinitionEntry>;

let vocabularyIndexPromise: Promise<VocabularyIndex> | null = null;

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

function normalizeAtomicConsideration(value: string | null): AtomicConsideration | null {
  if (!value) return null;
  if (
    value === "citation_chain" ||
    value === "explicit_contradiction" ||
    value === "name_alignment" ||
    value === "affiliation_overlap" ||
    value === "valid_from_timestamp"
  ) {
    return value;
  }
  return null;
}

function defaultEvalPromptAtomicOutPath(
  params: { consideration: string; statementFideId: string; evidenceStatementFideId: string },
): string {
  const statementSlug = slugifyIdentifier(params.statementFideId);
  const evidenceShort = shortFideSuffix(params.evidenceStatementFideId);
  return [
    "_scratch/evals/prompts",
    "temporal-validity/owl-sameAs/Person",
    statementSlug,
    `${params.consideration}--${evidenceShort}.md`,
  ].join("/");
}

function passesPersonMethodCriteria(statement: FideIdStatement): { ok: true } | { ok: false; reason: string } {
  if (statement.predicateRawIdentifier !== OWL_SAME_AS_IRI) {
    return { ok: false, reason: "Target statement predicate must be owl:sameAs." };
  }
  const subjectType = parseFideId(statement.subjectFideId as `did:fide:0x${string}`).entityType;
  if (subjectType !== "Person") {
    return { ok: false, reason: `Person method requires Person subject type. Found: ${subjectType}.` };
  }
  return { ok: true };
}

function buildPersonPromptContextStatements(target: FideIdStatement, allStatements: FideIdStatement[]): FideIdStatement[] {
  const targetRaw = buildRawId(target.subjectFideId, target.predicateFideId, target.objectFideId);
  const validTemporal = allStatements.filter((statement) =>
    (statement.predicateRawIdentifier === SCHEMA_VALID_FROM_IRI || statement.predicateRawIdentifier === SCHEMA_VALID_THROUGH_IRI)
    && matchesStatementReference(statement, target),
  );

  const validTemporalSet = new Set(validTemporal.map((statement) => statement.statementFideId));
  const validTemporalRawSet = new Set<string>(
    validTemporal.map((statement) =>
      buildRawId(statement.subjectFideId, statement.predicateFideId, statement.objectFideId),
    ),
  );

  const citations = allStatements.filter((statement) =>
    statement.predicateRawIdentifier === PROV_HAD_PRIMARY_SOURCE_IRI
    && (
      validTemporalSet.has(statement.subjectFideId)
      || validTemporalSet.has(statement.subjectRawIdentifier)
      || validTemporalRawSet.has(statement.subjectRawIdentifier)
      || statement.subjectFideId === target.statementFideId
      || statement.subjectRawIdentifier === target.statementFideId
      || statement.subjectRawIdentifier === targetRaw
    ),
  );

  const names = allStatements.filter((statement) =>
    statement.predicateRawIdentifier === SCHEMA_NAME_IRI
    && (statement.subjectFideId === target.subjectFideId || statement.subjectFideId === target.objectFideId),
  );
  const affiliations = allStatements.filter((statement) =>
    PERSON_AFFILIATION_PREDICATES.has(statement.predicateRawIdentifier)
    && (statement.subjectFideId === target.subjectFideId || statement.subjectFideId === target.objectFideId),
  );
  const contradictions = allStatements.filter((statement) =>
    statement.predicateRawIdentifier === OWL_DIFFERENT_FROM_IRI
    && (
      (statement.subjectFideId === target.subjectFideId && statement.objectFideId === target.objectFideId)
      || (statement.subjectFideId === target.objectFideId && statement.objectFideId === target.subjectFideId)
    ),
  );

  const selected = new Map<string, FideIdStatement>();
  for (const statement of [target, ...validTemporal, ...citations, ...names, ...affiliations, ...contradictions]) {
    selected.set(statement.statementFideId, statement);
  }

  const citationObjects = citations.map((statement) => ({
    fideId: statement.objectFideId,
    rawIdentifier: statement.objectRawIdentifier,
  }));
  const reportStatements = allStatements.filter((statement) =>
    citationObjects.some((report) =>
      statement.subjectFideId === report.fideId
      || statement.subjectRawIdentifier === report.rawIdentifier),
  );
  for (const statement of reportStatements) {
    selected.set(statement.statementFideId, statement);
  }

  const propertyNodes = reportStatements
    .filter((statement) => statement.predicateRawIdentifier === SCHEMA_ADDITIONAL_PROPERTY_IRI)
    .map((statement) => ({
      fideId: statement.objectFideId,
      rawIdentifier: statement.objectRawIdentifier,
    }));
  const propertyNodeStatements = allStatements.filter((statement) =>
    propertyNodes.some((node) =>
      statement.subjectFideId === node.fideId
      || statement.subjectRawIdentifier === node.rawIdentifier),
  );
  for (const statement of propertyNodeStatements) {
    selected.set(statement.statementFideId, statement);
  }

  return [...selected.values()];
}

function toFideTypeCurie(entityType: string): string {
  return `fide:${entityType}`;
}

function toPredicateCurie(iri: string): string {
  if (iri.startsWith("https://schema.org/")) return `schema:${iri.slice("https://schema.org/".length)}`;
  if (iri.startsWith("https://www.w3.org/ns/prov#")) return `prov:${iri.slice("https://www.w3.org/ns/prov#".length)}`;
  if (iri.startsWith("https://www.w3.org/2002/07/owl#")) return `owl:${iri.slice("https://www.w3.org/2002/07/owl#".length)}`;
  if (iri.startsWith("https://www.w3.org/1999/02/22-rdf-syntax-ns#")) return `rdf:${iri.slice("https://www.w3.org/1999/02/22-rdf-syntax-ns#".length)}`;
  return iri;
}

function toKnownCurie(iri: string): string {
  if (iri.startsWith("https://fide.work/vocab#")) return `fide:${iri.slice("https://fide.work/vocab#".length)}`;
  if (iri.startsWith("https://schema.org/")) return `schema:${iri.slice("https://schema.org/".length)}`;
  if (iri.startsWith("http://www.w3.org/2000/01/rdf-schema#")) return `rdfs:${iri.slice("http://www.w3.org/2000/01/rdf-schema#".length)}`;
  if (iri.startsWith("http://www.w3.org/2002/07/owl#")) return `owl:${iri.slice("http://www.w3.org/2002/07/owl#".length)}`;
  if (iri.startsWith("https://www.w3.org/2002/07/owl#")) return `owl:${iri.slice("https://www.w3.org/2002/07/owl#".length)}`;
  if (iri.startsWith("http://www.w3.org/ns/prov#")) return `prov:${iri.slice("http://www.w3.org/ns/prov#".length)}`;
  if (iri.startsWith("https://www.w3.org/ns/prov#")) return `prov:${iri.slice("https://www.w3.org/ns/prov#".length)}`;
  if (iri.startsWith("http://www.w3.org/1999/02/22-rdf-syntax-ns#")) return `rdf:${iri.slice("http://www.w3.org/1999/02/22-rdf-syntax-ns#".length)}`;
  if (iri.startsWith("http://www.w3.org/2001/XMLSchema#")) return `xsd:${iri.slice("http://www.w3.org/2001/XMLSchema#".length)}`;
  if (iri.startsWith("http://www.w3.org/ns/org#")) return `org:${iri.slice("http://www.w3.org/ns/org#".length)}`;
  if (iri.startsWith("https://w3id.org/security#")) return `sec:${iri.slice("https://w3id.org/security#".length)}`;
  return iri;
}

function curieToIri(term: string): string | null {
  const [prefix, local] = term.split(":");
  if (!prefix || !local) return null;
  if (prefix === "fide") return `https://fide.work/vocab#${local}`;
  if (prefix === "schema") return `https://schema.org/${local}`;
  if (prefix === "prov") return `http://www.w3.org/ns/prov#${local}`;
  if (prefix === "owl") return `http://www.w3.org/2002/07/owl#${local}`;
  if (prefix === "rdf") return `http://www.w3.org/1999/02/22-rdf-syntax-ns#${local}`;
  if (prefix === "rdfs") return `http://www.w3.org/2000/01/rdf-schema#${local}`;
  if (prefix === "xsd") return `http://www.w3.org/2001/XMLSchema#${local}`;
  if (prefix === "org") return `http://www.w3.org/ns/org#${local}`;
  if (prefix === "sec") return `https://w3id.org/security#${local}`;
  return null;
}

function getJsonLdText(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const extracted = getJsonLdText(item);
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

function getJsonLdIds(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => getJsonLdIds(item));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record["@id"] === "string") return [record["@id"]];
  }
  return [];
}

function vocabularyRepoRootFromThisFile(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../../../");
}

async function loadVocabularyIndex(): Promise<VocabularyIndex> {
  if (vocabularyIndexPromise) return vocabularyIndexPromise;
  vocabularyIndexPromise = (async () => {
    const repoRoot = vocabularyRepoRootFromThisFile();
    const files = [
      resolve(repoRoot, "packages/evaluation-methods/vocab/fide.jsonld"),
      resolve(repoRoot, "packages/evaluation-methods/vocab/schemaorg-current-https.jsonld"),
      resolve(repoRoot, "packages/evaluation-methods/vocab/prov-o.jsonld"),
      resolve(repoRoot, "packages/evaluation-methods/vocab/owl.jsonld"),
    ];
    const index: VocabularyIndex = new Map();

    for (const path of files) {
      let source = "";
      try {
        source = await readFile(path, "utf8");
      } catch {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(source);
      } catch {
        continue;
      }
      const graph = Array.isArray((parsed as { "@graph"?: unknown[] })["@graph"])
        ? (parsed as { "@graph": unknown[] })["@graph"]
        : [];
      for (const node of graph) {
        if (!node || typeof node !== "object") continue;
        const record = node as Record<string, unknown>;
        const id = typeof record["@id"] === "string" ? record["@id"] : null;
        if (!id) continue;
        const curie = toKnownCurie(id);
        const definition: PromptDefinitionEntry = {
          term: curie,
          kind: curie.startsWith("fide:") ? "entity_type" : curie.includes(":") ? "predicate" : "other",
          label: getJsonLdText(record["rdfs:label"]) ?? getJsonLdText(record["schema:name"]) ?? undefined,
          definition: getJsonLdText(record["rdfs:comment"]) ?? undefined,
          category: getJsonLdText(record["schema:category"]) ?? undefined,
          equivalentClass: getJsonLdIds(record["owl:equivalentClass"]).map(toKnownCurie),
          subClassOf: getJsonLdIds(record["rdfs:subClassOf"]).map(toKnownCurie),
        };
        index.set(curie, definition);
        index.set(id, definition);
      }
    }
    return index;
  })();
  return vocabularyIndexPromise;
}

function normalizeDefinitionEntry(entry: PromptDefinitionEntry): PromptDefinitionEntry {
  const cleaned: PromptDefinitionEntry = { ...entry };
  if (!cleaned.label) delete cleaned.label;
  if (!cleaned.definition) delete cleaned.definition;
  if (!cleaned.category) delete cleaned.category;
  if (!cleaned.equivalentClass || cleaned.equivalentClass.length === 0) delete cleaned.equivalentClass;
  if (!cleaned.subClassOf || cleaned.subClassOf.length === 0) delete cleaned.subClassOf;
  return cleaned;
}

async function buildDefinitionsMarkdown(terms: string[]): Promise<string[]> {
  const index = await loadVocabularyIndex();
  const definitions: PromptDefinitionEntry[] = terms
    .map((term) => {
      const fromIndex = index.get(term) ?? (curieToIri(term) ? index.get(curieToIri(term)!) : undefined);
      if (fromIndex) {
        return normalizeDefinitionEntry({
          ...fromIndex,
          term,
        });
      }
      const fallback = TERM_DEFINITIONS[term];
      const kind: PromptDefinitionEntry["kind"] = term.startsWith("fide:")
        ? "entity_type"
        : term.includes(":")
          ? "predicate"
          : "other";
      return normalizeDefinitionEntry({
        term,
        kind,
        definition: fallback ? fallback.replace(/^[^:]+:\s*/, "") : "definition not available.",
      });
    })
    .sort((a, b) => a.term.localeCompare(b.term));

  const lines: string[] = [];
  for (const definition of definitions) {
    lines.push(`### ${definition.term}`);
    lines.push(`- kind: ${definition.kind}`);
    if (definition.definition) lines.push(`- definition: ${definition.definition}`);
    if (definition.label) lines.push(`- label: ${definition.label}`);
    if (definition.category) lines.push(`- category: ${definition.category}`);
    if (definition.equivalentClass?.length) lines.push(`- equivalentClass: ${definition.equivalentClass.join(", ")}`);
    if (definition.subClassOf?.length) lines.push(`- subClassOf: ${definition.subClassOf.join(", ")}`);
    lines.push("");
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
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
      statement.subjectFideId === evidence.objectFideId
      || statement.subjectRawIdentifier === evidence.objectRawIdentifier,
  );
  if (reportStatements.length === 0) {
    return ["none"];
  }
  const getFirstObject = (predicateRawIdentifier: string): string | null =>
    reportStatements.find((statement) => statement.predicateRawIdentifier === predicateRawIdentifier)?.objectRawIdentifier ?? null;
  const collectObjects = (predicateRawIdentifier: string): string[] =>
    reportStatements
      .filter((statement) => statement.predicateRawIdentifier === predicateRawIdentifier)
      .map((statement) => statement.objectRawIdentifier);

  const name = getFirstObject(SCHEMA_NAME_IRI);
  const version = getFirstObject("https://schema.org/version");
  const description = getFirstObject("https://schema.org/description");
  const basedOn = collectObjects("https://schema.org/isBasedOn");

  const lines: string[] = [];
  if (name) {
    const normalizedName = (() => {
      const hasSameAs = name.includes("owl:sameAs");
      const hasValidFrom = name.includes("validFrom");
      return hasSameAs && hasValidFrom
        ? name
        : "owl:sameAs validFrom evidence report";
    })();
    lines.push(`schema:name: "${normalizedName}"`);
  }
  if (version) lines.push(`schema:version: "${version}"`);
  if (description) {
    const cleaned = description.replace(/^Estimated validFrom confidence=[0-9]*\.?[0-9]+\.\s*/i, "");
    lines.push(`schema:description: "${cleaned.replace(/"/g, '\\"')}"`);
  }
  if (basedOn.length > 0) {
    lines.push("schema:isBasedOn:");
    for (const iri of basedOn) lines.push(`  - "${iri}"`);
  }
  return lines.length > 0 ? lines : ["none"];
}

function statementTextBlock(
  statement: FideIdStatement,
  options?: {
    subjectStatementSectionById?: Map<string, string>;
  },
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
  const predicateCurie = toPredicateCurie(statement.predicateRawIdentifier);
  const subjectValue = (() => {
    if (subject.entityType !== "Statement") return statement.subjectRawIdentifier;
    const section = options?.subjectStatementSectionById?.get(statement.subjectRawIdentifier)
      ?? options?.subjectStatementSectionById?.get(statement.subjectFideId);
    if (section) return `section: ${section}`;
    return statement.subjectFideId;
  })();

  return [
    `- subject (${subjectPhrase}): ${subjectValue}`,
    `- predicate: ${predicateCurie}`,
    `- object (${objectPhrase}): ${statement.objectRawIdentifier}`,
  ].join("\n");
}

function collectTermsForDefinitions(args: {
  target: FideIdStatement;
  anchorValidity: FideIdStatement | null;
  evidence: FideIdStatement;
  reportLines: string[];
}): string[] {
  const terms = new Set<string>();
  const addStatementTerms = (statement: FideIdStatement | null): void => {
    if (!statement) return;
    terms.add(toFideTypeCurie(parseFideId(statement.subjectFideId as `did:fide:0x${string}`).entityType));
    terms.add(toFideTypeCurie(parseFideId(statement.subjectFideId as `did:fide:0x${string}`).sourceType));
    terms.add(toFideTypeCurie(parseFideId(statement.objectFideId as `did:fide:0x${string}`).entityType));
    terms.add(toFideTypeCurie(parseFideId(statement.objectFideId as `did:fide:0x${string}`).sourceType));
    terms.add(toPredicateCurie(statement.predicateRawIdentifier));
  };
  addStatementTerms(args.target);
  addStatementTerms(args.anchorValidity);
  addStatementTerms(args.evidence);
  for (const line of args.reportLines) {
    const match = line.match(/^-?\s*([a-z]+:[A-Za-z0-9]+):/);
    if (match) terms.add(match[1]);
  }
  return [...terms].sort((a, b) => a.localeCompare(b));
}

function buildAtomicPrompt(
  args: {
    target: FideIdStatement;
    consideration: AtomicConsideration;
    evidence: FideIdStatement;
    supportingStatements: FideIdStatement[];
    contextStatements: FideIdStatement[];
    definitionsMarkdownLines: string[];
  },
): string {
  const anchorValidity = args.supportingStatements[0] ?? null;
  const targetSection = "Statement: Target owl:sameAs";
  const anchorSection = "Statement: Anchor schema:validFrom";
  const evidenceSection = "Statement: Evidence under review";
  const subjectStatementSectionById = new Map<string, string>();
  subjectStatementSectionById.set(args.target.statementFideId, targetSection);
  subjectStatementSectionById.set(
    buildRawId(args.target.subjectFideId, args.target.predicateFideId, args.target.objectFideId),
    targetSection,
  );
  if (anchorValidity) {
    subjectStatementSectionById.set(anchorValidity.statementFideId, anchorSection);
    subjectStatementSectionById.set(
      buildRawId(anchorValidity.subjectFideId, anchorValidity.predicateFideId, anchorValidity.objectFideId),
      anchorSection,
    );
  }
  const anchorValidityLine = anchorValidity
    ? statementTextBlock(anchorValidity, { subjectStatementSectionById })
    : "- none";
  const reportLines = buildPrimarySourceReportLines(args.evidence, args.contextStatements);

  return [
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
    statementTextBlock(args.target, { subjectStatementSectionById }),
    "",
    "## Consideration",
    `- ${args.consideration}`,
    "",
    `## ${anchorSection}`,
    anchorValidityLine,
    "",
    `## ${evidenceSection}`,
    statementTextBlock(args.evidence, { subjectStatementSectionById }),
    "",
    "## Primary Source Report",
    "```",
    ...reportLines,
    "```",
    "",
    "## Return JSON",
    "- decision (supports | contradicts | insufficient)",
    "- confidence (0.0 to 1.0)",
    "- reason",
    "",
    "## Rules",
    "- Use only the statements in this prompt.",
    "- Evaluate this one evidence statement only.",
    "- Do not make an overall identity decision here.",
    "- Do not invent facts beyond the provided statements.",
  ].join("\n");
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
  if (consideration === "citation_chain") {
    const directValidFrom = contextStatements.find(
      (statement) =>
        statement.statementFideId === evidence.subjectFideId
        && statement.predicateRawIdentifier === SCHEMA_VALID_FROM_IRI,
    );
    if (directValidFrom) return [directValidFrom];

    const relatedValidFrom = contextStatements
      .filter(
        (statement) =>
          statement.predicateRawIdentifier === SCHEMA_VALID_FROM_IRI
          && matchesStatementReference(statement, target),
      )
      .sort((a, b) => {
        const at = Date.parse(a.objectRawIdentifier);
        const bt = Date.parse(b.objectRawIdentifier);
        const av = Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER;
        const bv = Number.isFinite(bt) ? bt : Number.MAX_SAFE_INTEGER;
        return av - bv || a.statementFideId.localeCompare(b.statementFideId);
      });
    if (relatedValidFrom[0]) return [relatedValidFrom[0]];
  }

  const anchor = contextStatements.find((statement) => statement.statementFideId === evidence.subjectFideId);
  return anchor ? [anchor] : [];
}

function collectPrimarySourceLinksForStatement(
  target: FideIdStatement,
  contextStatements: FideIdStatement[],
): FideIdStatement[] {
  const raw = buildRawId(target.subjectFideId, target.predicateFideId, target.objectFideId);
  return contextStatements.filter(
    (statement) =>
      statement.predicateRawIdentifier === PROV_HAD_PRIMARY_SOURCE_IRI
      && (
        statement.subjectFideId === target.statementFideId
        || statement.subjectRawIdentifier === target.statementFideId
        || statement.subjectRawIdentifier === raw
      ),
  );
}

function isReportBackedPrimarySource(statement: FideIdStatement): boolean {
  if (statement.predicateRawIdentifier !== PROV_HAD_PRIMARY_SOURCE_IRI) return false;
  if (!(statement.objectRawIdentifier.startsWith("http://") || statement.objectRawIdentifier.startsWith("https://"))) {
    return false;
  }
  return statement.objectRawIdentifier.includes("/evidence/reports/");
}

export async function runPromptAtomic(flags: Map<string, string | boolean>): Promise<number> {
  try {
    const explicitStatementId = getStringFlag(flags, "statement");
    const rawConsideration = getStringFlag(flags, "consideration");
    const consideration = normalizeAtomicConsideration(rawConsideration);
    const explicitEvidenceStatementId = getStringFlag(flags, "evidence-statement");
    const explicitOutPath = getStringFlag(flags, "out");

    if (!explicitStatementId) {
      console.error("Missing required flag: --statement <owl-sameAs-statement-fide-id>");
      return 1;
    }
    if (rawConsideration && !consideration) {
      console.error(
        "Missing or invalid --consideration. Use one of: citation_chain, explicit_contradiction, name_alignment, affiliation_overlap, valid_from_timestamp.",
      );
      return 1;
    }
    if (explicitOutPath) {
      console.error("`eval prompt-atomic` no longer accepts --out. File path is auto-generated under _scratch/evals/prompts.");
      return 1;
    }
    if (explicitEvidenceStatementId && !consideration) {
      console.error("`--evidence-statement` requires `--consideration`.");
      return 1;
    }

    const parsed = await buildSameAsEvaluationInputBatchFromDb();
    const statements = await wiresToStatements(parsed.statementWires);
    const target = statements.find((statement) => statement.statementFideId === explicitStatementId);
    if (!target) {
      console.error(`owl:sameAs statement not found in evaluation input: ${explicitStatementId}`);
      return 1;
    }
    if (target.predicateRawIdentifier !== OWL_SAME_AS_IRI) {
      console.error(`Statement is not an owl:sameAs statement: ${explicitStatementId}`);
      return 1;
    }

    const criteria = passesPersonMethodCriteria(target);
    if (!criteria.ok) {
      console.error(`Statement does not meet Person@v1 method criteria: ${criteria.reason}`);
      return 1;
    }

    const contextStatements = buildPersonPromptContextStatements(target, statements);
    const considerations: AtomicConsideration[] = consideration ? [consideration] : [...ALL_ATOMIC_CONSIDERATIONS];
    const generated: Array<{
      consideration: AtomicConsideration;
      evidenceStatementFideId: string;
      outPath: string;
      promptChars: number;
      supportingStatementCount: number;
    }> = [];
    const considerationSummaries: Array<{
      consideration: AtomicConsideration;
      evidencePoolCount: number;
      generatedCount: number;
      skippedReason?: string;
    }> = [];

    for (const currentConsideration of considerations) {
      let evidencePool = pickAtomicEvidencePool(currentConsideration, target, contextStatements);
      let selectedEvidence: FideIdStatement[] = [];
      let baseSupportingStatements: FideIdStatement[] = [];

      if (currentConsideration === "citation_chain") {
        const anchorCandidates = contextStatements
          .filter(
            (statement) =>
              statement.predicateRawIdentifier === SCHEMA_VALID_FROM_IRI
              && matchesStatementReference(statement, target),
          )
          .sort((a, b) => a.statementFideId.localeCompare(b.statementFideId));
        const anchorValidity = anchorCandidates[0] ?? null;
        if (!anchorValidity) {
          if (consideration) {
            console.error("No anchor validFrom statement found for target owl:sameAs statement.");
            return 1;
          }
          considerationSummaries.push({
            consideration: currentConsideration,
            evidencePoolCount: 0,
            generatedCount: 0,
            skippedReason: "No anchor validFrom statement found.",
          });
          continue;
        }

        const primarySourceForAnchorValidity = collectPrimarySourceLinksForStatement(anchorValidity, contextStatements)
          .filter(isReportBackedPrimarySource);
        if (primarySourceForAnchorValidity.length === 0) {
          if (consideration) {
            console.error("No primary-source evidence statements found for the anchor validFrom statement.");
            return 1;
          }
          considerationSummaries.push({
            consideration: currentConsideration,
            evidencePoolCount: 0,
            generatedCount: 0,
            skippedReason: "No primary-source evidence statements found for anchor validFrom statement.",
          });
          continue;
        }

        baseSupportingStatements = [anchorValidity];
        evidencePool = primarySourceForAnchorValidity;
      } else if (evidencePool.length === 0) {
        if (consideration) {
          console.error(`No evidence statements available for consideration: ${currentConsideration}`);
          return 1;
        }
        considerationSummaries.push({
          consideration: currentConsideration,
          evidencePoolCount: 0,
          generatedCount: 0,
          skippedReason: "No evidence statements available.",
        });
        continue;
      }

      if (explicitEvidenceStatementId) {
        const matched = evidencePool.find((statement) => statement.statementFideId === explicitEvidenceStatementId) ?? null;
        if (!matched) {
          console.error(`Evidence statement not found in pool for consideration ${currentConsideration}: ${explicitEvidenceStatementId}`);
          return 1;
        }
        selectedEvidence = [matched];
      } else {
        selectedEvidence = [...evidencePool];
      }

      if (selectedEvidence.length === 0) {
        if (consideration) {
          console.error(`No evidence statements selected for consideration: ${currentConsideration}`);
          return 1;
        }
        considerationSummaries.push({
          consideration: currentConsideration,
          evidencePoolCount: evidencePool.length,
          generatedCount: 0,
          skippedReason: "No evidence statements selected.",
        });
        continue;
      }

      const generatedBefore = generated.length;
      for (const evidence of selectedEvidence) {
        const supportingStatements = currentConsideration === "citation_chain"
          ? baseSupportingStatements
          : pickAtomicRequiredAnchor(currentConsideration, target, evidence, contextStatements);
        const definitionTerms = collectTermsForDefinitions({
          target,
          anchorValidity: supportingStatements[0] ?? null,
          evidence,
          reportLines: buildPrimarySourceReportLines(evidence, contextStatements),
        });
        const definitionsMarkdownLines = await buildDefinitionsMarkdown(definitionTerms);
        const prompt = buildAtomicPrompt({
          target,
          consideration: currentConsideration,
          evidence,
          supportingStatements,
          contextStatements,
          definitionsMarkdownLines,
        });

        const outPath = defaultEvalPromptAtomicOutPath({
          consideration: currentConsideration,
          statementFideId: target.statementFideId,
          evidenceStatementFideId: evidence.statementFideId,
        });
        await writeUtf8(outPath, prompt.endsWith("\n") ? prompt : `${prompt}\n`);
        generated.push({
          consideration: currentConsideration,
          evidenceStatementFideId: evidence.statementFideId,
          outPath,
          promptChars: prompt.length,
          supportingStatementCount: supportingStatements.length,
        });
      }
      considerationSummaries.push({
        consideration: currentConsideration,
        evidencePoolCount: evidencePool.length,
        generatedCount: generated.length - generatedBefore,
      });
    }

    if (generated.length === 0) {
      console.error("No prompts generated.");
      return 1;
    }

    const summary = {
      mode: "prompt-atomic",
      method: "temporal-validity/owl-sameAs/Person@v1",
      inputMode: "db",
      targetSameAsStatementFideId: target.statementFideId,
      selectedConsiderations: considerations,
      generatedCount: generated.length,
      considerations: considerationSummaries,
      generated,
    };

    if (hasFlag(flags, "json")) {
      printJson(summary);
      return 0;
    }

    for (const item of generated) {
      console.log(item.outPath);
    }
    return 0;
  } finally {
    await closeRuntimeDbClient();
  }
}
