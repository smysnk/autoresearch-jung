#!/usr/bin/env node

import {
  createIngestPayload,
  normalizeStorageOptions,
  publishIngestPayload,
} from "./ingest_report_utils.mjs";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const reportPath = args.input || process.env.TEST_STATION_INGEST_INPUT || "./.test-results/ci-report/report.json";
  const endpoint = args.endpoint || process.env.TEST_STATION_INGEST_ENDPOINT;
  const projectKey = args.projectKey || process.env.TEST_STATION_INGEST_PROJECT_KEY;
  const sharedKey = args.sharedKey || process.env.TEST_STATION_INGEST_SHARED_KEY;
  const payload = createIngestPayload({
    reportPath,
    projectKey,
    buildStartedAt: args.buildStartedAt || process.env.TEST_STATION_BUILD_STARTED_AT,
    buildCompletedAt: args.buildCompletedAt || process.env.TEST_STATION_BUILD_COMPLETED_AT,
    jobStatus: args.jobStatus || process.env.TEST_STATION_CI_STATUS,
    storage: normalizeStorageOptions({
      bucket: args.artifactS3Bucket || process.env.S3_BUCKET,
      prefix: args.artifactStoragePrefix || process.env.S3_STORAGE_PREFIX,
      baseUrl: args.artifactBaseUrl || process.env.S3_PUBLIC_URL,
    }),
  });
  const response = await publishIngestPayload({
    endpoint,
    sharedKey,
    payload,
  });

  process.stdout.write(`Published ${payload.projectKey}:${payload.source.provider}:${payload.source.runId || "manual"} to ${endpoint}\n`);
  if (response?.runId) {
    process.stdout.write(`runId=${response.runId}\n`);
  }
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];

    switch (token) {
      case "--input":
        parsed.input = value;
        index += 1;
        break;
      case "--endpoint":
        parsed.endpoint = value;
        index += 1;
        break;
      case "--project-key":
        parsed.projectKey = value;
        index += 1;
        break;
      case "--shared-key":
        parsed.sharedKey = value;
        index += 1;
        break;
      case "--build-started-at":
        parsed.buildStartedAt = value;
        index += 1;
        break;
      case "--build-completed-at":
        parsed.buildCompletedAt = value;
        index += 1;
        break;
      case "--job-status":
        parsed.jobStatus = value;
        index += 1;
        break;
      case "--artifact-base-url":
        parsed.artifactBaseUrl = value;
        index += 1;
        break;
      case "--artifact-storage-prefix":
        parsed.artifactStoragePrefix = value;
        index += 1;
        break;
      case "--artifact-s3-bucket":
        parsed.artifactS3Bucket = value;
        index += 1;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return parsed;
}

function printUsage() {
  process.stdout.write([
    "Usage: publish-test-station-report [options]",
    "",
    "Options:",
    "  --input <report.json>",
    "  --endpoint <https://host/api/ingest>",
    "  --project-key <project-key>",
    "  --shared-key <shared-key>",
    "  --build-started-at <iso8601>",
    "  --build-completed-at <iso8601>",
    "  --job-status <passed|failed>",
    "  --artifact-base-url <https://cdn.example.com/path>",
    "  --artifact-storage-prefix <prefix>",
    "  --artifact-s3-bucket <bucket>",
  ].join("\n"));
  process.stdout.write("\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
