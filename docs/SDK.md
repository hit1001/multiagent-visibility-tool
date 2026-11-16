# SDKs

Use an SDK when your agents aren't built on LangChain, AutoGen or CrewAI (those have
[drop-in adapters](../README.md#framework-adapters)).

Both SDKs behave the same way: calls never raise into your agent code, and if the dashboard is
down or rejects the key they warn once and stop sending.

## Node.js

Included in the npm package (Node 22+, no extra dependencies).

```js
const { Visibility } = require('agent-visibility/sdk');

const vis = new Visibility({
  url: 'http://localhost:4242',          // default, or $VISIBILITY_URL
  apiKey: process.env.VISIBILITY_API_KEY // only for password-protected dashboards
});

vis.setGoal('Summarise the quarterly report');
vis.registerAgent({ id: 'lead', label: 'Lead', role: 'orchestrator', model: 'claude-sonnet-5-5' });
vis.registerAgent({ id: 'reader', role: 'researcher', model: 'claude-haiku-5-5', reportsTo: 'lead', tokenBudget: 50000 });

vis.traceStep('lead', 'reader', { label: 'read the report' });

// After each model call:
vis.logLlmTurn({
  agent: 'reader', promptTokens: usage.input_tokens, completionTokens: usage.output_tokens,
  latencyMs, messages, response: text,
});

// Wrap a tool to record its input, output, duration and errors:
const rows = await vis.traceTool('reader', 'search_docs', () => searchDocs(query), { query });

vis.finishRun();          // or vis.finishRun('error')
await vis.flush();        // before the process exits
```

Calls return immediately; events are sent in order in the background. `flush()` waits for them.

| Method | Purpose |
|---|---|
| `setGoal(goal, { runId })` | Start a run |
| `registerAgent({ id, label, role, model, reportsTo, tokenBudget, color })` | Add an agent to the graph |
| `logLlmTurn({ agent, model, promptTokens, completionTokens, latencyMs, stopReason, messages, response, thinking })` | Record a model call (drives token and cost totals) |
| `logToolCall({ agent, tool, input, output, latencyMs, error })` | Record a tool call |
| `traceTool(agent, tool, fn, input)` | Run `fn`, time it and record it; returns its result and rethrows its error |
| `logEvent({ agent, type, message, tokens, latencyMs, metadata })` | Add a line to the event log |
| `traceStep(from, to, { label, type })` | Draw an arrow between two agents |
| `setAgentState(agentId, status)` | Mark an agent `running`, `done`, `error`… |
| `setMemory(key, value, op)` · `setPlan(tasks)` | Update the memory and plan panels |
| `finishRun(status)` | End the run |
| `tool(name, args)` | Send any [API tool](API.md#post-tool) directly |
| `flush()` | Wait until queued events are sent |

## Python

Copy `adapters/mavt_client.py` and `adapters/mavt_sdk.py` into your project (`pip install requests`).

```python
from mavt_sdk import Visibility

vis = Visibility("http://localhost:4242")      # api_key="mavt_sk_..." if password-protected
vis.set_goal("Summarise the quarterly report")
vis.register_agent("lead", role="orchestrator", model="claude-sonnet-5-5")

vis.log_llm_turn("lead", prompt_tokens=1200, completion_tokens=300, latency_ms=2100, response=text)

with vis.trace_tool("lead", "search_docs", input={"query": q}) as call:
    call.output = search_docs(q)

vis.finish_run()
```

Python calls are synchronous with a 2-second timeout. The methods mirror the Node SDK in
snake_case: `set_goal`, `register_agent`, `log_llm_turn`, `log_tool_call`, `trace_tool`,
`log_event`, `trace_step`, `set_agent_state`, `set_memory`, `set_plan`, `finish_run`.

## Tips

- Pass `model` when you register an agent, or on each `logLlmTurn`, so cost can be estimated.
  Models missing from the price table are counted as unpriced; see
  [How cost is estimated](API.md#how-cost-is-estimated).
- Give agents a `tokenBudget` to get an alert before they exhaust it.
- Use a new `runId` per task if several tasks share one process.
