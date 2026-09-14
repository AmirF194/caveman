"""Hash the installed distribution payloads used by every comparison arm."""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
from pathlib import Path

from budget import Refusal


def distribution_provenance():
    distributions = []
    for distribution in sorted(importlib.metadata.distributions(), key=lambda value: value.metadata["Name"].lower()):
        direct_url = distribution.read_text("direct_url.json")
        if direct_url and json.loads(direct_url).get("dir_info", {}).get("editable"):
            raise Refusal("Comparison dependencies must be installed artifacts, not editable source trees")
        files = []
        for item in distribution.files or []:
            if str(item).endswith(".pyc") or "__pycache__" in item.parts:
                continue
            path = Path(distribution.locate_file(item))
            if not path.is_file():
                raise Refusal("Installed dependency is missing a recorded payload file")
            content = path.read_bytes()
            files.append({"path": str(item), "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()})
        if not files:
            raise Refusal("Installed dependency has no recorded distribution payload")
        files.sort(key=lambda item: item["path"])
        manifest = json.dumps(files, sort_keys=True, separators=(",", ":")).encode()
        distributions.append({"name": distribution.metadata["Name"], "version": distribution.version,
                              "payload_manifest_sha256": hashlib.sha256(manifest).hexdigest(), "files": files})
    return {"schema_version": 1, "evidence_class": "installed_distribution_payload_hashes",
            "includes_native_binaries": True, "bytecode_excluded": True, "distributions": distributions}
