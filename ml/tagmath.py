"""Model-free numpy math for the tag sweep and classifier sampling.

Kept separate from server.py (which imports torch/open_clip at module load) so
it can be unit-tested with synthetic vectors: `python -m unittest discover -s ml/tests`.
"""
from __future__ import annotations

import zlib
from dataclasses import dataclass, field

import numpy as np

MIN_POSITIVES = 5        # fewer → no calibration, the tag stays out of the inbox
POOL_FLOOR = 0.10        # per-mode pool additions need at least this confidence
PER_MODE = 30            # extra pool slots per mode (keeps sparse sub-styles visible)
NEAR_DENIAL = 0.92       # cosine to a rejected image that flags a candidate
NEAR_DUP = 0.97          # cosine to an earlier pick that pushes a candidate to the end
MAX_MODES = 6


def seed_for(name: str) -> int:
    return zlib.crc32(name.encode())


def mode_count(n_pos: int) -> int:
    return int(min(MAX_MODES, max(1, round(np.sqrt(n_pos / 30)))))


def spherical_kmeans(x: np.ndarray, k: int, seed: int, iters: int = 12) -> np.ndarray:
    """k unit centroids for unit rows x (cosine k-means, k-means++ init). k=1 → unit mean."""
    n = len(x)
    if k <= 1 or n <= k:
        c = x.mean(axis=0, keepdims=True)
        return c / (np.linalg.norm(c, axis=1, keepdims=True) + 1e-12)
    rng = np.random.default_rng(seed)
    centers = [x[rng.integers(n)]]
    for _ in range(1, k):
        d = 1 - np.max(x @ np.stack(centers).T, axis=1)
        d = np.clip(d, 0, None) ** 2
        p = d / d.sum() if d.sum() > 0 else None
        centers.append(x[rng.choice(n, p=p)])
    c = np.stack(centers)
    for _ in range(iters):
        assign = np.argmax(x @ c.T, axis=1)
        for j in range(k):
            members = x[assign == j]
            if len(members):
                c[j] = members.sum(axis=0)
        c = c / (np.linalg.norm(c, axis=1, keepdims=True) + 1e-12)
    return c.astype(np.float32)


def calibrate(scores: np.ndarray, pos_sorted: np.ndarray) -> np.ndarray:
    """Fraction of positives scoring ≤ each score — comparable across tags."""
    return np.searchsorted(pos_sorted, scores, side="right") / max(len(pos_sorted), 1)


def top_indices(values: np.ndarray, allowed: np.ndarray, k: int) -> np.ndarray:
    """Indices of the k largest `values` among `allowed` (bool mask), descending."""
    cand = np.flatnonzero(allowed)
    if len(cand) == 0 or k <= 0:
        return np.zeros(0, dtype=np.int64)
    k = min(k, len(cand))
    v = values[cand]
    part = np.argpartition(-v, k - 1)[:k]
    return cand[part[np.argsort(-v[part])]]


def mmr_order(conf: np.ndarray, emb: np.ndarray, lam: float) -> np.ndarray:
    """Greedy MMR over the pool: conf − λ·max-sim-to-picked. Near-duplicates
    (cos > NEAR_DUP to an earlier pick) are deferred to the end, in pick order."""
    n = len(conf)
    if n == 0:
        return np.zeros(0, dtype=np.int64)
    sims = emb @ emb.T
    remaining = np.ones(n, dtype=bool)
    max_sim = np.full(n, -np.inf)
    picked: list[int] = []
    deferred: list[int] = []
    while remaining.any():
        penal = np.where(np.isfinite(max_sim), max_sim, 0.0)
        score = np.where(remaining, conf - lam * penal, -np.inf)
        i = int(np.argmax(score))
        remaining[i] = False
        (deferred if max_sim[i] > NEAR_DUP else picked).append(i)
        max_sim = np.maximum(max_sim, sims[i])
    return np.array(picked + deferred, dtype=np.int64)


@dataclass
class Model:
    """A scoring direction: classifier (w, b) or tag vector (w, b=0)."""
    name: str
    w: np.ndarray
    b: float = 0.0
    pos: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.int64))
    pos_sorted: np.ndarray | None = None  # filled lazily by `calibration`
    _modes: np.ndarray | None = None

    def calibration(self, x: np.ndarray) -> np.ndarray | None:
        if len(self.pos) < MIN_POSITIVES:
            return None
        if self.pos_sorted is None:
            self.pos_sorted = np.sort(x[self.pos] @ self.w + self.b)
        return self.pos_sorted

    def modes(self, x: np.ndarray) -> np.ndarray | None:
        """Unit centroids of this tag's sub-styles (k by positive count); None if untagged."""
        if len(self.pos) == 0:
            return None
        if self._modes is None:
            rows = self.pos
            if len(rows) > 2000:
                rows = np.random.default_rng(seed_for(self.name)).choice(rows, 2000, replace=False)
            self._modes = spherical_kmeans(x[rows], mode_count(len(self.pos)), seed_for(self.name))
        return self._modes


def sweep_tag(
    x: np.ndarray,
    scores: np.ndarray,
    target: Model,
    deny: np.ndarray,
    siblings: list[Model],
    sibling_member: dict[str, np.ndarray],
    pool_size: int = 200,
) -> dict | None:
    """Score one tag's candidates. `scores` = x @ w + b for the target (precomputed
    in a chunked matmul). `sibling_member[name]` = bool mask of files tagged with
    that sibling (or a descendant). Returns None when the tag has too few positives."""
    pos_sorted = target.calibration(x)
    if pos_sorted is None:
        return None
    n = len(x)
    conf = calibrate(scores, pos_sorted)
    allowed = np.ones(n, dtype=bool)
    allowed[target.pos] = False
    allowed[deny] = False

    modes = target.modes(x)

    pool = list(top_indices(scores, allowed, pool_size))
    if len(modes) > 1:
        floor = allowed & (conf >= POOL_FLOOR)
        seen = set(pool)
        for m in modes:
            for i in top_indices(x @ m, floor, PER_MODE):
                if int(i) not in seen:
                    seen.add(int(i))
                    pool.append(int(i))
    pool_idx = np.array(pool, dtype=np.int64)
    if len(pool_idx) == 0:
        return {"positives": int(len(target.pos)), "modes": int(len(modes)), "exemplars": [], "pool": []}

    pe = x[pool_idx]
    mode_of = np.argmax(pe @ modes.T, axis=1)
    pool_conf = conf[pool_idx]

    # Rivals: a sibling whose nearest sub-style prototype is closer than any of the
    # target's (raw cosine — the same scale for every tag, unlike percentiles, which
    # flatter broad tags and punish tight ones). Already tagged with a sibling = 1.0.
    own_sim = np.max(pe @ modes.T, axis=1)
    rival_name: list[str | None] = [None] * len(pool_idx)
    rival_conf = np.zeros(len(pool_idx))
    best_sim = own_sim.copy()
    for sib in siblings:
        member = sibling_member.get(sib.name)
        tagged = member[pool_idx] if member is not None else np.zeros(len(pool_idx), dtype=bool)
        sib_modes = sib.modes(x)
        sim = np.max(pe @ sib_modes.T, axis=1) if sib_modes is not None else np.full(len(pool_idx), -np.inf)
        cal = sib.calibration(x)
        sc = calibrate(pe @ sib.w + sib.b, cal) if cal is not None else np.zeros(len(pool_idx))
        wins = tagged | (sim > best_sim)
        for j in np.flatnonzero(wins):
            if tagged[j] or rival_conf[j] < 1.0:
                rival_name[j] = sib.name
                rival_conf[j] = 1.0 if tagged[j] else sc[j]
        best_sim = np.maximum(best_sim, sim)

    near_denial = np.zeros(len(pool_idx), dtype=bool)
    if len(deny):
        near_denial = np.max(pe @ x[deny].T, axis=1) > NEAR_DENIAL

    lam = 0.5 if len(modes) > 1 else 0.2
    order = mmr_order(pool_conf, pe, lam)
    rank = np.empty(len(pool_idx), dtype=np.int64)
    rank[order] = np.arange(len(order))

    exemplars = [
        [int(i) for i in target.pos[np.argsort(-(x[target.pos] @ m))[:3]]] for m in modes
    ]
    return {
        "positives": int(len(target.pos)),
        "modes": int(len(modes)),
        "exemplars": exemplars,  # row indices; the server maps them to fileIds
        "pool": [
            {
                "row": int(pool_idx[j]),
                "score": float(scores[pool_idx[j]]),
                "confidence": float(pool_conf[j]),
                "mode": int(mode_of[j]),
                "rank": int(rank[j]),
                "rival": None if rival_name[j] is None else
                {"tag": rival_name[j], "confidence": float(rival_conf[j])},
                "nearDenial": bool(near_denial[j]),
            }
            for j in range(len(pool_idx))
        ],
    }


def sibling_negatives(
    sibling_rows: np.ndarray, pos_rows: np.ndarray, limit: int, rng: np.random.Generator
) -> np.ndarray:
    """Hard negatives for /train: files tagged with a sibling subtree that aren't positives."""
    cand = np.setdiff1d(sibling_rows, pos_rows)
    if len(cand) > limit:
        cand = rng.choice(cand, limit, replace=False)
    return np.sort(cand).astype(np.int64)
