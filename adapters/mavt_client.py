"""
agent-visibility · shared adapter client
=========================================
Used by mavt_langchain.py, mavt_autogen.py and mavt_crewai.py.
Copy this file into your project next to the adapter you use.

Requires: pip install requests
"""

from __future__ import annotations

import os
import sys
import threading
from typing import Optional

import requests

_ROLE_KEYWORDS = [
    ("orchestrator", ("orchestrat", "manager", "lead", "user_proxy", "groupchat")),
    ("critic",       ("critic", "review", "quality")),
    ("researcher",   ("research", "analys")),
    ("coder",        ("cod", "engineer", "developer", "implement")),
]


def infer_role(name: str) -> str:
    n = name.lower()
    for role, words in _ROLE_KEYWORDS:
        if any(w in n for w in words):
            return role
    return "worker"


class VisibilityClient:
    """Posts tool calls to the dashboard; never slows or breaks the agent run."""

    def __init__(self, url: str = "http://localhost:4242", api_key: Optional[str] = None):
        self.url = url.rstrip("/")
        # Needed when the dashboard runs with --password; create one in the dashboard's Keys panel.
        key = api_key or os.environ.get("VISIBILITY_API_KEY")
        self._headers = {"X-API-Key": key} if key else {}
        self._disabled = False
        self._lock = threading.Lock()
        self._registered: set[str] = set()
        self.first_agent: Optional[str] = None  # fallback when an event names no agent

    def post(self, tool: str, args: dict) -> None:
        if self._disabled:
            return
        try:
            r = requests.post(f"{self.url}/tool", json={"tool": tool, "args": args},
                              headers=self._headers, timeout=2)
        except requests.RequestException as exc:
            # Dashboard down or slow: stop trying for this run instead of adding 2 s to every event.
            self._disable(f"dashboard unreachable at {self.url} ({exc.__class__.__name__})")
            return
        if r.status_code in (401, 403):
            self._disable(f"dashboard rejected events (HTTP {r.status_code}); "
                          "pass api_key= or set VISIBILITY_API_KEY")

    def _disable(self, reason: str) -> None:
        with self._lock:
            if self._disabled:
                return
            self._disabled = True
        print(f"[agent-visibility] {reason}; not sending further events for this run.", file=sys.stderr)

    def register(self, name: str, role: Optional[str] = None) -> None:
        with self._lock:
            if name in self._registered:
                return
            self._registered.add(name)
            if self.first_agent is None:
                self.first_agent = name
        self.post("register_agent", {"id": name, "label": name, "role": role or infer_role(name)})
