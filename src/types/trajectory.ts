import type { ArtifactProfile } from "./task.js";

export interface TrajectoryTextField {
  text: string;
  truncated: boolean;
  original_length?: number;
}

export type TrajectoryJsonValue =
  | string
  | number
  | boolean
  | null
  | TrajectoryTextField
  | TrajectoryJsonObject
  | TrajectoryJsonValue[];

export interface TrajectoryJsonObject {
  [key: string]: TrajectoryJsonValue;
}

export type TrajectoryStepSource = "system" | "user" | "agent";

export interface TrajectorySkillReference {
  id: string;
  label: string | null;
  skill_dir: string;
}

export interface TrajectoryAgentDescriptor {
  name: string;
  platform: string;
}

export interface TrajectoryToolCall {
  tool_use_id: string | null;
  name: string | null;
  input: TrajectoryJsonValue | null;
  extra: TrajectoryJsonObject | null;
}

export interface TrajectoryObservation {
  kind: string;
  tool_use_id: string | null;
  tool_name: string | null;
  content: TrajectoryJsonValue | null;
  is_error: boolean | null;
  extra: TrajectoryJsonObject | null;
}

export interface TrajectoryFinalMetrics {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  total_cost_usd: number | null;
  duration_ms: number | null;
  duration_api_ms: number | null;
  num_turns: number | null;
  stop_reason: string | null;
}

export interface TrajectoryStep {
  step_id: number;
  message_index: number;
  source: TrajectoryStepSource;
  message_type: string;
  message_subtype: string | null;
  uuid: string | null;
  session_id: string | null;
  parent_tool_use_id: string | null;
  timestamp: string | null;
  reasoning_content: TrajectoryTextField | null;
  message_text: TrajectoryTextField | null;
  tool_calls: TrajectoryToolCall[];
  observations: TrajectoryObservation[];
  result_metadata: TrajectoryJsonObject | null;
  extra: TrajectoryJsonObject | null;
}

export interface TrajectoryInitContext {
  cwd: string | null;
  model: string | null;
  session_id: string | null;
  source: string | null;
  transcript_path: string | null;
  system_init: TrajectoryJsonObject | null;
}

export interface TrajectoryFinalResultContext {
  subtype: string;
  is_error: boolean;
  message_text: TrajectoryTextField | null;
  result_metadata: TrajectoryJsonObject;
  extra: TrajectoryJsonObject | null;
}

export interface TrajectoryTruncationSummary {
  truncated_fields: number;
  omitted_steps: number;
  max_field_chars: number;
  max_file_bytes: number;
}

export interface TrialTrajectoryArtifact {
  schema_version: string;
  session_id: string | null;
  task_id: string;
  trial_id: string;
  runtime_success: boolean;
  model_name: string | null;
  agent: TrajectoryAgentDescriptor;
  selected_skill: TrajectorySkillReference | null;
  total_steps: number;
  total_messages: number;
  generated_at: string;
  artifact_profile: ArtifactProfile;
  truncated: boolean;
  truncation_summary: TrajectoryTruncationSummary | null;
  init_context: TrajectoryInitContext | null;
  final_result_context: TrajectoryFinalResultContext | null;
  final_metrics: TrajectoryFinalMetrics | null;
  steps: TrajectoryStep[];
}
