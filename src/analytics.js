'use strict';
// Aggregates stored run events into cost, usage and latency statistics.
// Pure: takes [{ id, goal, status, started_at, finished_at, events: [{ tool, args }] }].
const { costOf, costOfTotal } = require('./pricing');

const round = (n, d = 6) => +n.toFixed(d);
function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p / 100) - 1)];
}
function latencyStats(samples) {
  const s = samples.filter(n => n > 0).sort((a, b) => a - b);
  const total = s.reduce((a, b) => a + b, 0);
  return {
    avg_latency_ms:   s.length ? Math.round(total / s.length) : 0,
    p95_latency_ms:   pct(s, 95),
    total_latency_ms: total,
  };
}

function bucket(map, key, init) {
  if (!map.has(key)) map.set(key, { ...init(), _lat: [] });
  return map.get(key);
}
const usage = () => ({ llm_calls: 0, prompt_tokens: 0, completion_tokens: 0, tokens: 0, cost_usd: 0, unpriced_tokens: 0 });

function addUsage(b, { prompt = 0, completion = 0, total = prompt + completion, cost }) {
  b.prompt_tokens += prompt; b.completion_tokens += completion; b.tokens += total;
  if (cost == null) b.unpriced_tokens += total; else b.cost_usd += cost;
}

function analyse(runs) {
  const agents = new Map(), models = new Map(), tools = new Map();
  const totals = { runs: runs.length, tool_calls: 0, ...usage() };
  const perRun = [];

  for (const run of runs) {
    const agentModel = {};
    const r = { tokens: 0, cost_usd: 0 };
    for (const { tool, args: a } of run.events) {
      if (!a || typeof a !== 'object') continue;

      if (tool === 'register_agent') {
        if (a.id && a.model) agentModel[a.id] = a.model;

      } else if (tool === 'log_generation' || tool === 'log_llm_turn') {
        const prompt = Number(a.prompt_tokens) || 0, completion = Number(a.completion_tokens) || 0;
        const model = a.model || agentModel[a.agent] || '';
        const u = { prompt, completion, cost: costOf(model, prompt, completion) };
        const ag = bucket(agents, a.agent, () => ({ agent: a.agent, model, errors: 0, ...usage() }));
        const md = bucket(models, model || 'unknown', () => ({ model: model || 'unknown', ...usage() }));
        for (const b of [ag, md, totals]) { b.llm_calls++; addUsage(b, u); }
        if (model) ag.model = model;
        const lat = Number(a.latency_ms) || 0;
        ag._lat.push(lat); md._lat.push(lat);
        r.tokens += prompt + completion; r.cost_usd += u.cost || 0;

      } else if (tool === 'log_event') {
        const ag = bucket(agents, a.agent, () => ({ agent: a.agent, model: agentModel[a.agent] || '', errors: 0, ...usage() }));
        if (['error', 'fail'].includes(a.event_type)) ag.errors++;
        const total = Number(a.tokens) || 0;
        if (total) {
          const u = { total, cost: costOfTotal(ag.model || agentModel[a.agent], total) };
          addUsage(ag, u); addUsage(totals, u);
          r.tokens += total; r.cost_usd += u.cost || 0;
        }

      } else if (tool === 'log_tool_call') {
        const t = bucket(tools, a.tool_name, () => ({ tool: a.tool_name, calls: 0, errors: 0 }));
        t.calls++; totals.tool_calls++;
        if (a.error) t.errors++;
        t._lat.push(Number(a.latency_ms) || 0);
      }
    }
    perRun.push({
      id: run.id, goal: run.goal, status: run.status, started_at: run.started_at,
      duration_ms: run.finished_at ? run.finished_at - run.started_at : null,
      tokens: r.tokens, cost_usd: round(r.cost_usd),
    });
  }

  const finish = (map, extra = () => ({})) => [...map.values()].map(({ _lat, ...b }) => {
    const out = { ...b, ...latencyStats(_lat), ...extra(b) };
    if ('cost_usd' in out) out.cost_usd = round(out.cost_usd);
    return out;
  });
  const agentRows = finish(agents).sort((a, b) => b.cost_usd - a.cost_usd || b.tokens - a.tokens);
  const modelRows = finish(models).sort((a, b) => b.cost_usd - a.cost_usd || b.tokens - a.tokens);
  const toolRows  = finish(tools, t => ({ error_rate: t.calls ? round(t.errors / t.calls, 3) : 0 }))
    .sort((a, b) => b.total_latency_ms - a.total_latency_ms);

  // Where the time goes: LLM time per agent and time per tool, ranked by total.
  const timed = [
    ...agentRows.map(a => ({ kind: 'llm',  name: a.agent, calls: a.llm_calls, avg_latency_ms: a.avg_latency_ms, p95_latency_ms: a.p95_latency_ms, total_latency_ms: a.total_latency_ms })),
    ...toolRows.map(t  => ({ kind: 'tool', name: t.tool,  calls: t.calls,     avg_latency_ms: t.avg_latency_ms, p95_latency_ms: t.p95_latency_ms, total_latency_ms: t.total_latency_ms })),
  ].filter(x => x.total_latency_ms > 0);
  const allTime = timed.reduce((s, x) => s + x.total_latency_ms, 0);
  const bottlenecks = timed.sort((a, b) => b.total_latency_ms - a.total_latency_ms).slice(0, 5)
    .map(x => ({ ...x, share: round(x.total_latency_ms / allTime, 3) }));

  totals.cost_usd = round(totals.cost_usd);
  return { totals, agents: agentRows, models: modelRows, tools: toolRows, bottlenecks, runs: perRun };
}

module.exports = { analyse };
