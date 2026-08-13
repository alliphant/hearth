#!/usr/bin/env python3
"""Did ha_get_state fire recently? (verify the forced-tool skip on pre-injected EV turns)"""
import sqlite3
db = sqlite3.connect("/docker/hearth/data/hearth.db")
db.row_factory = sqlite3.Row
cols = [c[1] for c in db.execute("PRAGMA table_info(audit_log)").fetchall()]
tcol = "tool_name" if "tool_name" in cols else cols[0]
rows = db.execute("SELECT * FROM audit_log ORDER BY rowid DESC LIMIT 30").fetchall()
names = [r[tcol] for r in rows]
print("last 30 audit tool_names (newest first):")
print(" ", names)
ha = [n for n in names if n == "ha_get_state"]
verdict = "FORCED TOOL FIRED" if ha else "none recently = forced tool SKIPPED (pre-injected path worked)"
print("ha_get_state count in last 30:", len(ha), "->", verdict)
