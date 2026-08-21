import { sql } from "drizzle-orm";
import { bigint, boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey();
const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" }).notNull();
const nullableTime = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const tenants = pgTable("tenants", {
  id: id(),
  slug: varchar("slug", { length: 120 }).notNull(),
  createdAt: time("created_at"),
  deletionRequestedAt: nullableTime("deletion_requested_at"),
}, (table) => [uniqueIndex("tenants_slug_unique").on(table.slug)]);

export const users = pgTable("users", {
  id: id(),
  primaryTenantId: uuid("primary_tenant_id").notNull().references(() => tenants.id),
  displayName: varchar("display_name", { length: 160 }).notNull(),
  createdAt: time("created_at"),
  deletedAt: nullableTime("deleted_at"),
}, (table) => [index("users_primary_tenant_idx").on(table.primaryTenantId)]);

export const tenantMembers = pgTable("tenant_members", {
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  role: varchar("role", { length: 40 }).notNull().default("owner"),
  createdAt: time("created_at"),
}, (table) => [primaryKey({ columns: [table.tenantId, table.userId] })]);

export const githubAccounts = pgTable("github_accounts", {
  id: id(),
  githubAccountId: bigint("github_account_id", { mode: "number" }).notNull(),
  accountType: varchar("account_type", { length: 40 }).notNull().default("User"),
  actorKind: varchar("actor_kind", { length: 20 }).notNull().default("unknown"),
  login: varchar("login", { length: 255 }),
  nodeId: varchar("node_id", { length: 255 }),
  avatarUrl: text("avatar_url"),
  profileUpdatedAt: nullableTime("profile_updated_at"),
}, (table) => [uniqueIndex("github_accounts_external_id_unique").on(table.githubAccountId)]);

export const githubIdentities = pgTable("github_identities", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id),
  githubAccountId: uuid("github_account_id").notNull().references(() => githubAccounts.id),
  linkedAt: time("linked_at"),
  verifiedAt: time("verified_at"),
}, (table) => [
  uniqueIndex("github_identities_user_unique").on(table.userId),
  uniqueIndex("github_identities_account_unique").on(table.githubAccountId),
]);

export const authTransactions = pgTable("auth_transactions", {
  id: id(),
  stateHash: varchar("state_hash", { length: 128 }).notNull(),
  codeVerifierCiphertext: text("code_verifier_ciphertext").notNull(),
  handoffHash: varchar("handoff_hash", { length: 128 }),
  returnPath: varchar("return_path", { length: 500 }).notNull(),
  githubAccountId: bigint("github_account_id", { mode: "number" }),
  userId: uuid("user_id").references(() => users.id),
  createdAt: time("created_at"),
  expiresAt: time("expires_at"),
  consumedAt: nullableTime("consumed_at"),
  handoffConsumedAt: nullableTime("handoff_consumed_at"),
}, (table) => [uniqueIndex("auth_transactions_state_unique").on(table.stateHash), uniqueIndex("auth_transactions_handoff_unique").on(table.handoffHash)]);

export const applicationSessions = pgTable("application_sessions", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id),
  tokenHash: varchar("token_hash", { length: 128 }).notNull(),
  csrfTokenHash: varchar("csrf_token_hash", { length: 128 }).notNull(),
  createdAt: time("created_at"),
  expiresAt: time("expires_at"),
  revokedAt: nullableTime("revoked_at"),
  lastSeenAt: nullableTime("last_seen_at"),
}, (table) => [uniqueIndex("application_sessions_token_unique").on(table.tokenHash), index("application_sessions_user_idx").on(table.userId)]);

export const githubInstallations = pgTable("github_installations", {
  id: id(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  githubInstallationId: bigint("github_installation_id", { mode: "number" }).notNull(),
  accountGithubAccountId: uuid("account_github_account_id").notNull().references(() => githubAccounts.id),
  status: varchar("status", { length: 30 }).notNull().default("active"),
  permissions: jsonb("permissions").$type<Record<string, string>>().notNull().default({}),
  repositorySelection: varchar("repository_selection", { length: 30 }),
  suspendedAt: nullableTime("suspended_at"),
  deletedAt: nullableTime("deleted_at"),
  createdAt: time("created_at"),
  updatedAt: time("updated_at"),
}, (table) => [uniqueIndex("github_installations_external_id_unique").on(table.githubInstallationId), index("github_installations_tenant_idx").on(table.tenantId)]);

export const repositories = pgTable("repositories", {
  id: id(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  githubRepositoryId: bigint("github_repository_id", { mode: "number" }).notNull(),
  nodeId: varchar("node_id", { length: 255 }),
  ownerLogin: varchar("owner_login", { length: 255 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  fullName: varchar("full_name", { length: 511 }).notNull(),
  private: boolean("private").notNull().default(false),
  visibility: varchar("visibility", { length: 30 }),
  defaultBranch: varchar("default_branch", { length: 255 }).notNull(),
  description: text("description"),
  topics: jsonb("topics").$type<string[]>().notNull().default([]),
  languages: jsonb("languages").$type<Record<string, number>>().notNull().default({}),
  archivedAt: nullableTime("archived_at"),
  githubCreatedAt: nullableTime("github_created_at"),
  githubUpdatedAt: nullableTime("github_updated_at"),
  githubPushedAt: nullableTime("github_pushed_at"),
  deletedAt: nullableTime("deleted_at"),
  createdAt: time("created_at"),
  updatedAt: time("updated_at"),
}, (table) => [
  uniqueIndex("repositories_tenant_external_id_unique").on(table.tenantId, table.githubRepositoryId),
  index("repositories_tenant_pushed_idx").on(table.tenantId, table.githubPushedAt),
]);

export const repositoryAccess = pgTable("repository_access", {
  id: id(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  repositoryId: uuid("repository_id").notNull().references(() => repositories.id),
  installationId: uuid("installation_id").notNull().references(() => githubInstallations.id),
  accessStatus: varchar("access_status", { length: 30 }).notNull().default("selected"),
  selectedAt: time("selected_at"),
  revokedAt: nullableTime("revoked_at"),
}, (table) => [uniqueIndex("repository_access_unique").on(table.tenantId, table.repositoryId, table.installationId), index("repository_access_status_idx").on(table.tenantId, table.accessStatus)]);

export const branches = pgTable("branches", {
  id: id(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  repositoryId: uuid("repository_id").notNull().references(() => repositories.id),
  name: varchar("name", { length: 255 }).notNull(),
  headSha: varchar("head_sha", { length: 64 }),
  protected: boolean("protected").notNull().default(false),
  reachable: boolean("reachable").notNull().default(true),
  lastSeenAt: nullableTime("last_seen_at"),
  deletedAt: nullableTime("deleted_at"),
}, (table) => [uniqueIndex("branches_repo_name_unique").on(table.tenantId, table.repositoryId, table.name)]);

export const commits = pgTable("commits", {
  id: id(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  repositoryId: uuid("repository_id").notNull().references(() => repositories.id),
  sha: varchar("sha", { length: 64 }).notNull(),
  authorGithubAccountId: uuid("author_github_account_id").references(() => githubAccounts.id),
  committerGithubAccountId: uuid("committer_github_account_id").references(() => githubAccounts.id),
  message: text("message").notNull(),
  authoredAt: nullableTime("authored_at"),
  committedAt: nullableTime("committed_at"),
  parentShas: jsonb("parent_shas").$type<string[]>().notNull().default([]),
  verified: boolean("verified"),
  additions: integer("additions"),
  deletions: integer("deletions"),
  firstSeenAt: time("first_seen_at"),
  lastSeenAt: time("last_seen_at"),
}, (table) => [
  uniqueIndex("commits_tenant_repo_sha_unique").on(table.tenantId, table.repositoryId, table.sha),
  index("commits_tenant_repo_date_idx").on(table.tenantId, table.repositoryId, table.committedAt),
]);

export const developmentEvents = pgTable("development_events", {
  id: id(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  repositoryId: uuid("repository_id").notNull().references(() => repositories.id),
  sourceSystem: varchar("source_system", { length: 40 }).notNull().default("github"),
  sourceKind: varchar("source_kind", { length: 40 }).notNull(),
  sourceExternalId: varchar("source_external_id", { length: 255 }).notNull(),
  eventType: varchar("event_type", { length: 60 }).notNull(),
  verb: varchar("verb", { length: 60 }).notNull(),
  actorGithubAccountId: uuid("actor_github_account_id").references(() => githubAccounts.id),
  actorKind: varchar("actor_kind", { length: 20 }).notNull().default("unknown"),
  contributionRole: varchar("contribution_role", { length: 40 }).notNull(),
  contextKind: varchar("context_kind", { length: 20 }).notNull().default("unknown"),
  occurredAt: time("occurred_at"),
  sourceUpdatedAt: nullableTime("source_updated_at"),
  title: text("title"),
  summaryInput: text("summary_input"),
  completenessState: varchar("completeness_state", { length: 40 }).notNull().default("observed"),
  visibility: varchar("visibility", { length: 20 }).notNull().default("unknown"),
}, (table) => [
  uniqueIndex("development_events_source_unique").on(table.tenantId, table.repositoryId, table.sourceSystem, table.sourceKind, table.sourceExternalId, table.verb),
  index("development_events_tenant_date_idx").on(table.tenantId, table.occurredAt),
]);

export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: id(),
  tenantId: uuid("tenant_id").references(() => tenants.id),
  githubDeliveryGuid: varchar("github_delivery_guid", { length: 128 }).notNull(),
  eventName: varchar("event_name", { length: 80 }).notNull(),
  action: varchar("action", { length: 80 }),
  installationGithubId: bigint("installation_github_id", { mode: "number" }),
  repositoryGithubId: bigint("repository_github_id", { mode: "number" }),
  ref: varchar("ref", { length: 500 }),
  beforeSha: varchar("before_sha", { length: 64 }),
  afterSha: varchar("after_sha", { length: 64 }),
  forced: boolean("forced"),
  headers: jsonb("headers").$type<Record<string, string>>().notNull().default({}),
  payloadCiphertext: text("payload_ciphertext"),
  payloadKeyVersion: varchar("payload_key_version", { length: 40 }),
  firstReceivedAt: time("first_received_at"),
  lastReceivedAt: time("last_received_at"),
  receiptCount: integer("receipt_count").notNull().default(1),
  state: varchar("state", { length: 30 }).notNull().default("received"),
  processingAttempts: integer("processing_attempts").notNull().default(0),
  leaseExpiresAt: nullableTime("lease_expires_at"),
  jobId: varchar("job_id", { length: 255 }),
  sanitizedErrorCode: varchar("sanitized_error_code", { length: 120 }),
  processedAt: nullableTime("processed_at"),
  payloadExpiresAt: time("payload_expires_at"),
}, (table) => [
  uniqueIndex("webhook_deliveries_guid_unique").on(table.githubDeliveryGuid),
  index("webhook_deliveries_state_idx").on(table.state, table.lastReceivedAt),
]);

export const syncJobs = pgTable("sync_jobs", {
  id: id(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  repositoryId: uuid("repository_id").references(() => repositories.id),
  deliveryId: uuid("delivery_id").references(() => webhookDeliveries.id),
  kind: varchar("kind", { length: 50 }).notNull(),
  stage: varchar("stage", { length: 50 }),
  state: varchar("state", { length: 30 }).notNull().default("queued"),
  logicalKey: varchar("logical_key", { length: 255 }).notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(8),
  scheduledAt: time("scheduled_at"),
  startedAt: nullableTime("started_at"),
  finishedAt: nullableTime("finished_at"),
  heartbeatAt: nullableTime("heartbeat_at"),
  errorCode: varchar("error_code", { length: 120 }),
}, (table) => [uniqueIndex("sync_jobs_logical_key_unique").on(table.logicalKey), index("sync_jobs_tenant_state_idx").on(table.tenantId, table.state)]);

export const syncCursors = pgTable("sync_cursors", {
  id: id(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  repositoryId: uuid("repository_id").notNull().references(() => repositories.id),
  resourceType: varchar("resource_type", { length: 50 }).notNull(),
  refName: varchar("ref_name", { length: 500 }),
  headSha: varchar("head_sha", { length: 64 }),
  cursor: jsonb("cursor").$type<Record<string, unknown>>().notNull().default({}),
  highWaterAt: nullableTime("high_water_at"),
  lastSuccessAt: nullableTime("last_success_at"),
  lastFullReconcileAt: nullableTime("last_full_reconcile_at"),
  schemaVersion: integer("schema_version").notNull().default(1),
}, (table) => [uniqueIndex("sync_cursors_resource_unique").on(table.tenantId, table.repositoryId, table.resourceType, table.refName)]);

export const outbox = pgTable("outbox", {
  id: id(),
  tenantId: uuid("tenant_id").references(() => tenants.id),
  aggregateType: varchar("aggregate_type", { length: 60 }).notNull(),
  aggregateId: uuid("aggregate_id"),
  eventType: varchar("event_type", { length: 80 }).notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: time("created_at"),
  publishedAt: nullableTime("published_at"),
}, (table) => [index("outbox_unpublished_idx").on(table.publishedAt)]);

export const schema = {
  tenants,
  users,
  tenantMembers,
  githubAccounts,
  githubIdentities,
  authTransactions,
  applicationSessions,
  githubInstallations,
  repositories,
  repositoryAccess,
  branches,
  commits,
  developmentEvents,
  webhookDeliveries,
  syncJobs,
  syncCursors,
  outbox,
};

export const tenantTables = [tenants, users, tenantMembers, githubIdentities, authTransactions, applicationSessions, githubInstallations, repositories, repositoryAccess, branches, commits, developmentEvents, webhookDeliveries, syncJobs, syncCursors, outbox] as const;

export const now = sql`now()`;
