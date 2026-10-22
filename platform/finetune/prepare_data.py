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
# Same reading of amounts as the platform's guardrail (logic.js): "$9,040,000", "9.04 million", "9.04M", "USD 9 040 000".
MULT = {"k": 1e3, "thousand": 1e3, "m": 1e6, "mm": 1e6, "million": 1e6, "b": 1e9, "bn": 1e9, "billion": 1e9}
AMOUNT = re.compile(
    r"(\$|€|£|¥|\b(?:usd|eur|gbp|chf)\b)?\s?(\d{1,3}(?:[,   ]\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?)"
    r"(?:\s?(thousand|million|billion)\b|(k|mm|bn|m|b)(?![a-z0-9]))?(?:\s?(?:usd|eur|gbp|chf|dollars?|euros?)\b)?", re.I)
SPELLED = re.compile(
    r"\b(?:(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|a|half a)[\s-]+(?:\w+[\s-]+){0,4}?(?:thousand|million|billion)|(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+hundred)\b", re.I)


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
    """Every amount in text as (value, is_relevant). Years, seats and small plain numbers are not relevant."""
    out = []
    for m in AMOUNT.finditer(text):
        raw, cur, num, word, suffix = m.group(0), m.group(1), m.group(2), m.group(3), m.group(4)
        mag = (word or suffix or "").lower()
        digits = re.sub(r"[   ]", "", num)
        digits = digits.replace(",", "") if re.fullmatch(r"\d{1,3}(,\d{3})+(\.\d+)?", digits) else digits.replace(",", ".")
        value = float(digits) * MULT.get(mag, 1)
        currency = bool(cur) or bool(re.search(r"(usd|eur|gbp|chf|dollars?|euros?)\s*$", raw, re.I))
        out.append((value, currency or bool(mag) or value >= 10000, raw.strip()))
    return out


def close(a, b, rel):
    return abs(a - b) <= max(1e-9, abs(b) * rel)


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
    if SPELLED.search(reply):
        return "spelled-out amount"
    allowed = [v for s in (facts.get("decision", {}).get("price"), facts.get("buyersOffer")) if s for v, _, _ in amounts(s)]
    ac = facts.get("aircraft", {})
    allowed += [ac[k] for k in ("year", "seats", "rangeNm") if isinstance(ac.get(k), (int, float))]
    for value, relevant, raw in amounts(reply):
        if any(close(value, s, 0.005) for s in secrets):
            return "leaks a private limit"
        if relevant and not any(close(value, a, 1e-6) for a in allowed):
            return "amount not in facts: %s" % raw
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
