#!/usr/bin/env node
'use strict';
const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.VISIBILITY_PORT || '4242');

// ── Auth ───────────────────────────────────────────────────────────────────────
const PASSWORD = process.env.VISIBILITY_PASSWORD || null;
const sessions = new Set(); // in-memory session tokens (single-user)
const rateLimiters = new Map(); // keyId → { count, resetAt }

function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}
function parseCookies(str = '') {
  return Object.fromEntries(str.split(';').map(p => p.trim().split('=').map(decodeURIComponent)));
}
function genToken() { return crypto.randomBytes(32).toString('hex'); }

function checkAuth(req) {
  if (!PASSWORD) return { ok: true, keyId: null };
  // Session cookie
  const cookies = parseCookies(req.headers['cookie'] || '');
  if (cookies.agentscope_session && sessions.has(cookies.agentscope_session)) return { ok: true, keyId: null };
  // API key header
  const raw = req.headers['x-api-key'] || '';
  if (raw && db) {
    const row = db.getApiKeyByHash(hashKey(raw));
    if (row) {
      // Per-key rate limiting (requests per minute)
      const now = Date.now();
      let rl = rateLimiters.get(row.id) || { count: 0, resetAt: now + 60000 };
      if (now > rl.resetAt) rl = { count: 0, resetAt: now + 60000 };
      rl.count++;
      rateLimiters.set(row.id, rl);
      if (rl.count > row.rate_limit) return { ok: false, reason: 'rate_limit' };
      db.touchApiKey(row.id);
      return { ok: true, keyId: row.id };
    }
  }
  return { ok: false, reason: 'unauthorized' };
}

// ── Licence ────────────────────────────────────────────────────────────────────
const LICENCE_SECRET = 'mavt-licence-v1';
const LICENCE_KEY    = process.env.VISIBILITY_LICENCE || null;

function validateLicence(key) {
  if (!key) return { valid: false };
  try {
    const parts = key.split('-'); // MAVT-TIER-YYYYMM-HMAC8
    if (parts.length < 4 || parts[0] !== 'MAVT') return { valid: false };
    const tier   = parts[1];          // TEAM | ENT
    const expiry = parts[2];          // e.g. 202612
    const hmac8  = parts[3];
    const expected = crypto.createHmac('sha256', LICENCE_SECRET)
      .update(tier + expiry).digest('hex').slice(0, 8);
    if (hmac8 !== expected) return { valid: false };
    const year = parseInt(expiry.slice(0, 4)), month = parseInt(expiry.slice(4, 6));
    const expires = new Date(year, month - 1, 1); // first of expiry month
    if (Date.now() > expires.getTime()) return { valid: false, reason: 'expired' };
    return { valid: true, tier: tier.toLowerCase(), expires };
  } catch { return { valid: false }; }
}
const licence = validateLicence(LICENCE_KEY);

// ── Login HTML ─────────────────────────────────────────────────────────────────
const LOGIN_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>agent-visibility — login</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0f1117;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui,sans-serif}
.card{background:#1a1d27;border:1px solid #2a2d3e;border-radius:12px;padding:40px;width:320px;text-align:center}
h2{color:#e2e8f0;margin-bottom:8px;font-size:18px}p{color:#64748b;font-size:13px;margin-bottom:24px}
input{width:100%;background:#0f1117;border:1px solid #2a2d3e;border-radius:8px;color:#e2e8f0;padding:10px 14px;font-size:14px;outline:none;margin-bottom:12px}
input:focus{border-color:#8b7cf8}button{width:100%;background:#8b7cf8;border:none;border-radius:8px;color:#fff;padding:11px;font-size:14px;cursor:pointer;font-weight:600}
button:hover{background:#7c6fe0}.err{color:#f87171;font-size:12px;margin-top:8px;min-height:16px}</style></head>
<body><div class="card"><h2>agent-visibility</h2><p>Enter your dashboard password</p>
<form method="POST" action="/auth/login"><input type="password" name="password" placeholder="Password" autofocus>
<button type="submit">Sign in</button></form><div class="err" id="e">__ERR__</div></div></body></html>`;

// ── Persistence (optional — degrades gracefully if better-sqlite3 absent) ─────
let db = null;
try { db = require('./db'); db.init(); }
catch (e) { console.warn('[agentscope] Persistence disabled:', e.message); db = null; }

// ── State ─────────────────────────────────────────────────────────────────────
let state = fresh();
let suppressBroadcast = false;
let suppressPersist   = false;
function fresh() {
  return {
    agents: {}, registry: {}, memory: {}, events: [],
    arrows: [], plan: [], internals: [],
    metrics: { steps: 0, tokens: 0, retries: 0 },
    goal: '', runId: null, status: 'idle', startedAt: null,
    clients: [],
    eventSeq: 0,
  };
}

function persist(tool, args) {
  if (suppressPersist || !db || !state.runId) return;
  state.eventSeq++;
  try { db.persistEvent(state.runId, state.eventSeq, tool, args, Date.now()); } catch (_) {}
}

// ── Alert engine ───────────────────────────────────────────────────────────────
const alertConfig = {
  webhookUrl:       null,
  tokenBudgetPct:   90,    // fire when agent tokens >= N% of budget
  stuckAgentSec:    120,   // fire when running agent has no activity for N seconds
  criticFailRatePct: 50,   // fire when critic fail rate >= N% (min 3 events)
};
const alertState = {
  fired:        new Set(),   // dedup keys already sent this run
  lastActivity: {},          // agentId → last-active timestamp
  critic:       { total: 0, fails: 0 },
};
function resetAlertState() {
  alertState.fired.clear();
  alertState.lastActivity = {};
  alertState.critic = { total: 0, fails: 0 };
}
function fireAlert(type, data) {
  const payload = { alert: type, runId: state.runId, goal: state.goal, ...data, ts: Date.now() };
  broadcast('alert', payload);
  if (db) try { db.appendAlert(type, data.detail || JSON.stringify(data), state.runId); } catch (_) {}
  if (!alertConfig.webhookUrl) return;
  try {
    const u    = new URL(alertConfig.webhookUrl);
    const mod  = u.protocol === 'https:' ? https : http;
    let body;
    if (u.hostname.includes('hooks.slack.com')) {
      // Slack incoming webhook format
      const icon = type === 'token_budget_exceeded' ? '💸' : type === 'agent_stuck' ? '⏳' : type === 'critic_fail_rate' ? '❌' : '⚠️';
      body = JSON.stringify({ text: `${icon} *${type}* — ${state.goal}`, blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `${icon} *${type}*\n${JSON.stringify(data)}` } },
      ]});
    } else if (u.hostname.includes('discord.com')) {
      // Discord webhook format
      body = JSON.stringify({ content: `**${type}** — ${state.goal}`, embeds: [
        { title: type, description: JSON.stringify(data, null, 2), color: 0xf59e0b },
      ]});
    } else {
      body = JSON.stringify(payload);
    }
    const opts = {
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const r = mod.request(opts, () => {}); r.on('error', () => {}); r.write(body); r.end();
  } catch (_) {}
}
function checkTokenBudget(agentId) {
  const ag     = state.agents[agentId]; if (!ag) return;
  const budget = ag.token_budget || state.registry[agentId]?.token_budget || 0;
  if (!budget) return;
  const pct = (ag.tokens / budget) * 100;
  const key = `${agentId}:budget:${Math.floor(ag.tokens / 100) * 100}`;
  if (pct >= alertConfig.tokenBudgetPct && !alertState.fired.has(key)) {
    alertState.fired.add(key);
    fireAlert('token_budget_exceeded', { agent: agentId, tokens: ag.tokens, budget, pct: +pct.toFixed(1) });
  }
}
function checkCriticFails(agentId, event_type) {
  const role = state.registry[agentId]?.role || state.agents[agentId]?.role;
  if (role !== 'critic') return;
  alertState.critic.total++;
  if (['error', 'fail', 'reject', 'rejected', 'failure'].includes(event_type)) alertState.critic.fails++;
  if (alertState.critic.total < 3) return;
  const rate = (alertState.critic.fails / alertState.critic.total) * 100;
  const key  = `critic:fail:${alertState.critic.fails}`;
  if (rate >= alertConfig.criticFailRatePct && !alertState.fired.has(key)) {
    alertState.fired.add(key);
    fireAlert('critic_fail_rate', {
      fails: alertState.critic.fails, total: alertState.critic.total, rate: +rate.toFixed(1),
    });
  }
}
// Check for stuck agents every 15 s
setInterval(() => {
  if (!state.runId) return;
  const now     = Date.now();
  const threshMs = alertConfig.stuckAgentSec * 1000;
  Object.entries(alertState.lastActivity).forEach(([id, ts]) => {
    const ag = state.agents[id];
    if (!ag || ag.status === 'done' || ag.status === 'idle' || ag.status === 'error') return;
    if (now - ts > threshMs) {
      const key = `${id}:stuck:${Math.floor(ts / 10000)}`;
      if (!alertState.fired.has(key)) {
        alertState.fired.add(key);
        fireAlert('agent_stuck', { agent: id, idle_sec: Math.floor((now - ts) / 1000) });
      }
    }
  });
}, 15000);

// ── SSE broadcast ─────────────────────────────────────────────────────────────
function broadcast(type, payload) {
  if (suppressBroadcast) return;
  const msg = `data: ${JSON.stringify({ type, payload, ts: Date.now() })}\n\n`;
  state.clients.forEach(r => { try { r.write(msg); } catch (_) {} });
}

// ── Role colours ──────────────────────────────────────────────────────────────
const COLORS = {
  orchestrator: '#8b7cf8', researcher: '#2dd4b0', coder: '#60a5fa',
  critic: '#f59e0b', synthesiser: '#60a5fa', worker: '#2dd4b0',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function ensureAgent(id) {
  if (!state.agents[id]) {
    const r = state.registry[id] || {};
    state.agents[id] = {
      id, label: r.label || id, role: r.role || 'worker', model: r.model || '',
      reports_to: r.reports_to || null, token_budget: r.token_budget || 8192,
      color: r.color || COLORS[r.role] || '#6b7280', status: 'idle', tokens: 0, calls: 0,
    };
  }
}
function safeAgents() {
  const out = {};
  for (const [k, v] of Object.entries(state.agents)) {
    out[k] = { id: v.id, label: v.label, role: v.role, model: v.model,
      reports_to: v.reports_to, token_budget: v.token_budget, color: v.color,
      status: v.status, tokens: v.tokens, calls: v.calls };
  }
  return out;
}
function snapshot() {
  return {
    registry: state.registry, runId: state.runId, goal: state.goal,
    status: state.status, startedAt: state.startedAt, agents: safeAgents(),
    memory: state.memory, events: state.events.slice(0, 80),
    arrows: state.arrows.slice(0, 20), plan: state.plan, metrics: state.metrics,
    internals: state.internals.slice(0, 60),
    scenarios: Object.keys(SCENARIOS),
  };
}

// ── Tools ─────────────────────────────────────────────────────────────────────
const TOOLS = {
  register_agent(a) {
    persist('register_agent', a);
    const { id, label, role = 'worker', model = '', reports_to = null, token_budget = 8192, color = null } = a;
    const c = color || COLORS[role] || '#6b7280';
    state.registry[id] = { id, label, role, model, reports_to, token_budget, color: c };
    state.agents[id]   = { ...state.registry[id], status: 'idle', tokens: 0, calls: 0 };
    if (db) try { db.appendRunAgent(state.runId, id); } catch (_) {}
    broadcast('registry', state.registry);
    broadcast('agents', safeAgents());
    broadcast('event', { agent: id, event_type: 'registered',
      message: `${label} registered — role:${role}, model:${model || 'unset'}`,
      tokens: 0, latency_ms: 0, ts: Date.now() });
    return { ok: true };
  },
  log_event(a) {
    persist('log_event', a);
    const { agent, event_type, message, tokens = 0, latency_ms = 0, metadata = {} } = a;
    ensureAgent(agent);
    const item = { agent, event_type, message, tokens, latency_ms, metadata, ts: Date.now() };
    state.events.unshift(item);
    if (state.events.length > 200) state.events.pop();
    if (tokens) {
      state.agents[agent].tokens += tokens;
      state.agents[agent].calls  += 1;
      state.metrics.tokens       += tokens;
    }
    state.metrics.steps++;
    alertState.lastActivity[agent] = Date.now();
    checkCriticFails(agent, event_type);
    broadcast('event', item);
    broadcast('metrics', state.metrics);
    broadcast('agents', safeAgents());
    return { ok: true };
  },
  set_memory(a) {
    persist('set_memory', a);
    const { key, value, op = 'write' } = a;
    state.memory[key] = { value, op, ts: Date.now() };
    broadcast('memory', { key, value, op, ts: Date.now() });
    return { ok: true };
  },
  set_agent_state(a) {
    persist('set_agent_state', a);
    const { agent_id, status } = a;
    ensureAgent(agent_id);
    state.agents[agent_id].status = status;
    alertState.lastActivity[agent_id] = Date.now();
    broadcast('agents', safeAgents());
    return { ok: true };
  },
  trace_step(a) {
    persist('trace_step', a);
    const { from_agent, to_agent, label = '', arrow_type = 'msg' } = a;
    ensureAgent(from_agent); ensureAgent(to_agent);
    const arrow = { from: from_agent, to: to_agent, label, arrow_type, ts: Date.now() };
    state.arrows.unshift(arrow);
    if (state.arrows.length > 50) state.arrows.pop();
    broadcast('arrow', arrow);
    return { ok: true };
  },
  set_plan(a) {
    persist('set_plan', a);
    const { tasks } = a;
    state.plan = tasks;
    broadcast('plan', tasks);
    return { ok: true };
  },
  set_goal(a) {
    const { goal, run_id } = a;
    state.goal = goal;
    // preserve pre-set runId (from runScenario) unless caller passes one explicitly
    state.runId = run_id || state.runId || String(Date.now());
    state.status = 'running'; state.startedAt = Date.now();
    resetAlertState();
    if (db) try { db.startRun(state.runId, goal, state.startedAt); } catch (_) {}
    persist('set_goal', a); // after runId is set
    broadcast('goal', { goal, runId: state.runId });
    broadcast('status', 'running');
    return { ok: true };
  },
  finish_run(a) {
    const { status = 'done' } = a;
    state.status = status;
    const finishedAt = Date.now();
    if (db) try { db.finishRun(state.runId, status, finishedAt, { steps: state.metrics.steps, tokens: state.metrics.tokens }); } catch (_) {}
    persist('finish_run', a);
    broadcast('status', status);
    // Check for run duration outlier
    if (status === 'done' && state.startedAt && db) {
      try {
        const dur  = finishedAt - state.startedAt;
        const past = db.getLastRunDurations(10);
        if (past.length >= 3) {
          const mean = past.reduce((s,v)=>s+v,0) / past.length;
          const std  = Math.sqrt(past.reduce((s,v)=>s+(v-mean)**2,0) / past.length);
          if (std > 0 && dur > mean + 2 * std) {
            const key = `outlier:${state.runId}`;
            if (!alertState.fired.has(key)) {
              alertState.fired.add(key);
              fireAlert('run_duration_outlier', {
                duration_ms: dur, mean_ms: Math.round(mean), std_ms: Math.round(std),
                detail: `Run took ${Math.round(dur/1000)}s vs avg ${Math.round(mean/1000)}s`,
              });
            }
          }
        }
      } catch (_) {}
    }
    return { ok: true };
  },

  // ── Internal observability tools ──────────────────────────────────────────
  log_embedding(a) {
    persist('log_embedding', a);
    const { agent, text, model = 'text-embedding-3-small', dims = 1536, latency_ms = 0 } = a;
    ensureAgent(agent);
    const item = { kind: 'embedding', agent, text: String(text).slice(0, 90), model, dims, latency_ms, ts: Date.now() };
    state.internals.unshift(item);
    if (state.internals.length > 200) state.internals.pop();
    broadcast('internal', item);
    return { ok: true };
  },
  log_retrieval(a) {
    persist('log_retrieval', a);
    const { agent, query, results = [], latency_ms = 0 } = a;
    ensureAgent(agent);
    const item = {
      kind: 'retrieval', agent,
      query: String(query).slice(0, 90),
      results: results.slice(0, 6).map(r => ({ text: String(r.text || '').slice(0, 70), score: r.score ?? 0 })),
      latency_ms, ts: Date.now(),
    };
    state.internals.unshift(item);
    if (state.internals.length > 200) state.internals.pop();
    broadcast('internal', item);
    return { ok: true };
  },
  log_tool_call(a) {
    persist('log_tool_call', a);
    const { agent, tool_name, input = '', output = '', latency_ms = 0, error = null } = a;
    ensureAgent(agent);
    const item = {
      kind: 'tool_call', agent, tool_name,
      input:  String(input).slice(0, 4000),
      output: String(output).slice(0, 4000),
      latency_ms, error, ts: Date.now(),
    };
    state.internals.unshift(item);
    if (state.internals.length > 200) state.internals.pop();
    alertState.lastActivity[agent] = Date.now();
    broadcast('internal', item);
    return { ok: true };
  },
  log_generation(a) {
    persist('log_generation', a);
    const { agent, prompt_tokens = 0, completion_tokens = 0, model = '', latency_ms = 0, stop_reason = 'stop', messages = [], response = null, thinking = null } = a;
    ensureAgent(agent);
    const total = prompt_tokens + completion_tokens;
    const item = {
      kind: 'generation', agent, prompt_tokens, completion_tokens, total, model, latency_ms, stop_reason,
      messages: (messages||[]).slice(0,30).map(m => ({ role: String(m.role||'user'), content: String(m.content||'').slice(0,2000) })),
      response: response ? String(response).slice(0,4000) : null,
      thinking: thinking ? String(thinking).slice(0,3000) : null,
      ts: Date.now(),
    };
    state.internals.unshift(item);
    if (state.internals.length > 200) state.internals.pop();
    if (total) {
      state.agents[agent].tokens += total;
      state.agents[agent].calls  += 1;
      state.metrics.tokens       += total;
    }
    alertState.lastActivity[agent] = Date.now();
    if (total) checkTokenBudget(agent);
    broadcast('internal', item);
    broadcast('agents', safeAgents());
    broadcast('metrics', state.metrics);
    return { ok: true };
  },
};
// alias: log_llm_turn → log_generation (richer name exposed in MCP)
TOOLS.log_llm_turn = TOOLS.log_generation;

// ── Run replay ─────────────────────────────────────────────────────────────────
function computeStateAt(runId, targetSeq) {
  if (!db) return null;
  const events = db.getRunEvents(runId);
  const slice = (targetSeq != null) ? events.slice(0, targetSeq) : events;
  const savedState = state;
  state = fresh();
  suppressBroadcast = true;
  suppressPersist   = true;
  slice.forEach(ev => {
    try {
      const args = JSON.parse(ev.args);
      const fn = TOOLS[ev.tool];
      if (fn) fn(args);
    } catch (_) {}
  });
  const snap = snapshot();
  suppressBroadcast = false;
  suppressPersist   = false;
  state = savedState;
  return snap;
}

// ── Demo scenarios ─────────────────────────────────────────────────────────────
const SCENARIOS = {
  research_code: {
    goal: 'Explain quicksort and write a Python implementation',
    steps: [
      { delay: 0, fn: () => {
        TOOLS.register_agent({ id: 'orchestrator', label: 'Orchestrator', role: 'orchestrator', model: 'claude-sonnet-4-20250514', token_budget: 16384 });
        TOOLS.register_agent({ id: 'researcher',   label: 'Researcher',   role: 'researcher',   model: 'claude-haiku-4-5-20251001', reports_to: 'orchestrator', token_budget: 8192 });
        TOOLS.register_agent({ id: 'coder',        label: 'Coder',        role: 'coder',        model: 'claude-sonnet-4-20250514',  reports_to: 'orchestrator', token_budget: 8192 });
        TOOLS.register_agent({ id: 'critic',       label: 'Critic',       role: 'critic',       model: 'claude-haiku-4-5-20251001', reports_to: 'orchestrator', token_budget: 4096 });
      }},
      { delay: 800, fn: () => {
        TOOLS.set_goal({ goal: SCENARIOS.research_code.goal });
        TOOLS.set_agent_state({ agent_id: 'orchestrator', status: 'running' });
        TOOLS.log_generation({ agent: 'orchestrator', prompt_tokens: 280, completion_tokens: 95, model: 'claude-sonnet-4-20250514', latency_ms: 620, stop_reason: 'end_turn',
          messages: [
            { role: 'system', content: 'You are an orchestrator agent. Break the user goal into subtasks and delegate to specialist agents: Researcher (theory/research), Coder (implementation), Critic (validation). Always plan before routing.' },
            { role: 'user', content: 'Explain quicksort and write a Python implementation' },
          ],
          response: "I'll break this into 3 sequential tasks:\n1. **Researcher** — explain quicksort: theory, O(n log n) complexity, partition schemes (Lomuto/Hoare)\n2. **Coder** — write a clean Python implementation with type hints, docstrings, and edge-case handling\n3. **Critic** — review code quality, correctness, and style\n\nRouting to Researcher first.",
        });
        TOOLS.log_event({ agent: 'orchestrator', event_type: 'start', message: 'Planning tasks…' });
      }},
      { delay: 900, fn: () => {
        TOOLS.set_plan({ tasks: [{ agent: 'researcher', task: 'Explain quicksort', depends_on: [] }, { agent: 'coder', task: 'Write Python implementation', depends_on: [0] }, { agent: 'critic', task: 'Validate code quality', depends_on: [1] }] });
        TOOLS.trace_step({ from_agent: 'orchestrator', to_agent: 'researcher', label: 'explain', arrow_type: 'msg' });
        TOOLS.set_agent_state({ agent_id: 'researcher', status: 'running' });
        TOOLS.set_memory({ key: 'goal', value: SCENARIOS.research_code.goal });
      }},
      // Researcher — embed query, web search, generate
      { delay: 400, fn: () => {
        TOOLS.log_embedding({ agent: 'researcher', text: 'quicksort algorithm explanation divide conquer', model: 'text-embedding-3-small', dims: 1536, latency_ms: 48 });
      }},
      { delay: 300, fn: () => {
        TOOLS.log_retrieval({ agent: 'researcher', query: 'quicksort algorithm complexity analysis', latency_ms: 92,
          results: [
            { text: 'Quicksort uses divide-and-conquer: pick a pivot, partition into <, =, > subarrays.', score: 0.94 },
            { text: 'Average-case O(n log n); worst-case O(n²) with bad pivot selection.', score: 0.91 },
            { text: 'Lomuto vs Hoare partition schemes differ in swap count and cache behaviour.', score: 0.87 },
            { text: 'Introsort (used in STL) falls back to heapsort to avoid O(n²) worst case.', score: 0.82 },
          ],
        });
      }},
      { delay: 500, fn: () => {
        TOOLS.log_tool_call({ agent: 'researcher', tool_name: 'web_search', input: 'quicksort algorithm detailed explanation', output: '6 results — Wikipedia, CS Visualizer, CLRS excerpt', latency_ms: 340 });
      }},
      { delay: 900, fn: () => {
        TOOLS.log_generation({ agent: 'researcher', prompt_tokens: 1840, completion_tokens: 620, model: 'claude-haiku-4-5-20251001', latency_ms: 1320, stop_reason: 'end_turn',
          messages: [
            { role: 'system', content: 'You are a researcher agent. Synthesise accurate technical information from retrieved documents. Be precise, cite complexity bounds, note tradeoffs.' },
            { role: 'user', content: 'Task from orchestrator: Explain the quicksort algorithm in detail — theory, complexity, partition schemes.' },
            { role: 'assistant', content: '[embedding query and retrieving relevant documents…]' },
            { role: 'tool', content: 'Retrieved 4 chunks:\n• Quicksort uses divide-and-conquer: pick a pivot, partition into <, =, > subarrays. (score 0.94)\n• Average O(n log n); worst O(n²) with bad pivot selection. (score 0.91)\n• Lomuto vs Hoare partition differ in swap count and cache behaviour. (score 0.87)\n• Introsort falls back to heapsort to avoid O(n²) worst case. (score 0.82)' },
          ],
          response: "**Quicksort** is a divide-and-conquer sorting algorithm:\n\n**Core strategy**: Choose a pivot element, partition the array into ≤ pivot and > pivot halves, then recursively sort each half in-place.\n\n**Complexity**:\n- Average: O(n log n) — balanced splits with good pivot choice\n- Worst: O(n²) — degenerate pivot on already-sorted input\n- Space: O(log n) stack depth average\n\n**Partition schemes**:\n- *Lomuto*: simpler code, last element as pivot, O(n) comparisons\n- *Hoare*: ~3× fewer swaps, two converging pointers\n\n**Practical optimisations**:\n- Median-of-3 pivot selection to avoid worst case\n- Switch to insertion sort for subarrays smaller than ~10 elements\n- Introsort (Python's Timsort variant) adds heapsort fallback for guaranteed O(n log n)",
        });
        TOOLS.log_event({ agent: 'researcher', event_type: 'reply', message: 'Quicksort: divide-and-conquer. Pivot splits into <, =, > partitions. Avg O(n log n), worst O(n²) with sorted input.' });
        TOOLS.set_memory({ key: 'research', value: 'Quicksort: O(n log n) avg, O(n²) worst. Lomuto/Hoare partition.' });
        TOOLS.trace_step({ from_agent: 'researcher', to_agent: 'orchestrator', label: 'done', arrow_type: 'result' });
        TOOLS.set_agent_state({ agent_id: 'researcher', status: 'done' });
      }},
      { delay: 500, fn: () => {
        TOOLS.trace_step({ from_agent: 'orchestrator', to_agent: 'coder', label: 'implement', arrow_type: 'msg' });
        TOOLS.set_agent_state({ agent_id: 'coder', status: 'running' });
      }},
      // Coder — retrieve code examples, execute sandbox, generate
      { delay: 400, fn: () => {
        TOOLS.log_embedding({ agent: 'coder', text: 'Python quicksort implementation with type hints', model: 'text-embedding-3-small', dims: 1536, latency_ms: 51 });
      }},
      { delay: 300, fn: () => {
        TOOLS.log_retrieval({ agent: 'coder', query: 'Python quicksort recursive + in-place implementation', latency_ms: 88,
          results: [
            { text: 'def quicksort(arr): return [] if not arr else quicksort([x for x in arr[1:] if x<=arr[0]])+[arr[0]]+...', score: 0.96 },
            { text: 'def partition(arr, lo, hi): pivot=arr[hi]; i=lo-1; ...', score: 0.93 },
            { text: 'Lomuto partition: O(n) extra calls, simpler code. Hoare: fewer swaps.', score: 0.88 },
          ],
        });
      }},
      { delay: 800, fn: () => {
        TOOLS.log_generation({ agent: 'coder', prompt_tokens: 3200, completion_tokens: 980, model: 'claude-sonnet-4-20250514', latency_ms: 2100, stop_reason: 'end_turn',
          messages: [
            { role: 'system', content: 'You are a coder agent. Write production-quality Python code with type hints, docstrings, and edge-case handling. Use retrieved snippets as reference, not copy-paste.' },
            { role: 'user', content: 'Task from orchestrator: Implement quicksort in Python. Context from researcher:\n- Quicksort: divide-and-conquer, pick pivot, partition into ≤ and > halves\n- Avg O(n log n), worst O(n²)\n- Lomuto partition is simpler; Hoare has fewer swaps' },
            { role: 'assistant', content: '[retrieving code examples and planning implementation…]' },
            { role: 'tool', content: 'Retrieved snippets:\n• def quicksort(arr): return [] if not arr else quicksort([x for x in arr[1:] if x<=arr[0]])+[arr[0]]+... (functional, not in-place)\n• def partition(arr, lo, hi): pivot=arr[hi]; i=lo-1; ... (Lomuto, in-place)' },
          ],
          response: "```python\nfrom typing import TypeVar\n\nT = TypeVar('T')\n\n\ndef quicksort(arr: list[T]) -> list[T]:\n    \"\"\"Return a new sorted list using quicksort (functional style).\n\n    Average O(n log n), worst-case O(n²). Not in-place.\n    \"\"\"\n    if len(arr) <= 1:\n        return arr\n    pivot = arr[len(arr) // 2]  # median-of-1 (simple)\n    left  = [x for x in arr if x < pivot]\n    mid   = [x for x in arr if x == pivot]\n    right = [x for x in arr if x > pivot]\n    return quicksort(left) + mid + quicksort(right)\n\n\ndef quicksort_inplace(arr: list[T], lo: int = 0, hi: int | None = None) -> None:\n    \"\"\"Sort arr in-place using Lomuto partition scheme.\"\"\"\n    if hi is None:\n        hi = len(arr) - 1\n    if lo < hi:\n        p = _partition(arr, lo, hi)\n        quicksort_inplace(arr, lo, p - 1)\n        quicksort_inplace(arr, p + 1, hi)\n\n\ndef _partition(arr: list[T], lo: int, hi: int) -> int:\n    pivot, i = arr[hi], lo - 1\n    for j in range(lo, hi):\n        if arr[j] <= pivot:\n            i += 1\n            arr[i], arr[j] = arr[j], arr[i]\n    arr[i + 1], arr[hi] = arr[hi], arr[i + 1]\n    return i + 1\n```\n\nBoth variants pass edge cases: empty list, single element, all-equal, reverse-sorted.",
        });
      }},
      { delay: 600, fn: () => {
        TOOLS.log_tool_call({ agent: 'coder', tool_name: 'code_execute', input: 'quicksort([3,1,4,1,5,9,2,6]) — smoke test', output: '[1, 1, 2, 3, 4, 5, 6, 9] ✓ (12ms)', latency_ms: 112 });
        TOOLS.log_tool_call({ agent: 'coder', tool_name: 'code_execute', input: 'quicksort([]) — edge case empty list', output: '[] ✓', latency_ms: 8 });
        TOOLS.log_tool_call({ agent: 'coder', tool_name: 'code_execute', input: 'quicksort([1]) — single element', output: '[1] ✓', latency_ms: 6 });
      }},
      { delay: 900, fn: () => {
        TOOLS.log_event({ agent: 'coder', event_type: 'reply', message: 'quicksort() + quicksort_inplace() — full docstrings, Lomuto partition, all edge cases pass.' });
        TOOLS.set_memory({ key: 'code', value: 'def quicksort(arr: list) -> list: ...\ndef quicksort_inplace(arr, lo, hi): ...' });
        TOOLS.trace_step({ from_agent: 'coder', to_agent: 'orchestrator', label: 'ready', arrow_type: 'result' });
        TOOLS.set_agent_state({ agent_id: 'coder', status: 'done' });
      }},
      { delay: 500, fn: () => {
        TOOLS.trace_step({ from_agent: 'orchestrator', to_agent: 'critic', label: 'validate', arrow_type: 'msg' });
        TOOLS.set_agent_state({ agent_id: 'critic', status: 'running' });
      }},
      // Critic — embed code, lint, generate review
      { delay: 400, fn: () => {
        TOOLS.log_embedding({ agent: 'critic', text: 'def quicksort(arr: list) -> list: ...', model: 'text-embedding-3-small', dims: 1536, latency_ms: 44 });
      }},
      { delay: 300, fn: () => {
        TOOLS.log_tool_call({ agent: 'critic', tool_name: 'lint_check', input: 'quicksort.py', output: 'pylint 9.8/10 — 0 errors, 1 convention (missing module docstring)', latency_ms: 180 });
        TOOLS.log_tool_call({ agent: 'critic', tool_name: 'type_check',  input: 'mypy quicksort.py --strict', output: 'Success: no issues found in 1 source file', latency_ms: 95 });
      }},
      { delay: 700, fn: () => {
        TOOLS.log_generation({ agent: 'critic', prompt_tokens: 2100, completion_tokens: 480, model: 'claude-haiku-4-5-20251001', latency_ms: 980, stop_reason: 'end_turn',
          messages: [
            { role: 'system', content: 'You are a critic agent. Review code for correctness, style, type safety, and edge-case coverage. Output a score /10 with justification.' },
            { role: 'user', content: 'Review this Python quicksort implementation:\n\ndef quicksort(arr: list[T]) -> list[T]: ...\ndef quicksort_inplace(arr, lo, hi): ...\n\nTool results: pylint 9.8/10, mypy strict: no issues.' },
          ],
          response: "**PASS — 9/10**\n\n✓ Type hints on public API (TypeVar T for generics)\n✓ Docstrings explain complexity and behaviour\n✓ Both functional and in-place variants provided\n✓ Edge cases: empty list, single element return correctly\n✓ mypy strict passes — no type errors\n✓ pylint 9.8/10\n\n**Minor issues**:\n- Missing module-level docstring (-0.5)\n- `quicksort_inplace` docstring doesn't document `lo`/`hi` params (-0.5)\n- Pivot selection is not median-of-3 — can hit O(n²) on nearly-sorted input (acceptable for demo)\n\nRecommendation: **approve for merge**. Add module docstring before production use.",
        });
        TOOLS.log_event({ agent: 'critic', event_type: 'pass', message: 'PASS 9/10 — clean API, type-safe, edge cases covered. Minor: missing module docstring.' });
        TOOLS.trace_step({ from_agent: 'critic', to_agent: 'orchestrator', label: 'pass 9/10', arrow_type: 'result' });
        TOOLS.set_agent_state({ agent_id: 'critic', status: 'done' });
      }},
      { delay: 400, fn: () => {
        TOOLS.set_memory({ key: 'output', value: 'quicksort.py — approved 9/10' });
        TOOLS.log_event({ agent: 'orchestrator', event_type: 'done', message: 'Run complete — 18 steps' });
        TOOLS.set_agent_state({ agent_id: 'orchestrator', status: 'done' });
        TOOLS.finish_run({ status: 'done' });
      }},
    ],
  },

  critic_retry: {
    goal: 'Write an RFC-5321 compliant email regex validator',
    steps: [
      { delay: 0, fn: () => {
        TOOLS.register_agent({ id: 'orchestrator', label: 'Orchestrator', role: 'orchestrator', model: 'claude-sonnet-4-20250514', token_budget: 16384 });
        TOOLS.register_agent({ id: 'coder',        label: 'Coder',        role: 'coder',        model: 'claude-sonnet-4-20250514',  reports_to: 'orchestrator', token_budget: 8192 });
        TOOLS.register_agent({ id: 'critic',       label: 'Critic',       role: 'critic',       model: 'claude-haiku-4-5-20251001', reports_to: 'orchestrator', token_budget: 4096 });
      }},
      { delay: 700, fn: () => {
        TOOLS.set_goal({ goal: SCENARIOS.critic_retry.goal });
        TOOLS.set_agent_state({ agent_id: 'orchestrator', status: 'running' });
        TOOLS.log_generation({ agent: 'orchestrator', prompt_tokens: 240, completion_tokens: 80, model: 'claude-sonnet-4-20250514', latency_ms: 580 });
        TOOLS.log_event({ agent: 'orchestrator', event_type: 'start', message: 'Planning…' });
      }},
      { delay: 800, fn: () => {
        TOOLS.set_plan({ tasks: [{ agent: 'coder', task: 'Write RFC-5321 email regex', depends_on: [] }, { agent: 'critic', task: 'Validate regex correctness', depends_on: [0] }] });
        TOOLS.trace_step({ from_agent: 'orchestrator', to_agent: 'coder', label: 'write', arrow_type: 'msg' });
        TOOLS.set_agent_state({ agent_id: 'coder', status: 'running' });
      }},
      // Coder v1 — minimal attempt
      { delay: 400, fn: () => {
        TOOLS.log_embedding({ agent: 'coder', text: 'RFC-5321 email address validation regex Python', model: 'text-embedding-3-small', dims: 1536, latency_ms: 49 });
      }},
      { delay: 300, fn: () => {
        TOOLS.log_retrieval({ agent: 'coder', query: 'email regex RFC 5321 compliant Python', latency_ms: 84,
          results: [
            { text: 'Simple: r"[^@]+@[^@]+\\.[^@]+" — catches most but misses edge cases.', score: 0.89 },
            { text: 'RFC-5321 allows quoted strings, IP literals, special chars in local part.', score: 0.85 },
          ],
        });
      }},
      { delay: 900, fn: () => {
        TOOLS.log_generation({ agent: 'coder', prompt_tokens: 920, completion_tokens: 240, model: 'claude-sonnet-4-20250514', latency_ms: 1800, stop_reason: 'end_turn' });
        TOOLS.log_tool_call({ agent: 'coder', tool_name: 'code_execute', input: 'test_email("user@example.com")', output: 'True ✓', latency_ms: 14 });
        TOOLS.log_event({ agent: 'coder', event_type: 'reply', message: 'Draft v1: r"[^@]+" — covers basic cases.' });
        TOOLS.set_memory({ key: 'code', value: 'r"[^@]+"' });
        TOOLS.trace_step({ from_agent: 'coder', to_agent: 'orchestrator', label: 'v1', arrow_type: 'result' });
        TOOLS.set_agent_state({ agent_id: 'coder', status: 'active' });
      }},
      // Critic v1 review — fail
      { delay: 500, fn: () => {
        TOOLS.trace_step({ from_agent: 'orchestrator', to_agent: 'critic', label: 'review v1', arrow_type: 'msg' });
        TOOLS.set_agent_state({ agent_id: 'critic', status: 'running' });
      }},
      { delay: 400, fn: () => {
        TOOLS.log_embedding({ agent: 'critic', text: 'r"[^@]+" email regex RFC-5321 compliance', model: 'text-embedding-3-small', dims: 1536, latency_ms: 46 });
        TOOLS.log_tool_call({ agent: 'critic', tool_name: 'regex_test_suite', input: 'RFC-5321 test vectors (120 cases)', output: '67/120 pass — missing TLDs, quoted strings, IP literals, consecutive dot check', latency_ms: 220 });
      }},
      { delay: 700, fn: () => {
        TOOLS.log_generation({ agent: 'critic', prompt_tokens: 1400, completion_tokens: 360, model: 'claude-haiku-4-5-20251001', latency_ms: 980, stop_reason: 'end_turn' });
        TOOLS.log_event({ agent: 'critic', event_type: 'fail', message: 'FAIL 4/10 — 67/120 test vectors pass. Missing: TLDs, quoted strings, IP literals, consecutive-dot rule.' });
        TOOLS.set_memory({ key: 'critique', value: 'fail 4/10 — missing TLDs, quoted strings, IP literals' });
        TOOLS.trace_step({ from_agent: 'critic', to_agent: 'orchestrator', label: 'fail 4/10', arrow_type: 'result' });
        TOOLS.set_agent_state({ agent_id: 'critic', status: 'active' });
        state.metrics.retries++; broadcast('metrics', state.metrics);
      }},
      // Orchestrator retries coder
      { delay: 500, fn: () => {
        TOOLS.log_generation({ agent: 'orchestrator', prompt_tokens: 480, completion_tokens: 120, model: 'claude-sonnet-4-20250514', latency_ms: 640 });
        TOOLS.log_event({ agent: 'orchestrator', event_type: 'retry', message: 'Critic FAIL — retrying Coder with full critique attached' });
        TOOLS.trace_step({ from_agent: 'orchestrator', to_agent: 'coder', label: 'retry', arrow_type: 'retry' });
        TOOLS.set_agent_state({ agent_id: 'coder', status: 'running' });
      }},
      // Coder v2 — thorough attempt
      { delay: 400, fn: () => {
        TOOLS.log_embedding({ agent: 'coder', text: 'RFC-5321 quoted strings IP literal TLD validation', model: 'text-embedding-3-small', dims: 1536, latency_ms: 52 });
        TOOLS.log_retrieval({ agent: 'coder', query: 'RFC 5321 email local-part quoted string IP literal syntax', latency_ms: 96,
          results: [
            { text: 'Local part: atom or quoted-string. Quoted allows spaces, special chars within double quotes.', score: 0.95 },
            { text: 'Domain: hostname or IP literal [n.n.n.n]. TLD must be 2+ alpha chars.', score: 0.93 },
            { text: 'No consecutive dots in local or domain part. No leading/trailing dot.', score: 0.91 },
          ],
        });
      }},
      { delay: 1200, fn: () => {
        TOOLS.log_generation({ agent: 'coder', prompt_tokens: 2800, completion_tokens: 780, model: 'claude-sonnet-4-20250514', latency_ms: 2600, stop_reason: 'end_turn' });
      }},
      { delay: 600, fn: () => {
        TOOLS.log_tool_call({ agent: 'coder', tool_name: 'code_execute', input: 'RFC-5321 test suite — 120 vectors', output: '118/120 pass (2 obscure IPv6 edge cases)', latency_ms: 340 });
        TOOLS.log_event({ agent: 'coder', event_type: 'reply', message: 'Draft v2: RFC-5321 compliant — TLD check, quoted strings, IP literals, consecutive-dot guard.' });
        TOOLS.set_memory({ key: 'code', value: 'RFC5321_RE = re.compile(r\'...\')  # 118/120 RFC vectors pass' });
        TOOLS.trace_step({ from_agent: 'coder', to_agent: 'orchestrator', label: 'v2', arrow_type: 'result' });
        TOOLS.set_agent_state({ agent_id: 'coder', status: 'done' });
      }},
      // Critic v2 review — pass
      { delay: 500, fn: () => {
        TOOLS.trace_step({ from_agent: 'orchestrator', to_agent: 'critic', label: 'review v2', arrow_type: 'msg' });
        TOOLS.set_agent_state({ agent_id: 'critic', status: 'running' });
      }},
      { delay: 400, fn: () => {
        TOOLS.log_tool_call({ agent: 'critic', tool_name: 'regex_test_suite', input: 'RFC-5321 test vectors (120 cases)', output: '118/120 pass — 2 obscure IPv6 literals; acceptable for prod use', latency_ms: 215 });
      }},
      { delay: 700, fn: () => {
        TOOLS.log_generation({ agent: 'critic', prompt_tokens: 1600, completion_tokens: 320, model: 'claude-haiku-4-5-20251001', latency_ms: 860, stop_reason: 'end_turn' });
        TOOLS.log_event({ agent: 'critic', event_type: 'pass', message: 'PASS 9/10 — 118/120 RFC vectors pass, production-ready.' });
        TOOLS.trace_step({ from_agent: 'critic', to_agent: 'orchestrator', label: 'pass 9/10', arrow_type: 'result' });
        TOOLS.set_agent_state({ agent_id: 'critic', status: 'done' });
      }},
      { delay: 400, fn: () => {
        TOOLS.log_event({ agent: 'orchestrator', event_type: 'done', message: 'Complete after 1 retry — 1 retry, 20 steps' });
        TOOLS.set_agent_state({ agent_id: 'orchestrator', status: 'done' });
        TOOLS.finish_run({ status: 'done' });
      }},
    ],
  },

  memory_overflow: {
    goal: 'Summarise 3 ML papers and synthesise into a report',
    steps: [
      { delay: 0, fn: () => {
        TOOLS.register_agent({ id: 'orchestrator', label: 'Orchestrator', role: 'orchestrator', model: 'claude-sonnet-4-20250514', token_budget: 16384 });
        TOOLS.register_agent({ id: 'researcher',   label: 'Researcher',   role: 'researcher',   model: 'claude-haiku-4-5-20251001', reports_to: 'orchestrator', token_budget: 8192 });
        TOOLS.register_agent({ id: 'synthesiser',  label: 'Synthesiser',  role: 'synthesiser',  model: 'claude-sonnet-4-20250514',  reports_to: 'orchestrator', token_budget: 8192 });
        TOOLS.register_agent({ id: 'critic',       label: 'Critic',       role: 'critic',       model: 'claude-haiku-4-5-20251001', reports_to: 'orchestrator', token_budget: 4096 });
      }},
      { delay: 700, fn: () => {
        TOOLS.set_goal({ goal: SCENARIOS.memory_overflow.goal });
        TOOLS.set_agent_state({ agent_id: 'orchestrator', status: 'running' });
        TOOLS.log_generation({ agent: 'orchestrator', prompt_tokens: 260, completion_tokens: 88, model: 'claude-sonnet-4-20250514', latency_ms: 600 });
        TOOLS.log_event({ agent: 'orchestrator', event_type: 'start', message: 'Planning 3-paper synthesis…' });
      }},
      { delay: 900, fn: () => {
        TOOLS.set_plan({ tasks: [{ agent: 'researcher', task: 'Summarise paper A — scaling laws', depends_on: [] }, { agent: 'researcher', task: 'Summarise paper B — MoE routing', depends_on: [] }, { agent: 'researcher', task: 'Summarise paper C — RLHF hacking', depends_on: [] }, { agent: 'synthesiser', task: 'Synthesise into report', depends_on: [0,1,2] }] });
        TOOLS.trace_step({ from_agent: 'orchestrator', to_agent: 'researcher', label: 'paper A', arrow_type: 'msg' });
        TOOLS.set_agent_state({ agent_id: 'researcher', status: 'running' });
      }},
      // Paper A
      { delay: 400, fn: () => {
        TOOLS.log_tool_call({ agent: 'researcher', tool_name: 'pdf_extract', input: 'scaling_laws_2020.pdf', output: '18,400 tokens extracted — 42 pages', latency_ms: 480 });
        TOOLS.log_embedding({ agent: 'researcher', text: 'neural scaling laws loss compute data parameters', model: 'text-embedding-3-small', dims: 1536, latency_ms: 55 });
      }},
      { delay: 600, fn: () => {
        TOOLS.log_retrieval({ agent: 'researcher', query: 'key findings scaling laws compute-optimal training', latency_ms: 104,
          results: [
            { text: 'Loss scales as power law with N (params), D (data), C (compute): L ∝ N^0.076.', score: 0.97 },
            { text: 'Compute-optimal: scale params and data proportionally. Chinchilla law.', score: 0.94 },
            { text: 'Irreducible loss ≈ 1.69 nats; emergent capabilities at scale thresholds.', score: 0.88 },
          ],
        });
        TOOLS.log_generation({ agent: 'researcher', prompt_tokens: 2400, completion_tokens: 520, model: 'claude-haiku-4-5-20251001', latency_ms: 1600, stop_reason: 'end_turn' });
        TOOLS.log_event({ agent: 'researcher', event_type: 'reply', message: 'Paper A: Scaling laws — loss ∝ N^0.076. Compute-optimal: equal param/data scaling.' });
        TOOLS.set_memory({ key: 'paper_a', value: 'Scaling laws: loss ∝ N^0.076, Chinchilla-optimal' });
        TOOLS.trace_step({ from_agent: 'researcher', to_agent: 'orchestrator', label: 'A done', arrow_type: 'result' });
      }},
      // Paper B
      { delay: 400, fn: () => {
        TOOLS.trace_step({ from_agent: 'orchestrator', to_agent: 'researcher', label: 'paper B', arrow_type: 'msg' });
        TOOLS.log_tool_call({ agent: 'researcher', tool_name: 'pdf_extract', input: 'moe_routing_2023.pdf', output: '22,100 tokens extracted — 51 pages', latency_ms: 520 });
        TOOLS.log_embedding({ agent: 'researcher', text: 'mixture of experts routing sparse transformer efficiency', model: 'text-embedding-3-small', dims: 1536, latency_ms: 53 });
      }},
      { delay: 600, fn: () => {
        TOOLS.log_retrieval({ agent: 'researcher', query: 'MoE routing top-k expert selection load balancing', latency_ms: 98,
          results: [
            { text: 'Top-2 routing: each token sent to 2 of N experts. 60% active-param reduction vs dense.', score: 0.96 },
            { text: 'Load balancing loss prevents expert collapse. Jitter noise aids exploration.', score: 0.92 },
            { text: 'Switch Transformer: top-1 routing, simpler but prone to collapse without aux loss.', score: 0.87 },
          ],
        });
        TOOLS.log_generation({ agent: 'researcher', prompt_tokens: 2800, completion_tokens: 490, model: 'claude-haiku-4-5-20251001', latency_ms: 1500, stop_reason: 'end_turn' });
        TOOLS.log_event({ agent: 'researcher', event_type: 'reply', message: 'Paper B: MoE top-2 routing, 60% active-param reduction. Load-balance aux loss prevents collapse.' });
        TOOLS.set_memory({ key: 'paper_b', value: 'MoE: top-2 routing, 60% reduction, aux load-balance loss' });
        TOOLS.trace_step({ from_agent: 'researcher', to_agent: 'orchestrator', label: 'B done', arrow_type: 'result' });
      }},
      // Paper C — triggers memory pressure
      { delay: 400, fn: () => {
        TOOLS.trace_step({ from_agent: 'orchestrator', to_agent: 'researcher', label: 'paper C', arrow_type: 'msg' });
        TOOLS.log_tool_call({ agent: 'researcher', tool_name: 'pdf_extract', input: 'rlhf_reward_hacking_2024.pdf', output: '31,200 tokens extracted — 68 pages', latency_ms: 710 });
        TOOLS.log_embedding({ agent: 'researcher', text: 'RLHF reward hacking overoptimisation KL penalty', model: 'text-embedding-3-small', dims: 1536, latency_ms: 58 });
      }},
      { delay: 600, fn: () => {
        TOOLS.log_retrieval({ agent: 'researcher', query: 'reward hacking frequency mitigation strategies RLHF', latency_ms: 112,
          results: [
            { text: 'Reward hacking observed in 34% of runs beyond 3000 RL steps. KL alone insufficient.', score: 0.95 },
            { text: 'Constitutional AI + process reward models reduce hacking to <8%.', score: 0.91 },
            { text: 'Ensemble reward models provide more robust signal than single RM.', score: 0.88 },
          ],
        });
        TOOLS.log_generation({ agent: 'researcher', prompt_tokens: 3200, completion_tokens: 560, model: 'claude-haiku-4-5-20251001', latency_ms: 1800, stop_reason: 'end_turn' });
        TOOLS.log_event({ agent: 'researcher', event_type: 'reply', message: 'Paper C: RLHF reward hacking in 34% of runs. KL penalty alone insufficient; ensemble RMs help.' });
        TOOLS.set_memory({ key: 'paper_c', value: 'RLHF: reward hacking 34%, use ensemble RMs + CAI' });
        TOOLS.trace_step({ from_agent: 'researcher', to_agent: 'orchestrator', label: 'C done', arrow_type: 'result' });
        TOOLS.set_agent_state({ agent_id: 'researcher', status: 'done' });
      }},
      // Synthesiser — context overflow
      { delay: 600, fn: () => {
        TOOLS.trace_step({ from_agent: 'orchestrator', to_agent: 'synthesiser', label: 'synthesise', arrow_type: 'msg' });
        TOOLS.set_agent_state({ agent_id: 'synthesiser', status: 'running' });
      }},
      { delay: 400, fn: () => {
        TOOLS.log_embedding({ agent: 'synthesiser', text: 'scaling laws MoE routing RLHF reward hacking synthesis', model: 'text-embedding-3-small', dims: 1536, latency_ms: 62 });
        TOOLS.log_tool_call({ agent: 'synthesiser', tool_name: 'context_count', input: 'papers A+B+C combined tokens', output: '7,840 / 8,192 tokens used (95.7%) — paper C will be truncated', latency_ms: 12 });
        TOOLS.log_event({ agent: 'synthesiser', event_type: 'warn', message: 'WARNING: context at 95.7% — paper C (RLHF) will be truncated to fit budget.' });
      }},
      { delay: 1200, fn: () => {
        TOOLS.log_generation({ agent: 'synthesiser', prompt_tokens: 7840, completion_tokens: 980, model: 'claude-sonnet-4-20250514', latency_ms: 3200, stop_reason: 'max_tokens' });
        TOOLS.log_event({ agent: 'synthesiser', event_type: 'reply', message: 'Report done (partial): scaling laws + MoE full coverage; RLHF section truncated — recommend re-running with chunked context.' });
        TOOLS.set_memory({ key: 'output', value: 'Report: scaling (full) + MoE (full) + RLHF (truncated)' });
        TOOLS.trace_step({ from_agent: 'synthesiser', to_agent: 'orchestrator', label: 'report', arrow_type: 'result' });
        TOOLS.set_agent_state({ agent_id: 'synthesiser', status: 'done' });
      }},
      { delay: 400, fn: () => {
        TOOLS.log_event({ agent: 'orchestrator', event_type: 'done', message: 'Complete — context overflow on paper C. Recommend chunked summarisation for large doc sets.' });
        TOOLS.set_agent_state({ agent_id: 'orchestrator', status: 'done' });
        TOOLS.finish_run({ status: 'done' });
      }},
    ],
  },
};

function runScenario(name) {
  const s = SCENARIOS[name];
  if (!s) return false;
  const clients = state.clients;
  // Delete the previous run if it was abandoned (clicked again before scenario finished)
  if (db && state.runId && state.status !== 'done' && state.status !== 'error') {
    try { db.deleteRun(state.runId); } catch (_) {}
  }
  state = fresh();
  state.clients = clients;
  resetAlertState();
  // Pre-set runId so all scenario events (including register_agent) are persisted from step 0
  state.runId = String(Date.now());
  if (db) try { db.startRun(state.runId, s.goal, Date.now()); } catch (_) {}
  broadcast('reset', {});
  let cum = 0;
  s.steps.forEach(step => { cum += step.delay; setTimeout(() => { try { step.fn(); } catch (e) { console.error(e); } }, cum); });
  return true;
}

// ── Dashboard HTML ─────────────────────────────────────────────────────────────
const HTML = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');

// ── HTTP helpers ──────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
};
function body(req, cb) { let d = ''; req.on('data', c => d += c); req.on('end', () => cb(d)); }
function json(res, data, status = 200) {
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── HTTP server ────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  const u2       = new URL(req.url, `http://localhost`);
  const pathname = u2.pathname;

  // ── Auth routes (always public) ────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/login') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(LOGIN_HTML.replace('__ERR__', ''));
    return;
  }
  if (req.method === 'POST' && pathname === '/auth/login') {
    body(req, data => {
      const params = new URLSearchParams(data);
      const pwd    = params.get('password') || '';
      if (PASSWORD && pwd === PASSWORD) {
        const token = genToken();
        sessions.add(token);
        res.writeHead(302, { 'Set-Cookie': `agentscope_session=${token}; HttpOnly; Path=/`, Location: '/' });
        res.end(); return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(LOGIN_HTML.replace('__ERR__', 'Incorrect password'));
    }); return;
  }
  if (req.method === 'POST' && pathname === '/auth/logout') {
    const cookies = parseCookies(req.headers['cookie'] || '');
    if (cookies.agentscope_session) sessions.delete(cookies.agentscope_session);
    res.writeHead(302, { 'Set-Cookie': 'agentscope_session=; HttpOnly; Path=/; Max-Age=0', Location: '/login' });
    res.end(); return;
  }

  // ── Auth gate ──────────────────────────────────────────────────────────────
  const auth = checkAuth(req);
  if (!auth.ok) {
    if (auth.reason === 'rate_limit') { json(res, { error: 'Rate limit exceeded' }, 429); return; }
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/events')) {
      res.writeHead(302, { Location: '/login' }); res.end(); return;
    }
    json(res, { error: 'Unauthorized' }, 401); return;
  }


  // Dashboard UI
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
    return;
  }

  // SSE stream
  if (req.method === 'GET' && pathname === '/events') {
    res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'init', payload: { state: snapshot() }, ts: Date.now() })}\n\n`);
    state.clients.push(res);
    req.on('close', () => { state.clients = state.clients.filter(c => c !== res); });
    return;
  }

  // Current state snapshot
  if (req.method === 'GET' && pathname === '/state') {
    json(res, snapshot()); return;
  }

  // Tool call
  if (req.method === 'POST' && pathname === '/tool') {
    body(req, data => {
      try {
        const { tool, args } = JSON.parse(data);
        const fn = TOOLS[tool];
        if (db && tool) try { db.appendAudit(auth.keyId, tool, state.runId); } catch (_) {}
        json(res, fn ? fn(args || {}) : { error: `Unknown tool: ${tool}` });
      } catch (e) { json(res, { error: e.message }, 400); }
    }); return;
  }

  // Run a demo scenario
  if (req.method === 'POST' && pathname === '/emulate') {
    body(req, data => {
      const { scenario } = JSON.parse(data || '{}');
      const ok = runScenario(scenario || 'research_code');
      json(res, { ok, scenario }, ok ? 200 : 400);
    }); return;
  }

  // Reset state
  if (req.method === 'POST' && pathname === '/reset') {
    const clients = state.clients;
    state = fresh(); state.clients = clients;
    broadcast('reset', {});
    json(res, { ok: true }); return;
  }

  // ── Run history API ────────────────────────────────────────────────────────
  // GET /runs[?q=search] — list historical runs
  if (req.method === 'GET' && pathname === '/runs') {
    const q = u2.searchParams.get('q') || '';
    json(res, db ? db.listRuns({ q, limit: 50 }) : []); return;
  }

  // GET /runs/:id/state[?seq=N] — replay snapshot at event N
  if (req.method === 'GET' && /^\/runs\/[^/]+\/state$/.test(pathname)) {
    const runId = pathname.slice(6, -6);
    const seq = parseInt(u2.searchParams.get('seq') || '0') || 0;
    const snap = computeStateAt(runId, seq);
    if (!snap) { json(res, { error: 'Persistence disabled or run not found' }, 404); return; }
    json(res, snap); return;
  }

  // GET /runs/:id — single run metadata (with event_count)
  if (req.method === 'GET' && /^\/runs\/[^/]+$/.test(pathname)) {
    const runId = pathname.slice(6);
    const run = db ? db.getRun(runId) : null;
    if (!run) { json(res, { error: 'Not found' }, 404); return; }
    json(res, run); return;
  }

  // DELETE /runs/:id — delete a run and its events
  if (req.method === 'DELETE' && /^\/runs\/[^/]+$/.test(pathname)) {
    const runId = pathname.slice(6);
    if (db) db.deleteRun(runId);
    json(res, { ok: true }); return;
  }

  // GET /alerts/config — get current alert thresholds
  if (req.method === 'GET' && pathname === '/alerts/config') {
    json(res, alertConfig); return;
  }

  // POST /alerts/config — update alert thresholds / webhook
  if (req.method === 'POST' && pathname === '/alerts/config') {
    body(req, data => {
      try {
        const c = JSON.parse(data || '{}');
        if ('webhookUrl'        in c) alertConfig.webhookUrl        = c.webhookUrl || null;
        if ('tokenBudgetPct'    in c) alertConfig.tokenBudgetPct    = Math.max(1,  Math.min(100, Number(c.tokenBudgetPct)));
        if ('stuckAgentSec'     in c) alertConfig.stuckAgentSec     = Math.max(10, Number(c.stuckAgentSec));
        if ('criticFailRatePct' in c) alertConfig.criticFailRatePct = Math.max(1,  Math.min(100, Number(c.criticFailRatePct)));
        json(res, alertConfig);
      } catch (e) { json(res, { error: e.message }, 400); }
    }); return;
  }

  // GET /alerts/history — recent fired alerts
  if (req.method === 'GET' && pathname === '/alerts/history') {
    const limit = parseInt(u2.searchParams.get('limit') || '50');
    json(res, db ? db.listAlerts({ limit }) : []); return;
  }

  // ── API key management ─────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/keys') {
    json(res, db ? db.listApiKeys() : []); return;
  }
  if (req.method === 'POST' && pathname === '/keys') {
    body(req, data => {
      try {
        if (!db) { json(res, { error: 'Persistence disabled' }, 503); return; }
        const { label = '', rateLimit = 60, tokenBudget = null } = JSON.parse(data || '{}');
        const raw = 'mavt_sk_' + crypto.randomBytes(16).toString('hex');
        const id  = crypto.randomBytes(4).toString('hex');
        db.createApiKey(id, label, hashKey(raw), rateLimit, tokenBudget);
        json(res, { id, label, key: raw, rateLimit, tokenBudget, note: 'Save this key — it will not be shown again' });
      } catch (e) { json(res, { error: e.message }, 400); }
    }); return;
  }
  if (req.method === 'DELETE' && /^\/keys\/[^/]+$/.test(pathname)) {
    const id = pathname.slice(6);
    if (db) db.deleteApiKey(id);
    json(res, { ok: true }); return;
  }

  // ── Audit log ──────────────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/audit') {
    const keyId = u2.searchParams.get('key_id') || null;
    const limit = parseInt(u2.searchParams.get('limit') || '100');
    const since = parseInt(u2.searchParams.get('since') || '0');
    json(res, db ? db.listAudit({ keyId, limit, since }) : []); return;
  }

  // ── Export API ─────────────────────────────────────────────────────────────
  if (req.method === 'GET' && /^\/export\/run\/[^/]+$/.test(pathname)) {
    const runId = pathname.slice(12);
    if (!db) { json(res, { error: 'Persistence disabled' }, 503); return; }
    const run = db.getRun(runId);
    if (!run) { json(res, { error: 'Not found' }, 404); return; }
    const events = db.getRunEvents(runId);
    const out = JSON.stringify({ run, events }, null, 2);
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="run-${runId}.json"` });
    res.end(out); return;
  }
  if (req.method === 'GET' && pathname === '/export/runs') {
    if (!db) { json(res, { error: 'Persistence disabled' }, 503); return; }
    const since  = parseInt(u2.searchParams.get('since') || '0');
    const status = u2.searchParams.get('status') || null;
    const limit  = parseInt(u2.searchParams.get('limit') || '100');
    const runs   = db.exportRuns({ since, status, limit });
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="runs-export.json"' });
    res.end(JSON.stringify(runs, null, 2)); return;
  }

  // ── Data API (licence-gated) ───────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/v1/metrics') {
    if (!licence.valid) { json(res, { error: 'Licence required', upgrade: 'https://agentscope.dev/pricing' }, 402); return; }
    json(res, db ? db.getMetrics() : { error: 'Persistence disabled' }); return;
  }

  // GET /licence/status — for dashboard badge
  if (req.method === 'GET' && pathname === '/licence/status') {
    json(res, { valid: licence.valid, tier: licence.tier || null, expires: licence.expires || null }); return;
  }

  json(res, { error: 'Not found' }, 404);
});

server.listen(PORT, () => {
  console.log(`\n  agent-visibility\n`);
  console.log(`  Dashboard  →  http://localhost:${PORT}`);
  console.log(`  Tool POST  →  http://localhost:${PORT}/tool`);
  console.log(`  Ctrl+C to stop\n`);
});
