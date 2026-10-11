import { InfiniteQueryObserver, QueryClient, QueryObserver } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { staticSuggestionOptions } from "refr/app/_components/tag-actions";

it("keeps suggestion candidates fixed during invalidation but allows manual refresh", async () => {
  const client = new QueryClient();
  const fetch = vi.fn(async () => ["refreshed"]);
  const observer = new QueryObserver(client, {
    queryKey: ["ml", "suggestImagesForTag", "figure"],
    queryFn: fetch, initialData: ["original"], ...staticSuggestionOptions,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  try {
    await client.invalidateQueries({ queryKey: ["ml"] });
    await client.refetchQueries({ queryKey: ["ml"] });
    expect(fetch).not.toHaveBeenCalled();
    expect(observer.getCurrentResult().data).toEqual(["original"]);
    await observer.refetch();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(observer.getCurrentResult().data).toEqual(["refreshed"]);
  } finally { unsubscribe(); client.clear(); }
});

it("keeps suggest-search pages stable during tag edits and undo, without blocking pagination", async () => {
  const client = new QueryClient();
  const fetch = vi.fn(async ({ pageParam }: { pageParam: number }) => [pageParam]);
  const observer = new InfiniteQueryObserver(client, {
    queryKey: ["search", "query", "suggest:figure"], queryFn: fetch,
    initialPageParam: 0, getNextPageParam: (_last, pages) => pages.length,
    initialData: { pages: [[0]], pageParams: [0] }, ...staticSuggestionOptions,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  try {
    await client.invalidateQueries({ queryKey: ["search"] });
    await client.refetchQueries({ queryKey: ["search"] });
    expect(fetch).not.toHaveBeenCalled();
    await observer.fetchNextPage();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(observer.getCurrentResult().data?.pages).toEqual([[0], [1]]);
    await client.invalidateQueries({ queryKey: ["search"] });
    expect(fetch).toHaveBeenCalledTimes(1);
    await observer.refetch();
    expect(fetch).toHaveBeenCalledTimes(3);
  } finally { unsubscribe(); client.clear(); }
});
