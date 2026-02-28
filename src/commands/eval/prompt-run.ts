import { calculateFideId } from "@chris-test/fcp";
import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import { hasFlag, getStringFlag } from "../../lib/args.js";
import { printJson, readUtf8, writeUtf8 } from "../../lib/io.js";

const RDF_TYPE_IRI = "https://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const SCHEMA_ACTION_IRI = "https://schema.org/Action";
const SCHEMA_START_DATE_IRI = "https://schema.org/startDate";
const SCHEMA_END_DATE_IRI = "https://schema.org/endDate";
const SCHEMA_URL_IRI = "https://schema.org/url";
const SCHEMA_NAME_IRI = "https://schema.org/name";
const SCHEMA_DESCRIPTION_IRI = "https://schema.org/description";
const SCHEMA_ADDITIONAL_PROPERTY_IRI = "https://schema.org/additionalProperty";

function toWireJsonl(wires: Array<{ s: string; sr: string; p: string; pr: string; o: string; or: string }>): string {
  return `${wires.map((wire) => JSON.stringify(wire)).join("\n")}\n`;
}

function nowStamp(): string {
  return new Date().toISOString().replace(/[:]/g, "-").replace(/\.\d{3}Z$/, "Z");
}

function parseCsv(value: string | null): string[] {
  if (!value) return [];
  return value.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
}

function parseFloatCsv(value: string | null): number[] {
  return parseCsv(value).map((v) => Number(v)).filter((v) => Number.isFinite(v));
}

function parseIntFlag(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseJsonObjectFromText(input: string): Record<string, unknown> | null {
  const tryParse = (raw: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  };

  const direct = tryParse(input);
  if (direct) return direct;

  const fenced = input.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed) return parsed;
  }
  return null;
}

function promptRunSlug(promptPath: string): string {
  const base = basename(promptPath, extname(promptPath));
  const compactBase = slugifyIdentifier(base).slice(0, 72);
  const hash = createHash("sha1").update(promptPath).digest("hex").slice(0, 8);
  return `${compactBase || "prompt"}--${hash}`;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function parseRetryDelayMs(headers: Headers): number | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const asNumber = Number(retryAfter);
    if (Number.isFinite(asNumber) && asNumber >= 0) return Math.round(asNumber * 1000);
  }
  const resetRaw = headers.get("x-ratelimit-reset-tokens")
    ?? headers.get("x-ratelimit-reset-requests")
    ?? headers.get("x-ratelimit-reset");
  if (!resetRaw) return null;
  const text = resetRaw.trim().toLowerCase();
  const secMatch = text.match(/^([0-9]*\.?[0-9]+)s$/);
  if (secMatch) {
    const sec = Number(secMatch[1]);
    if (Number.isFinite(sec) && sec >= 0) return Math.round(sec * 1000);
  }
  const msMatch = text.match(/^([0-9]*\.?[0-9]+)ms$/);
  if (msMatch) {
    const ms = Number(msMatch[1]);
    if (Number.isFinite(ms) && ms >= 0) return Math.round(ms);
  }
  const rawNum = Number(text);
  if (Number.isFinite(rawNum) && rawNum >= 0) {
    return rawNum < 1000 ? Math.round(rawNum * 1000) : Math.round(rawNum);
  }
  return null;
}

function slugifyIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

export async function runPromptCommand(flags: Map<string, string | boolean>): Promise<number> {
  const invocationStartedAt = new Date().toISOString();
  const promptPath = getStringFlag(flags, "prompt");
  if (!promptPath) {
    console.error("Missing required flag: --prompt <file.md>");
    return 1;
  }

  const provider = (getStringFlag(flags, "provider") ?? "groq").toLowerCase();
  if (provider !== "groq" && provider !== "gemini") {
    console.error("Supported providers: groq, gemini.");
    return 1;
  }

  const apiKey = provider === "gemini"
    ? process.env.GEMINI_API_KEY
    : process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error(provider === "gemini"
      ? "Missing GEMINI_API_KEY environment variable."
      : "Missing GROQ_API_KEY environment variable.");
    return 1;
  }
  if (getStringFlag(flags, "out-dir")) {
    console.error("`prompt-run` does not accept --out-dir. Output path is auto-generated.");
    return 1;
  }

  const prompt = await readUtf8(promptPath);
  const models = (() => {
    const fromModels = parseCsv(getStringFlag(flags, "models"));
    if (fromModels.length > 0) return fromModels;
    const single = getStringFlag(flags, "model");
    if (single) return [single];
    return provider === "gemini"
      ? ["gemini-2.5-flash"]
      : ["llama-3.1-8b-instant"];
  })();
  const temperatures = (() => {
    const parsed = parseFloatCsv(getStringFlag(flags, "temps"));
    if (parsed.length > 0) return parsed;
    return [0];
  })();
  const repeats = Math.max(1, parseIntFlag(getStringFlag(flags, "repeats"), 1));
  const topP = (() => {
    const raw = getStringFlag(flags, "top-p");
    if (!raw) return 1;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 1;
  })();
  const maxOutputTokens = (() => {
    const raw = getStringFlag(flags, "max-output-tokens");
    if (!raw) return 512;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : 512;
  })();
  const maxAttempts = Math.max(1, parseIntFlag(getStringFlag(flags, "max-attempts"), 5));
  const baseBackoffMs = Math.max(100, parseIntFlag(getStringFlag(flags, "backoff-ms"), 1000));
  const paceMs = Math.max(0, parseIntFlag(getStringFlag(flags, "pace-ms"), 0));

  const outDir = `_scratch/evals/runs/${nowStamp().slice(0, 10)}/${promptRunSlug(promptPath)}`;
  const endpoint = provider === "gemini"
    ? "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    : "https://api.groq.com/openai/v1/chat/completions";

  type RunResult = {
    model: string;
    temperature: number;
    decision: "supports" | "contradicts" | "insufficient";
    confidence: number;
    reason: string;
    attempts: number;
    responseTimestamp: string;
  };

  type RunError = {
    model: string;
    temperature: number;
    repeat: number;
    attempts: number;
    error: string;
    responseTimestamp: string;
    rawContent?: string;
  };

  const runs: RunResult[] = [];
  const errors: RunError[] = [];
  for (const model of models) {
    for (const temperature of temperatures) {
      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        const body = {
          model,
          temperature,
          top_p: topP,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: prompt }],
          ...(provider === "groq" ? { max_completion_tokens: maxOutputTokens } : {}),
        };
        let attempts = 0;
        let response: Response | null = null;
        let responseText = "";
        let transportError: string | null = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          attempts = attempt;
          try {
            if (paceMs > 0) await sleepMs(paceMs);
            response = await fetch(endpoint, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(body),
            });
            responseText = await response.text();

            const retryableStatus = response.status === 429 || (response.status >= 500 && response.status < 600);
            if (retryableStatus && attempt < maxAttempts) {
              const headerDelay = parseRetryDelayMs(response.headers);
              const exponential = baseBackoffMs * (2 ** (attempt - 1));
              const wait = Math.max(baseBackoffMs, headerDelay ?? exponential);
              await sleepMs(wait);
              continue;
            }
            break;
          } catch (error) {
            transportError = error instanceof Error ? error.message : "Unknown network error.";
            if (attempt < maxAttempts) {
              const wait = baseBackoffMs * (2 ** (attempt - 1));
              await sleepMs(wait);
              continue;
            }
          }
        }

        let rawContent = "";
        let decision: "supports" | "contradicts" | "insufficient" | null = null;
        let confidence: number | null = null;
        let reason: string | null = null;
        let parseError: string | null = null;
        let ok = false;

        if (!response) {
          parseError = `Transport error after ${attempts} attempt(s): ${transportError ?? "unknown error"}`;
        } else if (!response.ok) {
          parseError = `HTTP ${response.status} after ${attempts} attempt(s): ${responseText}`;
        } else {
          try {
            const parsed = JSON.parse(responseText) as {
              choices?: Array<{ message?: { content?: string } }>;
            };
            rawContent = parsed.choices?.[0]?.message?.content ?? "";
            const extracted = parseJsonObjectFromText(rawContent);
            if (!extracted) {
              parseError = "Model output was not parseable JSON object.";
            } else {
              const rawDecision = extracted.decision;
              const rawConfidence = extracted.confidence;
              const rawReason = extracted.reason;
              if (
                (rawDecision === "supports" || rawDecision === "contradicts" || rawDecision === "insufficient")
                && typeof rawConfidence === "number"
                && Number.isFinite(rawConfidence)
                && rawConfidence >= 0
                && rawConfidence <= 1
                && typeof rawReason === "string"
              ) {
                decision = rawDecision;
                confidence = rawConfidence;
                reason = rawReason;
                ok = true;
              } else {
                parseError = "JSON parsed but did not match required schema (decision/confidence/reason).";
              }
            }
          } catch (error) {
            parseError = error instanceof Error ? error.message : "Failed to parse provider response JSON.";
          }
        }

        if (ok && decision && typeof confidence === "number" && typeof reason === "string") {
          runs.push({
            model,
            temperature,
            decision,
            confidence,
            reason,
            attempts,
            responseTimestamp: new Date().toISOString(),
          });
        } else {
          errors.push({
            model,
            temperature,
            repeat,
            attempts,
            error: parseError ?? "Unknown run error.",
            responseTimestamp: new Date().toISOString(),
            ...(rawContent ? { rawContent } : {}),
          });
        }
      }
    }
  }

  type AggregatedSuccessRecord = {
    provider: string;
    model: string;
    temperature: number;
    topP: number;
    decision: "supports" | "contradicts" | "insufficient";
    confidence: number;
    reason: string;
    responseTimestamps: string[];
  };
  const groupedSuccesses = new Map<string, RunResult[]>();
  for (const run of runs) {
    const key = `${run.model}::${run.temperature}`;
    const bucket = groupedSuccesses.get(key) ?? [];
    bucket.push(run);
    groupedSuccesses.set(key, bucket);
  }
  for (const [key, bucket] of groupedSuccesses.entries()) {
    const [model, temperatureRaw] = key.split("::");
    const temperature = Number(temperatureRaw);
    const runsJsonlPath = `${outDir}/${slugifyIdentifier(model)}/t-${String(temperature).replace(/\./g, "_")}/runs.jsonl`;
    const byVariant = new Map<string, AggregatedSuccessRecord>();

    try {
      const existing = await readUtf8(runsJsonlPath);
      for (const line of existing.split("\n").map((v) => v.trim()).filter((v) => v.length > 0)) {
        try {
          const parsed = JSON.parse(line) as Partial<AggregatedSuccessRecord>;
          if (
            typeof parsed.model !== "string"
            || typeof parsed.temperature !== "number"
            || typeof parsed.topP !== "number"
            || (parsed.decision !== "supports" && parsed.decision !== "contradicts" && parsed.decision !== "insufficient")
            || typeof parsed.confidence !== "number"
            || typeof parsed.reason !== "string"
          ) {
            continue;
          }
          const timestamps = Array.isArray(parsed.responseTimestamps)
            ? parsed.responseTimestamps.filter((v): v is string => typeof v === "string")
            : [];
          const variantKey = JSON.stringify({
            topP: parsed.topP,
            decision: parsed.decision,
            confidence: parsed.confidence,
            reason: parsed.reason,
          });
          byVariant.set(variantKey, {
            provider: provider,
            model: parsed.model,
            temperature: parsed.temperature,
            topP: parsed.topP,
            decision: parsed.decision,
            confidence: parsed.confidence,
            reason: parsed.reason,
            responseTimestamps: timestamps,
          });
        } catch {
          // Ignore malformed legacy line.
        }
      }
    } catch {
      // No previous file.
    }

    for (const run of bucket) {
      const variantKey = JSON.stringify({
        topP,
        decision: run.decision,
        confidence: run.confidence,
        reason: run.reason,
      });
      const current = byVariant.get(variantKey);
      if (current) {
        current.responseTimestamps.push(run.responseTimestamp);
      } else {
        byVariant.set(variantKey, {
          provider,
          model,
          temperature,
          topP,
          decision: run.decision,
          confidence: run.confidence,
          reason: run.reason,
          responseTimestamps: [run.responseTimestamp],
        });
      }
    }

    const content = [...byVariant.values()]
      .map((record) => {
        const dedupedTimestamps = [...new Set(record.responseTimestamps)].sort((a, b) => a.localeCompare(b));
        return JSON.stringify({
          ...record,
          responseTimestamps: dedupedTimestamps,
        });
      })
      .join("\n");
    await writeUtf8(runsJsonlPath, content.length > 0 ? `${content}\n` : "");
  }

  const summaryRows = models.flatMap((model) => temperatures.map((temperature) => {
    const successRuns = runs.filter((run) => run.model === model && run.temperature === temperature);
    const errorRuns = errors.filter((run) => run.model === model && run.temperature === temperature);
    const parseSuccess = successRuns.length;
    const parseFailure = errorRuns.length;
    const decisionCounts = {
      supports: successRuns.filter((r) => r.decision === "supports").length,
      contradicts: successRuns.filter((r) => r.decision === "contradicts").length,
      insufficient: successRuns.filter((r) => r.decision === "insufficient").length,
    };
    const confidenceValues = successRuns.map((r) => r.confidence);
    const avgConfidence = confidenceValues.length > 0
      ? Number((confidenceValues.reduce((a, b) => a + b, 0) / confidenceValues.length).toFixed(6))
      : null;
    return {
      model,
      temperature,
      repeats,
      parseSuccess,
      parseFailure,
      decisionCounts,
      avgConfidence,
    };
  }));

  const totalRequestedRuns = models.length * temperatures.length * repeats;
  const errorsPath = `${outDir}/errors.json`;
  let cumulativeErrors: RunError[] = [];
  try {
    const existingErrors = JSON.parse(await readUtf8(errorsPath)) as { errors?: unknown };
    if (Array.isArray(existingErrors.errors)) {
      cumulativeErrors = existingErrors.errors.filter((entry): entry is RunError => {
        if (!entry || typeof entry !== "object") return false;
        const record = entry as Record<string, unknown>;
        return (
          typeof record.model === "string"
          && typeof record.temperature === "number"
          && typeof record.repeat === "number"
          && typeof record.attempts === "number"
          && typeof record.error === "string"
          && typeof record.responseTimestamp === "string"
        );
      });
    }
  } catch {
    // No existing error log.
  }
  if (errors.length > 0) {
    cumulativeErrors = [...cumulativeErrors, ...errors];
    await writeUtf8(errorsPath, `${JSON.stringify({ errors: cumulativeErrors }, null, 2)}\n`);
  }

  const cumulativeSummaryRows: Array<{
    model: string;
    temperature: number;
    parseSuccess: number;
    parseFailure: number;
    decisionCounts: { supports: number; contradicts: number; insufficient: number };
    avgConfidence: number | null;
    distinctVariants: number;
  }> = [];

  for (const model of models) {
    for (const temperature of temperatures) {
      const runsJsonlPath = `${outDir}/${slugifyIdentifier(model)}/t-${String(temperature).replace(/\./g, "_")}/runs.jsonl`;
      let parseSuccess = 0;
      let distinctVariants = 0;
      let supports = 0;
      let contradicts = 0;
      let insufficient = 0;
      let confidenceSum = 0;

      try {
        const content = await readUtf8(runsJsonlPath);
        for (const line of content.split("\n").map((v) => v.trim()).filter((v) => v.length > 0)) {
          try {
            const parsed = JSON.parse(line) as {
              model?: string;
              temperature?: number;
              decision?: string;
              confidence?: number;
              responseTimestamps?: string[];
            };
            if (parsed.model !== model || parsed.temperature !== temperature) continue;
            const count = Array.isArray(parsed.responseTimestamps)
              ? parsed.responseTimestamps.filter((v): v is string => typeof v === "string").length
              : 0;
            if (count <= 0) continue;
            distinctVariants += 1;
            parseSuccess += count;
            if (parsed.decision === "supports") supports += count;
            if (parsed.decision === "contradicts") contradicts += count;
            if (parsed.decision === "insufficient") insufficient += count;
            if (typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)) {
              confidenceSum += parsed.confidence * count;
            }
          } catch {
            // Ignore malformed line.
          }
        }
      } catch {
        // No cumulative success file yet.
      }

      const parseFailure = cumulativeErrors.filter((entry) => entry.model === model && entry.temperature === temperature).length;
      const avgConfidence = parseSuccess > 0
        ? Number((confidenceSum / parseSuccess).toFixed(6))
        : null;

      cumulativeSummaryRows.push({
        model,
        temperature,
        parseSuccess,
        parseFailure,
        decisionCounts: {
          supports,
          contradicts,
          insufficient,
        },
        avgConfidence,
        distinctVariants,
      });
    }
  }

  const cumulativeSuccessRuns = cumulativeSummaryRows.reduce((sum, row) => sum + row.parseSuccess, 0);
  const cumulativeErrorRuns = cumulativeSummaryRows.reduce((sum, row) => sum + row.parseFailure, 0);

  const summary = {
    mode: "prompt-run",
    provider,
    promptPath,
    outDir,
    models,
    temperatures,
    repeats,
    topP,
    maxOutputTokens,
    maxAttempts,
    baseBackoffMs,
    paceMs,
    totalRequestedRuns,
    successRuns: runs.length,
    errorRuns: errors.length,
    errorsPath: cumulativeErrors.length > 0 ? errorsPath : null,
    summary: summaryRows,
    invocation: {
      totalRequestedRuns,
      successRuns: runs.length,
      errorRuns: errors.length,
      summary: summaryRows,
    },
    cumulative: {
      successRuns: cumulativeSuccessRuns,
      errorRuns: cumulativeErrorRuns,
      summary: cumulativeSummaryRows,
    },
    generatedDate: new Date().toISOString().slice(0, 10),
  };
  await writeUtf8(`${outDir}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);

  const invocationEndedAt = new Date().toISOString();
  const runSlug = promptRunSlug(promptPath);
  const runActionRawIdentifier = `https://fide.work/evaluations/runs/prompt-run/${summary.generatedDate}/${runSlug}/${nowStamp()}`;
  const statementsPath = `${outDir}/statements.jsonl`;

  const fideIdCache = new Map<string, string>();
  const fideIdFor = async (
    entityType: string,
    sourceType: string,
    rawIdentifier: string,
  ): Promise<string> => {
    const key = `${entityType}|${sourceType}|${rawIdentifier}`;
    const hit = fideIdCache.get(key);
    if (hit) return hit;
    const value = await calculateFideId(entityType as any, sourceType as any, rawIdentifier);
    fideIdCache.set(key, value);
    return value;
  };

  const statementWires: Array<{ s: string; sr: string; p: string; pr: string; o: string; or: string }> = [];
  const pushWire = async (
    subject: { rawIdentifier: string; entityType: string; sourceType: string },
    predicateRawIdentifier: string,
    object: { rawIdentifier: string; entityType: string; sourceType: string },
  ): Promise<void> => {
    statementWires.push({
      s: await fideIdFor(subject.entityType, subject.sourceType, subject.rawIdentifier),
      sr: subject.rawIdentifier,
      p: await fideIdFor("Concept", "NetworkResource", predicateRawIdentifier),
      pr: predicateRawIdentifier,
      o: await fideIdFor(object.entityType, object.sourceType, object.rawIdentifier),
      or: object.rawIdentifier,
    });
  };

  const runSubject = {
    rawIdentifier: runActionRawIdentifier,
    entityType: "Action",
    sourceType: "NetworkResource",
  };
  await pushWire(runSubject, RDF_TYPE_IRI, {
    rawIdentifier: SCHEMA_ACTION_IRI,
    entityType: "Concept",
    sourceType: "NetworkResource",
  });
  await pushWire(runSubject, SCHEMA_NAME_IRI, {
    rawIdentifier: "prompt-run evaluation action",
    entityType: "TextLiteral",
    sourceType: "TextLiteral",
  });
  await pushWire(runSubject, SCHEMA_START_DATE_IRI, {
    rawIdentifier: invocationStartedAt,
    entityType: "DateTimeLiteral",
    sourceType: "DateTimeLiteral",
  });
  await pushWire(runSubject, SCHEMA_END_DATE_IRI, {
    rawIdentifier: invocationEndedAt,
    entityType: "DateTimeLiteral",
    sourceType: "DateTimeLiteral",
  });
  await pushWire(runSubject, SCHEMA_URL_IRI, {
    rawIdentifier: `${outDir}/summary.json`,
    entityType: "TextLiteral",
    sourceType: "TextLiteral",
  });
  await pushWire(runSubject, SCHEMA_DESCRIPTION_IRI, {
    rawIdentifier: `provider=${provider}; promptPath=${promptPath}; models=${models.join(",")}; temperatures=${temperatures.join(",")}`,
    entityType: "TextLiteral",
    sourceType: "TextLiteral",
  });

  const addPropertyValue = async (
    propertyId: string,
    value: string,
    valueEntityType: "TextLiteral" | "IntegerLiteral" | "DecimalLiteral" | "JSONLiteral" | "BoolLiteral" = "TextLiteral",
    suffix?: string,
  ): Promise<void> => {
    const propertyNodeRaw = `${runActionRawIdentifier}/properties/${suffix ?? slugifyIdentifier(propertyId)}`;
    await pushWire(runSubject, SCHEMA_ADDITIONAL_PROPERTY_IRI, {
      rawIdentifier: propertyNodeRaw,
      entityType: "Concept",
      sourceType: "NetworkResource",
    });
    await pushWire(
      { rawIdentifier: propertyNodeRaw, entityType: "Concept", sourceType: "NetworkResource" },
      RDF_TYPE_IRI,
      { rawIdentifier: "https://schema.org/PropertyValue", entityType: "Concept", sourceType: "NetworkResource" },
    );
    await pushWire(
      { rawIdentifier: propertyNodeRaw, entityType: "Concept", sourceType: "NetworkResource" },
      "https://schema.org/propertyID",
      { rawIdentifier: propertyId, entityType: "TextLiteral", sourceType: "TextLiteral" },
    );
    await pushWire(
      { rawIdentifier: propertyNodeRaw, entityType: "Concept", sourceType: "NetworkResource" },
      "https://schema.org/value",
      { rawIdentifier: value, entityType: valueEntityType, sourceType: valueEntityType },
    );
  };

  await addPropertyValue("provider", provider, "TextLiteral");
  await addPropertyValue("models", JSON.stringify(models), "JSONLiteral");
  await addPropertyValue("temperatures", JSON.stringify(temperatures), "JSONLiteral");
  await addPropertyValue("repeats", String(repeats), "IntegerLiteral");
  await addPropertyValue("totalRequestedRuns", String(totalRequestedRuns), "IntegerLiteral");
  await addPropertyValue("successRuns", String(runs.length), "IntegerLiteral");
  await addPropertyValue("errorRuns", String(errors.length), "IntegerLiteral");
  await addPropertyValue("invocationSummary", JSON.stringify(summary.invocation), "JSONLiteral");
  await addPropertyValue("cumulativeSummary", JSON.stringify(summary.cumulative), "JSONLiteral");

  await writeUtf8(statementsPath, toWireJsonl(statementWires));

  if (hasFlag(flags, "json")) {
    printJson({
      ...summary,
      runActionRawIdentifier,
      statementsPath,
      statementCount: statementWires.length,
    });
    return 0;
  }
  console.log(`${outDir}/summary.json`);
  return 0;
}
