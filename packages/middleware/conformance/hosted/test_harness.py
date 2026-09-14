"""Offline authorization, accounting, task-oracle and rotation checks."""
from __future__ import annotations

import copy
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from budget import Budget, BudgetExhausted, Prices, Refusal, authorize, normalized_usage
from oracles import grade, python_cases
from report import comparison
from run import corpus, main, schedule


def prices():
    return Prices(*(Decimal(value) for value in ("1", "3", ".1", "1.25", "2", "0")),
                  maximum_input_tokens=1000, maximum_output_tokens=2048)


class ControlTests(unittest.TestCase):
    def test_refuses_before_environment_credentials_or_provider_import(self):
        native_get = os.environ.get
        def no_credentials(key, default=None):
            if any(word in key.upper() for word in ("API_KEY", "TOKEN", "SECRET", "CREDENTIAL")):
                raise AssertionError("credential lookup before refusal")
            return native_get(key, default)
        for arguments in (["--run"], ["--run", "--provider", "openai"],
                          ["--run", "--provider", "openai", "--opt-in-provider", "openai"],
                          ["--run", "--provider", "openai", "--opt-in-provider", "openai", "--max-spend-usd", "0"]):
            with self.subTest(arguments=arguments), patch.object(os.environ, "get", side_effect=no_credentials):
                with self.assertRaises(Refusal):
                    main(arguments)

    def test_complete_configuration_and_retained_source_are_checked_before_credentials(self):
        content = b"Offline synthetic pricing-control fixture; not provider pricing."
        config = {"provider": "openai", "model": "control-model", "endpoint": "https://api.openai.com/v1", "auth_class": "api_key",
                  "effort": None, "maximum_input_tokens": 1000, "maximum_output_tokens": 2048,
                  "rates_usd_per_million": {"input": "1", "output": "3", "cache_read": ".1", "cache_write_5m": "0", "cache_write_1h": "0"},
                  "per_request_usd": "0", "pricing_source": {"url": "https://openai.com/api/pricing/", "retrieved_at": "2026-09-09T00:00:00Z", "sha256": hashlib.sha256(content).hexdigest()}}
        cap, costs = authorize("openai", ["openai"], "1", config)
        self.assertEqual(cap, Decimal(1))
        self.assertGreater(costs.reservation, 0)
        for invalid in ({**config, "api_key": "must-not-be-read"}, {**config, "endpoint": "https://elsewhere.invalid/v1"},
                        {**config, "pricing_source": {**config["pricing_source"], "url": "https://user:password@openai.com/api/pricing/"}}):
            with self.assertRaises(Refusal): authorize("openai", ["openai"], "1", invalid)
        with tempfile.TemporaryDirectory(prefix="caveman-pricing-control-") as directory:
            root = Path(directory)
            (root / "config.json").write_text(json.dumps(config))
            (root / "pricing.txt").write_text("changed retained pricing source")
            native_get = os.environ.get
            def no_credentials(key, default=None):
                if key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY"):
                    raise AssertionError("credential lookup before source digest check")
                return native_get(key, default)
            with patch.object(os.environ, "get", side_effect=no_credentials), self.assertRaisesRegex(Refusal, "digest"):
                main(["--run", "--provider", "openai", "--opt-in-provider", "openai", "--max-spend-usd", "1",
                      "--config", str(root / "config.json"), "--pricing-source-file", str(root / "pricing.txt"),
                      "--runtime-binary", str(root / "unused-runtime"), "--output", str(root / "new-output")])

    def test_budget_reserves_each_attempt_and_never_refunds_missing_usage(self):
        costs = prices()
        budget = Budget(costs.reservation * 2, costs)
        budget.reserve("one"); budget.reserve("two")
        with self.assertRaises(BudgetExhausted): budget.reserve("three")
        outcome = budget.settle("one", None)
        self.assertFalse(outcome["usage_complete_for_pricing"])
        self.assertIsNone(outcome["estimated_cost_usd"])
        self.assertEqual(budget.committed, costs.reservation)
        budget.settle("two", {"input_uncached": 100, "output": 3, "cache_read": 0, "cache_write_5m": 0, "cache_write_1h": 0})
        with self.assertRaises(BudgetExhausted): budget.reserve("four")
        self.assertEqual(budget.pending, {})

    def test_cache_buckets_and_reasoning_are_not_double_counted(self):
        openai = normalized_usage("openai", {"prompt_tokens": 100, "completion_tokens": 30,
                                             "prompt_tokens_details": {"cached_tokens": 80},
                                             "completion_tokens_details": {"reasoning_tokens": 20}})
        self.assertEqual(openai, {"input_uncached": 20, "output": 30, "cache_read": 80, "cache_write_5m": 0, "cache_write_1h": 0, "reasoning": 20})
        self.assertIsNone(normalized_usage("openai", {"prompt_tokens": 100, "completion_tokens": 30}))
        anthropic = normalized_usage("anthropic", {"input_tokens": 10, "output_tokens": 4,
                                                    "cache_read_input_tokens": 50, "cache_creation_input_tokens": 30,
                                                    "cache_creation": {"ephemeral_5m_input_tokens": 20, "ephemeral_1h_input_tokens": 10}})
        self.assertEqual(anthropic["input_uncached"], 10)
        self.assertEqual(anthropic["cache_write_5m"], 20)
        self.assertIsNone(normalized_usage("anthropic", {"input_tokens": 10, "output_tokens": 4, "cache_read_input_tokens": 50, "cache_creation_input_tokens": 30}))

    def test_all_24_tasks_rotations_and_small_negative_strata_are_frozen(self):
        tasks = corpus()
        self.assertEqual(len(tasks), 24)
        self.assertEqual({category: sum(t["category"] == category for t in tasks) for category in {t["category"] for t in tasks}},
                         {"coding": 6, "rag": 6, "structured_data": 6, "tool_work": 6})
        self.assertTrue(any(t["strata"]["small_or_noop"] for t in tasks))
        self.assertTrue(any(t["strata"]["negative"] for t in tasks))
        jobs = schedule(tasks)
        self.assertEqual(len(jobs) * 2, 432)
        for task in tasks:
            observed = [job for job in jobs if job["task_id"] == task["id"]]
            self.assertEqual(len(observed), 9)
            self.assertEqual({tuple(job["arm"] for job in observed if job["rotation"] == rotation) for rotation in range(3)},
                             {("direct", "caveman", "headroom"), ("caveman", "headroom", "direct"), ("headroom", "direct", "caveman")})

    def test_data_and_citation_oracles_reject_wrong_answers_and_forged_citations(self):
        for task in corpus():
            oracle = task["oracle"]
            if oracle["kind"] == "python_function": continue
            answer = oracle.get("expected") or {"answer": oracle["expected_answer"], "citations": oracle["citations"]}
            self.assertTrue(grade(task, json.dumps(answer, ensure_ascii=False), task["files"], list(task["files"]))["passed"], task["id"])
            self.assertFalse(grade(task, "{}", task["files"], list(task["files"]))["passed"], task["id"])
        task = next(task for task in corpus() if task["id"] == "rag-duplicate-source")
        self.assertFalse(grade(task, json.dumps({"answer": "14 days", "citations": [{"source": "policy-a.txt", "quote": "The standard retention window is 14 days."}]}), task["files"], ["policy-a.txt"])["passed"])

    def test_hidden_coding_oracle_runs_correct_code_and_rejects_all_original_bugs(self):
        corrected = {
            "code-active-totals": "def sum_active(rows):\n    return sum(r.get('amount',0) for r in rows if r.get('active') is True)\n",
            "code-normalize-tags": "def normalize_tags(tags):\n    output=[]\n    for tag in tags:\n        text=tag.strip().lower()\n        if text and text not in output: output.append(text)\n    return output\n",
            "code-interval-union": "def merge_intervals(intervals):\n    output=[]\n    for start,end in sorted(intervals):\n        if output and start<=output[-1][1]: output[-1][1]=max(output[-1][1],end)\n        else: output.append([start,end])\n    return output\n",
            "code-page-boundary": "def page(items,index,size):\n    return [] if index<0 or size<=0 else items[index*size:(index+1)*size]\n",
            "code-safe-ratio": "def safe_ratio(numerator,denominator):\n    return round(numerator/denominator,4) if denominator else None\n",
            "code-duration-units": "def duration_ms(text):\n    text=text.strip()\n    for unit,mult in [('ms',1),('min',60000),('s',1000)]:\n        if text.endswith(unit):\n            try: value=float(text[:-len(unit)])\n            except ValueError: return None\n            return round(value*mult) if value>=0 else None\n    return None\n",
        }
        for task in corpus():
            if task["category"] != "coding": continue
            with self.subTest(task=task["id"]):
                self.assertFalse(grade(task, '{"done":true}', task["files"], list(task["files"]))["passed"])
                files = {**task["files"], "solution.py": corrected[task["id"]]}
                outcome = grade(task, '{"done":true}', files, list(files))
                self.assertTrue(outcome["passed"], outcome)
        self.assertFalse(python_cases("import os\ndef f(): return os.environ\n", "f", [{"args": [], "expected": {}}])["passed"])
        self.assertFalse(python_cases("def f(): return (1).__class__\n", "f", [{"args": [], "expected": 1}])["passed"])
        self.assertFalse(python_cases("def f(): return True\n", "f", [{"args": [], "expected": 1}])["passed"])
        self.assertFalse(python_cases("sum(range(10))\ndef f(): return 1\n", "f", [{"args": [], "expected": 1}])["passed"])

    def test_small_all_success_trial_stays_inconclusive_and_failed_costs_stay_counted(self):
        rows = [{"task_id": f"task-{task}", "rotation": rotation, "arm": arm, "passed": True,
                 "usage_complete": True, "estimated_cost_usd": "1" if arm == "direct" else ".5",
                 "cost_upper_bound_usd": "1" if arm == "direct" else ".5", "native_total_wall_ms": 10, "host_overhead_ms": 1}
                for task in range(24) for rotation in range(3) for arm in ("direct", "caveman")]
        result = comparison(rows, "caveman", full_schedule=True, bootstrap_samples=200)
        self.assertEqual(result["observed_cost_per_passed_task_reduction"], .5)
        self.assertEqual(result["verdict"], "inconclusive")
        self.assertLess(result["pass_rate_difference_95_interval"][0], -.02)
        from report import arm_summary
        sample = [dict(rows[0], passed=False), dict(rows[0], passed=True)]
        self.assertEqual(arm_summary(sample)["cost_per_passed_task_estimate_usd"], "2")


if __name__ == "__main__":
    unittest.main(verbosity=2)
