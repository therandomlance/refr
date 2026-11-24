"use client";

import { useMemo } from "react";
import { api } from "refr/trpc/react";

const WEEKS = 12;
// sequential, one hue: the theme accent mixed into the surface (0 = empty day)
const STEP_MIX = [0, 30, 55, 80, 100];

const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function duration(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

/**
 * Practice stats from session history (`sessions.stats`): totals, a 12-week
 * calendar heatmap of time drawn per day, and the most-practiced block searches.
 */
export function PracticeStats() {
  const stats = api.sessions.stats.useQuery();

  const { columns, max } = useMemo(() => {
    const byDay = new Map((stats.data?.days ?? []).map((d) => [d.date, d]));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // start on the Monday WEEKS-1 weeks back so columns are calendar weeks
    const start = new Date(today);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - (WEEKS - 1) * 7);
    const cols: { date: Date; key: string; seconds: number; images: number; future: boolean }[][] = [];
    let peak = 0;
    for (let w = 0; w < WEEKS; w++) {
      const col = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(start);
        date.setDate(start.getDate() + w * 7 + d);
        const key = dayKey(date);
        const row = byDay.get(key);
        const seconds = row?.seconds ?? 0;
        peak = Math.max(peak, seconds);
        col.push({ date, key, seconds, images: row?.images ?? 0, future: date > today });
      }
      cols.push(col);
    }
    return { columns: cols, max: peak };
  }, [stats.data]);

  const data = stats.data;
  if (!data || data.totals.sessions === 0) return null;

  const step = (seconds: number) => (seconds <= 0 || max <= 0 ? 0 : Math.min(4, Math.ceil((seconds / max) * 4)));
  const cellColor = (s: number) =>
    s === 0 ? "var(--fill)" : `color-mix(in oklab, var(--accent) ${STEP_MIX[s]}%, var(--surface-1))`;
  const topMax = data.tags[0]?.images ?? 1;

  return (
    <section className="card mb-6 p-4" aria-labelledby="practice-heading">
      <h2 id="practice-heading" className="mb-3 text-[13px] font-semibold">Practice</h2>
      <div className="flex flex-wrap gap-8">
        <dl className="flex gap-6">
          {[
            ["Time drawn", duration(data.totals.seconds)],
            ["Images", String(data.totals.images)],
            ["Sessions", String(data.totals.sessions)],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-[11px] uppercase tracking-wide text-fg-subtle">{label}</dt>
              <dd className="text-xl font-semibold tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>

        <figure className="m-0">
          <div className="flex gap-[3px]" role="img" aria-label={`Time drawn per day over the last ${WEEKS} weeks`}>
            {columns.map((col, w) => (
              <div key={w} className="flex flex-col gap-[3px]">
                {col.map((c) => (
                  <div
                    key={c.key}
                    className="practice-cell"
                    style={{ background: c.future ? "transparent" : cellColor(step(c.seconds)) }}
                    title={c.future ? undefined : `${c.date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}: ${c.seconds ? `${duration(c.seconds)}, ${c.images} images` : "no practice"}`}
                  />
                ))}
              </div>
            ))}
          </div>
          <figcaption className="mt-2 flex items-center gap-1 text-[11px] text-fg-subtle">
            Less
            {[0, 1, 2, 3, 4].map((s) => (
              <span key={s} className="practice-cell" style={{ background: cellColor(s) }} aria-hidden="true" />
            ))}
            More
          </figcaption>
        </figure>

        {data.tags.length > 0 && (
          <div className="min-w-48 flex-1">
            <div className="label mb-1">Most practiced</div>
            <ul className="flex flex-col gap-1.5">
              {data.tags.slice(0, 5).map((t) => (
                <li key={t.tag} className="text-xs">
                  <div className="flex justify-between gap-2">
                    <span className="truncate" title={t.tag}>{t.tag}</span>
                    <span className="tabular-nums text-fg-muted">{t.images}</span>
                  </div>
                  <div className="mt-0.5 h-1 rounded-full bg-fill">
                    <div className="h-1 rounded-full bg-accent" style={{ width: `${(t.images / topMax) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
