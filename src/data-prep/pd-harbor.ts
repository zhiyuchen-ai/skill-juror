import { spawn } from "child_process";
import { cp, readdir, readFile, rm, writeFile } from "fs/promises";
import { basename, dirname, join, resolve } from "path";

import { resolveDataPrepHarborConfig } from "./harbor-config.js";
import {
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
const DEFAULT_BASELINE_RUN_ROOT = "artifacts/skill-for-skill-single-file";
const PROGRESSIVE_DISCLOSURE_TRANSFORM_SKILL_NAME = "skill-for-skill-progressive-disclosure";
const PROGRESSIVE_DISCLOSURE_TRANSFORM_SKILL_SOURCE_DIR = resolve(
  "skill-for-skill",
  "transform-skills",
  PROGRESSIVE_DISCLOSURE_TRANSFORM_SKILL_NAME,
);

export interface PdHarborOptions {
  taskRef?: string;
  baselineRoot?: string;
  baselineRunsRoot?: string;
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

export interface PdHarborResult {
  taskId: string;
  rootDir: string;
  baselinePath: string;
  pdPath: string;
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

interface ResolvedBaselineInput {
  taskId: string;
  baselinePath: string;
}

interface MaterializedPdTask {
  taskRoot: string;
  sourceBaselineRoot: string;
  image: string;
}

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export async function runPdHarborCommand(options: PdHarborOptions): Promise<PdHarborResult> {
  const harborConfig = await resolveDataPrepHarborConfig(options, {
    model: DEFAULT_MODEL,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    npmRegistry: DEFAULT_NPM_REGISTRY,
  });
  const input = await resolveBaselineInput(options);
  const rootDir = resolve(options.outDir ?? "artifacts/skill-for-skill-progressive-disclosure", input.taskId);
  const logsDir = join(rootDir, "logs");
  const pdPath = join(rootDir, "pd");
  const jobsDir = join(rootDir, "harbor-jobs");
  const taskRoot = join(rootDir, "harbor-task");
  const jobName = `progressive-disclosure-${input.taskId}-${Date.now()}`;
  const harborAgentImportPath = options.harborAgentImportPath ?? harborConfig.agentImportPath ?? DEFAULT_AGENT_IMPORT_PATH;

  await rm(rootDir, { recursive: true, force: true });
  await ensureDir(logsDir);
  await ensureDir(jobsDir);

  try {
  const materialized = await materializePdHarborTask({
    taskId: input.taskId,
    baselinePath: input.baselinePath,
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
    schemaVersion: "skill-for-skill-progressive-disclosure-harbor-request/v1",
    generatedAt: new Date().toISOString(),
    taskRef: options.taskRef ?? null,
    configPath: options.configPath ?? "config.yaml",
    provider: options.provider ?? null,
    taskId: input.taskId,
    source: {
      kind: "single-file",
      skillRootCount: 1,
    },
    output: {
      root: relativeArtifactPath(rootDir, rootDir),
      variantRoot: relativeArtifactPath(rootDir, pdPath),
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
  const artifactTarPath = join(trialDir, "verifier", "pd.tar.gz");
  const failedArtifactTarPath = join(trialDir, "verifier", "pd.failed.tar.gz");
  const jobResultPath = join(jobDir, "result.json");
  await scrubHarborJobSensitiveFiles(jobDir);

  const reward = await readReward(rewardPath);
  if (commandResult.exitCode !== 0 || reward !== 1) {
    await writeJson(join(logsDir, "failure.json"), {
      schemaVersion: "skill-for-skill-progressive-disclosure-harbor-failure/v1",
      generatedAt: new Date().toISOString(),
      taskId: input.taskId,
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
    throw new Error(`Harbor progressive-disclosure conversion failed for ${input.taskId}; see ${logsDir}`);
  }

  await rm(pdPath, { recursive: true, force: true });
  await ensureDir(pdPath);
  await extractTarball(artifactTarPath, pdPath);

  const manifestPath = join(rootDir, "manifest.json");
  const result: PdHarborResult = {
    taskId: input.taskId,
    rootDir,
    baselinePath: input.baselinePath,
    pdPath,
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
    schemaVersion: "skill-for-skill-progressive-disclosure-manifest/v1",
    taskId: input.taskId,
    generatedAt: new Date().toISOString(),
    source: {
      id: "single-file",
      kind: "skill",
      skillIds: [basename(input.baselinePath)],
    },
    variants: [
      {
        id: "progressive-disclosure",
        kind: "skill",
        transform: "progressive-disclosure-harbor-codex",
        from: "single-file",
        path: relativeArtifactPath(rootDir, pdPath),
        outputSkills: [relativeArtifactPath(rootDir, pdPath)],
      },
    ],
    harbor: {
      jobName,
      command: loggedCommand,
    },
  });
  await writeJson(join(logsDir, "run-summary.json"), {
    schemaVersion: "skill-for-skill-progressive-disclosure-run-summary/v1",
    taskId: result.taskId,
    sourceVariant: "single-file",
    variantPath: relativeArtifactPath(rootDir, result.pdPath),
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

async function resolveBaselineInput(options: PdHarborOptions): Promise<ResolvedBaselineInput> {
  if (options.baselineRoot != null) {
    const baselinePath = resolve(options.baselineRoot);
    await assertBaselineRoot(baselinePath);
    return {
      taskId: options.taskRef != null ? sanitizeId(options.taskRef) : inferTaskIdFromBaselinePath(baselinePath),
      baselinePath,
    };
  }

  if (options.taskRef == null) {
    throw new Error("progressive-disclosure requires --task <task-id> or --single-file-root <path>.");
  }

  const baselineRunsRoot = resolve(options.baselineRunsRoot ?? DEFAULT_BASELINE_RUN_ROOT);
  const baselinePath = join(baselineRunsRoot, options.taskRef, "baseline");
  await assertBaselineRoot(baselinePath);
  return {
    taskId: sanitizeId(options.taskRef),
    baselinePath,
  };
}

async function assertBaselineRoot(baselinePath: string): Promise<void> {
  if (!await pathExists(join(baselinePath, "SKILL.md"))) {
    throw new Error(`Single-file root must contain SKILL.md: ${baselinePath}`);
  }
}

function inferTaskIdFromBaselinePath(baselinePath: string): string {
  const last = basename(baselinePath);
  if (last === "baseline") {
    return sanitizeId(basename(dirname(baselinePath)));
  }
  return sanitizeId(last);
}

async function materializePdHarborTask(input: {
  taskId: string;
  baselinePath: string;
  taskRoot: string;
  npmRegistry: string;
  dockerNetwork?: string;
  preinstallCodex: boolean;
}): Promise<MaterializedPdTask> {
  const environmentDir = join(input.taskRoot, "environment");
  const workspaceDir = join(environmentDir, "workspace");
  const sourceSingleFileRoot = join(workspaceDir, "source-single-file");
  const toolsDir = join(workspaceDir, "tools");
  const transformSkillsRoot = join(environmentDir, "skills");
  const testsDir = join(input.taskRoot, "tests");
  const image = `skill-juror/progressive-disclosure-${sanitizeId(input.taskId)}:local`;

  await ensureDir(sourceSingleFileRoot);
  await ensureDir(toolsDir);
  await ensureDir(transformSkillsRoot);
  await ensureDir(testsDir);
  await cp(input.baselinePath, sourceSingleFileRoot, { recursive: true, force: true });
  await cp(PROGRESSIVE_DISCLOSURE_TRANSFORM_SKILL_SOURCE_DIR, join(transformSkillsRoot, PROGRESSIVE_DISCLOSURE_TRANSFORM_SKILL_NAME), {
    recursive: true,
    force: true,
  });
  await writeFile(
    join(toolsDir, "behavior-unit-diff.mjs"),
    await readFile(resolve("scripts/behavior-unit-diff.mjs"), "utf8"),
  );
  await writeFile(
    join(toolsDir, "pd-path-hygiene.mjs"),
    await readFile(resolve("scripts/pd-path-hygiene.mjs"), "utf8"),
  );
  await writeFile(join(input.taskRoot, "task.toml"), renderTaskToml(input.taskId, image));
  await writeFile(join(input.taskRoot, "instruction.md"), renderPdInstruction(input.taskId));
  await writeFile(join(environmentDir, "setup.sh"), "#!/bin/bash\nset -euo pipefail\nmkdir -p /root/output/pd\n");
  await writeFile(join(environmentDir, "Dockerfile"), renderPdDockerfile({
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
    sourceBaselineRoot: sourceSingleFileRoot,
    image,
  };
}

export function renderPdInstruction(taskId: string): string {
  return [
    "You are constructing a Skill Juror progressive-disclosure skill artifact from a single-file skill.",
    "",
    `Task id: ${taskId}`,
    "Source single-file directory: `/root/source-single-file`",
    "Output progressive-disclosure root: `/root/output/pd`",
    `Transform skill: \`${PROGRESSIVE_DISCLOSURE_TRANSFORM_SKILL_NAME}\``,
    "",
    `Before converting, use the \`${PROGRESSIVE_DISCLOSURE_TRANSFORM_SKILL_NAME}\` skill. If it is not automatically loaded, read \`/skills/${PROGRESSIVE_DISCLOSURE_TRANSFORM_SKILL_NAME}/SKILL.md\` and follow it as the authoritative transform procedure.`,
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
    `name = ${tomlString(`skill-juror/progressive-disclosure-${taskId}`)}`,
    'description = "Skill Juror progressive-disclosure construction"',
    "authors = []",
    "keywords = []",
    "",
    "[metadata]",
    `source_task = ${tomlString(taskId)}`,
    'transform = "progressive-disclosure"',
    "",
    "[verifier]",
    "timeout_sec = 180",
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

export function renderPdDockerfile(input: {
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
    "RUN mkdir -p /logs/verifier /logs/agent /skills /root/output/pd",
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
    "if command -v node >/dev/null 2>&1 && [ -f /root/tools/behavior-unit-diff.mjs ] && [ -d /root/source-single-file ] && [ -d /root/output/pd ]; then",
    "  mkdir -p /logs/verifier/behavior-diff",
    "  node /root/tools/behavior-unit-diff.mjs --source /root/source-single-file --candidate /root/output/pd --out /logs/verifier/behavior-diff --fail-on-risk >> /logs/verifier/acceptance.stdout.txt 2>> /logs/verifier/acceptance.stderr.txt",
    "  diff_status=$?",
    "  if [ \"$status\" -eq 0 ]; then",
    "    status=$diff_status",
    "  fi",
    "fi",
    "if command -v node >/dev/null 2>&1 && [ -f /root/tools/pd-path-hygiene.mjs ] && [ -d /root/output/pd ]; then",
    "  mkdir -p /logs/verifier/path-hygiene",
    "  node /root/tools/pd-path-hygiene.mjs --root /root/output/pd --out /logs/verifier/path-hygiene --fail-on-risk >> /logs/verifier/acceptance.stdout.txt 2>> /logs/verifier/acceptance.stderr.txt",
    "  hygiene_status=$?",
    "  if [ \"$status\" -eq 0 ]; then",
    "    status=$hygiene_status",
    "  fi",
    "fi",
    "set -e",
    "if [ \"$status\" -eq 0 ]; then",
    "  tar -C /root/output/pd -czf /logs/verifier/pd.tar.gz .",
    "  printf '1\\n' > /logs/verifier/reward.txt",
    "else",
    "  if [ -d /root/output/pd ]; then",
    "    tar -C /root/output/pd -czf /logs/verifier/pd.failed.tar.gz . || true",
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
import re
from pathlib import Path

workspace = Path("/root")
root = workspace / "output" / "pd"
source = workspace / "source-single-file"
errors = []
fence_marker = chr(96) * 3

skill_path = root / "SKILL.md"
source_skill_path = source / "SKILL.md"

metadata_names = {
    "notes.json",
    "manifest.json",
    "validation-errors.json",
    "bundle-summary.json",
    "report.json",
}

text_suffixes = {
    ".bash", ".cjs", ".css", ".csv", ".html", ".js", ".json", ".jsx",
    ".mjs", ".py", ".r", ".rs", ".sh", ".sql", ".toml", ".ts", ".tsx",
    ".xml", ".yaml", ".yml",
}

def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")

def normalize_line_endings(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n").strip()

def list_files(base: Path) -> list[Path]:
    if not base.exists():
        return []
    return sorted(path for path in base.rglob("*") if path.is_file())

def relative(path: Path, base: Path) -> str:
    return path.relative_to(base).as_posix()

def output_all_text() -> str:
    parts = []
    for path in list_files(root):
        try:
            parts.append(read_text(path))
        except UnicodeDecodeError:
            continue
    return "\n".join(parts)

def fenced_blocks(markdown: str) -> list[str]:
    pattern = re.escape(fence_marker) + r"[^\n]*\n(.*?)\n" + re.escape(fence_marker)
    return [
        match.group(1).strip()
        for match in re.finditer(pattern, markdown, flags=re.DOTALL)
        if match.group(1).strip()
    ]

def source_file_blocks(markdown: str) -> list[tuple[str, str]]:
    tick = chr(96)
    marker = (
        r"(?:Source file:|"
        r"Helper implementation for|"
        r"Helper contract from|"
        r"Reference content from|"
        r"Configuration content from|"
        r"Template content from|"
        r"Support content from)"
    )
    pattern = (
        r"(?m)^" + marker + r"\s+" + re.escape(tick) + r"([^" + re.escape(tick) + r"]+)" + re.escape(tick) + r"\s*\n+"
        + re.escape(fence_marker)
        + r"[^\n]*\n(.*?)\n"
        + re.escape(fence_marker)
    )
    return [
        (match.group(1), match.group(2).rstrip() + "\n")
        for match in re.finditer(pattern, markdown, flags=re.DOTALL)
        if match.group(1) and match.group(2).strip()
    ]

def is_exact_support_path(path_text: str) -> bool:
    lowered = path_text.lower()
    if lowered.endswith("/skill.md") or lowered == "skill.md":
        return False
    suffix = Path(path_text).suffix.lower()
    if suffix in text_suffixes:
        return True
    return path_text.startswith(("scripts/", "templates/", "bin/"))

def path_mentions(markdown: str) -> list[tuple[str, int, str]]:
    mentions = []
    pattern = r"(?<![A-Za-z0-9_.\-/])((?:references|scripts|templates|docs|bin)/[A-Za-z0-9._/\-]+)"
    lines = markdown.splitlines()
    for line_index, line in enumerate(lines, start=1):
        if line.lstrip().startswith("#!"):
            continue
        context = "\n".join(lines[max(0, line_index - 4):min(len(lines), line_index + 3)]).lower()
        if any(phrase in context for phrase in (
            "another skill",
            "separate skill",
            "separate scientific-schematics",
            "external skill",
            "external workflow",
            "not bundled",
            "not include",
            "did not include",
            "do not synthesize",
            "its own",
        )):
            continue
        for match in re.finditer(pattern, line):
            value = match.group(1).rstrip(".,;:)])}")
            if "*" in value or value.endswith("/"):
                continue
            name = Path(value).name.lower()
            if name in {"script_name.py", "your_script.py", "example.py"}:
                continue
            if any(part in {"PRs", "URLs"} for part in value.split("/")):
                continue
            mentions.append((value, line_index, line))
    return mentions

def path_candidate_exists(path: Path, mention: str) -> bool:
    if (root / mention).exists():
        return True
    if (path.parent / mention).exists():
        return True
    candidates = [mention]
    if Path(mention).suffix == "":
        candidates.extend([mention + suffix for suffix in text_suffixes])
    for candidate in candidates:
        if (path.parent / candidate).exists() or (root / candidate).exists():
            return True
        for existing in list_files(root):
            rel = relative(existing, root)
            if rel.endswith("/" + candidate) or rel == candidate:
                return True
    return False

if not source_skill_path.is_file():
    errors.append("missing source single-file SKILL.md")

if not skill_path.is_file():
    errors.append("missing root SKILL.md")
else:
    skill_text = read_text(skill_path)
    skill_lines = skill_text.splitlines()
    if len(skill_lines) > 220:
        errors.append(f"root SKILL.md is too long for PD entrypoint: {len(skill_lines)} lines > 220")
    if (root / "skills").exists():
        errors.append("progressive-disclosure root must not contain nested skills/ directory")
    if "references/" not in skill_text:
        errors.append("root SKILL.md must name references/ files with loading triggers")

    reference_files = [
        path
        for path in list_files(root / "references")
        if path.suffix.lower() in {".md", ".txt"}
    ]
    if not reference_files:
        errors.append("progressive-disclosure output must include at least one references/ markdown file")
    for path in list_files(root):
        rel = relative(path, root)
        if path.name in metadata_names:
            errors.append(f"metadata/check file must not be inside progressive-disclosure root: {rel}")
        if rel.startswith(("behavior-diff/", "logs/")):
            errors.append(f"check/log output must not be inside progressive-disclosure root: {rel}")

    combined_output = output_all_text()
    source_text = read_text(source_skill_path) if source_skill_path.is_file() else ""

    for source_path, content in source_file_blocks(source_text):
        normalized_content = normalize_line_endings(content)
        output_path = root / source_path
        output_content = ""
        if output_path.is_file():
            output_content = normalize_line_endings(read_text(output_path))
        if is_exact_support_path(source_path):
            if normalized_content not in normalize_line_endings(combined_output) and output_content != normalized_content:
                errors.append(f"source support content not preserved: {source_path}")

    for path in list_files(root):
        rel_path = relative(path, root)
        if path.suffix.lower() not in {".md", ".txt", ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".sh", ".bash", ".zsh", ".json", ".yaml", ".yml", ".toml"}:
            continue
        try:
            text = read_text(path)
        except UnicodeDecodeError:
            continue
        if rel_path != "SKILL.md":
            continue
        for mention, line_number, line in path_mentions(text):
            if "://" in line:
                continue
            if not path_candidate_exists(path, mention):
                errors.append(f"dangling local path in {relative(path, root)}:{line_number}: {mention}")

if errors:
    raise SystemExit("\n".join(errors[:80]))

print(skill_path)
print("progressive-disclosure structural verifier passed")
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
