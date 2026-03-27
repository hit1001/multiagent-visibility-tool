#!/usr/bin/env node
/**
 * agentscope — MCP bridge for agent-visibility
 *
 * Agents connect here via MCP (SSE transport). Tool calls are forwarded to
 * the dashboard server at DASHBOARD_URL.
 *
 * Usage:
 *   node agentscope/agentscope.js
 *
 * MCP config for your agent:
 *   { "mcpServers": { "agentscope": { "url": "http://localhost:4243/sse" } } }
 */
'use strict';
const http = require('http');

const MCP_PORT     = parseInt(process.env.VISIBILITY_MCP_PORT || '4243');
const DASHBOARD    = `http://localhost:${process.env.VISIBILITY_PORT || '4242'}`;

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [
  { name: 'register_agent', description: 'Register an agent with the visibility dashboard.', inputSchema: { type:'object', required:['id','label','role'], properties: { id:{type:'string'}, label:{type:'string'}, role:{type:'string',enum:['orchestrator','worker','researcher','coder','critic','synthesiser']}, model:{type:'string'}, reports_to:{type:'string'}, token_budget:{type:'number'}, color:{type:'string'} } } },
  { name: 'log_event',      description: 'Log an agent event to the dashboard.',              inputSchema: { type:'object', required:['agent','event_type','message'], properties: { agent:{type:'string'}, event_type:{type:'string',enum:['start','plan','route','reply','tool','result','pass','fail','retry','warn','error','done']}, message:{type:'string'}, tokens:{type:'number'}, latency_ms:{type:'number'}, metadata:{type:'object'} } } },
  { name: 'log_llm_turn',   description: 'Log a full LLM conversation turn (messages in + response out + optional thinking). Use this to expose the exact context sent to and received from the model.',
    inputSchema: { type:'object', required:['agent'], properties: { agent:{type:'string'}, model:{type:'string'}, prompt_tokens:{type:'number'}, completion_tokens:{type:'number'}, latency_ms:{type:'number'}, stop_reason:{type:'string'}, messages:{type:'array',items:{type:'object',properties:{role:{type:'string'},content:{type:'string'}}}}, response:{type:'string'}, thinking:{type:'string'} } } },
  { name: 'trace_step',     description: 'Draw an arrow between two agents on the canvas.',  inputSchema: { type:'object', required:['from_agent','to_agent'], properties: { from_agent:{type:'string'}, to_agent:{type:'string'}, label:{type:'string'}, arrow_type:{type:'string',enum:['msg','result','retry','tool']} } } },
  { name: 'set_memory',     description: 'Write a value to the shared memory panel.',        inputSchema: { type:'object', required:['key','value'], properties: { key:{type:'string'}, value:{type:'string'}, op:{type:'string',enum:['write','read']} } } },
  { name: 'set_agent_state',description: 'Update an agent status on the dashboard.',         inputSchema: { type:'object', required:['agent_id','status'], properties: { agent_id:{type:'string'}, status:{type:'string',enum:['idle','running','active','done','error']} } } },
  { name: 'set_goal',       description: 'Set the run goal and mark the run as started.',    inputSchema: { type:'object', required:['goal'], properties: { goal:{type:'string'}, run_id:{type:'string'} } } },
  { name: 'set_plan',       description: 'Publish the task plan to the Plan tab.',           inputSchema: { type:'object', required:['tasks'], properties: { tasks:{type:'array'} } } },
  { name: 'finish_run',     description: 'Mark the current run as complete.',                inputSchema: { type:'object', properties: { status:{type:'string',enum:['done','error']} } } },
];

// ── Forward tool call to dashboard ────────────────────────────────────────────
function forward(tool, args) {
  return new Promise(resolve => {
    const body = JSON.stringify({ tool, args });
    const req = http.request(DASHBOARD + '/tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (_) { resolve({ ok: true }); } });
    });
    req.on('error', err => resolve({ ok: false, error: `Dashboard unreachable: ${err.message}` }));
    req.write(body); req.end();
  });
}

// ── MCP message handling ──────────────────────────────────────────────────────
async function handleMsg(msg, send) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc:'2.0', id, result: { protocolVersion:'2024-11-05', capabilities:{ tools:{} }, serverInfo:{ name:'agentscope', version:'1.0.0' } } });
  } else if (method === 'tools/list') {
    send({ jsonrpc:'2.0', id, result: { tools: TOOLS } });
  } else if (method === 'tools/call') {
    const { name, arguments: args } = params || {};
    const found = TOOLS.find(t => t.name === name);
    if (!found) { send({ jsonrpc:'2.0', id, error:{ code:-32601, message:`Unknown tool: ${name}` } }); return; }
    const result = await forward(name, args || {});
    send({ jsonrpc:'2.0', id, result:{ content:[{ type:'text', text:JSON.stringify(result) }], isError: result.ok === false } });
  } else if (method === 'notifications/initialized') {
    // no response
  } else if (id !== undefined) {
    send({ jsonrpc:'2.0', id, error:{ code:-32601, message:`Method not found: ${method}` } });
  }
}

// ── HTTP server (SSE transport) ────────────────────────────────────────────────
const sessions = new Map();
const CORS = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'GET, POST, OPTIONS', 'Access-Control-Allow-Headers':'Content-Type, Accept' };
function readBody(req, cb) { let d=''; req.on('data', c=>d+=c); req.on('end', ()=>cb(d)); }

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  if (req.method === 'GET' && req.url === '/sse') {
    const sid = `s_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    res.writeHead(200, { ...CORS, 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', 'Connection':'keep-alive' });
    const send = obj => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) {} };
    res.write(`event: endpoint\ndata: /message?sessionId=${sid}\n\n`);
    sessions.set(sid, { send });
    req.on('close', () => sessions.delete(sid));
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/message')) {
    const sid = new URL(req.url, 'http://localhost').searchParams.get('sessionId');
    const session = sessions.get(sid);
    if (!session) { res.writeHead(404, { ...CORS, 'Content-Type':'application/json' }); res.end(JSON.stringify({ error:'Session not found' })); return; }
    readBody(req, async data => {
      let msg;
      try { msg = JSON.parse(data); } catch (_) { res.writeHead(400, { ...CORS }); res.end('{}'); return; }
      res.writeHead(202, { ...CORS, 'Content-Type':'application/json' }); res.end('{"ok":true}');
      await handleMsg(msg, session.send);
    });
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { ...CORS, 'Content-Type':'application/json' });
    res.end(JSON.stringify({ ok:true, tools: TOOLS.map(t => t.name), dashboard: DASHBOARD }));
    return;
  }

  res.writeHead(404, { ...CORS, 'Content-Type':'application/json' }); res.end('{"error":"Not found"}');
}).listen(MCP_PORT, () => {
  console.log(`\n  agentscope — MCP bridge\n`);
  console.log(`  SSE:       http://localhost:${MCP_PORT}/sse`);
  console.log(`  Dashboard: ${DASHBOARD}\n`);
  console.log(`  Add to your agent config:`);
  console.log(`  { "mcpServers": { "agentscope": { "url": "http://localhost:${MCP_PORT}/sse" } } }\n`);
});
