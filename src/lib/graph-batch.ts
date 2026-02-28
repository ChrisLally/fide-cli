import { assertFideId, calculateStatementFideId, type FideId, type Statement } from "@chris-test/fcp";

export type GraphStatementWire = {
  s: string;
  sr: string;
  p: string;
  pr: string;
  o: string;
  or: string;
};

export type ParsedGraphStatementBatch = {
  statements: Statement[];
  statementWires: GraphStatementWire[];
  statementFideIds: string[];
  root: string;
};

function assertString(value: unknown, field: string, lineNumber: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid statement line ${lineNumber}: expected non-empty string at ${field}`);
  }
  return value;
}

function parseLineToGraphWire(line: string, lineNumber: number): GraphStatementWire {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`Invalid statement line ${lineNumber}: invalid JSON`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid statement line ${lineNumber}: expected object`);
  }

  const obj = parsed as Record<string, unknown>;
  return {
    s: assertString(obj.s, "s", lineNumber),
    sr: assertString(obj.sr, "sr", lineNumber),
    p: assertString(obj.p, "p", lineNumber),
    pr: assertString(obj.pr, "pr", lineNumber),
    o: assertString(obj.o, "o", lineNumber),
    or: assertString(obj.or, "or", lineNumber),
  };
}

async function graphWireToStatement(wire: GraphStatementWire): Promise<Statement> {
  assertFideId(wire.s);
  assertFideId(wire.p);
  assertFideId(wire.o);

  const subjectFideId = wire.s as FideId;
  const predicateFideId = wire.p as FideId;
  const objectFideId = wire.o as FideId;
  const statementFideId = await calculateStatementFideId(subjectFideId, predicateFideId, objectFideId);

  return {
    subjectFideId,
    subjectRawIdentifier: wire.sr,
    predicateFideId,
    predicateRawIdentifier: wire.pr,
    objectFideId,
    objectRawIdentifier: wire.or,
    statementFideId,
  };
}

async function calculateGraphStatementBatchRoot(statementFideIds: string[]): Promise<string> {
  if (!Array.isArray(statementFideIds) || statementFideIds.length === 0) {
    throw new Error("Invalid graph statement batch: expected one or more statement Fide IDs.");
  }

  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Web Crypto API unavailable: crypto.subtle is required.");
  }

  const canonicalIds = [...statementFideIds].sort();
  const input = new TextEncoder().encode(canonicalIds.join("\n"));
  const hashBuffer = await subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function parseGraphStatementBatchJsonl(input: string): Promise<ParsedGraphStatementBatch> {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error("Invalid graph statement batch: expected non-empty JSONL string");
  }

  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    throw new Error("Invalid graph statement batch: no statement lines found");
  }

  const statementWires = lines.map((line, index) => parseLineToGraphWire(line, index + 1));
  const statements = await Promise.all(statementWires.map((wire) => graphWireToStatement(wire)));
  const statementFideIds = statements.map((statement, index) => {
    if (!statement.statementFideId) {
      throw new Error(`Invalid statement line ${index + 1}: missing computed statementFideId`);
    }
    return statement.statementFideId;
  });
  const root = await calculateGraphStatementBatchRoot(statementFideIds);

  return { statements, statementWires, statementFideIds, root };
}
