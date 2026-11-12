"""refr CLIP sidecar: embeddings + in-RAM kNN. See SPEC.md §13.1."""
import argparse
import ctypes
import sqlite3
import sys
import threading
import zlib

import numpy as np
import open_clip
import torch
import uvicorn
from fastapi import FastAPI
from PIL import Image
from pydantic import BaseModel

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
    negatives = manual denials (weighted denyWeight) + a random sample of the rest.
    Classes are balanced to equal total weight. Sampling is seeded by the tag name
    so retraining unchanged data is stable. weights=None: too few positives."""
    knn_cache.refresh_if_needed()
    with knn_cache.lock:
        mat = knn_cache.matrix
        index = knn_cache.index
    n = 0 if mat is None else len(mat)
    pos_all = np.array(sorted({index[f] for f in tag_file_ids(req.tag) if f in index}), dtype=np.int64)
    if len(pos_all) < req.minPositives or n == 0:
        return {"weights": None, "bias": None, "positives": int(len(pos_all)), "negatives": 0}
    rng = np.random.default_rng(zlib.crc32(req.tag.encode()))
    pos = rng.choice(pos_all, req.maxPositives, replace=False) if len(pos_all) > req.maxPositives else pos_all
    pos_set = set(pos_all.tolist())
    deny = np.array(sorted({index[f] for f in req.denyIds if f in index} - pos_set), dtype=np.int64)
    blocked = np.zeros(n, dtype=bool)
    blocked[pos_all] = True
    blocked[deny] = True
    pool = np.flatnonzero(~blocked)
    rand = rng.choice(pool, req.randomNegatives, replace=False) if len(pool) > req.randomNegatives else pool
    if len(deny) + len(rand) == 0:
        return {"weights": None, "bias": None, "positives": int(len(pos_all)), "negatives": 0}

    rows = np.concatenate([pos, deny, rand])
    y = np.concatenate([np.ones(len(pos)), np.zeros(len(deny) + len(rand))]).astype(np.float32)
    neg_w = np.concatenate([np.full(len(deny), req.denyWeight), np.ones(len(rand))])
    sw = np.concatenate([np.full(len(pos), 0.5 / len(pos)), 0.5 * neg_w / neg_w.sum()]).astype(np.float32)
    w0 = (
        req.priorScale * np.asarray(req.prior, dtype=np.float32)
        if req.prior is not None
        else np.zeros(mat.shape[1], dtype=np.float32)
    )
    w, b = train_logreg(mat[rows], y, sw, req.l2, w0)
    return {"weights": w.tolist(), "bias": b, "positives": int(len(pos_all)), "negatives": int(len(deny) + len(rand))}


if __name__ == "__main__":
    threading.Thread(target=load_model, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
