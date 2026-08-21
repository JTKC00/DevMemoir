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
};

export type RefSyncResult = {
  status: "no-op" | "deleted" | "synced";
  previousHead: string | null;
  newHead: string | null;
  importedCommits: number;
};

const ZERO_SHA = "0".repeat(40);

export async function synchronizeRefHead(input: RefSyncInput, github: GithubClient, store: M1Store): Promise<RefSyncResult> {
  const previousHead = await store.getBranchHead(input.tenantId, input.repository.id, input.ref);
  if (input.after === ZERO_SHA) {
    await store.setBranchHead(input.tenantId, input.repository.id, input.ref, null);
    return { status: "deleted", previousHead, newHead: null, importedCommits: 0 };
  }
  if (previousHead === input.after) return { status: "no-op", previousHead, newHead: input.after, importedCommits: 0 };

  const commits: GithubCommit[] = [];
  let page = 1;
  let foundPrevious = false;
  do {
    const response = await github.listCommits({ owner: input.repository.ownerLogin, repo: input.repository.name, sha: input.after, page, perPage: 100 });
    for (const commit of response.commits) {
      commits.push({ ...commit, repositoryId: input.repository.id });
      if (previousHead && commit.sha === previousHead) foundPrevious = true;
    }
    if (!response.nextPage || foundPrevious || commits.length >= 100) break;
    page = response.nextPage;
  } while (page <= 10);

  for (const commit of commits) {
    const events = projectCommitFacts(commit, input.ownerGithubAccountId);
      for (const event of events) await store.saveCommit(input.tenantId, input.repository.id, commit, event, commit.htmlUrl);
  }
  await store.setBranchHead(input.tenantId, input.repository.id, input.ref, input.after);
  return { status: "synced", previousHead, newHead: input.after, importedCommits: commits.length };
}
