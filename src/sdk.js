'use strict';
/**
 * agent-visibility · Node.js SDK
 *
 *   const { Visibility } = require('agent-visibility/sdk');
 *   const vis = new Visibility();                       // http://localhost:4242
 *   vis.setGoal('Summarise the report');
 *   vis.registerAgent({ id: 'lead', label: 'Lead', role: 'orchestrator', model: 'claude-sonnet-5-5' });
 *   vis.logLlmTurn({ agent: 'lead', promptTokens: 1200, completionTokens: 300, latencyMs: 2100, response: '…' });
 *   const rows = await vis.traceTool('lead', 'search', () => search(q), q);
 *   vis.finishRun();
 *   await vis.flush();                                  // before the process exits
 *
 * Calls return immediately and are sent in order in the background. The SDK never throws into
 * your agent code: if the dashboard is unreachable or rejects the key it warns once and stops
 * sending for the rest of the process.
 */

const text = v => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v));
const drop = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

class Visibility {
  /**
   * @param {object} [opts]
   * @param {string} [opts.url]       dashboard URL (default $VISIBILITY_URL or http://localhost:4242)
   * @param {string} [opts.apiKey]    needed when the dashboard runs with --password (default $VISIBILITY_API_KEY)
   * @param {number} [opts.timeoutMs] per-request timeout (default 2000)
   */
  constructor({ url, apiKey, timeoutMs = 2000 } = {}) {
    this.url = (url || process.env.VISIBILITY_URL || 'http://localhost:4242').replace(/\/+$/, '');
    this.apiKey = apiKey || process.env.VISIBILITY_API_KEY || null;
    this.timeoutMs = timeoutMs;
    this.disabled = false;
    this._tail = Promise.resolve();
  }

  /** Send any dashboard tool call. Resolves to the server's reply, or null if it could not be sent. */
  tool(tool, args = {}) {
    const p = this._tail.then(() => this._send(tool, args));
    this._tail = p;
    return p;
  }

  /** Wait until everything queued so far has been sent. */
  flush() { return this._tail.then(() => undefined); }

  async _send(tool, args) {
    if (this.disabled) return null;
    try {
      const res = await fetch(this.url + '/tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.apiKey && { 'X-API-Key': this.apiKey }) },
        body: JSON.stringify({ tool, args }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 401 || res.status === 403) {
        this._disable(`dashboard rejected events (HTTP ${res.status}); pass apiKey or set VISIBILITY_API_KEY`);
        return null;
      }
      return await res.json().catch(() => null);
    } catch (e) {
      this._disable(`dashboard unreachable at ${this.url} (${e.name})`);
      return null;
    }
  }

  _disable(reason) {
    if (this.disabled) return;
    this.disabled = true;
    console.warn(`[agent-visibility] ${reason}; not sending further events.`);
  }

  // ── Run lifecycle ──────────────────────────────────────────────────────────
  setGoal(goal, { runId } = {}) { return this.tool('set_goal', drop({ goal, run_id: runId })); }
  finishRun(status = 'done')    { return this.tool('finish_run', { status }); }
  setPlan(tasks)                { return this.tool('set_plan', { tasks }); }

  // ── Agents ─────────────────────────────────────────────────────────────────
  registerAgent({ id, label = id, role = 'worker', model, reportsTo, tokenBudget, color }) {
    return this.tool('register_agent', drop({ id, label, role, model, reports_to: reportsTo, token_budget: tokenBudget, color }));
  }
  setAgentState(agentId, status) { return this.tool('set_agent_state', { agent_id: agentId, status }); }
  traceStep(from, to, { label, type } = {}) {
    return this.tool('trace_step', drop({ from_agent: from, to_agent: to, label, arrow_type: type }));
  }

  // ── Events ─────────────────────────────────────────────────────────────────
  logEvent({ agent, type = 'reply', message = '', tokens, latencyMs, metadata }) {
    return this.tool('log_event', drop({ agent, event_type: type, message, tokens, latency_ms: latencyMs, metadata }));
  }
  logLlmTurn({ agent, model, promptTokens, completionTokens, latencyMs, stopReason, messages, response, thinking }) {
    return this.tool('log_llm_turn', drop({
      agent, model, prompt_tokens: promptTokens, completion_tokens: completionTokens,
      latency_ms: latencyMs, stop_reason: stopReason, messages, response, thinking,
    }));
  }
  logToolCall({ agent, tool, input, output, latencyMs, error }) {
    return this.tool('log_tool_call', drop({
      agent, tool_name: tool, input: text(input), output: text(output), latency_ms: latencyMs,
      error: error == null ? undefined : String(error.message || error),
    }));
  }
  setMemory(key, value, op = 'write') { return this.tool('set_memory', { key, value, op }); }

  /**
   * Run `fn`, time it, and log it as a tool call by `agent`. Returns fn's result; rethrows its error.
   */
  async traceTool(agent, tool, fn, input) {
    const t0 = Date.now();
    try {
      const output = await fn();
      this.logToolCall({ agent, tool, input, output, latencyMs: Date.now() - t0 });
      return output;
    } catch (error) {
      this.logToolCall({ agent, tool, input, latencyMs: Date.now() - t0, error });
      throw error;
    }
  }
}

module.exports = { Visibility };
