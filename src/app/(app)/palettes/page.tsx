"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "refr/trpc/react";
import { ConfirmDialog, Dialog, PromptDialog } from "refr/app/_components/dialog";
import { SidePanel } from "refr/app/_components/side-panel";
import { ContextMenu } from "refr/app/_components/context-menu";
import { MAX_PALETTE_COLORS, contrast, exportPng, normalizeHex, reorderColor } from "refr/lib/palette-colors";
import { copyText } from "refr/lib/clipboard";
import { useActionFeedback } from "refr/app/_components/action-feedback";

type Editing = {
  name: string;
  colors: string[];
  folder: string;
  sourceFileId?: string;
  /** set when editing an existing palette — same name+folder on save = overwrite */
  orig?: { name: string; folder: string };
};

const PALETTE_DRAG = "application/x-refr-palette";

export default function PalettesPage() {
  const params = useSearchParams();
  const router = useRouter();
  const notify = useActionFeedback();
  // null = all palettes, "" = unfiled
  const [folder, setFolder] = useState<string | null>(null);
  const [sort, setSort] = useState<"name" | "date">("name");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [menu, setMenu] = useState<{ p: { name: string; folder: string }; x: number; y: number } | null>(null);
  const [deleteOf, setDeleteOf] = useState<{ name: string; folder: string } | null>(null);
  const [moveOf, setMoveOf] = useState<{ name: string; folder: string } | null>(null);
  const [newFolder, setNewFolder] = useState(false);
  const [folderMenu, setFolderMenu] = useState<{ folder: string; x: number; y: number } | null>(null);
  const [renameFolderOf, setRenameFolderOf] = useState<string | null>(null);
  const [deleteFolderOf, setDeleteFolderOf] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [dropOn, setDropOn] = useState<string | null>(null);
  const dragPal = useRef<{ name: string; folder: string } | null>(null);

  const utils = api.useUtils();
  const palettes = api.palettes.list.useQuery();
  const invalidate = () => void utils.palettes.list.invalidate();
  const extract = api.palettes.extract.useMutation();
  const save = api.palettes.save.useMutation({ onSuccess: invalidate });
  const del = api.palettes.delete.useMutation({ onSuccess: invalidate });
  const saving = save.isPending || del.isPending;
  const move = api.palettes.move.useMutation({ onSuccess: invalidate });
  const createFolder = api.palettes.createFolder.useMutation({ onSuccess: invalidate });
  const renameFolder = api.palettes.renameFolder.useMutation({ onSuccess: invalidate });
  const deleteFolder = api.palettes.deleteFolder.useMutation({ onSuccess: invalidate });

  const items = palettes.data?.items ?? [];
  const folders = palettes.data?.folders ?? [];

  // context action from grids: /palettes?extract=<fileId>. The param is dropped once
  // handled so refresh / back-navigation doesn't re-extract and reopen the editor.
  const extractId = params.get("extract");
  useEffect(() => {
    if (!extractId) return;
    extract.mutate({ fileId: extractId, n: 4 }, {
      onSuccess: (colors) => setEditing({ name: "new palette", colors, folder: folder ?? "", sourceFileId: extractId }),
      onSettled: () => router.replace("/palettes"),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extractId]);

  const q = filter.trim().toLowerCase();
  const shown = items
    .filter((p) => (folder === null || p.folder === folder) && (!q || p.name.toLowerCase().includes(q)))
    .sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : b.mtime - a.mtime));

  const copy = (hex: string) =>
    void copyText(hex).then((ok) => notify(ok ? { message: `Copied ${hex}` } : { message: "Could not copy to the clipboard.", error: true }));

  const open = (p: (typeof items)[number]) =>
    setEditing({ name: p.name, colors: p.colors, folder: p.folder, sourceFileId: p.sourceFileId, orig: { name: p.name, folder: p.folder } });

  // drag a palette card onto a sidebar folder row to move it
  const dropProps = (toFolder: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(PALETTE_DRAG)) return;
      e.preventDefault();
      setDropOn(toFolder);
    },
    onDragLeave: () => setDropOn((d) => (d === toFolder ? null : d)),
    onDrop: (e: React.DragEvent) => {
      const d = dragPal.current;
      dragPal.current = null;
      setDropOn(null);
      if (!e.dataTransfer.types.includes(PALETTE_DRAG)) return;
      e.preventDefault();
      if (d && d.folder !== toFolder) move.mutate({ name: d.name, fromFolder: d.folder, toFolder });
    },
  });

  // folders under `root` (or root itself) follow a rename/delete of root
  const under = (f: string, root: string) => f === root || f.startsWith(root + "/");

  return (
    <div className="flex min-h-0 flex-1">
      <SidePanel head={<>
          <h2 className="text-[13px] font-semibold">Folders</h2>
          <button className="btn" style={{ padding: "3px 8px", fontSize: 12 }} title="New folder" onClick={() => setNewFolder(true)}>
            + Folder
          </button>
        </>}>
        <div className="flex-1 px-2 pb-4">
          <div className={`trow ${folder === null ? "sel" : ""}`} onClick={() => setFolder(null)}>
            All palettes
            <span className="count">{items.length}</span>
          </div>
          <div className={`trow ${folder === "" ? "sel" : ""} ${dropOn === "" ? "drop" : ""}`} onClick={() => setFolder("")} {...dropProps("")}>
            Unfiled
          </div>
          {folders.map((f) => (
            <div
              key={f}
              className={`trow ${folder === f ? "sel" : ""} ${dropOn === f ? "drop" : ""}`}
              style={{ paddingLeft: 8 + 14 * (f.split("/").length - 1) }}
              title={f}
              onClick={() => setFolder(f)}
              onContextMenu={(e) => {
                e.preventDefault();
                setFolderMenu({ folder: f, x: e.clientX, y: e.clientY });
              }}
              {...dropProps(f)}
            >
              {f.split("/").pop()}
            </div>
          ))}
        </div>
      </SidePanel>

      <main className="scroll-thin min-w-0 flex-1 overflow-y-auto p-6">
        <header className="page-header page-header-inset">
          <div>
            <h1>Palettes</h1>
            <p>
              {folder === null ? "All" : folder || "Unfiled"} · {shown.length} {shown.length === 1 ? "palette" : "palettes"}
              {extract.isPending && " · Extracting colors…"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
          <input className="input" type="search" placeholder="Filter…" aria-label="Filter palettes" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <select className="input" aria-label="Sort palettes" value={sort} onChange={(e) => setSort(e.target.value as "name" | "date")}>
            <option value="name">Name</option>
            <option value="date">Date</option>
          </select>
          <button
            className="btn primary ml-auto"
            onClick={() => setEditing({ name: "new palette", colors: ["#888888", "#aaaaaa", "#cccccc", "#eeeeee"], folder: folder ?? "" })}
          >
            New palette
          </button>
          </div>
        </header>
        <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
          {shown.map((p) => (
            <div
              key={`${p.folder}/${p.name}`}
              className="pcard"
              draggable
              tabIndex={0}
              aria-label={`Open palette ${p.name}`}
              onDragStart={(e) => {
                dragPal.current = { name: p.name, folder: p.folder };
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData(PALETTE_DRAG, `${p.folder}/${p.name}`);
              }}
              onDragEnd={() => { dragPal.current = null; setDropOn(null); }}
              onDoubleClick={() => open(p)}
              onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) open(p); }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ p, x: e.clientX, y: e.clientY });
              }}
            >
              <div className="stripes">
                {p.colors.map((c, i) => (
                  <div
                    key={i}
                    style={{ background: c, color: contrast(c) }}
                    title={`Copy ${c}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      copy(c);
                    }}
                  >
                    <span>{c}</span>
                  </div>
                ))}
              </div>
              <button type="button" className="pname" title="Open" onClick={() => open(p)}>
                <span className="truncate">{p.name}</span>
                {folder === null && p.folder && <span className="pfolder">{p.folder}</span>}
              </button>
            </div>
          ))}
        </div>
        {shown.length === 0 && (
          <p className="text-sm" style={{ color: "var(--text-faint)" }}>
            {q ? "No palettes match the filter." : "No palettes here. Right-click an image anywhere → Create palette."}
          </p>
        )}
      </main>

      {editing && (
        <PaletteEditor
          editing={editing}
          folders={folders}
          saving={saving}
          extracting={extract.isPending}
          onExtract={(n) => extract.mutateAsync({ fileId: editing.sourceFileId!, n })}
          onSave={async (e) => {
            const isEdit = !!e.orig && e.orig.name === e.name && e.orig.folder === e.folder;
            try {
              const saved = await save.mutateAsync({ name: e.name, colors: e.colors, folder: e.folder, sourceFileId: e.sourceFileId, overwrite: isEdit });
              if (e.orig && !isEdit) await del.mutateAsync(e.orig);
              if (saved !== e.name) notify({ message: `Name taken, saved as “${saved}”.` });
              setEditing(null);
            } catch { /* mutation feedback reports failures; keep the editor open */ }
          }}
          onClose={() => { if (!saving) setEditing(null); }}
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
          current={moveOf.folder}
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
          label="New name (use / for nesting)"
          initial={renameFolderOf}
          onSubmit={(to) => {
            const from = renameFolderOf;
            // follow the selection only once the rename actually happened
            renameFolder.mutate({ from, to }, {
              onSuccess: () => setFolder((cur) => (cur !== null && under(cur, from) ? to + cur.slice(from.length) : cur)),
            });
          }}
          onClose={() => setRenameFolderOf(null)}
        />
      )}
      {deleteFolderOf && (
        <ConfirmDialog
          title="Delete folder"
          body={<>Delete folder <b>{deleteFolderOf}</b>? Its palettes (including subfolders) move to unfiled.</>}
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            const f = deleteFolderOf;
            deleteFolder.mutate({ folder: f }, {
              onSuccess: () => setFolder((cur) => (cur !== null && under(cur, f) ? "" : cur)),
            });
          }}
          onClose={() => setDeleteFolderOf(null)}
        />
      )}
    </div>
  );
}

function FolderPicker({ folders, current, onPick, onClose }: { folders: string[]; current: string; onPick: (f: string) => void; onClose: () => void }) {
  const [custom, setCustom] = useState("");
  return (
    <Dialog title="Move to folder" onClose={onClose}>
      <div className="mb-2 flex flex-col gap-1">
        {["" as string, ...folders].filter((f) => f !== current).map((f) => (
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
  saving,
  extracting,
  onExtract,
  onSave,
  onClose,
}: {
  editing: Editing;
  folders: string[];
  saving: boolean;
  extracting: boolean;
  onExtract: (n: number) => Promise<string[]>;
  onSave: (e: Editing) => Promise<void>;
  onClose: () => void;
}) {
  const notify = useActionFeedback();
  const [e, setE] = useState(editing);
  const [picking, setPicking] = useState<number | null>(null);
  const [canvasReady, setCanvasReady] = useState(false);
  const [editHex, setEditHex] = useState<number | null>(null);
  const [hexDraft, setHexDraft] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [extractN, setExtractN] = useState(editing.colors.length);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragColor = useRef<number | null>(null);

  const hasEyeDropper = typeof window !== "undefined" && "EyeDropper" in window;
  const canPick = hasEyeDropper || !!e.sourceFileId;
  const hexInvalid = editHex !== null && normalizeHex(hexDraft) === null;
  const dirty = e.name !== editing.name || e.folder !== editing.folder || e.colors.join() !== editing.colors.join();

  const setColor = (i: number, hex: string) => setE((s) => ({ ...s, colors: s.colors.map((c, j) => (j === i ? hex : c)) }));

  const reorder = (from: number, to: number) => {
    setE((s) => ({ ...s, colors: reorderColor(s.colors, from, to) }));
    setEditHex(null);
    setPicking(null);
  };

  // Escape / Cancel: back out of picking first, then confirm before dropping edits
  const requestClose = () => {
    if (picking !== null) { setPicking(null); return; }
    if (saving) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  // draw source image for eyedropper fallback (canvas overlays the thumb, so no swap/flicker).
  // Samples the same thumbnail that's displayed; clicks are ignored until it's drawn.
  useEffect(() => {
    setCanvasReady(false);
    if (picking === null || !e.sourceFileId || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    let live = true;
    const img = new Image();
    img.onload = () => {
      if (!live) return;
      canvas.width = Math.min(img.naturalWidth, 600);
      canvas.height = Math.round((canvas.width / img.naturalWidth) * img.naturalHeight);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      setCanvasReady(true);
    };
    img.src = `/api/thumb/${e.sourceFileId}`;
    return () => { live = false; };
  }, [picking, e.sourceFileId]);

  const pickFromCanvas = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !ctx || picking === null || !canvasReady) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((ev.clientX - rect.left) / rect.width) * canvas.width);
    const y = Math.floor(((ev.clientY - rect.top) / rect.height) * canvas.height);
    const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
    setColor(picking, `#${[r, g, b].map((v) => (v ?? 0).toString(16).padStart(2, "0")).join("")}`);
    setPicking(null);
  };

  const pickWithEyeDropper = async (i: number) => {
    if (hasEyeDropper) {
      try {
        const EyeDropperCtor = (
          window as unknown as { EyeDropper: new () => { open(): Promise<{ sRGBHex: string }> } }
        ).EyeDropper;
        const res = await new EyeDropperCtor().open();
        const hex = normalizeHex(res.sRGBHex);
        if (hex) setColor(i, hex);
        return;
      } catch {
        return; // cancelled
      }
    }
    if (e.sourceFileId) setPicking(i);
  };

  /** Enter commits only valid hex; blur commits valid hex and otherwise reverts. */
  const commitHex = (revertInvalid: boolean) => {
    if (editHex === null) return;
    const hex = normalizeHex(hexDraft);
    if (hex) setColor(editHex, hex);
    if (hex || revertInvalid) setEditHex(null);
  };

  const reExtract = async () => {
    try {
      const colors = await onExtract(extractN);
      setE((s) => ({ ...s, colors }));
      setEditHex(null);
      setPicking(null);
    } catch { /* mutation feedback reports failures */ }
  };

  const copy = (hex: string) =>
    void copyText(hex).then((ok) => notify(ok ? { message: `Copied ${hex}` } : { message: "Could not copy to the clipboard.", error: true }));

  return (
    <>
    <Dialog title="Palette" onClose={requestClose} wide={1620} dismissOnBackdrop={false}>
      <fieldset disabled={saving} inert={saving} className="contents">
      <div className="mb-3 flex gap-2">
        <input className="input flex-1" aria-label="Palette name" value={e.name} onChange={(ev) => setE({ ...e, name: ev.target.value })} />
        <select className="input" aria-label="Folder" value={e.folder} onChange={(ev) => setE({ ...e, folder: ev.target.value })}>
          <option value="">(unfiled)</option>
          {folders.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
      </div>

      <div className="palette-editor-body mb-4 flex gap-4">
        {/* full-height preview stripes; rows compress as colors are added */}
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto rounded">
          {e.colors.map((c, i) => (
            <div
              key={i}
              className="flex min-h-10 flex-1 items-center gap-2 px-2"
              onDragOver={(ev) => {
                if (dragColor.current !== null) {
                  ev.preventDefault();
                  ev.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={(ev) => {
                ev.preventDefault();
                if (dragColor.current !== null) reorder(dragColor.current, i);
                dragColor.current = null;
              }}
              style={{
                background: c,
                color: contrast(c),
                outline: picking === i ? "2px solid var(--accent)" : "none",
                outlineOffset: -2,
              }}
            >
              <button
                type="button"
                className="grid h-8 w-8 shrink-0 cursor-grab place-items-center rounded opacity-70 hover:opacity-100 active:cursor-grabbing"
                aria-label={`Reorder color ${i + 1}`}
                title="Drag to reorder, or use Arrow Up / Down"
                draggable
                onDragStart={(ev) => {
                  dragColor.current = i;
                  ev.dataTransfer.effectAllowed = "move";
                  ev.dataTransfer.setData("text/plain", String(i));
                  ev.dataTransfer.setDragImage(ev.currentTarget.parentElement!, 16, 16);
                }}
                onDragEnd={() => { dragColor.current = null; }}
                onKeyDown={(ev) => {
                  if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
                    ev.preventDefault();
                    const to = i + (ev.key === "ArrowUp" ? -1 : 1);
                    reorder(i, to);
                    if (to >= 0 && to < e.colors.length) {
                      ev.currentTarget.closest(".palette-editor-body")?.querySelector<HTMLButtonElement>(`[aria-label="Reorder color ${to + 1}"]`)?.focus();
                    }
                  }
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  {[5, 12, 19].map((y) => <g key={y}><circle cx="9" cy={y} r="1.5" /><circle cx="15" cy={y} r="1.5" /></g>)}
                </svg>
              </button>
              {editHex === i ? (
                <input
                  className="w-20 rounded bg-transparent font-mono text-[11px] outline-none"
                  style={{ color: "inherit", boxShadow: hexInvalid ? "0 0 0 2px var(--danger)" : undefined }}
                  aria-label={`Hex for color ${i + 1}`}
                  aria-invalid={hexInvalid}
                  title={hexInvalid ? "Enter a hex color like #a1b2c3 or abc" : undefined}
                  value={hexDraft}
                  autoFocus
                  onChange={(ev) => setHexDraft(ev.target.value)}
                  onBlur={() => commitHex(true)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter") commitHex(false);
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
                <StripeBtn label="Copy hex" onClick={() => copy(c)}><CopyIcon /></StripeBtn>
                <StripeBtn label="Edit hex" onClick={() => { setHexDraft(c); setEditHex(i); }}><PencilIcon /></StripeBtn>
                {/* native picker: works in every browser and needs no source image */}
                <label
                  title="Choose color"
                  className="relative grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded opacity-70 hover:opacity-100 [&>svg]:h-4 [&>svg]:w-4"
                  style={{ background: "rgba(0,0,0,.25)" }}
                >
                  <input
                    type="color"
                    aria-label={`Choose color ${i + 1}`}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                    value={c}
                    onChange={(ev) => setColor(i, ev.target.value.toLowerCase())}
                  />
                  <SwatchIcon />
                </label>
                {canPick && (
                  <StripeBtn label={e.sourceFileId && !hasEyeDropper ? "Pick from image" : "Eyedropper"} onClick={() => void pickWithEyeDropper(i)}><DropperIcon /></StripeBtn>
                )}
                <StripeBtn
                  label="Remove"
                  disabled={e.colors.length <= 1}
                  onClick={() => {
                    setEditHex(null);
                    setPicking(null);
                    setE({ ...e, colors: e.colors.filter((_, j) => j !== i) });
                  }}
                ><XIcon /></StripeBtn>
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
              <>
                <canvas
                  ref={canvasRef}
                  className="absolute inset-0 h-full w-full rounded"
                  style={{ cursor: canvasReady ? "crosshair" : "progress" }}
                  onClick={pickFromCanvas}
                />
                <div
                  className="pointer-events-none absolute left-2 top-2 rounded px-2 py-1 text-xs"
                  style={{ background: "var(--panel)", color: "var(--text-dim)" }}
                >
                  {canvasReady ? `Click to pick color ${picking + 1} · Esc to cancel` : "Loading…"}
                </div>
              </>
            )}
          </div>
        )}
      </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn"
          disabled={saving || e.colors.length >= MAX_PALETTE_COLORS}
          onClick={() => setE({ ...e, colors: [...e.colors, "#888888"] })}
        >
          + Add color
        </button>
        {e.sourceFileId && (
          <span className="flex items-center gap-1">
            <select
              className="input"
              aria-label="Number of colors to extract"
              value={extractN}
              disabled={saving || extracting}
              onChange={(ev) => setExtractN(Number(ev.target.value))}
            >
              {Array.from({ length: MAX_PALETTE_COLORS }, (_, k) => k + 1).map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <button className="btn" disabled={saving || extracting} onClick={() => void reExtract()}>
              {extracting ? "Extracting…" : "Re-extract"}
            </button>
          </span>
        )}
        <button className="btn" disabled={saving} onClick={() => exportPng(e.name, e.colors)}>Export PNG</button>
        <div className="flex-1" />
        <button className="btn" aria-disabled={saving} onClick={requestClose}>Cancel</button>
        <button className="btn primary" disabled={saving || !e.name.trim()} onClick={() => void onSave(e)}>{saving ? "Saving…" : "Save"}</button>
      </div>
    </Dialog>
    {confirmDiscard && (
      <ConfirmDialog
        title="Discard changes?"
        body="This palette has unsaved changes."
        confirmLabel="Discard"
        danger
        onConfirm={onClose}
        onClose={() => setConfirmDiscard(false)}
      />
    )}
    </>
  );
}

/** Icon button inline on a preview stripe (inherits the stripe's contrast color). */
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
      aria-label={label}
      disabled={disabled}
      onClick={(ev) => {
        ev.stopPropagation();
        onClick();
      }}
      className="grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded opacity-70 hover:opacity-100 disabled:opacity-30 [&>svg]:h-4 [&>svg]:w-4"
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
function SwatchIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 0 0 18Z" fill="currentColor" />
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

