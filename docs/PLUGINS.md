# Plugins

A plugin is a JavaScript file that runs inside the dashboard server and reacts to what your agents
report: write runs to a file, forward them to another system, add your own checks.

> Plugins run with the same permissions as the dashboard. Only install plugins whose code you
> have read or whose author you trust.

## Install a plugin

Copy the file into the `plugins` folder of the data directory and restart the dashboard:

```bash
mkdir -p ~/.agentscope/plugins
cp examples/plugins/jsonl-log.js ~/.agentscope/plugins/
agentscope
#   [agentscope] Plugin loaded: jsonl-log (onRunFinish)
```

You can also name plugins in `VISIBILITY_PLUGINS`, as comma-separated file paths or installed
package names: `VISIBILITY_PLUGINS=./my-plugin.js,agent-visibility-plugin-foo`.
`VISIBILITY_PLUGINS=off` loads no plugins at all. `GET /plugins` lists what is loaded.

## Write a plugin

Export an object with a `name` and any of the four hooks:

```js
module.exports = {
  name: 'my-plugin',

  // A run started (set_goal with a new run).
  onRunStart({ runId, goal }) {},

  // Every tool call reported to the dashboard. `tool` and `args` are as in docs/API.md.
  onEvent({ tool, args, runId }) {},

  // The run ended. metrics = { steps, tokens, retries, cost }.
  onRunFinish({ runId, goal, status, metrics, durationMs }) {},

  // An alert fired. `alert` is the type, e.g. "cost_budget_exceeded".
  onAlert({ alert, runId, goal, ...details }) {},
};
```

Exporting a function that returns such an object also works, if you need set-up code.

Rules of the road:

- **Hooks are called synchronously on the server's event path, so return quickly.** For network
  calls, start the request and return; a hook may be `async`, and the server does not wait for it.
- **Errors are contained.** If a hook throws or its promise rejects, the server logs
  `Plugin <name> <hook> failed` and carries on. A file that fails to load is skipped with a warning.
- **Hooks see live events only.** Replaying a saved run does not call them again.
- **Treat `args` as untrusted text.** Agents report content they read from the web. Don't `eval`
  it, build shell commands from it, or write it into HTML without escaping.
- Hooks receive the same objects the server uses. Don't modify them.

Configuration is up to you; environment variables are the simplest way (see the examples).

## Examples

| File | What it shows |
|---|---|
| [`examples/plugins/jsonl-log.js`](../examples/plugins/jsonl-log.js) | `onRunFinish`: append a line per run to a JSON Lines file |
| [`examples/plugins/slow-llm-warning.js`](../examples/plugins/slow-llm-warning.js) | `onEvent`: warn about slow or very large model calls |

## Share a plugin

Publish it to npm with the keyword `agent-visibility-plugin` so others can find it, and name the
package `agent-visibility-plugin-<something>`. Users install it next to the dashboard and add the
package name to `VISIBILITY_PLUGINS`.

To have it listed below, open a "Plugin submission" issue. See [CONTRIBUTING](../CONTRIBUTING.md).

### Community plugins

None listed yet.
