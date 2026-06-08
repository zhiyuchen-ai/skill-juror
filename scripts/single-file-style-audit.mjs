#!/usr/bin/env node
import { mkdir, readdir, readFile, stat, writeFile } from "fs/promises";
import { basename, dirname, join, resolve } from "path";

const USAGE = `single-file-style-audit

Usage:
  node scripts/single-file-style-audit.mjs --root <single-file-root-or-run-root> [--source <source-skills>] [--out <out-dir>] [--fail-on-risk]

Checks:
  - archive/bookkeeping headings and metadata in single-file SKILL.md
  - old bare Source file markers
  - construction-log prose that makes the skill read like a conversion log
  - dangling local Markdown links in the flat single-file skill
  - missing natural operational markers for source support files when --source is provided
`;

const args = parseArgs(process.argv.slice(2));
if (args.help || args.root == null) {
  console.log(USAGE);
  process.exit(args.root == null ? 1 : 0);
}

const root = resolve(args.root);
const source = args.source == null ? null : resolve(args.source);
const outDir = args.out == null ? null : resolve(args.out);
const roots = await resolveBaselineRoots(root);
const reports = [];
for (const baselineRoot of roots) {
  reports.push(await scanBaselineRoot(baselineRoot, source));
}

const affected = reports.filter((report) => report.risk !== "low");
const summary = {
  schemaVersion: "single-file-style-audit/v1",
  generatedAt: new Date().toISOString(),
  root,
  source,
  taskCount: reports.length,
  affectedTaskCount: affected.length,
  oldSourceMarkerTaskCount: reports.filter((report) => report.oldSourceMarkers.length > 0).length,
  archiveMarkerTaskCount: reports.filter((report) => report.archiveMarkers.length > 0).length,
  constructionProseTaskCount: reports.filter((report) => report.constructionProse.length > 0).length,
  danglingLocalLinkTaskCount: reports.filter((report) => report.danglingLocalLinks.length > 0).length,
  missingOperationalMarkerTaskCount: reports.filter((report) => report.missingOperationalMarkers.length > 0).length,
  tasks: reports,
};

if (outDir != null) {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "report.json"), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(join(outDir, "report.md"), renderMarkdown(summary));
}

console.log(renderConsoleSummary(summary));
if (args.failOnRisk && affected.length > 0) {
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = {
    root: null,
    source: null,
    out: null,
    failOnRisk: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      parsed.root = argv[++index];
    } else if (arg === "--source") {
      parsed.source = argv[++index];
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

async function resolveBaselineRoots(inputRoot) {
  if (await isFile(join(inputRoot, "SKILL.md"))) {
    return [inputRoot];
  }
  const roots = [];
  const entries = await readdir(inputRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const direct = join(inputRoot, entry.name);
    const nested = join(direct, "baseline");
    if (await isFile(join(direct, "SKILL.md"))) {
      roots.push(direct);
    } else if (await isFile(join(nested, "SKILL.md"))) {
      roots.push(nested);
    }
  }
  return roots.sort();
}

async function scanBaselineRoot(baselineRoot, sourceRoot) {
  const skillPath = join(baselineRoot, "SKILL.md");
  const text = await readFile(skillPath, "utf8");
  const oldSourceMarkers = findLineMatches(text, /^Source file:\s+`[^`]+`\s*$/i);
  const archiveMarkers = [
    ...findLineMatches(text, /^#{1,6}\s*(Archived Support Files?|Support File Archive|File Archive|Archive)\s*:?\s*$/i),
    ...findLineMatches(text, /^(?:[-*]\s*)?(Encoding|Bytes|Byte count|Checksum|SHA-?256)\s*:/i),
    ...findLineMatches(text, /\barchival labels?\b/i),
  ];
  const constructionProse = [
    ...findLineMatches(text, /\bsource reference content follows inline\b/i),
    ...findLineMatches(text, /\bsource skill content follows inline\b/i),
    ...findLineMatches(text, /\bcontent follows inline\b/i),
    ...findLineMatches(text, /\bconverted from\b/i),
    ...findLineMatches(text, /\bgenerated from\b/i),
    ...findLineMatches(text, /\bconversion report\b/i),
  ];
  const danglingLocalLinks = findDanglingLocalLinks(text, baselineRoot);
  const missingOperationalMarkers = sourceRoot == null
    ? []
    : await findMissingOperationalMarkers(text, sourceRoot);
  const risk =
    oldSourceMarkers.length > 0 ||
    archiveMarkers.length > 0 ||
    constructionProse.length > 0 ||
    danglingLocalLinks.length > 0 ||
    missingOperationalMarkers.length > 0
      ? "high"
      : "low";
  return {
    taskId: inferTaskId(baselineRoot),
    singleFileRoot: baselineRoot,
    risk,
    oldSourceMarkers,
    archiveMarkers,
    constructionProse,
    danglingLocalLinks,
    missingOperationalMarkers,
  };
}

function findLineMatches(text, pattern) {
  const matches = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (pattern.test(line)) {
      matches.push({
        line: index + 1,
        text: line.trim().slice(0, 240),
      });
    }
  }
  return matches;
}

function findDanglingLocalLinks(text, baselineRoot) {
  const issues = [];
  const lines = text.split(/\r?\n/);
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const linkPattern = /!?\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    for (const match of rawLine.matchAll(linkPattern)) {
      const target = match[1].trim();
      if (!isLocalMarkdownTarget(target)) {
        continue;
      }
      const withoutFragment = target.split("#", 1)[0];
      if (withoutFragment === "" || withoutFragment === "SKILL.md" || withoutFragment === "./SKILL.md") {
        continue;
      }
      issues.push({
        line: index + 1,
        target,
        text: rawLine.trim().slice(0, 240),
      });
    }
  }
  return issues;
}

function isLocalMarkdownTarget(target) {
  if (target.startsWith("#")) {
    return false;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    return false;
  }
  if (target.startsWith("<") || target.startsWith("{")) {
    return false;
  }
  return true;
}

async function findMissingOperationalMarkers(text, sourceRoot) {
  const files = await listFiles(sourceRoot);
  const supportFiles = [];
  for (const file of files) {
    if (basename(file) === "SKILL.md") {
      continue;
    }
    const absolute = join(sourceRoot, file);
    const raw = await readFile(absolute);
    if (isIgnoredSupportFile(file, raw)) {
      continue;
    }
    supportFiles.push(file);
  }

  const missing = [];
  for (const file of supportFiles) {
    if (!hasOperationalMarker(text, file)) {
      missing.push(file);
    }
  }
  return missing.slice(0, 80);
}

function hasOperationalMarker(text, file) {
  const escaped = escapeRegExp(file);
  const shortPath = file.split("/").slice(1).join("/");
  const escapedShort = shortPath ? escapeRegExp(shortPath) : escaped;
  const pathPattern = `(?:${escaped}${shortPath ? `|${escapedShort}` : ""})`;
  const markerPattern = new RegExp(
    [
      String.raw`\bHelper implementation for\s+` + "`" + pathPattern + "`",
      String.raw`\bHelper contract from\s+` + "`" + pathPattern + "`",
      String.raw`\bReference content from\s+` + "`" + pathPattern + "`",
      String.raw`\bConfiguration content from\s+` + "`" + pathPattern + "`",
      String.raw`\bTemplate content from\s+` + "`" + pathPattern + "`",
      String.raw`\bSupport content from\s+` + "`" + pathPattern + "`",
      String.raw`\bRecreate\s+` + "`" + pathPattern + "`",
    ].join("|"),
    "i",
  );
  return markerPattern.test(text);
}

async function listFiles(base) {
  const output = [];
  async function visit(current, relativeBase) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      const relative = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(absolute, relative);
      } else if (entry.isFile()) {
        output.push(relative);
      }
    }
  }
  await visit(base, "");
  return output.sort();
}

function isIgnoredSupportFile(file, raw) {
  const name = basename(file).toLowerCase();
  if (raw.toString("utf8").trim() === "") {
    return true;
  }
  if (name === ".gitkeep" || name === ".gitignore") {
    return true;
  }
  if (name === "license" || name === "license.txt" || name === "copying" || name === "notice") {
    return true;
  }
  return name.includes("license") && /\.(txt|md|license)?$/i.test(name);
}

async function isFile(path) {
  try {
    const fileStat = await stat(path);
    return fileStat.isFile();
  } catch {
    return false;
  }
}

function inferTaskId(baselineRoot) {
  return basename(baselineRoot) === "baseline"
    ? basename(dirname(baselineRoot))
    : basename(baselineRoot);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderConsoleSummary(summary) {
  return [
    `single-file style audit: risk=${summary.affectedTaskCount > 0 ? "high" : "low"}`,
    `tasks=${summary.taskCount}; affected=${summary.affectedTaskCount}; oldSourceMarkers=${summary.oldSourceMarkerTaskCount}; archiveMarkers=${summary.archiveMarkerTaskCount}; constructionProse=${summary.constructionProseTaskCount}; danglingLocalLinks=${summary.danglingLocalLinkTaskCount}; missingOperationalMarkers=${summary.missingOperationalMarkerTaskCount}`,
  ].join("\n");
}

function renderMarkdown(summary) {
  const lines = [
    "# Single-File Style Audit",
    "",
    `- Root: \`${summary.root}\``,
    `- Source: \`${summary.source ?? "not provided"}\``,
    `- Tasks: ${summary.taskCount}`,
    `- Affected tasks: ${summary.affectedTaskCount}`,
    "",
    "| Task | Risk | Old Source markers | Archive markers | Construction prose | Dangling local links | Missing operational markers |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const report of summary.tasks) {
    lines.push(`| \`${report.taskId}\` | ${report.risk} | ${report.oldSourceMarkers.length} | ${report.archiveMarkers.length} | ${report.constructionProse.length} | ${report.danglingLocalLinks.length} | ${report.missingOperationalMarkers.length} |`);
  }
  lines.push("");
  for (const report of summary.tasks.filter((entry) => entry.risk !== "low")) {
    lines.push(`## ${report.taskId}`, "");
    renderSamples(lines, "Old Source Markers", report.oldSourceMarkers);
    renderSamples(lines, "Archive Markers", report.archiveMarkers);
    renderSamples(lines, "Construction Prose", report.constructionProse);
    renderSamples(lines, "Dangling Local Links", report.danglingLocalLinks);
    if (report.missingOperationalMarkers.length > 0) {
      lines.push("### Missing Operational Markers", "");
      for (const file of report.missingOperationalMarkers.slice(0, 40)) {
        lines.push(`- \`${file}\``);
      }
      lines.push("");
    }
  }
  if (summary.affectedTaskCount === 0) {
    lines.push("No single-file archive-style anomalies found.", "");
  }
  return `${lines.join("\n")}\n`;
}

function renderSamples(lines, title, samples) {
  if (samples.length === 0) {
    return;
  }
  lines.push(`### ${title}`, "");
  for (const sample of samples.slice(0, 20)) {
    lines.push(`- line ${sample.line}: ${sample.text}`);
  }
  lines.push("");
}
