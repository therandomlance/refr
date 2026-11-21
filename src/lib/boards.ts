/** Moodboard document shape + pure geometry — shared by the boards service and the canvas. */
import { z } from "zod";
import type { TreeNode } from "./folder-tree";

/** Sidebar entry for a board (folders/order are stored apart from the board files). */
export type BoardLeaf = { t: "board"; name: string };
export type BoardTreeNode = TreeNode<BoardLeaf>;

/** Colour names map to theme tokens in CSS (never raw colours in the document). */
export const BOARD_COLORS = ["fg", "muted", "accent", "danger"] as const;
export type BoardColor = (typeof BOARD_COLORS)[number];

const id = z.string().min(1);

/** Per-image study view (flip lives on the item as `flipX`). */
export const boardStudySchema = z.object({
  gray: z.boolean().default(false),
  blur: z.boolean().default(false),
  value: z.union([z.literal(0), z.literal(2), z.literal(3), z.literal(5)]).default(0),
  grid: z.enum(["off", "thirds", "4x4"]).default("off"),
});
export type BoardStudy = z.infer<typeof boardStudySchema>;
export const NO_STUDY: BoardStudy = { gray: false, blur: false, value: 0, grid: "off" };

export const imageItemSchema = z.object({
  // pre-text boards have no `kind`; they're all images
  kind: z.literal("image").default("image"),
  id,
  fileId: id,
  /** world coords of the top-left corner (unrotated box); width in world px.
   *  Height follows the file's aspect ratio, so it isn't stored. */
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  /** rotation, degrees clockwise, about the centre */
  rot: z.number().default(0),
  flipX: z.boolean().default(false),
  study: boardStudySchema.optional(),
});

export const textItemSchema = z.object({
  kind: z.literal("text"),
  id,
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  /** basic markdown (see src/lib/markdown.ts) */
  text: z.string().max(20_000).default(""),
  size: z.enum(["s", "m", "l", "xl"]).default("m"),
  color: z.enum(BOARD_COLORS).default("fg"),
  bg: z.enum(["none", "card", "accent"]).default("card"),
  align: z.enum(["left", "center", "right"]).default("left"),
});

// text first: an item without `kind` fails the text literal and defaults to image
export const boardItemSchema = z.union([textItemSchema, imageItemSchema]);

/** An arrow end is either a free world point or attached to an item (follows it). */
export const arrowEndSchema = z.union([z.object({ item: id }), z.object({ x: z.number(), y: z.number() })]);

export const arrowSchema = z.object({
  id,
  from: arrowEndSchema,
  to: arrowEndSchema,
  color: z.enum(BOARD_COLORS).default("fg"),
  width: z.enum(["s", "m", "l"]).default("m"),
  heads: z.enum(["end", "both", "none"]).default("end"),
  dashed: z.boolean().default(false),
});

export const boardSchema = z.object({
  /** array order is z-order (last = front) */
  items: z.array(boardItemSchema).default([]),
  /** drawn above all items */
  arrows: z.array(arrowSchema).default([]),
  /** file ids hidden from this board's suggestions pane */
  hidden: z.array(z.string()).default([]),
});

export type ImageItem = z.infer<typeof imageItemSchema>;
export type TextItem = z.infer<typeof textItemSchema>;
export type BoardItem = z.infer<typeof boardItemSchema>;
export type ArrowEnd = z.infer<typeof arrowEndSchema>;
export type Arrow = z.infer<typeof arrowSchema>;
export type Board = z.infer<typeof boardSchema>;

export const BOARD_ITEM_WIDTH = 600;
export const BOARD_GAP = 40;
export const BOARD_ZOOM = { min: 0.05, max: 8, snapAtMin: false } as const;
export const MIN_ITEM_PX = 40;

// ---------------------------------------------------------------- geometry

export type Pt = { x: number; y: number };
/** An item's unrotated box plus rotation (degrees) about its centre. */
export type Box = { x: number; y: number; w: number; h: number; rot: number };
export type Corner = "nw" | "ne" | "sw" | "se";

const CORNER_SIGN: Record<Corner, [number, number]> = { nw: [-1, -1], ne: [1, -1], sw: [-1, 1], se: [1, 1] };

const rotate = (v: Pt, deg: number): Pt => {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
};

export const boxCenter = (b: Box): Pt => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/**
 * Drag `corner` of a (possibly rotated) box to world point `p`, keeping the
 * opposite corner fixed. `aspect` (h/w) locks the ratio (images); otherwise
 * width and height follow the pointer independently (text boxes).
 */
export function cornerResize(b: Box, corner: Corner, p: Pt, aspect?: number, min = MIN_ITEM_PX): Omit<Box, "rot"> {
  const [sx, sy] = CORNER_SIGN[corner];
  const c = boxCenter(b);
  const oppOff = rotate({ x: (-sx * b.w) / 2, y: (-sy * b.h) / 2 }, b.rot);
  const opp = { x: c.x + oppOff.x, y: c.y + oppOff.y };
  const d = rotate({ x: p.x - opp.x, y: p.y - opp.y }, -b.rot); // pointer in the box's frame
  let w: number;
  let h: number;
  if (aspect) {
    // least-squares fit of the pointer onto the locked diagonal
    w = Math.max(min, (sx * d.x + sy * d.y * aspect) / (1 + aspect * aspect));
    h = w * aspect;
  } else {
    w = Math.max(min, sx * d.x);
    h = Math.max(min, sy * d.y);
  }
  const off = rotate({ x: (sx * w) / 2, y: (sy * h) / 2 }, b.rot);
  const nc = { x: opp.x + off.x, y: opp.y + off.y };
  return { x: nc.x - w / 2, y: nc.y - h / 2, w, h };
}

/** Where the ray from the box centre toward `toward` leaves the (rotated) box, pushed out by `gap`. */
export function clipToBox(b: Box, toward: Pt, gap = 0): Pt {
  const c = boxCenter(b);
  const local = rotate({ x: toward.x - c.x, y: toward.y - c.y }, -b.rot);
  const len = Math.hypot(local.x, local.y);
  if (len < 1e-6) return c;
  const ux = local.x / len;
  const uy = local.y / len;
  const t = Math.min(Math.abs(ux) > 1e-9 ? b.w / 2 / Math.abs(ux) : Infinity, Math.abs(uy) > 1e-9 ? b.h / 2 / Math.abs(uy) : Infinity);
  const out = rotate({ x: ux * (t + gap), y: uy * (t + gap) }, b.rot);
  return { x: c.x + out.x, y: c.y + out.y };
}

/**
 * Resolve an arrow to its two drawn endpoints. Attached ends sit on their item's
 * edge, aimed at the other end; a missing item makes the arrow unresolvable.
 */
export function resolveArrow(a: Arrow, boxOf: (itemId: string) => Box | null, gap = 6): { from: Pt; to: Pt } | null {
  const anchor = (e: ArrowEnd): Pt | null => {
    if ("item" in e) {
      const b = boxOf(e.item);
      return b ? boxCenter(b) : null;
    }
    return e;
  };
  const fa = anchor(a.from);
  const ta = anchor(a.to);
  if (!fa || !ta) return null;
  const end = (e: ArrowEnd, self: Pt, other: Pt) => ("item" in e ? clipToBox(boxOf(e.item)!, other, gap) : self);
  return { from: end(a.from, fa, ta), to: end(a.to, ta, fa) };
}
