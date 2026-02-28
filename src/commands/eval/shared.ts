import { buildStatementRawIdentifier, calculateStatementFideId, parseFideId } from "@chris-test/fcp";

export type StatementWire = {
  s: string;
  sr: string;
  p: string;
  pr: string;
  o: string;
  or: string;
};

export type FideIdStatement = {
  statementFideId: string;
  subjectFideId: string;
  subjectRawIdentifier: string;
  predicateFideId: string;
  predicateRawIdentifier: string;
  objectFideId: string;
  objectRawIdentifier: string;
};

export type SameAsInputBatch = {
  statementCount: number;
  statementWires: StatementWire[];
  statementFideIds: string[];
  root: string | null;
};

export type EvalRunResult = {
  method: {
    input: string;
    key: string;
    methodId: string;
    methodIdentifier: string;
    methodVersion: string;
    methodName: string;
    evaluationBaseIdentifier: string;
    methodsUsed?: string[];
  };
  input: {
    root: string | null;
    statementCount: number;
    claimCount: number;
  };
  summary: {
    same: number;
    uncertain: number;
    different: number;
    reviewRequired: number;
    avgScore: number;
    avgConfidence: number;
  };
  results: Array<{
    targetSameAsStatementFideId: string;
    decision: "same" | "uncertain" | "different";
    score: number;
    confidence: number;
    reviewRequired: boolean;
    evidenceStatementFideIds: string[];
    method: {
      key: string;
      methodId: string;
      methodIdentifier: string;
      methodVersion: string;
      methodName: string;
      evaluationBaseIdentifier: string;
    };
  }>;
};

export const OWL_SAME_AS_IRI = "https://www.w3.org/2002/07/owl#sameAs";

export function toWireJsonl(wires: StatementWire[]): string {
  return `${wires.map((wire) => JSON.stringify(wire)).join("\n")}\n`;
}

export function shortFideSuffix(value: string): string {
  const hex = value.startsWith("did:fide:0x") ? value.slice("did:fide:0x".length) : value;
  return hex.slice(0, 12);
}

export function slugifyIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

export async function wiresToStatements(wires: StatementWire[]): Promise<FideIdStatement[]> {
  const statements = await Promise.all(wires.map(async (wire) => ({
    subjectFideId: wire.s,
    subjectRawIdentifier: wire.sr,
    predicateFideId: wire.p,
    predicateRawIdentifier: wire.pr,
    objectFideId: wire.o,
    objectRawIdentifier: wire.or,
    statementFideId: await calculateStatementFideId(wire.s, wire.p, wire.o),
  })));

  return statements;
}

export function parseClaimFilter(raw: string | null): Set<string> | null {
  if (!raw) return null;
  const claims = raw.split(",").map((value) => value.trim()).filter((value) => value.length > 0);
  return claims.length > 0 ? new Set(claims) : null;
}

export function toEvalRunSummary(run: EvalRunResult["results"]) {
  const same = run.filter((result) => result.decision === "same").length;
  const uncertain = run.filter((result) => result.decision === "uncertain").length;
  const different = run.filter((result) => result.decision === "different").length;
  const reviewRequired = run.filter((result) => result.reviewRequired).length;
  const avgScore = run.length > 0
    ? Number((run.reduce((sum, item) => sum + item.score, 0) / run.length).toFixed(6))
    : 0;
  const avgConfidence = run.length > 0
    ? Number((run.reduce((sum, item) => sum + item.confidence, 0) / run.length).toFixed(6))
    : 0;

  return { same, uncertain, different, reviewRequired, avgScore, avgConfidence };
}

export function toPercent(count: number, total: number): string {
  if (total <= 0) return "0.0%";
  return `${((count / total) * 100).toFixed(1)}%`;
}

export function matchesStatementReference(candidate: FideIdStatement, target: FideIdStatement): boolean {
  const raw = buildStatementRawIdentifier(target.subjectFideId, target.predicateFideId, target.objectFideId);
  return candidate.subjectFideId === target.statementFideId
    || candidate.subjectRawIdentifier === target.statementFideId
    || candidate.subjectRawIdentifier === raw;
}

export function normalizeDecisionFilter(value: string | null): "same" | "uncertain" | "different" | "all" {
  if (!value) return "all";
  if (value === "same" || value === "uncertain" || value === "different" || value === "all") {
    return value;
  }
  throw new Error(`Invalid --decision value: ${value}`);
}

export { buildStatementRawIdentifier, parseFideId };
