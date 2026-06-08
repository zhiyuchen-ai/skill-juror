import { createWriteStream } from "fs";
import { mkdir, readdir, readFile } from "fs/promises";
import { spawn } from "child_process";
import { join, resolve } from "path";

import type { ResolvedHarborProvider } from "../config/harbor-resolver.js";
import type { HarborRuntimeConfig } from "../types/config.js";
import { createControlledEnv } from "../runtime/env.js";
import { scrubHarborJobSensitiveFiles } from "./scrub.js";

const DEFAULT_HARBOR_AGENT_IMPORT_PATH = "harbor_ext.codex_custom:CodexCustom";
const DEFAULT_HARBOR_NPM_REGISTRY = "https://registry.npmjs.org/";
const DEFAULT_DOCKER_BUILD_MEMORY = "4g";
const DEFAULT_DOCKER_BUILD_MEMORY_SWAP = "6g";
const DEFAULT_DOCKER_BUILD_CPU_QUOTA = 200_000;
const DEFAULT_DOCKER_BUILD_CPU_PERIOD = 100_000;
const DEFAULT_DOCKER_BUILD_NETWORK = "host";
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const PYTHON_PATH_DELIMITER = ":";
const localPrebuiltImageBuilds = new Map<string, Promise<void>>();
let nextJobSequence = 0;

export interface HarborJobOptions {
  taskDir: string;
  jobsDir: string;
  provider: ResolvedHarborProvider;
  model: string;
  taskCount?: number;
  harbor?: HarborRuntimeConfig;
}

export interface HarborJobSubmissionResult {
  jobDir: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  logPath?: string;
  success: boolean;
}

export class HarborJobSubmitter {
  async submitJob(options: HarborJobOptions): Promise<HarborJobSubmissionResult> {
    const { taskDir, jobsDir, provider, model, harbor } = options;

    await mkdir(jobsDir, { recursive: true });
    const jobName = createHarborJobName();
    const jobDir = join(jobsDir, jobName);
    await mkdir(jobDir, { recursive: true });
    const agentImportPath = harbor?.agentImportPath ?? DEFAULT_HARBOR_AGENT_IMPORT_PATH;
    const forceBuild = harbor?.forceBuild ?? false;
    const deleteEnvironment = harbor?.delete ?? true;

    const args = [
      "job", "start",
      "--path", taskDir,
      "--model", model,
      "--job-name", jobName,
      "--jobs-dir", jobsDir,
      "--yes",
    ];
    if (harbor?.timeoutMultiplier != null) {
      args.push("--timeout-multiplier", String(harbor.timeoutMultiplier));
    }
    if (harbor?.agentTimeoutMultiplier != null) {
      args.push("--agent-timeout-multiplier", String(harbor.agentTimeoutMultiplier));
    }
    if (harbor?.verifierTimeoutMultiplier != null) {
      args.push("--verifier-timeout-multiplier", String(harbor.verifierTimeoutMultiplier));
    }
    args.push("--agent-setup-timeout-multiplier", String(harbor?.agentSetupTimeoutMultiplier ?? 5));
    if (harbor?.environmentBuildTimeoutMultiplier != null) {
      args.push("--environment-build-timeout-multiplier", String(harbor.environmentBuildTimeoutMultiplier));
    }
    args.push(deleteEnvironment ? "--delete" : "--no-delete");
    if (agentImportPath.length === 0) {
      throw new Error("Harbor agentImportPath cannot be empty; configure a Harbor agent adapter such as CodexCustom or ClaudeCodeCached.");
    }
    args.push("--agent-import-path", agentImportPath);
    if (harbor?.agentEnv != null) {
      for (const [key, value] of Object.entries(harbor.agentEnv)) {
        args.push("--ae", `${key}=${value}`);
      }
    }
    if (harbor?.agentKwargs != null) {
      for (const [key, value] of Object.entries(harbor.agentKwargs)) {
        args.push("--agent-kwarg", `${key}=${value}`);
      }
    }
    if (harbor?.mountsJson != null && harbor.mountsJson.length > 0) {
      args.push("--mounts-json", JSON.stringify(harbor.mountsJson));
    }
    if (harbor?.overrideCpus != null) {
      args.push("--override-cpus", String(harbor.overrideCpus));
    }
    if (harbor?.overrideMemoryMb != null) {
      args.push("--override-memory-mb", String(harbor.overrideMemoryMb));
    }
    if (harbor?.overrideStorageMb != null) {
      args.push("--override-storage-mb", String(harbor.overrideStorageMb));
    }
    if (forceBuild) {
      args.push("--force-build");
    } else {
      await prepareLocalPrebuiltImages(taskDir, harbor?.npmRegistry ?? DEFAULT_HARBOR_NPM_REGISTRY, harbor?.dockerBuild, jobDir);
    }

    const env: Record<string, string> = createControlledEnv({
      ...provider.env,
    }, { includeNetwork: true, includeTooling: true });
    overrideCodexConfigModel(env, model);
    const mergedPythonPath = mergePythonPath(harbor?.pythonPath ?? resolve("."), env.PYTHONPATH);
    if (mergedPythonPath != null) {
      env.PYTHONPATH = mergedPythonPath;
    }
    env.SKILL_JUROR_HARBOR_NPM_REGISTRY = harbor?.npmRegistry ?? DEFAULT_HARBOR_NPM_REGISTRY;

    const logPath = join(jobDir, "harbor-job-start.log");
    const result = await runCommand("harbor", args, env, harbor?.dockerBuild?.maxOutputBytes, logPath);
    await scrubHarborJobSensitiveFiles(jobDir);

    return {
      jobDir,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      logPath,
      success: result.exitCode === 0,
    };
  }
}

function overrideCodexConfigModel(env: Record<string, string>, model: string): void {
  const rawConfig = env.SKILL_JUROR_CODEX_CONFIG_JSON;
  if (rawConfig == null || rawConfig.length === 0) {
    return;
  }
  try {
    const parsed = JSON.parse(rawConfig) as Record<string, unknown>;
    parsed.model = model;
    env.SKILL_JUROR_CODEX_CONFIG_JSON = JSON.stringify(parsed);
  } catch {
    env.SKILL_JUROR_CODEX_CONFIG_JSON = rawConfig;
  }
}

function createHarborJobName(): string {
  nextJobSequence = (nextJobSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `skill-juror-${Date.now()}-${process.pid}-${nextJobSequence}`;
}

function mergePythonPath(preferredPath: string | undefined, existingPythonPath: string | undefined): string | undefined {
  if (preferredPath == null || preferredPath.length === 0) {
    return existingPythonPath;
  }
  if (existingPythonPath == null || existingPythonPath.length === 0) {
    return preferredPath;
  }

  const entries = existingPythonPath.split(PYTHON_PATH_DELIMITER);
  return entries.includes(preferredPath) ? existingPythonPath : `${preferredPath}${PYTHON_PATH_DELIMITER}${existingPythonPath}`;
}

async function prepareLocalPrebuiltImages(
  taskDir: string,
  npmRegistry: string,
  dockerBuild: HarborRuntimeConfig["dockerBuild"],
  diagnosticDir: string,
): Promise<void> {
  const taskRoots = await findHarborTaskRoots(taskDir);
  const preparedImages = new Set<string>();

  for (const root of taskRoots) {
    const image = await readDockerImage(join(root, "task.toml"));
    if (image == null || preparedImages.has(image)) {
      continue;
    }

    await ensureLocalPrebuiltImage(image, join(root, "environment"), npmRegistry, dockerBuild, diagnosticDir);
    preparedImages.add(image);
  }
}

async function ensureLocalPrebuiltImage(
  image: string,
  environmentDir: string,
  npmRegistry: string,
  dockerBuild: HarborRuntimeConfig["dockerBuild"],
  diagnosticDir: string,
): Promise<void> {
  const activeBuild = localPrebuiltImageBuilds.get(image);
  if (activeBuild != null) {
    await activeBuild;
    if (await localDockerImageExists(image)) {
      return;
    }
  }

  if (await localDockerImageExists(image)) {
    return;
  }

  const activeBuildAfterInspect = localPrebuiltImageBuilds.get(image);
  if (activeBuildAfterInspect != null) {
    await activeBuildAfterInspect;
    return;
  }

  const build = buildLocalPrebuiltImage(image, environmentDir, npmRegistry, dockerBuild, diagnosticDir)
    .finally(() => {
      localPrebuiltImageBuilds.delete(image);
    });
  localPrebuiltImageBuilds.set(image, build);
  await build;
}

async function localDockerImageExists(image: string): Promise<boolean> {
  const result = await runCommand("docker", ["image", "inspect", image], createControlledEnv({}, { includeTooling: true }));
  return result.exitCode === 0;
}

async function buildLocalPrebuiltImage(
  image: string,
  environmentDir: string,
  npmRegistry: string,
  dockerBuild: HarborRuntimeConfig["dockerBuild"],
  diagnosticDir: string,
): Promise<void> {
  await mkdir(diagnosticDir, { recursive: true });
  const logPath = join(diagnosticDir, `docker-build-${sanitizePathComponent(image)}.log`);
  const args = [
    "build",
    ...createDockerBuildResourceArgs(dockerBuild),
    "-t",
    image,
    "--build-arg",
    `HARBOR_CODEX_NPM_REGISTRY=${npmRegistry}`,
    "--build-arg",
    `LOCAL_NPM_REGISTRY=${npmRegistry}`,
    environmentDir,
  ];
  const result = await runCommand(
    "docker",
    args,
    createControlledEnv({}, { includeNetwork: true, includeTooling: true }),
    dockerBuild?.maxOutputBytes,
    logPath,
  );
  if (result.exitCode !== 0) {
    throw new Error(`Failed to build local Harbor image "${image}" (log: ${logPath}): ${result.stderr || result.stdout}`);
  }
}

export function createDockerBuildResourceArgs(dockerBuild: HarborRuntimeConfig["dockerBuild"]): string[] {
  const args = [
    "--network",
    dockerBuild?.network ?? DEFAULT_DOCKER_BUILD_NETWORK,
    "--memory",
    dockerBuild?.memory ?? DEFAULT_DOCKER_BUILD_MEMORY,
    "--memory-swap",
    dockerBuild?.memorySwap ?? DEFAULT_DOCKER_BUILD_MEMORY_SWAP,
    "--cpu-quota",
    String(dockerBuild?.cpuQuota ?? DEFAULT_DOCKER_BUILD_CPU_QUOTA),
    "--cpu-period",
    String(dockerBuild?.cpuPeriod ?? DEFAULT_DOCKER_BUILD_CPU_PERIOD),
  ];

  if (dockerBuild?.cpusetCpus != null) {
    args.push("--cpuset-cpus", dockerBuild.cpusetCpus);
  }
  if (dockerBuild?.shmSize != null) {
    args.push("--shm-size", dockerBuild.shmSize);
  }

  return args;
}

async function findHarborTaskRoots(taskDir: string): Promise<string[]> {
  const directTaskToml = join(taskDir, "task.toml");
  if (await pathExists(directTaskToml)) {
    return [taskDir];
  }

  const entries = await readdir(taskDir, { withFileTypes: true });
  const roots: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidateRoot = join(taskDir, entry.name);
    if (await pathExists(join(candidateRoot, "task.toml"))) {
      roots.push(candidateRoot);
    }
  }
  return roots;
}

async function readDockerImage(taskTomlPath: string): Promise<string | null> {
  const content = await readFile(taskTomlPath, "utf8");
  const match = /^docker_image\s*=\s*"([^"]+)"/m.exec(content);
  return match == null ? null : match[1];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

interface RawCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  logPath?: string;
}

function runCommand(
  command: string,
  args: string[],
  env: Record<string, string>,
  maxOutputBytes: number = DEFAULT_MAX_OUTPUT_BYTES,
  logPath?: string,
): Promise<RawCommandResult> {
  return new Promise((resolve, reject) => {
    const stdoutCapture = createBoundedOutputCapture(maxOutputBytes);
    const stderrCapture = createBoundedOutputCapture(maxOutputBytes);
    const log = logPath == null ? null : createWriteStream(logPath, { flags: "a" });
    let settled = false;
    log?.write(`[command] ${command} ${args.map(quoteCommandArg).join(" ")}\n\n`);

    const proc = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout?.on("data", (data: unknown) => {
      stdoutCapture.append(data);
      log?.write(data instanceof Buffer ? data : String(data));
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderrCapture.append(data);
      log?.write(data);
    });

    proc.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      log?.end(`\n[spawn-error] ${error.stack ?? error.message}\n`, () => reject(error));
      if (log == null) {
        reject(error);
      }
    });
    proc.on("exit", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      const result = {
        exitCode,
        stdout: stdoutCapture.toString(),
        stderr: stderrCapture.toString(),
        logPath,
      };
      if (log == null) {
        resolve(result);
        return;
      }
      log.end(`\n[exit] ${exitCode ?? "null"}\n`, () => resolve(result));
    });
  });
}

function sanitizePathComponent(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_");
}

function quoteCommandArg(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function createBoundedOutputCapture(maxBytes: number): {
  append(chunk: unknown): void;
  toString(): string;
} {
  let captured = "";
  let capturedBytes = 0;
  let truncated = false;
  const effectiveMaxBytes = Math.max(1, maxBytes);

  return {
    append(chunk: unknown): void {
      if (truncated) {
        return;
      }

      const text = chunk instanceof Buffer ? chunk.toString("utf8") : String(chunk);
      const bytes = Buffer.from(text, "utf8").length;
      if (capturedBytes + bytes <= effectiveMaxBytes) {
        captured += text;
        capturedBytes += bytes;
        return;
      }

      const remainingBytes = effectiveMaxBytes - capturedBytes;
      if (remainingBytes > 0) {
        captured += Buffer.from(text, "utf8").subarray(0, remainingBytes).toString("utf8");
      }
      captured += `\n[output truncated after ${effectiveMaxBytes} bytes]\n`;
      capturedBytes = effectiveMaxBytes;
      truncated = true;
    },
    toString(): string {
      return captured;
    },
  };
}
