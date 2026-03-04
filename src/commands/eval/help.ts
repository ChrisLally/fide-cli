export function evalHelp(): string {
  return [
    "Usage:",
    "  fide eval draft --method <id@v> --target <statementFideId> [--from <batch.jsonl>] [--agent codex] [--out <file>] [--json]",
    "",
    "Notes:",
    "  - If --from is omitted, the latest .fide/statements/**/*.jsonl batch is used.",
    "  - If --out is omitted, output is written under .fide/statement-drafts/YYYY/MM/DD/.",
    "  - Current draft implementation supports method: temporal-validity/owl-sameAs/Person@v1",
    "  - When --agent codex is provided, Codex is invoked to draft statement-doc output.",
  ].join("\n");
}
