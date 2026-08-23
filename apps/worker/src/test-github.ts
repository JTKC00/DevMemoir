/** Empty M3 source methods for tests that exercise only M1/M2 endpoints. */
export const emptyHistoricalGithubMethods = {
  listBranches: async () => ({ branches: [] }),
  listTags: async () => ({ tags: [] }),
  listPullRequests: async () => ({ pullRequests: [] }),
  listIssues: async () => ({ issues: [] }),
  listReleases: async () => ({ releases: [] }),
};
