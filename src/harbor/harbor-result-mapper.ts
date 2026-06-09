import type { HarborTrialResult } from "../types/harbor.js";
import type { TrialAcceptance, TrialExecutionMetadata, TrialResult, TrialUsage } from "../types/result.js";
import { scrubPublicDiagnostic } from "./public-scrub.js";

function blockDurationMs(block: { started_at: string; finished_at: string } | null): number | null {
  if (!block) return null;
  return new Date(block.finished_at).getTime() - new Date(block.started_at).getTime();
}

function mapAcceptance(trial: HarborTrialResult): TrialAcceptance {
  if (!trial.verifier_result) {
    return {
      success: false,
      evaluator: "harbor-verifier",
      summary: "No verifier result (trial did not reach verification stage)",
    };
  }
  const reward = trial.verifier_result.rewards["reward"] ?? 0;
  return {
    success: reward > 0,
    evaluator: "harbor-verifier",
    summary: `Harbor reward: ${JSON.stringify(trial.verifier_result.rewards)}`,
  };
}

function mapUsage(trial: HarborTrialResult): TrialUsage | null {
  if (!trial.agent_result) return null;
  return {
    input_tokens: trial.agent_result.n_input_tokens,
    output_tokens: trial.agent_result.n_output_tokens,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: trial.agent_result.n_cache_tokens,
  };
}

function mapExecution(trial: HarborTrialResult): TrialExecutionMetadata {
  return {
    runtimePlatform: trial.config.agent.name,
    providerId: null,
    model: trial.config.agent.model_name,
    environmentBackend: trial.config.environment.type,
    selectedSkill: null,
    candidateSkillIds: [],
    runtime: { platform: trial.config.agent.name },
    environment: {
      backend: trial.config.environment.type,
      workspaceTemplate: "",
      artifactProfile: "debug",
    },
    sessionInit: null,
    rawArtifacts: [],
    harbor: {
      verifier_result: trial.verifier_result
        ? { rewards: { ...trial.verifier_result.rewards } }
        : null,
    },
  };
}

export function mapHarborTrialToTrialResult(trial: HarborTrialResult): TrialResult {
  const taskId = trial.task_name.includes("/")
    ? trial.task_name.split("/").pop()!
    : trial.task_name;

  return {
    trialId: trial.id,
    taskId,
    runtime_success: trial.exception_info === null,
    duration_ms: blockDurationMs(trial.agent_execution)
      ?? blockDurationMs(trial.environment_setup)
      ?? blockDurationMs({ started_at: trial.started_at, finished_at: trial.finished_at }),
    usage: mapUsage(trial),
    total_cost_usd: trial.agent_result?.cost_usd ?? null,
    num_turns: null,
    stop_reason: null,
    session_id: null,
    transcript_path: null,
    acceptance: mapAcceptance(trial),
    execution: mapExecution(trial),
    error: trial.exception_info !== null
      ? { message: scrubPublicDiagnostic(JSON.stringify(trial.exception_info)) }
      : null,
  };
}
