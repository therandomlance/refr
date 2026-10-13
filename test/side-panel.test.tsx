import { renderToStaticMarkup } from "react-dom/server";
import type { HTMLAttributes } from "react";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  path: "/browse/folder",
  open: true,
  keys: [] as string[],
  handle: null as HTMLAttributes<HTMLDivElement> | null,
}));
vi.mock("next/navigation", () => ({ usePathname: () => state.path }));
vi.mock("refr/lib/persistent-state", () => ({
  usePersistentBoolean: (key: string) => {
    state.keys.push(key);
    return [state.open, vi.fn()];
  },
}));
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  const capture: typeof runtime.jsxDEV = (type, props, key, isStatic, source, self) => {
    const attributes = props as HTMLAttributes<HTMLDivElement>;
    if (attributes.role === "separator") state.handle = attributes;
    return runtime.jsxDEV(type, props, key, isStatic, source, self);
  };
  return { ...runtime, jsxDEV: capture };
});

import { SidePanel } from "refr/app/_components/side-panel";

afterEach(() => { vi.unstubAllGlobals(); state.open = true; });

it("scopes collapsed state and resized widths to the app section, not browse folders", () => {
  const setItem = vi.fn();
  vi.stubGlobal("localStorage", { setItem });
  for (const path of ["/browse/folder", "/browse/other", "/search", "/queue", "/palettes"]) {
    state.path = path;
    const page = path.split("/")[1]!;
    const html = renderToStaticMarkup(<SidePanel head="Sidebar">Contents</SidePanel>);
    expect(state.keys.at(-1)).toBe(`refr:sidepanel:${page}:open`);
    expect(html).toContain('aria-label="Resize sidebar"');
    const key = (value: string) => state.handle!.onKeyDown!({ key: value, preventDefault: vi.fn() } as unknown as React.KeyboardEvent<HTMLDivElement>);
    key("ArrowRight");
    expect(setItem).toHaveBeenLastCalledWith(`refr:sidepanel:${page}:width`, "250");
    key("Home");
    expect(setItem).toHaveBeenLastCalledWith(`refr:sidepanel:${page}:width`, "180");
    key("End");
    expect(setItem).toHaveBeenLastCalledWith(`refr:sidepanel:${page}:width`, "600");
    const target = { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() };
    const pointer = (x: number) => ({ button: 0, pointerId: 1, clientX: x, currentTarget: target, preventDefault: vi.fn() }) as unknown as React.PointerEvent<HTMLDivElement>;
    state.handle!.onPointerDown!(pointer(100));
    state.handle!.onPointerMove!(pointer(160));
    expect(setItem).toHaveBeenLastCalledWith(`refr:sidepanel:${page}:width`, "300");
    state.handle!.onPointerMove!(pointer(1000));
    expect(setItem).toHaveBeenLastCalledWith(`refr:sidepanel:${page}:width`, "600");
    state.handle!.onPointerUp!(pointer(1000));
    setItem.mockClear();
    state.handle!.onPointerMove!(pointer(150));
    expect(setItem).not.toHaveBeenCalled();
  }
  state.open = false;
  expect(renderToStaticMarkup(<SidePanel head="Sidebar">Contents</SidePanel>)).toContain('aria-label="Show sidebar"');
});
