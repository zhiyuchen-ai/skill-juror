# SkillJuror Runtime Toolkit

This toolkit accompanies the paper "SkillJuror: Measuring How Agent Skill Organization Changes Runtime Behavior."

This repository contains the public data-preparation and runtime-capture components for SkillJuror. The included code prepares skill variants for Harbor runs and executes those variants with Codex or Claude Code until the terminal runtime artifact, `trajectory.json`, is produced.

Source Harbor tasks and source skill bundles are supplied by the user. Evaluation, judging, aggregate reporting, and result-viewer components are outside the current release scope; we plan to publish additional modules in future releases.

## Included Modules

- `src/data-prep/`: Harbor construction flows for public skill variants.
- `skill-for-skill/transform-skills/`: generic transform skills used by the construction flows.
- `scripts/`: self-check utilities and a runtime-ready Harbor task artifact builder.
- `src/runtime/`: direct Harbor runtime orchestration that persists `trajectory.json`.
- `src/harbor/` and `harbor_ext/`: Harbor job submission, result reading, and Codex/Claude Code Harbor agent adapters.

## Variant Names

The public variant names are:

- `single-file`: a skill represented as one `SKILL.md` file. Compatibility alias: `baseline`.
- `progressive-disclosure`: a skill with a compact entrypoint and references. Compatibility alias: `pd`.
- `flatten-source`: a source skill bundle flattened for comparison. Compatibility alias: `origin-flat`.

The runtime artifact builder can also materialize `source-bundle` and `no-skill` controls. Their directory aliases are `origin` and `noskill`.

## Requirements

- Node.js 20+ and npm.
- Harbor CLI and Docker for construction and runtime jobs.
- A runtime API key exposed through the environment variable named by `apiKeyEnvVar` in `config.yaml`.
- A `config.yaml` based on `config.example.yaml`.
- User-supplied source Harbor tasks and source skill bundles.

## Setup

```bash
npm install
cp config.example.yaml config.yaml
npm run type-check
```

`config.yaml` selects the Harbor agent adapter and runtime provider. For Codex runs, the toolkit generates a Codex `config.toml` inside Harbor with full task-sandbox permissions by default. The default package registry is `https://registry.npmjs.org/`; configure a mirror only when your local network requires one. Do not put API keys directly in `config.yaml`; use `apiKeyEnvVar`.

## Data Preparation

Build a single-file skill variant from a source task bundle:

```bash
npm run construct -- single-file --task <task-id-or-path> --tasks-root <source-task-root> --out artifacts/single-file
```

Build a progressive-disclosure skill variant from a single-file skill:

```bash
npm run construct -- progressive-disclosure --single-file-root <single-file-skill-root> --out artifacts/progressive-disclosure
```

The current compatibility layout stores generated single-file skills under `<task-id>/baseline`.

Flatten a source skill bundle:

```bash
npm run construct -- flatten-source --task <task-id-or-path> --tasks-root <source-task-root> --out artifacts/flatten-source
```

Build runtime-ready Harbor task variants from prepared artifacts:

```bash
npm run build-harbor-artifact -- \
  --source-tasks-root <source-task-root> \
  --single-file-root <single-file-run-root> \
  --progressive-disclosure-root <progressive-disclosure-run-root> \
  --out-root artifacts/harbor-tasks \
  --force
```

## Runtime Capture

Run materialized Harbor tasks and persist runtime artifacts:

```bash
npm run run -- \
  --task-id <task-id> \
  --harbor-task-root artifacts/harbor-tasks \
  --variants single-file,progressive-disclosure \
  --config config.yaml \
  --provider codex-runtime \
  --output runs/<task-id>
```

For Claude Code, switch `harbor.agentImportPath` to `harbor_ext.claude_code_cached:ClaudeCodeCached` and use an Anthropic-compatible provider profile, such as `claude-code-runtime` in `config.example.yaml`.

Runtime capture records trajectories only. Verification and judging belong to the evaluation modules planned for future release. The expected terminal artifact is:

```text
runs/<task-id>/<variant>/trial-0/trajectory.json
```
