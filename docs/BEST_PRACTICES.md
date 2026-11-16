# Best practices

## Instrumenting agents

- **Report model calls with `log_llm_turn`, not `log_event`.** It carries the input/output token
  split, so cost is accurate, and it shows the messages and response in the inspector.
- **Don't report the same tokens twice.** If you send `log_llm_turn` for a call, leave `tokens` off
  any `log_event` about the same call, or the totals double.
- **Always pass the model name**, on the agent or on each call. Without it the call can't be priced.
- **Wrap tools rather than logging by hand** (`traceTool` / `trace_tool`). You get duration and
  errors for free, and failures are recorded even when the tool throws.
- **Use stable agent ids.** Analytics groups by id across runs; an id that changes each run
  (`worker-8f3a`) makes every run look like a new agent.
- **Give each task its own `run_id`** when one process handles several tasks, and call
  `finish_run` when each ends. Runs that never finish don't count towards duration statistics.
- **Set a `token_budget` on agents that loop** (critics, retry loops) so you hear about runaways.

## What you send is what gets stored

- Prompts and responses are stored in the dashboard's database. Don't send secrets you wouldn't
  want there; redact API keys and personal data in your own code before reporting.
- Long values are shortened for display (responses at 4,000 characters, messages at 2,000).
  The dashboard is a debugging view, not an archive of full transcripts.

## Running the dashboard

- **On your own machine:** the defaults are safe. It listens only on `127.0.0.1`.
- **Shared with a team:** use a password, HTTPS in front of it, and an API key per agent or
  service so the audit log shows who sent what. Revoke a key when it is no longer needed.
- **Sensitive traces:** set `VISIBILITY_ENCRYPTION_KEY` and store the key somewhere other than
  the data volume. See [Deployment](DEPLOYMENT.md#encryption-at-rest).
- **Back up `runs.db`** if run history matters to you, and delete old runs you no longer need.
- **Only install plugins you trust.** They run with the dashboard's permissions.

## Reading the numbers

- Cost is an estimate from list prices, without caching or batch discounts.
- Latency is whatever your code reports. If you don't pass `latency_ms`, a call doesn't appear in
  "where the time goes".
- A high tool p95 next to a low average points at occasional stalls: look at timeouts and retries
  before optimising the common case.
