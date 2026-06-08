#!/usr/bin/env node
import { constants } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, readFile, readdir, readlink, rm, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_OUT_ROOT = "artifacts/harbor-tasks";
const DEFAULT_CODEX_NPM_PACKAGE = "@openai/codex@0.128.0";

const CONDITION_LABELS = {
  origin: "Source Bundle",
  baseline: "Single-File",
  pd: "Progressive Disclosure",
  noskill: "No Skill",
};

const args = parseArgs(process.argv.slice(2));
if (args.help === true) {
  console.log(renderHelp());
  process.exit(0);
}
const sourceTasksRoot = requireArg(args, "sourceTasksRoot", "--source-tasks-root");
const singleFileRoot = requireOneArg(args, ["singleFileRoot", "baselineRoot"], "--single-file-root");
const progressiveDisclosureRoot = requireOneArg(
  args,
  ["progressiveDisclosureRoot", "pdRoot"],
  "--progressive-disclosure-root",
);
const outRoot = args.outRoot ?? DEFAULT_OUT_ROOT;
const force = args.force === true || args.force === "true";
const clearRuntimeProxy = args.clearRuntimeProxy !== "false";
const preinstallCodex = args.preinstallCodex === true || args.preinstallCodex === "true";

if (!force && await exists(outRoot)) {
  throw new Error(`Output already exists: ${outRoot}. Pass --force to rebuild.`);
}

if (force) {
  await rm(outRoot, { recursive: true, force: true });
}

const taskIds = await listTaskIds(singleFileRoot);
await assertInputs(taskIds, sourceTasksRoot, singleFileRoot, progressiveDisclosureRoot);

const records = [];
const generatedIds = new Set();

for (const condition of ["origin", "baseline", "pd", "noskill"]) {
  const conditionDir = path.join(outRoot, condition);
  await mkdir(conditionDir, { recursive: true });

  for (const taskId of taskIds) {
    const harborTaskId = `${taskId}-${condition}`;
    const sourceTaskDir = path.join(sourceTasksRoot, taskId);
    const destTaskDir = path.join(conditionDir, harborTaskId);

    await copyTreeHardlinked(sourceTaskDir, destTaskDir);
    await rewriteDockerfile(path.join(destTaskDir, "environment", "Dockerfile"), {
      clearRuntimeProxy,
      preinstallCodex,
    });
    await rewriteTaskToml(path.join(destTaskDir, "task.toml"), harborTaskId, condition);

    if (condition !== "origin") {
      const skillsDir = path.join(destTaskDir, "environment", "skills");
      await rm(skillsDir, { recursive: true, force: true });
      await mkdir(skillsDir, { recursive: true });

      if (condition !== "noskill") {
        const skillSource = condition === "baseline"
          ? path.join(singleFileRoot, taskId, "baseline")
          : path.join(progressiveDisclosureRoot, taskId, "pd");
        await copyTreeHardlinked(skillSource, path.join(skillsDir, `${taskId}-${condition}`));
      }
    }

    if (generatedIds.has(harborTaskId)) {
      throw new Error(`Duplicate generated task id: ${harborTaskId}`);
    }
    generatedIds.add(harborTaskId);

    records.push({
      taskId,
      condition,
      harborTaskId,
      path: path.relative(outRoot, destTaskDir),
      skillsPath: path.relative(outRoot, path.join(destTaskDir, "environment", "skills")),
    });
  }
}

const validation = await validateArtifact(outRoot, taskIds);
const manifest = {
  schemaVersion: "skill-juror-harbor-condition-artifact/v1",
  generatedAt: new Date().toISOString(),
  sourceTaskCount: taskIds.length,
  ignoredSourceTasks: await listIgnoredSourceTasks(sourceTasksRoot, taskIds),
  inputs: {
    sourceTasksRoot: "<provided>",
    singleFileRoot: "<provided>",
    progressiveDisclosureRoot: "<provided>",
  },
  generationOptions: {
    clearRuntimeProxy,
    preinstallCodex,
    codexNpmPackage: DEFAULT_CODEX_NPM_PACKAGE,
  },
  layout: {
    sourceBundle: "origin/<task-id>-origin",
    singleFile: "baseline/<task-id>-baseline",
    progressiveDisclosure: "pd/<task-id>-pd",
    noSkill: "noskill/<task-id>-noskill",
    origin: "origin/<task-id>-origin",
    baseline: "baseline/<task-id>-baseline",
    pd: "pd/<task-id>-pd",
    noskill: "noskill/<task-id>-noskill",
  },
  directoryAliases: {
    origin: "source-bundle",
    baseline: "single-file",
    pd: "progressive-disclosure",
    noskill: "no-skill",
  },
  conditions: {
    origin: {
      description: "Source skill bundle from environment/skills.",
      skillSource: "source task environment/skills",
    },
    baseline: {
      description: "Single-file skill variant injected as the only Harbor skill.",
      skillSource: "prepared single-file artifact",
    },
    pd: {
      description: "Progressive-disclosure skill variant injected as the only Harbor skill.",
      skillSource: "prepared progressive-disclosure artifact",
    },
    noskill: {
      description: "Source task with environment/skills present but empty.",
      skillSource: null,
    },
  },
  validation,
  records,
};

await writeFile(path.join(outRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(path.join(outRoot, "manifest.noskill.json"), `${JSON.stringify({
  schemaVersion: "skill-juror-noskill-harbor-condition/v1",
  generatedAt: manifest.generatedAt,
  sourceTaskCount: taskIds.length,
  generationOptions: { clearRuntimeProxy },
  layout: { noSkill: manifest.layout.noSkill, noskill: manifest.layout.noskill },
  conditions: { noskill: manifest.conditions.noskill },
  validation: { noskill: validation.noskill },
  records: records.filter((record) => record.condition === "noskill"),
}, null, 2)}\n`);
await writeFile(path.join(outRoot, "README.md"), renderReadme(manifest));
await writeFile(path.join(outRoot, "noskill", "README.md"), renderNoskillReadme(manifest));

console.log(JSON.stringify({
  outRoot,
  taskCount: taskIds.length,
  harborTaskCount: records.length,
  validation,
}, null, 2));

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "-h") {
      parsed.help = true;
      continue;
    }
    if (!value.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${value}`);
    }
    const key = normalizeArgKey(value.slice(2));
    const next = values[index + 1];
    if (next == null || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function normalizeArgKey(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function requireArg(parsed, key, displayName) {
  const value = parsed[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required option ${displayName}.`);
  }
  return value;
}

function requireOneArg(parsed, keys, displayName) {
  for (const key of keys) {
    const value = parsed[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  throw new Error(`Missing required option ${displayName}.`);
}

function renderHelp() {
  return `Usage: node scripts/build-harbor-artifact.mjs --source-tasks-root <path> --single-file-root <path> --progressive-disclosure-root <path> [options]

Build a Harbor task artifact with source-bundle, single-file, progressive-disclosure, and no-skill variants.

Options:
  --source-tasks-root <path>                  Source Harbor task root. Required.
  --single-file-root <path>                   Root containing single-file artifacts. Required.
  --progressive-disclosure-root <path>        Root containing progressive-disclosure artifacts. Required.
  --out-root <path>                           Output artifact root. Default: ${DEFAULT_OUT_ROOT}
  --force                                     Rebuild output root if it already exists.
  --clear-runtime-proxy <bool>                Clear historical Dockerfile proxy defaults. Default: true
  --preinstall-codex <bool>                   Preinstall Codex in generated Dockerfiles. Default: false
  -h, --help                                  Show this help text.

Compatibility aliases:
  --baseline-root -> --single-file-root
  --pd-root -> --progressive-disclosure-root

Camel-case spellings such as --sourceTasksRoot and --outRoot are also accepted.`;
}

async function listTaskIds(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function assertInputs(taskIds, skillsBenchRoot, baselineRootValue, pdRootValue) {
  const missing = [];
  for (const taskId of taskIds) {
    const requiredPaths = [
      path.join(skillsBenchRoot, taskId, "task.toml"),
      path.join(skillsBenchRoot, taskId, "instruction.md"),
      path.join(skillsBenchRoot, taskId, "environment", "Dockerfile"),
      path.join(skillsBenchRoot, taskId, "environment", "skills"),
      path.join(skillsBenchRoot, taskId, "tests", "test.sh"),
      path.join(baselineRootValue, taskId, "baseline", "SKILL.md"),
      path.join(pdRootValue, taskId, "pd", "SKILL.md"),
    ];
    for (const requiredPath of requiredPaths) {
      if (!await exists(requiredPath)) {
        missing.push(requiredPath);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(`Missing required inputs:\n${missing.join("\n")}`);
  }
}

async function copyTreeHardlinked(source, destination) {
  const sourceStat = await lstat(source);
  if (sourceStat.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: sourceStat.mode });
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      await copyTreeHardlinked(path.join(source, entry.name), path.join(destination, entry.name));
    }
    await chmod(destination, sourceStat.mode);
    return;
  }

  if (sourceStat.isSymbolicLink()) {
    await symlink(await readlink(source), destination);
    return;
  }

  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await link(source, destination);
  } catch (error) {
    if (error?.code !== "EXDEV" && error?.code !== "EPERM") {
      throw error;
    }
    await copyFile(source, destination, constants.COPYFILE_FICLONE);
  }
  await chmod(destination, sourceStat.mode);
}

async function rewriteTaskToml(taskTomlPath, harborTaskId, condition) {
  const original = await readFile(taskTomlPath, "utf8");
  const metadata = extractRequiredSectionBlock(original, "metadata");
  const task = extractSectionBlock(original, "task");
  const originalName = extractTomlString(metadata, "name") ?? (task == null ? null : extractTomlString(task, "name")) ?? harborTaskId;
  const updatedName = `${originalName} (${CONDITION_LABELS[condition]})`;
  const updatedMetadata = replaceTomlString(
    replaceTomlString(metadata, "id", harborTaskId),
    "name",
    updatedName,
  );
  const replacements = [updatedMetadata];

  if (task != null) {
    replacements.push(replaceTomlString(
      replaceTomlString(task, "id", harborTaskId),
      "name",
      updatedName,
    ));
  }

  const updated = replacements
    .sort((left, right) => right.start - left.start)
    .reduce((content, replacement) => `${content.slice(0, replacement.start)}${replacement.text}${content.slice(replacement.end)}`, original);

  await unlink(taskTomlPath);
  await writeFile(taskTomlPath, updated);
}

async function rewriteDockerfile(dockerfilePath, options) {
  const original = await readFile(dockerfilePath, "utf8");
  let updated = original;

  if (options.clearRuntimeProxy) {
    if (/^ARG LOCAL_PROXY_URL=.*$/m.test(updated)) {
      updated = updated.replace(/^ARG LOCAL_PROXY_URL=.*$/m, "ARG LOCAL_PROXY_URL=");
    } else if (!updated.includes("SKILL_JUROR_CLEAR_RUNTIME_PROXY")) {
      updated = `${updated.trimEnd()}\n\n# SKILL_JUROR_CLEAR_RUNTIME_PROXY\nENV HTTP_PROXY= HTTPS_PROXY= ALL_PROXY= http_proxy= https_proxy= all_proxy=\n`;
    }
  }

  if (options.preinstallCodex && !updated.includes("SKILL_JUROR_PREINSTALL_CODEX")) {
    updated = `${updated.trimEnd()}\n\n${renderCodexPreinstallDockerBlock()}\n`;
  }

  if (updated !== original) {
    await unlink(dockerfilePath);
    await writeFile(dockerfilePath, updated);
  }
}

function renderCodexPreinstallDockerBlock() {
  return `# SKILL_JUROR_PREINSTALL_CODEX
RUN set -eux; \\
    if command -v apk >/dev/null 2>&1; then \\
      apk add --no-cache bash ca-certificates curl nodejs npm ripgrep; \\
    elif command -v apt-get >/dev/null 2>&1; then \\
      apt-get update; \\
      apt-get install -y ca-certificates curl nodejs npm ripgrep; \\
      rm -rf /var/lib/apt/lists/*; \\
    elif command -v yum >/dev/null 2>&1; then \\
      yum install -y ca-certificates curl nodejs npm ripgrep; \\
    else \\
      echo "No supported package manager found for agent preinstall." >&2; \\
      exit 1; \\
    fi; \\
    mkdir -p /opt/codex /usr/local/bin; \\
    npm config set registry "\${LOCAL_NPM_REGISTRY:-https://registry.npmjs.org/}"; \\
    npm install -g --prefix /opt/codex ${DEFAULT_CODEX_NPM_PACKAGE}; \\
    printf '%s\\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'exec /opt/codex/bin/codex "$@"' > /usr/local/bin/codex; \\
    chmod +x /usr/local/bin/codex; \\
    codex --version`;
}

function extractRequiredSectionBlock(content, sectionName) {
  const section = extractSectionBlock(content, sectionName);
  if (section == null) {
    throw new Error(`task.toml is missing [${sectionName}]`);
  }
  return section;
}

function extractSectionBlock(content, sectionName) {
  const startMatch = new RegExp(`^\\[${escapeRegExp(sectionName)}\\]\\s*$`, "m").exec(content);
  if (startMatch == null) {
    return null;
  }
  const start = startMatch.index + startMatch[0].length;
  const rest = content.slice(start);
  const nextSectionMatch = /^\[[^\]]+\]\s*$/m.exec(rest);
  const end = nextSectionMatch == null ? content.length : start + nextSectionMatch.index;
  return {
    start,
    end,
    text: content.slice(start, end),
  };
}

function extractTomlString(block, key) {
  const match = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*\"((?:[^\"\\\\]|\\\\.)*)\"\\s*$`, "m").exec(block.text);
  return match?.[1] == null ? null : match[1].replace(/\\"/g, "\"");
}

function replaceTomlString(block, key, value) {
  const escapedValue = value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  const pattern = new RegExp(`^(\\s*${escapeRegExp(key)}\\s*=\\s*)\"(?:[^\"\\\\]|\\\\.)*\"(\\s*)$`, "m");
  if (pattern.test(block.text)) {
    return {
      ...block,
      text: block.text.replace(pattern, `$1"${escapedValue}"$2`),
    };
  }

  const prefix = block.text.startsWith("\n") ? "\n" : "";
  const body = block.text.startsWith("\n") ? block.text.slice(1) : block.text;
  return {
    ...block,
    text: `${prefix}${key} = "${escapedValue}"\n${body}`,
  };
}

async function validateArtifact(root, taskIds) {
  const summary = {};
  const allGeneratedIds = new Set();
  for (const condition of ["origin", "baseline", "pd", "noskill"]) {
    const conditionDir = path.join(root, condition);
    const taskDirs = (await readdir(conditionDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    const missing = [];
    let singleSkillCount = 0;
    let totalSkillRoots = 0;
    for (const taskId of taskIds) {
      const harborTaskId = `${taskId}-${condition}`;
      const taskDir = path.join(conditionDir, harborTaskId);
      const required = [
        "task.toml",
        "instruction.md",
        "environment/Dockerfile",
        "environment/skills",
        "tests/test.sh",
      ];
      for (const relativePath of required) {
        if (!await exists(path.join(taskDir, relativePath))) {
          missing.push(`${harborTaskId}/${relativePath}`);
        }
      }
      const taskToml = await readFile(path.join(taskDir, "task.toml"), "utf8");
      const metadata = extractRequiredSectionBlock(taskToml, "metadata");
      const tomlId = extractTomlString(metadata, "id");
      if (tomlId !== harborTaskId) {
        missing.push(`${harborTaskId}/task.toml metadata.id expected ${harborTaskId}, got ${tomlId}`);
      }
      const taskSection = extractSectionBlock(taskToml, "task");
      if (taskSection != null) {
        const taskSectionId = extractTomlString(taskSection, "id");
        if (taskSectionId !== harborTaskId) {
          missing.push(`${harborTaskId}/task.toml task.id expected ${harborTaskId}, got ${taskSectionId}`);
        }
      }
      if (allGeneratedIds.has(harborTaskId)) {
        missing.push(`duplicate generated id ${harborTaskId}`);
      }
      allGeneratedIds.add(harborTaskId);

      const skillRoots = await countSkillRoots(path.join(taskDir, "environment", "skills"));
      totalSkillRoots += skillRoots;
      if (skillRoots === 1) {
        singleSkillCount += 1;
      }
    }
    summary[condition] = {
      taskCount: taskDirs.length,
      expectedTaskCount: taskIds.length,
      missing,
      totalSkillRoots,
      singleSkillTasks: singleSkillCount,
    };
    if (condition === "noskill") {
      summary[condition].emptySkillTasks = taskIds.length - totalSkillRoots;
    }
  }
  return summary;
}

async function countSkillRoots(root) {
  let count = 0;
  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
      count += 1;
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await visit(path.join(dir, entry.name));
      }
    }
  }
  await visit(root);
  return count;
}

async function listIgnoredSourceTasks(sourceTasksRootValue, includedTaskIds) {
  const all = await listTaskIds(sourceTasksRootValue);
  const included = new Set(includedTaskIds);
  return all.filter((taskId) => !included.has(taskId));
}

async function exists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderReadme(manifest) {
  return `# Harbor Task Variants

Generated from source tasks plus single-file and progressive-disclosure skill artifacts.

## Layout

Canonical variant names are shown in the first column. The generated paths use compatibility directory aliases.

| Variant | Compatibility directory alias | Generated task layout | Skill input |
|---------|-------------------------------|-----------------------|-------------|
| Source bundle | \`origin\` | \`origin/<task-id>-origin\` | Source \`environment/skills\` bundle |
| Single-file | \`baseline\` | \`baseline/<task-id>-baseline\` | Single-file skill artifact |
| Progressive disclosure | \`pd\` | \`pd/<task-id>-pd\` | Progressive-disclosure skill artifact |
| No skill | \`noskill\` | \`noskill/<task-id>-noskill\` | Empty \`environment/skills\` directory |

## Counts

| Metric | Value |
|--------|------:|
| Source tasks | ${manifest.sourceTaskCount} |
| Harbor task directories | ${manifest.records.length} |
| Source-bundle tasks | ${manifest.validation.origin.taskCount} |
| Single-file tasks | ${manifest.validation.baseline.taskCount} |
| Progressive-disclosure tasks | ${manifest.validation.pd.taskCount} |
| No-skill tasks | ${manifest.validation.noskill.taskCount} |
| Ignored source tasks | ${manifest.ignoredSourceTasks.length === 0 ? "none" : manifest.ignoredSourceTasks.join(", ")} |

## Generation Options

| Option | Value |
|--------|-------|
| clearRuntimeProxy | ${String(manifest.generationOptions.clearRuntimeProxy)} |
| preinstallCodex | ${String(manifest.generationOptions.preinstallCodex)} |
| codexNpmPackage | ${manifest.generationOptions.codexNpmPackage} |

## Notes

- This artifact uses a compatibility runtime layout: \`<root>/<directory-alias>/<task-id>-<directory-alias>\`.
- Each generated task keeps the user-supplied source task files and non-skill environment files that are required for runtime capture.
- \`origin\` is the directory alias for the source-bundle runtime control.
- \`baseline\` is the directory alias for the single-file variant.
- \`pd\` is the directory alias for the progressive-disclosure variant.
- For \`noskill\`, \`environment/skills\` exists but contains no \`SKILL.md\`.
- Files are generated with hardlinks where possible to avoid duplicating large source inputs and generated skill artifacts on disk.
- \`clearRuntimeProxy=true\` clears historical Dockerfile proxy defaults; pass runtime/build proxies explicitly from the runner when needed.
- See \`manifest.json\` for the generated layout and per-task relative paths.
`;
}

function renderNoskillReadme(manifest) {
  return `# Harbor Tasks: No Skill

Generated as the no-skill variant for the Harbor task artifact.

## Layout

| Variant | Directory | Skill input |
|---------|-----------|-------------|
| No skill | \`noskill/<task-id>-noskill\` | Empty \`environment/skills\` directory |

## Counts

| Metric | Value |
|--------|------:|
| Source tasks | ${manifest.sourceTaskCount} |
| Harbor task directories | ${manifest.validation.noskill.taskCount} |
| Empty skill tasks | ${manifest.validation.noskill.emptySkillTasks} |
| Skill roots | ${manifest.validation.noskill.totalSkillRoots} |

See \`../manifest.noskill.json\` for the generated layout and per-task relative paths.
`;
}
