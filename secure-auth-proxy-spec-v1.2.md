# Secure Auth Proxy for Local AI Agents

## 設計仕様書 v1.3（MVP）

---

## 1. コンセプト

ローカルで動作するAIエージェント（openclaw等）が、APIキーやOAuthトークンなどの認証情報を**直接参照できない**ようにしつつ、外部APIを利用できる仕組みを提供する。

### 1.1 解決する課題

- AIエージェントはbash実行やファイル読み書きが可能であり、平文保存されたAPIキーはプロンプトインジェクション等で容易に流出する
- アプリレベルの制限（相対パス禁止、bashコマンド制限）はエッジケースに弱く、バイパス手段が無数に存在する
- 同一プロセス内にキーとエージェントが共存する場合、メモリ読み取りにより原理的にアクセス可能

### 1.2 設計原則

**「認証情報を持つプロセスと、エージェントの実行環境を、OSレベルで異なるセキュリティ境界に置く」**

Linuxのユーザー分離を利用し、エージェントとは別ユーザーで認証プロキシを起動する。カーネルがプロセス間のメモリアクセスを遮断するため、プロンプトインジェクション程度の攻撃ではキーに到達できない。

### 1.3 注意: プロキシは「署名オラクル」である

プロキシはAPIキーの**窃取**を防ぐが、**権限の行使**は防げない。エージェントはプロキシを通じて認証済みリクエストを送れるため、キーに紐づく権限（高額APIコール等）を悪用される可能性がある。MVPではAPI提供元のダッシュボードで課金上限を設定する運用とする。

---

## 2. 前提条件

### 2.1 動作環境

- **OS**: Linux（Ubuntu/EndeavourOS等）
- **ランタイム**: Node.js（TypeScript）
- **ユーザー**: 2つのLinuxユーザーを使用
  - `proxy-admin`: 認証プロキシを実行。キーファイルの所有者
  - `agent`: エージェントを実行

### 2.2 環境確認

以下の条件を起動前に確認する。確認スクリプト（`preflight-check.sh`）として実装する。

| 確認項目 | 期待値 | コマンド |
|---|---|---|
| agentのグループ | docker, lxd, libvirt, kvm, disk 等に含まれない | `groups agent` |
| ptrace_scope | 1以上 | `sysctl kernel.yama.ptrace_scope` |
| keys.jsonの所有者 | proxy-admin:proxy-admin | `stat /opt/auth-proxy/keys.json` |
| keys.jsonのパーミッション | 600 | 同上 |
| agentがsudoersにいない | sudo不可 | `sudo -l -U agent` |

スクリプトは全項目をチェックし、問題があれば警告を出してプロキシの起動を中断する。

---

## 3. アーキテクチャ

### 3.1 全体構成

```
┌───────────────────────────────────────────────────────────┐
│  agentユーザー                                              │
│                                                             │
│  ┌─────────────┐                                           │
│  │  AIエージェント │                                           │
│  └──────┬──────┘                                           │
│         │                                                   │
│         │ Unix Domain Socket                                │
│         │ /run/auth-proxy/proxy.sock                        │
│         │ (proxy-admin:agent-access 0660)                   │
│         │                                                   │
├─────────┼───────────────────────────────────────────────────┤
│  proxy-adminユーザー                                         │
│         ▼                                                   │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  認証プロキシ                                            │ │
│  │                                                          │ │
│  │  ┌──────────────┐  ┌──────────────┐                     │ │
│  │  │ キー           │  │ サービス振り分け │                     │ │
│  │  │ (proxy-admin  │  │ + ヘッダ再構築  │                     │ │
│  │  │  のみ読み取り) │  │               │                     │ │
│  │  └──────────────┘  └──────────────┘                     │ │
│  └───────────────────────┬──────────────────────────────────┘ │
│                          │                                    │
└──────────────────────────┼────────────────────────────────────┘
                           │ HTTPS (認証ヘッダ付き, redirect無効)
                           ▼
                    ┌──────────────┐
                    │  外部API       │
                    └──────────────┘
```

### 3.2 なぜ Unix Domain Socket か

`localhost:8080` (TCP) では、同一マシン上の**全ユーザー・全プロセス・ブラウザ**から到達可能。UDSならファイルパーミッションで接続元を制限できる。

```bash
/run/auth-proxy/proxy.sock
  所有者: proxy-admin
  グループ: agent-access
  パーミッション: 0660

# agentユーザーをagent-accessグループに追加
sudo usermod -aG agent-access agent
```

SDK側がUDSを扱えない場合の代替:
- ループバックTCPのまま + `iptables` の owner match で `agent` UIDのみに限定

### 3.3 データフロー

```
1. エージェント → プロキシ (UDS経由)
   POST /anthropic/v1/messages
   Body: {"model": "claude-sonnet-4-20250514", "messages": [...]}
   ※ APIキーは含まれない

2. プロキシ内部処理
   a. パスから宛先サービスを特定 (/anthropic/*)
   b. 上流リクエストを新規構築（受信ヘッダをそのまま転送しない）
      - method / path / query / body のみ抽出
      - 認証ヘッダをkeys.jsonから注入
      - Host, Content-Type等を再構築
   c. redirect無効で外部APIに送信

3. プロキシ → 外部API
   POST https://api.anthropic.com/v1/messages
   Headers: { "x-api-key": "sk-ant-xxxxx", "Host": "api.anthropic.com" }

4. 外部API → プロキシ → エージェント
   レスポンスを返却
```

### 3.4 上流リクエストの構築ルール

受信したHTTPリクエストをそのまま転送**しない**。

**破棄するヘッダ:**
- `Authorization`, `x-api-key`
- `Host`, `Connection`
- `Proxy-*`, `X-Forwarded-*`, `Forwarded`
- `Transfer-Encoding`

**プロキシが設定するヘッダ:**
- 認証ヘッダ（keys.jsonから読み込んだキー）
- `Host`（ターゲットAPIのホスト名）
- `Content-Type`（受信値を検証して引き継ぎ）

**リダイレクト:**
- 自動リダイレクトは**無効**。認証ヘッダ付きリクエストが別originに飛ぶのを防ぐ。

### 3.5 ログのマスキング

- 認証ヘッダはログに出力しない
- リクエストのログは `method`, `path`, `status` のみ
- デバッグモードでもヘッダの全出力はしない

---

## 4. 認証情報の管理

### 4.1 キーファイルの保護方針

暗号化は行わない。**OSのファイルパーミッションによるアクセス制御**がセキュリティの根拠である。

```
理由: keys.jsonへのアクセスにはroot権限またはproxy-adminであることが必要。
      - agentユーザーはファイルを読めない（600パーミッション + 別ユーザー所有）
      - rootが取れる攻撃者に対して暗号化は無意味（どのみちメモリから読める）
      - パスワード保護は脅威モデルに対して不釣り合いな複雑さを生む
```

```bash
# keys.json の形式
{
  "anthropic_main": "sk-ant-...",
  "openai_main": "sk-...",
  "cerebras_main": "csk-...",
  ...
}

# 権限設定
chown proxy-admin:proxy-admin /opt/auth-proxy/keys.json
chmod 600 /opt/auth-proxy/keys.json
```

### 4.2 キーの保護状況

| 攻撃手法 | agentユーザーから可能か | 理由 |
|---|---|---|
| `cat keys.json` | 不可 | `proxy-admin:proxy-admin 600` でアクセス拒否 |
| `/proc/<pid>/mem` 読み取り | 不可 | 別ユーザー + カーネルが遮断 |
| `/proc/<pid>/environ` | 不可 | 環境変数に入れていない + 別ユーザー |
| `ptrace` アタッチ | 不可 | 別ユーザー + `ptrace_scope>=1` |
| UDS経由でキーを引き出す | 不可 | プロキシはキーをレスポンスに含めない |
| カーネル脆弱性で権限昇格 | 理論上可能 | OSアップデートで対処 |

---

## 5. サービス設定

### 5.1 設定ファイル

```yaml
# /opt/auth-proxy/config.yaml

proxy:
  socket: "/run/auth-proxy/proxy.sock"
  socket_owner: "proxy-admin"
  socket_group: "agent-access"
  socket_mode: "0660"

services:
  openai:
    target: "https://api.openai.com"
    auth_header: "Authorization"
    auth_prefix: "Bearer "
    key_id: "openai_main"

  cerebras:
    target: "https://api.cerebras.ai"
    auth_header: "Authorization"
    auth_prefix: "Bearer "
    key_id: "cerebras_main"

  tavily:
    target: "https://api.tavily.com"
    auth_header: "Authorization"
    auth_prefix: "Bearer "
    key_id: "tavily"

  # 新規サービス追加はここに足すだけ
  google:
    target: "https://generativelanguage.googleapis.com"
    auth_header: "x-goog-api-key"
    key_id: "google_main"
```

### 5.2 対応範囲

大体のAPIに対応可能。HTTP(S)でヘッダに認証情報を付けて送る方式であれば、LLM・検索・ツール系を問わず同じ仕組みで扱える。

---

## 6. SDK連携

### 6.1 Anthropic SDK

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  // UDS対応時はhttp-proxy-agent等でUDS経由接続
  // TCPフォールバック時はlocalhost指定
  baseURL: "http://localhost:8081/anthropic",
  apiKey: "dummy",
});
```

### 6.2 OpenAI SDK

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8081/openai/v1",
  apiKey: "dummy",
});
```

### 6.3 GitHub Copilot SDK

CLIのサーバーモードがプロキシの役割を果たす。自前HTTPプロキシは不要。

```bash
sudo -u proxy-admin copilot --server --port 4321
```

```typescript
import { CopilotClient } from "@github/copilot-sdk";

const client = new CopilotClient({
  cliUrl: "localhost:4321",
});
```

### 6.4 SDKとUDSの互換性

多くのSDKは `baseURL` にHTTP URLを期待するため、UDS直接接続に対応していない場合がある。

対処法:
1. SDKがHTTPエージェントのカスタマイズに対応 → UDS用エージェントを注入
2. 非対応 → TCPフォールバック（`--tcp-fallback` フラグ）+ iptables UID制限

---

## 7. セットアップ手順

### 7.1 初回セットアップ

```bash
# 1. ユーザーとグループの作成
sudo useradd -r -m -s /bin/bash proxy-admin
sudo groupadd agent-access
sudo useradd -r -m -s /bin/bash -G agent-access agent

# 2. プロキシアプリケーションの配置
sudo mkdir -p /opt/auth-proxy
sudo chown proxy-admin:proxy-admin /opt/auth-proxy

# 3. ソケットディレクトリの作成
sudo mkdir -p /run/auth-proxy
sudo chown proxy-admin:agent-access /run/auth-proxy
sudo chmod 0750 /run/auth-proxy

# 再起動後もディレクトリを維持するための設定
echo "d /run/auth-proxy 0750 proxy-admin agent-access -" \
  | sudo tee /etc/tmpfiles.d/auth-proxy.conf

# 4. proxy-adminに切り替えてセットアップ
sudo -u proxy-admin bash
cd /opt/auth-proxy
npm install

# 5. APIキーの保存
cat > keys.json << 'EOF'
{
  "anthropic_main": "sk-ant-xxxxx",
  "openai_main": "sk-xxxxx",
  "cerebras_main": "csk-xxxxx"
}
EOF
chmod 600 keys.json config.yaml
exit
```

### 7.2 日常の起動手順

```bash
# 1. 環境確認
sudo bash /opt/auth-proxy/preflight-check.sh

# 2. プロキシ起動
sudo -u proxy-admin node /opt/auth-proxy/dist/server.js
# → "Auth proxy listening on /run/auth-proxy/proxy.sock"

# 3. Copilot CLI起動（必要な場合、別ターミナル）
sudo -u proxy-admin copilot --server --port 4321

# 4. エージェント起動（別ターミナル）
sudo -u agent node /home/agent/my-agent.js
```

---

## 8. セキュリティ評価

### 8.1 脅威モデル

主な想定脅威: **プロンプトインジェクションによりエージェントが悪意あるコードを実行し、認証情報の外部流出を試みる**

### 8.2 防御レベルの比較

| 方式 | 攻撃難易度 |
|---|---|
| 平文ファイル保存（同一ユーザー） | 極めて低い（`cat` 一発） |
| アプリレベル制限 | 低い（バイパス多数） |
| 暗号化 + 同一ユーザー | 中（メモリから読み取り可能） |
| **本方式（ユーザー分離 + UDS）** | **極めて高い（カーネル脆弱性が必要）** |

暗号化を追加しても、rootが取れる攻撃者に対しては意味がない。脅威モデル（プロンプトインジェクション）に対してはユーザー分離だけで十分。

---

## 9. v2 検討事項

MVPでは対応せず、将来の強化として検討する項目。

### 9.1 接続元UID検証

UDSの `SO_PEERCRED` で接続元が `agent` ユーザーであることをプロセスレベルで検証する。MVPではソケットのファイルパーミッション（0660）で制御。

### 9.2 サービスごとのallowlist

method / path / model / bodyサイズの制限をサービスごとに設定し、署名オラクルとしての悪用を制限する。

### 9.3 budget/cost制御

日次・月次のコスト上限をプロキシ側で管理する。MVPではAPI提供元のダッシュボードで課金上限を設定する運用。

### 9.4 秘密保持部分の言語分離

キーの保持・ヘッダ注入をRust/Go/Cの小さなデーモンに切り出す。メモリのzeroize、`mlock()` 等が可能になる。

### 9.5 macOS対応

Keychain.appとの統合。Touch ID等による認証。

### 9.6 リフレッシュトークンの自動更新

OAuth等で定期的なトークン更新が必要なサービスについて、プロキシ内部で自動リフレッシュ。

### 9.7 systemd化

`systemd` のサービスユニットとして起動を管理。

### 9.8 監査ログ

全リクエストの監査ログ（認証情報マスク済み）を記録し、事後検証を可能にする。
