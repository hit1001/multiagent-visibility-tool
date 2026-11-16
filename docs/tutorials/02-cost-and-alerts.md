# Tutorial 2: Budgets, alerts and analytics

**You will:** get warned before a run costs too much, and find out which agent or tool is slow.
**Time:** about 10 minutes. **You need:** the dashboard running and a script from
[Tutorial 1](01-first-trace.md).

## 1. Make sure calls can be priced

Cost is estimated from the model name. Give each agent a `model` when you register it, or pass
`model` on each `logLlmTurn`.

If you use a model the built-in table doesn't know (a local or fine-tuned one), add it. Create
`~/.agentscope/pricing.json` with prices in USD per million tokens, `[input, output]`, and restart:

```json
{ "qwen3-coder": [0, 0], "my-finetune": [1.5, 6] }
```

Until you do, those tokens are counted as "not priced" and add nothing to the cost.

## 2. Set a cost budget

Click **Alerts** in the top bar, set **Run cost budget (USD)** to a small number such as `0.01`,
and click **Save rules**. Run your script with larger token counts. When the run's estimated
cost reaches the budget you get one alert in the dashboard.

To be told somewhere else, paste a Slack or Discord webhook URL, or any URL that accepts a JSON
POST, into **Webhook URL**.

## 3. Catch slow tools and runaway agents

- **Tool call slower than (ms):** alerts the first time each tool takes longer than this in a run.
- **Token budget reached (%):** register an agent with a `tokenBudget`; you are alerted when it reaches this
  share of it.
- **Agent silent for (seconds):** alerts when a running agent reports nothing for this long.

## 4. Find where the time and money go

After a few runs, click **Analytics** in the top bar.

- **Where the time goes** ranks agents (model time) and tools by total reported latency. Start
  optimising at the top row.
- **Agents** and **Models** show tokens and cost. An expensive agent doing simple work is a
  candidate for a cheaper model.
- **Tools** shows error rates and 95th-percentile latency. A high p95 with a low average means
  occasional stalls.

The same numbers are available as JSON from `GET /analytics`; see the [API reference](../API.md#analytics).

Good to know: costs are estimates from list prices. They don't include prompt-caching or batch
discounts, so your real bill may be lower.

Next: [Tutorial 3: design a team in the builder](03-workflow-builder.md).
