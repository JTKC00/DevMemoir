type MigrationEnvironment = {
  NODE_ENV?: string;
  DATABASE_MIGRATIONS_URL?: string;
  DATABASE_DIRECT_URL?: string;
  DATABASE_URL?: string;
};

export function resolveMigrationConnectionString(env: MigrationEnvironment = process.env): string {
  const connectionString = env.NODE_ENV === "production"
    ? env.DATABASE_MIGRATIONS_URL
    : env.DATABASE_MIGRATIONS_URL ?? env.DATABASE_DIRECT_URL ?? env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(env.NODE_ENV === "production"
      ? "DATABASE_MIGRATIONS_URL is required in production"
      : "DATABASE_MIGRATIONS_URL, DATABASE_DIRECT_URL, or DATABASE_URL is required");
  }
  return connectionString;
}
