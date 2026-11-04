import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

type Editing = { name: string; colors: string[]; folder: string; orig?: { name: string; folder: string } };
const state = vi.hoisted(() => ({
  hook: 0,
  editing: null as Editing | null,
  onSave: null as ((value: Editing) => Promise<void>) | null,
  save: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = state.hook++;
    return [index === 2 ? state.editing : initial, (value: Editing | null) => { if (index === 2) state.editing = value; }];
  },
}));
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  const capture: typeof runtime.jsxDEV = (type, props, key, isStatic, source, self) => {
    const editor = props as { editing?: Editing; onSave?: typeof state.onSave };
    if (editor.editing && editor.onSave) state.onSave = editor.onSave;
    return runtime.jsxDEV(type, props, key, isStatic, source, self);
  };
  return { ...runtime, jsxDEV: capture };
});
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("refr/app/_components/side-panel", () => ({ SidePanel: () => null }));
vi.mock("refr/app/_components/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => children,
  ConfirmDialog: () => null,
  PromptDialog: () => null,
}));
vi.mock("refr/trpc/react", () => {
  const mutation = () => ({ isPending: false, mutate: vi.fn() });
  return { api: {
    useUtils: () => ({}),
    palettes: {
      list: { useQuery: () => ({ data: { items: [], folders: [] } }) },
      save: { useMutation: () => ({ ...mutation(), mutateAsync: state.save }) },
      delete: { useMutation: () => ({ ...mutation(), mutateAsync: state.remove }) },
      extract: { useMutation: mutation }, move: { useMutation: mutation },
      createFolder: { useMutation: mutation }, renameFolder: { useMutation: mutation }, deleteFolder: { useMutation: mutation },
    },
  } };
});

import PalettesPage from "refr/app/(app)/palettes/page";

it("retains a failed rename draft and deletes the original only after replacement succeeds", async () => {
  const original: Editing = { name: "original", colors: ["#123456"], folder: "", orig: { name: "original", folder: "" } };
  const draft = { ...original, name: "replacement" };
  const render = () => { state.hook = 0; renderToStaticMarkup(<PalettesPage />); };
  state.editing = original;
  state.save.mockRejectedValueOnce(new Error("disk full"));
  render();
  await state.onSave!(draft);
  expect(state.remove).not.toHaveBeenCalled();
  expect(state.editing).toBe(original);

  let release!: (name: string) => void;
  state.save.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
  render();
  const saving = state.onSave!(draft);
  expect(state.remove).not.toHaveBeenCalled();
  expect(state.editing).toBe(original);
  release("replacement");
  await saving;
  expect(state.remove).toHaveBeenCalledExactlyOnceWith(original.orig);
  expect(state.editing).toBeNull();
});
