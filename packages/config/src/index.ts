import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  API_ORIGIN: z.string().url().default("http://localhost:4000"),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  DATABASE_DIRECT_URL: z.string().min(1).optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(20).default(5),
  GITHUB_APP_ID: z.coerce.number().int().positive(),
  GITHUB_APP_CLIENT_ID: z.string().min(1),
  GITHUB_APP_CLIENT_SECRET: z.string().min(1).optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(16),
  GITHUB_WEBHOOK_SECRET_PREVIOUS: z.string().min(16).optional(),
  GITHUB_API_VERSION: z.string().min(1).default("2022-11-28"),
  OWNER_GITHUB_USER_ID: z.coerce.number().int().positive(),
  ENCRYPTION_KEY_BASE64: z.string().min(16),
  SESSION_SECRET: z.string().min(32),
  AUTH_TRANSACTION_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  HANDOFF_TTL_SECONDS: z.coerce.number().int().positive().default(120),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(604800),
  CSRF_HEADER: z.string().min(1).default("x-devmemoir-csrf"),
  PORT: z.coerce.number().int().positive().max(65535).default(4000),
  HOST: z.string().min(1).default("127.0.0.1"),
});

export type AppConfig = z.infer<typeof configSchema> & {
  DATABASE_DIRECT_URL: string;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(input: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): AppConfig {
  const result = configSchema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new ConfigError(`Invalid configuration: ${details}`);
  }
  return {
    ...result.data,
    DATABASE_DIRECT_URL: result.data.DATABASE_DIRECT_URL ?? result.data.DATABASE_URL,
  };
}

export function requireConfig(input?: NodeJS.ProcessEnv | Record<string, string | undefined>): AppConfig {
  return loadConfig(input);
}
