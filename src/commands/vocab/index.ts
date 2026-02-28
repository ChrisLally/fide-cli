import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import * as rdf from "rdflib";
import { getStringFlag, hasFlag, parseArgs } from "../../lib/args.js";
import { printJson } from "../../lib/io.js";

type VocabSource = "schemaorg" | "prov" | "owl" | "fide";

const VOCAB_SPECS: Record<VocabSource, { url: string; outFile: string; mediaType: string; convertToJsonLd: boolean }> = {
  schemaorg: {
    url: "https://schema.org/version/latest/schemaorg-current-https.jsonld",
    outFile: "schemaorg-current-https.jsonld",
    mediaType: "application/ld+json",
    convertToJsonLd: false,
  },
  prov: {
    url: "https://www.w3.org/ns/prov-o.ttl",
    outFile: "prov-o.jsonld",
    mediaType: "text/turtle",
    convertToJsonLd: true,
  },
  owl: {
    url: "https://www.w3.org/2002/07/owl.ttl",
    outFile: "owl.jsonld",
    mediaType: "text/turtle",
    convertToJsonLd: true,
  },
  fide: {
    url: "",
    outFile: "fide.jsonld",
    mediaType: "application/ld+json",
    convertToJsonLd: false,
  },
};

function vocabHelp(): string {
  return [
    "Usage:",
    "  fide vocab populate [--source <schemaorg|prov|owl|fide|all>] [--json]",
  ].join("\n");
}

function repoRootFromThisFile(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../../../");
}

function parseSource(raw: string | null): VocabSource[] | null {
  if (!raw || raw === "all") return ["schemaorg", "prov", "owl", "fide"];
  if (raw === "schemaorg" || raw === "prov" || raw === "owl" || raw === "fide") return [raw];
  return null;
}

type FideEntityDefinition = {
  name: string;
  hexCode: string;
  description: string;
  layer: string | null;
  standard: string | null;
  standardFit: string | null;
  litmus: string | null;
};

function cleanJsdocBlock(block: string): string[] {
  return block
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trim());
}

function pickTag(lines: string[], tagName: string): string | null {
  const line = lines.find((item) => item.startsWith(`@${tagName}`));
  if (!line) return null;
  return line.replace(`@${tagName}`, "").trim() || null;
}

function parseFideEntityDefinitions(constantsSource: string): FideEntityDefinition[] {
  const mapStart = constantsSource.indexOf("export const FIDE_ENTITY_TYPE_MAP = {");
  const mapEnd = constantsSource.indexOf("} as const;", mapStart);
  if (mapStart < 0 || mapEnd < 0) return [];
  const mapBody = constantsSource.slice(mapStart, mapEnd);

  const re = /\/\*\*([\s\S]*?)\*\/\s*([A-Za-z][A-Za-z0-9]*):\s*"([0-9a-f]{2})",/g;
  const out: FideEntityDefinition[] = [];

  for (const match of mapBody.matchAll(re)) {
    const jsdoc = match[1] ?? "";
    const name = match[2] ?? "";
    const hexCode = match[3] ?? "";
    const lines = cleanJsdocBlock(jsdoc);
    const description = lines
      .filter((line) => line.length > 0 && !line.startsWith("@"))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    out.push({
      name,
      hexCode,
      description,
      layer: pickTag(lines, "layer"),
      standard: pickTag(lines, "standard"),
      standardFit: pickTag(lines, "standardFit"),
      litmus: pickTag(lines, "litmus"),
    });
  }
  return out;
}

async function buildFideJsonLd(repoRoot: string): Promise<string> {
  const constantsPath = resolve(repoRoot, "packages/fcp/packages/fcp-js/src/fide-id/constants.ts");
  const source = await readFile(constantsPath, "utf8");
  const entities = parseFideEntityDefinitions(source);
  if (entities.length === 0) {
    throw new Error(`Failed to parse FIDE_ENTITY_TYPE_MAP from ${constantsPath}`);
  }

  const standardPrefixToBase: Record<string, string> = {
    schema: "https://schema.org/",
    rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    rdfs: "http://www.w3.org/2000/01/rdf-schema#",
    xsd: "http://www.w3.org/2001/XMLSchema#",
    org: "http://www.w3.org/ns/org#",
    prov: "http://www.w3.org/ns/prov#",
    sec: "https://w3id.org/security#",
    owl: "http://www.w3.org/2002/07/owl#",
    skos: "http://www.w3.org/2004/02/skos/core#",
  };

  const parseStandardUris = (raw: string | null): string[] => {
    if (!raw) return [];
    return raw
      .split("+")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => {
        const [prefix, local] = part.split(":");
        if (!prefix || !local) return null;
        const base = standardPrefixToBase[prefix];
        if (!base) return null;
        return `${base}${local}`;
      })
      .filter((uri): uri is string => Boolean(uri));
  };

  const graph = entities.map((entity) => {
    const node: Record<string, unknown> = {
      "@id": `fide:${entity.name}`,
      "@type": "schema:DefinedTerm",
      "rdfs:label": entity.name,
      "schema:name": entity.name,
      "schema:termCode": entity.hexCode,
    };
    if (entity.description) node["rdfs:comment"] = entity.description;
    if (entity.layer) node["schema:category"] = entity.layer;
    if (entity.litmus) node["schema:disambiguatingDescription"] = entity.litmus;

    const standardUris = parseStandardUris(entity.standard);
    if (standardUris.length > 0) {
      if (entity.standardFit === "Exact") {
        node["owl:equivalentClass"] = standardUris.map((uri) => ({ "@id": uri }));
      } else {
        node["rdfs:subClassOf"] = standardUris.map((uri) => ({ "@id": uri }));
      }
    }

    return node;
  });

  const doc = {
    "@context": {
      fide: "https://fide.work/vocab#",
      schema: "https://schema.org/",
      rdfs: "http://www.w3.org/2000/01/rdf-schema#",
      owl: "http://www.w3.org/2002/07/owl#",
    },
    "@id": "fide:EntityTypeSet",
    "@type": "schema:DefinedTermSet",
    "schema:name": "Fide Entity Types",
    "@graph": graph,
  };

  return `${JSON.stringify(doc, null, 2)}\n`;
}

function serializeStoreToJsonLd(store: rdf.Formula, baseIri: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    rdf.serialize(null, store, baseIri, "application/ld+json", (error, result) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise(String(result ?? ""));
    });
  });
}

async function convertToJsonLd(content: string, baseIri: string, mediaType: string): Promise<string> {
  const store = rdf.graph();
  rdf.parse(content, store, baseIri, mediaType);
  const jsonld = await serializeStoreToJsonLd(store, baseIri);
  const parsed = JSON.parse(jsonld) as unknown;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

async function downloadToFile(
  url: string,
  outPath: string,
  mediaType: string,
  convertToJsonLdOutput: boolean,
): Promise<{ bytes: number }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  const body = await response.text();
  const output = convertToJsonLdOutput
    ? await convertToJsonLd(body, url, mediaType)
    : `${JSON.stringify(JSON.parse(body), null, 2)}\n`;
  await writeFile(outPath, output, "utf8");
  return { bytes: Buffer.byteLength(output, "utf8") };
}

async function runPopulate(flags: Map<string, string | boolean>): Promise<number> {
  const sources = parseSource(getStringFlag(flags, "source"));
  if (!sources) {
    console.error("Invalid --source. Use one of: schemaorg, prov, owl, all.");
    return 1;
  }

  const repoRoot = repoRootFromThisFile();
  const outDir = resolve(repoRoot, "packages/evaluation-methods/vocab");
  await mkdir(outDir, { recursive: true });

  const written: Array<{ source: VocabSource; url: string; outPath: string; bytes: number }> = [];
  for (const source of sources) {
    const spec = VOCAB_SPECS[source];
    const outPath = resolve(outDir, spec.outFile);
    let result: { bytes: number };
    if (source === "fide") {
      const jsonld = await buildFideJsonLd(repoRoot);
      await writeFile(outPath, jsonld, "utf8");
      result = { bytes: Buffer.byteLength(jsonld, "utf8") };
    } else {
      result = await downloadToFile(spec.url, outPath, spec.mediaType, spec.convertToJsonLd);
    }
    written.push({
      source,
      url: spec.url,
      outPath,
      bytes: result.bytes,
    });
  }

  const summary = {
    mode: "vocab-populate",
    outDir,
    files: written,
  };

  if (hasFlag(flags, "json")) {
    printJson(summary);
  } else {
    for (const item of written) {
      console.log(`${item.source}: ${item.outPath}`);
    }
  }
  return 0;
}

export async function runVocabCommand(command: string | undefined, args: string[]): Promise<number> {
  if (!command || command === "--help") {
    console.log(vocabHelp());
    return 0;
  }
  const { flags } = parseArgs(args);
  if (command === "populate") {
    return runPopulate(flags);
  }
  console.error(`Unknown vocab command: ${command}`);
  console.error(vocabHelp());
  return 1;
}
