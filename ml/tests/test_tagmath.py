"""Tests for ml/tagmath.py (no model, numpy only).
Run: ml/.venv/bin/python -m unittest discover -s ml/tests"""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import tagmath  # noqa: E402


class TagMathTest(unittest.TestCase):
    def test_sibling_negatives_exclude_positives(self):
        rng = np.random.default_rng(1)
        out = tagmath.sibling_negatives(np.arange(10), np.array([2, 3]), 100, rng)
        self.assertEqual(list(out), [0, 1, 4, 5, 6, 7, 8, 9])
        self.assertEqual(len(tagmath.sibling_negatives(np.arange(1000), np.array([]), 50, rng)), 50)

    def test_seed_is_stable(self):
        self.assertEqual(tagmath.seed_for("a/b"), tagmath.seed_for("a/b"))


if __name__ == "__main__":
    unittest.main()
