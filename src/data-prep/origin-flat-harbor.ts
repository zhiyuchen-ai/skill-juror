import { spawn } from "child_process";
import { readdir, readFile, rm, writeFile } from "fs/promises";
import { join, resolve } from "path";

import { resolveDataPrepHarborConfig } from "./harbor-config.js";
import { resolveTaskBundle } from "./source.js";
import {
  copyDirectory,
  ensureDir,
  pathExists,
  publicRegistryLabel,
  relativeArtifactPath,
  sanitizeId,
  writeJson,
} from "./utils.js";
import { scrubHarborJobSensitiveFiles } from "../harbor/scrub.js";
import { createControlledEnv } from "../runtime/env.js";

const DEFAULT_MODEL = "gpt-5";
const DEFAULT_REASONING_EFFORT = "high";
const DEFAULT_AGENT_IMPORT_PATH = "harbor_ext.codex_custom:CodexCustom";
const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/";
const DEFAULT_TASKS_ROOT = "tasks";
const FLATTEN_SOURCE_TRANSFORM_SKILL_NAME = "skill-for-skill-flatten-source";
const FLATTEN_SOURCE_TRANSFORM_SKILL_SOURCE_DIR = resolve(
  "skill-for-skill",
  "transform-skills",
  FLATTEN_SOURCE_TRANSFORM_SKILL_NAME,
);

export interface OriginFlatHarborOptions {
  taskRef: string;
  tasksRoot?: string;
  outDir?: string;
  configPath?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  harborAgentImportPath?: string;
  baseUrl?: string;
  forceBuild?: boolean;
  npmRegistry?: string;
}

export interface OriginFlatHarborResult {
  taskId: string;
  rootDir: string;
  originFlatPath: string;
  skillsPath: string;
  manifestPath: string;
  jobsDir: string;
  jobName: string;
  jobResultPath: string;
  trialResultPath: string;
  verifierStdoutPath: string;
  rewardPath: string;
  command: string[];
  reward: number | null;
  success: boolean;
}

interface MaterializedTask {
  taskRoot: string;
  sourceSkillsRoot: string;
  image: string;
}

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export async function runOriginFlatHarborCommand(options: OriginFlatHarborOptions): Promise<OriginFlatHarborResult> {
  const harborConfig = await resolveDataPrepHarborConfig(options, {
    model: DEFAULT_MODEL,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    npmRegistry: DEFAULT_NPM_REGISTRY,
  });
  const bundle = await resolveTaskBundleFromOptions(options);
  const rootDir = resolve(options.outDir ?? "artifacts/skill-for-skill-flatten-source", bundle.taskId);
  const logsDir = join(rootDir, "logs");
  const originFlatPath = join(rootDir, "origin-flat");
  const skillsPath = join(originFlatPath, "skills");
  const jobsDir = join(rootDir, "harbor-jobs");
  const taskRoot = join(rootDir, "harbor-task");
  const jobName = `flatten-source-${bundle.taskId}-${Date.now()}`;
  const harborAgentImportPath = options.harborAgentImportPath ?? harborConfig.agentImportPath ?? DEFAULT_AGENT_IMPORT_PATH;

  await rm(rootDir, { recursive: true, force: true });
  await ensureDir(logsDir);
  await ensureDir(jobsDir);

  try {
  const materialized = await materializeOriginFlatHarborTask({
    taskId: bundle.taskId,
    bundleDir: bundle.bundleDir,
    taskRoot,
    npmRegistry: harborConfig.npmRegistry,
    preinstallCodex: isCodexAgentImportPath(harborAgentImportPath),
  });

  const command = buildHarborCommand({
    taskRoot: materialized.taskRoot,
    jobsDir,
    jobName,
    model: harborConfig.model,
    reasoningEffort: harborConfig.reasoningEffort,
    harborAgentImportPath,
    baseUrl: harborConfig.baseUrl,
    agentEnv: harborConfig.agentEnv,
    forceBuild: options.forceBuild ?? true,
  });
  const loggedCommand = redactHarborCommand(command);

  await writeJson(join(logsDir, "request.json"), {
    schemaVersion: "skill-for-skill-flatten-source-harbor-request/v1",
    generatedAt: new Date().toISOString(),
    taskRef: options.taskRef,
    configPath: options.configPath ?? "config.yaml",
    provider: options.provider ?? null,
    taskId: bundle.taskId,
    source: {
      kind: "source-bundle",
      skillRootCount: bundle.skills.length,
      skillIds: bundle.skills.map((entry) => entry.id),
    },
    output: {
      root: relativeArtifactPath(rootDir, rootDir),
      variantRoot: relativeArtifactPath(rootDir, originFlatPath),
      skillsRoot: relativeArtifactPath(rootDir, skillsPath),
    },
    model: harborConfig.model,
    reasoningEffort: harborConfig.reasoningEffort,
    npmRegistry: publicRegistryLabel(harborConfig.npmRegistry, DEFAULT_NPM_REGISTRY),
    harborAgentImportPath,
    providerBaseUrlConfigured: harborConfig.baseUrl != null,
    forceBuild: options.forceBuild ?? true,
    command: loggedCommand,
  });

  const commandResult = await runCommand("harbor", command.slice(1), {
    PYTHONPATH: mergePythonPath(process.cwd(), process.env.PYTHONPATH),
    SKILL_JUROR_HARBOR_NPM_REGISTRY: harborConfig.npmRegistry,
    ...harborConfig.agentEnv,
  });
  await writeFile(join(logsDir, "harbor.stdout.txt"), commandResult.stdout);
  await writeFile(join(logsDir, "harbor.stderr.txt"), commandResult.stderr);

  const jobDir = join(jobsDir, jobName);
  const trialDir = await findSingleTrialDir(jobDir);
  const trialResultPath = join(trialDir, "result.json");
  const verifierStdoutPath = join(trialDir, "verifier", "acceptance.stdout.txt");
  const rewardPath = join(trialDir, "verifier", "reward.txt");
  const artifactTarPath = join(trialDir, "verifier", "origin-flat.tar.gz");
  const failedArtifactTarPath = join(trialDir, "verifier", "origin-flat.failed.tar.gz");
  const jobResultPath = join(jobDir, "result.json");
  await scrubHarborJobSensitiveFiles(jobDir);

  const reward = await readReward(rewardPath);
  if (commandResult.exitCode !== 0 || reward !== 1) {
    await writeJson(join(logsDir, "failure.json"), {
      schemaVersion: "skill-for-skill-flatten-source-harbor-failure/v1",
      generatedAt: new Date().toISOString(),
      taskId: bundle.taskId,
      exitCode: commandResult.exitCode,
      reward,
      artifacts: {
        jobResult: relativeArtifactPath(rootDir, jobResultPath),
        trialResult: relativeArtifactPath(rootDir, trialResultPath),
        verifierStdout: relativeArtifactPath(rootDir, verifierStdoutPath),
        verifierStderr: relativeArtifactPath(rootDir, join(trialDir, "verifier", "acceptance.stderr.txt")),
        reward: relativeArtifactPath(rootDir, rewardPath),
        failedArchive: relativeArtifactPath(rootDir, failedArtifactTarPath),
      },
      command: loggedCommand,
    });
    throw new Error(`Harbor flatten-source conversion failed for ${bundle.taskId}; see ${logsDir}`);
  }

  await rm(originFlatPath, { recursive: true, force: true });
  await ensureDir(originFlatPath);
  await extractTarball(artifactTarPath, originFlatPath);

  const manifestPath = join(rootDir, "manifest.json");
  const result: OriginFlatHarborResult = {
    taskId: bundle.taskId,
    rootDir,
    originFlatPath,
    skillsPath,
    manifestPath,
    jobsDir,
    jobName,
    jobResultPath,
    trialResultPath,
    verifierStdoutPath,
    rewardPath,
    command: loggedCommand,
    reward,
    success: true,
  };
  await writeJson(manifestPath, {
    schemaVersion: "skill-for-skill-flatten-source-manifest/v1",
    taskId: bundle.taskId,
    generatedAt: new Date().toISOString(),
    source: {
      id: "source-bundle",
      kind: "bundle",
      skillIds: bundle.skills.map((entry) => entry.id),
    },
    variants: [
      {
        id: "flatten-source",
        kind: "bundle",
        transform: "flatten-source-harbor-codex",
        from: "source-bundle",
        path: relativeArtifactPath(rootDir, originFlatPath),
        outputSkills: bundle.skills.map((entry) => relativeArtifactPath(rootDir, join(skillsPath, entry.id))),
      },
    ],
    harbor: {
      jobName,
      command: loggedCommand,
    },
  });
  await writeJson(join(logsDir, "run-summary.json"), {
    schemaVersion: "skill-for-skill-flatten-source-run-summary/v1",
    taskId: result.taskId,
    sourceVariant: "source-bundle",
    variantPath: relativeArtifactPath(rootDir, result.originFlatPath),
    skillsPath: relativeArtifactPath(rootDir, result.skillsPath),
    manifestPath: relativeArtifactPath(rootDir, result.manifestPath),
    reward: result.reward,
    success: result.success,
    command: result.command,
  });

  return result;
  } finally {
    await rm(taskRoot, { recursive: true, force: true });
    await rm(jobsDir, { recursive: true, force: true });
  }
}

async function resolveTaskBundleFromOptions(options: OriginFlatHarborOptions) {
  const direct = resolve(options.taskRef);
  if (await pathExists(direct)) {
    return resolveTaskBundle(direct);
  }

  const tasksRoot = resolve(options.tasksRoot ?? DEFAULT_TASKS_ROOT);
  const fromTasksRoot = join(tasksRoot, options.taskRef);
  if (await pathExists(fromTasksRoot)) {
    return resolveTaskBundle(fromTasksRoot);
  }

  return resolveTaskBundle(options.taskRef);
}

async function materializeOriginFlatHarborTask(input: {
  taskId: string;
  bundleDir: string;
  taskRoot: string;
  npmRegistry: string;
  preinstallCodex: boolean;
}): Promise<MaterializedTask> {
  const environmentDir = join(input.taskRoot, "environment");
  const workspaceDir = join(environmentDir, "workspace");
  const sourceSkillsRoot = join(workspaceDir, "source-skills");
  const toolsDir = join(workspaceDir, "tools");
  const transformSkillsRoot = join(environmentDir, "skills");
  const testsDir = join(input.taskRoot, "tests");
  const image = `skill-juror/flatten-source-${sanitizeId(input.taskId)}:local`;

  await ensureDir(sourceSkillsRoot);
  await ensureDir(toolsDir);
  await ensureDir(transformSkillsRoot);
  await ensureDir(testsDir);
  await copyDirectory(input.bundleDir, sourceSkillsRoot);
  await copyDirectory(
    FLATTEN_SOURCE_TRANSFORM_SKILL_SOURCE_DIR,
    join(transformSkillsRoot, FLATTEN_SOURCE_TRANSFORM_SKILL_NAME),
  );
  await writeFile(
    join(toolsDir, "behavior-unit-diff.mjs"),
    await readFile(resolve("scripts/behavior-unit-diff.mjs"), "utf8"),
  );
  await writeFile(join(input.taskRoot, "task.toml"), renderTaskToml(input.taskId, image));
  await writeFile(join(input.taskRoot, "instruction.md"), renderOriginFlatInstruction(input.taskId));
  await writeFile(join(environmentDir, "setup.sh"), "#!/bin/bash\nset -euo pipefail\nmkdir -p /root/output/origin-flat/skills\n");
  await writeFile(join(environmentDir, "Dockerfile"), renderOriginFlatDockerfile({
    npmRegistry: input.npmRegistry,
    preinstallCodex: input.preinstallCodex,
  }));
  await writeFile(join(testsDir, "test.sh"), renderVerifierShell());
  await writeFile(join(testsDir, "check.py"), renderVerifierPython());

  return {
    taskRoot: input.taskRoot,
    sourceSkillsRoot,
    image,
  };
}

export function renderOriginFlatInstruction(taskId: string): string {
  return [
    "You are constructing a Skill Juror flatten-source skill artifact.",
    "",
    `Task id: ${taskId}`,
    "Source skills directory: `/root/source-skills`",
    "Output flatten-source bundle root: `/root/output/origin-flat`",
    "Output skills directory: `/root/output/origin-flat/skills`",
    `Transform skill: \`${FLATTEN_SOURCE_TRANSFORM_SKILL_NAME}\``,
    "",
    `Before converting, use the \`${FLATTEN_SOURCE_TRANSFORM_SKILL_NAME}\` skill. If it is not automatically loaded, read \`/skills/${FLATTEN_SOURCE_TRANSFORM_SKILL_NAME}/SKILL.md\` and follow it as the authoritative transform procedure.`,
    "The caller-specific facts are only the task id and paths above. The stable conversion rules live in the transform skill.",
    "",
    "When finished, return exactly one short JSON object. The verifier checks the filesystem output.",
    "",
  ].join("\n");
}

function renderTaskToml(taskId: string, image: string): string {
  return [
    'schema_version = "1.1"',
    "",
    "[task]",
    `name = ${tomlString(`skill-juror/flatten-source-${taskId}`)}`,
    'description = "Skill Juror flatten-source construction"',
    "authors = []",
    "keywords = []",
    "",
    "[metadata]",
    `source_task = ${tomlString(taskId)}`,
    'transform = "flatten-source"',
    "",
    "[verifier]",
    "timeout_sec = 240",
    "",
    "[agent]",
    "timeout_sec = 1800",
    "",
    "[environment]",
    "build_timeout_sec = 1800.0",
    `docker_image = ${tomlString(image)}`,
    "cpus = 1",
    "memory_mb = 4096",
    "storage_mb = 10240",
    "gpus = 0",
    "allow_internet = true",
    "mcp_servers = []",
    'skills_dir = "/skills"',
    "",
    "[verifier.env]",
    "",
    "[environment.env]",
    "",
    "[solution.env]",
    "",
  ].join("\n");
}

export function renderOriginFlatDockerfile(input: {
  npmRegistry: string;
  preinstallCodex?: boolean;
}): string {
  const preinstallCodex = input.preinstallCodex !== false;
  const baseSetup = preinstallCodex
    ? [
      "FROM ubuntu:24.04",
      "",
      `ARG HARBOR_CODEX_NPM_REGISTRY=${input.npmRegistry}`,
      "ENV DEBIAN_FRONTEND=noninteractive",
      "ENV NPM_CONFIG_REGISTRY=${HARBOR_CODEX_NPM_REGISTRY}",
      "",
      "RUN apt-get update && apt-get install -y --no-install-recommends \\",
      "    bash ca-certificates curl git nodejs npm python3 ripgrep tar gzip && \\",
      "    rm -rf /var/lib/apt/lists/*",
      "",
      "RUN npm install -g @openai/codex@0.128.0 && codex --version",
      "",
    ]
    : [
      "FROM python:3.10-slim",
      "",
    ];
  return [
    ...baseSetup,
    "WORKDIR /root",
    "RUN mkdir -p /logs/verifier /logs/agent /skills /root/output/origin-flat/skills",
    "COPY workspace/ /root/",
    "COPY skills/ /skills/",
    "COPY setup.sh /tmp/skill-juror-setup.sh",
    "RUN bash /tmp/skill-juror-setup.sh && rm -f /tmp/skill-juror-setup.sh",
    "",
  ].join("\n");
}

function isCodexAgentImportPath(agentImportPath: string): boolean {
  return /codex/i.test(agentImportPath);
}

function renderVerifierShell(): string {
  return [
    "#!/bin/bash",
    "set -euo pipefail",
    "mkdir -p /logs/verifier",
    "set +e",
    "python3 /tests/check.py /root > /logs/verifier/acceptance.stdout.txt 2> /logs/verifier/acceptance.stderr.txt",
    "status=$?",
    "if command -v node >/dev/null 2>&1 && [ -f /root/tools/behavior-unit-diff.mjs ] && [ -d /root/source-skills ] && [ -d /root/output/origin-flat/skills ]; then",
    "  for source_skill in /root/source-skills/*; do",
    "    [ -d \"$source_skill\" ] || continue",
    "    [ -f \"$source_skill/SKILL.md\" ] || continue",
    "    skill_name=\"$(basename \"$source_skill\")\"",
    "    candidate_skill=\"/root/output/origin-flat/skills/$skill_name\"",
    "    mkdir -p \"/logs/verifier/behavior-diff/$skill_name\"",
    "    node /root/tools/behavior-unit-diff.mjs --source \"$source_skill\" --candidate \"$candidate_skill\" --out \"/logs/verifier/behavior-diff/$skill_name\" --fail-on-risk >> /logs/verifier/acceptance.stdout.txt 2>> /logs/verifier/acceptance.stderr.txt",
    "    diff_status=$?",
    "    if [ \"$status\" -eq 0 ]; then",
    "      status=$diff_status",
    "    fi",
    "  done",
    "fi",
    "set -e",
    "if [ \"$status\" -eq 0 ]; then",
    "  tar -C /root/output/origin-flat -czf /logs/verifier/origin-flat.tar.gz .",
    "  printf '1\\n' > /logs/verifier/reward.txt",
    "else",
    "  if [ -d /root/output/origin-flat ]; then",
    "    tar -C /root/output/origin-flat -czf /logs/verifier/origin-flat.failed.tar.gz . || true",
    "  fi",
    "  printf '0\\n' > /logs/verifier/reward.txt",
    "fi",
    "cat /logs/verifier/acceptance.stdout.txt || true",
    "cat /logs/verifier/acceptance.stderr.txt >&2 || true",
    "exit 0",
    "",
  ].join("\n");
}

function renderVerifierPython(): string {
  return String.raw`#!/usr/bin/env python3
import base64
import re
from pathlib import Path

workspace = Path("/root")
source = workspace / "source-skills"
root = workspace / "output" / "origin-flat" / "skills"
errors = []
fence_marker = chr(96) * 3

exact_text_suffixes = {
    ".bash",
    ".cjs",
    ".css",
    ".csv",
    ".html",
    ".js",
    ".json",
    ".jsx",
    ".mjs",
    ".py",
    ".r",
    ".rs",
    ".sh",
    ".sql",
    ".toml",
    ".ts",
    ".tsx",
    ".xml",
    ".yaml",
    ".yml",
}

def skill_dirs(base: Path) -> list[Path]:
    if not base.exists():
        return []
    return sorted(path for path in base.iterdir() if path.is_dir() and (path / "SKILL.md").is_file())

def list_files(base: Path) -> list[Path]:
    if not base.exists():
        return []
    return sorted(path for path in base.rglob("*") if path.is_file())

def fenced_blocks(markdown: str) -> list[str]:
    pattern = re.escape(fence_marker) + r"[^\n]*\n(.*?)\n" + re.escape(fence_marker)
    return [
        match.group(1).strip()
        for match in re.finditer(pattern, markdown, flags=re.DOTALL)
        if match.group(1).strip()
    ]

def markdown_headings(markdown: str) -> list[str]:
    return [
        line.lstrip("#").strip()
        for line in markdown.splitlines()
        if line.startswith("#") and line.lstrip("#").strip()
    ]

def significant_markdown_lines(markdown: str) -> list[str]:
    lines = []
    for line in markdown.splitlines():
        stripped = line.strip()
        if len(stripped) < 20:
            continue
        if stripped.startswith((fence_marker, "---")):
            continue
        if stripped.startswith(("#", "-", "*", "1.", "2.", "3.", "4.", "5.")):
            lines.append(stripped.lstrip("#-*0123456789. ").strip())
    return [line for line in lines if len(line) >= 20]

def normalized_line(line: str) -> str:
    return re.sub(r"\s+", " ", line.strip())

def is_ignored_support_file(helper: Path, raw: bytes) -> bool:
    name = helper.name.lower()
    if raw.strip() == b"":
        return True
    if name in {".gitkeep", ".gitignore", "license", "license.txt", "copying", "notice"}:
        return True
    if "license" in name and helper.suffix.lower() in {"", ".txt", ".license", ".md"}:
        return True
    return False

def is_exact_text_helper(helper: Path, source_text: str) -> bool:
    if helper.suffix.lower() in exact_text_suffixes:
        return True
    return source_text.startswith("#!")

def source_command_lines(markdown: str) -> list[str]:
    commands = []
    tick = chr(96)
    script_path_pattern = r"(^|\s)(?:[^\s'\"]+/)?scripts/[^\s'\"]+(?:\.py|\.js|\.mjs|\.sh|\.ts|\.tsx|\.cjs)"
    command_prefixes = (
        "python ",
        "python3 ",
        "node ",
        "npm ",
        "npx ",
        "bash ",
        "sh ",
        "uv run ",
    )
    for line in markdown.splitlines():
        stripped = line.strip()
        stripped = re.sub(r"^[-*]\s+", "", stripped)
        stripped = re.sub(r"^\d+\.\s+", "", stripped)
        if stripped.startswith(command_prefixes) or re.search(script_path_pattern, stripped):
            commands.append(stripped)
        for inline in re.findall(re.escape(tick) + r"([^" + re.escape(tick) + r"]+)" + re.escape(tick), line):
            inline_stripped = inline.strip()
            if inline_stripped.startswith(command_prefixes) or re.search(script_path_pattern, inline_stripped):
                commands.append(inline_stripped)
    seen = set()
    unique = []
    for command in commands:
        normalized = normalized_line(command)
        if normalized in seen:
            continue
        seen.add(normalized)
        unique.append(command)
    return unique

source_skills = skill_dirs(source)
output_skills = skill_dirs(root)
source_names = [path.name for path in source_skills]
output_names = [path.name for path in output_skills]
if source_names != output_names:
    errors.append(f"skill root names differ; expected {source_names}, got {output_names}")

for source_skill in source_skills:
    output_skill = root / source_skill.name
    output_skill_md = output_skill / "SKILL.md"
    if not output_skill_md.is_file():
        errors.append(f"missing output SKILL.md for {source_skill.name}")
        continue

    extra_files = [
        path.relative_to(output_skill).as_posix()
        for path in list_files(output_skill)
        if path.name != "SKILL.md"
    ]
    if extra_files:
        errors.append(f"{source_skill.name} must contain only SKILL.md; extra files: {', '.join(extra_files[:20])}")

    text = output_skill_md.read_text(encoding="utf-8", errors="replace")
    lower_text = text.lower()
    forbidden_patterns = [
        (r"(?im)^#{1,6}\s*archived support files?\s*:?\s*$", "archived support files heading"),
        (r"(?m)^\s*[-*]?\s*(Encoding|Bytes|Byte count|Checksum|SHA-?256)\s*:", "bookkeeping metadata line"),
    ]
    for pattern, label in forbidden_patterns:
        if re.search(pattern, text):
            errors.append(f"{source_skill.name}: construction metadata found in SKILL.md: {label}")
    forbidden_fragment_patterns = [
        (r"compatibility helper implementations", "compatibility helper implementations"),
        (r"(?<![a-z0-9_-])baseline(?![a-z0-9_-])", "baseline"),
        (r"(?<![a-z0-9_-])pd(?![a-z0-9_-])", "pd"),
    ]
    for pattern, label in forbidden_fragment_patterns:
        if re.search(pattern, lower_text):
            errors.append(f"{source_skill.name}: construction metadata found in SKILL.md: {label}")

    source_skill_text = (source_skill / "SKILL.md").read_text(encoding="utf-8", errors="replace")
    for command in source_command_lines(source_skill_text):
        if command not in text:
            errors.append(f"{source_skill.name}: missing source command in SKILL.md: {command}")

    source_helpers = [
        path.relative_to(source_skill)
        for path in list_files(source_skill)
        if path.name != "SKILL.md"
    ]
    for helper in source_helpers:
        source_file = source_skill / helper
        raw = source_file.read_bytes()
        if is_ignored_support_file(helper, raw):
            continue
        helper_path = helper.as_posix()
        bundle_relative_path = f"{source_skill.name}/{helper_path}"
        if helper_path not in text and bundle_relative_path not in text:
            errors.append(f"{source_skill.name}: missing helper compatibility path in SKILL.md: {helper_path}")
        try:
            source_text = raw.decode("utf-8")
            stripped_source = source_text.strip()
            if not stripped_source:
                continue
            if stripped_source in text:
                continue
            if is_exact_text_helper(helper, source_text):
                errors.append(f"{source_skill.name}: helper text content is not preserved verbatim: {helper_path}")
                continue

            missing_blocks = [
                block
                for block in fenced_blocks(source_text)
                if block not in text
            ]
            for block in missing_blocks[:5]:
                errors.append(f"{source_skill.name}: markdown helper fenced block is not preserved: {helper_path}")

            important_lines = significant_markdown_lines(source_text)
            important_lines.extend(markdown_headings(source_text))
            if important_lines:
                covered = sum(1 for line in important_lines if line in text)
                if covered / len(important_lines) < 0.6:
                    errors.append(
                        f"{source_skill.name}: markdown helper line coverage too low: {helper_path} ({covered}/{len(important_lines)})"
                    )
        except UnicodeDecodeError:
            encoded = base64.b64encode(raw).decode("ascii")
            if encoded not in text:
                errors.append(f"{source_skill.name}: binary helper content is not preserved as base64: {helper_path}")

if errors:
    raise SystemExit("\n".join(errors[:120]))

print(root)
print(f"flatten-source verifier passed: {len(source_skills)} skill roots")
`;
}

function buildHarborCommand(input: {
  taskRoot: string;
  jobsDir: string;
  jobName: string;
  model: string;
  reasoningEffort: string;
  harborAgentImportPath: string;
  baseUrl?: string;
  agentEnv?: Record<string, string>;
  forceBuild: boolean;
}): string[] {
  const args = [
    "harbor",
    "job",
    "start",
    "--path",
    input.taskRoot,
    "--agent-import-path",
    input.harborAgentImportPath,
    "--model",
    input.model,
    "--agent-kwarg",
    `reasoning_effort=${input.reasoningEffort}`,
    "--jobs-dir",
    input.jobsDir,
    "--job-name",
    input.jobName,
    "--n-concurrent",
    "1",
    "--yes",
    "--no-delete",
    "--agent-setup-timeout-multiplier",
    "5",
  ];
  if (input.forceBuild) {
    args.push("--force-build");
  }
  if (input.baseUrl != null && input.baseUrl.length > 0) {
    args.push("--ae", `CODEX_PROVIDER_BASE_URL=${input.baseUrl}`);
  }
  if (input.agentEnv != null) {
    for (const [key, value] of Object.entries(input.agentEnv)) {
      if (shouldPassAgentEnvInCommand(key)) {
        args.push("--ae", `${key}=${value}`);
      }
    }
  }
  return args;
}

function shouldPassAgentEnvInCommand(key: string): boolean {
  return ![
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "CODEX_PROVIDER_BASE_URL",
    "SKILL_JUROR_CODEX_PROXY_URL",
  ].includes(key);
}

function redactHarborCommand(command: string[]): string[] {
  return command.map((entry, index) => {
    const previous = command[index - 1];
    if (previous === "--path") {
      return "<harbor-task>";
    }
    if (previous === "--jobs-dir") {
      return "<harbor-jobs>";
    }
    if (previous === "--ae") {
      const separator = entry.indexOf("=");
      const key = separator < 0 ? entry : entry.slice(0, separator);
      if (isSensitiveAgentEnvKey(key)) {
        return `${key}=<redacted>`;
      }
    }
    return entry;
  });
}

function isSensitiveAgentEnvKey(key: string): boolean {
  return [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "CODEX_PROVIDER_BASE_URL",
    "SKILL_JUROR_CODEX_CONFIG_JSON",
    "SKILL_JUROR_CODEX_PROXY_URL",
  ].includes(key);
}

async function runCommand(command: string, args: string[], extraEnv: Record<string, string | undefined>): Promise<CommandResult> {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: createControlledEnv(extraEnv, { includeNetwork: true, includeTooling: true }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdout += text;
    process.stdout.write(text);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderr += text;
    process.stderr.write(text);
  });
  const exitCode = await new Promise<number | null>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise(code));
  });
  return { exitCode, stdout, stderr };
}

async function findSingleTrialDir(jobDir: string): Promise<string> {
  const entries = await readdir(jobDir, { withFileTypes: true });
  const trialDirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = join(jobDir, entry.name);
    if (await pathExists(join(candidate, "result.json"))) {
      trialDirs.push(candidate);
    }
  }
  if (trialDirs.length !== 1) {
    throw new Error(`Expected exactly one Harbor trial directory under ${jobDir}, found ${trialDirs.length}`);
  }
  return trialDirs[0];
}

async function readReward(rewardPath: string): Promise<number | null> {
  if (!await pathExists(rewardPath)) {
    return null;
  }
  const text = (await readFile(rewardPath, "utf8")).trim();
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

async function extractTarball(tarballPath: string, outputDir: string): Promise<void> {
  await assertFile(tarballPath);
  await runCommand("tar", ["-xzf", tarballPath, "-C", outputDir], {});
}

async function assertFile(filePath: string): Promise<void> {
  if (!await pathExists(filePath)) {
    throw new Error(`Required file not found: ${filePath}`);
  }
}

function mergePythonPath(left: string, right: string | undefined): string {
  return right == null || right.length === 0 ? left : `${left}:${right}`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
