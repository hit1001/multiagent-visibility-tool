'use strict';
const test   = require('node:test');
const assert = require('node:assert');
const http   = require('http');
const { freePort, tmpHome, start, startServer, request } = require('./helpers');

test('default (loopback, no password)', async t => {
  const s = await startServer();
  t.after(s.stop);
  const host = `127.0.0.1:${s.port}`;

  await t.test('serves same-origin requests without CORS headers', async () => {
    const r = await request(s.port, { path: '/state' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['access-control-allow-origin'], undefined);
  });

  await t.test('rejects DNS-rebound Host headers', async () => {
    const r = await request(s.port, { path: '/state', headers: { Host: `evil.example:${s.port}` } });
    assert.strictEqual(r.status, 421);
  });

  await t.test('rejects cross-origin writes', async () => {
    const r = await request(s.port, { method: 'POST', path: '/reset', headers: { Origin: 'https://evil.example' } });
    assert.strictEqual(r.status, 403);
    const del = await request(s.port, { method: 'DELETE', path: '/runs/x', headers: { Origin: 'https://evil.example' } });
    assert.strictEqual(del.status, 403);
  });

  await t.test('accepts same-origin writes from the dashboard', async () => {
    const r = await request(s.port, { method: 'POST', path: '/reset', headers: { Origin: `http://${host}` } });
    assert.strictEqual(r.status, 200);
  });

  await t.test('accepts tool calls from non-browser clients', async () => {
    const r = await request(s.port, { method: 'POST', path: '/tool', headers: { 'Content-Type': 'application/json' },
      body: { tool: 'set_goal', args: { goal: 'test' } } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await request(s.port, { path: '/state' })).json.goal, 'test');
  });

  await t.test('does not accept forged licence keys', async () => {
    const lic = await request(s.port, { path: '/licence/status' });
    assert.strictEqual(lic.json.valid, false);
    assert.strictEqual((await request(s.port, { path: '/api/v1/metrics' })).status, 402);
  });
});

test('refuses to listen beyond loopback without a password', async () => {
  const port = await freePort();
  const started = start('src/server.js', { HOME: tmpHome(), VISIBILITY_PORT: String(port), VISIBILITY_HOST: '0.0.0.0' }, 'Ctrl+C to stop');
  started.then(child => child.kill(), () => {}); // never leave a server running if this regresses
  await assert.rejects(started, e => e.code === 1 && /Refusing to listen/.test(e.out));
});

test('rejects licence keys forged with the old public HMAC secret', async t => {
  const hmac8 = require('crypto').createHmac('sha256', 'mavt-licence-v1').update('TEAM209912').digest('hex').slice(0, 8);
  const s = await startServer({ VISIBILITY_LICENCE: `MAVT-TEAM-209912-${hmac8}` });
  t.after(s.stop);
  assert.strictEqual((await request(s.port, { path: '/licence/status' })).json.valid, false);
});

test('password protection', async t => {
  const s = await startServer({ VISIBILITY_PASSWORD: 'hunter2', VISIBILITY_INTERNAL_TOKEN: 'internal-secret' });
  t.after(s.stop);
  const form = { 'Content-Type': 'application/x-www-form-urlencoded' };

  await t.test('blocks unauthenticated requests', async () => {
    assert.strictEqual((await request(s.port, { path: '/state' })).status, 401);
  });

  await t.test('rejects a wrong password', async () => {
    const r = await request(s.port, { method: 'POST', path: '/auth/login', headers: form, body: 'password=wrong' });
    assert.strictEqual(r.headers['set-cookie'], undefined);
  });

  await t.test('issues a SameSite=Strict session cookie for the right password', async () => {
    const r = await request(s.port, { method: 'POST', path: '/auth/login', headers: form, body: 'password=hunter2' });
    assert.strictEqual(r.status, 302);
    const cookie = r.headers['set-cookie'][0];
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const ok = await request(s.port, { path: '/state', headers: { Cookie: cookie.split(';')[0] } });
    assert.strictEqual(ok.status, 200);
  });

  await t.test('accepts the internal bridge token only when it matches', async () => {
    assert.strictEqual((await request(s.port, { path: '/state', headers: { 'X-Internal-Token': 'internal-secret' } })).status, 200);
    assert.strictEqual((await request(s.port, { path: '/state', headers: { 'X-Internal-Token': 'nope' } })).status, 401);
  });

  await t.test('accepts API keys created through the dashboard', async () => {
    const login = await request(s.port, { method: 'POST', path: '/auth/login', headers: form, body: 'password=hunter2' });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const created = await request(s.port, { method: 'POST', path: '/keys', headers: { Cookie: cookie }, body: { label: 'ci' } });
    const r = await request(s.port, { path: '/state', headers: { 'X-API-Key': created.json.key } });
    assert.strictEqual(r.status, 200);
  });
});

test('MCP bridge forwards to a password-protected dashboard and only serves local clients', async t => {
  const token = 'bridge-token';
  const s = await startServer({ VISIBILITY_PASSWORD: 'pw', VISIBILITY_INTERNAL_TOKEN: token });
  t.after(s.stop);
  const mcpPort = await freePort();
  const bridge = await start('agentscope/agentscope.js',
    { VISIBILITY_PORT: String(s.port), VISIBILITY_MCP_PORT: String(mcpPort), VISIBILITY_INTERNAL_TOKEN: token }, 'Add to your agent config');
  t.after(() => bridge.kill());

  assert.strictEqual((await request(mcpPort, { path: '/health', headers: { Host: 'evil.example' } })).status, 403);
  assert.strictEqual((await request(mcpPort, { path: '/health', headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.strictEqual((await request(mcpPort, { path: '/health' })).status, 200);

  // Open an SSE session, call set_goal, and read the JSON-RPC result off the stream.
  const result = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: mcpPort, path: '/sse' }, res => {
      let buf = '';
      res.on('data', async chunk => {
        buf += chunk;
        const ep = buf.match(/event: endpoint\ndata: (\S+)/);
        if (ep && !res.sent) {
          res.sent = true;
          await request(mcpPort, { method: 'POST', path: ep[1], headers: { 'Content-Type': 'application/json' },
            body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'set_goal', arguments: { goal: 'via bridge' } } } });
        }
        const msg = buf.split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6))).find(m => m.id === 1);
        if (msg) { res.destroy(); resolve(msg.result); }
      });
    }).on('error', reject);
  });
  assert.strictEqual(result.isError, false);
  const state = await request(s.port, { path: '/state', headers: { 'X-Internal-Token': token } });
  assert.strictEqual(state.json.goal, 'via bridge');
});
