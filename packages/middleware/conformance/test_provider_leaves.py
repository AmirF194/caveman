"""Native provider fields are recognized without accepting alternate tool authority."""
import copy
import unittest

from caveman_middleware._native import leaves


class NativeProviderLeaves(unittest.TestCase):
    def test_responses_null_caller_fields_keep_original_call_and_reject_scoped_callers(self):
        call = {"type": "function_call", "call_id": "read-1", "name": "read_logs", "arguments": "{}", "id": "fc_read-1",
                "status": "completed", "caller": None, "namespace": None}
        result = {"type": "function_call_output", "call_id": "read-1", "output": "original"}
        body = {"input": [call, result]}
        before = copy.deepcopy(body)
        selected = leaves(body, "openai-responses")
        self.assertEqual(selected[1], [(("input", 1, "output"), "original")])
        self.assertEqual(body, before)
        for extra in ({"caller": {"type": "code_interpreter"}}, {"namespace": "remote_tools"}, {"namespace": ""}, {"caller": False}, {"unexpected": None}):
            with self.subTest(extra=extra):
                self.assertEqual(leaves({"input": [{**call, **extra}, result]}, "openai-responses")[1], [])


if __name__ == "__main__":
    unittest.main()
