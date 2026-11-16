'use strict';
// Cost estimation for LLM calls.
//
// Prices are USD per 1M tokens: [input, output]. They are list prices as of November 2026 and
// will drift — override or extend them in <data dir>/pricing.json:
//   { "my-model": [0.5, 1.5], "gpt-4o": { "input": 2.5, "output": 10 } }
// A model matches the longest key that its id starts with, so dated ids
// ("claude-sonnet-4-20250514") and provider prefixes ("anthropic.claude-…", "openai/gpt-…") work.
const fs   = require('fs');
const path = require('path');

const DEFAULT_PRICES = {
  // Anthropic — current
  'claude-fable-5-2':  [8, 40],
  'claude-mythos-5-2': [8, 40],
  'claude-fable-5':    [10, 50],   // 5 and 5.1
  'claude-mythos-5':   [10, 50],
  'claude-opus-5-5':   [4, 20],
  'claude-opus-5':     [5, 25],
  'claude-opus-4-8':   [5, 25],
  'claude-opus-4-7':   [5, 25],
  'claude-opus-4-6':   [5, 25],
  'claude-opus-4-5':   [5, 25],
  'claude-sonnet-5':   [2, 10],    // 5 and 5.5
  'claude-sonnet-4':   [3, 15],    // 4, 4.5, 4.6
  'claude-haiku-5-5':  [0.1, 0.5], // prompts up to 100K tokens
  'claude-haiku-4-5':  [1, 5],
  // Anthropic — legacy
  'claude-opus-4':     [15, 75],   // 4 and 4.1
  'claude-3-7-sonnet': [3, 15],
  'claude-3-5-sonnet': [3, 15],
  'claude-3-5-haiku':  [0.8, 4],
  'claude-3-opus':     [15, 75],
  'claude-3-haiku':    [0.25, 1.25],
  // OpenAI
  'gpt-4.1-nano':      [0.1, 0.4],
  'gpt-4.1-mini':      [0.4, 1.6],
  'gpt-4.1':           [2, 8],
  'gpt-4o-mini':       [0.15, 0.6],
  'gpt-4o':            [2.5, 10],
};

let prices = { ...DEFAULT_PRICES };

function normalise(entry) {
  if (Array.isArray(entry)) entry = { input: entry[0], output: entry[1] };
  if (!entry || typeof entry !== 'object') return null;
  const input = Number(entry.input), output = Number(entry.output);
  return Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0 ? [input, output] : null;
}

// Merge user overrides from <dir>/pricing.json. Returns the number of entries applied.
function loadOverrides(dir) {
  prices = { ...DEFAULT_PRICES };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(dir, 'pricing.json'), 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') console.warn('[agentscope] Ignoring pricing.json:', e.message);
    return 0;
  }
  let n = 0;
  for (const [model, entry] of Object.entries(raw || {})) {
    const p = normalise(entry);
    if (p) { prices[model.toLowerCase()] = p; n++; }
    else console.warn(`[agentscope] pricing.json: skipping "${model}" (expected [input, output] in USD per 1M tokens)`);
  }
  return n;
}

// [input, output] USD per 1M tokens, or null when the model isn't in the table.
function priceFor(model) {
  if (!model) return null;
  const id = String(model).toLowerCase().replace(/^.*\//, '').replace(/^(us\.|eu\.|apac\.|global\.)?anthropic\./, '');
  let best = null;
  for (const key of Object.keys(prices)) {
    if (id.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? prices[best] : null;
}

// Cost in USD of one LLM call, or null when the model is unpriced.
function costOf(model, promptTokens = 0, completionTokens = 0) {
  const p = priceFor(model);
  if (!p) return null;
  return ((Number(promptTokens) || 0) * p[0] + (Number(completionTokens) || 0) * p[1]) / 1e6;
}

// Cost when only a total is known (log_event): assumes an even input/output split.
function costOfTotal(model, tokens = 0) {
  const p = priceFor(model);
  if (!p) return null;
  return (Number(tokens) || 0) * (p[0] + p[1]) / 2 / 1e6;
}

module.exports = { DEFAULT_PRICES, loadOverrides, priceFor, costOf, costOfTotal };
