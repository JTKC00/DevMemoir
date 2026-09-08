export type ActivityResponse = {
  completeness: string;
  repository?: { id: string; fullName: string; private: boolean };
  historical?: {
    status: string;
    stage: string;
    lastSuccessAt?: string;
    counts: { commits: number; branches: number; tags: number; pullRequests: number; issues: number; releases: number };
    completeness: { observed: string; reachableAtSync: string; knownUnknown: string; outOfScope: string };
  };
  events: Array<{ id: string; repositoryId: string; sourceKind: string; sourceExternalId: string; eventType: string; occurredAt: string; verb: string; contributionRole: string; ownerContributionRole?: string; contextKind: string; actorKind: string; attributionConfidence: string; completenessState: string; visibility: string; projectionVersion: number; title?: string; message?: string; sourceUrl?: string }>;
};

export const ACTIVITY_TYPES = { all: "All activity", commit: "Commits", pull_request: "Pull requests", issue: "Issues", release: "Releases", repository: "Repository changes", tag: "Tags" } as const;
export const ACTIVITY_CONTEXTS = { default: "Overview", personal: "My contributions", project: "Project activity", unknown: "Unattributed activity" } as const;
export type ActivityParams = { context?: string; type?: string; includeBots?: string; error?: string };

export function activityFilters(params: ActivityParams) {
  const context = Object.hasOwn(ACTIVITY_CONTEXTS, params.context ?? "") ? params.context as keyof typeof ACTIVITY_CONTEXTS : "default";
  const type = Object.hasOwn(ACTIVITY_TYPES, params.type ?? "") ? params.type as keyof typeof ACTIVITY_TYPES : "all";
  const includeBots = params.includeBots === "true";
  return { context, type, includeBots };
}

export function groupActivity(events: ActivityResponse["events"], type: keyof typeof ACTIVITY_TYPES) {
  const groups = new Map<string, ActivityResponse["events"]>();
  const filtered = events.filter((event) => type === "all" || event.sourceKind === type);
  filtered.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || a.id.localeCompare(b.id));
  for (const event of filtered) {
    const day = new Date(event.occurredAt).toISOString().slice(0, 10);
    const group = groups.get(day) ?? [];
    group.push(event);
    groups.set(day, group);
  }
  return [...groups].map(([day, events]) => ({ day, events }));
}
