import { readdir } from "fs/promises";
import { join, resolve } from "path";

import { pathExists, sanitizeId } from "./utils.js";

export interface SourceTarget {
  id: string;
  kind: "skill" | "bundle";
  path: string;
  skillPaths: string[];
}

export interface ResolvedSkillDir {
  id: string;
  path: string;
}

export interface ResolvedTaskBundle {
  taskId: string;
  taskDir: string;
  bundleDir: string;
  skills: ResolvedSkillDir[];
}

export async function resolveTaskBundle(taskRef: string, cwd = process.cwd()): Promise<ResolvedTaskBundle> {
  const directPath = resolve(cwd, taskRef);
  const taskDir = await pathExists(directPath)
    ? directPath
    : resolve(cwd, "tasks", taskRef);
  const bundleDir = resolve(taskDir, "environment", "skills");

  if (!await pathExists(bundleDir)) {
    throw new Error(`Skills bundle not found: ${bundleDir}`);
  }

  const taskId = sanitizeId(taskDir.split(/[\\/]/).at(-1) ?? taskRef);
  const skills = await listSkillDirs(bundleDir);
  if (skills.length === 0) {
    throw new Error(`No skills found under bundle directory: ${bundleDir}`);
  }

  return {
    taskId,
    taskDir,
    bundleDir,
    skills,
  };
}

export async function listSkillDirs(bundleDir: string): Promise<ResolvedSkillDir[]> {
  const entries = await readdir(bundleDir, { withFileTypes: true });
  const skills: ResolvedSkillDir[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillDir = join(bundleDir, entry.name);
    const skillFile = join(skillDir, "SKILL.md");
    if (await pathExists(skillFile)) {
      skills.push({ id: entry.name, path: skillDir });
    }
  }

  return skills.sort((left, right) => left.id.localeCompare(right.id));
}

export async function resolveTargetPath(targetPath: string): Promise<SourceTarget> {
  const absolutePath = resolve(targetPath);
  const skillFile = join(absolutePath, "SKILL.md");
  if (await pathExists(skillFile)) {
    return {
      id: sanitizeId(absolutePath.split(/[\\/]/).at(-1) ?? "skill"),
      kind: "skill",
      path: absolutePath,
      skillPaths: [absolutePath],
    };
  }

  const nestedSkills = await listSkillDirs(absolutePath);
  if (nestedSkills.length > 0) {
    return {
      id: sanitizeId(absolutePath.split(/[\\/]/).at(-1) ?? "bundle"),
      kind: "bundle",
      path: absolutePath,
      skillPaths: nestedSkills.map((entry) => entry.path),
    };
  }

  const nestedSkillsDir = join(absolutePath, "skills");
  if (await pathExists(nestedSkillsDir)) {
    const skills = await listSkillDirs(nestedSkillsDir);
    if (skills.length > 0) {
      return {
        id: sanitizeId(absolutePath.split(/[\\/]/).at(-1) ?? "bundle"),
        kind: "bundle",
        path: absolutePath,
        skillPaths: skills.map((entry) => entry.path),
      };
    }
  }

  throw new Error(`Target path is neither a skill directory nor a bundle directory: ${absolutePath}`);
}
