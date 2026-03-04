export function evalHelp(): string {
  return [
    "Usage:",
    "  fide eval add [--method <id@v>] [--target <statementFideId>] [--from <batch.jsonl>] [--consideration <id>] [--consideration-ref <https-url>] [--evidence-statement <statementFideId>] [--prompt-file <path-or-url>] --decision <supports|contradicts|insufficient> --confidence <0..1> --reason <text> [--json]",
    "  fide eval prompt --target <statementFideId> [--method <id@v>] [--from <batch.jsonl>] [--consideration <citation_chain|explicit_contradiction|name_alignment|affiliation_overlap|valid_from_timestamp>] [--evidence-statement <statementFideId>] [--agent codex --draft] [--stream] [--json]",
    "",
    "Notes:",
    "  - `eval add` writes a statement-doc draft under .fide/evals/drafts/YYYY/MM/DD/.",
    "  - If method/target/from are omitted, `eval add` can read env vars: FIDE_EVAL_METHOD, FIDE_EVAL_TARGET, FIDE_EVAL_FROM.",
    "  - Atomic context can also be provided via flags/env: consideration, evidence statement id, and prompt file.",
    "  - If --from is omitted, the latest .fide/statements/**/*.jsonl batch is used.",
    "  - `eval prompt` supports methods: temporal-validity/owl-sameAs/Person@v1, temporal-validity/owl-sameAs/Concept@v1",
    "  - `prompt` writes sectioned prompt preview files under .fide/evals/prompts/YYYY/MM/DD/.",
    "  - `--agent codex --draft` runs Codex for each prompt and writes statement-doc drafts under .fide/evals/drafts/YYYY/MM/DD/.",
    "  - `--stream` shows live Codex output while agent mode is running.",
  ].join("\n");
}
