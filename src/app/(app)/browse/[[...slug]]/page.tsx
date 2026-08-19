"use client";

import { useCallback, useMemo, useState, useEffect } from "react";
import { usePathname, useRouter, useParams, useSearchParams } from "next/navigation";
import { api } from "refr/trpc/react";
import { MediaGrid } from "refr/app/_components/media-grid";
import { SidePanel } from "refr/app/_components/side-panel";
import { Tree, childSegments, type TreeNodeData } from "refr/app/_components/tree";
import { useFileContextMenu } from "refr/app/_components/file-menu";
import { ContextMenu } from "refr/app/_components/context-menu";
import { ConfirmDialog, PromptDialog } from "refr/app/_components/dialog";
import { publishViewerList } from "refr/app/_components/viewer-store";

export default function BrowsePage() {
  const router = useRouter();
  const pathname = usePathname();
  const urlParams = useParams<{ slug?: string[] }>();
  const searchParams = useSearchParams();

  // Derive mode + selected from the URL path:
  //   /browse/tags/reference/figure  → tags, "reference/figure"
  //   /browse/folders/mnt/network     → folders, "/mnt/network"
  //   /browse                        → folders (default), null
  // Decode each segment — useParams() may return URL-encoded values for
  // catch-all routes (e.g. "ai%20generated" instead of "ai generated").
  const slug = (urlParams.slug ?? []).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const mode: "folders" | "tags" = slug[0] === "tags" ? "tags" : "folders";
  const selectedPath = slug.slice(1).join("/");
  const selected = slug.length > 1 ? (mode === "folders" ? "/" + selectedPath : selectedPath) : null;

  // Navigate while preserving query params (especially ?v= for the viewer)
  const push = useCallback(
    (path: string) => {
      const qs = searchParams.toString();
      router.push(qs ? `${path}?${qs}` : path);
    },
    [router, searchParams],
  );
  // Encode each path segment so spaces/special chars don't break routing.
  // The key is a full tag/folder path with "/" separators; each segment is
  // individually encodeURIComponent'd.
  const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");
  const selectNode = useCallback(
    (key: string | null) => {
      if (!key) push(`/browse/${mode}`);
      else if (mode === "folders") push(`/browse/folders/${encodePath(key.replace(/^\//, ""))}`);
      else push(`/browse/tags/${encodePath(key)}`);
    },
    [mode, push],
  );
  const switchMode = useCallback(
    (m: "folders" | "tags") => push(`/browse/${m}`),
    [push],
  );

  const [selection, setSelection] = useState<Set<string>>(new Set());
  const fileMenu = useFileContextMenu(selection, setSelection);

  // tag management dialogs
  const [tagMenu, setTagMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  const [renameOf, setRenameOf] = useState<string | null>(null);
  const [mergeOf, setMergeOf] = useState<string | null>(null);
  const [deleteOf, setDeleteOf] = useState<string | null>(null);

  const utils = api.useUtils();
  const folders = api.browse.folderTree.useQuery();
  const tags = api.browse.tagTree.useQuery();
  const mlStatus = api.ml.status.useQuery();

  const renameM = api.tags.rename.useMutation({ onSuccess: () => void utils.browse.tagTree.invalidate() });
  const mergeM = api.tags.merge.useMutation({ onSuccess: () => void utils.browse.tagTree.invalidate() });
  const deleteM = api.tags.delete.useMutation({ onSuccess: () => void utils.browse.tagTree.invalidate() });
  const setTags = api.tags.setTags.useMutation({ onSuccess: () => void utils.invalidate() });
  const excludeSuggestion = api.ml.excludeSuggestion.useMutation({
    onSuccess: () => void utils.ml.suggestImagesForTag.invalidate(),
  });

  const tagNames = useMemo(() => (tags.data ?? []).filter((t) => t.count > 0).map((t) => t.name), [tags.data]);
  const tagCounts = useMemo(() => new Map((tags.data ?? []).map((t) => [t.name, t.count])), [tags.data]);

  const tagChildren = useCallback(
    async (key: string | null): Promise<TreeNodeData[]> => {
      return childSegments(tagNames, key).map((n) => ({ ...n, count: tagCounts.get(n.key) }));
    },
    [tagNames, tagCounts],
  );

  const folderChildren = useCallback(
    async (key: string): Promise<TreeNodeData[]> => {
      const client = await utils.browse.children.fetch({ path: key });
      return client.map((c) => ({ name: c.name, key: c.path, hasChildren: c.hasChildren }));
    },
    [utils],
  );

  // cards of the selected node's children shown atop the grid
  const [childCards, setChildCards] = useState<TreeNodeData[]>([]);
  const rootCards: TreeNodeData[] = useMemo(() => {
    if (mode === "folders") {
      return (folders.data ?? []).map((f) => ({ name: f.name, key: f.path, hasChildren: f.hasChildren }));
    }
    return childSegments(tagNames, null).map((n) => ({ ...n, count: tagCounts.get(n.key) }));
  }, [mode, folders.data, tagNames, tagCounts]);

  useEffect(() => {
    if (selected === null) {
      setChildCards([]);
      return;
    }
    void (mode === "folders" ? folderChildren(selected) : tagChildren(selected)).then(setChildCards);
  }, [selected, mode, folderChildren, tagChildren]);

  // suggested strip for tag mode
  const suggestions = api.ml.suggestImagesForTag.useQuery(
    { tag: selected ?? "" },
    { enabled: mode === "tags" && selected !== null && mlStatus.data?.state === "ready" },
  );
  const [stripOpen, setStripOpen] = useState(true);

  const crumbs = selected ? selected.split("/").filter(Boolean) : [];
  const crumbPath = (i: number) => {
    const joined = crumbs.slice(0, i + 1).join("/");
    return mode === "folders" && selected!.startsWith("/") ? "/" + joined : joined;
  };

  return (
    <div className="flex min-h-0 flex-1">
      <SidePanel
        head={
          <>
            <h2 className="text-[13px] font-semibold">Browse</h2>
            <div className="seg">
              <button className={mode === "folders" ? "on" : ""} onClick={() => switchMode("folders")}>Folders</button>
              <button className={mode === "tags" ? "on" : ""} onClick={() => switchMode("tags")}>Tags</button>
            </div>
          </>
        }
      >
        <div className="flex-1 px-2 pb-4">
          {mode === "folders" && (
            <Tree
              roots={rootCards}
              loadChildren={folderChildren}
              selected={selected}
              onSelect={selectNode}
            />
          )}
          {mode === "tags" && (
            <Tree
              roots={rootCards}
              loadChildren={tagChildren}
              selected={selected}
              onSelect={selectNode}
              onContext={(key, x, y) => setTagMenu({ key, x, y })}
            />
          )}
        </div>
      </SidePanel>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-none items-center gap-1 px-4 py-3 text-sm" style={{ color: "var(--text-dim)" }}>
          <button className="hover:underline" onClick={() => selectNode(null)} style={{ color: selected ? undefined : "var(--text)", fontWeight: selected ? 400 : 600 }}>
            {mode === "folders" ? "Libraries" : "Tags"}
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              <span style={{ opacity: 0.5 }}>/</span>
              <button
                className="hover:underline"
                style={{ color: i === crumbs.length - 1 ? "var(--text)" : undefined, fontWeight: i === crumbs.length - 1 ? 600 : 400 }}
                onClick={() => selectNode(crumbPath(i))}
              >
                {c}
              </button>
            </span>
          ))}
        </div>

        {selected === null ? (
          <div className="scroll-thin flex-1 overflow-y-auto p-4">
            <div className="flex flex-wrap gap-3">
              {rootCards.map((c) => (
                <Card key={c.key} node={c} onOpen={() => selectNode(c.key)} />
              ))}
            </div>
            {rootCards.length === 0 && (
              <p className="text-sm" style={{ color: "var(--text-faint)" }}>
                {mode === "folders"
                  ? "No libraries configured. Add library paths in Settings."
                  : "No tags yet. Tag some files first."}
              </p>
            )}
          </div>
        ) : (
          <>
            {mode === "tags" && suggestions.data && suggestions.data.length > 0 && (
              <div className="mx-4 mb-2 flex-none rounded" style={{ background: "var(--panel)", border: "1px solid var(--border)" }}>
                <button className="flex w-full items-center gap-2 px-3 py-2 text-xs font-semibold" onClick={() => setStripOpen(!stripOpen)}>
                  {stripOpen ? "▾" : "▸"} Suggested for this tag
                  <span style={{ color: "var(--text-faint)", fontWeight: 400 }}>{suggestions.data.length}</span>
                </button>
                {stripOpen && (
                  <div className="scroll-thin flex gap-3 overflow-x-auto px-3 pb-3">
                    {suggestions.data.map((s) => (
                      <div key={s.fileId} className="tile" style={{ width: 220, height: 148 }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`/api/thumb/${s.fileId}`} alt="" onClick={() => publishAndOpen(s.fileId)} />
                        <button
                          className="check"
                          style={{ opacity: 1, background: "var(--accent)", borderColor: "var(--accent)", width: 32, height: 32, fontSize: 18 }}
                          title="Accept tag"
                          onClick={() => setTags.mutate({ fileIds: [s.fileId], add: [selected], remove: [] })}
                        >
                          ✓
                        </button>
                        <button
                          className="x"
                          style={{ top: 6, right: 6, width: 22, height: 22, fontSize: 12, background: "var(--panel)", border: "1px solid var(--border)", borderRadius: "50%", display: "grid", placeItems: "center", cursor: "pointer", zIndex: 2 }}
                          title="Exclude from suggestions"
                          onClick={() => excludeSuggestion.mutate({ tag: selected ?? "", fileId: s.fileId })}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <MediaGrid
              source={mode === "folders" ? { kind: "files", pathPrefix: selected } : { kind: "files", tag: selected }}
              selection={selection}
              onSelectionChange={setSelection}
              onContextMenu={fileMenu.open}
              header={
                childCards.length > 0 ? (
                  <div className="flex flex-wrap gap-3 pb-3 pt-1">
                    {childCards.map((c) => (
                      <Card key={c.key} node={c} onOpen={() => selectNode(c.key)} />
                    ))}
                  </div>
                ) : null
              }
            />
          </>
        )}
      </main>

      {fileMenu.element}
      {tagMenu && (
        <ContextMenu
          x={tagMenu.x}
          y={tagMenu.y}
          onClose={() => setTagMenu(null)}
          items={[
            { label: "Rename…", onClick: () => setRenameOf(tagMenu.key) },
            { label: "Merge into…", onClick: () => setMergeOf(tagMenu.key) },
            { label: "Delete…", onClick: () => setDeleteOf(tagMenu.key), danger: true },
          ]}
        />
      )}
      {renameOf && (
        <PromptDialog
          title="Rename tag"
          label={`Rename '${renameOf}' (and all subtags) to:`}
          initial={renameOf}
          onSubmit={(v) => renameM.mutate({ oldName: renameOf, newName: v })}
          onClose={() => setRenameOf(null)}
        />
      )}
      {mergeOf && (
        <PromptDialog
          title="Merge tag"
          label={`Merge '${mergeOf}' into:`}
          onSubmit={(v) => mergeM.mutate({ sources: [mergeOf], target: v })}
          onClose={() => setMergeOf(null)}
        />
      )}
      {deleteOf && (
        <ConfirmDialog
          title="Delete tag"
          body={<>Delete <b>{deleteOf}</b> and all subtags? This removes the tag from <b>{tagCounts.get(deleteOf) ?? 0}</b> files. Files are not deleted.</>}
          confirmLabel="Delete"
          danger
          onConfirm={() => deleteM.mutate({ name: deleteOf })}
          onClose={() => setDeleteOf(null)}
        />
      )}
    </div>
  );

  function publishAndOpen(id: string) {
    publishViewerList({ items: suggestions.data!.map((s) => ({ id: s.fileId, mediaType: "image", width: null, height: null, duration: null, mtime: 0 })), loadMore: null, hasMore: false });
    const p = new URLSearchParams(window.location.search);
    p.set("v", id);
    router.push(`${pathname}?${p.toString()}`);
  }
}

function Card({ node, onOpen }: { node: TreeNodeData; onOpen: () => void }) {
  return (
    <div
      className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg p-4 text-center"
      style={{ width: 120, height: 96, background: "var(--panel)", border: "1px solid var(--border)" }}
      onClick={onOpen}
    >
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: "var(--text-dim)" }}>
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
      <div className="w-full truncate text-xs">{node.name}</div>
      {node.count !== undefined && <div className="text-[10px]" style={{ color: "var(--text-faint)" }}>{node.count}</div>}
    </div>
  );
}
