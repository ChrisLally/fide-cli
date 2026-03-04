export function statementsHelp(): string {
  return [
    "Usage:",
    "  fide graph statements add --subject <raw> --subject-type <type> --subject-source <type> --predicate <iri> --object <raw> --object-type <type> --object-source <type> [--no-normalize] [--json]",
    "  fide graph statements add --in <inputs> [--format <json|jsonl|fsd>] [--no-normalize] [--json] [--draft]",
    "  fide graph statements add --stdin [--format <json|jsonl|fsd>] [--no-normalize] [--json] [--draft]",
    "  fide graph statements validate --in <input> [--format <json|jsonl|fsd>] [--json]",
    "  fide graph statements root --in <input> [--format <json|jsonl|fsd>]",
    "",
    "Notes:",
    "  - Normalization is ON by default for `graph statements add`.",
    "  - Default mode writes to .fide/statements/YYYY/MM/DD/<root>.jsonl.",
    "  - `--draft` writes a statement-doc markdown file to .fide/statement-drafts/YYYY/MM/DD/<root>.md.",
    "  - `--stdin`/`--in` can auto-detect json/jsonl/fsd, or use --format to force.",
    "  - `validate`/`root` accept statement-doc inputs and json/jsonl batches.",
  ].join("\n");
}
