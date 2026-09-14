"""Report actual native unittest successes to the central TAP host."""
import json
import unittest


class ReportingResult(unittest.TextTestResult):
    def addSuccess(self, test):
        super().addSuccess(test)
        name = ".".join(test.id().split(".")[-2:])
        print("CAVEMAN_MIDDLEWARE_TEST_RESULT " + json.dumps({"test_id": "examples/middleware/crewai/test_native.py::" + name, "name": name, "result": "passed"}), flush=True)
