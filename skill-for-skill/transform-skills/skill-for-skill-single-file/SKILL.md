---
name: skill-for-skill-single-file
description: "Use when converting a source skill bundle into the Skill Juror single-file format: exactly one flat SKILL.md that preserves helper/script/reference semantics without progressive disclosure or archive metadata."
---

# Skill For Skill Single File

Convert source skills into a normalized single-file skill for Skill Juror runs.

## Inputs And Output

The caller provides task-specific paths. In the Harbor single-file flow these are usually:

- Source skills directory: `/root/source-skills`
- Single-file output root using the compatibility directory alias: `/root/output/baseline`
- Behavior diff tool: `/root/tools/behavior-unit-diff.mjs`

`baseline` is only the compatibility output directory alias for the single-file variant.

Produce exactly one flat skill root. The output root must contain only `SKILL.md`; do not leave scripts, references, templates, nested skill directories, or `skills/` beside it.

## Conversion Rules

Read every source `SKILL.md` and every behavior-relevant support file under the source skills directory.

Preserve all source functional domains in dense, non-progressive-disclosure form. Multiple source skills should become distinct capability sections inside the single `SKILL.md`; keep their tool boundaries, inputs, outputs, warnings, examples, and command contracts concrete. Do not merge multiple source `SKILL.md` files so aggressively that procedure steps, output formats, hard requirements, selection criteria, examples, or decision rules disappear. For bundles made mostly of source `SKILL.md` files, preserve each source skill's operational sections and headings substantially, while removing only structural duplication.

When writing the output YAML description and opening capability summary, preserve the breadth of the source descriptions. Do not narrow a broad source domain to one example trigger. For example, if the source says it organizes files across the computer, the single-file description must not read as though it only handles Downloads cleanup; it must also mention broader folders such as Documents, home directories, project directories, archives, or the equivalent source scope.

Preserve helper files by embedding their usable content directly into natural operational sections of `SKILL.md`:

- For source code, scripts, schemas, config files, `.skill` contract files, and command helpers that actually exist in the source bundle, include the full original text in a fenced block. Treat extensionless files with a shebang such as `#!/usr/bin/env python3` as executable source code.
- Do not append support files as a final archive/dump. Place each support file beside the capability, command, or workflow that uses it.
- Use an operational marker before embedded support content, not archive metadata. Preferred forms are:
  - `Helper implementation for \`path/from/source-skills\``
  - `Helper contract from \`path/from/source-skills\`` for `.skill` contract files
  - `Reference content from \`path/from/source-skills\``
  - `Configuration content from \`path/from/source-skills\``
  - `Template content from \`path/from/source-skills\``
- Do not use bare `Source file:` markers. They are too easy for the final skill to read like a migration archive instead of a usable single-file skill.
- Use headings such as `Helper Implementation`, `Reference Implementation`, or a capability-specific name only for source files that really exist, and keep the heading tied to a user operation.
- For source markdown references, default to embedding the original text verbatim when practical. This is required for API references, pattern catalogs, descriptor lists, schemas, command references, and other dense lookup material where many individual lines carry meaning. If condensing any markdown helper, preserve fenced code/config/schema examples, behavior-critical headings, warnings, commands, schemas, decision rules, field names, thresholds, and examples concretely enough that both behavior-unit diff and style audit stay low risk.
- For README, INSTALLATION, TESTING, CHANGELOG, LICENSE, or other repository-support documents, include only behavior-relevant operational material such as required setup, commands, dependencies, constraints, tests that define expected behavior, schemas, or workflow caveats. Do not paste legal text, project history, broad contributor documentation, or generic repository prose unless a source skill explicitly depends on it.
- For binary support files, include base64 only when required to preserve behavior.
- Empty files, `.gitkeep`, `.gitignore`, and license-only files do not need to be embedded unless a source instruction explicitly depends on their contents.
- If source frontmatter points to a local support file that the flat output cannot include, such as `LICENSE.txt has complete terms`, rewrite the field so it remains true without implying that a missing local file exists. For example, keep `license: Proprietary` rather than preserving a false `LICENSE.txt` reference.

Preserve every source shell command line verbatim. If a command names a helper script path, keep the exact command text and explain that the single-file skill contains the helper code inline, so the agent must recreate that same source-derived helper path from the embedded implementation before running the command.

Because the output artifact contains only one file, do not preserve source-local Markdown links as if those files still exist beside `SKILL.md`. Rewrite links such as `references/foo.md`, `scripts/README.md`, `../../COMMANDS.md`, `docs/bar.md`, or `templates/baz` into plain section references, embedded-content references, or explicit external-resource prose. Local paths may remain when they are command arguments, helper recreation paths, or operational support markers, but not as clickable navigation to files missing from the flat single-file root.

## Prohibitions

Do not invent helper scripts, compatibility helpers, APIs, command implementations, or runnable code that is not present in a source support file. If source markdown mentions a missing script path, preserve the command contract and expected inputs/outputs, but do not synthesize an implementation.

Do not present embedded helper content as an archive, artifact dump, manifest, or verifier record. The final `SKILL.md` must not contain headings or bullets such as `Archived Support Files`, `Archived Support File`, `Encoding`, `Bytes`, `Byte count`, checksums, or other bookkeeping metadata. Source-derived lowercase terms such as XML `encoding` attributes may remain when they are part of embedded operational reference content.

Do not include process prose such as `source reference content follows inline`, `source skill content follows inline`, `archive`, `archival`, `migration`, `generated from`, or `converted from`. The output should read like a normal skill that happens to be flat, not a construction log.

Do not include Markdown links to local files that will not exist in the output root. Since the flat single-file root contains only `SKILL.md`, relative links to `references/`, `scripts/`, `docs/`, `templates/`, `../../...`, or sibling `.md` files are invalid unless rewritten into a same-document anchor that actually exists.

Do not include `baseline`, `conversion`, or `artifact` in generated skill frontmatter, titles, headings, or user-facing prose unless those words appeared in the source skill itself.

Do not copy placeholder paths from caller instructions. Only mention paths that appear in the source bundle or are required output/self-check paths.

Do not rewrite non-script data/config paths into script paths. Preserve exact extensions such as `.json`, `.tsv`, `.txt`, and `.md`; for example, never turn `package.json` into `package.js` or `INFOTABLE.tsv` into `INFOTABLE.ts`.

Do not replace concrete helper scripts, command names, import names, argument names, return fields, schemas, or examples with vague prose.

Local paths are allowed only as original compatibility paths, operational support-file markers, or recreate-this-helper paths. Do not imply external files already exist in the single-file artifact.

If a source command uses an absolute path under a legacy agent skill installation directory or `/root/skills`, preserve that original command as a compatibility note, but provide the preferred recreation path as a relative working-directory path. Do not make writing to a global agent skill installation directory the only execution path.

When explaining a preferred relative helper path, do not restate the old absolute hidden-agent skill directory or `/root/skills/...` path in prose. The absolute path may appear only inside the exact preserved source command/code block. For example, after preserving a source command that appends an absolute skill helper directory to `sys.path`, say `For normal use, recreate the helper under name/scripts and add that directory to sys.path`; do not repeat the old absolute path in explanatory prose.

Do not summarize absolute helper paths with placeholder ellipses. Absolute helper paths may appear only when copied exactly from source commands or source code. The final `SKILL.md` must not contain placeholder absolute skill-root paths ending in `...`.

Do not modify the source skills directory.

## Self Check

After writing `SKILL.md`, run the behavior-unit diff if the tool exists. The candidate path below is the Harbor compatibility output directory for the single-file variant:

```bash
node /root/tools/behavior-unit-diff.mjs --source /root/source-skills --candidate /root/output/baseline --out /root/output/behavior-diff
```

Inspect `/root/output/behavior-diff/report.md`.

- If risk is `high`, revise `SKILL.md` until high-risk semantic loss/addition is gone.
- If risk is `medium`, inspect semantic missing/added samples. Fix real omissions such as missing commands, code, schemas, examples, thresholds, or warnings.
- Do not mechanically reintroduce structural paths/frontmatter or archive metadata just to reduce the diff score.

Also run this compatibility-path sanity check:

```bash
grep -nE '/root/(\.[A-Za-z0-9_-]+/skills|skills)/\.\.\.' /root/output/baseline/SKILL.md
```

This grep must produce no matches. If it matches, replace the placeholder sentence with exact source paths or relative helper recreation paths.

If `/root/tools/single-file-style-audit.mjs` exists, run:

```bash
node /root/tools/single-file-style-audit.mjs --source /root/source-skills --root /root/output/baseline --out /root/output/single-file-style --fail-on-risk
```

If it reports archive markers, old `Source file:` markers, bookkeeping metadata, construction-log prose, or dangling local Markdown links, revise `SKILL.md` until it passes. Keep style audit reports outside the single-file root.

If it reports `markdown helper line coverage too low`, inspect the named source markdown file. For reference catalogs such as SMARTS patterns, API reference pages, descriptor tables, schema docs, or long command guides, embed that source markdown more completely under a normal operational `Reference content from \`...\`` section instead of summarizing it. Do not hide this as an archive; place it in the capability section that uses it.

Keep behavior-diff reports outside the single-file root.
