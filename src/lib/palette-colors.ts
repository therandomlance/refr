/** Move one swatch by index, including when multiple swatches have the same hex. */
export function reorderColor(colors: string[], from: number, to: number): string[] {
  if (from === to || from < 0 || from >= colors.length || to < 0 || to >= colors.length) return colors;
  const next = [...colors];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}
