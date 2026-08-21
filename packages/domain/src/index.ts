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
export type CompletenessState =
  | "observed"
  | "reachable_at_sync"
  | "known_unknown"
  | "out_of_scope";

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
};

export type DevelopmentEvent = {
  id: string;
  repositoryId: string;
  sourceKind: "commit" | "pull_request" | "issue" | "release" | "repository";
  sourceExternalId: string;
  eventType: string;
  verb: string;
  actorGithubAccountId?: number | undefined;
  actorKind: ActorKind;
  contributionRole: "author" | "committer" | "opener" | "merger" | "releaser" | "maintainer";
  contextKind: ContextKind;
  occurredAt: Date;
  sourceUpdatedAt?: Date | undefined;
  title?: string | undefined;
  summaryInput?: string | undefined;
  completenessState: CompletenessState;
  visibility: "public" | "private" | "internal" | "unknown";
};

export type TimelineEvent = DevelopmentEvent & { displayVerb: string };

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
  ownerGithubAccountId?: number,
): DevelopmentEvent {
  const actorKind = actor?.actorKind ?? "unknown";
  const actorId = actor?.githubAccountId;
  return {
    id: createId(),
    repositoryId: commit.repositoryId,
    sourceKind: "commit",
    sourceExternalId: commit.sha,
    eventType: "commit",
    verb: role === "author" ? "authored" : "committed",
    actorGithubAccountId: actorId,
    actorKind,
    contributionRole: role,
    contextKind: actorId && ownerGithubAccountId === actorId ? "personal" : actorId ? "project" : "unknown",
    occurredAt: commit.authoredAt ?? commit.committedAt ?? new Date(0),
    sourceUpdatedAt: commit.committedAt,
    summaryInput: truncatePrivateText(commit.message),
    completenessState: "observed",
    visibility: "unknown",
  };
}

export function projectCommitFacts(commit: CommitFact, ownerGithubAccountId?: number): DevelopmentEvent[] {
  const authorId = commit.author?.githubAccountId;
  const committerId = commit.committer?.githubAccountId;
  if (authorId !== undefined && authorId === committerId) {
    return [eventForCommit(commit, commit.author, "author", ownerGithubAccountId)];
  }
  return [
    eventForCommit(commit, commit.author, "author", ownerGithubAccountId),
    eventForCommit(commit, commit.committer, "committer", ownerGithubAccountId),
  ].filter((event) => event.actorGithubAccountId !== undefined || event.contextKind !== "unknown");
}

export function defaultTimelineEvents(
  events: DevelopmentEvent[],
  ownerGithubAccountId: number,
): TimelineEvent[] {
  const result: TimelineEvent[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.actorKind === "bot") continue;
    const ownerEvent = event.actorGithubAccountId === ownerGithubAccountId;
    const milestone = event.contextKind === "project" && event.eventType === "release";
    if (!ownerEvent && !milestone) continue;
    const collapseKey = `${event.sourceKind}:${event.sourceExternalId}:${ownerEvent ? ownerGithubAccountId : "milestone"}`;
    if (seen.has(collapseKey)) continue;
    seen.add(collapseKey);
    result.push({ ...event, displayVerb: event.verb });
  }
  return result.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
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
