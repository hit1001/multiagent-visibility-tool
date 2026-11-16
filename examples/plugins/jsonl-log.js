'use strict';
// Example plugin: append one line per finished run to a JSON Lines file.
// Install: copy this file to ~/.agentscope/plugins/ and restart the dashboard.
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const FILE = process.env.MAVT_RUN_LOG || path.join(os.homedir(), '.agentscope', 'runs.jsonl');

module.exports = {
  name: 'jsonl-log',
  onRunFinish({ runId, goal, status, metrics, durationMs }) {
    const line = { runId, goal, status, durationMs, ...metrics, finishedAt: new Date().toISOString() };
    fs.appendFileSync(FILE, JSON.stringify(line) + '\n');
  },
};
