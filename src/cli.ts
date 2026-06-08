import { join, resolve } from "path";

import { runBaselineHarborCommand } from "./data-prep/baseline-harbor.js";
import { runOriginFlatHarborCommand } from "./data-prep/origin-flat-harbor.js";
import { runPdHarborCommand } from "./data-prep/pd-harbor.js";
import { runDirectHarborRuntime, type DirectHarborTaskInput } from "./runtime/direct-harbor-runtime.js";
import type { HarborRuntimeConfig } from "./types/config.js";

interface ParsedArgs {
  positionals: string[];
  values: Map<string, string[]>;
  flags: Set<string>;
}

const DEFAULT_AGENT_IMPORT_PATH = "harbor_ext.codex_custom:CodexCustom";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positionals[0];

  if (command == null) {
    print(renderHelp());
    return;
  }

  if (command === "construct") {
    await handleConstruct(args);
    return;
  }

  if (command === "run") {
    await handleRun(args);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

async function handleConstruct(args: ParsedArgs): Promise<void> {
  const rawVariant = args.positionals[1];
  if (rawVariant == null || hasFlag(args, "help") || hasFlag(args, "h")) {
    print(renderConstructHelp());
    return;
  }
  const variant = normalizeConstructVariant(rawVariant);

  if (variant === "baseline") {
    const result = await runBaselineHarborCommand({
      taskRef: requireValue(args, "task"),
      tasksRoot: optionalValue(args, "tasks-root"),
      outDir: optionalValue(args, "out"),
      configPath: optionalValue(args, "config"),
      provider: optionalValue(args, "provider"),
      model: optionalValue(args, "model"),
      reasoningEffort: optionalValue(args, "reasoning-effort"),
      harborAgentImportPath: optionalValue(args, "agent-import-path"),
      baseUrl: optionalValue(args, "base-url"),
      proxyUrl: optionalValue(args, "proxy-url"),
      dockerNetwork: optionalValue(args, "docker-network"),
      forceBuild: optionalBoolean(args, "force-build"),
      npmRegistry: optionalValue(args, "npm-registry"),
    });
    printJson(result);
    return;
  }

  if (variant === "pd") {
    const result = await runPdHarborCommand({
      taskRef: optionalValue(args, "task"),
      baselineRoot: optionalValue(args, "single-file-root") ?? optionalValue(args, "baseline-root"),
      baselineRunsRoot: optionalValue(args, "single-file-runs-root") ?? optionalValue(args, "baseline-runs-root"),
      outDir: optionalValue(args, "out"),
      configPath: optionalValue(args, "config"),
      provider: optionalValue(args, "provider"),
      model: optionalValue(args, "model"),
      reasoningEffort: optionalValue(args, "reasoning-effort"),
      harborAgentImportPath: optionalValue(args, "agent-import-path"),
      baseUrl: optionalValue(args, "base-url"),
      proxyUrl: optionalValue(args, "proxy-url"),
      dockerNetwork: optionalValue(args, "docker-network"),
      forceBuild: optionalBoolean(args, "force-build"),
      npmRegistry: optionalValue(args, "npm-registry"),
    });
    printJson(result);
    return;
  }

  if (variant === "origin-flat") {
    const result = await runOriginFlatHarborCommand({
      taskRef: requireValue(args, "task"),
      tasksRoot: optionalValue(args, "tasks-root"),
      outDir: optionalValue(args, "out"),
      configPath: optionalValue(args, "config"),
      provider: optionalValue(args, "provider"),
      model: optionalValue(args, "model"),
      reasoningEffort: optionalValue(args, "reasoning-effort"),
      harborAgentImportPath: optionalValue(args, "agent-import-path"),
      baseUrl: optionalValue(args, "base-url"),
      forceBuild: optionalBoolean(args, "force-build"),
      npmRegistry: optionalValue(args, "npm-registry"),
    });
    printJson(result);
    return;
  }

  throw new Error(`Unknown construct variant: ${rawVariant}`);
}

async function handleRun(args: ParsedArgs): Promise<void> {
  if (hasFlag(args, "help") || hasFlag(args, "h")) {
    print(renderRunHelp());
    return;
  }

  const taskId = requireValue(args, "task-id");
  const harborTasks = resolveHarborTaskInputs(args, taskId);
  const harborOverrides = buildHarborOverrides(args);

  const result = await runDirectHarborRuntime({
    taskId,
    harborTasks,
    configPath: optionalValue(args, "config"),
    outputDir: optionalValue(args, "output"),
    harborJobsDir: optionalValue(args, "harbor-jobs-dir"),
    providerOverride: optionalValue(args, "provider"),
    modelOverride: optionalValue(args, "model"),
    agentImportPathOverride: optionalValue(args, "agent-import-path"),
    agentKwargs: parseKeyValueMap(values(args, "agent-kwarg")),
    harborOverrides,
    concurrency: optionalInteger(args, "concurrency"),
    preinstallCodex: optionalBoolean(args, "preinstall-codex"),
    preinstallClaudeCode: optionalBoolean(args, "preinstall-claude-code"),
    dockerProxyUrl: optionalValue(args, "docker-proxy-url"),
  });

  printJson({
    taskId: result.taskId,
    outputDir: result.outputDir,
    summaryPath: result.summaryPath,
    runs: result.runs.map((run) => ({
      variant: publicVariantName(run.condition),
      outputDir: run.outputDir,
      trajectoryPath: join(run.outputDir, "trial-0", "trajectory.json"),
      runtimeSuccess: run.result.runtime_success,
      rawArtifacts: run.result.execution.rawArtifacts,
      error: run.result.error,
    })),
  });
}

function resolveHarborTaskInputs(args: ParsedArgs, taskId: string): DirectHarborTaskInput[] {
  const directInputs = values(args, "harbor-task-dir").map(parseHarborTaskDir);
  const root = optionalValue(args, "harbor-task-root");
  const variants = parseList(optionalValue(args, "variants") ?? optionalValue(args, "conditions"));

  if (directInputs.length > 0 && root != null) {
    throw new Error("Use either --harbor-task-dir or --harbor-task-root, not both.");
  }

  if (directInputs.length > 0) {
    return directInputs;
  }

  if (root == null) {
    throw new Error("run requires --harbor-task-root or at least one --harbor-task-dir variant=path.");
  }
  if (variants.length === 0) {
    throw new Error("run with --harbor-task-root requires --variants <name[,name...]>");
  }

  const absoluteRoot = resolve(root);
  return variants.map((variant) => {
    const internalVariant = normalizeRuntimeVariant(variant);
    return {
      condition: internalVariant,
      taskDir: join(absoluteRoot, internalVariant, `${taskId}-${internalVariant}`),
    };
  });
}

function parseHarborTaskDir(value: string): DirectHarborTaskInput {
  const separatorIndex = value.indexOf("=");
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    throw new Error(`Invalid --harbor-task-dir value "${value}". Expected variant=path.`);
  }

  return {
    condition: normalizeRuntimeVariant(value.slice(0, separatorIndex)),
    taskDir: value.slice(separatorIndex + 1),
  };
}

function normalizeConstructVariant(value: string): "baseline" | "pd" | "origin-flat" | string {
  const normalized = normalizeKey(value);
  if (normalized === "single-file" || normalized === "baseline") {
    return "baseline";
  }
  if (normalized === "progressive-disclosure" || normalized === "progressive" || normalized === "pd") {
    return "pd";
  }
  if (normalized === "flatten-source" || normalized === "flatten-original" || normalized === "origin-flat") {
    return "origin-flat";
  }
  return normalized;
}

function normalizeRuntimeVariant(value: string): string {
  const normalized = normalizeKey(value);
  if (normalized === "single-file" || normalized === "baseline") {
    return "baseline";
  }
  if (normalized === "progressive-disclosure" || normalized === "progressive" || normalized === "pd") {
    return "pd";
  }
  if (normalized === "source-bundle" || normalized === "origin") {
    return "origin";
  }
  if (normalized === "no-skill" || normalized === "noskill") {
    return "noskill";
  }
  if (normalized === "flatten-source" || normalized === "origin-flat") {
    return "origin-flat";
  }
  return normalized;
}

function publicVariantName(value: string): string {
  const normalized = normalizeRuntimeVariant(value);
  if (normalized === "baseline") {
    return "single-file";
  }
  if (normalized === "pd") {
    return "progressive-disclosure";
  }
  if (normalized === "origin") {
    return "source-bundle";
  }
  if (normalized === "noskill") {
    return "no-skill";
  }
  if (normalized === "origin-flat") {
    return "flatten-source";
  }
  return value;
}

function buildHarborOverrides(args: ParsedArgs): HarborRuntimeConfig | undefined {
  const override: HarborRuntimeConfig = {};
  const agentEnv = parseKeyValueMap(values(args, "agent-env"));
  const dockerBuild = {
    network: optionalValue(args, "docker-network"),
    memory: optionalValue(args, "docker-memory"),
    memorySwap: optionalValue(args, "docker-memory-swap"),
    maxOutputBytes: optionalInteger(args, "docker-max-output-bytes"),
  };
  const hasDockerBuild = Object.values(dockerBuild).some((value) => value != null);

  if (Object.keys(agentEnv).length > 0) {
    override.agentEnv = agentEnv;
  }
  if (hasDockerBuild) {
    override.dockerBuild = dockerBuild;
  }

  override.forceBuild = optionalBoolean(args, "force-build");
  override.delete = optionalBoolean(args, "delete");
  override.npmRegistry = optionalValue(args, "npm-registry");
  override.pythonPath = optionalValue(args, "python-path");
  override.timeoutMultiplier = optionalNumber(args, "timeout-multiplier");
  override.agentTimeoutMultiplier = optionalNumber(args, "agent-timeout-multiplier");
  override.verifierTimeoutMultiplier = optionalNumber(args, "verifier-timeout-multiplier");
  override.agentSetupTimeoutMultiplier = optionalNumber(args, "agent-setup-timeout-multiplier");
  override.environmentBuildTimeoutMultiplier = optionalNumber(args, "environment-build-timeout-multiplier");
  override.overrideCpus = optionalNumber(args, "override-cpus");
  override.overrideMemoryMb = optionalInteger(args, "override-memory-mb");
  override.overrideStorageMb = optionalInteger(args, "override-storage-mb");

  const hasOverride = Object.values(override).some((value) => value != null);
  return hasOverride ? override : undefined;
}

function parseArgs(rawArgs: string[]): ParsedArgs {
  const positionals: string[] = [];
  const valuesByKey = new Map<string, string[]>();
  const flags = new Set<string>();

  for (let index = 0; index < rawArgs.length; index += 1) {
    const raw = rawArgs[index];
    if (!raw.startsWith("-")) {
      positionals.push(raw);
      continue;
    }

    const key = normalizeKey(raw.replace(/^-+/, ""));
    const next = rawArgs[index + 1];
    if (next == null || next.startsWith("-")) {
      flags.add(key);
      continue;
    }

    const existing = valuesByKey.get(key) ?? [];
    existing.push(next);
    valuesByKey.set(key, existing);
    index += 1;
  }

  return {
    positionals,
    values: valuesByKey,
    flags,
  };
}

function normalizeKey(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function hasFlag(args: ParsedArgs, key: string): boolean {
  return args.flags.has(normalizeKey(key));
}

function values(args: ParsedArgs, key: string): string[] {
  return args.values.get(normalizeKey(key)) ?? [];
}

function optionalValue(args: ParsedArgs, key: string): string | undefined {
  const matches = values(args, key);
  return matches.length === 0 ? undefined : matches[matches.length - 1];
}

function requireValue(args: ParsedArgs, key: string): string {
  const value = optionalValue(args, key);
  if (value == null || value.length === 0) {
    throw new Error(`Missing required option --${normalizeKey(key)}.`);
  }
  return value;
}

function optionalBoolean(args: ParsedArgs, key: string): boolean | undefined {
  const normalizedKey = normalizeKey(key);
  const value = optionalValue(args, normalizedKey);
  if (value == null) {
    return args.flags.has(normalizedKey) ? true : undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no"].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean for --${normalizedKey}: ${value}`);
}

function optionalInteger(args: ParsedArgs, key: string): number | undefined {
  const value = optionalValue(args, key);
  if (value == null) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== value.trim()) {
    throw new Error(`Invalid integer for --${normalizeKey(key)}: ${value}`);
  }
  return parsed;
}

function optionalNumber(args: ParsedArgs, key: string): number | undefined {
  const value = optionalValue(args, key);
  if (value == null) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number for --${normalizeKey(key)}: ${value}`);
  }
  return parsed;
}

function parseList(value: string | undefined): string[] {
  if (value == null) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseKeyValueMap(entries: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const entry of entries) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex <= 0) {
      throw new Error(`Expected key=value, got: ${entry}`);
    }
    map[entry.slice(0, separatorIndex)] = entry.slice(separatorIndex + 1);
  }
  return map;
}

function print(value: string): void {
  process.stdout.write(`${value}\n`);
}

function printJson(value: unknown): void {
  print(JSON.stringify(value, null, 2));
}

function renderHelp(): string {
  return `Usage:
  npm run construct -- <variant> [options]
  npm run run -- [options]

Commands:
  construct single-file                 Build a single-file skill variant.
  construct progressive-disclosure      Build a progressive-disclosure skill variant.
  construct flatten-source              Flatten a source skill bundle.
  run                                   Run materialized Harbor task variants and persist trajectory.json.

Compatibility aliases:
  baseline -> single-file
  pd -> progressive-disclosure
  origin-flat -> flatten-source

Run a command with --help for command-specific options.`;
}

function renderConstructHelp(): string {
  return `Usage:
  npm run construct -- single-file --task <task-id-or-path> [--tasks-root <root>] [--out <dir>]
  npm run construct -- progressive-disclosure --single-file-root <dir> [--task <task-id>] [--out <dir>]
  npm run construct -- flatten-source --task <task-id-or-path> [--tasks-root <root>] [--out <dir>]

Common options:
  --config <path>                  Default: config.yaml
  --provider <id>
  --model <name>
  --reasoning-effort <effort>
  --agent-import-path <path>       Harbor agent adapter, default: config.yaml then ${DEFAULT_AGENT_IMPORT_PATH}
  --base-url <url>                 Optional provider endpoint override.
  --proxy-url <url>                single-file/progressive-disclosure only.
  --docker-network host            single-file/progressive-disclosure only.
  --force-build <bool>
  --npm-registry <url>

Compatibility aliases:
  baseline -> single-file
  pd -> progressive-disclosure
  origin-flat -> flatten-source
  --baseline-root -> --single-file-root
  --baseline-runs-root -> --single-file-runs-root`;
}

function renderRunHelp(): string {
  return `Usage:
  npm run run -- --task-id <id> --harbor-task-root <root> --variants single-file,progressive-disclosure [options]
  npm run run -- --task-id <id> --harbor-task-dir single-file=/path/to/task [--harbor-task-dir progressive-disclosure=/path/to/task] [options]

Options:
  --config <path>                  Default: config.yaml
  --output <dir>
  --provider <id>
  --model <name>
  --agent-import-path <path>       Harbor agent adapter, default: config.yaml then ${DEFAULT_AGENT_IMPORT_PATH}
  --agent-kwarg key=value          Repeatable.
  --agent-env key=value            Repeatable.
  --concurrency <n>
  --preinstall-codex <bool>
  --preinstall-claude-code <bool>
  --docker-proxy-url <url>
  --force-build <bool>
  --delete <bool>
  --python-path <path>
  --npm-registry <url>
  --docker-network <network>
  --docker-memory <value>
  --docker-memory-swap <value>
  --docker-max-output-bytes <n>

Compatibility aliases:
  baseline -> single-file
  pd -> progressive-disclosure
  origin -> source-bundle
  noskill -> no-skill
  --conditions is accepted as a compatibility alias for --variants.

Agent adapters:
  Codex: harbor_ext.codex_custom:CodexCustom
  Claude Code: harbor_ext.claude_code_cached:ClaudeCodeCached`;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
