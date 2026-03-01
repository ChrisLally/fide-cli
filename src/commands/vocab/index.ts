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
    url: "https://schema.org/docs/jsonldcontext.json",
    outFile: "schemaorg-context.jsonld",
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
  code: string;
  description: string;
  layer: string;
  standards: string[];
  standardFit: "Exact" | "Close" | "Broad";
  litmus: string;
};

function parseFideEntityDefinitions(specSource: string): FideEntityDefinition[] {
  const parsed = JSON.parse(specSource) as {
    entityTypes?: Record<string, {
      code: string;
      layer: string;
      standards: string[];
      standardFit: "Exact" | "Close" | "Broad";
      description: string;
      litmus: string;
    }>;
  };

  if (!parsed.entityTypes || typeof parsed.entityTypes !== "object") {
    return [];
  }

  return Object.entries(parsed.entityTypes)
    .map(([name, entity]) => ({
      name,
      code: entity.code,
      layer: entity.layer,
      standards: entity.standards,
      standardFit: entity.standardFit,
      description: entity.description,
      litmus: entity.litmus,
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

async function buildFideJsonLd(repoRoot: string): Promise<string> {
  const specPath = resolve(repoRoot, "packages/fide-context-protocol/spec/v1/entity-types.json");
  const source = await readFile(specPath, "utf8");
  const entities = parseFideEntityDefinitions(source);
  if (entities.length === 0) {
    throw new Error(`Failed to parse entity types from ${specPath}`);
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

  const parseStandardUris = (rawStandards: string[]): string[] => {
    return rawStandards
      .map((part) => part.trim())
      .map((part) => {
        if (part.startsWith("http://") || part.startsWith("https://")) {
          return part;
        }
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
      "schema:termCode": entity.code,
    };
    if (entity.description) node["rdfs:comment"] = entity.description;
    if (entity.layer) node["schema:category"] = entity.layer;
    if (entity.litmus) node["schema:disambiguatingDescription"] = entity.litmus;

    const standardUris = parseStandardUris(entity.standards);
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
    "@context": [
      "https://schema.org/docs/jsonldcontext.json",
      "https://www.w3.org/ns/prov.jsonld",
      {
        fide: "https://fide.work/spec/v1/",
        fcp: "https://fide.work/spec/v1/context.jsonld#",
        rdfs: "http://www.w3.org/2000/01/rdf-schema#",
        owl: "http://www.w3.org/2002/07/owl#",
      },
    ],
    "@id": "fide:entity-types",
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
  const specDir = resolve(repoRoot, "packages/fide-context-protocol/spec/v1");
  const vendorDir = resolve(specDir, "vendor");
  await mkdir(specDir, { recursive: true });
  const needsVendorDir = sources.some((source) => source !== "fide");
  if (needsVendorDir) {
    await mkdir(vendorDir, { recursive: true });
  }

  const written: Array<{ source: VocabSource; url: string; outPath: string; bytes: number }> = [];
  for (const source of sources) {
    const spec = VOCAB_SPECS[source];
    const outPath = source === "fide"
      ? resolve(specDir, "context.jsonld")
      : resolve(vendorDir, spec.outFile);
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
    outDir: specDir,
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
