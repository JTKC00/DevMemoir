import type { GithubClient, GithubRepository } from "@devmemoir/github";
import { createId } from "@devmemoir/domain";
import type { InventoryReconcileResult, M1Store, RepositoryRecord } from "@devmemoir/db";

export type InventoryRefreshInput = {
  tenantId: string;
  installationGithubId: number;
  now?: Date;
};

export const INSTALLATION_REPOSITORY_PAGE_SIZE = 100;

function mapRepository(repository: GithubRepository, tenantId: string, installationId: string, observedAt: Date): RepositoryRecord {
  const ownerLogin = repository.owner?.login ?? repository.full_name.split("/", 1)[0] ?? "unknown";
  const parseDate = (value: string | null | undefined): Date | undefined => {
    if (!value) return undefined;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  };
  const githubCreatedAt = parseDate(repository.created_at);
  const githubUpdatedAt = parseDate(repository.updated_at);
  const githubPushedAt = parseDate(repository.pushed_at);
  return {
    id: createId(),
    tenantId,
    installationId,
    githubRepositoryId: repository.id,
    ownerLogin,
    name: repository.name,
    fullName: repository.full_name,
    private: repository.private,
    ...(repository.node_id ? { nodeId: repository.node_id } : {}),
    ...(repository.html_url ? { htmlUrl: repository.html_url } : {}),
    ...(repository.visibility ? { visibility: repository.visibility } : {}),
    defaultBranch: repository.default_branch,
    ...(repository.description ? { description: repository.description } : {}),
    ...(repository.archived !== undefined ? { archived: repository.archived } : {}),
    ...(repository.disabled !== undefined ? { disabled: repository.disabled } : {}),
    firstSeenAt: observedAt,
    lastSeenAt: observedAt,
    lastAuthoritativeObservedAt: observedAt,
    ...(githubCreatedAt ? { githubCreatedAt } : {}),
    ...(githubUpdatedAt ? { githubUpdatedAt } : {}),
    ...(githubPushedAt ? { githubPushedAt } : {}),
  };
}

/**
 * Fetches the complete installation inventory before changing any local row.
 * A thrown page request therefore leaves the previous authoritative state
 * untouched; only the successful complete set reaches the store transaction.
 */
export async function refreshInstallationInventory(
  input: InventoryRefreshInput,
  github: GithubClient,
  store: M1Store,
): Promise<InventoryReconcileResult> {
  const observedAt = input.now ?? new Date();
  const localInstallation = await store.getInstallation(input.installationGithubId);
  if (!localInstallation || (localInstallation.status && localInstallation.status !== "active")) throw new Error("Installation is not active for inventory refresh");
  if (localInstallation.tenantId !== input.tenantId) throw new Error("Installation tenant mismatch during inventory refresh");
  const installation = await github.getInstallation(input.installationGithubId);
  if (installation.account.type !== "User" || installation.account.id !== localInstallation.accountGithubAccountId) throw new Error("Installation account mismatch during inventory refresh");
  if (installation.suspended_at) throw new Error("Installation is suspended during inventory refresh");
  const byGithubId = new Map<number, GithubRepository>();
  let page = 1;
  while (true) {
    const response = await github.listInstallationRepositories(page, INSTALLATION_REPOSITORY_PAGE_SIZE);
    for (const repository of response.repositories) byGithubId.set(repository.id, repository);
    if (response.nextPage === undefined) break;
    if (!Number.isSafeInteger(response.nextPage) || response.nextPage <= page) throw new Error("GitHub inventory pagination did not advance");
    page = response.nextPage;
  }
  const repositories = [...byGithubId.values()].map((repository) => mapRepository(repository, input.tenantId, localInstallation.id, observedAt));
  const currentInstallation = await store.getInstallation(input.installationGithubId);
  if (!currentInstallation || currentInstallation.tenantId !== input.tenantId || (currentInstallation.status && currentInstallation.status !== "active")) throw new Error("Installation changed during inventory refresh");
  await store.updateInstallationSnapshot({ tenantId: input.tenantId, githubInstallationId: input.installationGithubId, ...(installation.permissions ? { permissions: installation.permissions } : {}), ...(installation.repository_selection ? { repositorySelection: installation.repository_selection } : {}) });
  return store.reconcileInstallationInventory({ tenantId: input.tenantId, githubInstallationId: input.installationGithubId, repositories, observedAt });
}
