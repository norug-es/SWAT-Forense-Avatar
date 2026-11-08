import http from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const HOST = process.env.SWAT_GATEWAY_HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT ?? "8787", 10);
const MCP_URL = process.env.SWAT_MCP_URL ?? "";
const MCP_API_KEY = process.env.SWAT_MCP_API_KEY ?? "";
const AUTH_HEADER = process.env.SWAT_MCP_AUTH_HEADER ?? "Authorization";
const AUTH_PREFIX = process.env.SWAT_MCP_AUTH_PREFIX ?? "Bearer";
const FEED_TOOLS = (process.env.SWAT_MCP_FEED_TOOLS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const QUERY_TOOL = process.env.SWAT_MCP_QUERY_TOOL ?? "";
const QUERY_ARG = process.env.SWAT_MCP_QUERY_ARG ?? "query";
const PUBLIC_ORIGINS = new Set((process.env.SWAT_PUBLIC_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
const RATE_LIMIT = Math.max(1, Number.parseInt(process.env.SWAT_RATE_LIMIT_PER_MINUTE ?? "60", 10));
const MAX_BODY_BYTES = Math.max(1024, Number.parseInt(process.env.SWAT_MAX_BODY_BYTES ?? "1048576", 10));
const MAX_QUERY_LENGTH = Math.max(1, Number.parseInt(process.env.SWAT_MAX_QUERY_LENGTH ?? "500", 10));
const sessions = new Map();
const requestsByIp = new Map();
const MUTATING_TOOL = /(delete|remove|write|create|update|send|exec|reset|post|publish|transfer|set_|subscribe|unsubscribe)/i;

function configReady() {
  return Boolean(MCP_URL && MCP_API_KEY && FEED_TOOLS.length && QUERY_TOOL && !MUTATING_TOOL.test(QUERY_TOOL) && FEED_TOOLS.every((tool) => !MUTATING_TOOL.test(tool)));
}

function responseMeta(requestId, source = "live") {
  return { schema_version: "1", request_id: requestId, source, upstream: "neuralbus", fetched_at: new Date().toISOString() };
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function contract(res, status, requestId, data, error = null, source = "live", headers = {}) {
  sendJson(res, status, { ok: error === null, data, meta: responseMeta(requestId, source), error }, headers);
}

function originFor(req) {
  const origin = req.headers.origin;
  if (!origin || PUBLIC_ORIGINS.has("*")) return PUBLIC_ORIGINS.has("*") ? "*" : null;
  return PUBLIC_ORIGINS.has(origin) ? origin : null;
}

function corsHeaders(req) {
  const origin = originFor(req);
  return origin ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Accept", Vary: "Origin" } : {};
}

function requestId(req) {
  return String(req.headers["x-request-id"] ?? `req_${randomUUID()}`);
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "unknown").split(",")[0].trim();
}

function withinRateLimit(req) {
  const now = Date.now();
  const key = clientIp(req);
  const current = requestsByIp.get(key) ?? { start: now, count: 0 };
  if (now - current.start >= 60_000) Object.assign(current, { start: now, count: 0 });
  current.count += 1;
  requestsByIp.set(key, current);
  return current.count <= RATE_LIMIT;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("BODY_TOO_LARGE"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseMcpResponse(text, contentType) {
  if (contentType?.includes("text/event-stream")) {
    const data = text.split(/\r?\n\r?\n/).flatMap((block) => block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim())).find(Boolean);
    return data ? JSON.parse(data) : null;
  }
  return text ? JSON.parse(text) : null;
}

async function upstreamRpc(method, params = {}) {
  let session = sessions.get("upstream");
  if (!session && method !== "initialize") {
    await upstreamRpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "swat-forense-avatar-gateway", version: "1.0.0" } });
    session = sessions.get("upstream");
  }
  const id = randomUUID();
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", [AUTH_HEADER]: AUTH_PREFIX ? `${AUTH_PREFIX} ${MCP_API_KEY}` : MCP_API_KEY };
  if (session?.sessionId) headers["Mcp-Session-Id"] = session.sessionId;
  const upstream = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(15_000) });
  const sessionId = upstream.headers.get("Mcp-Session-Id");
  if (sessionId) sessions.set("upstream", { sessionId, touched: Date.now() });
  const response = parseMcpResponse(await upstream.text(), upstream.headers.get("Content-Type"));
  if (!upstream.ok) throw Object.assign(new Error("UPSTREAM_HTTP_ERROR"), { status: upstream.status });
  if (response?.error) throw Object.assign(new Error("UPSTREAM_RPC_ERROR"), { status: 502 });
  return response?.result ?? null;
}

function normalizeResult(result, source) {
  const payload = result?.structuredContent ?? result;
  const content = Array.isArray(payload?.content) ? payload.content : [];
  const text = content.filter((item) => item?.type === "text").map((item) => item.text).join("\n");
  let value = payload;
  if (text) {
    try { value = JSON.parse(text); } catch { value = text; }
  }
  const records = Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [value];
  return records.filter((record) => record && typeof record === "object").map((record, index) => {
    const id = String(record.id ?? record.sensor_id ?? record.operation_id ?? record.address ?? record.wallet ?? record.hash ?? `${source}-${index}`);
    const rawRisk = record.risk ?? record.risk_score ?? record.riskScore ?? record.score ?? record.severity_score;
    const numericRisk = Number(rawRisk);
    const risk = Number.isFinite(numericRisk) ? Math.round(Math.max(0, Math.min(100, numericRisk <= 1 ? numericRisk * 100 : numericRisk))) : null;
    const tags = Array.isArray(record.tags) ? record.tags : [];
    const domains = Array.isArray(record.domains) ? record.domains : [];
    const scalarSummary = Object.entries(record)
      .filter(([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value))
      .slice(0, 5)
      .map(([key, value]) => `${key}: ${String(value)}`)
      .join("; ");
    const nestedSummary = Object.entries(record)
      .filter(([, value]) => value && typeof value === "object" && !Array.isArray(value))
      .map(([key, value]) => {
        const status = value.status ?? value.state;
        return status ? `${key}: ${String(status)}` : "";
      })
      .filter(Boolean)
      .join("; ");
    const status = record.status ?? record.state;
    return { id, label: String(record.label ?? record.name ?? record.title ?? record.summary ?? (status ? `${source} ${status}` : undefined) ?? record.sensor_id ?? record.operation_id ?? id), category: String(record.category ?? record.result_type ?? record.type ?? record.kind ?? tags[0] ?? domains[0] ?? source).toUpperCase(), risk, detail: String(record.detail ?? record.description ?? record.summary ?? record.subtitle ?? record.message ?? record.text ?? [scalarSummary, nestedSummary].filter(Boolean).join("; ")), source };
  });
}

async function fetchFeed() {
  const results = await Promise.all(FEED_TOOLS.map((tool) => upstreamRpc("tools/call", { name: tool, arguments: {} }).then((result) => normalizeResult(result, tool))));
  return results.flat();
}

async function handleApi(req, res, path) {
  const id = requestId(req);
  const headers = corsHeaders(req);
  if (!configReady()) {
    contract(res, 503, id, null, { code: "GATEWAY_NOT_CONFIGURED", message: "El gateway no tiene una configuracion MCP publica segura", retryable: false }, "unavailable", headers);
    return;
  }
  if (!withinRateLimit(req)) {
    contract(res, 429, id, null, { code: "RATE_LIMITED", message: "Limite de uso excedido", retryable: true }, "unavailable", { ...headers, "Retry-After": "60" });
    return;
  }
  try {
    if (path === "/api/v1/capabilities" && req.method === "GET") {
      contract(res, 200, id, { capabilities: ["feed", "query"], query: { max_length: MAX_QUERY_LENGTH }, tools: FEED_TOOLS.length + 1 }, null, "live", headers);
      return;
    }
    if (path === "/api/v1/feed" && req.method === "GET") {
      contract(res, 200, id, { items: await fetchFeed() }, null, "live", headers);
      return;
    }
    if (path === "/api/v1/query" && req.method === "POST") {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch (error) { contract(res, error?.message === "BODY_TOO_LARGE" ? 413 : 400, id, null, { code: error?.message === "BODY_TOO_LARGE" ? "BODY_TOO_LARGE" : "INVALID_REQUEST", message: "La peticion no es valida", retryable: false }, "unavailable", headers); return; }
      const query = typeof body?.query === "string" ? body.query.trim() : "";
      if (!query || query.length > MAX_QUERY_LENGTH) { contract(res, 400, id, null, { code: "INVALID_REQUEST", message: `query debe tener entre 1 y ${MAX_QUERY_LENGTH} caracteres`, retryable: false }, "unavailable", headers); return; }
      const result = await upstreamRpc("tools/call", { name: QUERY_TOOL, arguments: { [QUERY_ARG]: query } });
      contract(res, 200, id, { items: normalizeResult(result, QUERY_TOOL), query }, null, "live", headers);
      return;
    }
    contract(res, 404, id, null, { code: "NOT_FOUND", message: "Ruta no encontrada", retryable: false }, "unavailable", headers);
  } catch (error) {
    const status = error?.name === "TimeoutError" ? 504 : 502;
    contract(res, status, id, null, { code: status === 504 ? "UPSTREAM_TIMEOUT" : "UPSTREAM_ERROR", message: "No se pudo obtener informacion de NeuralBus", retryable: status === 504 }, "unavailable", headers);
  }
}

function handler(req, res) {
  if (req.method === "OPTIONS") { res.writeHead(204, corsHeaders(req)); res.end(); return; }
  if (req.url === "/healthz" && req.method === "GET") {
    const ready = configReady();
    sendJson(res, ready ? 200 : 503, { ok: ready, data: { service: "swat-forense-avatar-gateway", status: ready ? "ready" : "not_configured" }, meta: { schema_version: "1" }, error: ready ? null : { code: "GATEWAY_NOT_CONFIGURED", retryable: false } });
    return;
  }
  void handleApi(req, res, req.url?.split("?")[0] ?? "");
}

export const server = http.createServer(handler);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, HOST, () => console.log(`SWAT gateway listening on http://${HOST}:${PORT}`));
}

