"""Native HTTPX2 transport decorator; byte forwarding and physical receipts."""
from __future__ import annotations

import hashlib
import json
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx2

from budget import Refusal, normalized_usage


def redacted_usage(raw):
    """Provider usage may gain fields; retain only known numeric accounting."""
    numeric = {"prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens",
               "cache_read_input_tokens", "cache_creation_input_tokens", "cached_tokens", "reasoning_tokens",
               "ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens", "audio_tokens",
               "accepted_prediction_tokens", "rejected_prediction_tokens"}
    nested = {"prompt_tokens_details", "completion_tokens_details", "cache_creation"}
    return {key: (redacted_usage(value) if key in nested and isinstance(value, dict) else value)
            for key, value in raw.items()
            if (key in numeric and type(value) is int and value >= 0) or (key in nested and isinstance(value, dict))}


class Capture:
    def __init__(self, provider, content_type):
        self.provider = provider
        self.streaming = "text/event-stream" in content_type
        self.pending = bytearray()
        self.hash = hashlib.sha256()
        self.bytes = 0
        self.usage = {}
        self.overflow = False
        self.first_byte_at = None
        self.saw_terminal = False
        self.protocol_done = False

    def event(self, value):
        if not isinstance(value, dict):
            return
        if self.provider == "openai":
            if isinstance(value.get("usage"), dict):
                self.usage = value["usage"]
            if not self.streaming or any(choice.get("finish_reason") is not None for choice in value.get("choices", []) if isinstance(choice, dict)):
                self.saw_terminal = True
        else:
            if value.get("type") == "message_start" and isinstance(value.get("message"), dict):
                self.usage.update(value["message"].get("usage") or {})
            if isinstance(value.get("usage"), dict):
                self.usage.update(value["usage"])
            if value.get("type") in ("message", "message_stop"):
                self.saw_terminal = True
                self.protocol_done = True

    def feed(self, chunk):
        if self.first_byte_at is None:
            self.first_byte_at = time.perf_counter()
        self.hash.update(chunk)
        self.bytes += len(chunk)
        if self.overflow:
            return
        self.pending.extend(chunk)
        if self.streaming:
            while b"\n" in self.pending:
                line, _, rest = self.pending.partition(b"\n")
                self.pending = bytearray(rest)
                if line.startswith(b"data:"):
                    payload = line[5:].strip()
                    if payload == b"[DONE]":
                        self.protocol_done = True
                        continue
                    try:
                        self.event(json.loads(payload))
                    except (ValueError, UnicodeError):
                        self.overflow = True
            limit = 128 * 1024
        else:
            limit = 2 * 1024 * 1024
        if len(self.pending) > limit:
            self.pending.clear()
            self.overflow = True

    def finish(self):
        if not self.streaming and not self.overflow:
            try:
                self.event(json.loads(self.pending))
            except (ValueError, UnicodeError):
                self.overflow = True
        self.pending.clear()
        return normalized_usage(self.provider, self.usage) if self.saw_terminal and not self.overflow else None


class ObservedStream(httpx2.SyncByteStream):
    def __init__(self, stream, attempt, finish):
        self.stream, self.attempt, self.finish_attempt = stream, attempt, finish
        self.capture = Capture(attempt["provider"], attempt["response_content_type"])
        self.finished = False

    def finish(self, event, error=None):
        if self.finished:
            return
        self.finished = True
        usage = self.capture.finish() if event == "completed" else None
        self.finish_attempt(self.attempt, event, usage, self.capture, error)

    def __iter__(self):
        try:
            for chunk in self.stream:
                self.capture.feed(chunk)
                yield chunk
            self.finish("completed" if self.attempt["http_status"] < 400 else "failed")
        except BaseException as error:
            self.finish("failed", type(error).__name__)
            raise

    def close(self):
        try:
            self.stream.close()
        finally:
            # Native SDKs stop at their protocol sentinel and then close the
            # HTTP iterator. That is completion even without another EOF read.
            completed = self.capture.protocol_done and self.attempt["http_status"] < 400
            self.finish("completed" if completed else "cancelled")


class MeteredTransport(httpx2.BaseTransport):
    def __init__(self, transport, *, config, budget, emit, task_metadata, maximum_calls, local_fixture=False):
        self.transport, self.config, self.budget, self.emit = transport, config, budget, emit
        self.task_metadata = task_metadata
        self.maximum_calls, self.calls = maximum_calls, 0
        self.receipts = []
        self.local_fixture = local_fixture

    def handle_request(self, request):
        expected, actual = urlparse(self.config["endpoint"]), urlparse(str(request.url))
        path = "/v1/chat/completions" if self.config["provider"] == "openai" else "/v1/messages"
        if (actual.scheme, actual.netloc, actual.path) != (expected.scheme, expected.netloc, path) or actual.query or actual.fragment:
            raise Refusal("Provider request escaped the exact configured native endpoint")
        if self.local_fixture and actual.hostname not in ("127.0.0.1", "::1", "localhost"):
            raise Refusal("Local fixture endpoint must be loopback")
        body = request.read()
        if len(body) > 2 * 1024 * 1024:
            raise Refusal("Frozen comparison request limit exceeded")
        value = json.loads(body)
        output_limit = value.get("max_completion_tokens", value.get("max_tokens"))
        if value.get("model") != self.config["model"] or type(output_limit) is not int or not 0 < output_limit <= 2048:
            raise Refusal("Native model or output limit drifted from the frozen task configuration")
        if self.calls >= self.maximum_calls:
            raise Refusal("Frozen task provider-call limit exceeded")
        attempt_id = str(uuid.uuid4())
        reservation = self.budget.reserve(attempt_id)
        self.calls += 1
        attempt = {**self.task_metadata, "attempt_id": attempt_id, "provider": self.config["provider"],
                   "provider_endpoint": self.config["endpoint"], "model": self.config["model"],
                   "auth_class": "local_fixture" if self.local_fixture else self.config["auth_class"],
                   "date": datetime.now(timezone.utc).isoformat(), "request_bytes": len(body),
                   "request_sha256": hashlib.sha256(body).hexdigest(), "stream": value.get("stream") is True,
                   "reservation_usd": str(reservation), "started_monotonic": time.perf_counter(),
                   "request_ordinal": self.calls, "recovery_marker_on_wire": b"cmw_" in body,
                   "native_tools_sha256": hashlib.sha256(json.dumps(value.get("tools", []), sort_keys=True).encode()).hexdigest(),
                   "cache_identity_sha256": hashlib.sha256(str(value.get("prompt_cache_key", "")).encode()).hexdigest(),
                   "sdk_retry_count": request.headers.get("x-stainless-retry-count"),
                   "evidence_class": "local_provider_fixture" if self.local_fixture else "real_provider_receipt"}
        try:
            response = self.transport.handle_request(request)
        except BaseException as error:
            self.finish(attempt, "failed", None, None, type(error).__name__)
            raise
        attempt.update(http_status=response.status_code,
                       response_content_type=response.headers.get("content-type", ""),
                       provider_request_id=response.headers.get("x-request-id") or response.headers.get("request-id"))
        return httpx2.Response(response.status_code, headers=response.headers,
                               stream=ObservedStream(response.stream, attempt, self.finish), extensions=response.extensions)

    def finish(self, attempt, event, usage, capture, error=None):
        pricing = self.budget.settle(attempt["attempt_id"], usage)
        started = attempt.pop("started_monotonic")
        receipt = {**attempt, **pricing, "event": event, "usage": usage,
                   "raw_redacted_usage": redacted_usage(capture.usage) if capture is not None else None,
                   "response_sha256": capture.hash.hexdigest() if capture is not None else None,
                   "response_bytes": capture.bytes if capture is not None else 0,
                   "provider_wall_ms": (time.perf_counter() - started) * 1000,
                   "first_response_byte_ms": ((capture.first_byte_at - started) * 1000
                                              if capture is not None and capture.first_byte_at is not None else None),
                   "error_class": error, "cost_basis": "operator_price_snapshot_estimate",
                   "invoice_reconciled": False}
        self.receipts.append(receipt)
        self.emit(receipt)

    def close(self):
        self.transport.close()
