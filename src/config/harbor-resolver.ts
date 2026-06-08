import type { ProjectConfig, ProviderConfig } from "../types/config.js";

type HarborTransport = "openai" | "openai-compatible" | "anthropic";

export interface HarborModelInfo {
  name: string;
  transport: HarborTransport;
  baseURL: string | null;
}

export interface ResolvedHarborProvider {
  providerId: string;
  provider: ProviderConfig;
  transport: HarborTransport;
  model: string;
  env: Record<string, string>;
  modelInfo: HarborModelInfo;
}

export function resolveHarborProvider(
  projectConfig: ProjectConfig,
  providerId: string,
): ResolvedHarborProvider {
  if (providerId.length === 0) {
    throw new Error("Harbor provider id is required.");
  }

  const provider = projectConfig.providers[providerId];
  if (provider == null) {
    throw new Error(`Provider "${providerId}" was not found in project config.`);
  }

  const transport = provider.transport ?? "openai";

  const model = provider.model ?? projectConfig.model;
  if (model == null) {
    throw new Error(`Provider "${providerId}" is missing a model.`);
  }

  const baseURL = resolveBaseURL(projectConfig, provider, providerId);
  const apiKey = resolveApiKey(projectConfig, provider, providerId);
  const env = createProviderEnv(projectConfig, {
    transport,
    model,
    baseURL,
    apiKey,
  });

  return {
    providerId,
    provider,
    transport,
    model,
    env,
    modelInfo: {
      name: model,
      transport,
      baseURL,
    },
  };
}

function resolveApiKey(
  projectConfig: ProjectConfig,
  provider: ProviderConfig,
  providerId: string,
): string {
  if (provider.apiKey != null) {
    return provider.apiKey;
  }

  if (projectConfig.apiKey != null) {
    return projectConfig.apiKey;
  }

  const apiKeyEnvVar = provider.apiKeyEnvVar ?? projectConfig.apiKeyEnvVar;
  if (apiKeyEnvVar == null) {
    throw new Error(`Provider "${providerId}" is missing apiKey and apiKeyEnvVar.`);
  }

  const apiKey = process.env[apiKeyEnvVar];
  if (apiKey == null || apiKey.length === 0) {
    throw new Error(
      `Provider "${providerId}" requires environment variable "${apiKeyEnvVar}", but it is not set.`,
    );
  }

  return apiKey;
}

function resolveBaseURL(
  projectConfig: ProjectConfig,
  provider: ProviderConfig,
  providerId: string,
): string | null {
  const directBaseURL = provider.baseURL ?? projectConfig.baseURL;
  if (directBaseURL != null && directBaseURL.trim().length > 0) {
    return directBaseURL;
  }

  const baseURLEnvVar = provider.baseURLEnvVar ?? projectConfig.baseURLEnvVar;
  if (baseURLEnvVar == null) {
    return null;
  }

  const value = process.env[baseURLEnvVar];
  if (value == null || value.trim().length === 0) {
    throw new Error(
      `Provider "${providerId}" requires environment variable "${baseURLEnvVar}" for baseURL, but it is not set.`,
    );
  }

  return value;
}

function createProviderEnv(
  projectConfig: ProjectConfig,
  input: {
    transport: HarborTransport;
    model: string;
    baseURL: string | null;
    apiKey: string;
  },
): Record<string, string> {
  if (input.transport === "anthropic") {
    return {
      ANTHROPIC_API_KEY: input.apiKey,
      ...(input.baseURL == null ? {} : { ANTHROPIC_BASE_URL: input.baseURL }),
    };
  }

  const env: Record<string, string> = {
    OPENAI_API_KEY: input.apiKey,
    SKILL_JUROR_CODEX_CONFIG_JSON: createCodexConfigJson(projectConfig, {
      model: input.model,
      baseURL: input.baseURL,
    }),
  };

  if (input.baseURL != null) {
    env.OPENAI_BASE_URL = input.baseURL;
    env.CODEX_PROVIDER_BASE_URL = input.baseURL;
  }

  return env;
}

function createCodexConfigJson(
  projectConfig: ProjectConfig,
  input: {
    model: string;
    baseURL: string | null;
  },
): string {
  const codex = projectConfig.harbor?.codex;
  const modelProvider = codex?.modelProvider ?? "custom";
  const modelReasoningEffort =
    codex?.modelReasoningEffort
    ?? projectConfig.harbor?.agentKwargs?.reasoning_effort
    ?? "high";

  return JSON.stringify({
    model: input.model,
    model_provider: modelProvider,
    model_reasoning_effort: modelReasoningEffort,
    approval_policy: codex?.approvalPolicy ?? "never",
    sandbox_mode: codex?.sandboxMode ?? "danger-full-access",
    model_providers: {
      [modelProvider]: {
        name: codex?.providerName ?? "OpenAI",
        wire_api: codex?.wireApi ?? "responses",
        requires_openai_auth: codex?.requiresOpenAIAuth ?? true,
        ...(input.baseURL == null ? {} : { base_url: input.baseURL }),
      },
    },
  });
}
