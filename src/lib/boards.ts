/** Moodboard document shape — shared by the boards service and the board canvas. */
import { z } from "zod";

export const boardItemSchema = z.object({
  /** item id (a file may appear on a board more than once only via duplication) */
  id: z.string().min(1),
  fileId: z.string().min(1),
  /** world coords of the top-left corner; width in world px. Height follows the
   *  file's aspect ratio, so it isn't stored. */
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  /** rotation, degrees clockwise */
  rot: z.number().default(0),
  flipX: z.boolean().default(false),
});

export const boardSchema = z.object({
  /** array order is z-order (last = front) */
  items: z.array(boardItemSchema).default([]),
  view: z.object({ x: z.number(), y: z.number(), zoom: z.number().positive() }).default({ x: 0, y: 0, zoom: 1 }),
});

export type BoardItem = z.infer<typeof boardItemSchema>;
export type Board = z.infer<typeof boardSchema>;

export const BOARD_ITEM_WIDTH = 400;
export const BOARD_GAP = 40;
export const BOARD_ZOOM = { min: 0.05, max: 8, snapAtMin: false } as const;
