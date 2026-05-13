"""
agentscope · AutoGen adapter
==============================
Two-line integration (pyautogen / autogen-agentchat):

    from agentscope.adapters.autogen import track
    scope = track(agents=[orchestrator, researcher, coder], goal="My task")

    # … run your agents …

    scope.finish()

Works with AutoGen 0.2 / 0.3 (pyautogen) by monkey-patching `generate_reply`.
For AutoGen 0.4+ (autogen-agentchat) use the same API — the patch targets the
same method signature.

Requires: pip install pyautogen requests   (or pip install autogen-agentchat)
"""

from __future__ import annotations

import functools
import time
import threading
from typing import Any, List, Optional

import requests


def track(
    agents: List[Any],
    goal: str = "",
    url: str = "http://localhost:4242",
) -> "_AgentscopeAutoGen":
    """
    Patch a list of AutoGen agents and start a visibility run.

    Returns a scope object; call scope.finish() when done.
    """
    scope = _AgentscopeAutoGen(url=url, goal=goal)
    for agent in agents:
        scope._patch(agent)
    scope._start()
    return scope


class _AgentscopeAutoGen:
    def __init__(self, url: str, goal: str):
        self.url = url.rstrip("/")
        self._goal = goal
        self._run_id = str(int(time.time() * 1000))
        self._lock = threading.Lock()
        self._registered: set[str] = set()

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

    def _start(self) -> None:
        self._post("set_goal", {"goal": self._goal or "AutoGen run", "run_id": self._run_id})

    def _register(self, name: str, role: str) -> None:
        with self._lock:
            if name in self._registered:
                return
            self._registered.add(name)
        self._post("register_agent", {"id": name, "label": name, "role": role})

    # ── agent patching ────────────────────────────────────────────────────────

    def _patch(self, agent: Any) -> None:
        name = getattr(agent, "name", str(agent))
        name_lower = name.lower()
        if "orchestrat" in name_lower or "manager" in name_lower or "user_proxy" in name_lower:
            role = "orchestrator"
        elif "critic" in name_lower or "review" in name_lower:
            role = "critic"
        elif "research" in name_lower:
            role = "researcher"
        elif "cod" in name_lower or "engineer" in name_lower or "developer" in name_lower:
            role = "coder"
        else:
            role = "worker"

        self._register(name, role)
        scope = self

        # ── patch generate_reply ──────────────────────────────────────────────
        orig_generate = getattr(agent, "generate_reply", None)
        if orig_generate is not None:
            @functools.wraps(orig_generate)
            def patched_generate_reply(
                messages: Optional[List[dict]] = None,
                sender: Any = None,
                **kwargs: Any,
            ):
                scope._post("set_agent_state", {"agent_id": name, "status": "running"})
                t0 = time.time()
                try:
                    result = orig_generate(messages=messages, sender=sender, **kwargs)
                except Exception as exc:
                    scope._post("log_event", {
                        "agent": name, "event_type": "error", "message": str(exc)[:300],
                    })
                    scope._post("set_agent_state", {"agent_id": name, "status": "error"})
                    raise

                latency = int((time.time() - t0) * 1000)
                response_text = str(result)[:2000] if result is not None else ""

                scope._post("log_generation", {
                    "agent":      name,
                    "latency_ms": latency,
                    "response":   response_text,
                    "messages":   [
                        {"role": m.get("role", "user"), "content": str(m.get("content", ""))[:500]}
                        for m in (messages or [])[-6:]   # last 6 turns for context
                    ],
                })

                if sender is not None:
                    sender_name = getattr(sender, "name", str(sender))
                    scope._post("trace_step", {
                        "from_agent": name,
                        "to_agent":   sender_name,
                        "label":      "reply",
                        "arrow_type": "msg",
                    })

                scope._post("set_agent_state", {"agent_id": name, "status": "idle"})
                return result

            agent.generate_reply = patched_generate_reply

        # ── patch initiate_chat (UserProxyAgent / GroupChatManager) ──────────
        orig_initiate = getattr(agent, "initiate_chat", None)
        if orig_initiate is not None:
            @functools.wraps(orig_initiate)
            def patched_initiate_chat(recipient: Any, message: Any = None, **kwargs: Any):
                if message:
                    goal_text = str(message)[:200]
                    scope._post("log_event", {
                        "agent": name, "event_type": "start", "message": goal_text,
                    })
                return orig_initiate(recipient, message=message, **kwargs)

            agent.initiate_chat = patched_initiate_chat

    # ── public API ────────────────────────────────────────────────────────────

    def finish(self, status: str = "done") -> None:
        """Call after your agent conversation ends."""
        self._post("finish_run", {"status": status})
