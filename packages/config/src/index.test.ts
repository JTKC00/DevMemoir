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
    expect(config.CSRF_HEADER).toBe("x-devmemoir-csrf");
  });

  it("rejects missing required secret material", () => {
    expect(() => loadConfig({ ...valid, SESSION_SECRET: "short" })).toThrow(ConfigError);
  });
});
