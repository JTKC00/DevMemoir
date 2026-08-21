import type { GithubClient, GithubCommit } from "@devmemoir/github";
import { projectCommitFacts } from "@devmemoir/domain";
import type { M1Store, RepositoryRecord } from "@devmemoir/db";

export type RefSyncInput = {
  tenantId: string;
  repository: RepositoryRecord;
  installationId: number;
  ownerGithubAccountId: number;
  ref: string;
  before: string;
  after: string;
  forced: boolean;
  /** Keep the per-run budget explicit so tests can prove resumable behavior. */
  maxPages?: number;
};

export type RefSyncResult = {
  status: "no-op" | "deleted" | "partial" | "synced" | "stale";
  previousHead: string | null;
  newHead: string | null;
  importedCommits: number;
  nextPage?: number;
};

const ZERO_SHA = "0".repeat(40);
export const DEFAULT_COMMIT_PAGE_BUDGET = 10;

export async function synchronizeRefHead(input: RefSyncInput, github: GithubClient, store: M1Store): Promise<RefSyncResult> {
  const previousHead = await store.getBranchHead(input.tenantId, input.repository.id, input.ref);
  if (input.after === ZERO_SHA) {
    const published = await store.finalizeRefSync({ tenantId: input.tenantId, repositoryId: input.repository.id, ref: input.ref, expectedHead: previousHead, headSha: null, invalidatePrevious: true, reachableShas: [] });
    if (!published) return { status: "stale", previousHead, newHead: await store.getBranchHead(input.tenantId, input.repository.id, input.ref), importedCommits: 0 };
    return { status: "deleted", previousHead, newHead: null, importedCommits: 0 };
  }
  if (previousHead === input.after) return { status: "no-op", previousHead, newHead: input.after, importedCommits: 0 };

  const continuation = await store.getRefSyncContinuation(input.tenantId, input.repository.id, input.ref);
  const resumable = continuation?.after === input.after && continuation.previousHead === previousHead;
  const effectiveForced = input.forced || Boolean(continuation?.forced);
  let page = resumable ? continuation.nextPage : 1;
  const maxPages = input.maxPages ?? DEFAULT_COMMIT_PAGE_BUDGET;
  let pagesRead = 0;
  let importedCommits = 0;
  const importedShas: string[] = resumable && continuation ? [...(continuation.reachableShas ?? [])] : [];
  let foundPrevious = false;
  const initialImport = previousHead === null && !resumable;

  while (pagesRead < maxPages) {
    const response = await github.listCommits({ owner: input.repository.ownerLogin, repo: input.repository.name, sha: input.after, page, perPage: 100 });
    pagesRead += 1;
    const pageCommits: GithubCommit[] = [];
    for (const commit of response.commits) {
      pageCommits.push({ ...commit, repositoryId: input.repository.id });
      if (previousHead && commit.sha === previousHead) foundPrevious = true;
    }
    for (const commit of pageCommits) {
      await store.saveCommit(input.tenantId, input.repository.id, commit, undefined, commit.htmlUrl);
      for (const event of projectCommitFacts(commit, input.ownerGithubAccountId)) {
        await store.saveDevelopmentEvent(input.tenantId, input.repository.id, event, { ...(commit.htmlUrl ? { htmlUrl: commit.htmlUrl } : {}), message: commit.message });
      }
      if (!importedShas.includes(commit.sha)) importedShas.push(commit.sha);
      importedCommits += 1;
    }

    // M1 deliberately imports only the newest page when there is no prior head.
    // For an existing head we must continue until that head is found or the
    // API has proved the new ref's reachable history is exhausted.
    if (initialImport || foundPrevious || !response.nextPage) {
      const diverged = previousHead !== null && !foundPrevious;
      const published = await store.finalizeRefSync({ tenantId: input.tenantId, repositoryId: input.repository.id, ref: input.ref, expectedHead: previousHead, headSha: input.after, invalidatePrevious: diverged || effectiveForced, reachableShas: importedShas });
      if (!published) return { status: "stale", previousHead, newHead: await store.getBranchHead(input.tenantId, input.repository.id, input.ref), importedCommits };
      return { status: "synced", previousHead, newHead: input.after, importedCommits };
    }

    page = response.nextPage;
    if (page === undefined) break;
  }

  // The old head was not found within this bounded run. Persist only the
  // continuation; advancing the branch head here would permanently lose the
  // unseen range on a restart.
  await store.setRefSyncContinuation(input.tenantId, input.repository.id, input.ref, {
    after: input.after,
    previousHead,
    nextPage: page,
    forced: effectiveForced,
    reachableShas: importedShas,
  });
  return { status: "partial", previousHead, newHead: previousHead, importedCommits, nextPage: page };
}
