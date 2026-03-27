# agent-visibility

Real-time debug dashboard for multi-agent AI systems.

Plug it into any agent framework via HTTP or MCP and get an instant view of:

- **Topology graph** — live agent nodes, hierarchy lines, message arrows; click any node to expand into operation sub-nodes
- **LLM turn inspector** — full prompt messages, model response, and optional thinking/scratchpad for every generation
- **Tool call traces** — full input/output for every tool call, with success/error status and latency
- **Embeddings & retrievals** — query text, top results, similarity scores
- **Memory panel** — key/value store with read/write flash animations
- **Plan & event log** — task plan with completion state, timestamped event stream

![screenshot placeholder](docs/screenshot.png)

---

## Quick start

```bash
# no install needed — zero dependencies
node bin/visibility.js
# → Dashboard at http://localhost:4242
```

Click one of the built-in demo scenarios (Research + code, Critic retry loop, Memory overflow) to see a full run with real LLM prompts and responses.

---

## Send data from your agent

### Option A — HTTP POST (any language)

```bash
curl -X POST http://localhost:4242/tool \
  -H 'Content-Type: application/json' \
  -d '{"tool":"register_agent","args":{"id":"my-agent","label":"My Agent","role":"worker","model":"claude-sonnet-4-5"}}'
```

### Option B — MCP bridge

```bash
node bin/visibility.js --mcp
# → MCP SSE endpoint at http://localhost:4243/sse
```

Add to your agent's MCP config:

```json
{
  "mcpServers": {
    "agentscope": { "url": "http://localhost:4243/sse" }
  }
}
```

---

## Available tools

| Tool | Purpose |
|---|---|
| `register_agent` | Register an agent (id, label, role, model, hierarchy) |
| `set_goal` | Set the run goal and start the timer |
| `set_agent_state` | Update agent status (`running`, `done`, `error`, …) |
| `log_event` | Log a timestamped event to the event stream |
| `log_llm_turn` | **Full LLM turn** — messages in, response out, optional thinking |
| `log_generation` | Token-count-only generation (lightweight alternative) |
| `log_tool_call` | Tool call with full input/output |
| `log_embedding` | Embedding call (text, model, dims) |
| `log_retrieval` | Retrieval call (query, results with scores) |
| `trace_step` | Draw an arrow between two agents on the graph |
| `set_memory` | Write/read a value in the memory panel |
| `set_plan` | Publish the task plan |
| `finish_run` | Mark the run as done or errored |

### Logging a full LLM turn

```bash
curl -X POST http://localhost:4242/tool \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "log_llm_turn",
    "args": {
      "agent": "researcher",
      "model": "claude-haiku-4-5",
      "prompt_tokens": 1840,
      "completion_tokens": 620,
      "latency_ms": 1320,
      "stop_reason": "end_turn",
      "messages": [
        {"role": "system", "content": "You are a researcher agent…"},
        {"role": "user",   "content": "Explain quicksort."}
      ],
      "response": "Quicksort is a divide-and-conquer algorithm…"
    }
  }'
```

---

## Canvas interaction

- **Click an agent node** → expands into operation-type sub-nodes (generate, embed, retrieve, tool) with counts and stats
- **Click a tool dropdown** → highlights the agent node on the canvas and shows an info overlay

---

## Ports

| Port | Service |
|---|---|
| `4242` | Dashboard HTTP server + SSE stream |
| `4243` | MCP bridge (only with `--mcp`) |

Override with `--port` / `--mcp-port` flags or `VISIBILITY_PORT` / `VISIBILITY_MCP_PORT` env vars.

---

## File layout

```
bin/visibility.js          CLI entry point
src/server.js              HTTP + SSE dashboard server
src/dashboard.html         Dark-theme UI (served by the node server)
agentscope/agentscope.js   MCP bridge (forwards tool calls to the dashboard)
```

---

## License

MIT
