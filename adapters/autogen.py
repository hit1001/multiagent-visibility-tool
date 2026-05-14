"""
agentscope · AutoGen adapter
==============================
Two-line integration (pyautogen / autogen-agentchat):

    from agentscope.adapters.autogen import track
    scope = track(agents=[orchestrator, researcher, coder], goal="My task")

    # … run your agents …

    scope.finish()

Works with:
  - AutoGen 0.2 / 0.3 (pyautogen) — patches generate_reply
  - AutoGen 0.4+ (autogen-agentchat) — patches on_messages if available
  - GroupChatManager — patches run_chat to trace speaker transitions
  - function_map tool calls — wraps each tool to log_tool_call

Requires: pip install pyautogen requests   (or pip install autogen-agentchat)
"""

from __future__ import annotations

import functools
import time
import threading
from typing import Any, Dict, List, Optional

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

    def _infer_role(self, name: str) -> str:
        n = name.lower()
        if "orchestrat" in n or "manager" in n or "user_proxy" in n or "groupchat" in n:
            return "orchestrator"
        if "critic" in n or "review" in n:
            return "critic"
        if "research" in n:
            return "researcher"
        if "cod" in n or "engineer" in n or "developer" in n:
            return "coder"
        return "worker"

    # ── agent patching ────────────────────────────────────────────────────────

    def _patch(self, agent: Any) -> None:
        name = getattr(agent, "name", str(agent))
        role = self._infer_role(name)
        self._register(name, role)
        scope = self

        # ── patch generate_reply (AutoGen 0.2 / 0.3) ─────────────────────────
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
                    scope._post("log_event", {"agent": name, "event_type": "error", "message": str(exc)[:300]})
                    scope._post("set_agent_state", {"agent_id": name, "status": "error"})
                    raise

                latency = int((time.time() - t0) * 1000)
                response_text = str(result)[:2000] if result is not None else ""

                # Extract token usage if available (AutoGen 0.3+ may include usage in reply)
                prompt_tokens = completion_tokens = 0
                if isinstance(result, dict):
                    usage = result.get("usage", {})
                    prompt_tokens     = usage.get("prompt_tokens", 0)
                    completion_tokens = usage.get("completion_tokens", 0)

                scope._post("log_generation", {
                    "agent":             name,
                    "latency_ms":        latency,
                    "response":          response_text,
                    "prompt_tokens":     prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "messages": [
                        {"role": m.get("role", "user"), "content": str(m.get("content", ""))[:500]}
                        for m in (messages or [])[-6:]
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

        # ── patch on_messages (AutoGen 0.4+ agentchat) ───────────────────────
        orig_on_messages = getattr(agent, "on_messages", None)
        if orig_on_messages is not None:
            @functools.wraps(orig_on_messages)
            async def patched_on_messages(messages: Any, cancellation_token: Any = None, **kwargs: Any):
                scope._post("set_agent_state", {"agent_id": name, "status": "running"})
                t0 = time.time()
                try:
                    result = await orig_on_messages(messages, cancellation_token, **kwargs)
                except Exception as exc:
                    scope._post("log_event", {"agent": name, "event_type": "error", "message": str(exc)[:300]})
                    scope._post("set_agent_state", {"agent_id": name, "status": "error"})
                    raise

                latency = int((time.time() - t0) * 1000)
                response_text = ""
                if hasattr(result, "chat_message"):
                    response_text = str(getattr(result.chat_message, "content", ""))[:2000]
                elif result is not None:
                    response_text = str(result)[:2000]

                scope._post("log_generation", {
                    "agent":      name,
                    "latency_ms": latency,
                    "response":   response_text,
                })
                scope._post("set_agent_state", {"agent_id": name, "status": "idle"})
                return result

            agent.on_messages = patched_on_messages

        # ── patch initiate_chat (UserProxyAgent / GroupChatManager) ──────────
        orig_initiate = getattr(agent, "initiate_chat", None)
        if orig_initiate is not None:
            @functools.wraps(orig_initiate)
            def patched_initiate_chat(recipient: Any, message: Any = None, **kwargs: Any):
                if message:
                    scope._post("log_event", {
                        "agent": name, "event_type": "start",
                        "message": str(message)[:200],
                    })
                return orig_initiate(recipient, message=message, **kwargs)

            agent.initiate_chat = patched_initiate_chat

        # ── patch run_chat (GroupChatManager — traces speaker transitions) ────
        orig_run_chat = getattr(agent, "run_chat", None)
        if orig_run_chat is not None:
            @functools.wraps(orig_run_chat)
            def patched_run_chat(messages: Any = None, sender: Any = None, config: Any = None, **kwargs: Any):
                groupchat = config if config is not None else getattr(agent, "groupchat", None)
                if groupchat is not None:
                    # Patch next_agent or select_speaker to trace transitions
                    for attr in ("next_agent", "select_speaker"):
                        orig_next = getattr(groupchat, attr, None)
                        if orig_next is not None:
                            def make_next_wrapper(fn):
                                @functools.wraps(fn)
                                def patched_next(*a, **kw):
                                    next_agent = fn(*a, **kw)
                                    if next_agent is not None:
                                        next_name = getattr(next_agent, "name", str(next_agent))
                                        scope._post("trace_step", {
                                            "from_agent": name,
                                            "to_agent":   next_name,
                                            "label":      "selected",
                                            "arrow_type": "msg",
                                        })
                                    return next_agent
                                return patched_next
                            try:
                                setattr(groupchat, attr, make_next_wrapper(orig_next))
                            except Exception:
                                pass
                            break
                return orig_run_chat(messages=messages, sender=sender, config=config, **kwargs)

            agent.run_chat = patched_run_chat

        # ── wrap function_map tools ───────────────────────────────────────────
        function_map: Dict[str, Any] = getattr(agent, "function_map", None) or {}
        if function_map:
            for tool_name, tool_fn in list(function_map.items()):
                def make_wrapper(fn, tn):
                    @functools.wraps(fn)
                    def wrapper(*args, **kwargs):
                        t0 = time.time()
                        try:
                            output = fn(*args, **kwargs)
                            scope._post("log_tool_call", {
                                "agent":      name,
                                "tool_name":  tn,
                                "input":      str(args[0] if args else kwargs)[:1000],
                                "output":     str(output)[:2000],
                                "latency_ms": int((time.time() - t0) * 1000),
                            })
                            return output
                        except Exception as exc:
                            scope._post("log_tool_call", {
                                "agent":     name,
                                "tool_name": tn,
                                "input":     str(args[0] if args else kwargs)[:1000],
                                "output":    "",
                                "error":     str(exc)[:300],
                            })
                            raise
                    return wrapper
                function_map[tool_name] = make_wrapper(tool_fn, tool_name)

    # ── public API ────────────────────────────────────────────────────────────

    def finish(self, status: str = "done") -> None:
        """Call after your agent conversation ends."""
        self._post("finish_run", {"status": status})
