"""Record registry versions for the middleware compatibility matrix.

This command only reads public package metadata. It does not install or execute
packages. Re-running deliberately updates the proposed pins; conformance evidence
must be regenerated before a changed pin can be called supported.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import urlopen

NPM = (
    "ai", "@ai-sdk/provider", "@ai-sdk/provider-utils", "@ai-sdk/openai",
    "@ai-sdk/anthropic", "@ai-sdk/google", "openai", "@anthropic-ai/sdk",
    "@google/genai", "langchain", "@langchain/core", "@langchain/langgraph",
    "@langchain/openai", "@langchain/anthropic", "@strands-agents/sdk",
    "@modelcontextprotocol/sdk", "@mastra/core",
)
PYPI = (
    "openai", "anthropic", "google-genai", "langchain", "langchain-core",
    "langgraph", "langchain-openai", "langchain-anthropic", "litellm", "agno", "strands-agents", "crewai",
    "autogen-agentchat", "autogen-core", "autogen-ext", "fastapi", "starlette",
    "mcp", "pydantic-ai", "llama-index-core", "llama-index-llms-openai",
    "llama-index-llms-anthropic",
)


def metadata(registry: str, name: str) -> dict:
    url = (
        f"https://registry.npmjs.org/{quote(name, safe='')}/latest"
        if registry == "npm" else f"https://pypi.org/pypi/{quote(name, safe='')}/json"
    )
    with urlopen(url, timeout=30) as response:
        raw = response.read(16 * 1024 * 1024 + 1)
        if len(raw) > 16 * 1024 * 1024:
            raise ValueError(f"oversized registry response for {name}")
        data = json.loads(raw)
    if registry == "npm":
        return {
            "registry": registry, "name": name, "version": data["version"],
            "source": url, "engines": data.get("engines", {}),
            "integrity": data["dist"].get("integrity"),
            "tarball": data["dist"]["tarball"],
        }
    return {
        "registry": registry, "name": name, "version": data["info"]["version"],
        "source": url, "requires_python": data["info"].get("requires_python"),
        "artifacts": [
            {"filename": file["filename"], "sha256": file["digests"]["sha256"],
             "url": file["url"]}
            for file in data["urls"] if not file.get("yanked")
        ],
    }


def name_status(registry: str, name: str) -> dict:
    try:
        found = metadata(registry, name)
    except HTTPError as error:
        if error.code != 404:
            raise
        return {"registry": registry, "name": name, "status": "not_found"}
    return {"registry": registry, "name": name, "status": "exists",
            "version": found["version"]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("upstream-lock.json"))
    parser.add_argument("--missing-only", action="store_true", help="Keep existing pins and resolve only new package entries")
    args = parser.parse_args()
    entries = [("npm", name) for name in NPM] + [("pypi", name) for name in PYPI]
    previous = json.loads(args.output.read_text()) if args.missing_only and args.output.exists() else None
    if previous:
        keys = {(p["registry"], p["name"]) for p in previous["packages"]}
        entries = [entry for entry in entries if entry not in keys]
    with ThreadPoolExecutor(max_workers=6) as pool:
        packages = list(pool.map(lambda item: metadata(*item), entries))
    result = {
        "schema_version": 1,
        "recorded_at": datetime.now(timezone.utc).isoformat(),
        "evidence": "registry_metadata_only",
        "packages": packages,
        "proposed_names": [name_status("npm", "@caveman-ai/middleware"),
                           name_status("pypi", "caveman-middleware")],
    }
    if previous:
        previous["packages"].extend(packages)
        previous["amended_at"] = result["recorded_at"]
        result = previous
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(f"Recorded {len(packages)} package pins in {args.output}")


if __name__ == "__main__":
    main()
