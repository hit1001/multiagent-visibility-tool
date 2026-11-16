"""
agent-visibility · Python SDK
=============================
For agents that don't use LangChain, AutoGen or CrewAI. Copy this file and
mavt_client.py into your project (pip install requests).

    from mavt_sdk import Visibility

    vis = Visibility()                                   # http://localhost:4242
    vis.set_goal("Summarise the report")
    vis.register_agent("lead", role="orchestrator", model="claude-sonnet-5-5")
    vis.log_llm_turn("lead", prompt_tokens=1200, completion_tokens=300,
                     latency_ms=2100, response="...")
    with vis.trace_tool("lead", "search", input=query) as call:
        call.output = search(query)
    vis.finish_run()

Calls never raise into your agent code: if the dashboard is unreachable the
client warns once and stops sending.
"""

from __future__ import annotations

import json
import time
from contextlib import contextmanager
from typing import Any, Optional

from mavt_client import VisibilityClient


def _text(value: Any) -> str:
    if value is None:
        return ""
    return value if isinstance(value, str) else json.dumps(value, default=str)


def _drop(**kwargs: Any) -> dict:
    return {k: v for k, v in kwargs.items() if v is not None}


class _ToolCall:
    output: Any = None


class Visibility(VisibilityClient):
    # -- run lifecycle ------------------------------------------------------
    def set_goal(self, goal: str, run_id: Optional[str] = None) -> None:
        self.post("set_goal", _drop(goal=goal, run_id=run_id))

    def finish_run(self, status: str = "done") -> None:
        self.post("finish_run", {"status": status})

    def set_plan(self, tasks: list) -> None:
        self.post("set_plan", {"tasks": tasks})

    # -- agents -------------------------------------------------------------
    def register_agent(self, id: str, label: Optional[str] = None, role: str = "worker",
                       model: Optional[str] = None, reports_to: Optional[str] = None,
                       token_budget: Optional[int] = None, color: Optional[str] = None) -> None:
        self.post("register_agent", _drop(id=id, label=label or id, role=role, model=model,
                                          reports_to=reports_to, token_budget=token_budget, color=color))

    def set_agent_state(self, agent_id: str, status: str) -> None:
        self.post("set_agent_state", {"agent_id": agent_id, "status": status})

    def trace_step(self, from_agent: str, to_agent: str, label: Optional[str] = None,
                   arrow_type: Optional[str] = None) -> None:
        self.post("trace_step", _drop(from_agent=from_agent, to_agent=to_agent, label=label, arrow_type=arrow_type))

    # -- events -------------------------------------------------------------
    def log_event(self, agent: str, event_type: str = "reply", message: str = "",
                  tokens: Optional[int] = None, latency_ms: Optional[int] = None,
                  metadata: Optional[dict] = None) -> None:
        self.post("log_event", _drop(agent=agent, event_type=event_type, message=message,
                                     tokens=tokens, latency_ms=latency_ms, metadata=metadata))

    def log_llm_turn(self, agent: str, model: Optional[str] = None, prompt_tokens: Optional[int] = None,
                     completion_tokens: Optional[int] = None, latency_ms: Optional[int] = None,
                     stop_reason: Optional[str] = None, messages: Optional[list] = None,
                     response: Optional[str] = None, thinking: Optional[str] = None) -> None:
        self.post("log_llm_turn", _drop(agent=agent, model=model, prompt_tokens=prompt_tokens,
                                        completion_tokens=completion_tokens, latency_ms=latency_ms,
                                        stop_reason=stop_reason, messages=messages,
                                        response=response, thinking=thinking))

    def log_tool_call(self, agent: str, tool_name: str, input: Any = None, output: Any = None,
                      latency_ms: Optional[int] = None, error: Optional[str] = None) -> None:
        self.post("log_tool_call", _drop(agent=agent, tool_name=tool_name, input=_text(input),
                                         output=_text(output), latency_ms=latency_ms, error=error))

    def set_memory(self, key: str, value: Any, op: str = "write") -> None:
        self.post("set_memory", {"key": key, "value": value, "op": op})

    @contextmanager
    def trace_tool(self, agent: str, tool_name: str, input: Any = None):
        """Time a block and log it as a tool call; set `.output` on the yielded object."""
        call, t0 = _ToolCall(), time.monotonic()
        try:
            yield call
        except Exception as exc:
            self.log_tool_call(agent, tool_name, input, latency_ms=int((time.monotonic() - t0) * 1000),
                               error=f"{exc.__class__.__name__}: {exc}")
            raise
        self.log_tool_call(agent, tool_name, input, call.output, latency_ms=int((time.monotonic() - t0) * 1000))
