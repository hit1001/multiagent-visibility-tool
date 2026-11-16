# HTTP API

The dashboard server listens on `http://localhost:4242` by default. Everything the dashboard
does goes through this API, so anything that can send HTTP can report events or read results.

## Authentication

Without `--password` no authentication is needed (the server only listens on `127.0.0.1`).

With `--password`, every endpoint except `/healthz` and the login routes needs one of:

| Credential | Header | Used by |
|---|---|---|
| Session cookie | `Cookie: agentscope_session=…` (set by `POST /auth/login`) | The dashboard in a browser |
| API key | `X-API-Key: mavt_sk_…` | Agents, adapters, SDKs, scripts |

Create API keys in the dashboard under **API keys** or with `POST /keys`. Each key has its own
rate limit (requests per minute, default 60); over the limit the server answers `429`.

Sessions last 12 hours (`VISIBILITY_SESSION_TTL_HOURS`). After 10 failed logins from one address
within 15 minutes, further logins from that address get `429` until the window ends.

Browser requests from other origins are rejected with `403`. Set `VISIBILITY_CORS_ORIGIN` to allow one.

## Reporting events

### `POST /tool`

```json
{ "tool": "log_llm_turn", "args": { "agent": "lead", "prompt_tokens": 1200, "completion_tokens": 300 } }
```

Returns `{ "ok": true }`, or `{ "error": "Unknown tool: …" }`.

| Tool | Required args | Optional args |
|---|---|---|
| `set_goal` | `goal` | `run_id` (starts a new run when it changes) |
| `register_agent` | `id`, `label` | `role` (`orchestrator`, `worker`, `researcher`, `coder`, `critic`, `synthesiser`), `model`, `reports_to`, `token_budget`, `color` |
| `log_event` | `agent`, `event_type`, `message` | `tokens`, `latency_ms`, `metadata` |
| `log_llm_turn` (alias `log_generation`) | `agent` | `model`, `prompt_tokens`, `completion_tokens`, `latency_ms`, `stop_reason`, `messages` (`[{role, content}]`), `response`, `thinking` |
| `log_tool_call` | `agent`, `tool_name` | `input`, `output`, `latency_ms`, `error` |
| `log_retrieval` | `agent`, `query` | `results` (`[{text, score}]`), `latency_ms` |
| `log_embedding` | `agent`, `text` | `model`, `dims`, `latency_ms` |
| `trace_step` | `from_agent`, `to_agent` | `label`, `arrow_type` (`msg`, `result`, `retry`, `tool`) |
| `set_agent_state` | `agent_id`, `status` | |
| `set_memory` | `key`, `value` | `op` (`write`, `read`) |
| `set_plan` | `tasks` | |
| `finish_run` | | `status` (`done` or `error`, default `done`) |

`event_type` is one of `start`, `plan`, `route`, `reply`, `tool`, `result`, `pass`, `fail`, `retry`,
`warn`, `error`, `done`.

Request bodies are limited to 5 MB. Long strings are truncated for display (for example responses
at 4,000 characters).

## Reading state

| Endpoint | Returns |
|---|---|
| `GET /state` | Snapshot of the current run: agents, events, memory, plan, metrics |
| `GET /events` | Server-sent events stream of live updates |
| `GET /runs?q=<text>` | Up to 50 saved runs, newest first; `q` searches goals and agent ids |
| `GET /runs/<id>` | One run's metadata; `summary` is JSON with `steps`, `tokens`, `cost` |
| `GET /runs/<id>/state?seq=<n>` | The run replayed up to event `n` (whole run without `seq`) |
| `DELETE /runs/<id>` | Deletes the run and its events |
| `GET /export/run/<id>` | The run and all its events as a JSON download |
| `GET /export/runs?since=<ms>&status=<s>&limit=<n>` | Run metadata as a JSON download |

`metrics` in a snapshot is `{ steps, tokens, retries, cost }`. Each agent has `tokens`, `calls` and,
once it has made a priced LLM call, `cost`.

## Analytics

### `GET /analytics?days=30&limit=50`

Cost, usage and latency over saved runs from the last `days` days (1–365), newest `limit` runs (1–500).

```json
{
  "window": { "days": 30, "limit": 50 },
  "totals": { "runs": 12, "llm_calls": 96, "tool_calls": 140, "prompt_tokens": 410000,
              "completion_tokens": 52000, "tokens": 462000, "cost_usd": 2.01, "unpriced_tokens": 0 },
  "agents": [ { "agent": "coder", "model": "claude-sonnet-5-5", "llm_calls": 30, "tokens": 210000,
                "cost_usd": 0.92, "avg_latency_ms": 2100, "p95_latency_ms": 4800,
                "total_latency_ms": 63000, "errors": 1 } ],
  "models": [ { "model": "claude-sonnet-5-5", "llm_calls": 60, "cost_usd": 1.7 } ],
  "tools":  [ { "tool": "web_search", "calls": 40, "errors": 2, "error_rate": 0.05,
                "avg_latency_ms": 340, "p95_latency_ms": 900, "total_latency_ms": 13600 } ],
  "bottlenecks": [ { "kind": "llm", "name": "coder", "calls": 30, "total_latency_ms": 63000, "share": 0.61 } ],
  "runs": [ { "id": "…", "goal": "…", "status": "done", "duration_ms": 41000, "tokens": 9600, "cost_usd": 0.036 } ]
}
```

`bottlenecks` lists the five agents (LLM time) or tools that account for the most reported latency;
`share` is their fraction of the total.

### How cost is estimated

Cost is `prompt_tokens × input price + completion_tokens × output price`, using list prices per
million tokens. It ignores prompt-caching discounts, batch discounts and long-context surcharges,
so treat it as an estimate.

- `log_llm_turn` uses its own `model`, or the agent's registered model if it has none.
- `log_event` only carries a token total, so it is priced at the average of the model's input and
  output price.
- A model that isn't in the price table costs nothing and its tokens are reported as
  `unpriced_tokens`.

To add or change prices, create `pricing.json` in the data directory (`~/.agentscope/` by default)
and restart. Values are USD per million tokens, `[input, output]`:

```json
{ "qwen3-coder": [0, 0], "my-finetune": [1.5, 6] }
```

A model id matches the longest key it starts with, so `claude-sonnet-4` also covers
`claude-sonnet-4-20250514`.

## Alerts

| Endpoint | Purpose |
|---|---|
| `GET /alerts/config` | Current settings |
| `POST /alerts/config` | Update any subset of settings |
| `GET /alerts/history?limit=50` | Recently fired alerts |

| Setting | Default | Alert fired |
|---|---|---|
| `webhookUrl` | none | Where alerts are POSTed (Slack and Discord URLs get formatted messages) |
| `tokenBudgetPct` | 90 | `token_budget_exceeded` when an agent reaches this % of its `token_budget` |
| `stuckAgentSec` | 120 | `agent_stuck` when a running agent is silent this long |
| `criticFailRatePct` | 50 | `critic_fail_rate` when critics fail this often (after 3 events) |
| `costBudgetUsd` | off | `cost_budget_exceeded` when a run's estimated cost reaches this many dollars |
| `slowToolMs` | off | `slow_tool_call` when a tool call takes this long (once per tool per run) |
| `disabled` | `[]` | Alert types to mute, e.g. `["agent_stuck"]` |

`run_duration_outlier` fires when a run takes more than two standard deviations longer than the
last ten.

## Workflow templates

Made in the builder at `/builder`; also usable directly.

| Endpoint | Purpose |
|---|---|
| `GET /workflows` | List saved templates: `[{ id, name, updated_at, agents }]` (`agents` is a count) |
| `POST /workflows` | Create a template, or update one when the body has an existing `id` |
| `GET /workflows/<id>` | One template with its agents |
| `POST /workflows/<id>/apply` | Register the template's agents on the dashboard |
| `DELETE /workflows/<id>` | Delete a template |

```json
{ "name": "Review team", "agents": [
  { "id": "lead", "label": "Lead", "role": "orchestrator", "model": "claude-sonnet-5-5" },
  { "id": "dev", "label": "Developer", "role": "coder", "reports_to": "lead", "token_budget": 50000 }
] }
```

A template has 1–50 agents. Ids are 1–40 letters, digits, `.`, `_` or `-` and must be unique;
`reports_to` must name another agent in the template and must not form a loop. Invalid templates
get `400` with the reason. `x` and `y` (canvas position) are optional.

## Plugins

`GET /plugins` lists loaded plugins: `[{ name, source, hooks }]`. See [Plugins](PLUGINS.md).

## Administration

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | Liveness check, no auth: `{ ok, version, persistence }` |
| `GET /keys` · `POST /keys` · `DELETE /keys/<id>` | List, create (`{ label, rateLimit }`) and revoke API keys. The key is shown once. |
| `GET /audit?key_id=&since=&limit=` | Audit log, newest first |
| `POST /reset` | Clear the live view (saved runs are kept) |
| `POST /emulate` | Run a demo scenario: `{ "scenario": "research_code" }` |
| `GET /licence/status` | Licence state |
| `GET /api/v1/metrics` | Aggregate run metrics (commercial licence) |

Audit log rows are `{ id, key_id, tool, run_id, ts, detail }`. Every `/tool` call is recorded with
the API key that made it. Administrative actions are recorded as `admin.login`,
`admin.login_failed`, `admin.logout`, `admin.key_create`, `admin.key_delete`, `admin.run_delete`,
`admin.alerts_config`, `admin.reset`, `admin.workflow_save`, `admin.workflow_apply` and
`admin.workflow_delete`.
