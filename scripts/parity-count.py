#!/usr/bin/env python3
"""Count statuses in docs/typora-parity-gap.md (column 3 = Before, column 4 = After)."""
import collections, re, sys
p = sys.argv[1] if len(sys.argv) > 1 else "docs/typora-parity-gap.md"
before, after = collections.Counter(), collections.Counter()
for line in open(p, encoding="utf-8"):
    cells = [c.strip() for c in line.strip().strip("|").split("|")]
    if len(cells) != 5 or not cells[0] or cells[2] in ("Before", "---", ""): continue
    before[cells[2]] += 1
    after[cells[3] or cells[2]] += 1
keys = ["done", "partial", "missing", "win-broken", "n/a"]
print("before", {k: before[k] for k in keys}, "total", sum(before.values()))
print("after ", {k: after[k] for k in keys}, "total", sum(after.values()))
