import {
  createId,
  deliveryRedeliveryAction,
  type CommitFact,
  type DeliveryState,
  type DevelopmentEvent,
} from "@devmemoir/domain";

export type AuthTransactionRecord = {
  id: string;
  stateHash: string;
  codeVerifierCiphertext: string;
  returnPath: string;
  expiresAt: Date;
  githubAccountId?: number;
  userId?: string;
  handoffHash?: string;
  consumedAt?: Date;
  handoffConsumedAt?: Date;
};

export type UserRecord = {
  userId: string;
  tenantId: string;
  githubAccountId: number;
  login: string;
  displayName: string;
};

export type SessionRecord = {
  userId: string;
  tenantId: string;
  tokenHash: string;
  csrfTokenHash: string;
  expiresAt: Date;
  revokedAt?: Date;
};

export type InstallationRecord = {
  id: string;
  tenantId: string;
  githubInstallationId: number;
  accountGithubAccountId: number;
};

export type RepositoryRecord = {
  id: string;
  tenantId: string;
  installationId: string;
  githubRepositoryId: number;
  ownerLogin: string;
  name: string;
  fullName: string;
  private: boolean;
  visibility?: string;
  defaultBranch: string;
  description?: string;
  htmlUrl?: string;
};

export type DeliveryRecord = {
  id: string;
  tenantId?: string;
  guid: string;
  eventName: string;
  action?: string;
  installationGithubId?: number;
  repositoryGithubId?: number;
  ref?: string;
  before?: string;
  after?: string;
  forced?: boolean;
  payloadCiphertext?: string;
  state: DeliveryState;
  firstReceivedAt: Date;
  lastReceivedAt: Date;
  receiptCount: number;
  processingAttempts: number;
  jobId?: string;
  errorCode?: string;
  processedAt?: Date;
  payloadExpiresAt: Date;
};

export type ActivityRecord = DevelopmentEvent & {
  htmlUrl?: string;
  message?: string;
};

export type DeliveryInsertResult = {
  record: DeliveryRecord;
  created: boolean;
  action: ReturnType<typeof deliveryRedeliveryAction>;
};

export interface M1Store {
  createAuthTransaction(record: AuthTransactionRecord): Promise<void>;
  consumeAuthState(stateHash: string, now: Date): Promise<AuthTransactionRecord | undefined>;
  attachAuthUser(stateHash: string, user: UserRecord): Promise<void>;
  createHandoff(stateHash: string, handoffHash: string): Promise<void>;
  consumeHandoff(handoffHash: string, now: Date): Promise<UserRecord | undefined>;
  createSession(session: SessionRecord): Promise<void>;
  getSession(tokenHash: string, now: Date): Promise<SessionRecord | undefined>;
  upsertUser(user: UserRecord): Promise<void>;
  getUserById(userId: string): Promise<UserRecord | undefined>;
  getUserByGithubAccountId(githubAccountId: number): Promise<UserRecord | undefined>;
  saveInstallation(installation: InstallationRecord): Promise<void>;
  getInstallation(githubInstallationId: number): Promise<InstallationRecord | undefined>;
  listInstallations(tenantId: string): Promise<InstallationRecord[]>;
  saveRepository(repository: RepositoryRecord): Promise<void>;
  getRepositoryByGithubId(tenantId: string, githubRepositoryId: number): Promise<RepositoryRecord | undefined>;
  getRepositoryById(tenantId: string, repositoryId: string): Promise<RepositoryRecord | undefined>;
  listRepositories(tenantId: string): Promise<RepositoryRecord[]>;
  insertDelivery(input: Omit<DeliveryRecord, "id" | "state" | "firstReceivedAt" | "lastReceivedAt" | "receiptCount" | "processingAttempts"> & { now: Date }): Promise<DeliveryInsertResult>;
  updateDelivery(id: string, patch: Partial<DeliveryRecord>, tenantId?: string): Promise<void>;
  getDelivery(id: string, tenantId?: string): Promise<DeliveryRecord | undefined>;
  ensureJob(logicalKey: string, payload: Record<string, unknown>): Promise<string>;
  setBranchHead(tenantId: string, repositoryId: string, ref: string, headSha: string | null): Promise<void>;
  getBranchHead(tenantId: string, repositoryId: string, ref: string): Promise<string | null>;
  saveCommit(tenantId: string, repositoryId: string, commit: CommitFact, event: DevelopmentEvent, htmlUrl?: string): Promise<void>;
  listActivity(tenantId: string, repositoryId?: string): Promise<ActivityRecord[]>;
}

export class InMemoryM1Store implements M1Store {
  readonly authTransactions = new Map<string, AuthTransactionRecord>();
  readonly users = new Map<string, UserRecord>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly installations = new Map<number, InstallationRecord>();
  readonly repositories = new Map<string, RepositoryRecord>();
  readonly deliveries = new Map<string, DeliveryRecord>();
  readonly jobs = new Map<string, { id: string; logicalKey: string; payload: Record<string, unknown> }>();
  readonly branchHeads = new Map<string, string | null>();
  readonly commits = new Map<string, { tenantId: string; repositoryId: string; commit: CommitFact; htmlUrl?: string }>();
  readonly events: ActivityRecord[] = [];

  async createAuthTransaction(record: AuthTransactionRecord): Promise<void> { this.authTransactions.set(record.stateHash, { ...record }); }

  async consumeAuthState(stateHash: string, now: Date): Promise<AuthTransactionRecord | undefined> {
    const transaction = this.authTransactions.get(stateHash);
    if (!transaction || transaction.consumedAt || transaction.expiresAt <= now) return undefined;
    transaction.consumedAt = now;
    return { ...transaction };
  }

  async attachAuthUser(stateHash: string, user: UserRecord): Promise<void> {
    const transaction = this.authTransactions.get(stateHash);
    if (!transaction) throw new Error("Auth transaction not found");
    transaction.githubAccountId = user.githubAccountId;
    transaction.userId = user.userId;
    await this.upsertUser(user);
  }

  async createHandoff(stateHash: string, handoffHash: string): Promise<void> {
    const transaction = this.authTransactions.get(stateHash);
    if (!transaction) throw new Error("Auth transaction not found");
    transaction.handoffHash = handoffHash;
  }

  async consumeHandoff(handoffHash: string, now: Date): Promise<UserRecord | undefined> {
    const transaction = [...this.authTransactions.values()].find((value) => value.handoffHash === handoffHash);
    if (!transaction || transaction.handoffConsumedAt || transaction.expiresAt <= now || !transaction.userId) return undefined;
    transaction.handoffConsumedAt = now;
    return this.users.get(transaction.userId);
  }

  async createSession(session: SessionRecord): Promise<void> { this.sessions.set(session.tokenHash, { ...session }); }
  async getSession(tokenHash: string, now: Date): Promise<SessionRecord | undefined> {
    const session = this.sessions.get(tokenHash);
    if (!session || session.revokedAt || session.expiresAt <= now) return undefined;
    return { ...session };
  }
  async upsertUser(user: UserRecord): Promise<void> { this.users.set(user.userId, { ...user }); }
  async getUserById(userId: string): Promise<UserRecord | undefined> { return this.users.get(userId); }
  async getUserByGithubAccountId(githubAccountId: number): Promise<UserRecord | undefined> { return [...this.users.values()].find((user) => user.githubAccountId === githubAccountId); }
  async saveInstallation(installation: InstallationRecord): Promise<void> { this.installations.set(installation.githubInstallationId, { ...installation }); }
  async getInstallation(githubInstallationId: number): Promise<InstallationRecord | undefined> { return this.installations.get(githubInstallationId); }
  async listInstallations(tenantId: string): Promise<InstallationRecord[]> { return [...this.installations.values()].filter((installation) => installation.tenantId === tenantId).map((installation) => ({ ...installation })); }
  async saveRepository(repository: RepositoryRecord): Promise<void> { this.repositories.set(`${repository.tenantId}:${repository.githubRepositoryId}`, { ...repository }); }
  async getRepositoryByGithubId(tenantId: string, githubRepositoryId: number): Promise<RepositoryRecord | undefined> { return this.repositories.get(`${tenantId}:${githubRepositoryId}`); }
  async getRepositoryById(tenantId: string, repositoryId: string): Promise<RepositoryRecord | undefined> { return [...this.repositories.values()].find((repository) => repository.tenantId === tenantId && repository.id === repositoryId); }
  async listRepositories(tenantId: string): Promise<RepositoryRecord[]> { return [...this.repositories.values()].filter((repository) => repository.tenantId === tenantId).map((repository) => ({ ...repository })); }

  async insertDelivery(input: Omit<DeliveryRecord, "id" | "state" | "firstReceivedAt" | "lastReceivedAt" | "receiptCount" | "processingAttempts"> & { now: Date }): Promise<DeliveryInsertResult> {
    const existing = this.deliveries.get(input.guid);
    if (existing) {
      existing.lastReceivedAt = input.now;
      existing.receiptCount += 1;
      return { record: { ...existing }, created: false, action: deliveryRedeliveryAction(existing.state) };
    }
    const record: DeliveryRecord = {
      ...input,
      id: createId(),
      state: "received",
      firstReceivedAt: input.now,
      lastReceivedAt: input.now,
      receiptCount: 1,
      processingAttempts: 0,
    };
    this.deliveries.set(record.guid, record);
    return { record: { ...record }, created: true, action: "ensure_job" };
  }

  async updateDelivery(id: string, patch: Partial<DeliveryRecord>, _tenantId?: string): Promise<void> {
    const delivery = [...this.deliveries.values()].find((value) => value.id === id);
    if (!delivery) throw new Error("Delivery not found");
    Object.assign(delivery, patch);
  }
  async getDelivery(id: string, _tenantId?: string): Promise<DeliveryRecord | undefined> { return [...this.deliveries.values()].find((value) => value.id === id); }
  async ensureJob(logicalKey: string, payload: Record<string, unknown>): Promise<string> {
    const existing = this.jobs.get(logicalKey);
    if (existing) return existing.id;
    const job = { id: createId(), logicalKey, payload };
    this.jobs.set(logicalKey, job);
    return job.id;
  }
  async setBranchHead(tenantId: string, repositoryId: string, ref: string, headSha: string | null): Promise<void> { this.branchHeads.set(`${tenantId}:${repositoryId}:${ref}`, headSha); }
  async getBranchHead(tenantId: string, repositoryId: string, ref: string): Promise<string | null> { return this.branchHeads.get(`${tenantId}:${repositoryId}:${ref}`) ?? null; }
  async saveCommit(tenantId: string, repositoryId: string, commit: CommitFact, event: DevelopmentEvent, htmlUrl?: string): Promise<void> {
    this.commits.set(`${tenantId}:${repositoryId}:${commit.sha}`, { tenantId, repositoryId, commit, ...(htmlUrl ? { htmlUrl } : {}) });
    const existing = this.events.find((value) => value.repositoryId === repositoryId && value.sourceKind === event.sourceKind && value.sourceExternalId === event.sourceExternalId && value.verb === event.verb);
    if (!existing) this.events.push({ ...event, ...(htmlUrl ? { htmlUrl } : {}), message: commit.message });
  }
  async listActivity(tenantId: string, repositoryId?: string): Promise<ActivityRecord[]> {
    return this.events.filter((event) => (!repositoryId || event.repositoryId === repositoryId) && [...this.repositories.values()].some((repository) => repository.tenantId === tenantId && repository.id === event.repositoryId)).sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  }
}

