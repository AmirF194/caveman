"""Render retained native-soak samples with standard Matplotlib, without smoothing."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output-prefix", type=Path, required=True)
    args = parser.parse_args()
    raw = args.input.read_bytes()
    report = json.loads(raw)
    samples = report["samples"]
    if not samples or report.get("evidence_class") != "local_native_interleaved_soak":
        raise ValueError("Expected actual native soak samples")
    minutes = [row["elapsed_seconds"] / 60 for row in samples]
    mib = 1024 * 1024
    values = lambda name: [row[name] / mib for row in samples]
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10,
                         "axes.spines.top": False, "axes.spines.right": False,
                         "axes.grid": True, "grid.alpha": .17, "svg.fonttype": "none"})
    figure, axes = plt.subplots(2, 2, figsize=(13, 8.5), layout="constrained")
    blue, green, red = "#2558A8", "#208565", "#B65345"
    memory, storage, retained, work = axes.flat
    memory.plot(minutes, values("node_rss_bytes"), color=blue, label="Node process RSS")
    memory.plot(minutes, values("runtime_rss_bytes"), color=green, label="Go runtime RSS")
    memory.plot(minutes, values("node_heap_used_bytes"), color=red, linestyle=":", label="JavaScript heap used")
    memory.set(title="Observed process memory", ylabel="MiB")
    memory.legend(loc="upper left", frameon=False, fontsize=9)
    storage.plot(minutes, values("database_file_bytes"), color=blue, label="SQLite files, including reusable pages")
    storage.plot(minutes, values("metadata_bytes"), color=green, label="Live middleware metadata payload")
    storage.plot(minutes, values("receipt_bytes"), color=red, linestyle=":", label="Retained receipt payload")
    storage.set(title="Storage: payload versus allocated files", ylabel="MiB")
    storage.legend(loc="upper left", frameon=False, fontsize=9)
    payload = [(row["manifest_bytes"] + row["choice_payload_bytes"] + row["plan_bytes"]) / mib for row in samples]
    retained.plot(minutes, payload, color=blue, label="Scoped manifests + choices + plans")
    retained.set(title="Session deletion releases scoped payload", ylabel="Scoped payload, MiB")
    scopes = retained.twinx()
    scopes.plot(minutes, [row["live_scopes"] for row in samples], color=green, linestyle="--", label="Live scopes")
    scopes.set(ylabel="Live scopes", ylim=(-4, report["scopes"] * 1.1))
    retained.legend(loc="upper left", frameon=False, fontsize=9)
    scopes.legend(loc="upper right", frameon=False, fontsize=9)
    work.plot(minutes, [row["completed_turns"] for row in samples], color=blue, label="Completed native turns")
    work.set(title="Native work and runtime restarts", ylabel="Completed turns")
    for row in samples:
        if row["label"].startswith("restart-"):
            when = row["elapsed_seconds"] / 60
            for axis in axes.flat:
                axis.axvline(when, color="#888888", linewidth=.8, linestyle=":")
            work.annotate(row["label"], (when, row["completed_turns"]), xytext=(5, -22), textcoords="offset points", fontsize=9)
    for axis in axes.flat:
        axis.set_xlabel("Minutes since timed phase began")
        axis.set_xlim(0, max(minutes) + .3)
        axis.set_ylim(bottom=0)
    all_passed = all(report["gates"].values())
    title = f"Native middleware soak: {'all recorded gates pass' if all_passed else 'incomplete or failed gate'}"
    figure.suptitle(title + f"\n{report['completed_turns']:,} turns · {report['scopes']} scopes · {report['runtime_restarts']} restarts", fontsize=16)
    final = samples[-1]
    footer = (f"Actual samples, no smoothing. Final active counters: {sum(report['final_counters'].values())}. "
              f"Scoped payload: {final['manifest_bytes'] + final['choice_payload_bytes'] + final['plan_bytes']} B. "
              f"Shared Engine original: {final['ccr_original_bytes']:,} B under {report['configured_ccr_capacity_bytes'] // mib} MiB capacity.\n"
              "RSS includes framework/provider pools and caller histories; macOS resident memory differs from JavaScript heap. "
              "Remaining SQLite pages and policy-retained receipt metadata are not live scoped payload.")
    figure.get_layout_engine().set(rect=(0, .065, 1, .90))
    figure.text(.5, .008, footer, ha="center", va="bottom", fontsize=8.5)
    args.output_prefix.parent.mkdir(parents=True, exist_ok=True)
    for extension in ("png", "svg"):
        figure.savefig(str(args.output_prefix) + "." + extension, dpi=170, facecolor="white")
    plt.close(figure)
    record = {"schema_version": 1, "input_sha256": hashlib.sha256(raw).hexdigest(),
              "sample_count": len(samples), "matplotlib_version": matplotlib.__version__,
              "renderer_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "artifacts": {extension: hashlib.sha256(Path(str(args.output_prefix) + "." + extension).read_bytes()).hexdigest()
                            for extension in ("png", "svg")}}
    Path(str(args.output_prefix) + ".json").write_text(json.dumps(record, indent=2) + "\n")


if __name__ == "__main__":
    main()
