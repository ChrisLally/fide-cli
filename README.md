# @chris-test/cli

Fide command-line interface.

## Commands

- `fide init`
- `fide graph statements <add|validate|root|normalize>`
- `fide graph ingest <apply|replay>`
- `fide graph query`
- `fide vocab ...`
- `fide project ...`

## Scope

- Protocol primitives come from `@chris-test/fcp`.
- CLI remains user-facing and avoids direct DB/runtime coupling.
- Runtime operations should flow through API contracts.

## Release

- Monorepo release tag: `fide-cli/v<version>`
- Standalone repo release tag: `fide-cli-v<version>`
- From repo root: `pnpm run release:cli`

## License

See `LICENSE`.
