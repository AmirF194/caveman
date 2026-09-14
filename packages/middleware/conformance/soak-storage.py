"""Read-only storage observations for the native middleware soak."""
import json
import pathlib
import sqlite3
import sys


def connect(path):
    return sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=2)


home = pathlib.Path(sys.argv[1]).resolve()
with connect(home / "caveman.db") as db:
    rows, size = db.execute("SELECT rows,bytes FROM middleware_usage WHERE singleton=1").fetchone()
    live, revoked, manifests = db.execute(
        "SELECT sum(expires_at>0),sum(expires_at=0),coalesce(sum(length(manifest)),0) FROM middleware_scopes"
    ).fetchone()
    choices, payload = db.execute(
        "SELECT count(*),coalesce(sum(length(payload)),0) FROM middleware_choices"
    ).fetchone()
    revoked_payload = db.execute(
        "SELECT coalesce(sum(length(c.payload)+length(c.ccr_handle)),0) FROM middleware_choices c "
        "JOIN middleware_scopes s ON s.id=c.scope WHERE s.expires_at=0"
    ).fetchone()[0]
    plans, plan_bytes = db.execute("SELECT count(*),coalesce(sum(length(payload)),0) FROM middleware_plans").fetchone()
    receipts, receipt_bytes = db.execute("SELECT count(*),coalesce(sum(length(payload)),0) FROM middleware_receipts").fetchone()
with connect(home / "ccr.db") as db:
    originals, original_bytes = db.execute("SELECT count(*),coalesce(sum(length(original)),0) FROM recoveries").fetchone()
print(json.dumps({"metadata_rows": rows, "metadata_bytes": size, "live_scopes": live or 0,
    "revoked_scopes": revoked or 0, "manifest_bytes": manifests, "choices": choices,
    "choice_payload_bytes": payload, "revoked_choice_payload_bytes": revoked_payload,
    "plans": plans, "plan_bytes": plan_bytes, "receipts": receipts, "receipt_bytes": receipt_bytes,
    "ccr_originals": originals, "ccr_original_bytes": original_bytes,
    "database_file_bytes": sum(p.stat().st_size for p in home.glob("*.db*"))}))
