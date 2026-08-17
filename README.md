# 神龍 (Shenron)

自己ホスト型の MCP コントロールプレーン。自然文の「願い」から **発見 → plan → 生成 → 承認 → 実行 → 定期化** までを1つの箱で回す。あなたの AI サブスク（Claude 等）で動くので**従量課金ゼロ**、credential は**あなたのマシンから出ない**、足りない道具は神龍が**自分で生成**する。

- **北極星**: ① 人生ゴールの concierge ② Langflow 非依存（MCP が真のコントロールプレーン）。
- **堀**: 従量0（本人サブスク）／ローカル credential ／道具生成。
- **全機能 MCP 完結**: web cockpit が無くても plan / generate / approve / run / schedule を MCP client から呼べる。

外部 npm 依存ゼロ（Node の標準ライブラリのみ）。ブラウザ操作が要る時だけ Playwright を `npx` で遅延起動する。

## Quickstart

Node ≥ 20 が必要。

```bash
# npm に公開後:
npx shenron-hub

# または リポジトリから直接:
git clone https://github.com/shibu003/shenron-hub.git
cd shenron-hub
node bin/shenron.mjs
```

起動したら玄関 (launcher) を開く:

```
http://localhost:8795/
```

- `/ui2` … フロー作業場（canvas でノードを配線）
- `/shenron` … 神龍事務所（願いを出す・庫・実行・設定）
- `/settings` … 設定（credential / 通知 / ユーザー）

ポートを変えるなら `PORT=9000 node bin/shenron.mjs`。

## MCP として使う

神龍は2つの MCP surface を出す（tool 定義は単一ソース＝`prototype/mcp/tools.mjs`）。

**リモート (claude.ai connector など)** — hub が `POST /mcp` で HTTP/SSE transport を提供。claude.ai の connector に hub の URL を登録するだけ。秘密値・権限・認証系は remote から遮断（`REMOTE_DENY`）。

**stdio (ローカル MCP client)**:

```bash
A2A_SHARED_TOKEN=$(openssl rand -hex 32) node prototype/mcp/server.mjs
```

`SHENRON_HUB`（既定 `http://localhost:8795`）で接続先 hub を指定。`run_*` / `fire_event` など副作用のある tool は `A2A_SHARED_TOKEN` が必要（閲覧系は不要）。

## 個人 vs チーム

- **既定 = 個人ハブ（無料・全機能）**: `A2A_SHARED_TOKEN` 未設定かつ未ログインなら hub は開放状態（openDev）。1人で全部使える。
- **チーム = multi-seat**: `A2A_SHARED_TOKEN` を設定するか Web UI ログインを有効にすると hub が閉じ、role（admin/member）・共有エージェント庫・admin gate が点灯する。最初の登録ユーザーが admin。

## トラブル時

```bash
node bin/shenron.mjs doctor
```

Node バージョン・Playwright Chromium・ポート競合・`A2A_SHARED_TOKEN`・ユーザー登録状態をチェックし、修正コマンドを表示する。

## ライセンス

**コア: Elastic License 2.0** — [`LICENSE`](LICENSE) 参照。
**MCP 接続面 (`prototype/mcp/`): Apache-2.0。**

自分のマシン・自分のチームでの self-host は無制限。禁止しているのは、
Shenron を第三者にホスト型 / マネージド型サービスとして提供することだけです。

どのファイルがどちらに属するかは [`LICENSE_SCOPE.md`](LICENSE_SCOPE.md) を参照。
MIT 時代のリリースは MIT のまま利用できます。

---

## このリポジトリについて

開発リポジトリから **動くコードだけを取り出した公開ミラー**です（hub 本体・MCP surface・エージェント実行系・テスト）。
設計メモ・開発ログ・運用ドキュメントは含みません。ライブ環境: <https://hub.shibubu.ai>
