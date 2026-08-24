import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { createCipheriv, createHash, createDecipheriv, randomBytes } from "node:crypto";

export const DELIVERY_STATES = [
  "received",
  "processing",
  "failed",
  "dead_letter",
  "processed",
  "ignored",
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export const TERMINAL_DELIVERY_STATES = new Set<DeliveryState>(["processed", "ignored"]);

export const REPOSITORY_ACCESS_STATUSES = [
  "accessible",
  "access_removed",
  "installation_suspended",
  "unavailable",
  "disconnected",
] as const;
export type RepositoryAccessStatus = (typeof REPOSITORY_ACCESS_STATUSES)[number];

export function repositoryAccessIsAvailable(status: RepositoryAccessStatus): boolean {
  return status === "accessible";
}

export type DeliveryTransition = "noop" | "ensure_job" | "requeue";

export function deliveryRedeliveryAction(state: DeliveryState): DeliveryTransition {
  if (state === "processed" || state === "ignored") return "noop";
  if (state === "processing") return "ensure_job";
  return "requeue";
}

export function isTerminalDeliveryState(state: DeliveryState): boolean {
  return TERMINAL_DELIVERY_STATES.has(state);
}

export type ActorKind = "user" | "bot" | "unknown";
export type ContextKind = "personal" | "project" | "unknown";
export type AttributionConfidence = "exact_github_actor" | "unknown";
export type CompletenessState =
  | "observed"
  | "reachable_at_sync"
  | "known_unknown"
  | "out_of_scope";

export const PROJECTION_VERSION = 1;

export type SourceKind = "commit" | "pull_request" | "issue" | "release" | "repository" | "tag";
export type EventVerb =
  | "authored"
  | "committed"
  | "opened"
  | "merged"
  | "closed"
  | "reopened"
  | "published"
  | "edited"
  | "created"
  | "archived"
  | "renamed"
  | "deleted";
export type ContributionRole = "author" | "committer" | "opener" | "merger" | "releaser" | "maintainer" | "unknown_action";
export type Visibility = "public" | "private" | "internal" | "unknown";

export type GithubActor = {
  githubAccountId: number;
  login?: string;
  accountType?: string;
  actorKind: ActorKind;
};

export type CommitFact = {
  repositoryId: string;
  sha: string;
  author?: GithubActor;
  committer?: GithubActor;
  message: string;
  authoredAt?: Date;
  committedAt?: Date;
  parents: string[];
  verified?: boolean;
  additions?: number;
  deletions?: number;
  htmlUrl?: string;
};

export type DevelopmentEvent = {
  id: string;
  repositoryId: string;
  sourceKind: SourceKind;
  sourceExternalId: string;
  eventType: SourceKind;
  verb: EventVerb;
  actorGithubAccountId?: number | undefined;
  actorKind: ActorKind;
  contributionRole: ContributionRole;
  contextKind: ContextKind;
  occurredAt: Date;
  sourceUpdatedAt?: Date | undefined;
  title?: string | undefined;
  summaryInput?: string | undefined;
  sourceUrl?: string | undefined;
  completenessState: CompletenessState;
  visibility: Visibility;
  attributionConfidence: AttributionConfidence;
  projectionVersion: number;
  logicalEventKey?: string | undefined;
};

export type TimelineEvent = DevelopmentEvent & {
  displayVerb: EventVerb;
  /** Owner contribution retained when the displayed lifecycle actor is a collaborator. */
  ownerContributionRole?: ContributionRole | undefined;
};

export type ProjectionActor = {
  githubAccountId?: number | undefined;
  actorKind: ActorKind;
  login?: string | undefined;
  accountType?: string | undefined;
};

export type NormalizedPullRequestFact = {
  githubId: number;
  title: string;
  author?: ProjectionActor | undefined;
  merger?: ProjectionActor | undefined;
  sourceUrl?: string | undefined;
  createdAt: Date;
  updatedAt: Date;
  closedAt?: Date | undefined;
  mergedAt?: Date | undefined;
  completenessState?: CompletenessState | undefined;
};

export type NormalizedIssueFact = {
  githubId: number;
  title: string;
  author?: ProjectionActor | undefined;
  sourceUrl?: string | undefined;
  createdAt: Date;
  updatedAt: Date;
  closedAt?: Date | undefined;
  completenessState?: CompletenessState | undefined;
};

export type NormalizedReleaseFact = {
  githubId: number;
  name?: string | undefined;
  author?: ProjectionActor | undefined;
  sourceUrl?: string | undefined;
  publishedAt?: Date | undefined;
  updatedAt: Date;
  completenessState?: CompletenessState | undefined;
};

export type NormalizedRepositoryRenameFact = {
  observedAt: Date;
};

export type NormalizedTagFact = {
  name: string;
  deletedAt?: Date | undefined;
  completenessState?: CompletenessState | undefined;
};

export type CanonicalProjectionInput = {
  tenantId: string;
  repositoryId: string;
  githubRepositoryId: number;
  ownerGithubAccountId?: number | undefined;
  private: boolean;
  visibility?: string | undefined;
  githubCreatedAt?: Date | undefined;
  archivedAt?: Date | undefined;
  commits: Array<CommitFact>;
  pullRequests: Array<NormalizedPullRequestFact>;
  issues: Array<NormalizedIssueFact>;
  releases: Array<NormalizedReleaseFact>;
  repositoryRenames?: Array<NormalizedRepositoryRenameFact>;
  tags?: Array<NormalizedTagFact>;
  projectionVersion?: number | undefined;
};

export function actorKindFromGithub(actor: {
  type?: string | null;
  login?: string | null;
  id?: number | null;
} | null | undefined): ActorKind {
  if (!actor?.id) return "unknown";
  if (actor.type?.toLowerCase() === "bot" || actor.login?.endsWith("[bot]")) return "bot";
  return "user";
}

export function createId(): string {
  return uuidv7();
}

export function truncatePrivateText(value: string | undefined, limit = 4000): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function eventForCommit(
  commit: CommitFact,
  actor: GithubActor | undefined,
  role: "author" | "committer",
  verb: "authored" | "committed",
  ownerGithubAccountId?: number,
  tenantId?: string,
  projectionVersion = PROJECTION_VERSION,
  visibility: Visibility = "unknown",
): DevelopmentEvent {
  const actorKind = actor?.actorKind ?? "unknown";
  const actorId = actor?.githubAccountId;
  return {
    id: "",
    repositoryId: commit.repositoryId,
    sourceKind: "commit",
    sourceExternalId: commit.sha,
    eventType: "commit",
    verb,
    actorGithubAccountId: actorId,
    actorKind,
    contributionRole: role,
    contextKind: contextForActor(actorId, ownerGithubAccountId),
    occurredAt: (role === "author" ? commit.authoredAt : commit.committedAt) as Date,
    ...(commit.committedAt ? { sourceUpdatedAt: commit.committedAt } : {}),
    summaryInput: truncatePrivateText(commit.message),
    ...(commit.htmlUrl ? { sourceUrl: commit.htmlUrl } : {}),
    completenessState: "observed",
    visibility,
    attributionConfidence: actorId === undefined ? "unknown" : "exact_github_actor",
    projectionVersion,
    ...(tenantId ? { logicalEventKey: canonicalLogicalEventKey(tenantId, { repositoryId: commit.repositoryId, sourceKind: "commit", sourceExternalId: commit.sha, eventType: "commit", verb, contributionRole: role }) } : {}),
  };
}

function contextForActor(actorId: number | undefined, ownerGithubAccountId?: number): ContextKind {
  if (actorId === undefined || ownerGithubAccountId === undefined) return "unknown";
  return actorId === ownerGithubAccountId ? "personal" : "project";
}

export function canonicalLogicalEventKey(
  tenantId: string,
  dimensions: Pick<DevelopmentEvent, "repositoryId" | "sourceKind" | "sourceExternalId" | "eventType" | "verb" | "contributionRole">,
): string {
  return [tenantId, dimensions.repositoryId, dimensions.sourceKind, dimensions.sourceExternalId, dimensions.eventType, dimensions.verb, dimensions.contributionRole].join(":");
}

function visibilityForRepository(privateRepository: boolean, visibility?: string): Visibility {
  if (privateRepository) return "private";
  if (visibility === "public" || visibility === "private" || visibility === "internal") return visibility;
  return "unknown";
}

function eventForLifecycle(input: {
  tenantId: string;
  repositoryId: string;
  sourceKind: SourceKind;
  sourceExternalId: string;
  verb: EventVerb;
  contributionRole: ContributionRole;
  actor?: ProjectionActor | undefined;
  occurredAt?: Date | undefined;
  sourceUpdatedAt?: Date | undefined;
  title?: string | undefined;
  summaryInput?: string | undefined;
  sourceUrl?: string | undefined;
  completenessState?: CompletenessState | undefined;
  visibility: Visibility;
  projectionVersion: number;
}): DevelopmentEvent | undefined {
  if (!input.occurredAt) return undefined;
  const actorId = input.actor?.githubAccountId;
  const event: DevelopmentEvent = {
    id: "",
    repositoryId: input.repositoryId,
    sourceKind: input.sourceKind,
    sourceExternalId: input.sourceExternalId,
    eventType: input.sourceKind,
    verb: input.verb,
    ...(actorId === undefined ? {} : { actorGithubAccountId: actorId }),
    actorKind: input.actor?.actorKind ?? "unknown",
    contributionRole: input.contributionRole,
    contextKind: contextForActor(actorId, undefined),
    occurredAt: input.occurredAt,
    ...(input.sourceUpdatedAt ? { sourceUpdatedAt: input.sourceUpdatedAt } : {}),
    ...(input.title ? { title: truncatePrivateText(input.title) } : {}),
    ...(input.summaryInput ? { summaryInput: truncatePrivateText(input.summaryInput) } : {}),
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    completenessState: input.completenessState ?? "observed",
    visibility: input.visibility,
    attributionConfidence: actorId === undefined ? "unknown" : "exact_github_actor",
    projectionVersion: input.projectionVersion,
  };
  event.logicalEventKey = canonicalLogicalEventKey(input.tenantId, event);
  return event;
}

function withOwnerContext(event: DevelopmentEvent, ownerGithubAccountId?: number): DevelopmentEvent {
  const actorId = event.actorGithubAccountId;
  return { ...event, contextKind: contextForActor(actorId, ownerGithubAccountId) };
}

function projectCommitFact(commit: CommitFact, ownerGithubAccountId: number | undefined, tenantId?: string, projectionVersion = PROJECTION_VERSION, visibility: Visibility = "unknown"): DevelopmentEvent[] {
  const result: DevelopmentEvent[] = [];
  if (commit.authoredAt) result.push(withOwnerContext(eventForCommit(commit, commit.author, "author", "authored", ownerGithubAccountId, tenantId, projectionVersion, visibility), ownerGithubAccountId));
  if (commit.committedAt) result.push(withOwnerContext(eventForCommit(commit, commit.committer, "committer", "committed", ownerGithubAccountId, tenantId, projectionVersion, visibility), ownerGithubAccountId));
  return result;
}

export function projectCommitFacts(commit: CommitFact, ownerGithubAccountId?: number): DevelopmentEvent[] {
  return projectCommitFact(commit, ownerGithubAccountId);
}

function tagIdentity(name: string): string {
  return createHash("sha256").update(name).digest("hex");
}

export function projectCanonicalFacts(input: CanonicalProjectionInput): DevelopmentEvent[] {
  const projectionVersion = input.projectionVersion ?? PROJECTION_VERSION;
  const visibility = visibilityForRepository(input.private, input.visibility);
  const events: DevelopmentEvent[] = [];
  for (const commit of input.commits) events.push(...projectCommitFact(commit, input.ownerGithubAccountId, input.tenantId, projectionVersion, visibility));

  for (const pullRequest of input.pullRequests) {
    const sourceExternalId = String(pullRequest.githubId);
    const opened = eventForLifecycle({ tenantId: input.tenantId, repositoryId: input.repositoryId, sourceKind: "pull_request", sourceExternalId, verb: "opened", contributionRole: "opener", actor: pullRequest.author, occurredAt: pullRequest.createdAt, sourceUpdatedAt: pullRequest.updatedAt, title: pullRequest.title, sourceUrl: pullRequest.sourceUrl, completenessState: pullRequest.completenessState, visibility, projectionVersion });
    const merged = eventForLifecycle({ tenantId: input.tenantId, repositoryId: input.repositoryId, sourceKind: "pull_request", sourceExternalId, verb: "merged", contributionRole: "merger", actor: pullRequest.merger, occurredAt: pullRequest.mergedAt, sourceUpdatedAt: pullRequest.updatedAt, title: pullRequest.title, sourceUrl: pullRequest.sourceUrl, completenessState: pullRequest.completenessState, visibility, projectionVersion });
    const closed = eventForLifecycle({ tenantId: input.tenantId, repositoryId: input.repositoryId, sourceKind: "pull_request", sourceExternalId, verb: "closed", contributionRole: "unknown_action", occurredAt: pullRequest.closedAt, sourceUpdatedAt: pullRequest.updatedAt, title: pullRequest.title, sourceUrl: pullRequest.sourceUrl, completenessState: pullRequest.completenessState, visibility, projectionVersion });
    if (opened) events.push(withOwnerContext(opened, input.ownerGithubAccountId ?? Number.NaN));
    if (merged) events.push(withOwnerContext(merged, input.ownerGithubAccountId ?? Number.NaN));
    if (closed) events.push(withOwnerContext(closed, input.ownerGithubAccountId ?? Number.NaN));
  }

  for (const issue of input.issues) {
    const sourceExternalId = String(issue.githubId);
    const opened = eventForLifecycle({ tenantId: input.tenantId, repositoryId: input.repositoryId, sourceKind: "issue", sourceExternalId, verb: "opened", contributionRole: "opener", actor: issue.author, occurredAt: issue.createdAt, sourceUpdatedAt: issue.updatedAt, title: issue.title, sourceUrl: issue.sourceUrl, completenessState: issue.completenessState, visibility, projectionVersion });
    const closed = eventForLifecycle({ tenantId: input.tenantId, repositoryId: input.repositoryId, sourceKind: "issue", sourceExternalId, verb: "closed", contributionRole: "unknown_action", occurredAt: issue.closedAt, sourceUpdatedAt: issue.updatedAt, title: issue.title, sourceUrl: issue.sourceUrl, completenessState: issue.completenessState, visibility, projectionVersion });
    if (opened) events.push(withOwnerContext(opened, input.ownerGithubAccountId ?? Number.NaN));
    if (closed) events.push(withOwnerContext(closed, input.ownerGithubAccountId ?? Number.NaN));
  }

  for (const release of input.releases) {
    const published = eventForLifecycle({ tenantId: input.tenantId, repositoryId: input.repositoryId, sourceKind: "release", sourceExternalId: String(release.githubId), verb: "published", contributionRole: "releaser", actor: release.author, occurredAt: release.publishedAt, sourceUpdatedAt: release.updatedAt, title: release.name, sourceUrl: release.sourceUrl, completenessState: release.completenessState, visibility, projectionVersion });
    if (published) events.push(withOwnerContext(published, input.ownerGithubAccountId ?? Number.NaN));
  }

  const repositoryId = String(input.githubRepositoryId);
  const created = eventForLifecycle({ tenantId: input.tenantId, repositoryId: input.repositoryId, sourceKind: "repository", sourceExternalId: repositoryId, verb: "created", contributionRole: "unknown_action", actor: undefined, occurredAt: input.githubCreatedAt, sourceUpdatedAt: input.githubCreatedAt, title: "Repository created", visibility, projectionVersion });
  const archived = eventForLifecycle({ tenantId: input.tenantId, repositoryId: input.repositoryId, sourceKind: "repository", sourceExternalId: repositoryId, verb: "archived", contributionRole: "unknown_action", actor: undefined, occurredAt: input.archivedAt, sourceUpdatedAt: input.archivedAt, title: "Repository archived", visibility, projectionVersion });
  if (created) events.push(created);
  if (archived) events.push(archived);
  for (const rename of input.repositoryRenames ?? []) {
    const renamed = eventForLifecycle({ tenantId: input.tenantId, repositoryId: input.repositoryId, sourceKind: "repository", sourceExternalId: `${repositoryId}:rename:${rename.observedAt.toISOString()}`, verb: "renamed", contributionRole: "unknown_action", actor: undefined, occurredAt: rename.observedAt, sourceUpdatedAt: rename.observedAt, title: "Repository renamed", visibility, projectionVersion });
    if (renamed) events.push(renamed);
  }
  for (const tag of input.tags ?? []) {
    const deleted = eventForLifecycle({ tenantId: input.tenantId, repositoryId: input.repositoryId, sourceKind: "tag", sourceExternalId: tagIdentity(tag.name), verb: "deleted", contributionRole: "unknown_action", actor: undefined, occurredAt: tag.deletedAt, sourceUpdatedAt: tag.deletedAt, title: "Tag deleted", completenessState: tag.completenessState, visibility, projectionVersion });
    if (deleted) events.push(deleted);
  }
  return events.sort((left, right) => {
    const byDate = right.occurredAt.getTime() - left.occurredAt.getTime();
    if (byDate !== 0) return byDate;
    return (left.logicalEventKey ?? "").localeCompare(right.logicalEventKey ?? "");
  });
}

export function defaultTimelineEvents(
  events: DevelopmentEvent[],
  ownerGithubAccountId: number,
): TimelineEvent[] {
  const visible = events.filter((event) => event.actorKind !== "bot");
  const result: TimelineEvent[] = [];
  const groups = new Map<string, DevelopmentEvent[]>();
  for (const event of visible) {
    const key = `${event.repositoryId}:${event.sourceKind}:${event.sourceExternalId}`;
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    if (first.sourceKind === "commit") {
      const ownerEvents = group.filter((event) => event.actorGithubAccountId === ownerGithubAccountId);
      const authored = ownerEvents.find((event) => event.verb === "authored");
      const committed = ownerEvents.find((event) => event.verb === "committed");
      const chosen = authored ?? committed;
      if (chosen) result.push({ ...chosen, displayVerb: chosen.verb, ownerContributionRole: chosen.contributionRole });
      continue;
    }
    if (first.sourceKind === "pull_request") {
      const ownerOpened = group.find((event) => event.actorGithubAccountId === ownerGithubAccountId && event.contributionRole === "opener");
      const ownerMerged = group.find((event) => event.actorGithubAccountId === ownerGithubAccountId && event.verb === "merged");
      const merged = group.find((event) => event.verb === "merged");
      const closed = group.find((event) => event.verb === "closed");
      const opened = group.find((event) => event.verb === "opened" && event.actorGithubAccountId === ownerGithubAccountId);
      const chosen = merged ?? (closed && ownerOpened ? closed : opened);
      if (chosen) {
        result.push({
          ...chosen,
          displayVerb: chosen.verb,
          ...(ownerMerged ? { ownerContributionRole: ownerMerged.contributionRole } : ownerOpened ? { ownerContributionRole: ownerOpened.contributionRole } : {}),
        });
      }
      continue;
    }
    const ownerEvent = group.find((event) => event.actorGithubAccountId === ownerGithubAccountId);
    const milestone = first.sourceKind === "release" && first.contextKind === "project";
    if (ownerEvent) result.push({ ...ownerEvent, displayVerb: ownerEvent.verb, ownerContributionRole: ownerEvent.contributionRole });
    else if (milestone) result.push({ ...first, displayVerb: first.verb });
  }
  return result.sort((a, b) => {
    const byDate = b.occurredAt.getTime() - a.occurredAt.getTime();
    return byDate !== 0 ? byDate : (a.logicalEventKey ?? "").localeCompare(b.logicalEventKey ?? "");
  });
}

export function filterContextEvents(events: DevelopmentEvent[], context: "personal" | "project" | "unknown", includeBots = false): DevelopmentEvent[] {
  return events.filter((event) => (includeBots || event.actorKind !== "bot") && event.contextKind === context);
}

const actorPayloadSchema = z
  .object({ id: z.number().int().positive().optional(), login: z.string().optional(), type: z.string().optional() })
  .strip();
const repositoryPayloadSchema = z
  .object({ id: z.number().int().positive().optional(), full_name: z.string().optional(), name: z.string().optional() })
  .strip();
const installationPayloadSchema = z
  .object({ id: z.number().int().positive().optional(), account: actorPayloadSchema.optional() })
  .strip();

export const pushPayloadSchema = z
  .object({
    ref: z.string().min(1),
    before: z.string().min(1),
    after: z.string().min(1),
    forced: z.boolean().optional().default(false),
    repository: repositoryPayloadSchema.optional(),
    installation: installationPayloadSchema.optional(),
    sender: actorPayloadSchema.optional(),
  })
  .strip();

export const webhookEnvelopeSchema = z
  .object({
    action: z.string().optional(),
    installation: installationPayloadSchema.optional(),
    repository: repositoryPayloadSchema.optional(),
    sender: actorPayloadSchema.optional(),
  })
  .strip();

export type PushSignal = {
  ref: string;
  before: string;
  after: string;
  forced: boolean;
  repositoryGithubId?: number | undefined;
  installationGithubId?: number | undefined;
};

export type ParsedWebhook = {
  eventName: string;
  action?: string | undefined;
  installationGithubId?: number | undefined;
  repositoryGithubId?: number | undefined;
  kind: "push" | "supported" | "ignored";
  push?: PushSignal;
};

export function parseWebhook(eventName: string, rawPayload: unknown): ParsedWebhook {
  const envelope = webhookEnvelopeSchema.parse(rawPayload);
  const installationGithubId = envelope.installation?.id;
  const repositoryGithubId = envelope.repository?.id;
  if (eventName === "push") {
    const push = pushPayloadSchema.parse(rawPayload);
    return {
      eventName,
      installationGithubId: push.installation?.id ?? installationGithubId,
      repositoryGithubId: push.repository?.id ?? repositoryGithubId,
      kind: "push",
      push: {
        ref: push.ref,
        before: push.before,
        after: push.after,
        forced: push.forced,
        repositoryGithubId: push.repository?.id,
        installationGithubId: push.installation?.id,
      },
    };
  }
  if (eventName === "ping" || eventName === "github_app_authorization") {
    return { eventName, action: envelope.action, installationGithubId, repositoryGithubId, kind: "supported" };
  }
  const supported = new Set(["installation", "installation_repositories", "repository", "create", "delete", "pull_request", "issues", "release"]);
  return {
    eventName,
    action: envelope.action,
    installationGithubId,
    repositoryGithubId,
    kind: supported.has(eventName) ? "supported" : "ignored",
  };
}

export type MinimalPushSignal = Omit<PushSignal, "repositoryGithubId" | "installationGithubId"> & {
  deliveryGuid: string;
  installationGithubId?: number | undefined;
  repositoryGithubId?: number | undefined;
};

export function minimalPushSignal(deliveryGuid: string, parsed: ParsedWebhook): MinimalPushSignal {
  if (!parsed.push) throw new Error("A push signal is required");
  return {
    deliveryGuid,
    ref: parsed.push.ref,
    before: parsed.push.before,
    after: parsed.push.after,
    forced: parsed.push.forced,
    installationGithubId: parsed.installationGithubId,
    repositoryGithubId: parsed.repositoryGithubId,
  };
}
export function createOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashOpaqueToken(token: string, secret: string): string {
  return createHash("sha256").update(secret).update("\0").update(token).digest("hex");
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = createOpaqueToken(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function encryptSecret(plaintext: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY_BASE64 must decode to 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

export function decryptSecret(encoded: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY_BASE64 must decode to 32 bytes");
  const payload = Buffer.from(encoded, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, payload.subarray(0, 12));
  decipher.setAuthTag(payload.subarray(12, 28));
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8");
}
