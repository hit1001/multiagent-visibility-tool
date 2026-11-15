"""
Adapter tests against a real dashboard server.

    pip install langchain-core requests
    python test/test_adapters.py
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "adapters"))

from mavt_client import VisibilityClient, infer_role  # noqa: E402


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class DashboardTest(unittest.TestCase):
    def setUp(self):
        self.port = free_port()
        env = {**os.environ, "HOME": tempfile.mkdtemp(), "VISIBILITY_PORT": str(self.port)}
        self.proc = subprocess.Popen(["node", os.path.join(ROOT, "src", "server.js")], env=env,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        for line in self.proc.stdout:
            if b"Ctrl+C to stop" in line:
                break
        self.url = f"http://127.0.0.1:{self.port}"

    def tearDown(self):
        self.proc.kill()
        self.proc.wait()
        self.proc.stdout.close()

    def get(self, path):
        with urllib.request.urlopen(self.url + path) as r:
            return json.load(r)


class ClientTests(DashboardTest):
    def test_registers_first_agent_and_infers_roles(self):
        c = VisibilityClient(self.url)
        c.post("set_goal", {"goal": "g", "run_id": "r1"})
        c.register("Lead Planner")
        c.register("code_reviewer")
        self.assertEqual(c.first_agent, "Lead Planner")
        reg = self.get("/state")["registry"]
        self.assertEqual(reg["Lead Planner"]["role"], "orchestrator")
        self.assertEqual(infer_role("user_proxy"), "orchestrator")
        self.assertEqual(infer_role("quality checker"), "critic")

    def test_stops_posting_after_dashboard_is_unreachable(self):
        c = VisibilityClient(f"http://127.0.0.1:{free_port()}")  # nothing listening
        t0 = time.time()
        for _ in range(20):
            c.post("log_event", {"agent": "a", "event_type": "start", "message": "x"})
        self.assertLess(time.time() - t0, 2)


class LangChainTests(DashboardTest):
    def test_chain_run_is_traced(self):
        from langchain_core.language_models.fake import FakeListLLM
        from langchain_core.prompts import PromptTemplate
        from mavt_langchain import AgentscopeCallback

        cb = AgentscopeCallback(url=self.url, goal="Say hi")
        chain = PromptTemplate.from_template("Say {x}") | FakeListLLM(responses=["hi"])
        self.assertEqual(chain.invoke({"x": "hi"}, config={"callbacks": [cb]}), "hi")
        cb.finish()

        state = self.get("/state")
        self.assertEqual(state["goal"], "Say hi")
        self.assertEqual(state["status"], "done")
        self.assertTrue(state["registry"], "chain should be registered as an agent")
        self.assertTrue(all(a["status"] == "done" for a in state["agents"].values()),
                        "chains must not stay 'running' after they end")
        self.assertTrue(any(i["kind"] == "generation" and i["response"] == "hi" for i in state["internals"]))

        run = self.get(f"/runs/{state['runId']}")
        self.assertTrue(run["agents_text"], "agents must be saved under this run")


if __name__ == "__main__":
    unittest.main()
