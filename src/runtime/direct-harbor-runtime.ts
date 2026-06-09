import { cp, mkdir, readFile, readdir, rm, writeFile } from "fs/promises";
import { basename, dirname, join, relative, resolve } from "path";

import { loadProjectConfig } from "../config/loader.js";
import { resolveHarborProvider } from "../config/harbor-resolver.js";
import { HarborJobSubmitter } from "../harbor/harbor-runner.js";
import type { HarborJobSubmissionResult } from "../harbor/harbor-runner.js";
import { readHarborTrialResult } from "../harbor/harbor-reader.js";
import { mapHarborTrialToTrialResult } from "../harbor/harbor-result-mapper.js";
import { scrubPublicDiagnostic } from "../harbor/public-scrub.js";
import {
  configureHarborVerifierBridge,
  persistHarborTrialArtifacts,
} from "./harbor-runtime-artifacts.js";
import { validateMaterializedHarborTask } from "./harbor-task-precheck.js";
import type { HarborRuntimeConfig, ProjectConfig } from "../types/config.js";
import type { TrialResult } from "../types/result.js";
import type { SkillCandidate } from "../types/task.js";
import {
  buildDirectHarborConditionConfig,
  configureDirectHarborDockerProxy,
  hardenDockerMirrorSetup,
  hardenDirectHarborDockerNetworkFetches,
  ensurePythonCommandAliasInHarborDockerfile,
  preinstallClaudeCodeInHarborDockerfile,
  preinstallCodexInHarborDockerfile,
  prewarmDirectHarborAgentDockerCache,
  repairPreFromDockerfileInstructions,
  repairTrailingDockerfileContinuation,
  slugifyHarborLabel,
  stabilizeDirectHarborPackageMirrors,
  stabilizeDirectHarborUvInstaller,
  stabilizeKnownDirectHarborDockerfilePatterns,
  stabilizeDirectHarborTaskToml,
  stripDirectHarborSkillCopyDockerfileLayers,
} from "./direct-harbor-dockerfile.js";

const DEFAULT_HARBOR_AGENT_IMPORT_PATH = "harbor_ext.codex_custom:CodexCustom";

export interface DirectHarborTaskInput {
  condition: string;
  taskDir: string;
}

export interface RunDirectHarborRuntimeOptions {
  taskId: string;
  harborTasks: DirectHarborTaskInput[];
  configPath?: string;
  outputDir?: string;
  harborJobsDir?: string;
  providerOverride?: string;
  modelOverride?: string;
  agentImportPathOverride?: string;
  agentKwargs?: Record<string, string>;
  harborOverrides?: HarborRuntimeConfig;
  concurrency?: number;
  preinstallCodex?: boolean;
  preinstallClaudeCode?: boolean;
  dockerProxyUrl?: string;
  harborJobSubmitter?: Pick<HarborJobSubmitter, "submitJob">;
}

export interface DirectHarborConditionRun {
  condition: string;
  sourceTaskDir: string;
  materializedTaskDir: string;
  outputDir: string;
  jobDir: string;
  result: TrialResult;
}

export interface DirectHarborRuntimeRunResult {
  taskId: string;
  outputDir: string;
  summaryPath: string;
  runs: DirectHarborConditionRun[];
}

export async function runDirectHarborRuntime(
  options: RunDirectHarborRuntimeOptions,
): Promise<DirectHarborRuntimeRunResult> {
  if (options.harborTasks.length === 0) {
    throw new Error("Direct Harbor runtime requires at least one --harbor-task-dir input.");
  }

  let config = await loadProjectConfig(options.configPath);
  if (config == null) {
    throw new Error("Direct Harbor runtime requires a config.yaml with providers defined.");
  }
  if (options.providerOverride != null) {
    if (!(options.providerOverride in config.providers)) {
      const available = Object.keys(config.providers);
      throw new Error(
        `Provider "${options.providerOverride}" not found in config. Available providers: ${available.length > 0 ? available.join(", ") : "(none)"}.`,
      );
    }
    config = applyProviderOverride(config, options.providerOverride);
  }

  const providerId = config.defaultRuntime?.provider ?? config.provider;
  if (providerId == null) {
    throw new Error("Direct Harbor runtime requires defaultRuntime.provider in config.yaml.");
  }
  const resolvedProvider = resolveHarborProvider(config, providerId);
  const model = options.modelOverride ?? resolvedProvider.model;
  const outputDir = resolve(options.outputDir ?? createDefaultOutputDir(`${options.taskId}-harbor-runtime`));
  const jobsDir = resolve(options.harborJobsDir ?? join(outputDir, "harbor-jobs"));
  const materializedRoot = join(outputDir, "materialized-harbor-tasks");
  const submitter = options.harborJobSubmitter ?? new HarborJobSubmitter();
  const harborConfig = buildDirectHarborConfig(config.harbor, options);
  const preinstallCodex = options.preinstallCodex ?? isCodexHarborAgentImportPath(harborConfig.agentImportPath);
  const preinstallClaudeCode = options.preinstallClaudeCode ?? isClaudeHarborAgentImportPath(harborConfig.agentImportPath);
  const dockerProxyUrl = normalizeOptionalText(options.dockerProxyUrl ?? process.env.SKILL_JUROR_HARBOR_RUNTIME_PROXY_URL);
  const candidates = options.harborTasks.map((input): SkillCandidate => ({
    id: input.condition,
    label: input.condition,
    skillDir: join(resolve(input.taskDir), "environment", "skills"),
    skillDetection: { enabled: true },
  }));
  const candidateSkillIds = candidates.map((candidate) => candidate.id);

  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "manifest.json"), JSON.stringify({
    schemaVersion: "direct-harbor-runtime-v1",
    taskId: options.taskId,
    providerId,
    model,
    agentImportPath: harborConfig.agentImportPath ?? null,
    runtimeCapture: {
      terminalArtifact: "trajectory.json",
      verification: "not-run",
    },
    preinstallCodex,
    preinstallClaudeCode,
    dockerProxyConfigured: dockerProxyUrl !== null,
    variantCount: options.harborTasks.length,
  }, null, 2));

  const runs = new Array<DirectHarborConditionRun>(options.harborTasks.length);
  let nextIndex = 0;
  const workerCount = Math.min(normalizeConcurrency(options.concurrency), options.harborTasks.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      const input = options.harborTasks[index];
      if (input == null) {
        return;
      }

      runs[index] = await runDirectHarborCondition({
        taskId: options.taskId,
        input,
        outputDir,
        materializedRoot,
        jobsDir,
        providerId,
        provider: resolvedProvider,
        model,
        harborConfig,
        preinstallCodex,
        preinstallClaudeCode,
        prewarmAgentCache: options.harborJobSubmitter == null,
        dockerProxyUrl,
        submitter,
        candidates,
        candidateSkillIds,
      });
    }
  });
  const summaryPath = join(outputDir, "summary.json");
  try {
    await Promise.all(workers);

    await writeFile(summaryPath, JSON.stringify({
      schemaVersion: "direct-harbor-runtime-v1",
      taskId: options.taskId,
      providerId,
      model,
      agentImportPath: harborConfig.agentImportPath ?? null,
      runtimeCapture: {
        terminalArtifact: "trajectory.json",
        verification: "not-run",
      },
      preinstallCodex,
      preinstallClaudeCode,
      dockerProxyConfigured: dockerProxyUrl !== null,
      results: runs.map((run) => summarizeDirectHarborConditionRun(run, outputDir)),
    }, null, 2));

    return {
      taskId: options.taskId,
      outputDir,
      summaryPath,
      runs,
    };
  } finally {
    await rm(materializedRoot, { recursive: true, force: true });
    await rm(jobsDir, { recursive: true, force: true });
  }
}

function buildDirectHarborConfig(
  baseConfig: HarborRuntimeConfig | undefined,
  options: Pick<RunDirectHarborRuntimeOptions, "agentImportPathOverride" | "agentKwargs" | "harborOverrides">,
): HarborRuntimeConfig {
  return {
    ...(baseConfig ?? {}),
    ...(options.harborOverrides ?? {}),
    agentImportPath: options.agentImportPathOverride ?? options.harborOverrides?.agentImportPath ?? baseConfig?.agentImportPath ?? DEFAULT_HARBOR_AGENT_IMPORT_PATH,
    agentKwargs: {
      ...(baseConfig?.agentKwargs ?? {}),
      ...(options.harborOverrides?.agentKwargs ?? {}),
      ...(options.agentKwargs ?? {}),
    },
    dockerBuild: mergeOptionalObjects(baseConfig?.dockerBuild, options.harborOverrides?.dockerBuild),
    mountsJson: options.harborOverrides?.mountsJson ?? baseConfig?.mountsJson,
    agentEnv: mergeOptionalObjects(baseConfig?.agentEnv, options.harborOverrides?.agentEnv),
  };
}

function mergeOptionalObjects<T extends Record<string, unknown>>(
  base: T | undefined,
  override: T | undefined,
): T | undefined {
  if (base == null) {
    return override;
  }
  if (override == null) {
    return base;
  }
  return {
    ...base,
    ...override,
  };
}

function isCodexHarborAgentImportPath(agentImportPath: string | undefined): boolean {
  return agentImportPath != null && /codex/i.test(agentImportPath);
}

function isClaudeHarborAgentImportPath(agentImportPath: string | undefined): boolean {
  return agentImportPath != null && /claude/i.test(agentImportPath);
}

interface DirectHarborConditionExecutionOptions {
  taskId: string;
  input: DirectHarborTaskInput;
  outputDir: string;
  materializedRoot: string;
  jobsDir: string;
  providerId: string;
  provider: ReturnType<typeof resolveHarborProvider>;
  model: string;
  harborConfig: HarborRuntimeConfig;
  preinstallCodex: boolean;
  preinstallClaudeCode: boolean;
  prewarmAgentCache: boolean;
  dockerProxyUrl: string | null;
  submitter: Pick<HarborJobSubmitter, "submitJob">;
  candidates: SkillCandidate[];
  candidateSkillIds: string[];
}

async function runDirectHarborCondition(
  options: DirectHarborConditionExecutionOptions,
): Promise<DirectHarborConditionRun> {
  const conditionSlug = slugifyHarborLabel(options.input.condition);
  const sourceTaskDir = resolve(options.input.taskDir);
  const materializedTaskDir = join(options.materializedRoot, conditionSlug);
  const conditionOutputDir = join(options.outputDir, options.input.condition);
  let submission: HarborJobSubmissionResult | null = null;

  try {
    await rm(materializedTaskDir, { recursive: true, force: true });
    await mkdir(options.materializedRoot, { recursive: true });
    await cp(sourceTaskDir, materializedTaskDir, { recursive: true });
    if (options.dockerProxyUrl !== null) {
      await configureDirectHarborDockerProxy(materializedTaskDir, options.dockerProxyUrl);
    }
    await repairPreFromDockerfileInstructions(materializedTaskDir);
    await hardenDockerMirrorSetup(materializedTaskDir);
    await stabilizeDirectHarborPackageMirrors(materializedTaskDir);
    await stabilizeDirectHarborUvInstaller(materializedTaskDir);
    await stabilizeKnownDirectHarborDockerfilePatterns(materializedTaskDir);
    await hardenDirectHarborDockerNetworkFetches(materializedTaskDir);
    await stripDirectHarborSkillCopyDockerfileLayers(materializedTaskDir);
    await ensureRuntimeSkillFrontmatter(join(materializedTaskDir, "environment", "skills"));
    if (options.preinstallCodex) {
      await preinstallCodexInHarborDockerfile(materializedTaskDir);
    }
    if (options.preinstallClaudeCode) {
      await preinstallClaudeCodeInHarborDockerfile(materializedTaskDir);
    }
    if (options.prewarmAgentCache) {
      await prewarmDirectHarborAgentDockerCache(materializedTaskDir, options.harborConfig.dockerBuild);
    }
    await ensurePythonCommandAliasInHarborDockerfile(materializedTaskDir);
    await repairTrailingDockerfileContinuation(materializedTaskDir);
    await configureHarborVerifierBridge(materializedTaskDir);
    const taskToml = await stabilizeDirectHarborTaskToml(materializedTaskDir, {
      taskId: options.taskId,
      condition: options.input.condition,
      materializedTaskDir,
    });
    const harborConfig = buildDirectHarborConditionConfig(options.harborConfig, materializedTaskDir, taskToml.skillsDir);
    await validateMaterializedHarborTask(materializedTaskDir);
    await mkdir(conditionOutputDir, { recursive: true });

    submission = await options.submitter.submitJob({
      taskDir: materializedTaskDir,
      jobsDir: join(options.jobsDir, conditionSlug),
      provider: options.provider,
      model: options.model,
      taskCount: 1,
      harbor: harborConfig,
    });
    if (!submission.success) {
      const diagnosticOutput = scrubPublicDiagnostic(
        [submission.stderr, submission.stdout].filter((value) => value.trim().length > 0).join("\n"),
      );
      throw new Error(
        `Harbor job submission failed for ${options.input.condition} `
        + `(exit ${submission.exitCode ?? "null"}): ${diagnosticOutput}`,
      );
    }

    const trialDirNames = (await readdir(submission.jobDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    if (trialDirNames.length !== 1) {
      throw new Error(`Expected exactly one Harbor trial for ${options.input.condition}, found ${trialDirNames.length}.`);
    }

    const harborTrialDir = join(submission.jobDir, trialDirNames[0]);
    const harborTrial = await readHarborTrialResult(harborTrialDir);
    const mapped = mapHarborTrialToTrialResult(harborTrial);
    const localTrialDir = join(conditionOutputDir, "trial-0");
    const selectedSkill = {
      id: options.input.condition,
      label: options.input.condition,
      skillDir: join(materializedTaskDir, "environment", "skills"),
    };
    const runtime = {
      platform: harborTrial.config.agent.name,
      provider: options.providerId,
      model: harborTrial.config.agent.model_name ?? options.model,
    };
    const environment = {
      backend: harborTrial.config.environment.type,
      workspaceTemplate: "",
      artifactProfile: "debug" as const,
    };
    const result: TrialResult = {
      ...mapped,
      trialId: "trial-0",
      taskId: options.taskId,
      acceptance: {
        success: mapped.runtime_success,
        evaluator: "not-run",
        summary: "Runtime capture completed; task verification was not run by this toolkit.",
      },
      execution: {
        ...mapped.execution,
        providerId: options.providerId,
        selectedSkill,
        candidateSkillIds: options.candidateSkillIds,
        runtime,
        environment,
      },
    };
    const persisted = await persistHarborTrialArtifacts({
      harborTrialDir,
      localTrialDir,
      result,
    });

    await writeFile(join(conditionOutputDir, "summary.json"), JSON.stringify(summarizeDirectHarborConditionRun({
      condition: options.input.condition,
      sourceTaskDir,
      materializedTaskDir,
      outputDir: conditionOutputDir,
      jobDir: submission.jobDir,
      result: persisted,
    }, conditionOutputDir), null, 2));

    return {
      condition: options.input.condition,
      sourceTaskDir,
      materializedTaskDir,
      outputDir: conditionOutputDir,
      jobDir: submission.jobDir,
      result: persisted,
    };
  } finally {
    await rm(materializedTaskDir, { recursive: true, force: true });
    if (submission !== null) {
      await rm(submission.jobDir, { recursive: true, force: true });
    }
  }
}

function summarizeDirectHarborConditionRun(run: DirectHarborConditionRun, baseDir: string): Record<string, unknown> {
  return {
    condition: run.condition,
    trialId: run.result.trialId,
    trajectoryPath: relative(baseDir, join(run.outputDir, "trial-0", "trajectory.json")),
    runtimeSuccess: run.result.runtime_success,
    durationMs: run.result.duration_ms,
    usage: run.result.usage,
    numTurns: run.result.num_turns,
    stopReason: run.result.stop_reason,
    sessionId: run.result.session_id,
    rawArtifacts: run.result.execution.rawArtifacts,
    error: run.result.error,
  };
}

async function ensureRuntimeSkillFrontmatter(skillsDir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = join(skillsDir, entry.name);
    if (entry.isDirectory()) {
      await ensureRuntimeSkillFrontmatter(entryPath);
      continue;
    }
    if (!entry.isFile() || entry.name !== "SKILL.md") {
      continue;
    }

    const original = await readTextFile(entryPath);
    if (original === null || hasYamlFrontmatter(original)) {
      continue;
    }

    const skillName = sanitizeSkillName(basename(dirname(entryPath)));
    const description = inferSkillDescription(original, skillName);
    const updated = [
      "---",
      `name: ${jsonString(skillName)}`,
      `description: ${jsonString(description)}`,
      "---",
      "",
      original.trimStart(),
    ].join("\n");
    await writeFile(entryPath, updated);
  }
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function hasYamlFrontmatter(text: string): boolean {
  return /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(text);
}

function sanitizeSkillName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "runtime-skill";
}

function inferSkillDescription(text: string, skillName: string): string {
  const lines = text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const useLine = lines.find((line) => /^use this skill\b/i.test(line));
  const candidate = useLine ?? `Use this skill for ${skillName}.`;
  return candidate.length <= 240 ? candidate : `${candidate.slice(0, 237)}...`;
}

function jsonString(value: string): string {
  return JSON.stringify(value);
}


function normalizeOptionalText(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized == null || normalized.length === 0 ? null : normalized;
}

function applyProviderOverride(config: ProjectConfig, providerId: string): ProjectConfig {
  return {
    ...config,
    provider: providerId,
    defaultRuntime: {
      ...(config.defaultRuntime ?? {}),
      provider: providerId,
    },
  };
}

function createDefaultOutputDir(label: string): string {
  const timestamp = new Date().toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
  return join("runs", `${label}-${timestamp}`);
}

function normalizeConcurrency(value: number | undefined): number {
  if (value == null) {
    return 1;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("Concurrency must be an integer greater than or equal to 1.");
  }
  return value;
}
