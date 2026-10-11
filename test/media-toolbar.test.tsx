import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MediaGrid } from "refr/app/_components/media-grid";
import { TRPCReactProvider } from "refr/trpc/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/search",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

it("renders search, view controls, selection actions, and thumbnail sizes in one shared toolbar", () => {
  const html = renderToStaticMarkup(
    <TRPCReactProvider>
      <MediaGrid
        source={{ kind: "search", tokens: [] }}
        selection={new Set(["selected"])}
        onSelectionChange={() => undefined}
        toolbarSearch={<input aria-label="Search references" />}
      />
    </TRPCReactProvider>,
  );
  expect(html.indexOf('class="gallery-toolbar"')).toBeLessThan(html.indexOf('aria-label="Search references"'));
  expect(html.indexOf('aria-label="Search references"')).toBeLessThan(html.indexOf('class="gallery-toolbar-end"'));
  expect(html.indexOf('class="gallery-toolbar-end"')).toBeLessThan(html.indexOf('class="gallery-view-controls"'));
  for (const label of ["Rows", "Columns", "Sort images", "Group images", "Select all", "Clear selection", "Selection actions", "small thumbnails", "medium thumbnails", "large thumbnails"]) {
    expect(html).toContain(label);
  }
  const withoutSearch = renderToStaticMarkup(
    <TRPCReactProvider>
      <MediaGrid source={{ kind: "files" }} selection={new Set()} onSelectionChange={() => undefined} />
    </TRPCReactProvider>,
  );
  expect(withoutSearch.indexOf('class="gallery-view-controls"')).toBeLessThan(withoutSearch.indexOf('class="gallery-toolbar-end"'));
});
