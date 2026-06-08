export type ArtifactProfile = "debug";

export interface SkillCandidate {
  id: string;
  label: string | null;
  skillDir: string;
  skillDetection?: {
    enabled: boolean;
  };
}
