#!/usr/bin/env node
/**
 * visibility — agent-visibility CLI
 *
 * Usage:
 *   visibility                  dashboard on :4242, opens browser
 *   visibility --mcp            dashboard + MCP bridge on :4243
 *   visibility --port 5000      custom dashboard port
 *   visibility --mcp-port 5001  custom MCP port
 *   visibility --no-open        don't auto-open browser
 *   visibility --help
 */
'use strict';
const path = require('path');
const { execSync, spawn } = require('child_process');

const argv  = process.argv.slice(2);
const flags = { mcp:false, noOpen:false, help:false, port:4242, mcpPort:4243 };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--mcp')                      flags.mcp     = true;
  if (argv[i] === '--no-open')                  flags.noOpen  = true;
  if (argv[i] === '--help' || argv[i] === '-h') flags.help    = true;
  if (argv[i] === '--port'     && argv[i+1])    flags.port    = parseInt(argv[++i]);
  if (argv[i] === '--mcp-port' && argv[i+1])    flags.mcpPort = parseInt(argv[++i]);
}

if (flags.help) {
  console.log(`
  agent-visibility

  Commands:
    visibility                  dashboard on :4242, opens browser
    visibility --mcp            dashboard + MCP bridge on :4243
    visibility --port 5000      custom dashboard port
    visibility --mcp-port 5001  custom MCP port
    visibility --no-open        suppress auto browser open
    visibility --help

  MCP config (after running with --mcp):
    { "mcpServers": { "agentscope": { "url": "http://localhost:4243/sse" } } }
  `);
  process.exit(0);
}

const env = { ...process.env, VISIBILITY_PORT: String(flags.port), VISIBILITY_MCP_PORT: String(flags.mcpPort) };
const children = [];

function spawn_(script) {
  const child = spawn(process.execPath, [script], { stdio:'inherit', env });
  children.push(child);
  child.on('exit', code => { if (code) process.exit(code); });
}

function shutdown() { children.forEach(c => { try { c.kill('SIGTERM'); } catch (_) {} }); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

spawn_(path.join(__dirname, '..', 'src', 'server.js'));

if (flags.mcp) {
  setTimeout(() => spawn_(path.join(__dirname, '..', 'agentscope', 'agentscope.js')), 400);
}

if (!flags.noOpen) {
  setTimeout(() => {
    const url = `http://localhost:${flags.port}`;
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    try { execSync(cmd, { stdio:'ignore' }); } catch (_) {}
  }, 900);
}
