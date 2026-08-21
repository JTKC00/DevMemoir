import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./index.js";

const valid = {
  DATABASE_URL: "postgres://db",
  GITHUB_APP_ID: "1",
  GITHUB_APP_CLIENT_ID: "client",
  GITHUB_APP_PRIVATE_KEY: "private",
  GITHUB_WEBHOOK_SECRET: "current-secret-123456",
  OWNER_GITHUB_USER_ID: "7",
  ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 1).toString("base64"),
  SESSION_SECRET: "session-secret-that-is-at-least-32-bytes-long",
};

describe("typed configuration", () => {
  it("loads defaults and derives the direct URL", () => {
    const config = loadConfig(valid);
    expect(config.DATABASE_DIRECT_URL).toBe(config.DATABASE_URL);
    expect(config.DATABASE_API_URL).toBe(config.DATABASE_URL);
    expect(config.DATABASE_WORKER_URL).toBe(config.DATABASE_URL);
    expect(config.DATABASE_QUEUE_URL).toBe(config.DATABASE_URL);
    expect(config.DATABASE_MIGRATIONS_URL).toBe(config.DATABASE_URL);
    expect(config.CSRF_HEADER).toBe("x-devmemoir-csrf");
  });

  it("rejects missing required secret material", () => {
    expect(() => loadConfig({ ...valid, SESSION_SECRET: "short" })).toThrow(ConfigError);
  });

  it("requires explicit database role URLs in production", () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: "production" })).toThrow(ConfigError);
  });

  it("preserves distinct production role URLs without owner fallback", () => {
    const config = loadConfig({
      ...valid,
      NODE_ENV: "production",
      DATABASE_DIRECT_URL: "postgres://owner",
      DATABASE_API_URL: "postgres://api",
      DATABASE_WORKER_URL: "postgres://worker",
      DATABASE_QUEUE_URL: "postgres://queue",
      DATABASE_MIGRATIONS_URL: "postgres://migrations",
    });
    expect(config.DATABASE_API_URL).toBe("postgres://api");
    expect(config.DATABASE_WORKER_URL).toBe("postgres://worker");
    expect(config.DATABASE_QUEUE_URL).toBe("postgres://queue");
    expect(config.DATABASE_MIGRATIONS_URL).toBe("postgres://migrations");
    expect(config.DATABASE_DIRECT_URL).toBe("postgres://owner");
  });
});
