'use strict';
const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const { startServer, request, tmpHome, start, freePort } = require('./helpers');
const pricing  = require('../src/pricing');
const security = require('../src/security');
const { analyse } = require('../src/analytics');
const { Visibility } = require('../src/sdk');

const tool = (port, name, args, headers = {}) =>
  request(port, { method: 'POST', path: '/tool', headers: { 'Content-Type': 'application/json', ...headers }, body: { tool: name, args } });
const post = (port, p, body, headers = {}) =>
  request(port, { method: 'POST', path: p, headers: { 'Content-Type': 'application/json', ...headers }, body });

// ── pricing ───────────────────────────────────────────────────────────────────
test('pricing matches dated and provider-prefixed model ids by longest prefix', () => {
  assert.deepStrictEqual(pricing.priceFor('claude-sonnet-4-20250514'), [3, 15]);
  assert.deepStrictEqual(pricing.priceFor('claude-opus-4-1-20250805'), [15, 75]);
  assert.deepStrictEqual(pricing.priceFor('claude-opus-4-8'), [5, 25]);
  assert.deepStrictEqual(pricing.priceFor('anthropic.claude-haiku-4-5-20251001-v1:0'), [1, 5]);
  assert.deepStrictEqual(pricing.priceFor('openai/gpt-4o-mini'), [0.15, 0.6]);
  assert.strictEqual(pricing.priceFor('qwen3-coder'), null);
  assert.strictEqual(pricing.costOf('qwen3-coder', 1000, 1000), null);
  assert.strictEqual(pricing.costOf('claude-opus-5-5', 1e6, 1e6), 24);
});

test('pricing.json overrides and extends the built-in table', () => {
  const dir = tmpHome();
  fs.writeFileSync(path.join(dir, 'pricing.json'), JSON.stringify({ 'qwen3-coder': [0, 0], 'gpt-4o': { input: 1, output: 2 }, bad: 'x' }));
  assert.strictEqual(pricing.loadOverrides(dir), 2);
  assert.strictEqual(pricing.costOf('qwen3-coder', 5000, 5000), 0);
  assert.strictEqual(pricing.costOf('gpt-4o', 1e6, 1e6), 3);
  pricing.loadOverrides(tmpHome()); // back to defaults
  assert.strictEqual(pricing.costOf('gpt-4o', 1e6, 1e6), 12.5);
});

// ── encryption ────────────────────────────────────────────────────────────────
test('encryption round-trips and rejects wrong keys, tampering and bad key formats', () => {
  const key = security.parseKey(security.generateKey());
  const enc = security.encrypt(key, '{"secret":"prompt"}');
  assert.ok(security.isEncrypted(enc) && !enc.includes('prompt'));
  assert.notStrictEqual(enc, security.encrypt(key, '{"secret":"prompt"}')); // fresh IV each time
  assert.strictEqual(security.decrypt(key, enc), '{"secret":"prompt"}');
  assert.strictEqual(security.decrypt(key, '{"plain":1}'), '{"plain":1}'); // rows written before a key was set
  assert.throws(() => security.decrypt(security.parseKey(security.generateKey()), enc), /Could not decrypt/);
  assert.throws(() => security.decrypt(key, enc.slice(0, -4) + 'AAAA'), /Could not decrypt/);
  assert.throws(() => security.decrypt(null, enc), /VISIBILITY_ENCRYPTION_KEY/);
  assert.throws(() => security.parseKey('too-short'), /64 hex/);
  assert.strictEqual(security.parseKey(''), null);
});

test('with a key, event payloads are encrypted on disk and replay still works', async t => {
  const key = security.generateKey();
  const s = await startServer({ VISIBILITY_ENCRYPTION_KEY: key });
  await tool(s.port, 'set_goal', { goal: 'enc run', run_id: 'e1' });
  await tool(s.port, 'log_generation', { agent: 'a', prompt_tokens: 10, completion_tokens: 5, response: 'TOP-SECRET-RESPONSE' });
  await tool(s.port, 'finish_run', {});
  const replay = await request(s.port, { path: '/runs/e1/state' });
  assert.strictEqual(replay.json.internals[0].response, 'TOP-SECRET-RESPONSE');
  s.stop();

  const dir = path.join(s.home, '.agentscope');
  const onDisk = fs.readdirSync(dir).filter(f => f.startsWith('runs.db')).map(f => fs.readFileSync(path.join(dir, f), 'latin1')).join('');
  assert.ok(onDisk.includes('enc:v1:'), 'events should be stored encrypted');
  assert.ok(!onDisk.includes('TOP-SECRET-RESPONSE'), 'plaintext must not reach the database');

  // Same data, no key: the server says why instead of crashing or returning garbage.
  const noKey = await startServer({}, s.home);
  t.after(noKey.stop);
  const r = await request(noKey.port, { path: '/runs/e1/state' });
  assert.strictEqual(r.status, 500);
  assert.match(r.json.error, /VISIBILITY_ENCRYPTION_KEY/);
  assert.strictEqual((await request(noKey.port, { path: '/state' })).status, 200); // still up
});

test('refuses to start with a malformed encryption key', async () => {
  const port = await freePort();
  const started = start('src/server.js', { HOME: tmpHome(), VISIBILITY_PORT: String(port), VISIBILITY_ENCRYPTION_KEY: 'abc' }, 'Ctrl+C to stop');
  started.then(child => child.kill(), () => {});
  await assert.rejects(started, e => e.code === 1 && /64 hex/.test(e.out));
});

// ── cost tracking, analytics, alerts ──────────────────────────────────────────
test('tracks cost per agent and run, live and in analytics', async t => {
  const s = await startServer();
  t.after(s.stop);
  await post(s.port, '/alerts/config', { costBudgetUsd: 4, slowToolMs: 500, disabled: ['agent_stuck', 'not_a_type'] });
  await tool(s.port, 'set_goal', { goal: 'cost run', run_id: 'c1' });
  await tool(s.port, 'register_agent', { id: 'lead', label: 'Lead', role: 'orchestrator', model: 'claude-sonnet-4-6' });
  await tool(s.port, 'register_agent', { id: 'local', label: 'Local', role: 'worker', model: 'qwen3-coder' });
  await tool(s.port, 'log_generation', { agent: 'lead', prompt_tokens: 1e6, completion_tokens: 1e5, latency_ms: 900 }); // $3 + $1.5
  await tool(s.port, 'log_generation', { agent: 'local', prompt_tokens: 5000, completion_tokens: 500, latency_ms: 100 }); // unpriced
  await tool(s.port, 'log_tool_call', { agent: 'lead', tool_name: 'search', latency_ms: 2000 });
  await tool(s.port, 'log_tool_call', { agent: 'lead', tool_name: 'search', latency_ms: 3000, error: 'timeout' });
  await tool(s.port, 'log_tool_call', { agent: 'lead', tool_name: 'read', latency_ms: 20 });
  await tool(s.port, 'finish_run', {});

  const st = (await request(s.port, { path: '/state' })).json;
  assert.strictEqual(st.metrics.cost, 4.5);
  assert.strictEqual(st.agents.lead.cost, 4.5);
  assert.strictEqual(st.agents.local.cost, undefined);
  assert.strictEqual(st.internals.find(i => i.kind === 'generation' && i.agent === 'local').cost, null);
  assert.strictEqual(JSON.parse((await request(s.port, { path: '/runs/c1' })).json.summary).cost, 4.5);
  assert.strictEqual((await request(s.port, { path: '/runs/c1/state' })).json.metrics.cost, 4.5, 'replay recomputes cost');

  const cfg = (await request(s.port, { path: '/alerts/config' })).json;
  assert.deepStrictEqual(cfg.disabled, ['agent_stuck']);
  const fired = (await request(s.port, { path: '/alerts/history' })).json.map(a => a.type).sort();
  assert.deepStrictEqual(fired, ['cost_budget_exceeded', 'slow_tool_call'], 'each fires once per run');

  const a = (await request(s.port, { path: '/analytics' })).json;
  assert.strictEqual(a.totals.runs, 1);
  assert.strictEqual(a.totals.cost_usd, 4.5);
  assert.strictEqual(a.totals.unpriced_tokens, 5500);
  assert.strictEqual(a.agents[0].agent, 'lead');
  assert.strictEqual(a.models.find(m => m.model === 'qwen3-coder').cost_usd, 0);
  const search = a.tools.find(x => x.tool === 'search');
  assert.deepStrictEqual([search.calls, search.errors, search.error_rate, search.avg_latency_ms, search.p95_latency_ms], [2, 1, 0.5, 2500, 3000]);
  assert.deepStrictEqual([a.bottlenecks[0].kind, a.bottlenecks[0].name], ['tool', 'search']);
  assert.strictEqual(a.runs[0].cost_usd, 4.5);
});

test('analytics handles empty input and events without a model', () => {
  const empty = analyse([]);
  assert.deepStrictEqual([empty.totals.runs, empty.agents, empty.bottlenecks], [0, [], []]);
  const a = analyse([{ id: 'r', goal: '', status: 'done', started_at: 1, finished_at: 5, events: [
    { tool: 'log_event', args: { agent: 'x', event_type: 'error', message: 'm', tokens: 100 } },
    { tool: 'log_event', args: null },
  ] }]);
  assert.strictEqual(a.agents[0].errors, 1);
  assert.strictEqual(a.totals.unpriced_tokens, 100);
  assert.strictEqual(a.runs[0].duration_ms, 4);
});

// ── health, audit, login throttling ───────────────────────────────────────────
test('healthz is public; admin actions are audited; repeated bad logins are locked out', async t => {
  const s = await startServer({ VISIBILITY_PASSWORD: 'pw' });
  t.after(s.stop);
  const health = await request(s.port, { path: '/healthz' });
  assert.strictEqual(health.status, 200);
  assert.deepStrictEqual(Object.keys(health.json).sort(), ['ok', 'persistence', 'version']);
  assert.strictEqual((await request(s.port, { path: '/analytics' })).status, 401);

  const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const login = await request(s.port, { method: 'POST', path: '/auth/login', headers: form, body: 'password=pw' });
  assert.match(login.headers['set-cookie'][0], /Max-Age=43200/);
  const cookie = { Cookie: login.headers['set-cookie'][0].split(';')[0] };
  const key = (await post(s.port, '/keys', { label: 'k' }, cookie)).json;
  await request(s.port, { method: 'DELETE', path: '/runs/nope', headers: cookie });
  await request(s.port, { method: 'DELETE', path: `/keys/${key.id}`, headers: cookie });

  const bad = () => request(s.port, { method: 'POST', path: '/auth/login', headers: form, body: 'password=wrong' });
  await Promise.all(Array.from({ length: 10 }, bad));
  assert.strictEqual((await bad()).status, 429);
  // A correct password is refused too while locked out, so guessing cannot continue.
  assert.strictEqual((await request(s.port, { method: 'POST', path: '/auth/login', headers: form, body: 'password=pw' })).status, 429);

  const audit = (await request(s.port, { path: '/audit', headers: cookie })).json;
  const actions = audit.map(r => r.tool);
  for (const a of ['admin.login', 'admin.key_create', 'admin.run_delete', 'admin.key_delete', 'admin.login_failed']) {
    assert.ok(actions.includes(a), `audit log should record ${a}`);
  }
  assert.strictEqual(audit.find(r => r.tool === 'admin.key_create').detail, key.id);
});

// ── Node SDK ──────────────────────────────────────────────────────────────────
test('Node SDK sends events in order and times tools', async t => {
  const s = await startServer();
  t.after(s.stop);
  const vis = new Visibility({ url: `http://127.0.0.1:${s.port}` });
  vis.setGoal('sdk run', { runId: 'n1' });
  vis.registerAgent({ id: 'lead', role: 'orchestrator', model: 'claude-haiku-4-5', tokenBudget: 5000 });
  vis.logLlmTurn({ agent: 'lead', promptTokens: 1000, completionTokens: 200, latencyMs: 50, response: 'hi' });
  assert.strictEqual(await vis.traceTool('lead', 'add', async () => 1 + 1, { a: 1 }), 2);
  await assert.rejects(vis.traceTool('lead', 'fail', async () => { throw new Error('boom'); }), /boom/);
  vis.logEvent({ agent: 'lead', type: 'done', message: 'finished' });
  vis.finishRun();
  await vis.flush();

  const st = (await request(s.port, { path: '/state' })).json;
  assert.deepStrictEqual([st.goal, st.runId, st.status], ['sdk run', 'n1', 'done']);
  assert.strictEqual(st.registry.lead.token_budget, 5000);
  assert.strictEqual(st.metrics.cost, 0.002);
  const calls = st.internals.filter(i => i.kind === 'tool_call');
  assert.deepStrictEqual(calls.map(c => [c.tool_name, c.input, c.output, c.error]).reverse(),
    [['add', '{"a":1}', '2', null], ['fail', '', '', 'boom']]);
});

test('Node SDK goes quiet when the dashboard is down and never throws', async () => {
  const warn = console.warn; const warnings = [];
  console.warn = m => warnings.push(m);
  try {
    const vis = new Visibility({ url: `http://127.0.0.1:${await freePort()}` });
    for (let i = 0; i < 20; i++) vis.logEvent({ agent: 'a', message: 'x' });
    assert.strictEqual(await vis.finishRun(), null);
    assert.strictEqual(vis.disabled, true);
    assert.strictEqual(warnings.length, 1);
  } finally { console.warn = warn; }
});

// ── Workflow templates ────────────────────────────────────────────────────────
test('workflow validation rejects bad ids, unknown leads and loops', () => {
  const { validate, inReportingOrder } = require('../src/workflows');
  const ok = validate({ name: ' Team ', agents: [
    { id: 'dev', role: 'coder', reports_to: 'lead', token_budget: '5000', x: 10.4, y: 'x' },
    { id: 'lead', role: 'nonsense', label: '' },
  ] });
  assert.strictEqual(ok.name, 'Team');
  assert.deepStrictEqual(ok.agents[0], { id: 'dev', label: 'dev', role: 'coder', model: '', reports_to: 'lead', token_budget: 5000, x: 10, y: 0 });
  assert.strictEqual(ok.agents[1].role, 'worker');
  assert.deepStrictEqual(inReportingOrder(ok.agents).map(a => a.id), ['lead', 'dev']);
  const bad = (wf, re) => assert.throws(() => validate(wf), re);
  bad({ agents: [{ id: 'a' }] }, /needs a name/);
  bad({ name: 'n', agents: [] }, /at least one agent/);
  bad({ name: 'n', agents: [{ id: '<script>' }] }, /must be 1-40/);
  bad({ name: 'n', agents: [{ id: 'a' }, { id: 'a' }] }, /Duplicate/);
  bad({ name: 'n', agents: [{ id: 'a', reports_to: 'ghost' }] }, /unknown agent/);
  bad({ name: 'n', agents: [{ id: 'a', reports_to: 'b' }, { id: 'b', reports_to: 'a' }] }, /loop/);
  bad({ name: 'n', agents: Array.from({ length: 51 }, (_, i) => ({ id: 'a' + i })) }, /at most 50/);
});

test('workflows can be saved, updated, applied and deleted; the builder page is served', async t => {
  const s = await startServer();
  t.after(s.stop);
  const page = await request(s.port, { path: '/builder' });
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /Workflow Builder/);

  assert.strictEqual((await post(s.port, '/workflows', { name: 'x', agents: [{ id: 'a', reports_to: 'a' }] })).status, 400);
  const wf = { name: 'Review team', agents: [
    { id: 'dev', label: 'Developer', role: 'coder', model: 'claude-sonnet-5-5', reports_to: 'lead', token_budget: 9000 },
    { id: 'lead', label: 'Lead', role: 'orchestrator' },
  ] };
  const saved = (await post(s.port, '/workflows', wf)).json;
  assert.ok(saved.id);
  const again = (await post(s.port, '/workflows', { ...wf, id: saved.id, name: 'Renamed' })).json;
  assert.strictEqual(again.id, saved.id, 'saving with an id updates in place');
  const list = (await request(s.port, { path: '/workflows' })).json;
  assert.deepStrictEqual(list.map(w => [w.name, w.agents]), [['Renamed', 2]]);

  assert.deepStrictEqual((await post(s.port, `/workflows/${saved.id}/apply`)).json, { ok: true, registered: 2 });
  const reg = (await request(s.port, { path: '/state' })).json.registry;
  assert.deepStrictEqual([reg.dev.reports_to, reg.dev.model, reg.dev.token_budget, reg.lead.role], ['lead', 'claude-sonnet-5-5', 9000, 'orchestrator']);
  // Applied agents carry into the next run.
  await tool(s.port, 'set_goal', { goal: 'go', run_id: 'w1' });
  assert.match((await request(s.port, { path: '/runs/w1' })).json.agents_text, /lead/);

  await request(s.port, { method: 'DELETE', path: `/workflows/${saved.id}` });
  assert.strictEqual((await request(s.port, { path: `/workflows/${saved.id}` })).status, 404);
  assert.strictEqual((await post(s.port, `/workflows/${saved.id}/apply`)).status, 404);
});

test('the builder needs a login when the dashboard has a password', async t => {
  const s = await startServer({ VISIBILITY_PASSWORD: 'pw' });
  t.after(s.stop);
  const page = await request(s.port, { path: '/builder' });
  assert.deepStrictEqual([page.status, page.headers.location], [302, '/login']);
  assert.strictEqual((await request(s.port, { path: '/workflows' })).status, 401);
  assert.strictEqual((await request(s.port, { path: '/plugins' })).status, 401);
});

// ── Plugins ───────────────────────────────────────────────────────────────────
test('plugins receive run, event and alert hooks; a broken plugin cannot stop the server', async t => {
  const home = tmpHome();
  const dir = path.join(home, '.agentscope', 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(home, 'calls.jsonl');
  fs.writeFileSync(path.join(dir, 'recorder.js'), `
    const fs = require('fs');
    const rec = (hook, p) => fs.appendFileSync(${JSON.stringify(out)}, JSON.stringify([hook, p.alert || p.tool || p.status || p.goal]) + '\\n');
    module.exports = { name: 'recorder',
      onRunStart: p => rec('onRunStart', p), onEvent: p => rec('onEvent', p),
      onRunFinish: p => rec('onRunFinish', p), onAlert: p => rec('onAlert', p) };`);
  fs.writeFileSync(path.join(dir, 'broken.js'), `module.exports = { onEvent() { throw new Error('plugin bug'); }, onRunFinish: async () => { throw new Error('async bug'); } };`);
  fs.writeFileSync(path.join(dir, 'syntax.js'), `this is not javascript`);
  fs.writeFileSync(path.join(dir, 'nohooks.js'), `module.exports = { name: 'nothing' };`);
  fs.writeFileSync(path.join(dir, 'notes.txt'), `ignored`);

  const s = await startServer({}, home);
  t.after(s.stop);
  assert.deepStrictEqual((await request(s.port, { path: '/plugins' })).json.map(p => p.name), ['broken', 'recorder']);

  await post(s.port, '/alerts/config', { slowToolMs: 100 });
  await tool(s.port, 'set_goal', { goal: 'plugin run', run_id: 'p1' });
  await tool(s.port, 'log_tool_call', { agent: 'a', tool_name: 'slow', latency_ms: 500 });
  await tool(s.port, 'finish_run', { status: 'error' });
  await request(s.port, { path: '/runs/p1/state' }); // replay must not re-notify plugins

  const calls = fs.readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepStrictEqual(calls, [
    ['onEvent', 'set_goal'], ['onRunStart', 'plugin run'],
    ['onAlert', 'slow_tool_call'], ['onEvent', 'log_tool_call'],
    ['onEvent', 'finish_run'], ['onRunFinish', 'error'],
  ]);
  assert.strictEqual((await request(s.port, { path: '/healthz' })).status, 200);
});

test('VISIBILITY_PLUGINS loads extra plugins by path, and "off" loads none', async t => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.agentscope', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agentscope', 'plugins', 'a.js'), `module.exports = { onEvent() {} };`);
  const example = path.join(__dirname, '..', 'examples', 'plugins', 'slow-llm-warning.js');
  const on = await startServer({ VISIBILITY_PLUGINS: example }, home);
  assert.deepStrictEqual((await request(on.port, { path: '/plugins' })).json.map(p => p.name), ['a', 'slow-llm-warning']);
  on.stop();
  const off = await startServer({ VISIBILITY_PLUGINS: 'off' }, home);
  t.after(off.stop);
  assert.deepStrictEqual((await request(off.port, { path: '/plugins' })).json, []);
});

// ── Pages and replay ──────────────────────────────────────────────────────────
test('pages are served with the shared theme and icons inlined', async t => {
  const s = await startServer({ VISIBILITY_PASSWORD: 'pw' });
  t.after(s.stop);
  const login = await request(s.port, { path: '/login' });
  for (const marker of ['--role-orchestrator', 'id="i-logo"', 'Sign in']) assert.ok(login.body.includes(marker), `login page should contain ${marker}`);
  assert.ok(!login.body.includes('__THEME__') && !login.body.includes('__ICONS__') && !login.body.includes('__ERR__'));
  const bad = await request(s.port, { method: 'POST', path: '/auth/login', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=no' });
  assert.match(bad.body, /Incorrect password/);
  assert.ok(!/fonts\.googleapis/.test(login.body), 'pages must not load anything from other sites');
});

test('replay shows events at the time they happened, not the time of the replay', async t => {
  const s = await startServer();
  t.after(s.stop);
  await tool(s.port, 'set_goal', { goal: 'timed', run_id: 't1' });
  await tool(s.port, 'log_event', { agent: 'a', event_type: 'start', message: 'm' });
  await tool(s.port, 'finish_run', {});
  const live = (await request(s.port, { path: '/state' })).json;
  await new Promise(r => setTimeout(r, 300));
  const replay = (await request(s.port, { path: '/runs/t1/state' })).json;
  assert.ok(Math.abs(replay.startedAt - live.startedAt) < 100);
  assert.ok(Math.abs(replay.events[0].ts - live.events[0].ts) < 100);
  // The server's own clock is untouched afterwards.
  await tool(s.port, 'set_goal', { goal: 'next', run_id: 't2' });
  assert.ok((await request(s.port, { path: '/state' })).json.startedAt > live.startedAt + 250);
});
