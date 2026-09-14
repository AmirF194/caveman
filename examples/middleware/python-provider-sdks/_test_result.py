"""Exact unittest results for the central TAP replay driver."""
import json
from pathlib import Path
import unittest


class ReportingResult(unittest.TextTestResult):
    def addSuccess(self, test):
        super().addSuccess(test)
        file = Path(__import__(test.__module__).__file__).resolve()
        root = Path(__file__).resolve().parents[3]
        name = ".".join(test.id().split(".")[-2:])
        print("CAVEMAN_MIDDLEWARE_TEST_RESULT " + json.dumps({"test_id": str(file.relative_to(root)) + "::" + name, "name": name, "result": "passed"}), flush=True)
