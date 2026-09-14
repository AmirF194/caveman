"""Exact native version gates without importing unrelated frameworks."""
from functools import lru_cache
from importlib.metadata import PackageNotFoundError, version


@lru_cache(maxsize=32)
def installed_version(name):
    try:
        return version(name)
    except (PackageNotFoundError, ValueError, OSError):
        return None


def matches_framework(*pins):
    """Pure version check for adapters retaining a passive per-call delegate."""
    return all(installed_version(name) == expected for name, expected in pins)


def supports_framework(runtime, *pins):
    if runtime.mode == "off":
        return False
    if matches_framework(*pins):
        return True
    runtime.decline("unsupported_version")
    return False
