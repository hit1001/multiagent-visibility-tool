# Changelog

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
