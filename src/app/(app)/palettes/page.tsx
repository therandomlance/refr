"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "refr/trpc/react";
import { ConfirmDialog, Dialog, PromptDialog } from "refr/app/_components/dialog";
import { ContextMenu } from "refr/app/_components/context-menu";

type Editing = {
  name: string;
  colors: string[];
  folder: string;
  sourceFileId?: string;
  /** set when editing an existing palette — same name+folder on save = overwrite */
  orig?: { name: string; folder: string };
};

export default function PalettesPage() {
  const params = useSearchParams();
  const [folder, setFolder] = useState<string>("");
  const [sort, setSort] = useState<"name" | "date">("name");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [menu, setMenu] = useState<{ p: { name: string; folder: string }; x: number; y: number } | null>(null);
  const [deleteOf, setDeleteOf] = useState<{ name: string; folder: string } | null>(null);
  const [moveOf, setMoveOf] = useState<{ name: string; folder: string } | null>(null);
  const [newFolder, setNewFolder] = useState(false);
  const [folderMenu, setFolderMenu] = useState<{ folder: string; x: number; y: number } | null>(null);
  const [renameFolderOf, setRenameFolderOf] = useState<string | null>(null);
  const [deleteFolderOf, setDeleteFolderOf] = useState<string | null>(null);
  const dragPal = useRef<{ name: string; folder: string } | null>(null);

  const utils = api.useUtils();
  const palettes = api.palettes.list.useQuery();
  const invalidate = () => void utils.palettes.list.invalidate();
  const extract = api.palettes.extract.useMutation();
  const save = api.palettes.save.useMutation({ onSuccess: invalidate });
  const del = api.palettes.delete.useMutation({ onSuccess: invalidate });
  const move = api.palettes.move.useMutation({ onSuccess: invalidate });
  const createFolder = api.palettes.createFolder.useMutation({ onSuccess: invalidate });
  const renameFolder = api.palettes.renameFolder.useMutation({ onSuccess: invalidate });
  const deleteFolder = api.palettes.deleteFolder.useMutation({ onSuccess: invalidate });

  const items = palettes.data?.items ?? [];
  const folders = palettes.data?.folders ?? [];

  // context action from grids: /palettes?extract=<fileId>
  const extractId = params.get("extract");
  useEffect(() => {
    if (!extractId) return;
    void extract.mutateAsync({ fileId: extractId, n: 4 }).then((colors) => {
      setEditing({ name: "new palette", colors, folder: "", sourceFileId: extractId });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extractId]);

  const shown = items
    .filter((p) => p.folder === folder)
    .sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : b.mtime - a.mtime));

  // drag a palette card onto a sidebar folder row to move it
  const dropTo = (toFolder: string) => {
    const d = dragPal.current;
    dragPal.current = null;
    if (d && d.folder !== toFolder) move.mutate({ name: d.name, fromFolder: d.folder, toFolder });
  };

  return (
    <div className="flex min-h-0 flex-1">
      <aside
        className="scroll-thin flex w-60 flex-none flex-col overflow-y-auto"
        style={{ background: "var(--panel)", borderRight: "1px solid var(--border)" }}
      >
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <h2 className="text-[13px] font-semibold">Palettes</h2>
          <button className="btn" style={{ padding: "3px 8px", fontSize: 12 }} title="New folder" onClick={() => setNewFolder(true)}>
            + Folder
          </button>
        </div>
        <div className="flex-1 px-2 pb-4">
          <div
            className={`trow ${folder === "" ? "sel" : ""}`}
            onClick={() => setFolder("")}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => dropTo("")}
          >
            All / unfiled
          </div>
          {folders.map((f) => (
            <div
              key={f}
              className={`trow ${folder === f ? "sel" : ""}`}
              onClick={() => setFolder(f)}
              onContextMenu={(e) => {
                e.preventDefault();
                setFolderMenu({ folder: f, x: e.clientX, y: e.clientY });
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => dropTo(f)}
            >
              {f}
            </div>
          ))}
        </div>
      </aside>

      <main className="scroll-thin flex-1 overflow-y-auto p-6">
        <div className="mb-4 flex items-center gap-3">
          <select className="input" value={sort} onChange={(e) => setSort(e.target.value as "name" | "date")}>
            <option value="name">Name</option>
            <option value="date">Date</option>
          </select>
          <button
            className="btn primary ml-auto"
            onClick={() => setEditing({ name: "new palette", colors: ["#888888", "#aaaaaa", "#cccccc", "#eeeeee"], folder })}
          >
            New palette
          </button>
        </div>
        <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
          {shown.map((p) => (
            <div
              key={`${p.folder}/${p.name}`}
              className="pcard"
              draggable
              onDragStart={() => (dragPal.current = { name: p.name, folder: p.folder })}
              title="Double-click to open"
              onDoubleClick={() =>
                setEditing({ name: p.name, colors: p.colors, folder: p.folder, sourceFileId: p.sourceFileId, orig: { name: p.name, folder: p.folder } })
              }
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ p, x: e.clientX, y: e.clientY });
              }}
            >
              <div className="stripes">
                {p.colors.map((c, i) => (
                  <div
                    key={i}
                    style={{ background: c }}
                    title={`Copy ${c}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void navigator.clipboard.writeText(c);
                    }}
                  />
                ))}
              </div>
              <div className="pname">{p.name}</div>
            </div>
          ))}
        </div>
        {shown.length === 0 && (
          <p className="text-sm" style={{ color: "var(--text-faint)" }}>
            No palettes here. Right-click an image anywhere → Create palette.
          </p>
        )}
      </main>

      {editing && (
        <PaletteEditor
          editing={editing}
          folders={folders}
          onSave={(e) => {
            const isEdit = !!e.orig && e.orig.name === e.name && e.orig.folder === e.folder;
            if (e.orig && !isEdit) del.mutate(e.orig); // renamed/moved: remove the old file
            save.mutate({ name: e.name, colors: e.colors, folder: e.folder, sourceFileId: e.sourceFileId, overwrite: isEdit });
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: "Export PNG",
              onClick: () => exportPng(menu.p.name, items.find((x) => x.name === menu.p.name && x.folder === menu.p.folder)?.colors ?? []),
            },
            { label: "Move to folder…", onClick: () => setMoveOf(menu.p) },
            { label: "Delete…", onClick: () => setDeleteOf(menu.p), danger: true },
          ]}
        />
      )}
      {moveOf && (
        <FolderPicker
          folders={folders}
          onPick={(f) => move.mutate({ name: moveOf.name, fromFolder: moveOf.folder, toFolder: f })}
          onClose={() => setMoveOf(null)}
        />
      )}
      {deleteOf && (
        <ConfirmDialog
          title="Delete palette"
          body={<>Delete <b>{deleteOf.name}</b>?</>}
          confirmLabel="Delete"
          danger
          onConfirm={() => del.mutate(deleteOf)}
          onClose={() => setDeleteOf(null)}
        />
      )}
      {newFolder && (
        <PromptDialog
          title="New folder"
          label="Folder name (use / for nesting)"
          onSubmit={(f) => createFolder.mutate({ folder: f })}
          onClose={() => setNewFolder(false)}
        />
      )}
      {folderMenu && (
        <ContextMenu
          x={folderMenu.x}
          y={folderMenu.y}
          onClose={() => setFolderMenu(null)}
          items={[
            { label: "Rename…", onClick: () => setRenameFolderOf(folderMenu.folder) },
            { label: "Delete…", onClick: () => setDeleteFolderOf(folderMenu.folder), danger: true },
          ]}
        />
      )}
      {renameFolderOf && (
        <PromptDialog
          title="Rename folder"
          label="New name"
          initial={renameFolderOf}
          onSubmit={(to) => {
            if (folder === renameFolderOf) setFolder(to);
            renameFolder.mutate({ from: renameFolderOf, to });
          }}
          onClose={() => setRenameFolderOf(null)}
        />
      )}
      {deleteFolderOf && (
        <ConfirmDialog
          title="Delete folder"
          body={<>Delete folder <b>{deleteFolderOf}</b>? Its palettes move to unfiled.</>}
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            if (folder === deleteFolderOf) setFolder("");
            deleteFolder.mutate({ folder: deleteFolderOf });
          }}
          onClose={() => setDeleteFolderOf(null)}
        />
      )}
    </div>
  );
}

function FolderPicker({ folders, onPick, onClose }: { folders: string[]; onPick: (f: string) => void; onClose: () => void }) {
  const [custom, setCustom] = useState("");
  return (
    <Dialog title="Move to folder" onClose={onClose}>
      <div className="mb-2 flex flex-col gap-1">
        {["" as string, ...folders].map((f) => (
          <button key={f} className="btn" style={{ textAlign: "left" }} onClick={() => { onPick(f); onClose(); }}>
            {f === "" ? "(unfiled)" : f}
          </button>
        ))}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (custom.trim()) { onPick(custom.trim()); onClose(); }
        }}
      >
        <input className="input flex-1" placeholder="New folder…" value={custom} onChange={(e) => setCustom(e.target.value)} />
        <button className="btn primary" type="submit">Move</button>
      </form>
    </Dialog>
  );
}

function PaletteEditor({
  editing,
  folders,
  onSave,
  onClose,
}: {
  editing: Editing;
  folders: string[];
  onSave: (e: Editing) => void;
  onClose: () => void;
}) {
  const [e, setE] = useState(editing);
  const [picking, setPicking] = useState<number | null>(null);
  const [editHex, setEditHex] = useState<number | null>(null);
  const [hexDraft, setHexDraft] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // draw source image for eyedropper fallback (canvas overlays the thumb, so no swap/flicker)
  useEffect(() => {
    if (picking === null || !e.sourceFileId || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    const img = new Image();
    img.onload = () => {
      canvas.width = Math.min(img.naturalWidth, 600);
      canvas.height = Math.round((canvas.width / img.naturalWidth) * img.naturalHeight);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    img.src = `/api/file/${e.sourceFileId}`;
  }, [picking, e.sourceFileId]);

  const pickFromCanvas = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !ctx || picking === null) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((ev.clientX - rect.left) / rect.width) * canvas.width);
    const y = Math.floor(((ev.clientY - rect.top) / rect.height) * canvas.height);
    const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
    const hex = `#${[r, g, b].map((v) => (v ?? 0).toString(16).padStart(2, "0")).join("")}`;
    setE((s) => ({ ...s, colors: s.colors.map((c, i) => (i === picking ? hex : c)) }));
    setPicking(null);
  };

  const pickWithEyeDropper = async (i: number) => {
    if ("EyeDropper" in window) {
      try {
        const EyeDropperCtor = (
          window as unknown as { EyeDropper: new () => { open(): Promise<{ sRGBHex: string }> } }
        ).EyeDropper;
        const res = await new EyeDropperCtor().open();
        setE((s) => ({ ...s, colors: s.colors.map((c, j) => (j === i ? res.sRGBHex : c)) }));
        return;
      } catch {
        return; // cancelled
      }
    }
    if (e.sourceFileId) setPicking(i);
  };

  const commitHex = () => {
    if (editHex === null) return;
    const v = hexDraft.startsWith("#") ? hexDraft : `#${hexDraft}`;
    if (/^#[0-9a-fA-F]{6}$/.test(v)) setE({ ...e, colors: e.colors.map((x, j) => (j === editHex ? v : x)) });
    setEditHex(null);
  };

  return (
    <Dialog title="Palette" onClose={onClose} wide dismissOnBackdrop={false}>
      <div className="mb-3 flex gap-2">
        <input className="input flex-1" value={e.name} onChange={(ev) => setE({ ...e, name: ev.target.value })} />
        <select className="input" value={e.folder} onChange={(ev) => setE({ ...e, folder: ev.target.value })}>
          <option value="">(unfiled)</option>
          {folders.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
      </div>

      <div className="mb-4 flex gap-4" style={{ height: "min(60vh, 520px)" }}>
        {/* full-height preview stripes; rows compress as colors are added */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded">
          {e.colors.map((c, i) => (
            <div
              key={i}
              className="flex min-h-7 flex-1 items-center gap-1 px-2"
              style={{
                background: c,
                color: contrast(c),
                outline: picking === i ? "2px solid var(--accent)" : "none",
                outlineOffset: -2,
              }}
            >
              {editHex === i ? (
                <input
                  className="w-20 bg-transparent font-mono text-[11px] outline-none"
                  style={{ color: "inherit" }}
                  value={hexDraft}
                  autoFocus
                  onChange={(ev) => setHexDraft(ev.target.value)}
                  onBlur={commitHex}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter") commitHex();
                    if (ev.key === "Escape") {
                      ev.stopPropagation(); // don't close the dialog
                      setEditHex(null);
                    }
                  }}
                />
              ) : (
                <span className="font-mono text-[11px]">{c}</span>
              )}
              <span className="ml-auto flex gap-1">
                <StripeBtn label="Copy hex" onClick={() => void navigator.clipboard.writeText(c)}><CopyIcon /></StripeBtn>
                <StripeBtn label="Edit hex" onClick={() => { setHexDraft(c); setEditHex(i); }}><PencilIcon /></StripeBtn>
                <StripeBtn label="Pick color" onClick={() => void pickWithEyeDropper(i)}><DropperIcon /></StripeBtn>
                <StripeBtn label="Remove" disabled={e.colors.length <= 1} onClick={() => { setEditHex(null); setE({ ...e, colors: e.colors.filter((_, j) => j !== i) }); }}><XIcon /></StripeBtn>
              </span>
            </div>
          ))}
        </div>

        {/* referenced image, side by side with the stripes; a canvas overlays it while picking */}
        {e.sourceFileId && (
          <div className="relative h-full flex-none" style={{ maxWidth: "60%" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/thumb/${e.sourceFileId}`} className="h-full w-auto max-w-full rounded object-contain" alt="" />
            {picking !== null && (
              <canvas ref={canvasRef} className="absolute inset-0 h-full w-full cursor-crosshair rounded" onClick={pickFromCanvas} />
            )}
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <button
          className="btn"
          disabled={e.colors.length >= 10}
          onClick={() => setE({ ...e, colors: [...e.colors, "#888888"] })}
        >
          + Add color
        </button>
        <button className="btn" onClick={() => exportPng(e.name, e.colors)}>Export PNG</button>
        <div className="flex-1" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={() => onSave(e)}>Save</button>
      </div>
    </Dialog>
  );
}

/** Small icon button inline on a preview stripe (inherits the stripe's contrast color). */
function StripeBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      title={label}
      disabled={disabled}
      onClick={(ev) => {
        ev.stopPropagation();
        onClick();
      }}
      className="grid h-5 w-5 cursor-pointer place-items-center rounded opacity-70 hover:opacity-100 disabled:opacity-30"
      style={{ color: "inherit", background: "rgba(0,0,0,.25)", border: 0, padding: 0 }}
    >
      {children}
    </button>
  );
}

function CopyIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
function PencilIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  );
}
function DropperIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m2 22 1-4 9.5-9.5 3 3L6 21l-4 1z" />
      <path d="m14.5 5.5 3-3a2.12 2.12 0 1 1 3 3l-3 3" />
    </svg>
  );
}
function XIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

/** Striped rectangle PNG via canvas → download. Hex codes drawn on the stripes like the preview. */
function exportPng(name: string, colors: string[]) {
  const canvas = document.createElement("canvas");
  canvas.width = 800;
  canvas.height = 800;
  const ctx = canvas.getContext("2d")!;
  const h = 800 / colors.length;
  colors.forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.fillRect(0, i * h, 800, h);
    ctx.fillStyle = contrast(c);
    ctx.font = `${Math.max(12, Math.round(h * 0.35))}px monospace`;
    ctx.textBaseline = "middle";
    ctx.fillText(c, 12, i * h + h / 2);
  });
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = `${name}.png`;
  a.click();
}

/** readable text color on a hex swatch */
function contrast(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const l = 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return l > 140 ? "#000" : "#fff";
}
