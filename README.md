<p align="center">
  <img alt="MAVT — Multi-Agent Visibility Tool" src="https://shieldcn.dev/header/surface.svg?title=MAVT&amp;subtitle=Multi-Agent+Visibility+Tool+&amp;size=wide&amp;mode=dark&amp;image=https%3A%2F%2Fimages.unsplash.com%2Fphoto-1550745165-9bc0b252726f%3Fw%3D1600%26q%3D70%26fit%3Dcrop%26fm%3Djpg&amp;overlay=1" />
</p>

<h1 align="center">🔍 MAVT — Multi-Agent Visibility Tool</h1>

<p align="center">
  <strong>The missing DevTools for multi-agent AI systems.</strong><br />
  Trace, visualize, and debug agent workflows in real time.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/agent-visibility"><img alt="npm version" src="https://img.shields.io/npm/v/agent-visibility?style=flat-square&logo=npm" /></a>
  <a href="https://github.com/hit1001/multiagent-visibility-tool/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/hit1001/multiagent-visibility-tool?style=flat-square&logo=github" /></a>
  <a href="https://github.com/hit1001/multiagent-visibility-tool/graphs/contributors"><img alt="Contributors" src="https://img.shields.io/github/contributors/hit1001/multiagent-visibility-tool?style=flat-square" /></a>
  <a href="./LICENSE"><img alt="Dual license" src="https://img.shields.io/badge/license-dual--licensed-blue?style=flat-square" /></a>
</p>

<p align="center">
  <a href="#-quick-start">Quick Start</a> ·
  <a href="#-features">Features</a> ·
  <a href="#-framework-adapters">Adapters</a> ·
  <a href="#-optional-mcp-bridge">MCP Bridge</a> ·
  <a href="#-roadmap">Roadmap</a> ·
  <a href="#-contributing">Contributing</a>
</p>

---

<p align="center">
  <img src="./demo.gif" alt="MAVT real-time dashboard demonstration" />
</p>

> **You wouldn't ship a backend without logs. Why ship your agents blind?**

Debugging multi-agent workflows shouldn't mean guessing which agent failed, searching through terminal output, or reconstructing conversations by hand. **MAVT** brings agent activity, LLM turns, tool calls, handoffs, memory, and run history together in a local dashboard.

## 🎯 The Problem

Your multi-agent workflow produces an unexpected result. You need to know:

- **Which agent** failed, stalled, or returned the wrong information?
- **What context** did the model receive, and what did it generate?
- **Which handoff or tool call** caused a problem?
- **Where did the time and tokens go** during execution?

**MAVT helps you follow the execution trail instead of debugging blind.**

## ✨ Features

| Capability | What you can inspect |
| --- | --- |
| 🕸️ **Live topology graph** | Agent relationships and execution flow as events arrive |
| 🔁 **Inter-agent traces** | Messages, handoffs, and transitions between agents |
| 🧠 **LLM turn inspector** | Prompts, responses, token counts, and latency where instrumentation captures them |
| 🛠️ **Tool call traces** | Tool names, inputs, outputs, timing, and reported errors |
| 🧩 **Memory panel** | Instrumented memory reads and writes |
| 📜 **Run history & replay** | Inspect recorded runs and step through prior events |
| 🔔 **Alerts & webhooks** | Monitor token budgets, inactivity, and critic failures |
| 🔌 **MCP bridge** | Send tracing events from MCP-compatible agents and clients |

## 🚀 Quick Start

### Requirements

- **Node.js 22 or newer**, as specified by the package's `engines` field.
- **npm** (npm 11+ recommended; npm 12 may require explicit approval of dependency install scripts).

### 1. Install MAVT

```bash
npm install -g agent-visibility --allow-scripts=better-sqlite3
```

`better-sqlite3` supplies the native SQLite persistence dependency. On npm versions that block install scripts by default, the `--allow-scripts` option permits that dependency to build. If your npm version does not support this option, follow its normal install-script approval process.

### 2. Start the dashboard

```bash
agentscope
```

Open **http://localhost:4242**. The CLI also attempts to open the page automatically.

> **Important:** Starting MAVT launches the dashboard; it does **not** automatically instrument an existing application. Connect a framework adapter or have an MCP client send tracing events to see your own runs.

### Useful CLI options

```bash
agentscope --no-open               # Do not open the browser automatically
agentscope --port 5000             # Change the dashboard port
agentscope --mcp                   # Start the dashboard and MCP bridge
agentscope --mcp-port 5001         # Change the MCP bridge port (with --mcp)
agentscope --help                  # Show CLI help
```

The command `visibility` is also provided as an alias for `agentscope`.

## 🧭 How It Works

```mermaid
flowchart TD
    A[Your multi-agent application] --> B{Tracing integration}
    B --> C[Python framework adapter]
    B --> D[MCP tracing tools]
    C --> E[MAVT local server]
    D --> E
    E --> F[Live dashboard]
    E --> G[(Run and event storage)]
    E --> H[Alerts and webhooks]
```

MAVT runs a local Node.js dashboard server. Python adapters send observed execution events to it; the optional MCP bridge exposes tools for MCP-compatible agents to report their activity.

## 🔌 Framework Adapters

The repository includes Python integrations for **LangChain**, **AutoGen**, and **CrewAI**. These are source adapters, not Python packages installed automatically by the npm CLI.

**Setup:** Copy [`mavt_client.py`](./adapters/mavt_client.py) **and** the adapter you want into your Python project (in the same importable directory). Install the required Python dependencies for your framework, and keep the MAVT dashboard running while your workflow executes.

### LangChain

**Files:** [`mavt_langchain.py`](./adapters/mavt_langchain.py) + [`mavt_client.py`](./adapters/mavt_client.py)  
**Dependencies:** `pip install langchain-core requests`

```python
from mavt_langchain import AgentscopeCallback

callback = AgentscopeCallback(goal="Research and summarize a topic")

# Attach to your existing LangChain runnable or agent.
result = chain.invoke(input_data, config={"callbacks": [callback]})

callback.finish()
```

`chain` and `input_data` represent your existing LangChain application.

### AutoGen

**Files:** [`mavt_autogen.py`](./adapters/mavt_autogen.py) + [`mavt_client.py`](./adapters/mavt_client.py)  
**Dependencies:** `pip install pyautogen requests` (or your supported `autogen-agentchat` version)

```python
from mavt_autogen import track

scope = track(agents=[orchestrator, researcher, coder], goal="My task")

# Run your existing AutoGen workflow here.

scope.finish()
```

### CrewAI

**Files:** [`mavt_crewai.py`](./adapters/mavt_crewai.py) + [`mavt_client.py`](./adapters/mavt_client.py)  
**Dependencies:** `pip install crewai requests`

```python
from crewai import Crew
from mavt_crewai import AgentscopeListener

listener = AgentscopeListener(goal="My task")

crew = Crew(
    agents=[researcher, coder, critic],
    tasks=[task1, task2],
    step_callback=listener,
    task_callback=listener.on_task_end,  # Optional
)

result = crew.kickoff()
listener.finish()
```

These snippets show **integration points**, not complete standalone agent applications. Framework APIs can change; check the linked adapter code and use a compatible framework version.

## 🔗 Optional MCP Bridge

Run the dashboard and MCP server together:

```bash
agentscope --mcp
```

| Component | Default local endpoint |
| --- | --- |
| Dashboard | `http://localhost:4242` |
| MCP SSE endpoint | `http://localhost:4243/sse` |

For MCP clients supporting the **legacy SSE transport**, a sample client configuration is:

```json
{
  "mcpServers": {
    "agentscope": {
      "url": "http://localhost:4243/sse"
    }
  }
}
```

The bridge exposes tools including `register_agent`, `log_event`, `log_llm_turn`, `trace_step`, `log_tool_call`, `set_memory`, and `finish_run`.

> Connecting an MCP client makes the tools available; the client or application must still **call** them to report its activity. MCP transport support depends on the client.

## 🔔 Alerts & Webhooks

Configure alerts in the dashboard to monitor instrumented activity:

| Alert | Trigger |
| --- | --- |
| 💸 **Token budget** | Recorded usage crosses a configured percentage of a tracked budget |
| ⏳ **Agent stuck** | An active agent is inactive beyond the configured duration |
| ❌ **Critic failure rate** | Reported critic failures exceed a configured threshold |

MAVT can display alerts in the interface and POST notifications to configured webhook URLs, including supported Slack and Discord webhook formats.

## 🔒 Local-First Operation

By default, MAVT runs on the local machine. The CLI also supports a custom host and password:

```bash
agentscope --host 0.0.0.0 --password "choose-a-strong-password"
```

Only bind the server to a network interface when necessary; use a strong password and appropriate network protections. For private local development, prefer the default loopback-only setup.

## 🗂️ Repository Structure

```text
multiagent-visibility-tool/
├── adapters/
│   ├── mavt_client.py        # Shared Python event client
│   ├── mavt_langchain.py     # LangChain callback adapter
│   ├── mavt_autogen.py       # AutoGen integration
│   └── mavt_crewai.py        # CrewAI integration
├── agentscope/
│   └── agentscope.js         # MCP bridge
├── bin/
│   └── visibility.js        # CLI entry point
├── src/                      # Dashboard server, data, UI, alerts
├── demo.gif                  # Dashboard demo
├── package.json
├── LICENSE
└── README.md
```

## 🛣️ Roadmap

**Available in the project:**

- [x] Live topology graph
- [x] LLM turn inspector
- [x] Tool call traces
- [x] Memory panel
- [x] Run history and replay
- [x] LangChain, AutoGen, and CrewAI adapters
- [x] Alerts and webhooks
- [x] Optional MCP bridge

**Planned:**

- [ ] OpenTelemetry export
- [ ] Cloud-hosted dashboard
- [ ] Per-agent cost tracking

Have an integration idea? [Open an issue](https://github.com/hit1001/multiagent-visibility-tool/issues).

## 🤝 Contributing

Bug reports, documentation improvements, framework integrations, and pull requests are welcome.

1. [Open an issue](https://github.com/hit1001/multiagent-visibility-tool/issues) to discuss major changes.
2. Fork the repository and create a feature branch.
3. Make and test your changes.
4. Open a pull request explaining what changed and why.

## 📄 License

MAVT is distributed under a **dual-license arrangement**. The [LICENSE](./LICENSE) file sets out free-use categories for individuals, small teams, open-source projects, and evaluation, alongside commercial licensing requirements for certain organizations and use cases.

**Please review the actual license before using MAVT, especially in commercial environments.** Its additional restrictions mean the project should not be described simply as unmodified MIT-licensed or OSI-approved open-source software.

## 💬 Support

Questions, bug reports, or feature requests? [Open a GitHub issue](https://github.com/hit1001/multiagent-visibility-tool/issues).

---

<p align="center">
  <strong>Built with ❤️ by <a href="https://github.com/hit1001">Hitarth Bhatt</a> &amp; <a href="https://github.com/DheiryaBhatt">Dheirya Bhatt</a>.</strong>
</p>

<p align="center">
  If MAVT helps you debug your agents, consider <a href="https://github.com/hit1001/multiagent-visibility-tool">starring the repository ⭐</a>.
</p>
