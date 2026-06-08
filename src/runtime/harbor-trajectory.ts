export function getHarborTrajectoryTurns(value: unknown): number | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const finalMetrics = typeof record.final_metrics === "object" && record.final_metrics !== null
    ? record.final_metrics as Record<string, unknown>
    : null;

  if (typeof finalMetrics?.total_steps === "number" && Number.isFinite(finalMetrics.total_steps)) {
    return finalMetrics.total_steps;
  }

  return Array.isArray(record.steps) ? record.steps.length : null;
}

export function getHarborTrajectorySessionId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  return typeof record.session_id === "string" ? record.session_id : null;
}

export function getHarborTrajectoryStopReason(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.steps)) {
    return null;
  }

  for (let index = record.steps.length - 1; index >= 0; index -= 1) {
    const step = record.steps[index];
    if (typeof step !== "object" || step === null) {
      continue;
    }

    const stepRecord = step as Record<string, unknown>;
    const extra = typeof stepRecord.extra === "object" && stepRecord.extra !== null
      ? stepRecord.extra as Record<string, unknown>
      : null;

    if (typeof extra?.stop_reason === "string") {
      return extra.stop_reason;
    }
  }

  return null;
}

export function getHarborTrajectoryCacheCreationTokens(value: unknown): number | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const finalMetrics = typeof record.final_metrics === "object" && record.final_metrics !== null
    ? record.final_metrics as Record<string, unknown>
    : null;
  const extra = typeof finalMetrics?.extra === "object" && finalMetrics.extra !== null
    ? finalMetrics.extra as Record<string, unknown>
    : null;

  return typeof extra?.total_cache_creation_input_tokens === "number" && Number.isFinite(extra.total_cache_creation_input_tokens)
    ? extra.total_cache_creation_input_tokens
    : null;
}
