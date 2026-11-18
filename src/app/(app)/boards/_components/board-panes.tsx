"use client";

import { Icon } from "refr/app/_components/icon";
import { VIEWER_SHORTCUTS } from "refr/lib/keyboard";
import { BOARD_COLORS, type Arrow, type BoardColor, type TextItem } from "refr/lib/boards";

type PaneBtn = { label: string; on: boolean; onClick: () => void; content: React.ReactNode; hint?: string };

function PaneButton({ label, on, onClick, content, hint }: PaneBtn) {
  return (
    <button
      type="button"
      className={on ? "on" : ""}
      aria-pressed={on}
      aria-label={label}
      title={hint ? `${label} (${hint})` : label}
      onClick={onClick}
    >
      {content}
    </button>
  );
}

const Sep = () => <span className="sep" aria-hidden="true" />;

/** Study tools for the selected image(s) — same set and keys as the viewer, saved per image. */
export function StudyPane({
  state,
  onFlip,
  onGray,
  onBlur,
  onValue,
  onGrid,
}: {
  state: { flip: boolean; gray: boolean; blur: boolean; value: number; grid: "off" | "thirds" | "4x4" };
  onFlip: () => void;
  onGray: () => void;
  onBlur: () => void;
  onValue: () => void;
  onGrid: () => void;
}) {
  const k = (name: keyof typeof VIEWER_SHORTCUTS) => VIEWER_SHORTCUTS[name].hint();
  return (
    <div className="board-pane vertical" role="toolbar" aria-label="Study tools">
      <PaneButton label="Flip horizontally" hint={k("flip")} on={state.flip} onClick={onFlip} content={<Icon name="flip" />} />
      <PaneButton label="Grayscale" hint={k("gray")} on={state.gray} onClick={onGray} content={<Icon name="contrast" />} />
      <PaneButton label="Squint blur" hint={k("blur")} on={state.blur} onClick={onBlur} content={<Icon name="blur" />} />
      <PaneButton
        label={state.value ? `Value steps: ${state.value}` : "Value steps"}
        hint={k("value")}
        on={state.value > 0}
        onClick={onValue}
        content={state.value ? <span className="vstudy-n">{state.value}</span> : <Icon name="steps" />}
      />
      <PaneButton
        label={state.grid === "off" ? "Grid overlay" : `Grid overlay: ${state.grid}`}
        hint={k("grid")}
        on={state.grid !== "off"}
        onClick={onGrid}
        content={<Icon name="gridlines" />}
      />
    </div>
  );
}

const COLOR_LABEL: Record<BoardColor, string> = { fg: "Default", muted: "Muted", accent: "Accent", danger: "Red" };

function Swatches({ value, onChange }: { value: BoardColor; onChange: (c: BoardColor) => void }) {
  return (
    <>
      {BOARD_COLORS.map((c) => (
        <PaneButton key={c} label={`Colour: ${COLOR_LABEL[c]}`} on={value === c} onClick={() => onChange(c)} content={<span className={`board-swatch c-${c}`} />} />
      ))}
    </>
  );
}

/** Formatting for the selected text box(es). The first selected box shows the current values. */
export function TextPane({ text, onChange, onEdit }: { text: TextItem; onChange: (patch: Partial<TextItem>) => void; onEdit: () => void }) {
  return (
    <div className="board-pane" role="toolbar" aria-label="Text formatting">
      <PaneButton label="Edit text (double-click or Enter)" on={false} onClick={onEdit} content={<Icon name="text" />} />
      <Sep />
      {(["s", "m", "l", "xl"] as const).map((s) => (
        <PaneButton key={s} label={`Size ${s.toUpperCase()}`} on={text.size === s} onClick={() => onChange({ size: s })} content={<span className="vstudy-n">{s.toUpperCase()}</span>} />
      ))}
      <Sep />
      {(["left", "center", "right"] as const).map((a) => (
        <PaneButton key={a} label={`Align ${a}`} on={text.align === a} onClick={() => onChange({ align: a })} content={<Icon name={`align-${a}`} />} />
      ))}
      <Sep />
      <Swatches value={text.color} onChange={(color) => onChange({ color })} />
      <Sep />
      {(["none", "card", "accent"] as const).map((b) => (
        <PaneButton key={b} label={`Background: ${b}`} on={text.bg === b} onClick={() => onChange({ bg: b })} content={<span className={`board-bg-swatch bg-${b}`} />} />
      ))}
    </div>
  );
}

/** Style for the selected arrow(s). */
export function ArrowPane({ arrow, onChange }: { arrow: Arrow; onChange: (patch: Partial<Arrow>) => void }) {
  return (
    <div className="board-pane" role="toolbar" aria-label="Arrow style">
      {(["s", "m", "l"] as const).map((w) => (
        <PaneButton key={w} label={`Line ${w === "s" ? "thin" : w === "m" ? "medium" : "thick"}`} on={arrow.width === w} onClick={() => onChange({ width: w })}
          content={<span className="board-line-swatch" style={{ height: w === "s" ? 1.5 : w === "m" ? 3 : 5 }} />} />
      ))}
      <PaneButton label="Dashed" on={arrow.dashed} onClick={() => onChange({ dashed: !arrow.dashed })} content={<span className="board-line-swatch dashed" />} />
      <Sep />
      {(["end", "both", "none"] as const).map((h) => (
        <PaneButton key={h} label={`Arrowheads: ${h}`} on={arrow.heads === h} onClick={() => onChange({ heads: h })}
          content={<span className="glyph">{h === "end" ? "→" : h === "both" ? "↔" : "—"}</span>} />
      ))}
      <Sep />
      <Swatches value={arrow.color} onChange={(color) => onChange({ color })} />
    </div>
  );
}
