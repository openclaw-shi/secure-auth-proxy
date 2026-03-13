# よく使うコマンド

## プロキシ起動

```bash
# UDS モード（本番）
sudo -u proxy-admin node /opt/auth-proxy/dist/server.js

# TCP モード（開発・テスト用）
sudo -u proxy-admin node /opt/auth-proxy/dist/server.js --tcp-fallback
```

## 動作確認

```bash
# UDS 経由（agent ユーザーとして）
sudo -u agent curl -s --unix-socket /run/auth-proxy/proxy.sock \
  http://localhost/cerebras/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"llama3.1-8b","messages":[{"role":"user","content":"hi"}]}'

# TCP 経由（--tcp-fallback 起動時）
curl -s http://127.0.0.1:8081/cerebras/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"llama3.1-8b","messages":[{"role":"user","content":"hi"}]}'

# サービス一覧確認（UDS）
sudo -u agent curl -s --unix-socket /run/auth-proxy/proxy.sock http://localhost/unknown

# サービス一覧確認（TCP）
curl -s http://127.0.0.1:8081/unknown
```

## 開発（プロジェクトディレクトリ）

```bash
# TypeScript ビルド
npm run build

# ビルド後 /opt に反映
sudo cp -r dist/* /opt/auth-proxy/dist/

# 開発サーバー起動（プロジェクトディレクトリから）
node dist/server.js --tcp-fallback
```

## セットアップ・初期化

```bash
# 初回セットアップ（要 root）
sudo bash /home/openclaw/projects/secure-auth-proxy/setup.sh

# クリーンアップ（やり直し時）
sudo userdel -r proxy-admin
sudo userdel -r agent
sudo groupdel agent-access
sudo rm -rf /opt/auth-proxy /run/auth-proxy
sudo rm -f /etc/tmpfiles.d/auth-proxy.conf
```

## 状態確認

```bash
# プロキシプロセス確認
ps aux | grep "dist/server.js" | grep -v grep

# ソケットファイル確認
ls -la /run/auth-proxy/

# keys.json パーミッション確認
stat /opt/auth-proxy/keys.json

# ユーザー確認
id proxy-admin && id agent && getent group agent-access
```

## keys.json 編集

```bash
sudo nano /opt/auth-proxy/keys.json
```

フォーマット:
```json
{
  "cerebras_main": "csk-...",
  "openai_main": "sk-...",
  "tavily": "tvly-...",
  "google_main": "AIza..."
}
```
