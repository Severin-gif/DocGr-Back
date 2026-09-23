import test from "node:test";
import assert from "node:assert/strict";
import { buildHomeDashboard, parseHomeQuery } from "./home.js";

test("parses bounded home query", () => {
  assert.deepEqual(parseHomeQuery(new URLSearchParams()), { mode: "feed", limit: 50 });
  assert.deepEqual(parseHomeQuery(new URLSearchParams("mode=journal&limit=100")), { mode: "journal", limit: 100 });
  assert.equal(parseHomeQuery(new URLSearchParams("mode=other")), null);
  assert.equal(parseHomeQuery(new URLSearchParams("limit=101")), null);
  assert.equal(parseHomeQuery(new URLSearchParams("extra=1")), null);
});

test("aggregates repositories, notifications and mode-specific activity", () => {
  const repositories = [
    { id: "r1", name: "Alpha", documents: 2, openReviews: 1, openIssues: 3 },
    { id: "r2", name: "Beta", documents: 4, openReviews: 2, openIssues: 0 },
  ];
  const groups = [
    {
      repository: repositories[0]!,
      activity: [
        { id: "e1", projectId: "r1", eventType: "folder.created", createdAt: "2026-09-22T10:00:00Z" },
        { id: "e2", projectId: "r1", eventType: "commit.created", createdAt: "2026-09-22T11:00:00Z" },
      ],
    },
    {
      repository: repositories[1]!,
      activity: [
        { id: "e3", projectId: "r2", eventType: "review.opened", createdAt: "2026-09-22T12:00:00Z" },
      ],
    },
  ];

  const feed = buildHomeDashboard(repositories, groups, "feed", 10);
  assert.deepEqual(feed.notifications, { openReviews: 3, openIssues: 3, documents: 6 });
  assert.deepEqual(feed.activity.map((item) => item.id), ["e3", "e2"]);
  assert.equal(feed.activity[0]!.repositoryName, "Beta");

  const journal = buildHomeDashboard(repositories, groups, "journal", 10);
  assert.deepEqual(journal.activity.map((item) => item.id), ["e3", "e2", "e1"]);
});
