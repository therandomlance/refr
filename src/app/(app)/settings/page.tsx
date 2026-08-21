"use client";

import { useState } from "react";
import { api } from "refr/trpc/react";
import { ConfirmDialog } from "refr/app/_components/dialog";
import { THEMES } from "refr/lib/themes";

export default function SettingsPage() {
  const settings = api.settings.get.useQuery();
  const utils = api.useUtils();
  const patch = api.settings.patch.useMutation({
    onSuccess: () => void utils.settings.get.invalidate(),
  });

  if (!settings.data) return <p className="p-6 text-sm" style={{ color: "var(--text-faint)" }}>Loading…</p>;
  const s = settings.data;

  const save = (p: Parameters<typeof patch.mutate>[0]) => patch.mutate(p);

  return (
    <div className="scroll-thin flex-1 overflow-y-auto p-6">
      <h1 className="mb-6 text-lg font-semibold">Settings</h1>
      <div className="flex max-w-2xl flex-col gap-8">
        <Section title="Libraries">
          <PathList
            values={s.libraries}
            onChange={(libraries) => save({ libraries })}
            addLabel="Add library path"
          />
          <p className="mt-2 text-xs" style={{ color: "var(--text-faint)" }}>
            Libraries are read-only. Removing a path keeps its files in the database until they vanish or you purge.
          </p>
        </Section>

        <Section title="Scanning">
          <ScanControls scanTime={s.scanTime} onTimeChange={(scanTime) => save({ scanTime })} />
        </Section>

        <Section title="Background activity">
          <BackgroundStatus />
        </Section>

        <Section title="Appearance">
          <div className="flex gap-2">
            {THEMES.map((t) => (
              <button
                key={t}
                className="rounded-lg p-1"
                style={{ outline: s.theme === t ? "2px solid var(--accent)" : "1px solid var(--border)", width: 84 }}
                onClick={() => {
                  save({ theme: t });
                  document.documentElement.dataset.theme = t;
                }}
              >
                <div data-theme={t} style={{ background: "var(--bg)", borderRadius: 6, padding: 6, border: "1px solid var(--border)" }}>
                  <div style={{ background: "var(--accent)", height: 8, borderRadius: 3, marginBottom: 4 }} />
                  <div style={{ background: "var(--panel)", height: 14, borderRadius: 3 }} />
                </div>
                <div className="mt-1 text-center text-xs capitalize">{t}</div>
              </button>
            ))}
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm">
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

        <Section title="Send-to destinations">
          <PathList values={s.sendToPaths} onChange={(sendToPaths) => save({ sendToPaths })} addLabel="Add destination" />
        </Section>

        <Section title="Sessions">
          <label className="flex items-center gap-2 text-sm">
            History cap (entries per template)
            <input
              className="input w-24"
              type="number"
              inputMode="numeric"
              min={1}
              defaultValue={s.sessionHistoryCap}
              onBlur={(e) => save({ sessionHistoryCap: Math.max(1, Number(e.target.value) || 1000) })}
            />
          </label>
        </Section>

        <Section title="Password">
          <PasswordControls hasPassword={s.hasPassword} />
        </Section>

        <Section title="Semantic search (CLIP)">
          <MlControls ml={s.ml} />
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function PathList({ values, onChange, addLabel }: { values: string[]; onChange: (v: string[]) => void; addLabel: string }) {
  const [draft, setDraft] = useState("");
  return (
    <div className="flex flex-col gap-2">
      {values.map((v, i) => (
        <div key={i} className="flex items-center gap-2">
          <code className="flex-1 overflow-hidden text-ellipsis rounded px-2 py-1 text-xs" style={{ background: "var(--hover)" }}>{v}</code>
          <button className="btn" style={{ padding: "3px 8px" }} onClick={() => onChange(values.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) { onChange([...values, draft.trim()]); setDraft(""); }
        }}
      >
        <input className="input flex-1" placeholder="/absolute/path" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button className="btn" type="submit">{addLabel}</button>
      </form>
    </div>
  );
}

function ScanControls({ scanTime, onTimeChange }: { scanTime: string | null; onTimeChange: (t: string | null) => void }) {
  const utils = api.useUtils();
  const scanNow = api.settings.scanNow.useMutation();
  const status = api.settings.scanStatus.useQuery(undefined, {
    refetchInterval: (q) => (q.state.data?.running ? 2000 : false),
  });
  const thumbs = api.settings.thumbStatus.useQuery(undefined, {
    refetchInterval: (q) => (q.state.data?.running ? 2000 : false),
  });
  const orphans = api.files.countOrphans.useQuery();
  const purge = api.files.purgeOrphans.useMutation({ onSuccess: () => void utils.files.countOrphans.invalidate() });
  const [purgeConfirm, setPurgeConfirm] = useState(false);
  const external = api.files.countExternal.useQuery();
  const purgeExternal = api.files.purgeExternal.useMutation({
    onSuccess: () => void utils.files.countExternal.invalidate(),
  });
  const [externalConfirm, setExternalConfirm] = useState(false);
  const purgeThumbs = api.files.purgeOrphanThumbs.useMutation();
  const [thumbsConfirm, setThumbsConfirm] = useState(false);

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
          <span className="text-xs" style={{ color: "var(--text-faint)" }}>
            {status.data.phase} — {status.data.processed}/{status.data.total || "?"}
          </span>
        )}
        {status.data?.running && (
          <div className="h-1.5 flex-1 rounded" style={{ background: "var(--hover)" }}>
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
          <span className="text-xs" style={{ color: "var(--text-faint)" }}>
            Generating thumbnails — {thumbs.data.processed}/{thumbs.data.total || "?"}
          </span>
          <div className="h-1.5 flex-1 rounded" style={{ background: "var(--hover)" }}>
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
      <div className="flex items-center gap-3">
        <button className="btn" onClick={() => setPurgeConfirm(true)} disabled={!orphans.data}>
          Purge vanished files
        </button>
        <span className="text-xs" style={{ color: "var(--text-faint)" }}>
          {orphans.data ?? 0} files have no existing paths
        </span>
      </div>
      <div className="flex items-center gap-3">
        <button className="btn" onClick={() => setExternalConfirm(true)} disabled={!external.data}>
          Remove images outside libraries
        </button>
        <span className="text-xs" style={{ color: "var(--text-faint)" }}>
          {external.data ?? 0} images have no path in a current library
        </span>
      </div>
      <div className="flex items-center gap-3">
        <button className="btn" onClick={() => setThumbsConfirm(true)}>Clear orphaned thumbnails</button>
        <span className="text-xs" style={{ color: "var(--text-faint)" }}>
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
    refetchInterval: (q) =>
      q.state.data && (q.state.data.embedded < q.state.data.total || q.state.data.state === "bootstrapping" || q.state.data.state === "starting")
        ? 3000
        : false,
  });
  const rows: { label: string; detail: string }[] = [];
  if (scan.data?.running) rows.push({ label: "Scan", detail: `${scan.data.phase} — ${scan.data.processed}/${scan.data.total || "?"}` });
  if (thumbs.data?.running) rows.push({ label: "Thumbnails", detail: `${thumbs.data.processed}/${thumbs.data.total || "?"} generated` });
  if (ml.data?.enabled && (ml.data.state === "bootstrapping" || ml.data.state === "starting")) {
    rows.push({ label: "ML sidecar", detail: ml.data.state });
  } else if (ml.data?.enabled && ml.data.embedded < ml.data.total) {
    rows.push({ label: "Embeddings", detail: `${ml.data.embedded}/${ml.data.total}` });
  }
  return (
    <div className="rounded-lg p-3 text-xs" style={{ background: "var(--panel)", border: "1px solid var(--border)" }}>
      {rows.length === 0 ? (
        <span style={{ color: "var(--text-faint)" }}>Idle — no background processes running.</span>
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
      {msg && <p className="text-xs" style={{ color: "var(--text-faint)" }}>{msg}</p>}
    </div>
  );
}

function MlControls({ ml }: { ml: { enabled: boolean; port: number; model: string; pretrained: string; tagSuggestionTextWeight: number } }) {
  const utils = api.useUtils();
  const patch = api.settings.patch.useMutation({ onSuccess: () => void utils.settings.get.invalidate() });
  const setEnabled = api.ml.setEnabled.useMutation({ onSuccess: () => void utils.ml.status.invalidate() });
  const reembed = api.ml.reembedAll.useMutation();
  const status = api.ml.status.useQuery(undefined, {
    refetchInterval: (q) => (q.state.data?.state === "bootstrapping" || q.state.data?.state === "starting" ? 2000 : false),
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
        <div className="rounded-lg p-3 text-xs" style={{ background: "var(--panel)", border: "1px solid var(--border)" }}>
          <div className="kv"><span>Status</span><b>{st.state}{st.error ? ` — ${st.error}` : ""}</b></div>
          {st.device && <div className="kv"><span>Device</span><b>{st.device}</b></div>}
          {st.model && <div className="kv"><span>Model</span><b>{st.model}</b></div>}
          <div className="kv"><span>Embedded</span><b>{st.embedded} / {st.total}</b></div>
          {(st.state === "bootstrapping" || st.state === "starting") && st.log.length > 0 && (
            <pre className="scroll-thin mt-2 max-h-32 overflow-y-auto text-[10px]" style={{ color: "var(--text-faint)" }}>
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
              defaultValue={ml.tagSuggestionTextWeight}
              onBlur={(e) => patch.mutate({ ml: { tagSuggestionTextWeight: Number(e.target.value) } })}
            />
            <span className="text-xs" style={{ color: "var(--text-faint)" }}>0 = image centroid only, 1 = tag name only</span>
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
