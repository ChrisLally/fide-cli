import type { StatementInput } from "@chris-test/fcp";

type AddStatementInput = {
  subject: string;
  subjectType: string;
  subjectSource: string;
  predicate: string;
  object: string;
  objectType: string;
  objectSource: string;
};

/**
 * Validate raw JSON payload shape for statements add input.
 */
function normalizeAddInputs(parsed: unknown): AddStatementInput[] {
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Invalid input payload. Expected non-empty array of statement inputs.");
  }

  return parsed.map((item) => {
    const candidate = item as Partial<AddStatementInput>;
    if (
      !candidate.subject || !candidate.subjectType || !candidate.subjectSource ||
      !candidate.predicate || !candidate.object || !candidate.objectType || !candidate.objectSource
    ) {
      throw new Error("Invalid input item. Each item must include subject/subjectType/subjectSource/predicate/object/objectType/objectSource.");
    }
    return {
      subject: candidate.subject,
      subjectType: candidate.subjectType,
      subjectSource: candidate.subjectSource,
      predicate: candidate.predicate,
      object: candidate.object,
      objectType: candidate.objectType,
      objectSource: candidate.objectSource,
    };
  });
}

/**
 * Convert CLI add-input rows into canonical `StatementInput` values.
 */
function mapAddInputsToStatementInputs(inputs: AddStatementInput[]): StatementInput[] {
  return inputs.map((input) => ({
    subject: {
      rawIdentifier: input.subject,
      entityType: input.subjectType as StatementInput["subject"]["entityType"],
      sourceType: input.subjectSource as StatementInput["subject"]["sourceType"],
    },
    predicate: {
      rawIdentifier: input.predicate,
      entityType: "Concept",
      sourceType: "NetworkResource",
    },
    object: {
      rawIdentifier: input.object,
      entityType: input.objectType as StatementInput["object"]["entityType"],
      sourceType: input.objectSource as StatementInput["object"]["sourceType"],
    },
  }));
}

/**
 * Parse statement inputs from JSON array payload.
 */
export function parseJsonInputs(raw: string): StatementInput[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Input payload is empty.");
  }

  const parsed = JSON.parse(trimmed) as unknown;
  return mapAddInputsToStatementInputs(normalizeAddInputs(parsed));
}

/**
 * Map one ad-hoc statement row into a canonical `StatementInput`.
 */
export function mapSingleStatementInput(input: AddStatementInput): StatementInput {
  return mapAddInputsToStatementInputs([input])[0];
}
