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
  lastInventoryAt: nullableTime("last_inventory_at"),
  apiPausedUntil: nullableTime("api_paused_until"),
  apiPauseReason: varchar("api_pause_reason", { length: 120 }),
  createdAt: time("created_at"),
  updatedAt: time("updated_at"),
}, (table) => [uniqueIndex("github_installations_external_id_unique").on(table.githubInstallationId), uniqueIndex("github_installations_tenant_id_unique").on(table.tenantId, table.id), index("github_installations_tenant_idx").on(table.tenantId)]);

/** Minimal cross-tenant routing metadata used to resolve a webhook installation. */
export const installationRoutes = pgTable("installation_routes", {
  githubInstallationId: bigint("github_installation_id", { mode: "number" }).primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  createdAt: time("created_at"),
  updatedAt: time("updated_at"),
});

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
  disabled: boolean("disabled").notNull().default(false),
  githubCreatedAt: nullableTime("github_created_at"),
  githubUpdatedAt: nullableTime("github_updated_at"),
  githubPushedAt: nullableTime("github_pushed_at"),
  firstSeenAt: nullableTime("first_seen_at"),
  lastSeenAt: nullableTime("last_seen_at"),
  lastAuthoritativeObservedAt: nullableTime("last_authoritative_observed_at"),
  deletedAt: nullableTime("deleted_at"),
  createdAt: time("created_at"),
  updatedAt: time("updated_at"),
}, (table) => [
  uniqueIndex("repositories_tenant_external_id_unique").on(table.tenantId, table.githubRepositoryId),
  uniqueIndex("repositories_tenant_id_unique").on(table.tenantId, table.id),
  index("repositories_tenant_pushed_idx").on(table.tenantId, table.githubPushedAt),
]);

export const repositoryAccess = pgTable("repository_access", {
  id: id(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  repositoryId: uuid("repository_id").notNull().references(() => repositories.id),
  installationId: uuid("installation_id").notNull().references(() => githubInstallations.id),
  accessStatus: varchar("access_status", { length: 30 }).notNull().default("accessible"),
  selected: boolean("selected").notNull().default(false),
  selectedAt: nullableTime("selected_at"),
  revokedAt: nullableTime("revoked_at"),
  lastSeenAt: nullableTime("last_seen_at"),
  lastAuthoritativeObservedAt: nullableTime("last_authoritative_observed_at"),
}, (table) => [uniqueIndex("repository_access_unique").on(table.tenantId, table.repositoryId, table.installationId), uniqueIndex("repository_access_one_selected_per_tenant_idx").on(table.tenantId).where(sql`selected = true`), index("repository_access_status_idx").on(table.tenantId, table.accessStatus)]);

export const repositoryNameHistory = pgTable("repository_name_history", {
  id: id(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  repositoryId: uuid("repository_id").notNull().references(() => repositories.id),
  ownerLogin: varchar("owner_login", { length: 255 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  fullName: varchar("full_name", { length: 511 }).notNull(),
  validFrom: time("valid_from"),
  validTo: nullableTime("valid_to"),
}, (table) => [index("repository_name_history_lookup_idx").on(table.tenantId, table.repositoryId, table.validFrom)]);

export const branches = pgTable("branches", {
  id: id(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  repositoryId: uuid("repository_id").notNull().references(() => repositories.id),
  name: varchar("name", { length: 255 }).notNull(),
  headSha: varchar("head_sha", { length: 64 }),
  protected: boolean("protected").notNull().default(false),
  reachable: boolean("reachable").notNull().default(true),
  firstSeenAt: nullableTime("first_seen_at"),
  lastSeenAt: nullableTime("last_seen_at"),
  lastAuthoritativeObservedAt: nullableTime("last_authoritative_observed_at"),
  observationGeneration: nullableTime("observation_generation"),
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
  htmlUrl: text("html_url"),
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
  sourceUrl: text("source_url"),
  completenessState: varchar("completeness_state", { length: 40 }).notNull().default("observed"),
  visibility: varchar("visibility", { length: 20 }).notNull().default("unknown"),
  attributionConfidence: varchar("attribution_confidence", { length: 40 }).notNull().default("unknown"),
  projectionVersion: integer("projection_version").notNull().default(0),
  logicalEventKey: varchar("logical_event_key", { length: 1024 }).notNull(),
}, (table) => [
  uniqueIndex("development_events_source_unique").on(table.tenantId, table.repositoryId, table.sourceSystem, table.sourceKind, table.sourceExternalId, table.verb),
  uniqueIndex("development_events_logical_key_unique").on(table.logicalEventKey),
  index("development_events_tenant_date_idx").on(table.tenantId, table.occurredAt),
  index("development_events_tenant_repository_date_idx").on(table.tenantId, table.repositoryId, table.occurredAt),
  index("development_events_context_actor_idx").on(table.tenantId, table.repositoryId, table.contextKind, table.actorKind),
]);

export const commitRefs = pgTable("commit_refs", {
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  commitId: uuid("commit_id").notNull().references(() => commits.id),
  branchId: uuid("branch_id").notNull().references(() => branches.id),
  lastSeenAt: time("last_seen_at"),
  reachable: boolean("reachable").notNull().default(true),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.commitId, table.branchId] }),
  index("commit_refs_branch_reachable_idx").on(table.tenantId, table.branchId, table.reachable),
]);

export const tags = pgTable("tags", {
  id: id(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  repositoryId: uuid("repository_id").notNull().references(() => repositories.id),
  name: varchar("name", { length: 255 }).notNull(),
  targetSha: varchar("target_sha", { length: 64 }).notNull(),
  targetType: varchar("target_type", { length: 30 }),
  reachable: boolean("reachable").notNull().default(true),
  completenessState: varchar("completeness_state", { length: 40 }).notNull().default("reachable_at_sync"),
  firstSeenAt: time("first_seen_at"),
  lastSeenAt: time("last_seen_at"),
  lastAuthoritativeObservedAt: time("last_authoritative_observed_at"),
  observationGeneration: time("observation_generation"),
  deletedAt: nullableTime("deleted_at"),
}, (table) => [
  uniqueIndex("tags_repo_name_unique").on(table.tenantId, table.repositoryId, table.name),
  index("tags_repo_reachable_idx").on(table.tenantId, table.repositoryId, table.reachable),
]);

export const pullRequests = pgTable("pull_requests", {
  id: id(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  repositoryId: uuid("repository_id").notNull().references(() => repositories.id),
  githubPullRequestId: bigint("github_pull_request_id", { mode: "number" }).notNull(),
  number: integer("number").notNull(),
  title: text("title").notNull(),
  state: varchar("state", { length: 30 }).notNull(),
  draft: boolean("draft").notNull().default(false),
  authorGithubAccountId: uuid("author_github_account_id").references(() => githubAccounts.id),
  authorActorKind: varchar("author_actor_kind", { length: 20 }).notNull().default("unknown"),
  mergerGithubAccountId: uuid("merger_github_account_id").references(() => githubAccounts.id),
  baseRef: varchar("base_ref", { length: 500 }),
  baseSha: varchar("base_sha", { length: 64 }),
  headRef: varchar("head_ref", { length: 500 }),
  headSha: varchar("head_sha", { length: 64 }),
  sourceUrl: text("source_url"),
  githubCreatedAt: time("github_created_at"),
  githubUpdatedAt: time("github_updated_at"),
  githubClosedAt: nullableTime("github_closed_at"),
  githubMergedAt: nullableTime("github_merged_at"),
  firstSeenAt: time("first_seen_at"),
  lastSeenAt: time("last_seen_at"),
  completenessState: varchar("completeness_state", { length: 40 }).notNull().default("observed"),
}, (table) => [
  uniqueIndex("pull_requests_repo_github_id_unique").on(table.tenantId, table.repositoryId, table.githubPullRequestId),
  uniqueIndex("pull_requests_repo_number_unique").on(table.tenantId, table.repositoryId, table.number),
  index("pull_requests_repo_updated_idx").on(table.tenantId, table.repositoryId, table.githubUpdatedAt),
]);

export const issues = pgTable("issues", {
  id: id(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  repositoryId: uuid("repository_id").notNull().references(() => repositories.id),
  githubIssueId: bigint("github_issue_id", { mode: "number" }).notNull(),
  number: integer("number").notNull(),
  title: text("title").notNull(),
  state: varchar("state", { length: 30 }).notNull(),
  stateReason: varchar("state_reason", { length: 40 }),
  authorGithubAccountId: uuid("author_github_account_id").references(() => githubAccounts.id),
  authorActorKind: varchar("author_actor_kind", { length: 20 }).notNull().default("unknown"),
  sourceUrl: text("source_url"),
  githubCreatedAt: time("github_created_at"),
  githubUpdatedAt: time("github_updated_at"),
  githubClosedAt: nullableTime("github_closed_at"),
  firstSeenAt: time("first_seen_at"),
  lastSeenAt: time("last_seen_at"),
  completenessState: varchar("completeness_state", { length: 40 }).notNull().default("observed"),
}, (table) => [
  uniqueIndex("issues_repo_github_id_unique").on(table.tenantId, table.repositoryId, table.githubIssueId),
  uniqueIndex("issues_repo_number_unique").on(table.tenantId, table.repositoryId, table.number),
  index("issues_repo_updated_idx").on(table.tenantId, table.repositoryId, table.githubUpdatedAt),
]);

export const releases = pgTable("releases", {
  id: id(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  repositoryId: uuid("repository_id").notNull().references(() => repositories.id),
  githubReleaseId: bigint("github_release_id", { mode: "number" }).notNull(),
  tagName: varchar("tag_name", { length: 255 }).notNull(),
  name: text("name"),
  draft: boolean("draft").notNull().default(false),
  prerelease: boolean("prerelease").notNull().default(false),
  authorGithubAccountId: uuid("author_github_account_id").references(() => githubAccounts.id),
  authorActorKind: varchar("author_actor_kind", { length: 20 }).notNull().default("unknown"),
  sourceUrl: text("source_url"),
  githubCreatedAt: time("github_created_at"),
  githubUpdatedAt: time("github_updated_at"),
  githubPublishedAt: nullableTime("github_published_at"),
  firstSeenAt: time("first_seen_at"),
  lastSeenAt: time("last_seen_at"),
  completenessState: varchar("completeness_state", { length: 40 }).notNull().default("observed"),
}, (table) => [
  uniqueIndex("releases_repo_github_id_unique").on(table.tenantId, table.repositoryId, table.githubReleaseId),
  index("releases_repo_updated_idx").on(table.tenantId, table.repositoryId, table.githubUpdatedAt),
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

export const unroutedWebhookDeliveries = pgTable("unrouted_webhook_deliveries", {
  id: id(),
  githubDeliveryGuid: varchar("github_delivery_guid", { length: 128 }).notNull(),
  eventName: varchar("event_name", { length: 80 }).notNull(),
  payloadCiphertext: text("payload_ciphertext"),
  receivedAt: time("received_at"),
  payloadExpiresAt: time("payload_expires_at"),
}, (table) => [uniqueIndex("unrouted_webhook_deliveries_guid_unique").on(table.githubDeliveryGuid)]);

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
  refName: varchar("ref_name", { length: 500 }).notNull().default(""),
  headSha: varchar("head_sha", { length: 64 }),
  cursor: jsonb("cursor").$type<Record<string, unknown>>().notNull().default({}),
  highWaterAt: nullableTime("high_water_at"),
  lastSuccessAt: nullableTime("last_success_at"),
  lastFullReconcileAt: nullableTime("last_full_reconcile_at"),
  status: varchar("status", { length: 30 }).notNull().default("pending"),
  startedAt: nullableTime("started_at"),
  completedAt: nullableTime("completed_at"),
  pausedUntil: nullableTime("paused_until"),
  errorCode: varchar("error_code", { length: 120 }),
  completenessState: varchar("completeness_state", { length: 40 }).notNull().default("known_unknown"),
  schemaVersion: integer("schema_version").notNull().default(1),
}, (table) => [uniqueIndex("sync_cursors_resource_unique").on(table.tenantId, table.repositoryId, table.resourceType, table.refName)]);

export const reconciliationGenerations = pgTable("reconciliation_generations", {
  id: id(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  repositoryId: uuid("repository_id").notNull().references(() => repositories.id),
  reconciliationRunId: uuid("reconciliation_run_id").notNull(),
  generation: bigint("generation", { mode: "number" }).notNull(),
  current: boolean("current").notNull().default(false),
  startedAt: time("started_at"),
  supersededAt: nullableTime("superseded_at"),
}, (table) => [
  uniqueIndex("reconciliation_generations_run_unique").on(table.tenantId, table.repositoryId, table.reconciliationRunId),
  uniqueIndex("reconciliation_generations_generation_unique").on(table.tenantId, table.repositoryId, table.generation),
  uniqueIndex("reconciliation_generations_current_unique").on(table.tenantId, table.repositoryId).where(sql`current = true`),
  uniqueIndex("reconciliation_generations_tenant_id_unique").on(table.tenantId, table.id),
]);

export const githubDeliveryAudits = pgTable("github_delivery_audits", {
  id: id(),
  githubAppId: bigint("github_app_id", { mode: "number" }).notNull(),
  currentRunId: uuid("current_run_id").notNull(),
  generation: bigint("generation", { mode: "number" }).notNull(),
  status: varchar("status", { length: 30 }).notNull().default("pending"),
  listCursor: text("list_cursor"),
  pageNumber: integer("page_number").notNull().default(1),
  stopBeforeDeliveredAt: nullableTime("stop_before_delivered_at"),
  newestDeliveredAtSeen: nullableTime("newest_delivered_at_seen"),
  highWaterDeliveredAt: nullableTime("high_water_delivered_at"),
  pausedUntil: nullableTime("paused_until"),
  pauseReason: varchar("pause_reason", { length: 120 }),
  lastErrorCode: varchar("last_error_code", { length: 120 }),
  lastSuccessAt: nullableTime("last_success_at"),
  startedAt: time("started_at"),
  completedAt: nullableTime("completed_at"),
  updatedAt: time("updated_at"),
}, (table) => [
  uniqueIndex("github_delivery_audits_app_unique").on(table.githubAppId),
  uniqueIndex("github_delivery_audits_run_unique").on(table.githubAppId, table.currentRunId),
]);

export const maintenanceWindows = pgTable("maintenance_windows", {
  task: varchar("task", { length: 40 }).notNull(),
  bucket: varchar("bucket", { length: 16 }).notNull(),
  jobKind: varchar("job_kind", { length: 40 }).notNull(),
  acceptedJobId: varchar("accepted_job_id", { length: 64 }).notNull(),
  acceptedAt: time("accepted_at"),
  completedAt: nullableTime("completed_at"),
  lastErrorCode: varchar("last_error_code", { length: 120 }),
  updatedAt: time("updated_at"),
}, (table) => [primaryKey({ columns: [table.task, table.bucket] })]);

export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerInstanceId: uuid("worker_instance_id").primaryKey(),
  startedAt: time("started_at"),
  lastHeartbeatAt: time("last_heartbeat_at"),
  stoppedAt: nullableTime("stopped_at"),
  updatedAt: time("updated_at"),
}, (table) => [index("worker_heartbeats_last_heartbeat_idx").on(table.lastHeartbeatAt)]);

export const githubDeliveryRepairs = pgTable("github_delivery_repairs", {
  id: id(),
  githubDeliveryGuid: varchar("github_delivery_guid", { length: 128 }).notNull(),
  githubDeliveryId: bigint("github_delivery_id", { mode: "number" }).notNull(),
  githubAppId: bigint("github_app_id", { mode: "number" }).notNull(),
  auditRunId: uuid("audit_run_id"),
  eventName: varchar("event_name", { length: 80 }).notNull(),
  action: varchar("action", { length: 80 }),
  installationGithubId: bigint("installation_github_id", { mode: "number" }),
  repositoryGithubId: bigint("repository_github_id", { mode: "number" }),
  status: varchar("status", { length: 30 }).notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastRedeliveryRequestedAt: nullableTime("last_redelivery_requested_at"),
  nextEligibleAt: nullableTime("next_eligible_at"),
  lastGithubStatusCode: integer("last_github_status_code"),
  lastGithubDeliveredAt: nullableTime("last_github_delivered_at"),
  sanitizedErrorCode: varchar("sanitized_error_code", { length: 120 }),
  createdAt: time("created_at"),
  updatedAt: time("updated_at"),
}, (table) => [
  uniqueIndex("github_delivery_repairs_guid_unique").on(table.githubDeliveryGuid),
  index("github_delivery_repairs_status_idx").on(table.status, table.nextEligibleAt),
]);

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
  installationRoutes,
  repositories,
  repositoryAccess,
  repositoryNameHistory,
  branches,
  commits,
  developmentEvents,
  commitRefs,
  tags,
  pullRequests,
  issues,
  releases,
  webhookDeliveries,
  unroutedWebhookDeliveries,
  syncJobs,
  syncCursors,
  reconciliationGenerations,
  githubDeliveryAudits,
  githubDeliveryRepairs,
  maintenanceWindows,
  workerHeartbeats,
  outbox,
};

export const tenantTables = [tenants, users, tenantMembers, githubIdentities, authTransactions, applicationSessions, githubInstallations, repositories, repositoryAccess, repositoryNameHistory, branches, commits, developmentEvents, commitRefs, tags, pullRequests, issues, releases, webhookDeliveries, syncJobs, syncCursors, reconciliationGenerations, outbox] as const;

export const now = sql`now()`;
