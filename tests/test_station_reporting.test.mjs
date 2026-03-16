import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGitHubSourceContext,
  createIngestPayload,
} from "../scripts/ingest_report_utils.mjs";

const repoRoot = new URL("../", import.meta.url).pathname;

test("buildGitHubSourceContext uses GitHub Actions metadata when available", () => {
  const source = buildGitHubSourceContext(
    {
      repoRoot,
      buildStartedAt: "2026-03-16T05:00:00Z",
      buildCompletedAt: "2026-03-16T05:00:12Z",
    },
    {
      GITHUB_ACTIONS: "true",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "smysnk/autoresearch-jung",
      GITHUB_REF_TYPE: "branch",
      GITHUB_REF_NAME: "master",
      GITHUB_SHA: "abc123def456",
      GITHUB_RUN_ID: "12345",
      GITHUB_RUN_NUMBER: "77",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_ACTOR: "smysnk",
      GITHUB_WORKFLOW: "Test Station CI",
      GITHUB_EVENT_NAME: "push",
    },
  );

  assert.equal(source.provider, "github-actions");
  assert.equal(source.branch, "master");
  assert.equal(source.commitSha, "abc123def456");
  assert.equal(source.buildNumber, 77);
  assert.equal(source.runId, "12345");
  assert.match(source.runUrl, /actions\/runs\/12345$/);
});

test("buildGitHubSourceContext falls back to local git metadata outside GitHub Actions", () => {
  const source = buildGitHubSourceContext(
    {
      repoRoot,
      buildStartedAt: "2026-03-16T05:00:00Z",
      buildCompletedAt: "2026-03-16T05:00:12Z",
      buildNumber: 901,
    },
    {},
  );

  assert.equal(source.provider, "manual");
  assert.ok(source.branch);
  assert.ok(source.commitSha);
  assert.equal(source.buildNumber, 901);
  assert.match(source.repositoryUrl || "", /^https?:\/\//);
});

test("buildGitHubSourceContext honors manual override metadata", () => {
  const source = buildGitHubSourceContext(
    {
      repoRoot,
      buildStartedAt: "2026-03-16T05:00:00Z",
      buildCompletedAt: "2026-03-16T05:00:12Z",
      buildNumber: 903,
    },
    {
      TEST_STATION_REPOSITORY: "smysnk/autoresearch-jung",
      TEST_STATION_REPOSITORY_URL: "https://github.com/smysnk/autoresearch-jung",
      TEST_STATION_BRANCH: "master",
      TEST_STATION_COMMIT_SHA: "deadbeef1234",
      TEST_STATION_ACTOR: "codex",
    },
  );

  assert.equal(source.repository, "smysnk/autoresearch-jung");
  assert.equal(source.repositoryUrl, "https://github.com/smysnk/autoresearch-jung");
  assert.equal(source.branch, "master");
  assert.equal(source.commitSha, "deadbeef1234");
  assert.equal(source.actor, "codex");
  assert.equal(source.buildNumber, 903);
});

test("createIngestPayload includes artifact inventory and source metadata", () => {
  const payload = createIngestPayload({
    reportPath: `${repoRoot}.test-results/ci-report/report.json`,
    projectKey: "autoresearch-jung",
    outputDir: `${repoRoot}.test-results/ci-report`,
    buildStartedAt: "2026-03-16T05:00:00Z",
    buildCompletedAt: "2026-03-16T05:00:12Z",
    buildNumber: 902,
    repoRoot,
  });

  assert.equal(payload.projectKey, "autoresearch-jung");
  assert.ok(Array.isArray(payload.artifacts));
  assert.ok(payload.artifacts.some((entry) => entry.relativePath === "report.json"));
  assert.equal(payload.source.buildNumber, 902);
  assert.ok(payload.source.commitSha);
});
