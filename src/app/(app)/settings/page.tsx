"use client";

import { useState } from "react";
import { api } from "refr/trpc/react";
import { ConfirmDialog } from "refr/app/_components/dialog";
import { THEMES, ACCENTS, DENSITIES, type Theme, type Accent, type Density } from "refr/lib/themes";
import { Icon } from "refr/app/_components/icon";
import { Hint } from "refr/app/_components/hint";

export default function SettingsPage() {
  const settings = api.settings.get.useQuery();
  const utils = api.useUtils();
  const patch = api.settings.patch.useMutation({
    onSuccess: () => void utils.settings.get.invalidate(),
  });

  if (!settings.data) return <p className="p-6 text-sm text-fg-subtle">Loading…</p>;
  const s = settings.data;

  const save = (p: Parameters<typeof patch.mutate>[0]) => patch.mutate(p);

  return (
    <div className="scroll-thin flex-1 overflow-y-auto p-6">
      <header className="page-header page-header-inset"><div><h1>Settings</h1></div></header>
      <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        <a href="#libraries">Libraries</a><a href="#workspace">Workspace</a><a href="#services">Services & security</a><a href="#backup">Backup</a><a href="#maintenance">Maintenance</a>
      </nav>
      <div className="flex min-w-0 flex-col gap-6">
        <div className="settings-group" id="libraries"><h2>Libraries</h2>
        <Section title="Library paths" hint="Libraries are read-only. Removing a path keeps its files in the database until they vanish or you purge.">
          <LibraryList values={s.libraries} onChange={(libraries) => save({ libraries })} />
        </Section>

        <Section title="Scanning">
          <ScanControls scanTime={s.scanTime} onTimeChange={(scanTime) => save({ scanTime })} />
        </Section>

        <Section title="Background activity">
          <BackgroundStatus />
        </Section>
        </div>

        <div className="settings-group" id="workspace"><h2>Workspace</h2>
        <Section title="Appearance">
          <AppearanceControls theme={s.theme} accent={s.accent} density={s.density} />
          <label className="mt-5 flex items-center gap-2 text-sm">
            Default thumbnail size
            <select
              className="input"
              value={s.defaultThumbnailSize}
              onChange={(e) => save({ defaultThumbnailSize: e.target.value as "small" | "medium" | "large" })}
            >
              <option value="small">Small</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
            </select>
          </label>
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={s.skipTagRemoveConfirm}
              onChange={(e) => save({ skipTagRemoveConfirm: e.target.checked })}
            />
            Skip confirmation when removing tags
          </label>
        </Section>

        <Section title="Send-to destinations" hint="Existing filenames are skipped, never overwritten or renamed.">
          <DestinationList values={s.sendToPaths} onChange={(sendToPaths) => save({ sendToPaths })} />
        </Section>

        <section>
          <label className="flex items-center gap-2 text-sm">
            Session history per template
            <input
              className="input w-24"
              type="number"
              inputMode="numeric"
              min={1}
              defaultValue={s.sessionHistoryCap}
              onBlur={(e) => save({ sessionHistoryCap: Math.max(1, Number(e.target.value) || 1000) })}
            />
          </label>
        </section>

        </div>
        <div className="settings-group" id="services"><h2>Services & security</h2>
        <Section title="Password">
          <PasswordControls hasPassword={s.hasPassword} />
        </Section>

        <Section title="Semantic search (CLIP)">
          <MlControls ml={s.ml} />
        </Section>
        </div>
        <div className="settings-group" id="backup"><h2>Backup</h2>
        <Section title="Tags and notes" hint="Tags, favorites, sources and notes live only in the database. Export them as a .jsonl file; importing merges a file back in (matched by content, then path) and only ever adds.">
          <TagExportControls />
        </Section>
        <Section title="Database snapshots">
          <SnapshotControls enabled={s.backup.enabled} keep={s.backup.keep} onChange={(backup) => save({ backup })} />
        </Section>
        </div>
        <div className="settings-group" id="maintenance"><h2>Maintenance</h2>
          <MaintenanceControls />
        </div>
      </div>
      </div>
    </div>
  );
}

/** Theme / accent / density apply instantly via <html data-*> and roll back if the save fails. */
function AppearanceControls({ theme, accent, density }: { theme: Theme; accent: Accent; density: Density }) {
  const utils = api.useUtils();
  const patch = api.settings.patch.useMutation({ onSuccess: () => void utils.settings.get.invalidate() });
  const apply = (key: "theme" | "accent" | "density", value: string, previous: string) => {
    document.documentElement.dataset[key] = value;
    patch.mutate({ [key]: value }, { onError: () => { document.documentElement.dataset[key] = previous; } });
  };
  return (
    <div className="flex flex-col gap-5">
      <fieldset>
        <legend className="mb-2 text-xs text-fg-subtle">Theme</legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {THEMES.map((t) => (
            <button
              key={t}
              className="theme-choice"
              aria-pressed={theme === t}
              disabled={patch.isPending}
              onClick={() => apply("theme", t, theme)}
            >
              <div data-theme={t} className="theme-preview" aria-hidden="true">
                <div className="theme-preview-rail"><i /><i /><i /></div>
                <div className="theme-preview-content">
                  <i /><i />
                  <div className="theme-preview-tiles"><i /><i /><i /></div>
                  <div className="theme-preview-footer"><i /><b /></div>
                </div>
              </div>
              <div className="mt-2 px-1 pb-0.5">
                <div className="flex items-center justify-between text-xs font-medium capitalize">
                  <span>{t}</span>
                  {theme === t && <span className="text-accent"><Icon name="check" size={14} /></span>}
                </div>
              </div>
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-2 text-xs text-fg-subtle">Accent</legend>
        <div className="accent-swatches">
          {ACCENTS.map((a) => (
            <button
              key={a}
              data-theme={theme}
              data-accent={a}
              className="accent-swatch"
              aria-pressed={accent === a}
              aria-label={`${a} accent`}
              title={a}
              disabled={patch.isPending}
              onClick={() => apply("accent", a, accent)}
            >
              {accent === a && <Icon name="check" size={14} />}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-2 text-xs text-fg-subtle">Density</legend>
        <div className="seg" role="group" aria-label="Density" title="Spacing between thumbnails, row height, and corner rounding">
          {DENSITIES.map((d) => (
            <button
              key={d}
              className={`capitalize ${density === d ? "on" : ""}`}
              aria-pressed={density === d}
              disabled={patch.isPending}
              onClick={() => apply("density", d, density)}
            >
              {d}
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-3 text-[13px] font-semibold text-fg-muted">
        {title}
        {hint && <Hint text={hint} />}
      </h3>
      {children}
    </section>
  );
}

type Destination = { path: string; alias?: string };

function DestinationList({ values, onChange }: { values: Destination[]; onChange: (v: Destination[]) => void }) {
  const [draft, setDraft] = useState("");
  return (
    <div className="flex flex-col gap-2">
      {values.map((v, i) => (
        <form
          key={`${i}:${v.path}:${v.alias ?? ""}`}
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            const next = { path: (data.get("path") as string).trim(), alias: (data.get("alias") as string).trim() || undefined };
            if (next.path) onChange(values.map((value, j) => j === i ? next : value));
          }}
        >
          <input
            className="input min-w-40 flex-1"
            name="path"
            required
            aria-label={`Destination path ${i + 1}`}
            defaultValue={v.path}
          />
          <input
            className="input"
            name="alias"
            style={{ width: 130, padding: "5px 8px", fontSize: 12 }}
            aria-label={`Destination alias ${i + 1}`}
            title="Name shown in the Send to menu"
            placeholder="alias"
            defaultValue={v.alias ?? ""}
          />
          <button className="btn" type="submit">Save</button>
          <button className="btn" type="button" aria-label={`Remove destination ${v.path}`} onClick={() => onChange(values.filter((_, j) => j !== i))}><Icon name="close" /></button>
        </form>
      ))}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) { onChange([...values, { path: draft.trim() }]); setDraft(""); }
        }}
      >
        <input className="input flex-1" aria-label="New destination path" placeholder="/absolute/path" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button className="btn" type="submit">Add destination</button>
      </form>
    </div>
  );
}

function LibraryList({
  values,
  onChange,
}: {
  values: { path: string; alias?: string; timeline: boolean }[];
  onChange: (v: { path: string; alias?: string; timeline: boolean }[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const update = (i: number, patch: Partial<{ path: string; alias?: string; timeline: boolean }>) =>
    onChange(values.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  return (
    <div className="flex flex-col gap-2">
      {values.map((v, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <code className="min-w-40 flex-1 overflow-hidden text-ellipsis rounded px-2 py-1 text-xs bg-fill">{v.path}</code>
          <input
            className="input"
            style={{ width: 130, padding: "5px 8px", fontSize: 12 }}
            placeholder="alias"
            title="Search this library with path:<alias>"
            defaultValue={v.alias ?? ""}
            onBlur={(e) => {
              const next = e.target.value.trim() || undefined;
              if (next !== v.alias) update(i, { alias: next });
            }}
          />
          <label className="flex items-center gap-1 text-xs text-fg-muted" title="Include in the main timeline. Unchecked libraries stay searchable.">
            <input type="checkbox" checked={v.timeline} onChange={(e) => update(i, { timeline: e.target.checked })} />
            Timeline
          </label>
          <button className="btn" aria-label={`Remove library ${v.path}`} onClick={() => onChange(values.filter((_, j) => j !== i))}><Icon name="close" /></button>
        </div>
      ))}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) { onChange([...values, { path: draft.trim(), timeline: true }]); setDraft(""); }
        }}
      >
        <input className="input flex-1" placeholder="/absolute/path" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button className="btn" type="submit">Add library path</button>
      </form>
    </div>
  );
}

function ScanControls({ scanTime, onTimeChange }: { scanTime: string | null; onTimeChange: (t: string | null) => void }) {
  const utils = api.useUtils();
  // The mutation only kicks off the background job and returns immediately —
  // suppress the generic "Done." and refetch status so polling picks it up.
  const scanNow = api.settings.scanNow.useMutation({
    meta: { customFeedback: true },
    onSuccess: () => void utils.settings.scanStatus.invalidate(),
  });
  const status = api.settings.scanStatus.useQuery(undefined, {
    refetchInterval: (q) => (q.state.data?.running ? 2000 : false),
  });
  const thumbs = api.settings.thumbStatus.useQuery(undefined, {
    refetchInterval: (q) => (q.state.data?.running ? 2000 : false),
  });

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2 text-sm">
        Nightly scan
        <select
          className="input"
          value={scanTime ?? "off"}
          onChange={(e) => onTimeChange(e.target.value === "off" ? null : e.target.value)}
        >
          <option value="off">Off</option>
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={`${String(h).padStart(2, "0")}:00`}>{String(h).padStart(2, "0")}:00</option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-3">
        <button className="btn" onClick={() => scanNow.mutate()} disabled={status.data?.running}>
          {status.data?.running ? "Scanning…" : "Scan now"}
        </button>
        {status.data?.running && (
          <span className="text-xs text-fg-subtle">
            {status.data.phase} — {status.data.processed}/{status.data.total || "?"}
          </span>
        )}
        {status.data?.running && (
          <div className="h-1.5 flex-1 rounded bg-fill">
            <div
              className="h-1.5 rounded"
              style={{
                background: "var(--accent)",
                width: status.data.total ? `${Math.min(100, (status.data.processed / status.data.total) * 100)}%` : "30%",
                transition: "width .5s",
              }}
            />
          </div>
        )}
      </div>
      {thumbs.data?.running && (
        <div className="flex items-center gap-3">
          <span className="text-xs text-fg-subtle">
            Generating thumbnails — {thumbs.data.processed}/{thumbs.data.total || "?"}
          </span>
          <div className="h-1.5 flex-1 rounded bg-fill">
            <div
              className="h-1.5 rounded"
              style={{
                background: "var(--accent)",
                width: thumbs.data.total ? `${Math.min(100, (thumbs.data.processed / thumbs.data.total) * 100)}%` : "30%",
                transition: "width .5s",
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function MaintenanceControls() {
  const utils = api.useUtils();
  const orphans = api.files.countOrphans.useQuery();
  const purge = api.files.purgeOrphans.useMutation({ onSuccess: () => void utils.files.countOrphans.invalidate() });
  const [purgeConfirm, setPurgeConfirm] = useState(false);
  const external = api.files.countExternal.useQuery();
  const purgeExternal = api.files.purgeExternal.useMutation({ onSuccess: () => void utils.files.countExternal.invalidate() });
  const [externalConfirm, setExternalConfirm] = useState(false);
  const purgeThumbs = api.files.purgeOrphanThumbs.useMutation();
  const [thumbsConfirm, setThumbsConfirm] = useState(false);
  return (
    <div className="maintenance-panel">
      <div>
        <button className="btn" onClick={() => setPurgeConfirm(true)} disabled={!orphans.data}>
          Purge vanished files
        </button>
        <span className="text-xs text-fg-subtle">
          {orphans.data ?? 0} files have no existing paths
        </span>
      </div>
      <div>
        <button className="btn" onClick={() => setExternalConfirm(true)} disabled={!external.data}>
          Remove images outside libraries
        </button>
        <span className="text-xs text-fg-subtle">
          {external.data ?? 0} images have no path in a current library
        </span>
      </div>
      <div>
        <button className="btn" onClick={() => setThumbsConfirm(true)}>Clear orphaned thumbnails</button>
        <span className="text-xs text-fg-subtle">
          {purgeThumbs.data !== undefined ? `Removed ${purgeThumbs.data} cached thumbnails` : "Deletes cached thumbnails with no matching image"}
        </span>
      </div>
      {purgeConfirm && (
        <ConfirmDialog
          title="Purge vanished files"
          body={<>Delete <b>{orphans.data}</b> database rows (and thumbnails) whose files no longer exist anywhere? Tags on them are lost forever.</>}
          confirmLabel="Purge"
          danger
          onConfirm={() => purge.mutate()}
          onClose={() => setPurgeConfirm(false)}
        />
      )}
      {externalConfirm && (
        <ConfirmDialog
          title="Remove images outside libraries"
          body={<>Delete <b>{external.data}</b> database rows (and thumbnails) that have no path in any current library? Tags on them are lost forever. Files on disk are not touched.</>}
          confirmLabel="Remove"
          danger
          onConfirm={() => purgeExternal.mutate()}
          onClose={() => setExternalConfirm(false)}
        />
      )}
      {thumbsConfirm && (
        <ConfirmDialog
          title="Clear orphaned thumbnails"
          body="Delete cached thumbnail files that don't match any image in the database? Missing thumbnails regenerate automatically."
          confirmLabel="Clear"
          danger
          onConfirm={() => purgeThumbs.mutate()}
          onClose={() => setThumbsConfirm(false)}
        />
      )}
    </div>
  );
}

/** Live view of whatever background work is running (scan, thumbs, ML). */
function BackgroundStatus() {
  const scan = api.settings.scanStatus.useQuery(undefined, {
    refetchInterval: (q) => (q.state.data?.running ? 2000 : false),
  });
  const thumbs = api.settings.thumbStatus.useQuery(undefined, {
    refetchInterval: (q) => (q.state.data?.running ? 2000 : false),
  });
  const ml = api.ml.status.useQuery(undefined, {
    refetchInterval: (q) => (q.state.data?.enabled ? 3000 : false),
  });
  const rows: { label: string; detail: string }[] = [];
  if (scan.data?.running) rows.push({ label: "Scan", detail: `${scan.data.phase} — ${scan.data.processed}/${scan.data.total || "?"}` });
  if (thumbs.data?.running) rows.push({ label: "Thumbnails", detail: `${thumbs.data.processed}/${thumbs.data.total || "?"} generated` });
  if (ml.data?.enabled && (ml.data.state === "bootstrapping" || ml.data.state === "starting")) {
    rows.push({ label: "ML sidecar", detail: ml.data.state });
  } else if (ml.data?.embeddingRunning) {
    rows.push({ label: "Embeddings", detail: `${ml.data.embedded}/${ml.data.total}` });
  }
  return (
    <div className="rounded-lg p-3 text-xs card">
      {rows.length === 0 ? (
        <span className="text-fg-subtle">Idle</span>
      ) : (
        rows.map((r) => (
          <div key={r.label} className="kv"><span>{r.label}</span><b>{r.detail}</b></div>
        ))
      )}
    </div>
  );
}

function PasswordControls({ hasPassword }: { hasPassword: boolean }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const utils = api.useUtils();
  const [msg, setMsg] = useState<string | null>(null);
  const setPw = api.settings.setPassword.useMutation({
    onSuccess: () => { setMsg("Password updated"); setCurrent(""); setNext(""); void utils.settings.get.invalidate(); },
    onError: (e) => setMsg(e.message),
  });
  const clearPw = api.settings.clearPassword.useMutation({
    onSuccess: () => { setMsg("Password cleared — app is open"); setCurrent(""); void utils.settings.get.invalidate(); },
    onError: (e) => setMsg(e.message),
  });
  return (
    <div className="flex max-w-sm flex-col gap-2">
      {hasPassword && (
        <input className="input" type="password" placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      )}
      <input className="input" type="password" placeholder="New password" value={next} onChange={(e) => setNext(e.target.value)} />
      <div className="flex gap-2">
        <button className="btn" disabled={!next} onClick={() => setPw.mutate({ current: current || undefined, next })}>
          {hasPassword ? "Change password" : "Set password"}
        </button>
        {hasPassword && (
          <button className="btn danger" onClick={() => clearPw.mutate({ current: current || undefined })}>Clear password</button>
        )}
      </div>
      {msg && <p className="text-xs text-fg-subtle">{msg}</p>}
    </div>
  );
}

type MlSettings = {
  enabled: boolean; port: number; model: string; pretrained: string;
  tagSuggestionTextWeight: number; tagModel: "auto" | "vector";
};

function MlControls({ ml }: { ml: MlSettings }) {
  const utils = api.useUtils();
  const patch = api.settings.patch.useMutation({ onSuccess: () => void utils.settings.get.invalidate() });
  const setEnabled = api.ml.setEnabled.useMutation({ onSuccess: () => void utils.ml.status.invalidate() });
  const reembed = api.ml.reembedAll.useMutation();
  const status = api.ml.status.useQuery(undefined, {
    refetchInterval: (q) => {
      const d = q.state.data;
      return d?.state === "bootstrapping" || d?.state === "starting" || d?.tags?.warming ? 2000 : false;
    },
  });
  const [reembedConfirm, setReembedConfirm] = useState(false);
  const st = status.data;

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={ml.enabled}
          onChange={(e) => setEnabled.mutate({ enabled: e.target.checked })}
        />
        Enable semantic features (downloads several GB on first run)
      </label>
      {ml.enabled && st && (
        <div className="rounded-lg p-3 text-xs card">
          <div className="kv"><span>Status</span><b>{st.state}{st.error ? ` — ${st.error}` : ""}</b></div>
          {st.device && <div className="kv"><span>Device</span><b>{st.device}</b></div>}
          {st.model && <div className="kv"><span>Model</span><b>{st.model}</b></div>}
          <div className="kv"><span>Embedded</span><b>{st.embedded} / {st.total}</b></div>
          {st.tags && (
            <div className="kv"><span>Tag vectors</span><b>{st.tags.vectors} / {st.tags.total}{st.tags.warming ? " — building…" : ""}</b></div>
          )}
          {st.tags?.classifiers && (
            <div className="kv">
              <span>Classifiers</span>
              <b>
                {st.tags.classifiers.trained} trained, {st.tags.classifiers.tooSmall} too small
                {" "}/ {st.tags.total}{st.tags.warming ? " — training…" : ""}
              </b>
            </div>
          )}
          {(st.state === "bootstrapping" || st.state === "starting") && st.log.length > 0 && (
            <pre className="scroll-thin mt-2 max-h-32 overflow-y-auto text-[10px] text-fg-subtle">
              {st.log.slice(-8).join("\n")}
            </pre>
          )}
        </div>
      )}
      {ml.enabled && (
        <>
          <label className="flex items-center gap-2 text-sm">
            Tag suggestion text weight
            <input
              className="input w-20"
              type="number" inputMode="decimal" step={0.05} min={0} max={1}
              title="0 = image centroid only, 1 = tag name only"
              defaultValue={ml.tagSuggestionTextWeight}
              onBlur={(e) => patch.mutate({ ml: { tagSuggestionTextWeight: Number(e.target.value) } })}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            Tag model
            <select
              className="input w-auto"
              title="Classifiers learn from each tag's images, ✕ rejections and sibling tags"
              value={ml.tagModel}
              onChange={(e) => patch.mutate({ ml: { tagModel: e.target.value as MlSettings["tagModel"] } }, { onSuccess: () => void utils.ml.status.invalidate() })}
            >
              <option value="auto">Auto — classifier when a tag has 10+ images</option>
              <option value="vector">Tag vector only</option>
            </select>
          </label>
          <div>
            <button className="btn" onClick={() => setReembedConfirm(true)}>Re-embed all</button>
          </div>
        </>
      )}
      {reembedConfirm && (
        <ConfirmDialog
          title="Re-embed all"
          body="Drop all embeddings and regenerate? This takes hours for large libraries on CPU. Required after changing the model."
          confirmLabel="Re-embed"
          onConfirm={() => reembed.mutate()}
          onClose={() => setReembedConfirm(false)}
        />
      )}
    </div>
  );
}

/** Export / import tags, favorites, sources and notes as JSON lines (backup.ts). */
function TagExportControls() {
  const utils = api.useUtils();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const onFile = async (file: File) => {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/import", { method: "POST", body: file });
      if (!res.ok) throw new Error(`Import failed (${res.status})`);
      const r = (await res.json()) as { lines: number; matched: number; unmatched: number; invalid: number; changedFiles: number };
      setResult(`Read ${r.lines} entries: ${r.matched} matched, ${r.unmatched} not in this library${r.invalid ? `, ${r.invalid} unreadable` : ""}. ${r.changedFiles} files updated.`);
      void utils.invalidate();
    } catch (e) {
      setResult(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <a className="btn" href="/api/export" download>Export tags</a>
        <label className={`btn ${busy ? "pointer-events-none opacity-60" : ""}`}>
          {busy ? "Importing…" : "Import tags…"}
          <input
            type="file"
            accept=".jsonl,.json,application/x-ndjson"
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void onFile(f);
            }}
          />
        </label>
      </div>
      {result && <p role="status" className="text-xs text-fg-muted">{result}</p>}
    </div>
  );
}

/** Nightly `VACUUM INTO` snapshots of refr.db in data/backups/. */
function SnapshotControls({ enabled, keep, onChange }: { enabled: boolean; keep: number; onChange: (b: { enabled?: boolean; keep?: number }) => void }) {
  const utils = api.useUtils();
  const snapshots = api.settings.snapshots.useQuery();
  const backupNow = api.settings.backupNow.useMutation({ onSuccess: () => void utils.settings.snapshots.invalidate() });
  const latest = snapshots.data?.[0];
  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => onChange({ enabled: e.target.checked })} />
        Snapshot the database after each nightly scan
      </label>
      <label className="flex items-center gap-2 text-sm">
        Keep the newest
        <input
          className="input w-20"
          type="number"
          min={1}
          max={100}
          defaultValue={keep}
          onBlur={(e) => onChange({ keep: Math.max(1, Math.min(100, Number(e.target.value) || 7)) })}
        />
        snapshots
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn" disabled={backupNow.isPending} onClick={() => backupNow.mutate()}>
          {backupNow.isPending ? "Backing up…" : "Back up now"}
        </button>
        <span className="text-xs text-fg-subtle">
          {latest
            ? `Latest: ${new Date(latest.createdAt).toLocaleString()} (${(latest.size / (1 << 20)).toFixed(1)} MB), ${snapshots.data!.length} kept in data/backups/`
            : "No snapshots yet."}
        </span>
      </div>
    </div>
  );
}
