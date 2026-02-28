export type ParsedArgs = {
  positionals: string[];
  flags: Map<string, string | boolean>;
};

export function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const keyValue = token.slice(2);
    const eqIndex = keyValue.indexOf("=");
    if (eqIndex >= 0) {
      const key = keyValue.slice(0, eqIndex);
      const value = keyValue.slice(eqIndex + 1);
      flags.set(key, value);
      continue;
    }

    const key = keyValue;
    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      flags.set(key, true);
      continue;
    }

    flags.set(key, next);
    i += 1;
  }

  return { positionals, flags };
}

export function getStringFlag(
  flags: Map<string, string | boolean>,
  key: string,
): string | null {
  const value = flags.get(key);
  if (typeof value === "string") return value;
  return null;
}

export function hasFlag(flags: Map<string, string | boolean>, key: string): boolean {
  return flags.has(key);
}
