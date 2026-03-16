const rootDir = import.meta.dirname;
const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1] || "autoresearch-jung";

const singleCheck = ({
  id,
  label,
  packageName,
  cwd,
  module,
  theme,
  assertions,
  env = {},
  command,
  rawDetailsFields = ["command", "exitCode", "stdout", "stderr", "commandPayload"],
}) => ({
  id,
  label,
  adapter: "shell",
  package: packageName,
  cwd,
  env,
  command: [
    "python3",
    `${rootDir}/scripts/test_station_check.py`,
    "--",
    ...command,
  ],
  resultFormat: "single-check-json-v1",
  resultFormatOptions: {
    name: label,
    assertions,
    module,
    theme,
    classificationSource: "config",
    statusField: "status",
    failureMessageField: "message",
    rawDetailsFields,
  },
});

export default {
  schemaVersion: "1",
  project: {
    name: repositoryName,
    rootDir,
    outputDir: ".test-results/ci-report",
    rawDir: ".test-results/ci-report/raw",
  },
  execution: {
    continueOnError: true,
    defaultCoverage: false,
  },
  manifests: {
    classification: "./test-station.manifest.json",
    coverageAttribution: "./test-station.manifest.json",
  },
  enrichers: {
    sourceAnalysis: {
      enabled: true,
    },
  },
  render: {
    html: true,
    console: true,
    defaultView: "package",
    includeDetailedAnalysisToggle: true,
  },
  suites: [
    {
      id: "reporting-helpers",
      label: "Test Station reporting helpers",
      adapter: "node-test",
      package: "ci",
      cwd: rootDir,
      command: ["node", "--test", "./tests/*.test.mjs"],
      coverage: {
        enabled: true,
        mode: "same-run",
      },
    },
    singleCheck({
      id: "python-compile",
      label: "Python source compile",
      packageName: "runtime",
      cwd: rootDir,
      module: "runner",
      theme: "python",
      assertions: [
        "Compile the core Python entrypoints and runner scripts without syntax errors.",
      ],
      command: ["python3", "./scripts/check_python_sources.py"],
      rawDetailsFields: ["command", "exitCode", "stdout", "stderr", "commandPayload"],
    }),
    singleCheck({
      id: "atlas-lint",
      label: "Experiment Atlas lint",
      packageName: "experiment-atlas",
      cwd: `${rootDir}/experiment-atlas`,
      module: "atlas",
      theme: "lint",
      assertions: [
        "Run the Experiment Atlas lint checks without warnings or errors.",
      ],
      command: ["npm", "run", "lint"],
    }),
    singleCheck({
      id: "atlas-pages-build",
      label: "Experiment Atlas Pages build",
      packageName: "experiment-atlas",
      cwd: `${rootDir}/experiment-atlas`,
      module: "atlas",
      theme: "build",
      assertions: [
        "Build the static Experiment Atlas GitHub Pages snapshot successfully.",
      ],
      env: {
        AUTORESEARCH_REPO_ROOT: rootDir,
        ATLAS_STATIC_EXPORT: "1",
        NEXT_PUBLIC_ATLAS_STATIC_EXPORT: "1",
        ATLAS_BASE_PATH: `/${repositoryName}`,
      },
      command: ["npm", "run", "build:pages"],
    }),
  ],
};
