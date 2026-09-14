"""Create an isolated hash-locked native framework conformance environment."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
GROUPS = {
    "langchain": ["langchain", "langchain-core", "langgraph", "langchain-openai", "langchain-anthropic"],
    "litellm": ["litellm"],
    "strands": ["strands-agents"],
    "agno": ["agno", "openai", "anthropic"],
    "crewai": ["crewai[anthropic,litellm]", "litellm"],
    "autogen": ["autogen-agentchat", "autogen-core", "autogen-ext[openai,anthropic]", "openai", "anthropic"],
    "asgi": ["fastapi", "starlette", "openai", "anthropic", "uvicorn"],
    "mcp": ["mcp", "openai", "anthropic"],
    "pydantic-ai": ["pydantic-ai"],
    "llama-index": ["llama-index-core", "llama-index-llms-openai", "llama-index-llms-anthropic", "anthropic", "openai"],
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("group", choices=GROUPS)
    args = parser.parse_args()
    lock = json.loads((ROOT / "packages/middleware/conformance/upstream-lock.json").read_text())
    pins = {p["name"]: p["version"] for p in lock["packages"] if p["registry"] == "pypi"}
    # The ASGI fixture runs a real local server; it is not an adapter dependency.
    if args.group == "asgi":
        pins["uvicorn"] = "0.52.4"
    # These pinned frameworks still send temperature, removed in Anthropic 1.x.
    # Their separately locked baselines are verified by native client tests.
    if args.group in ("agno", "autogen", "llama-index"):
        pins["anthropic"] = "0.125.0"
    if args.group in ("agno", "autogen", "llama-index"):
        pins["openai"] = "2.54.0"
    folder = ROOT / "examples/middleware" / args.group
    folder.mkdir(parents=True, exist_ok=True)
    requirements = folder / "requirements.in"
    requirements.write_text("".join(f"{name}=={pins[name.split('[')[0]]}\n" for name in GROUPS[args.group]))
    environment = Path(tempfile.gettempdir()) / f"caveman-middleware-{args.group}-venv"
    env = {**os.environ, "UV_CACHE_DIR": str(Path(tempfile.gettempdir()) / "caveman-middleware-uv-cache"), "UV_NATIVE_TLS": "true"}
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.exists():
        subprocess.run(["uv", "venv", str(environment), "--python", "3.13"], check=True, env=env)
    resolved = folder / "requirements.lock"
    subprocess.run(["uv", "pip", "compile", str(requirements), "--python", str(python), "--generate-hashes", "--output-file", str(resolved)], check=True, env=env)
    subprocess.run(["uv", "pip", "sync", str(resolved), "--python", str(python)], check=True, env=env)
    print(f"Native {args.group} environment: {python}")


if __name__ == "__main__":
    main()
