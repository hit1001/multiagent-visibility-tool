'use strict';
const test   = require('node:test');
const assert = require('node:assert');
const { tmpHome } = require('./helpers');

process.env.HOME = tmpHome(); // db.js stores runs under ~/.agentscope
const db = require('../src/db');
db.init();

test('records a run with agents and events', () => {
  db.startRun('r1', 'goal', 1000);
  db.startRun('r1', 'updated goal', 1000);
  db.appendRunAgent('r1', 'a');
  db.appendRunAgent('r1', 'b');
  db.appendRunAgent('r1', 'a'); // duplicates ignored
  db.persistEvent('r1', 1, 'log_event', { x: 1 }, 1001);
  db.finishRun('r1', 'done', 2000, { tokens: 5 });

  const run = db.getRun('r1');
  assert.strictEqual(run.goal, 'updated goal');
  assert.strictEqual(run.agents_text, 'a b');
  assert.strictEqual(run.event_count, 1);
  assert.deepStrictEqual(db.getRunEvents('r1'), [{ seq: 1, tool: 'log_event', args: '{"x":1}', ts: 1001 }]);
  assert.strictEqual(db.listRuns({ q: 'updated' }).length, 1);
  assert.strictEqual(db.exportRuns({ status: 'done' }).length, 1);
});

test('computes metrics from finished runs', () => {
  const m = db.getMetrics();
  assert.strictEqual(m.runs_total, 1);
  assert.strictEqual(m.total_tokens, 5);
  assert.deepStrictEqual(db.getLastRunDurations(), [1000]);
});

test('manages API keys, audit log and alerts', () => {
  db.createApiKey('k1', 'ci', 'hash1', 60);
  assert.strictEqual(db.getApiKeyByHash('hash1').id, 'k1');
  db.appendAudit('k1', 'log_event', 'r1');
  assert.strictEqual(db.listAudit({ keyId: 'k1' }).length, 1);
  db.deleteApiKey('k1');
  assert.strictEqual(db.getApiKeyByHash('hash1'), null);
  db.appendAlert('stuck_agent', 'detail', 'r1');
  assert.strictEqual(db.listAlerts().length, 1);
});

test('deletes a run and its events', () => {
  db.deleteRun('r1');
  assert.strictEqual(db.getRun('r1'), null);
  assert.strictEqual(db.getRunEvents('r1').length, 0);
});
