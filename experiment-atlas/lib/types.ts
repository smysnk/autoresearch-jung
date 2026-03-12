export type DataSource = "experiment_logs" | "runpod";

export type VisualMode =
  | "chronicle"
  | "braid"
  | "mirror"
  | "constellation"
  | "stratigraphy"
  | "sankey"
  | "genome"
  | "filmstrip";

export type CodeLanguage = "python" | "diff" | "json" | "log" | "text";

export type MetricSnapshot = {
  valBpb: number | null;
  peakVramMb: number | null;
  trainingSeconds: number | null;
  totalSeconds: number | null;
  mfuPercent: number | null;
  totalTokensM: number | null;
  numSteps: number | null;
  numParamsM: number | null;
  depth: number | null;
  raw: Record<string, unknown>;
};

export type CodeSnapshot = {
  label: string;
  language: CodeLanguage;
  content: string | null;
  path: string | null;
};

export type CodexPhaseArtifact = {
  phase: "prepare" | "reflect";
  summary: string | null;
  modifiedFiles: string[];
  patches: CodeSnapshot[];
  lastMessage: CodeSnapshot | null;
  transcript: CodeSnapshot | null;
  stateSnapshot: CodeSnapshot | null;
  manifestRaw: Record<string, unknown> | null;
};

export type TensionNode = {
  id: string;
  label: string;
  kind: string | null;
  whyActive: string | null;
  favoredSide: string | null;
  createdInIteration: number | null;
  updatedInIteration: number | null;
  latestIteration: number | null;
  iterationRefs: number[];
  thesis: CodeSnapshot | null;
  antithesis: CodeSnapshot | null;
  metaRaw: Record<string, unknown> | null;
};

export type TranscendentArtifact = {
  sourceTensionIds: string[];
  thesisRef: string | null;
  antithesisRef: string | null;
  emergentThought: string | null;
  concreteChange: string | null;
  testedInIteration: number | null;
  resultStatus: string | null;
  code: CodeSnapshot | null;
  raw: Record<string, unknown> | null;
};

export type ExecutionArtifacts = {
  runLog: CodeSnapshot | null;
  liveEvents: CodeSnapshot | null;
  summary: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  relayState: Record<string, unknown> | null;
};

export type IterationNode = {
  id: string;
  iteration: number;
  label: string;
  source: DataSource;
  sourcePath: string;
  createdAt: string | null;
  completedAt: string | null;
  status: string | null;
  moveType: string | null;
  prediction: string | null;
  outcome: string | null;
  keepDiscardStatus: string | null;
  nextMoveType: string | null;
  contradictedAssumption: string | null;
  summaryText: string | null;
  parentCommit: string | null;
  candidateCommit: string | null;
  activeTensionIds: string[];
  planRaw: Record<string, unknown> | null;
  resultRaw: Record<string, unknown> | null;
  metrics: MetricSnapshot;
  actualCode: CodeSnapshot | null;
  diff: CodeSnapshot | null;
  preparePhase: CodexPhaseArtifact | null;
  reflectPhase: CodexPhaseArtifact | null;
  tensions: TensionNode[];
  transcendent: TranscendentArtifact | null;
  execution: ExecutionArtifacts;
};

export type LiveRunProgress = {
  step: number | null;
  epoch: number | null;
  progressPct: number | null;
  remainingSeconds: number | null;
  trainLoss: number | null;
  trainingSecondsElapsed: number | null;
  lrMultiplier: number | null;
  tokensPerSecond: number | null;
  mfuPercent: number | null;
  stepDtMs: number | null;
  currentVramMb: number | null;
  reservedVramMb: number | null;
  peakVramMb: number | null;
  valBpb: number | null;
  gpuUtilPercent: number | null;
  gpuMemoryUtilPercent: number | null;
  tempC: number | null;
  powerW: number | null;
};

export type LiveReflectionState = {
  outcome: string | null;
  contradictedAssumption: string | null;
  keepDiscardStatus: string | null;
  framingDiagnosis: string | null;
  nextMoveType: string | null;
  summary: string | null;
  modifiedFiles: string[];
  transcendentThought: string | null;
  resultStatus: string | null;
};

export type LiveSessionState = {
  isActive: boolean;
  phase: string | null;
  status: string | null;
  experimentIndex: number | null;
  experimentCount: number | null;
  currentIterationLabel: string | null;
  executionId: string | null;
  executionDir: string | null;
  runLogPath: string | null;
  telemetryEventsPath: string | null;
  relayStatePath: string | null;
  relayWsUrl: string | null;
  attentionBackend: string | null;
  timeBudgetSeconds: number | null;
  deviceBatchSize: number | null;
  totalBatchSize: number | null;
  gradAccumSteps: number | null;
  depth: number | null;
  numParamsM: number | null;
  lastEventType: string | null;
  reflection: LiveReflectionState | null;
  updatedAt: string | null;
  progress: LiveRunProgress | null;
};

export type SessionStats = {
  iterationCount: number;
  bestValBpb: number | null;
  latestValBpb: number | null;
  keptCount: number;
  discardedCount: number;
  crashCount: number;
  confirmedCount: number;
  contradictionCount: number;
  activeTensionCount: number;
};

export type SessionGraph = {
  id: string;
  title: string;
  branch: string;
  runnerMode: string;
  source: DataSource;
  sourcePath: string;
  createdAt: string | null;
  updatedAt: string | null;
  objective: string | null;
  notes: string | null;
  manifestRaw: Record<string, unknown> | null;
  sessionRaw: Record<string, unknown> | null;
  live: LiveSessionState | null;
  iterations: IterationNode[];
  tensions: TensionNode[];
  stats: SessionStats;
};
