import express, { Request, Response } from "express";
import { fetch } from "undici";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

// ---- 設定読み込み ----

interface ServiceConfig {
  target: string;
  auth_header: string;
  auth_prefix?: string;
  key_id: string;
}

interface ProxyConfig {
  proxy: {
    socket: string;
    socket_mode: string;
  };
  services: Record<string, ServiceConfig>;
}

const CONFIG_FILE =
  process.env.AUTH_PROXY_CONFIG ?? path.resolve(__dirname, "../config.yaml");

const config = yaml.load(fs.readFileSync(CONFIG_FILE, "utf-8")) as ProxyConfig;

// ---- 起動時バリデーション ----

if (!config.services || typeof config.services !== "object") {
  console.error("Error: config.yaml に services が定義されていません");
  process.exit(1);
}

for (const [name, svc] of Object.entries(config.services)) {
  const missing: string[] = [];
  if (!svc.target) missing.push("target");
  if (!svc.auth_header) missing.push("auth_header");
  if (!svc.key_id) missing.push("key_id");
  if (missing.length > 0) {
    console.error(`Error: services.${name} に必須項目がありません: ${missing.join(", ")}`);
    process.exit(1);
  }
  try {
    new URL(svc.target);
  } catch {
    console.error(`Error: services.${name}.target が有効なURLではありません: "${svc.target}"`);
    process.exit(1);
  }
}

const SERVICES: Record<string, ServiceConfig> = config.services;

const TCP_FALLBACK = process.argv.includes("--tcp-fallback");
const TCP_PORT = 8081;
const SOCKET_PATH =
  process.env.AUTH_PROXY_SOCKET ?? config.proxy.socket;

// ---- APIキー読み込み ----

const KEYS_FILE =
  process.env.AUTH_PROXY_KEYS ?? path.resolve(__dirname, "../keys.json");

if (!fs.existsSync(KEYS_FILE)) {
  console.error(`Error: keys.json が見つかりません: ${KEYS_FILE}`);
  process.exit(1);
}

const apiKeys: Record<string, string> = JSON.parse(
  fs.readFileSync(KEYS_FILE, "utf-8")
);
console.log(`keys.json を読み込みました: ${KEYS_FILE}`);

// 各サービスが参照する key_id がキーファイルに存在するか確認
for (const [name, svc] of Object.entries(SERVICES)) {
  if (!apiKeys[svc.key_id]) {
    console.error(`Error: services.${name}.key_id "${svc.key_id}" が keys.json に見つかりません`);
    process.exit(1);
  }
}

function getApiKey(keyId: string): string {
  const key = apiKeys[keyId];
  if (!key) {
    throw new Error(`APIキーが見つかりません: key_id="${keyId}"`);
  }
  return key;
}

// ---- プロキシロジック ----

const UPSTREAM_TIMEOUT_MS = 30_000;

// 転送してはいけないヘッダ
const HOP_BY_HOP_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "host",
  "connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
]);

function sanitizeHeaders(
  incoming: Record<string, string | string[] | undefined>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    if (key.toLowerCase().startsWith("proxy-")) continue;
    if (key.toLowerCase().startsWith("x-forwarded-")) continue;
    if (value === undefined) continue;
    result[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}

// ---- サーバー起動 ----

const app = express();

app.use(express.raw({ type: "*/*", limit: "10mb" }));

app.use(async (req: Request, res: Response) => {
  const parts = req.path.split("/").filter(Boolean);
  const serviceName = parts[0] ?? "";
  const backend = SERVICES[serviceName];

  if (!backend) {
    res
      .status(404)
      .type("json")
      .send(
        JSON.stringify({
          error: `Unknown service: "${serviceName}". Available: ${Object.keys(SERVICES).join(", ")}`,
        }) + "\n"
      );
    return;
  }

  const upstreamPath =
    req.path.replace(new RegExp(`^/${serviceName}`), "") || "/";
  const upstreamUrl = `${backend.target}${upstreamPath}${
    req.url.includes("?") ? "?" + req.url.split("?")[1] : ""
  }`;

  let apiKey: string;
  try {
    apiKey = getApiKey(backend.key_id);
  } catch (e) {
    res
      .status(500)
      .type("json")
      .send(JSON.stringify({ error: (e as Error).message }) + "\n");
    return;
  }

  const upstreamHeaders: Record<string, string> = {
    ...sanitizeHeaders(req.headers as Record<string, string>),
    [backend.auth_header]: `${backend.auth_prefix ?? ""}${apiKey}`,
    host: new URL(backend.target).host,
  };

  const method = req.method;
  const hasBody = !["GET", "HEAD", "DELETE"].includes(method);

  console.log(
    `[${new Date().toISOString()}] → ${method} /${serviceName}${upstreamPath}`
  );

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(upstreamUrl, {
      method,
      headers: upstreamHeaders,
      body:
        hasBody && Buffer.isBuffer(req.body) && req.body.length > 0
          ? req.body
          : undefined,
      redirect: "manual",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    const body = await upstream.arrayBuffer();
    res.end(Buffer.from(body));

    console.log(
      `[${new Date().toISOString()}] ← ${upstream.status} ${method} /${serviceName}${upstreamPath}`
    );
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = (err as Error).name === "AbortError";
    console.error(`[${new Date().toISOString()}] ${isTimeout ? "TIMEOUT" : "ERROR"} ${method} /${serviceName}${upstreamPath}:`, (err as Error).message);
    res
      .status(isTimeout ? 504 : 502)
      .type("json")
      .send(JSON.stringify({ error: isTimeout ? "Gateway Timeout" : "Bad Gateway" }) + "\n");
  }
});

if (TCP_FALLBACK) {
  app.listen(TCP_PORT, "127.0.0.1", () => {
    console.log(`Auth proxy listening on http://127.0.0.1:${TCP_PORT}`);
    console.log(`Available services: ${Object.keys(SERVICES).join(", ")}`);
  });
} else {
  // 古いソケットファイルが残っていれば削除
  if (fs.existsSync(SOCKET_PATH)) {
    fs.unlinkSync(SOCKET_PATH);
  }

  const server = app.listen(SOCKET_PATH, () => {
    fs.chmodSync(SOCKET_PATH, parseInt(config.proxy.socket_mode ?? "0660", 8));
    console.log(`Auth proxy listening on ${SOCKET_PATH}`);
    console.log(`Available services: ${Object.keys(SERVICES).join(", ")}`);
  });

  const cleanup = () => {
    server.close();
    if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
    process.exit(0);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
}
