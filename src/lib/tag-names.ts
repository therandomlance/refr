/** Client-safe tag-name helpers (hierarchy is derived from the `/`-separated string). */

/** trim, collapse repeated '/', strip leading/trailing '/', lowercase. */
export function normalize(name: string): string {
  return name.trim().replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
}

/** `a/b/c` → `[a, a/b, a/b/c]`. */
export function ancestors(name: string): string[] {
  const parts = normalize(name).split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** `name` is `root` or sits beneath it. */
export function isUnder(name: string, root: string): boolean {
  return name === root || name.startsWith(root + "/");
}
