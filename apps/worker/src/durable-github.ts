import type { InstallationRecord, M1Store } from "@devmemoir/db";
import {
  GithubRateLimitPauseError,
  type GithubClient,
  type GithubRateLimitCode,
} from "@devmemoir/github";

function rateLimitCode(reason?: string): GithubRateLimitCode {
  if (reason === "github_secondary_rate_limit") return "secondary_rate_limit";
  if (reason === "github_retry_after") return "retry_after";
  return "primary_rate_limit";
}

/**
 * Reads the durable installation gate immediately before a request. The
 * database is the recovery truth; process-local request lanes are only a
 * traffic-control optimization.
 */
export async function ensureInstallationApiAvailable(input: {
  tenantId: string;
  installationGithubId: number;
  store: M1Store;
  now: Date;
}): Promise<InstallationRecord | undefined> {
  const installation = await input.store.getInstallation(input.installationGithubId);
  if (!installation || installation.tenantId !== input.tenantId || (installation.status && installation.status !== "active")) return undefined;
  if (installation.apiPausedUntil && installation.apiPausedUntil > input.now) {
    throw new GithubRateLimitPauseError(rateLimitCode(installation.apiPauseReason), 429, installation.apiPausedUntil);
  }
  // The store method is guarded by the same expiry predicate, so a worker can
  // clear an exhausted pause at the boundary but never before it.
  if (installation.apiPausedUntil) await input.store.resumeInstallationApi({ tenantId: input.tenantId, installationId: installation.id, now: input.now });
  return installation;
}

/**
 * Wraps every installation-authenticated GithubClient method with the durable
 * preflight. OAuth/user methods are intentionally left untouched because they
 * are not installation-credential traffic.
 */
export function guardInstallationGithub(input: {
  tenantId: string;
  installationGithubId: number;
  store: M1Store;
  github: GithubClient;
  now: () => Date;
}): GithubClient {
  const bypass = new Set(["getUser", "exchangeOAuthCode"]);
  return new Proxy(input.github, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || bypass.has(String(property))) return value;
      return async (...args: unknown[]) => {
        const installation = await ensureInstallationApiAvailable({
          tenantId: input.tenantId,
          installationGithubId: input.installationGithubId,
          store: input.store,
          now: input.now(),
        });
        if (!installation) throw new Error("Installation is unavailable for GitHub request");
        return Reflect.apply(value, target, args);
      };
    },
  }) as GithubClient;
}

