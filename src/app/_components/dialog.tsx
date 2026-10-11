"use client";

import { useEffect, useId, useRef, useState } from "react";
import { api } from "refr/trpc/react";
import { TagInput } from "./tag-input";

export function Dialog({
  title,
  children,
  onClose,
  wide = false,
  dismissOnBackdrop = true,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean | number;
  dismissOnBackdrop?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input, button, [tabindex='0']")?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return (
    <div className="dialog-bg" onClick={dismissOnBackdrop ? onClose : undefined}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className="dialog" style={wide ? { maxWidth: typeof wide === "number" ? wide : 1080, width: "calc(100vw - 32px)", maxHeight: "calc(100dvh - 32px)", overflowY: "auto" } : undefined} onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.stopPropagation(); onClose(); }
          if (e.key !== "Tab") return;
          const controls = [...e.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex='0']")];
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }}>
        <h2 id={titleId} className="mb-3 text-base font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel = "Confirm",
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="mb-4 text-sm" style={{ color: "var(--text-dim)" }}>{body}</div>
      <div className="flex justify-end gap-2">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className={`btn ${danger ? "danger" : "primary"}`} onClick={() => { onConfirm(); onClose(); }}>
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

export function PromptDialog({
  title,
  label,
  initial = "",
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initial?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) { onSubmit(value.trim()); onClose(); }
        }}
      >
        <label className="mb-1 block text-xs" style={{ color: "var(--text-faint)" }}>{label}</label>
        <input ref={ref} className="input mb-4 w-full" value={value} onChange={(e) => setValue(e.target.value)} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary">OK</button>
        </div>
      </form>
    </Dialog>
  );
}

export function TagPromptDialog({
  title,
  label,
  onSubmit,
  onClose,
  suggestFor,
}: {
  title: string;
  label: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
  /** file ids of the selection — shows clickable tag suggestions (viewer-style) */
  suggestFor?: string[];
}) {
  const mlStatus = api.ml.status.useQuery();
  const suggestedQ = api.ml.suggestTagsForFiles.useQuery(
    { fileIds: suggestFor ?? [] },
    { enabled: !!suggestFor?.length && mlStatus.data?.state === "ready" },
  );
  return (
    <Dialog title={title} onClose={onClose}>
      {suggestedQ.data && suggestedQ.data.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1">
          {suggestedQ.data.map((s) => (
            <button type="button"
              key={s.tag}
              className="chip"
              style={{ cursor: "pointer", border: "1px dashed var(--border)" }}
              onClick={() => {
                onSubmit(s.tag);
                onClose();
              }}
            >
              + {s.tag}
            </button>
          ))}
        </div>
      )}
      <label className="mb-1 block text-xs" style={{ color: "var(--text-faint)" }}>{label}</label>
      <TagInput autoFocus onCommit={(value) => { onSubmit(value); onClose(); }} />
    </Dialog>
  );
}
