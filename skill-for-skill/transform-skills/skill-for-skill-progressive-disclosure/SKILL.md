---
name: skill-for-skill-progressive-disclosure
description: "Use when converting a Skill Juror single-file skill into a progressive-disclosure skill: concise SKILL.md, detailed references, and preserved support files without semantic drift."
---

# Skill For Skill Progressive Disclosure

Convert a single-file skill into a progressive-disclosure skill for Skill Juror runs.

## Inputs And Output

The caller provides task-specific paths. In the Harbor progressive-disclosure flow these are usually:

- Source single-file directory: `/root/source-single-file`
- Progressive-disclosure output root using the compatibility directory alias: `/root/output/pd`
- Behavior diff tool: `/root/tools/behavior-unit-diff.mjs`
- Path hygiene tool, with a compatibility script name: `/root/tools/pd-path-hygiene.mjs`

`pd` is only the compatibility output directory alias for the progressive-disclosure variant.

Produce exactly one skill root at the output path. The output root must contain a root `SKILL.md`, a `references/` directory for detailed prose, and any support files that the progressive-disclosure skill still names or needs.

## Conversion Rules

Read the full source single-file `SKILL.md` before writing output.

Make the root `SKILL.md` short and navigation-oriented:

- Preserve source YAML frontmatter fields unless a field would become false after file movement.
- If a frontmatter field points to a local file that will not exist in the progressive-disclosure output, rewrite that field so it remains true without a dangling local-file claim. For example, use `license: Proprietary` rather than `license: Proprietary. LICENSE.txt has complete terms` unless `LICENSE.txt` is actually recreated under the output root.
- Keep `SKILL.md` focused on overview, capability map, critical constraints, and concrete loading triggers.
- Target 150 lines or fewer. If a task has many domains, keep it below 220 lines and move the rest to `references/`.
- Every `references/*.md` file that the agent should use must be named in `SKILL.md` with a concrete trigger: when to open it, why, and what decision or operation it supports.
- If the progressive-disclosure output contains non-code support documents outside `references/`, such as package-local guides, templates, examples, or reference documents, mention those files in the root `SKILL.md` or route to them through an explicitly named reference that explains when to load them. Do not leave qualifying support docs invisible to root navigation.
- Preserve high-value search terms in the root trigger map. If detailed references use domain-specific acronyms, API names, helper command names, file-format terms, or alternate names, include those terms in the root `SKILL.md` near the reference that covers them. The root should be searchable by the terms a user or agent is likely to type, not only by expanded prose names.

Move detailed operational material into `references/`:

- Preserve every functional domain from the source single-file skill.
- Preserve exact commands, code examples, schemas, flags, field names, warnings, thresholds, error messages, and decision rules.
- Do not replace concrete content with vague prose such as "use the helper" or "follow the script".
- It is acceptable to reorganize sections, but not to delete source behavior.

Handle embedded support files from the source single-file skill carefully:

- A source block of the form `Source file: \`path\`` followed by a fenced block represents source-derived support content.
- Newer single-file skills may instead introduce support content with operational markers such as `Helper implementation for \`path\``, `Helper contract from \`path\``, `Reference content from \`path\``, `Configuration content from \`path\``, or `Template content from \`path\`` followed by a fenced block. Treat these exactly like source-derived support content.
- For code, scripts, package/config files, schemas, templates, and executable helpers, recreate the file under the output root at the same relative path whenever the progressive-disclosure output names that path or preserves commands/imports that depend on it.
- Preserve recreated file text exactly, except for line-ending normalization.
- Do not modernize, simplify, "fix", reformat, or clarify recreated code/support-file text. Even small help-string changes count as support-content drift.
- When recreating a code or script file from a fenced source block, write only the fenced body to the file. Do not include the opening or closing Markdown fence, adjacent headings, or following source sections in the executable file.
- Do not replace a source file path with a wrapper, package directory, shim, symlink-like prose, or alternate entrypoint. If the source block says `Source file: \`pkg/scripts/helper.py\``, recreate `pkg/scripts/helper.py` with the exact source text.
- Do not add provenance comments such as `# Source file: ...` into recreated code files unless that line was in the source file text itself.
- For source markdown support content, either move it into an appropriate `references/*.md` file or recreate it at the same relative path if the output names that path.
- If a source `Source file:` block is for an original `SKILL.md`, keep its functional content in a reference file rather than recreating nested skill directories. Preserve functional frontmatter/configuration fields such as `allowed-tools`, `metadata`, and hook definitions when they describe activation, tool access, or automation behavior.

## Prohibitions

Do not modify the source single-file directory.

Do not create nested skill roots or an output `skills/` directory.

Do not write transform metadata such as `notes.json`, `manifest.json`, `validation-errors.json`, rubric JSON, or behavior-diff reports inside the output skill root.

Do not leave dangling local paths. If output prose, commands, or code mention `scripts/...`, `templates/...`, `references/...`, `package.json`, or a local helper import, make the referenced file exist under the output root or rewrite the reference into concrete self-contained content.

Do not invent helper scripts, APIs, command implementations, or runnable code that was not present in the source single-file skill. If the source only mentions a missing helper contract without implementation, preserve the contract in a reference file but do not synthesize implementation code.

Do not include `pd`, `baseline`, `conversion`, or `artifact` in generated skill frontmatter, titles, headings, or user-facing prose unless those words appeared in the source skill itself.

Do not keep template placeholders such as `[describe your task]`, `[specific task related to this skill]`, `[List related skills]`, or generic commands such as `python {} input.txt`. Replace them with concrete examples grounded in the recreated files, or remove them.

## Path Consistency

Source single-file content may contain nested package documentation whose examples use package-relative paths like `scripts/helper.py`, `references/tools.md`, or package-local reference files.

When you preserve that documentation, choose one consistent strategy:

- Recreate the package-relative directory structure so links and commands still resolve from the documented working directory.
- Or rewrite every preserved command/link to the actual output path you created.
- If you rename a reference file, update all internal links to the renamed file or create a short alias reference file at the old path that points to the new one.
- When moving a package-local guide into top-level `references/`, rewrite local links such as `forms.md`, `reference.md`, `ooxml.md`, `scripts/helper.py`, and `references/tools.md` to the actual output-relative paths you created, for example `pdf/forms.md`, `pdf/reference.md`, `docx/ooxml.md`, or `pkg/scripts/helper.py`.
- Do not preserve source-package-relative prose such as "see `ooxml.md`" after moving the text into `references/` unless `references/ooxml.md` actually exists.
- Before finalizing, grep moved reference files for bare sibling links from the source package and verify each one resolves from its new location.
- If a command is meant to be run from a subdirectory, state the working directory directly next to the command.
- If a source package guide is moved into `references/`, do not keep "run from this file's directory" unless the referenced files also exist under `references/`. Rewrite that sentence to the real working directory or rewrite the command to a root-relative canonical path.
- Every command in every Markdown file must be executable from either the skill root or an explicitly stated working directory. Check commands such as `python recalc.py`, `python scripts/helper.py`, `node scripts/helper.js`, and Markdown links like `(scripts/helper.js)`.
- Prefer one canonical execution style for each helper across root `SKILL.md` and its detailed reference. If the helper can be run from the skill root, use the root-relative command everywhere, for example `python xlsx/recalc.py <file>`. Use `cd xlsx && python recalc.py <file>` only when package-local imports or runtime behavior require that working directory, and repeat the working-directory requirement immediately next to every such command.
- Apply the same command-path standard to user-facing `.txt` support files, command contracts, and package docs. A `.txt` file is not exempt from dangling or extensionless helper commands.
- If a helper lives under a package-specific subdirectory, commands in references must name that path from the skill root or clearly state the package subdirectory as the working directory.
- If a preserved command contract refers to a helper from a separate external skill that is not bundled in the progressive-disclosure output, do not present it as a runnable local command. Describe the external command shape in prose and state that the helper is not bundled here.
- If a source warning says not to call an unbundled external binary such as a tool under `bin/`, do not repeat the `bin/...` local path in root `SKILL.md`; refer to the external tool by name or move the detailed warning into a reference with a resolvable working-directory context.
- Treat hidden-agent tool paths, home-directory skill install paths, and bare `scripts/...` paths as local runnable helpers only when the exact files are recreated under the output root. If those files are external tooling or command contracts, rewrite fenced shell commands into prose that names the optional tool behavior instead of leaving unresolved commands.
- Prefer external tool names, package-manager commands, or optional external-tool descriptions over unresolved legacy tool scripts unless those scripts are actually bundled in the progressive-disclosure output.
- Prefer rewriting commands to the canonical recreated path over adding duplicate compatibility copies.
- Do not create two executable copies of the same source helper, such as both `pdf/scripts/helper.py` and `scripts/helper.py`, unless the source baseline actually contained both files.
- Do not create extensionless executable aliases for source files that have an extension. If source prose says `python scripts/helper` but the source file is `pkg/scripts/helper.py`, rewrite the command to `python pkg/scripts/helper.py`.
- Do not satisfy an extensionless command by creating a package directory such as `scripts/helper/__main__.py` or a wrapper script. Use the source file path with its real extension instead.
- Apply path hygiene silently. Do not put user-facing notes such as "compatibility warning", "alias", "path hygiene", or "conversion rule" in the final skill just to explain why a command path was canonicalized. Present the canonical command as the normal command.
- Remove extensionless duplicate reference files when an equivalent `.md` reference exists. Root `SKILL.md` should point to the `.md` reference.
- Remove extensionless duplicate script files when a canonical `.py`, `.js`, or `.sh` source file exists. Never leave placeholder scripts with TODO bodies as runnable helpers.
- Do not leave old local agent install paths; rewrite them to the actual recreated package directory under the PD skill root.
- Do not leave stale absolute skill roots such as `/mnt/skills/...`, hidden-agent skill directories, or `/root/skills/...` in examples. Rewrite examples to skill-root-relative paths or clearly user-supplied paths.
- Do not include conversion/provenance prose such as "inline source blocks", "Source content from", "source has been recreated", or similar bookkeeping. The final skill should read like a normal usable skill, not a migration report.
- Avoid split artifacts: no bare `#` headings, no duplicated adjacent headings, no section heading left empty at end of file, and no unclosed inline-code backticks in prose.

Before returning, search the output for `scripts/`, `templates/`, `references/`, `docs/`, and package-local helper paths. Fix any path that would not resolve either from the skill root or from the explicitly stated working directory.

If you run Python helpers or tests while validating the output, remove interpreter caches from the compatibility output directory before final checks:

```bash
find /root/output/pd -type d -name __pycache__ -prune -exec rm -rf {} +
find /root/output/pd -type f -name '*.pyc' -delete
```

If `/root/tools/pd-path-hygiene.mjs` exists, run it against the compatibility output directory:

```bash
node /root/tools/pd-path-hygiene.mjs --root /root/output/pd --out /root/output/path-hygiene --fail-on-risk
```

If it reports duplicate top-level/nested helper copies, extensionless aliases, or `__pycache__` files, revise the output and rerun the check until it passes. Do not keep the `path-hygiene` report inside the final progressive-disclosure root.

## Self Check

After writing the progressive-disclosure output, run the behavior-unit diff if the tool exists. The candidate path below is the Harbor compatibility output directory for the progressive-disclosure variant:

```bash
node /root/tools/behavior-unit-diff.mjs --source /root/source-single-file --candidate /root/output/pd --out /root/output/behavior-diff
```

Inspect `/root/output/behavior-diff/report.md`.

- If risk is `high`, revise the progressive-disclosure output until high-risk semantic loss/addition is gone.
- If risk is `medium`, inspect semantic missing/added samples. Fix real omissions such as missing commands, code, schemas, examples, thresholds, or warnings.
- Do not mechanically copy everything back into `SKILL.md`; preserve progressive disclosure by moving details into `references/` or support files.

Run a path sanity check before returning: every local file path mentioned by the output should exist under the progressive-disclosure output root, except obvious external package/module paths or paths that are explicitly user-supplied placeholders.

Keep behavior-diff reports outside the progressive-disclosure skill root.
