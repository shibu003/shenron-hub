# prototype/mcp — BuildHUD MCP server (次セッションの入口)

BuildHUD を **MCP server** として公開し、AI（Claude/Codex 等）が agent / workflow / automation を **発見・検索・実行**できる control plane。設計は `docs/10_MCP_INTERFACE.md`。
肝 = **clean-mcp 流 token-light index**：`search_*` は小さな ref を返し、`get_*` で必要な 1 件だけ展開（数百 agent でも定数トークン）。3 索引（agent / workflow / automation）は **1 つの generic searcher** を共有。

- `server.mjs` — 依存ゼロの MCP stdio server（newline-delimited JSON-RPC）。`../agents/*.json`・`workflows.json`・`automations.json` を索引。
- `workflows.json` — named workflow（例: `sales-to-marketing`）。run-on-demand な連鎖。
- `automations.json` — **trigger-bound** な run（`schedule` / `build_state`）。「build-state を引き金に走らせる」中核。各 automation = trigger ＋ bound workflow ＋ default input。

## Tools（11）

| tool | 種別 | 入力 | 返り |
|---|---|---|---|
| `search_agents` | read | `{query, limit?}` | 小 ref `[{id,name,company,skillId,skill,tags}]` |
| `get_agent` | read | `{id}` | full agent（on-demand） |
| `search_workflows` | read | `{query, limit?}` | 小 ref `[{id,name,summary,steps,tags}]` |
| `get_workflow` | read | `{id}` | full 定義（steps） |
| `search_automations` | read | `{query, limit?}` | 小 ref `[{id,name,summary,trigger,workflow,enabled,tags}]` |
| `get_automation` | read | `{id}` | full 定義（trigger / bound workflow / default input） |
| `build_state` | read | `{}` | 要約（counts / ids / attended-unattended） |
| `run_handoff` | **act** | `{toAgentId, skill, input, confirm?}` | 1 handoff（`confirm:true` で実行、無しは dry-run） |
| `run_workflow` | **act** | `{id, input, confirm?}` | workflow 連鎖＋trace（`confirm:true` で実行） |
| `run_automation` | **act** | `{id, input?, confirm?}` | automation の bound workflow を即 fire（`confirm:true`／`--unattended`） |
| `fire_event` | **act** | `{event, input?, confirm?}` | build-state event に match した enabled automation を返す＋（`confirm:true`／`--unattended`）fire |

read/act 分離。**act は二段 fence**：(1) `confirm:true`（or `--unattended`）まで実行せず dry-run plan、(2) 実行は `A2A_SHARED_TOKEN` 必須（無ければ network に出ず即 refuse）。

## A. MCP client に登録（Claude Code 等）

`.mcp.json`（または `claude mcp add`）に：
```jsonc
{ "mcpServers": {
    "buildhud": {
      "command": "node",
      "args": ["/Users/you/GioGio/prototype/mcp/server.mjs"],
      "env": { "A2A_SHARED_TOKEN": "<your-shared-token>" }
    } } }
```
登録後、AI 側の典型フロー：`search_workflows("sales")` → `get_workflow("sales-to-marketing")` → `run_workflow("sales-to-marketing", "<brief>", confirm=true)`。
`A2A_SHARED_TOKEN` は `run_*`（実行）にのみ必要。read tools は不要。

## B. スタンドアロン smoke test（client 無しで stdio に流す）

```bash
cd /Users/you/GioGio
printf '%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
'{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
'{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_workflows","arguments":{"query":"sales"}}}' \
'{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"run_workflow","arguments":{"id":"sales-to-marketing","input":"x"}}}' \
| node prototype/mcp/server.mjs        # stdout = JSON-RPC, logs → stderr
```
id4 は `confirm` 無しなので **dry-run plan**（実行しない）。

## C. 実 LLM で workflow を実行（A社 Codex → B社 Claude）

`run_workflow(confirm:true)` は実行時に agents が起動している必要あり（`../agents/README.md`）。

```bash
cd /Users/you/GioGio
export A2A_SHARED_TOKEN=$(openssl rand -hex 16)
# 1) agents 起動（別ターミナル可。ここでは background）
node prototype/agents/agent.mjs --config prototype/agents/sales.json     &   # A社/Codex :8810
node prototype/agents/agent.mjs --config prototype/agents/marketing.json &   # B社/Claude :8811
# 2) MCP 経由で実行（confirm:true）
printf '%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
'{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"run_workflow","arguments":{"id":"sales-to-marketing","input":"Target: Series-A fintech SaaS; ICP VP Sales. Product: AI SDR that books meetings.","confirm":true}}}' \
| node prototype/mcp/server.mjs
```
返り（id2）= `{result:<B社 outreach>, trace:[{agent,skill,chars}...]}`。

**検証済（2026-06-16）**：trace = A社/find-prospects(~677B, Codex) → B社/draft-outreach(~1393B, Claude)、実 LLM でパーソナライズ文面を返却。

## D. Automation（build-state を引き金に）+ autonomous

automation = trigger（`schedule` / `build_state`）に bind した workflow。AI が「build が green になったら走らせる」を宣言的に持てる。

```bash
# build-state event を投げて、match した automation を確認（attended: dry-run）
printf '%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
'{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"fire_event","arguments":{"event":{"event":"review_completed","status":"green"}}}}' \
| node prototype/mcp/server.mjs
# → id2 = {event, matched:[{id:"on-green-build-outreach",...}], note:"...confirm:true / --unattended..."}
```

**autonomous（勝手に走る）= `--unattended` で opt-in**：

```bash
export A2A_SHARED_TOKEN=$(openssl rand -hex 16)
node prototype/agents/agent.mjs --config prototype/agents/sales.json     &
node prototype/agents/agent.mjs --config prototype/agents/marketing.json &
# --unattended: enabled automation を confirm 無しで fire（CI hook / cron から呼べる）
printf '%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
'{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"fire_event","arguments":{"event":{"event":"review_completed","status":"green"}}}}' \
| node prototype/mcp/server.mjs --unattended
# → id2 = {event, fired:[{automation, result:<B社 outreach>, trace:[...]}]}
```

二段 fence は autonomous でも生きる：`--unattended` は dry-run を飛ばすが、**`A2A_SHARED_TOKEN` 無しなら network に出ず即 refuse**（schedule trigger の cron 化は外部 scheduler に委譲、`when` は索引に保持するだけ）。

## 拡張（agent / workflow / automation を足す）
- agent 追加：`../agents/<name>.json` を 1 つ足すだけ（server が起動時に索引）。
- workflow 追加：`workflows.json` に `{id,name,summary,tags,steps:[{agent,skill}]}` を足す。
- automation 追加：`automations.json` に `{id,name,summary,tags,trigger:{type,...},workflow,input,enabled}` を足す。`trigger.type` は `schedule`（`when`=cron）か `build_state`（`match`={event,status,...} の subset 一致）。
- いずれも search index に自動で載る（token-light のまま）。

## Fence / 注意（docs/09・10）
- `run_*` / `fire_event` は既定 **attended**（`confirm:true` 必須）。autonomous は **`--unattended`（or `BUILDHUD_UNATTENDED=1`）で明示 opt-in**。どちらでも実行は `A2A_SHARED_TOKEN` 必須＝二段 fence。
- trust は **fake**（共有 token + allowlist）。本物の cross-party 認可(OBO/DPoP・M5)は未実装＝ship 不可。
- MCP の version 文字列/schema は最小・概形 → 本番は `@modelcontextprotocol/sdk` 採用も検討。
- **full dump tool を作らない**（`get_*` で 1 件ずつ＝token 節約の核）。

## 関連
`docs/10_MCP_INTERFACE.md`（設計）/ `prototype/agents/README.md`（A社↔B社）/ `prototype/README.md`（1-handoff）/ `docs/06 §6.6-6.7`（capture と MCP control plane）。
