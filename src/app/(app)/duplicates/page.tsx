"use client";

import { useSearchParams } from "next/navigation";
import { DuplicateReview } from "./duplicate-review";

export default function DuplicatesPage() {
  const params = useSearchParams();
  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="page-header">
        <div>
          <h1>Duplicates</h1>
          <p>Near-identical images. Keep one and its twin&apos;s tags merge onto it; the other is hidden, never deleted.</p>
        </div>
      </header>
      <DuplicateReview fileId={params.get("file")} />
    </main>
  );
}
