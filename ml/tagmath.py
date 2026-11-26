"""Model-free numpy helpers for classifier sampling.

Kept separate from server.py (which imports torch/open_clip at module load) so
it can be unit-tested with synthetic vectors: `python -m unittest discover -s ml/tests`.
"""
from __future__ import annotations

import zlib

import numpy as np


def seed_for(name: str) -> int:
    return zlib.crc32(name.encode())


def sibling_negatives(
    sibling_rows: np.ndarray, pos_rows: np.ndarray, limit: int, rng: np.random.Generator
) -> np.ndarray:
    """Hard negatives for /train: files tagged with a sibling subtree that aren't positives."""
    cand = np.setdiff1d(sibling_rows, pos_rows)
    if len(cand) > limit:
        cand = rng.choice(cand, limit, replace=False)
    return np.sort(cand).astype(np.int64)
