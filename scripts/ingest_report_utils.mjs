import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SECRETISH_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PRIVATE|ACCESS_KEY|SESSION_KEY|AUTHORIZATION|CREDENTIAL)/i;

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

export function createIngestPayload(options = {}) {
  const reportPath = requireNonEmptyString(options.reportPath, "reportPath");
  const projectKey = requireNonEmptyString(options.projectKey, "projectKey");
  const report = options.report || readJson(reportPath);
  const outputDir = path.resolve(options.outputDir || path.dirname(reportPath));
  const storage = normalizeStorageOptions(options.storage);
  const source = buildGitHubSourceContext(
    {
      buildStartedAt: options.buildStartedAt,
      buildCompletedAt: options.buildCompletedAt,
      buildNumber: options.buildNumber,
      jobStatus: options.jobStatus,
      artifactCount: countOutputFiles(outputDir),
      storage,
      repoRoot: options.repoRoot || outputDir,
    },
    options.env,
  );

  return {
    projectKey,
    report: attachArtifactLocations(report, storage),
    source,
    artifacts: collectOutputArtifacts(outputDir, storage),
  };
}

export async function publishIngestPayload(options = {}) {
  const endpoint = requireNonEmptyString(options.endpoint, "endpoint");
  const sharedKey = requireNonEmptyString(options.sharedKey, "sharedKey");
  const payload = options.payload;
  if (!payload || typeof payload !== "object") {
    throw new Error("payload is required");
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required to publish ingest payloads.");
  }

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sharedKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  const body = tryParseJson(text);

  if (!response.ok) {
    const detail = body?.error?.message || body?.message || text || `HTTP ${response.status}`;
    throw new Error(`Ingest publish failed (${response.status}): ${detail}`);
  }

  return body;
}

export function collectOutputArtifacts(outputDir, storage = {}) {
  const files = listFilesRecursively(path.resolve(outputDir));
  return files
    .map((absolutePath) => toRelativePosixPath(outputDir, absolutePath))
    .sort((left, right) => left.localeCompare(right))
    .map((relativePath) => {
      const locator = createArtifactLocator(relativePath, storage);
      return {
        label: createArtifactLabel(relativePath),
        relativePath,
        href: relativePath,
        kind: "file",
        mediaType: inferMediaType(relativePath),
        storageKey: locator.storageKey,
        sourceUrl: locator.sourceUrl,
      };
    });
}

export function attachArtifactLocations(report, storage = {}) {
  const cloned = structuredClone(report);
  const packages = Array.isArray(cloned?.packages) ? cloned.packages : [];

  for (const packageEntry of packages) {
    const suites = Array.isArray(packageEntry?.suites) ? packageEntry.suites : [];
    for (const suite of suites) {
      const rawArtifacts = Array.isArray(suite?.rawArtifacts) ? suite.rawArtifacts : [];
      for (const artifact of rawArtifacts) {
        if (!artifact || typeof artifact !== "object" || !artifact.relativePath) {
          continue;
        }
        const relativePath = path.posix.join("raw", normalizeRelativePath(artifact.relativePath));
        const locator = createArtifactLocator(relativePath, storage);
        artifact.storageKey = locator.storageKey;
        artifact.sourceUrl = locator.sourceUrl;
      }
    }
  }

  return cloned;
}

export function buildGitHubSourceContext(options = {}, env = process.env) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const event = readGitHubEvent(env.GITHUB_EVENT_PATH);
  const environment = captureGitHubDefaultEnvironment(env);
  const serverUrl = trimToNull(env.GITHUB_SERVER_URL) || "https://github.com";
  const gitRemote = resolveGitRemote(repoRoot);
  const repositoryFullName = trimToNull(event?.repository?.full_name)
    || trimToNull(env.GITHUB_REPOSITORY)
    || trimToNull(env.TEST_STATION_REPOSITORY)
    || gitRemote.repository;
  const repositoryUrl = trimToNull(event?.repository?.html_url)
    || trimToNull(env.TEST_STATION_REPOSITORY_URL)
    || gitRemote.url
    || (repositoryFullName ? `${serverUrl}/${repositoryFullName}` : null);
  const branch = resolveBranch(env, event, repoRoot);
  const tag = resolveTag(env, event);
  const startedAt = normalizeTimestamp(options.buildStartedAt) || normalizeTimestamp(env.TEST_STATION_BUILD_STARTED_AT) || new Date().toISOString();
  const completedAt = normalizeTimestamp(options.buildCompletedAt) || normalizeTimestamp(env.TEST_STATION_BUILD_COMPLETED_AT) || new Date().toISOString();
  const buildDurationMs = diffTimestamps(startedAt, completedAt);
  const buildNumber = parseInteger(options.buildNumber)
    || parseInteger(env.TEST_STATION_BUILD_NUMBER)
    || parseInteger(env.GITHUB_RUN_NUMBER)
    || parseInteger(resolveGitValue(repoRoot, ["rev-list", "--count", "HEAD"]));
  const runId = trimToNull(env.GITHUB_RUN_ID) || trimToNull(env.TEST_STATION_RUN_ID);
  const runAttempt = parseInteger(env.GITHUB_RUN_ATTEMPT);
  const runUrl = repositoryFullName && runId ? `${serverUrl}/${repositoryFullName}/actions/runs/${runId}` : null;
  const semanticVersion = tag && /^v?\d+\.\d+\.\d+([-.+].+)?$/.test(tag) ? tag.replace(/^v/, "") : null;
  const jobStatus = trimToNull(options.jobStatus) || trimToNull(env.TEST_STATION_CI_STATUS);
  const storage = normalizeStorageOptions(options.storage);
  const commitSha = trimToNull(env.GITHUB_SHA)
    || trimToNull(env.TEST_STATION_COMMIT_SHA)
    || resolveGitValue(repoRoot, ["rev-parse", "HEAD"]);

  return {
    provider: trimToNull(env.GITHUB_ACTIONS) === "true" ? "github-actions" : "manual",
    runId,
    runUrl,
    repositoryUrl,
    repository: repositoryFullName,
    defaultBranch: trimToNull(event?.repository?.default_branch),
    branch,
    tag,
    commitSha,
    actor: trimToNull(env.GITHUB_ACTOR)
      || trimToNull(env.TEST_STATION_ACTOR)
      || trimToNull(env.USER)
      || trimToNull(env.USERNAME),
    startedAt,
    completedAt,
    buildNumber,
    semanticVersion,
    releaseName: tag,
    versionKey: tag ? `tag:${tag}` : null,
    ci: {
      eventName: trimToNull(env.GITHUB_EVENT_NAME),
      workflow: trimToNull(env.GITHUB_WORKFLOW),
      workflowRef: trimToNull(env.GITHUB_WORKFLOW_REF),
      workflowSha: trimToNull(env.GITHUB_WORKFLOW_SHA),
      job: trimToNull(env.GITHUB_JOB),
      ref: trimToNull(env.GITHUB_REF),
      refName: trimToNull(env.GITHUB_REF_NAME),
      refType: trimToNull(env.GITHUB_REF_TYPE),
      runAttempt,
      repositoryOwner: trimToNull(env.GITHUB_REPOSITORY_OWNER),
      serverUrl,
      status: jobStatus,
      buildDurationMs,
      artifactCount: Number.isFinite(options.artifactCount) ? options.artifactCount : null,
      environment,
      storage: {
        bucket: storage.bucket,
        prefix: storage.prefix,
        baseUrl: storage.baseUrl,
      },
    },
  };
}

export function normalizeStorageOptions(storage = {}) {
  return {
    bucket: trimToNull(storage.bucket),
    prefix: normalizeRelativePath(storage.prefix || ""),
    baseUrl: normalizeBaseUrl(storage.baseUrl),
  };
}

function captureGitHubDefaultEnvironment(env = process.env) {
  if (!env || typeof env !== "object") {
    return {};
  }

  const entries = Object.entries(env)
    .filter(([name]) => isGitHubDefaultEnvironmentName(name) && !isSecretLikeEnvironmentName(name))
    .map(([name, value]) => [name, normalizeEnvironmentValue(value)])
    .filter(([, value]) => value !== null)
    .sort(([left], [right]) => left.localeCompare(right));

  return Object.fromEntries(entries);
}

function isGitHubDefaultEnvironmentName(name) {
  return name === "CI" || name.startsWith("GITHUB_") || name.startsWith("RUNNER_");
}

function isSecretLikeEnvironmentName(name) {
  return SECRETISH_ENV_NAME.test(name);
}

function normalizeEnvironmentValue(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

function createArtifactLocator(relativePath, storage = {}) {
  const normalizedRelativePath = normalizeRelativePath(relativePath);
  const prefix = normalizeRelativePath(storage.prefix || "");
  const objectPath = prefix ? path.posix.join(prefix, normalizedRelativePath) : normalizedRelativePath;

  return {
    storageKey: storage.bucket ? `s3://${storage.bucket}/${objectPath}` : null,
    sourceUrl: storage.baseUrl ? new URL(objectPath, `${storage.baseUrl}/`).toString() : null,
  };
}

function readGitHubEvent(eventPath) {
  if (!trimToNull(eventPath)) {
    return {};
  }

  try {
    return readJson(eventPath);
  } catch {
    return {};
  }
}

function resolveBranch(env, event, repoRoot) {
  return trimToNull(env.GITHUB_HEAD_REF)
    || trimToNull(event?.pull_request?.head?.ref)
    || trimToNull(env.TEST_STATION_BRANCH)
    || (trimToNull(env.GITHUB_REF_TYPE) === "branch" ? trimToNull(env.GITHUB_REF_NAME) : null)
    || resolveGitValue(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

function resolveTag(env, event) {
  return (trimToNull(env.GITHUB_REF_TYPE) === "tag" ? trimToNull(env.GITHUB_REF_NAME) : null)
    || trimToNull(event?.release?.tag_name);
}

function resolveGitRemote(repoRoot) {
  const remote = resolveGitValue(repoRoot, ["config", "--get", "remote.origin.url"]);
  if (!remote) {
    return {
      repository: null,
      url: null,
    };
  }

  const normalized = normalizeGitRemote(remote);
  return {
    repository: normalized?.repository || null,
    url: normalized?.url || null,
  };
}

function normalizeGitRemote(remote) {
  const trimmed = trimToNull(remote);
  if (!trimmed) {
    return null;
  }

  const sshMatch = trimmed.match(/^git@github\.com:(.+?)(?:\.git)?$/i);
  if (sshMatch) {
    const repository = sshMatch[1];
    return {
      repository,
      url: `https://github.com/${repository}`,
    };
  }

  const httpsMatch = trimmed.match(/^https:\/\/github\.com\/(.+?)(?:\.git)?$/i);
  if (httpsMatch) {
    return {
      repository: httpsMatch[1],
      url: `https://github.com/${httpsMatch[1]}`,
    };
  }

  return {
    repository: null,
    url: trimmed,
  };
}

function resolveGitValue(repoRoot, args) {
  try {
    return trimToNull(
      execFileSync("git", args, {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return null;
  }
}

function listFilesRecursively(rootDir) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursively(absolutePath));
      continue;
    }
    if (entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files;
}

function countOutputFiles(outputDir) {
  return listFilesRecursively(outputDir).length;
}

function createArtifactLabel(relativePath) {
  switch (relativePath) {
    case "report.json":
      return "Normalized report";
    case "modules.json":
      return "Module rollup";
    case "ownership.json":
      return "Ownership rollup";
    case "index.html":
      return "HTML report";
    default:
      return path.posix.basename(relativePath);
  }
}

function inferMediaType(relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  switch (extension) {
    case ".json":
      return "application/json";
    case ".html":
      return "text/html";
    case ".txt":
    case ".log":
      return "text/plain";
    case ".ndjson":
      return "application/x-ndjson";
    case ".zip":
      return "application/zip";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webm":
      return "video/webm";
    default:
      return null;
  }
}

function tryParseJson(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeRelativePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

function normalizeBaseUrl(value) {
  const trimmed = trimToNull(value);
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/, "");
}

function toRelativePosixPath(rootDir, absolutePath) {
  return path.relative(rootDir, absolutePath).split(path.sep).join("/");
}

function normalizeTimestamp(value) {
  const trimmed = trimToNull(value);
  if (!trimmed) {
    return null;
  }
  const timestamp = new Date(trimmed);
  if (Number.isNaN(timestamp.valueOf())) {
    return null;
  }
  return timestamp.toISOString();
}

function diffTimestamps(startedAt, completedAt) {
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed)) {
    return null;
  }
  return Math.max(0, completed - started);
}

function parseInteger(value) {
  const normalized = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(normalized) ? normalized : null;
}

function trimToNull(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function requireNonEmptyString(value, name) {
  const normalized = trimToNull(value);
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}
