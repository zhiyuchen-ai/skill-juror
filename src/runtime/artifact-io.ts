import { readFile, writeFile } from "fs/promises";
import { resolve } from "path";

import type { TrialResult } from "../types/result.js";

export async function writeSkillTraceArtifact(outputDir: string, results: TrialResult[]): Promise<void> {
  const sections: string[] = [];

  for (const result of results) {
    const tracePath = resolve(outputDir, result.trialId, "trace.txt");
    const traceContent = await readOptionalFile(tracePath);
    if (traceContent == null || traceContent.trim().length === 0) {
      continue;
    }

    sections.push(`=== Trial ${result.trialId} ===\n${traceContent.trimEnd()}\n`);
  }

  if (sections.length === 0) {
    return;
  }

  await writeFile(resolve(outputDir, "trace.txt"), `${sections.join("\n")}\n`);
}

export async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export function parseJsonText(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
