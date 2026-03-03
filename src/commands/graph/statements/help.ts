export function statementsHelp(): string {
  return [
    "Usage:",
    "  fide graph statements add --subject <raw> --subject-type <type> --subject-source <type> --predicate <iri> --object <raw> --object-type <type> --object-source <type> [--no-normalize] [--out <batch.jsonl>] [--json]",
    "  fide graph statements add --in <inputs> [--format <json|jsonl|fsd>] [--no-normalize] [--out <batch.jsonl>] [--json]",
    "  fide graph statements add --stdin [--format <json|jsonl|fsd>] [--no-normalize] [--out <batch.jsonl>] [--json]",
    "  fide graph statements validate --in <batch.jsonl> [--json]",
    "  fide graph statements root --in <batch.jsonl>",
    "  fide graph statements normalize --in <batch.jsonl> [--out <normalized.jsonl>]",
    "",
    "Notes:",
    "  - Normalization is ON by default for `graph statements add`.",
    "  - `--stdin`/`--in` can auto-detect json/jsonl/fsd, or use --format to force.",
  ].join("\n");
}
