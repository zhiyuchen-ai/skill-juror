import { readFile } from "fs/promises";
import { join } from "path";
import type { HarborJobResult, HarborTrajectoryArtifact, HarborTrialResult } from "../types/harbor.js";

async function readJson<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

export async function readHarborJobResult(jobDir: string): Promise<HarborJobResult> {
  return readJson<HarborJobResult>(join(jobDir, "result.json"));
}

export async function readHarborTrialResult(trialDir: string): Promise<HarborTrialResult> {
  return readJson<HarborTrialResult>(join(trialDir, "result.json"));
}

export async function readHarborTrajectory(trialDir: string): Promise<HarborTrajectoryArtifact> {
  return readJson<HarborTrajectoryArtifact>(join(trialDir, "agent", "trajectory.json"));
}
