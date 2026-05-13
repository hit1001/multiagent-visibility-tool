# 🔍 MAVT — Multi-Agent Visibility Tool

> The missing DevTools for multi-agent AI systems.

[![npm](https://img.shields.io/npm/v/agent-visibility?style=flat&color=blue)](https://www.npmjs.com/package/agent-visibility)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/hit1001/multiagent-visibility-tool?style=flat)](https://github.com/hit1001/multiagent-visibility-tool/stargazers)

![MAVT Demo](demo.gif)

**You wouldn't ship a backend without logs. Why are you shipping agents blind?**

Multi-agent systems are the future of AI — but right now, debugging them feels like
reading smoke signals. MAVT gives you full observability: every agent call, every
decision step, every inter-agent message, visualized in real time.

---

## The problem

You build a multi-agent workflow. Something breaks. You ask yourself:

- Which agent failed — and why?
- What did agent A actually say to agent B?
- Where in the chain did the task go wrong?
- Why is this running so slow?

You open your terminal. You see... nothing useful.

**MAVT fixes this.**

---

## What you get

| | |
|---|---|
| 🔁 **Agent-to-agent traces** | See every message passed between agents, in order |
| 🧠 **LLM turn inspector** | Full prompt/response history with token counts and latency |
| 📊 **Live topology graph** | Visual execution graph, updating in real time |
| 🛠 **Tool call traces** | Every tool invocation, input, output, and duration |
| 🧩 **Memory panel** | Watch agent memory reads and writes as they happen |
| 📜 **Run history & replay** | Browse past runs and replay them step by step |
| 🔔 **Webhook alerts** | Get notified on token budget exceeded, agent stuck, critic failures |

---

## Get started in 60 seconds

```bash
npm install -g agent-visibility
agentscope
```

Open your browser → `http://localhost:4242`

Your agents are now fully observable.

---

## Framework adapters

Drop-in Python adapters — two lines of code, full visibility.

### LangChain

```python
from adapters.langchain import AgentscopeCallback

AgentExecutor(agent=agent, tools=tools,
              callbacks=[AgentscopeCallback(goal="My task")])
```

### AutoGen

```python
from adapters.autogen import track

scope = track(agents=[orchestrator, researcher, coder], goal="My task")
# ... run your agents ...
scope.finish()
```

### CrewAI

```python
from adapters.crewai import AgentscopeListener

listener = AgentscopeListener(goal="My task")
crew = Crew(agents=[...], tasks=[...], step_callback=listener)
result = crew.kickoff()
listener.finish()
```

---

## Webhook alerts

Configure alerts directly from the dashboard sidebar:

| Alert | Trigger |
|---|---|
| 💸 Token budget | Agent uses ≥ X% of its token budget |
| ⏳ Agent stuck | Agent silent for more than N seconds |
| ❌ Critic fail rate | Critic failure rate exceeds X% |

Alerts appear as toast notifications in the UI and are POSTed to any webhook URL you configure.

---

## Why observability is non-negotiable

> *"If you can't measure it, you can't manage it."*

AI agents are making real decisions in production systems today — in customer service,
in code generation, in enterprise workflows. Without visibility:

- You can't debug failures
- You can't trust outputs
- You can't scale safely
- You can't explain decisions to stakeholders

MAVT is the foundation layer your agent stack is missing.

---

## Roadmap

- [x] Live topology graph
- [x] LLM turn inspector
- [x] Tool call traces
- [x] Memory panel
- [x] Run history & replay
- [x] LangChain adapter
- [x] AutoGen adapter
- [x] CrewAI adapter
- [x] Webhook alerts
- [ ] OpenTelemetry export
- [ ] Cloud-hosted dashboard
- [ ] Cost tracking per agent

---

## Contributing

Issues, PRs, and framework integrations are very welcome.
If you're using MAVT with a framework not listed above — open an issue and let's add it.

---

## Star history

If MAVT saves you a debugging session, consider leaving a ⭐ —
it helps other developers find the tool.

---

## About the author

Built by [Hitarth Bhatt](https://github.com/hit1001) — AI product leader with 10+ years
shipping AI systems at scale. MAVT grew out of a real frustration: the more powerful
multi-agent systems become, the harder they are to see inside.

---

**MIT License** · [npm](https://www.npmjs.com/package/agent-visibility) · [Issues](https://github.com/hit1001/multiagent-visibility-tool/issues)
