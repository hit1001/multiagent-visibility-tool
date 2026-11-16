'use strict';
// Validation for workflow templates made in the builder: a set of agents and who reports to whom.
const ROLES = ['orchestrator', 'worker', 'researcher', 'coder', 'critic', 'synthesiser'];
const MAX_AGENTS = 50;

function fail(msg) { const e = new Error(msg); e.status = 400; throw e; }

// Returns a clean { name, agents: [{ id, label, role, model, reports_to, token_budget, x, y }] } or throws.
function validate(input) {
  if (!input || typeof input !== 'object') fail('Expected a workflow object');
  const name = String(input.name || '').trim().slice(0, 80);
  if (!name) fail('Workflow needs a name');
  if (!Array.isArray(input.agents) || !input.agents.length) fail('Workflow needs at least one agent');
  if (input.agents.length > MAX_AGENTS) fail(`A workflow can have at most ${MAX_AGENTS} agents`);

  const ids = new Set();
  const agents = input.agents.map((a, i) => {
    if (!a || typeof a !== 'object') fail(`Agent ${i + 1} is not an object`);
    const id = String(a.id || '').trim();
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(id)) fail(`Agent id "${id.slice(0, 40)}" must be 1-40 letters, digits, ".", "_" or "-"`);
    if (ids.has(id)) fail(`Duplicate agent id "${id}"`);
    ids.add(id);
    const role = ROLES.includes(a.role) ? a.role : 'worker';
    const budget = Number(a.token_budget);
    const coord = v => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
    return {
      id, label: String(a.label || id).trim().slice(0, 60) || id, role,
      model: String(a.model || '').trim().slice(0, 80),
      reports_to: a.reports_to ? String(a.reports_to) : null,
      token_budget: Number.isFinite(budget) && budget > 0 ? Math.round(budget) : null,
      x: coord(a.x), y: coord(a.y),
    };
  });

  const byId = Object.fromEntries(agents.map(a => [a.id, a]));
  for (const a of agents) {
    if (a.reports_to && !byId[a.reports_to]) fail(`"${a.id}" reports to unknown agent "${a.reports_to}"`);
    const seen = new Set([a.id]);
    for (let p = a.reports_to; p; p = byId[p].reports_to) {
      if (seen.has(p)) fail(`Reporting loop involving "${a.id}"`);
      seen.add(p);
    }
  }
  return { name, agents };
}

// Parents before children, so the topology builds top-down when applied.
function inReportingOrder(agents) {
  const byId = Object.fromEntries(agents.map(a => [a.id, a]));
  const depth = a => { let d = 0; for (let p = a.reports_to; p; p = byId[p].reports_to) d++; return d; };
  return [...agents].sort((a, b) => depth(a) - depth(b));
}

module.exports = { ROLES, MAX_AGENTS, validate, inReportingOrder };
