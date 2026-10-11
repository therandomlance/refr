import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ failed: false, extraFiles: false, searchOptions: {} as { staleTime?: string } }));
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
    data: state.failed ? undefined : {
      items: state.extraFiles ? [file, { ...file, id: "ui2", width: 200 }, { ...file, id: "ui3", width: 50 }] : [file],
      pages: [{ items: [file] }],
    },
    isError: state.failed, error: new Error("offline"), isLoading: false, isFetching: false,
    fetchNextPage: vi.fn(), fetchPreviousPage: vi.fn(), refetch: vi.fn(),
  });
  const mutation = () => ({ isPending: false, mutate: vi.fn(), mutateAsync: async () => ({ changes: [] }) });
  return { api: {
    useUtils: () => ({}),
    files: { list: { useQuery: query, useInfiniteQuery: query }, timeline: { useQuery: () => ({}) } },
    search: { query: { useInfiniteQuery: (_input: unknown, options: { staleTime?: string }) => { state.searchOptions = options; return query(); } }, timeline: { useQuery: () => ({}) } },
    settings: { get: { useQuery: () => ({}) }, patch: { useMutation: mutation } },
    tags: { setTags: { useMutation: mutation }, undo: { useMutation: mutation } },
  } };
});

import { MediaGrid } from "refr/app/_components/media-grid";
import { Tree } from "refr/app/_components/tree";

it("renders separate keyboard controls and distinguishes failed queries from empty lists", () => {
  const props = { source: { kind: "ids" as const, ids: ["ui1"] }, selection: new Set<string>(), onSelectionChange: vi.fn(), onContextMenu: vi.fn() };
  const grid = renderToStaticMarkup(createElement(MediaGrid, props));
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

it("hides reviewed thumbnails without removing their row or changing grid heights", () => {
  const props = { source: { kind: "ids" as const, ids: ["ui1"] }, selection: new Set<string>(), onSelectionChange: vi.fn() };
  const shown = renderToStaticMarkup(createElement(MediaGrid, props));
  const hidden = renderToStaticMarkup(createElement(MediaGrid, { ...props, hiddenIds: new Set(["ui1"]) }));
  expect(hidden).toContain('aria-hidden="true"');
  expect(hidden).toContain("visibility:hidden");
  expect(hidden).not.toContain('aria-label="Open image 1"');
  expect(hidden.match(/height:[^;"]+/g)).toEqual(shown.match(/height:[^;"]+/g));
  const restored = renderToStaticMarkup(createElement(MediaGrid, { ...props, hiddenIds: new Set<string>() }));
  expect(restored).toBe(shown);
});

it("shifts only later thumbnails into fixed slots and restores their order on undo", () => {
  state.extraFiles = true;
  try {
    const props = { source: { kind: "ids" as const, ids: ["ui1", "ui2", "ui3"] }, selection: new Set<string>(), onSelectionChange: vi.fn() };
    const shown = renderToStaticMarkup(createElement(MediaGrid, props));
    const hidden = renderToStaticMarkup(createElement(MediaGrid, { ...props, hiddenIds: new Set(["ui2"]) }));
    const ids = (markup: string) => [...markup.matchAll(/data-file-id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids(shown)).toEqual(["ui1", "ui2", "ui3"]);
    expect(ids(hidden)).toEqual(["ui1", "ui3"]);
    expect(hidden.match(/(?:width|height):[^;"]+/g)).toEqual(shown.match(/(?:width|height):[^;"]+/g));
    expect(renderToStaticMarkup(createElement(MediaGrid, { ...props, hiddenIds: new Set<string>() }))).toBe(shown);
  } finally { state.extraFiles = false; }
});
