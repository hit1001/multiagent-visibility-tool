# Tutorial 1: Trace your first agent run

**You will:** start the dashboard, report a two-agent run from a script, and read the result.
**Time:** about 10 minutes. **You need:** Node.js 22 or newer.

## 1. Start the dashboard

```bash
npm install -g agent-visibility --allow-scripts=better-sqlite3
agentscope
```

Your browser opens `http://localhost:4242`. Click **Research + code** under *Demo scenarios* to see
what a traced run looks like, then come back here.

## 2. Report a run from your own code

Create `demo.js` in a folder where `agent-visibility` is installed (`npm install agent-visibility`):

```js
const { Visibility } = require('agent-visibility/sdk');
const vis = new Visibility();

async function main() {
  vis.setGoal('Answer a customer question');
  vis.registerAgent({ id: 'lead', label: 'Lead', role: 'orchestrator', model: 'claude-sonnet-5-5' });
  vis.registerAgent({ id: 'helper', label: 'Helper', role: 'researcher', model: 'claude-haiku-5-5', reportsTo: 'lead' });

  vis.traceStep('lead', 'helper', { label: 'look up the refund policy' });
  vis.setAgentState('helper', 'running');

  // Stand-in for a real tool: traceTool records its input, output and duration.
  const policy = await vis.traceTool('helper', 'search_docs',
    async () => 'Refunds within 30 days.', { query: 'refund policy' });

  // Stand-in for a real model call: report the token counts your provider returns.
  vis.logLlmTurn({
    agent: 'helper', promptTokens: 850, completionTokens: 120, latencyMs: 900,
    messages: [{ role: 'user', content: 'Summarise: ' + policy }],
    response: 'Customers can get a refund within 30 days.',
  });
  vis.setAgentState('helper', 'done');
  vis.traceStep('helper', 'lead', { label: 'summary', type: 'result' });

  vis.finishRun();
  await vis.flush();
}
main();
```

Run it with `node demo.js` while the dashboard is open.

## 3. Read the result

- **Graph:** Lead at the top, Helper below it, with the two messages you traced.
- **Tools tab:** the `search_docs` call with its input, output and duration, and the model call
  with its messages and response.
- **Top row:** steps, tokens, estimated cost and elapsed time.
- **Agents:** click one, in the list or on the graph, to see its tokens, cost and what it did.
- **History:** the run is saved. Open it to replay it step by step.

## 4. Use it with your real agents

Replace the stand-ins: call `logLlmTurn` after each real model call with the usage numbers the
provider returns, and wrap real tools in `traceTool`. If you use LangChain, AutoGen or CrewAI, use
the [drop-in adapters](../../README.md#framework-adapters) instead. Python has the same SDK:
see [SDKs](../SDK.md).

Next: [Tutorial 2: budgets, alerts and analytics](02-cost-and-alerts.md).
