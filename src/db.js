'use strict';
const path = require('path');
const os   = require('os');
const fs   = require('fs');

let db = null;

function init() {
  const Database = require('better-sqlite3');
  const dir = path.join(os.homedir(), '.agentscope');
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
  `);
  // Clean up runs left in 'running' state with no events — orphaned by server crash or repeated clicks
  db.exec(`DELETE FROM runs WHERE status='running' AND id NOT IN (SELECT DISTINCT run_id FROM run_events)`);
}

function startRun(runId, goal, startedAt) {
  if (!db) return;
  db.prepare('INSERT OR REPLACE INTO runs (id, goal, status, started_at) VALUES (?,?,?,?)')
    .run(runId, goal || '', 'running', startedAt);
}

function updateRunGoal(runId, goal) {
  if (!db) return;
  db.prepare('UPDATE runs SET goal=? WHERE id=?').run(goal, runId);
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
    .run(runId, seq, tool, JSON.stringify(args), ts);
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
  return db.prepare('SELECT seq, tool, args, ts FROM run_events WHERE run_id=? ORDER BY seq ASC').all(runId);
}

function deleteRun(runId) {
  if (!db) return;
  db.prepare('DELETE FROM run_events WHERE run_id=?').run(runId);
  db.prepare('DELETE FROM runs WHERE id=?').run(runId);
}

module.exports = { init, startRun, updateRunGoal, finishRun, appendRunAgent, persistEvent, listRuns, getRun, getRunEvents, deleteRun };
