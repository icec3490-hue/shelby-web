import http from "node:http";

const PORT = Number(process.env.PORT || 10000);
const SUPABASE_URL = new URL(
  process.env.SUPABASE_URL || "https://dflvklhnozxifhvnbzud.supabase.co",
);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "https://shelby-web.onrender.com";
const VERIFY_TOKEN = process.env.PAGAR_VERIFICATION_TOKEN || "";
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function setCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin !== FRONTEND_ORIGIN) return false;
  res.setHeader("Access-Control-Allow-Origin", FRONTEND_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "authorization, apikey, content-type, x-client-info, x-supabase-api-version");
  res.setHeader("Access-Control-Max-Age", "600");
  res.setHeader("Vary", "Origin");
  return true;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!setCors(req, res)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("Origin not allowed");
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end('{"status":"ok"}');
      return;
    }

    if (req.method === "GET" && req.url === "/.well-known/pagar-verification.txt") {
      if (!VERIFY_TOKEN) {
        res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end("Verification token not configured");
        return;
      }
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      }).end(VERIFY_TOKEN);
      return;
    }

    if (!req.url?.startsWith("/functions/v1/")) {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" }).end('{"error":"Not found"}');
      return;
    }

    const upstreamUrl = new URL(req.url, SUPABASE_URL);
    if (upstreamUrl.origin !== SUPABASE_URL.origin || !upstreamUrl.pathname.startsWith("/functions/v1/")) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" }).end('{"error":"Invalid route"}');
      return;
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (!value || ["host", "connection", "content-length", "accept-encoding"].includes(name.toLowerCase())) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }

    const body = ["GET", "HEAD"].includes(req.method || "GET") ? undefined : await readBody(req);
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(25000),
    });

    const responseHeaders = { "cache-control": upstream.headers.get("cache-control") || "no-store" };
    for (const name of ["content-type", "retry-after", "location"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders[name] = value;
    }
    res.writeHead(upstream.status, responseHeaders);
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    const status = Number(error?.status) || (error?.name === "TimeoutError" ? 504 : 502);
    if (!res.headersSent) res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: status === 413 ? "Request body too large" : "Backend temporarily unavailable" }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`SHELBY backend bridge listening on ${PORT}`);
});
