---
name: skill-for-skill-flatten-source
description: "Use when converting a source multi-skill bundle into the Skill Juror flatten-source condition: preserve the original skill roots and names while making every skill root a single SKILL.md."
---

# Skill For Skill Flatten Source

Convert a source skill bundle into a flatten-source bundle for Skill Juror runs.

## Inputs And Output

The caller provides task-specific paths. In the Harbor flatten-source flow these are usually:

- Source skills directory: `/root/source-skills`
- Flatten-source bundle output root using the compatibility directory alias: `/root/output/origin-flat`
- Flatten-source skills output directory using the same compatibility alias: `/root/output/origin-flat/skills`
- Behavior diff tool: `/root/tools/behavior-unit-diff.mjs`

`origin-flat` is only the compatibility output directory alias for the flatten-source variant.

Produce one output skill root for every direct source skill root under `/root/source-skills`. The output skill root names must exactly match the source skill root names. Each output skill root must contain only `SKILL.md`; do not leave scripts, references, templates, nested skill directories, helper files, metadata, logs, or behavior-diff reports inside any output skill root.

## Conversion Rules

Process each source skill independently. Do not merge different source skills into one skill, and do not move support files from one source skill into another skill.

For every source skill:

- Read its `SKILL.md` and every behavior-relevant support file below that same skill root.
- Preserve the source frontmatter and operational identity unless a field would become false after flattening.
- Preserve procedure steps, commands, required inputs, required outputs, examples, warnings, schemas, field names, thresholds, selection criteria, and failure handling.
- Preserve every source shell command line verbatim. If a command names a helper script path, keep the exact command text and explain that this flatten-source skill contains the helper code inline, so the agent must recreate the same source-derived helper path from the embedded implementation before running that command.
- Keep local path references concrete. If a source path is preserved but the file no longer exists beside `SKILL.md`, state that the path is a source-derived recreation path from embedded content.

Preserve support files by embedding their usable content directly into the same skill's `SKILL.md`:

- For source code, scripts, schemas, config files, templates, command helpers, and extensionless executable files with shebangs, include the full original text in a fenced block.
- Add a natural operational marker before embedded support content, such as `Support content from \`path/from/this/source-skill\``.
- For source markdown references, default to embedding the original text verbatim when practical. If condensing, preserve every fenced block verbatim and keep behavior-critical headings, warnings, commands, schemas, decision rules, field names, thresholds, and examples concrete.
- For binary support files, include base64 only when required to preserve behavior.
- Empty files, `.gitkeep`, `.gitignore`, and license-only files do not need to be embedded unless a source instruction explicitly depends on their contents.

## Prohibitions

Do not invent helper scripts, compatibility helpers, APIs, command implementations, or runnable code that is not present in the source skill. If source markdown mentions a missing script path, preserve the command contract and expected inputs/outputs, but do not synthesize an implementation.

Do not present embedded helper content as an archive, artifact dump, manifest, verifier record, or conversion log. The final `SKILL.md` must not contain headings or bullets such as `Archived Support Files`, `Archived Support File`, `Encoding`, `Bytes`, `Byte count`, checksums, or other bookkeeping metadata. Source-derived lowercase terms such as XML `encoding` attributes may remain when they are part of embedded operational reference content.

Do not include `origin-flat`, `baseline`, `pd`, `conversion`, or `artifact` in generated skill frontmatter, titles, headings, or user-facing prose unless those words appeared in the source skill itself.

Do not copy placeholder paths from caller instructions. Only mention paths that appear in the source skill or are required output/self-check paths.

Do not rewrite non-script data/config paths into script paths. Preserve exact extensions such as `.json`, `.tsv`, `.txt`, and `.md`; for example, never turn `package.json` into `package.js` or `INFOTABLE.tsv` into `INFOTABLE.ts`.

Do not replace concrete helper scripts, command names, import names, argument names, return fields, schemas, or examples with vague prose.

Do not modify `/root/source-skills`.

## Self Check

After writing all output skills, verify the structure under the compatibility output directory:

```bash
find /root/output/origin-flat/skills -mindepth 2 -type f ! -name SKILL.md
```

This command must print no files.

For each source skill root, run the behavior-unit diff if the tool exists. The candidate path below is the Harbor compatibility output directory for the flatten-source variant:

```bash
node /root/tools/behavior-unit-diff.mjs --source /root/source-skills/<skill-name> --candidate /root/output/origin-flat/skills/<skill-name> --out /root/output/behavior-diff/<skill-name>
```

Inspect each `report.md`.

- If risk is `high`, revise that skill's `SKILL.md` until high-risk semantic loss/addition is gone.
- If risk is `medium`, inspect semantic missing/added samples. Fix real omissions such as missing commands, code, schemas, examples, thresholds, or warnings.
- Do not mechanically reintroduce support files or archive metadata just to reduce the diff score.

Keep behavior-diff reports outside `/root/output/origin-flat/skills`.
