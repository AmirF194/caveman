"""Task grading; hidden cases never enter the application tool inventory."""
from __future__ import annotations

import ast
import copy
import json
import multiprocessing
import subprocess
import time


def final_json(text):
    text = text.strip()
    if text.startswith("```json\n") and text.endswith("\n```"):
        text = text[8:-4]
    return json.loads(text)


def same_value(actual, expected):
    """Exact JSON/Python scalar types, including bool versus int, are graded."""
    if type(actual) is not type(expected):
        return False
    if isinstance(expected, dict):
        return actual.keys() == expected.keys() and all(same_value(actual[key], value) for key, value in expected.items())
    if isinstance(expected, (list, tuple)):
        return len(actual) == len(expected) and all(same_value(left, right) for left, right in zip(actual, expected))
    return actual == expected


# The coding corpus deliberately uses a small pure-Python function subset.
# No imports, I/O, reflection, dynamic execution, process or network access.
SAFE_BUILTINS = {"sum": sum, "len": len, "sorted": sorted, "set": set, "list": list,
                 "dict": dict, "tuple": tuple, "range": range, "enumerate": enumerate,
                 "zip": zip, "min": min, "max": max, "abs": abs, "round": round,
                 "int": int, "float": float, "str": str, "bool": bool,
                 "ValueError": ValueError, "TypeError": TypeError}
SAFE_METHODS = {"get", "items", "keys", "values", "append", "extend", "strip", "lower",
                "endswith", "startswith", "isdigit", "replace", "split", "copy", "sort"}
DENIED_NODES = (ast.Import, ast.ImportFrom, ast.ClassDef, ast.Lambda, ast.Global,
                ast.Nonlocal, ast.With, ast.AsyncWith, ast.AsyncFunctionDef,
                ast.Await, ast.Yield, ast.YieldFrom, ast.Delete)


def check_source(source, symbol):
    if len(source.encode()) > 16384:
        raise ValueError("coding_source_too_large")
    tree = ast.parse(source)
    if len(list(ast.walk(tree))) > 1500:
        raise ValueError("coding_ast_too_large")
    functions = {node.name for node in tree.body if isinstance(node, ast.FunctionDef)}
    def declaration(node):
        return isinstance(node, ast.FunctionDef) or (isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str))
    if symbol not in functions or any(not declaration(node) for node in tree.body):
        raise ValueError("coding_requires_pure_functions")
    for node in ast.walk(tree):
        if isinstance(node, DENIED_NODES):
            raise ValueError("coding_forbidden_statement")
        if isinstance(node, ast.Name) and node.id.startswith("_"):
            raise ValueError("coding_private_name")
        if isinstance(node, ast.Attribute) and node.attr not in SAFE_METHODS:
            raise ValueError("coding_forbidden_attribute")
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id not in SAFE_BUILTINS and node.func.id not in functions:
                raise ValueError("coding_forbidden_call")
            if not isinstance(node.func, (ast.Name, ast.Attribute)):
                raise ValueError("coding_indirect_call")
    return tree


def _execute(source, symbol, cases, connection):
    try:
        try:
            import resource
            resource.setrlimit(resource.RLIMIT_CPU, (2, 2))
            try:
                resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
                memory_limit = "kernel_address_space"
            except (ValueError, OSError):
                memory_limit = "parent_rss_sampling"
        except ImportError:
            memory_limit = "parent_rss_sampling"
        namespace = {"__builtins__": SAFE_BUILTINS}
        exec(compile(check_source(source, symbol), "<task-solution>", "exec"), namespace)
        passed = []
        for case in cases:
            arguments = copy.deepcopy(case["args"])
            before = copy.deepcopy(arguments)
            actual = namespace[symbol](*arguments)
            passed.append(same_value(actual, case["expected"]) and same_value(arguments, before))
        connection.send({"passed": all(passed), "cases": len(passed), "cases_passed": sum(passed), "memory_limit": memory_limit})
    except BaseException as error:
        connection.send({"passed": False, "error_class": type(error).__name__})
    finally:
        connection.close()


def python_cases(source, symbol, cases):
    # Validate before process creation as well; no model text enters a shell.
    try:
        check_source(source, symbol)
    except (ValueError, SyntaxError) as error:
        return {"passed": False, "error_class": type(error).__name__}
    context = multiprocessing.get_context("spawn")
    receive, send = context.Pipe(duplex=False)
    process = context.Process(target=_execute, args=(source, symbol, cases, send))
    process.start()
    send.close()
    try:
        deadline = time.monotonic() + 5
        while not receive.poll(.025):
            if time.monotonic() >= deadline:
                return {"passed": False, "error_class": "OracleDeadline"}
            try:
                observed = subprocess.run(["/bin/ps", "-o", "rss=", "-p", str(process.pid)], capture_output=True, text=True, timeout=.25)
                if observed.returncode == 0 and int(observed.stdout.strip() or "0") * 1024 > 256 * 1024 * 1024:
                    return {"passed": False, "error_class": "OracleMemoryLimit"}
            except (OSError, ValueError, subprocess.TimeoutExpired):
                return {"passed": False, "error_class": "OracleMemoryMonitorUnavailable"}
        try:
            return receive.recv()
        except EOFError:
            return {"passed": False, "error_class": "OracleProcessExit"}
    finally:
        receive.close()
        process.join(0.1)
        if process.is_alive():
            process.terminate()
            process.join(1)


def grade(task, text, files, reads):
    oracle = task["oracle"]
    result = {"passed": False, "oracle": oracle["kind"],
              "source_read_requirement": len(set(reads)) >= oracle["minimum_distinct_source_reads"]}
    try:
        actual = final_json(text)
        if oracle["kind"] == "python_function":
            result.update(python_cases(files[oracle["path"]], oracle["symbol"], oracle["cases"]))
            result["passed"] = result["passed"] and same_value(actual, {"done": True})
        elif oracle["kind"] == "json":
            result["passed"] = same_value(actual, oracle["expected"])
        else:
            expected = {"answer": oracle["expected_answer"], "citations": oracle["citations"]}
            result["passed"] = same_value(actual, expected) and all(c["quote"] in files[c["source"]] for c in actual["citations"])
    except (ValueError, TypeError, KeyError):
        result["parse_or_shape_error"] = True
    result["passed"] = result["passed"] and result["source_read_requirement"]
    return result
