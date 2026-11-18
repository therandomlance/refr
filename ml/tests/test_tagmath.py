"""Synthetic-vector tests for ml/tagmath.py (no model, numpy only).
Run: ml/.venv/bin/python -m unittest discover -s ml/tests"""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import tagmath  # noqa: E402

D = 32


def unit(v):
    v = np.asarray(v, dtype=np.float32)
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


def cluster(rng, center, n, spread=0.15):
    return unit(center + spread * rng.standard_normal((n, D)).astype(np.float32))


class Fixture:
    """Two tight modes A1/A2 for the target tag, a look-alike sibling B, noise."""

    def __init__(self):
        rng = np.random.default_rng(0)
        a1, a2, b = (unit(rng.standard_normal(D)) for _ in range(3))
        self.x = np.concatenate([
            cluster(rng, a1, 60),          # 0..59   target positives, mode 1
            cluster(rng, a2, 60),          # 60..119 target positives, mode 2
            cluster(rng, a1, 20),          # 120..139 untagged, mode 1
            cluster(rng, a2, 5),           # 140..144 untagged, mode 2 (sparse)
            cluster(rng, b, 40),           # 145..184 sibling B positives
            cluster(rng, unit(0.4 * a1 + 0.6 * b), 5),  # 185..189 look-alikes (closer to B)
            unit(rng.standard_normal((200, D))),          # 190.. noise
        ]).astype(np.float32)
        self.pos = np.arange(120)
        w = unit(self.x[self.pos].mean(axis=0))
        self.target = tagmath.Model("chars/a", w, 0.0, self.pos)
        self.sib = tagmath.Model("chars/b", unit(self.x[145:185].mean(axis=0)), 0.0, np.arange(145, 185))
        self.member = {"chars/b": np.isin(np.arange(len(self.x)), self.sib.pos)}

    def run(self, deny=np.zeros(0, dtype=np.int64), pool_size=40):
        s = self.x @ self.target.w
        return tagmath.sweep_tag(self.x, s, self.target, deny, [self.sib], self.member, pool_size)


class TagMathTest(unittest.TestCase):
    def test_calibration_is_positive_percentile(self):
        pos = np.array([0.1, 0.2, 0.3, 0.4])
        np.testing.assert_allclose(tagmath.calibrate(np.array([0.05, 0.25, 0.4, 0.9]), pos), [0, 0.5, 1, 1])

    def test_too_few_positives_skips(self):
        f = Fixture()
        f.target.pos = np.arange(3)
        self.assertIsNone(f.run())

    def test_positives_and_denials_are_masked(self):
        f = Fixture()
        r = f.run(deny=np.arange(120, 125))
        rows = {p["row"] for p in r["pool"]}
        self.assertFalse(rows & set(range(120)))
        self.assertFalse(rows & set(range(120, 125)))
        # the remaining mode-1 lookups are confident
        conf = {p["row"]: p["confidence"] for p in r["pool"]}
        self.assertGreater(conf[130], 0.05)

    def test_modes_and_sparse_mode_in_pool(self):
        f = Fixture()
        r = f.run(pool_size=10)
        self.assertEqual(r["modes"], 2)
        rows = {p["row"] for p in r["pool"]}
        self.assertTrue(rows & set(range(140, 145)), "sparse second mode should get its own pool slots")
        self.assertEqual(len(r["exemplars"]), 2)
        self.assertTrue(all(len(g) == 3 for g in r["exemplars"]))

    def test_rival_flag_for_lookalikes_and_tagged_siblings(self):
        f = Fixture()
        s = f.x @ f.target.w
        # force look-alikes and a tagged sibling into the pool
        r = tagmath.sweep_tag(f.x, s, f.target, np.zeros(0, dtype=np.int64), [f.sib], f.member, 400)
        by_row = {p["row"]: p for p in r["pool"]}
        self.assertEqual(by_row[150]["rival"]["tag"], "chars/b")
        self.assertEqual(by_row[150]["rival"]["confidence"], 1.0)  # already tagged chars/b
        lookalikes = [by_row[i] for i in range(185, 190)]
        self.assertTrue(all(p["rival"] and p["rival"]["tag"] == "chars/b" for p in lookalikes))
        clean = [by_row[i] for i in range(120, 140)]
        self.assertTrue(all(p["rival"] is None for p in clean))

    def test_near_denial(self):
        f = Fixture()
        f.x[121] = unit(f.x[120] + 0.01)  # a near-copy of the rejected image
        r = f.run(deny=np.array([120]))
        by_row = {p["row"]: p for p in r["pool"]}
        self.assertTrue(by_row[121]["nearDenial"])
        self.assertFalse(any(by_row[i]["nearDenial"] for i in by_row if i >= 190))

    def test_mmr_spreads_across_modes(self):
        f = Fixture()
        r = f.run(pool_size=40)
        first = sorted(r["pool"], key=lambda p: p["rank"])[:6]
        self.assertEqual(len({p["mode"] for p in first}), 2)

    def test_mmr_defers_near_duplicates(self):
        emb = unit(np.array([[1, 0, 0], [1, 0.001, 0], [0, 1, 0]], dtype=np.float32))
        order = tagmath.mmr_order(np.array([0.9, 0.89, 0.5]), emb, 0.2)
        self.assertEqual(list(order), [0, 2, 1])

    def test_sibling_negatives_exclude_positives(self):
        rng = np.random.default_rng(1)
        out = tagmath.sibling_negatives(np.arange(10), np.array([2, 3]), 100, rng)
        self.assertEqual(list(out), [0, 1, 4, 5, 6, 7, 8, 9])
        self.assertEqual(len(tagmath.sibling_negatives(np.arange(1000), np.array([]), 50, rng)), 50)


if __name__ == "__main__":
    unittest.main()
