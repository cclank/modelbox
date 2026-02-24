#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    file: path.resolve(process.cwd(), "logs/modelbox.jsonl"),
    index: -1,
    traceId: "",
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--file" && argv[i + 1]) {
      args.file = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === "--index" && argv[i + 1]) {
      const parsed = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(parsed)) {
        args.index = parsed;
      }
      i += 1;
      continue;
    }
    if (token === "--traceId" && argv[i + 1]) {
      args.traceId = String(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === "--json") {
      args.json = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
  }
  return args;
}

function usage() {
  console.log(
    [
      "Usage:",
      "  node src/analyze-log.mjs [--file logs/modelbox.jsonl] [--index -1] [--traceId <id>] [--json]",
      "",
      "Options:",
      "  --file      JSONL file path (default: logs/modelbox.jsonl)",
      "  --index     Request record index among request records with body.input (default: -1 = latest)",
      "  --traceId   Pick a specific traceId (overrides --index)",
      "  --json      Output JSON",
    ].join("\n"),
  );
}

function parseJsonl(text) {
  const records = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`Invalid JSONL at line ${i + 1}: ${error.message}`);
    }
  }
  return records;
}

function selectRequestRecord(records, opts) {
  const requests = records.filter(
    (record) =>
      record &&
      record.direction === "request" &&
      record.body &&
      Array.isArray(record.body.input),
  );
  if (requests.length === 0) {
    throw new Error("No request records with body.input found.");
  }
  if (opts.traceId) {
    const found = requests.find((record) => String(record.traceId || "") === opts.traceId);
    if (!found) {
      throw new Error(`traceId not found in request records: ${opts.traceId}`);
    }
    return found;
  }
  if (opts.index >= 0) {
    if (opts.index >= requests.length) {
      throw new Error(`--index ${opts.index} out of range (0..${requests.length - 1})`);
    }
    return requests[opts.index];
  }
  const resolved = requests.length + opts.index;
  if (resolved < 0 || resolved >= requests.length) {
    throw new Error(`--index ${opts.index} out of range for ${requests.length} records`);
  }
  return requests[resolved];
}

function tokenEstimateFromChars(chars) {
  const low = Math.round(chars / 4);
  const high = Math.round(chars / 2.5);
  const mid = Math.round((low + high) / 2);
  return { low, est: mid, high };
}

function scoreSection(text) {
  const chars = text.length;
  return {
    chars,
    tokens: tokenEstimateFromChars(chars),
  };
}

function findFirstSystemText(inputItems) {
  if (!Array.isArray(inputItems)) {
    return "";
  }
  for (const item of inputItems) {
    if (!item || item.role !== "system") {
      continue;
    }
    if (typeof item.content === "string") {
      return item.content;
    }
  }
  return "";
}

function sliceByNextIndex(source, start, candidateStarts) {
  const valid = candidateStarts.filter((value) => Number.isFinite(value) && value >= 0 && value > start);
  if (valid.length === 0) {
    return source.slice(start);
  }
  const end = Math.min(...valid);
  return source.slice(start, end);
}

function buildSystemSections(systemText) {
  const sections = [];
  if (!systemText) {
    return sections;
  }

  sections.push({
    key: "system_total",
    label: "system.total",
    source: "system_prompt",
    text: systemText,
  });

  const projectContextIndex = systemText.indexOf("# Project Context");
  if (projectContextIndex >= 0) {
    sections.push({
      key: "system_head",
      label: "system.head_before_project_context",
      source: "system_prompt",
      text: systemText.slice(0, projectContextIndex),
    });
  }

  const tailTitles = ["## Silent Replies", "## Heartbeats", "## Runtime"];
  const tailStarts = tailTitles
    .map((title) => systemText.indexOf(title))
    .filter((index) => index >= 0);
  const tailStart = tailStarts.length > 0 ? Math.min(...tailStarts) : -1;

  if (projectContextIndex >= 0) {
    const projectEnd = tailStart >= 0 ? tailStart : systemText.length;
    const projectBlock = systemText.slice(projectContextIndex, projectEnd);
    const fileHeadingRegex = /^## (\/[^\n]+)$/gm;
    const headings = [];
    let match = fileHeadingRegex.exec(projectBlock);
    while (match) {
      headings.push({
        path: match[1],
        offset: match.index,
        lineLength: match[0].length,
      });
      match = fileHeadingRegex.exec(projectBlock);
    }
    for (let i = 0; i < headings.length; i += 1) {
      const current = headings[i];
      const next = headings[i + 1];
      const start = current.offset + current.lineLength + 1;
      const end = next ? next.offset : projectBlock.length;
      const body = projectBlock.slice(start, end);
      sections.push({
        key: `context_file:${current.path}`,
        label: `project_context_file:${current.path}`,
        source: "dynamic_injected_file",
        text: body,
      });
    }
  }

  for (let i = 0; i < tailTitles.length; i += 1) {
    const title = tailTitles[i];
    const start = systemText.indexOf(title);
    if (start < 0) {
      continue;
    }
    const titleEnd = systemText.indexOf("\n", start);
    const contentStart = titleEnd >= 0 ? titleEnd + 1 : start + title.length;
    const candidates = tailTitles
      .slice(i + 1)
      .map((candidate) => systemText.indexOf(candidate))
      .filter((index) => index >= 0);
    const body = sliceByNextIndex(systemText, contentStart, candidates);
    sections.push({
      key: `tail:${title}`,
      label: `system_tail:${title.replace(/^##\s+/, "").toLowerCase().replace(/\s+/g, "_")}`,
      source: "system_prompt",
      text: body,
    });
  }

  return sections;
}

function extractSystemToolNames(systemText) {
  const names = [];
  if (!systemText) {
    return names;
  }
  const start = systemText.indexOf("## Tooling");
  const end = systemText.indexOf("## Tool Call Style");
  if (start < 0 || end < 0 || end <= start) {
    return names;
  }
  const block = systemText.slice(start, end);
  for (const line of block.split("\n")) {
    if (!line.startsWith("- ")) {
      continue;
    }
    const colonIndex = line.indexOf(":");
    if (colonIndex < 0) {
      continue;
    }
    const name = line.slice(2, colonIndex).trim();
    if (name) {
      names.push(name);
    }
  }
  return names;
}

function analyzeRecord(record) {
  const body = record.body || {};
  const systemText = findFirstSystemText(body.input || []);
  const sections = buildSystemSections(systemText);
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const toolsCompactJson = JSON.stringify(tools);
  const systemToolNames = new Set(extractSystemToolNames(systemText));
  const payloadToolNames = new Set(tools.map((tool) => tool && String(tool.name || "")).filter(Boolean));

  const sectionStats = sections.map((section) => {
    const metrics = scoreSection(section.text);
    return {
      ...section,
      ...metrics,
    };
  });
  sectionStats.sort((a, b) => b.tokens.est - a.tokens.est);

  return {
    traceId: record.traceId || null,
    ts: record.ts || null,
    model: body.model || null,
    summaryPromptChars: record.summary && typeof record.summary.promptChars === "number"
      ? record.summary.promptChars
      : null,
    systemChars: systemText.length,
    systemTokens: tokenEstimateFromChars(systemText.length),
    sections: sectionStats.map((section) => ({
      key: section.key,
      label: section.label,
      source: section.source,
      chars: section.chars,
      tokens: section.tokens,
    })),
    tools: {
      count: tools.length,
      charsCompactJson: toolsCompactJson.length,
      tokensCompactJson: tokenEstimateFromChars(toolsCompactJson.length),
      overlapWithSystemTooling: {
        systemToolCount: systemToolNames.size,
        payloadToolCount: payloadToolNames.size,
        intersection: [...systemToolNames].filter((name) => payloadToolNames.has(name)).length,
        onlyInSystem: [...systemToolNames].filter((name) => !payloadToolNames.has(name)).sort(),
        onlyInPayload: [...payloadToolNames].filter((name) => !systemToolNames.has(name)).sort(),
      },
    },
  };
}

function printTextReport(report) {
  const lines = [];
  lines.push("ModelBox Prompt Breakdown");
  lines.push(`traceId: ${report.traceId || "-"}`);
  lines.push(`ts: ${report.ts || "-"}`);
  lines.push(`model: ${report.model || "-"}`);
  lines.push(
    `system: chars=${report.systemChars}, tokens~${report.systemTokens.low}-${report.systemTokens.high} (est ${report.systemTokens.est})`,
  );
  if (typeof report.summaryPromptChars === "number") {
    lines.push(`summary.promptChars: ${report.summaryPromptChars}`);
  }
  lines.push(
    `body.tools[]: count=${report.tools.count}, chars=${report.tools.charsCompactJson}, tokens~${report.tools.tokensCompactJson.low}-${report.tools.tokensCompactJson.high} (est ${report.tools.tokensCompactJson.est})`,
  );
  lines.push(
    `tool-name overlap (system tooling vs body.tools): ${report.tools.overlapWithSystemTooling.intersection}/${report.tools.overlapWithSystemTooling.payloadToolCount}`,
  );
  lines.push("");
  lines.push("Sections (sorted by est tokens desc):");
  for (const section of report.sections) {
    lines.push(
      `- ${section.label} [${section.source}]: chars=${section.chars}, tokens~${section.tokens.low}-${section.tokens.high} (est ${section.tokens.est})`,
    );
  }
  console.log(lines.join("\n"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }

  const raw = await readFile(args.file, "utf8");
  const records = parseJsonl(raw);
  const record = selectRequestRecord(records, args);
  const report = analyzeRecord(record);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printTextReport(report);
}

main().catch((error) => {
  console.error(`[analyze-log] ${error.message}`);
  process.exit(1);
});

