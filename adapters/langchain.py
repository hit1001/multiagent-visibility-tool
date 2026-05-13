"""
agentscope · LangChain adapter
================================
Two-line integration:

    from agentscope.adapters.langchain import AgentscopeCallback
    chain.invoke(input, config={"callbacks": [AgentscopeCallback()]})

Or pass to any LangChain runnable / agent executor:

    AgentExecutor(agent=agent, tools=tools,
                  callbacks=[AgentscopeCallback(goal="My task")])

Requires: pip install langchain-core requests
"""

from __future__ import annotations

import time
import threading
from typing import Any, Dict, List, Optional, Union
from uuid import UUID

import requests


class AgentscopeCallback:
    """LangChain BaseCallbackHandler that streams events to the agentscope dashboard."""

    def __init__(self, url: str = "http://localhost:4242", goal: str = ""):
        self.url = url.rstrip("/")
        self._goal = goal
        self._run_id = str(int(time.time() * 1000))
        self._goal_set = False
        self._registered: set[str] = set()
        self._llm_starts: dict[str, dict] = {}   # uuid → {model, t0}
        self._tool_starts: dict[str, dict] = {}  # uuid → {name, input, t0}
        self._lock = threading.Lock()

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

    def _ensure(self, name: str, role: str = "worker") -> None:
        with self._lock:
            if name in self._registered:
                return
            self._registered.add(name)
        self._post("register_agent", {"id": name, "label": name, "role": role})

    def _ensure_goal(self, hint: str = "") -> None:
        with self._lock:
            if self._goal_set:
                return
            self._goal_set = True
        goal = (self._goal or hint or "LangChain run")[:200]
        self._post("set_goal", {"goal": goal, "run_id": self._run_id})

    def _first_agent(self) -> str:
        with self._lock:
            return next(iter(self._registered), "llm")

    # ── chain callbacks ───────────────────────────────────────────────────────

    def on_chain_start(
        self,
        serialized: Dict[str, Any],
        inputs: Dict[str, Any],
        *,
        run_id: UUID,
        tags: Optional[List[str]] = None,
        **kwargs: Any,
    ) -> None:
        name = (serialized or {}).get("name", "chain")
        with self._lock:
            role = "orchestrator" if not self._registered else "worker"
        self._ensure(name, role)
        hint = str(inputs.get("input", inputs.get("question", ""))).strip()[:200]
        self._ensure_goal(hint)
        self._post("set_agent_state", {"agent_id": name, "status": "running"})

    def on_chain_end(
        self,
        outputs: Dict[str, Any],
        *,
        run_id: UUID,
        **kwargs: Any,
    ) -> None:
        pass  # finish_run is called explicitly via .finish() or on AgentExecutor end

    def on_chain_error(
        self,
        error: Union[Exception, KeyboardInterrupt],
        *,
        run_id: UUID,
        **kwargs: Any,
    ) -> None:
        self._post("log_event", {
            "agent": self._first_agent(),
            "event_type": "error",
            "message": str(error)[:300],
        })

    # ── LLM callbacks ─────────────────────────────────────────────────────────

    def on_llm_start(
        self,
        serialized: Dict[str, Any],
        prompts: List[str],
        *,
        run_id: UUID,
        **kwargs: Any,
    ) -> None:
        model = (serialized or {}).get("name", "")
        self._llm_starts[str(run_id)] = {"model": model, "t0": time.time()}

    def on_chat_model_start(
        self,
        serialized: Dict[str, Any],
        messages: List[Any],
        *,
        run_id: UUID,
        **kwargs: Any,
    ) -> None:
        model = (serialized or {}).get("name", "")
        flat = []
        for batch in messages:
            for m in (batch if isinstance(batch, list) else [batch]):
                role = getattr(m, "type", "user")
                content = getattr(m, "content", str(m))
                flat.append({"role": role, "content": str(content)[:1000]})
        self._llm_starts[str(run_id)] = {"model": model, "t0": time.time(), "messages": flat}

    def on_llm_end(self, response: Any, *, run_id: UUID, **kwargs: Any) -> None:
        info = self._llm_starts.pop(str(run_id), {})
        latency = int((time.time() - info.get("t0", time.time())) * 1000)
        agent = self._first_agent()
        for gen_list in (response.generations or []):
            for gen in (gen_list if isinstance(gen_list, list) else [gen_list]):
                usage = {}
                if response.llm_output:
                    usage = response.llm_output.get("token_usage", {})
                self._post("log_generation", {
                    "agent": agent,
                    "model": info.get("model", ""),
                    "prompt_tokens":      usage.get("prompt_tokens", 0),
                    "completion_tokens":  usage.get("completion_tokens", 0),
                    "latency_ms":         latency,
                    "messages":           info.get("messages", []),
                    "response":           getattr(gen, "text", str(gen))[:2000],
                })

    def on_llm_error(
        self,
        error: Union[Exception, KeyboardInterrupt],
        *,
        run_id: UUID,
        **kwargs: Any,
    ) -> None:
        self._llm_starts.pop(str(run_id), None)
        self._post("log_event", {
            "agent": self._first_agent(),
            "event_type": "error",
            "message": f"LLM error: {error}"[:300],
        })

    # ── tool callbacks ────────────────────────────────────────────────────────

    def on_tool_start(
        self,
        serialized: Dict[str, Any],
        input_str: str,
        *,
        run_id: UUID,
        **kwargs: Any,
    ) -> None:
        name = (serialized or {}).get("name", "tool")
        self._tool_starts[str(run_id)] = {"name": name, "input": input_str, "t0": time.time()}

    def on_tool_end(self, output: str, *, run_id: UUID, **kwargs: Any) -> None:
        info = self._tool_starts.pop(str(run_id), {})
        self._post("log_tool_call", {
            "agent":      self._first_agent(),
            "tool_name":  info.get("name", "tool"),
            "input":      info.get("input", "")[:1000],
            "output":     str(output)[:2000],
            "latency_ms": int((time.time() - info.get("t0", time.time())) * 1000),
        })

    def on_tool_error(
        self,
        error: Union[Exception, KeyboardInterrupt],
        *,
        run_id: UUID,
        **kwargs: Any,
    ) -> None:
        info = self._tool_starts.pop(str(run_id), {})
        self._post("log_tool_call", {
            "agent":     self._first_agent(),
            "tool_name": info.get("name", "tool"),
            "input":     info.get("input", ""),
            "output":    "",
            "error":     str(error)[:300],
        })

    # ── agent action / finish ─────────────────────────────────────────────────

    def on_agent_action(self, action: Any, *, run_id: UUID, **kwargs: Any) -> None:
        self._post("log_event", {
            "agent":      self._first_agent(),
            "event_type": "action",
            "message":    str(getattr(action, "log", action))[:200],
        })

    def on_agent_finish(self, finish: Any, *, run_id: UUID, **kwargs: Any) -> None:
        self._post("log_event", {
            "agent":      self._first_agent(),
            "event_type": "done",
            "message":    str(getattr(finish, "log", finish))[:200],
        })
        self.finish("done")

    # ── public API ────────────────────────────────────────────────────────────

    def finish(self, status: str = "done") -> None:
        """Call after your chain/agent finishes to mark the run complete."""
        self._post("finish_run", {"status": status})
