'use strict';
// Plugins: local JavaScript modules that react to what the dashboard sees.
//
// A plugin is a module exporting an object with a name and any of these hooks:
//   onRunStart({ runId, goal })
//   onEvent({ tool, args, runId })                 every reported tool call
//   onRunFinish({ runId, goal, status, metrics, durationMs })
//   onAlert({ alert, runId, goal, ... })
// Loaded from <data dir>/plugins/*.js and from VISIBILITY_PLUGINS (comma-separated paths or
// package names). VISIBILITY_PLUGINS=off loads none. Plugins run inside the server process with
// its permissions, so only install ones you trust. A plugin that throws is logged and skipped
// for that call; it cannot take the server down.
const fs   = require('fs');
const path = require('path');

const HOOKS = ['onRunStart', 'onEvent', 'onRunFinish', 'onAlert'];
let loaded = [];

function loadOne(id, source) {
  try {
    const mod = require(id);
    const plugin = typeof mod === 'function' ? mod() : mod;
    if (!plugin || typeof plugin !== 'object') throw new Error('must export an object (or a function returning one)');
    const hooks = HOOKS.filter(h => typeof plugin[h] === 'function');
    if (!hooks.length) throw new Error(`exports none of ${HOOKS.join(', ')}`);
    const name = String(plugin.name || path.basename(id, '.js'));
    loaded.push({ name, source, hooks, plugin });
    console.log(`[agentscope] Plugin loaded: ${name} (${hooks.join(', ')})`);
  } catch (e) {
    console.warn(`[agentscope] Plugin ${source} not loaded: ${e.message}`);
  }
}

function load(dataDir, spec = process.env.VISIBILITY_PLUGINS || '') {
  loaded = [];
  if (spec.trim().toLowerCase() === 'off') return loaded;
  const dir = path.join(dataDir, 'plugins');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort(); } catch (_) {} // no plugins directory
  for (const f of files) loadOne(path.join(dir, f), f);
  for (const id of spec.split(',').map(s => s.trim()).filter(Boolean)) {
    loadOne(/^[./]/.test(id) || path.isAbsolute(id) ? path.resolve(id) : id, id);
  }
  return loaded;
}

function emit(hook, payload) {
  for (const p of loaded) {
    if (!p.hooks.includes(hook)) continue;
    const fail = e => console.warn(`[agentscope] Plugin ${p.name} ${hook} failed: ${e && e.message}`);
    try {
      const r = p.plugin[hook](payload);
      if (r && typeof r.catch === 'function') r.catch(fail);
    } catch (e) { fail(e); }
  }
}

const list = () => loaded.map(({ name, source, hooks }) => ({ name, source, hooks }));

module.exports = { HOOKS, load, emit, list };
