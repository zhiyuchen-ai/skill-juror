import type { TrajectoryJsonObject, TrajectoryJsonValue } from "./trajectory.js";

export interface HarborTrialTimingBlock {
  started_at: string;
  finished_at: string;
}

export interface HarborTaskReference {
  path: string;
}

export interface HarborTaskConfig {
  path: string;
  git_url: string | null;
  git_commit_id: string | null;
  name: string | null;
  ref: string | null;
  overwrite: boolean;
  download_dir: string | null;
  source: TrajectoryJsonValue | null;
}

export interface HarborAgentConfig {
  name: string;
  import_path: string | null;
  model_name: string | null;
  override_timeout_sec: number | null;
  override_setup_timeout_sec: number | null;
  max_timeout_sec: number | null;
  kwargs: TrajectoryJsonObject;
  env: TrajectoryJsonObject;
}

export interface HarborEnvironmentConfig {
  type: string;
  import_path: string | null;
  force_build: boolean;
  delete: boolean;
  override_cpus: number | null;
  override_memory_mb: number | null;
  override_storage_mb: number | null;
  override_gpus: number | null;
  suppress_override_warnings: boolean;
  mounts_json: string | null;
  env: TrajectoryJsonObject;
  kwargs: TrajectoryJsonObject;
}

export interface HarborVerifierConfig {
  override_timeout_sec: number | null;
  max_timeout_sec: number | null;
  disable: boolean;
}

export interface HarborTrialConfig {
  task: HarborTaskConfig;
  trial_name: string;
  trials_dir: string;
  timeout_multiplier: number;
  agent_timeout_multiplier: number | null;
  verifier_timeout_multiplier: number | null;
  agent_setup_timeout_multiplier: number | null;
  environment_build_timeout_multiplier: number | null;
  agent: HarborAgentConfig;
  environment: HarborEnvironmentConfig;
  verifier: HarborVerifierConfig;
  artifacts: TrajectoryJsonValue[];
  job_id: string;
}

export interface HarborAgentInfo {
  name: string;
  version: string;
  model_info: TrajectoryJsonValue | null;
}

export interface HarborAgentResult {
  n_input_tokens: number;
  n_cache_tokens: number;
  n_output_tokens: number;
  cost_usd: number | null;
  rollout_details: TrajectoryJsonValue | null;
  metadata: TrajectoryJsonValue | null;
}

export interface HarborVerifierResult {
  rewards: Record<string, number>;
}

export interface HarborTrialResult {
  id: string;
  task_name: string;
  trial_name: string;
  trial_uri: string;
  task_id: HarborTaskReference;
  source: TrajectoryJsonValue | null;
  task_checksum: string;
  config: HarborTrialConfig;
  agent_info: HarborAgentInfo;
  agent_result: HarborAgentResult | null;
  verifier_result: HarborVerifierResult | null;
  exception_info: TrajectoryJsonValue | null;
  started_at: string;
  finished_at: string;
  environment_setup: HarborTrialTimingBlock | null;
  agent_setup: HarborTrialTimingBlock | null;
  agent_execution: HarborTrialTimingBlock | null;
  verifier: HarborTrialTimingBlock | null;
}

export interface HarborJobMetricSummary {
  mean: number;
}

export interface HarborJobRewardStats {
  [rewardName: string]: Record<string, string[]>;
}

export interface HarborJobEvalStats {
  n_trials: number;
  n_errors: number;
  metrics: HarborJobMetricSummary[];
  reward_stats: HarborJobRewardStats;
  exception_stats: Record<string, TrajectoryJsonValue>;
}

export interface HarborJobStats {
  n_trials: number;
  n_errors: number;
  evals: Record<string, HarborJobEvalStats>;
}

export interface HarborJobResult {
  id: string;
  started_at: string;
  finished_at: string;
  n_total_trials: number;
  stats: HarborJobStats;
}

export interface HarborTrajectoryAgentExtra {
  cwds: string[];
  git_branches: string[];
}

export interface HarborTrajectoryAgent {
  name: string;
  version: string;
  model_name: string;
  extra: HarborTrajectoryAgentExtra;
}

export interface HarborTrajectoryToolCall {
  tool_call_id: string;
  function_name: string;
  arguments: TrajectoryJsonValue;
}

export interface HarborTrajectoryObservationResult {
  source_call_id: string;
  content: string;
}

export interface HarborTrajectoryObservation {
  results: HarborTrajectoryObservationResult[];
}

export interface HarborTrajectoryStepMetricsServerToolUse {
  web_search_requests: number;
  web_fetch_requests: number;
}

export interface HarborTrajectoryStepMetricsCacheCreation {
  ephemeral_1h_input_tokens: number;
  ephemeral_5m_input_tokens: number;
}

export interface HarborTrajectoryStepMetricsExtra {
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  server_tool_use: HarborTrajectoryStepMetricsServerToolUse;
  service_tier: string;
  cache_creation: HarborTrajectoryStepMetricsCacheCreation;
  inference_geo: string;
  iterations: TrajectoryJsonValue[];
  speed: string;
}

export interface HarborTrajectoryStepMetrics {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  extra: HarborTrajectoryStepMetricsExtra;
}

export interface HarborTrajectoryRawToolResult {
  type: string;
  content: string;
  tool_use_id?: string;
  is_error?: boolean;
}

export interface HarborTrajectoryToolResultMetadata {
  tool_use_result?: TrajectoryJsonValue;
  raw_tool_result: HarborTrajectoryRawToolResult;
  is_error?: boolean;
}

export interface HarborTrajectoryStepExtra {
  stop_reason: string;
  cwd: string;
  is_sidechain: boolean;
  tool_use_name?: string;
  tool_result_metadata?: HarborTrajectoryToolResultMetadata;
  tool_result_is_error?: boolean;
  metadata?: HarborTrajectoryToolResultMetadata;
  raw_arguments?: TrajectoryJsonValue;
}

export interface HarborTrajectoryStep {
  step_id: number;
  timestamp: string;
  source: "user" | "agent";
  message: string;
  model_name?: string;
  reasoning_content?: string;
  metrics?: HarborTrajectoryStepMetrics;
  tool_calls?: HarborTrajectoryToolCall[];
  observation?: HarborTrajectoryObservation;
  extra?: HarborTrajectoryStepExtra;
}

export interface HarborTrajectoryFinalMetricsExtra {
  service_tiers: string[];
  total_cache_creation_input_tokens: number;
  total_cache_read_input_tokens: number;
}

export interface HarborTrajectoryFinalMetrics {
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_cached_tokens: number;
  total_steps: number;
  extra: HarborTrajectoryFinalMetricsExtra;
}

export interface HarborTrajectoryArtifact {
  schema_version: string;
  session_id: string;
  agent: HarborTrajectoryAgent;
  steps: HarborTrajectoryStep[];
  final_metrics: HarborTrajectoryFinalMetrics;
}
