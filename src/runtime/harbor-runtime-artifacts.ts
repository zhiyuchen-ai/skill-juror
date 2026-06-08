import { mkdir, readFile, rm, stat, writeFile } from "fs/promises";
import { join } from "path";

import { parseJsonText, readOptionalFile } from "./artifact-io.js";
import {
  getHarborTrajectoryCacheCreationTokens,
  getHarborTrajectorySessionId,
  getHarborTrajectoryStopReason,
  getHarborTrajectoryTurns,
} from "./harbor-trajectory.js";
import type { TrialResult } from "../types/result.js";

const HARBOR_VERIFIER_PLAYWRIGHT_PREINSTALL_MARKER_PATH = "/opt/skill-juror/verifier-playwright-preinstalled";

export async function configureHarborVerifierBridge(
  taskDir: string,
): Promise<void> {
  const testsDir = join(taskDir, "tests");
  const testScriptPath = join(testsDir, "test.sh");
  const originalScriptPath = join(testsDir, "test.original.sh");

  await mkdir(testsDir, { recursive: true });

  const hasOriginalScript = await fileExists(testScriptPath);
  if (hasOriginalScript) {
    await rm(originalScriptPath, { force: true });
    await rm(testScriptPath, { force: true });
    await writeFile(originalScriptPath, "# Original verifier omitted by the OSS runtime-capture wrapper.\n");
    await stabilizeHarborOriginalVerifierScript(originalScriptPath);
  }

  await writeFile(testScriptPath, buildHarborRuntimeOnlyVerifierWrapper());
}

async function stabilizeHarborOriginalVerifierScript(scriptPath: string): Promise<void> {
  const original = await readFile(scriptPath, "utf8");
  let updated = original;
  updated = stabilizeVerifierAptInstalls(updated);
  updated = stabilizeVerifierUvBootstrap(updated);
  updated = stabilizeVerifierPlaywrightInstalls(updated);
  updated = stabilizeVerifierServerWaits(updated);

  if (usesUvVerifier(updated) && !updated.includes("SKILL_JUROR_VERIFIER_UV_PATH")) {
    const pathPrelude = [
      "# SKILL_JUROR_VERIFIER_UV_PATH",
      'export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"',
      'if [ -n "${PIP_INDEX_URL:-}" ]; then',
      '  export UV_INDEX_URL="${UV_INDEX_URL:-$PIP_INDEX_URL}"',
      '  export UV_DEFAULT_INDEX="${UV_DEFAULT_INDEX:-$PIP_INDEX_URL}"',
      "fi",
      'if [ -n "${PIP_TRUSTED_HOST:-}" ]; then',
      '  export UV_INSECURE_HOST="${UV_INSECURE_HOST:-$PIP_TRUSTED_HOST}"',
      "fi",
      ...(requiresVerifierPython311(original) ? ['export UV_PYTHON="${UV_PYTHON:-3.11}"'] : []),
      "",
    ].join("\n");
    if (updated.startsWith("#!")) {
      updated = updated.replace(/^(#![^\n]*\n)/, `$1\n${pathPrelude}`);
    } else {
      updated = `${pathPrelude}${updated}`;
    }
  }

  if (updated !== original) {
    await writeFile(scriptPath, updated);
  }
}

function stabilizeVerifierAptInstalls(script: string): string {
  let updated = script;
  updated = updated.replace(
    /^apt-get update(?:\s*>[^\n]+)?\napt-get install -y curl poppler-utils(?:\s*>[^\n]+)?$/m,
    [
      "if ! command -v curl >/dev/null 2>&1 || ! command -v pdftotext >/dev/null 2>&1; then",
      "  apt-get update",
      "  apt-get install -y curl poppler-utils",
      "fi",
    ].join("\n"),
  );
  updated = updated.replace(
    /^apt-get update(?:\s*>[^\n]+)?\napt-get install -y curl(?:\s*>[^\n]+)?$/m,
    [
      "if ! command -v curl >/dev/null 2>&1; then",
      "  apt-get update",
      "  apt-get install -y curl",
      "fi",
    ].join("\n"),
  );
  return updated;
}

function stabilizeVerifierUvBootstrap(script: string): string {
  let updated = script;
  updated = updated.replace(
    /^if command -v curl &> \/dev\/null; then\n\s+curl -LsSf https:\/\/astral\.sh\/uv\/([0-9.]+)\/install\.sh \| sh\n\s+source\s+["']?\$HOME\/\.local\/bin\/env["']?\nelse\n\s+pip3 install --break-system-packages uv\nfi$/m,
    [
      "if ! command -v uv >/dev/null 2>&1 || ! command -v uvx >/dev/null 2>&1; then",
      "  if command -v curl >/dev/null 2>&1; then",
      "    curl -LsSf https://astral.sh/uv/$1/install.sh | sh",
      "  else",
      "    pip3 install --break-system-packages uv",
      "  fi",
      "fi",
    ].join("\n"),
  );
  updated = updated.replace(
    /^curl -LsSf https:\/\/astral\.sh\/uv\/([0-9.]+)\/install\.sh \| sh(?:\s*>[^\n]+)?$/m,
    [
      "if ! command -v uv >/dev/null 2>&1 || ! command -v uvx >/dev/null 2>&1; then",
      "  curl -LsSf https://astral.sh/uv/$1/install.sh | sh",
      "fi",
    ].join("\n"),
  );
  updated = updated.replace(
    /^source\s+["']?\$HOME\/\.local\/bin\/env["']?$/m,
    [
      'if [ -f "$HOME/.local/bin/env" ]; then',
      '  source "$HOME/.local/bin/env"',
      "fi",
      'export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"',
    ].join("\n"),
  );
  return updated;
}

function stabilizeVerifierPlaywrightInstalls(script: string): string {
  if (script.includes(HARBOR_VERIFIER_PLAYWRIGHT_PREINSTALL_MARKER_PATH)) {
    return script;
  }

  let updated = script;
  updated = updated.replace(
    /^([ \t]*)(pip3?\s+install\b.*(?:pytest-playwright|playwright).*)$/gm,
    (_match: string, indent: string, command: string) => [
      `${indent}if [ ! -f ${HARBOR_VERIFIER_PLAYWRIGHT_PREINSTALL_MARKER_PATH} ]; then`,
      `${indent}  ${command}`,
      `${indent}fi`,
    ].join("\n"),
  );
  updated = updated.replace(
    /^([ \t]*)(python3\s+-m\s+pip\s+install\b.*(?:pytest-playwright|playwright).*)$/gm,
    (_match: string, indent: string, command: string) => [
      `${indent}if [ ! -f ${HARBOR_VERIFIER_PLAYWRIGHT_PREINSTALL_MARKER_PATH} ]; then`,
      `${indent}  ${command}`,
      `${indent}fi`,
    ].join("\n"),
  );
  updated = updated.replace(
    /^([ \t]*)(python3\s+-m\s+playwright\s+install\s+chromium\b.*)$/gm,
    (_match: string, indent: string, command: string) => [
      `${indent}if [ ! -f ${HARBOR_VERIFIER_PLAYWRIGHT_PREINSTALL_MARKER_PATH} ]; then`,
      `${indent}  ${command}`,
      `${indent}fi`,
    ].join("\n"),
  );
  updated = updated.replace(
    /^([ \t]*)(playwright\s+install\s+chromium\b.*)$/gm,
    (_match: string, indent: string, command: string) => [
      `${indent}if [ ! -f ${HARBOR_VERIFIER_PLAYWRIGHT_PREINSTALL_MARKER_PATH} ]; then`,
      `${indent}  ${command}`,
      `${indent}fi`,
    ].join("\n"),
  );
  return updated;
}

function stabilizeVerifierServerWaits(script: string): string {
  let updated = script;
  updated = updated.replace(
    /^until curl -s http:\/\/api:4000\/api\/results-bar > \/dev\/null 2>&1; do\n\s+sleep 1\ndone$/m,
    [
      "for i in {1..60}; do",
      "  if curl -s http://api:4000/api/results-bar > /dev/null 2>&1; then",
      "    break",
      "  fi",
      "  if [ \"$i\" -eq 60 ]; then",
      "    echo 0 > /logs/verifier/reward.txt",
      "    echo \"API server did not become ready\" >&2",
      "    exit 0",
      "  fi",
      "  sleep 1",
      "done",
    ].join("\n"),
  );
  updated = updated.replace(
    /^until curl -s -o \/dev\/null -w "%\{http_code\}" http:\/\/localhost:3000 \| grep -q "200"; do\n\s+sleep 1\ndone$/m,
    [
      "for i in {1..90}; do",
      "  if curl -s -o /dev/null -w \"%{http_code}\" http://localhost:3000 | grep -q \"200\"; then",
      "    break",
      "  fi",
      "  if [ \"$i\" -eq 90 ]; then",
      "    echo 0 > /logs/verifier/reward.txt",
      "    echo \"App server did not become ready\" >&2",
      "    kill ${APP_PID:-} 2>/dev/null || true",
      "    exit 0",
      "  fi",
      "  sleep 1",
      "done",
    ].join("\n"),
  );
  return updated;
}

function buildHarborRuntimeOnlyVerifierWrapper(): string {
  return `#!/bin/bash
set -euo pipefail

mkdir -p /logs/verifier
echo 1 > /logs/verifier/reward.txt
printf 'Runtime capture completed; task verification was not run by this toolkit.' > /logs/verifier/acceptance.stdout.txt
: > /logs/verifier/acceptance.stderr.txt
exit 0
`;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error: unknown) {
    if (isFileNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}

export async function persistHarborTrialArtifacts(options: {
  harborTrialDir: string;
  localTrialDir: string;
  result: TrialResult;
}): Promise<TrialResult> {
  const { harborTrialDir, localTrialDir } = options;
  const result: TrialResult = {
    ...options.result,
    execution: {
      ...options.result.execution,
      rawArtifacts: [],
    },
  };
  await mkdir(localTrialDir, { recursive: true });
  const emittedArtifacts = new Set<string>();

  const trajectoryText = await readOptionalFile(join(harborTrialDir, "agent", "trajectory.json"));
  if (trajectoryText !== null) {
    await writeFile(join(localTrialDir, "trajectory.json"), trajectoryText);
    emittedArtifacts.add("trajectory.json");

    const trajectory = parseJsonText(trajectoryText);
    const sessionId = getHarborTrajectorySessionId(trajectory);
    if (sessionId !== null) {
      result.session_id = sessionId;
    }

    const stopReason = getHarborTrajectoryStopReason(trajectory);
    if (stopReason !== null) {
      result.stop_reason = stopReason;
    }

    const cacheCreationTokens = getHarborTrajectoryCacheCreationTokens(trajectory);
    if (cacheCreationTokens !== null && result.usage !== null) {
      result.usage.cache_creation_input_tokens = cacheCreationTokens;
    }

    const numTurns = getHarborTrajectoryTurns(trajectory);
    if (numTurns !== null) {
      result.num_turns = numTurns;
    }
  }

  result.execution.rawArtifacts = [...emittedArtifacts].sort();
  result.execution.sessionInit = result.session_id == null && result.execution.model == null
    ? null
    : {
        cwd: null,
        model: result.execution.model,
        session_id: result.session_id,
        source: "harbor",
        transcript_path: result.transcript_path,
  };
  return result;
}

export function isFileNotFoundError(error: unknown): boolean {
  return typeof error === "object"
    && error != null
    && "code" in error
    && error.code === "ENOENT";
}

export function isFileAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object"
    && error != null
    && "code" in error
    && error.code === "EEXIST";
}


function usesUvVerifier(script: string): boolean {
  return /\buvx\b/.test(script) || /\buv\b/.test(script) || script.includes("astral.sh/uv/");
}

function requiresVerifierPython311(script: string): boolean {
  return /\btorch==2\.1\.[0-9]+\b/.test(script);
}
