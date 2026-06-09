import { spawn } from "child_process";
import { readdir, readFile, rm, stat, writeFile } from "fs/promises";
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
import { createControlledEnv } from "../runtime/env.js";
import { scrubHarborJobSensitiveFiles } from "../harbor/scrub.js";

const DEFAULT_MODEL = "gpt-5";
const DEFAULT_REASONING_EFFORT = "high";
const DEFAULT_AGENT_IMPORT_PATH = "harbor_ext.codex_custom:CodexCustom";
const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/";
const DEFAULT_TASKS_ROOT = "tasks";
const SINGLE_FILE_TRANSFORM_SKILL_NAME = "skill-for-skill-single-file";
const SINGLE_FILE_TRANSFORM_SKILL_SOURCE_DIR = resolve(
  "skill-for-skill",
  "transform-skills",
  SINGLE_FILE_TRANSFORM_SKILL_NAME,
);

export interface BaselineHarborOptions {
  taskRef: string;
  tasksRoot?: string;
  outDir?: string;
  configPath?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  harborAgentImportPath?: string;
  baseUrl?: string;
  proxyUrl?: string;
  dockerNetwork?: string;
  forceBuild?: boolean;
  npmRegistry?: string;
}

export interface BaselineHarborResult {
  taskId: string;
  rootDir: string;
  baselinePath: string;
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

export async function runBaselineHarborCommand(options: BaselineHarborOptions): Promise<BaselineHarborResult> {
  const harborConfig = await resolveDataPrepHarborConfig(options, {
    model: DEFAULT_MODEL,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    npmRegistry: DEFAULT_NPM_REGISTRY,
  });
  const bundle = await resolveTaskBundleFromOptions(options);
  const rootDir = resolve(options.outDir ?? "artifacts/skill-for-skill-single-file", bundle.taskId);
  const logsDir = join(rootDir, "logs");
  const baselinePath = join(rootDir, "baseline");
  const jobsDir = join(rootDir, "harbor-jobs");
  const taskRoot = join(rootDir, "harbor-task");
  const jobName = `single-file-${bundle.taskId}-${Date.now()}`;
  const harborAgentImportPath = options.harborAgentImportPath ?? harborConfig.agentImportPath ?? DEFAULT_AGENT_IMPORT_PATH;

  await rm(rootDir, { recursive: true, force: true });
  await ensureDir(logsDir);
  await ensureDir(jobsDir);

  try {
  const materialized = await materializeBaselineHarborTask({
    taskId: bundle.taskId,
    bundleDir: bundle.bundleDir,
    taskRoot,
    npmRegistry: harborConfig.npmRegistry,
    dockerNetwork: options.dockerNetwork,
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
    proxyUrl: options.proxyUrl,
    forceBuild: options.forceBuild ?? true,
  });
  const loggedCommand = redactHarborCommand(command);

  await writeJson(join(logsDir, "request.json"), {
    schemaVersion: "skill-for-skill-single-file-harbor-request/v1",
    generatedAt: new Date().toISOString(),
    taskRef: options.taskRef,
    configPath: options.configPath ?? "config.yaml",
    provider: options.provider ?? null,
    taskId: bundle.taskId,
    source: {
      skillRootCount: bundle.skills.length,
    },
    output: {
      root: relativeArtifactPath(rootDir, rootDir),
      variantRoot: relativeArtifactPath(rootDir, baselinePath),
    },
    model: harborConfig.model,
    reasoningEffort: harborConfig.reasoningEffort,
    npmRegistry: publicRegistryLabel(harborConfig.npmRegistry, DEFAULT_NPM_REGISTRY),
    harborAgentImportPath,
    proxyConfigured: resolveProxyUrl(options.proxyUrl) !== null,
    dockerNetworkConfigured: resolveDockerNetwork(options.dockerNetwork) !== null,
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
  const artifactTarPath = join(trialDir, "verifier", "baseline.tar.gz");
  const failedArtifactTarPath = join(trialDir, "verifier", "baseline.failed.tar.gz");
  const jobResultPath = join(jobDir, "result.json");
  await scrubHarborJobSensitiveFiles(jobDir);

  const reward = await readReward(rewardPath);
  if (commandResult.exitCode !== 0 || reward !== 1) {
    await writeJson(join(logsDir, "failure.json"), {
      schemaVersion: "skill-for-skill-single-file-harbor-failure/v1",
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
    throw new Error(`Harbor single-file conversion failed for ${bundle.taskId}; see ${logsDir}`);
  }

  await rm(baselinePath, { recursive: true, force: true });
  await ensureDir(baselinePath);
  await extractTarball(artifactTarPath, baselinePath);

  const manifestPath = join(rootDir, "manifest.json");
  const result: BaselineHarborResult = {
    taskId: bundle.taskId,
    rootDir,
    baselinePath,
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
    schemaVersion: "skill-for-skill-single-file-manifest/v1",
    taskId: bundle.taskId,
    generatedAt: new Date().toISOString(),
    source: {
      id: "source-bundle",
      kind: "bundle",
      skillIds: bundle.skills.map((entry) => entry.id),
    },
    variants: [
      {
        id: "single-file",
        kind: "skill",
        transform: "single-file-harbor-codex",
        from: "source-bundle",
        path: relativeArtifactPath(rootDir, baselinePath),
        outputSkills: [relativeArtifactPath(rootDir, baselinePath)],
      },
    ],
    harbor: {
      jobName,
      command: loggedCommand,
    },
  });
  await writeJson(join(logsDir, "run-summary.json"), {
    schemaVersion: "skill-for-skill-single-file-run-summary/v1",
    taskId: result.taskId,
    variantPath: relativeArtifactPath(rootDir, result.baselinePath),
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

async function resolveTaskBundleFromOptions(options: BaselineHarborOptions) {
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

async function materializeBaselineHarborTask(input: {
  taskId: string;
  bundleDir: string;
  taskRoot: string;
  npmRegistry: string;
  dockerNetwork?: string;
  preinstallCodex: boolean;
}): Promise<MaterializedTask> {
  const environmentDir = join(input.taskRoot, "environment");
  const workspaceDir = join(environmentDir, "workspace");
  const sourceSkillsRoot = join(workspaceDir, "source-skills");
  const toolsDir = join(workspaceDir, "tools");
  const transformSkillsRoot = join(environmentDir, "skills");
  const testsDir = join(input.taskRoot, "tests");
  const image = `skill-juror/single-file-${sanitizeId(input.taskId)}:local`;

  await ensureDir(sourceSkillsRoot);
  await ensureDir(toolsDir);
  await ensureDir(transformSkillsRoot);
  await ensureDir(testsDir);
  await copyDirectory(input.bundleDir, sourceSkillsRoot);
  await copyDirectory(
    SINGLE_FILE_TRANSFORM_SKILL_SOURCE_DIR,
    join(transformSkillsRoot, SINGLE_FILE_TRANSFORM_SKILL_NAME),
  );
  await writeFile(
    join(toolsDir, "behavior-unit-diff.mjs"),
    await readFile(resolve("scripts/behavior-unit-diff.mjs"), "utf8"),
  );
  await writeFile(
    join(toolsDir, "single-file-style-audit.mjs"),
    await readFile(resolve("scripts/single-file-style-audit.mjs"), "utf8"),
  );
  await writeFile(join(input.taskRoot, "task.toml"), renderTaskToml(input.taskId, image));
  await writeFile(join(input.taskRoot, "instruction.md"), renderBaselineInstruction(input.taskId));
  await writeFile(join(environmentDir, "setup.sh"), "#!/bin/bash\nset -euo pipefail\nmkdir -p /root/output/baseline\n");
  await writeFile(join(environmentDir, "Dockerfile"), renderBaselineDockerfile({
    npmRegistry: input.npmRegistry,
    preinstallCodex: input.preinstallCodex,
  }));
  const dockerNetwork = resolveDockerNetwork(input.dockerNetwork);
  if (dockerNetwork != null) {
    await writeFile(join(environmentDir, "docker-compose.yaml"), renderDockerComposeOverride(dockerNetwork));
  }
  await writeFile(join(testsDir, "test.sh"), renderVerifierShell());
  await writeFile(join(testsDir, "check.py"), renderVerifierPython());

  return {
    taskRoot: input.taskRoot,
    sourceSkillsRoot,
    image,
  };
}

export function renderBaselineInstruction(taskId: string): string {
  return [
    "You are constructing a Skill Juror single-file skill artifact.",
    "",
    `Task id: ${taskId}`,
    "Source skills directory: `/root/source-skills`",
    "Output single-file root: `/root/output/baseline`",
    `Transform skill: \`${SINGLE_FILE_TRANSFORM_SKILL_NAME}\``,
    "",
    `Before converting, use the \`${SINGLE_FILE_TRANSFORM_SKILL_NAME}\` skill. If it is not automatically loaded, read \`/skills/${SINGLE_FILE_TRANSFORM_SKILL_NAME}/SKILL.md\` and follow it as the authoritative transform procedure.`,
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
    `name = ${tomlString(`skill-juror/single-file-${taskId}`)}`,
    'description = "Skill Juror single-file construction"',
    "authors = []",
    "keywords = []",
    "",
    "[metadata]",
    `source_task = ${tomlString(taskId)}`,
    'transform = "single-file"',
    "",
    "[verifier]",
    "timeout_sec = 120",
    "",
    "[agent]",
    "timeout_sec = 2400",
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

export function renderBaselineDockerfile(input: {
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
    "RUN mkdir -p /logs/verifier /logs/agent /skills /root/output/baseline",
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
    "if command -v node >/dev/null 2>&1 && [ -f /root/tools/behavior-unit-diff.mjs ] && [ -d /root/source-skills ] && [ -d /root/output/baseline ]; then",
    "  mkdir -p /logs/verifier/behavior-diff",
    "  node /root/tools/behavior-unit-diff.mjs --source /root/source-skills --candidate /root/output/baseline --out /logs/verifier/behavior-diff --fail-on-risk >> /logs/verifier/acceptance.stdout.txt 2>> /logs/verifier/acceptance.stderr.txt",
    "  diff_status=$?",
    "  if [ \"$status\" -eq 0 ]; then",
    "    status=$diff_status",
    "  fi",
    "fi",
    "if command -v node >/dev/null 2>&1 && [ -f /root/tools/single-file-style-audit.mjs ] && [ -d /root/source-skills ] && [ -d /root/output/baseline ]; then",
    "  mkdir -p /logs/verifier/single-file-style",
    "  node /root/tools/single-file-style-audit.mjs --source /root/source-skills --root /root/output/baseline --out /logs/verifier/single-file-style --fail-on-risk >> /logs/verifier/acceptance.stdout.txt 2>> /logs/verifier/acceptance.stderr.txt",
    "  style_status=$?",
    "  if [ \"$status\" -eq 0 ]; then",
    "    status=$style_status",
    "  fi",
    "fi",
    "set -e",
    "if [ \"$status\" -eq 0 ]; then",
    "  tar -C /root/output/baseline -czf /logs/verifier/baseline.tar.gz .",
    "  printf '1\\n' > /logs/verifier/reward.txt",
    "else",
    "  if [ -d /root/output/baseline ]; then",
    "    tar -C /root/output/baseline -czf /logs/verifier/baseline.failed.tar.gz . || true",
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

root = Path("/root/output/baseline")
source = Path("/root/source-skills")
errors = []
fence_marker = chr(96) * 3

skill_path = root / "SKILL.md"
if not skill_path.is_file():
    errors.append("missing root SKILL.md")
if (root / "skills").exists():
    errors.append("single-file root must not contain nested skills/ directory")

extra_files = [
    path.relative_to(root)
    for path in root.rglob("*")
    if path.is_file() and path.name != "SKILL.md"
]
if extra_files:
    errors.append("single-file root must contain only SKILL.md; extra files: " + ", ".join(str(path) for path in extra_files[:20]))

source_helpers = [
    path.relative_to(source)
    for path in source.rglob("*")
    if path.is_file() and path.name != "SKILL.md"
]

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
    ".skill",
    ".sql",
    ".toml",
    ".ts",
    ".tsx",
    ".xml",
    ".xsd",
    ".yaml",
    ".yml",
}

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

def is_repository_support_doc(helper: Path) -> bool:
    return helper.name.lower() in {
        "readme.md",
        "installation.md",
        "testing.md",
        "changelog.md",
        "contributing.md",
        "license.md",
    }

def is_exact_text_helper(helper: Path, source_text: str) -> bool:
    if helper.suffix.lower() in exact_text_suffixes:
        return True
    return source_text.startswith("#!")

def source_command_lines(markdown: str) -> list[str]:
    commands = []
    tick = chr(96)
    script_path_pattern = r"(^|\s)(?:[A-Za-z0-9_.-]+/)*scripts/[A-Za-z0-9_./-]+(?:\.py|\.js|\.mjs|\.sh|\.ts|\.tsx|\.cjs)"
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

if skill_path.is_file():
    text = skill_path.read_text(encoding="utf-8", errors="replace")
    lower_text = text.lower()
    forbidden_patterns = [
        (r"(?im)^#{1,6}\s*archived support files?\s*:?\s*$", "archived support files heading"),
        (r"(?m)^(?:[-*]\s*)?(Encoding|Bytes|Byte count|Checksum|SHA-?256)\s*:", "bookkeeping metadata line"),
    ]
    for pattern, label in forbidden_patterns:
        if re.search(pattern, text):
            errors.append(f"construction metadata found in SKILL.md: {label}")
    for fragment in ["compatibility helper implementations", "baseline"]:
        if fragment in lower_text:
            errors.append(f"construction metadata found in SKILL.md: {fragment}")
    for skill_md in source.rglob("SKILL.md"):
        source_text = skill_md.read_text(encoding="utf-8", errors="replace")
        for command in source_command_lines(source_text):
            if command not in text:
                errors.append(f"missing source command in SKILL.md: {command}")
    for helper in source_helpers:
        source_file = source / helper
        raw = source_file.read_bytes()
        if is_ignored_support_file(helper, raw):
            continue
        helper_path = helper.as_posix()
        command_compatible_path = Path(*helper.parts[1:]).as_posix() if len(helper.parts) > 1 else helper_path
        if helper_path not in text and command_compatible_path not in text:
            errors.append(f"missing helper compatibility path in SKILL.md: {helper_path}")
        try:
            source_text = raw.decode("utf-8")
            stripped_source = source_text.strip()
            if not stripped_source:
                continue
            if stripped_source in text:
                continue
            if is_exact_text_helper(helper, source_text):
                errors.append(f"helper text content is not preserved verbatim: {helper.as_posix()}")
                continue

            important_lines = significant_markdown_lines(source_text)
            important_lines.extend(markdown_headings(source_text))
            if important_lines and not is_repository_support_doc(helper):
                covered = sum(1 for line in important_lines if line in text)
                if covered / len(important_lines) < 0.6:
                    errors.append(
                        f"markdown helper line coverage too low: {helper.as_posix()} ({covered}/{len(important_lines)})"
                    )
        except UnicodeDecodeError:
            encoded = base64.b64encode(raw).decode("ascii")
            if encoded not in text:
                errors.append(f"binary helper content is not preserved as base64: {helper.as_posix()}")

    source_script_paths = {
        helper.as_posix()
        for helper in source_helpers
        if not is_ignored_support_file(helper, (source / helper).read_bytes())
        and is_exact_text_helper(helper, (source / helper).read_text(encoding="utf-8", errors="replace"))
    }
    source_script_paths.update(
        Path(*helper.parts[1:]).as_posix()
        for helper in source_helpers
        if len(helper.parts) > 1
        and not is_ignored_support_file(helper, (source / helper).read_bytes())
        and is_exact_text_helper(helper, (source / helper).read_text(encoding="utf-8", errors="replace"))
    )
    script_path_pattern = r"(?<![#\]\(])((?:/?[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+(?:\.tsx|\.ts|\.mjs|\.cjs|\.js|\.py|\.sh)(?=$|[\s'\"\)\]\},;:]))"
    mentioned_script_paths = {
        match.group(1).strip(chr(96) + "'\"")
        for match in re.finditer(script_path_pattern, text)
    }
    source_skill_text = "\n".join(
        skill_md.read_text(encoding="utf-8", errors="replace")
        for skill_md in source.rglob("SKILL.md")
    )
    source_all_text_parts = [source_skill_text]
    for helper in source_helpers:
        try:
            source_all_text_parts.append((source / helper).read_text(encoding="utf-8", errors="replace"))
        except UnicodeDecodeError:
            pass
    source_all_text = "\n".join(source_all_text_parts)
    normalized_source_lines = {
        normalized_line(line)
        for line in source_all_text.splitlines()
        if line.strip()
    }
    for script_path in sorted(mentioned_script_paths):
        if script_path in source_script_paths or script_path in source_all_text:
            continue
        errors.append(f"invented helper script path not present in source: {script_path}")

    for line in text.splitlines():
        line_paths = [
            match.group(1).strip(chr(96) + "'\"")
            for match in re.finditer(script_path_pattern, line)
        ]
        if not line_paths:
            continue
        if normalized_line(line) in normalized_source_lines:
            continue
        lower_line = line.lower()
        describes_absence = any(
            marker in lower_line
            for marker in [
                "did not include implementation",
                "does not include implementation",
                "source did not include",
                "source does not include",
                "without providing invented implementation",
                "no implementation files",
                "not provide implementation code",
            ]
        )
        if describes_absence:
            continue
        is_implementation_context = (
            "helper implementation" in lower_line
            or "reference implementation" in lower_line
            or lower_line.startswith(("implementation for", "implementation:"))
            or (line.lstrip().startswith("#") and "implementation" in lower_line)
        )
        if not is_implementation_context:
            continue
        for script_path in line_paths:
            if script_path not in source_script_paths and Path(script_path).name not in {Path(path).name for path in source_script_paths}:
                errors.append(f"invented helper implementation for non-source script path: {script_path}")

    absolute_root_targets = [
        path.strip(chr(96) + "'\"")
        for path in re.findall(r"(/root/(?:\.[A-Za-z0-9_-]+/skills|skills)/[^\s'\"]+)", text)
        if path.strip(chr(96) + "'\"") not in source_all_text
    ]
    if absolute_root_targets:
        errors.append("absolute /root skill recreation path introduced without source command: " + absolute_root_targets[0])

if errors:
    raise SystemExit("\n".join(errors))

print(skill_path)
for helper in source_helpers:
    if is_ignored_support_file(helper, (source / helper).read_bytes()):
        continue
    print(f"embedded helper preserved: {helper.as_posix()}")
print("single-file verifier passed")
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
  proxyUrl?: string;
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
  const proxyUrl = resolveProxyUrl(input.proxyUrl);
  if (proxyUrl != null) {
    args.push("--ae", `SKILL_JUROR_CODEX_PROXY_URL=${proxyUrl}`);
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

function resolveProxyUrl(proxyUrl: string | undefined): string | null {
  const resolved = proxyUrl ?? process.env.SKILL_JUROR_HARBOR_CODEX_PROXY_URL;
  if (resolved == null || resolved.trim().length === 0) {
    return null;
  }
  return resolved.trim();
}

function resolveDockerNetwork(dockerNetwork: string | undefined): string | null {
  const resolved = dockerNetwork ?? process.env.SKILL_JUROR_HARBOR_DOCKER_NETWORK;
  if (resolved == null || resolved.trim().length === 0) {
    return null;
  }
  const normalized = resolved.trim();
  if (normalized !== "host") {
    throw new Error(`Unsupported Harbor Docker network mode: ${normalized}. Only "host" is supported.`);
  }
  return normalized;
}

function renderDockerComposeOverride(dockerNetwork: string): string {
  return [
    "services:",
    "  main:",
    `    network_mode: ${dockerNetwork}`,
    "",
  ].join("\n");
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
  const info = await stat(filePath);
  if (!info.isFile()) {
    throw new Error(`Expected file: ${filePath}`);
  }
}

function mergePythonPath(preferred: string, existing: string | undefined): string {
  if (existing == null || existing.length === 0) {
    return preferred;
  }
  return existing.split(":").includes(preferred) ? existing : `${preferred}:${existing}`;
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
