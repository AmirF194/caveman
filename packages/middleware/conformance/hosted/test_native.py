"""Real installed three-arm LangChain HTTP/stream harness controls, no paid calls."""
from __future__ import annotations

import copy
from decimal import Decimal
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import threading
import unittest

from budget import Budget, Prices
from native import run_pair
from run import corpus, execute_job


class Provider:
    def __init__(self, provider, task, mode="normal"):
        self.provider, self.task, self.mode = provider, task, mode
        self.requests, self.errors, self.recoveries = [], [], []
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            def log_message(self, *_): pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                fixture.requests.append(body)
                if fixture.mode == "http_error":
                    payload = b'{"error":{"message":"local fixture error","type":"server_error","code":"fixture"}}'
                    self.send_response(503)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    self.close_connection = True
                    return
                try:
                    assert body.get("stream") is True, "native message stream must enable actual provider streaming"
                    name, arguments, text = fixture.next(body)
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    for event in fixture.events(name, arguments, text):
                        payload = event if isinstance(event, str) else json.dumps(event)
                        if fixture.provider == "anthropic" and isinstance(event, dict):
                            self.wfile.write(("event: " + event["type"] + "\n").encode())
                        self.wfile.write(("data: " + payload + "\n\n").encode())
                        self.wfile.flush()
                except BaseException as error:
                    fixture.errors.append(type(error).__name__ + ": " + str(error))
                self.close_connection = True
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        self.url = "http://127.0.0.1:" + str(self.server.server_port)
        return self

    def __exit__(self, *_):
        self.server.shutdown(); self.server.server_close(); self.thread.join(2)

    def next(self, body):
        messages = body["messages"]
        if self.provider == "openai":
            values = [message["content"] for message in messages if message.get("role") == "tool"]
        else:
            values = [part["content"] for message in messages if isinstance(message.get("content"), list)
                      for part in message["content"] if part.get("type") == "tool_result"]
            values = [value if isinstance(value, str) else "".join(part.get("text", "") for part in value) for value in values]
        if not values:
            return "read_source", {"path": next(iter(self.task["files"]))}, None
        handle = re.search(r"cmw_[a-f0-9]{48}", values[0])
        if handle and len(values) == 1:
            return "caveman_retrieve", {"handle": handle[0]}, None
        if handle:
            page = json.loads(values[-1])
            assert page["text"] == next(iter(self.task["files"].values()))
            fixture_hash = hashlib.sha256(page["text"].encode()).hexdigest()
            assert page["original_sha256"] == fixture_hash
            self.recoveries.append(fixture_hash)
        oracle = self.task["oracle"]
        answer = oracle["expected"] if "expected" in oracle else {"answer": oracle["expected_answer"], "citations": oracle["citations"]}
        return None, None, json.dumps(answer, ensure_ascii=False)

    def events(self, name, arguments, text):
        if self.provider == "openai":
            def event(delta, finish=None, usage=None):
                return {"id": "chatcmpl-fixture", "object": "chat.completion.chunk", "created": 1, "model": "fixture-model",
                        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}] if usage is None else [], "usage": usage}
            if name:
                yield event({"role": "assistant", "tool_calls": [{"index": 0, "id": f"call-{len(self.requests)}", "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}}]})
            else:
                yield event({"role": "assistant", "content": text[:1]})
                yield event({"content": text[1:]})
            yield event({}, "tool_calls" if name else "stop")
            if self.mode != "missing_usage":
                yield event({}, usage={"prompt_tokens": 1000, "completion_tokens": 20, "total_tokens": 1020,
                                      "prompt_tokens_details": {"cached_tokens": 0}, "completion_tokens_details": {"reasoning_tokens": 0},
                                      "untrusted_future_field": "fixture-secret-source-must-not-be-retained"})
            yield "[DONE]"
            return
        yield {"type": "message_start", "message": {"id": "msg-fixture", "type": "message", "role": "assistant", "model": "fixture-model", "content": [], "stop_reason": None,
                                                       "usage": {"input_tokens": 1000, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}}}
        if name:
            yield {"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": f"call-{len(self.requests)}", "name": name, "input": {}}}
            yield {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": json.dumps(arguments)}}
        else:
            yield {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}
            yield {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text[:1]}}
            yield {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text[1:]}}
        yield {"type": "content_block_stop", "index": 0}
        yield {"type": "message_delta", "delta": {"stop_reason": "tool_use" if name else "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 20}}
        yield {"type": "message_stop"}


class NativeHarnessTests(unittest.TestCase):
    evidence = []

    @classmethod
    def tearDownClass(cls):
        output = os.environ.get("CAVEMAN_MIDDLEWARE_HOSTED_LOCAL_EVIDENCE")
        if output:
            path = Path(output)
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("x") as destination:
                json.dump({"schema_version": 1, "evidence_class": "local_native_harness_controls",
                           "external_inference_requests": 0, "provider_quality_evidence": False,
                           "cases": cls.evidence}, destination, indent=2)
                destination.write("\n")

    def test_three_actual_native_arms_stream_and_grade_without_paid_inference(self):
        endpoint = os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"]
        tasks = [task for task in corpus() if task["id"] in ("data-small-noop", "data-enumerate-json")]
        costs = Prices(*(Decimal(value) for value in ("1", "2", ".1", "1.25", "2", "0")), maximum_input_tokens=100000, maximum_output_tokens=2048)
        cache_identities = set()
        for provider in ("openai",):
            for arm in ("direct", "caveman", "headroom"):
                for task in tasks:
                    with self.subTest(provider=provider, arm=arm, task=task["id"]), Provider(provider, task) as fixture:
                        config = {"provider": provider, "model": "fixture-model", "endpoint": fixture.url + ("/v1" if provider == "openai" else ""), "auth_class": "local_fixture"}
                        result, receipts = [], []
                        failure = execute_job({"task": task, "arm": arm, "rotation": 0, "run_id": "local-native-harness",
                                               "config": config, "api_key": "local-fixture", "endpoint": endpoint,
                                               "local_fixture": True}, Budget(Decimal("100"), costs), receipts.append, result.append)
                        self.evidence.append({"control": "three_arm_native_flow", "provider": provider, "arm": arm,
                                              "task_id": task["id"], "observed_provider_requests": len(fixture.requests),
                                              "coverage_failure": failure, "results": result, "receipts": receipts})
                        self.assertIsNone(failure)
                        self.assertEqual(fixture.errors, [])
                        self.assertEqual([row["stratum"] for row in result], ["cold", "warm"])
                        self.assertTrue(all(row["passed"] and row["usage_complete"] and row["original_input_unchanged"] for row in result), result)
                        self.assertTrue(all(row["native_stream_event_classes"] for row in result))
                        self.assertEqual(len(receipts), len(fixture.requests))
                        self.assertTrue(all(row["evidence_class"] == "local_provider_fixture" for row in receipts))
                        self.assertTrue(all(row["usage"]["output"] == 20 and row["usage_complete_for_pricing"] for row in receipts))
                        self.assertTrue(all(row["error_class"] is None for row in result))
                        self.assertTrue(all("authorization" not in json.dumps(row).lower() and "local-fixture" not in json.dumps(row) for row in receipts))
                        self.assertTrue(all("fixture-secret-source" not in json.dumps(row) for row in receipts))
                        identities = {body["prompt_cache_key"] for body in fixture.requests}
                        self.assertEqual(len(identities), 1)
                        self.assertFalse(cache_identities.intersection(identities))
                        cache_identities.update(identities)
                        if arm == "caveman" and task["id"] == "data-enumerate-json":
                            self.assertGreaterEqual(len(fixture.recoveries), 1)

    def test_budget_stop_and_unknown_usage_never_dispatch_an_extra_native_request(self):
        task = next(task for task in corpus() if task["id"] == "data-small-noop")
        prices = Prices(*(Decimal(value) for value in ("1", "2", ".1", "1.25", "2", "0")), maximum_input_tokens=100000, maximum_output_tokens=2048)
        for mode in ("normal", "missing_usage", "http_error"):
            with self.subTest(mode=mode), Provider("openai", task, mode) as fixture:
                budget = Budget(prices.reservation, prices)
                receipts, results = [], []
                config = {"provider": "openai", "model": "fixture-model", "endpoint": fixture.url + "/v1", "auth_class": "local_fixture"}
                failure = execute_job({"task": task, "arm": "direct", "rotation": 0, "run_id": "local-native-budget",
                                       "config": config, "api_key": "local-fixture", "endpoint": os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"],
                                       "local_fixture": True}, budget, receipts.append, results.append)
                self.evidence.append({"control": "budget_refusal", "mode": mode, "expected_native_failure": failure,
                                      "observed_provider_requests": len(fixture.requests), "committed_upper_bound_usd": str(budget.committed),
                                      "maximum_spend_usd": str(budget.cap), "results": results, "receipts": receipts})
                self.assertIsNotNone(failure)
                self.assertEqual(len(fixture.requests), 1)
                self.assertEqual(len(receipts), 1)
                self.assertEqual(receipts[0]["sdk_retry_count"], "0")
                self.assertEqual(budget.pending, {})
                self.assertLessEqual(budget.committed, budget.cap)
                if mode == "normal":
                    self.assertTrue(receipts[0]["usage_complete_for_pricing"])
                    self.assertFalse(budget.halted)
                else:
                    self.assertFalse(receipts[0]["usage_complete_for_pricing"])
                    self.assertTrue(budget.halted)
                    self.assertEqual(budget.committed, prices.reservation)


if __name__ == "__main__":
    unittest.main(verbosity=2)
