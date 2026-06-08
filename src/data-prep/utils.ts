import { cp, mkdir, readFile, stat, writeFile } from "fs/promises";
import { dirname, relative, resolve, sep } from "path";

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(targetPath: string): Promise<void> {
  await mkdir(targetPath, { recursive: true });
}

export async function copyDirectory(sourcePath: string, targetPath: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  await cp(sourcePath, targetPath, { recursive: true, force: true });
}

export async function writeJson(targetPath: string, value: unknown): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readText(targetPath: string): Promise<string> {
  return readFile(targetPath, "utf8");
}

export function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function relativeArtifactPath(rootDir: string, targetPath: string): string {
  const relativePath = relative(rootDir, targetPath);
  return relativePath.length === 0 ? "." : toPosixPath(relativePath);
}

export function publicRegistryLabel(registry: string, defaultRegistry: string): string {
  return registry === defaultRegistry ? defaultRegistry : "<configured>";
}

export function ensureInsideRoot(rootDir: string, relativePath: string): string {
  const normalizedRelative = relativePath.replace(/^[\\/]+/, "");
  const absolutePath = resolve(rootDir, normalizedRelative);
  const normalizedRoot = `${resolve(rootDir)}${sep}`;
  if (absolutePath !== resolve(rootDir) && !absolutePath.startsWith(normalizedRoot)) {
    throw new Error(`Refusing to write outside output root: ${relativePath}`);
  }
  return absolutePath;
}

export function sanitizeId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function extractJsonBlock(input: string): string {
  const fencedMatch = input.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1] != null) {
    return extractBalancedJson(fencedMatch[1].trim());
  }

  const firstBrace = input.indexOf("{");
  const firstBracket = input.indexOf("[");
  const startIndexCandidates = [firstBrace, firstBracket].filter((value) => value >= 0);
  if (startIndexCandidates.length === 0) {
    return input.trim();
  }

  const startIndex = Math.min(...startIndexCandidates);
  return extractBalancedJson(input.slice(startIndex).trim());
}

function extractBalancedJson(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }

  const opening = trimmed[0];
  if (opening !== "{" && opening !== "[") {
    return trimmed;
  }

  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      if (inString) {
        escaped = true;
      }
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === opening) {
      depth += 1;
      continue;
    }

    if (char === closing) {
      depth -= 1;
      if (depth === 0) {
        return trimmed.slice(0, index + 1);
      }
    }
  }

  return trimmed;
}
