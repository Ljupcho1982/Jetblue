#!/usr/bin/env python3
"""Validate and split the platform's finetune.jsonl before training.

Checks: chat-format schema, duplicates, replies that leak a private limit (needs --db),
replies with binding language or an amount not present in the request facts.
Writes train.jsonl and val.jsonl. Exits non-zero if too few clean rows remain.
"""
import argparse
import json
import random
import re
import sys
from pathlib import Path

BINDING = re.compile(r"guarantee|legally binding|we accept your offer and", re.I)
MONEY = re.compile(r"\$\s?\d[\d,]*(?:\.\d+)?")


def private_numbers(db_path):
    """Floor / minimum lease / lowest allowed price for every aircraft in the platform database."""
    if not db_path:
        return set()
    db = json.loads(Path(db_path).read_text())
    nums = set()
    for a in db.get("inventory", []):
        nums.add(round(a["floor"]))
        nums.add(round(a["minLeaseMonthly"]))
        nums.add(round(a["listPrice"] * (1 - a["maxDiscountPct"] / 100)))
    return nums


def amounts(text):
    return {round(float(m.replace("$", "").replace(",", "").strip())) for m in MONEY.findall(text)}


def check(row, secrets):
    msgs = row.get("messages")
    if not isinstance(msgs, list) or [m.get("role") for m in msgs] != ["system", "user", "assistant"]:
        return "bad schema"
    reply = msgs[2].get("content", "").strip()
    if not reply:
        return "empty reply"
    try:
        facts = json.loads(msgs[1]["content"])
    except (ValueError, KeyError):
        return "user turn is not JSON facts"
    got = amounts(reply)
    if got & secrets:
        return "leaks a private limit"
    allowed = set()
    d = facts.get("decision", {})
    for s in (d.get("price"), facts.get("buyersOffer")):
        if s:
            allowed |= amounts(s)
    if got - allowed:
        return "amount not in facts: %s" % sorted(got - allowed)
    if BINDING.search(reply):
        return "binding language"
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", help="finetune.jsonl downloaded from the Training page")
    ap.add_argument("--db", help="platform data/db.json, enables the private-limit leak check")
    ap.add_argument("--out", default="data", help="output directory (default: data)")
    ap.add_argument("--val-frac", type=float, default=0.1)
    ap.add_argument("--min-rows", type=int, default=50, help="refuse to continue below this many clean rows")
    ap.add_argument("--seed", type=int, default=42)
    a = ap.parse_args()

    secrets = private_numbers(a.db)
    if not a.db:
        print("warning: no --db given, private-limit leak check is skipped", file=sys.stderr)

    rows, seen, dropped = [], set(), {}
    for n, line in enumerate(Path(a.input).read_text().splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except ValueError:
            dropped["invalid json"] = dropped.get("invalid json", 0) + 1
            continue
        why = check(row, secrets)
        if not why:
            key = row["messages"][1]["content"] + "\0" + row["messages"][2]["content"]
            if key in seen:
                why = "duplicate"
            seen.add(key)
        if why:
            dropped[why.split(":")[0]] = dropped.get(why.split(":")[0], 0) + 1
            print("line %d dropped: %s" % (n, why), file=sys.stderr)
        else:
            rows.append(row)

    print("clean rows: %d, dropped: %s" % (len(rows), dropped or "none"))
    if len(rows) < a.min_rows:
        print("only %d clean rows; need at least %d. Collect more approved replies." % (len(rows), a.min_rows), file=sys.stderr)
        sys.exit(1)

    random.Random(a.seed).shuffle(rows)
    n_val = max(1, int(len(rows) * a.val_frac))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for name, part in (("val.jsonl", rows[:n_val]), ("train.jsonl", rows[n_val:])):
        (out / name).write_text("".join(json.dumps(r) + "\n" for r in part))
        print("wrote %s (%d rows)" % (out / name, len(part)))


if __name__ == "__main__":
    main()
