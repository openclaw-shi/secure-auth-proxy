import express, { Request, Response } from "express";
import { fetch } from "undici";
import * as fs from "fs";
import * as path from "path";

// ---- 設定 ----

const PORT = 8080;

// バックエンドサービスの定義
// OpenAI互換なら target に向けるだけ
const SERVICES: Record<string, { target: string; authHeader: string; authPrefix?: string }> = {
  cerebras: {
    target: "https://api.cerebras.ai",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  openai: {
    target: "https://api.openai.com",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
};

// APIキーの読み込み
// keys.json（プロジェクトルート）があればそこから、なければ環境変数にフォールバック
// keys.json の形式: { "CEREBRAS_API_KEY": "csk-...", "OPENAI_API_KEY": "sk-..." }
const KEYS_FILE = path.resolve(__dirname, "../keys.json");
let keysFromFile: Record<string, string> = {};
if (fs.existsSync(KEYS_FILE)) {
  keysFromFile = JSON.parse(fs.readFileSync(KEYS_FILE, "utf-8"));
  console.log(`keys.json を読み込みました: ${KEYS_FILE}`);
}

function getApiKey(service: string): string {
  const envName = `${service.toUpperCase()}_API_KEY`;
  const key = keysFromFile[envName] ?? process.env[envName];
  if (!key) {
    throw new Error(`APIキーが見つかりません。keys.json に ${envName} を設定してください`);
  }
  return key;
}

// ---- プロキシロジック ----

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

function sanitizeHeaders(incoming: Record<string, string | string[] | undefined>): Record<string, string> {
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

// rawボディが必要なのでjsonパーサーより先にraw取得
app.use(express.raw({ type: "*/*", limit: "10mb" }));

// ルート: /:service/v1/* → 対応バックエンドに転送
// app.use で受けることで Express v5 のワイルドカード制約を回避
app.use(async (req: Request, res: Response) => {
  // パスの最初のセグメントをサービス名として解釈
  // 例: /cerebras/v1/chat/completions → serviceName=cerebras, upstream=/v1/chat/completions
  const parts = req.path.split("/").filter(Boolean);
  const serviceName = parts[0] ?? "";
  const backend = SERVICES[serviceName];

  if (!backend) {
    res.status(404).json({
      error: `Unknown service: "${serviceName}". Available: ${Object.keys(SERVICES).join(", ")}`,
    });
    return;
  }

  // パスから /:service を除いて残りをそのまま使う
  const upstreamPath = req.path.replace(new RegExp(`^/${serviceName}`), "") || "/";
  const upstreamUrl = `${backend.target}${upstreamPath}${req.url.includes("?") ? "?" + req.url.split("?")[1] : ""}`;

  let apiKey: string;
  try {
    apiKey = getApiKey(serviceName);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
    return;
  }

  // ヘッダ再構築（受信ヘッダをそのまま転送しない）
  const upstreamHeaders: Record<string, string> = {
    ...sanitizeHeaders(req.headers as Record<string, string>),
    [backend.authHeader]: `${backend.authPrefix ?? ""}${apiKey}`,
    host: new URL(backend.target).host,
  };

  const method = req.method;
  const hasBody = !["GET", "HEAD", "DELETE"].includes(method);

  console.log(`→ ${method} ${serviceName}${upstreamPath}`);

  try {
    const upstream = await fetch(upstreamUrl, {
      method,
      headers: upstreamHeaders,
      body: hasBody && Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined,
      redirect: "manual", // リダイレクト自動追従を無効化
    });

    // レスポンスをそのままパイプ
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    const body = await upstream.arrayBuffer();
    res.end(Buffer.from(body));

    console.log(`← ${upstream.status} ${serviceName}${upstreamPath}`);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(502).json({ error: "Bad Gateway", detail: (err as Error).message });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Auth proxy listening on http://127.0.0.1:${PORT}`);
  console.log(`Usage: http://127.0.0.1:${PORT}/<service>/v1/chat/completions`);
  console.log(`Available services: ${Object.keys(SERVICES).join(", ")}`);
});
