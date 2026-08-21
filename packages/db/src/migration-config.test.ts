import { describe, expect, it } from "vitest";
import { resolveMigrationConnectionString } from "./migration-config.js";

describe("migration database URL", () => {
  it("fails closed in production when the migration URL is absent", () => {
    expect(() => resolveMigrationConnectionString({ NODE_ENV: "production", DATABASE_DIRECT_URL: "postgres://owner", DATABASE_URL: "postgres://owner" })).toThrow("DATABASE_MIGRATIONS_URL is required in production");
  });

  it("uses the explicit migration principal in production", () => {
    expect(resolveMigrationConnectionString({ NODE_ENV: "production", DATABASE_MIGRATIONS_URL: "postgres://migration", DATABASE_DIRECT_URL: "postgres://owner", DATABASE_URL: "postgres://owner" })).toBe("postgres://migration");
  });

  it("keeps the local fallback order outside production", () => {
    expect(resolveMigrationConnectionString({ NODE_ENV: "test", DATABASE_DIRECT_URL: "postgres://direct", DATABASE_URL: "postgres://owner" })).toBe("postgres://direct");
    expect(resolveMigrationConnectionString({ NODE_ENV: "development", DATABASE_URL: "postgres://owner" })).toBe("postgres://owner");
  });
});
