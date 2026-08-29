import type { Pool, PoolClient, QueryResultRow } from "pg";
import { canonicalLogicalEventKey, createId, deliveryRedeliveryAction, githubDeliveryAttemptSucceeded, githubDeliveryIsExpired, isTerminalDeliveryState, isTerminalGithubDeliveryRepairStatus, nextRedeliveryClaimLeaseAt, nextRedeliveryEligibleAt, projectCanonicalFacts, PROJECTION_VERSION, repositoryAccessIsAvailable, type CanonicalProjectionInput, type CommitFact, type DevelopmentEvent, type RepositoryAccessStatus } from "@devmemoir/domain";
import { emptyInventoryReconcileResult, InstallationResolutionError, repositoryProjectionInputsChanged, RepositorySelectionError } from "./store.js";
import type {
  ActivityRecord,
  ActivityQuery,
  AuthTransactionRecord,
  DeliveryInsertResult,
  DeliveryRecord,
  GithubDeliveryAudit,
  GithubDeliveryRedeliveryClaim,
  GithubDeliveryRepair,
  GithubDeliveryRepairObservation,
  InventoryReconcileResult,
  InstallationRecord,
  InstallationLifecycleStatus,
  HistoricalActor,
  HistoricalCursor,
  HistoricalPageCommit,
  HistoricalPageCommitResult,
  HistoricalProgress,
  HistoricalSourceCounts,
  HistoricalSourceStage,
  HistoricalStage,
  M1Store,
  ProjectionResult,
  ReconciliationGeneration,
  RepositoryRecord,
  RefSyncContinuation,
  SessionRecord,
  UserRecord,
} from "./store.js";
import { HISTORICAL_STAGES } from "./store.js";

type Row = QueryResultRow & Record<string, unknown>;

function date(value: unknown): Date | undefined {
  return value instanceof Date ? value : typeof value === "string" ? new Date(value) : undefined;
}

function branchName(ref: string): string {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("heads/")) return ref.slice("heads/".length);
  return ref;
}

function userFromRow(row: Row | undefined): UserRecord | undefined {
  if (!row) return undefined;
  return {
    userId: String(row.user_id),
    tenantId: String(row.tenant_id),
    githubAccountId: Number(row.github_account_id),
    login: String(row.login),
    displayName: String(row.display_name),
  };
}

function installationFromRow(row: Row | undefined): InstallationRecord | undefined {
  if (!row) return undefined;
  const suspendedAt = date(row.suspended_at);
  const deletedAt = date(row.deleted_at);
  const lastInventoryAt = date(row.last_inventory_at);
  const apiPausedUntil = date(row.api_paused_until);
  const permissions = row.permissions && typeof row.permissions === "object" && !Array.isArray(row.permissions) ? row.permissions as Record<string, string> : undefined;
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    githubInstallationId: Number(row.github_installation_id),
    accountGithubAccountId: Number(row.account_github_account_id),
    ...(permissions ? { permissions } : {}),
    ...(row.repository_selection ? { repositorySelection: String(row.repository_selection) } : {}),
    ...(row.status ? { status: row.status as NonNullable<InstallationRecord["status"]> } : {}),
    ...(suspendedAt ? { suspendedAt } : {}),
    ...(deletedAt ? { deletedAt } : {}),
    ...(lastInventoryAt ? { lastInventoryAt } : {}),
    ...(apiPausedUntil ? { apiPausedUntil } : {}),
    ...(row.api_pause_reason ? { apiPauseReason: String(row.api_pause_reason) } : {}),
  };
}

function historicalProgressFromRow(row: Row | undefined): HistoricalProgress | undefined {
  if (!row) return undefined;
  const value = row.cursor && typeof row.cursor === "object" && !Array.isArray(row.cursor) ? row.cursor as Record<string, unknown> : {};
  const nextPage = typeof value.nextPage === "number" && Number.isInteger(value.nextPage) && value.nextPage > 0 ? value.nextPage : 1;
  const cursor: HistoricalCursor = { ...value, nextPage };
  const highWaterAt = date(row.high_water_at);
  const startedAt = date(row.started_at);
  const lastSuccessAt = date(row.last_success_at);
  const completedAt = date(row.completed_at);
  const pausedUntil = date(row.paused_until);
  return {
    tenantId: String(row.tenant_id),
    repositoryId: String(row.repository_id),
    stage: row.resource_type as HistoricalStage,
    refName: String(row.ref_name ?? ""),
    status: row.status as HistoricalProgress["status"],
    cursor,
    nextPage,
    ...(row.head_sha ? { anchorHeadSha: String(row.head_sha) } : {}),
    ...(highWaterAt ? { highWaterAt } : {}),
    ...(startedAt ? { startedAt, observationStartedAt: startedAt } : {}),
    ...(lastSuccessAt ? { lastSuccessAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(pausedUntil ? { pausedUntil } : {}),
    ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
    completenessState: row.completeness_state as HistoricalProgress["completenessState"],
  };
}

function reconciliationGenerationFromRow(row: Row | undefined): ReconciliationGeneration | undefined {
  if (!row) return undefined;
  const startedAt = date(row.started_at);
  const supersededAt = date(row.superseded_at);
  return {
    tenantId: String(row.tenant_id),
    repositoryId: String(row.repository_id),
    reconciliationRunId: String(row.reconciliation_run_id),
    generation: Number(row.generation),
    current: Boolean(row.current),
    startedAt: startedAt ?? new Date(0),
    ...(supersededAt ? { supersededAt } : {}),
  };
}

function nextHistoricalStage(stage: HistoricalSourceStage): HistoricalStage {
  const index = HISTORICAL_STAGES.indexOf(stage);
  return HISTORICAL_STAGES[index + 1] ?? "completed";
}

function repositoryFromRow(row: Row | undefined): RepositoryRecord | undefined {
  if (!row) return undefined;
  const firstSeenAt = date(row.first_seen_at);
  const lastSeenAt = date(row.last_seen_at);
  const lastAuthoritativeObservedAt = date(row.last_authoritative_observed_at);
  const revokedAt = date(row.revoked_at);
  const githubCreatedAt = date(row.github_created_at);
  const githubUpdatedAt = date(row.github_updated_at);
  const githubPushedAt = date(row.github_pushed_at);
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    installationId: String(row.installation_id),
    githubRepositoryId: Number(row.github_repository_id),
    ownerLogin: String(row.owner_login),
    name: String(row.name),
    fullName: String(row.full_name),
    private: Boolean(row.private),
    ...(row.node_id ? { nodeId: String(row.node_id) } : {}),
    ...(row.visibility ? { visibility: String(row.visibility) } : {}),
    defaultBranch: String(row.default_branch),
    ...(row.description ? { description: String(row.description) } : {}),
    ...(row.archived_at ? { archived: true, archivedAt: new Date(String(row.archived_at)) } : {}),
    ...(row.disabled !== null && row.disabled !== undefined ? { disabled: Boolean(row.disabled) } : {}),
    ...(row.access_status ? { accessStatus: (row.access_status === "selected" || row.access_status === "unselected" ? "accessible" : row.access_status) as RepositoryAccessStatus, selected: row.selected !== null && row.selected !== undefined ? Boolean(row.selected) : row.access_status === "selected" } : {}),
    ...(firstSeenAt ? { firstSeenAt } : {}),
    ...(lastSeenAt ? { lastSeenAt } : {}),
    ...(lastAuthoritativeObservedAt ? { lastAuthoritativeObservedAt } : {}),
    ...(revokedAt ? { revokedAt } : {}),
    ...(githubCreatedAt ? { githubCreatedAt } : {}),
    ...(githubUpdatedAt ? { githubUpdatedAt } : {}),
    ...(githubPushedAt ? { githubPushedAt } : {}),
  };
}

function auditFromRow(row: Row | undefined): GithubDeliveryAudit | undefined {
  if (!row) return undefined;
  const startedAt = date(row.started_at);
  const updatedAt = date(row.updated_at);
  if (!startedAt || !updatedAt) return undefined;
  const listCursor = row.list_cursor ? String(row.list_cursor) : undefined;
  const stopBeforeDeliveredAt = date(row.stop_before_delivered_at);
  const newestDeliveredAtSeen = date(row.newest_delivered_at_seen);
  const highWaterDeliveredAt = date(row.high_water_delivered_at);
  const pausedUntil = date(row.paused_until);
  const lastSuccessAt = date(row.last_success_at);
  const completedAt = date(row.completed_at);
  return {
    id: String(row.id),
    githubAppId: Number(row.github_app_id),
    currentRunId: String(row.current_run_id),
    generation: Number(row.generation),
    status: row.status as GithubDeliveryAudit["status"],
    ...(listCursor ? { listCursor } : {}),
    pageNumber: Number(row.page_number),
    ...(stopBeforeDeliveredAt ? { stopBeforeDeliveredAt } : {}),
    ...(newestDeliveredAtSeen ? { newestDeliveredAtSeen } : {}),
    ...(highWaterDeliveredAt ? { highWaterDeliveredAt } : {}),
    ...(pausedUntil ? { pausedUntil } : {}),
    ...(row.pause_reason ? { pauseReason: String(row.pause_reason) } : {}),
    ...(row.last_error_code ? { lastErrorCode: String(row.last_error_code) } : {}),
    ...(lastSuccessAt ? { lastSuccessAt } : {}),
    startedAt,
    ...(completedAt ? { completedAt } : {}),
    updatedAt,
  };
}

function repairFromRow(row: Row | undefined): GithubDeliveryRepair | undefined {
  if (!row) return undefined;
  const lastRedeliveryRequestedAt = date(row.last_redelivery_requested_at);
  const nextEligibleAt = date(row.next_eligible_at);
  const lastGithubDeliveredAt = date(row.last_github_delivered_at);
  return {
    id: String(row.id),
    githubDeliveryGuid: String(row.github_delivery_guid),
    githubDeliveryId: Number(row.github_delivery_id),
    githubAppId: Number(row.github_app_id),
    ...(row.audit_run_id ? { auditRunId: String(row.audit_run_id) } : {}),
    eventName: String(row.event_name),
    ...(row.action ? { action: String(row.action) } : {}),
    ...(row.installation_github_id ? { installationGithubId: Number(row.installation_github_id) } : {}),
    ...(row.repository_github_id ? { repositoryGithubId: Number(row.repository_github_id) } : {}),
    status: row.status as GithubDeliveryRepair["status"],
    attemptCount: Number(row.attempt_count),
    ...(lastRedeliveryRequestedAt ? { lastRedeliveryRequestedAt } : {}),
    ...(nextEligibleAt ? { nextEligibleAt } : {}),
    ...(row.last_github_status_code !== null && row.last_github_status_code !== undefined ? { lastGithubStatusCode: Number(row.last_github_status_code) } : {}),
    ...(lastGithubDeliveredAt ? { lastGithubDeliveredAt } : {}),
    ...(row.sanitized_error_code ? { sanitizedErrorCode: String(row.sanitized_error_code) } : {}),
  };
}

function deliveryFromRow(row: Row | undefined): DeliveryRecord | undefined {
  if (!row) return undefined;
  const firstReceivedAt = date(row.first_received_at);
  const lastReceivedAt = date(row.last_received_at);
  const payloadExpiresAt = date(row.payload_expires_at);
  const processedAt = date(row.processed_at);
  if (!firstReceivedAt || !lastReceivedAt || !payloadExpiresAt) return undefined;
  return {
    id: String(row.id),
    ...(row.tenant_id ? { tenantId: String(row.tenant_id) } : {}),
    guid: String(row.github_delivery_guid),
    eventName: String(row.event_name),
    ...(row.action ? { action: String(row.action) } : {}),
    ...(row.installation_github_id ? { installationGithubId: Number(row.installation_github_id) } : {}),
    ...(row.repository_github_id ? { repositoryGithubId: Number(row.repository_github_id) } : {}),
    ...(row.ref ? { ref: String(row.ref) } : {}),
    ...(row.before_sha ? { before: String(row.before_sha) } : {}),
    ...(row.after_sha ? { after: String(row.after_sha) } : {}),
    ...(row.forced !== null && row.forced !== undefined ? { forced: Boolean(row.forced) } : {}),
    ...(row.payload_ciphertext ? { payloadCiphertext: String(row.payload_ciphertext) } : {}),
    state: row.state as DeliveryRecord["state"],
    firstReceivedAt,
    lastReceivedAt,
    receiptCount: Number(row.receipt_count),
    processingAttempts: Number(row.processing_attempts),
    ...(row.job_id ? { jobId: String(row.job_id) } : {}),
    ...(row.sanitized_error_code ? { errorCode: String(row.sanitized_error_code) } : {}),
    ...(processedAt ? { processedAt } : {}),
    payloadExpiresAt,
  };
}

/**
 * PostgreSQL-backed M1 store. Every tenant-scoped operation runs inside a
 * transaction-local app.tenant_id context so the first migration's FORCE RLS
 * policy is exercised by the application, not merely documented.
 */
export class PostgresM1Store implements M1Store {
  constructor(private readonly pool: Pool) {}

  private async tenantQuery<T>(tenantId: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      const value = await operation(client);
      await client.query("commit");
      return value;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async createAuthTransaction(record: AuthTransactionRecord): Promise<void> {
    await this.pool.query(
      `insert into auth_transactions (id, state_hash, code_verifier_ciphertext, handoff_hash, return_path, github_account_id, user_id, created_at, expires_at, consumed_at, handoff_consumed_at)
       values ($1,$2,$3,$4,$5,$6,$7,now(),$8,$9,$10)
       on conflict (state_hash) do update set code_verifier_ciphertext=excluded.code_verifier_ciphertext, return_path=excluded.return_path, expires_at=excluded.expires_at`,
      [record.id, record.stateHash, record.codeVerifierCiphertext, record.handoffHash ?? null, record.returnPath, record.githubAccountId ?? null, record.userId ?? null, record.expiresAt, record.consumedAt ?? null, record.handoffConsumedAt ?? null],
    );
  }

  async consumeAuthState(stateHash: string, now: Date): Promise<AuthTransactionRecord | undefined> {
    const result = await this.pool.query<Row>(
      `update auth_transactions set consumed_at=$2 where state_hash=$1 and consumed_at is null and expires_at>$2
       returning id,state_hash,code_verifier_ciphertext,return_path,expires_at,github_account_id,user_id,handoff_hash,consumed_at,handoff_consumed_at`,
      [stateHash, now],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const handoffConsumedAt = date(row.handoff_consumed_at);
    return {
      id: String(row.id), stateHash: String(row.state_hash), codeVerifierCiphertext: String(row.code_verifier_ciphertext), returnPath: String(row.return_path), expiresAt: new Date(String(row.expires_at)),
      ...(row.github_account_id ? { githubAccountId: Number(row.github_account_id) } : {}), ...(row.user_id ? { userId: String(row.user_id) } : {}), ...(row.handoff_hash ? { handoffHash: String(row.handoff_hash) } : {}),
      consumedAt: now, ...(handoffConsumedAt ? { handoffConsumedAt } : {}),
    };
  }

  async attachAuthUser(stateHash: string, user: UserRecord): Promise<void> {
    await this.upsertUser(user);
    await this.pool.query("update auth_transactions set github_account_id=$2,user_id=$3 where state_hash=$1", [stateHash, user.githubAccountId, user.userId]);
  }

  async createHandoff(stateHash: string, handoffHash: string, expiresAt?: Date): Promise<void> {
    await this.pool.query("update auth_transactions set handoff_hash=$2,expires_at=coalesce($3,expires_at) where state_hash=$1 and consumed_at is not null", [stateHash, handoffHash, expiresAt ?? null]);
  }

  async consumeHandoff(handoffHash: string, now: Date): Promise<UserRecord | undefined> {
    const result = await this.pool.query<Row>(
      `update auth_transactions set handoff_consumed_at=$2 where handoff_hash=$1 and handoff_consumed_at is null and expires_at>$2 returning user_id`,
      [handoffHash, now],
    );
    const userId = result.rows[0]?.user_id;
    return userId ? this.getUserById(String(userId)) : undefined;
  }

  async createSession(session: SessionRecord): Promise<void> {
    await this.pool.query(
      `insert into application_sessions (id,user_id,token_hash,csrf_token_hash,created_at,expires_at,revoked_at,last_seen_at) values ($1,$2,$3,$4,now(),$5,$6,now()) on conflict (token_hash) do nothing`,
      [createId(), session.userId, session.tokenHash, session.csrfTokenHash, session.expiresAt, session.revokedAt ?? null],
    );
  }

  async getSession(tokenHash: string, now: Date): Promise<SessionRecord | undefined> {
    const result = await this.pool.query<Row>("select user_id,token_hash,csrf_token_hash,expires_at,revoked_at from application_sessions where token_hash=$1 and revoked_at is null and expires_at>$2", [tokenHash, now]);
    const row = result.rows[0];
    if (!row) return undefined;
    const user = await this.getUserById(String(row.user_id));
    if (!user) return undefined;
    const revokedAt = date(row.revoked_at);
    return { userId: user.userId, tenantId: user.tenantId, tokenHash: String(row.token_hash), csrfTokenHash: String(row.csrf_token_hash), expiresAt: new Date(String(row.expires_at)), ...(revokedAt ? { revokedAt } : {}) };
  }

  async upsertUser(user: UserRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("insert into tenants (id,slug,created_at) values ($1,$2,now()) on conflict (id) do nothing", [user.tenantId, `owner-${user.githubAccountId}`]);
      const account = await client.query<Row>("insert into github_accounts (id,github_account_id,account_type,actor_kind,login) values ($1,$2,'User','user',$3) on conflict (github_account_id) do update set login=excluded.login returning id", [createId(), user.githubAccountId, user.login]);
      const accountId = account.rows[0]?.id;
      await client.query("insert into users (id,primary_tenant_id,display_name,created_at) values ($1,$2,$3,now()) on conflict (id) do update set display_name=excluded.display_name", [user.userId, user.tenantId, user.displayName]);
      await client.query("insert into tenant_members (tenant_id,user_id,role,created_at) values ($1,$2,'owner',now()) on conflict do nothing", [user.tenantId, user.userId]);
      if (accountId) await client.query("insert into github_identities (id,user_id,github_account_id,linked_at,verified_at) values ($1,$2,$3,now(),now()) on conflict (user_id) do update set github_account_id=excluded.github_account_id,verified_at=now()", [createId(), user.userId, accountId]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async getUserById(userId: string): Promise<UserRecord | undefined> {
    const result = await this.pool.query<Row>("select u.id as user_id,u.primary_tenant_id as tenant_id,ga.github_account_id,ga.login,u.display_name from users u join github_identities gi on gi.user_id=u.id join github_accounts ga on ga.id=gi.github_account_id where u.id=$1 and u.deleted_at is null", [userId]);
    return userFromRow(result.rows[0]);
  }

  async getUserByGithubAccountId(githubAccountId: number): Promise<UserRecord | undefined> {
    const result = await this.pool.query<Row>("select u.id as user_id,u.primary_tenant_id as tenant_id,ga.github_account_id,ga.login,u.display_name from users u join github_identities gi on gi.user_id=u.id join github_accounts ga on ga.id=gi.github_account_id where ga.github_account_id=$1 and u.deleted_at is null", [githubAccountId]);
    return userFromRow(result.rows[0]);
  }

  private async ensureGithubAccount(client: Pool | PoolClient, accountId: number, login?: string, accountType = "User", actorKind = "user"): Promise<string> {
    const result = await client.query<Row>("insert into github_accounts (id,github_account_id,account_type,actor_kind,login) values ($1,$2,$3,$4,$5) on conflict (github_account_id) do update set account_type=excluded.account_type,actor_kind=excluded.actor_kind,login=coalesce(excluded.login,github_accounts.login) returning id", [createId(), accountId, accountType, actorKind, login ?? null]);
    return String(result.rows[0]?.id);
  }

  async saveInstallation(installation: InstallationRecord): Promise<void> {
    await this.tenantQuery(installation.tenantId, async (client) => {
      const accountId = await this.ensureGithubAccount(client, installation.accountGithubAccountId);
      await client.query(`insert into github_installations (id,tenant_id,github_installation_id,account_github_account_id,status,permissions,repository_selection,suspended_at,deleted_at,created_at,updated_at) values ($1,$2,$3,$4,'active',$5,$6,null,null,now(),now()) on conflict (github_installation_id) do update set tenant_id=excluded.tenant_id,account_github_account_id=excluded.account_github_account_id,permissions=case when $5::jsonb = '{}'::jsonb then github_installations.permissions else excluded.permissions end,repository_selection=coalesce(excluded.repository_selection,github_installations.repository_selection),status='active',suspended_at=null,deleted_at=null,updated_at=now()`, [installation.id, installation.tenantId, installation.githubInstallationId, accountId, JSON.stringify(installation.permissions ?? {}), installation.repositorySelection ?? null]);
      await client.query(`insert into installation_routes (github_installation_id,tenant_id,created_at,updated_at) values ($1,$2,now(),now()) on conflict (github_installation_id) do update set tenant_id=excluded.tenant_id,updated_at=now()`, [installation.githubInstallationId, installation.tenantId]);
    });
  }

  async updateInstallationSnapshot(input: { tenantId: string; githubInstallationId: number; permissions?: Record<string, string>; repositorySelection?: string }): Promise<void> {
    await this.tenantQuery(input.tenantId, async (client) => {
      const result = await client.query("update github_installations set permissions=coalesce($3::jsonb,permissions),repository_selection=coalesce($4,repository_selection),updated_at=now() where tenant_id=$1 and github_installation_id=$2", [input.tenantId, input.githubInstallationId, input.permissions ? JSON.stringify(input.permissions) : null, input.repositorySelection ?? null]);
      if (result.rowCount !== 1) throw new Error("Installation not found for snapshot update");
    });
  }

  async getInstallation(githubInstallationId: number): Promise<InstallationRecord | undefined> {
    const route = await this.pool.query<Row>("select tenant_id from installation_routes where github_installation_id=$1", [githubInstallationId]);
    const tenantId = route.rows[0]?.tenant_id;
    if (!tenantId) return undefined;
    return this.tenantQuery(String(tenantId), async (client) => {
      const result = await client.query<Row>("select gi.id,gi.tenant_id,gi.github_installation_id,gi.status,gi.permissions,gi.repository_selection,gi.suspended_at,gi.deleted_at,gi.last_inventory_at,gi.api_paused_until,gi.api_pause_reason,ga.github_account_id as account_github_account_id from github_installations gi join github_accounts ga on ga.id=gi.account_github_account_id where gi.github_installation_id=$1", [githubInstallationId]);
      return installationFromRow(result.rows[0]);
    });
  }

  async listInstallations(tenantId: string): Promise<InstallationRecord[]> {
    return this.tenantQuery(tenantId, async (client) => {
      const result = await client.query<Row>("select gi.id,gi.tenant_id,gi.github_installation_id,gi.status,gi.permissions,gi.repository_selection,gi.suspended_at,gi.deleted_at,gi.last_inventory_at,gi.api_paused_until,gi.api_pause_reason,ga.github_account_id as account_github_account_id from github_installations gi join github_accounts ga on ga.id=gi.account_github_account_id where gi.tenant_id=$1", [tenantId]);
      return result.rows.map((row) => installationFromRow(row)).filter((row): row is InstallationRecord => Boolean(row));
    });
  }

  async getActiveInstallationForTenant(tenantId: string): Promise<InstallationRecord | undefined> {
    return this.tenantQuery(tenantId, async (client) => {
      const result = await client.query<Row>("select gi.id,gi.tenant_id,gi.github_installation_id,gi.status,gi.permissions,gi.repository_selection,gi.suspended_at,gi.deleted_at,gi.last_inventory_at,gi.api_paused_until,gi.api_pause_reason,ga.github_account_id as account_github_account_id from github_installations gi join github_accounts ga on ga.id=gi.account_github_account_id where gi.tenant_id=$1 and gi.status='active' limit 2", [tenantId]);
      if (result.rows.length > 1) throw new InstallationResolutionError();
      return installationFromRow(result.rows[0]);
    });
  }

  async saveRepository(repository: RepositoryRecord): Promise<RepositoryRecord> {
    const savedId = await this.tenantQuery(repository.tenantId, async (client) => {
      const result = await client.query<Row>(`insert into repositories (id,tenant_id,github_repository_id,owner_login,name,full_name,private,visibility,default_branch,description,archived_at,disabled,first_seen_at,last_seen_at,last_authoritative_observed_at,created_at,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,coalesce($13,now()),$14,$15,now(),now()) on conflict (tenant_id,github_repository_id) do update set owner_login=excluded.owner_login,name=excluded.name,full_name=excluded.full_name,private=excluded.private,visibility=excluded.visibility,default_branch=excluded.default_branch,description=excluded.description,archived_at=excluded.archived_at,disabled=excluded.disabled,updated_at=now() returning id`, [repository.id, repository.tenantId, repository.githubRepositoryId, repository.ownerLogin, repository.name, repository.fullName, repository.private, repository.visibility ?? null, repository.defaultBranch, repository.description ?? null, repository.archived ? new Date() : null, repository.disabled ?? false, repository.firstSeenAt ?? null, repository.lastSeenAt ?? null, repository.lastAuthoritativeObservedAt ?? null]);
      const repositoryId = String(result.rows[0]?.id ?? repository.id);
      await client.query(`insert into repository_access (id,tenant_id,repository_id,installation_id,access_status,selected,selected_at,last_seen_at,last_authoritative_observed_at,revoked_at) values ($1,$2,$3,$4,'accessible',true,now(),$5,$6,null) on conflict (tenant_id,repository_id,installation_id) do update set access_status='accessible',selected=true,selected_at=coalesce(repository_access.selected_at,now()),revoked_at=null`, [createId(), repository.tenantId, repositoryId, repository.installationId, repository.lastSeenAt ?? null, repository.lastAuthoritativeObservedAt ?? null]);
      return repositoryId;
    });
    return savedId === repository.id ? { ...repository, selected: true, accessStatus: "accessible" } : { ...repository, id: savedId, selected: true, accessStatus: "accessible" };
  }

  async getRepositoryByGithubId(tenantId: string, githubRepositoryId: number): Promise<RepositoryRecord | undefined> {
    return this.tenantQuery(tenantId, async (client) => repositoryFromRow((await client.query<Row>("select r.id,r.tenant_id,ra.installation_id,r.github_repository_id,r.owner_login,r.name,r.full_name,r.private,r.visibility,r.node_id,r.github_created_at,r.github_updated_at,r.github_pushed_at,r.default_branch,r.description,r.archived_at,r.disabled,r.first_seen_at,r.last_seen_at,r.last_authoritative_observed_at,ra.access_status,ra.selected,ra.revoked_at from repositories r join lateral (select ra.installation_id,ra.access_status,ra.selected,ra.revoked_at from repository_access ra join github_installations gi on gi.id=ra.installation_id and gi.tenant_id=ra.tenant_id where ra.repository_id=r.id and ra.tenant_id=r.tenant_id and gi.status='active' order by ra.selected desc, ra.selected_at desc nulls last limit 1) ra on true where r.tenant_id=$1 and r.github_repository_id=$2", [tenantId, githubRepositoryId])).rows[0]));
  }

  async getRepositoryById(tenantId: string, repositoryId: string): Promise<RepositoryRecord | undefined> {
    return this.tenantQuery(tenantId, async (client) => repositoryFromRow((await client.query<Row>("select r.id,r.tenant_id,ra.installation_id,r.github_repository_id,r.owner_login,r.name,r.full_name,r.private,r.visibility,r.node_id,r.github_created_at,r.github_updated_at,r.github_pushed_at,r.default_branch,r.description,r.archived_at,r.disabled,r.first_seen_at,r.last_seen_at,r.last_authoritative_observed_at,ra.access_status,ra.selected,ra.revoked_at from repositories r join lateral (select ra.installation_id,ra.access_status,ra.selected,ra.revoked_at from repository_access ra join github_installations gi on gi.id=ra.installation_id and gi.tenant_id=ra.tenant_id where ra.repository_id=r.id and ra.tenant_id=r.tenant_id and gi.status='active' order by ra.selected desc, ra.selected_at desc nulls last limit 1) ra on true where r.tenant_id=$1 and r.id=$2", [tenantId, repositoryId])).rows[0]));
  }

  async getRepositoryByFullName(tenantId: string, fullName: string): Promise<RepositoryRecord | undefined> {
    return this.tenantQuery(tenantId, async (client) => repositoryFromRow((await client.query<Row>("select r.id,r.tenant_id,ra.installation_id,r.github_repository_id,r.owner_login,r.name,r.full_name,r.private,r.visibility,r.node_id,r.github_created_at,r.github_updated_at,r.github_pushed_at,r.default_branch,r.description,r.archived_at,r.disabled,r.first_seen_at,r.last_seen_at,r.last_authoritative_observed_at,ra.access_status,ra.selected,ra.revoked_at from repositories r join lateral (select ra.installation_id,ra.access_status,ra.selected,ra.revoked_at from repository_access ra join github_installations gi on gi.id=ra.installation_id and gi.tenant_id=ra.tenant_id where ra.repository_id=r.id and ra.tenant_id=r.tenant_id and gi.status='active' order by ra.selected desc, ra.selected_at desc nulls last limit 1) ra on true where r.tenant_id=$1 and r.full_name=$2", [tenantId, fullName])).rows[0]));
  }

  async listRepositories(tenantId: string): Promise<RepositoryRecord[]> {
    const activeInstallation = await this.getActiveInstallationForTenant(tenantId);
    if (!activeInstallation) return [];
    return this.tenantQuery(tenantId, async (client) => {
      const result = await client.query<Row>("select r.id,r.tenant_id,ra.installation_id,r.github_repository_id,r.owner_login,r.name,r.full_name,r.private,r.visibility,r.node_id,r.github_created_at,r.github_updated_at,r.github_pushed_at,r.default_branch,r.description,r.archived_at,r.disabled,r.first_seen_at,r.last_seen_at,r.last_authoritative_observed_at,ra.access_status,ra.selected,ra.revoked_at from repositories r join lateral (select ra.installation_id,ra.access_status,ra.selected,ra.revoked_at from repository_access ra join github_installations gi on gi.id=ra.installation_id and gi.tenant_id=ra.tenant_id where ra.repository_id=r.id and ra.tenant_id=r.tenant_id and gi.status='active' and ra.selected=true and ra.access_status='accessible' order by ra.selected_at desc limit 1) ra on true where r.tenant_id=$1 order by r.created_at asc", [tenantId]);
      return result.rows.map((row) => repositoryFromRow(row)).filter((row): row is RepositoryRecord => Boolean(row));
    });
  }

  async listRepositoryInventory(tenantId: string, installationId?: string): Promise<RepositoryRecord[]> {
    return this.tenantQuery(tenantId, async (client) => {
      const result = await client.query<Row>("select r.id,r.tenant_id,ra.installation_id,r.github_repository_id,r.owner_login,r.name,r.full_name,r.private,r.visibility,r.node_id,r.github_created_at,r.github_updated_at,r.github_pushed_at,r.default_branch,r.description,r.archived_at,r.disabled,r.first_seen_at,r.last_seen_at,r.last_authoritative_observed_at,ra.access_status,ra.selected,ra.revoked_at from repositories r join repository_access ra on ra.repository_id=r.id and ra.tenant_id=r.tenant_id where r.tenant_id=$1 and ($2::uuid is null or ra.installation_id=$2) order by r.full_name asc", [tenantId, installationId ?? null]);
      return result.rows.map((row) => repositoryFromRow(row)).filter((row): row is RepositoryRecord => Boolean(row));
    });
  }

  async selectRepository(tenantId: string, repositoryId: string): Promise<RepositoryRecord | undefined> {
    return this.tenantQuery(tenantId, async (client) => {
      const current = await client.query<Row>("select r.id,r.tenant_id,ra.installation_id,r.github_repository_id,r.owner_login,r.name,r.full_name,r.private,r.visibility,r.node_id,r.github_created_at,r.github_updated_at,r.github_pushed_at,r.default_branch,r.description,r.archived_at,r.disabled,r.first_seen_at,r.last_seen_at,r.last_authoritative_observed_at,ra.access_status,ra.selected,ra.revoked_at from repositories r join repository_access ra on ra.repository_id=r.id and ra.tenant_id=r.tenant_id join github_installations gi on gi.id=ra.installation_id and gi.tenant_id=ra.tenant_id where r.tenant_id=$1 and r.id=$2 and gi.status='active' for update", [tenantId, repositoryId]);
      const row = current.rows[0];
      if (!row || !row.access_status || !repositoryAccessIsAvailable(row.access_status as RepositoryAccessStatus)) return undefined;
      await client.query("update repository_access ra set selected=false where ra.tenant_id=$1 and ra.selected=true and exists (select 1 from github_installations gi where gi.id=ra.installation_id and gi.tenant_id=ra.tenant_id and gi.status<>'active')", [tenantId]);
      const conflict = await client.query<Row>("select 1 from repository_access ra join github_installations gi on gi.id=ra.installation_id and gi.tenant_id=ra.tenant_id where ra.tenant_id=$1 and ra.selected=true and gi.status='active' and ra.repository_id<>$2 limit 1", [tenantId, repositoryId]);
      if (conflict.rows.length > 0) throw new RepositorySelectionError();
      await client.query("update repository_access set access_status='accessible',selected=true,selected_at=coalesce(selected_at,now()),revoked_at=null where tenant_id=$1 and repository_id=$2 and installation_id=$3", [tenantId, repositoryId, row.installation_id]);
      return repositoryFromRow({ ...row, access_status: "accessible", selected: true, revoked_at: null });
    });
  }

  async unselectRepository(tenantId: string, repositoryId: string): Promise<RepositoryRecord | undefined> {
    return this.tenantQuery(tenantId, async (client) => {
      const current = await client.query<Row>("select r.id,r.tenant_id,ra.installation_id,r.github_repository_id,r.owner_login,r.name,r.full_name,r.private,r.visibility,r.node_id,r.github_created_at,r.github_updated_at,r.github_pushed_at,r.default_branch,r.description,r.archived_at,r.disabled,r.first_seen_at,r.last_seen_at,r.last_authoritative_observed_at,ra.access_status,ra.selected,ra.revoked_at from repositories r join repository_access ra on ra.repository_id=r.id and ra.tenant_id=r.tenant_id join github_installations gi on gi.id=ra.installation_id and gi.tenant_id=ra.tenant_id where r.tenant_id=$1 and r.id=$2 and gi.status='active' for update", [tenantId, repositoryId]);
      const row = current.rows[0];
      if (!row) return undefined;
      if (row.access_status && !repositoryAccessIsAvailable(row.access_status as RepositoryAccessStatus)) {
        await client.query("update repository_access set selected=false where tenant_id=$1 and repository_id=$2 and installation_id=$3", [tenantId, repositoryId, row.installation_id]);
        return repositoryFromRow({ ...row, selected: false });
      }
      await client.query("update repository_access set access_status='accessible',selected=false where tenant_id=$1 and repository_id=$2 and installation_id=$3", [tenantId, repositoryId, row.installation_id]);
      return repositoryFromRow({ ...row, access_status: "accessible", selected: false });
    });
  }

  async reconcileInstallationInventory(input: { tenantId: string; githubInstallationId: number; repositories: RepositoryRecord[]; observedAt: Date }): Promise<InventoryReconcileResult> {
    return this.tenantQuery(input.tenantId, async (client) => {
      const installationResult = await client.query<Row>("select id,last_inventory_at from github_installations where tenant_id=$1 and github_installation_id=$2 and status='active' for update", [input.tenantId, input.githubInstallationId]);
      const installationId = installationResult.rows[0]?.id;
      if (!installationId) throw new Error("Installation is not active for inventory reconciliation");
      const lastInventoryAt = date(installationResult.rows[0]?.last_inventory_at);
      if (lastInventoryAt && lastInventoryAt >= input.observedAt) return emptyInventoryReconcileResult(input.repositories.length);
      const observed = new Map<number, RepositoryRecord>();
      for (const repository of input.repositories) observed.set(repository.githubRepositoryId, repository);
      let added = 0;
      let updated = 0;
      const projectionRelevantRepositoryIds: string[] = [];
      for (const repository of observed.values()) {
        const existingResult = await client.query<Row>("select r.id,r.owner_login,r.name,r.full_name,r.private,r.visibility,r.archived_at,r.github_created_at,r.first_seen_at,(select max(nh.valid_to) from repository_name_history nh where nh.tenant_id=r.tenant_id and nh.repository_id=r.id) as last_name_changed_at,ra.access_status,ra.selected from repositories r left join repository_access ra on ra.repository_id=r.id and ra.installation_id=$3 and ra.tenant_id=r.tenant_id where r.tenant_id=$1 and r.github_repository_id=$2 for update of r", [input.tenantId, repository.githubRepositoryId, installationId]);
        const existing = existingResult.rows[0];
        const repositoryId = String(existing?.id ?? repository.id);
        const wasSelected = existing?.selected === true;
        const archived = repository.archived ?? Boolean(date(existing?.archived_at));
        const archivedAt = archived ? date(existing?.archived_at) ?? input.observedAt : undefined;
        if (existing && repositoryProjectionInputsChanged(
          { ownerLogin: String(existing.owner_login), name: String(existing.name), fullName: String(existing.full_name), private: Boolean(existing.private), ...(existing.visibility ? { visibility: String(existing.visibility) } : {}), ...(date(existing.archived_at) ? { archivedAt: date(existing.archived_at) } : {}), ...(date(existing.github_created_at) ? { githubCreatedAt: date(existing.github_created_at) } : {}) },
          { ownerLogin: repository.ownerLogin, name: repository.name, fullName: repository.fullName, private: repository.private, ...(repository.visibility ? { visibility: repository.visibility } : {}), ...(archivedAt ? { archivedAt } : {}), ...(repository.githubCreatedAt ?? date(existing.github_created_at) ? { githubCreatedAt: repository.githubCreatedAt ?? date(existing.github_created_at) } : {}) },
        )) projectionRelevantRepositoryIds.push(repositoryId);
        if (existing && (existing.owner_login !== repository.ownerLogin || existing.name !== repository.name || existing.full_name !== repository.fullName)) {
          await client.query("insert into repository_name_history (id,tenant_id,repository_id,owner_login,name,full_name,valid_from,valid_to) values ($1,$2,$3,$4,$5,$6,coalesce($7::timestamptz,$8::timestamptz,$9::timestamptz),$9::timestamptz)", [createId(), input.tenantId, repositoryId, existing.owner_login, existing.name, existing.full_name, existing.last_name_changed_at, existing.first_seen_at, input.observedAt]);
        }
        await client.query(`insert into repositories (id,tenant_id,github_repository_id,node_id,owner_login,name,full_name,private,visibility,default_branch,description,archived_at,disabled,github_created_at,github_updated_at,github_pushed_at,first_seen_at,last_seen_at,last_authoritative_observed_at,created_at,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now(),now()) on conflict (tenant_id,github_repository_id) do update set node_id=coalesce(excluded.node_id,repositories.node_id),owner_login=excluded.owner_login,name=excluded.name,full_name=excluded.full_name,private=excluded.private,visibility=excluded.visibility,default_branch=excluded.default_branch,description=excluded.description,archived_at=case when excluded.archived_at is null then null else coalesce(repositories.archived_at, excluded.archived_at) end,disabled=excluded.disabled,github_created_at=coalesce(excluded.github_created_at,repositories.github_created_at),github_updated_at=coalesce(excluded.github_updated_at,repositories.github_updated_at),github_pushed_at=coalesce(excluded.github_pushed_at,repositories.github_pushed_at),last_seen_at=excluded.last_seen_at,last_authoritative_observed_at=excluded.last_authoritative_observed_at,updated_at=now()`, [repositoryId, input.tenantId, repository.githubRepositoryId, repository.nodeId ?? null, repository.ownerLogin, repository.name, repository.fullName, repository.private, repository.visibility ?? null, repository.defaultBranch, repository.description ?? null, archivedAt ?? null, repository.disabled ?? false, repository.githubCreatedAt ?? null, repository.githubUpdatedAt ?? null, repository.githubPushedAt ?? null, existing?.first_seen_at ?? repository.firstSeenAt ?? input.observedAt, input.observedAt, input.observedAt]);
        await client.query("insert into repository_access (id,tenant_id,repository_id,installation_id,access_status,selected,selected_at,revoked_at,last_seen_at,last_authoritative_observed_at) values ($1,$2,$3,$4,'accessible',$5,$6,null,$7,$7) on conflict (tenant_id,repository_id,installation_id) do update set access_status='accessible',selected=repository_access.selected or $5,selected_at=case when repository_access.selected or $5 then coalesce(repository_access.selected_at,$6) else repository_access.selected_at end,revoked_at=null,last_seen_at=$7,last_authoritative_observed_at=$7", [createId(), input.tenantId, repositoryId, installationId, wasSelected, wasSelected ? input.observedAt : null, input.observedAt]);
        if (existing) updated += 1; else added += 1;
      }
      const ids = [...observed.keys()];
      const absent = await client.query<Row>("update repository_access ra set access_status='access_removed',selected=false,revoked_at=$3 where ra.tenant_id=$1 and ra.installation_id=$2 and ra.access_status in ('accessible','installation_suspended','unavailable') and not (ra.repository_id in (select r.id from repositories r where r.tenant_id=$1 and r.github_repository_id=any($4::bigint[]))) returning ra.id", [input.tenantId, installationId, input.observedAt, ids]);
      await client.query("update github_installations set last_inventory_at=$3,updated_at=now() where tenant_id=$1 and id=$2", [input.tenantId, installationId, input.observedAt]);
      return { observed: observed.size, added, updated, removed: absent.rowCount ?? 0, projectionRelevantRepositoryIds };
    });
  }

  async updateInstallationLifecycle(githubInstallationId: number, status: InstallationLifecycleStatus, now: Date): Promise<void> {
    const route = await this.pool.query<Row>("select tenant_id from installation_routes where github_installation_id=$1", [githubInstallationId]);
    const tenantId = route.rows[0]?.tenant_id;
    if (!tenantId) return;
    await this.tenantQuery(String(tenantId), async (client) => {
      if (status === "suspended") {
        await client.query("update github_installations set status='suspended',suspended_at=$2::timestamptz,deleted_at=null,updated_at=now() where tenant_id=$1 and github_installation_id=$3", [tenantId, now, githubInstallationId]);
      } else if (status === "active") {
        await client.query("update github_installations set status='active',suspended_at=null,deleted_at=null,updated_at=now() where tenant_id=$1 and github_installation_id=$2", [tenantId, githubInstallationId]);
      } else {
        await client.query("update github_installations set status=$2::varchar,suspended_at=null,deleted_at=$3::timestamptz,updated_at=now() where tenant_id=$1 and github_installation_id=$4", [tenantId, status, now, githubInstallationId]);
      }
      const accessStatus = status === "suspended" ? "installation_suspended" : status === "active" ? "unavailable" : "disconnected";
      if (status === "active") await client.query("update repository_access set access_status='unavailable',selected=false where tenant_id=$1 and installation_id=(select id from github_installations where tenant_id=$1 and github_installation_id=$2)", [tenantId, githubInstallationId]);
      else await client.query("update repository_access set access_status=$2,selected=false,revoked_at=$3 where tenant_id=$1 and installation_id=(select id from github_installations where tenant_id=$1 and github_installation_id=$4)", [tenantId, accessStatus, now, githubInstallationId]);
    });
  }

  async insertDelivery(input: Omit<DeliveryRecord, "id" | "state" | "firstReceivedAt" | "lastReceivedAt" | "receiptCount" | "processingAttempts"> & { now: Date }): Promise<DeliveryInsertResult> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      if (input.tenantId) await client.query("select set_config('app.tenant_id', $1, true)", [input.tenantId]);
      const existingResult = await client.query<Row>("select * from webhook_deliveries where github_delivery_guid=$1 for update", [input.guid]);
      const existing = deliveryFromRow(existingResult.rows[0]);
      if (existing) {
        await client.query("update webhook_deliveries set last_received_at=$2,receipt_count=receipt_count+1 where id=$1", [existing.id, input.now]);
        await client.query("commit");
        return { record: { ...existing, lastReceivedAt: input.now, receiptCount: existing.receiptCount + 1 }, created: false, action: deliveryRedeliveryAction(existing.state) };
      }
      const id = createId();
      await client.query(`insert into webhook_deliveries (id,tenant_id,github_delivery_guid,event_name,action,installation_github_id,repository_github_id,ref,before_sha,after_sha,forced,payload_ciphertext,first_received_at,last_received_at,receipt_count,state,processing_attempts,payload_expires_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,1,'received',0,$14)`, [id, input.tenantId ?? null, input.guid, input.eventName, input.action ?? null, input.installationGithubId ?? null, input.repositoryGithubId ?? null, input.ref ?? null, input.before ?? null, input.after ?? null, input.forced ?? null, input.payloadCiphertext ?? null, input.now, input.payloadExpiresAt]);
      await client.query("commit");
      const record: DeliveryRecord = { ...input, id, state: "received", firstReceivedAt: input.now, lastReceivedAt: input.now, receiptCount: 1, processingAttempts: 0 };
      return { record, created: true, action: "ensure_job" };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordUnroutedWebhook(record: { guid: string; eventName: string; payloadCiphertext: string; receivedAt: Date; payloadExpiresAt: Date }): Promise<void> {
    await this.pool.query("insert into unrouted_webhook_deliveries (id,github_delivery_guid,event_name,payload_ciphertext,received_at,payload_expires_at) values ($1,$2,$3,$4,$5,$6) on conflict (github_delivery_guid) do nothing", [createId(), record.guid, record.eventName, record.payloadCiphertext, record.receivedAt, record.payloadExpiresAt]);
  }

  async updateDelivery(id: string, patch: Partial<DeliveryRecord>, tenantId?: string): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown) => { fields.push(`${column}=$${values.length + 1}`); values.push(value); };
    if (patch.state !== undefined) add("state", patch.state);
    if (patch.processingAttempts !== undefined) add("processing_attempts", patch.processingAttempts);
    if (patch.jobId !== undefined) add("job_id", patch.jobId);
    if (patch.errorCode !== undefined) add("sanitized_error_code", patch.errorCode);
    if (patch.processedAt !== undefined) add("processed_at", patch.processedAt);
    if (patch.tenantId !== undefined) add("tenant_id", patch.tenantId);
    if (fields.length) {
      const query = `update webhook_deliveries set ${fields.join(",")} where id=$${values.length + 1}`;
      if (tenantId) await this.tenantQuery(tenantId, async (client) => { await client.query(query, [...values, id]); });
      else await this.pool.query(query, [...values, id]);
    }
  }

  async getDelivery(id: string, tenantId?: string): Promise<DeliveryRecord | undefined> {
    if (tenantId) return this.tenantQuery(tenantId, async (client) => deliveryFromRow((await client.query<Row>("select * from webhook_deliveries where id=$1", [id])).rows[0]));
    const result = await this.pool.query<Row>("select * from webhook_deliveries where id=$1", [id]);
    return deliveryFromRow(result.rows[0]);
  }

  async getDeliveryByGuid(guid: string, tenantId: string): Promise<DeliveryRecord | undefined> {
    return this.tenantQuery(tenantId, async (client) => deliveryFromRow((await client.query<Row>("select * from webhook_deliveries where github_delivery_guid=$1", [guid])).rows[0]));
  }

  async claimDeliveryForProcessing(id: string, tenantId?: string): Promise<DeliveryRecord | undefined> {
    const run = async (client: PoolClient) => deliveryFromRow((await client.query<Row>("update webhook_deliveries set state='processing',processing_attempts=processing_attempts+1 where id=$1 and state not in ('processed','ignored') returning *", [id])).rows[0]);
    if (tenantId) return this.tenantQuery(tenantId, run);
    const result = await this.pool.query<Row>("update webhook_deliveries set state='processing',processing_attempts=processing_attempts+1 where id=$1 and state not in ('processed','ignored') returning *", [id]);
    return deliveryFromRow(result.rows[0]);
  }

  async ensureJob(logicalKey: string, payload: Record<string, unknown>): Promise<string> {
    const run = async (client: PoolClient) => {
      const inserted = await client.query<Row>("insert into sync_jobs (id,tenant_id,kind,logical_key,payload,scheduled_at) values ($1,$2,$3,$4,$5,now()) on conflict (logical_key) do nothing returning id", [createId(), String(payload.tenantId), String(payload.kind ?? "webhook_delivery"), logicalKey, payload]);
      if (inserted.rows[0]?.id) return String(inserted.rows[0].id);
      const existing = await client.query<Row>("select id from sync_jobs where logical_key=$1", [logicalKey]);
      const existingId = existing.rows[0]?.id;
      if (!existingId) throw new Error("Durable job disappeared after logical-key conflict");
      return String(existingId);
    };
    if (!payload.tenantId) throw new Error("Tenant is required for durable jobs");
    return this.tenantQuery(String(payload.tenantId), run);
  }

  async setBranchHead(tenantId: string, repositoryId: string, ref: string, headSha: string | null): Promise<void> {
    const name = branchName(ref);
    await this.tenantQuery(tenantId, async (client) => {
      await client.query(`insert into branches (id,tenant_id,repository_id,name,head_sha,last_seen_at,reachable) values ($1,$2,$3,$4,$5,now(),$6) on conflict (tenant_id,repository_id,name) do update set head_sha=excluded.head_sha,last_seen_at=now(),reachable=excluded.reachable,deleted_at=case when excluded.head_sha is null then now() else null end`, [createId(), tenantId, repositoryId, name, headSha, headSha !== null]);
    });
  }

  async getBranchHead(tenantId: string, repositoryId: string, ref: string): Promise<string | null> {
    const name = branchName(ref);
    return this.tenantQuery(tenantId, async (client) => {
      const result = await client.query<Row>("select head_sha from branches where tenant_id=$1 and repository_id=$2 and name=$3", [tenantId, repositoryId, name]);
      return result.rows[0]?.head_sha ? String(result.rows[0].head_sha) : null;
    });
  }

  async finalizeRefSync(input: { tenantId: string; repositoryId: string; ref: string; expectedHead: string | null; headSha: string | null; invalidatePrevious: boolean; reachableShas: string[] }): Promise<boolean> {
    const name = branchName(input.ref);
    return this.tenantQuery(input.tenantId, async (client) => {
      // Serialize publications for one tenant/repository/ref and make the
      // compare-and-set decision in the same transaction as reachability.
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`${input.tenantId}:${input.repositoryId}:${name}`]);
      const existing = await client.query<Row>("select id,head_sha from branches where tenant_id=$1 and repository_id=$2 and name=$3 for update", [input.tenantId, input.repositoryId, name]);
      const current = existing.rows[0]?.head_sha ? String(existing.rows[0].head_sha) : null;
      if (existing.rows.length > 0 && current !== input.expectedHead) return false;
      if (existing.rows.length === 0 && input.expectedHead !== null) return false;

      let branchId: string;
      if (existing.rows[0]?.id) {
        branchId = String(existing.rows[0].id);
        await client.query("update branches set head_sha=$4,last_seen_at=now(),reachable=$5,deleted_at=case when $4 is null then now() else null end where tenant_id=$1 and repository_id=$2 and name=$3", [input.tenantId, input.repositoryId, name, input.headSha, input.headSha !== null]);
      } else {
        const inserted = await client.query<Row>("insert into branches (id,tenant_id,repository_id,name,head_sha,last_seen_at,reachable) values ($1,$2,$3,$4,$5,now(),$6) returning id", [createId(), input.tenantId, input.repositoryId, name, input.headSha, input.headSha !== null]);
        branchId = String(inserted.rows[0]?.id);
      }
      if (input.invalidatePrevious) await client.query("update commit_refs set reachable=false where tenant_id=$1 and branch_id=$2", [input.tenantId, branchId]);
      if (input.reachableShas.length > 0) {
        await client.query("insert into commit_refs (tenant_id,commit_id,branch_id,last_seen_at,reachable) select $1,c.id,$2,now(),true from commits c where c.tenant_id=$1 and c.repository_id=$3 and c.sha=any($4::text[]) on conflict (tenant_id,commit_id,branch_id) do update set last_seen_at=now(),reachable=true", [input.tenantId, branchId, input.repositoryId, input.reachableShas]);
      }
      await client.query("delete from sync_cursors where tenant_id=$1 and repository_id=$2 and resource_type='commit_ref' and ref_name=$3", [input.tenantId, input.repositoryId, name]);
      return true;
    });
  }

  async saveCommit(tenantId: string, repositoryId: string, commit: CommitFact, htmlUrl?: string): Promise<void> {
    await this.tenantQuery(tenantId, async (client) => {
      await this.writeCommit(client, tenantId, repositoryId, commit, htmlUrl, true);
    });
  }

  private async writeCommit(client: PoolClient, tenantId: string, repositoryId: string, commit: CommitFact, htmlUrl?: string, allowLegacyStats = false): Promise<void> {
    const authorId = commit.author ? await this.ensureGithubAccount(client, commit.author.githubAccountId, commit.author.login, commit.author.accountType ?? "User", commit.author.actorKind) : undefined;
    const committerId = commit.committer ? await this.ensureGithubAccount(client, commit.committer.githubAccountId, commit.committer.login, commit.committer.accountType ?? "User", commit.committer.actorKind) : undefined;
    await client.query(`insert into commits (id,tenant_id,repository_id,sha,author_github_account_id,committer_github_account_id,message,authored_at,committed_at,parent_shas,verified,additions,deletions,html_url,first_seen_at,last_seen_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),now()) on conflict (tenant_id,repository_id,sha) do update set author_github_account_id=coalesce(excluded.author_github_account_id,commits.author_github_account_id),committer_github_account_id=coalesce(excluded.committer_github_account_id,commits.committer_github_account_id),message=case when excluded.message <> '' then excluded.message else commits.message end,authored_at=coalesce(excluded.authored_at,commits.authored_at),committed_at=coalesce(excluded.committed_at,commits.committed_at),parent_shas=case when jsonb_array_length(excluded.parent_shas) > 0 then excluded.parent_shas else commits.parent_shas end,verified=coalesce(excluded.verified,commits.verified),additions=case when $15 then coalesce(excluded.additions,commits.additions) else commits.additions end,deletions=case when $15 then coalesce(excluded.deletions,commits.deletions) else commits.deletions end,html_url=coalesce(excluded.html_url,commits.html_url),last_seen_at=now()`, [createId(), tenantId, repositoryId, commit.sha, authorId ?? null, committerId ?? null, commit.message, commit.authoredAt ?? null, commit.committedAt ?? null, JSON.stringify(commit.parents), commit.verified ?? null, allowLegacyStats ? commit.additions ?? null : null, allowLegacyStats ? commit.deletions ?? null : null, htmlUrl ?? commit.htmlUrl ?? null, allowLegacyStats]);
  }

  private async writeDevelopmentEvent(client: PoolClient, tenantId: string, repositoryId: string, event: DevelopmentEvent, actorId?: string, htmlUrl?: string, message?: string): Promise<void> {
    const logicalEventKey = event.logicalEventKey ?? canonicalLogicalEventKey(tenantId, event);
    await client.query(`insert into development_events (id,tenant_id,repository_id,source_system,source_kind,source_external_id,event_type,verb,actor_github_account_id,actor_kind,contribution_role,context_kind,occurred_at,source_updated_at,title,summary_input,source_url,completeness_state,visibility,attribution_confidence,projection_version,logical_event_key) values ($1,$2,$3,'github',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) on conflict (logical_event_key) do update set event_type=excluded.event_type,verb=excluded.verb,actor_github_account_id=excluded.actor_github_account_id,actor_kind=excluded.actor_kind,contribution_role=excluded.contribution_role,context_kind=excluded.context_kind,occurred_at=excluded.occurred_at,source_updated_at=excluded.source_updated_at,title=excluded.title,summary_input=excluded.summary_input,source_url=excluded.source_url,completeness_state=excluded.completeness_state,visibility=excluded.visibility,attribution_confidence=excluded.attribution_confidence,projection_version=excluded.projection_version`, [event.id || createId(), tenantId, repositoryId, event.sourceKind, event.sourceExternalId, event.eventType, event.verb, actorId ?? null, event.actorKind, event.contributionRole, event.contextKind, event.occurredAt, event.sourceUpdatedAt ?? null, event.title ?? null, event.summaryInput ?? message ?? null, htmlUrl ?? event.sourceUrl ?? null, event.completenessState, event.visibility, event.attributionConfidence, event.projectionVersion, logicalEventKey]);
  }

  async saveDevelopmentEvent(tenantId: string, repositoryId: string, event: DevelopmentEvent, options?: { htmlUrl?: string; message?: string }): Promise<void> {
    await this.tenantQuery(tenantId, async (client) => {
      const actorId = event.actorGithubAccountId === undefined ? undefined : await this.ensureGithubAccount(client, event.actorGithubAccountId, undefined, event.actorKind === "bot" ? "Bot" : "User", event.actorKind);
      await this.writeDevelopmentEvent(client, tenantId, repositoryId, event, actorId, options?.htmlUrl, options?.message);
    });
  }

  async getRefSyncContinuation(tenantId: string, repositoryId: string, ref: string): Promise<RefSyncContinuation | undefined> {
    const name = branchName(ref);
    return this.tenantQuery(tenantId, async (client) => {
      const result = await client.query<Row>("select cursor from sync_cursors where tenant_id=$1 and repository_id=$2 and resource_type='commit_ref' and ref_name=$3", [tenantId, repositoryId, name]);
      const cursor = result.rows[0]?.cursor;
      if (!cursor || typeof cursor !== "object") return undefined;
      const value = cursor as Record<string, unknown>;
      if (typeof value.after !== "string" || typeof value.nextPage !== "number" || typeof value.forced !== "boolean") return undefined;
      return { after: value.after, previousHead: typeof value.previousHead === "string" ? value.previousHead : null, nextPage: value.nextPage, forced: value.forced, reachableShas: Array.isArray(value.reachableShas) ? value.reachableShas.filter((sha): sha is string => typeof sha === "string") : [] };
    });
  }

  async setRefSyncContinuation(tenantId: string, repositoryId: string, ref: string, continuation: RefSyncContinuation): Promise<void> {
    const name = branchName(ref);
    await this.tenantQuery(tenantId, async (client) => {
      await client.query(`insert into sync_cursors (id,tenant_id,repository_id,resource_type,ref_name,cursor,schema_version) values ($1,$2,$3,'commit_ref',$4,$5,1) on conflict (tenant_id,repository_id,resource_type,ref_name) do update set cursor=excluded.cursor,schema_version=excluded.schema_version`, [createId(), tenantId, repositoryId, name, continuation]);
    });
  }

  async clearRefSyncContinuation(tenantId: string, repositoryId: string, ref: string): Promise<void> {
    await this.tenantQuery(tenantId, async (client) => { await client.query("delete from sync_cursors where tenant_id=$1 and repository_id=$2 and resource_type='commit_ref' and ref_name=$3", [tenantId, repositoryId, branchName(ref)]); });
  }

  async markBranchCommitsUnreachable(tenantId: string, repositoryId: string, ref: string): Promise<void> {
    await this.tenantQuery(tenantId, async (client) => {
      await client.query("update commit_refs cr set reachable=false from branches b where b.id=cr.branch_id and cr.tenant_id=$1 and b.tenant_id=$1 and b.repository_id=$2 and b.name=$3", [tenantId, repositoryId, branchName(ref)]);
    });
  }

  async setCommitReachability(tenantId: string, repositoryId: string, ref: string, sha: string, reachable: boolean): Promise<void> {
    const name = branchName(ref);
    await this.tenantQuery(tenantId, async (client) => {
      await client.query("insert into branches (id,tenant_id,repository_id,name,last_seen_at,reachable) values ($1,$2,$3,$4,now(),true) on conflict (tenant_id,repository_id,name) do update set last_seen_at=now()", [createId(), tenantId, repositoryId, name]);
      const branch = await client.query<Row>("select id from branches where tenant_id=$1 and repository_id=$2 and name=$3", [tenantId, repositoryId, name]);
      const commit = await client.query<Row>("select id from commits where tenant_id=$1 and repository_id=$2 and sha=$3", [tenantId, repositoryId, sha]);
      const branchId = branch.rows[0]?.id;
      const commitId = commit.rows[0]?.id;
      if (branchId && commitId) await client.query("insert into commit_refs (tenant_id,commit_id,branch_id,last_seen_at,reachable) values ($1,$2,$3,now(),$4) on conflict (tenant_id,commit_id,branch_id) do update set last_seen_at=now(),reachable=excluded.reachable", [tenantId, commitId, branchId, reachable]);
    });
  }

  private async historicalGate(client: PoolClient, tenantId: string, repositoryId: string, installationId: string, now: Date): Promise<boolean> {
    const result = await client.query(
      `select 1
         from github_installations i
         join repository_access ra on ra.tenant_id=i.tenant_id and ra.installation_id=i.id
        where i.tenant_id=$1 and i.id=$3 and i.status='active'
          and (i.api_paused_until is null or i.api_paused_until <= $4)
          and ra.repository_id=$2 and ra.selected=true and ra.access_status='accessible'
        limit 1`,
      [tenantId, repositoryId, installationId, now],
    );
    return result.rowCount === 1;
  }

  async startHistoricalBackfill(input: { tenantId: string; repositoryId: string; installationId: string; defaultBranch: string; now: Date }): Promise<HistoricalProgress> {
    return this.tenantQuery(input.tenantId, async (client) => {
      if (!await this.historicalGate(client, input.tenantId, input.repositoryId, input.installationId, input.now)) throw new Error("historical_backfill_gated");
      for (const stage of HISTORICAL_STAGES) {
        const refName = stage === "default_branch_commits" ? branchName(input.defaultBranch) : "";
        const first = stage === "default_branch_commits";
        await client.query(
          `insert into sync_cursors (id,tenant_id,repository_id,resource_type,ref_name,cursor,status,started_at,completeness_state,schema_version)
           values ($1,$2,$3,$4,$5,$6,$7,$8,'known_unknown',3)
           on conflict (tenant_id,repository_id,resource_type,ref_name) do nothing`,
          [createId(), input.tenantId, input.repositoryId, stage, refName, { nextPage: 1 }, first ? "in_progress" : "pending", first ? input.now : null],
        );
      }
      const result = await client.query<Row>("select * from sync_cursors where tenant_id=$1 and repository_id=$2 and resource_type='default_branch_commits' and ref_name=$3", [input.tenantId, input.repositoryId, branchName(input.defaultBranch)]);
      const progress = historicalProgressFromRow(result.rows[0]);
      if (!progress) throw new Error("historical_progress_missing");
      return progress;
    });
  }

  async startRepositoryReconciliation(input: { tenantId: string; repositoryId: string; installationId: string; defaultBranch: string; reconciliationRunId: string; now: Date }): Promise<HistoricalProgress | undefined> {
    return this.tenantQuery(input.tenantId, async (client) => {
      if (!await this.historicalGate(client, input.tenantId, input.repositoryId, input.installationId, input.now)) return undefined;
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`m5:${input.tenantId}:${input.repositoryId}`]);
      const known = reconciliationGenerationFromRow((await client.query<Row>(
        "select * from reconciliation_generations where tenant_id=$1 and repository_id=$2 and reconciliation_run_id=$3 for update",
        [input.tenantId, input.repositoryId, input.reconciliationRunId],
      )).rows[0]);
      if (known && !known.current) return undefined;
      if (known?.current) {
        const existing = await client.query<Row>(
          "select * from sync_cursors where tenant_id=$1 and repository_id=$2 and cursor->>'reconciliationRunId'=$3 order by case status when 'in_progress' then 0 when 'paused' then 1 when 'completed' then 2 else 3 end,case resource_type when 'completed' then 0 else 1 end,started_at nulls last limit 1",
          [input.tenantId, input.repositoryId, input.reconciliationRunId],
        );
        return historicalProgressFromRow(existing.rows[0]);
      }

      await client.query(
        "update reconciliation_generations set current=false, superseded_at=$3 where tenant_id=$1 and repository_id=$2 and current=true",
        [input.tenantId, input.repositoryId, input.now],
      );
      const nextGeneration = Number((await client.query<{ generation: string | number }>(
        "select coalesce(max(generation), 0) + 1 as generation from reconciliation_generations where tenant_id=$1 and repository_id=$2",
        [input.tenantId, input.repositoryId],
      )).rows[0]?.generation ?? 1);
      await client.query(
        "insert into reconciliation_generations (id,tenant_id,repository_id,reconciliation_run_id,generation,current,started_at) values ($1,$2,$3,$4,$5,true,$6)",
        [createId(), input.tenantId, input.repositoryId, input.reconciliationRunId, nextGeneration, input.now],
      );

      const defaultBranch = branchName(input.defaultBranch);
      await client.query("delete from sync_cursors where tenant_id=$1 and repository_id=$2 and resource_type='default_branch_commits' and ref_name<>$3", [input.tenantId, input.repositoryId, defaultBranch]);
      for (const stage of HISTORICAL_STAGES) {
        const refName = stage === "default_branch_commits" ? defaultBranch : "";
        const first = stage === "default_branch_commits";
        await client.query(
          `insert into sync_cursors (id,tenant_id,repository_id,resource_type,ref_name,cursor,status,started_at,completed_at,paused_until,error_code,high_water_at,last_success_at,last_full_reconcile_at,head_sha,completeness_state,schema_version)
           values ($1,$2,$3,$4,$5,$6,$7,$8,null,null,null,null,null,null,null,'known_unknown',3)
           on conflict (tenant_id,repository_id,resource_type,ref_name) do update set
             cursor=excluded.cursor,status=excluded.status,started_at=excluded.started_at,completed_at=null,
             paused_until=null,error_code=null,high_water_at=null,last_success_at=null,head_sha=null,
             completeness_state='known_unknown',schema_version=3`,
          [createId(), input.tenantId, input.repositoryId, stage, refName, { nextPage: 1, reconciliationRunId: input.reconciliationRunId }, first ? "in_progress" : "pending", first ? input.now : null],
        );
      }
      const result = await client.query<Row>("select * from sync_cursors where tenant_id=$1 and repository_id=$2 and resource_type='default_branch_commits' and ref_name=$3", [input.tenantId, input.repositoryId, defaultBranch]);
      return historicalProgressFromRow(result.rows[0]);
    });
  }

  async getRepositoryReconciliationGeneration(tenantId: string, repositoryId: string, reconciliationRunId: string): Promise<ReconciliationGeneration | undefined> {
    return this.tenantQuery(tenantId, async (client) => reconciliationGenerationFromRow((await client.query<Row>(
      "select * from reconciliation_generations where tenant_id=$1 and repository_id=$2 and reconciliation_run_id=$3",
      [tenantId, repositoryId, reconciliationRunId],
    )).rows[0]));
  }

  async getCurrentRepositoryReconciliationGeneration(tenantId: string, repositoryId: string): Promise<ReconciliationGeneration | undefined> {
    return this.tenantQuery(tenantId, async (client) => reconciliationGenerationFromRow((await client.query<Row>(
      "select * from reconciliation_generations where tenant_id=$1 and repository_id=$2 and current=true",
      [tenantId, repositoryId],
    )).rows[0]));
  }

  async getHistoricalProgress(tenantId: string, repositoryId: string, stage: HistoricalStage, refName = ""): Promise<HistoricalProgress | undefined> {
    return this.tenantQuery(tenantId, async (client) => historicalProgressFromRow((await client.query<Row>("select * from sync_cursors where tenant_id=$1 and repository_id=$2 and resource_type=$3 and ref_name=$4", [tenantId, repositoryId, stage, stage === "default_branch_commits" ? branchName(refName) : refName])).rows[0]));
  }

  async listHistoricalProgress(tenantId: string, repositoryId: string): Promise<HistoricalProgress[]> {
    return this.tenantQuery(tenantId, async (client) => {
      const result = await client.query<Row>("select * from sync_cursors where tenant_id=$1 and repository_id=$2 and resource_type=any($3::text[])", [tenantId, repositoryId, HISTORICAL_STAGES]);
      return result.rows.map(historicalProgressFromRow).filter((value): value is HistoricalProgress => Boolean(value)).sort((left, right) => HISTORICAL_STAGES.indexOf(left.stage) - HISTORICAL_STAGES.indexOf(right.stage));
    });
  }

  async resetCommitTraversal(input: { tenantId: string; repositoryId: string; installationId: string; refName: string; anchorHeadSha: string; now: Date; expectedReconciliationRunId?: string }): Promise<HistoricalProgress | undefined> {
    const refName = branchName(input.refName);
    return this.tenantQuery(input.tenantId, async (client) => {
      if (!await this.historicalGate(client, input.tenantId, input.repositoryId, input.installationId, input.now)) return undefined;
      if (input.expectedReconciliationRunId) await client.query("select pg_advisory_xact_lock(hashtext($1))", [`m5:${input.tenantId}:${input.repositoryId}`]);
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`m3:${input.tenantId}:${input.repositoryId}:${refName}`]);
      const cursorRow = await client.query<Row>("select cursor from sync_cursors where tenant_id=$1 and repository_id=$2 and resource_type='default_branch_commits' and ref_name=$3", [input.tenantId, input.repositoryId, refName]);
      const currentCursor = cursorRow.rows[0]?.cursor && typeof cursorRow.rows[0].cursor === "object" ? cursorRow.rows[0].cursor as Record<string, unknown> : {};
      const reconciliationRunId = typeof currentCursor.reconciliationRunId === "string" ? currentCursor.reconciliationRunId : undefined;
      if (input.expectedReconciliationRunId) {
        const current = reconciliationGenerationFromRow((await client.query<Row>(
          "select * from reconciliation_generations where tenant_id=$1 and repository_id=$2 and current=true",
          [input.tenantId, input.repositoryId],
        )).rows[0]);
        if (reconciliationRunId !== input.expectedReconciliationRunId || current?.reconciliationRunId !== input.expectedReconciliationRunId) return undefined;
      }
      const branch = await client.query<Row>("select id,head_sha from branches where tenant_id=$1 and repository_id=$2 and name=$3 for update", [input.tenantId, input.repositoryId, refName]);
      const previousHead = branch.rows[0]?.head_sha ? String(branch.rows[0].head_sha) : null;
      if (branch.rows[0]?.id) await client.query("update commit_refs set reachable=false where tenant_id=$1 and branch_id=$2", [input.tenantId, branch.rows[0].id]);
      const result = await client.query<Row>(
        `insert into sync_cursors (id,tenant_id,repository_id,resource_type,ref_name,head_sha,cursor,status,started_at,completed_at,paused_until,error_code,high_water_at,last_success_at,completeness_state,schema_version)
         values ($1,$2,$3,'default_branch_commits',$4,$5,$6,'in_progress',$7,null,null,null,null,null,'known_unknown',3)
         on conflict (tenant_id,repository_id,resource_type,ref_name) do update set
           head_sha=excluded.head_sha,cursor=excluded.cursor,status='in_progress',started_at=excluded.started_at,
           completed_at=null,paused_until=null,error_code=null,high_water_at=null,last_success_at=null,
           completeness_state='known_unknown',schema_version=3
         returning *`,
        [createId(), input.tenantId, input.repositoryId, refName, input.anchorHeadSha, { nextPage: 1, previousHead, ...(reconciliationRunId ? { reconciliationRunId } : {}) }, input.now],
      );
      return historicalProgressFromRow(result.rows[0]);
    });
  }

  async commitHistoricalPage(input: HistoricalPageCommit): Promise<HistoricalPageCommitResult> {
    const refName = input.stage === "default_branch_commits" ? branchName(input.refName) : "";
    const expectedRunId = typeof input.expectedCursor.reconciliationRunId === "string" ? input.expectedCursor.reconciliationRunId : undefined;
    return this.tenantQuery(input.tenantId, async (client) => {
      if (expectedRunId) await client.query("select pg_advisory_xact_lock(hashtext($1))", [`m5:${input.tenantId}:${input.repositoryId}`]);
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`m3:${input.tenantId}:${input.repositoryId}:${input.stage}:${refName}`]);
      const rowResult = await client.query<Row>("select * from sync_cursors where tenant_id=$1 and repository_id=$2 and resource_type=$3 and ref_name=$4 for update", [input.tenantId, input.repositoryId, input.stage, refName]);
      const progress = historicalProgressFromRow(rowResult.rows[0]);
      if (!progress) throw new Error("historical_progress_missing");
      if (!await this.historicalGate(client, input.tenantId, input.repositoryId, input.installationId, input.observedAt) || progress.status === "paused") return { applied: false, reason: "gated", progress };
      if (expectedRunId) {
        const current = reconciliationGenerationFromRow((await client.query<Row>(
          "select * from reconciliation_generations where tenant_id=$1 and repository_id=$2 and current=true",
          [input.tenantId, input.repositoryId],
        )).rows[0]);
        if (current?.reconciliationRunId !== expectedRunId) return { applied: false, reason: "checkpoint_mismatch", progress };
      }
      const match = await client.query<{ matches: boolean }>("select $1::jsonb = $2::jsonb as matches", [progress.cursor, input.expectedCursor]);
      if (!match.rows[0]?.matches || progress.status === "completed") return { applied: false, reason: "checkpoint_mismatch", progress };
      const generation = progress.startedAt ?? input.observedAt;

      if (input.stage === "default_branch_commits") {
        if (progress.anchorHeadSha && progress.anchorHeadSha !== input.anchorHeadSha) return { applied: false, reason: "checkpoint_mismatch", progress };
        let branchId: string | undefined;
        if (input.finalPage) {
          const branchResult = await client.query<Row>("select id,head_sha from branches where tenant_id=$1 and repository_id=$2 and name=$3 for update", [input.tenantId, input.repositoryId, refName]);
          const publishedHead = branchResult.rows[0]?.head_sha ? String(branchResult.rows[0].head_sha) : null;
          const expectedPublishedHead = typeof progress.cursor.previousHead === "string" ? progress.cursor.previousHead : null;
          if (publishedHead !== expectedPublishedHead && publishedHead !== input.anchorHeadSha) return { applied: false, reason: "checkpoint_mismatch", progress };
          branchId = branchResult.rows[0]?.id ? String(branchResult.rows[0].id) : undefined;
        }
        for (const fact of input.facts) await this.writeCommit(client, input.tenantId, input.repositoryId, fact.commit, fact.htmlUrl, false);
        const shas = input.facts.map((fact) => fact.commit.sha);
        if (!branchId) {
          const branchResult = await client.query<Row>(
            `insert into branches (id,tenant_id,repository_id,name,reachable,first_seen_at,last_seen_at)
             values ($1,$2,$3,$4,true,$5,$5)
             on conflict (tenant_id,repository_id,name) do update set last_seen_at=excluded.last_seen_at returning id`,
            [createId(), input.tenantId, input.repositoryId, refName, input.observedAt],
          );
          branchId = branchResult.rows[0]?.id ? String(branchResult.rows[0].id) : undefined;
        }
        if (branchId && shas.length > 0) await client.query(
          `insert into commit_refs (tenant_id,commit_id,branch_id,last_seen_at,reachable)
           select $1,c.id,$2,$4,true from commits c where c.tenant_id=$1 and c.repository_id=$3 and c.sha=any($5::text[])
           on conflict (tenant_id,commit_id,branch_id) do update set last_seen_at=excluded.last_seen_at,reachable=true`,
          [input.tenantId, branchId, input.repositoryId, input.observedAt, shas],
        );
        if (input.finalPage && branchId) await client.query(
          "update branches set head_sha=$4,reachable=true,deleted_at=null,last_seen_at=$5,last_authoritative_observed_at=$5 where tenant_id=$1 and repository_id=$2 and id=$3",
          [input.tenantId, input.repositoryId, branchId, input.anchorHeadSha, input.observedAt],
        );
      } else if (input.stage === "branches") {
        for (const fact of input.facts) await client.query(
          `insert into branches (id,tenant_id,repository_id,name,head_sha,protected,reachable,first_seen_at,last_seen_at,last_authoritative_observed_at,observation_generation,deleted_at)
           values ($1,$2,$3,$4,$5,$6,true,$7,$7,$7,$8,null)
           on conflict (tenant_id,repository_id,name) do update set head_sha=excluded.head_sha,protected=excluded.protected,reachable=true,last_seen_at=excluded.last_seen_at,last_authoritative_observed_at=excluded.last_authoritative_observed_at,observation_generation=excluded.observation_generation,deleted_at=null`,
          [createId(), input.tenantId, input.repositoryId, fact.name, fact.headSha, fact.protected, input.observedAt, generation],
        );
        if (input.finalPage) await client.query("update branches set reachable=false,deleted_at=$3 where tenant_id=$1 and repository_id=$2 and (observation_generation is null or observation_generation <> $4)", [input.tenantId, input.repositoryId, input.observedAt, generation]);
      } else if (input.stage === "tags") {
        for (const fact of input.facts) await client.query(
          `insert into tags (id,tenant_id,repository_id,name,target_sha,target_type,reachable,completeness_state,first_seen_at,last_seen_at,last_authoritative_observed_at,observation_generation,deleted_at)
           values ($1,$2,$3,$4,$5,$6,true,'reachable_at_sync',$7,$7,$7,$8,null)
           on conflict (tenant_id,repository_id,name) do update set target_sha=excluded.target_sha,target_type=excluded.target_type,reachable=true,completeness_state='reachable_at_sync',last_seen_at=excluded.last_seen_at,last_authoritative_observed_at=excluded.last_authoritative_observed_at,observation_generation=excluded.observation_generation,deleted_at=null`,
          [createId(), input.tenantId, input.repositoryId, fact.name, fact.targetSha, fact.targetType ?? null, input.observedAt, generation],
        );
        if (input.finalPage) await client.query("update tags set reachable=false,deleted_at=$3 where tenant_id=$1 and repository_id=$2 and observation_generation <> $4", [input.tenantId, input.repositoryId, input.observedAt, generation]);
      } else if (input.stage === "pull_requests") {
        for (const fact of input.facts) {
          const authorId = fact.author ? await this.ensureGithubAccount(client, fact.author.githubAccountId, fact.author.login, fact.author.accountType ?? "User", fact.author.actorKind) : null;
          const mergerId = fact.merger ? await this.ensureGithubAccount(client, fact.merger.githubAccountId, fact.merger.login, fact.merger.accountType ?? "User", fact.merger.actorKind) : null;
          await client.query(
            `insert into pull_requests (id,tenant_id,repository_id,github_pull_request_id,number,title,state,draft,author_github_account_id,author_actor_kind,merger_github_account_id,base_ref,base_sha,head_ref,head_sha,source_url,github_created_at,github_updated_at,github_closed_at,github_merged_at,first_seen_at,last_seen_at,completeness_state)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21,'observed')
             on conflict (tenant_id,repository_id,github_pull_request_id) do update set number=excluded.number,title=excluded.title,state=excluded.state,draft=excluded.draft,author_github_account_id=excluded.author_github_account_id,author_actor_kind=excluded.author_actor_kind,merger_github_account_id=excluded.merger_github_account_id,base_ref=excluded.base_ref,base_sha=excluded.base_sha,head_ref=excluded.head_ref,head_sha=excluded.head_sha,source_url=excluded.source_url,github_created_at=excluded.github_created_at,github_updated_at=excluded.github_updated_at,github_closed_at=excluded.github_closed_at,github_merged_at=excluded.github_merged_at,last_seen_at=excluded.last_seen_at,completeness_state='observed'
             where excluded.github_updated_at >= pull_requests.github_updated_at`,
            [createId(), input.tenantId, input.repositoryId, fact.githubId, fact.number, fact.title, fact.state, fact.draft, authorId, fact.author?.actorKind ?? "unknown", mergerId, fact.baseRef ?? null, fact.baseSha ?? null, fact.headRef ?? null, fact.headSha ?? null, fact.sourceUrl ?? null, fact.createdAt, fact.updatedAt, fact.closedAt ?? null, fact.mergedAt ?? null, input.observedAt],
          );
        }
      } else if (input.stage === "issues") {
        for (const fact of input.facts) {
          const authorId = fact.author ? await this.ensureGithubAccount(client, fact.author.githubAccountId, fact.author.login, fact.author.accountType ?? "User", fact.author.actorKind) : null;
          await client.query(
            `insert into issues (id,tenant_id,repository_id,github_issue_id,number,title,state,state_reason,author_github_account_id,author_actor_kind,source_url,github_created_at,github_updated_at,github_closed_at,first_seen_at,last_seen_at,completeness_state)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,'observed')
             on conflict (tenant_id,repository_id,github_issue_id) do update set number=excluded.number,title=excluded.title,state=excluded.state,state_reason=excluded.state_reason,author_github_account_id=excluded.author_github_account_id,author_actor_kind=excluded.author_actor_kind,source_url=excluded.source_url,github_created_at=excluded.github_created_at,github_updated_at=excluded.github_updated_at,github_closed_at=excluded.github_closed_at,last_seen_at=excluded.last_seen_at,completeness_state='observed'
             where excluded.github_updated_at >= issues.github_updated_at`,
            [createId(), input.tenantId, input.repositoryId, fact.githubId, fact.number, fact.title, fact.state, fact.stateReason ?? null, authorId, fact.author?.actorKind ?? "unknown", fact.sourceUrl ?? null, fact.createdAt, fact.updatedAt, fact.closedAt ?? null, input.observedAt],
          );
        }
      } else {
        for (const fact of input.facts) {
          const authorId = fact.author ? await this.ensureGithubAccount(client, fact.author.githubAccountId, fact.author.login, fact.author.accountType ?? "User", fact.author.actorKind) : null;
          await client.query(
            `insert into releases (id,tenant_id,repository_id,github_release_id,tag_name,name,draft,prerelease,author_github_account_id,author_actor_kind,source_url,github_created_at,github_updated_at,github_published_at,first_seen_at,last_seen_at,completeness_state)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,'observed')
             on conflict (tenant_id,repository_id,github_release_id) do update set tag_name=excluded.tag_name,name=excluded.name,draft=excluded.draft,prerelease=excluded.prerelease,author_github_account_id=excluded.author_github_account_id,author_actor_kind=excluded.author_actor_kind,source_url=excluded.source_url,github_created_at=excluded.github_created_at,github_updated_at=excluded.github_updated_at,github_published_at=excluded.github_published_at,last_seen_at=excluded.last_seen_at,completeness_state='observed'
             where excluded.github_updated_at > releases.github_updated_at`,
            [createId(), input.tenantId, input.repositoryId, fact.githubId, fact.tagName, fact.name ?? null, fact.draft, fact.prerelease, authorId, fact.author?.actorKind ?? "unknown", fact.sourceUrl ?? null, fact.createdAt, fact.updatedAt, fact.publishedAt ?? null, input.observedAt],
          );
        }
      }

      const reconciliationRunId = typeof progress.cursor.reconciliationRunId === "string" ? progress.cursor.reconciliationRunId : undefined;
      const nextCursor = input.stage === "default_branch_commits" ? { ...input.nextCursor, previousHead: progress.cursor.previousHead, ...(reconciliationRunId ? { reconciliationRunId } : {}) } : { ...input.nextCursor, ...(reconciliationRunId ? { reconciliationRunId } : {}) };
      const completeness = input.finalPage && (input.stage === "default_branch_commits" || input.stage === "branches" || input.stage === "tags") ? "reachable_at_sync" : input.finalPage ? "observed" : "known_unknown";
      const updatedResult = await client.query<Row>(
        `update sync_cursors set cursor=$5,status=$6,last_success_at=$7,completed_at=$8,
           high_water_at=coalesce($9,high_water_at),completeness_state=$10,error_code=null,paused_until=null
         where tenant_id=$1 and repository_id=$2 and resource_type=$3 and ref_name=$4 returning *`,
        [input.tenantId, input.repositoryId, input.stage, refName, nextCursor, input.finalPage ? "completed" : "in_progress", input.observedAt, input.finalPage ? input.observedAt : null, input.highWaterAt ?? null, completeness],
      );
      const updated = historicalProgressFromRow(updatedResult.rows[0]);
      if (!updated) throw new Error("historical_progress_missing_after_commit");
      if (input.finalPage) {
        const next = nextHistoricalStage(input.stage);
        await client.query(
          `update sync_cursors set status=$5::varchar,started_at=coalesce(started_at,$6),completed_at=case when $5::varchar='completed' then $6 else completed_at end,last_success_at=case when $5::varchar='completed' then $6 else last_success_at end,last_full_reconcile_at=case when $5::varchar='completed' and $7::text is not null then $6 else last_full_reconcile_at end,completeness_state=case when $5::varchar='completed' then 'observed' else completeness_state end,cursor=case when $7::text is null then cursor else cursor || jsonb_build_object('reconciliationRunId',$7::text) end
           where tenant_id=$1 and repository_id=$2 and resource_type=$3 and ref_name=$4`,
          [input.tenantId, input.repositoryId, next, "", next === "completed" ? "completed" : "in_progress", input.observedAt, reconciliationRunId ?? null],
        );
      }
      return { applied: true, progress: updated };
    });
  }

  async pauseHistoricalStage(input: { tenantId: string; repositoryId: string; stage: HistoricalSourceStage; refName?: string; pausedUntil?: Date; errorCode: string; expectedReconciliationRunId?: string }): Promise<HistoricalProgress | undefined> {
    const refName = input.stage === "default_branch_commits" ? branchName(input.refName ?? "") : input.refName ?? "";
    return this.tenantQuery(input.tenantId, async (client) => {
      if (input.expectedReconciliationRunId) await client.query("select pg_advisory_xact_lock(hashtext($1))", [`m5:${input.tenantId}:${input.repositoryId}`]);
      return historicalProgressFromRow((await client.query<Row>(
        `update sync_cursors set status='paused',paused_until=$5,error_code=$6
         where tenant_id=$1 and repository_id=$2 and resource_type=$3 and ref_name=$4 and status <> 'completed'
           and ($7::text is null or (cursor->>'reconciliationRunId'=$7 and exists (
             select 1 from reconciliation_generations g
             where g.tenant_id=$1 and g.repository_id=$2 and g.reconciliation_run_id=$7::uuid and g.current=true
           )))
         returning *`,
        [input.tenantId, input.repositoryId, input.stage, refName, input.pausedUntil ?? null, input.errorCode, input.expectedReconciliationRunId ?? null],
      )).rows[0]);
    });
  }

  async resumeHistoricalStage(input: { tenantId: string; repositoryId: string; stage: HistoricalSourceStage; refName?: string; now: Date; expectedReconciliationRunId?: string }): Promise<HistoricalProgress | undefined> {
    const refName = input.stage === "default_branch_commits" ? branchName(input.refName ?? "") : input.refName ?? "";
    return this.tenantQuery(input.tenantId, async (client) => {
      if (input.expectedReconciliationRunId) await client.query("select pg_advisory_xact_lock(hashtext($1))", [`m5:${input.tenantId}:${input.repositoryId}`]);
      return historicalProgressFromRow((await client.query<Row>(
        `update sync_cursors set status='in_progress',paused_until=null,error_code=null
         where tenant_id=$1 and repository_id=$2 and resource_type=$3 and ref_name=$4 and status='paused'
           and (paused_until is null or paused_until <= $5)
           and ($6::text is null or (cursor->>'reconciliationRunId'=$6 and exists (
             select 1 from reconciliation_generations g
             where g.tenant_id=$1 and g.repository_id=$2 and g.reconciliation_run_id=$6::uuid and g.current=true
           )))
         returning *`,
        [input.tenantId, input.repositoryId, input.stage, refName, input.now, input.expectedReconciliationRunId ?? null],
      )).rows[0]);
    });
  }

  async pauseInstallationApi(input: { tenantId: string; installationId: string; pausedUntil: Date; reason: string }): Promise<void> {
    await this.tenantQuery(input.tenantId, async (client) => {
      await client.query(
        "update github_installations set api_paused_until=greatest(coalesce(api_paused_until,$3),$3),api_pause_reason=case when api_paused_until is null or api_paused_until <= $3 then $4 else api_pause_reason end where tenant_id=$1 and id=$2",
        [input.tenantId, input.installationId, input.pausedUntil, input.reason],
      );
    });
  }

  async resumeInstallationApi(input: { tenantId: string; installationId: string; now: Date }): Promise<void> {
    await this.tenantQuery(input.tenantId, async (client) => { await client.query("update github_installations set api_paused_until=null,api_pause_reason=null where tenant_id=$1 and id=$2 and (api_paused_until is null or api_paused_until <= $3)", [input.tenantId, input.installationId, input.now]); });
  }

  async getHistoricalSourceCounts(tenantId: string, repositoryId: string): Promise<HistoricalSourceCounts> {
    return this.tenantQuery(tenantId, async (client) => {
      const result = await client.query<Row>(
        `select
           (select count(*)::int from commits where tenant_id=$1 and repository_id=$2) commits,
           (select count(*)::int from branches where tenant_id=$1 and repository_id=$2) branches,
           (select count(*)::int from tags where tenant_id=$1 and repository_id=$2) tags,
           (select count(*)::int from pull_requests where tenant_id=$1 and repository_id=$2) pull_requests,
           (select count(*)::int from issues where tenant_id=$1 and repository_id=$2) issues,
           (select count(*)::int from releases where tenant_id=$1 and repository_id=$2) releases`,
        [tenantId, repositoryId],
      );
      const row = result.rows[0];
      return { commits: Number(row?.commits ?? 0), branches: Number(row?.branches ?? 0), tags: Number(row?.tags ?? 0), pullRequests: Number(row?.pull_requests ?? 0), issues: Number(row?.issues ?? 0), releases: Number(row?.releases ?? 0) };
    });
  }

  async listActivity(tenantId: string, repositoryId?: string, query?: ActivityQuery): Promise<ActivityRecord[]> {
    return this.tenantQuery(tenantId, async (client) => {
      const contextClause = query?.context && query.context !== "default" ? ` and e.context_kind=$${repositoryId ? 3 : 2}` : "";
      const botClause = query && !query.includeBots ? " and e.actor_kind <> 'bot'" : "";
      const params = repositoryId ? [tenantId, repositoryId] : [tenantId];
      if (query?.context && query.context !== "default") params.push(query.context);
      const result = await client.query<Row>(`select e.id,e.repository_id,e.source_kind,e.source_external_id,e.event_type,e.verb,ga.github_account_id as actor_github_id,e.actor_kind,e.contribution_role,e.context_kind,e.occurred_at,e.source_updated_at,e.title,e.summary_input,e.source_url,e.completeness_state,e.visibility,e.attribution_confidence,e.projection_version,e.logical_event_key,c.message from development_events e join repositories r on r.id=e.repository_id and r.tenant_id=e.tenant_id left join commits c on c.tenant_id=e.tenant_id and c.repository_id=e.repository_id and c.sha=e.source_external_id left join github_accounts ga on ga.id=e.actor_github_account_id where e.tenant_id=$1 ${repositoryId ? "and e.repository_id=$2" : ""}${contextClause}${botClause} order by e.occurred_at desc,e.logical_event_key asc limit 1000`, params);
      return result.rows.map((row) => ({ id: String(row.id), repositoryId: String(row.repository_id), sourceKind: row.source_kind as DevelopmentEvent["sourceKind"], sourceExternalId: String(row.source_external_id), eventType: row.event_type as DevelopmentEvent["eventType"], verb: row.verb as DevelopmentEvent["verb"], ...(row.actor_github_id ? { actorGithubAccountId: Number(row.actor_github_id) } : {}), actorKind: row.actor_kind as DevelopmentEvent["actorKind"], contributionRole: row.contribution_role as DevelopmentEvent["contributionRole"], contextKind: row.context_kind as DevelopmentEvent["contextKind"], occurredAt: new Date(String(row.occurred_at)), ...(date(row.source_updated_at) ? { sourceUpdatedAt: date(row.source_updated_at) } : {}), ...(row.title ? { title: String(row.title) } : {}), ...(row.summary_input ? { summaryInput: String(row.summary_input) } : {}), completenessState: row.completeness_state as DevelopmentEvent["completenessState"], visibility: row.visibility as DevelopmentEvent["visibility"], attributionConfidence: row.attribution_confidence as DevelopmentEvent["attributionConfidence"], projectionVersion: Number(row.projection_version), logicalEventKey: String(row.logical_event_key), ...(row.message ? { message: String(row.message) } : {}), ...(row.source_url ? { sourceUrl: String(row.source_url) } : {}) }));
    });
  }

  async reprojectRepository(input: { tenantId: string; repositoryId: string; ownerGithubAccountId: number; projectionVersion?: number; failureAfterEvents?: number }): Promise<ProjectionResult> {
    return this.tenantQuery(input.tenantId, async (client) => {
      const repositoryResult = await client.query<Row>("select github_repository_id,private,visibility,github_created_at,archived_at from repositories where tenant_id=$1 and id=$2", [input.tenantId, input.repositoryId]);
      const repository = repositoryResult.rows[0];
      if (!repository) throw new Error("repository_not_found_for_projection");
      const actor = (row: Row, prefix: string) => row[`${prefix}_github_id`] === null || row[`${prefix}_github_id`] === undefined ? undefined : ({ githubAccountId: Number(row[`${prefix}_github_id`]), actorKind: row[`${prefix}_actor_kind`] as "user" | "bot" | "unknown", ...(row[`${prefix}_login`] ? { login: String(row[`${prefix}_login`]) } : {}), ...(row[`${prefix}_account_type`] ? { accountType: String(row[`${prefix}_account_type`]) } : {}) });
      const required = (row: Row, field: string): Date => {
        const value = date(row[field]);
        if (!value) throw new Error("projection_source_missing_timestamp");
        return value;
      };
      const commitRows = await client.query<Row>(`select c.sha,c.message,c.authored_at,c.committed_at,c.parent_shas,c.verified,c.html_url,aa.github_account_id as author_github_id,aa.actor_kind as author_actor_kind,aa.login as author_login,aa.account_type as author_account_type,ca.github_account_id as committer_github_id,ca.actor_kind as committer_actor_kind,ca.login as committer_login,ca.account_type as committer_account_type from commits c left join github_accounts aa on aa.id=c.author_github_account_id left join github_accounts ca on ca.id=c.committer_github_account_id where c.tenant_id=$1 and c.repository_id=$2 order by c.sha`, [input.tenantId, input.repositoryId]);
      const pullRows = await client.query<Row>(`select p.github_pull_request_id,p.title,p.source_url,p.github_created_at,p.github_updated_at,p.github_closed_at,p.github_merged_at,aa.github_account_id as author_github_id,aa.actor_kind as author_actor_kind,aa.login as author_login,aa.account_type as author_account_type,ma.github_account_id as merger_github_id,ma.actor_kind as merger_actor_kind,ma.login as merger_login,ma.account_type as merger_account_type,p.completeness_state from pull_requests p left join github_accounts aa on aa.id=p.author_github_account_id left join github_accounts ma on ma.id=p.merger_github_account_id where p.tenant_id=$1 and p.repository_id=$2 order by p.github_pull_request_id`, [input.tenantId, input.repositoryId]);
      const issueRows = await client.query<Row>(`select i.github_issue_id,i.title,i.source_url,i.github_created_at,i.github_updated_at,i.github_closed_at,aa.github_account_id as author_github_id,aa.actor_kind as author_actor_kind,aa.login as author_login,aa.account_type as author_account_type,i.completeness_state from issues i left join github_accounts aa on aa.id=i.author_github_account_id where i.tenant_id=$1 and i.repository_id=$2 order by i.github_issue_id`, [input.tenantId, input.repositoryId]);
      const releaseRows = await client.query<Row>(`select r.github_release_id,r.name,r.source_url,r.github_updated_at,r.github_published_at,aa.github_account_id as author_github_id,aa.actor_kind as author_actor_kind,aa.login as author_login,aa.account_type as author_account_type,r.completeness_state from releases r left join github_accounts aa on aa.id=r.author_github_account_id where r.tenant_id=$1 and r.repository_id=$2 order by r.github_release_id`, [input.tenantId, input.repositoryId]);
      const renameRows = await client.query<Row>("select valid_to from repository_name_history where tenant_id=$1 and repository_id=$2 and valid_to is not null order by valid_to", [input.tenantId, input.repositoryId]);
      const tagRows = await client.query<Row>("select name,deleted_at,completeness_state from tags where tenant_id=$1 and repository_id=$2 and deleted_at is not null order by name", [input.tenantId, input.repositoryId]);
      const projectionInput: CanonicalProjectionInput = {
        tenantId: input.tenantId,
        repositoryId: input.repositoryId,
        githubRepositoryId: Number(repository.github_repository_id),
        ownerGithubAccountId: input.ownerGithubAccountId,
        private: Boolean(repository.private),
        ...(repository.visibility ? { visibility: String(repository.visibility) } : {}),
        ...(date(repository.github_created_at) ? { githubCreatedAt: date(repository.github_created_at) } : {}),
        ...(date(repository.archived_at) ? { archivedAt: date(repository.archived_at) } : {}),
        commits: commitRows.rows.map((row) => {
          const author = actor(row, "author");
          const committer = actor(row, "committer");
          const authoredAt = date(row.authored_at);
          const committedAt = date(row.committed_at);
          return { repositoryId: input.repositoryId, sha: String(row.sha), ...(author ? { author } : {}), ...(committer ? { committer } : {}), message: String(row.message), ...(authoredAt ? { authoredAt } : {}), ...(committedAt ? { committedAt } : {}), parents: Array.isArray(row.parent_shas) ? row.parent_shas.filter((value): value is string => typeof value === "string") : [], ...(row.verified === null || row.verified === undefined ? {} : { verified: Boolean(row.verified) }), ...(row.html_url ? { htmlUrl: String(row.html_url) } : {}) };
        }),
        pullRequests: pullRows.rows.map((row) => {
          const author = actor(row, "author");
          const merger = actor(row, "merger");
          return { githubId: Number(row.github_pull_request_id), title: String(row.title), ...(author ? { author } : {}), ...(merger ? { merger } : {}), ...(row.source_url ? { sourceUrl: String(row.source_url) } : {}), createdAt: required(row, "github_created_at"), updatedAt: required(row, "github_updated_at"), ...(date(row.github_closed_at) ? { closedAt: date(row.github_closed_at) } : {}), ...(date(row.github_merged_at) ? { mergedAt: date(row.github_merged_at) } : {}), ...(row.completeness_state ? { completenessState: row.completeness_state as "observed" | "reachable_at_sync" | "known_unknown" | "out_of_scope" } : {}) };
        }),
        issues: issueRows.rows.map((row) => {
          const author = actor(row, "author");
          return { githubId: Number(row.github_issue_id), title: String(row.title), ...(author ? { author } : {}), ...(row.source_url ? { sourceUrl: String(row.source_url) } : {}), createdAt: required(row, "github_created_at"), updatedAt: required(row, "github_updated_at"), ...(date(row.github_closed_at) ? { closedAt: date(row.github_closed_at) } : {}), ...(row.completeness_state ? { completenessState: row.completeness_state as "observed" | "reachable_at_sync" | "known_unknown" | "out_of_scope" } : {}) };
        }),
        releases: releaseRows.rows.map((row) => {
          const author = actor(row, "author");
          return { githubId: Number(row.github_release_id), ...(row.name ? { name: String(row.name) } : {}), ...(author ? { author } : {}), ...(row.source_url ? { sourceUrl: String(row.source_url) } : {}), updatedAt: required(row, "github_updated_at"), ...(date(row.github_published_at) ? { publishedAt: date(row.github_published_at) } : {}), ...(row.completeness_state ? { completenessState: row.completeness_state as "observed" | "reachable_at_sync" | "known_unknown" | "out_of_scope" } : {}) };
        }),
        repositoryRenames: renameRows.rows.map((row) => ({ observedAt: required(row, "valid_to") })),
        tags: tagRows.rows.map((row) => ({ name: String(row.name), deletedAt: required(row, "deleted_at"), ...(row.completeness_state ? { completenessState: row.completeness_state as "observed" | "reachable_at_sync" | "known_unknown" | "out_of_scope" } : {}) })),
        projectionVersion: input.projectionVersion ?? PROJECTION_VERSION,
      };
      const projected = projectCanonicalFacts(projectionInput);
      await client.query("delete from development_events where tenant_id=$1 and repository_id=$2", [input.tenantId, input.repositoryId]);
      for (const [index, event] of projected.entries()) {
        if (input.failureAfterEvents !== undefined && index >= input.failureAfterEvents) throw new Error("projection_injected_failure");
        const actorId = event.actorGithubAccountId === undefined ? undefined : await this.ensureGithubAccount(client, event.actorGithubAccountId, undefined, event.actorKind === "bot" ? "Bot" : "User", event.actorKind);
        await this.writeDevelopmentEvent(client, input.tenantId, input.repositoryId, event, actorId, event.sourceUrl, event.summaryInput);
      }
      return { projectionVersion: input.projectionVersion ?? PROJECTION_VERSION, eventCount: projected.length };
    });
  }

  async assertReachable(): Promise<void> {
    await this.pool.query("select 1");
  }

  async getGithubDeliveryAudit(githubAppId: number): Promise<GithubDeliveryAudit | undefined> {
    const result = await this.pool.query<Row>("select * from github_delivery_audits where github_app_id=$1", [githubAppId]);
    return auditFromRow(result.rows[0]);
  }

  async startGithubDeliveryAudit(input: { githubAppId: number; auditRunId: string; now: Date }): Promise<GithubDeliveryAudit> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const existing = auditFromRow((await client.query<Row>("select * from github_delivery_audits where github_app_id=$1 for update", [input.githubAppId])).rows[0]);
      if (existing && existing.status !== "completed") {
        if (existing.currentRunId === input.auditRunId && existing.status === "paused" && (!existing.pausedUntil || existing.pausedUntil <= input.now)) {
          const resumed = auditFromRow((await client.query<Row>("update github_delivery_audits set status='in_progress',paused_until=null,pause_reason=null,updated_at=$2 where github_app_id=$1 returning *", [input.githubAppId, input.now])).rows[0]);
          await client.query("commit");
          if (!resumed) throw new Error("Delivery audit disappeared during resume");
          return resumed;
        }
        await client.query("commit");
        return existing;
      }
      const stopBefore = existing?.highWaterDeliveredAt ?? new Date(input.now.getTime() - 3 * 24 * 60 * 60 * 1000);
      const generation = (existing?.generation ?? 0) + 1;
      const saved = auditFromRow((await client.query<Row>(
        `insert into github_delivery_audits (id,github_app_id,current_run_id,generation,status,list_cursor,page_number,stop_before_delivered_at,newest_delivered_at_seen,high_water_delivered_at,paused_until,pause_reason,last_error_code,started_at,completed_at,updated_at)
         values ($1,$2,$3,$4,'in_progress',null,1,$5,null,$6,null,null,null,$7,null,$7)
         on conflict (github_app_id) do update set current_run_id=excluded.current_run_id,generation=excluded.generation,status='in_progress',list_cursor=null,page_number=1,stop_before_delivered_at=excluded.stop_before_delivered_at,newest_delivered_at_seen=null,paused_until=null,pause_reason=null,last_error_code=null,started_at=excluded.started_at,completed_at=null,updated_at=excluded.updated_at,high_water_delivered_at=github_delivery_audits.high_water_delivered_at
         returning *`,
        [existing?.id ?? createId(), input.githubAppId, input.auditRunId, generation, stopBefore, existing?.highWaterDeliveredAt ?? null, input.now],
      )).rows[0]);
      await client.query("commit");
      if (!saved) throw new Error("Delivery audit was not created");
      return saved;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async pauseGithubDeliveryAudit(input: { githubAppId: number; auditRunId: string; pausedUntil: Date; errorCode: string }): Promise<GithubDeliveryAudit | undefined> {
    const result = await this.pool.query<Row>("update github_delivery_audits set status='paused',paused_until=$3,pause_reason=$4,last_error_code=$4,updated_at=$3 where github_app_id=$1 and current_run_id=$2 returning *", [input.githubAppId, input.auditRunId, input.pausedUntil, input.errorCode]);
    return auditFromRow(result.rows[0]);
  }

  async resumeGithubDeliveryAudit(input: { githubAppId: number; auditRunId: string; now: Date }): Promise<GithubDeliveryAudit | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const existing = auditFromRow((await client.query<Row>("select * from github_delivery_audits where github_app_id=$1 and current_run_id=$2 for update", [input.githubAppId, input.auditRunId])).rows[0]);
      if (!existing) {
        await client.query("commit");
        return undefined;
      }
      if (existing.pausedUntil && existing.pausedUntil > input.now) {
        await client.query("commit");
        return existing;
      }
      const resumed = auditFromRow((await client.query<Row>("update github_delivery_audits set status='in_progress',paused_until=null,pause_reason=null,updated_at=$3 where github_app_id=$1 and current_run_id=$2 returning *", [input.githubAppId, input.auditRunId, input.now])).rows[0]);
      await client.query("commit");
      return resumed;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async commitGithubDeliveryAuditPage(input: {
    githubAppId: number;
    auditRunId: string;
    expectedPage: number;
    expectedCursor?: string;
    nextCursor?: string;
    newestDeliveredAt?: Date;
    reachedStop: boolean;
    now: Date;
  }): Promise<GithubDeliveryAudit | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const existing = auditFromRow((await client.query<Row>("select * from github_delivery_audits where github_app_id=$1 and current_run_id=$2 for update", [input.githubAppId, input.auditRunId])).rows[0]);
      if (!existing || existing.pageNumber !== input.expectedPage || (existing.listCursor ?? undefined) !== input.expectedCursor) {
        await client.query("commit");
        return undefined;
      }
      const newest = input.newestDeliveredAt && (!existing.newestDeliveredAtSeen || input.newestDeliveredAt > existing.newestDeliveredAtSeen) ? input.newestDeliveredAt : existing.newestDeliveredAtSeen ?? null;
      const complete = input.reachedStop || !input.nextCursor;
      const saved = complete
        ? auditFromRow((await client.query<Row>("update github_delivery_audits set status='completed',completed_at=$3,last_success_at=$3,high_water_delivered_at=coalesce($4,high_water_delivered_at),newest_delivered_at_seen=coalesce($4,newest_delivered_at_seen),list_cursor=null,updated_at=$3 where github_app_id=$1 and current_run_id=$2 returning *", [input.githubAppId, input.auditRunId, input.now, newest])).rows[0])
        : auditFromRow((await client.query<Row>("update github_delivery_audits set status='in_progress',list_cursor=$3,page_number=$4,newest_delivered_at_seen=coalesce($5,newest_delivered_at_seen),updated_at=$6 where github_app_id=$1 and current_run_id=$2 returning *", [input.githubAppId, input.auditRunId, input.nextCursor, input.expectedPage + 1, newest, input.now])).rows[0]);
      await client.query("commit");
      return saved;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async getGithubDeliveryRepair(guid: string): Promise<GithubDeliveryRepair | undefined> {
    const result = await this.pool.query<Row>("select * from github_delivery_repairs where github_delivery_guid=$1", [guid]);
    return repairFromRow(result.rows[0]);
  }

  async observeGithubDeliveryAttempt(input: GithubDeliveryRepairObservation): Promise<GithubDeliveryRepair> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const existing = repairFromRow((await client.query<Row>("select * from github_delivery_repairs where github_delivery_guid=$1 for update", [input.githubDeliveryGuid])).rows[0]);
      if (existing?.lastGithubDeliveredAt && existing.lastGithubDeliveredAt >= input.deliveredAt) {
        await client.query("commit");
        return existing;
      }
      const status = githubDeliveryAttemptSucceeded(input.statusCode) ? "healthy" : existing?.status === "requesting" ? "requesting" : "pending";
      const saved = repairFromRow((await client.query<Row>(
        `insert into github_delivery_repairs (id,github_delivery_guid,github_delivery_id,github_app_id,audit_run_id,event_name,action,installation_github_id,repository_github_id,status,attempt_count,last_redelivery_requested_at,next_eligible_at,last_github_status_code,last_github_delivered_at,sanitized_error_code,created_at,updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)
         on conflict (github_delivery_guid) do update set github_delivery_id=excluded.github_delivery_id,audit_run_id=excluded.audit_run_id,event_name=excluded.event_name,action=excluded.action,installation_github_id=excluded.installation_github_id,repository_github_id=excluded.repository_github_id,status=excluded.status,last_github_status_code=excluded.last_github_status_code,last_github_delivered_at=excluded.last_github_delivered_at,updated_at=excluded.updated_at
         returning *`,
        [existing?.id ?? createId(), input.githubDeliveryGuid, input.githubDeliveryId, input.githubAppId, input.auditRunId, input.eventName, input.action ?? null, input.installationGithubId ?? null, input.repositoryGithubId ?? null, status, existing?.attemptCount ?? 0, existing?.lastRedeliveryRequestedAt ?? null, existing?.nextEligibleAt ?? null, input.statusCode, input.deliveredAt, existing?.sanitizedErrorCode ?? null, input.now],
      )).rows[0]);
      await client.query("commit");
      if (!saved) throw new Error("Delivery repair was not stored");
      return saved;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async claimGithubDeliveryRedelivery(input: { guid: string; githubDeliveryId: number; now: Date; maxAttempts: number }): Promise<GithubDeliveryRedeliveryClaim> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const repair = repairFromRow((await client.query<Row>("select * from github_delivery_repairs where github_delivery_guid=$1 for update", [input.guid])).rows[0]);
      if (!repair) throw new Error("Delivery repair not found");
      let localDelivery: DeliveryRecord | undefined;
      if (repair.installationGithubId) {
        const route = await client.query<Row>("select tenant_id from installation_routes where github_installation_id=$1", [repair.installationGithubId]);
        const tenantId = route.rows[0]?.tenant_id ? String(route.rows[0].tenant_id) : undefined;
        if (tenantId) {
          await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
          localDelivery = deliveryFromRow((await client.query<Row>("select * from webhook_deliveries where github_delivery_guid=$1 for update", [input.guid])).rows[0]);
        }
      }
      const deny = async (reason: GithubDeliveryRedeliveryClaim["reason"], status?: GithubDeliveryRepair["status"]): Promise<GithubDeliveryRedeliveryClaim> => {
        const saved = status
          ? repairFromRow((await client.query<Row>("update github_delivery_repairs set status=$2,updated_at=$3 where github_delivery_guid=$1 returning *", [input.guid, status, input.now])).rows[0]) ?? repair
          : repair;
        await client.query("commit");
        return { allowed: false, reason, repair: saved, ...(localDelivery ? { localDelivery } : {}) };
      };
      if (isTerminalGithubDeliveryRepairStatus(repair.status)) {
        return deny(repair.status === "skipped_terminal" ? "terminal" : repair.status === "exhausted" ? "exhausted" : repair.status === "expired" ? "expired" : "healthy");
      }
      if (repair.lastGithubDeliveredAt && githubDeliveryIsExpired(repair.lastGithubDeliveredAt, input.now)) return deny("expired", "expired");
      if (localDelivery && isTerminalDeliveryState(localDelivery.state)) return deny("terminal", "skipped_terminal");
      if (localDelivery?.state === "processing") return deny("processing", "skipped_processing");
      if (repair.attemptCount >= input.maxAttempts) return deny("exhausted", "exhausted");
      if (repair.nextEligibleAt && repair.nextEligibleAt > input.now) return deny("cooldown");
      const saved = repairFromRow((await client.query<Row>("update github_delivery_repairs set status='requesting',github_delivery_id=$2,next_eligible_at=$3,updated_at=$4 where github_delivery_guid=$1 returning *", [input.guid, input.githubDeliveryId, nextRedeliveryClaimLeaseAt(input.now), input.now])).rows[0]);
      await client.query("commit");
      if (!saved) throw new Error("Delivery repair claim failed");
      return { allowed: true, reason: "claimed", repair: saved, ...(localDelivery ? { localDelivery } : {}) };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async acceptGithubDeliveryRedelivery(input: { guid: string; now: Date }): Promise<GithubDeliveryRepair | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const existing = repairFromRow((await client.query<Row>("select * from github_delivery_repairs where github_delivery_guid=$1 for update", [input.guid])).rows[0]);
      if (!existing) {
        await client.query("commit");
        return undefined;
      }
      if (existing.status === "requested" && existing.lastRedeliveryRequestedAt) {
        await client.query("commit");
        return existing;
      }
      const attemptCount = existing.attemptCount + 1;
      const saved = repairFromRow((await client.query<Row>("update github_delivery_repairs set status='requested',attempt_count=$2,last_redelivery_requested_at=$3,next_eligible_at=$4,updated_at=$3 where github_delivery_guid=$1 returning *", [input.guid, attemptCount, input.now, nextRedeliveryEligibleAt(attemptCount, input.now)])).rows[0]);
      await client.query("commit");
      return saved;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async deferGithubDeliveryRedelivery(input: { guid: string; resumeAt: Date; errorCode: string; now: Date }): Promise<GithubDeliveryRepair | undefined> {
    const result = await this.pool.query<Row>("update github_delivery_repairs set status='requesting',next_eligible_at=$2,sanitized_error_code=$3,updated_at=$4 where github_delivery_guid=$1 returning *", [input.guid, input.resumeAt, input.errorCode, input.now]);
    return repairFromRow(result.rows[0]);
  }

  async listRecoverableGithubDeliveryRepairs(githubAppId: number): Promise<GithubDeliveryRepair[]> {
    const result = await this.pool.query<Row>("select * from github_delivery_repairs where github_app_id=$1 and status in ('pending','requesting','requested','skipped_processing')", [githubAppId]);
    return result.rows.map((row) => repairFromRow(row)).filter((row): row is GithubDeliveryRepair => Boolean(row));
  }

  async markGithubDeliveryRepair(input: { guid: string; status: GithubDeliveryRepair["status"]; errorCode?: string; now: Date }): Promise<GithubDeliveryRepair | undefined> {
    const result = await this.pool.query<Row>("update github_delivery_repairs set status=$2,sanitized_error_code=coalesce($3,sanitized_error_code),updated_at=$4 where github_delivery_guid=$1 returning *", [input.guid, input.status, input.errorCode ?? null, input.now]);
    return repairFromRow(result.rows[0]);
  }
}
