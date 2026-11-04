import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ failed: false, extraFiles: false, timeline: false, loadedMonth: false, firstPagePending: false, monthFailed: false, monthCount: 600, monthSeeds: 0, monthRequests: 0, searchOptions: {} as { staleTime?: string }, idsQuery: vi.fn(), notify: vi.fn(), selectAll: undefined as (() => Promise<void>) | undefined }));
// Capture the rendered control to exercise its async handler without a DOM dependency.
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  return { ...runtime, jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
    const [type, props] = args;
    const button = props as { children?: unknown; onClick?: () => Promise<void> };
    if (type === "button" && button.children === "Select all") state.selectAll = button.onClick;
    return runtime.jsxDEV(...args);
  } };
});
vi.mock("refr/app/_components/action-feedback", () => ({ useActionFeedback: () => state.notify }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/queue", useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams(),
}));
vi.mock("refr/app/_components/viewer", () => ({ Viewer: () => null }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 300, size: 300 })),
    getTotalSize: () => count * 300, measureElement: vi.fn(),
  }),
}));
vi.mock("refr/trpc/react", () => {
  const file = { id: "ui1", mediaType: "image", width: 100, height: 100, duration: null, mtime: 0 };
  const query = () => ({
    data: state.failed || state.firstPagePending ? undefined : {
      items: state.extraFiles ? [file, { ...file, id: "ui2", width: 200 }, { ...file, id: "ui3", width: 50 }] : [file],
      pages: [{ items: state.extraFiles ? [file, { ...file, id: "ui2", width: 200 }, { ...file, id: "ui3", width: 50 }] : [file] }],
    },
    isError: state.failed, error: new Error("offline"), isLoading: state.firstPagePending, isFetching: state.firstPagePending,
    dataUpdatedAt: 1000,
    fetchNextPage: vi.fn(), fetchPreviousPage: vi.fn(), refetch: vi.fn(),
  });
  const mutation = () => ({ isPending: false, mutate: vi.fn(), mutateAsync: async () => ({ changes: [] }) });
  const timeline = () => ({ data: state.timeline ? [{ year: 1970, month: 1, count: state.monthCount, minMtime: 0, maxMtime: 0 }] : undefined });
  const month = (_input: unknown, options: { initialData?: { items: typeof file[] }; enabled?: boolean }) => options;
  return { api: {
    useUtils: () => ({ client: { files: { ids: { query: state.idsQuery } } } }),
    useQueries: (getQueries: (t: { files: { list: typeof month }; search: { query: typeof month } }) => ReturnType<typeof month>[], options: { combine: (results: { data?: { items: typeof file[] }; error: Error | null; refetch: () => void }[]) => unknown }) => {
      const queries = getQueries({ files: { list: month }, search: { query: month } });
      state.monthSeeds = queries.filter((q) => q.initialData).length;
      state.monthRequests = queries.filter((q) => q.enabled && !q.initialData).length;
      return options.combine(queries.map((q) => ({ data: state.loadedMonth ? { items: [file] } : q.initialData, error: state.failed || state.monthFailed ? new Error("offline") : null, refetch: vi.fn() })));
    },
    files: { list: { useQuery: query, useInfiniteQuery: query }, timeline: { useQuery: timeline } },
    search: { query: { useInfiniteQuery: (_input: unknown, options: { staleTime?: string }) => { state.searchOptions = options; return query(); } }, timeline: { useQuery: timeline } },
    settings: { get: { useQuery: () => ({}) }, patch: { useMutation: mutation } },
    tags: { setTags: { useMutation: mutation }, undo: { useMutation: mutation } },
  } };
});

it.each(["files", "search"] as const)("starts thumbnails from the first page before its full timeline month loads (%s)", (kind) => {
  state.timeline = true;
  const source = kind === "files" ? { kind } : { kind, tokens: [] };
  const render = () => renderToStaticMarkup(createElement(MediaGrid, { source, selection: new Set<string>(), onSelectionChange: vi.fn() }));
  try {
    state.firstPagePending = true;
    const loading = render();
    expect(loading).toContain('role="scrollbar"');
    expect(loading).toContain('class="tl-placeholder"');
    expect(loading).not.toContain("Nothing here yet");
    expect(loading).not.toContain('data-file-id="ui1"');
    expect(state.monthRequests).toBe(0); // wait for the first page before deciding what needs fetching
    state.firstPagePending = false;
    const preview = render();
    expect(preview).toContain('data-file-id="ui1"');
    expect(preview).toContain('class="tl-placeholder"'); // room remains for the rest of the month
    state.monthFailed = true;
    expect(render()).toContain('data-file-id="ui1"'); // a background failure must not erase the preview
    expect(render()).toContain("Try again");
    state.monthFailed = false;
    state.failed = true;
    expect(render()).toContain("Could not load images. offline");
    expect(render()).toContain("Try again");
    state.failed = false;
    state.loadedMonth = true;
    const loaded = render();
    expect(loaded.match(/data-file-id="ui1"/g)).toHaveLength(1);
    expect(loaded).not.toContain('class="tl-placeholder"');
  } finally { state.timeline = false; state.loadedMonth = false; state.failed = false; state.firstPagePending = false; state.monthFailed = false; }
});

it.each(["files", "search"] as const)("seeds a fully covered month without another metadata request (%s)", (kind) => {
  state.timeline = true;
  state.monthCount = 1;
  const source = kind === "files" ? { kind } : { kind, tokens: [] };
  try {
    const html = renderToStaticMarkup(createElement(MediaGrid, { source, selection: new Set<string>(), onSelectionChange: vi.fn() }));
    expect(html).toContain('data-file-id="ui1"');
    expect(html).not.toContain('class="tl-placeholder"');
    expect(state.monthSeeds).toBe(1);
    expect(state.monthRequests).toBe(0);
  } finally { state.timeline = false; state.monthCount = 600; }
});

import { MediaGrid } from "refr/app/_components/media-grid";
import { Tree } from "refr/app/_components/tree";

it.each(["folder", "tag"] as const)("selects every matching browse ID across pages, not just loaded thumbnails (%s)", async (kind) => {
  state.idsQuery.mockReset()
    .mockResolvedValueOnce({ ids: ["ui1", "unloaded-1"], nextCursor: "unloaded-1" })
    .mockResolvedValueOnce({ ids: ["unloaded-2", "unloaded-3"], nextCursor: null });
  const onSelectionChange = vi.fn();
  const filter = kind === "folder" ? { pathPrefix: "/select-all/folder" } : { tag: "select-all/tag" };
  renderToStaticMarkup(createElement(MediaGrid, { source: { kind: "files", ...filter }, selection: new Set(["ui1"]), onSelectionChange }));
  await state.selectAll!();
  expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith(new Set(["ui1", "unloaded-1", "unloaded-2", "unloaded-3"]));
  expect(state.idsQuery).toHaveBeenCalledTimes(2);
  expect(state.idsQuery.mock.calls[0]?.[0]).toMatchObject({ ...filter, recursive: true, cursor: null });
  expect(state.idsQuery.mock.calls[1]?.[0]).toMatchObject({ ...filter, recursive: true, cursor: "unloaded-1" });
  expect(state.idsQuery.mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) });
});

it("leaves the existing selection intact if an ID page fails", async () => {
  state.idsQuery.mockReset()
    .mockResolvedValueOnce({ ids: ["ui1", "unloaded"], nextCursor: "unloaded" })
    .mockRejectedValueOnce(new Error("offline"));
  state.notify.mockClear();
  const onSelectionChange = vi.fn();
  renderToStaticMarkup(createElement(MediaGrid, { source: { kind: "files", tag: "select-all" }, selection: new Set(["ui1"]), onSelectionChange }));
  await state.selectAll!();
  expect(onSelectionChange).not.toHaveBeenCalled();
  expect(state.notify).toHaveBeenCalledWith({ message: "offline", error: true });
});

it.each(["search", "ids"] as const)("keeps the existing select-all behavior outside browse (%s)", async (kind) => {
  state.idsQuery.mockClear();
  const onSelectionChange = vi.fn();
  const source = kind === "search" ? { kind, tokens: [] } : { kind, ids: ["ui1"] };
  renderToStaticMarkup(createElement(MediaGrid, { source, selection: new Set(["ui1"]), onSelectionChange }));
  await state.selectAll!();
  expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith(new Set(["ui1"]));
  expect(state.idsQuery).not.toHaveBeenCalled();
});

it("renders separate keyboard controls and distinguishes failed queries from empty lists", () => {
  const props = { source: { kind: "ids" as const, ids: ["ui1"] }, selection: new Set<string>(), onSelectionChange: vi.fn(), onContextMenu: vi.fn() };
  const grid = renderToStaticMarkup(createElement(MediaGrid, props));
  expect(grid).toContain("padding:3px 0 7px"); // 10px between images, matching horizontal padding + gap
  for (const name of ["Open image 1", "Select image 1", "Actions for image 1"]) expect(grid).toContain(`aria-label="${name}"`);
  expect(grid).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/);
  const tree = renderToStaticMarkup(createElement(Tree, {
    roots: [{ key: "root", name: "Root", hasChildren: true }], loadChildren: async () => [], selected: "root", onSelect: vi.fn(), onContext: vi.fn(),
  }));
  expect(tree).toContain('aria-label="Expand Root"');
  expect(tree).toContain('aria-label="Actions for Root"');
  state.failed = true;
  const failed = renderToStaticMarkup(createElement(MediaGrid, props));
  expect(failed).toContain("Could not load images");
  expect(failed).toContain("Try again");
  expect(failed).not.toContain("Nothing here yet");
  state.failed = false;
});

it("uses static candidates only for suggest searches and exposes manual refresh", () => {
  const token = { kind: "tag" as const, tag: "suggest:figure", negate: false, exact: false, or: false, wildcard: false };
  const props = { source: { kind: "search" as const, tokens: [token] }, selection: new Set<string>(), onSelectionChange: vi.fn() };
  const suggestions = renderToStaticMarkup(createElement(MediaGrid, props));
  expect(state.searchOptions.staleTime).toBe("static");
  expect(suggestions).toContain("Refresh suggestions");
  renderToStaticMarkup(createElement(MediaGrid, { ...props, source: { kind: "search", tokens: [{ ...token, tag: "figure" }] } }));
  expect(state.searchOptions.staleTime).toBeUndefined();
});

it("hides reviewed thumbnails and restores their original layout on undo", () => {
  const props = { source: { kind: "ids" as const, ids: ["ui1"] }, selection: new Set<string>(), onSelectionChange: vi.fn() };
  const shown = renderToStaticMarkup(createElement(MediaGrid, props));
  const hidden = renderToStaticMarkup(createElement(MediaGrid, { ...props, hiddenIds: new Set(["ui1"]) }));
  expect(hidden).not.toContain('aria-label="Open image 1"');
  const restored = renderToStaticMarkup(createElement(MediaGrid, { ...props, hiddenIds: new Set<string>() }));
  expect(restored).toBe(shown);
});

it.each(["ids", "search"] as const)("shifts fixed-height thumbnails and restores them on undo (%s)", (kind) => {
  state.extraFiles = true;
  try {
    const source = kind === "ids" ? { kind, ids: ["ui1", "ui2", "ui3"] } : { kind, tokens: [{ kind: "tag" as const, tag: "suggest:figure", negate: false, exact: false, or: false, wildcard: false }] };
    const props = { source, selection: new Set<string>(), onSelectionChange: vi.fn() };
    const shown = renderToStaticMarkup(createElement(MediaGrid, props));
    const hidden = renderToStaticMarkup(createElement(MediaGrid, { ...props, hiddenIds: new Set(["ui2"]) }));
    const ids = (markup: string) => [...markup.matchAll(/data-file-id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids(shown)).toEqual(["ui1", "ui2", "ui3"]);
    expect(ids(hidden)).toEqual(["ui1", "ui3"]);
    const sizes = (markup: string) => [...markup.matchAll(/width:([\d.]+)px;height:([\d.]+)px;padding/g)].map((match) => [match[1], match[2]]);
    const originalSizes = sizes(shown);
    expect(originalSizes).toHaveLength(3);
    expect(originalSizes.every((size) => size[1] === "300")).toBe(true);
    expect(sizes(hidden)).toEqual([originalSizes[0], originalSizes[2]]);
    expect(originalSizes[1]).not.toEqual(originalSizes[2]); // different aspect ratios
    expect(renderToStaticMarkup(createElement(MediaGrid, { ...props, hiddenIds: new Set<string>() }))).toBe(shown);
    const allHidden = renderToStaticMarkup(createElement(MediaGrid, { ...props, hiddenIds: new Set(["ui1", "ui2", "ui3"]) }));
    expect(allHidden).not.toContain('class="ghead"');
    expect(ids(allHidden)).toEqual([]);
  } finally { state.extraFiles = false; }
});
