#!/usr/bin/env node
import { createHash } from "crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "path";

const USAGE = `progressive-disclosure-path-hygiene

Usage:
  node scripts/pd-path-hygiene.mjs --root <progressive-disclosure-root-or-run-root> --out <out-dir> [--fail-on-risk]

The script filename is retained as a compatibility name.

Checks:
  - __pycache__/ and *.pyc files inside progressive-disclosure artifacts
  - extensionless helper aliases that duplicate a same-directory .py file
  - exact duplicate helper copies between top-level scripts/ and nested */scripts/
  - Markdown/text command paths that do not resolve from their stated working directory
  - stale local skill paths and conversion/provenance prose in user-facing docs
  - extensionless placeholder scripts and duplicate extensionless reference files
  - Markdown code fences accidentally written into executable script files
`;

const args = parseArgs(process.argv.slice(2));
if (args.help || args.root == null) {
  console.log(USAGE);
  process.exit(args.root == null ? 1 : 0);
}

const root = resolve(args.root);
const outDir = args.out != null ? resolve(args.out) : null;
const roots = await resolvePdRoots(root);
const taskReports = [];
for (const pdRoot of roots) {
  taskReports.push(await scanPdRoot(pdRoot));
}

const affected = taskReports.filter((report) => report.risk !== "low");
const summary = {
  schemaVersion: "progressive-disclosure-path-hygiene/v1",
  generatedAt: new Date().toISOString(),
  root,
  taskCount: taskReports.length,
  affectedTaskCount: affected.length,
  topNestedDupTaskCount: taskReports.filter((report) => report.topNestedDuplicates.length > 0).length,
  extensionlessAliasTaskCount: taskReports.filter((report) => report.extensionlessAliases.length > 0).length,
  extensionlessScriptConflictTaskCount: taskReports.filter((report) => report.extensionlessScriptConflicts.length > 0).length,
  placeholderScriptTaskCount: taskReports.filter((report) => report.placeholderScripts.length > 0).length,
  extensionlessReferenceDuplicateTaskCount: taskReports.filter((report) => report.extensionlessReferenceDuplicates.length > 0).length,
  scriptCodeFenceTaskCount: taskReports.filter((report) => report.scriptCodeFenceArtifacts.length > 0).length,
  scriptCodeFenceIssueCount: sumIssueCount(taskReports, "scriptCodeFenceArtifacts"),
  unresolvedCommandTaskCount: taskReports.filter((report) => report.unresolvedCommandPaths.length > 0).length,
  unresolvedCommandIssueCount: sumIssueCount(taskReports, "unresolvedCommandPaths"),
  extensionlessCommandTaskCount: taskReports.filter((report) => report.extensionlessCommandTargets.length > 0).length,
  extensionlessCommandIssueCount: sumIssueCount(taskReports, "extensionlessCommandTargets"),
  brokenMarkdownLinkTaskCount: taskReports.filter((report) => report.brokenMarkdownLinks.length > 0).length,
  brokenMarkdownLinkIssueCount: sumIssueCount(taskReports, "brokenMarkdownLinks"),
  staleLocalPathTaskCount: taskReports.filter((report) => report.staleLocalPaths.length > 0).length,
  staleLocalPathIssueCount: sumIssueCount(taskReports, "staleLocalPaths"),
  provenanceLeakTaskCount: taskReports.filter((report) => report.provenanceLeaks.length > 0).length,
  provenanceLeakIssueCount: sumIssueCount(taskReports, "provenanceLeaks"),
  headingArtifactTaskCount: taskReports.filter((report) => report.headingArtifacts.length > 0).length,
  headingArtifactIssueCount: sumIssueCount(taskReports, "headingArtifacts"),
  pycacheTaskCount: taskReports.filter((report) => report.pycacheFiles.length > 0).length,
  tasks: taskReports,
};

if (outDir != null) {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "report.json"), JSON.stringify(summary, null, 2) + "\n");
  await writeFile(join(outDir, "report.md"), renderMarkdown(summary));
}

console.log(renderConsoleSummary(summary));
if (args.failOnRisk && affected.length > 0) {
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = { root: null, out: null, failOnRisk: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      parsed.root = argv[++index];
    } else if (arg === "--out") {
      parsed.out = argv[++index];
    } else if (arg === "--fail-on-risk") {
      parsed.failOnRisk = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

async function resolvePdRoots(inputRoot) {
  if (await isFile(join(inputRoot, "SKILL.md"))) {
    return [inputRoot];
  }
  const entries = await readdir(inputRoot, { withFileTypes: true });
  const roots = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const directCandidate = join(inputRoot, entry.name);
    if (await isFile(join(directCandidate, "SKILL.md"))) {
      roots.push(directCandidate);
      continue;
    }
    const nestedCandidate = join(inputRoot, entry.name, "pd");
    if (await isFile(join(nestedCandidate, "SKILL.md"))) {
      roots.push(nestedCandidate);
    }
  }
  return roots.sort();
}

async function scanPdRoot(pdRoot) {
  const files = await listFiles(pdRoot);
  const relFiles = files.map((file) => relative(pdRoot, file).split("\\").join("/"));
  const relSet = new Set(relFiles);
  const pycacheFiles = relFiles.filter((rel) => rel.includes("__pycache__/") || rel.endsWith(".pyc"));
  const extensionlessAliases = await findExtensionlessAliases(pdRoot, relFiles);
  const extensionlessScriptConflicts = await findExtensionlessScriptConflicts(pdRoot, relFiles);
  const placeholderScripts = await findPlaceholderScripts(pdRoot, relFiles);
  const topNestedDuplicates = await findTopNestedDuplicates(pdRoot, relFiles);
  const extensionlessReferenceDuplicates = findExtensionlessReferenceDuplicates(relFiles);
  const scriptCodeFenceArtifacts = await findScriptCodeFenceArtifacts(pdRoot, relFiles);
  const markdownPathReport = await findMarkdownPathIssues(pdRoot, relFiles, relSet);
  const textArtifactReport = await findUserFacingTextArtifacts(pdRoot, relFiles);
  const risk =
    pycacheFiles.length > 0 ||
    extensionlessAliases.length > 0 ||
    extensionlessScriptConflicts.length > 0 ||
    placeholderScripts.length > 0 ||
    topNestedDuplicates.length > 0 ||
    extensionlessReferenceDuplicates.length > 0 ||
    scriptCodeFenceArtifacts.length > 0 ||
    markdownPathReport.unresolvedCommandPaths.length > 0 ||
    markdownPathReport.extensionlessCommandTargets.length > 0 ||
    markdownPathReport.brokenMarkdownLinks.length > 0 ||
    textArtifactReport.staleLocalPaths.length > 0 ||
    textArtifactReport.provenanceLeaks.length > 0 ||
    textArtifactReport.headingArtifacts.length > 0
      ? "high"
      : "low";
  return {
    taskId: inferTaskId(pdRoot),
    pdRoot,
    risk,
    pycacheFiles,
    extensionlessAliases,
    extensionlessScriptConflicts,
    placeholderScripts,
    topNestedDuplicates,
    extensionlessReferenceDuplicates,
    scriptCodeFenceArtifacts,
    unresolvedCommandPaths: markdownPathReport.unresolvedCommandPaths,
    extensionlessCommandTargets: markdownPathReport.extensionlessCommandTargets,
    brokenMarkdownLinks: markdownPathReport.brokenMarkdownLinks,
    staleLocalPaths: textArtifactReport.staleLocalPaths,
    provenanceLeaks: textArtifactReport.provenanceLeaks,
    headingArtifacts: textArtifactReport.headingArtifacts,
  };
}

async function listFiles(base) {
  const output = [];
  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        output.push(full);
      }
    }
  }
  await visit(base);
  return output.sort();
}

async function findExtensionlessAliases(pdRoot, relFiles) {
  const relSet = new Set(relFiles);
  const aliases = [];
  for (const rel of relFiles) {
    if (rel.includes("__pycache__/") || extname(rel) !== "") {
      continue;
    }
    const pyRel = `${rel}.py`;
    if (!relSet.has(pyRel)) {
      continue;
    }
    const [aliasHash, pyHash] = await Promise.all([
      hashFile(join(pdRoot, rel)),
      hashFile(join(pdRoot, pyRel)),
    ]);
    if (aliasHash === pyHash) {
      aliases.push({ alias: rel, canonical: pyRel });
    }
  }
  return aliases;
}

async function findExtensionlessScriptConflicts(pdRoot, relFiles) {
  const conflicts = [];
  const relSet = new Set(relFiles);
  for (const rel of relFiles) {
    if (!isScriptDirFile(rel) || rel.includes("__pycache__/") || extname(rel) !== "") {
      continue;
    }
    const siblingPaths = relFiles.filter((candidate) => {
      return (
        dirname(candidate) === dirname(rel) &&
        candidate !== rel &&
        extname(candidate) !== "" &&
        basename(candidate, extname(candidate)) === basename(rel)
      );
    });
    const pySibling = `${rel}.py`;
    if (siblingPaths.length > 0 || relSet.has(pySibling)) {
      conflicts.push({
        extensionless: rel,
        siblings: Array.from(new Set([...siblingPaths, ...(relSet.has(pySibling) ? [pySibling] : [])])).sort(),
      });
    }
  }
  return conflicts.sort((left, right) => left.extensionless.localeCompare(right.extensionless));
}

async function findPlaceholderScripts(pdRoot, relFiles) {
  const placeholders = [];
  for (const rel of relFiles) {
    if (!isScriptDirFile(rel) || rel.includes("__pycache__/")) {
      continue;
    }
    const text = await readTextFile(join(pdRoot, rel));
    if (text == null) {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (/TODO:\s*Implement actual functionality|placeholder implementation|not implemented/i.test(lines[index])) {
        if (/add_argument\(.*help=.*not implemented/i.test(lines[index])) {
          continue;
        }
        placeholders.push({ file: rel, line: index + 1, text: lines[index].trim() });
        break;
      }
    }
  }
  return placeholders;
}

async function findScriptCodeFenceArtifacts(pdRoot, relFiles) {
  const artifacts = [];
  for (const rel of relFiles) {
    if (!isScriptDirFile(rel) || rel.includes("__pycache__/") || !isExecutableTextFile(rel)) {
      continue;
    }
    const text = await readTextFile(join(pdRoot, rel));
    if (text == null) {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const trimmed = lines[index].trim();
      if (trimmed.startsWith("```")) {
        artifacts.push({ file: rel, line: index + 1, text: trimmed });
      }
    }
  }
  return artifacts;
}

function findExtensionlessReferenceDuplicates(relFiles) {
  const relSet = new Set(relFiles);
  const duplicates = [];
  for (const rel of relFiles) {
    if (!rel.startsWith("references/") || extname(rel) !== "") {
      continue;
    }
    const mdRel = `${rel}.md`;
    if (relSet.has(mdRel)) {
      duplicates.push({ extensionless: rel, canonical: mdRel });
    }
  }
  return duplicates;
}

async function findMarkdownPathIssues(pdRoot, relFiles, relSet) {
  const unresolvedCommandPaths = [];
  const extensionlessCommandTargets = [];
  const brokenMarkdownLinks = [];
  for (const rel of relFiles.filter(isUserFacingTextFile)) {
    const text = await readTextFile(join(pdRoot, rel));
    if (text == null) {
      continue;
    }
    const lines = text.split(/\r?\n/);
    const documentWorkingDirs = inferDocumentWorkingDirs(text);
    let inFence = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const trimmed = line.trim();
      if (trimmed.startsWith("```")) {
        inFence = !inFence;
        continue;
      }
      const isExternalCommandContract = /\bexternal\b|not bundled|separate .*skill|do not assume a local helper/i.test(line);
      if (isExternalCommandContract) {
        continue;
      }
      for (const command of extractLocalCommandTargets(line)) {
        const workingDirs = inferLineWorkingDirs(lines, index, rel, documentWorkingDirs);
        const resolution = resolveLocalTarget(command.target, workingDirs, relSet);
        if (resolution.resolvedRel != null && extname(resolution.resolvedRel) === "") {
          const siblings = findSiblingWithExtension(resolution.resolvedRel, relFiles);
          if (siblings.length > 0) {
            extensionlessCommandTargets.push({
              file: rel,
              line: index + 1,
              command: command.raw,
              target: command.target,
              resolved: resolution.resolvedRel,
              canonicalSiblings: siblings,
            });
          }
        }
        if (resolution.resolvedRel == null) {
          const alternatives = findAlternativeTargets(command.target, relFiles);
          unresolvedCommandPaths.push({
            file: rel,
            line: index + 1,
            command: command.raw,
            target: command.target,
            workingDirs,
            alternatives,
          });
        }
      }
      if (inFence || !isMarkdownFile(rel)) {
        continue;
      }
      for (const link of extractLocalMarkdownLinks(line)) {
        const workingDirs = inferLineWorkingDirs(lines, index, rel, documentWorkingDirs);
        const resolution = resolveLocalTarget(link.target, [dirname(rel), ...workingDirs], relSet);
        if (resolution.resolvedRel == null) {
          const alternatives = findAlternativeTargets(link.target, relFiles);
          if (alternatives.length > 0 || isSkillLocalPath(link.target)) {
            brokenMarkdownLinks.push({
              file: rel,
              line: index + 1,
              target: link.target,
              workingDirs: [dirname(rel), ...workingDirs],
              alternatives,
            });
          }
        }
      }
      if (!rel.startsWith("references/")) {
        continue;
      }
      for (const mention of extractBareLocalPathMentions(line)) {
        const workingDirs = inferLineWorkingDirs(lines, index, rel, documentWorkingDirs);
        const resolution = resolveLocalTarget(mention.target, [dirname(rel), ...workingDirs], relSet);
        if (resolution.resolvedRel == null) {
          const alternatives = findAlternativeTargets(mention.target, relFiles);
          if (alternatives.length > 0) {
            brokenMarkdownLinks.push({
              file: rel,
              line: index + 1,
              target: mention.target,
              workingDirs: [dirname(rel), ...workingDirs],
              alternatives,
            });
          }
        }
      }
    }
  }
  return { unresolvedCommandPaths, extensionlessCommandTargets, brokenMarkdownLinks };
}

async function findUserFacingTextArtifacts(pdRoot, relFiles) {
  const staleLocalPaths = [];
  const provenanceLeaks = [];
  const headingArtifacts = [];
  for (const rel of relFiles.filter(isUserFacingTextFile)) {
    const text = await readTextFile(join(pdRoot, rel));
    if (text == null) {
      continue;
    }
    const lines = text.split(/\r?\n/);
    let inFence = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const trimmed = line.trim();
      const isExternalCommandContract = /\bexternal\b|not bundled|separate .*skill|optional environment tooling|installed .*helper|do not assume a local helper/i.test(line);
      if (!isExternalCommandContract && /~\/\.[A-Za-z0-9_-]+\/skills\/|\.[A-Za-z0-9_-]+\/tools\/|\/mnt\/skills\b|\/root\/\.[A-Za-z0-9_-]+\/skills\/|\/root\/skills\/|(^|[\s`'"])skills\/[A-Za-z0-9_.-]+\//.test(line)) {
        staleLocalPaths.push({ file: rel, line: index + 1, text: line.trim() });
      }
      if (
        /inline source blocks/i.test(line) ||
        /Source content from/i.test(line) ||
        /\bfrom the baseline\b/i.test(line) ||
        /\bbaseline\b.*\brecreated\b/i.test(line) ||
        /\brecreated\b.*\bbaseline\b/i.test(line) ||
        /\bcompatibility warning\b/i.test(line) ||
        /\bpath hygiene\b/i.test(line) ||
        /\bconversion rule\b/i.test(line) ||
        /python\s+\{\}/.test(line) ||
        /\[(?:describe your task|specific task|combined task|more complex task|Describe the main input needed|What context helps improve results|Any customization options|List related skills|Skills that complement this one|another skill)\]/i.test(line)
      ) {
        provenanceLeaks.push({ file: rel, line: index + 1, text: line.trim() });
      }
      if (/^#{1,6}\s*$/.test(line)) {
        headingArtifacts.push({ file: rel, line: index + 1, type: "bare-heading", text: line.trim() });
      }
      if (isMarkdownFile(rel) && !inFence && hasUnbalancedInlineBackticks(line)) {
        headingArtifacts.push({ file: rel, line: index + 1, type: "malformed-inline-code", text: line.trim() });
      }
      if (trimmed.startsWith("```")) {
        inFence = !inFence;
      }
    }
    if (isMarkdownFile(rel)) {
      for (const artifact of findDuplicateOrTerminalHeadings(rel, lines)) {
        headingArtifacts.push(artifact);
      }
    }
  }
  return { staleLocalPaths, provenanceLeaks, headingArtifacts };
}

function extractLocalCommandTargets(line) {
  const commands = [];
  const commandPattern = /\b(?:python3?|node|bash|sh)\s+([^\s`'")]+)/g;
  let match;
  while ((match = commandPattern.exec(line)) != null) {
    const target = stripCommandTarget(match[1]);
    if (!isLocalCommandTarget(target)) {
      continue;
    }
    commands.push({ raw: match[0], target });
  }
  return commands;
}

function extractLocalMarkdownLinks(line) {
  const links = [];
  const linkPattern = /\[[^\]]+\]\(([^)]+)\)/g;
  let match;
  while ((match = linkPattern.exec(line)) != null) {
    const target = stripCommandTarget(match[1].split("#")[0]);
    if (!isSkillLocalPath(target)) {
      continue;
    }
    links.push({ target });
  }
  return links;
}

function extractBareLocalPathMentions(line) {
  const mentions = [];
  const strippedLine = line.replace(/\[[^\]]+\]\([^)]+\)/g, " ");
  const seen = new Set();
  for (const pattern of [
    /`([^`]+\.(?:md|txt|py|js|mjs|cjs|sh|json|ya?ml))`/g,
    /\b((?:references|scripts|templates|docs|pdf|pptx|docx|xlsx|ooxml)\/[A-Za-z0-9._/\-]+\.(?:md|txt|py|js|mjs|cjs|sh|json|ya?ml))\b/g,
    /(?<![A-Za-z0-9._/\-])([A-Za-z0-9._-]+\.md)\b/g,
  ]) {
    let match;
    while ((match = pattern.exec(strippedLine)) != null) {
      const target = stripCommandTarget(match[1].split("#")[0]);
      if (!target.includes("/") && !target.endsWith(".md")) {
        continue;
      }
      if (!isSkillLocalPath(target) || seen.has(target)) {
        continue;
      }
      seen.add(target);
      mentions.push({ target });
    }
  }
  return mentions;
}

function inferDocumentWorkingDirs(text) {
  const dirs = new Set();
  if (/\bfrom the skill root\b|\bfrom skill root\b|\busing .* from the root\b/i.test(text)) {
    dirs.add(".");
  }
  const directoryPattern = /from the `([^`]+)` directory/gi;
  let match;
  while ((match = directoryPattern.exec(text)) != null) {
    const rel = normalizeRel(match[1]);
    if (rel !== "." && !rel.startsWith("~") && !rel.startsWith("/")) {
      dirs.add(rel);
    }
  }
  return Array.from(dirs);
}

function inferLineWorkingDirs(lines, index, markdownRel, documentWorkingDirs) {
  const dirs = [];
  const start = Math.max(0, index - 2);
  const context = lines.slice(start, index + 1).join(" ");
  if (/from this file's directory|from this files directory|run from this file/i.test(context)) {
    dirs.push(dirname(markdownRel));
  }
  const lineDirectoryPattern = /from the `([^`]+)` directory/gi;
  let match;
  while ((match = lineDirectoryPattern.exec(context)) != null) {
    const rel = normalizeRel(match[1]);
    if (rel !== "." && !rel.startsWith("~") && !rel.startsWith("/")) {
      dirs.push(rel);
    }
  }
  if (/\bfrom the skill root\b|\bfrom skill root\b/i.test(context)) {
    dirs.push(".");
  }
  dirs.push(...documentWorkingDirs);
  if (!isMarkdownFile(markdownRel) && dirname(markdownRel) !== ".") {
    dirs.push(dirname(markdownRel));
  }
  if (dirs.length === 0) {
    dirs.push(".");
  }
  return Array.from(new Set(dirs.map(normalizeRel)));
}

function resolveLocalTarget(target, workingDirs, relSet) {
  for (const workingDir of workingDirs) {
    const rel = normalizeRel(workingDir === "." ? target : `${workingDir}/${target}`);
    if (relSet.has(rel)) {
      return { resolvedRel: rel };
    }
  }
  return { resolvedRel: null };
}

function findSiblingWithExtension(rel, relFiles) {
  return relFiles.filter((candidate) => {
    return (
      dirname(candidate) === dirname(rel) &&
      candidate !== rel &&
      extname(candidate) !== "" &&
      basename(candidate, extname(candidate)) === basename(rel)
    );
  }).sort();
}

function findAlternativeTargets(target, relFiles) {
  const targetName = basename(target);
  const targetStem = extname(targetName) === "" ? targetName : basename(targetName, extname(targetName));
  return relFiles
    .filter((rel) => {
      const name = basename(rel);
      if (name === targetName) {
        return true;
      }
      return basename(name, extname(name)) === targetStem && extname(name) !== "";
    })
    .slice(0, 8);
}

function findDuplicateOrTerminalHeadings(rel, lines) {
  const artifacts = [];
  let previousHeading = null;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading == null) {
      if (lines[index].trim() !== "") {
        previousHeading = null;
      }
      continue;
    }
    const normalizedHeading = `${heading[1]} ${heading[2].trim().toLowerCase()}`;
    if (previousHeading != null && previousHeading.normalized === normalizedHeading) {
      artifacts.push({
        file: rel,
        line: previousHeading.line,
        type: "duplicate-adjacent-heading",
        text: lines[previousHeading.line - 1].trim(),
      });
    }
    previousHeading = { normalized: normalizedHeading, line: index + 1 };
  }
  const lastContentLine = findLastNonEmptyLine(lines);
  if (lastContentLine != null && /^#{1,6}\s+.+/.test(lines[lastContentLine - 1])) {
    artifacts.push({
      file: rel,
      line: lastContentLine,
      type: "terminal-empty-heading",
      text: lines[lastContentLine - 1].trim(),
    });
  }
  return artifacts;
}

function findLastNonEmptyLine(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() !== "") {
      return index + 1;
    }
  }
  return null;
}

function stripCommandTarget(value) {
  return value.replace(/^[`'"]+/, "").replace(/[`'",.;:]+$/, "");
}

function isLocalCommandTarget(target) {
  if (!isSkillLocalPath(target)) {
    return false;
  }
  if (isGenericExampleTarget(target)) {
    return false;
  }
  return target.includes("/") || /\.(py|js|mjs|cjs|sh)$/.test(target);
}

function isGenericExampleTarget(target) {
  return new Set([
    "script.py",
    "your_script.py",
    "todo.py",
    "example.py",
    "test.py",
  ]).has(basename(target));
}

function isSkillLocalPath(target) {
  if (target === "" || target.startsWith("-") || target.startsWith("<") || target.startsWith("$")) {
    return false;
  }
  if (/^(https?:|mailto:|#|~\/|\/)/.test(target)) {
    return false;
  }
  if (target.includes("..")) {
    return false;
  }
  return /^(scripts|references|docs|templates|pdf|pptx|xlsx|gmail-skill|google-calendar-skill)\//.test(target) ||
    /\.(py|js|mjs|cjs|sh|md|json|yaml|yml|txt|xsd)$/.test(target);
}

function normalizeRel(value) {
  const parts = [];
  for (const part of value.replace(/\\/g, "/").replace(/\/+$/g, "").split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length === 0 ? "." : parts.join("/");
}

async function findTopNestedDuplicates(pdRoot, relFiles) {
  const scriptsFiles = relFiles.filter((rel) => isScriptDirFile(rel) && !rel.includes("__pycache__/"));
  const byHash = new Map();
  for (const rel of scriptsFiles) {
    const hash = await hashFile(join(pdRoot, rel));
    const list = byHash.get(hash) ?? [];
    list.push(rel);
    byHash.set(hash, list);
  }
  const duplicates = [];
  for (const paths of byHash.values()) {
    const topLevel = paths.filter((rel) => rel.startsWith("scripts/"));
    const nested = paths.filter((rel) => !rel.startsWith("scripts/") && rel.includes("/scripts/"));
    for (const top of topLevel) {
      for (const nestedPath of nested) {
        if (basename(top) === basename(nestedPath)) {
          duplicates.push({ topLevel: top, nested: nestedPath });
        }
      }
    }
  }
  return duplicates.sort((left, right) => `${left.topLevel}\0${left.nested}`.localeCompare(`${right.topLevel}\0${right.nested}`));
}

function isScriptDirFile(rel) {
  return rel.startsWith("scripts/") || rel.includes("/scripts/");
}

function isMarkdownFile(rel) {
  return rel === "SKILL.md" || rel.endsWith(".md") || rel.endsWith(".mdx");
}

function isUserFacingTextFile(rel) {
  return isMarkdownFile(rel) || rel.endsWith(".txt");
}

function isExecutableTextFile(rel) {
  const ext = extname(rel);
  return ext === "" || [".py", ".js", ".mjs", ".cjs", ".sh"].includes(ext);
}

function hasUnbalancedInlineBackticks(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith("```")) {
    return false;
  }
  let count = 0;
  for (const char of line) {
    if (char === "`") {
      count += 1;
    }
  }
  return count % 2 === 1;
}

function sumIssueCount(reports, key) {
  return reports.reduce((total, report) => total + report[key].length, 0);
}

async function hashFile(filePath) {
  const data = await readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

async function readTextFile(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function inferTaskId(pdRoot) {
  return basename(pdRoot) === "pd" ? basename(dirname(pdRoot)) : basename(pdRoot);
}

function renderConsoleSummary(summary) {
  return [
    `progressive-disclosure path hygiene: risk=${summary.affectedTaskCount > 0 ? "high" : "low"}`,
    `tasks=${summary.taskCount}`,
    `affected=${summary.affectedTaskCount}`,
    `topNestedDup=${summary.topNestedDupTaskCount}`,
    `extensionlessAlias=${summary.extensionlessAliasTaskCount}`,
    `extensionlessScriptConflict=${summary.extensionlessScriptConflictTaskCount}`,
    `placeholderScript=${summary.placeholderScriptTaskCount}`,
    `extensionlessReferenceDuplicate=${summary.extensionlessReferenceDuplicateTaskCount}`,
    `scriptCodeFenceTasks=${summary.scriptCodeFenceTaskCount}`,
    `scriptCodeFenceIssues=${summary.scriptCodeFenceIssueCount}`,
    `unresolvedCommandTasks=${summary.unresolvedCommandTaskCount}`,
    `unresolvedCommandIssues=${summary.unresolvedCommandIssueCount}`,
    `extensionlessCommandTasks=${summary.extensionlessCommandTaskCount}`,
    `extensionlessCommandIssues=${summary.extensionlessCommandIssueCount}`,
    `brokenMarkdownLinkTasks=${summary.brokenMarkdownLinkTaskCount}`,
    `brokenMarkdownLinkIssues=${summary.brokenMarkdownLinkIssueCount}`,
    `staleLocalPathTasks=${summary.staleLocalPathTaskCount}`,
    `staleLocalPathIssues=${summary.staleLocalPathIssueCount}`,
    `provenanceLeakTasks=${summary.provenanceLeakTaskCount}`,
    `provenanceLeakIssues=${summary.provenanceLeakIssueCount}`,
    `headingArtifactTasks=${summary.headingArtifactTaskCount}`,
    `headingArtifactIssues=${summary.headingArtifactIssueCount}`,
    `pycache=${summary.pycacheTaskCount}`,
  ].join(" ");
}

function renderMarkdown(summary) {
  const lines = [
    "# Progressive-Disclosure Path Hygiene Report",
    "",
    `- Root: \`${summary.root}\``,
    `- Tasks scanned: ${summary.taskCount}`,
    `- Affected tasks: ${summary.affectedTaskCount}`,
    `- Top-level scripts duplicated from nested scripts: ${summary.topNestedDupTaskCount}`,
    `- Extensionless aliases with same .py sibling: ${summary.extensionlessAliasTaskCount}`,
    `- Extensionless script conflicts: ${summary.extensionlessScriptConflictTaskCount}`,
    `- Placeholder scripts: ${summary.placeholderScriptTaskCount}`,
    `- Extensionless reference duplicates: ${summary.extensionlessReferenceDuplicateTaskCount}`,
    `- Tasks with Markdown fences in executable scripts: ${summary.scriptCodeFenceTaskCount}`,
    `- Markdown fence issues in executable scripts: ${summary.scriptCodeFenceIssueCount}`,
    `- Tasks with unresolved Markdown/text command paths: ${summary.unresolvedCommandTaskCount}`,
    `- Unresolved Markdown/text command path issues: ${summary.unresolvedCommandIssueCount}`,
    `- Tasks with extensionless Markdown/text command targets: ${summary.extensionlessCommandTaskCount}`,
    `- Extensionless Markdown/text command target issues: ${summary.extensionlessCommandIssueCount}`,
    `- Tasks with broken Markdown links: ${summary.brokenMarkdownLinkTaskCount}`,
    `- Broken Markdown link issues: ${summary.brokenMarkdownLinkIssueCount}`,
    `- Tasks with stale local skill paths: ${summary.staleLocalPathTaskCount}`,
    `- Stale local skill path issues: ${summary.staleLocalPathIssueCount}`,
    `- Tasks with conversion/provenance leaks: ${summary.provenanceLeakTaskCount}`,
    `- Conversion/provenance leak issues: ${summary.provenanceLeakIssueCount}`,
    `- Tasks with heading artifacts: ${summary.headingArtifactTaskCount}`,
    `- Heading artifact issues: ${summary.headingArtifactIssueCount}`,
    `- __pycache__/ or *.pyc present: ${summary.pycacheTaskCount}`,
    "",
  ];

  for (const report of summary.tasks.filter((item) => item.risk !== "low")) {
    lines.push(`## ${report.taskId}`, "");
    if (report.topNestedDuplicates.length > 0) {
      lines.push("### Top-level/nested duplicate helpers");
      for (const duplicate of report.topNestedDuplicates.slice(0, 20)) {
        lines.push(`- \`${duplicate.topLevel}\` == \`${duplicate.nested}\``);
      }
      if (report.topNestedDuplicates.length > 20) {
        lines.push(`- ... ${report.topNestedDuplicates.length - 20} more`);
      }
      lines.push("");
    }
    if (report.extensionlessAliases.length > 0) {
      lines.push("### Extensionless aliases");
      for (const alias of report.extensionlessAliases) {
        lines.push(`- \`${alias.alias}\` duplicates \`${alias.canonical}\``);
      }
      lines.push("");
    }
    if (report.extensionlessScriptConflicts.length > 0) {
      lines.push("### Extensionless script conflicts");
      for (const conflict of report.extensionlessScriptConflicts.slice(0, 20)) {
        lines.push(`- \`${conflict.extensionless}\` conflicts with ${conflict.siblings.map((item) => `\`${item}\``).join(", ")}`);
      }
      if (report.extensionlessScriptConflicts.length > 20) {
        lines.push(`- ... ${report.extensionlessScriptConflicts.length - 20} more`);
      }
      lines.push("");
    }
    if (report.placeholderScripts.length > 0) {
      lines.push("### Placeholder scripts");
      for (const placeholder of report.placeholderScripts.slice(0, 20)) {
        lines.push(`- \`${placeholder.file}:${placeholder.line}\` ${placeholder.text}`);
      }
      if (report.placeholderScripts.length > 20) {
        lines.push(`- ... ${report.placeholderScripts.length - 20} more`);
      }
      lines.push("");
    }
    if (report.extensionlessReferenceDuplicates.length > 0) {
      lines.push("### Extensionless reference duplicates");
      for (const duplicate of report.extensionlessReferenceDuplicates.slice(0, 20)) {
        lines.push(`- \`${duplicate.extensionless}\` duplicates \`${duplicate.canonical}\``);
      }
      if (report.extensionlessReferenceDuplicates.length > 20) {
        lines.push(`- ... ${report.extensionlessReferenceDuplicates.length - 20} more`);
      }
      lines.push("");
    }
    if (report.scriptCodeFenceArtifacts.length > 0) {
      lines.push("### Markdown fences inside executable scripts");
      for (const issue of report.scriptCodeFenceArtifacts.slice(0, 20)) {
        lines.push(`- \`${issue.file}:${issue.line}\` ${issue.text}`);
      }
      if (report.scriptCodeFenceArtifacts.length > 20) {
        lines.push(`- ... ${report.scriptCodeFenceArtifacts.length - 20} more`);
      }
      lines.push("");
    }
    if (report.unresolvedCommandPaths.length > 0) {
      lines.push("### Unresolved Markdown/text command paths");
      for (const issue of report.unresolvedCommandPaths.slice(0, 30)) {
        const alternatives = issue.alternatives.length > 0 ? `; alternatives: ${issue.alternatives.map((item) => `\`${item}\``).join(", ")}` : "";
        lines.push(`- \`${issue.file}:${issue.line}\` command \`${issue.command}\` with cwd ${issue.workingDirs.map((item) => `\`${item}\``).join(", ")}${alternatives}`);
      }
      if (report.unresolvedCommandPaths.length > 30) {
        lines.push(`- ... ${report.unresolvedCommandPaths.length - 30} more`);
      }
      lines.push("");
    }
    if (report.extensionlessCommandTargets.length > 0) {
      lines.push("### Extensionless Markdown/text command targets");
      for (const issue of report.extensionlessCommandTargets.slice(0, 30)) {
        lines.push(`- \`${issue.file}:${issue.line}\` command \`${issue.command}\` resolves to \`${issue.resolved}\`; canonical siblings: ${issue.canonicalSiblings.map((item) => `\`${item}\``).join(", ")}`);
      }
      if (report.extensionlessCommandTargets.length > 30) {
        lines.push(`- ... ${report.extensionlessCommandTargets.length - 30} more`);
      }
      lines.push("");
    }
    if (report.brokenMarkdownLinks.length > 0) {
      lines.push("### Broken Markdown links");
      for (const issue of report.brokenMarkdownLinks.slice(0, 20)) {
        const alternatives = issue.alternatives.length > 0 ? `; alternatives: ${issue.alternatives.map((item) => `\`${item}\``).join(", ")}` : "";
        lines.push(`- \`${issue.file}:${issue.line}\` link target \`${issue.target}\`${alternatives}`);
      }
      if (report.brokenMarkdownLinks.length > 20) {
        lines.push(`- ... ${report.brokenMarkdownLinks.length - 20} more`);
      }
      lines.push("");
    }
    if (report.staleLocalPaths.length > 0) {
      lines.push("### Stale local skill paths");
      for (const issue of report.staleLocalPaths.slice(0, 20)) {
        lines.push(`- \`${issue.file}:${issue.line}\` ${issue.text}`);
      }
      if (report.staleLocalPaths.length > 20) {
        lines.push(`- ... ${report.staleLocalPaths.length - 20} more`);
      }
      lines.push("");
    }
    if (report.provenanceLeaks.length > 0) {
      lines.push("### Conversion/provenance leaks");
      for (const issue of report.provenanceLeaks.slice(0, 20)) {
        lines.push(`- \`${issue.file}:${issue.line}\` ${issue.text}`);
      }
      if (report.provenanceLeaks.length > 20) {
        lines.push(`- ... ${report.provenanceLeaks.length - 20} more`);
      }
      lines.push("");
    }
    if (report.headingArtifacts.length > 0) {
      lines.push("### Heading artifacts");
      for (const issue of report.headingArtifacts.slice(0, 20)) {
        lines.push(`- \`${issue.file}:${issue.line}\` ${issue.type}: ${issue.text}`);
      }
      if (report.headingArtifacts.length > 20) {
        lines.push(`- ... ${report.headingArtifacts.length - 20} more`);
      }
      lines.push("");
    }
    if (report.pycacheFiles.length > 0) {
      lines.push("### __pycache__/pyc files");
      for (const file of report.pycacheFiles.slice(0, 20)) {
        lines.push(`- \`${file}\``);
      }
      if (report.pycacheFiles.length > 20) {
        lines.push(`- ... ${report.pycacheFiles.length - 20} more`);
      }
      lines.push("");
    }
  }

  if (summary.affectedTaskCount === 0) {
    lines.push("No path hygiene anomalies found.", "");
  }
  return lines.join("\n");
}
