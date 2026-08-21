import type { Pool, PoolClient, QueryResultRow } from "pg";
import { createId, deliveryRedeliveryAction, type CommitFact, type DevelopmentEvent } from "@devmemoir/domain";
import type {
  ActivityRecord,
  AuthTransactionRecord,
  DeliveryInsertResult,
  DeliveryRecord,
  InstallationRecord,
  M1Store,
  RepositoryRecord,
  SessionRecord,
  UserRecord,
} from "./store.js";

type Row = QueryResultRow & Record<string, unknown>;

function date(value: unknown): Date | undefined {
  return value instanceof Date ? value : typeof value === "string" ? new Date(value) : undefined;
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
  return { id: String(row.id), tenantId: String(row.tenant_id), githubInstallationId: Number(row.github_installation_id), accountGithubAccountId: Number(row.account_github_account_id) };
}

function repositoryFromRow(row: Row | undefined): RepositoryRecord | undefined {
  if (!row) return undefined;
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    installationId: String(row.installation_id),
    githubRepositoryId: Number(row.github_repository_id),
    ownerLogin: String(row.owner_login),
    name: String(row.name),
    fullName: String(row.full_name),
    private: Boolean(row.private),
    ...(row.visibility ? { visibility: String(row.visibility) } : {}),
    defaultBranch: String(row.default_branch),
    ...(row.description ? { description: String(row.description) } : {}),
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

  async createHandoff(stateHash: string, handoffHash: string): Promise<void> {
    await this.pool.query("update auth_transactions set handoff_hash=$2 where state_hash=$1 and consumed_at is not null", [stateHash, handoffHash]);
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

  private async ensureGithubAccount(accountId: number, login?: string): Promise<string> {
    const result = await this.pool.query<Row>("insert into github_accounts (id,github_account_id,account_type,actor_kind,login) values ($1,$2,'User','user',$3) on conflict (github_account_id) do update set login=coalesce(excluded.login,github_accounts.login) returning id", [createId(), accountId, login ?? null]);
    return String(result.rows[0]?.id);
  }

  async saveInstallation(installation: InstallationRecord): Promise<void> {
    const accountId = await this.ensureGithubAccount(installation.accountGithubAccountId);
    await this.tenantQuery(installation.tenantId, async (client) => {
      await client.query(`insert into github_installations (id,tenant_id,github_installation_id,account_github_account_id,created_at,updated_at) values ($1,$2,$3,$4,now(),now()) on conflict (github_installation_id) do update set tenant_id=excluded.tenant_id,account_github_account_id=excluded.account_github_account_id,updated_at=now()`, [installation.id, installation.tenantId, installation.githubInstallationId, accountId]);
    });
  }

  async getInstallation(githubInstallationId: number): Promise<InstallationRecord | undefined> {
    const result = await this.pool.query<Row>("select id,tenant_id,github_installation_id,ga.github_account_id as account_github_account_id from github_installations gi join github_accounts ga on ga.id=gi.account_github_account_id where gi.github_installation_id=$1 and gi.deleted_at is null", [githubInstallationId]);
    return installationFromRow(result.rows[0]);
  }

  async listInstallations(tenantId: string): Promise<InstallationRecord[]> {
    return this.tenantQuery(tenantId, async (client) => {
      const result = await client.query<Row>("select id,tenant_id,github_installation_id,ga.github_account_id as account_github_account_id from github_installations gi join github_accounts ga on ga.id=gi.account_github_account_id where gi.tenant_id=$1 and gi.deleted_at is null", [tenantId]);
      return result.rows.map((row) => installationFromRow(row)).filter((row): row is InstallationRecord => Boolean(row));
    });
  }

  async saveRepository(repository: RepositoryRecord): Promise<void> {
    await this.tenantQuery(repository.tenantId, async (client) => {
      const result = await client.query<Row>(`insert into repositories (id,tenant_id,github_repository_id,owner_login,name,full_name,private,visibility,default_branch,description,created_at,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now()) on conflict (tenant_id,github_repository_id) do update set owner_login=excluded.owner_login,name=excluded.name,full_name=excluded.full_name,private=excluded.private,visibility=excluded.visibility,default_branch=excluded.default_branch,description=excluded.description,updated_at=now() returning id`, [repository.id, repository.tenantId, repository.githubRepositoryId, repository.ownerLogin, repository.name, repository.fullName, repository.private, repository.visibility ?? null, repository.defaultBranch, repository.description ?? null]);
      const repositoryId = String(result.rows[0]?.id ?? repository.id);
      await client.query(`insert into repository_access (id,tenant_id,repository_id,installation_id,access_status,selected_at) values ($1,$2,$3,$4,'selected',now()) on conflict (tenant_id,repository_id,installation_id) do update set access_status='selected',revoked_at=null`, [createId(), repository.tenantId, repositoryId, repository.installationId]);
    });
  }

  async getRepositoryByGithubId(tenantId: string, githubRepositoryId: number): Promise<RepositoryRecord | undefined> {
    return this.tenantQuery(tenantId, async (client) => repositoryFromRow((await client.query<Row>("select r.id,r.tenant_id,coalesce(ra.installation_id,'00000000-0000-0000-0000-000000000000') as installation_id,r.github_repository_id,r.owner_login,r.name,r.full_name,r.private,r.visibility,r.default_branch,r.description from repositories r left join lateral (select installation_id from repository_access where repository_id=r.id and tenant_id=r.tenant_id and access_status='selected' order by selected_at desc limit 1) ra on true where r.tenant_id=$1 and r.github_repository_id=$2 and r.deleted_at is null", [tenantId, githubRepositoryId])).rows[0]));
  }

  async getRepositoryById(tenantId: string, repositoryId: string): Promise<RepositoryRecord | undefined> {
    return this.tenantQuery(tenantId, async (client) => repositoryFromRow((await client.query<Row>("select r.id,r.tenant_id,coalesce(ra.installation_id,'00000000-0000-0000-0000-000000000000') as installation_id,r.github_repository_id,r.owner_login,r.name,r.full_name,r.private,r.visibility,r.default_branch,r.description from repositories r left join lateral (select installation_id from repository_access where repository_id=r.id and tenant_id=r.tenant_id and access_status='selected' order by selected_at desc limit 1) ra on true where r.tenant_id=$1 and r.id=$2 and r.deleted_at is null", [tenantId, repositoryId])).rows[0]));
  }

  async listRepositories(tenantId: string): Promise<RepositoryRecord[]> {
    return this.tenantQuery(tenantId, async (client) => {
      const result = await client.query<Row>("select r.id,r.tenant_id,coalesce(ra.installation_id,'00000000-0000-0000-0000-000000000000') as installation_id,r.github_repository_id,r.owner_login,r.name,r.full_name,r.private,r.visibility,r.default_branch,r.description from repositories r left join lateral (select installation_id from repository_access where repository_id=r.id and tenant_id=r.tenant_id and access_status='selected' order by selected_at desc limit 1) ra on true where r.tenant_id=$1 and r.deleted_at is null order by r.created_at asc", [tenantId]);
      return result.rows.map((row) => repositoryFromRow(row)).filter((row): row is RepositoryRecord => Boolean(row));
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

  async ensureJob(logicalKey: string, payload: Record<string, unknown>): Promise<string> {
    const run = async (client: PoolClient) => {
      const result = await client.query<Row>("insert into sync_jobs (id,tenant_id,kind,logical_key,payload,scheduled_at) values ($1,$2,$3,$4,$5,now()) on conflict (logical_key) do update set payload=excluded.payload returning id", [createId(), String(payload.tenantId), String(payload.kind ?? "webhook_delivery"), logicalKey, payload]);
      return String(result.rows[0]?.id);
    };
    if (!payload.tenantId) throw new Error("Tenant is required for durable jobs");
    return this.tenantQuery(String(payload.tenantId), run);
  }

  async setBranchHead(tenantId: string, repositoryId: string, ref: string, headSha: string | null): Promise<void> {
    const name = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    await this.tenantQuery(tenantId, async (client) => {
      await client.query(`insert into branches (id,tenant_id,repository_id,name,head_sha,last_seen_at) values ($1,$2,$3,$4,$5,now()) on conflict (tenant_id,repository_id,name) do update set head_sha=excluded.head_sha,last_seen_at=now(),deleted_at=case when excluded.head_sha is null then now() else null end`, [createId(), tenantId, repositoryId, name, headSha]);
    });
  }

  async getBranchHead(tenantId: string, repositoryId: string, ref: string): Promise<string | null> {
    const name = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    return this.tenantQuery(tenantId, async (client) => {
      const result = await client.query<Row>("select head_sha from branches where tenant_id=$1 and repository_id=$2 and name=$3", [tenantId, repositoryId, name]);
      return result.rows[0]?.head_sha ? String(result.rows[0].head_sha) : null;
    });
  }

  async saveCommit(tenantId: string, repositoryId: string, commit: CommitFact, event: DevelopmentEvent, htmlUrl?: string): Promise<void> {
    const authorId = commit.author ? await this.ensureGithubAccount(commit.author.githubAccountId, commit.author.login) : undefined;
    const committerId = commit.committer ? await this.ensureGithubAccount(commit.committer.githubAccountId, commit.committer.login) : undefined;
    await this.tenantQuery(tenantId, async (client) => {
      await client.query(`insert into commits (id,tenant_id,repository_id,sha,author_github_account_id,committer_github_account_id,message,authored_at,committed_at,parent_shas,verified,additions,deletions,first_seen_at,last_seen_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),now()) on conflict (tenant_id,repository_id,sha) do update set author_github_account_id=excluded.author_github_account_id,committer_github_account_id=excluded.committer_github_account_id,message=excluded.message,authored_at=excluded.authored_at,committed_at=excluded.committed_at,parent_shas=excluded.parent_shas,verified=excluded.verified,additions=excluded.additions,deletions=excluded.deletions,last_seen_at=now()`, [createId(), tenantId, repositoryId, commit.sha, authorId ?? null, committerId ?? null, commit.message, commit.authoredAt ?? null, commit.committedAt ?? null, JSON.stringify(commit.parents), commit.verified ?? null, commit.additions ?? null, commit.deletions ?? null]);
      await client.query(`insert into development_events (id,tenant_id,repository_id,source_system,source_kind,source_external_id,event_type,verb,actor_github_account_id,actor_kind,contribution_role,context_kind,occurred_at,source_updated_at,title,summary_input,completeness_state,visibility) values ($1,$2,$3,'github',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) on conflict (tenant_id,repository_id,source_system,source_kind,source_external_id,verb) do update set actor_github_account_id=excluded.actor_github_account_id,actor_kind=excluded.actor_kind,occurred_at=excluded.occurred_at,summary_input=excluded.summary_input`, [event.id, tenantId, repositoryId, event.sourceKind, event.sourceExternalId, event.eventType, event.verb, event.actorGithubAccountId ? await this.ensureGithubAccount(event.actorGithubAccountId) : null, event.actorKind, event.contributionRole, event.contextKind, event.occurredAt, event.sourceUpdatedAt ?? null, event.title ?? null, event.summaryInput ?? null, event.completenessState, event.visibility]);
      void htmlUrl;
    });
  }

  async listActivity(tenantId: string, repositoryId?: string): Promise<ActivityRecord[]> {
    return this.tenantQuery(tenantId, async (client) => {
      const result = await client.query<Row>(`select e.id,e.repository_id,e.source_kind,e.source_external_id,e.event_type,e.verb,e.actor_github_account_id,e.actor_kind,e.contribution_role,e.context_kind,e.occurred_at,e.source_updated_at,e.title,e.summary_input,e.completeness_state,e.visibility,c.message from development_events e left join commits c on c.tenant_id=e.tenant_id and c.repository_id=e.repository_id and c.sha=e.source_external_id where e.tenant_id=$1 ${repositoryId ? "and e.repository_id=$2" : ""} order by e.occurred_at desc limit 100`, repositoryId ? [tenantId, repositoryId] : [tenantId]);
      return result.rows.map((row) => ({ id: String(row.id), repositoryId: String(row.repository_id), sourceKind: row.source_kind as DevelopmentEvent["sourceKind"], sourceExternalId: String(row.source_external_id), eventType: String(row.event_type), verb: String(row.verb), ...(row.actor_github_account_id ? { actorGithubAccountId: Number(row.actor_github_account_id) } : {}), actorKind: row.actor_kind as DevelopmentEvent["actorKind"], contributionRole: row.contribution_role as DevelopmentEvent["contributionRole"], contextKind: row.context_kind as DevelopmentEvent["contextKind"], occurredAt: new Date(String(row.occurred_at)), ...(date(row.source_updated_at) ? { sourceUpdatedAt: date(row.source_updated_at) } : {}), ...(row.title ? { title: String(row.title) } : {}), ...(row.summary_input ? { summaryInput: String(row.summary_input) } : {}), completenessState: row.completeness_state as DevelopmentEvent["completenessState"], visibility: row.visibility as DevelopmentEvent["visibility"], ...(row.message ? { message: String(row.message) } : {}) }));
    });
  }

  async assertReachable(): Promise<void> {
    await this.pool.query("select 1");
  }
}
