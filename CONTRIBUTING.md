# Contributing

Bug reports, fixes, framework adapters and plugins are all welcome.

## Set up

```bash
git clone https://github.com/hit1001/multiagent-visibility-tool
cd multiagent-visibility-tool
npm install
npm test                                # Node tests (server, database, security, SDK, plugins)
pip install langchain-core requests
python test/test_adapters.py            # Python adapters and SDK against a real server
npm run dev                             # dashboard on http://localhost:4242
```

Node.js 22 or newer. The server has one runtime dependency (`better-sqlite3`); please keep it that
way unless there is a strong reason.

## Pull requests

- Add or update a test for what you change. Tests start a real server on a free port with a
  temporary home directory (`test/helpers.js`), so they never touch your own data.
- Anything shown in the dashboard that came from an agent must be escaped (`esc()` in
  `dashboard.html`, `textContent` in `builder.html`). Agents report text they read from the web.
- New endpoints go behind the existing auth check and are added to [docs/API.md](docs/API.md).
- Update `CHANGELOG.md` under "Unreleased".

## Adding a framework adapter

Adapters live in `adapters/` as single files that import `mavt_client.py`. A good adapter:

1. Needs at most two lines in the user's code.
2. Registers agents as it first sees them and infers a role from the name (`infer_role`).
3. Reports model calls with `log_llm_turn` including token counts and the model name.
4. Never raises into the user's agent run and never slows it down (`VisibilityClient` already
   stops sending after the first failure).
5. Has a test in `test/test_adapters.py` that runs it against a real dashboard.

## Publishing a plugin

Plugins don't need to live in this repository. See [docs/PLUGINS.md](docs/PLUGINS.md) for the hook
API and naming convention. To have yours listed there, open a **Plugin submission** issue with a
link to the source. Listed plugins must have public source code and say plainly what data they
send and where.

## Reporting security problems

Please don't open a public issue for a vulnerability. Contact the author privately through their GitHub profile (linked in the README) with the
details and steps to reproduce.
