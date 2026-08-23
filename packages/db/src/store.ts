import {
  createId,
  deliveryRedeliveryAction,
  repositoryAccessIsAvailable,
  type CommitFact,
  type ActorKind,
  type CompletenessState,
  type DeliveryState,
  type DevelopmentEvent,
  type RepositoryAccessStatus,
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
  permissions?: Record<string, string>;
  repositorySelection?: string;
  status?: "active" | "suspended" | "deleted" | "disconnected";
  suspendedAt?: Date;
  deletedAt?: Date;
  lastInventoryAt?: Date;
  apiPausedUntil?: Date;
  apiPauseReason?: string;
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
  nodeId?: string;
  visibility?: string;
  defaultBranch: string;
  description?: string;
  htmlUrl?: string;
  archived?: boolean;
  disabled?: boolean;
  selected?: boolean;
  accessStatus?: RepositoryAccessStatus;
  firstSeenAt?: Date;
  lastSeenAt?: Date;
  lastAuthoritativeObservedAt?: Date;
  revokedAt?: Date;
  githubCreatedAt?: Date;
  githubUpdatedAt?: Date;
  githubPushedAt?: Date;
};

export type InventoryReconcileResult = {
  observed: number;
  added: number;
  updated: number;
  removed: number;
};

export type InstallationLifecycleStatus = "active" | "suspended" | "deleted" | "disconnected";

export class RepositorySelectionError extends Error {
  constructor(message = "Only one repository can be selected in M1") {
    super(message);
    this.name = "RepositorySelectionError";
    Object.defineProperty(this, "code", { value: "one_repository_only", enumerable: true });
  }
}

export class InstallationResolutionError extends Error {
  constructor(message = "Multiple active installations found for tenant") {
    super(message);
    this.name = "InstallationResolutionError";
    Object.defineProperty(this, "code", { value: "multiple_active_installations", enumerable: true });
  }
}

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
  /** A real pg-boss UUID; null clears a stale owner after a restart/race. */
  jobId?: string | null;
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

export type UnroutedWebhookRecord = {
  guid: string;
  eventName: string;
  payloadCiphertext: string;
  receivedAt: Date;
  payloadExpiresAt: Date;
};

export type RefSyncContinuation = {
  after: string;
  previousHead: string | null;
  nextPage: number;
  forced: boolean;
  reachableShas?: string[];
};

export const HISTORICAL_STAGES = [
  "default_branch_commits",
  "branches",
  "tags",
  "pull_requests",
  "issues",
  "releases",
  "completed",
] as const;
export type HistoricalStage = (typeof HISTORICAL_STAGES)[number];
export type HistoricalSourceStage = Exclude<HistoricalStage, "completed">;
export type HistoricalStageStatus = "pending" | "in_progress" | "paused" | "completed";

export type HistoricalCursor = {
  nextPage: number;
  [key: string]: unknown;
};

export type HistoricalProgress = {
  tenantId: string;
  repositoryId: string;
  stage: HistoricalStage;
  refName: string;
  status: HistoricalStageStatus;
  cursor: HistoricalCursor;
  nextPage: number;
  anchorHeadSha?: string;
  highWaterAt?: Date;
  startedAt?: Date;
  observationStartedAt?: Date;
  lastSuccessAt?: Date;
  completedAt?: Date;
  pausedUntil?: Date;
  errorCode?: string;
  completenessState: CompletenessState;
};

export type HistoricalActor = {
  githubAccountId: number;
  login?: string;
  accountType?: string;
  actorKind: ActorKind;
};

export type HistoricalBranchFact = {
  name: string;
  headSha: string;
  protected: boolean;
};

export type HistoricalTagFact = {
  name: string;
  targetSha: string;
  targetType?: string;
};

export type HistoricalPullRequestFact = {
  githubId: number;
  number: number;
  title: string;
  state: string;
  draft: boolean;
  author?: HistoricalActor;
  merger?: HistoricalActor;
  baseRef?: string;
  baseSha?: string;
  headRef?: string;
  headSha?: string;
  sourceUrl?: string;
  createdAt: Date;
  updatedAt: Date;
  closedAt?: Date;
  mergedAt?: Date;
};

export type HistoricalIssueFact = {
  githubId: number;
  number: number;
  title: string;
  state: string;
  stateReason?: string;
  author?: HistoricalActor;
  sourceUrl?: string;
  createdAt: Date;
  updatedAt: Date;
  closedAt?: Date;
};

export type HistoricalReleaseFact = {
  githubId: number;
  tagName: string;
  name?: string;
  draft: boolean;
  prerelease: boolean;
  author?: HistoricalActor;
  sourceUrl?: string;
  createdAt: Date;
  updatedAt: Date;
  publishedAt?: Date;
};

type HistoricalPageBase = {
  tenantId: string;
  repositoryId: string;
  installationId: string;
  expectedCursor: HistoricalCursor;
  nextCursor: HistoricalCursor;
  observedAt: Date;
  highWaterAt?: Date;
  finalPage: boolean;
};

export type HistoricalPageCommit =
  | (HistoricalPageBase & { stage: "default_branch_commits"; refName: string; anchorHeadSha: string; facts: Array<{ commit: CommitFact; event?: DevelopmentEvent; htmlUrl?: string }> })
  | (HistoricalPageBase & { stage: "branches"; facts: HistoricalBranchFact[] })
  | (HistoricalPageBase & { stage: "tags"; facts: HistoricalTagFact[] })
  | (HistoricalPageBase & { stage: "pull_requests"; facts: HistoricalPullRequestFact[] })
  | (HistoricalPageBase & { stage: "issues"; facts: HistoricalIssueFact[] })
  | (HistoricalPageBase & { stage: "releases"; facts: HistoricalReleaseFact[] });

export type HistoricalPageCommitResult = {
  applied: boolean;
  reason?: "checkpoint_mismatch" | "gated";
  progress: HistoricalProgress;
};

export type HistoricalSourceCounts = {
  commits: number;
  branches: number;
  tags: number;
  pullRequests: number;
  issues: number;
  releases: number;
};

function branchName(ref: string): string {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("heads/")) return ref.slice("heads/".length);
  return ref;
}

function nextHistoricalStage(stage: HistoricalSourceStage): HistoricalStage {
  const index = HISTORICAL_STAGES.indexOf(stage);
  return HISTORICAL_STAGES[index + 1] ?? "completed";
}

export interface M1Store {
  createAuthTransaction(record: AuthTransactionRecord): Promise<void>;
  consumeAuthState(stateHash: string, now: Date): Promise<AuthTransactionRecord | undefined>;
  attachAuthUser(stateHash: string, user: UserRecord): Promise<void>;
  createHandoff(stateHash: string, handoffHash: string, expiresAt?: Date): Promise<void>;
  consumeHandoff(handoffHash: string, now: Date): Promise<UserRecord | undefined>;
  createSession(session: SessionRecord): Promise<void>;
  getSession(tokenHash: string, now: Date): Promise<SessionRecord | undefined>;
  upsertUser(user: UserRecord): Promise<void>;
  getUserById(userId: string): Promise<UserRecord | undefined>;
  getUserByGithubAccountId(githubAccountId: number): Promise<UserRecord | undefined>;
  saveInstallation(installation: InstallationRecord): Promise<void>;
  updateInstallationSnapshot(input: { tenantId: string; githubInstallationId: number; permissions?: Record<string, string>; repositorySelection?: string }): Promise<void>;
  getInstallation(githubInstallationId: number): Promise<InstallationRecord | undefined>;
  listInstallations(tenantId: string): Promise<InstallationRecord[]>;
  getActiveInstallationForTenant(tenantId: string): Promise<InstallationRecord | undefined>;
  saveRepository(repository: RepositoryRecord): Promise<RepositoryRecord>;
  getRepositoryByGithubId(tenantId: string, githubRepositoryId: number): Promise<RepositoryRecord | undefined>;
  getRepositoryById(tenantId: string, repositoryId: string): Promise<RepositoryRecord | undefined>;
  getRepositoryByFullName(tenantId: string, fullName: string): Promise<RepositoryRecord | undefined>;
  listRepositories(tenantId: string): Promise<RepositoryRecord[]>;
  listRepositoryInventory(tenantId: string, installationId?: string): Promise<RepositoryRecord[]>;
  selectRepository(tenantId: string, repositoryId: string): Promise<RepositoryRecord | undefined>;
  unselectRepository(tenantId: string, repositoryId: string): Promise<RepositoryRecord | undefined>;
  reconcileInstallationInventory(input: { tenantId: string; githubInstallationId: number; repositories: RepositoryRecord[]; observedAt: Date }): Promise<InventoryReconcileResult>;
  updateInstallationLifecycle(githubInstallationId: number, status: InstallationLifecycleStatus, now: Date): Promise<void>;
  insertDelivery(input: Omit<DeliveryRecord, "id" | "state" | "firstReceivedAt" | "lastReceivedAt" | "receiptCount" | "processingAttempts"> & { now: Date }): Promise<DeliveryInsertResult>;
  recordUnroutedWebhook(record: UnroutedWebhookRecord): Promise<void>;
  updateDelivery(id: string, patch: Partial<DeliveryRecord>, tenantId?: string): Promise<void>;
  getDelivery(id: string, tenantId?: string): Promise<DeliveryRecord | undefined>;
  /** Claim one non-terminal delivery without reopening processed/ignored work. */
  claimDeliveryForProcessing(id: string, tenantId?: string): Promise<DeliveryRecord | undefined>;
  ensureJob(logicalKey: string, payload: Record<string, unknown>): Promise<string>;
  setBranchHead(tenantId: string, repositoryId: string, ref: string, headSha: string | null): Promise<void>;
  getBranchHead(tenantId: string, repositoryId: string, ref: string): Promise<string | null>;
  /** Atomically publish a completed walk only when the observed head is still current. */
  finalizeRefSync(input: { tenantId: string; repositoryId: string; ref: string; expectedHead: string | null; headSha: string | null; invalidatePrevious: boolean; reachableShas: string[] }): Promise<boolean>;
  /** Persist the source fact even when no event can be projected for it. */
  saveCommit(tenantId: string, repositoryId: string, commit: CommitFact, event?: DevelopmentEvent, htmlUrl?: string): Promise<void>;
  saveDevelopmentEvent(tenantId: string, repositoryId: string, event: DevelopmentEvent, options?: { htmlUrl?: string; message?: string }): Promise<void>;
  getRefSyncContinuation(tenantId: string, repositoryId: string, ref: string): Promise<RefSyncContinuation | undefined>;
  setRefSyncContinuation(tenantId: string, repositoryId: string, ref: string, continuation: RefSyncContinuation): Promise<void>;
  clearRefSyncContinuation(tenantId: string, repositoryId: string, ref: string): Promise<void>;
  markBranchCommitsUnreachable(tenantId: string, repositoryId: string, ref: string): Promise<void>;
  setCommitReachability(tenantId: string, repositoryId: string, ref: string, sha: string, reachable: boolean): Promise<void>;
  listActivity(tenantId: string, repositoryId?: string): Promise<ActivityRecord[]>;
  startHistoricalBackfill(input: { tenantId: string; repositoryId: string; installationId: string; defaultBranch: string; now: Date }): Promise<HistoricalProgress>;
  getHistoricalProgress(tenantId: string, repositoryId: string, stage: HistoricalStage, refName?: string): Promise<HistoricalProgress | undefined>;
  listHistoricalProgress(tenantId: string, repositoryId: string): Promise<HistoricalProgress[]>;
  resetCommitTraversal(input: { tenantId: string; repositoryId: string; installationId: string; refName: string; anchorHeadSha: string; now: Date }): Promise<HistoricalProgress | undefined>;
  commitHistoricalPage(input: HistoricalPageCommit): Promise<HistoricalPageCommitResult>;
  pauseHistoricalStage(input: { tenantId: string; repositoryId: string; stage: HistoricalSourceStage; refName?: string; pausedUntil?: Date; errorCode: string }): Promise<HistoricalProgress | undefined>;
  resumeHistoricalStage(input: { tenantId: string; repositoryId: string; stage: HistoricalSourceStage; refName?: string; now: Date }): Promise<HistoricalProgress | undefined>;
  pauseInstallationApi(input: { tenantId: string; installationId: string; pausedUntil: Date; reason: string }): Promise<void>;
  resumeInstallationApi(input: { tenantId: string; installationId: string; now: Date }): Promise<void>;
  getHistoricalSourceCounts(tenantId: string, repositoryId: string): Promise<HistoricalSourceCounts>;
}

export class InMemoryM1Store implements M1Store {
  readonly authTransactions = new Map<string, AuthTransactionRecord>();
  readonly users = new Map<string, UserRecord>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly installations = new Map<number, InstallationRecord>();
  readonly repositories = new Map<string, RepositoryRecord>();
  readonly repositoryNameHistory: Array<{ tenantId: string; repositoryId: string; ownerLogin: string; name: string; fullName: string; validFrom: Date; validTo?: Date }> = [];
  readonly deliveries = new Map<string, DeliveryRecord>();
  readonly jobs = new Map<string, { id: string; logicalKey: string; payload: Record<string, unknown> }>();
  readonly branchHeads = new Map<string, string | null>();
  readonly commits = new Map<string, { tenantId: string; repositoryId: string; commit: CommitFact; htmlUrl?: string }>();
  readonly events: ActivityRecord[] = [];
  readonly eventKeys = new Set<string>();
  readonly unroutedWebhooks = new Map<string, UnroutedWebhookRecord>();
  readonly refSyncContinuations = new Map<string, RefSyncContinuation>();
  readonly commitReachability = new Map<string, boolean>();
  readonly historicalProgress = new Map<string, HistoricalProgress>();
  readonly historicalBranches = new Map<string, HistoricalBranchFact & { reachable: boolean; generation: Date }>();
  readonly historicalTags = new Map<string, HistoricalTagFact & { reachable: boolean; generation: Date }>();
  readonly historicalPullRequests = new Map<string, HistoricalPullRequestFact>();
  readonly historicalIssues = new Map<string, HistoricalIssueFact>();
  readonly historicalReleases = new Map<string, HistoricalReleaseFact>();

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

  async createHandoff(stateHash: string, handoffHash: string, expiresAt?: Date): Promise<void> {
    const transaction = this.authTransactions.get(stateHash);
    if (!transaction) throw new Error("Auth transaction not found");
    transaction.handoffHash = handoffHash;
    if (expiresAt) transaction.expiresAt = expiresAt;
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
  async saveInstallation(installation: InstallationRecord): Promise<void> {
    const previous = this.installations.get(installation.githubInstallationId);
    const saved: InstallationRecord = {
      ...previous,
      ...installation,
      status: "active",
    };
    delete saved.suspendedAt;
    delete saved.deletedAt;
    this.installations.set(installation.githubInstallationId, saved);
  }
  async updateInstallationSnapshot(input: { tenantId: string; githubInstallationId: number; permissions?: Record<string, string>; repositorySelection?: string }): Promise<void> {
    const installation = this.installations.get(input.githubInstallationId);
    if (!installation || installation.tenantId !== input.tenantId) throw new Error("Installation not found for snapshot update");
    this.installations.set(input.githubInstallationId, { ...installation, ...(input.permissions ? { permissions: input.permissions } : {}), ...(input.repositorySelection ? { repositorySelection: input.repositorySelection } : {}) });
  }
  async getInstallation(githubInstallationId: number): Promise<InstallationRecord | undefined> { return this.installations.get(githubInstallationId); }
  async listInstallations(tenantId: string): Promise<InstallationRecord[]> { return [...this.installations.values()].filter((installation) => installation.tenantId === tenantId).map((installation) => ({ ...installation })); }
  async getActiveInstallationForTenant(tenantId: string): Promise<InstallationRecord | undefined> {
    const active = [...this.installations.values()].filter((installation) => installation.tenantId === tenantId && (!installation.status || installation.status === "active"));
    if (active.length > 1) throw new InstallationResolutionError();
    return active[0] ? { ...active[0] } : undefined;
  }
  async saveRepository(repository: RepositoryRecord): Promise<RepositoryRecord> {
    const key = `${repository.tenantId}:${repository.githubRepositoryId}`;
    const previous = this.repositories.get(key);
    const saved = { ...previous, ...repository, selected: true, accessStatus: "accessible" as const, firstSeenAt: previous?.firstSeenAt ?? repository.firstSeenAt ?? new Date() };
    this.repositories.set(key, saved);
    return { ...saved };
  }
  async getRepositoryByGithubId(tenantId: string, githubRepositoryId: number): Promise<RepositoryRecord | undefined> {
    const installation = await this.getActiveInstallationForTenant(tenantId);
    const value = this.repositories.get(`${tenantId}:${githubRepositoryId}`);
    return value && installation?.id === value.installationId ? { ...value } : undefined;
  }
  async getRepositoryById(tenantId: string, repositoryId: string): Promise<RepositoryRecord | undefined> {
    const installation = await this.getActiveInstallationForTenant(tenantId);
    const value = [...this.repositories.values()].find((repository) => repository.tenantId === tenantId && repository.id === repositoryId && repository.installationId === installation?.id);
    return value ? { ...value } : undefined;
  }
  async getRepositoryByFullName(tenantId: string, fullName: string): Promise<RepositoryRecord | undefined> {
    const installation = await this.getActiveInstallationForTenant(tenantId);
    const value = [...this.repositories.values()].find((repository) => repository.tenantId === tenantId && repository.fullName === fullName && repository.installationId === installation?.id);
    return value ? { ...value } : undefined;
  }
  async listRepositories(tenantId: string): Promise<RepositoryRecord[]> {
    const installation = await this.getActiveInstallationForTenant(tenantId);
    if (!installation) return [];
    return [...this.repositories.values()].filter((repository) => repository.tenantId === tenantId && repository.installationId === installation.id && repository.selected === true && (!repository.accessStatus || repositoryAccessIsAvailable(repository.accessStatus))).map((repository) => ({ ...repository }));
  }
  async listRepositoryInventory(tenantId: string, installationId?: string): Promise<RepositoryRecord[]> { return [...this.repositories.values()].filter((repository) => repository.tenantId === tenantId && (!installationId || repository.installationId === installationId)).map((repository) => ({ ...repository })).sort((a, b) => a.fullName.localeCompare(b.fullName)); }
  async selectRepository(tenantId: string, repositoryId: string): Promise<RepositoryRecord | undefined> {
    const repository = await this.getRepositoryById(tenantId, repositoryId);
    if (!repository) return undefined;
    const installation = await this.getActiveInstallationForTenant(tenantId);
    if (!installation || installation.id !== repository.installationId) return undefined;
    if (repository.accessStatus && !repositoryAccessIsAvailable(repository.accessStatus)) return undefined;
    const other = [...this.repositories.values()].find((value) => value.tenantId === tenantId && value.installationId === installation.id && value.id !== repositoryId && value.selected === true);
    if (other) throw new RepositorySelectionError();
    const { revokedAt: _revokedAt, ...withoutRevokedAt } = repository;
    const updated: RepositoryRecord = { ...withoutRevokedAt, selected: true, accessStatus: "accessible" };
    this.repositories.set(`${tenantId}:${repository.githubRepositoryId}`, updated);
    return { ...updated };
  }
  async unselectRepository(tenantId: string, repositoryId: string): Promise<RepositoryRecord | undefined> {
    const repository = await this.getRepositoryById(tenantId, repositoryId);
    if (!repository) return undefined;
    if (repository.accessStatus && !repositoryAccessIsAvailable(repository.accessStatus)) {
      const updated = { ...repository, selected: false };
      this.repositories.set(`${tenantId}:${repository.githubRepositoryId}`, updated);
      return { ...updated };
    }
    const updated = { ...repository, selected: false, accessStatus: "accessible" as const };
    this.repositories.set(`${tenantId}:${repository.githubRepositoryId}`, updated);
    return { ...updated };
  }
  async reconcileInstallationInventory(input: { tenantId: string; githubInstallationId: number; repositories: RepositoryRecord[]; observedAt: Date }): Promise<InventoryReconcileResult> {
    const installation = this.installations.get(input.githubInstallationId);
    if (!installation || installation.tenantId !== input.tenantId) throw new Error("Installation not found for inventory reconciliation");
    if (installation.lastInventoryAt && installation.lastInventoryAt >= input.observedAt) return { observed: input.repositories.length, added: 0, updated: 0, removed: 0 };
    const observed = new Map<number, RepositoryRecord>();
    for (const candidate of input.repositories) observed.set(candidate.githubRepositoryId, candidate);
    let added = 0;
    let updated = 0;
    for (const candidate of observed.values()) {
      const key = `${input.tenantId}:${candidate.githubRepositoryId}`;
      const previous = this.repositories.get(key);
      const wasSelected = previous?.selected === true;
      if (previous && (previous.ownerLogin !== candidate.ownerLogin || previous.name !== candidate.name || previous.fullName !== candidate.fullName)) {
        const previousHistory = this.repositoryNameHistory.filter((entry) => entry.tenantId === input.tenantId && entry.repositoryId === previous.id).sort((left, right) => (right.validTo?.getTime() ?? 0) - (left.validTo?.getTime() ?? 0))[0];
        this.repositoryNameHistory.push({ tenantId: input.tenantId, repositoryId: previous.id, ownerLogin: previous.ownerLogin, name: previous.name, fullName: previous.fullName, validFrom: previousHistory?.validTo ?? previous.firstSeenAt ?? input.observedAt, validTo: input.observedAt });
      }
      const { revokedAt: _revokedAt, ...withoutRevokedAt } = previous ?? {};
      const saved: RepositoryRecord = {
        ...withoutRevokedAt,
        ...candidate,
        id: previous?.id ?? candidate.id,
        tenantId: input.tenantId,
        installationId: installation.id,
        selected: wasSelected,
        accessStatus: "accessible",
        firstSeenAt: previous?.firstSeenAt ?? candidate.firstSeenAt ?? input.observedAt,
        lastSeenAt: input.observedAt,
        lastAuthoritativeObservedAt: input.observedAt,
      };
      this.repositories.set(key, saved);
      if (previous) updated += 1; else added += 1;
    }
    let removed = 0;
    for (const [key, repository] of this.repositories.entries()) {
      if (repository.tenantId !== input.tenantId || repository.installationId !== installation.id || repository.accessStatus === "access_removed" || repository.accessStatus === "disconnected") continue;
      if (observed.has(repository.githubRepositoryId)) continue;
      this.repositories.set(key, { ...repository, accessStatus: "access_removed", selected: false, revokedAt: input.observedAt });
      removed += 1;
    }
    this.installations.set(input.githubInstallationId, { ...installation, lastInventoryAt: input.observedAt });
    return { observed: observed.size, added, updated, removed };
  }
  async updateInstallationLifecycle(githubInstallationId: number, status: InstallationLifecycleStatus, now: Date): Promise<void> {
    const installation = this.installations.get(githubInstallationId);
    if (!installation) return;
    const updatedInstallation: InstallationRecord = { ...installation, status, ...(status === "suspended" ? { suspendedAt: now } : {}), ...(status === "deleted" || status === "disconnected" ? { deletedAt: now } : {}) };
    if (status === "active") {
      delete updatedInstallation.suspendedAt;
      delete updatedInstallation.deletedAt;
    }
    this.installations.set(githubInstallationId, updatedInstallation);
    for (const [key, repository] of this.repositories.entries()) {
      if (repository.installationId !== installation.id) continue;
      const accessStatus = status === "suspended" ? "installation_suspended" : status === "active" ? "unavailable" : "disconnected";
      if (status === "active") this.repositories.set(key, { ...repository, accessStatus, selected: false });
      else this.repositories.set(key, { ...repository, accessStatus, selected: false, revokedAt: now });
    }
  }

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

  async recordUnroutedWebhook(record: UnroutedWebhookRecord): Promise<void> { if (!this.unroutedWebhooks.has(record.guid)) this.unroutedWebhooks.set(record.guid, { ...record }); }

  async updateDelivery(id: string, patch: Partial<DeliveryRecord>, _tenantId?: string): Promise<void> {
    const delivery = [...this.deliveries.values()].find((value) => value.id === id);
    if (!delivery) throw new Error("Delivery not found");
    Object.assign(delivery, patch);
  }
  async getDelivery(id: string, _tenantId?: string): Promise<DeliveryRecord | undefined> { return [...this.deliveries.values()].find((value) => value.id === id); }
  async claimDeliveryForProcessing(id: string, _tenantId?: string): Promise<DeliveryRecord | undefined> {
    const delivery = [...this.deliveries.values()].find((value) => value.id === id);
    if (!delivery || delivery.state === "processed" || delivery.state === "ignored") return undefined;
    delivery.state = "processing";
    delivery.processingAttempts += 1;
    return { ...delivery };
  }
  async ensureJob(logicalKey: string, payload: Record<string, unknown>): Promise<string> {
    const existing = this.jobs.get(logicalKey);
    if (existing) return existing.id;
    const job = { id: createId(), logicalKey, payload };
    this.jobs.set(logicalKey, job);
    return job.id;
  }
  async setBranchHead(tenantId: string, repositoryId: string, ref: string, headSha: string | null): Promise<void> { this.branchHeads.set(`${tenantId}:${repositoryId}:${branchName(ref)}`, headSha); }
  async getBranchHead(tenantId: string, repositoryId: string, ref: string): Promise<string | null> { return this.branchHeads.get(`${tenantId}:${repositoryId}:${branchName(ref)}`) ?? null; }
  async finalizeRefSync(input: { tenantId: string; repositoryId: string; ref: string; expectedHead: string | null; headSha: string | null; invalidatePrevious: boolean; reachableShas: string[] }): Promise<boolean> {
    const key = `${input.tenantId}:${input.repositoryId}:${branchName(input.ref)}`;
    const current = this.branchHeads.get(key) ?? null;
    if (current !== input.expectedHead) return false;
    if (input.invalidatePrevious) await this.markBranchCommitsUnreachable(input.tenantId, input.repositoryId, input.ref);
    for (const sha of input.reachableShas) await this.setCommitReachability(input.tenantId, input.repositoryId, input.ref, sha, true);
    this.branchHeads.set(key, input.headSha);
    this.refSyncContinuations.delete(key);
    return true;
  }
  async saveCommit(tenantId: string, repositoryId: string, commit: CommitFact, event?: DevelopmentEvent, htmlUrl?: string): Promise<void> {
    this.commits.set(`${tenantId}:${repositoryId}:${commit.sha}`, { tenantId, repositoryId, commit, ...(htmlUrl ? { htmlUrl } : {}) });
    if (event) await this.saveDevelopmentEvent(tenantId, repositoryId, event, { ...(htmlUrl ? { htmlUrl } : {}), message: commit.message });
  }
  async saveDevelopmentEvent(tenantId: string, repositoryId: string, event: DevelopmentEvent, options?: { htmlUrl?: string; message?: string }): Promise<void> {
    const key = `${tenantId}:${repositoryId}:${event.sourceKind}:${event.sourceExternalId}:${event.verb}`;
    const existingIndex = this.events.findIndex((value) => this.eventKeys.has(`${tenantId}:${repositoryId}:${value.sourceKind}:${value.sourceExternalId}:${value.verb}`) && value.repositoryId === repositoryId && value.sourceKind === event.sourceKind && value.sourceExternalId === event.sourceExternalId && value.verb === event.verb);
    if (existingIndex === -1) {
      this.events.push({ ...event, ...(options?.htmlUrl ? { htmlUrl: options.htmlUrl } : {}), ...(options?.message ? { message: options.message } : {}) });
      this.eventKeys.add(key);
    } else {
      const existing = this.events[existingIndex];
      if (existing) this.events[existingIndex] = { ...existing, ...(options?.htmlUrl ? { htmlUrl: options.htmlUrl } : {}), ...(options?.message ? { message: options.message } : {}) };
    }
  }
  async getRefSyncContinuation(tenantId: string, repositoryId: string, ref: string): Promise<RefSyncContinuation | undefined> { return this.refSyncContinuations.get(`${tenantId}:${repositoryId}:${branchName(ref)}`); }
  async setRefSyncContinuation(tenantId: string, repositoryId: string, ref: string, continuation: RefSyncContinuation): Promise<void> { this.refSyncContinuations.set(`${tenantId}:${repositoryId}:${branchName(ref)}`, { ...continuation }); }
  async clearRefSyncContinuation(tenantId: string, repositoryId: string, ref: string): Promise<void> { this.refSyncContinuations.delete(`${tenantId}:${repositoryId}:${branchName(ref)}`); }
  async markBranchCommitsUnreachable(tenantId: string, repositoryId: string, ref: string): Promise<void> {
    const prefix = `${tenantId}:${repositoryId}:${branchName(ref)}:`;
    for (const key of this.commitReachability.keys()) if (key.startsWith(prefix)) this.commitReachability.set(key, false);
  }
  async setCommitReachability(tenantId: string, repositoryId: string, ref: string, sha: string, reachable: boolean): Promise<void> { this.commitReachability.set(`${tenantId}:${repositoryId}:${branchName(ref)}:${sha}`, reachable); }
  async listActivity(tenantId: string, repositoryId?: string): Promise<ActivityRecord[]> {
    return this.events.filter((event) => {
      const repository = [...this.repositories.values()].find((value) => value.tenantId === tenantId && value.id === event.repositoryId);
      if (!repository || (repositoryId && event.repositoryId !== repositoryId)) return false;
      if (event.sourceKind !== "commit") return true;
      const reachabilityKey = `${tenantId}:${repository.id}:${branchName(`refs/heads/${repository.defaultBranch}`)}:${event.sourceExternalId}`;
      return !this.commitReachability.has(reachabilityKey) || this.commitReachability.get(reachabilityKey) === true;
    }).sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  }

  private historicalKey(tenantId: string, repositoryId: string, stage: HistoricalStage, refName = ""): string {
    return `${tenantId}:${repositoryId}:${stage}:${refName}`;
  }

  private historicalGate(tenantId: string, repositoryId: string, installationId: string, now: Date): boolean {
    const installation = [...this.installations.values()].find((value) => value.id === installationId && value.tenantId === tenantId);
    if (!installation || (installation.status && installation.status !== "active") || (installation.apiPausedUntil && installation.apiPausedUntil > now)) return false;
    const repository = [...this.repositories.values()].find((value) => value.id === repositoryId && value.tenantId === tenantId && value.installationId === installationId);
    return Boolean(repository?.selected && (!repository.accessStatus || repositoryAccessIsAvailable(repository.accessStatus)));
  }

  async startHistoricalBackfill(input: { tenantId: string; repositoryId: string; installationId: string; defaultBranch: string; now: Date }): Promise<HistoricalProgress> {
    if (!this.historicalGate(input.tenantId, input.repositoryId, input.installationId, input.now)) throw new Error("historical_backfill_gated");
    for (const stage of HISTORICAL_STAGES) {
      const refName = stage === "default_branch_commits" ? branchName(input.defaultBranch) : "";
      const key = this.historicalKey(input.tenantId, input.repositoryId, stage, refName);
      if (this.historicalProgress.has(key)) continue;
      const first = stage === "default_branch_commits";
      this.historicalProgress.set(key, {
        tenantId: input.tenantId,
        repositoryId: input.repositoryId,
        stage,
        refName,
        status: first ? "in_progress" : "pending",
        cursor: { nextPage: 1 },
        nextPage: 1,
        ...(first ? { startedAt: input.now, observationStartedAt: input.now } : {}),
        completenessState: "known_unknown",
      });
    }
    const progress = this.historicalProgress.get(this.historicalKey(input.tenantId, input.repositoryId, "default_branch_commits", branchName(input.defaultBranch)));
    if (!progress) throw new Error("historical_progress_missing");
    return { ...progress, cursor: { ...progress.cursor } };
  }

  async getHistoricalProgress(tenantId: string, repositoryId: string, stage: HistoricalStage, refName = ""): Promise<HistoricalProgress | undefined> {
    const normalizedRef = stage === "default_branch_commits" ? branchName(refName) : refName;
    const progress = this.historicalProgress.get(this.historicalKey(tenantId, repositoryId, stage, normalizedRef));
    return progress ? { ...progress, cursor: { ...progress.cursor } } : undefined;
  }

  async listHistoricalProgress(tenantId: string, repositoryId: string): Promise<HistoricalProgress[]> {
    return [...this.historicalProgress.values()]
      .filter((value) => value.tenantId === tenantId && value.repositoryId === repositoryId)
      .sort((left, right) => HISTORICAL_STAGES.indexOf(left.stage) - HISTORICAL_STAGES.indexOf(right.stage))
      .map((value) => ({ ...value, cursor: { ...value.cursor } }));
  }

  async resetCommitTraversal(input: { tenantId: string; repositoryId: string; installationId: string; refName: string; anchorHeadSha: string; now: Date }): Promise<HistoricalProgress | undefined> {
    if (!this.historicalGate(input.tenantId, input.repositoryId, input.installationId, input.now)) return undefined;
    const previousHead = await this.getBranchHead(input.tenantId, input.repositoryId, input.refName);
    await this.markBranchCommitsUnreachable(input.tenantId, input.repositoryId, input.refName);
    const progress: HistoricalProgress = {
      tenantId: input.tenantId,
      repositoryId: input.repositoryId,
      stage: "default_branch_commits",
      refName: branchName(input.refName),
      status: "in_progress",
      cursor: { nextPage: 1, previousHead },
      nextPage: 1,
      anchorHeadSha: input.anchorHeadSha,
      startedAt: input.now,
      observationStartedAt: input.now,
      completenessState: "known_unknown",
    };
    this.historicalProgress.set(this.historicalKey(input.tenantId, input.repositoryId, progress.stage, progress.refName), progress);
    return { ...progress, cursor: { ...progress.cursor } };
  }

  async commitHistoricalPage(input: HistoricalPageCommit): Promise<HistoricalPageCommitResult> {
    const refName = input.stage === "default_branch_commits" ? branchName(input.refName) : "";
    const key = this.historicalKey(input.tenantId, input.repositoryId, input.stage, refName);
    const progress = this.historicalProgress.get(key);
    if (!progress) throw new Error("historical_progress_missing");
    if (!this.historicalGate(input.tenantId, input.repositoryId, input.installationId, input.observedAt)) return { applied: false, reason: "gated", progress: { ...progress, cursor: { ...progress.cursor } } };
    if (JSON.stringify(progress.cursor) !== JSON.stringify(input.expectedCursor)) return { applied: false, reason: "checkpoint_mismatch", progress: { ...progress, cursor: { ...progress.cursor } } };
    if (input.stage === "default_branch_commits") {
      if (progress.anchorHeadSha && progress.anchorHeadSha !== input.anchorHeadSha) return { applied: false, reason: "checkpoint_mismatch", progress: { ...progress, cursor: { ...progress.cursor } } };
      if (input.finalPage) {
        const publishedHead = await this.getBranchHead(input.tenantId, input.repositoryId, refName);
        const expectedPublishedHead = typeof progress.cursor.previousHead === "string" ? progress.cursor.previousHead : null;
        if (publishedHead !== expectedPublishedHead && publishedHead !== input.anchorHeadSha) return { applied: false, reason: "checkpoint_mismatch", progress: { ...progress, cursor: { ...progress.cursor } } };
      }
      for (const fact of input.facts) {
        await this.saveCommit(input.tenantId, input.repositoryId, fact.commit, fact.event, fact.htmlUrl);
        await this.setCommitReachability(input.tenantId, input.repositoryId, refName, fact.commit.sha, true);
      }
      if (input.finalPage) {
        await this.setBranchHead(input.tenantId, input.repositoryId, refName, input.anchorHeadSha);
      }
    } else if (input.stage === "branches") {
      const generation = progress.startedAt ?? input.observedAt;
      for (const fact of input.facts) this.historicalBranches.set(`${input.tenantId}:${input.repositoryId}:${fact.name}`, { ...fact, reachable: true, generation });
      if (input.finalPage) for (const [factKey, value] of this.historicalBranches) if (factKey.startsWith(`${input.tenantId}:${input.repositoryId}:`) && value.generation < generation) value.reachable = false;
    } else if (input.stage === "tags") {
      const generation = progress.startedAt ?? input.observedAt;
      for (const fact of input.facts) this.historicalTags.set(`${input.tenantId}:${input.repositoryId}:${fact.name}`, { ...fact, reachable: true, generation });
      if (input.finalPage) for (const [factKey, value] of this.historicalTags) if (factKey.startsWith(`${input.tenantId}:${input.repositoryId}:`) && value.generation < generation) value.reachable = false;
    } else if (input.stage === "pull_requests") {
      for (const fact of input.facts) {
        const factKey = `${input.tenantId}:${input.repositoryId}:${fact.githubId}`;
        const previous = this.historicalPullRequests.get(factKey);
        if (!previous || fact.updatedAt >= previous.updatedAt) this.historicalPullRequests.set(factKey, { ...fact });
      }
    } else if (input.stage === "issues") {
      for (const fact of input.facts) {
        const factKey = `${input.tenantId}:${input.repositoryId}:${fact.githubId}`;
        const previous = this.historicalIssues.get(factKey);
        if (!previous || fact.updatedAt >= previous.updatedAt) this.historicalIssues.set(factKey, { ...fact });
      }
    } else {
      for (const fact of input.facts) {
        const factKey = `${input.tenantId}:${input.repositoryId}:${fact.githubId}`;
        const previous = this.historicalReleases.get(factKey);
        // GitHub's release REST shape has no updated_at. published_at (or
        // created_at) is the best source clock, so equal-clock replays must not
        // overwrite an already-observed snapshot.
        if (!previous || fact.updatedAt > previous.updatedAt) this.historicalReleases.set(factKey, { ...fact });
      }
    }
    progress.cursor = input.stage === "default_branch_commits" ? { ...input.nextCursor, previousHead: progress.cursor.previousHead } : { ...input.nextCursor };
    progress.nextPage = input.nextCursor.nextPage;
    progress.status = input.finalPage ? "completed" : "in_progress";
    progress.lastSuccessAt = input.observedAt;
    if (input.highWaterAt) progress.highWaterAt = input.highWaterAt;
    progress.completenessState = input.finalPage ? (input.stage === "default_branch_commits" || input.stage === "branches" || input.stage === "tags" ? "reachable_at_sync" : "observed") : "known_unknown";
    if (input.finalPage) progress.completedAt = input.observedAt;
    if (input.finalPage) {
      const next = nextHistoricalStage(input.stage);
      const nextRef = "";
      const nextProgress = this.historicalProgress.get(this.historicalKey(input.tenantId, input.repositoryId, next, nextRef));
      if (nextProgress) {
        nextProgress.status = next === "completed" ? "completed" : "in_progress";
        nextProgress.startedAt = input.observedAt;
        nextProgress.observationStartedAt = input.observedAt;
        if (next === "completed") {
          nextProgress.completedAt = input.observedAt;
          nextProgress.lastSuccessAt = input.observedAt;
          nextProgress.completenessState = "observed";
        }
      }
    }
    return { applied: true, progress: { ...progress, cursor: { ...progress.cursor } } };
  }

  async pauseHistoricalStage(input: { tenantId: string; repositoryId: string; stage: HistoricalSourceStage; refName?: string; pausedUntil?: Date; errorCode: string }): Promise<HistoricalProgress | undefined> {
    const refName = input.stage === "default_branch_commits" ? branchName(input.refName ?? "") : input.refName ?? "";
    const progress = this.historicalProgress.get(this.historicalKey(input.tenantId, input.repositoryId, input.stage, refName));
    if (!progress || progress.status === "completed") return progress;
    progress.status = "paused";
    progress.errorCode = input.errorCode;
    if (input.pausedUntil) progress.pausedUntil = input.pausedUntil; else delete progress.pausedUntil;
    return { ...progress, cursor: { ...progress.cursor } };
  }

  async resumeHistoricalStage(input: { tenantId: string; repositoryId: string; stage: HistoricalSourceStage; refName?: string; now: Date }): Promise<HistoricalProgress | undefined> {
    const refName = input.stage === "default_branch_commits" ? branchName(input.refName ?? "") : input.refName ?? "";
    const progress = this.historicalProgress.get(this.historicalKey(input.tenantId, input.repositoryId, input.stage, refName));
    if (!progress || progress.status === "completed" || (progress.pausedUntil && progress.pausedUntil > input.now)) return progress ? { ...progress, cursor: { ...progress.cursor } } : undefined;
    progress.status = "in_progress";
    delete progress.pausedUntil;
    delete progress.errorCode;
    return { ...progress, cursor: { ...progress.cursor } };
  }

  async pauseInstallationApi(input: { tenantId: string; installationId: string; pausedUntil: Date; reason: string }): Promise<void> {
    const installation = [...this.installations.values()].find((value) => value.id === input.installationId && value.tenantId === input.tenantId);
    if (installation) Object.assign(installation, { apiPausedUntil: input.pausedUntil, apiPauseReason: input.reason });
  }

  async resumeInstallationApi(input: { tenantId: string; installationId: string; now: Date }): Promise<void> {
    const installation = [...this.installations.values()].find((value) => value.id === input.installationId && value.tenantId === input.tenantId);
    if (installation && (!installation.apiPausedUntil || installation.apiPausedUntil <= input.now)) {
      delete installation.apiPausedUntil;
      delete installation.apiPauseReason;
    }
  }

  async getHistoricalSourceCounts(tenantId: string, repositoryId: string): Promise<HistoricalSourceCounts> {
    const prefix = `${tenantId}:${repositoryId}:`;
    return {
      commits: [...this.commits.keys()].filter((key) => key.startsWith(prefix)).length,
      branches: [...this.historicalBranches.keys()].filter((key) => key.startsWith(prefix)).length,
      tags: [...this.historicalTags.keys()].filter((key) => key.startsWith(prefix)).length,
      pullRequests: [...this.historicalPullRequests.keys()].filter((key) => key.startsWith(prefix)).length,
      issues: [...this.historicalIssues.keys()].filter((key) => key.startsWith(prefix)).length,
      releases: [...this.historicalReleases.keys()].filter((key) => key.startsWith(prefix)).length,
    };
  }
}
