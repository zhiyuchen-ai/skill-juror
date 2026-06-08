import { loadProjectConfig } from "../config/loader.js";
import { resolveHarborProvider } from "../config/harbor-resolver.js";

export interface DataPrepHarborConfigOptions {
  configPath?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  npmRegistry?: string;
  baseUrl?: string;
}

export interface DataPrepHarborConfigDefaults {
  model: string;
  reasoningEffort: string;
  npmRegistry: string;
}

export interface ResolvedDataPrepHarborConfig {
  model: string;
  reasoningEffort: string;
  npmRegistry: string;
  agentImportPath?: string;
  baseUrl?: string;
  agentEnv: Record<string, string>;
}

export async function resolveDataPrepHarborConfig(
  options: DataPrepHarborConfigOptions,
  defaults: DataPrepHarborConfigDefaults,
): Promise<ResolvedDataPrepHarborConfig> {
  const config = await loadProjectConfig(options.configPath);
  if (config == null) {
    throw new Error(`Data preparation requires ${options.configPath ?? "config.yaml"} with providers defined.`);
  }

  const providerId = options.provider ?? config.defaultRuntime?.provider ?? config.provider;
  if (providerId == null) {
    throw new Error("Data preparation requires defaultRuntime.provider in config.yaml.");
  }
  const resolvedProvider = resolveHarborProvider(config, providerId);
  const model = options.model ?? resolvedProvider.model ?? config.model ?? defaults.model;
  const reasoningEffort =
    options.reasoningEffort
    ?? config.harbor?.codex?.modelReasoningEffort
    ?? config.harbor?.agentKwargs?.reasoning_effort
    ?? defaults.reasoningEffort;
  const baseUrl = options.baseUrl ?? resolvedProvider?.modelInfo.baseURL ?? config.baseURL;
  const agentEnv = { ...resolvedProvider.env };
  const configJson = overrideCodexConfig(agentEnv.SKILL_JUROR_CODEX_CONFIG_JSON, {
    model,
    reasoningEffort,
    baseUrl,
  });

  if (configJson != null) {
    agentEnv.SKILL_JUROR_CODEX_CONFIG_JSON = configJson;
  }

  return {
    model,
    reasoningEffort,
    npmRegistry: options.npmRegistry ?? config.harbor?.npmRegistry ?? defaults.npmRegistry,
    agentImportPath: config.harbor?.agentImportPath,
    baseUrl,
    agentEnv,
  };
}

function overrideCodexConfig(
  rawConfig: string | undefined,
  overrides: {
    model: string;
    reasoningEffort: string;
    baseUrl?: string;
  },
): string | null {
  if (rawConfig == null || rawConfig.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawConfig) as {
      model?: string;
      model_provider?: string;
      model_reasoning_effort?: string;
      model_providers?: Record<string, Record<string, unknown>>;
    };
    parsed.model = overrides.model;
    parsed.model_reasoning_effort = overrides.reasoningEffort;
    if (overrides.baseUrl != null) {
      const providerKey = parsed.model_provider ?? "custom";
      parsed.model_providers ??= {};
      parsed.model_providers[providerKey] ??= {};
      parsed.model_providers[providerKey].base_url = overrides.baseUrl;
    }
    return JSON.stringify(parsed);
  } catch {
    return rawConfig;
  }
}
