#!/bin/bash
set -euo pipefail

# root で実行されているか確認
if [[ $EUID -ne 0 ]]; then
  echo "Error: sudo bash setup.sh で実行してください" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="/opt/auth-proxy"
SOCKET_DIR="/run/auth-proxy"

echo "=== [1/5] TypeScript ビルド ==="
cd "$SCRIPT_DIR"
npm run build

echo ""
echo "=== [2/5] ユーザー・グループ作成 ==="

# グループ作成
if ! getent group agent-access > /dev/null 2>&1; then
  groupadd agent-access
  echo "  グループ agent-access を作成しました"
else
  echo "  グループ agent-access は既に存在します"
fi

# proxy-admin ユーザー作成
if ! id proxy-admin > /dev/null 2>&1; then
  useradd -r -m -s /bin/bash proxy-admin
  echo "  ユーザー proxy-admin を作成しました"
else
  echo "  ユーザー proxy-admin は既に存在します"
fi

# agent ユーザー作成
if ! id agent > /dev/null 2>&1; then
  useradd -r -m -s /bin/bash -G agent-access agent
  echo "  ユーザー agent を作成しました (agent-access グループに追加)"
else
  usermod -aG agent-access agent
  echo "  ユーザー agent は既に存在します (agent-access グループに追加)"
fi

echo ""
echo "=== [3/5] ディレクトリ設定 ==="

mkdir -p "$APP_DIR"
chown proxy-admin:proxy-admin "$APP_DIR"

mkdir -p "$SOCKET_DIR"
chown proxy-admin:agent-access "$SOCKET_DIR"
chmod 0750 "$SOCKET_DIR"
echo "  $SOCKET_DIR を作成しました"

# 再起動後もディレクトリを維持する設定
echo "d /run/auth-proxy 0750 proxy-admin agent-access -" \
  > /etc/tmpfiles.d/auth-proxy.conf
echo "  /etc/tmpfiles.d/auth-proxy.conf を作成しました"

echo ""
echo "=== [4/5] ファイルデプロイ ==="

# アプリファイルをコピー
cp -r "$SCRIPT_DIR/dist"              "$APP_DIR/"
cp    "$SCRIPT_DIR/package.json"      "$APP_DIR/"
cp    "$SCRIPT_DIR/package-lock.json" "$APP_DIR/"
cp    "$SCRIPT_DIR/config.yaml"       "$APP_DIR/"

# 本番用 node_modules インストール（root のまま実行し後で chown）
cd "$APP_DIR"
npm install --omit=dev --silent

# すべてのファイルを一括で chown（node_modules 含む）
chown -R proxy-admin:proxy-admin "$APP_DIR"
chmod 600 "$APP_DIR/config.yaml"
echo "  $APP_DIR にデプロイしました"

echo ""
echo "=== [5/5] keys.json 設定 ==="

if [[ ! -f "$APP_DIR/keys.json" ]]; then
  cat > "$APP_DIR/keys.json" << 'EOF'
{
  "cerebras_main": "csk-XXXXXXXX",
  "openai_main": "sk-XXXXXXXX",
  "tavily": "tvly-XXXXXXXX",
  "google_main": "AIzaXXXXXXXX"
}
EOF
  echo "  テンプレートを作成しました: $APP_DIR/keys.json"
  echo "  ★ APIキーを入力してください ★"
else
  echo "  既存の keys.json を使用します"
fi

# keys.json のパーミッションは常に設定
chown proxy-admin:proxy-admin "$APP_DIR/keys.json"
chmod 600 "$APP_DIR/keys.json"

echo ""
echo "=================================================="
echo "  セットアップ完了"
echo "=================================================="
echo ""
echo "次のステップ:"
echo ""

if grep -q "XXXXXXXX" "$APP_DIR/keys.json" 2>/dev/null; then
  echo "  1. APIキーを設定（要 root）:"
  echo "       sudo nano $APP_DIR/keys.json"
  echo ""
  echo "  2. プロキシを起動:"
else
  echo "  1. プロキシを起動:"
fi

echo "       sudo -u proxy-admin node $APP_DIR/dist/server.js"
echo ""
echo "  ※ SDK からの接続テスト（UDS 未対応の場合は --tcp-fallback）:"
echo "       sudo -u proxy-admin node $APP_DIR/dist/server.js --tcp-fallback"
echo "       curl http://127.0.0.1:8081/cerebras/v1/chat/completions ..."
echo ""
