"""refr CLIP sidecar: embeddings + in-RAM kNN. See SPEC.md §13.1."""
import argparse
import sqlite3
import threading

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
                self.stamp = stamp
        finally:
            conn.close()


knn_cache = KnnCache()


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
        return {"vectors": []}
    with torch.no_grad():
        batch = torch.stack(imgs).to(device)
        feats = model.encode_image(batch)
        feats = feats / feats.norm(dim=-1, keepdim=True)
    return {"vectors": feats.cpu().numpy().astype(np.float32).tolist()}


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
        conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
        try:
            esc = req.excludeTag.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            pat = esc.rstrip("/") + "/%"
            rows = conn.execute(
                """SELECT DISTINCT ft.fileId FROM FileTag ft JOIN Tag t ON t.id = ft.tagId
                   WHERE t.name = ? OR t.name LIKE ? ESCAPE '\\'""",
                (req.excludeTag, pat),
            ).fetchall()
            exclude_ids = {r[0] for r in rows}
        finally:
            conn.close()

    k = min(req.k + req.skip, len(ids))
    idx = np.argpartition(-scores, k - 1)[:k]
    idx = idx[np.argsort(-scores[idx])]
    out = []
    for i in idx:
        fid = ids[i]
        if fid in exclude_ids:
            continue
        out.append({"fileId": fid, "score": float(scores[i])})
    return out[req.skip :]


if __name__ == "__main__":
    threading.Thread(target=load_model, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
