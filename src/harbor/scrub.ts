import { readdir, rm } from "fs/promises";
import { join } from "path";

const SENSITIVE_HARBOR_FILENAMES = new Set([
  ".env",
  ".npmrc",
  "auth.json",
  "config.toml",
]);

export async function scrubHarborJobSensitiveFiles(rootDir: string): Promise<void> {
  try {
    await scrubDirectory(rootDir);
  } catch (error: unknown) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }
}

async function scrubDirectory(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await scrubDirectory(entryPath);
      continue;
    }
    if (entry.isFile() && SENSITIVE_HARBOR_FILENAMES.has(entry.name)) {
      await rm(entryPath, { force: true });
    }
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === "object"
    && error != null
    && "code" in error
    && error.code === "ENOENT";
}
