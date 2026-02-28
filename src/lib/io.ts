import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export async function readUtf8(path: string): Promise<string> {
  return readFile(resolve(process.cwd(), path), "utf8");
}

export async function writeUtf8(path: string, content: string): Promise<void> {
  const absPath = resolve(process.cwd(), path);
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, content, "utf8");
}

export async function appendUtf8(path: string, content: string): Promise<void> {
  const absPath = resolve(process.cwd(), path);
  await mkdir(dirname(absPath), { recursive: true });
  await appendFile(absPath, content, "utf8");
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
