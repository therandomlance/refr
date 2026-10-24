import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { RouterOutputs } from "refr/trpc/react";
import type { MenuItem } from "refr/app/_components/context-menu";

type Result = RouterOutputs["files"]["sendTo"];
const state = vi.hoisted(() => ({
  hook: 0,
  menu: null as { x: number; y: number; fileIds: string[] } | null,
  items: [] as MenuItem[],
  mutate: vi.fn(),
  notify: vi.fn(),
  options: undefined as { meta: { customFeedback: boolean }; onSuccess: (result: Result) => void } | undefined,
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => [state.hook++ === 0 ? state.menu : initial, (value: typeof state.menu) => { state.menu = value; }],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("refr/app/_components/action-feedback", () => ({ useActionFeedback: () => state.notify }));
vi.mock("refr/app/_components/tag-actions", () => ({ useTagEdit: () => ({ mutate: vi.fn() }) }));
vi.mock("refr/app/_components/context-menu", () => ({
  ContextMenu: ({ items }: { items: MenuItem[] }) => { state.items = items; return null; },
}));
vi.mock("refr/trpc/react", () => ({ api: {
  useUtils: () => ({}),
  queue: { get: { useQuery: () => ({ data: [] }) }, set: { useMutation: () => ({}) } },
  settings: { get: { useQuery: () => ({ data: { sendToPaths: [
    { path: "/references/drawing", alias: "Drawing references" }, { path: "/references/painting" },
  ] } }) } },
  ml: { status: { useQuery: () => ({}) } },
  files: { sendTo: { useMutation: (options: typeof state.options) => { state.options = options; return { mutate: state.mutate }; } } },
} }));

import { useFileContextMenu } from "refr/app/_components/file-menu";

it("sends all selected IDs, uses destination aliases, and reports skipped filenames", () => {
  let actions: ReturnType<typeof useFileContextMenu>;
  const changeSelection = vi.fn();
  function Harness() {
    actions = useFileContextMenu(new Set(["first", "second"]), changeSelection);
    return actions.element;
  }
  const render = () => { state.hook = 0; renderToStaticMarkup(<Harness />); };
  const destinations = () => {
    const item = state.items.find((i) => i !== "sep" && i.label === "Send to");
    if (!item || item === "sep" || !("submenu" in item)) throw new Error("Send to submenu missing");
    return item.submenu;
  };
  const event = { clientX: 10, clientY: 20 } as React.MouseEvent;
  render();
  actions!.open(event, "second");
  render();
  expect(destinations().map((d) => d.label)).toEqual(["Drawing references", "painting"]);
  destinations()[0]!.onClick();
  expect(state.mutate).toHaveBeenLastCalledWith({ fileIds: ["first", "second"], destIndex: 0 });
  expect(state.options?.meta.customFeedback).toBe(true);
  state.options!.onSuccess({ copied: ["first.jpg"], existing: ["second.jpg"], failed: [] });
  expect(state.notify).toHaveBeenLastCalledWith({ message: "Sent 1 file. Skipped 1 already-existing filename: second.jpg.", error: false });

  state.options!.onSuccess({ copied: [], existing: [], failed: [{ id: "gone", name: "gone.jpg", message: "no existing path for file" }] });
  expect(state.notify).toHaveBeenLastCalledWith({ message: "Sent 0 files. Failed 1: gone.jpg: no existing path for file.", error: true });

  actions!.open(event, "unselected");
  render();
  destinations()[1]!.onClick();
  expect(state.mutate).toHaveBeenLastCalledWith({ fileIds: ["unselected"], destIndex: 1 });
  expect(changeSelection).toHaveBeenLastCalledWith(new Set(["unselected"]));
});
