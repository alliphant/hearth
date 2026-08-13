#!/usr/bin/env python3
"""Print recent turn token counts from the audit log to verify the slim voice
persona is active (voice turn tokens_in should be ~1k, not ~5k+). Runs on the LLM host."""
import sqlite3, json
db = sqlite3.connect("/docker/hearth/data/hearth.db")
db.row_factory = sqlite3.Row
cols = [c[1] for c in db.execute("PRAGMA table_info(audit_log)").fetchall()]
rows = db.execute("SELECT * FROM audit_log ORDER BY rowid DESC LIMIT 60").fetchall()
keyset = set()
shown = 0
er_col = "execution_result" if "execution_result" in cols else None
ti_col = "tool_input" if "tool_input" in cols else None
for r in rows:
    er = r[er_col] if er_col else None
    if not er or not er.startswith("{"):
        continue
    try:
        d = json.loads(er)
    except Exception:
        continue
    keyset |= set(d.keys())
    tin = d.get("tokens_in", d.get("prompt_tokens"))
    tout = d.get("tokens_out", d.get("completion_tokens"))
    if tin is not None:
        ti = r[ti_col] if ti_col else None
        surf = ""
        if ti and ti.startswith("{"):
            try:
                surf = json.loads(ti).get("surface", "")
            except Exception:
                pass
        print("{:30s} surface={:8s} tokens_in={} tokens_out={}".format(
            (r["tool_name"] or "")[:30], surf or "-", tin, tout))
        shown += 1
    if shown >= 10:
        break
if not shown:
    print("no token fields in recent audit rows. execution_result keys seen:")
    print(sorted(keyset))
