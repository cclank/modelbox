#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

const parseBool = (value, fallback) => {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
};

const parsePositiveInt = (value, fallback) => {
  if (typeof value !== "string") {
    return fallback;
  }
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return n;
};

const normalizeMode = (value) => {
  const mode = String(value || "").trim().toLowerCase();
  return mode === "mock" ? "mock" : "passthrough";
};

const resolvePath = (value, fallback) => {
  const raw = String(value || "").trim();
  const target = raw || fallback;
  return path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
};

const envValue = (primary, fallback = undefined) => {
  const first = process.env[primary];
  if (typeof first === "string" && first.trim() !== "") {
    return first;
  }
  if (!fallback) {
    return first;
  }
  return process.env[fallback];
};

const state = {
  mode: normalizeMode(envValue("MODELBOX_MODE", "SIDECAR_MODE")),
  capture: parseBool(envValue("MODELBOX_CAPTURE", "SIDECAR_CAPTURE"), true),
  upstreamBaseUrl: String(
    envValue("MODELBOX_UPSTREAM_BASE_URL", "SIDECAR_UPSTREAM_BASE_URL") || "",
  ).trim(),
  upstreamApiKey: String(envValue("MODELBOX_UPSTREAM_API_KEY", "SIDECAR_UPSTREAM_API_KEY") || "").trim(),
  adminToken: String(envValue("MODELBOX_ADMIN_TOKEN", "SIDECAR_ADMIN_TOKEN") || "").trim(),
  redactAuthHeaders: parseBool(
    envValue("MODELBOX_REDACT_AUTH_HEADERS", "SIDECAR_REDACT_AUTH_HEADERS"),
    true,
  ),
  logFile: resolvePath(
    envValue("MODELBOX_LOG_FILE", "SIDECAR_LOG_FILE"),
    "./logs/modelbox.jsonl",
  ),
  maxCaptureBytes: parsePositiveInt(
    envValue("MODELBOX_MAX_CAPTURE_BYTES", "SIDECAR_MAX_CAPTURE_BYTES"),
    2 * 1024 * 1024,
  ),
};

let writer = createWriter(state.logFile);

function createWriter(filePath) {
  const normalized = resolvePath(filePath, "./logs/modelbox.jsonl");
  const ready = mkdir(path.dirname(normalized), { recursive: true }).catch(() => undefined);
  let queue = Promise.resolve();
  return {
    filePath: normalized,
    write: (line) => {
      queue = queue
        .then(() => ready)
        .then(() => appendFile(normalized, line, "utf8"))
        .catch(() => undefined);
      return queue;
    },
  };
}

function setLogFile(nextPath) {
  state.logFile = resolvePath(nextPath, "./logs/modelbox.jsonl");
  writer = createWriter(state.logFile);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value, (_k, v) => {
      if (typeof v === "bigint") {
        return v.toString();
      }
      if (v instanceof Error) {
        return { name: v.name, message: v.message, stack: v.stack };
      }
      return v;
    });
  } catch {
    return JSON.stringify({ error: "failed_to_serialize" });
  }
}

function sanitizeHeaders(headers) {
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(headers || {})) {
    const key = rawKey.toLowerCase();
    if (typeof rawValue === "undefined") {
      continue;
    }
    const value = Array.isArray(rawValue) ? rawValue.join(",") : String(rawValue);
    if (
      state.redactAuthHeaders &&
      (key === "authorization" || key === "x-api-key" || key === "proxy-authorization")
    ) {
      out[key] = "[REDACTED]";
    } else {
      out[key] = value;
    }
  }
  return out;
}

function collectImageCount(value) {
  let count = 0;
  const walk = (node) => {
    if (!node || typeof node !== "object") {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item);
      }
      return;
    }

    const record = node;
    const typeValue = typeof record.type === "string" ? record.type.toLowerCase() : "";
    if (typeValue.includes("image") || Object.hasOwn(record, "image_url") || Object.hasOwn(record, "image")) {
      count += 1;
    }
    for (const valueOfKey of Object.values(record)) {
      walk(valueOfKey);
    }
  };
  walk(value);
  return count;
}

function collectRoleCounts(items) {
  const roles = {};
  if (!Array.isArray(items)) {
    return roles;
  }
  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const role = typeof item.role === "string" ? item.role : "unknown";
    roles[role] = (roles[role] || 0) + 1;
  }
  return roles;
}

function inferMessageItems(pathname, payload) {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  if (pathname === "/v1/chat/completions" && Array.isArray(payload.messages)) {
    return payload.messages;
  }
  if (pathname === "/v1/responses") {
    if (Array.isArray(payload.input)) {
      return payload.input;
    }
    if (typeof payload.input === "string" && payload.input) {
      return [{ role: "user", content: [{ type: "input_text", text: payload.input }] }];
    }
  }
  return [];
}

function buildSummary({ traceId, pathname, payload, bodyText }) {
  const messageItems = inferMessageItems(pathname, payload);
  const toolsCount =
    payload && typeof payload === "object" && Array.isArray(payload.tools) ? payload.tools.length : 0;
  const promptSource =
    payload && typeof payload === "object" && Object.hasOwn(payload, "input")
      ? payload.input
      : payload && typeof payload === "object" && Array.isArray(payload.messages)
        ? payload.messages
        : bodyText;
  const promptChars = safeJsonStringify(promptSource)?.length || 0;

  return {
    traceId,
    route: pathname,
    model: payload && typeof payload === "object" ? payload.model || null : null,
    stream: Boolean(payload && typeof payload === "object" && payload.stream === true),
    messageCount: Array.isArray(messageItems) ? messageItems.length : 0,
    roles: collectRoleCounts(messageItems),
    toolsCount,
    imagesCount: collectImageCount(payload),
    promptChars,
  };
}

function buildDebugText(summary) {
  return `DEBUG_CONTEXT_SUMMARY ${safeJsonStringify(summary)}`;
}

function createTraceId() {
  const now = new Date();
  const stamp = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}_${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}${String(now.getUTCSeconds()).padStart(2, "0")}`;
  return `ctx_${stamp}_${randomUUID().slice(0, 8)}`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sendJson(res, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function setSseHeaders(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
}

function writeSse(res, data) {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  res.write(`data: ${body}\n\n`);
}

function writeDone(res) {
  res.write("data: [DONE]\n\n");
}

function createResponseResource({ responseId, outputItemId, model, text, createdAt }) {
  return {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status: "completed",
    error: null,
    model,
    output: [
      {
        id: outputItemId,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    output_text: text,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

function createChatCompletionResource({ completionId, model, text, createdAt }) {
  return {
    id: completionId,
    object: "chat.completion",
    created: createdAt,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

function applyForwardHeaders(reqHeaders) {
  const headers = new Headers();
  for (const [keyRaw, valueRaw] of Object.entries(reqHeaders || {})) {
    const key = keyRaw.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(key) || key === "content-length") {
      continue;
    }
    if (typeof valueRaw === "undefined") {
      continue;
    }
    if (Array.isArray(valueRaw)) {
      headers.set(keyRaw, valueRaw.join(","));
    } else {
      headers.set(keyRaw, String(valueRaw));
    }
  }
  if (state.upstreamApiKey) {
    headers.set("authorization", `Bearer ${state.upstreamApiKey}`);
  }
  return headers;
}

function mergeUrl(baseUrl, incomingPathAndQuery) {
  const base = new URL(baseUrl);
  const incoming = new URL(incomingPathAndQuery, "http://modelbox.local");
  const basePath = base.pathname.replace(/\/+$/, "");
  const incomingPath = incoming.pathname.replace(/^\/+/, "");
  const pathname = `${basePath}/${incomingPath}`.replace(/\/+/g, "/");
  return `${base.origin}${pathname}${incoming.search}`;
}

function getPublicState() {
  return {
    mode: state.mode,
    capture: state.capture,
    upstreamBaseUrl: state.upstreamBaseUrl || null,
    hasUpstreamApiKey: Boolean(state.upstreamApiKey),
    logFile: state.logFile,
    maxCaptureBytes: state.maxCaptureBytes,
  };
}

function adminAuthorized(req) {
  if (!state.adminToken) {
    return true;
  }
  const auth = req.headers.authorization;
  const bearer = typeof auth === "string" ? auth.replace(/^Bearer\s+/i, "").trim() : "";
  const token =
    bearer ||
    (typeof req.headers["x-modelbox-token"] === "string"
      ? req.headers["x-modelbox-token"]
      : typeof req.headers["x-sidecar-token"] === "string"
        ? req.headers["x-sidecar-token"]
        : "");
  return token === state.adminToken;
}

function eventBase({ traceId, req, pathname, method }) {
  return {
    ts: new Date().toISOString(),
    traceId,
    mode: state.mode,
    method,
    path: pathname,
    query: (() => {
      const url = new URL(req.url || pathname, "http://modelbox.local");
      return Object.fromEntries(url.searchParams.entries());
    })(),
  };
}

function captureEvent(event) {
  if (!state.capture) {
    return;
  }
  const line = safeJsonStringify(event);
  if (!line) {
    return;
  }
  void writer.write(`${line}\n`);
}

function respondMock({ req, res, pathname, bodyJson, traceId, summary }) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const model =
    bodyJson && typeof bodyJson === "object" && typeof bodyJson.model === "string"
      ? bodyJson.model
      : "mock-model";
  const text = buildDebugText(summary);

  if (pathname === "/v1/chat/completions") {
    if (bodyJson?.stream === true) {
      const chunkId = `chatcmpl_${randomUUID()}`;
      setSseHeaders(res);
      writeSse(res, {
        id: chunkId,
        object: "chat.completion.chunk",
        created: nowSeconds,
        model,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      });
      writeSse(res, {
        id: chunkId,
        object: "chat.completion.chunk",
        created: nowSeconds,
        model,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      });
      writeSse(res, {
        id: chunkId,
        object: "chat.completion.chunk",
        created: nowSeconds,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
      writeDone(res);
      res.end();

      captureEvent({
        ...eventBase({ traceId, req, pathname, method: req.method || "POST" }),
        direction: "response",
        source: "mock",
        status: 200,
        stream: true,
        responsePreview: text,
      });
      return;
    }

    const completionId = `chatcmpl_${randomUUID()}`;
    const payload = createChatCompletionResource({
      completionId,
      model,
      text,
      createdAt: nowSeconds,
    });
    sendJson(res, 200, payload);
    captureEvent({
      ...eventBase({ traceId, req, pathname, method: req.method || "POST" }),
      direction: "response",
      source: "mock",
      status: 200,
      stream: false,
      response: payload,
      responseSha256: sha256(JSON.stringify(payload)),
    });
    return;
  }

  if (pathname === "/v1/models") {
    const payload = {
      object: "list",
      data: [{ id: model, object: "model", created: nowSeconds, owned_by: "modelbox" }],
    };
    sendJson(res, 200, payload);
    captureEvent({
      ...eventBase({ traceId, req, pathname, method: req.method || "GET" }),
      direction: "response",
      source: "mock",
      status: 200,
      response: payload,
      responseSha256: sha256(JSON.stringify(payload)),
    });
    return;
  }

  if (pathname === "/v1/responses") {
    const responseId = `resp_${randomUUID()}`;
    const outputItemId = `msg_${randomUUID()}`;

    if (bodyJson?.stream === true) {
      setSseHeaders(res);
      const initialResponse = {
        id: responseId,
        object: "response",
        created_at: nowSeconds,
        status: "in_progress",
        error: null,
        model,
        output: [],
      };
      writeSse(res, { type: "response.created", response: initialResponse });
      writeSse(res, { type: "response.in_progress", response: initialResponse });
      writeSse(res, {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: outputItemId,
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      });
      writeSse(res, {
        type: "response.content_part.added",
        item_id: outputItemId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "" },
      });
      writeSse(res, {
        type: "response.output_text.delta",
        item_id: outputItemId,
        output_index: 0,
        content_index: 0,
        delta: text,
      });
      writeSse(res, {
        type: "response.output_text.done",
        item_id: outputItemId,
        output_index: 0,
        content_index: 0,
        text,
      });
      writeSse(res, {
        type: "response.content_part.done",
        item_id: outputItemId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text },
      });

      const completed = createResponseResource({
        responseId,
        outputItemId,
        model,
        text,
        createdAt: nowSeconds,
      });
      writeSse(res, { type: "response.output_item.done", output_index: 0, item: completed.output[0] });
      writeSse(res, { type: "response.completed", response: completed });
      writeDone(res);
      res.end();

      captureEvent({
        ...eventBase({ traceId, req, pathname, method: req.method || "POST" }),
        direction: "response",
        source: "mock",
        status: 200,
        stream: true,
        responsePreview: text,
      });
      return;
    }

    const payload = createResponseResource({
      responseId,
      outputItemId,
      model,
      text,
      createdAt: nowSeconds,
    });
    sendJson(res, 200, payload);
    captureEvent({
      ...eventBase({ traceId, req, pathname, method: req.method || "POST" }),
      direction: "response",
      source: "mock",
      status: 200,
      stream: false,
      response: payload,
      responseSha256: sha256(JSON.stringify(payload)),
    });
    return;
  }

  sendJson(res, 404, {
    error: {
      type: "not_found",
      message: `mock mode does not implement ${pathname}`,
    },
  });
}

async function respondPassthrough({ req, res, traceId, pathname, bodyBuffer }) {
  if (!state.upstreamBaseUrl) {
    sendJson(res, 502, {
      error: {
        type: "misconfigured_modelbox",
        message: "MODELBOX_UPSTREAM_BASE_URL is required in passthrough mode",
      },
    });
    captureEvent({
      ...eventBase({ traceId, req, pathname, method: req.method || "GET" }),
      direction: "response",
      source: "passthrough",
      status: 502,
      error: "missing_upstream_base_url",
    });
    return;
  }

  const targetUrl = mergeUrl(state.upstreamBaseUrl, req.url || pathname);
  const method = req.method || "GET";
  const headers = applyForwardHeaders(req.headers);
  const startedAt = Date.now();

  let upstreamRes;
  try {
    upstreamRes = await fetch(targetUrl, {
      method,
      headers,
      body: ["GET", "HEAD"].includes(method) ? undefined : bodyBuffer,
      redirect: "manual",
    });
  } catch (error) {
    sendJson(res, 502, {
      error: {
        type: "upstream_error",
        message: error instanceof Error ? error.message : String(error),
      },
    });
    captureEvent({
      ...eventBase({ traceId, req, pathname, method }),
      direction: "response",
      source: "passthrough",
      status: 502,
      upstreamUrl: targetUrl,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const responseHeaders = {};
  for (const [key, value] of upstreamRes.headers.entries()) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === "content-length") {
      continue;
    }
    responseHeaders[key] = value;
  }

  res.writeHead(upstreamRes.status, responseHeaders);

  if (!upstreamRes.body) {
    res.end();
    captureEvent({
      ...eventBase({ traceId, req, pathname, method }),
      direction: "response",
      source: "passthrough",
      status: upstreamRes.status,
      upstreamUrl: targetUrl,
      durationMs: Date.now() - startedAt,
      headers: sanitizeHeaders(responseHeaders),
    });
    return;
  }

  const stream = Readable.fromWeb(upstreamRes.body);
  const captured = [];
  let capturedBytes = 0;
  let totalBytes = 0;
  let truncated = false;

  stream.on("data", (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;

    if (!state.capture || state.maxCaptureBytes <= 0) {
      return;
    }

    const remaining = state.maxCaptureBytes - capturedBytes;
    if (remaining <= 0) {
      truncated = true;
      return;
    }

    if (buf.length <= remaining) {
      captured.push(buf);
      capturedBytes += buf.length;
      return;
    }

    captured.push(buf.subarray(0, remaining));
    capturedBytes += remaining;
    truncated = true;
  });

  stream.on("end", () => {
    const capturedBody = Buffer.concat(captured);
    const responseText = capturedBody.toString("utf8");
    captureEvent({
      ...eventBase({ traceId, req, pathname, method }),
      direction: "response",
      source: "passthrough",
      status: upstreamRes.status,
      upstreamUrl: targetUrl,
      durationMs: Date.now() - startedAt,
      headers: sanitizeHeaders(responseHeaders),
      body: state.capture ? responseText : undefined,
      bodySha256: state.capture ? sha256(capturedBody) : undefined,
      bodyBytes: totalBytes,
      bodyTruncated: truncated,
    });
  });

  stream.on("error", (error) => {
    captureEvent({
      ...eventBase({ traceId, req, pathname, method }),
      direction: "response",
      source: "passthrough",
      status: upstreamRes.status,
      upstreamUrl: targetUrl,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    if (!res.writableEnded) {
      res.end();
    }
  });

  stream.pipe(res);
}

async function handleAdmin(req, res, pathname) {
  if (!adminAuthorized(req)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (req.method === "GET" && pathname === "/admin/state") {
    sendJson(res, 200, getPublicState());
    return;
  }

  if (req.method === "POST" && pathname === "/admin/state") {
    const bodyBuffer = await readBody(req);
    const bodyText = bodyBuffer.toString("utf8");
    const bodyJson = safeJsonParse(bodyText);
    if (!bodyJson || typeof bodyJson !== "object") {
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }

    if (Object.hasOwn(bodyJson, "mode")) {
      state.mode = normalizeMode(bodyJson.mode);
    }
    if (Object.hasOwn(bodyJson, "capture")) {
      state.capture = Boolean(bodyJson.capture);
    }
    if (typeof bodyJson.upstreamBaseUrl === "string") {
      state.upstreamBaseUrl = bodyJson.upstreamBaseUrl.trim();
    }
    if (typeof bodyJson.upstreamApiKey === "string") {
      state.upstreamApiKey = bodyJson.upstreamApiKey.trim();
    }
    if (typeof bodyJson.maxCaptureBytes === "number" && bodyJson.maxCaptureBytes > 0) {
      state.maxCaptureBytes = Math.floor(bodyJson.maxCaptureBytes);
    }
    if (typeof bodyJson.logFile === "string" && bodyJson.logFile.trim()) {
      setLogFile(bodyJson.logFile.trim());
    }

    sendJson(res, 200, getPublicState());
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

const server = createServer(async (req, res) => {
  try {
    const host = req.headers.host || "127.0.0.1";
    const url = new URL(req.url || "/", `http://${host}`);
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/healthz") {
      sendJson(res, 200, {
        ok: true,
        service: "modelbox",
        mode: state.mode,
        capture: state.capture,
      });
      return;
    }

    if (pathname.startsWith("/admin/")) {
      await handleAdmin(req, res, pathname);
      return;
    }

    if (!pathname.startsWith("/v1/")) {
      sendJson(res, 404, {
        error: {
          type: "not_found",
          message: `unknown path: ${pathname}`,
        },
      });
      return;
    }

    const traceId = createTraceId();
    const method = req.method || "GET";
    const bodyBuffer = ["GET", "HEAD"].includes(method) ? Buffer.alloc(0) : await readBody(req);
    const bodyText = bodyBuffer.toString("utf8");
    const bodyJson = bodyText ? safeJsonParse(bodyText) : null;
    const summary = buildSummary({
      traceId,
      pathname,
      payload: bodyJson,
      bodyText,
    });

    captureEvent({
      ...eventBase({ traceId, req, pathname, method }),
      direction: "request",
      headers: sanitizeHeaders(req.headers),
      body: bodyJson ?? bodyText,
      bodySha256: sha256(bodyBuffer),
      summary,
    });

    if (state.mode === "mock") {
      respondMock({ req, res, pathname, bodyJson, traceId, summary });
      return;
    }

    await respondPassthrough({ req, res, traceId, pathname, bodyBuffer });
  } catch (error) {
    sendJson(res, 500, {
      error: {
        type: "modelbox_error",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});

const bind = String(envValue("MODELBOX_BIND", "SIDECAR_BIND") || "127.0.0.1").trim() || "127.0.0.1";
const port = parsePositiveInt(envValue("MODELBOX_PORT", "SIDECAR_PORT"), 8787);

server.listen(port, bind, () => {
  const startup = {
    service: "modelbox",
    bind,
    port,
    mode: state.mode,
    capture: state.capture,
    upstreamBaseUrl: state.upstreamBaseUrl || null,
    hasUpstreamApiKey: Boolean(state.upstreamApiKey),
    logFile: state.logFile,
    maxCaptureBytes: state.maxCaptureBytes,
  };
  process.stdout.write(`${JSON.stringify(startup)}\n`);
});
