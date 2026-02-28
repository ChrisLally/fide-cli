import { writeUtf8 } from "./io.js";

export type ReportSection = {
  heading: string;
  lines: string[];
};

function stripMarkdown(input: string): string {
  return input
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function deriveDescription(sections: ReportSection[]): string {
  const preferred = sections.find((section) => section.heading.toLowerCase() === "executive summary");
  const firstLine = preferred?.lines.find((line) => line.trim().length > 0)
    ?? sections.flatMap((section) => section.lines).find((line) => line.trim().length > 0);

  if (!firstLine) return "Generated report.";
  const clean = stripMarkdown(firstLine);
  if (!clean) return "Generated report.";
  return clean.length > 180 ? `${clean.slice(0, 177)}...` : clean;
}

export async function writeMarkdownReport(params: {
  reportPath: string;
  title: string;
  description?: string;
  sections: ReportSection[];
}): Promise<void> {
  const safe = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const description = params.description ?? deriveDescription(params.sections);
  const generatedAt = new Date().toISOString().slice(0, 10);
  const body: string[] = [
    "---",
    `title: "${safe(params.title)}"`,
    `description: "${safe(description)}"`,
    "---",
    "",
    `Generated at: ${generatedAt}`,
    "",
  ];

  for (const section of params.sections) {
    body.push(`## ${section.heading}`);
    body.push(...section.lines);
    body.push("");
  }

  await writeUtf8(params.reportPath, `${body.join("\n").trimEnd()}\n`);
}

export function markdownTable(headers: string[], rows: string[][]): string[] {
  const safe = (value: string): string => value.replaceAll("|", "\\|").replaceAll("\n", " ");
  const head = `| ${headers.map(safe).join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map((value) => safe(value)).join(" | ")} |`);
  return [head, separator, ...body];
}
