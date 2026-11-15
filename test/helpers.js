'use strict';
const { spawn } = require('child_process');
const fs   = require('fs');
const net  = require('net');
const os   = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address(); s.close(() => resolve(port));
    }).on('error', reject);
  });
}

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-test-')); }

// Start a script and resolve once it prints `readyText`; rejects if it exits first.
function start(script, env, readyText) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, script)], {
      env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = d => { out += d; if (out.includes(readyText)) resolve(child); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', code => reject(Object.assign(new Error(`exited ${code}: ${out}`), { code, out })));
  });
}

async function startServer(env = {}) {
  const port = await freePort();
  const home = tmpHome();
  const child = await start('src/server.js', { HOME: home, VISIBILITY_PORT: String(port), ...env }, 'Ctrl+C to stop');
  return { port, home, child, stop: () => child.kill() };
}

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let json = null; try { json = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

module.exports = { freePort, tmpHome, start, startServer, request };
