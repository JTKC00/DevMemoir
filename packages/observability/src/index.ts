export const ALLOWED_LOG_KEYS = new Set([
  "request_id",
  "delivery_guid",
  "job_id",
  "tenant_id",
  "installation_id",
  "repository_id",
  "event_type",
  "state",
  "attempt",
  "duration_ms",
  "result",
  "changed_count",
  "projection_version",
  "rate_limit_bucket",
  "error_code",
  "error_name",
  "audit_run_id",
  "retry_at",
]);

export type SafeLogValue = string | number | boolean | null;
export type SafeLogFields = Record<string, SafeLogValue | undefined>;
export type LogSink = (line: string) => void;

export function scrubError(error: unknown): { error_name: string; error_code?: string } {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return {
      error_name: error.name || "Error",
      ...(typeof code === "string" ? { error_code: code.slice(0, 120) } : {}),
    };
  }
  return { error_name: "UnknownError" };
}

export function allowlistFields(fields: SafeLogFields): Record<string, SafeLogValue> {
  const safe: Record<string, SafeLogValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_LOG_KEYS.has(key) || value === undefined) continue;
    if (typeof value === "string" && value.length > 200) safe[key] = `${value.slice(0, 200)}…`;
    else safe[key] = value;
  }
  return safe;
}

export function createLogger(sink: LogSink = (line) => process.stdout.write(`${line}\n`)) {
  const write = (level: "debug" | "info" | "warn" | "error", fields: SafeLogFields, error?: unknown) => {
    const safe = allowlistFields(fields);
    if (error !== undefined) Object.assign(safe, scrubError(error));
    sink(JSON.stringify({ level, ...safe }));
  };
  return {
    debug: (fields: SafeLogFields) => write("debug", fields),
    info: (fields: SafeLogFields) => write("info", fields),
    warn: (fields: SafeLogFields, error?: unknown) => write("warn", fields, error),
    error: (fields: SafeLogFields, error?: unknown) => write("error", fields, error),
  };
}

export type Logger = ReturnType<typeof createLogger>;

export function createCanarySink() {
  const lines: string[] = [];
  return {
    sink: (line: string) => lines.push(line),
    lines,
    text: () => lines.join("\n"),
  };
}
