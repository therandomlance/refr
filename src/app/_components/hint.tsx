import { Icon } from "refr/app/_components/icon";

/** Small ⓘ next to a heading; the explanation lives in its hover text instead of a paragraph. */
export function Hint({ text }: { text: string }) {
  return (
    <span className="hint" title={text} aria-label={text} role="img">
      <Icon name="info" size={14} />
    </span>
  );
}
