'use strict';
const test   = require('node:test');
const assert = require('node:assert');
const { startServer, request } = require('./helpers');

const tool = (port, name, args) =>
  request(port, { method: 'POST', path: '/tool', headers: { 'Content-Type': 'application/json' }, body: { tool: name, args } });

async function shortRun(port, runId, { budget = null, tokens = 300 } = {}) {
  await tool(port, 'set_goal', { goal: `goal ${runId}`, run_id: runId });
  await tool(port, 'register_agent', { id: 'lead', label: 'Lead', role: 'orchestrator', token_budget: budget });
  await tool(port, 'log_event', { agent: 'lead', event_type: 'retry', message: 'again' });
  await tool(port, 'set_memory', { key: 'k', value: 'v' });
  await tool(port, 'log_generation', { agent: 'lead', prompt_tokens: tokens, completion_tokens: 0, response: 'ok' });
  await tool(port, 'finish_run', { status: 'done' });
}

// Fields that must match between the live run and its replay (timestamps aside).
const comparable = s => ({
  goal: s.goal, status: s.status, metrics: s.metrics, registry: s.registry, plan: s.plan,
  agents: Object.fromEntries(Object.entries(s.agents).map(([k, a]) => [k, { status: a.status, tokens: a.tokens, calls: a.calls }])),
  memory: Object.fromEntries(Object.entries(s.memory).map(([k, m]) => [k, m.value])),
  events: s.events.map(e => [e.agent, e.event_type, e.message]),
  internals: s.internals.map(i => [i.kind, i.agent]),
});

test('replay matches the live run and never writes', async t => {
  const s = await startServer();
  t.after(s.stop);
  await shortRun(s.port, 'r1');
  const live = (await request(s.port, { path: '/state' })).json;
  const before = (await request(s.port, { path: '/runs' })).json;

  const replay = (await request(s.port, { path: '/runs/r1/state' })).json;
  assert.deepStrictEqual(comparable(replay), comparable(live));
  for (let seq = 1; seq <= 6; seq++) await request(s.port, { path: `/runs/r1/state?seq=${seq}` });

  assert.deepStrictEqual((await request(s.port, { path: '/runs' })).json, before, 'replay must not add or change runs');
  assert.strictEqual((await request(s.port, { path: '/alerts/history' })).json.length, 0);
});

test('runs do not leak into each other', async t => {
  const s = await startServer();
  t.after(s.stop);
  await shortRun(s.port, 'r1');
  // second run registers before set_goal, like many agents do
  await tool(s.port, 'register_agent', { id: 'solo', label: 'Solo', role: 'worker' });
  await tool(s.port, 'set_goal', { goal: 'second', run_id: 'r2' });
  await tool(s.port, 'log_event', { agent: 'solo', event_type: 'start', message: 'go' });

  const st = (await request(s.port, { path: '/state' })).json;
  assert.deepStrictEqual(Object.keys(st.registry), ['solo']);
  assert.deepStrictEqual(st.metrics, { steps: 1, tokens: 0, retries: 0 });
  assert.strictEqual((await request(s.port, { path: '/runs/r2' })).json.agents_text, 'solo');
  assert.strictEqual((await request(s.port, { path: '/runs/r1' })).json.agents_text, 'lead');
  const replay = (await request(s.port, { path: '/runs/r2/state' })).json;
  assert.deepStrictEqual(Object.keys(replay.registry), ['solo']);
});

test('counts real retry events', async t => {
  const s = await startServer();
  t.after(s.stop);
  await shortRun(s.port, 'r1');
  assert.strictEqual((await request(s.port, { path: '/state' })).json.metrics.retries, 1);
});

test('token budget alerts need a budget and fire once', async t => {
  const s = await startServer();
  t.after(s.stop);
  await shortRun(s.port, 'nobudget', { tokens: 50000 });
  assert.strictEqual((await request(s.port, { path: '/alerts/history' })).json.length, 0);

  await tool(s.port, 'set_goal', { goal: 'b', run_id: 'budget' });
  await tool(s.port, 'register_agent', { id: 'a', label: 'A', role: 'worker', token_budget: 1000 });
  for (let i = 0; i < 5; i++) await tool(s.port, 'log_generation', { agent: 'a', prompt_tokens: 400, completion_tokens: 0 });
  const alerts = (await request(s.port, { path: '/alerts/history' })).json;
  assert.strictEqual(alerts.filter(a => a.type === 'token_budget_exceeded').length, 1);
});

test('alert settings survive a restart and ignore non-numbers', async t => {
  const s1 = await startServer();
  await request(s1.port, { method: 'POST', path: '/alerts/config', headers: { 'Content-Type': 'application/json' },
    body: { webhookUrl: 'http://127.0.0.1:9/hook', stuckAgentSec: 300, tokenBudgetPct: 'abc' } });
  s1.stop();
  const s2 = await startServer({}, s1.home);
  t.after(s2.stop);
  const cfg = (await request(s2.port, { path: '/alerts/config' })).json;
  assert.strictEqual(cfg.webhookUrl, 'http://127.0.0.1:9/hook');
  assert.strictEqual(cfg.stuckAgentSec, 300);
  assert.strictEqual(cfg.tokenBudgetPct, 90);
});

test('bad requests do not crash the server', async t => {
  const s = await startServer();
  t.after(s.stop);
  assert.strictEqual((await request(s.port, { path: '/state', headers: { Cookie: 'x=%E0%A4%A' } })).status, 200);
  assert.strictEqual((await request(s.port, { method: 'POST', path: '/emulate', body: '{not json' })).status, 400);
  const big = await request(s.port, { method: 'POST', path: '/tool', body: 'x'.repeat(6 * 1024 * 1024) }).catch(e => ({ status: e.code }));
  assert.ok([413, 'ECONNRESET', 'EPIPE'].includes(big.status), `got ${big.status}`);
  assert.strictEqual((await request(s.port, { path: '/state' })).status, 200, 'server still up');
});
