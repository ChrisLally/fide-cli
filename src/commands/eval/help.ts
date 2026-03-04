export function evalHelp(): string {
  return [
    "Usage:",
    "  fide eval draft --method <id@v> --target <statementFideId> [--from <batch.jsonl>] [--agent codex] [--json]",
    "  fide eval prompt --target <statementFideId> [--method <id@v>] [--from <batch.jsonl>] [--consideration <citation_chain|explicit_contradiction|name_alignment|affiliation_overlap|valid_from_timestamp>] [--evidence-statement <statementFideId>] [--json]",
    "",
    "Notes:",
    "  - If --from is omitted, the latest .fide/statements/**/*.jsonl batch is used.",
    "  - Output is written under .fide/evals/drafts/YYYY/MM/DD/.",
    "  - `eval draft` currently supports method: temporal-validity/owl-sameAs/Person@v1",
    "  - `eval prompt` supports methods: temporal-validity/owl-sameAs/Person@v1, temporal-validity/owl-sameAs/Concept@v1",
    "  - When --agent codex is provided, Codex is invoked to draft statement-doc output.",
    "  - `prompt` writes sectioned prompt preview files under .fide/evals/prompts/YYYY/MM/DD/.",
  ].join("\n");
}
