export type HomeMode = "feed" | "journal";

export type HomeRepository = {
  id: string;
  name: string;
  description?: string | null;
  createdAt?: string;
  updatedAt?: string;
  documents?: number;
  branches?: number;
  openReviews?: number;
  openIssues?: number;
};

export type HomeActivity = {
  id: string;
  projectId: string;
  actorId?: string;
  eventType: string;
  entityType?: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type HomeActivityWithRepository = HomeActivity & {
  repositoryName: string;
};

const FEED_EVENTS = new Set([
  "repository.created",
  "artifact.created",
  "commit.created",
  "material.added",
  "review.opened",
  "review.merged",
  "review.conflict",
  "issue.created",
  "issue.decided",
  "ai.review.completed",
  "release.created",
]);

export function parseHomeQuery(searchParams: URLSearchParams): { mode: HomeMode; limit: number } | null {
  for (const key of searchParams.keys()) {
    if (key !== "mode" && key !== "limit") return null;
  }
  const mode = searchParams.get("mode") ?? "feed";
  if (mode !== "feed" && mode !== "journal") return null;

  const rawLimit = searchParams.get("limit") ?? "50";
  if (!/^\d+$/.test(rawLimit)) return null;
  const limit = Number(rawLimit);
  if (limit < 1 || limit > 100) return null;

  return { mode, limit };
}

export function buildHomeDashboard(
  repositories: HomeRepository[],
  activityGroups: Array<{ repository: HomeRepository; activity: HomeActivity[] }>,
  mode: HomeMode,
  limit: number,
) {
  const all = activityGroups.flatMap(({ repository, activity }) =>
    activity.map((item) => ({
      ...item,
      repositoryName: repository.name,
    })),
  );

  const selected = (mode === "feed" ? all.filter((item) => FEED_EVENTS.has(item.eventType)) : all)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit);

  const notifications = repositories.reduce(
    (acc, repository) => {
      acc.openReviews += Number(repository.openReviews ?? 0);
      acc.openIssues += Number(repository.openIssues ?? 0);
      acc.documents += Number(repository.documents ?? 0);
      return acc;
    },
    { openReviews: 0, openIssues: 0, documents: 0 },
  );

  return {
    mode,
    repositories,
    activity: selected,
    notifications,
  };
}
