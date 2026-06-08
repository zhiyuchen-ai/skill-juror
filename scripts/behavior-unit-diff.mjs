#!/usr/bin/env node
import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import path from "path";

const textFilePattern = /\.(md|mdx|txt|skill|yaml|yml|json|py|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|toml|xml|xsd|html|css|csv|sql|rs|r)$/i;
const codeFilePattern = /\.(skill|py|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|xml|xsd|rs|r)$/i;
const commandPrefixPattern = /^(?:python|python3|node|npm|npx|bash|sh|uv run|pip|pip3|cargo|go|ruby|Rscript)\b/;
const scriptPathPattern = /(?:^|\s)(?:[^\s'"`]+\/)?(?:scripts|bin)\/[^\s'"`]+(?:\.(?:py|js|mjs|sh|ts|tsx|cjs|bash|zsh|rs|r))?/;
const structuralKinds = new Set(["file-path", "skill-frontmatter"]);

function parseArgs(argv) {
  const options = {
    source: "",
    candidate: "",
    out: "",
    failOnRisk: false,
    missingWarnRatio: 0.18,
    addedWarnRatio: 0.35,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") {
      options.source = requiredValue(argv, ++index, arg);
    } else if (arg === "--candidate") {
      options.candidate = requiredValue(argv, ++index, arg);
    } else if (arg === "--out") {
      options.out = requiredValue(argv, ++index, arg);
    } else if (arg === "--fail-on-risk") {
      options.failOnRisk = true;
    } else if (arg === "--missing-warn-ratio") {
      options.missingWarnRatio = Number(requiredValue(argv, ++index, arg));
    } else if (arg === "--added-warn-ratio") {
      options.addedWarnRatio = Number(requiredValue(argv, ++index, arg));
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.source || !options.candidate || !options.out) {
    throw new Error("Required: --source <source-skill-or-bundle> --candidate <candidate-skill> --out <dir>");
  }
  if (!Number.isFinite(options.missingWarnRatio) || !Number.isFinite(options.addedWarnRatio)) {
    throw new Error("Warn ratios must be finite numbers.");
  }
  return options;
}

function requiredValue(argv, index, optionName) {
  const value = argv[index];
  if (value == null || value.startsWith("--")) {
    throw new Error(`Missing value for ${optionName}.`);
  }
  return value;
}

function printHelp() {
  console.log(`behavior-unit-diff

Compare a source skill or source bundle and a transformed skill as unordered behavior-unit sets.

Usage:
  node scripts/behavior-unit-diff.mjs --source source-skills --candidate single-file --out tmp/diff

Options:
  --source <dir>                 Source skill or source bundle directory
  --candidate <dir>              Transformed skill directory
  --out <dir>                    Output directory for report.json/report.md
  --fail-on-risk                 Exit non-zero when high-risk loss/addition is detected
  --missing-warn-ratio <number>  Missing ratio threshold for high-risk warning (default: 0.18)
  --added-warn-ratio <number>    Added ratio threshold for high-risk warning (default: 0.35)
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourceRoot = path.resolve(options.source);
  const candidateRoot = path.resolve(options.candidate);
  const outDir = path.resolve(options.out);
  await mkdir(outDir, { recursive: true });

  const source = await collectBehaviorUnits(sourceRoot);
  const candidate = await collectBehaviorUnits(candidateRoot);
  const report = buildReport({ sourceRoot, candidateRoot, source, candidate, options });

  await writeFile(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(outDir, "report.md"), renderMarkdown(report));
  console.log(`[behavior-diff] ${outDir}`);
  console.log(`[behavior-diff] risk=${report.risk.level}; semantic missing=${report.summary.semanticMissingUnits}/${report.summary.semanticSourceUnits}; semantic added=${report.summary.semanticAddedUnits}/${report.summary.semanticCandidateUnits}`);
  if (options.failOnRisk && report.risk.level === "high") {
    process.exitCode = 1;
  }
}

async function collectBehaviorUnits(root) {
  const files = await listFiles(root);
  const units = new Map();
  const textParts = [];
  for (const file of files) {
    const absolute = path.join(root, file);
    const text = await readFile(absolute, "utf8").catch(() => "");
    if (!textFilePattern.test(file) && !isExtensionlessTextHelper(file, text)) {
      continue;
    }
    if (!text.trim()) {
      continue;
    }
    textParts.push(text);
    addUnit(units, "file-path", file, file, 1, file);
    if (path.basename(file) === "SKILL.md") {
      addUnit(units, "skill-frontmatter", extractFrontmatter(text), file, 1, firstLine(extractFrontmatter(text)));
    }
    collectHeadingUnits(units, text, file);
    collectCommandUnits(units, text, file);
    collectFenceUnits(units, text, file);
    collectImportantLineUnits(units, text, file);
    collectSchemaKeyUnits(units, text, file);
    if (codeFilePattern.test(file)) {
      collectCodeSymbolUnits(units, text, file);
      addUnit(units, "semantic-code-block", normalizeCode(text), file, 1, preview(text));
    }
  }
  return { root, files, units, allText: textParts.join("\n") };
}

function isExtensionlessTextHelper(file, text) {
  if (path.extname(file) !== "") {
    return false;
  }
  if (text.startsWith("#!")) {
    return true;
  }
  if (!/^(?:scripts|bin|references)\//.test(file.replace(/\\/g, "/"))) {
    return false;
  }
  if (text.includes("\0")) {
    return false;
  }
  return /[A-Za-z0-9_#\-]/.test(text) && text.length < 500_000;
}

async function listFiles(root) {
  const files = [];
  async function walk(current, relativeBase) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      const absolute = path.join(current, entry.name);
      const relative = relativeBase ? path.join(relativeBase, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else if (entry.isFile()) {
        files.push(relative.replace(/\\/g, "/"));
      }
    }
  }
  await walk(root, "");
  return files.sort((left, right) => left.localeCompare(right));
}

function addUnit(units, kind, rawValue, file, line, previewText) {
  const normalized = normalizeUnitValue(kind, rawValue);
  if (!normalized) {
    return;
  }
  const id = `${kind}:${normalized}`;
  const existing = units.get(id);
  if (existing) {
    existing.locations.push({ file, line });
    return;
  }
  units.set(id, {
    id,
    kind,
    value: normalized,
    preview: cleanPreview(previewText ?? rawValue),
    locations: [{ file, line }],
  });
}

function normalizeUnitValue(kind, value) {
  if (kind === "semantic-code-block") {
    return normalizeCode(value);
  }
  return normalizeText(value);
}

function normalizeText(text) {
  return canonicalizePathHygieneEquivalents(String(text))
    .replace(/\r\n/g, "\n")
    .replace(/\s+#\s*external,?\s+not bundled\b/gi, "")
    .replace(/[`*_~>#|()[\]{}:;,.!?，。；：！？、"'“”‘’]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeCode(text) {
  const canonical = canonicalizePathHygieneEquivalents(String(text));
  const shellLike = canonical
    .split(/\r?\n/)
    .some((line) => commandPrefixPattern.test(line.trim()));
  return (shellLike ? canonical.replace(/\\\s*(?:\r?\n|$)/g, " ") : canonical)
    .replace(/\r\n/g, "\n")
    .replace(/\s+#\s*external,?\s+not bundled\b/gi, "")
    .replace(/^\s*#.*$/gm, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalizePathHygieneEquivalents(text) {
  return String(text)
    .replace(/\bPYTHONPATH=(?:~\/\.[A-Za-z0-9_-]+\/skills|\/root\/\.[A-Za-z0-9_-]+\/skills|\/mnt\/skills|\/root\/skills)\/[A-Za-z0-9_.-]+/g, "PYTHONPATH=.")
    .replace(/<path-to-this-skill>\/?/gi, "")
    .replace(/(?:~|\/root)\/\.[A-Za-z0-9_-]+\/skills\/[A-Za-z0-9_.-]+\/scripts/g, "scripts")
    .replace(/\/mnt\/skills\/[A-Za-z0-9_.-]+\/scripts/g, "scripts")
    .replace(/\/root\/skills\/[A-Za-z0-9_.-]+\/scripts/g, "scripts")
    .replace(/\/mnt\/skills\/([A-Za-z0-9_.-]+)/g, "$1")
    .replace(/\/root\/skills\/([A-Za-z0-9_.-]+)/g, "$1")
    .replace(/\/mnt\/skills\b/g, ".")
    .replace(/<skill-root>/gi, ".")
    .replace(/~\/\.[A-Za-z0-9_-]+\/skills\/?/g, "active skill install directory")
    .replace(/\/root\/\.[A-Za-z0-9_-]+\/skills\/?/g, "active skill install directory")
    .replace(/\/root\/\.[A-Za-z0-9_-]+\/skills\/([A-Za-z0-9_.-]+)/g, "$1")
    .replace(/~\/\.[A-Za-z0-9_-]+\/skills\/([A-Za-z0-9_.-]+)/g, "$1")
    .replace(
      /\b(python3?|node|bash|sh)\s+((?:(?:\.\/)?[A-Za-z0-9_.-]+\/)+)?([A-Za-z0-9_.-]+?)(\.(?:py|js|mjs|cjs|sh|bash|zsh|ts|tsx|rs|r))?(?=\s|$|[`'")])/g,
      (full, command, prefix, stem, extension) => {
        if (prefix == null && extension == null) {
          return full;
        }
        return `${command} ${stem}`;
      },
    )
    .replace(
      /\b(npx\s+(?:ts-node|tsx))\s+((?:(?:\.\/)?[A-Za-z0-9_.-]+\/)+)?([A-Za-z0-9_.-]+?)(\.(?:js|mjs|cjs|ts|tsx))(?=\s|$|[`'")])/g,
      (_full, command, _prefix, stem) => `${command} ${stem}`,
    );
}

function collectHeadingUnits(units, text, file) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match?.[2]) {
      addUnit(units, "heading", match[2], file, index + 1, line);
    }
  });
}

function collectCommandUnits(units, text, file) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const isSourceMarker = /\bSource file:\s*`/.test(line);
    const stripped = line.trim().replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "");
    if (!isGenericTemplateCommand(stripped) && commandPrefixPattern.test(stripped)) {
      addUnit(units, "command", stripped, file, index + 1, stripped);
    }
    if (isSourceMarker) {
      return;
    }
    for (const inline of line.matchAll(/`([^`\n]+)`/g)) {
      const value = inline[1]?.trim() ?? "";
      if (isGenericTemplateCommand(value)) {
        continue;
      }
      if (commandPrefixPattern.test(value) || scriptPathPattern.test(value)) {
        addUnit(units, "command", value, file, index + 1, value);
      }
    }
  });
}

function isGenericTemplateCommand(value) {
  return /\b(?:python3?|node|bash|sh)\s+\{\}/.test(value);
}

function collectFenceUnits(units, text, file) {
  const pattern = /```([^\n]*)\n([\s\S]*?)```/g;
  for (const match of text.matchAll(pattern)) {
    const language = (match[1] ?? "").trim().toLowerCase();
    const block = match[2] ?? "";
    if (!block.trim()) {
      continue;
    }
    const line = lineNumberAt(text, match.index ?? 0);
    const kind = (language && /^(python|py|javascript|js|typescript|ts|bash|sh|json|yaml|yml|xml|toml|rust|r|sql)$/.test(language)) || looksLikeCode(block)
      ? "semantic-code-block"
      : "fenced-text";
    addUnit(units, kind, block, file, line, block);
    collectCommandUnits(units, block, file);
    collectSchemaKeyUnits(units, block, file);
    if (kind === "semantic-code-block") {
      collectCodeSymbolUnits(units, block, file);
    }
  }
}

function looksLikeCode(block) {
  const text = block.trim();
  return /^#!\//.test(text)
    || /\b(?:import|from|def|class|function|const|let|var|export|interface|type|return|if|for|while)\b/.test(text)
    || /\b(?:python3?|node|npm|npx|bash|sh)\s+/.test(text)
    || /[{;]\s*$/.test(text);
}

function collectImportantLineUnits(units, text, file) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const stripped = line.trim();
    if (stripped.length < 36 || stripped.startsWith("```") || stripped === "---") {
      return;
    }
    if (/^(?:[-*]|\d+\.|#{1,6})\s+/.test(stripped) || /\b(?:must|never|always|required|critical|warning|schema|format|validate|verify|error|coordinate|threshold)\b/i.test(stripped)) {
      addUnit(units, "important-line", stripped, file, index + 1, stripped);
    }
  });
}

function collectSchemaKeyUnits(units, text, file) {
  for (const match of text.matchAll(/["']([A-Za-z_][\w-]{1,80})["']\s*:/g)) {
    addUnit(units, "schema-key", match[1], file, lineNumberAt(text, match.index ?? 0), match[0]);
  }
}

function collectCodeSymbolUnits(units, text, file) {
  const canonicalText = canonicalizePathHygieneEquivalents(text);
  const patterns = [
    ["module", /^\s*from\s+([A-Za-z_][\w.]+)\s+import\s+/gm],
    ["module", /^\s*import\s+([A-Za-z_][\w.]+)/gm],
    ["call", /\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)\s*\(/g],
    ["method", /\.([A-Za-z_]\w*)\s*\(/g],
    ["attr", /\.([A-Za-z_]\w*)\b/g],
  ];
  for (const [symbolKind, pattern] of patterns) {
    for (const match of canonicalText.matchAll(pattern)) {
      if (match[1]) {
        addUnit(units, `code-symbol:${symbolKind}`, match[1], file, lineNumberAt(text, match.index ?? 0), match[0]);
      }
    }
  }
}

function buildReport({ sourceRoot, candidateRoot, source, candidate, options }) {
  const sourceIds = new Set(source.units.keys());
  const candidateIds = new Set(candidate.units.keys());
  const missing = Array.from(source.units.values())
    .filter((unit) => !candidateIds.has(unit.id))
    .filter((unit) => !corpusContainsUnit(candidate, unit));
  const added = Array.from(candidate.units.values())
    .filter((unit) => !sourceIds.has(unit.id))
    .filter((unit) => !corpusContainsUnit(source, unit));
  const semanticSource = Array.from(source.units.values()).filter(isSemanticUnit);
  const semanticCandidate = Array.from(candidate.units.values()).filter(isSemanticUnit);
  const semanticMissing = missing.filter(isSemanticUnit);
  const semanticAdded = added.filter(isSemanticUnit);
  const structuralMissing = missing.filter((unit) => !isSemanticUnit(unit));
  const structuralAdded = added.filter((unit) => !isSemanticUnit(unit));
  const missingByKind = countByKind(missing);
  const addedByKind = countByKind(added);
  const sourceByKind = countByKind(Array.from(source.units.values()));
  const candidateByKind = countByKind(Array.from(candidate.units.values()));
  const highRiskMissing = missing.filter(isHighRiskMissingUnit);
  const sourceNormalizedText = normalizeText(source.allText);
  const sourceKnownPaths = sourcePathValues(source.files);
  const highRiskAdded = added.filter((unit) => isHighRiskAddedUnit(unit, sourceNormalizedText, sourceKnownPaths));
  const missingRatio = semanticSource.length === 0 ? 0 : semanticMissing.length / semanticSource.length;
  const addedRatio = semanticCandidate.length === 0 ? 0 : semanticAdded.length / semanticCandidate.length;
  const risk = classifyRisk({ missingRatio, addedRatio, highRiskMissing, highRiskAdded, options });
  return {
    schemaVersion: "behavior-unit-diff/v1",
    generatedAt: new Date().toISOString(),
    sourceRoot,
    candidateRoot,
    summary: {
      sourceFiles: source.files.length,
      candidateFiles: candidate.files.length,
      sourceUnits: source.units.size,
      candidateUnits: candidate.units.size,
      missingUnits: missing.length,
      addedUnits: added.length,
      semanticSourceUnits: semanticSource.length,
      semanticCandidateUnits: semanticCandidate.length,
      semanticMissingUnits: semanticMissing.length,
      semanticAddedUnits: semanticAdded.length,
      structuralMissingUnits: structuralMissing.length,
      structuralAddedUnits: structuralAdded.length,
      missingRatio,
      addedRatio,
      highRiskMissingUnits: highRiskMissing.length,
      highRiskAddedUnits: highRiskAdded.length,
    },
    byKind: {
      source: sourceByKind,
      candidate: candidateByKind,
      missing: missingByKind,
      added: addedByKind,
    },
    risk,
    samples: {
      missing: summarizeUnits(missing, 80),
      added: summarizeUnits(added, 80),
      highRiskMissing: summarizeUnits(highRiskMissing, 80),
      highRiskAdded: summarizeUnits(highRiskAdded, 80),
      semanticMissing: summarizeUnits(semanticMissing, 80),
      semanticAdded: summarizeUnits(semanticAdded, 80),
      structuralMissing: summarizeUnits(structuralMissing, 80),
      structuralAdded: summarizeUnits(structuralAdded, 80),
    },
  };
}

function corpusContainsUnit(corpus, unit) {
  if (unitMentionsKnownCorpusPath(unit, corpus.files)) {
    return true;
  }
  if (unit.kind === "semantic-code-block") {
    return normalizeCode(corpus.allText).includes(unit.value);
  }
  if (unit.kind === "fenced-text" || unit.kind === "important-line" || unit.kind === "command" || unit.kind === "schema-key" || unit.kind.startsWith("code-symbol:")) {
    return normalizeText(corpus.allText).includes(unit.value);
  }
  return false;
}

function unitMentionsKnownCorpusPath(unit, files) {
  if (!(unit.kind === "command" || unit.kind === "heading" || unit.kind === "important-line")) {
    return false;
  }
  return sourceMentionsKnownPath(unit.value, sourcePathValues(files));
}

function classifyRisk({ missingRatio, addedRatio, highRiskMissing, highRiskAdded, options }) {
  const reasons = [];
  if (missingRatio > options.missingWarnRatio) {
    reasons.push(`missing ratio ${missingRatio.toFixed(3)} > ${options.missingWarnRatio}`);
  }
  if (addedRatio > options.addedWarnRatio) {
    reasons.push(`added ratio ${addedRatio.toFixed(3)} > ${options.addedWarnRatio}`);
  }
  if (highRiskMissing.length > 0) {
    reasons.push(`${highRiskMissing.length} high-risk source units missing`);
  }
  if (highRiskAdded.length > 15) {
    reasons.push(`${highRiskAdded.length} high-risk candidate-only units added`);
  }
  const hasHighRiskLoss = highRiskMissing.length > 0 || highRiskAdded.length > 15;
  const hasExtremeTextDrift = missingRatio > 0.5 || addedRatio > 0.7;
  return {
    level: reasons.length === 0 ? "low" : hasHighRiskLoss || hasExtremeTextDrift ? "high" : "medium",
    reasons,
  };
}

function isHighRiskMissingUnit(unit) {
  if (isPathGuideShellBlock(unit)) {
    return false;
  }
  return unit.kind === "semantic-code-block"
    || unit.kind === "command"
    || unit.kind.startsWith("code-symbol:");
}

function isHighRiskAddedUnit(unit, sourceNormalizedText, sourceKnownPaths) {
  if (isPathGuideShellBlock(unit)) {
    return false;
  }
  if (unit.kind === "command" && sourceNormalizedText.includes(unit.value)) {
    return false;
  }
  if (unit.kind === "command" && sourceMentionsKnownPath(unit.value, sourceKnownPaths)) {
    return false;
  }
  return unit.kind === "semantic-code-block"
    || unit.kind === "command"
    || unit.kind.startsWith("code-symbol:");
}

function isPathGuideShellBlock(unit) {
  if (unit.kind !== "semantic-code-block") {
    return false;
  }
  const value = unit.value.trim().toLowerCase();
  if (!/^(?:cat|cd|mv|ls)\b/.test(value)) {
    return false;
  }
  return !/[{};]/.test(value);
}

function isSemanticUnit(unit) {
  return !structuralKinds.has(unit.kind);
}

function sourcePathValues(files) {
  const values = new Set();
  for (const file of files) {
    const normalized = normalizeText(file);
    values.add(normalized);
    const parts = normalized.split("/");
    if (parts.length > 1) {
      values.add(parts.slice(1).join("/"));
    }
  }
  return values;
}

function sourceMentionsKnownPath(value, sourceKnownPaths) {
  for (const knownPath of sourceKnownPaths) {
    if (knownPath.length > 0 && value.includes(knownPath)) {
      return true;
    }
  }
  return false;
}

function countByKind(units) {
  const counts = {};
  for (const unit of units) {
    counts[unit.kind] = (counts[unit.kind] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function summarizeUnits(units, limit) {
  return units.slice(0, limit).map((unit) => ({
    kind: unit.kind,
    value: unit.value,
    preview: unit.preview,
    locations: unit.locations.slice(0, 5),
  }));
}

function renderMarkdown(report) {
  return [
    `# Behavior Unit Diff`,
    "",
    `- Source: \`${report.sourceRoot}\``,
    `- Candidate: \`${report.candidateRoot}\``,
    `- Risk: \`${report.risk.level}\``,
    `- Reasons: ${report.risk.reasons.length === 0 ? "none" : report.risk.reasons.map((reason) => `\`${reason}\``).join(", ")}`,
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Source files | ${report.summary.sourceFiles} |`,
    `| Candidate files | ${report.summary.candidateFiles} |`,
    `| Source units | ${report.summary.sourceUnits} |`,
    `| Candidate units | ${report.summary.candidateUnits} |`,
    `| Missing units | ${report.summary.missingUnits} |`,
    `| Added units | ${report.summary.addedUnits} |`,
    `| Semantic source units | ${report.summary.semanticSourceUnits} |`,
    `| Semantic candidate units | ${report.summary.semanticCandidateUnits} |`,
    `| Semantic missing units | ${report.summary.semanticMissingUnits} |`,
    `| Semantic added units | ${report.summary.semanticAddedUnits} |`,
    `| Structural missing units | ${report.summary.structuralMissingUnits} |`,
    `| Structural added units | ${report.summary.structuralAddedUnits} |`,
    `| Semantic missing ratio | ${report.summary.missingRatio.toFixed(3)} |`,
    `| Semantic added ratio | ${report.summary.addedRatio.toFixed(3)} |`,
    `| High-risk missing | ${report.summary.highRiskMissingUnits} |`,
    `| High-risk added | ${report.summary.highRiskAddedUnits} |`,
    "",
    renderKindTable("Missing By Kind", report.byKind.missing),
    renderKindTable("Added By Kind", report.byKind.added),
    renderUnitSamples("High-Risk Missing Samples", report.samples.highRiskMissing),
    renderUnitSamples("High-Risk Added Samples", report.samples.highRiskAdded),
    renderUnitSamples("Semantic Missing Samples", report.samples.semanticMissing),
    renderUnitSamples("Semantic Added Samples", report.samples.semanticAdded),
    renderUnitSamples("Structural Missing Samples", report.samples.structuralMissing),
    renderUnitSamples("Structural Added Samples", report.samples.structuralAdded),
  ].join("\n");
}

function renderKindTable(title, counts) {
  const rows = Object.entries(counts);
  if (rows.length === 0) {
    return `## ${title}\n\nNone.\n`;
  }
  return [
    `## ${title}`,
    "",
    "| Kind | Count |",
    "|---|---:|",
    ...rows.map(([kind, count]) => `| \`${kind}\` | ${count} |`),
    "",
  ].join("\n");
}

function renderUnitSamples(title, units) {
  if (units.length === 0) {
    return `## ${title}\n\nNone.\n`;
  }
  return [
    `## ${title}`,
    "",
    ...units.slice(0, 25).map((unit, index) => {
      const location = unit.locations[0] ? `${unit.locations[0].file}:${unit.locations[0].line}` : "unknown";
      return `${index + 1}. \`${unit.kind}\` at \`${location}\`: ${unit.preview}`;
    }),
    "",
  ].join("\n");
}

function extractFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return match?.[1] ?? "";
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function firstLine(text) {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
}

function preview(text) {
  return String(text).replace(/\s+/g, " ").trim().slice(0, 180);
}

function cleanPreview(text) {
  return preview(text).replace(/\|/g, "\\|");
}

main().catch((error) => {
  console.error(`[behavior-diff] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
