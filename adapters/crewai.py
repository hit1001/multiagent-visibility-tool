"""
agentscope · CrewAI adapter
=============================
Two-line integration:

    from agentscope.adapters.crewai import AgentscopeListener
    listener = AgentscopeListener(goal="My task")

    crew = Crew(
        agents=[researcher, coder, critic],
        tasks=[task1, task2],
        step_callback=listener,          # called after every agent step
        task_callback=listener.on_task_end,  # optional
    )
    result = crew.kickoff()
    listener.finish()

Works with crewai >= 0.28.

Requires: pip install crewai requests
"""

from __future__ import annotations

import time
import threading
from typing import Any, List, Optional

import requests


class AgentscopeListener:
    """
    Drop-in CrewAI step_callback + optional task callback.

    Streams all agent steps, LLM calls (where available), tool calls,
    and memory writes to the agentscope dashboard in real time.
    """

    def __init__(self, url: str = "http://localhost:4242", goal: str = ""):
        self.url = url.rstrip("/")
        self._goal = goal
        self._run_id = str(int(time.time() * 1000))
        self._lock = threading.Lock()
        self._registered: set[str] = set()
        self._started = False

    # ── internal helpers ──────────────────────────────────────────────────────

    def _post(self, tool: str, args: dict) -> None:
        try:
            requests.post(
                f"{self.url}/tool",
                json={"tool": tool, "args": args},
                timeout=2,
            )
        except Exception:
            pass

    def _agent_name(self, agent: Any) -> str:
        return str(getattr(agent, "role", None) or getattr(agent, "name", None) or str(agent))

    def _agent_role(self, name: str) -> str:
        n = name.lower()
        if "orchestrat" in n or "manager" in n or "lead" in n:
            return "orchestrator"
        if "critic" in n or "review" in n or "quality" in n:
            return "critic"
        if "research" in n or "analys" in n:
            return "researcher"
        if "cod" in n or "engineer" in n or "developer" in n or "implement" in n:
            return "coder"
        return "worker"

    def _ensure(self, name: str) -> None:
        with self._lock:
            if name in self._registered:
                return
            self._registered.add(name)
        self._post("register_agent", {
            "id": name, "label": name, "role": self._agent_role(name),
        })

    def _ensure_started(self) -> None:
        with self._lock:
            if self._started:
                return
            self._started = True
        self._post("set_goal", {"goal": self._goal or "CrewAI run", "run_id": self._run_id})

    # ── step_callback (called after every agent step) ─────────────────────────

    def __call__(self, step_output: Any) -> None:
        """Called by CrewAI's step_callback after each agent action."""
        self._ensure_started()
        try:
            self._handle_step(step_output)
        except Exception:
            pass

    def _handle_step(self, step: Any) -> None:
        # CrewAI ≥ 0.28 passes a TaskOutput or AgentFinish-like object
        agent_obj = getattr(step, "agent", None)
        if agent_obj is not None:
            name = self._agent_name(agent_obj)
        else:
            # Older versions pass the raw output string
            name = next(iter(self._registered), "agent")

        self._ensure(name)
        self._post("set_agent_state", {"agent_id": name, "status": "running"})

        # Extract result text
        result = (
            getattr(step, "raw", None)
            or getattr(step, "result", None)
            or getattr(step, "output", None)
            or str(step)
        )
        result_str = str(result)[:2000]

        # Log LLM generation if token info available
        token_usage = getattr(step, "token_usage", None)
        if token_usage:
            self._post("log_generation", {
                "agent":             name,
                "response":          result_str,
                "prompt_tokens":     getattr(token_usage, "prompt_tokens", 0),
                "completion_tokens": getattr(token_usage, "completion_tokens", 0),
            })
        else:
            self._post("log_event", {
                "agent":      name,
                "event_type": "step",
                "message":    result_str[:200],
            })

        self._post("set_agent_state", {"agent_id": name, "status": "idle"})

    # ── optional task-level callbacks ─────────────────────────────────────────

    def on_task_start(self, task: Any, agent: Any = None) -> None:
        """
        Optional: wire to a task's on_start callback if your CrewAI version supports it.

        crew = Crew(tasks=[Task(..., on_start=listener.on_task_start)])
        """
        self._ensure_started()
        try:
            ag = agent or getattr(task, "agent", None)
            name = self._agent_name(ag) if ag else "agent"
            self._ensure(name)
            desc = str(getattr(task, "description", ""))[:200]
            self._post("set_agent_state", {"agent_id": name, "status": "running"})
            self._post("log_event", {
                "agent": name, "event_type": "start", "message": desc,
            })
        except Exception:
            pass

    def on_task_end(self, task_output: Any) -> None:
        """
        Optional: wire to Crew's task_callback.

        crew = Crew(..., task_callback=listener.on_task_end)
        """
        try:
            agent_obj = getattr(task_output, "agent", None)
            name = self._agent_name(agent_obj) if agent_obj else next(iter(self._registered), "agent")
            self._ensure(name)
            result = str(
                getattr(task_output, "raw", None)
                or getattr(task_output, "result", None)
                or task_output
            )[:200]
            self._post("log_event", {
                "agent": name, "event_type": "done", "message": result,
            })
            self._post("set_agent_state", {"agent_id": name, "status": "done"})
        except Exception:
            pass

    # ── register agents upfront (optional but gives richer graph) ────────────

    def register_crew(self, crew: Any) -> "AgentscopeListener":
        """
        Optionally call before kickoff() to pre-register all agents so the
        topology graph is visible from the start.

            listener.register_crew(crew)
            result = crew.kickoff()
        """
        self._ensure_started()
        agents = getattr(crew, "agents", [])
        for ag in agents:
            self._ensure(self._agent_name(ag))
        return self

    # ── public API ────────────────────────────────────────────────────────────

    def finish(self, status: str = "done") -> None:
        """Call after crew.kickoff() returns."""
        self._post("finish_run", {"status": status})
