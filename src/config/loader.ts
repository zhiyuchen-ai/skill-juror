import { readFile } from "fs/promises";
import { resolve } from "path";

import { load } from "js-yaml";

import { ProjectConfigSchema, type ProjectConfig } from "../types/config.js";

export async function loadProjectConfig(
  configPath: string = "config.yaml",
): Promise<ProjectConfig | null> {
  try {
    const fullPath = resolve(configPath);
    const content = await readFile(fullPath, "utf-8");
    return ProjectConfigSchema.parse(load(content));
  } catch (error: unknown) {
    if (isFileNotFoundError(error)) {
      return null;
    }

    throw error;
  }
}

function isFileNotFoundError(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
