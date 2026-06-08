import { readFile, stat } from "fs/promises";
import { join } from "path";

export async function validateMaterializedHarborTask(
  taskDir: string,
): Promise<void> {
  const issues: string[] = [];
  const taskTomlPath = join(taskDir, "task.toml");
  const taskToml = await readRequiredTextFile(taskTomlPath, issues, "task.toml");

  await requireFile(join(taskDir, "instruction.md"), issues, "instruction.md");
  await requireDirectory(join(taskDir, "environment"), issues, "environment/");
  await requireFile(join(taskDir, "environment", "Dockerfile"), issues, "environment/Dockerfile");
  await requireDirectory(join(taskDir, "environment", "skills"), issues, "environment/skills/");
  await requireFile(join(taskDir, "tests", "test.sh"), issues, "tests/test.sh");

  if (taskToml !== null) {
    issues.push(...findDuplicateTomlEntries(taskToml));
    const taskName = readTomlStringFromSection(taskToml, "task", "name");
    if (taskName !== null && !isValidHarborPackageName(taskName)) {
      issues.push(`[task].name must be a Harbor package name like "org/name", got: ${JSON.stringify(taskName)}`);
    }

    const dockerImage = readTomlStringFromSection(taskToml, "environment", "docker_image");
    if (dockerImage === null || dockerImage.length === 0) {
      issues.push("[environment].docker_image is required before Harbor submission");
    }

    const skillsDir = readTomlStringFromSection(taskToml, "environment", "skills_dir");
    if (skillsDir !== null && !skillsDir.startsWith("/")) {
      issues.push(`[environment].skills_dir must be an absolute container path, got: ${JSON.stringify(skillsDir)}`);
    }
  }

  if (issues.length > 0) {
    throw new Error(`Direct Harbor task precheck failed for ${taskDir}:\n- ${issues.join("\n- ")}`);
  }
}

async function readRequiredTextFile(path: string, issues: string[], label: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    issues.push(`missing required file: ${label}`);
    return null;
  }
}

async function requireFile(path: string, issues: string[], label: string): Promise<void> {
  try {
    const stats = await stat(path);
    if (!stats.isFile()) {
      issues.push(`expected file: ${label}`);
    }
  } catch {
    issues.push(`missing required file: ${label}`);
  }
}

async function requireDirectory(path: string, issues: string[], label: string): Promise<void> {
  try {
    const stats = await stat(path);
    if (!stats.isDirectory()) {
      issues.push(`expected directory: ${label}`);
    }
  } catch {
    issues.push(`missing required directory: ${label}`);
  }
}

function findDuplicateTomlEntries(toml: string): string[] {
  const issues: string[] = [];
  const seenSections = new Set<string>();
  const seenKeys = new Set<string>();
  let section = "";

  toml.split(/\r?\n/).forEach((line, index) => {
    const stripped = stripTomlComment(line).trim();
    if (stripped.length === 0) {
      return;
    }

    const sectionMatch = /^\[([A-Za-z0-9_.-]+)\]$/.exec(stripped);
    if (sectionMatch?.[1] != null) {
      section = sectionMatch[1];
      if (seenSections.has(section)) {
        issues.push(`duplicate TOML section [${section}] at line ${index + 1}`);
      }
      seenSections.add(section);
      return;
    }

    const keyMatch = /^([A-Za-z0-9_.-]+)\s*=/.exec(stripped);
    if (keyMatch?.[1] == null) {
      return;
    }

    const fullKey = `${section}.${keyMatch[1]}`;
    if (seenKeys.has(fullKey)) {
      issues.push(`duplicate TOML key ${formatTomlKey(section, keyMatch[1])} at line ${index + 1}`);
    }
    seenKeys.add(fullKey);
  });

  return issues;
}

function readTomlStringFromSection(toml: string, targetSection: string, key: string): string | null {
  let section = "";
  for (const line of toml.split(/\r?\n/)) {
    const stripped = stripTomlComment(line).trim();
    const sectionMatch = /^\[([A-Za-z0-9_.-]+)\]$/.exec(stripped);
    if (sectionMatch?.[1] != null) {
      section = sectionMatch[1];
      continue;
    }
    if (section !== targetSection) {
      continue;
    }

    const keyMatch = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*"([^"]*)"`).exec(stripped);
    if (keyMatch?.[1] != null) {
      return keyMatch[1];
    }
  }
  return null;
}

function isValidHarborPackageName(value: string): boolean {
  const parts = value.split("/");
  if (parts.length !== 2) {
    return false;
  }

  return parts.every((part) => (
    /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(part)
    && !part.includes("..")
  ));
}

function stripTomlComment(line: string): string {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\\" && inDoubleQuote && !escaped) {
      escaped = true;
      continue;
    }
    if (char === "'" && !inDoubleQuote && !escaped) {
      inSingleQuote = !inSingleQuote;
    } else if (char === "\"" && !inSingleQuote && !escaped) {
      inDoubleQuote = !inDoubleQuote;
    } else if (char === "#" && !inSingleQuote && !inDoubleQuote) {
      return line.slice(0, index);
    }
    escaped = false;
  }

  return line;
}

function formatTomlKey(section: string, key: string): string {
  return section.length === 0 ? key : `[${section}].${key}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
