import { spawn } from "child_process";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import { join, resolve } from "path";

import { readOptionalFile } from "./artifact-io.js";
import { fileExists, isFileAlreadyExistsError } from "./harbor-runtime-artifacts.js";
import { createDockerBuildResourceArgs } from "../harbor/harbor-runner.js";
import { createControlledEnv } from "../runtime/env.js";
import type { HarborRuntimeConfig } from "../types/config.js";

const DIRECT_HARBOR_CODEX_PREINSTALL_MARKER = "SKILL_JUROR_PREINSTALL_CODEX";
const DIRECT_HARBOR_CODEX_NPM_PACKAGE = "@openai/codex@0.128.0";
const DIRECT_HARBOR_CLAUDE_CODE_PREINSTALL_MARKER = "SKILL_JUROR_PREINSTALL_CLAUDE_CODE";
const DIRECT_HARBOR_CLAUDE_CODE_NPM_PACKAGE = "@anthropic-ai/claude-code@2.1.126";
const DIRECT_HARBOR_NODE_MANAGER_NPM_PACKAGE = "n@9.2.3";
const DIRECT_HARBOR_UV_INSTALLER_STABILIZATION_MARKER = "SKILL_JUROR_STABILIZE_UV_INSTALLER";
const DIRECT_HARBOR_VERIFIER_UV_PREINSTALL_MARKER = "SKILL_JUROR_PREINSTALL_VERIFIER_UV";
const DIRECT_HARBOR_VERIFIER_UV_VERSION = "0.9.7";
const DIRECT_HARBOR_VERIFIER_PLAYWRIGHT_PREINSTALL_MARKER = "SKILL_JUROR_PREINSTALL_VERIFIER_PLAYWRIGHT";
const DIRECT_HARBOR_PYTHON_ALIAS_MARKER = "SKILL_JUROR_PYTHON3_ALIAS";
const DIRECT_HARBOR_VERIFIER_PREINSTALL_MARKER_DIR = "/opt/skill-juror";
const DIRECT_HARBOR_VERIFIER_PLAYWRIGHT_PREINSTALL_MARKER_PATH = "/opt/skill-juror/verifier-playwright-preinstalled";
const DIRECT_HARBOR_DEFAULT_APT_MIRROR = "";
const DIRECT_HARBOR_DEFAULT_PIP_INDEX_URL = "https://pypi.org/simple/";
const DIRECT_HARBOR_DEFAULT_PIP_TRUSTED_HOST = "";
const DIRECT_HARBOR_PYTORCH_CPU_INDEX_URL = "https://download.pytorch.org/whl/cpu";
const DIRECT_HARBOR_DEFAULT_PIP_TIMEOUT_SEC = 60;
const DIRECT_HARBOR_DEFAULT_PIP_RETRIES = 10;
const DIRECT_HARBOR_DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/";
const DIRECT_HARBOR_DEFAULT_NODE_MIRROR = "https://nodejs.org/dist";
const DIRECT_HARBOR_CURL_FETCH_ARGS = "--connect-timeout 20 --retry 5 --retry-delay 2 --retry-connrefused --speed-limit 65536 --speed-time 60";
const DIRECT_HARBOR_WGET_FETCH_ARGS = "--tries=5 --timeout=30 --read-timeout=60";
const DIRECT_HARBOR_MIN_BUILD_TIMEOUT_SEC = 1800;
const DIRECT_HARBOR_DEFAULT_SKILLS_DIR = "/skills";
const DIRECT_HARBOR_RUNTIME_SKILLS_MOUNT_MARKER = "SKILL_JUROR_RUNTIME_SKILLS_MOUNT";
const DIRECT_HARBOR_AGENT_CACHE_LOCK_WAIT_MS = 20 * 60 * 1000;

export function slugifyHarborLabel(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "condition";
}

interface DirectHarborTaskTomlStabilizationOptions {
  taskId: string;
  condition: string;
  materializedTaskDir: string;
}

export interface DirectHarborTaskTomlStabilizationResult {
  dockerImage: string;
  skillsDir: string;
}

export async function stabilizeDirectHarborTaskToml(
  taskDir: string,
  options: DirectHarborTaskTomlStabilizationOptions,
): Promise<DirectHarborTaskTomlStabilizationResult> {
  const taskTomlPath = join(taskDir, "task.toml");
  const original = await readOptionalFile(taskTomlPath);
  if (original === null) {
    throw new Error(`Direct Harbor task is missing task.toml: ${taskTomlPath}`);
  }

  const dockerImage = await buildDirectHarborDockerImageName(options);
  let updated = original;
  updated = ensureValidDirectHarborTaskName(updated, options);
  if (/^docker_image\s*=\s*"[^"]*"$/m.test(updated)) {
    updated = updated.replace(/^docker_image\s*=\s*"[^"]*"$/m, `docker_image = "${dockerImage}"`);
  } else if (/^\[environment\]\s*$/m.test(updated)) {
    updated = updated.replace(/^\[environment\]\s*$/m, `[environment]\ndocker_image = "${dockerImage}"`);
  } else {
    updated = `${updated.trimEnd()}\n\n[environment]\ndocker_image = "${dockerImage}"\n`;
  }

  updated = ensureMinimumTomlNumber(updated, "build_timeout_sec", DIRECT_HARBOR_MIN_BUILD_TIMEOUT_SEC, "[environment]");
  const skillsDir = readTomlString(updated, "skills_dir", "[environment]") ?? DIRECT_HARBOR_DEFAULT_SKILLS_DIR;
  updated = ensureTomlString(updated, "skills_dir", skillsDir, "[environment]");

  if (updated !== original) {
    await writeFile(taskTomlPath, updated);
  }

  return {
    dockerImage,
    skillsDir,
  };
}

async function buildDirectHarborDockerImageName(options: DirectHarborTaskTomlStabilizationOptions): Promise<string> {
  const label = slugifyHarborLabel(options.taskId).replace(/[._]+/g, "-");
  const hash = await hashDirectHarborEnvironment(join(options.materializedTaskDir, "environment"));
  return `skill-juror/direct-env-${label}-${hash}:local`;
}

function ensureValidDirectHarborTaskName(
  toml: string,
  options: Pick<DirectHarborTaskTomlStabilizationOptions, "taskId" | "condition">,
): string {
  if (!/^\[task\]\s*$/m.test(toml)) {
    return toml;
  }

  const taskName = `skill-juror/${slugifyHarborLabel(`${options.taskId}-${options.condition}`)}`;
  const existing = readTomlString(toml, "name", "[task]");
  if (existing !== null && isValidHarborTaskName(existing)) {
    return toml;
  }

  return ensureTomlString(toml, "name", taskName, "[task]");
}

async function hashDirectHarborEnvironment(environmentDir: string): Promise<string> {
  let hash = 0x811c9dc5;
  const dockerfile = await readOptionalFile(join(environmentDir, "Dockerfile"));
  const includeRuntimeSkills = dockerfile == null ? false : hasActiveSkillCopyInstruction(dockerfile);
  const updateByte = (byte: number) => {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  const updateText = (value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      updateByte(value.charCodeAt(index) & 0xff);
    }
  };
  const updateBytes = (bytes: Uint8Array) => {
    for (const byte of bytes) {
      updateByte(byte);
    }
  };

  const visit = async (dir: string, relativeDir: string) => {
    const entries = (await readdir(dir, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = normalizeHashPath(relativeDir.length === 0 ? entry.name : `${relativeDir}/${entry.name}`);
      if (!includeRuntimeSkills && isDirectHarborRuntimeSkillsPath(relativePath)) {
        continue;
      }

      const absolutePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        updateText(`D\0${relativePath}\0`);
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        updateText(`F\0${relativePath}\0`);
        updateBytes(await readFile(absolutePath));
        updateText("\0");
      } else {
        const stats = await lstat(absolutePath);
        updateText(`${stats.isSymbolicLink() ? "L" : "O"}\0${relativePath}\0`);
      }
    }
  };

  await visit(environmentDir, "");
  return hash.toString(16).padStart(8, "0");
}

function normalizeHashPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function isDirectHarborRuntimeSkillsPath(relativePath: string): boolean {
  return relativePath === "skills" || relativePath.startsWith("skills/");
}

export function buildDirectHarborConditionConfig(
  baseConfig: HarborRuntimeConfig,
  materializedTaskDir: string,
  skillsDir: string,
): HarborRuntimeConfig {
  if (!skillsDir.startsWith("/")) {
    throw new Error(`Direct Harbor runtime skills_dir must be an absolute container path, got: ${skillsDir}`);
  }

  const skillMount = {
    type: "bind" as const,
    source: join(materializedTaskDir, "environment", "skills"),
    target: skillsDir,
    read_only: true as const,
    bind: { create_host_path: false },
  };
  const existingMounts = baseConfig.mountsJson ?? [];
  return {
    ...baseConfig,
    mountsJson: [
      ...existingMounts.filter((mount) => mount.target !== skillsDir),
      skillMount,
    ],
  };
}

function ensureMinimumTomlNumber(
  toml: string,
  key: string,
  minimumValue: number,
  sectionName: string,
): string {
  return updateTomlSection(toml, sectionName, (lines) => {
    const keyPattern = new RegExp(`^(\\s*)${escapeRegExp(key)}\\s*=\\s*([0-9]+(?:\\.[0-9]+)?)(\\s*(?:#.*)?)$`);
    const existingIndex = lines.findIndex((line) => keyPattern.test(line));
    if (existingIndex !== -1) {
      const line = lines[existingIndex] ?? "";
      const match = keyPattern.exec(line);
      const value = Number(match?.[2]);
      if (Number.isFinite(value) && value >= minimumValue) {
        return lines;
      }
      const indent = match?.[1] ?? "";
      const comment = match?.[3] ?? "";
      return replaceLine(lines, existingIndex, `${indent}${key} = ${minimumValue.toFixed(1)}${comment}`);
    }

    return [lines[0] ?? sectionName, `${key} = ${minimumValue.toFixed(1)}`, ...lines.slice(1)];
  });
}

function readTomlString(toml: string, key: string, sectionName: string): string | null {
  const lines = getTomlSectionLines(toml, sectionName);
  if (lines === null) {
    return null;
  }

  const stringPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]*)"\\s*(?:#.*)?$`);
  for (const line of lines.slice(1)) {
    const match = stringPattern.exec(line);
    if (match?.[1] != null) {
      return match[1];
    }
  }
  return null;
}

function ensureTomlString(toml: string, key: string, value: string, sectionName: string): string {
  return updateTomlSection(toml, sectionName, (lines) => {
    const stringPattern = new RegExp(`^(\\s*)${escapeRegExp(key)}\\s*=\\s*"[^"]*"(\\s*(?:#.*)?)$`);
    const existingIndex = lines.findIndex((line) => stringPattern.test(line));
    const rendered = `${key} = ${JSON.stringify(value)}`;
    if (existingIndex !== -1) {
      const match = stringPattern.exec(lines[existingIndex] ?? "");
      const indent = match?.[1] ?? "";
      const comment = match?.[2] ?? "";
      return replaceLine(lines, existingIndex, `${indent}${rendered}${comment}`);
    }

    return [lines[0] ?? sectionName, rendered, ...lines.slice(1)];
  });
}

function updateTomlSection(
  toml: string,
  sectionName: string,
  update: (sectionLines: string[]) => string[],
): string {
  const lines = toml.split(/\r?\n/);
  const range = findTomlSectionRange(lines, sectionName);
  if (range === null) {
    return `${toml.trimEnd()}\n\n${sectionName}\n${update([sectionName]).slice(1).join("\n")}\n`;
  }

  const nextLines = update(lines.slice(range.start, range.end));
  return [
    ...lines.slice(0, range.start),
    ...nextLines,
    ...lines.slice(range.end),
  ].join("\n");
}

function getTomlSectionLines(toml: string, sectionName: string): string[] | null {
  const lines = toml.split(/\r?\n/);
  const range = findTomlSectionRange(lines, sectionName);
  return range === null ? null : lines.slice(range.start, range.end);
}

function findTomlSectionRange(lines: string[], sectionName: string): { start: number; end: number } | null {
  const sectionPattern = new RegExp(`^\\s*${escapeRegExp(sectionName)}\\s*$`);
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (start === -1) {
      if (sectionPattern.test(line)) {
        start = index;
      }
      continue;
    }

    if (/^\s*\[[A-Za-z0-9_.-]+\]\s*$/.test(line)) {
      return { start, end: index };
    }
  }

  return start === -1 ? null : { start, end: lines.length };
}

function replaceLine(lines: string[], index: number, value: string): string[] {
  return [
    ...lines.slice(0, index),
    value,
    ...lines.slice(index + 1),
  ];
}

function isValidHarborTaskName(value: string): boolean {
  const parts = value.split("/");
  return parts.length === 2 && parts.every((part) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(part) && !part.includes(".."));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function configureDirectHarborDockerProxy(taskDir: string, proxyUrl: string): Promise<void> {
  if (/\s/.test(proxyUrl)) {
    throw new Error("SKILL_JUROR_HARBOR_RUNTIME_PROXY_URL must not contain whitespace.");
  }

  const dockerfilePath = join(taskDir, "environment", "Dockerfile");
  const original = await readFile(dockerfilePath, "utf8");
  if (!/^ARG LOCAL_PROXY_URL=.*$/m.test(original)) {
    return;
  }

  const mavenProxyArg = renderMavenProxyBuildArg(proxyUrl);
  const proxyArgLine = `ARG LOCAL_PROXY_URL=${proxyUrl}`;
  const replacementLines = [proxyArgLine];
  if (mavenProxyArg !== null) {
    replacementLines.push(mavenProxyArg);
  }
  let didInsertMavenProxyArg = false;
  let updated = original.replace(/^ARG LOCAL_PROXY_URL=.*$/gm, () => {
    if (didInsertMavenProxyArg || mavenProxyArg === null) {
      return proxyArgLine;
    }
    didInsertMavenProxyArg = true;
    return replacementLines.join("\n");
  });
  if (mavenProxyArg !== null) {
    updated = updated.replace(
      /\bmvn\s+dependency:resolve\b/g,
      "MAVEN_OPTS=\"${SKILL_JUROR_MAVEN_PROXY_OPTS}\" mvn dependency:resolve",
    );
  }
  await writeFile(dockerfilePath, updated);
}

function renderMavenProxyBuildArg(proxyUrl: string): string | null {
  const match = /^(?:https?:\/\/)?([^:/?#]+)(?::([0-9]+))?\/?$/.exec(proxyUrl);
  if (match == null) {
    return null;
  }

  const host = match[1];
  const port = match[2] ?? "80";
  const nonProxyHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    "172.17.0.1",
  ].join("|");
  return `ARG SKILL_JUROR_MAVEN_PROXY_OPTS="-Dhttp.proxyHost=${host} -Dhttp.proxyPort=${port} -Dhttps.proxyHost=${host} -Dhttps.proxyPort=${port} -Dhttp.nonProxyHosts=${nonProxyHosts}"`;
}

export async function repairPreFromDockerfileInstructions(taskDir: string): Promise<void> {
  const dockerfilePath = join(taskDir, "environment", "Dockerfile");
  const original = await readFile(dockerfilePath, "utf8");
  const lines = original.split(/\n/);
  const firstFromIndex = lines.findIndex((line) => /^\s*FROM\b/i.test(line));
  if (firstFromIndex <= 0) {
    return;
  }

  const preFromLines = lines.slice(0, firstFromIndex);
  const invalidPreFromLines = preFromLines.filter((line) => !isAllowedBeforeDockerFrom(line));
  if (invalidPreFromLines.length === 0) {
    return;
  }

  const preservedPreamble = preFromLines.filter((line) => isDockerCommentOrBlank(line) || /^\s*ARG\b/i.test(line));
  const stagePreamble = preFromLines
    .filter((line) => !isDockerParserDirective(line) && !isDockerCommentOrBlank(line))
    .join("\n")
    .trim();
  if (stagePreamble.length === 0) {
    return;
  }

  const remainder = lines.slice(firstFromIndex);
  const insertionIndex = findFirstStageSetupInsertionIndex(remainder);
  const nextLines = [
    ...trimTrailingBlankLines(preservedPreamble),
    ...remainder.slice(0, insertionIndex),
    "",
    "# SKILL_JUROR_REPAIRED_PRE_FROM_INSTRUCTIONS",
    stagePreamble,
    "",
    ...remainder.slice(insertionIndex),
  ];
  await writeFile(dockerfilePath, `${trimDockerfileBlankLines(nextLines).join("\n")}\n`);
}

export async function hardenDockerMirrorSetup(taskDir: string): Promise<void> {
  const dockerfilePath = join(taskDir, "environment", "Dockerfile");
  const original = await readFile(dockerfilePath, "utf8");
  const lines = original.split(/\n/);
  const updated: string[] = [];
  let index = 0;
  let changed = false;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!/^\s*RUN\s+find\s+\/etc\/apt\b/.test(line)) {
      updated.push(line);
      index += 1;
      continue;
    }

    const end = findDockerInstructionEnd(lines, index);
    const instruction = lines.slice(index, end).join("\n");
    if (instruction.includes("SKILL_JUROR_APT_MIRROR_GUARD") || !instruction.includes("/etc/pip")) {
      updated.push(...lines.slice(index, end));
      index = end;
      continue;
    }

    updated.push(...rewriteAptMirrorSetupInstruction(instruction).split("\n"));
    changed = true;
    index = end;
  }

  if (changed) {
    await writeFile(dockerfilePath, `${trimDockerfileBlankLines(updated).join("\n")}\n`);
  }
}

export async function stabilizeDirectHarborPackageMirrors(taskDir: string): Promise<void> {
  const dockerfilePath = join(taskDir, "environment", "Dockerfile");
  const original = await readFile(dockerfilePath, "utf8");
  const updated = original
    .replace(/^ARG LOCAL_PIP_INDEX_URL=(?!https:\/\/pypi\.org\/simple\/?\s*$).+$/gm, `ARG LOCAL_PIP_INDEX_URL=${DIRECT_HARBOR_DEFAULT_PIP_INDEX_URL}`)
    .replace(/^ARG LOCAL_PIP_TRUSTED_HOST=.+$/gm, `ARG LOCAL_PIP_TRUSTED_HOST=${DIRECT_HARBOR_DEFAULT_PIP_TRUSTED_HOST}`)
    .replace(
      /printf '\[global\]\\nindex-url = %s\\ntrusted-host = %s\\n(?:timeout = [0-9]+\\n)?(?:retries = [0-9]+\\n)?' "\$\{LOCAL_PIP_INDEX_URL\}" "\$\{LOCAL_PIP_TRUSTED_HOST\}"/g,
      renderDirectHarborPipConfigPrintf(),
    );
  if (updated !== original) {
    await writeFile(dockerfilePath, updated);
  }
}

function renderDirectHarborPipConfigPrintf(): string {
  return `if [ -n "\${LOCAL_PIP_TRUSTED_HOST:-}" ]; then printf '[global]\\nindex-url = %s\\ntrusted-host = %s\\ntimeout = ${DIRECT_HARBOR_DEFAULT_PIP_TIMEOUT_SEC}\\nretries = ${DIRECT_HARBOR_DEFAULT_PIP_RETRIES}\\n' "\${LOCAL_PIP_INDEX_URL}" "\${LOCAL_PIP_TRUSTED_HOST}"; else printf '[global]\\nindex-url = %s\\ntimeout = ${DIRECT_HARBOR_DEFAULT_PIP_TIMEOUT_SEC}\\nretries = ${DIRECT_HARBOR_DEFAULT_PIP_RETRIES}\\n' "\${LOCAL_PIP_INDEX_URL}"; fi`;
}

function rewriteAptMirrorSetupInstruction(instruction: string): string {
  const lines = instruction.split(/\n/);
  const firstLineMatch = /^(\s*)RUN\s+find\s+\/etc\/apt\b(.*)$/.exec(lines[0] ?? "");
  if (firstLineMatch == null) {
    return instruction;
  }

  const indent = firstLineMatch[1] ?? "";
  const firstLineRemainder = firstLineMatch[2] ?? "";
  const rewritten = [
    `${indent}RUN SKILL_JUROR_APT_MIRROR_GUARD=1; if [ -d /etc/apt ]; then \\`,
    `${indent}    find /etc/apt${firstLineRemainder}`,
    ...lines.slice(1),
  ];
  const pipSetupIndex = rewritten.findIndex((line) => /^\s*&&\s+mkdir\s+-p\s+\/etc\/pip\b/.test(line));
  if (pipSetupIndex > 0) {
    const previous = rewritten[pipSetupIndex - 1] ?? "";
    const terminatedPrevious = hasDockerLineContinuation(previous)
      ? previous.replace(/\\\s*$/, "|| true; \\")
      : `${previous.trimEnd()} || true; \\`;
    rewritten[pipSetupIndex - 1] = terminatedPrevious;
    rewritten[pipSetupIndex] = rewritten[pipSetupIndex].replace(/^\s*&&\s+/, `${indent}    (`);
    rewritten.splice(pipSetupIndex, 0, `${indent}fi; \\`);
    const lastIndex = rewritten.length - 1;
    rewritten[lastIndex] = `${rewritten[lastIndex]?.trimEnd() ?? ""}) || true`;
  }

  return rewritten.join("\n");
}

export async function stabilizeDirectHarborUvInstaller(taskDir: string): Promise<void> {
  const dockerfilePath = join(taskDir, "environment", "Dockerfile");
  const original = await readFile(dockerfilePath, "utf8");
  const updated = original.replace(
    /^RUN\s+curl\s+-LsSf\s+https:\/\/astral\.sh\/uv\/([0-9.]+)\/install\.sh\s*\|\s*sh\s*$/gm,
    (_line, version: string) => renderDirectHarborUvPipInstallDockerBlock(version),
  );
  if (updated !== original) {
    await writeFile(dockerfilePath, updated);
  }
}

export async function hardenDirectHarborDockerNetworkFetches(taskDir: string): Promise<void> {
  const dockerfilePath = join(taskDir, "environment", "Dockerfile");
  const original = await readFile(dockerfilePath, "utf8");
  const updated = original.split(/\n/).map(hardenDockerNetworkFetchLine).join("\n");
  if (updated !== original) {
    await writeFile(dockerfilePath, updated);
  }
}

export async function stabilizeKnownDirectHarborDockerfilePatterns(taskDir: string): Promise<void> {
  const dockerfilePath = join(taskDir, "environment", "Dockerfile");
  const original = await readFile(dockerfilePath, "utf8");
  let updated = original;
  updated = stabilizeTrivyAptRepositorySetup(updated);
  updated = stabilizeDeadsnakesAptRepositorySetup(updated);
  updated = stabilizeOpenaiWhisperLegacyBuild(updated);
  updated = stabilizeKokoroLegacyTorchTransformersBuild(updated);
  updated = await stabilizeDockerBuildHostDnsPins(updated);
  if (updated !== original) {
    await writeFile(dockerfilePath, updated);
  }
}

function stabilizeTrivyAptRepositorySetup(dockerfile: string): string {
  return dockerfile.replace(
    /RUN\s+wget(?:\s+[^\n\\]+)*\s+-qO\s+-\s+https:\/\/aquasecurity\.github\.io\/trivy-repo\/deb\/public\.key\s*\|\s*gpg\s+--dearmor\s+-o\s+\/usr\/share\/keyrings\/trivy\.gpg\s*&&\s*\\\n\s*echo\s+"deb\s+\[signed-by=\/usr\/share\/keyrings\/trivy\.gpg\]\s+https:\/\/aquasecurity\.github\.io\/trivy-repo\/deb\s+[^"]+\s+main"\s*\|\s*tee\s+-a\s+\/etc\/apt\/sources\.list\.d\/trivy\.list\s*&&\s*\\\n\s*apt-get\s+update\s*&&\s*\\\n\s*apt-get\s+install\s+-y\s+trivy\s*&&\s*\\\n\s*rm\s+-rf\s+\/var\/lib\/apt\/lists\/\*/g,
    renderStableTrivyAptRepositoryDockerInstruction(),
  );
}

function stabilizeDeadsnakesAptRepositorySetup(dockerfile: string): string {
  if (!dockerfile.includes("add-apt-repository ppa:deadsnakes/ppa -y")) {
    return dockerfile;
  }

  return dockerfile
    .replace(/\bsoftware-properties-common\s+curl\b/g, "software-properties-common ca-certificates curl gnupg")
    .replace(
      /&&\s*add-apt-repository\s+ppa:deadsnakes\/ppa\s+-y\s*\\/g,
      `&& curl ${DIRECT_HARBOR_CURL_FETCH_ARGS} -fsSL "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0xF23C5A6CF475977595C89F51BA6932366A755776" | gpg --dearmor -o /usr/share/keyrings/deadsnakes.gpg \\
    && . /etc/os-release \\
    && echo "deb [signed-by=/usr/share/keyrings/deadsnakes.gpg] https://ppa.launchpadcontent.net/deadsnakes/ppa/ubuntu \${VERSION_CODENAME:-noble} main" > /etc/apt/sources.list.d/deadsnakes-ppa.list \\`,
    );
}

function stabilizeOpenaiWhisperLegacyBuild(dockerfile: string): string {
  if (!dockerfile.includes("openai-whisper==20231117")) {
    return dockerfile;
  }

  return dockerfile
    .replace(
      /\bRUN\s+pip\s+install\s+--no-cache-dir\s+-U\s+pip\s+setuptools\s+wheel\b/g,
      "RUN pip install --no-cache-dir -U pip 'setuptools<81' wheel",
    )
    .replace(
      /\bRUN\s+pip\s+install\s+--no-cache-dir(\s+\\\n\s+speechbrain==1\.0\.3\s+\\\n\s+openai-whisper==20231117\b)/g,
      "RUN pip install --no-cache-dir --no-build-isolation$1",
    );
}

function stabilizeKokoroLegacyTorchTransformersBuild(dockerfile: string): string {
  if (
    !dockerfile.includes("kokoro==0.9.4")
    || !/\btorch==2\.2\.0(?:\+cpu)?\b/.test(dockerfile)
    || /\btransformers\s*(?:[<>=!~]|@)/.test(dockerfile)
  ) {
    return dockerfile;
  }

  return dockerfile.replace(
    /\bkokoro==0\.9\.4\b/g,
    "kokoro==0.9.4 \\\n    'transformers<5'",
  );
}

function renderStableTrivyAptRepositoryDockerInstruction(): string {
  return `RUN set -eux; \\
    curl ${DIRECT_HARBOR_CURL_FETCH_ARGS} -fsSL https://aquasecurity.github.io/trivy-repo/deb/public.key -o /tmp/trivy-public.key; \\
    grep -q "BEGIN PGP PUBLIC KEY" /tmp/trivy-public.key; \\
    rm -f /usr/share/keyrings/trivy.gpg; \\
    gpg --dearmor -o /usr/share/keyrings/trivy.gpg /tmp/trivy-public.key; \\
    . /etc/os-release; \\
    echo "deb [signed-by=/usr/share/keyrings/trivy.gpg] https://aquasecurity.github.io/trivy-repo/deb \${VERSION_CODENAME:-bookworm} main" > /etc/apt/sources.list.d/trivy.list; \\
    apt-get update; \\
    apt-get install -y trivy; \\
    rm -rf /var/lib/apt/lists/* /tmp/trivy-public.key`;
}

async function stabilizeDockerBuildHostDnsPins(dockerfile: string): Promise<string> {
  if (dockerfile.includes("SKILL_JUROR_HOST_DNS_PIN") || !/\bhuggingface(?:_hub|-hub|\.co)\b/i.test(dockerfile)) {
    return dockerfile;
  }

  const huggingFaceIp = await resolveHostIpv4ForDocker("huggingface.co");
  if (huggingFaceIp === null) {
    return dockerfile;
  }

  return insertHostDnsPinIntoDockerStage(dockerfile, "huggingface.co", huggingFaceIp);
}

async function resolveHostIpv4ForDocker(hostname: string): Promise<string | null> {
  const result = await runCommandQuiet("getent", ["ahostsv4", hostname], 64 * 1024);
  if (result.exitCode !== 0) {
    return null;
  }
  const match = /^([0-9]{1,3}(?:\.[0-9]{1,3}){3})\s+/m.exec(result.stdout);
  return match?.[1] ?? null;
}

function insertHostDnsPinIntoDockerStage(dockerfile: string, hostname: string, ipAddress: string): string {
  const lines = dockerfile.split(/\n/);
  const targetIndex = lines.findIndex((line) => line.toLowerCase().includes(hostname));
  if (targetIndex === -1) {
    return dockerfile;
  }

  const stageStart = findStageStartForLine(lines, targetIndex);
  if (stageStart === null) {
    return dockerfile;
  }
  const insertionIndex = stageStart + findFirstStageSetupInsertionIndex(lines.slice(stageStart));
  return insertDockerBlockAtLine(
    dockerfile,
    `# SKILL_JUROR_HOST_DNS_PIN
RUN printf '%s\\n' '${ipAddress} ${hostname}' >> /etc/hosts`,
    insertionIndex,
  );
}

function hardenDockerNetworkFetchLine(line: string): string {
  const withCurl = hardenDockerNetworkCommandLine(
    line,
    "curl",
    DIRECT_HARBOR_CURL_FETCH_ARGS,
    [
      /(?:^|\s+)--connect-timeout(?:=|\s+)\S+/g,
      /(?:^|\s+)--retry(?:=|\s+)\S+/g,
      /(?:^|\s+)--retry-delay(?:=|\s+)\S+/g,
      /(?:^|\s+)--retry-connrefused\b/g,
      /(?:^|\s+)--speed-limit(?:=|\s+)\S+/g,
      /(?:^|\s+)--speed-time(?:=|\s+)\S+/g,
    ],
  );
  return hardenDockerNetworkCommandLine(
    withCurl,
    "wget",
    DIRECT_HARBOR_WGET_FETCH_ARGS,
    [
      /(?:^|\s+)--tries(?:=|\s+)\S+/g,
      /(?:^|\s+)--timeout(?:=|\s+)\S+/g,
      /(?:^|\s+)--read-timeout(?:=|\s+)\S+/g,
    ],
  );
}

function hardenDockerNetworkCommandLine(
  line: string,
  commandName: "curl" | "wget",
  fetchArgs: string,
  staleArgPatterns: RegExp[],
): string {
  const commandPattern = new RegExp(`(^\\s*RUN\\s+|&&\\s+)${commandName}\\s+`, "g");
  let result = "";
  let index = 0;
  while (index < line.length) {
    commandPattern.lastIndex = index;
    const match = commandPattern.exec(line);
    if (match === null) {
      result += line.slice(index);
      break;
    }

    const commandPrefix = match[1] ?? "";
    const argsStart = commandPattern.lastIndex;
    const argsEnd = findDockerShellCommandSegmentEnd(line, argsStart);
    const originalArgs = line.slice(argsStart, argsEnd);
    const normalizedArgs = stripDockerFetchArgs(originalArgs, staleArgPatterns);
    result += line.slice(index, match.index);
    result += `${commandPrefix}${commandName} ${fetchArgs}`;
    if (normalizedArgs.length > 0) {
      result += ` ${normalizedArgs}`;
    }
    index = argsEnd;
  }
  return result;
}

function stripDockerFetchArgs(args: string, staleArgPatterns: RegExp[]): string {
  let stripped = args;
  for (const pattern of staleArgPatterns) {
    stripped = stripped.replace(pattern, "");
  }
  return stripped.trim().replace(/\s{2,}/g, " ");
}

function findDockerShellCommandSegmentEnd(line: string, startIndex: number): number {
  let quote: "\"" | "'" | null = null;
  for (let index = startIndex; index < line.length; index += 1) {
    const character = line[index];
    if (quote !== null) {
      if (character === "\\" && quote === "\"") {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === "\\" || character === ";" || character === "|") {
      return index;
    }
    if (character === "&" && line[index + 1] === "&") {
      return index;
    }
  }
  return line.length;
}

function isAllowedBeforeDockerFrom(line: string): boolean {
  return isDockerCommentOrBlank(line) || isDockerParserDirective(line) || /^\s*ARG\b/i.test(line);
}

function isDockerCommentOrBlank(line: string): boolean {
  return /^\s*(?:#.*)?$/.test(line);
}

function isDockerParserDirective(line: string): boolean {
  return /^\s*#\s*(?:syntax|escape|check)\s*=/i.test(line);
}

function findFirstStageSetupInsertionIndex(linesStartingAtFrom: string[]): number {
  let index = 1;
  while (index < linesStartingAtFrom.length && /^\s*(?:ARG\b|#|$)/i.test(linesStartingAtFrom[index] ?? "")) {
    index += 1;
  }
  if (/^\s*USER\s+root\s*$/i.test(linesStartingAtFrom[index] ?? "")) {
    index += 1;
  }
  return index;
}

export async function preinstallCodexInHarborDockerfile(taskDir: string): Promise<void> {
  const dockerfilePath = join(taskDir, "environment", "Dockerfile");
  const original = await readFile(dockerfilePath, "utf8");
  if (original.includes(DIRECT_HARBOR_CODEX_PREINSTALL_MARKER) || original.includes("SKILL_JUROR_PREINSTALL_AGENTS")) {
    return;
  }

  const block = renderDirectHarborCodexPreinstallDockerBlock();
  await writeFile(dockerfilePath, insertDockerBlockAtLine(original, block, findAgentPreinstallInsertionLine(original)));
}

export async function preinstallClaudeCodeInHarborDockerfile(taskDir: string): Promise<void> {
  const dockerfilePath = join(taskDir, "environment", "Dockerfile");
  const original = await readFile(dockerfilePath, "utf8");
  if (original.includes(DIRECT_HARBOR_CLAUDE_CODE_PREINSTALL_MARKER) || original.includes("SKILL_JUROR_PREINSTALL_AGENTS")) {
    return;
  }

  const block = renderDirectHarborClaudeCodePreinstallDockerBlock();
  await writeFile(dockerfilePath, insertDockerBlockAtLine(original, block, findAgentPreinstallInsertionLine(original)));
}

export async function stripDirectHarborSkillCopyDockerfileLayers(taskDir: string): Promise<void> {
  const dockerfilePath = join(taskDir, "environment", "Dockerfile");
  const original = await readFile(dockerfilePath, "utf8");
  const lines = original.split(/\n/);
  const firstCopyIndex = lines.findIndex((line) => parseRuntimeSkillCopyInstruction(line) !== null);
  if (firstCopyIndex === -1) {
    return;
  }
  if (hasSkillCopyDependentInstruction(lines.slice(firstCopyIndex + 1))) {
    return;
  }

  let changed = false;
  const updated: string[] = [];

  for (const line of lines) {
    const copy = parseRuntimeSkillCopyInstruction(line);
    if (copy === null) {
      updated.push(line);
      continue;
    }

    changed = true;
    updated.push(`# ${DIRECT_HARBOR_RUNTIME_SKILLS_MOUNT_MARKER}: ${line.trim()}`);
    for (const destination of copy.destinations) {
      updated.push(`RUN mkdir -p ${quoteShellArg(destination)}`);
    }
  }

  if (changed) {
    await writeFile(dockerfilePath, `${trimDockerfileBlankLines(updated).join("\n")}\n`);
  }
}

interface RuntimeSkillCopyInstruction {
  destinations: string[];
}

function parseRuntimeSkillCopyInstruction(line: string): RuntimeSkillCopyInstruction | null {
  const trimmed = line.trim();
  if (!/^COPY\s+/i.test(trimmed)) {
    return null;
  }

  const jsonCopy = parseJsonDockerCopyInstruction(trimmed);
  if (jsonCopy !== null) {
    return jsonCopy;
  }

  const tokens = splitDockerInstructionTokens(trimmed);
  if (tokens.length < 3 || tokens[0]?.toUpperCase() !== "COPY") {
    return null;
  }
  if (tokens.some((token) => /^--from(?:=|$)/i.test(token))) {
    return null;
  }

  const operands = tokens.slice(1).filter((token) => !token.startsWith("--"));
  if (operands.length < 2) {
    return null;
  }
  const sources = operands.slice(0, -1);
  if (!sources.some((source) => isRuntimeSkillCopySource(source))) {
    return null;
  }

  const destination = normalizeDockerCopyDestination(operands[operands.length - 1] ?? "");
  return destination === null || !isRuntimeSkillCopyDestination(destination) ? null : { destinations: [destination] };
}

function parseJsonDockerCopyInstruction(trimmedLine: string): RuntimeSkillCopyInstruction | null {
  const jsonStart = trimmedLine.indexOf("[");
  if (jsonStart === -1) {
    return null;
  }
  const beforeJson = trimmedLine.slice(0, jsonStart);
  if (!/^COPY\s+(?:--(?!from=)[^\s]+\s+)*$/i.test(beforeJson)) {
    return null;
  }

  try {
    const values = JSON.parse(trimmedLine.slice(jsonStart)) as unknown;
    if (!Array.isArray(values) || values.length < 2 || !values.every((value) => typeof value === "string")) {
      return null;
    }
    const stringValues = values as string[];
    const sources = stringValues.slice(0, -1);
    if (!sources.some((source) => isRuntimeSkillCopySource(source))) {
      return null;
    }
    const destination = normalizeDockerCopyDestination(stringValues[stringValues.length - 1] ?? "");
    return destination === null || !isRuntimeSkillCopyDestination(destination) ? null : { destinations: [destination] };
  } catch {
    return null;
  }
}

function splitDockerInstructionTokens(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function isRuntimeSkillCopySource(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/g, "");
  return normalized === "skills" || normalized.startsWith("skills/");
}

function normalizeDockerCopyDestination(value: string): string | null {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/g, "");
  return normalized.startsWith("/") ? normalized : null;
}

function isRuntimeSkillCopyDestination(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/g, "");
  return /\/\.[A-Za-z0-9_-]+\/skills(?:\/|$)/i.test(normalized)
    || /\/\.opencode\/skill(?:\/|$)/i.test(normalized)
    || /\/root\/skills(?:\/|$)/i.test(normalized)
    || /^\/skills(?:\/|$)/i.test(normalized);
}

function hasActiveSkillCopyInstruction(dockerfile: string): boolean {
  return dockerfile.split(/\n/).some((line) => {
    if (/^\s*#/.test(line)) {
      return false;
    }
    return parseAnySkillCopyInstruction(line) !== null;
  });
}

function parseAnySkillCopyInstruction(line: string): RuntimeSkillCopyInstruction | null {
  const trimmed = line.trim();
  if (!/^COPY\s+/i.test(trimmed)) {
    return null;
  }

  const jsonStart = trimmed.indexOf("[");
  if (jsonStart !== -1) {
    const beforeJson = trimmed.slice(0, jsonStart);
    if (!/^COPY\s+(?:--(?!from=)[^\s]+\s+)*$/i.test(beforeJson)) {
      return null;
    }
    try {
      const values = JSON.parse(trimmed.slice(jsonStart)) as unknown;
      if (!Array.isArray(values) || values.length < 2 || !values.every((value) => typeof value === "string")) {
        return null;
      }
      return values.slice(0, -1).some((source) => isRuntimeSkillCopySource(String(source))) ? { destinations: [] } : null;
    } catch {
      return null;
    }
  }

  const tokens = splitDockerInstructionTokens(trimmed);
  if (tokens.length < 3 || tokens[0]?.toUpperCase() !== "COPY") {
    return null;
  }
  if (tokens.some((token) => /^--from(?:=|$)/i.test(token))) {
    return null;
  }

  const operands = tokens.slice(1).filter((token) => !token.startsWith("--"));
  if (operands.length < 2) {
    return null;
  }
  return operands.slice(0, -1).some((source) => isRuntimeSkillCopySource(source)) ? { destinations: [] } : null;
}

async function optimizeSkillCopyDockerfileLayers(taskDir: string): Promise<void> {
  const dockerfilePath = join(taskDir, "environment", "Dockerfile");
  const original = await readFile(dockerfilePath, "utf8");
  const lines = original.split(/\n/);
  const copyIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => isStandardAgentSkillCopyInstruction(line))
    .map(({ index }) => index);
  if (copyIndexes.length === 0) {
    return;
  }

  const firstCopyIndex = Math.min(...copyIndexes);
  const lastCopyIndex = Math.max(...copyIndexes);
  const copyRange = lines.slice(firstCopyIndex, lastCopyIndex + 1);
  if (!copyRange.every((line) => isStandardAgentSkillCopyInstruction(line) || /^\s*(?:#.*)?$/.test(line))) {
    return;
  }

  const copyBlockStart = includeAdjacentSkillCopyComment(lines, firstCopyIndex);
  const copyBlockEnd = includeTrailingBlankLines(lines, lastCopyIndex + 1);
  if (hasSkillCopyDependentInstruction(lines.slice(copyBlockEnd))) {
    return;
  }

  const copyBlock = lines.slice(copyBlockStart, copyBlockEnd);
  const remaining = [...lines.slice(0, copyBlockStart), ...lines.slice(copyBlockEnd)];
  const insertionIndex = findLateSkillCopyInsertionIndex(remaining);
  if (insertionIndex <= copyBlockStart) {
    return;
  }
  if (isInsideDockerLineContinuation(remaining, insertionIndex)) {
    return;
  }

  const updated = [
    ...remaining.slice(0, insertionIndex),
    "",
    ...trimDockerfileBlankLines(copyBlock),
    "",
    ...remaining.slice(insertionIndex),
  ];
  const serialized = `${trimDockerfileBlankLines(updated).join("\n")}\n`;
  if (serialized !== original) {
    await writeFile(dockerfilePath, serialized);
  }
}

function isStandardAgentSkillCopyInstruction(line: string): boolean {
  if (!/^\s*COPY\s+skills\/?\s+/i.test(line)) {
    return false;
  }
  return /\/\.[A-Za-z0-9_-]+\/|\/root\/skills\b|\/home\/[^/\s]+\/\.[A-Za-z0-9_-]+\//i.test(line);
}

function includeAdjacentSkillCopyComment(lines: string[], firstCopyIndex: number): number {
  let index = firstCopyIndex;
  while (index > 0) {
    const previous = lines[index - 1];
    if (previous == null) {
      break;
    }
    if (/^\s*$/.test(previous)) {
      index -= 1;
      continue;
    }
    if (/^\s*#.*skills?/i.test(previous)) {
      index -= 1;
      continue;
    }
    break;
  }
  return index;
}

function includeTrailingBlankLines(lines: string[], endIndex: number): number {
  let index = endIndex;
  while (index < lines.length && /^\s*$/.test(lines[index] ?? "")) {
    index += 1;
  }
  return index;
}

function hasSkillCopyDependentInstruction(lines: string[]): boolean {
  return lines.some((line) => {
    if (/^\s*(?:#|$)/.test(line)) {
      return false;
    }
    if (/^\s*COPY\s+skills\/?\s+/i.test(line)) {
      return false;
    }
    return /\b(?:cd|chmod|chown|find|ln|mv|cp|rm|npm|pip|python|node|test)\b.*(?:\/skills\b|\/root\/skills\b|\/root\/verifier-skills\b|\.[A-Za-z0-9_-]+\/skills|\.opencode\/skill)/i.test(line);
  });
}

function isInsideDockerLineContinuation(lines: string[], insertionIndex: number): boolean {
  let index = insertionIndex - 1;
  while (index >= 0 && /^\s*$/.test(lines[index] ?? "")) {
    index -= 1;
  }
  return index >= 0 && hasDockerLineContinuation(lines[index] ?? "");
}

export async function prewarmDirectHarborAgentDockerCache(
  taskDir: string,
  dockerBuild: HarborRuntimeConfig["dockerBuild"] = undefined,
): Promise<void> {
  if (process.env.SKILL_JUROR_DISABLE_HARBOR_AGENT_CACHE_PREWARM === "1") {
    return;
  }

  const dockerfilePath = join(taskDir, "environment", "Dockerfile");
  const dockerfile = await readFile(dockerfilePath, "utf8");
  const seedDockerfile = buildDirectHarborAgentCacheSeedDockerfile(dockerfile);
  if (seedDockerfile === null) {
    return;
  }

  const tag = `skill-juror/direct-agent-cache-${hashText(seedDockerfile)}:local`;
  await ensureDirectHarborAgentCacheSeed(tag, seedDockerfile, dockerBuild);
}

function buildDirectHarborAgentCacheSeedDockerfile(dockerfile: string): string | null {
  const lines = dockerfile.split(/\n/);
  const markerIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.includes(DIRECT_HARBOR_CODEX_PREINSTALL_MARKER))
    .map(({ index }) => index);
  if (markerIndexes.length === 0) {
    return null;
  }

  const firstMarkerIndex = Math.min(...markerIndexes);
  const stageStart = findStageStartForLine(lines, firstMarkerIndex);
  if (stageStart === null) {
    return null;
  }

  let seedEnd = stageStart + 1;
  for (const markerIndex of markerIndexes) {
    if ((findStageStartForLine(lines, markerIndex) ?? -1) !== stageStart) {
      continue;
    }
    const instructionStart = findNextDockerInstructionIndex(lines, markerIndex + 1);
    if (instructionStart === null) {
      continue;
    }
    seedEnd = Math.max(seedEnd, findDockerInstructionEnd(lines, instructionStart));
  }
  if (seedEnd <= stageStart + 1) {
    return null;
  }

  const globalPrefixEnd = findFirstFromInstructionIndex(lines);
  const globalPrefix = globalPrefixEnd > 0 && lines.slice(0, globalPrefixEnd).every(isAllowedBeforeDockerFrom)
    ? lines.slice(0, globalPrefixEnd)
    : [];
  const seedLines = [
    ...globalPrefix,
    ...lines.slice(stageStart, seedEnd),
  ];
  return `${trimDockerfileBlankLines(seedLines).join("\n")}\n`;
}

function findNextDockerInstructionIndex(lines: string[], startIndex: number): number | null {
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*(?:#|$)/.test(line)) {
      continue;
    }
    return index;
  }
  return null;
}

async function ensureDirectHarborAgentCacheSeed(
  tag: string,
  dockerfile: string,
  dockerBuild: HarborRuntimeConfig["dockerBuild"],
): Promise<void> {
  const cacheRoot = resolve(process.env.SKILL_JUROR_HARBOR_AGENT_CACHE_DIR ?? join("tmp", "harbor-agent-cache"));
  await mkdir(cacheRoot, { recursive: true });
  if (await dockerImageExists(tag)) {
    return;
  }

  const lockDir = join(cacheRoot, `${sanitizeDockerCacheLabel(tag)}.lock`);
  const seedDir = join(cacheRoot, sanitizeDockerCacheLabel(tag));
  if (await acquireDirectoryLock(lockDir)) {
    try {
      if (!await dockerImageExists(tag)) {
        await mkdir(seedDir, { recursive: true });
        await writeFile(join(seedDir, "Dockerfile"), dockerfile);
        await runDockerCommand(["build", ...createDockerBuildResourceArgs(dockerBuild), "-t", tag, seedDir], dockerBuild);
      }
    } catch (error: unknown) {
      process.stderr.write(`[direct-harbor] agent cache prewarm skipped for ${tag}: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
    return;
  }

  const deadline = Date.now() + DIRECT_HARBOR_AGENT_CACHE_LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    if (await dockerImageExists(tag)) {
      return;
    }
    if (!await fileExists(lockDir)) {
      return;
    }
    await sleep(2000);
  }
  process.stderr.write(`[direct-harbor] timed out waiting for agent cache prewarm ${tag}; continuing with normal Docker build\n`);
}

async function acquireDirectoryLock(lockDir: string): Promise<boolean> {
  try {
    await mkdir(lockDir);
    await writeFile(join(lockDir, "owner.json"), JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }, null, 2));
    return true;
  } catch (error: unknown) {
    if (isFileAlreadyExistsError(error)) {
      return false;
    }
    throw error;
  }
}

async function dockerImageExists(tag: string): Promise<boolean> {
  const result = await runCommandQuiet("docker", ["image", "inspect", tag]);
  return result.exitCode === 0;
}

async function runDockerCommand(args: string[], dockerBuild: HarborRuntimeConfig["dockerBuild"]): Promise<void> {
  const result = await runCommandQuiet("docker", args, dockerBuild?.maxOutputBytes);
  if (result.exitCode !== 0) {
    throw new Error(`docker ${args.join(" ")} exited with ${result.exitCode}: ${result.stderr || result.stdout}`);
  }
}

function runCommandQuiet(
  command: string,
  args: string[],
  maxOutputBytes = 10 * 1024 * 1024,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      env: createControlledEnv({}, { includeNetwork: true, includeTooling: true }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = createBoundedOutputCapture(maxOutputBytes);
    const stderr = createBoundedOutputCapture(maxOutputBytes);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
    });
    child.on("error", (error) => {
      stderr.append(error.message);
      resolvePromise({ exitCode: 127, stdout: stdout.toString(), stderr: stderr.toString() });
    });
    child.on("exit", (code, signal) => {
      const signalSuffix = signal == null ? "" : ` signal=${signal}`;
      stderr.append(signalSuffix);
      resolvePromise({ exitCode: code ?? 128, stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
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

function sanitizeDockerCacheLabel(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_");
}

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, durationMs);
  });
}

export async function repairTrailingDockerfileContinuation(taskDir: string): Promise<void> {
  const dockerfilePath = join(taskDir, "environment", "Dockerfile");
  const original = await readFile(dockerfilePath, "utf8");
  const lines = original.split(/\n/);
  let index = lines.length - 1;
  while (index >= 0 && /^\s*$/.test(lines[index] ?? "")) {
    index -= 1;
  }
  if (index < 0 || !hasDockerLineContinuation(lines[index] ?? "")) {
    return;
  }

  lines[index] = (lines[index] ?? "").replace(/\\\s*$/, "").trimEnd();
  await writeFile(dockerfilePath, `${trimDockerfileBlankLines(lines).join("\n")}\n`);
}

function findAgentPreinstallInsertionLine(dockerfile: string): number {
  const lines = dockerfile.split(/\n/);
  const skillCopyIndex = lines.findIndex((line) => isStandardAgentSkillCopyInstruction(line) || /^\s*COPY\s+skills\/?\s+/i.test(line));
  const fallbackFromIndex = findLastFromInstructionIndex(lines);
  if (fallbackFromIndex === -1) {
    return lines.length;
  }

  const stageStart = skillCopyIndex === -1
    ? fallbackFromIndex
    : findStageStartForLine(lines, skillCopyIndex) ?? fallbackFromIndex;
  const stageLimit = skillCopyIndex === -1 ? lines.length : skillCopyIndex;
  let index = stageStart + 1;

  while (index < stageLimit) {
    if (/^\s*$/.test(lines[index] ?? "")) {
      index += 1;
      continue;
    }
    if (/^\s*#\s*SKILL_JUROR_REPAIRED_PRE_FROM_INSTRUCTIONS\b/.test(lines[index] ?? "")) {
      index += 1;
      continue;
    }
    if (/^\s*#/.test(lines[index] ?? "")) {
      break;
    }

    const end = findDockerInstructionEnd(lines, index);
    const instruction = lines.slice(index, end).join("\n");
    if (!isAgentPreinstallPrologueInstruction(instruction)) {
      break;
    }
    index = end;
  }

  return index;
}

function findLastFromInstructionIndex(lines: string[]): number {
  let lastFromIndex = -1;
  for (const index of findDockerInstructionStartIndexes(lines)) {
    if (index >= lines.length) {
      break;
    }
    if (isDockerFromInstruction(lines[index] ?? "")) {
      lastFromIndex = index;
    }
  }
  return lastFromIndex;
}

function findFirstFromInstructionIndex(lines: string[]): number {
  for (const index of findDockerInstructionStartIndexes(lines)) {
    if (isDockerFromInstruction(lines[index] ?? "")) {
      return index;
    }
  }
  return -1;
}

function findStageStartForLine(lines: string[], lineIndex: number): number | null {
  let stageStart: number | null = null;
  for (const index of findDockerInstructionStartIndexes(lines)) {
    if (index > lineIndex) {
      break;
    }
    if (isDockerFromInstruction(lines[index] ?? "")) {
      stageStart = index;
    }
  }
  return stageStart;
}

function findDockerInstructionEnd(lines: string[], startIndex: number): number {
  const headerLines = [lines[startIndex] ?? ""];
  let index = startIndex + 1;
  while (index < lines.length && hasDockerLineContinuation(lines[index - 1] ?? "")) {
    headerLines.push(lines[index] ?? "");
    index += 1;
  }

  for (const heredoc of findDockerHeredocDelimiters(headerLines)) {
    while (index < lines.length) {
      const line = lines[index] ?? "";
      const candidate = heredoc.stripLeadingTabs ? line.replace(/^\t+/, "") : line;
      index += 1;
      if (candidate.trim() === heredoc.delimiter) {
        break;
      }
    }
  }
  return index;
}

function findDockerInstructionStartIndexes(lines: string[]): number[] {
  const indexes: number[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (/^\s*(?:#|$)/.test(line)) {
      index += 1;
      continue;
    }
    indexes.push(index);
    index = Math.max(index + 1, findDockerInstructionEnd(lines, index));
  }
  return indexes;
}

function isDockerFromInstruction(line: string): boolean {
  return /^\s*FROM(?:\s|$)/i.test(line);
}

function findDockerHeredocDelimiters(headerLines: string[]): Array<{ delimiter: string; stripLeadingTabs: boolean }> {
  const header = headerLines.join("\n");
  const delimiters: Array<{ delimiter: string; stripLeadingTabs: boolean }> = [];
  let quote: "\"" | "'" | null = null;
  for (let index = 0; index < header.length; index += 1) {
    const character = header[index];
    if (quote !== null) {
      if (character === "\\" && quote === "\"") {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character !== "<" || header[index + 1] !== "<") {
      continue;
    }

    let cursor = index + 2;
    const stripLeadingTabs = header[cursor] === "-";
    if (stripLeadingTabs) {
      cursor += 1;
    }
    while (cursor < header.length && /[ \t]/.test(header[cursor] ?? "")) {
      cursor += 1;
    }

    const delimiterQuote = header[cursor] === "\"" || header[cursor] === "'" ? header[cursor] : null;
    if (delimiterQuote !== null) {
      cursor += 1;
      const start = cursor;
      while (cursor < header.length && header[cursor] !== delimiterQuote) {
        cursor += 1;
      }
      const delimiter = header.slice(start, cursor);
      if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(delimiter)) {
        delimiters.push({ delimiter, stripLeadingTabs });
      }
      index = cursor;
      continue;
    }

    const delimiterMatch = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(header.slice(cursor));
    if (delimiterMatch !== null) {
      delimiters.push({ delimiter: delimiterMatch[0], stripLeadingTabs });
      index = cursor + delimiterMatch[0].length - 1;
    }
  }
  return delimiters;
}

function hasDockerLineContinuation(line: string): boolean {
  return /\\\s*$/.test(line);
}

function isAgentPreinstallPrologueInstruction(instruction: string): boolean {
  const firstLine = instruction.split(/\n/, 1)[0] ?? "";
  if (/^\s*ARG\b/i.test(firstLine)) {
    return true;
  }
  if (/^\s*ENV\b/i.test(firstLine)) {
    return /\b(?:LOCAL_[A-Z0-9_]+|PIP_INDEX_URL|PIP_TRUSTED_HOST|NPM_CONFIG_REGISTRY|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|no_proxy|https?_proxy|all_proxy)\b/.test(instruction);
  }
  if (/^\s*USER\s+root\s*$/i.test(firstLine)) {
    return true;
  }
  if (/^\s*RUN\b/i.test(firstLine)) {
    return /\b(?:LOCAL_APT_MIRROR|LOCAL_PIP_INDEX_URL|LOCAL_PIP_TRUSTED_HOST|\/etc\/apt|\/etc\/pip|pip\.conf)\b/.test(instruction);
  }
  return false;
}

function insertDockerBlockAtLine(dockerfile: string, block: string, lineIndex: number): string {
  const lines = dockerfile.split(/\n/);
  if (lineIndex >= lines.length) {
    return `${dockerfile.trimEnd()}\n\n${block}\n`;
  }

  const before = lines.slice(0, lineIndex).join("\n").trimEnd();
  const after = lines.slice(lineIndex).join("\n").trimStart();
  if (before.length === 0) {
    return `${block}\n\n${after.trimEnd()}\n`;
  }
  if (after.length === 0) {
    return `${before}\n\n${block}\n`;
  }
  return `${before}\n\n${block}\n\n${after.trimEnd()}\n`;
}

function findLateSkillCopyInsertionIndex(lines: string[]): number {
  let index = trimTrailingBlankLines(lines).length;
  while (index > 0 && isTrailingDockerMetadataInstruction(lines[index - 1] ?? "")) {
    index -= 1;
  }
  return index;
}

function isTrailingDockerMetadataInstruction(line: string): boolean {
  return /^\s*(?:CMD|ENTRYPOINT|USER|WORKDIR|EXPOSE|VOLUME|LABEL|STOPSIGNAL|HEALTHCHECK|SHELL)\b/i.test(line);
}

function trimTrailingBlankLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && /^\s*$/.test(lines[end - 1] ?? "")) {
    end -= 1;
  }
  return lines.slice(0, end);
}

function trimDockerfileBlankLines(lines: string[]): string[] {
  const trimmed = trimTrailingBlankLines(lines);
  let start = 0;
  while (start < trimmed.length && /^\s*$/.test(trimmed[start] ?? "")) {
    start += 1;
  }
  return trimmed.slice(start);
}

function renderDirectHarborCodexPreinstallDockerBlock(): string {
  return `ARG LOCAL_APT_MIRROR=${DIRECT_HARBOR_DEFAULT_APT_MIRROR}
ARG LOCAL_NPM_REGISTRY=${DIRECT_HARBOR_DEFAULT_NPM_REGISTRY}
# ${DIRECT_HARBOR_CODEX_PREINSTALL_MARKER}
RUN set -eux; \\
    if command -v apk >/dev/null 2>&1; then \\
      apk add --no-cache bash ca-certificates curl nodejs npm ripgrep xz; \\
    elif command -v apt-get >/dev/null 2>&1; then \\
      ${renderDirectHarborAptMirrorSetupDockerShell()} \\
      apt-get update; \\
      apt-get install -y --no-install-recommends ca-certificates curl nodejs npm ripgrep xz-utils; \\
      rm -rf /var/lib/apt/lists/*; \\
    elif command -v yum >/dev/null 2>&1; then \\
      yum_packages="ca-certificates nodejs npm ripgrep xz"; \\
      if ! command -v curl >/dev/null 2>&1; then yum_packages="curl ${"$"}{yum_packages}"; fi; \\
      yum install -y ${"$"}{yum_packages} || yum install -y --allowerasing ${"$"}{yum_packages}; \\
    else \\
      echo "No supported package manager found for Codex preinstall." >&2; \\
      exit 1; \\
    fi; \\
    ${renderDirectHarborNode20EnsureDockerShell()} \\
    mkdir -p /opt/codex /usr/local/bin; \\
    npm config set registry "${"$"}{LOCAL_NPM_REGISTRY:-${DIRECT_HARBOR_DEFAULT_NPM_REGISTRY}}"; \\
    npm install -g --prefix /opt/codex ${DIRECT_HARBOR_CODEX_NPM_PACKAGE}; \\
    printf '%s\\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'exec /opt/codex/bin/codex "$@"' > /usr/local/bin/codex; \\
    chmod +x /usr/local/bin/codex; \\
    codex --version`;
}

function renderDirectHarborClaudeCodePreinstallDockerBlock(): string {
  return `ARG LOCAL_APT_MIRROR=${DIRECT_HARBOR_DEFAULT_APT_MIRROR}
ARG LOCAL_NPM_REGISTRY=${DIRECT_HARBOR_DEFAULT_NPM_REGISTRY}
# ${DIRECT_HARBOR_CLAUDE_CODE_PREINSTALL_MARKER}
RUN set -eux; \\
    if command -v apk >/dev/null 2>&1; then \\
      apk add --no-cache bash ca-certificates curl nodejs npm xz; \\
    elif command -v apt-get >/dev/null 2>&1; then \\
      ${renderDirectHarborAptMirrorSetupDockerShell()} \\
      apt-get update; \\
      apt-get install -y --no-install-recommends ca-certificates curl nodejs npm xz-utils; \\
      rm -rf /var/lib/apt/lists/*; \\
    elif command -v yum >/dev/null 2>&1; then \\
      yum_packages="ca-certificates nodejs npm xz"; \\
      if ! command -v curl >/dev/null 2>&1; then yum_packages="curl ${"$"}{yum_packages}"; fi; \\
      yum install -y ${"$"}{yum_packages} || yum install -y --allowerasing ${"$"}{yum_packages}; \\
    else \\
      echo "No supported package manager found for Claude Code preinstall." >&2; \\
      exit 1; \\
    fi; \\
    ${renderDirectHarborNode20EnsureDockerShell()} \\
    mkdir -p /opt/claude-code /usr/local/bin; \\
    npm config set registry "${"$"}{LOCAL_NPM_REGISTRY:-${DIRECT_HARBOR_DEFAULT_NPM_REGISTRY}}"; \\
    npm install -g --prefix /opt/claude-code ${DIRECT_HARBOR_CLAUDE_CODE_NPM_PACKAGE}; \\
    printf '%s\\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'exec /opt/claude-code/bin/claude "$@"' > /usr/local/bin/claude; \\
    chmod +x /usr/local/bin/claude; \\
    claude --version`;
}

function renderDirectHarborAptMirrorSetupDockerShell(): string {
  return `if [ -n "${"$"}{LOCAL_APT_MIRROR:-}" ]; then \\
        find /etc/apt -maxdepth 2 -type f \\( -name '*.list' -o -name '*.sources' \\) -print0 \\
          | xargs -0 -r sed -i \\
            -e "s|http://archive.ubuntu.com/ubuntu|http://${"$"}{LOCAL_APT_MIRROR}/ubuntu|g" \\
            -e "s|https://archive.ubuntu.com/ubuntu|http://${"$"}{LOCAL_APT_MIRROR}/ubuntu|g" \\
            -e "s|http://security.ubuntu.com/ubuntu|http://${"$"}{LOCAL_APT_MIRROR}/ubuntu|g" \\
            -e "s|https://security.ubuntu.com/ubuntu|http://${"$"}{LOCAL_APT_MIRROR}/ubuntu|g" \\
            -e "s|http://deb.debian.org/debian|http://${"$"}{LOCAL_APT_MIRROR}/debian|g" \\
            -e "s|https://deb.debian.org/debian|http://${"$"}{LOCAL_APT_MIRROR}/debian|g" \\
            -e "s|http://security.debian.org/debian-security|http://${"$"}{LOCAL_APT_MIRROR}/debian-security|g" \\
            -e "s|https://security.debian.org/debian-security|http://${"$"}{LOCAL_APT_MIRROR}/debian-security|g" || true; \\
      fi;`;
}

function renderDirectHarborUvPipInstallDockerBlock(version: string): string {
  return `ARG LOCAL_APT_MIRROR=${DIRECT_HARBOR_DEFAULT_APT_MIRROR}
ARG LOCAL_PIP_INDEX_URL=${DIRECT_HARBOR_DEFAULT_PIP_INDEX_URL}
ARG LOCAL_PIP_TRUSTED_HOST=${DIRECT_HARBOR_DEFAULT_PIP_TRUSTED_HOST}
# ${DIRECT_HARBOR_UV_INSTALLER_STABILIZATION_MARKER}
ENV PIP_INDEX_URL=\${LOCAL_PIP_INDEX_URL} \\
    PIP_TRUSTED_HOST=\${LOCAL_PIP_TRUSTED_HOST} \\
    UV_INDEX_URL=\${LOCAL_PIP_INDEX_URL} \\
    UV_DEFAULT_INDEX=\${LOCAL_PIP_INDEX_URL} \\
    UV_INSECURE_HOST=\${LOCAL_PIP_TRUSTED_HOST}
RUN set -eux; \\
    if ! command -v pip3 >/dev/null 2>&1; then \\
      if command -v apk >/dev/null 2>&1; then \\
        apk add --no-cache python3 py3-pip py3-virtualenv; \\
      elif command -v apt-get >/dev/null 2>&1; then \\
        ${renderDirectHarborAptMirrorSetupDockerShell()} \\
        apt-get update; \\
        apt-get install -y python3 python3-pip python3-venv; \\
        rm -rf /var/lib/apt/lists/*; \\
      elif command -v yum >/dev/null 2>&1; then \\
        yum install -y python3 python3-pip; \\
      else \\
        echo "No supported package manager found for uv installer stabilization." >&2; \\
        exit 1; \\
      fi; \\
    fi; \\
    pip3 install --retries ${DIRECT_HARBOR_DEFAULT_PIP_RETRIES} --timeout ${DIRECT_HARBOR_DEFAULT_PIP_TIMEOUT_SEC} --break-system-packages uv==${version} || pip3 install --retries ${DIRECT_HARBOR_DEFAULT_PIP_RETRIES} --timeout ${DIRECT_HARBOR_DEFAULT_PIP_TIMEOUT_SEC} uv==${version}; \\
    mkdir -p "$HOME/.local/bin"; \\
    printf 'export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"\\n' > "$HOME/.local/bin/env"; \\
    uv --version; \\
    uvx --version`;
}

function renderDirectHarborNode20EnsureDockerShell(): string {
  return `node_major="$(node -p 'process.versions.node.split(".")[0]')"; \\
    if [ "$node_major" -lt 18 ]; then \\
      npm config set registry "${"$"}{LOCAL_NPM_REGISTRY:-${DIRECT_HARBOR_DEFAULT_NPM_REGISTRY}}"; \\
      npm install -g ${DIRECT_HARBOR_NODE_MANAGER_NPM_PACKAGE}; \\
      N_NODE_MIRROR="${"$"}{LOCAL_NODE_MIRROR:-${DIRECT_HARBOR_DEFAULT_NODE_MIRROR}}" n 20; \\
      hash -r; \\
    fi; \\
    node --version; \\
    npm --version;`;
}

export async function preinstallVerifierUvInHarborDockerfile(taskDir: string): Promise<void> {
  const verifierScriptPath = join(taskDir, "tests", "test.sh");
  const verifierScript = await readOptionalFile(verifierScriptPath);
  if (verifierScript === null) {
    return;
  }

  const dockerfilePath = join(taskDir, "environment", "Dockerfile");
  const original = await readFile(dockerfilePath, "utf8");
  const blocks: string[] = [];
  if (usesUvVerifier(verifierScript) && !original.includes(DIRECT_HARBOR_VERIFIER_UV_PREINSTALL_MARKER)) {
    blocks.push(renderDirectHarborVerifierUvPreinstallDockerBlock(verifierScript));
  }
  if (usesPlaywrightVerifier(verifierScript) && !original.includes(DIRECT_HARBOR_VERIFIER_PLAYWRIGHT_PREINSTALL_MARKER)) {
    blocks.push(renderDirectHarborVerifierPlaywrightPreinstallDockerBlock(verifierScript));
  }

  if (blocks.length === 0) {
    return;
  }

  await writeFile(dockerfilePath, `${original.trimEnd()}\n\n${blocks.join("\n\n")}\n`);
}

export async function ensurePythonCommandAliasInHarborDockerfile(taskDir: string): Promise<void> {
  const dockerfilePath = join(taskDir, "environment", "Dockerfile");
  const original = await readFile(dockerfilePath, "utf8");
  if (original.includes(DIRECT_HARBOR_PYTHON_ALIAS_MARKER)) {
    return;
  }
  if (!/\bpython3\b/.test(original) || /\bpython-is-python3\b/.test(original)) {
    return;
  }

  await writeFile(dockerfilePath, `${original.trimEnd()}\n\n${renderDirectHarborPythonAliasDockerBlock()}\n`);
}

function renderDirectHarborPythonAliasDockerBlock(): string {
  return `# ${DIRECT_HARBOR_PYTHON_ALIAS_MARKER}
RUN set -eux; \\
    if ! command -v python >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then \\
      mkdir -p /usr/local/bin; \\
      ln -sf "$(command -v python3)" /usr/local/bin/python; \\
    fi; \\
    if command -v python >/dev/null 2>&1; then python --version; fi`;
}

function usesUvVerifier(script: string): boolean {
  return /\buvx\b/.test(script) || /\buv\b/.test(script) || script.includes("astral.sh/uv/");
}

function usesPlaywrightVerifier(script: string): boolean {
  return /\bplaywright\s+install\s+chromium\b/.test(script)
    || /\bpython3\s+-m\s+playwright\s+install\s+chromium\b/.test(script)
    || /\bpytest-playwright==/.test(script)
    || /\bplaywright==/.test(script);
}

function renderDirectHarborVerifierUvPreinstallDockerBlock(verifierScript: string): string {
  const prewarmCommand = buildUvxPrewarmCommand(verifierScript);
  const prewarmLine = prewarmCommand === null
    ? ""
    : `; \\\n    if ! ${prewarmCommand}; then echo "SKILL_JUROR_VERIFIER_UV_PREWARM_SKIPPED"; fi`;
  return `ARG LOCAL_APT_MIRROR=${DIRECT_HARBOR_DEFAULT_APT_MIRROR}
ARG LOCAL_PIP_INDEX_URL=${DIRECT_HARBOR_DEFAULT_PIP_INDEX_URL}
ARG LOCAL_PIP_TRUSTED_HOST=${DIRECT_HARBOR_DEFAULT_PIP_TRUSTED_HOST}
# ${DIRECT_HARBOR_VERIFIER_UV_PREINSTALL_MARKER}
ENV PIP_INDEX_URL=\${LOCAL_PIP_INDEX_URL} \\
    PIP_TRUSTED_HOST=\${LOCAL_PIP_TRUSTED_HOST} \\
    UV_INDEX_URL=\${LOCAL_PIP_INDEX_URL} \\
    UV_DEFAULT_INDEX=\${LOCAL_PIP_INDEX_URL} \\
    UV_INSECURE_HOST=\${LOCAL_PIP_TRUSTED_HOST}
RUN set -eux; \\
    if ! command -v pip3 >/dev/null 2>&1; then \\
      if command -v apk >/dev/null 2>&1; then \\
        apk add --no-cache python3 py3-pip py3-virtualenv; \\
      elif command -v apt-get >/dev/null 2>&1; then \\
        ${renderDirectHarborAptMirrorSetupDockerShell()} \\
        apt-get update; \\
        apt-get install -y python3 python3-pip python3-venv; \\
        rm -rf /var/lib/apt/lists/*; \\
      elif command -v yum >/dev/null 2>&1; then \\
        yum install -y python3 python3-pip; \\
      else \\
        echo "No supported package manager found for verifier uv preinstall." >&2; \\
        exit 1; \\
      fi; \\
    fi; \\
    pip3 install --retries ${DIRECT_HARBOR_DEFAULT_PIP_RETRIES} --timeout ${DIRECT_HARBOR_DEFAULT_PIP_TIMEOUT_SEC} --break-system-packages uv==${DIRECT_HARBOR_VERIFIER_UV_VERSION} || pip3 install --retries ${DIRECT_HARBOR_DEFAULT_PIP_RETRIES} --timeout ${DIRECT_HARBOR_DEFAULT_PIP_TIMEOUT_SEC} uv==${DIRECT_HARBOR_VERIFIER_UV_VERSION}; \\
    mkdir -p "$HOME/.local/bin"; \\
    printf 'export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"\\n' > "$HOME/.local/bin/env"; \\
    uv --version; \\
    uvx --version${prewarmLine}`;
}

function renderDirectHarborVerifierPlaywrightPreinstallDockerBlock(verifierScript: string): string {
  const packages = extractVerifierPipInstallPackages(verifierScript);
  const packageArgs = packages.length > 0
    ? packages.map(quoteShellArg).join(" ")
    : "playwright";
  return `ARG LOCAL_APT_MIRROR=${DIRECT_HARBOR_DEFAULT_APT_MIRROR}
ARG LOCAL_PIP_INDEX_URL=${DIRECT_HARBOR_DEFAULT_PIP_INDEX_URL}
ARG LOCAL_PIP_TRUSTED_HOST=${DIRECT_HARBOR_DEFAULT_PIP_TRUSTED_HOST}
# ${DIRECT_HARBOR_VERIFIER_PLAYWRIGHT_PREINSTALL_MARKER}
ENV PIP_INDEX_URL=\${LOCAL_PIP_INDEX_URL} \\
    PIP_TRUSTED_HOST=\${LOCAL_PIP_TRUSTED_HOST} \\
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN set -eux; \\
    if ! command -v pip3 >/dev/null 2>&1; then \\
      if command -v apk >/dev/null 2>&1; then \\
        apk add --no-cache python3 py3-pip; \\
      elif command -v apt-get >/dev/null 2>&1; then \\
        ${renderDirectHarborAptMirrorSetupDockerShell()} \\
        apt-get update; \\
        apt-get install -y python3 python3-pip; \\
        rm -rf /var/lib/apt/lists/*; \\
      elif command -v yum >/dev/null 2>&1; then \\
        yum install -y python3 python3-pip; \\
      else \\
        echo "No supported package manager found for verifier Playwright preinstall." >&2; \\
        exit 1; \\
      fi; \\
    fi; \\
    pip3 install --retries ${DIRECT_HARBOR_DEFAULT_PIP_RETRIES} --timeout ${DIRECT_HARBOR_DEFAULT_PIP_TIMEOUT_SEC} --break-system-packages ${packageArgs} || pip3 install --retries ${DIRECT_HARBOR_DEFAULT_PIP_RETRIES} --timeout ${DIRECT_HARBOR_DEFAULT_PIP_TIMEOUT_SEC} ${packageArgs}; \\
    python3 -m playwright install chromium; \\
    mkdir -p ${quoteShellArg(DIRECT_HARBOR_VERIFIER_PREINSTALL_MARKER_DIR)}; \\
    touch ${quoteShellArg(DIRECT_HARBOR_VERIFIER_PLAYWRIGHT_PREINSTALL_MARKER_PATH)}`;
}

function extractVerifierPipInstallPackages(verifierScript: string): string[] {
  const packages: string[] = [];
  const installCommands = [
    ...verifierScript.matchAll(/^(?:pip3?|python3\s+-m\s+pip)\s+install\s+.*$/gm),
  ].map((match) => match[0]);
  for (const command of installCommands) {
    const tokens = command.trim().split(/\s+/);
    const installIndex = tokens.indexOf("install");
    if (installIndex === -1) {
      continue;
    }
    for (let index = 0; index < tokens.length; index += 1) {
      if (index <= installIndex) {
        continue;
      }
      const token = tokens[index] ?? "";
      if (token.length === 0) {
        continue;
      }
      if (token === "--break-system-packages") {
        continue;
      }
      if (token === "--retries" || token === "--timeout" || token === "-i" || token === "--index-url" || token === "--trusted-host") {
        index += 1;
        continue;
      }
      if (token.startsWith("-")) {
        continue;
      }
      packages.push(token);
    }
  }

  if (packages.length === 0) {
    return [];
  }
  if (!packages.some((dependency) => /^playwright(?:==|$)/.test(dependency)) && packages.some((dependency) => /^pytest-playwright(?:==|$)/.test(dependency))) {
    packages.push("playwright");
  }
  return [...new Set(packages)];
}

function buildUvxPrewarmCommand(verifierScript: string): string | null {
  if (!/\buvx\b/.test(verifierScript) || !/\bpytest\b/.test(verifierScript)) {
    return null;
  }

  const packages = [...verifierScript.matchAll(/--with\s+([^\s\\]+)/g)]
    .map((match) => match[1])
    .filter((value): value is string => value != null && value.length > 0);
  if (packages.length === 0) {
    return null;
  }

  const uniquePackages = [...new Set(packages)];
  const withArgs = uniquePackages.map((dependency) => `--with ${quoteShellArg(dependency)}`).join(" ");
  const pythonArg = requiresVerifierPython311(verifierScript) ? "--python 3.11 " : "";
  const cpuTorchIndexArg = usesPytorchCpuWheel(uniquePackages)
    ? `--extra-index-url ${quoteShellArg(DIRECT_HARBOR_PYTORCH_CPU_INDEX_URL)} `
    : "";
  return `uvx ${pythonArg}${cpuTorchIndexArg}${withArgs} pytest --version`;
}

function requiresVerifierPython311(verifierScript: string): boolean {
  return /\btorch==2\.1\.[0-9]+\b/.test(verifierScript);
}

function usesPytorchCpuWheel(packages: string[]): boolean {
  return packages.some((dependency) => /^torch(?:vision|audio)?==[^"'\\\s]+\+cpu$/.test(dependency));
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
