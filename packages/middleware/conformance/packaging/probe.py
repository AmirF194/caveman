"""Validate installed wheel origins, declarations and typed-package markers."""
import importlib
import importlib.metadata as metadata
import hashlib
import json
import os
import platform
import sys
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
root = Path(sys.prefix).resolve()
config = json.loads(Path(sys.argv[1]).read_text())
assert "PYTHONPATH" not in os.environ
assert "PYTHONHOME" not in os.environ
origins = {}
for name in ["caveman_cloud", "caveman_cloud.middleware", "caveman_middleware", *config["imports"]]:
    module = importlib.import_module(name)
    paths = ([module.__file__] if getattr(module, "__file__", None) else list(module.__path__))
    for path in paths:
        assert Path(path).resolve().is_relative_to(root), (name, path, root)
    origins[name] = paths

installed = {dist.metadata["Name"]: dist.version for dist in metadata.distributions()}
declarations = {}
for name, package in [("caveman-sdk", "caveman_cloud"), ("caveman-middleware", "caveman_middleware")]:
    dist = metadata.distribution(name)
    declarations[name] = {"version": dist.version, "requires": dist.requires or [],
                          "requires_python": dist.metadata.get("Requires-Python")}
    assert (Path(importlib.import_module(package).__file__).parent / "py.typed").is_file()
    direct = json.loads(dist.read_text("direct_url.json"))
    archive = urlparse(direct["url"])
    # uv 0.7 records the verified hash in the URL fragment; pip may use archive_info.
    digest = direct.get("archive_info", {}).get("hashes", {}).get("sha256")
    digest = digest or parse_qs(archive.fragment).get("sha256", [None])[0]
    assert archive.scheme == "file" and digest, direct
    assert hashlib.sha256(Path(unquote(archive.path)).read_bytes()).hexdigest() == digest
    assert not direct.get("dir_info", {}).get("editable", False), direct

assert declarations["caveman-sdk"]["requires"] == []
core_requires = [value for value in declarations["caveman-middleware"]["requires"] if "extra ==" not in value]
assert core_requires == ["caveman-sdk==1.0.0"], core_requires
if config["core"]:
    assert set(installed) == {"caveman-sdk", "caveman-middleware"}, installed

result = {"python": platform.python_version(), "platform": platform.platform(),
          "machine": platform.machine(), "prefix": str(root), "imports": origins,
          "installed": installed, "declarations": declarations,
          "py_typed": True, "editable": False, "pythonpath": False,
          "static_typecheck": "recorded by the separate consumer type-check stage"}
Path(sys.argv[2]).write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({"package_probe": "passed", "packages": len(installed)}))
