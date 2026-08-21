import type { Pool, PoolClient, QueryResultRow } from "pg";
import { createId, deliveryRedeliveryAction, repositoryAccessIsAvailable, type CommitFact, type DevelopmentEvent, type RepositoryAccessStatus } from "@devmemoir/domain";
import { RepositorySelectionError } from "./store.js";
import type {
  ActivityRecord,
  AuthTransactionRecord,
  DeliveryInsertResult,
  DeliveryRecord,
  InventoryReconcileResult,
  InstallationRecord,
  InstallationLifecycleStatus,
  M1Store,
  RepositoryRecord,
  RefSyncContinuation,
  SessionRecord,
  UserRecord,
} from "./store.js";

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
  };
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
    ...(row.archived_at ? { archived: true } : {}),
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
      const result = await client.query<Row>("select gi.id,gi.tenant_id,gi.github_installation_id,gi.status,gi.permissions,gi.repository_selection,gi.suspended_at,gi.deleted_at,gi.last_inventory_at,ga.github_account_id as account_github_account_id from github_installations gi join github_accounts ga on ga.id=gi.account_github_account_id where gi.github_installation_id=$1", [githubInstallationId]);
      return installationFromRow(result.rows[0]);
    });
  }

  async listInstallations(tenantId: string): Promise<InstallationRecord[]> {
    return this.tenantQuery(tenantId, async (client) => {
      const result = await client.query<Row>("select gi.id,gi.tenant_id,gi.github_installation_id,gi.status,gi.permissions,gi.repository_selection,gi.suspended_at,gi.deleted_at,gi.last_inventory_at,ga.github_account_id as account_github_account_id from github_installations gi join github_accounts ga on ga.id=gi.account_github_account_id where gi.tenant_id=$1", [tenantId]);
      return result.rows.map((row) => installationFromRow(row)).filter((row): row is InstallationRecord => Boolean(row));
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
    return this.tenantQuery(tenantId, async (client) => repositoryFromRow((await client.query<Row>("select r.id,r.tenant_id,ra.installation_id,r.github_repository_id,r.owner_login,r.name,r.full_name,r.private,r.visibility,r.node_id,r.github_created_at,r.github_updated_at,r.github_pushed_at,r.default_branch,r.description,r.archived_at,r.disabled,r.first_seen_at,r.last_seen_at,r.last_authoritative_observed_at,ra.access_status,ra.selected,ra.revoked_at from repositories r join lateral (select installation_id,access_status,selected,revoked_at from repository_access where repository_id=r.id and tenant_id=r.tenant_id order by selected desc, selected_at desc nulls last limit 1) ra on true where r.tenant_id=$1 and r.github_repository_id=$2", [tenantId, githubRepositoryId])).rows[0]));
  }

  async getRepositoryById(tenantId: string, repositoryId: string): Promise<RepositoryRecord | undefined> {
    return this.tenantQuery(tenantId, async (client) => repositoryFromRow((await client.query<Row>("select r.id,r.tenant_id,ra.installation_id,r.github_repository_id,r.owner_login,r.name,r.full_name,r.private,r.visibility,r.node_id,r.github_created_at,r.github_updated_at,r.github_pushed_at,r.default_branch,r.description,r.archived_at,r.disabled,r.first_seen_at,r.last_seen_at,r.last_authoritative_observed_at,ra.access_status,ra.selected,ra.revoked_at from repositories r join lateral (select installation_id,access_status,selected,revoked_at from repository_access where repository_id=r.id and tenant_id=r.tenant_id order by selected desc, selected_at desc nulls last limit 1) ra on true where r.tenant_id=$1 and r.id=$2", [tenantId, repositoryId])).rows[0]));
  }

  async getRepositoryByFullName(tenantId: string, fullName: string): Promise<RepositoryRecord | undefined> {
    return this.tenantQuery(tenantId, async (client) => repositoryFromRow((await client.query<Row>("select r.id,r.tenant_id,ra.installation_id,r.github_repository_id,r.owner_login,r.name,r.full_name,r.private,r.visibility,r.node_id,r.github_created_at,r.github_updated_at,r.github_pushed_at,r.default_branch,r.description,r.archived_at,r.disabled,r.first_seen_at,r.last_seen_at,r.last_authoritative_observed_at,ra.access_status,ra.selected,ra.revoked_at from repositories r join lateral (select installation_id,access_status,selected,revoked_at from repository_access where repository_id=r.id and tenant_id=r.tenant_id order by selected desc, selected_at desc nulls last limit 1) ra on true where r.tenant_id=$1 and r.full_name=$2", [tenantId, fullName])).rows[0]));
  }

  async listRepositories(tenantId: string): Promise<RepositoryRecord[]> {
    return this.tenantQuery(tenantId, async (client) => {
      const result = await client.query<Row>("select r.id,r.tenant_id,ra.installation_id,r.github_repository_id,r.owner_login,r.name,r.full_name,r.private,r.visibility,r.node_id,r.github_created_at,r.github_updated_at,r.github_pushed_at,r.default_branch,r.description,r.archived_at,r.disabled,r.first_seen_at,r.last_seen_at,r.last_authoritative_observed_at,ra.access_status,ra.selected,ra.revoked_at from repositories r join lateral (select installation_id,access_status,selected,revoked_at from repository_access where repository_id=r.id and tenant_id=r.tenant_id and selected=true and access_status='accessible' order by selected_at desc limit 1) ra on true where r.tenant_id=$1 order by r.created_at asc", [tenantId]);
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
      const conflict = await client.query<Row>("select 1 from repository_access where tenant_id=$1 and selected=true and repository_id<>$2 limit 1", [tenantId, repositoryId]);
      if (conflict.rows.length > 0) throw new RepositorySelectionError();
      await client.query("update repository_access set access_status='accessible',selected=true,selected_at=coalesce(selected_at,now()),revoked_at=null where tenant_id=$1 and repository_id=$2 and installation_id=$3", [tenantId, repositoryId, row.installation_id]);
      return repositoryFromRow({ ...row, access_status: "accessible", selected: true, revoked_at: null });
    });
  }

  async unselectRepository(tenantId: string, repositoryId: string): Promise<RepositoryRecord | undefined> {
    return this.tenantQuery(tenantId, async (client) => {
      const current = await client.query<Row>("select r.id,r.tenant_id,ra.installation_id,r.github_repository_id,r.owner_login,r.name,r.full_name,r.private,r.visibility,r.node_id,r.github_created_at,r.github_updated_at,r.github_pushed_at,r.default_branch,r.description,r.archived_at,r.disabled,r.first_seen_at,r.last_seen_at,r.last_authoritative_observed_at,ra.access_status,ra.selected,ra.revoked_at from repositories r join repository_access ra on ra.repository_id=r.id and ra.tenant_id=r.tenant_id where r.tenant_id=$1 and r.id=$2 for update", [tenantId, repositoryId]);
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
      if (lastInventoryAt && lastInventoryAt >= input.observedAt) return { observed: input.repositories.length, added: 0, updated: 0, removed: 0 };
      const observed = new Map<number, RepositoryRecord>();
      for (const repository of input.repositories) observed.set(repository.githubRepositoryId, repository);
      let added = 0;
      let updated = 0;
      for (const repository of observed.values()) {
        const existingResult = await client.query<Row>("select r.id,r.owner_login,r.name,r.full_name,r.first_seen_at,(select max(nh.valid_to) from repository_name_history nh where nh.tenant_id=r.tenant_id and nh.repository_id=r.id) as last_name_changed_at,ra.access_status,ra.selected from repositories r left join repository_access ra on ra.repository_id=r.id and ra.installation_id=$3 and ra.tenant_id=r.tenant_id where r.tenant_id=$1 and r.github_repository_id=$2 for update", [input.tenantId, repository.githubRepositoryId, installationId]);
        const existing = existingResult.rows[0];
        const repositoryId = String(existing?.id ?? repository.id);
        const wasSelected = existing?.selected === true;
        if (existing && (existing.owner_login !== repository.ownerLogin || existing.name !== repository.name || existing.full_name !== repository.fullName)) {
          await client.query("insert into repository_name_history (id,tenant_id,repository_id,owner_login,name,full_name,valid_from,valid_to) values ($1,$2,$3,$4,$5,$6,coalesce($7,$8,$9),$9)", [createId(), input.tenantId, repositoryId, existing.owner_login, existing.name, existing.full_name, existing.last_name_changed_at, existing.first_seen_at, input.observedAt]);
        }
        await client.query(`insert into repositories (id,tenant_id,github_repository_id,node_id,owner_login,name,full_name,private,visibility,default_branch,description,archived_at,disabled,github_created_at,github_updated_at,github_pushed_at,first_seen_at,last_seen_at,last_authoritative_observed_at,created_at,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now(),now()) on conflict (tenant_id,github_repository_id) do update set node_id=coalesce(excluded.node_id,repositories.node_id),owner_login=excluded.owner_login,name=excluded.name,full_name=excluded.full_name,private=excluded.private,visibility=excluded.visibility,default_branch=excluded.default_branch,description=excluded.description,archived_at=excluded.archived_at,disabled=excluded.disabled,github_created_at=coalesce(excluded.github_created_at,repositories.github_created_at),github_updated_at=coalesce(excluded.github_updated_at,repositories.github_updated_at),github_pushed_at=coalesce(excluded.github_pushed_at,repositories.github_pushed_at),last_seen_at=excluded.last_seen_at,last_authoritative_observed_at=excluded.last_authoritative_observed_at,updated_at=now()`, [repositoryId, input.tenantId, repository.githubRepositoryId, repository.nodeId ?? null, repository.ownerLogin, repository.name, repository.fullName, repository.private, repository.visibility ?? null, repository.defaultBranch, repository.description ?? null, repository.archived ? input.observedAt : null, repository.disabled ?? false, repository.githubCreatedAt ?? null, repository.githubUpdatedAt ?? null, repository.githubPushedAt ?? null, existing?.first_seen_at ?? repository.firstSeenAt ?? input.observedAt, input.observedAt, input.observedAt]);
        await client.query("insert into repository_access (id,tenant_id,repository_id,installation_id,access_status,selected,selected_at,revoked_at,last_seen_at,last_authoritative_observed_at) values ($1,$2,$3,$4,'accessible',$5,$6,null,$7,$7) on conflict (tenant_id,repository_id,installation_id) do update set access_status='accessible',selected=repository_access.selected or $5,selected_at=case when repository_access.selected or $5 then coalesce(repository_access.selected_at,$6) else repository_access.selected_at end,revoked_at=null,last_seen_at=$7,last_authoritative_observed_at=$7", [createId(), input.tenantId, repositoryId, installationId, wasSelected, wasSelected ? input.observedAt : null, input.observedAt]);
        if (existing) updated += 1; else added += 1;
      }
      const ids = [...observed.keys()];
      const absent = await client.query<Row>("update repository_access ra set access_status='access_removed',revoked_at=$3 where ra.tenant_id=$1 and ra.installation_id=$2 and ra.access_status in ('accessible','installation_suspended','unavailable') and not (ra.repository_id in (select r.id from repositories r where r.tenant_id=$1 and r.github_repository_id=any($4::bigint[]))) returning ra.id", [input.tenantId, installationId, input.observedAt, ids]);
      await client.query("update github_installations set last_inventory_at=$3,updated_at=now() where tenant_id=$1 and id=$2", [input.tenantId, installationId, input.observedAt]);
      return { observed: observed.size, added, updated, removed: absent.rowCount ?? 0 };
    });
  }

  async updateInstallationLifecycle(githubInstallationId: number, status: InstallationLifecycleStatus, now: Date): Promise<void> {
    const route = await this.pool.query<Row>("select tenant_id from installation_routes where github_installation_id=$1", [githubInstallationId]);
    const tenantId = route.rows[0]?.tenant_id;
    if (!tenantId) return;
    await this.tenantQuery(String(tenantId), async (client) => {
      const statusSql = status === "suspended" ? "suspended" : status === "active" ? "active" : status;
      await client.query("update github_installations set status=$2,suspended_at=case when $2='suspended' then $3 else null end,deleted_at=case when $2 in ('deleted','disconnected') then $3 else null end,updated_at=now() where tenant_id=$1 and github_installation_id=$4", [tenantId, statusSql, now, githubInstallationId]);
      const accessStatus = status === "suspended" ? "installation_suspended" : status === "active" ? "unavailable" : "disconnected";
      if (status === "active") await client.query("update repository_access set access_status='unavailable' where tenant_id=$1 and installation_id=(select id from github_installations where tenant_id=$1 and github_installation_id=$2)", [tenantId, githubInstallationId]);
      else await client.query("update repository_access set access_status=$2,revoked_at=$3 where tenant_id=$1 and installation_id=(select id from github_installations where tenant_id=$1 and github_installation_id=$4)", [tenantId, accessStatus, now, githubInstallationId]);
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

  async saveCommit(tenantId: string, repositoryId: string, commit: CommitFact, event?: DevelopmentEvent, htmlUrl?: string): Promise<void> {
    await this.tenantQuery(tenantId, async (client) => {
      const authorId = commit.author ? await this.ensureGithubAccount(client, commit.author.githubAccountId, commit.author.login, commit.author.accountType ?? "User", commit.author.actorKind) : undefined;
      const committerId = commit.committer ? await this.ensureGithubAccount(client, commit.committer.githubAccountId, commit.committer.login, commit.committer.accountType ?? "User", commit.committer.actorKind) : undefined;
      const eventActorId = event?.actorGithubAccountId === undefined ? undefined : await this.ensureGithubAccount(client, event.actorGithubAccountId, undefined, event.actorKind === "bot" ? "Bot" : "User", event.actorKind);
      await client.query(`insert into commits (id,tenant_id,repository_id,sha,author_github_account_id,committer_github_account_id,message,authored_at,committed_at,parent_shas,verified,additions,deletions,first_seen_at,last_seen_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),now()) on conflict (tenant_id,repository_id,sha) do update set author_github_account_id=coalesce(excluded.author_github_account_id,commits.author_github_account_id),committer_github_account_id=coalesce(excluded.committer_github_account_id,commits.committer_github_account_id),message=case when excluded.message <> '' then excluded.message else commits.message end,authored_at=coalesce(excluded.authored_at,commits.authored_at),committed_at=coalesce(excluded.committed_at,commits.committed_at),parent_shas=case when jsonb_array_length(excluded.parent_shas) > 0 then excluded.parent_shas else commits.parent_shas end,verified=coalesce(excluded.verified,commits.verified),additions=coalesce(excluded.additions,commits.additions),deletions=coalesce(excluded.deletions,commits.deletions),last_seen_at=now()`, [createId(), tenantId, repositoryId, commit.sha, authorId ?? null, committerId ?? null, commit.message, commit.authoredAt ?? null, commit.committedAt ?? null, JSON.stringify(commit.parents), commit.verified ?? null, commit.additions ?? null, commit.deletions ?? null]);
      if (event) await this.writeDevelopmentEvent(client, tenantId, repositoryId, event, eventActorId, htmlUrl, commit.message);
    });
  }

  private async writeDevelopmentEvent(client: PoolClient, tenantId: string, repositoryId: string, event: DevelopmentEvent, actorId?: string, htmlUrl?: string, message?: string): Promise<void> {
    await client.query(`insert into development_events (id,tenant_id,repository_id,source_system,source_kind,source_external_id,event_type,verb,actor_github_account_id,actor_kind,contribution_role,context_kind,occurred_at,source_updated_at,title,summary_input,source_url,completeness_state,visibility) values ($1,$2,$3,'github',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) on conflict (tenant_id,repository_id,source_system,source_kind,source_external_id,verb) do update set actor_github_account_id=coalesce(excluded.actor_github_account_id,development_events.actor_github_account_id),actor_kind=case when excluded.actor_github_account_id is not null then excluded.actor_kind else development_events.actor_kind end,contribution_role=excluded.contribution_role,context_kind=case when excluded.actor_github_account_id is not null then excluded.context_kind else development_events.context_kind end,occurred_at=excluded.occurred_at,source_updated_at=coalesce(excluded.source_updated_at,development_events.source_updated_at),summary_input=coalesce(excluded.summary_input,development_events.summary_input),source_url=coalesce(excluded.source_url,development_events.source_url),completeness_state=excluded.completeness_state,visibility=excluded.visibility`, [event.id, tenantId, repositoryId, event.sourceKind, event.sourceExternalId, event.eventType, event.verb, actorId ?? null, event.actorKind, event.contributionRole, event.contextKind, event.occurredAt, event.sourceUpdatedAt ?? null, event.title ?? null, event.summaryInput ?? message ?? null, htmlUrl ?? null, event.completenessState, event.visibility]);
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

  async listActivity(tenantId: string, repositoryId?: string): Promise<ActivityRecord[]> {
    return this.tenantQuery(tenantId, async (client) => {
      const result = await client.query<Row>(`select e.id,e.repository_id,e.source_kind,e.source_external_id,e.event_type,e.verb,ga.github_account_id as actor_github_id,e.actor_kind,e.contribution_role,e.context_kind,e.occurred_at,e.source_updated_at,e.title,e.summary_input,e.source_url,e.completeness_state,e.visibility,c.message from development_events e join repositories r on r.id=e.repository_id and r.tenant_id=e.tenant_id left join commits c on c.tenant_id=e.tenant_id and c.repository_id=e.repository_id and c.sha=e.source_external_id left join github_accounts ga on ga.id=e.actor_github_account_id where e.tenant_id=$1 ${repositoryId ? "and e.repository_id=$2" : ""} and (e.source_kind <> 'commit' or exists (select 1 from commit_refs cr join branches b on b.id=cr.branch_id where cr.tenant_id=e.tenant_id and cr.commit_id=c.id and b.repository_id=e.repository_id and b.name=r.default_branch and cr.reachable=true)) order by e.occurred_at desc limit 100`, repositoryId ? [tenantId, repositoryId] : [tenantId]);
      return result.rows.map((row) => ({ id: String(row.id), repositoryId: String(row.repository_id), sourceKind: row.source_kind as DevelopmentEvent["sourceKind"], sourceExternalId: String(row.source_external_id), eventType: String(row.event_type), verb: String(row.verb), ...(row.actor_github_id ? { actorGithubAccountId: Number(row.actor_github_id) } : {}), actorKind: row.actor_kind as DevelopmentEvent["actorKind"], contributionRole: row.contribution_role as DevelopmentEvent["contributionRole"], contextKind: row.context_kind as DevelopmentEvent["contextKind"], occurredAt: new Date(String(row.occurred_at)), ...(date(row.source_updated_at) ? { sourceUpdatedAt: date(row.source_updated_at) } : {}), ...(row.title ? { title: String(row.title) } : {}), ...(row.summary_input ? { summaryInput: String(row.summary_input) } : {}), completenessState: row.completeness_state as DevelopmentEvent["completenessState"], visibility: row.visibility as DevelopmentEvent["visibility"], ...(row.message ? { message: String(row.message) } : {}), ...(row.source_url ? { htmlUrl: String(row.source_url) } : {}) }));
    });
  }

  async assertReachable(): Promise<void> {
    await this.pool.query("select 1");
  }
}
