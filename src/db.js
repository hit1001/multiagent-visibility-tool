'use strict';
const path = require('path');
const os   = require('os');
const fs   = require('fs');

const security = require('./security');

let db = null;
let encKey = null; // Buffer when VISIBILITY_ENCRYPTION_KEY is set

// Where runs.db, alerts.json and pricing.json live. Override for containers and tests.
function dataDir() {
  return process.env.VISIBILITY_DATA_DIR || path.join(os.homedir(), '.agentscope');
}

function init({ key = null } = {}) {
  encKey = key;
  const Database = require('better-sqlite3');
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  db = new Database(path.join(dir, 'runs.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id          TEXT PRIMARY KEY,
      goal        TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'running',
      started_at  INTEGER NOT NULL,
      finished_at INTEGER,
      summary     TEXT,
      agents_text TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS run_events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id  TEXT NOT NULL REFERENCES runs(id),
      seq     INTEGER NOT NULL,
      tool    TEXT NOT NULL,
      args    TEXT NOT NULL,
      ts      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_run_events ON run_events(run_id, seq);
    CREATE TABLE IF NOT EXISTS api_keys (
      id           TEXT PRIMARY KEY,
      label        TEXT DEFAULT '',
      key_hash     TEXT NOT NULL,
      rate_limit   INTEGER DEFAULT 60,
      created_at   INTEGER NOT NULL,
      last_used    INTEGER
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      key_id  TEXT,
      tool    TEXT NOT NULL,
      run_id  TEXT,
      ts      INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS alert_history (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      type     TEXT NOT NULL,
      detail   TEXT,
      run_id   TEXT,
      fired_at INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE TABLE IF NOT EXISTS workflows (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    definition TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  // Older databases predate the audit detail column.
  if (!db.prepare('PRAGMA table_info(audit_log)').all().some(c => c.name === 'detail')) {
    db.exec('ALTER TABLE audit_log ADD COLUMN detail TEXT');
  }
  // Clean up runs left in 'running' state with no events — orphaned by server crash or repeated clicks
  db.exec(`DELETE FROM runs WHERE status='running' AND id NOT IN (SELECT DISTINCT run_id FROM run_events)`);
}

function startRun(runId, goal, startedAt) {
  if (!db) return;
  db.prepare('INSERT OR REPLACE INTO runs (id, goal, status, started_at) VALUES (?,?,?,?)')
    .run(runId, goal || '', 'running', startedAt);
}

function finishRun(runId, status, finishedAt, summary) {
  if (!db) return;
  db.prepare('UPDATE runs SET status=?, finished_at=?, summary=? WHERE id=?')
    .run(status, finishedAt, JSON.stringify(summary), runId);
}

function appendRunAgent(runId, agentId) {
  if (!db) return;
  const row = db.prepare('SELECT agents_text FROM runs WHERE id=?').get(runId);
  if (!row) return;
  const cur = row.agents_text || '';
  if (cur.split(' ').includes(agentId)) return;
  db.prepare('UPDATE runs SET agents_text=? WHERE id=?').run((cur ? cur + ' ' : '') + agentId, runId);
}

function persistEvent(runId, seq, tool, args, ts) {
  if (!db || !runId) return;
  db.prepare('INSERT INTO run_events (run_id, seq, tool, args, ts) VALUES (?,?,?,?,?)')
    .run(runId, seq, tool, encKey ? security.encrypt(encKey, JSON.stringify(args)) : JSON.stringify(args), ts);
}

function listRuns({ q = '', limit = 50, offset = 0 } = {}) {
  if (!db) return [];
  const qLike = '%' + q + '%';
  const sql = q
    ? `SELECT r.id,r.goal,r.status,r.started_at,r.finished_at,r.summary,r.agents_text,
              COUNT(e.id) as event_count
         FROM runs r LEFT JOIN run_events e ON e.run_id=r.id
        WHERE r.goal LIKE ? OR r.agents_text LIKE ?
        GROUP BY r.id ORDER BY r.started_at DESC LIMIT ? OFFSET ?`
    : `SELECT r.id,r.goal,r.status,r.started_at,r.finished_at,r.summary,r.agents_text,
              COUNT(e.id) as event_count
         FROM runs r LEFT JOIN run_events e ON e.run_id=r.id
        GROUP BY r.id ORDER BY r.started_at DESC LIMIT ? OFFSET ?`;
  const params = q ? [qLike, qLike, limit, offset] : [limit, offset];
  return db.prepare(sql).all(...params);
}

function getRun(runId) {
  if (!db) return null;
  return db.prepare(
    `SELECT r.*, COUNT(e.id) as event_count
       FROM runs r LEFT JOIN run_events e ON e.run_id=r.id
      WHERE r.id=? GROUP BY r.id`
  ).get(runId) || null;
}

function getRunEvents(runId) {
  if (!db) return [];
  const rows = db.prepare('SELECT seq, tool, args, ts FROM run_events WHERE run_id=? ORDER BY seq ASC').all(runId);
  for (const r of rows) r.args = security.decrypt(encKey, r.args); // throws if encrypted and the key is missing or wrong
  return rows;
}

// Recent runs with their parsed events, for analytics.
function getRunsWithEvents({ since = 0, limit = 50 } = {}) {
  if (!db) return [];
  const runs = db.prepare('SELECT id,goal,status,started_at,finished_at FROM runs WHERE started_at > ? ORDER BY started_at DESC LIMIT ?').all(since, limit);
  for (const run of runs) {
    run.events = getRunEvents(run.id).map(e => {
      try { return { tool: e.tool, args: JSON.parse(e.args), ts: e.ts }; } catch { return { tool: e.tool, args: null, ts: e.ts }; }
    });
  }
  return runs;
}

function deleteRun(runId) {
  if (!db) return;
  db.prepare('DELETE FROM run_events WHERE run_id=?').run(runId);
  db.prepare('DELETE FROM runs WHERE id=?').run(runId);
}

function exportRuns({ since = 0, status = null, limit = 100 } = {}) {
  if (!db) return [];
  const cond = status ? 'WHERE r.started_at > ? AND r.status = ?' : 'WHERE r.started_at > ?';
  const params = status ? [since, status, limit] : [since, limit];
  return db.prepare(
    `SELECT r.id,r.goal,r.status,r.started_at,r.finished_at,r.summary,r.agents_text,
            COUNT(e.id) as event_count
       FROM runs r LEFT JOIN run_events e ON e.run_id=r.id
      ${cond} GROUP BY r.id ORDER BY r.started_at DESC LIMIT ?`
  ).all(...params);
}

// ── API keys ──────────────────────────────────────────────────────────────────
function createApiKey(id, label, keyHash, rateLimit) {
  if (!db) return;
  db.prepare('INSERT INTO api_keys (id,label,key_hash,rate_limit,created_at) VALUES (?,?,?,?,?)')
    .run(id, label, keyHash, rateLimit, Date.now());
}

function listApiKeys() {
  if (!db) return [];
  return db.prepare('SELECT id,label,rate_limit,created_at,last_used FROM api_keys ORDER BY created_at DESC').all();
}

function getApiKeyByHash(hash) {
  if (!db) return null;
  return db.prepare('SELECT * FROM api_keys WHERE key_hash=?').get(hash) || null;
}

function touchApiKey(id) {
  if (!db) return;
  db.prepare('UPDATE api_keys SET last_used=? WHERE id=?').run(Date.now(), id);
}

function deleteApiKey(id) {
  if (!db) return;
  db.prepare('DELETE FROM api_keys WHERE id=?').run(id);
}

// ── Workflow templates ────────────────────────────────────────────────────────
function saveWorkflow(id, name, definition) {
  db.prepare('INSERT INTO workflows (id,name,definition,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, definition=excluded.definition, updated_at=excluded.updated_at')
    .run(id, name, JSON.stringify(definition), Date.now());
}
function listWorkflows() {
  if (!db) return [];
  return db.prepare('SELECT id,name,definition,updated_at FROM workflows ORDER BY updated_at DESC').all()
    .map(w => ({ id: w.id, name: w.name, updated_at: w.updated_at, agents: JSON.parse(w.definition).agents.length }));
}
function getWorkflow(id) {
  if (!db) return null;
  const w = db.prepare('SELECT * FROM workflows WHERE id=?').get(id);
  return w ? { id: w.id, updated_at: w.updated_at, ...JSON.parse(w.definition) } : null;
}
function deleteWorkflow(id) {
  if (!db) return;
  db.prepare('DELETE FROM workflows WHERE id=?').run(id);
}

// ── Audit log ─────────────────────────────────────────────────────────────────
function appendAudit(keyId, tool, runId, detail) {
  if (!db) return;
  db.prepare('INSERT INTO audit_log (key_id,tool,run_id,ts,detail) VALUES (?,?,?,?,?)').run(keyId || null, tool, runId || null, Date.now(), detail || null);
}

function listAudit({ keyId = null, limit = 100, since = 0 } = {}) {
  if (!db) return [];
  if (keyId) {
    return db.prepare('SELECT * FROM audit_log WHERE key_id=? AND ts>? ORDER BY ts DESC LIMIT ?').all(keyId, since, limit);
  }
  return db.prepare('SELECT * FROM audit_log WHERE ts>? ORDER BY ts DESC LIMIT ?').all(since, limit);
}

// ── Alert history ─────────────────────────────────────────────────────────────
function appendAlert(type, detail, runId) {
  if (!db) return;
  db.prepare('INSERT INTO alert_history (type,detail,run_id,fired_at) VALUES (?,?,?,?)').run(type, detail || null, runId || null, Date.now());
}

function listAlerts({ limit = 50 } = {}) {
  if (!db) return [];
  return db.prepare('SELECT * FROM alert_history ORDER BY fired_at DESC LIMIT ?').all(limit);
}

// ── Metrics aggregation ───────────────────────────────────────────────────────
function getMetrics() {
  if (!db) return null;
  const runs = db.prepare(`SELECT status, started_at, finished_at, summary FROM runs WHERE status IN ('done','error')`).all();
  if (!runs.length) return { runs_total: 0 };

  const durations = runs.filter(r => r.finished_at).map(r => r.finished_at - r.started_at).sort((a,b) => a-b);
  const success   = runs.filter(r => r.status === 'done').length;
  const totalTok  = runs.reduce((s, r) => { try { return s + (JSON.parse(r.summary || '{}').tokens || 0); } catch { return s; } }, 0);
  const p = (arr, pct) => arr.length ? arr[Math.floor(arr.length * pct / 100)] : 0;

  return {
    runs_total:       runs.length,
    success_rate:     +(success / runs.length).toFixed(3),
    avg_duration_ms:  durations.length ? Math.round(durations.reduce((a,b)=>a+b,0)/durations.length) : 0,
    p50_duration_ms:  p(durations, 50),
    p95_duration_ms:  p(durations, 95),
    total_tokens:     totalTok,
    avg_tokens_per_run: runs.length ? Math.round(totalTok / runs.length) : 0,
  };
}

function getLastRunDurations(limit = 10) {
  if (!db) return [];
  return db.prepare(`SELECT finished_at - started_at as dur FROM runs WHERE status='done' AND finished_at IS NOT NULL ORDER BY started_at DESC LIMIT ?`).all(limit).map(r => r.dur);
}

module.exports = {
  init, dataDir, getRunsWithEvents, saveWorkflow, listWorkflows, getWorkflow, deleteWorkflow, startRun, finishRun, appendRunAgent, persistEvent,
  listRuns, getRun, getRunEvents, deleteRun, exportRuns,
  createApiKey, listApiKeys, getApiKeyByHash, touchApiKey, deleteApiKey,
  appendAudit, listAudit,
  appendAlert, listAlerts,
  getMetrics, getLastRunDurations,
};
