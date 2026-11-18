"""refr CLIP sidecar: embeddings + in-RAM kNN. See SPEC.md §13.1."""
import argparse
import base64
import ctypes
import sqlite3
import sys
import threading

import numpy as np
import open_clip
import torch
import uvicorn
from fastapi import FastAPI
from PIL import Image
from pydantic import BaseModel

import tagmath

parser = argparse.ArgumentParser()
parser.add_argument("--db", required=True)
parser.add_argument("--thumbs", required=True)
parser.add_argument("--port", type=int, default=3777)
parser.add_argument("--model", default="ViT-B-16-SigLIP2")
parser.add_argument("--pretrained", default="webli")
args = parser.parse_args()


def die_with_parent():
    """Linux: ask the kernel to SIGKILL us when our parent process dies, for
    ANY reason (including SIGKILL of the parent, which no handler can catch).
    Belt-and-suspenders on top of Node's clean-exit child.kill(). No-op off-Linux."""
    if not sys.platform.startswith("linux"):
        return
    PR_SET_PDEATHSIG = 1
    libc = ctypes.CDLL("libc.so.6", use_errno=True)
    libc.prctl(PR_SET_PDEATHSIG, 9)  # SIGKILL


die_with_parent()

app = FastAPI()
device = "cuda" if torch.cuda.is_available() else "cpu"
MODEL_ID = f"{args.model}__{args.pretrained}"

model = None
preprocess = None
tokenizer = None
state = {"status": "booting"}


def load_model():
    global model, preprocess, tokenizer
    state["status"] = "loading"
    m, _, pp = open_clip.create_model_and_transforms(args.model, pretrained=args.pretrained)
    model = m.to(device).eval()
    preprocess = pp
    tokenizer = open_clip.get_tokenizer(args.model)
    state["status"] = "ready"


# ------------------------------------------------------------------ kNN cache

class KnnCache:
    def __init__(self):
        self.lock = threading.Lock()
        self.matrix = None      # (N, 768) float32, L2-normalized rows
        self.ids = []           # fileId per row
        self.index = {}         # fileId -> row
        self.stamp = None       # (count, max updatedAt)

    def refresh_if_needed(self):
        conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
        try:
            count, mx = conn.execute(
                "SELECT COUNT(*), COALESCE(MAX(updatedAt), 0) FROM FileEmbedding WHERE model = ?",
                (MODEL_ID,),
            ).fetchone()
            stamp = (count, mx)
            if stamp == self.stamp and self.matrix is not None:
                return
            rows = conn.execute(
                "SELECT fileId, vector FROM FileEmbedding WHERE model = ? ORDER BY fileId",
                (MODEL_ID,),
            ).fetchall()
            ids = [r[0] for r in rows]
            mat = (
                np.stack([np.frombuffer(r[1], dtype="<f4") for r in rows])
                if rows
                else np.zeros((0, 768), dtype=np.float32)
            )
            with self.lock:
                self.matrix = mat
                self.ids = ids
                self.index = {fid: i for i, fid in enumerate(ids)}
                self.stamp = stamp
        finally:
            conn.close()


knn_cache = KnnCache()


def tag_file_ids(tag):
    """fileIds tagged with `tag` or any descendant (§9 matching)."""
    conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    try:
        esc = tag.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pat = esc.rstrip("/") + "/%"
        rows = conn.execute(
            """SELECT DISTINCT ft.fileId FROM FileTag ft JOIN Tag t ON t.id = ft.tagId
               WHERE t.name = ? OR t.name LIKE ? ESCAPE '\\'""",
            (tag, pat),
        ).fetchall()
        return [r[0] for r in rows]
    finally:
        conn.close()


def ancestors(name):
    parts = name.split("/")
    return ["/".join(parts[: i + 1]) for i in range(len(parts))]


def parent_of(name):
    i = name.rfind("/")
    return None if i <= 0 else name[:i]


class Membership:
    """Tag name (any tree node) → matrix rows tagged with it or a descendant, plus
    ✕ denials by tag name. Rebuilt when FileTag/SuggestionDenial or the kNN
    matrix change (row-count + max-rowid stamp; FileTag has no timestamps)."""

    def __init__(self):
        self.stamp = None
        self.rows = {}    # name -> np.int64 array (sorted, unique)
        self.denied = {}  # tagName -> np.int64 array

    def refresh(self, index, matrix_stamp):
        conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
        try:
            ft = conn.execute("SELECT COUNT(*), COALESCE(MAX(rowid), 0) FROM FileTag").fetchone()
            sd = conn.execute("SELECT COUNT(*), COALESCE(MAX(rowid), 0) FROM SuggestionDenial").fetchone()
            stamp = (ft, sd, matrix_stamp)
            if stamp == self.stamp:
                return self
            acc = {}
            for name, fid in conn.execute("SELECT t.name, ft.fileId FROM FileTag ft JOIN Tag t ON t.id = ft.tagId"):
                r = index.get(fid)
                if r is None:
                    continue
                for a in ancestors(name):
                    acc.setdefault(a, []).append(r)
            den = {}
            for name, fid in conn.execute("SELECT tagName, fileId FROM SuggestionDenial"):
                r = index.get(fid)
                if r is not None:
                    den.setdefault(name, []).append(r)
            self.rows = {k: np.unique(np.array(v, dtype=np.int64)) for k, v in acc.items()}
            self.denied = {k: np.unique(np.array(v, dtype=np.int64)) for k, v in den.items()}
            self.stamp = stamp
            return self
        finally:
            conn.close()

    def of(self, name):
        return self.rows.get(name, np.zeros(0, dtype=np.int64))

    def denials(self, name):
        return self.denied.get(name, np.zeros(0, dtype=np.int64))

    def sibling_names(self, name):
        """Immediate children of name's parent, other than name. Top-level tags have none."""
        parent = parent_of(name)
        if parent is None:
            return []
        prefix = parent + "/"
        return [k for k in self.rows if k.startswith(prefix) and "/" not in k[len(prefix):] and k != name]


membership = Membership()


def current_membership():
    knn_cache.refresh_if_needed()
    with knn_cache.lock:
        index = knn_cache.index
        stamp = knn_cache.stamp
    return membership.refresh(index, stamp)


class Health(BaseModel):
    status: str
    device: str
    model: str


@app.get("/health")
def health():
    return Health(status=state["status"], device=device, model=f"{args.model}__{args.pretrained}")


class TextReq(BaseModel):
    texts: list[str]


class ImageReq(BaseModel):
    paths: list[str]


class KnnReq(BaseModel):
    vector: list[float]
    k: int = 200
    skip: int = 0
    excludeTag: str | None = None
    excludeIds: list[str] | None = None


def encode_text(texts):
    with torch.no_grad():
        tokens = tokenizer(texts).to(device)
        feats = model.encode_text(tokens)
        feats = feats / feats.norm(dim=-1, keepdim=True)
    return feats.cpu().numpy().astype(np.float32)


@app.post("/embed/text")
def embed_text(req: TextReq):
    return {"vectors": encode_text(req.texts).tolist()}


@app.post("/embed/image")
def embed_image(req: ImageReq):
    imgs = []
    keep = []
    for i, p in enumerate(req.paths):
        try:
            imgs.append(preprocess(Image.open(p).convert("RGB")))
            keep.append(i)
        except Exception:
            pass
    if not imgs:
        return {"vectors": [], "kept": []}
    with torch.no_grad():
        batch = torch.stack(imgs).to(device)
        feats = model.encode_image(batch)
        feats = feats / feats.norm(dim=-1, keepdim=True)
    return {"vectors": feats.cpu().numpy().astype(np.float32).tolist(), "kept": keep}


@app.post("/knn")
def knn(req: KnnReq):
    knn_cache.refresh_if_needed()
    with knn_cache.lock:
        mat = knn_cache.matrix
        ids = knn_cache.ids
    if mat is None or len(ids) == 0:
        return []
    q = np.asarray(req.vector, dtype=np.float32)
    q = q / (np.linalg.norm(q) + 1e-12)
    scores = mat @ q

    exclude_ids = set()
    if req.excludeIds:
        exclude_ids.update(req.excludeIds)
    if req.excludeTag:
        # union with the ids already excluded (manual denials) — don't clobber
        exclude_ids.update(tag_file_ids(req.excludeTag))

    # Over-fetch by the exclusion count so filtering out already-tagged/denied
    # files doesn't shrink the returned list below k (pigeonhole: among the top
    # k + len(exclude_ids) candidates at most len(exclude_ids) are excluded).
    over = min(req.k + req.skip + len(exclude_ids), len(ids))
    idx = np.argpartition(-scores, over - 1)[:over]
    idx = idx[np.argsort(-scores[idx])]
    out = []
    for i in idx:
        fid = ids[i]
        if fid in exclude_ids:
            continue
        out.append({"fileId": fid, "score": float(scores[i])})
    return out[req.skip : req.k + req.skip]


# ------------------------------------------------------------------ per-tag classifier


class TrainReq(BaseModel):
    tag: str
    denyIds: list[str] = []
    minPositives: int = 10
    maxPositives: int = 2000
    randomNegatives: int = 3000
    denyWeight: float = 3.0
    l2: float = 3e-2
    prior: list[float] | None = None  # the tag vector to anchor to
    priorScale: float = 20.0
    siblingNegatives: int = 0  # hard negatives: files under sibling tags (0 = off)
    siblingWeight: float = 1.5


def train_logreg(x, y, sw, l2, w0):
    """Weighted logistic regression via L-BFGS (CPU; N is a few thousand), pulled
    toward w0 by 0.5·l2·|w − w0|² and started there."""
    X = torch.from_numpy(x)
    Y = torch.from_numpy(y)
    SW = torch.from_numpy(sw)
    W0 = torch.from_numpy(w0)
    w = W0.clone().requires_grad_(True)
    b = torch.zeros(1, requires_grad=True)
    opt = torch.optim.LBFGS([w, b], lr=1, max_iter=200, line_search_fn="strong_wolfe")

    def closure():
        opt.zero_grad()
        logits = X @ w + b
        loss = (SW * torch.nn.functional.binary_cross_entropy_with_logits(logits, Y, reduction="none")).sum()
        loss = loss + 0.5 * l2 * ((w - W0) ** 2).sum()
        loss.backward()
        return loss

    with torch.enable_grad():
        opt.step(closure)
    return w.detach().numpy().astype(np.float32), float(b.detach()[0])


@app.post("/train")
def train(req: TrainReq):
    """Anchored per-tag classifier (see CLASSIFIER in src/server/services/ml.ts).
    Positives = files tagged with the tag or a descendant (sampled to maxPositives);
    negatives = manual denials (weighted denyWeight) + files under sibling tags
    (weighted siblingWeight; the look-alike signal for characters/franchises) +
    a random sample of the rest. Classes are balanced to equal total weight.
    Sampling is seeded by the tag name so retraining unchanged data is stable.
    weights=None: too few positives."""
    mem = current_membership()
    with knn_cache.lock:
        mat = knn_cache.matrix
        index = knn_cache.index
    n = 0 if mat is None else len(mat)
    pos_all = mem.of(req.tag)
    if len(pos_all) < req.minPositives or n == 0:
        return {"weights": None, "bias": None, "positives": int(len(pos_all)), "negatives": 0}
    rng = np.random.default_rng(tagmath.seed_for(req.tag))
    pos = rng.choice(pos_all, req.maxPositives, replace=False) if len(pos_all) > req.maxPositives else pos_all
    deny = np.setdiff1d(
        np.array(sorted({index[f] for f in req.denyIds if f in index}), dtype=np.int64), pos_all
    )
    sib = np.zeros(0, dtype=np.int64)
    if req.siblingNegatives > 0:
        names = mem.sibling_names(req.tag)
        if names:
            rows = np.unique(np.concatenate([mem.of(k) for k in names]))
            sib = tagmath.sibling_negatives(np.setdiff1d(rows, deny), pos_all, req.siblingNegatives, rng)
    blocked = np.zeros(n, dtype=bool)
    blocked[pos_all] = True
    blocked[deny] = True
    blocked[sib] = True
    pool = np.flatnonzero(~blocked)
    rand = rng.choice(pool, req.randomNegatives, replace=False) if len(pool) > req.randomNegatives else pool
    if len(deny) + len(sib) + len(rand) == 0:
        return {"weights": None, "bias": None, "positives": int(len(pos_all)), "negatives": 0}

    rows = np.concatenate([pos, deny, sib, rand])
    y = np.concatenate([np.ones(len(pos)), np.zeros(len(deny) + len(sib) + len(rand))]).astype(np.float32)
    neg_w = np.concatenate([np.full(len(deny), req.denyWeight), np.full(len(sib), req.siblingWeight), np.ones(len(rand))])
    sw = np.concatenate([np.full(len(pos), 0.5 / len(pos)), 0.5 * neg_w / neg_w.sum()]).astype(np.float32)
    w0 = (
        req.priorScale * np.asarray(req.prior, dtype=np.float32)
        if req.prior is not None
        else np.zeros(mat.shape[1], dtype=np.float32)
    )
    w, b = train_logreg(mat[rows], y, sw, req.l2, w0)
    return {
        "weights": w.tolist(),
        "bias": b,
        "positives": int(len(pos_all)),
        "negatives": int(len(deny) + len(sib) + len(rand)),
    }


# ------------------------------------------------------------------ tag sweep


class SweepModel(BaseModel):
    name: str
    w: str  # base64 float32 LE
    b: float = 0.0


class SweepReq(BaseModel):
    targets: list[str]
    models: list[SweepModel]  # targets + any siblings worth checking as rivals
    poolSize: int = 200


@app.post("/sweep")
def sweep(req: SweepReq):
    """Calibrated cross-tag candidates (tagmath.sweep_tag) for each target tag."""
    mem = current_membership()
    with knn_cache.lock:
        mat = knn_cache.matrix
        ids = knn_cache.ids
    if mat is None or len(ids) == 0:
        return {"results": [{"tag": t, "skipped": True} for t in req.targets]}
    models = {}
    for m in req.models:
        w = np.frombuffer(base64.b64decode(m.w), dtype="<f4")
        if w.shape[0] != mat.shape[1]:
            continue
        models[m.name] = tagmath.Model(m.name, w, m.b, mem.of(m.name))
    targets = [t for t in req.targets if t in models]
    out = [{"tag": t, "skipped": True} for t in req.targets if t not in models]
    for start in range(0, len(targets), 64):
        chunk = targets[start : start + 64]
        W = np.stack([models[t].w for t in chunk])
        S = mat @ W.T  # N × chunk
        for j, t in enumerate(chunk):
            m = models[t]
            sib_names = [k for k in mem.sibling_names(t)]
            siblings = [models[k] for k in sib_names if k in models]
            sib_member = {}
            for k in sib_names:
                mask = np.zeros(len(ids), dtype=bool)
                mask[mem.of(k)] = True
                sib_member[k] = mask
            # siblings with no model still count when a candidate is already tagged with them
            for k in sib_names:
                if k not in models:
                    siblings.append(tagmath.Model(k, np.zeros(mat.shape[1], dtype=np.float32), 0.0))
            r = tagmath.sweep_tag(mat, S[:, j] + m.b, m, mem.denials(t), siblings, sib_member, req.poolSize)
            if r is None:
                out.append({"tag": t, "skipped": True, "positives": int(len(m.pos))})
                continue
            r["tag"] = t
            r["exemplars"] = [[ids[i] for i in group] for group in r["exemplars"]]
            for p in r["pool"]:
                p["fileId"] = ids[p.pop("row")]
            out.append(r)
    return {"results": out}


if __name__ == "__main__":
    threading.Thread(target=load_model, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
