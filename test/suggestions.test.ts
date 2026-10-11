import { QueryClient, QueryObserver } from "@tanstack/react-query";
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
