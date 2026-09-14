"""Report exact unittest successes for the central native TAP driver."""
import json
from pathlib import Path
import sys
import unittest


class ReportingResult(unittest.TextTestResult):
    def addSuccess(self, test):
        super().addSuccess(test)
        name = ".".join(test.id().split(".")[-2:])
        file = Path(sys.modules[test.__module__].__file__).name
        print("CAVEMAN_MIDDLEWARE_TEST_RESULT " + json.dumps({"test_id": "examples/middleware/agno/" + file + "::" + name, "name": name, "result": "passed"}), flush=True)
