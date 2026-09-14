"""Matched task outcomes and task-clustered uncertainty; no invoice claims."""
from __future__ import annotations

from collections import defaultdict
from decimal import Decimal
import random


def quantile(values, probability):
    values = sorted(values)
    return values[min(len(values) - 1, int((len(values) - 1) * probability))] if values else None


def arm_summary(rows):
    passed = sum(row["passed"] for row in rows)
    known = sum((Decimal(row["estimated_cost_usd"]) for row in rows if row.get("estimated_cost_usd") is not None), Decimal(0))
    upper = sum((Decimal(row["cost_upper_bound_usd"]) for row in rows), Decimal(0))
    complete = bool(rows) and all(row["usage_complete"] for row in rows)
    return {"tasks": len(rows), "passed": passed, "pass_rate": passed / len(rows) if rows else None,
            "usage_complete": complete, "provider_cost_estimate_usd": str(known) if complete else None,
            "known_usage_cost_estimate_usd": str(known), "cost_upper_bound_usd": str(upper),
            "cost_per_passed_task_estimate_usd": str(known / passed) if passed and complete else None,
            "cost_includes_failed_tasks": True, "invoice_reconciled": False,
            "latency_p95_ms": quantile([row["native_total_wall_ms"] for row in rows], .95),
            "host_overhead_p95_ms": quantile([row["host_overhead_ms"] for row in rows], .95),
            "provider_usage": {bucket: {"known_tokens": sum(row.get("provider_usage", {}).get(bucket, {}).get("known_tokens", 0) for row in rows),
                                        "receipts_with_value": sum(row.get("provider_usage", {}).get(bucket, {}).get("receipts_with_value", 0) for row in rows),
                                        "total_receipts": sum(len(row.get("receipt_ids", [])) for row in rows)}
                               for bucket in ("input_uncached", "output", "reasoning", "cache_read", "cache_write_5m", "cache_write_1h")}}


def comparison(rows, candidate, *, full_schedule, bootstrap_samples=10000):
    grouped = defaultdict(lambda: defaultdict(list))
    for row in rows:
        if row["arm"] in ("direct", candidate):
            grouped[row["task_id"]][row["arm"]].append(row)
    keys = sorted(key for key, groups in grouped.items() if set(groups) == {"direct", candidate})
    def outcome(task_keys):
        direct = arm_summary([row for key in task_keys for row in grouped[key]["direct"]])
        tested = arm_summary([row for key in task_keys for row in grouped[key][candidate]])
        difference = tested["pass_rate"] - direct["pass_rate"]
        base, candidate_cost = direct["cost_per_passed_task_estimate_usd"], tested["cost_per_passed_task_estimate_usd"]
        reduction = (1 - float(Decimal(candidate_cost) / Decimal(base))) if base and candidate_cost and Decimal(base) > 0 else None
        return difference, reduction
    if not keys:
        return {"candidate": candidate, "verdict": "inconclusive", "reason": "no_matched_task_clusters"}
    observed_quality, observed_cost = outcome(keys)
    randomizer = random.Random(20260909)
    quality, cost = [], []
    for _ in range(bootstrap_samples):
        q, c = outcome(randomizer.choices(keys, k=len(keys)))
        quality.append(q)
        if c is not None:
            cost.append(c)
    quality_lower = quantile(quality, .025)
    degenerate = max(quality) == min(quality)
    # All-success paired bootstrap samples have zero width. Retain a one-sided
    # unseen-discordance bound across independent task clusters instead of
    # turning a small all-success corpus into a quality-equivalence claim.
    unseen_loss_bound = 1 - .025 ** (1 / len(keys)) if degenerate else None
    if unseen_loss_bound is not None:
        quality_lower = min(quality_lower, observed_quality - unseen_loss_bound)
    cost_lower = quantile(cost, .025)
    matched_counts = all(len(grouped[key]["direct"]) == len(grouped[key][candidate]) >= 3 for key in keys)
    complete_usage = all(row["usage_complete"] for row in rows if row["arm"] in ("direct", candidate))
    qualified = (full_schedule and len(keys) >= 24 and matched_counts and complete_usage and
                 observed_quality >= -.02 and quality_lower >= -.02 and cost_lower is not None and cost_lower > 0)
    return {"candidate": candidate, "reference": "direct", "task_clusters": len(keys),
            "observed_pass_rate_difference": observed_quality, "pass_rate_difference_95_interval": [quality_lower, quantile(quality, .975)],
            "observed_cost_per_passed_task_reduction": observed_cost,
            "cost_reduction_95_interval": [cost_lower, quantile(cost, .975)],
            "bootstrap_samples": bootstrap_samples, "cluster_unit": "task; all rotations retained together",
            "zero_variance_unseen_discordance_bound": unseen_loss_bound,
            "complete_usage": complete_usage, "full_schedule": full_schedule,
            "verdict": "qualifies_within_frozen_corpus" if qualified else "inconclusive",
            "cost_basis": "provider-reported usage multiplied by operator price snapshot; not invoices"}


def report(results, receipts, planned_jobs):
    receipt_index = {row["attempt_id"]: row for row in receipts}
    enriched = []
    for result in results:
        observed = [receipt_index[key] for key in result["receipt_ids"] if key in receipt_index]
        complete = result["usage_complete"] and len(observed) == len(result["receipt_ids"])
        total = sum((Decimal(row["estimated_cost_usd"]) for row in observed if row["estimated_cost_usd"] is not None), Decimal(0))
        upper = sum((Decimal(row["cost_upper_bound_usd"]) for row in observed), Decimal(0))
        usage = {bucket: {"known_tokens": sum(row["usage"][bucket] for row in observed if isinstance(row.get("usage"), dict) and type(row["usage"].get(bucket)) is int),
                          "receipts_with_value": sum(isinstance(row.get("usage"), dict) and type(row["usage"].get(bucket)) is int for row in observed)}
                 for bucket in ("input_uncached", "output", "reasoning", "cache_read", "cache_write_5m", "cache_write_1h")}
        enriched.append({**result, "usage_complete": complete, "provider_usage": usage,
                         "estimated_cost_usd": str(total) if complete else None, "cost_upper_bound_usd": str(upper)})
    expected = {(job["task_id"], job["arm"], job["rotation"], stratum) for job in planned_jobs for stratum in ("cold", "warm")}
    actual = {(row["task_id"], row["arm"], row["rotation"], row["stratum"]) for row in results}
    allocated = {key for row in results for key in row["receipt_ids"]}
    unallocated = [row for row in receipts if row["attempt_id"] not in allocated]
    allocation_list = [key for row in results for key in row["receipt_ids"]]
    invalid_receipt_identity = len(receipt_index) != len(receipts) or len(allocation_list) != len(set(allocation_list))
    full = expected == actual and len(actual) == len(results) and not unallocated and not invalid_receipt_identity
    strata = {}
    for stratum in ("cold", "warm"):
        rows = [row for row in enriched if row["stratum"] == stratum]
        strata[stratum] = {"arms": {arm: arm_summary([row for row in rows if row["arm"] == arm]) for arm in ("direct", "caveman", "headroom")},
                           "comparisons": [comparison(rows, arm, full_schedule=full) for arm in ("caveman", "headroom")]}
    return {"schema_version": 1, "full_scheduled_matrix_observed": full, "planned_task_runs": len(expected),
            "observed_task_runs": len(actual), "missing_task_runs": [list(key) for key in sorted(expected - actual)],
            "strata": strata, "results": enriched,
            "receipt_count": len(receipts), "unallocated_receipt_ids": [row["attempt_id"] for row in unallocated],
            "duplicate_receipt_identity_or_allocation": invalid_receipt_identity,
            "unallocated_cost_upper_bound_usd": str(sum((Decimal(row["cost_upper_bound_usd"]) for row in unallocated), Decimal(0))),
            "small_negative_and_failed_tasks_retained": True,
            "no_universal_quality_or_savings_claim": True}
