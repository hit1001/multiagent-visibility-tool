# Changelog

## Unreleased

### Added

- **Cost tracking.** Estimated cost per LLM call, agent and run, shown live in the dashboard and
  saved with each run. Prices come from a built-in table that `pricing.json` can extend.
- **Analytics.** A dashboard panel and `GET /analytics`: cost and tokens per agent and model, tool
  error rates, average and p95 latency, and the agents and tools that take the most time.
- **New alerts:** run cost budget and slow tool calls. Individual alert types can be muted.
- **Workflow builder** at `/builder`: design a team of agents by drag and drop, save it, register
  it on the dashboard, and export registration code. Templates are stored via `/workflows`.
- **Plugins.** JavaScript files in `<data dir>/plugins/` (or named in `VISIBILITY_PLUGINS`) receive
  `onRunStart`, `onEvent`, `onRunFinish` and `onAlert`. Examples in `examples/plugins/`.
- Tutorials, a best-practices guide and `CONTRIBUTING.md`.
- **SDKs.** `require('agent-visibility/sdk')` for Node.js and `adapters/mavt_sdk.py` for Python.
- **Docker.** `Dockerfile`, `docker-compose.yml`, a `GET /healthz` endpoint and
  `VISIBILITY_DATA_DIR` to choose where data is stored.
- **Encryption at rest.** `VISIBILITY_ENCRYPTION_KEY` encrypts stored event data with AES-256-GCM.
- Documentation: [API reference](docs/API.md), [deployment](docs/DEPLOYMENT.md), [SDKs](docs/SDK.md).

### Changed

- **Redesigned interface.** The dashboard, workflow builder and sign-in page share one design
  system with light and dark themes (follows the system setting; switch with the button in the top
  bar). Run metrics moved to the top, the topology graph is sharp on high-density displays, agents
  can be selected to see their activity, the Tools tab can be filtered by kind, and alert rules
  moved into their own dialog.
- Pages no longer load fonts from Google; nothing is requested from other sites.
- Replaying a saved run shows each event at the time it happened.

### Security

- Logins expire after 12 hours (`VISIBILITY_SESSION_TTL_HOURS`); previously they lasted until restart.
- Ten failed logins from one address lock it out for 15 minutes.
- The audit log now records logins, API key changes, run deletions, alert changes and resets.
- `VISIBILITY_COOKIE_SECURE=1` marks the session cookie `Secure` for HTTPS deployments.
- A request that fails unexpectedly returns a 500 instead of stopping the server.

### Changed

- `metrics` in state snapshots and run summaries has a new `cost` field.

## 0.5.0

A security and reliability release. **Read "Upgrading" before you update.**

### Upgrading

- **Node.js 22 or newer** is required (Node 20 is end-of-life). With npm 12, install with
  `npm install -g agent-visibility --allow-scripts=better-sqlite3`.
- **The dashboard only listens on `127.0.0.1` by default.** To reach it from another machine, use
  `--host 0.0.0.0 --password <pwd>`.
- **Python adapters were renamed.** Copy `mavt_client.py` plus `mavt_langchain.py`, `mavt_autogen.py` or
  `mavt_crewai.py` into your project and import from them (`from mavt_langchain import AgentscopeCallback`).
- **Licence keys have a new format.** Keys issued for 0.4 no longer validate; request a new one.
- **Password-protected dashboards:** give adapters an API key (`api_key=` or `VISIBILITY_API_KEY`).
  The `--mcp` bridge authenticates automatically.

### Security

- Dashboard and MCP bridge listen on localhost only; non-local addresses require a password.
- Removed wildcard CORS; cross-site requests and DNS-rebinding attempts are rejected.
- Agent-supplied text is escaped everywhere in the dashboard, so content an agent reads from the web
  can't run script in it.
- Licence keys are Ed25519-signed; the old scheme could be forged from the published source.
- Timing-safe password check, `SameSite=Strict` session cookie, 1 s delay after a wrong password.
- Malformed cookies or JSON no longer crash the server; request bodies are capped at 5 MB.

### Fixes

- Password mode works with real agents: adapters send API keys and the MCP bridge is authenticated.
  Previously every event was rejected silently.
- LangChain adapter is a real `BaseCallbackHandler`. The previous version raised `AttributeError` inside
  your chain.
- Each run starts from a clean state; tokens, steps and events no longer carry over between runs, and
  agents registered before `set_goal` are saved with the run.
- Replaying a run no longer changes history or sends alerts, and `/runs/<id>/state` without `?seq`
  returns the full run.
- Token budget alerts fire only for agents with a budget, once per run; no "agent stuck" alerts after a
  run ends; the Retries counter counts real retry events.
- Alert settings persist across restarts.
- MCP bridge exposes `log_tool_call`, `log_embedding` and `log_retrieval`, and reports errors.
- Adapters stop sending after the dashboard is unreachable instead of adding a 2 s timeout to every event.
- `better-sqlite3` is now optional; if it can't build, the dashboard runs without history.

### Development

- Test suites for the server, database, licences, security, replay and Python adapters.
- CI on Node 22, 24 and 26; npm releases are published from version tags with provenance.
