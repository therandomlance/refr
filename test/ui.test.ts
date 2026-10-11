import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ failed: false }));
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
    data: state.failed ? undefined : { items: [file], pages: [{ items: [file] }] },
    isError: state.failed, error: new Error("offline"), isLoading: false, isFetching: false,
    fetchNextPage: vi.fn(), fetchPreviousPage: vi.fn(), refetch: vi.fn(),
  });
  const mutation = () => ({ isPending: false, mutate: vi.fn(), mutateAsync: async () => ({ changes: [] }) });
  return { api: {
    useUtils: () => ({}),
    files: { list: { useQuery: query, useInfiniteQuery: query }, timeline: { useQuery: () => ({}) } },
    search: { query: { useInfiniteQuery: query }, timeline: { useQuery: () => ({}) } },
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
