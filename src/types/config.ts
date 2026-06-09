import { z } from "zod";

export const ProviderConfigSchema = z.object({
  transport: z.enum(["openai", "openai-compatible", "anthropic"]).optional(),
  baseURL: z.string().min(1).optional(),
  baseURLEnvVar: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  apiKeyEnvVar: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const CodexRuntimeConfigSchema = z.object({
  modelProvider: z.string().min(1).optional(),
  providerName: z.string().min(1).optional(),
  wireApi: z.string().min(1).optional(),
  requiresOpenAIAuth: z.boolean().optional(),
  modelReasoningEffort: z.string().min(1).optional(),
  approvalPolicy: z.string().min(1).optional(),
  sandboxMode: z.string().min(1).optional(),
});

export const HarborRuntimeConfigSchema = z.object({
  agentImportPath: z.string().min(1).optional(),
  pythonPath: z.string().min(1).optional(),
  forceBuild: z.boolean().optional(),
  delete: z.boolean().optional(),
  npmRegistry: z.string().min(1).optional(),
  codex: CodexRuntimeConfigSchema.optional(),
  timeoutMultiplier: z.number().positive().optional(),
  agentTimeoutMultiplier: z.number().positive().optional(),
  verifierTimeoutMultiplier: z.number().positive().optional(),
  agentSetupTimeoutMultiplier: z.number().positive().optional(),
  environmentBuildTimeoutMultiplier: z.number().positive().optional(),
  overrideCpus: z.number().positive().optional(),
  overrideMemoryMb: z.number().int().positive().optional(),
  overrideStorageMb: z.number().int().positive().optional(),
  dockerBuild: z.object({
    memory: z.string().min(1).optional(),
    memorySwap: z.string().min(1).optional(),
    cpuQuota: z.number().int().positive().optional(),
    cpuPeriod: z.number().int().positive().optional(),
    network: z.string().min(1).optional(),
    cpusetCpus: z.string().min(1).optional(),
    shmSize: z.string().min(1).optional(),
    maxOutputBytes: z.number().int().positive().optional(),
  }).optional(),
  mountsJson: z.array(z.object({
    type: z.enum(["bind", "volume", "image"]),
    source: z.string().min(1),
    target: z.string().min(1),
    read_only: z.literal(true).optional(),
    bind: z.record(z.string(), z.unknown()).optional(),
    volume: z.record(z.string(), z.unknown()).optional(),
    image: z.record(z.string(), z.unknown()).optional(),
  }).passthrough()).optional(),
  agentEnv: z.record(z.string(), z.string()).optional(),
  agentKwargs: z.record(z.string(), z.string()).optional(),
});

const RawProjectConfigSchema = z.object({
  provider: z.string().min(1).optional(),
  baseURL: z.string().min(1).optional(),
  baseURLEnvVar: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  apiKeyEnvVar: z.string().min(1).optional(),
  providers: z.record(z.string(), ProviderConfigSchema).optional(),
  defaultRuntime: z.object({
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  }).strict().optional(),
  harbor: HarborRuntimeConfigSchema.optional(),
}).strict();

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type CodexRuntimeConfig = z.infer<typeof CodexRuntimeConfigSchema>;
export type HarborRuntimeConfig = z.infer<typeof HarborRuntimeConfigSchema>;
export type RawProjectConfig = z.infer<typeof RawProjectConfigSchema>;

export interface ProjectConfig {
  provider?: string;
  baseURL?: string;
  baseURLEnvVar?: string;
  model?: string;
  apiKey?: string;
  apiKeyEnvVar?: string;
  providers: Record<string, ProviderConfig>;
  defaultRuntime?: {
    provider?: string;
    model?: string;
  };
  harbor?: HarborRuntimeConfig;
}

export const ProjectConfigSchema = RawProjectConfigSchema.transform((raw) => normalizeProjectConfig(raw));

export function normalizeProjectConfig(raw: RawProjectConfig): ProjectConfig {
  const defaultProviderId = raw.provider ?? raw.defaultRuntime?.provider ?? inferDefaultProviderId(raw.providers);
  const legacyProviderConfig =
    defaultProviderId == null
      ? undefined
      : {
        transport: "openai" as const,
        baseURL: raw.baseURL,
        baseURLEnvVar: raw.baseURLEnvVar,
        apiKey: raw.apiKey,
        apiKeyEnvVar: raw.apiKeyEnvVar,
        model: raw.model,
      } satisfies ProviderConfig;

  return {
    provider: defaultProviderId,
    baseURL: raw.baseURL,
    baseURLEnvVar: raw.baseURLEnvVar,
    model: raw.model,
    apiKey: raw.apiKey,
    apiKeyEnvVar: raw.apiKeyEnvVar,
    providers: mergeProviders(raw.providers, defaultProviderId, legacyProviderConfig),
    defaultRuntime: raw.defaultRuntime,
    harbor: raw.harbor,
  };
}

function inferDefaultProviderId(
  providers: Record<string, ProviderConfig> | undefined,
): string | undefined {
  if (providers == null) {
    return undefined;
  }

  return Object.keys(providers)[0];
}

function mergeProviders(
  providers: Record<string, ProviderConfig> | undefined,
  defaultProviderId: string | undefined,
  legacyProviderConfig: ProviderConfig | undefined,
): Record<string, ProviderConfig> {
  const merged: Record<string, ProviderConfig> = { ...(providers ?? {}) };

  if (defaultProviderId != null && legacyProviderConfig != null && hasProviderValues(legacyProviderConfig)) {
    merged[defaultProviderId] = {
      ...legacyProviderConfig,
      ...merged[defaultProviderId],
    };
  }

  return merged;
}

function hasProviderValues(provider: ProviderConfig): boolean {
  return [provider.baseURL, provider.baseURLEnvVar, provider.apiKey, provider.apiKeyEnvVar, provider.model].some(
    (value) => value != null,
  );
}
