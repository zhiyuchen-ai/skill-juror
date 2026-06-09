import type { HarborVerifierResult } from "./harbor.js";

export interface TrialAcceptance {
  success: boolean;
  evaluator: string;
  summary: string;
}

export interface TrialUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
}

export interface TrialRuntimeMetadata {
  platform: string;
  provider?: string | null;
  model?: string | null;
}

export interface TrialEnvironmentMetadata {
  backend: string;
  workspaceTemplate: string;
  artifactProfile: "debug";
}

export interface SelectedSkillMetadata {
  id: string;
  label: string | null;
  skillDir: string;
}

export interface TrialExecutionMetadata {
  runtimePlatform: string;
  providerId: string | null;
  model: string | null;
  environmentBackend: string;
  selectedSkill: SelectedSkillMetadata | null;
  candidateSkillIds: string[];
  runtime: TrialRuntimeMetadata;
  environment: TrialEnvironmentMetadata;
  rawArtifacts: string[];
  sessionInit: {
    cwd: string | null;
    model: string | null;
    session_id: string | null;
    source: "harbor";
    transcript_path: string | null;
  } | null;
  harbor: {
    verifier_result: HarborVerifierResult | null;
  };
}

export interface TrialResult {
  trialId: string;
  taskId: string;
  runtime_success: boolean;
  duration_ms: number | null;
  usage: TrialUsage | null;
  total_cost_usd: number | null;
  num_turns: number | null;
  stop_reason: string | null;
  session_id: string | null;
  transcript_path: string | null;
  acceptance: TrialAcceptance;
  execution: TrialExecutionMetadata;
  error: { message: string } | null;
}
