import "server-only";

import fs from "node:fs";
import path from "node:path";
import { unstable_noStore as noStore } from "next/cache";

import type {
  CodexPhaseArtifact,
  CodeSnapshot,
  IterationNode,
  KnowledgeExperimentLink,
  KnowledgeTensionPair,
  LiveReflectionState,
  LiveRunProgress,
  LiveSessionState,
  MetricSnapshot,
  SessionGraph,
  SessionKnowledgeSummary,
  SessionStats,
  TensionNode,
  TranscendentArtifact,
} from "./types";

type JsonRecord = Record<string, unknown>;
type KnowledgeBundle = {
  experimentsById: Map<string, JsonRecord>;
  sessionSummaries: Map<string, JsonRecord>;
  incumbents: JsonRecord | null;
};

function applyRequestCachingPolicy(): void {
  if (process.env.ATLAS_STATIC_EXPORT === "1") {
    return;
  }
  noStore();
}

function getRepoRoot(): string {
  if (process.env.AUTORESEARCH_REPO_ROOT) {
    return path.resolve(process.env.AUTORESEARCH_REPO_ROOT);
  }

  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "pyproject.toml"))) {
    return cwd;
  }
  if (path.basename(cwd) === "experiment-atlas") {
    return path.resolve(cwd, "..");
  }
  return path.resolve(cwd);
}

function relativeToRepo(filePath: string): string {
  return path.relative(getRepoRoot(), filePath) || ".";
}

function slugify(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

function isDirectory(target: string): boolean {
  return fs.existsSync(target) && fs.statSync(target).isDirectory();
}

function listDirectories(target: string): string[] {
  if (!isDirectory(target)) {
    return [];
  }

  return fs
    .readdirSync(target, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(target, entry.name))
    .sort();
}

function readText(target: string): string | null {
  if (!fs.existsSync(target)) {
    return null;
  }
  return fs.readFileSync(target, "utf8");
}

function readJson(target: string): JsonRecord | null {
  const content = readText(target);
  if (!content) {
    return null;
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as JsonRecord;
    }
  } catch {
    return null;
  }

  return null;
}

function readJsonLines(target: string): JsonRecord[] {
  const content = readText(target);
  if (!content) {
    return [];
  }

  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return asRecord(parsed);
      } catch {
        return null;
      }
    })
    .filter((entry): entry is JsonRecord => Boolean(entry));
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry : null))
    .filter((entry): entry is string => Boolean(entry));
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function compareNullableNumberAsc(left: number | null, right: number | null): number {
  if (left === null && right === null) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return left - right;
}

function compareNullableNumberDesc(left: number | null, right: number | null): number {
  return compareNullableNumberAsc(right, left);
}

function padIteration(iteration: number): string {
  return String(iteration).padStart(3, "0");
}

function makeCodeSnapshot(
  label: string,
  language: CodeSnapshot["language"],
  content: string | null,
  filePath: string | null,
): CodeSnapshot | null {
  if (!content) {
    return null;
  }
  return {
    label,
    language,
    content,
    path: filePath ? relativeToRepo(filePath) : null,
  };
}

function parseExperimentId(experimentId: string | null): {
  sessionId: string;
  iteration: number;
  iterationLabel: string;
} | null {
  if (!experimentId) {
    return null;
  }

  const [sessionId, iterationLabel] = experimentId.split(":");
  if (!sessionId || !iterationLabel) {
    return null;
  }

  const iteration = Number.parseInt(iterationLabel, 10);
  return {
    sessionId,
    iteration: Number.isFinite(iteration) ? iteration : 0,
    iterationLabel: /^\d+$/.test(iterationLabel) ? iterationLabel.padStart(3, "0") : iterationLabel,
  };
}

function sessionPathFromSourceIterationPath(sourceIterationPath: string | null): string | null {
  if (!sourceIterationPath) {
    return null;
  }
  const normalized = sourceIterationPath.replaceAll("\\", "/");
  const marker = "/iterations/";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }
  return normalized.slice(0, markerIndex);
}

function loadKnowledgeBundle(): KnowledgeBundle {
  const root = path.join(getRepoRoot(), "knowledge_base");
  if (!isDirectory(root)) {
    return {
      experimentsById: new Map(),
      sessionSummaries: new Map(),
      incumbents: null,
    };
  }

  const experimentsById = new Map<string, JsonRecord>();
  for (const record of readJsonLines(path.join(root, "experiments.jsonl"))) {
    const experimentId = asString(record.experiment_id);
    if (experimentId) {
      experimentsById.set(experimentId, record);
    }
  }

  const sessionSummaries = new Map<string, JsonRecord>();
  const sessionsRoot = path.join(root, "sessions");
  if (fs.existsSync(sessionsRoot)) {
    for (const entry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const sessionSummary = readJson(path.join(sessionsRoot, entry.name));
      if (!sessionSummary) {
        continue;
      }
      const sessionId = asString(sessionSummary.session_id);
      if (sessionId) {
        sessionSummaries.set(sessionId, sessionSummary);
      }
    }
  }

  return {
    experimentsById,
    sessionSummaries,
    incumbents: readJson(path.join(root, "incumbents.json")),
  };
}

function buildKnowledgeExperimentLink(record: JsonRecord | null): KnowledgeExperimentLink | null {
  if (!record) {
    return null;
  }

  const experimentId = asString(record.experiment_id);
  const parsed = parseExperimentId(experimentId);
  if (!experimentId || !parsed) {
    return null;
  }

  const sourceIterationPath = asString(record.source_iteration_path);

  return {
    experimentId,
    sessionId: asString(record.session_id) ?? parsed.sessionId,
    iteration: toNumber(record.iteration) ?? parsed.iteration,
    iterationLabel: asString(record.iteration_label) ?? parsed.iterationLabel,
    branch: asString(record.branch),
    title: asString(record.branch),
    sessionPath: sessionPathFromSourceIterationPath(sourceIterationPath),
    sourceIterationPath,
    knowledgeRef: asString(record.knowledge_ref),
    valBpb: toNumber(record.val_bpb),
    keepDiscardStatus: asString(record.keep_discard_status),
    outcome: asString(record.outcome) ?? asString(record.status),
    takeaway: asString(record.takeaway),
    confidence: asString(record.confidence),
    evidenceStrength: toNumber(record.evidence_strength),
    axisTags: asStringArray(record.axis_tags),
    mechanismTags: asStringArray(record.mechanism_tags),
  };
}

function buildKnowledgeTensionPair(record: JsonRecord | null): KnowledgeTensionPair | null {
  if (!record) {
    return null;
  }

  return {
    anchorExperimentId: asString(record.anchor_experiment_id),
    opposingExperimentId: asString(record.opposing_experiment_id),
    selectionReason: asString(record.selection_reason),
    sharedAxes: asStringArray(record.shared_axes),
    opposedAxes: asStringArray(record.opposed_axes),
    relevanceScore: toNumber(record.relevance_score),
    oppositionScore: toNumber(record.opposition_score),
    totalScore: toNumber(record.total_score),
    transcendentPrediction: asString(record.transcendent_prediction),
  };
}

function resolveKnowledgeExperimentLinks(
  experimentIds: string[],
  knowledgeBundle: KnowledgeBundle,
): KnowledgeExperimentLink[] {
  return experimentIds
    .map((experimentId) => buildKnowledgeExperimentLink(knowledgeBundle.experimentsById.get(experimentId) ?? null))
    .filter((entry): entry is KnowledgeExperimentLink => Boolean(entry));
}

function buildSessionKnowledgeSummary(
  sessionId: string,
  knowledgeBundle: KnowledgeBundle,
): SessionKnowledgeSummary | null {
  const summary = knowledgeBundle.sessionSummaries.get(sessionId) ?? null;
  if (!summary) {
    return null;
  }

  const bestExperimentId = asString(summary.best_experiment_id);
  const latestAnchorExperimentId = asString(summary.latest_anchor_experiment_id);
  const latestOpposingExperimentId = asString(summary.latest_opposing_experiment_id);
  const bestExperiment = buildKnowledgeExperimentLink(
    bestExperimentId ? knowledgeBundle.experimentsById.get(bestExperimentId) ?? null : null,
  );
  const latestAnchor = buildKnowledgeExperimentLink(
    latestAnchorExperimentId ? knowledgeBundle.experimentsById.get(latestAnchorExperimentId) ?? null : null,
  );
  const latestOpposing = buildKnowledgeExperimentLink(
    latestOpposingExperimentId ? knowledgeBundle.experimentsById.get(latestOpposingExperimentId) ?? null : null,
  );

  return {
    bestExperimentId,
    bestValBpb: toNumber(summary.best_val_bpb),
    latestAnchorExperimentId,
    latestOpposingExperimentId,
    defaultTensionPairCount: toNumber(summary.default_tension_pair_count),
    defaultTensionPairsWithOpposition: toNumber(summary.default_tension_pairs_with_opposition),
    sourceSessionPath: asString(summary.source_session_path),
    bestExperiment,
    latestAnchor,
    latestOpposing,
    raw: summary,
  };
}

function dedupeKnowledgeLinks(links: KnowledgeExperimentLink[]): KnowledgeExperimentLink[] {
  const seen = new Set<string>();
  const deduped: KnowledgeExperimentLink[] = [];
  for (const link of links) {
    if (seen.has(link.experimentId)) {
      continue;
    }
    seen.add(link.experimentId);
    deduped.push(link);
  }
  return deduped;
}

function buildIncumbentLineage(
  iterations: IterationNode[],
  knowledgeBundle: KnowledgeBundle,
): KnowledgeExperimentLink[] {
  const ids: string[] = [];
  for (const iteration of [...iterations].sort((left, right) => left.iteration - right.iteration)) {
    if (iteration.isIncumbentCandidate) {
      ids.push(iteration.id);
    }
    if (iteration.knowledgeAnchorExperimentId) {
      ids.push(iteration.knowledgeAnchorExperimentId);
    }
  }

  return dedupeKnowledgeLinks(resolveKnowledgeExperimentLinks(ids, knowledgeBundle)).sort((left, right) => {
    const valDelta = compareNullableNumberAsc(left.valBpb, right.valBpb);
    if (valDelta !== 0) {
      return valDelta;
    }
    return left.experimentId.localeCompare(right.experimentId);
  });
}

function buildStrongestCounterexamples(
  iterations: IterationNode[],
  sessionKnowledge: SessionKnowledgeSummary | null,
  knowledgeBundle: KnowledgeBundle,
): KnowledgeExperimentLink[] {
  const candidateIds = new Set<string>();
  const latestAnchorExperimentId =
    [...iterations]
      .sort((left, right) => right.iteration - left.iteration)
      .map((iteration) => iteration.knowledgeAnchorExperimentId)
      .find((value): value is string => Boolean(value)) ?? sessionKnowledge?.latestAnchorExperimentId ?? null;

  for (const iteration of iterations) {
    if (iteration.knowledgeOpposingExperimentId) {
      candidateIds.add(iteration.knowledgeOpposingExperimentId);
    }
    for (const opposing of iteration.opposingExperiments) {
      candidateIds.add(opposing.experimentId);
    }
  }

  if (latestAnchorExperimentId) {
    for (const [experimentId, record] of knowledgeBundle.experimentsById.entries()) {
      if (asStringArray(record.opposes_experiment_ids).includes(latestAnchorExperimentId)) {
        candidateIds.add(experimentId);
      }
    }
  }

  return dedupeKnowledgeLinks(resolveKnowledgeExperimentLinks([...candidateIds], knowledgeBundle)).sort((left, right) => {
    const evidenceDelta = compareNullableNumberDesc(left.evidenceStrength, right.evidenceStrength);
    if (evidenceDelta !== 0) {
      return evidenceDelta;
    }
    const signalDelta = compareNullableNumberAsc(left.valBpb, right.valBpb);
    if (signalDelta !== 0) {
      return signalDelta;
    }
    return left.experimentId.localeCompare(right.experimentId);
  });
}

function parseRunLogSummary(runLog: string | null): JsonRecord {
  if (!runLog) {
    return {};
  }

  const summary: JsonRecord = {};
  const matches = [...runLog.matchAll(/^([a-z_]+):\s+([^\n]+)$/gm)];
  for (const match of matches) {
    const [, key, rawValue] = match;
    const trimmed = rawValue.trim();
    summary[key] = toNumber(trimmed) ?? trimmed;
  }

  return summary;
}

function normalizeMetrics(raw: JsonRecord | null): MetricSnapshot {
  const source = raw ?? {};
  return {
    valBpb: toNumber(source.val_bpb ?? source.valBpb),
    peakVramMb: toNumber(source.peak_vram_mb ?? source.peakVramMb),
    trainingSeconds: toNumber(source.training_seconds ?? source.trainingSeconds),
    totalSeconds: toNumber(source.total_seconds ?? source.totalSeconds),
    mfuPercent: toNumber(source.mfu_percent ?? source.mfuPercent),
    totalTokensM: toNumber(source.total_tokens_M ?? source.totalTokensM),
    numSteps: toNumber(source.num_steps ?? source.numSteps),
    numParamsM: toNumber(source.num_params_M ?? source.numParamsM),
    depth: toNumber(source.depth),
    raw: source,
  };
}

function parseLiveRunProgress(runLog: string | null): LiveRunProgress | null {
  if (!runLog) {
    return null;
  }

  const stepMatches = [...runLog.matchAll(
    /step\s+(\d+)\s+\(([\d.]+)%\)\s+\|\s+loss:\s+([\d.]+)\s+\|\s+lrm:\s+([\d.]+)\s+\|\s+dt:\s+\d+ms\s+\|\s+tok\/sec:\s+([\d,]+)\s+\|\s+mfu:\s+([\d.]+)%\s+\|\s+epoch:\s+(\d+)\s+\|\s+remaining:\s+(\d+)s/gi,
  )];
  const match = stepMatches.at(-1);
  if (!match) {
    return null;
  }

  return {
    step: toNumber(match[1]),
    progressPct: toNumber(match[2]),
    trainLoss: toNumber(match[3]),
    trainingSecondsElapsed: null,
    lrMultiplier: toNumber(match[4]),
    tokensPerSecond: toNumber(match[5].replaceAll(",", "")),
    mfuPercent: toNumber(match[6]),
    epoch: toNumber(match[7]),
    remainingSeconds: toNumber(match[8]),
    stepDtMs: null,
    currentVramMb: null,
    reservedVramMb: null,
    peakVramMb: null,
    valBpb: null,
    gpuUtilPercent: null,
    gpuMemoryUtilPercent: null,
    tempC: null,
    powerW: null,
  };
}

type LiveTelemetryParseResult = {
  progress: LiveRunProgress | null;
  attentionBackend: string | null;
  timeBudgetSeconds: number | null;
  deviceBatchSize: number | null;
  totalBatchSize: number | null;
  gradAccumSteps: number | null;
  depth: number | null;
  numParamsM: number | null;
  lastEventType: string | null;
};

type LiveRunnerEventsParseResult = {
  lastEventType: string | null;
  reflection: LiveReflectionState | null;
};

function readJsonFromLine(line: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function scaleParamTotal(value: unknown): number | null {
  const total = toNumber(value);
  return total === null ? null : total / 1_000_000;
}

function parseLiveTelemetryEvents(content: string | null): LiveTelemetryParseResult {
  const fallback: LiveTelemetryParseResult = {
    progress: null,
    attentionBackend: null,
    timeBudgetSeconds: null,
    deviceBatchSize: null,
    totalBatchSize: null,
    gradAccumSteps: null,
    depth: null,
    numParamsM: null,
    lastEventType: null,
  };
  if (!content) {
    return fallback;
  }

  let latestTrainStep: JsonRecord | null = null;
  let runStarted: JsonRecord | null = null;
  let runSummary: JsonRecord | null = null;
  let lastEventType: string | null = null;

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const event = readJsonFromLine(line);
    if (!event) {
      continue;
    }
    lastEventType = asString(event.type) ?? lastEventType;
    if (event.type === "run_started") {
      runStarted = event;
      continue;
    }
    if (event.type === "train_step") {
      latestTrainStep = event;
      continue;
    }
    if (event.type === "run_summary") {
      runSummary = event;
    }
  }

  const progressSource = latestTrainStep ?? runSummary;
  const cuda = asRecord(progressSource?.cuda);
  const config = asRecord(runStarted?.config);
  const paramCounts = asRecord(runStarted?.param_counts);

  return {
    progress: progressSource
      ? {
          step: toNumber(progressSource.step ?? progressSource.num_steps),
          epoch: toNumber(progressSource.epoch),
          progressPct: toNumber(progressSource.progress_pct) ?? (progressSource === runSummary ? 100 : null),
          remainingSeconds: toNumber(progressSource.remaining_seconds) ?? (progressSource === runSummary ? 0 : null),
          trainLoss: toNumber(progressSource.train_loss_ema ?? progressSource.train_loss_raw),
          trainingSecondsElapsed: toNumber(progressSource.training_seconds_elapsed ?? progressSource.training_seconds),
          lrMultiplier: toNumber(progressSource.lr_multiplier),
          tokensPerSecond: toNumber(progressSource.tokens_per_second),
          mfuPercent: toNumber(progressSource.mfu_percent_instant ?? progressSource.mfu_percent),
          stepDtMs: toNumber(progressSource.step_dt_ms),
          currentVramMb: toNumber(cuda?.memory_allocated_mb),
          reservedVramMb: toNumber(cuda?.memory_reserved_mb),
          peakVramMb: toNumber(cuda?.max_memory_allocated_mb ?? progressSource.peak_vram_mb),
          valBpb: toNumber(progressSource.val_bpb),
          gpuUtilPercent: toNumber(asRecord(progressSource.gpu)?.util_percent),
          gpuMemoryUtilPercent: toNumber(asRecord(progressSource.gpu)?.mem_util_percent),
          tempC: toNumber(asRecord(progressSource.gpu)?.temp_c),
          powerW: toNumber(asRecord(progressSource.gpu)?.power_w),
        }
      : null,
    attentionBackend: asString(runStarted?.attention_backend),
    timeBudgetSeconds: toNumber(runStarted?.time_budget_s),
    deviceBatchSize: toNumber(runStarted?.device_batch_size),
    totalBatchSize: toNumber(runStarted?.total_batch_size),
    gradAccumSteps: toNumber(runStarted?.grad_accum_steps),
    depth: toNumber(runSummary?.depth ?? config?.n_layer),
    numParamsM: toNumber(runSummary?.num_params_M) ?? scaleParamTotal(paramCounts?.total),
    lastEventType,
  };
}

function parseLiveRunnerEvents(content: string | null): LiveRunnerEventsParseResult {
  const fallback: LiveRunnerEventsParseResult = {
    lastEventType: null,
    reflection: null,
  };
  if (!content) {
    return fallback;
  }

  let lastEventType: string | null = null;
  let reflection: LiveReflectionState | null = null;

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const event = readJsonFromLine(line);
    if (!event) {
      continue;
    }
    lastEventType = asString(event.type) ?? lastEventType;
    if (event.type !== "reflection_completed") {
      continue;
    }
    const reflectChanges = asRecord(event.reflect_changes);
    const transcendent = asRecord(event.transcendent_result);
    reflection = {
      outcome: asString(event.outcome),
      contradictedAssumption: asString(event.contradicted_assumption),
      keepDiscardStatus: asString(event.keep_discard_status),
      framingDiagnosis: asString(event.framing_diagnosis),
      nextMoveType: asString(event.next_move_type),
      summary: asString(reflectChanges?.summary) ?? asString(event.summary),
      modifiedFiles: asStringArray(reflectChanges?.modified_files),
      transcendentThought: asString(transcendent?.emergent_thought),
      resultStatus: asString(transcendent?.result_status),
    };
  }

  return {
    lastEventType,
    reflection,
  };
}

function parseRunpodTimestamp(executionId: string): string | null {
  const match = executionId.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/);
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
}

function loadTension(tensionDir: string, iteration: number): TensionNode {
  const metaPath = path.join(tensionDir, "meta.json");
  const thesisPath = path.join(tensionDir, "thesis", "train.py");
  const antithesisPath = path.join(tensionDir, "antithesis", "train.py");
  const meta = readJson(metaPath);
  const id = asString(meta?.id) ?? path.basename(tensionDir);

  return {
    id,
    label: asString(meta?.label) ?? id,
    kind: asString(meta?.kind),
    whyActive: asString(meta?.why_active),
    favoredSide: asString(meta?.favored_side),
    createdInIteration: toNumber(meta?.created_in_iteration),
    updatedInIteration: toNumber(meta?.updated_in_iteration) ?? iteration,
    latestIteration: iteration,
    iterationRefs: [iteration],
    thesis: makeCodeSnapshot("Thesis", "python", readText(thesisPath), thesisPath),
    antithesis: makeCodeSnapshot("Antithesis", "python", readText(antithesisPath), antithesisPath),
    metaRaw: meta,
  };
}

function mergeTensions(iterations: IterationNode[]): TensionNode[] {
  const merged = new Map<string, TensionNode>();

  for (const iteration of iterations) {
    for (const tension of iteration.tensions) {
      const existing = merged.get(tension.id);
      if (!existing) {
        merged.set(tension.id, { ...tension });
        continue;
      }

      existing.iterationRefs = [...new Set([...existing.iterationRefs, ...tension.iterationRefs])].sort((a, b) => a - b);
      existing.latestIteration = Math.max(existing.latestIteration ?? 0, tension.latestIteration ?? 0);
      existing.label = tension.label || existing.label;
      existing.kind = tension.kind ?? existing.kind;
      existing.whyActive = tension.whyActive ?? existing.whyActive;
      existing.favoredSide = tension.favoredSide ?? existing.favoredSide;
      existing.createdInIteration = existing.createdInIteration ?? tension.createdInIteration;
      existing.updatedInIteration = tension.updatedInIteration ?? existing.updatedInIteration;
      existing.thesis = tension.thesis ?? existing.thesis;
      existing.antithesis = tension.antithesis ?? existing.antithesis;
      existing.metaRaw = tension.metaRaw ?? existing.metaRaw;
    }
  }

  return [...merged.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function buildStats(iterations: IterationNode[], tensions: TensionNode[]): SessionStats {
  const valBpbs = iterations
    .map((iteration) => iteration.metrics.valBpb)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);

  const latestValBpb = [...iterations]
    .sort((left, right) => left.iteration - right.iteration)
    .map((iteration) => iteration.metrics.valBpb)
    .findLast((value): value is number => value !== null) ?? null;

  return {
    iterationCount: iterations.length,
    bestValBpb: valBpbs[0] ?? null,
    latestValBpb,
    keptCount: iterations.filter((iteration) => iteration.keepDiscardStatus === "keep").length,
    discardedCount: iterations.filter((iteration) => iteration.keepDiscardStatus === "discard").length,
    crashCount: iterations.filter((iteration) => iteration.outcome === "crash" || iteration.status === "crash").length,
    confirmedCount: iterations.filter((iteration) => iteration.outcome === "confirmed").length,
    contradictionCount: iterations.filter((iteration) => iteration.outcome === "contradicted").length,
    activeTensionCount: tensions.length,
  };
}

function loadTranscendentArtifact(iterationDir: string): TranscendentArtifact | null {
  const resultPath = path.join(iterationDir, "transcendent", "result.json");
  const codePath = path.join(iterationDir, "transcendent", "train.py");
  const result = readJson(resultPath);
  const code = readText(codePath);

  if (!result && !code) {
    return null;
  }

  return {
    sourceTensionIds: asStringArray(result?.source_tension_ids),
    thesisRef: asString(result?.thesis_ref),
    antithesisRef: asString(result?.antithesis_ref),
    emergentThought: asString(result?.emergent_thought),
    concreteChange: asString(result?.concrete_change),
    testedInIteration: toNumber(result?.tested_in_iteration),
    resultStatus: asString(result?.result_status),
    code: makeCodeSnapshot("Synthesis candidate", "python", code, codePath),
    raw: result,
  };
}

function loadCodexPhaseArtifact(iterationDir: string, phase: "prepare" | "reflect"): CodexPhaseArtifact | null {
  const phaseDir = path.join(iterationDir, "codex", phase);
  if (!isDirectory(phaseDir)) {
    return null;
  }

  const manifestPath = path.join(phaseDir, "manifest.json");
  const manifest = readJson(manifestPath);
  const lastMessagePath = path.join(phaseDir, "last-message.txt");
  const transcriptPath = path.join(phaseDir, "transcript.log");
  const statePath = path.join(phaseDir, "current_iteration.json");
  const patchesDir = path.join(phaseDir, "patches");
  const patches = isDirectory(patchesDir)
    ? fs
        .readdirSync(patchesDir)
        .filter((name) => name.endsWith(".diff.patch"))
        .sort()
        .map((name) => {
          const patchPath = path.join(patchesDir, name);
          return makeCodeSnapshot(name, "diff", readText(patchPath), patchPath);
        })
        .filter((snapshot): snapshot is CodeSnapshot => Boolean(snapshot))
    : [];

  return {
    phase,
    summary: asString(manifest?.summary),
    modifiedFiles: asStringArray(manifest?.modified_files),
    patches,
    lastMessage: makeCodeSnapshot("Codex last message", "text", readText(lastMessagePath), lastMessagePath),
    transcript: makeCodeSnapshot("Codex transcript", "log", readText(transcriptPath), transcriptPath),
    stateSnapshot: makeCodeSnapshot("Staged iteration state", "json", readText(statePath), statePath),
    manifestRaw: manifest,
  };
}

function loadLiveSessionState(sessionDir: string): LiveSessionState | null {
  const liveStatePath = path.join(sessionDir, "live", "state.json");
  const liveState = readJson(liveStatePath);
  if (!liveState) {
    return null;
  }

  const rawRunLogPath = asString(liveState.run_log_path);
  const runnerEventsPath = path.join(sessionDir, "live", "events.ndjson");
  const rawTelemetryEventsPath = asString(liveState.telemetry_events_path);
  const rawRelayStatePath = asString(liveState.relay_state_path);
  let runLog: string | null = null;
  if (rawRunLogPath) {
    const resolved = path.isAbsolute(rawRunLogPath) ? rawRunLogPath : path.join(getRepoRoot(), rawRunLogPath);
    runLog = readText(resolved);
  }
  let telemetryEvents: string | null = null;
  if (rawTelemetryEventsPath) {
    const resolved = path.isAbsolute(rawTelemetryEventsPath)
      ? rawTelemetryEventsPath
      : path.join(getRepoRoot(), rawTelemetryEventsPath);
    telemetryEvents = readText(resolved);
  }
  const telemetry = parseLiveTelemetryEvents(telemetryEvents);
  const runnerEvents = parseLiveRunnerEvents(readText(runnerEventsPath));

  return {
    isActive: Boolean(liveState.is_active),
    phase: asString(liveState.phase),
    status: asString(liveState.status),
    experimentIndex: toNumber(liveState.experiment_index),
    experimentCount: toNumber(liveState.experiment_count),
    currentIterationLabel: asString(liveState.current_iteration_label),
    executionId: asString(liveState.execution_id),
    executionDir: asString(liveState.execution_dir),
    runLogPath: rawRunLogPath,
    telemetryEventsPath: rawTelemetryEventsPath,
    relayStatePath: rawRelayStatePath,
    attentionBackend: telemetry.attentionBackend,
    timeBudgetSeconds: telemetry.timeBudgetSeconds,
    deviceBatchSize: telemetry.deviceBatchSize,
    totalBatchSize: telemetry.totalBatchSize,
    gradAccumSteps: telemetry.gradAccumSteps,
    depth: telemetry.depth,
    numParamsM: telemetry.numParamsM,
    lastEventType: telemetry.lastEventType ?? runnerEvents.lastEventType,
    reflection: runnerEvents.reflection,
    updatedAt: asString(liveState.updated_at),
    progress: telemetry.progress ?? parseLiveRunProgress(runLog),
  };
}

function loadExperimentIteration(sessionId: string, iterationDir: string, knowledgeBundle: KnowledgeBundle): IterationNode {
  const planPath = path.join(iterationDir, "plan.json");
  const resultPath = path.join(iterationDir, "result.json");
  const actualPath = path.join(iterationDir, "actual", "train.py");
  const diffPath = path.join(iterationDir, "actual", "train.diff.patch");
  const runLogPath = path.join(iterationDir, "execution", "run.log");
  const liveEventsPath = path.join(iterationDir, "execution", "live-events.ndjson");
  const relayStatePath = path.join(iterationDir, "execution", "relay-state.json");
  const summaryPath = path.join(iterationDir, "execution", "summary.json");
  const metadataPath = path.join(iterationDir, "execution", "run-metadata.json");
  const plan = readJson(planPath);
  const result = readJson(resultPath);
  const summary = readJson(summaryPath);
  const metadata = readJson(metadataPath);
  const relayState = readJson(relayStatePath);
  const runLog = readText(runLogPath);
  const liveEvents = readText(liveEventsPath);
  const actualCode = readText(actualPath);
  const diff = readText(diffPath);
  const iterationLabel = path.basename(iterationDir);
  const iterationNumber = toNumber(plan?.iteration ?? result?.iteration) ?? (Number.parseInt(iterationLabel, 10) || 0);
  const tensions = listDirectories(path.join(iterationDir, "tensions")).map((tensionDir) =>
    loadTension(tensionDir, iterationNumber),
  );
  const activeTensionIds = asStringArray(plan?.active_tension_ids);
  const metricSource = asRecord(result?.metrics) ?? asRecord(result?.summary) ?? summary ?? parseRunLogSummary(runLog);
  const experimentId = `${sessionId}:${iterationLabel}`;
  const knowledgeRecord = knowledgeBundle.experimentsById.get(experimentId) ?? null;
  const defaultTensionPair = buildKnowledgeTensionPair(asRecord(knowledgeRecord?.default_tension_pair));
  const knowledgeAnchorExperimentId =
    asString(knowledgeRecord?.knowledge_anchor_experiment_id) ?? defaultTensionPair?.anchorExperimentId ?? null;
  const knowledgeOpposingExperimentId =
    asString(knowledgeRecord?.knowledge_opposing_experiment_id) ?? defaultTensionPair?.opposingExperimentId ?? null;

  return {
    id: experimentId,
    iteration: iterationNumber,
    label: iterationLabel,
    source: "experiment_logs",
    sourcePath: relativeToRepo(iterationDir),
    createdAt: asString(plan?.created_at) ?? asString(result?.created_at),
    completedAt: asString(result?.completed_at),
    status: asString(result?.status) ?? asString(plan?.status),
    moveType: asString(plan?.move_type),
    prediction: asString(plan?.prediction),
    outcome: asString(result?.outcome) ?? asString(result?.status),
    keepDiscardStatus: asString(result?.keep_discard_status),
    nextMoveType: asString(result?.next_move_type),
    contradictedAssumption: asString(result?.contradicted_assumption),
    summaryText: asString(result?.summary_text) ?? asString(result?.framing_diagnosis) ?? asString(plan?.why_now),
    parentCommit: asString(plan?.parent_commit),
    candidateCommit: asString(plan?.candidate_commit),
    activeTensionIds: activeTensionIds.length ? activeTensionIds : tensions.map((tension) => tension.id),
    planRaw: plan,
    resultRaw: result,
    metrics: normalizeMetrics(metricSource),
    actualCode: makeCodeSnapshot("Tested train.py", "python", actualCode, actualPath),
    diff: makeCodeSnapshot("train.py diff", "diff", diff, diffPath),
    preparePhase: loadCodexPhaseArtifact(iterationDir, "prepare"),
    reflectPhase: loadCodexPhaseArtifact(iterationDir, "reflect"),
    tensions,
    transcendent: loadTranscendentArtifact(iterationDir),
    takeaway: asString(knowledgeRecord?.takeaway),
    mechanismHypothesis: asString(knowledgeRecord?.mechanism_hypothesis),
    contradictionClass: asString(knowledgeRecord?.contradiction_class),
    confidence: asString(knowledgeRecord?.confidence),
    evidenceStrength: toNumber(knowledgeRecord?.evidence_strength),
    isIncumbentCandidate: Boolean(knowledgeRecord?.is_incumbent_candidate),
    incumbentRank: toNumber(knowledgeRecord?.incumbent_rank),
    axisTags: asStringArray(knowledgeRecord?.axis_tags),
    mechanismTags: asStringArray(knowledgeRecord?.mechanism_tags),
    knowledgeRef: asString(knowledgeRecord?.knowledge_ref),
    knowledgeAnchorExperimentId,
    knowledgeOpposingExperimentId,
    knowledgeSelectionReason:
      asString(knowledgeRecord?.knowledge_selection_reason) ?? defaultTensionPair?.selectionReason ?? null,
    knowledgeTranscendentPrediction:
      asString(knowledgeRecord?.knowledge_transcendent_prediction) ?? defaultTensionPair?.transcendentPrediction ?? null,
    defaultTensionPair,
    knowledgeAnchor: buildKnowledgeExperimentLink(
      knowledgeAnchorExperimentId ? knowledgeBundle.experimentsById.get(knowledgeAnchorExperimentId) ?? null : null,
    ),
    knowledgeOpposing: buildKnowledgeExperimentLink(
      knowledgeOpposingExperimentId ? knowledgeBundle.experimentsById.get(knowledgeOpposingExperimentId) ?? null : null,
    ),
    supportingExperiments: resolveKnowledgeExperimentLinks(
      asStringArray(knowledgeRecord?.supports_experiment_ids),
      knowledgeBundle,
    ),
    opposingExperiments: resolveKnowledgeExperimentLinks(
      asStringArray(knowledgeRecord?.opposes_experiment_ids),
      knowledgeBundle,
    ),
    execution: {
      runLog: makeCodeSnapshot("Execution log", "log", runLog, runLogPath),
      liveEvents: makeCodeSnapshot("Structured live telemetry", "log", liveEvents, liveEventsPath),
      summary,
      metadata,
      relayState,
    },
  };
}

function loadExperimentLogSessions(): SessionGraph[] {
  const root = path.join(getRepoRoot(), "experiment_logs");
  if (!isDirectory(root)) {
    return [];
  }
  const knowledgeBundle = loadKnowledgeBundle();

  return listDirectories(root)
    .map((sessionDir) => {
      const sessionPath = path.join(sessionDir, "session.json");
      const manifestPath = path.join(sessionDir, "manifest.json");
      const session = readJson(sessionPath);
      const manifest = readJson(manifestPath);
      const branch = asString(session?.branch) ?? asString(manifest?.branch) ?? path.basename(sessionDir);
      const sessionId = asString(session?.session_id) ?? path.basename(sessionDir);
      const iterationsRoot = path.join(sessionDir, "iterations");
      const iterations = listDirectories(iterationsRoot)
        .map((iterationDir) => loadExperimentIteration(sessionId, iterationDir, knowledgeBundle))
        .sort((left, right) => left.iteration - right.iteration);
      const tensions = mergeTensions(iterations);
      const knowledgeSummary = buildSessionKnowledgeSummary(sessionId, knowledgeBundle);
      const incumbentLineage = buildIncumbentLineage(iterations, knowledgeBundle);
      const strongestCounterexamples = buildStrongestCounterexamples(iterations, knowledgeSummary, knowledgeBundle);

      return {
        id: sessionId,
        title: branch.replace(/^autoresearch\//, ""),
        branch,
        runnerMode: asString(session?.runner_mode) ?? "experiment_logs",
        source: "experiment_logs" as const,
        sourcePath: relativeToRepo(sessionDir),
        createdAt: asString(session?.created_at) ?? asString(manifest?.created_at),
        updatedAt: asString(session?.updated_at) ?? asString(manifest?.updated_at),
        objective: asString(session?.objective),
        notes: asString(session?.notes),
        manifestRaw: manifest,
        sessionRaw: session,
        live: loadLiveSessionState(sessionDir),
        iterations,
        tensions,
        knowledgeSummary,
        incumbentLineage,
        strongestCounterexamples,
        stats: buildStats(iterations, tensions),
      };
    })
    .sort((left, right) => {
      const liveDelta = Number(Boolean(right.live?.isActive)) - Number(Boolean(left.live?.isActive));
      if (liveDelta !== 0) {
        return liveDelta;
      }
      const rightStamp = right.live?.updatedAt ?? right.updatedAt ?? "";
      const leftStamp = left.live?.updatedAt ?? left.updatedAt ?? "";
      return rightStamp.localeCompare(leftStamp);
    });
}

function loadRunpodSessions(): SessionGraph[] {
  const root = path.join(getRepoRoot(), "runpod_runs");
  if (!isDirectory(root)) {
    return [];
  }

  const grouped = new Map<
    string,
    {
      dir: string;
      branch: string;
      createdAt: string | null;
    }[]
  >();

  for (const executionDir of listDirectories(root)) {
    const gitBranch = readJson(path.join(executionDir, "metadata", "git-branch.json"));
    const branch = asString(gitBranch?.branch);
    if (!branch) {
      continue;
    }

    const entries = grouped.get(branch) ?? [];
    entries.push({
      dir: executionDir,
      branch,
      createdAt: parseRunpodTimestamp(path.basename(executionDir)),
    });
    grouped.set(branch, entries);
  }

  return [...grouped.entries()]
    .map(([branch, entries]) => {
      const ordered = [...entries].sort((left, right) => left.dir.localeCompare(right.dir));
      const sessionId = `${slugify(branch)}--runpod`;
      const iterations: IterationNode[] = ordered.map((entry, index) => {
        const summaryPath = path.join(entry.dir, "metadata", "summary.json");
        const gitBranchPath = path.join(entry.dir, "metadata", "git-branch.json");
        const configPath = path.join(entry.dir, "metadata", "config.effective.json");
        const runLogPath = path.join(entry.dir, "artifacts", "run.log");
        const summary = readJson(summaryPath);
        const gitBranch = readJson(gitBranchPath);
        const metadata = readJson(configPath);
        const runLog = readText(runLogPath);
        const label = padIteration(index + 1);

        return {
          id: `${sessionId}:${label}`,
          iteration: index + 1,
          label,
          source: "runpod",
          sourcePath: relativeToRepo(entry.dir),
          createdAt: entry.createdAt,
          completedAt: entry.createdAt,
          status: "captured",
          moveType: null,
          prediction: null,
          outcome: null,
          keepDiscardStatus: null,
          nextMoveType: null,
          contradictedAssumption: null,
          summaryText: `Fallback view from ${path.basename(entry.dir)}`,
          parentCommit: null,
          candidateCommit: asString(gitBranch?.commit),
          activeTensionIds: [],
          planRaw: null,
          resultRaw: summary,
          metrics: normalizeMetrics(summary ?? parseRunLogSummary(runLog)),
          actualCode: null,
          diff: null,
        preparePhase: null,
        reflectPhase: null,
        tensions: [],
        transcendent: null,
        takeaway: null,
        mechanismHypothesis: null,
        contradictionClass: null,
        confidence: null,
        evidenceStrength: null,
        isIncumbentCandidate: false,
        incumbentRank: null,
        axisTags: [],
        mechanismTags: [],
        knowledgeRef: null,
        knowledgeAnchorExperimentId: null,
        knowledgeOpposingExperimentId: null,
        knowledgeSelectionReason: null,
        knowledgeTranscendentPrediction: null,
        defaultTensionPair: null,
        knowledgeAnchor: null,
        knowledgeOpposing: null,
        supportingExperiments: [],
        opposingExperiments: [],
        execution: {
          runLog: makeCodeSnapshot("Execution log", "log", runLog, runLogPath),
          liveEvents: null,
            summary,
            metadata,
            relayState: null,
          },
        };
      });
      const tensions: TensionNode[] = [];
      const createdAt = ordered[0]?.createdAt ?? null;
      const updatedAt = ordered[ordered.length - 1]?.createdAt ?? null;

      return {
        id: sessionId,
        title: branch.replace(/^autoresearch\//, ""),
        branch,
        runnerMode: "runpod",
        source: "runpod" as const,
        sourcePath: "runpod_runs",
        createdAt,
        updatedAt,
        objective: "val_bpb",
        notes: "Fallback session assembled from runpod artifacts.",
        manifestRaw: null,
        sessionRaw: null,
        live: null,
        iterations,
        tensions,
        knowledgeSummary: null,
        incumbentLineage: [],
        strongestCounterexamples: [],
        stats: buildStats(iterations, tensions),
      };
    })
    .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
}

export function getAllSessions(): SessionGraph[] {
  applyRequestCachingPolicy();
  const experimentSessions = loadExperimentLogSessions();
  const canonicalBranches = new Set(experimentSessions.map((session) => session.branch));
  const runpodSessions = loadRunpodSessions().filter((session) => !canonicalBranches.has(session.branch));
  return [...experimentSessions, ...runpodSessions];
}

export function getAllSessionIds(): string[] {
  return getAllSessions().map((session) => session.id);
}

export function getIterationLabels(sessionId: string): string[] {
  const session = getSessionGraph(sessionId);
  if (!session) {
    return [];
  }
  return session.iterations.map((iteration) => iteration.label);
}

export function getSessionGraph(sessionId: string): SessionGraph | null {
  return getAllSessions().find((session) => session.id === sessionId) ?? null;
}
