# タスク進捗

## 完了

- [x] 仕様書 v1.2 → v1.3 更新（暗号化・レートリミット削除、OSユーザー分離に一本化）
- [x] `config.yaml` 作成（サービス定義: openai, cerebras, tavily, google）
- [x] `src/server.ts` 改修
  - [x] `config.yaml` からサービス設定を動的に読み込み
  - [x] UDS モード対応（`--tcp-fallback` フラグで TCP も可）
  - [x] ログフォーマット改善（ISO タイムスタンプ付き）
  - [x] エラーレスポンスに末尾改行を追加
- [x] `setup.sh` 作成・修正（冪等、ユーザー/グループ/ディレクトリ/デプロイ）
- [x] `COMMANDS.md` 作成（よく使うコマンド一覧）
- [x] セットアップ実行・動作確認（`proxy-admin` ユーザーでサーバー起動確認）

## 未着手

- [ ] `preflight-check.sh` 作成（環境確認スクリプト）
- [ ] `setup.sh` に `preflight-check.sh` 実行ステップを追加
