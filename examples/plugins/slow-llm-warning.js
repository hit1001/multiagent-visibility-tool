'use strict';
// Example plugin: print a warning when a single model call is slow or large.
// Shows onEvent, which receives every tool call reported to the dashboard.
const MAX_MS     = Number(process.env.MAVT_SLOW_LLM_MS) || 10000;
const MAX_TOKENS = Number(process.env.MAVT_BIG_PROMPT_TOKENS) || 50000;

module.exports = {
  name: 'slow-llm-warning',
  onEvent({ tool, args, runId }) {
    if (tool !== 'log_llm_turn' && tool !== 'log_generation') return;
    if (args.latency_ms > MAX_MS) console.warn(`[slow-llm] ${args.agent} waited ${args.latency_ms} ms (run ${runId})`);
    if (args.prompt_tokens > MAX_TOKENS) console.warn(`[slow-llm] ${args.agent} sent ${args.prompt_tokens} prompt tokens (run ${runId})`);
  },
};
