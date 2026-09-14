"""Explicit opt-in and per-HTTP-attempt reservation, before native dispatch.

Prices are supplied by the operator with an authoritative source snapshot.
This module contains no default model price and never reads credentials.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from datetime import datetime
import threading
from urllib.parse import urlparse


class Refusal(RuntimeError):
    pass


class BudgetExhausted(Refusal):
    pass


def decimal(value, name, *, positive=False):
    if isinstance(value, (bool, float)):
        raise Refusal(f"{name} must be a decimal string, not a floating-point number")
    try:
        result = Decimal(value)
    except (InvalidOperation, TypeError, ValueError):
        raise Refusal(f"Invalid {name}") from None
    if not result.is_finite() or result < 0 or (positive and result <= 0):
        raise Refusal(f"{name} must be finite and {'positive' if positive else 'nonnegative'}")
    return result


def integer(value, name):
    if type(value) is not int or not 0 < value <= 100_000_000:
        raise Refusal(f"Invalid positive {name}")
    return value


@dataclass(frozen=True)
class Prices:
    input: Decimal
    output: Decimal
    cache_read: Decimal
    cache_write_5m: Decimal
    cache_write_1h: Decimal
    per_request: Decimal
    maximum_input_tokens: int
    maximum_output_tokens: int

    @property
    def reservation(self):
        return (max(self.input, self.cache_read, self.cache_write_5m, self.cache_write_1h)
                * self.maximum_input_tokens + self.output * self.maximum_output_tokens) / 1_000_000 + self.per_request

    def cost(self, usage):
        return (self.input * usage["input_uncached"] + self.output * usage["output"]
                + self.cache_read * usage["cache_read"] + self.cache_write_5m * usage["cache_write_5m"]
                + self.cache_write_1h * usage["cache_write_1h"]) / 1_000_000 + self.per_request


def authorize(provider, opted_in, maximum_spend, config):
    # Keep these checks ahead of dependency imports, credential lookup, or I/O.
    if provider not in ("openai", "anthropic") or provider not in opted_in:
        raise Refusal("Hosted execution requires explicit opt-in for the selected provider")
    cap = decimal(maximum_spend, "maximum spend", positive=True)
    allowed = {"provider", "model", "endpoint", "auth_class", "effort", "pricing_source", "rates_usd_per_million",
               "per_request_usd", "maximum_input_tokens", "maximum_output_tokens"}
    if not isinstance(config, dict) or set(config) - allowed:
        raise Refusal("Provider configuration contains unknown fields; credentials do not belong in this file")
    if config.get("provider") != provider or not isinstance(config.get("model"), str) or not config["model"]:
        raise Refusal("An exact provider and model pricing configuration is required")
    expected = "https://api.openai.com/v1" if provider == "openai" else "https://api.anthropic.com"
    if config.get("endpoint") != expected or config.get("auth_class") != "api_key":
        raise Refusal("This harness certifies direct API-key endpoints only; other authentication has a coverage gap")
    source = config.get("pricing_source", {})
    if not isinstance(source, dict) or set(source) != {"url", "retrieved_at", "sha256"}:
        raise Refusal("Pricing source requires exactly URL, retrieval date and SHA256")
    source_url = urlparse(source.get("url", ""))
    source_host = source_url.hostname
    allowed_sources = {"openai.com", "platform.openai.com", "developers.openai.com"} if provider == "openai" else {"anthropic.com", "www.anthropic.com", "platform.claude.com"}
    if source_url.scheme != "https" or source_url.username or source_url.password or source_host not in allowed_sources or not isinstance(source.get("retrieved_at"), str):
        raise Refusal("Pricing requires an authoritative provider source URL and retrieval date")
    try:
        datetime.fromisoformat(source["retrieved_at"].replace("Z", "+00:00"))
    except ValueError:
        raise Refusal("Pricing retrieval date must use ISO8601") from None
    if not isinstance(source.get("sha256"), str) or len(source["sha256"]) != 64 or any(c not in "0123456789abcdef" for c in source["sha256"]):
        raise Refusal("Pricing requires the SHA256 of the retained source snapshot")
    rates = config.get("rates_usd_per_million", {})
    prices = Prices(*(decimal(rates.get(key), key, positive=key in ("input", "output"))
                      for key in ("input", "output", "cache_read", "cache_write_5m", "cache_write_1h")),
                    per_request=decimal(config.get("per_request_usd", "0"), "per-request price"),
                    maximum_input_tokens=integer(config.get("maximum_input_tokens"), "model input token ceiling"),
                    maximum_output_tokens=integer(config.get("maximum_output_tokens"), "output token ceiling"))
    if prices.maximum_output_tokens < 2048:
        raise Refusal("The frozen task output limit is 2048 tokens")
    if prices.reservation > cap:
        raise BudgetExhausted("Budget cannot reserve one worst-case provider request under this pricing snapshot")
    return cap, prices


def normalized_usage(provider, raw):
    if not isinstance(raw, dict):
        return None
    def number(name, default=None):
        value = raw.get(name, default)
        return value if type(value) is int and value >= 0 else None
    if provider == "openai":
        total_input, output = number("prompt_tokens"), number("completion_tokens")
        details = raw.get("prompt_tokens_details")
        cache_read = details.get("cached_tokens") if isinstance(details, dict) else None
        output_details = raw.get("completion_tokens_details")
        reasoning = output_details.get("reasoning_tokens") if isinstance(output_details, dict) else None
        if total_input is None or output is None or type(cache_read) is not int or not 0 <= cache_read <= total_input:
            return None
        return {"input_uncached": total_input - cache_read, "output": output, "cache_read": cache_read,
                "cache_write_5m": 0, "cache_write_1h": 0,
                "reasoning": reasoning if type(reasoning) is int and 0 <= reasoning <= output else None}
    uncached, output, cache_read, cache_write = (number(key) for key in
        ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))
    if any(value is None for value in (uncached, output, cache_read, cache_write)):
        return None
    creation = raw.get("cache_creation")
    if cache_write == 0:
        five, hour = 0, 0
    elif isinstance(creation, dict):
        five, hour = creation.get("ephemeral_5m_input_tokens"), creation.get("ephemeral_1h_input_tokens")
        if type(five) is not int or type(hour) is not int or min(five, hour) < 0 or five + hour != cache_write:
            return None
    else:
        # Unknown cache TTL must not be priced as the cheaper write bucket.
        return None
    return {"input_uncached": uncached, "output": output, "cache_read": cache_read,
            "cache_write_5m": five, "cache_write_1h": hour, "reasoning": None}


class Budget:
    def __init__(self, maximum_spend, prices):
        self.cap, self.prices = maximum_spend, prices
        self.committed = Decimal(0)
        self.pending = {}
        self.halted = False
        self.lock = threading.Lock()

    def reserve(self, attempt_id):
        with self.lock:
            if self.halted:
                raise BudgetExhausted("Scheduling stopped after incomplete usage or a price-bound violation")
            if attempt_id in self.pending:
                raise Refusal("Duplicate physical provider attempt ID")
            reserved = sum(self.pending.values(), Decimal(0))
            if self.committed + reserved + self.prices.reservation > self.cap:
                raise BudgetExhausted("Maximum spend reached; no new provider request scheduled")
            self.pending[attempt_id] = self.prices.reservation
            return self.prices.reservation

    def settle(self, attempt_id, usage):
        with self.lock:
            reservation = self.pending.pop(attempt_id)
            estimate = self.prices.cost(usage) if usage is not None else None
            if estimate is None:
                self.committed += reservation
                self.halted = True
            else:
                self.committed += estimate
                if estimate > reservation:
                    self.halted = True
            return {"estimated_cost_usd": str(estimate) if estimate is not None else None,
                    "cost_upper_bound_usd": str(estimate if estimate is not None else reservation),
                    "usage_complete_for_pricing": usage is not None,
                    "reservation_exceeded": estimate is not None and estimate > reservation}
