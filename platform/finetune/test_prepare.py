import json, subprocess, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).parent


def row(offer, price, reply, system="sys"):
    facts = {"decision": {"action": "counter", "price": "${:,}".format(price), "flags": []}, "buyersOffer": "${:,}".format(offer)}
    return {"messages": [{"role": "system", "content": system}, {"role": "user", "content": json.dumps(facts)}, {"role": "assistant", "content": reply}]}


class PrepareTest(unittest.TestCase):
    def run_prepare(self, rows, min_rows=2, db=True):
        d = Path(tempfile.mkdtemp())
        (d / "in.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
        (d / "db.json").write_text(json.dumps({"inventory": [{"floor": 8600000, "minLeaseMonthly": 86000, "listPrice": 9500000, "maxDiscountPct": 8}]}))
        cmd = [sys.executable, str(HERE / "prepare_data.py"), str(d / "in.jsonl"), "--out", str(d / "out"), "--min-rows", str(min_rows)]
        if db:
            cmd += ["--db", str(d / "db.json")]
        p = subprocess.run(cmd, capture_output=True, text=True)
        return p, d / "out"

    def test_filters_bad_rows(self):
        good = [row(8000000, 9040000, "We can propose $9,040,000 for this aircraft. Subject to contract %d." % i) for i in range(12)]
        bad = [
            row(8000000, 9040000, "Our floor is $8,600,000."),                       # leaks floor
            row(8000000, 9040000, "How about $8,700,000?"),                          # amount not in facts
            row(8000000, 9040000, "This is a legally binding offer at $9,040,000."),  # binding
            good[0],                                                                  # duplicate
            {"messages": [{"role": "user", "content": "x"}]},                         # schema
        ]
        p, out = self.run_prepare(good + bad)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("clean rows: 12", p.stdout)
        kept = (out / "train.jsonl").read_text() + (out / "val.jsonl").read_text()
        self.assertNotIn("8,600,000", kept)
        self.assertEqual(len((out / "val.jsonl").read_text().splitlines()), 1)
        self.assertEqual(len((out / "train.jsonl").read_text().splitlines()), 11)

    def test_too_few_rows_fails(self):
        p, _ = self.run_prepare([row(8000000, 9040000, "We propose $9,040,000.")], min_rows=50)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("need at least 50", p.stderr)

    def test_no_db_warns(self):
        rows = [row(8000000, 9040000, "We propose $9,040,000, ref %d." % i) for i in range(3)]
        p, _ = self.run_prepare(rows, db=False)
        self.assertEqual(p.returncode, 0)
        self.assertIn("leak check is skipped", p.stderr)

    def test_train_dry_run_and_help(self):
        rows = [row(8000000, 9040000, "We propose $9,040,000, ref %d." % i) for i in range(5)]
        p, out = self.run_prepare(rows)
        self.assertEqual(p.returncode, 0, p.stderr)
        dry = subprocess.run([sys.executable, str(HERE / "train.py"), "--data", str(out), "--dry-run"], capture_output=True, text=True)
        self.assertEqual(dry.returncode, 0, dry.stderr)
        self.assertIn("train rows: 4, validation rows: 1", dry.stdout)
        self.assertEqual(subprocess.run([sys.executable, str(HERE / "train.py"), "--help"], capture_output=True).returncode, 0)


if __name__ == "__main__":
    unittest.main()
